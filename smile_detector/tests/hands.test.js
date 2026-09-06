import { test } from "node:test";
import assert from "node:assert/strict";
import { HandsTracker } from "../js/hands.js";

const L = (x, y) => ({ Left: { x, y } });
const LR = (ax, ay, bx, by) => ({ Left: { x: ax, y: ay }, Right: { x: bx, y: by } });

test("no hands or a single hand: no rect", () => {
  const h = new HandsTracker();
  assert.equal(h.feed({}, 0), null);
  assert.equal(h.feed(L(100, 100), 0.1), null);
});

test("two palms: rect with palms as opposite corners", () => {
  const h = new HandsTracker({ smooth: 1 });
  assert.deepEqual(h.feed(LR(300, 50, 100, 200), 0), { x1: 100, y1: 50, x2: 300, y2: 200 });
});

test("rect follows the hands, smoothed", () => {
  const h = new HandsTracker({ smooth: 0.5 });
  h.feed(LR(0, 0, 100, 100), 0);
  const r = h.feed(LR(0, 0, 140, 100), 0.05);
  assert.equal(r.x2, 120);
});

test("a dropped frame keeps the rect, a hand missing for long removes it", () => {
  const h = new HandsTracker({ smooth: 1, graceS: 0.4 });
  h.feed(LR(0, 0, 100, 100), 0);
  assert.notEqual(h.feed(L(0, 0), 0.1), null);       // Right lost for one frame
  assert.equal(h.feed(L(0, 0), 0.6), null);          // Right missing for 0.6s
  assert.equal(h.feed({}, 1.0), null);
});

test("hold: rect freezes on appearance and stops following hands", () => {
  const h = new HandsTracker({ smooth: 1, hold: true });
  const r0 = h.feed(LR(0, 0, 100, 100), 0);
  const r1 = h.feed(LR(10, 10, 200, 200), 0.1);
  assert.deepEqual(r1, r0);
  h.feed({}, 1);                                      // hands gone -> disappears
  assert.equal(h.rect, null);
  assert.deepEqual(h.feed(LR(10, 10, 200, 200), 1.1), { x1: 10, y1: 10, x2: 200, y2: 200 });
});

test("manual reset and optional periodic reset", () => {
  const h = new HandsTracker({ smooth: 1, hold: true, resetS: 5, nowS: 0 });
  h.feed(LR(0, 0, 100, 100), 0);
  assert.equal(h.resetIn(2), 3);
  h.feed(LR(50, 50, 300, 300), 5.5);                  // periodic reset -> new rect from current hands
  assert.deepEqual(h.rect, { x1: 50, y1: 50, x2: 300, y2: 300 });
  h.reset(6);
  assert.equal(h.rect, null);
  assert.equal(new HandsTracker().resetIn(10), null); // reset disabled
});

test("minimum height: a bit taller than the hands, centered", () => {
  const h = new HandsTracker({ smooth: 1, minHeightFactor: 1.2 });
  const r = h.feed({ Left: { x: 100, y: 300, size: 100 }, Right: { x: 400, y: 310, size: 100 } }, 0);
  assert.equal(r.x1, 100); assert.equal(r.x2, 400);
  assert.equal(r.y2 - r.y1, 120);
  assert.equal((r.y1 + r.y2) / 2, 305);
  // tall enough already: untouched
  const t = h.feed({ Left: { x: 100, y: 100, size: 100 }, Right: { x: 400, y: 400, size: 100 } }, 2);
  assert.equal(t.y1, 100); assert.equal(t.y2, 400);
});

test("palmCenter returns the hand size from the landmark bbox", () => {
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: i * 2, y: i * 5 }));
  const p = HandsTracker.palmCenter(lm);
  assert.equal(p.size, 100);
});

test("assignKeys handles duplicate or empty labels", () => {
  assert.deepEqual(HandsTracker.assignKeys(["Left", "Left"]), ["Left", "Right"]);
  assert.deepEqual(HandsTracker.assignKeys(["", ""]), ["Left", "Right"]);
  assert.deepEqual(HandsTracker.assignKeys(["Right"]), ["Right"]);
});
