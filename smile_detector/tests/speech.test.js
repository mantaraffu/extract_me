import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechRouter, COMMANDS, OPEN_FREE, UNK, grammar, normalize } from "../js/speech.js";

function routerWith(opts = {}) {
  const commands = [], segments = [];
  const r = new SpeechRouter({
    onCommand: c => commands.push(c), onFree: s => segments.push(s), nowS: 0, ...opts,
  });
  return { r, commands, segments };
}

/** A final result, the shape the adapter feeds in. */
function say(r, text, nowS, extra = {}) {
  return r.result({ text, final: true, nowS, ...extra });
}

test("grammar is the commands plus the unknown token", () => {
  assert.deepEqual(grammar(["Start", "Tell me!"]), ["start", "tell me", UNK]);
  assert.ok(grammar().includes(UNK));
});

test("normalize drops punctuation and collapses spaces", () => {
  assert.equal(normalize("  Tell   me, please! "), "tell me please");
  assert.equal(normalize(null), "");
});

test("a word in the grammar is a command", () => {
  const { r, commands } = routerWith();
  const v = say(r, "save session", 5);
  assert.equal(v.kind, "command");
  assert.equal(v.command, "save session");
  assert.deepEqual(commands.map(c => c.command), ["save session"]);
});

test("unknown audio and words outside the grammar are dropped", () => {
  const { r, commands } = routerWith();
  assert.equal(say(r, UNK, 1), null);
  assert.equal(say(r, "banana", 2), null);
  assert.equal(say(r, "", 3), null);
  assert.deepEqual(commands, []);
});

test("partial results never produce a command", () => {
  const { r, commands } = routerWith();
  assert.equal(r.result({ text: "reset", final: false, nowS: 1 }), null);
  assert.deepEqual(commands, []);
});

test("the opening command switches to free mode and is not itself a command", () => {
  const { r, commands } = routerWith();
  assert.equal(say(r, OPEN_FREE, 10), null);
  assert.equal(r.mode, "free");
  assert.deepEqual(commands, []);
});

test("free window: pauses do not truncate, silence closes it", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5 });
  say(r, OPEN_FREE, 0);
  say(r, "i came here", 1);
  assert.equal(r.tick(2.0), null);            // 1.0 s of quiet: still open
  say(r, "with my sister", 2.4);              // the pause was mid-thought
  assert.equal(r.tick(3.5), null);
  const seg = r.tick(4.0);                    // 1.6 s since the last words
  assert.equal(seg.text, "i came here with my sister");
  assert.equal(seg.endedBy, "silence");
  assert.equal(r.mode, "command");
  assert.equal(segments.length, 1);
});

test("free window: the hard ceiling closes it on whoever never stops", () => {
  const { r, segments } = routerWith({ freeMaxS: 5, freeSilenceS: 1.5 });
  say(r, OPEN_FREE, 0);
  for (let t = 1; t <= 5; t++) say(r, "and another thing", t);
  const seg = r.tick(5.1);
  assert.equal(seg.endedBy, "timeout");
  assert.equal(segments.length, 1);
  assert.ok(seg.durationS >= 5);
});

test("an empty window closes without producing a segment", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1, freeLeadS: 1 });
  say(r, OPEN_FREE, 0);
  assert.equal(r.tick(1.5), null);       // the lead-in ran out with nothing said
  assert.equal(r.mode, "command");
  assert.deepEqual(segments, []);
});

test("commands work again after the window closed", () => {
  const { r, commands } = routerWith({ freeSilenceS: 1 });
  say(r, OPEN_FREE, 0);
  say(r, "something", 0.5);
  r.tick(2);
  say(r, "reset", 3);
  assert.deepEqual(commands.map(c => c.command), ["reset"]);
});

test("a coach phrase said verbatim in the free window is dropped", () => {
  const { r, segments } = routerWith({ coachPhrases: ["smile more please"], freeSilenceS: 1 });
  say(r, OPEN_FREE, 0);
  say(r, "Smile more, please!", 0.5);
  assert.equal(r.tick(2), null);
  assert.deepEqual(segments, []);
});

test("speech overlapping the coach is kept but flagged", () => {
  const { r } = routerWith({ freeSilenceS: 1 });
  say(r, OPEN_FREE, 0);
  say(r, "i think it is funny", 0.5, { speaking: true });
  const seg = r.tick(2);
  assert.equal(seg.coachOverlap, true);
  assert.equal(seg.text, "i think it is funny");
});

test("confidence is averaged over the window", () => {
  const { r } = routerWith({ freeSilenceS: 1 });
  say(r, OPEN_FREE, 0);
  say(r, "one", 0.2, { conf: 0.9 });
  say(r, "two", 0.4, { conf: 0.7 });
  const seg = r.tick(2);
  assert.equal(seg.conf, 0.8);
});

test("freeLeftS counts down, and is null in command mode", () => {
  const { r } = routerWith({ freeMaxS: 20, freeSilenceS: 2, freeLeadS: 2 });
  assert.equal(r.freeLeftS(0), null);
  say(r, OPEN_FREE, 0);
  assert.equal(r.freeLeftS(0.5), 1.5);        // the lead-in is the nearer deadline
});

test("reset drops an open window", () => {
  const { r, segments } = routerWith();
  say(r, OPEN_FREE, 0);
  say(r, "half a sentence", 0.5);
  r.reset(1);
  assert.equal(r.mode, "command");
  assert.equal(r.tick(10), null);
  assert.deepEqual(segments, []);
});

test("COMMANDS contains the opening command", () => {
  assert.ok(COMMANDS.map(normalize).includes(normalize(OPEN_FREE)));
});

