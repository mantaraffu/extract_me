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
