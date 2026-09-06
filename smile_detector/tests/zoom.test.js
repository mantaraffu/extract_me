import { test } from "node:test";
import assert from "node:assert/strict";
import { ZoomTracker } from "../js/zoom.js";

// A round frame keeps the expected crops easy to read.
const W = 1000, H = 500;
const box = (cx, cy, w, h) => ({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** alpha 1 = no smoothing, so the crop is exactly the target and assertions stay readable. */
const tracker = (o = {}) => new ZoomTracker({ alpha: 1, ...o });

test("starts on the full frame", () => {
  const z = tracker();
  assert.equal(z.feed(null, 0, W, H), null);
  assert.equal(z.state, "full");
});

test("a visible face keeps the full frame: no zoom unless needed", () => {
  const z = tracker();
  for (let t = 0; t < 3; t += 0.1) assert.equal(z.feed(box(500, 250, 100, 100), t, W, H), null);
  assert.equal(z.state, "full");
});

test("no face for the search period switches to the zoomed centre crop", () => {
  const z = tracker({ searchPeriodS: 0.5, zoom: 2 });
  assert.equal(z.feed(null, 0, W, H), null);
  assert.equal(z.feed(null, 0.4, W, H), null);      // still inside the period
  const c = z.feed(null, 0.6, W, H);
  assert.equal(z.state, "search");
  assert.ok(near(c.w, 500) && near(c.h, 250), `got ${c.w}x${c.h}`);
  assert.ok(near(c.x, 250) && near(c.y, 125), `got ${c.x},${c.y}`);
});

test("with nobody there it alternates full and search", () => {
  const z = tracker({ searchPeriodS: 0.5 });
  const seen = [];
  for (let t = 0; t <= 2.2; t += 0.1) { z.feed(null, t, W, H); seen.push(z.state); }
  assert.ok(seen.includes("full") && seen.includes("search"));
  // it must come back to full, or a face near the edge would never be found again
  assert.ok(seen.lastIndexOf("full") > seen.indexOf("search"));
});

test("a face found while searching switches to tracking it", () => {
  const z = tracker({ searchPeriodS: 0.5, margin: 1.6 });
  z.feed(null, 0, W, H); z.feed(null, 0.6, W, H);
  assert.equal(z.state, "search");
  const c = z.feed(box(500, 250, 100, 100), 0.7, W, H);
  assert.equal(z.state, "track");
  // 100 * 1.6 = 160 -> 160/1000 = 0.16 wide, 160/500 = 0.32 tall; the taller one wins
  assert.ok(near(c.w, 320) && near(c.h, 160), `got ${c.w}x${c.h}`);
  assert.ok(near(c.x, 340) && near(c.y, 170), `got ${c.x},${c.y}`);
});

test("the crop keeps the frame aspect ratio", () => {
  const z = tracker({ searchPeriodS: 0.5 });
  z.feed(null, 0, 1280, 720); z.feed(null, 0.6, 1280, 720);
  const c = z.feed(box(300, 200, 90, 120), 0.7, 1280, 720);
  assert.ok(near(c.w / c.h, 1280 / 720, 1e-9), `${c.w}/${c.h} != 16/9`);
});

test("the crop stays inside the frame", () => {
  const z = tracker({ searchPeriodS: 0.5 });
  z.feed(null, 0, W, H); z.feed(null, 0.6, W, H);
  const c = z.feed(box(10, 10, 100, 100), 0.7, W, H);   // face in the top-left corner
  assert.ok(c.x >= 0 && c.y >= 0, `got ${c.x},${c.y}`);
  assert.ok(c.x + c.w <= W && c.y + c.h <= H, `crop runs past the frame`);
});

test("the crop never zooms past minCropRatio", () => {
  const z = tracker({ searchPeriodS: 0.5, minCropRatio: 0.25 });
  z.feed(null, 0, W, H); z.feed(null, 0.6, W, H);
  const c = z.feed(box(500, 250, 4, 4), 0.7, W, H);      // a tiny, very distant face
  assert.ok(near(c.w, 250) && near(c.h, 125), `got ${c.w}x${c.h}`);
});

test("a dropped frame keeps the crop, a long loss goes back to full frame", () => {
  const z = tracker({ searchPeriodS: 0.5, lostToleranceS: 0.4 });
  z.feed(null, 0, W, H); z.feed(null, 0.6, W, H);
  const c = z.feed(box(500, 250, 100, 100), 0.7, W, H);
  const still = z.feed(null, 0.9, W, H);                 // one dropped frame
  assert.equal(z.state, "track");
  assert.deepEqual(still, c);
  z.feed(null, 1.3, W, H);                               // gone for good
  assert.equal(z.state, "full");
});

test("smoothing eases the crop toward the target instead of jumping", () => {
  const z = new ZoomTracker({ alpha: 0.5, searchPeriodS: 0.5 });
  z.feed(null, 0, W, H); z.feed(null, 0.6, W, H);
  const first = z.feed(box(500, 250, 100, 100), 0.7, W, H);
  const second = z.feed(box(300, 250, 100, 100), 0.8, W, H);
  const third = z.feed(box(300, 250, 100, 100), 0.9, W, H);
  // it moves toward the new centre without landing on it in one step
  assert.ok(second.x > third.x, "should keep easing toward the target");
  assert.ok(second.x < first.x, "should move in the direction of the target");
});

test("reset returns it to the full frame", () => {
  const z = tracker({ searchPeriodS: 0.5 });
  z.feed(null, 0, W, H); z.feed(null, 0.6, W, H);
  z.feed(box(500, 250, 100, 100), 0.7, W, H);
  z.reset();
  assert.equal(z.state, "full");
  assert.equal(z.feed(box(500, 250, 100, 100), 0.8, W, H), null);
});
