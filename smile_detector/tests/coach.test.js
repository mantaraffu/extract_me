import { test } from "node:test";
import assert from "node:assert/strict";
import { SmileCoach, ENCOURAGEMENTS, REPRIMANDS } from "../js/coach.js";

/**
 * Feed `seconds` of face at `happyFrac` happy, 10 samples per second. The
 * timer credits a stretch only when both ends are happy, so a block of k+1
 * happy samples is worth k tenths: hence `<=`.
 */
function run(coach, fromS, seconds, happyFrac, visible = true) {
  const verdicts = [];
  const n = Math.round(seconds * 10);
  for (let i = 1; i <= n; i++) {
    const happy = (i % 10) <= Math.round(happyFrac * 10);
    const v = coach.feed(happy, visible, fromS + i / 10);
    if (v) verdicts.push(v);
  }
  return verdicts;
}

function coachWith(spoken) {
  return new SmileCoach({ speak: t => spoken.push(t), nowS: 0 });
}

test("nothing before the first two minutes", () => {
  const spoken = [];
  const c = coachWith(spoken);
  assert.deepEqual(run(c, 0, 119, 0.5), []);
  assert.deepEqual(spoken, []);
  assert.ok(Math.abs(c.nextInS(119) - 1) < 1e-9);
});

test("first verdict at 2:00: above 30% is the first encouragement", () => {
  const spoken = [];
  const c = coachWith(spoken);
  const v = run(c, 0, 120, 0.5);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "encouragement");
  assert.equal(v[0].text, ENCOURAGEMENTS[0]);
  assert.ok(Math.abs(v[0].frac - 0.5) < 0.02);
  assert.equal(v[0].prevFrac, null);
  assert.ok(Math.abs(v[0].atS - 120) < 1e-9);
  assert.deepEqual(spoken, [ENCOURAGEMENTS[0]]);
});

test("the threshold is inclusive: exactly 30% is an encouragement", () => {
  // set the window readings directly so the boundary is exact
  const c = coachWith([]);
  c.happy.seconds = 30; c.visible.seconds = 100;
  assert.equal(c.check(120).kind, "encouragement");
  const d = coachWith([]);
  d.happy.seconds = 29.99; d.visible.seconds = 100;
  assert.equal(d.check(120).kind, "reprimand");
});

test("first verdict below 30% is the first reprimand", () => {
  const spoken = [];
  const c = coachWith(spoken);
  const v = run(c, 0, 120, 0.2);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "reprimand");
  assert.equal(v[0].text, REPRIMANDS[0]);
});

test("after the first verdict a check comes every minute", () => {
  const c = coachWith([]);
  run(c, 0, 120, 0.5);
  assert.ok(Math.abs(c.nextInS(120) - 60) < 1e-9);
  const v = run(c, 120, 60, 0.6);
  assert.equal(v.length, 1);
  assert.ok(Math.abs(v[0].atS - 180) < 1e-9);
  assert.ok(Math.abs(c.nextInS(180) - 60) < 1e-9);
});

test("better than before moves forward in the encouragements", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.5);     // encouragement 0
  run(c, 120, 60, 0.6);    // better -> encouragement 1
  run(c, 180, 60, 0.7);    // better -> encouragement 2
  assert.deepEqual(spoken, ENCOURAGEMENTS.slice(0, 3));
});

test("worse than before moves forward in the reprimands, even when above the threshold", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.9);     // encouragement 0
  run(c, 120, 60, 0.8);    // worse -> reprimand 0
  run(c, 180, 60, 0.7);    // worse -> reprimand 1
  assert.deepEqual(spoken, [ENCOURAGEMENTS[0], REPRIMANDS[0], REPRIMANDS[1]]);
});

test("each list keeps its own cursor across the other's turns", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.5);     // enc 0
  run(c, 120, 60, 0.4);    // worse -> rep 0
  run(c, 180, 60, 0.6);    // better -> enc 1
  run(c, 240, 60, 0.5);    // worse -> rep 1
  assert.deepEqual(spoken, [ENCOURAGEMENTS[0], REPRIMANDS[0], ENCOURAGEMENTS[1], REPRIMANDS[1]]);
});

test("a tie falls back to the threshold", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.0);     // rep 0
  run(c, 120, 60, 0.0);    // same, below 30% -> rep 1
  run(c, 180, 60, 1.0);    // better -> enc 0
  run(c, 240, 60, 1.0);    // same, above 30% -> enc 1
  assert.deepEqual(spoken, [REPRIMANDS[0], REPRIMANDS[1], ENCOURAGEMENTS[0], ENCOURAGEMENTS[1]]);
});

test("the cursor wraps around at the end of a list", () => {
  const spoken = [];
  const c = new SmileCoach({ speak: t => spoken.push(t), encouragements: ["a", "b"], nowS: 0 });
  run(c, 0, 120, 0.5);
  run(c, 120, 60, 0.6);
  run(c, 180, 60, 0.7);
  assert.deepEqual(spoken, ["a", "b", "a"]);
});

