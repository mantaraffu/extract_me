/**
 * Two palms -> one rectangle with the palms as opposite corners.
 *
 * - Appears when both hands are visible, disappears when one of them has
 *   been missing for more than `graceS` seconds (a single dropped frame
 *   does not hide it).
 * - Palms are smoothed with an EMA (`smooth` = weight of the new sample),
 *   so the rectangle does not jitter.
 * - `hold`: the rectangle freezes when it first appears and stops following
 *   the hands until they leave or a reset happens.
 * - `resetS` > 0 enables a periodic reset; `reset()` is the manual one.
 * - Hands are keyed by handedness ("Left"/"Right"), not by detection order.
 * - Minimum rect height = `minHeightFactor` x the hand size seen in the video
 *   (mean of the two hands), expanded around the rect center.
 *
 * `feed(palms, nowS)` is pure: palms = {Left: {x,y,size}, Right: {x,y,size}}
 * in pixels, where `size` is the hand extent (optional). Returns the rect
 * {x1,y1,x2,y2} or null.
 */
export const PALM_IDX = [0, 5, 9, 13, 17];
export const HAND_KEYS = ["Left", "Right"];

export class HandsTracker {
  constructor({ smooth = 0.25, graceS = 0.4, staleS = 1.0, hold = false, resetS = 0,
                minHeightFactor = 1.2, nowS = 0 } = {}) {
    this.smooth = smooth;     // EMA weight of the new sample (1 = no smoothing)
    this.minHeightFactor = minHeightFactor;  // min rect height as a multiple of the hand size
    this.graceS = graceS;     // tolerance for hands lost for a few frames
    this.staleS = staleS;     // after this long unseen, the EMA restarts from the new sample
    this.hold = hold;
    this.resetS = resetS;     // 0 = no periodic reset
    this.windowStart = nowS;
    this.palms = {};          // smoothed palms seen in the current frame
    this._smoothed = {};
    this._lastSeen = {};
    this._size = {};
    this.rect = null;
  }

  resetIn(nowS) { return this.resetS > 0 ? Math.max(0, this.resetS - (nowS - this.windowStart)) : null; }

  reset(nowS = 0) {
    this.rect = null;
    this._smoothed = {};
    this._lastSeen = {};
    this.windowStart = nowS;
  }

  /** Handedness may repeat the same label: the second hand goes to the other key. */
  static assignKeys(labels) {
    const out = [], used = new Set();
    for (const lab of labels) {
      const key = HAND_KEYS.includes(lab) && !used.has(lab) ? lab : HAND_KEYS.find(k => !used.has(k));
      if (!key) break;
      used.add(key);
      out.push(key);
    }
    return out;
  }

  /** Palm center (mean of the base landmarks) and hand size (largest extent
   * of the 21-landmark bounding box) in pixels. */
  static palmCenter(landmarksPx) {
    let x = 0, y = 0;
    for (const i of PALM_IDX) { x += landmarksPx[i].x; y += landmarksPx[i].y; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of landmarksPx) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
    return { x: x / PALM_IDX.length, y: y / PALM_IDX.length, size: Math.max(x2 - x1, y2 - y1) };
  }

  feed(palms, nowS) {
    if (this.resetS > 0 && nowS - this.windowStart >= this.resetS) this.reset(nowS);

    this.palms = {};
    for (const [key, p] of Object.entries(palms)) {
      let { x, y } = p;
      let size = p.size ?? this._size[key] ?? 0;
      const prev = this._smoothed[key];
      if (prev && nowS - (this._lastSeen[key] ?? -1e9) <= this.staleS) {
        x = this.smooth * x + (1 - this.smooth) * prev.x;
        y = this.smooth * y + (1 - this.smooth) * prev.y;
        size = this.smooth * size + (1 - this.smooth) * (this._size[key] ?? size);
      }
      this._smoothed[key] = { x, y };
      this._size[key] = size;
      this._lastSeen[key] = nowS;
      this.palms[key] = { x, y };
    }

    // visible = seen within graceS (one dropped frame does not hide the rect)
    const visible = HAND_KEYS.filter(k => nowS - (this._lastSeen[k] ?? -1e9) <= this.graceS);
    if (visible.length < 2) { this.rect = null; return null; }
    if (this.hold && this.rect) return this.rect;

    const a = this._smoothed[visible[0]], b = this._smoothed[visible[1]];
    let y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    // minimum height: a bit more than the hands themselves, centered on the rect
    const minH = this.minHeightFactor * ((this._size[visible[0]] + this._size[visible[1]]) / 2);
    if (y2 - y1 < minH) { const cy = (y1 + y2) / 2; y1 = cy - minH / 2; y2 = cy + minH / 2; }
    this.rect = { x1: Math.min(a.x, b.x), y1, x2: Math.max(a.x, b.x), y2 };
    return this.rect;
  }
}
