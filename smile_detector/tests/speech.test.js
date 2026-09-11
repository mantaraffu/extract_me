import { test } from "node:test";
import assert from "node:assert/strict";
import { Transcriber, UNK, normalize, stripUnk } from "../js/speech.js";

function make(opts = {}) {
  const seen = [];
  const t = new Transcriber({ onText: s => seen.push(s), nowS: 0, ...opts });
  return { t, seen };
}

/** A final result, the shape the adapter feeds in. */
function say(t, text, nowS = 0, extra = {}) {
  return t.result({ text, final: true, nowS, ...extra });
}

test("normalize drops punctuation and collapses spaces", () => {
  assert.equal(normalize("  Tell   me, please! "), "tell me please");
  assert.equal(normalize(null), "");
});

test("normalize strips the brackets off [unk], so UNK is never matched directly", () => {
  assert.equal(normalize(UNK), "unk");
  assert.notEqual(normalize(UNK), UNK);
});

test("stripUnk removes markers wherever they sit", () => {
  assert.equal(stripUnk("i came unk here"), "i came here");
  assert.equal(stripUnk("unk unk"), "");
});

test("nothing is recorded while the switch is off", () => {
  const { t, seen } = make();
  assert.equal(say(t, "i said something", 1), null);
  assert.equal(t.text(), "");
  assert.deepEqual(seen, []);
});

test("the switch starts it, and everything said lands in one string", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "first sentence", 1);
  say(t, "second sentence", 2);
  say(t, "third sentence", 3);
  assert.equal(t.text(), "first sentence second sentence third sentence");
  assert.equal(t.words(), 6);
});

test("a pause of any length does not end anything", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "i think", 1);
  say(t, "it was strange", 400);        // six and a half minutes later
  assert.equal(t.text(), "i think it was strange");
});

test("stopping folds in what Vosk had not finalised yet", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "i came here", 1);
  t.result({ text: "with my sister", final: false, nowS: 2 });
  t.setRecording(false, 3);
  assert.equal(t.text(), "i came here with my sister");
});

test("a partial superseded by its final is not counted twice", () => {
  const { t } = make();
  t.setRecording(true, 0);
  t.result({ text: "i came here", final: false, nowS: 1 });
  say(t, "i came here", 2);
  assert.equal(t.text(), "i came here");
});

test("switching off and on again appends rather than starting over", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "before the pause", 1);
  t.setRecording(false, 2);
  assert.equal(say(t, "not recorded", 3), null);
  t.setRecording(true, 4);
  say(t, "after the pause", 5);
  assert.equal(t.text(), "before the pause after the pause");
});

test("recorded seconds accumulate across switch-offs", () => {
  const { t } = make();
  t.setRecording(true, 10);
  t.setRecording(false, 25);
  t.setRecording(true, 100);
  assert.equal(t.seconds(110), 25);        // 15 + 10 so far
  t.setRecording(false, 130);
  assert.equal(t.seconds(500), 45);
});

test("out-of-vocabulary markers never reach the transcript", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "i came [unk] here", 1);
  say(t, "[unk] [unk]", 2);
  assert.equal(t.text(), "i came here");
  assert.equal(t.stats.unknown, 2);
});

test("a coach line said verbatim is dropped, and counted", () => {
  const { t } = make({ coachPhrases: ["smile more please"] });
  t.setRecording(true, 0);
  say(t, "i was saying", 1);
  say(t, "Smile more, please!", 2);
  say(t, "something else", 3);
  assert.equal(t.text(), "i was saying something else");
  assert.equal(t.stats.coachDropped, 1);
});

test("speech overlapping the coach is kept, and counted", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "i think it is funny", 1, { speaking: true });
  assert.equal(t.text(), "i think it is funny");
  assert.equal(t.stats.coachOverlaps, 1);
});

test("confidence is averaged over the finalised utterances", () => {
  const { t } = make();
  t.setRecording(true, 0);
  assert.equal(t.confidence(), null);
  say(t, "one", 1, { conf: 0.9 });
  say(t, "two", 2, { conf: 0.7 });
  assert.equal(t.confidence(), 0.8);
});

test("onText fires as the transcript grows and when recording stops", () => {
  const { t, seen } = make();
  t.setRecording(true, 0);
  say(t, "one", 1);
  say(t, "two", 2);
  t.setRecording(false, 3);
  assert.deepEqual(seen, ["", "one", "one two", "one two"]);
});

test("flipping the switch to where it already is changes nothing", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "hello", 1);
  t.setRecording(true, 2);
  assert.equal(t.text(), "hello");
  assert.equal(t.seconds(10), 10);
});

test("reset empties the transcript but keeps the session counters", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "something", 1);
  t.reset(2);
  assert.equal(t.text(), "");
  assert.equal(t.recording, false);
  assert.equal(t.stats.finals, 1);
});