test("the fraction is over face time, not wall-clock time", () => {
  const c = coachWith([]);
  run(c, 0, 60, 0, false);        // a minute of empty room
  const v = run(c, 60, 60, 0.5);  // a minute of face, half of it happy
  assert.equal(v.length, 1);
  assert.ok(Math.abs(v[0].frac - 0.5) < 0.02);
  assert.ok(Math.abs(v[0].visibleS - 60) < 0.2);
});

test("a verdict comes at every deadline, even with almost no face", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.5);                 // enc 0, prev = 0.5
  run(c, 120, 55, 0, false);
  const v = run(c, 175, 5, 1.0);       // only 5 s of face in this window, all of it happy
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "encouragement");   // 100% > 50%
  assert.ok(Math.abs(c.prevFrac - 1.0) < 0.02);
  assert.ok(Math.abs(c.nextInS(180) - 60) < 1e-9);
});

test("no face at all: counts as 0% happy, the previous reading is kept", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.5);                 // enc 0, prev = 0.5
  const v = run(c, 120, 60, 0, false); // empty room for a whole window
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "reprimand");       // 0% < 50%
  assert.equal(v[0].frac, 0);
  assert.ok(Math.abs(c.prevFrac - 0.5) < 0.02);   // still the last measured value
  const later = run(c, 180, 60, 0.6);  // compared with 0.5, not with the empty window
  assert.equal(later[0].kind, "encouragement");
  assert.deepEqual(spoken, [ENCOURAGEMENTS[0], REPRIMANDS[0], ENCOURAGEMENTS[1]]);
});

test("first window with no face: a reprimand, and the next verdict is still the first real one", () => {
  const c = coachWith([]);
  const v = run(c, 0, 120, 0, false);
  assert.equal(v[0].kind, "reprimand");
  assert.equal(c.prevFrac, null);
  assert.ok(Math.abs(c.nextInS(120) - 60) < 1e-9);
});

test("check() forces the verdict now and restarts the clock", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 30, 0.8);
  const v = c.check(30);
  assert.equal(v.kind, "encouragement");
  assert.deepEqual(spoken, [ENCOURAGEMENTS[0]]);
  assert.ok(Math.abs(c.nextInS(30) - 60) < 1e-9);
  assert.equal(c.fraction(), null);
});

test("reset drops window, cursors and the previous reading", () => {
  const c = coachWith([]);
  run(c, 0, 120, 0.5);
  run(c, 120, 60, 0.6);
  c.reset(200);
  assert.equal(c.prevFrac, null);
  assert.equal(c.encIdx, -1);
  assert.equal(c.last, null);
  assert.ok(Math.abs(c.nextInS(200) - 120) < 1e-9);
});

test("no speaker: the verdict still comes back", () => {
  const c = new SmileCoach({ nowS: 0 });
  const v = run(c, 0, 120, 0.5);
  assert.equal(v.length, 1);
});

// --- browserSpeaker on a fake Web Speech API ---

function fakeSpeech() {
  const calls = { spoken: [], cancels: 0 };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = {
    speaking: false, pending: false,
    getVoices: () => [{ name: "It", lang: "it-IT" }, { name: "Sam", lang: "en-US" }],
    cancel() { calls.cancels++; },
    speak(u) { calls.spoken.push(u); },
  };
  return calls;
}
function dropFakeSpeech() { delete globalThis.SpeechSynthesisUtterance; delete globalThis.speechSynthesis; }

test("browserSpeaker: null without the API, English voice with it", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  dropFakeSpeech();
  assert.equal(browserSpeaker(), null);
  const calls = fakeSpeech();
  try {
    const speak = browserSpeaker();
    speak("hi");
    assert.equal(calls.spoken.length, 1);
    assert.equal(calls.spoken[0].voice.name, "Sam");
    assert.equal(calls.spoken[0].lang, "en-US");
    assert.equal(calls.cancels, 0);       // nothing was being said: no cancel
    speechSynthesis.speaking = true;
    speak("again");
    assert.equal(calls.cancels, 1);       // cut the previous line short
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: reports blocked, error and speaking; ignores its own interruptions", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const calls = fakeSpeech();
  try {
    const seen = [];
    const speak = browserSpeaker({ onState: (st, text, detail) => seen.push([st, text, detail]) });
    speak("one");
    const u = calls.spoken[0];
    u.onerror({ error: "not-allowed" });
    u.onerror({ error: "interrupted" });
    u.onerror({ error: "synthesis-failed" });
    u.onstart(); u.onend();
    assert.deepEqual(seen, [
      ["blocked", "one", "not-allowed"], ["error", "one", "synthesis-failed"],
      ["speaking", "one", undefined], ["done", "one", undefined],
    ]);
  } finally { dropFakeSpeech(); }
});
