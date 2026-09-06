import { test } from "node:test";
import assert from "node:assert/strict";
import { PositiveTimer, formatDuration } from "../js/positive_timer.js";

test("starts at zero and stopped", () => {
  const t = new PositiveTimer();
  assert.equal(t.seconds, 0);
  assert.equal(t.running, false);
});

test("time accrues only while the emotion is positive", () => {
  const t = new PositiveTimer();
  t.feed(true, 0);          // first sample: no previous instant, nothing to add
  t.feed(true, 0.4);
  assert.ok(Math.abs(t.seconds - 0.4) < 1e-9);
  assert.equal(t.running, true);
});

test("not positive: the clock stops and does not accrue", () => {
  const t = new PositiveTimer();
  t.feed(true, 0);
  t.feed(true, 0.4);
  t.feed(false, 0.8);       // the 0.4..0.8 stretch is not positive
  t.feed(false, 1.2);
  assert.ok(Math.abs(t.seconds - 0.4) < 1e-9);
  assert.equal(t.running, false);
});

test("positive again: resumes from the previous total", () => {
  const t = new PositiveTimer();
  t.feed(true, 0); t.feed(true, 0.4);
  t.feed(false, 5);
  t.feed(true, 5.3);        // the 5..5.3 gap is not positive: it does not count
  t.feed(true, 5.6);
  assert.ok(Math.abs(t.seconds - 0.7) < 1e-9);
  assert.equal(t.running, true);
});

test("accrues by elapsed time, not by frame count", () => {
  const fast = new PositiveTimer();
  const slow = new PositiveTimer();
  for (let i = 0; i <= 20; i++) fast.feed(true, i * 0.02);   // 50 fps
  for (let i = 0; i <= 4; i++) slow.feed(true, i * 0.1);     // 10 fps
  assert.ok(Math.abs(fast.seconds - 0.4) < 1e-9);
  assert.ok(Math.abs(fast.seconds - slow.seconds) < 1e-9);
});

test("a long stall adds at most one step (background tab)", () => {
  const t = new PositiveTimer({ maxStepS: 0.5 });
  t.feed(true, 0);
  t.feed(true, 300);        // 5 minutes with the tab in the background
  assert.equal(t.seconds, 0.5);
});

test("reset zeroes the total without counting the gap that follows", () => {
  const t = new PositiveTimer();
  t.feed(true, 0); t.feed(true, 2);
  t.reset(2);
  assert.equal(t.seconds, 0);
  assert.equal(t.running, false);
  t.feed(true, 10);         // the 2..10 gap belongs to no session
  t.feed(true, 10.4);
  assert.ok(Math.abs(t.seconds - 0.4) < 1e-9);
});

test("formatDuration: mm:ss, and h:mm:ss past the hour", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(9.7), "00:09");
  assert.equal(formatDuration(75), "01:15");
  assert.equal(formatDuration(600), "10:00");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3661), "1:01:01");
});
