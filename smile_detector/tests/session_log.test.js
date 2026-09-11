import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionLog, sessionFileName, transcriptFileName } from "../js/session_log.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("time splits between face / no face and smiling / not smiling", () => {
  const log = new SessionLog({ nowS: 0 });
  log.feed({ nowS: 0, label: "happy", positive: true });
  log.feed({ nowS: 0.1, label: "happy", positive: true });     // +0.1 smiling
  log.feed({ nowS: 0.3, label: "neutral", positive: false });  // +0.2 not smiling
  log.feed({ nowS: 0.6 });                                     // +0.3 absent
  const j = log.toJSON({ nowS: 0.6 });
  near(j.face.visibleS, 0.3); near(j.face.absentS, 0.3);
  near(j.smile.smilingS, 0.1); near(j.smile.notSmilingS, 0.2);
  near(j.smile.pctOfFaceTime, 33.33, 0.01);
  near(j.emotions.secondsByLabel.happy, 0.1); near(j.emotions.secondsByLabel.neutral, 0.2);
  assert.equal(j.frames, 4);
});

test("a long gap is capped: a background tab does not inflate the totals", () => {
  const log = new SessionLog({ nowS: 0, maxStepS: 0.5 });
  log.feed({ nowS: 0, label: "happy", positive: true });
  log.feed({ nowS: 30, label: "happy", positive: true });
  near(log.toJSON({ nowS: 30 }).smile.smilingS, 0.5);
});

test("blinks are counted as events, per minute of face time", () => {
  const log = new SessionLog({ nowS: 0 });
  for (let i = 0; i <= 300; i++) log.feed({ nowS: i * 0.1, label: "neutral", blinked: i % 100 === 50 });
  const j = log.toJSON({ nowS: 30 });
  assert.equal(j.blink.count, 3);
  near(j.blink.perMinOfFaceTime, 6, 0.01);
});

test("hands: seconds with one and two hands, rect time and appearances, palm travel", () => {
  const log = new SessionLog({ nowS: 0, frameWidth: 1000 });
  log.feed({ nowS: 0, hands: 1, palms: { Left: { x: 0, y: 0 } } });
  log.feed({ nowS: 0.1, hands: 1, palms: { Left: { x: 30, y: 40 } } });                                  // travel 50
  log.feed({ nowS: 0.2, hands: 2, palms: { Left: { x: 30, y: 40 }, Right: { x: 500, y: 500 } }, rect: true });
  log.feed({ nowS: 0.3, hands: 2, palms: { Left: { x: 30, y: 40 }, Right: { x: 500, y: 600 } }, rect: true });  // +100
  log.feed({ nowS: 0.4, hands: 0, palms: null });
  log.feed({ nowS: 0.5, hands: 2, palms: { Left: { x: 0, y: 0 }, Right: { x: 0, y: 0 } }, rect: true });        // no travel: previous unknown
  const j = log.toJSON({ nowS: 0.5 });
  near(j.hands.secondsWithHands, 0.4); near(j.hands.secondsWithTwoHands, 0.3);
  near(j.hands.rectS, 0.3); assert.equal(j.hands.rectAppearances, 2);
  assert.equal(j.hands.travelPx, 150); near(j.hands.travelFrameWidths, 0.15);
});

test("verdicts are recorded with their instant and shares", () => {
  const log = new SessionLog({ startedAt: Date.UTC(2026, 0, 1, 12, 0, 0), nowS: 100 });
  log.verdict({ kind: "reprimand", text: "smile more", frac: 0.123, prevFrac: null }, 220);
  log.verdict({ kind: "steady", text: "keep going!", frac: 0.5, prevFrac: 0.49 }, 280);
  const j = log.toJSON({ nowS: 300 });
  assert.equal(j.coach.verdicts.length, 2);
  assert.deepEqual(j.coach.counts, { reprimand: 1, steady: 1 });
  assert.equal(j.coach.verdicts[0].atS, 120);
  assert.equal(j.coach.verdicts[0].at, "2026-01-01T12:02:00.000Z");
  assert.equal(j.coach.verdicts[0].roundPct, 12.3);
  assert.equal(j.coach.verdicts[0].referencePct, null);
  assert.equal(j.coach.verdicts[1].referencePct, 49);
  assert.equal(j.startedAt, "2026-01-01T12:00:00.000Z");
  assert.equal(j.endedAt, "2026-01-01T12:03:20.000Z");
  assert.equal(j.elapsedS, 200);
});

