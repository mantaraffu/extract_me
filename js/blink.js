/**
 * Time-based blink counting (not frame-based).
 *
 * - mode "blend": level = mean of eyeBlinkLeft / eyeBlinkRight (blendshapes 0..1),
 *   eye closed when level > thresh (default 0.5).
 * - mode "ear": level = Eye Aspect Ratio, closed when level < thresh (0.21).
 *
 * A blink is a closure lasting between minClosedMs and maxClosedMs.
 * `feed(closed, nowS)` is the pure logic; `level()` computes the level.
 */
export const LEFT_EYE = [33, 160, 158, 133, 153, 144];
export const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
export const DEFAULT_THRESH = { blend: 0.5, ear: 0.21 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** pts: 6 points {x,y} in p1..p6 order. */
export function ear(pts) {
  const a = dist(pts[1], pts[5]);
  const b = dist(pts[2], pts[4]);
  const c = dist(pts[0], pts[3]);
  return (a + b) / (2 * Math.max(c, 1e-6));
}

export class BlinkCounter {
  constructor({ mode = "blend", thresh = null, minClosedMs = 40, maxClosedMs = 700,
                rateWindowS = 60 } = {}) {
    if (!(mode in DEFAULT_THRESH)) throw new Error(`mode must be blend or ear, not ${mode}`);
    this.mode = mode;
    this.thresh = thresh ?? DEFAULT_THRESH[mode];
    this.minClosed = minClosedMs / 1000;
    this.maxClosed = maxClosedMs / 1000;
    this.rateWindow = rateWindowS;
    this.closedSince = null;
    this.blinks = 0;
    this.times = [];
  }

  /** Returns true when a blink has just completed. nowS in seconds. */
  feed(closed, nowS) {
    let blinked = false;
    if (closed) {
      if (this.closedSince === null) this.closedSince = nowS;
    } else if (this.closedSince !== null) {
      const dur = nowS - this.closedSince;
      this.closedSince = null;
      if (dur >= this.minClosed && dur <= this.maxClosed) {
        blinked = true;
        this.blinks += 1;
        this.times.push(nowS);
      }
    }
    const cutoff = nowS - this.rateWindow;
    while (this.times.length && this.times[0] < cutoff) this.times.shift();
    return blinked;
  }

  /** Face lost: forget the closure in progress. */
  resetClosure() { this.closedSince = null; }

  perMin() { return this.times.length * (60 / this.rateWindow); }

  /** Is the eye closed at this level, according to the mode? */
  isClosed(level) {
    return this.mode === "blend" ? level > this.thresh : level < this.thresh;
  }

  /** Level from the MediaPipe result: blendshapes {name: score} and landmarks in px. */
  level(blendshapes, landmarksPx) {
    if (this.mode === "blend") {
      return ((blendshapes.eyeBlinkLeft ?? 0) + (blendshapes.eyeBlinkRight ?? 0)) / 2;
    }
    const l = ear(LEFT_EYE.map(i => landmarksPx[i]));
    const r = ear(RIGHT_EYE.map(i => landmarksPx[i]));
    return (l + r) / 2;
  }
}
