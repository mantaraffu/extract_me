import { test } from "node:test";
import assert from "node:assert/strict";
import { BlinkCounter, ear } from "../js/blink.js";

test("blink counted by duration, not by frames (5 fps)", () => {
  const b = new BlinkCounter({ minClosedMs: 40, maxClosedMs: 700 });
  assert.equal(b.feed(false, 0), false);
  assert.equal(b.feed(true, 0.2), false);
  assert.equal(b.feed(false, 0.4), true);
  assert.equal(b.blinks, 1);
});

test("closure too short is ignored", () => {
  const b = new BlinkCounter({ minClosedMs: 40 });
  b.feed(true, 0);
  assert.equal(b.feed(false, 0.01), false);
  assert.equal(b.blinks, 0);
});

test("long closure is not a blink", () => {
  const b = new BlinkCounter({ maxClosedMs: 700 });
  b.feed(true, 0); b.feed(true, 1); b.feed(true, 1.5);
  assert.equal(b.feed(false, 2), false);
  assert.equal(b.blinks, 0);
});

test("blinks per minute with sliding window", () => {
  const b = new BlinkCounter({ rateWindowS: 60 });
  for (let i = 0; i < 3; i++) { b.feed(true, i * 10); b.feed(false, i * 10 + 0.1); }
  assert.equal(b.perMin(), 3);
  b.feed(false, 200);
  assert.equal(b.perMin(), 0);
});

test("face lost resets the closure", () => {
  const b = new BlinkCounter();
  b.feed(true, 0);
  b.resetClosure();
  assert.equal(b.feed(false, 0.2), false);
});

test("default thresholds and isClosed per mode", () => {
  const blend = new BlinkCounter({ mode: "blend" });
  const e = new BlinkCounter({ mode: "ear" });
  assert.equal(blend.thresh, 0.5);
  assert.equal(e.thresh, 0.21);
  assert.equal(blend.isClosed(0.7), true);
  assert.equal(e.isClosed(0.1), true);
  assert.equal(e.isClosed(0.3), false);
  assert.throws(() => new BlinkCounter({ mode: "boh" }));
});

test("level: blend uses eyeBlink, ear uses landmarks", () => {
  const b = new BlinkCounter({ mode: "blend" });
  assert.equal(b.level({ eyeBlinkLeft: 0.8, eyeBlinkRight: 0.6 }, []), 0.7);
  // open eye: EAR ~ height/width
  const open = [{ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 2, y: -1 }, { x: 3, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }];
  assert.ok(Math.abs(ear(open) - 4 / 6) < 1e-9);
});
