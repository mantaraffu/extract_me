import { test } from "node:test";
import assert from "node:assert/strict";
import { SmileCoach, ENCOURAGEMENTS, REPRIMANDS, STEADY } from "../js/coach.js";

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

test("the first verdict goes by the threshold, later ties say keep going", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.0);     // first: below 30% -> rep 0
  run(c, 120, 60, 0.0);    // unchanged, but at zero: not a tie, a reprimand
  run(c, 180, 60, 1.0);    // better -> enc 0
  run(c, 240, 60, 1.0);    // unchanged and smiling -> steady, no cursor moved
  run(c, 300, 60, 0.5);    // worse -> rep 2
  assert.deepEqual(spoken, [REPRIMANDS[0], REPRIMANDS[1], ENCOURAGEMENTS[0], STEADY, REPRIMANDS[2]]);
  assert.equal(c.last.kind, "reprimand");
});

test("unchanged means within the tie margin", () => {
  const c = new SmileCoach({ tieMargin: 0.05, nowS: 0 });
  run(c, 0, 120, 0.5);
  c.happy.seconds = 54; c.visible.seconds = 100;   // 54% vs 50%: within 5 points
  assert.equal(c.check(180).kind, "steady");
  c.happy.seconds = 60; c.visible.seconds = 100;   // 60% vs the 54% just measured: beyond it
  assert.equal(c.check(240).kind, "encouragement");
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

test("a reference passed to feed wins over the previous window", () => {
  const spoken = [];
  const c = coachWith(spoken);
  // session share 0.7 all along: a 50% window is worse, a 90% window is better
  const runRef = (from, secs, frac, ref) => {
    const out = [];
    for (let i = 1; i <= secs * 10; i++) {
      const v = c.feed((i % 10) <= Math.round(frac * 10), true, from + i / 10, ref);
      if (v) out.push(v);
    }
    return out;
  };
  const first = runRef(0, 120, 0.5, 0.7);
  assert.equal(first[0].kind, "encouragement");   // first verdict: threshold, not the reference
  const a = runRef(120, 60, 0.5, 0.7);
  assert.equal(a[0].kind, "reprimand");
  assert.ok(Math.abs(a[0].prevFrac - 0.7) < 1e-9);
  const b = runRef(180, 60, 0.9, 0.7);
  assert.equal(b[0].kind, "encouragement");
  assert.deepEqual(spoken, [ENCOURAGEMENTS[0], REPRIMANDS[0], ENCOURAGEMENTS[1]]);
});

test("a null reference falls back to the previous window", () => {
  const c = coachWith([]);
  run(c, 0, 120, 0.5);
  c.feed(true, true, 120.1, 0.9);   // reference set...
  c.feed(true, true, 120.2, null);  // ...and withdrawn: back to prevFrac
  assert.equal(c.reference, null);
  const v = run(c, 120.2, 59.8, 0.8);
  assert.equal(v[0].kind, "encouragement");   // 80% > previous window's 50%
});

// --- browserSpeaker on a fake Web Speech API ---

function fakeSpeech(voices = [{ name: "It", lang: "it-IT" }, { name: "Sam", lang: "en-US" }]) {
  const calls = { spoken: [], cancels: 0, voices, listeners: [] };
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = {
    speaking: false, pending: false,
    getVoices: () => calls.voices,
    addEventListener: (ev, fn) => { if (ev === "voiceschanged") calls.listeners.push(fn); },
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

test("a share stuck at zero never says keep going, and does not repeat itself", () => {
  const spoken = [];
  const c = coachWith(spoken);
  for (let i = 0; i < 5; i++) run(c, i * 60, 60, 0.0);   // a face, never smiling
  assert.ok(!spoken.includes(STEADY), `said "${STEADY}" at 0%: ${spoken.join(" | ")}`);
  assert.deepEqual(spoken, REPRIMANDS.slice(0, spoken.length));   // escalates, no repeats
});

test("a tie is still a tie as soon as there is some smiling", () => {
  const spoken = [];
  const c = coachWith(spoken);
  run(c, 0, 120, 0.4);
  run(c, 120, 60, 0.4);
  assert.equal(c.last.kind, "steady");
  assert.equal(spoken.at(-1), STEADY);
});

test("steadyMin raises the floor under the steady line", () => {
  const c = new SmileCoach({ steadyMin: 0.2, nowS: 0 });
  run(c, 0, 120, 0.1);
  run(c, 120, 60, 0.1);      // unchanged at 10%, below the floor
  assert.equal(c.last.kind, "reprimand");
});

test("browserSpeaker: a language tag matches whatever its spelling", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const calls = fakeSpeech();
  try {
    // "en_US" is how the tag gets written by hand; voices report "en-US"
    for (const lang of ["en-US", "en_US", "EN-us", "en"]) {
      browserSpeaker({ lang })("hi");
      assert.equal(calls.spoken.at(-1).voice?.name, "Sam", `no voice for ${lang}`);
      assert.equal(calls.spoken.at(-1).lang, "en-US", `wrong tag for ${lang}`);
    }
    browserSpeaker({ lang: "it" })("ciao");
    assert.equal(calls.spoken.at(-1).voice?.name, "It");
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: an English variant is taken over a system voice", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const calls = fakeSpeech([{ name: "It", lang: "it-IT" }, { name: "Brit", lang: "en-GB" }]);
  try {
    browserSpeaker({ lang: "en-US" })("hi");      // no en-US on this machine
    assert.equal(calls.spoken.at(-1).voice?.name, "Brit");   // not the Italian default
    assert.equal(calls.spoken.at(-1).lang, "en-GB");
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: never falls back to a voice of another language", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const states = [];
  const calls = fakeSpeech([{ name: "It", lang: "it-IT" }, { name: "Fr", lang: "fr-FR" }]);
  try {
    browserSpeaker({ lang: "en-US", onState: (s, t, d) => states.push([s, d]) })("hi");
    assert.equal(calls.spoken.at(-1).voice, undefined);      // rather than the Italian one
    assert.equal(calls.spoken.at(-1).lang, "en-us");         // never the system locale
    assert.ok(states.some(([s, d]) => s === "error" && /no en voice/.test(d)), states.join("|"));
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: voices arriving late still get used", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const calls = fakeSpeech([]);                   // getVoices() is empty at first, as it usually is
  try {
    const speak = browserSpeaker({ lang: "en-US" });
    speak("too early");
    assert.equal(calls.spoken.at(-1).voice, undefined);
    calls.voices = [{ name: "Sam", lang: "en-US" }];
    for (const fn of calls.listeners) fn();       // the browser announces the list
    speak("now");
    assert.equal(calls.spoken.at(-1).voice?.name, "Sam");
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: an exact tag wins over a variant", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const calls = fakeSpeech([{ name: "Brit", lang: "en-GB" }, { name: "Sam", lang: "en-US" }]);
  try {
    browserSpeaker({ lang: "en-US" })("hi");
    assert.equal(calls.spoken.at(-1).voice?.name, "Sam");
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: the system's own voice wins, when it is English", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  // getVoices() lists the good and the ancient together: "Ralph" is first here
  const calls = fakeSpeech([
    { name: "Ralph", lang: "en-US" },
    { name: "Samantha", lang: "en-US", default: true },
    { name: "Alice", lang: "it-IT" },
  ]);
  try {
    browserSpeaker({ lang: "en_US" })("hi");
    assert.equal(calls.spoken.at(-1).voice?.name, "Samantha");
  } finally { dropFakeSpeech(); }
});

test("browserSpeaker: a default in another language is ignored", async () => {
  const { browserSpeaker } = await import("../js/coach.js");
  const calls = fakeSpeech([
    { name: "Alice", lang: "it-IT", default: true },
    { name: "Sam", lang: "en-US" },
  ]);
  try {
    browserSpeaker({ lang: "en_US" })("hi");
    assert.equal(calls.spoken.at(-1).voice?.name, "Sam", "took the Italian default");
  } finally { dropFakeSpeech(); }
});

// --- talk coach ---

test("talkCoach: nothing before the first verdict is due", async () => {
  const { TalkCoach } = await import("../js/coach.js");
  const spoken = [];
  const c = new TalkCoach({ firstS: 120, speak: t => spoken.push(t), nowS: 0 });
  assert.equal(c.feed(0.1, 119), null);
  assert.deepEqual(spoken, []);
  assert.equal(c.nextInS(119), 1);
});

test("talkCoach: under half the session asks for more, over it asks for less", async () => {
  const { TalkCoach, TALK_MORE, TALK_LESS } = await import("../js/coach.js");
  const spoken = [];
  const c = new TalkCoach({ firstS: 10, everyS: 10, speak: t => spoken.push(t), nowS: 0 });
  assert.equal(c.feed(0.2, 10).text, TALK_MORE);
  assert.equal(c.feed(0.8, 20).text, TALK_LESS);
  assert.deepEqual(spoken, [TALK_MORE, TALK_LESS]);
});

test("talkCoach: exactly on the threshold there is nothing left to ask for", async () => {
  const { TalkCoach, TALK_LESS } = await import("../js/coach.js");
  const c = new TalkCoach({ firstS: 10, nowS: 0 });
  assert.equal(c.feed(0.5, 10).text, TALK_LESS);
});

test("talkCoach: an unknown share counts as silence", async () => {
  const { TalkCoach, TALK_MORE } = await import("../js/coach.js");
  const c = new TalkCoach({ firstS: 10, nowS: 0 });
  const v = c.feed(null, 10);
  assert.equal(v.text, TALK_MORE);
  assert.equal(v.frac, 0);
});

test("talkCoach: verdicts keep to their interval and do not escalate", async () => {
  const { TalkCoach, TALK_MORE } = await import("../js/coach.js");
  const spoken = [];
  const c = new TalkCoach({ firstS: 10, everyS: 30, speak: t => spoken.push(t), nowS: 0 });
  for (let t = 1; t <= 80; t++) c.feed(0.1, t);
  assert.deepEqual(spoken, [TALK_MORE, TALK_MORE, TALK_MORE]);   // 10, 40, 70
});

test("talkCoach: a custom threshold moves the line", async () => {
  const { TalkCoach, TALK_LESS } = await import("../js/coach.js");
  const c = new TalkCoach({ firstS: 10, threshold: 0.2, nowS: 0 });
  assert.equal(c.feed(0.25, 10).text, TALK_LESS);
});

test("talkCoach: a verdict due while the other coach talks is postponed, not lost", async () => {
  const { TalkCoach, TALK_MORE } = await import("../js/coach.js");
  const spoken = [];
  let busyUntil = 16;
  const c = new TalkCoach({
    firstS: 10, everyS: 60, retryS: 8,
    canSpeak: now => now >= busyUntil,
    speak: t => spoken.push(t), nowS: 0,
  });
  assert.equal(c.feed(0.1, 10), null, "spoke over the other coach");
  assert.deepEqual(spoken, []);
  assert.equal(c.feed(0.1, 17), null, "the retry was not honoured");   // postponed to 18
  const v = c.feed(0.1, 18);
  assert.equal(v.text, TALK_MORE);
  assert.deepEqual(spoken, [TALK_MORE]);
});

test("talkCoach: without a canSpeak it simply speaks", async () => {
  const { TalkCoach, TALK_MORE } = await import("../js/coach.js");
  const spoken = [];
  const c = new TalkCoach({ firstS: 10, speak: t => spoken.push(t), nowS: 0 });
  c.feed(0.1, 10);
  assert.deepEqual(spoken, [TALK_MORE]);
});

test("talkCoach: yielding to the other coach is not yielding to itself", async () => {
  const { TalkCoach, TALK_MORE } = await import("../js/coach.js");
  // the contract the app wires up: one voice, a gap only after somebody else
  const GAP = 6;
  let lastSpoke = { atS: -1e9, who: null };
  const spoken = [];
  const c = new TalkCoach({
    firstS: 4, everyS: 4, retryS: 8,          // interval shorter than the gap, on purpose
    canSpeak: t => lastSpoke.who === "talk" || t - lastSpoke.atS >= GAP,
    speak: t => { spoken.push(t); },
    nowS: 0,
  });
  // the app stamps who spoke at the moment the line is handed over
  const tick = now => {
    const before = spoken.length;
    c.feed(0, now);
    if (spoken.length > before) lastSpoke = { atS: now, who: "talk" };
  };
  for (let t = 0; t <= 40; t += 0.5) tick(t);
  assert.equal(spoken.length, 10, `fell silent after ${spoken.length}: ${spoken.join(",")}`);
  assert.ok(spoken.every(s => s === TALK_MORE));
});

test("talkCoach: the other coach speaking still pushes it back", async () => {
  const { TalkCoach } = await import("../js/coach.js");
  let lastSpoke = { atS: 10, who: "coach" };   // the smile coach just spoke
  const spoken = [];
  const c = new TalkCoach({
    firstS: 10, everyS: 60, retryS: 8,
    canSpeak: t => lastSpoke.who === "talk" || t - lastSpoke.atS >= 6,
    speak: t => spoken.push(t), nowS: 0,
  });
  assert.equal(c.feed(0, 10), null, "spoke over the smile coach");
  assert.deepEqual(spoken, []);
  assert.ok(c.feed(0, 18), "never came back");
});

test("talkCoach: counts what it delivered and what the voice took", async () => {
  const { TalkCoach } = await import("../js/coach.js");
  const heard = new TalkCoach({ firstS: 1, everyS: 5, speak: () => true, nowS: 0 });
  for (let t = 0; t <= 20; t += 0.5) heard.feed(0, t);
  assert.equal(heard.stats.verdicts, 4);
  assert.equal(heard.stats.spoken, 4);
  assert.equal(heard.stats.noSpeaker, 0);

  // a verdict reached with no voice to take it: silent for a different reason
  const mute = new TalkCoach({ firstS: 1, everyS: 5, speak: () => false, nowS: 0 });
  for (let t = 0; t <= 20; t += 0.5) mute.feed(0, t);
  assert.equal(mute.stats.verdicts, 4);
  assert.equal(mute.stats.spoken, 0);
  assert.equal(mute.stats.noSpeaker, 4);
});

test("talkCoach: postponements are counted apart from verdicts", async () => {
  const { TalkCoach } = await import("../js/coach.js");
  let busy = true;
  const c = new TalkCoach({
    firstS: 1, everyS: 5, retryS: 2,
    canSpeak: () => !busy, speak: () => true, nowS: 0,
  });
  c.feed(0, 1); c.feed(0, 3);
  assert.equal(c.stats.postponed, 2);
  assert.equal(c.stats.verdicts, 0);
  busy = false;
  c.feed(0, 5);
  assert.equal(c.stats.verdicts, 1);
});