test("timeline: one row per minute since the start", () => {
  const log = new SessionLog({ nowS: 10 });
  for (let t = 10; t <= 130; t += 0.5) log.feed({ nowS: t, label: "happy", positive: t < 70, blinked: t === 100 });
  const j = log.toJSON({ nowS: 130 });
  assert.equal(j.timeline.length, 3);
  near(j.timeline[0].smilingS, 59.5, 0.01);   // 10..69.5: positive
  assert.equal(j.timeline[1].blinks, 1);
  near(j.timeline[2].faceS, 0.5, 0.01);
});

test("the file name carries the local start time", () => {
  const name = sessionFileName(new Date(2026, 8, 8, 9, 5, 7).getTime());
  assert.equal(name, "smile_session_2026-09-08_09-05-07.json");
});

test("speech: the session file carries a pointer, not the words", () => {
  const log = new SessionLog({ nowS: 0 });
  log.feed({ nowS: 0, label: "neutral" });
  log.transcript({
    text: "i came here with my sister", words: 6, conf: 0.72, recordedS: 14.2,
    file: "smile_transcript_x.json", sessionFile: "smile_session_x.json",
  });
  const j = log.toJSON({ nowS: 20 });
  assert.equal(j.format, 3);
  assert.equal(j.speech.transcript, "smile_transcript_x.json");
  assert.equal(j.speech.words, 6);
  assert.equal(JSON.stringify(j).includes("my sister"), false, "the words leaked into the session file");
});

test("speech: the transcript is its own document, pointing back", () => {
  const log = new SessionLog({ startedAt: Date.UTC(2026, 0, 2, 3, 4, 5), nowS: 0 });
  log.transcript({
    text: "i came here", words: 3, conf: 0.5, recordedS: 4,
    file: "smile_transcript_x.json", sessionFile: "smile_session_x.json",
  });
  log.speechStats({ finals: 2 });
  const t = log.transcriptJSON({ nowS: 10, reason: "close" });
  assert.equal(t.kind, "transcript");
  assert.equal(t.text, "i came here");
  assert.equal(t.words, 3);
  assert.equal(t.recordedS, 4);
  assert.equal(t.session, "smile_session_x.json");
  assert.equal(t.reason, "close");
  assert.equal(t.diagnostics.finals, 2);
});

test("speech: a silent session writes no transcript at all", () => {
  const log = new SessionLog({ nowS: 0 });
  assert.equal(log.transcriptJSON({ nowS: 1 }), null);
  assert.equal(log.toJSON({ nowS: 1 }).speech, null);
  log.transcript({ text: "", words: 0, conf: null, recordedS: 0, file: "f.json" });
  assert.equal(log.transcriptJSON({ nowS: 1 }), null);
  assert.equal(log.toJSON({ nowS: 1 }).speech, null);
});

test("the two files of one session share a timestamp", () => {
  const at = Date.UTC(2026, 0, 2, 3, 4, 5);
  const a = sessionFileName(at), b = transcriptFileName(at);
  assert.match(a, /^smile_session_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/);
  assert.match(b, /^smile_transcript_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/);
  assert.equal(a.replace("session", "X"), b.replace("transcript", "X"));
});

test("speech diagnostics ride along with the transcript, not the session", () => {
  const log = new SessionLog({ nowS: 0 });
  log.speechStats({ finals: 3, chunks: 900 });
  log.transcript({ text: "something", words: 1, conf: null, recordedS: 1, file: "f.json" });
  assert.equal(log.transcriptJSON({ nowS: 2 }).diagnostics.chunks, 900);
  assert.equal(log.toJSON({ nowS: 2 }).speech.diagnostics, undefined);
});

test("speech: the ranking line is the last thing in the transcript file", () => {
  const log = new SessionLog({ nowS: 0 });
  log.transcript({
    text: "my sister laughed", words: 3, conf: 0.5, recordedS: 4,
    top: [{ word: "sister", count: 1 }], top3: "1: sister 2: laughed",
    file: "f.json", sessionFile: "s.json",
  });
  const t = log.transcriptJSON({ nowS: 10 });
  assert.equal(t.top3, "1: sister 2: laughed");
  assert.equal(Object.keys(t).at(-1), "top3", "the ranking has to come last");
});

test("coach: the talk diagnostics live in the session file, which is always written", () => {
  const log = new SessionLog({ nowS: 0 });
  assert.equal(log.toJSON({ nowS: 1 }).coach.talk, null);
  log.coachStats({ talk: "on", built: true, verdicts: 3, spoken: 3, postponed: 1 });
  const j = log.toJSON({ nowS: 2 });
  assert.equal(j.coach.talk.talk, "on");
  assert.equal(j.coach.talk.verdicts, 3);
  assert.equal(j.coach.talk.spoken, 3);
  // a silent session writes no transcript, so this cannot live there instead
  assert.equal(log.transcriptJSON({ nowS: 2 }), null);
});