test("the tail of the opening command does not become the transcript", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  say(r, "me", 0.1);                     // the "me" of "tell me", still in the audio
  assert.deepEqual(r.parts, []);
  say(r, "i came here with my sister", 1.0);
  const seg = r.tick(2.6);
  assert.equal(seg.text, "i came here with my sister");
  assert.equal(segments.length, 1);
});

test("the whole opening command echoed back is dropped too", () => {
  const { r } = routerWith({ freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  say(r, "tell me", 0.1);
  assert.deepEqual(r.parts, []);
});

test("an echo is only dropped first: the same word later is real speech", () => {
  const { r } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  say(r, "it was funny", 0.5);
  say(r, "me", 1.0);                     // now it is something the visitor said
  const seg = r.tick(2.6);
  assert.equal(seg.text, "it was funny me");
});

test("a visitor who pauses to think keeps the window", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  assert.equal(r.tick(2), null);         // 2 s of thinking: the old rule closed here
  assert.equal(r.tick(3.5), null);
  say(r, "i think it was strange", 3.8);
  const seg = r.tick(5.4);
  assert.equal(seg.text, "i think it was strange");
  assert.equal(segments.length, 1);
});

test("but a window nobody ever speaks into still closes on the lead-in", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  assert.equal(r.tick(3.9), null);
  assert.equal(r.tick(4.1), null);       // closed, but empty: no segment
  assert.equal(r.mode, "command");
  assert.deepEqual(segments, []);
});

test("once speech started, the shorter silence rule takes over again", () => {
  const { r } = routerWith({ freeSilenceS: 1.5, freeLeadS: 10 });
  say(r, OPEN_FREE, 0);
  say(r, "done", 0.5);
  assert.equal(r.tick(1.5), null);
  const seg = r.tick(2.1);               // 1.6 s after the words, not the 10 s lead
  assert.equal(seg.text, "done");
});

test("freeLeftS counts the lead-in before anything is said", () => {
  const { r } = routerWith({ freeMaxS: 20, freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  assert.equal(r.freeLeftS(1), 3);       // the lead, not the 1.5 s silence
  say(r, "hello", 1);
  assert.equal(r.freeLeftS(1.5), 1);     // now the silence rule
});

test("partials keep a long sentence alive: Vosk only finalises at a pause", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  // one long utterance: nothing but partials until the speaker stops
  for (let t = 1; t <= 8; t++) r.result({ text: "i came here with my", final: false, nowS: t });
  assert.equal(r.tick(8.1), null, "closed in the middle of the sentence");
  say(r, "i came here with my sister", 8.5);
  const seg = r.tick(10.1);
  assert.equal(seg.text, "i came here with my sister");
  assert.equal(segments.length, 1);
});

test("a partial that is only the command echo does not start the clock", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 2 });
  say(r, OPEN_FREE, 0);
  r.result({ text: "me", final: false, nowS: 0.1 });
  assert.equal(r.heard, false);
  assert.equal(r.tick(2.1), null);       // still closes on the lead-in
  assert.deepEqual(segments, []);
});

test("normalize strips the brackets off [unk], so UNK is never matched directly", () => {
  assert.equal(normalize(UNK), "unk");
  assert.notEqual(normalize(UNK), UNK);        // the comparison that silently never fired
});

test("an out-of-vocabulary result is dropped, not counted as speech", () => {
  const { r, commands, segments } = routerWith({ freeLeadS: 2 });
  assert.equal(say(r, "[unk]", 1), null);
  assert.equal(say(r, "[unk] [unk]", 2), null);
  assert.deepEqual(commands, []);
  assert.deepEqual(segments, []);
  assert.equal(r.stats.unknown, 2);
});

test("inline [unk] markers are stripped out of a transcript", () => {
  const { r } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  say(r, "i came [unk] here with [unk] my sister", 1);
  const seg = r.tick(2.6);
  assert.equal(seg.text, "i came here with my sister");
});

test("a free result of nothing but markers does not start the clock", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 2 });
  say(r, OPEN_FREE, 0);
  say(r, "[unk] [unk]", 0.5);
  assert.equal(r.heard, false);
  assert.equal(r.tick(2.1), null);
  assert.deepEqual(segments, []);
});

test("a window that shuts before Vosk finalises still keeps what it heard", () => {
  const { r, segments } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  // the whole sentence arrives as partials; the final never comes
  r.result({ text: "i came", final: false, nowS: 1 });
  r.result({ text: "i came here with", final: false, nowS: 1.5 });
  r.result({ text: "i came here with my sister", final: false, nowS: 2 });
  const seg = r.tick(3.6);
  assert.equal(seg.text, "i came here with my sister");
  assert.equal(seg.fromPartial, true);
  assert.equal(segments.length, 1);
});

test("a finalised utterance drops its partial instead of repeating it", () => {
  const { r } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  r.result({ text: "i came here", final: false, nowS: 1 });
  say(r, "i came here", 1.5);             // same words, now final
  const seg = r.tick(3.1);
  assert.equal(seg.text, "i came here");  // not "i came here i came here"
  assert.equal(seg.fromPartial, false);
});

test("finalised sentences and a trailing unfinalised one are joined", () => {
  const { r } = routerWith({ freeSilenceS: 1.5, freeLeadS: 4 });
  say(r, OPEN_FREE, 0);
  say(r, "first sentence", 1);
  r.result({ text: "and then some more", final: false, nowS: 2 });
  const seg = r.tick(3.6);
  assert.equal(seg.text, "first sentence and then some more");
  assert.equal(seg.fromPartial, true);
});