// --- word ranking ---

test("the ranking keeps content words and nothing else", async () => {
  const { topWords } = await import("../js/speech.js");
  // grammar, an auxiliary, a filler verb and a placeholder noun: all of it goes
  const top = topWords("this is the thing that i think that this sister said to that sister");
  assert.deepEqual(top.map(t => t.word), ["sister"]);
});

test("interjections never reach the ranking", async () => {
  const { topWords, topLine } = await import("../js/speech.js");
  assert.deepEqual(topWords("ah uhm eh er hmm oh yeah ok wow huh"), []);
  // the shape of a real session: hesitation around two content words
  assert.equal(topLine("ah it s called ah in love yeah uhm a new tab"),
    "1: called 2: love 3: new");
});

test("emotion words are subject matter here, not noise", async () => {
  const { topWords } = await import("../js/speech.js");
  const top = topWords("i felt happy and then i laughed because she felt happy too");
  assert.deepEqual(top, [
    { word: "felt", count: 2 },
    { word: "happy", count: 2 },
    { word: "laughed", count: 1 },
  ]);
});

test("the ranking is ordered by count, alphabetical on ties", async () => {
  const { topWords } = await import("../js/speech.js");
  const top = topWords("banana apple banana cherry apple banana cherry", 5);
  assert.deepEqual(top, [
    { word: "banana", count: 3 },
    { word: "apple", count: 2 },
    { word: "cherry", count: 2 },
  ]);
});

test("the ranking keeps at most five, and copes with nothing to rank", async () => {
  const { topWords } = await import("../js/speech.js");
  assert.equal(topWords("one two three four five six seven eight").length, 5);
  assert.deepEqual(topWords(""), []);
  assert.deepEqual(topWords("the and this that i was"), []);   // all stop words
});

test("the transcriber ranks its own transcript", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "my sister and my sister laughed", 1);
  assert.deepEqual(t.top(2), [{ word: "sister", count: 2 }, { word: "laughed", count: 1 }]);
});

// --- per-word timings on the session clock ---

test("word timings are moved onto the session clock", () => {
  const { t } = make();
  t.setRecording(true, 100);                 // the session is 100 s in
  t.result({
    text: "hello there", final: true, nowS: 102,
    words: [{ word: "hello", start: 0.5, end: 0.9, conf: 0.8 },
            { word: "there", start: 1.0, end: 1.4, conf: 0.6 }],
  });
  assert.deepEqual(t.wordTimings(), [
    { word: "hello", atS: 100.5, endS: 100.9, conf: 0.8 },
    { word: "there", atS: 101.0, endS: 101.4, conf: 0.6 },
  ]);
});

test("a pause in recording does not shift later words", () => {
  const { t } = make();
  t.setRecording(true, 10);
  t.result({ text: "one", final: true, nowS: 11, words: [{ word: "one", start: 0.5, end: 0.8, conf: 1 }] });
  t.setRecording(false, 15);                 // 5 s of audio fed so far
  t.setRecording(true, 300);                 // resumed much later
  // Vosk keeps counting from its own start: 5 s of stream, now at session 300
  t.result({ text: "two", final: true, nowS: 301, words: [{ word: "two", start: 5.5, end: 5.8, conf: 1 }] });
  assert.equal(t.wordTimings()[0].atS, 10.5);
  assert.equal(t.wordTimings()[1].atS, 300.5);
});

test("words without timings do not poison the list", () => {
  const { t } = make();
  t.setRecording(true, 0);
  t.result({ text: "hm", final: true, nowS: 1, words: [{ word: "hm" }] });
  assert.deepEqual(t.wordTimings(), [{ word: "hm", atS: null, endS: null, conf: null }]);
});

test("partials contribute no words: only a final is confirmed", () => {
  const { t } = make();
  t.setRecording(true, 0);
  t.result({ text: "hello", final: false, nowS: 1, words: [{ word: "hello", start: 0.1, end: 0.2, conf: 1 }] });
  assert.deepEqual(t.wordTimings(), []);
});

test("the ranking line is numbered, in order, space separated", async () => {
  const { topLine } = await import("../js/speech.js");
  assert.equal(topLine("my sister and my sister laughed the sister was happy and happy"),
    "1: sister 2: happy 3: laughed");
});

test("the ranking line asks for three and settles for what there is", async () => {
  const { topLine } = await import("../js/speech.js");
  assert.equal(topLine("sister sister"), "1: sister");
  assert.equal(topLine(""), "");
  assert.equal(topLine("the and this that i was"), "");     // nothing but stop words
});

test("the transcriber offers its own ranking line", () => {
  const { t } = make();
  t.setRecording(true, 0);
  say(t, "the cat sat on the cat mat", 1);
  assert.equal(t.topLine(3), "1: cat 2: mat 3: sat");
});
