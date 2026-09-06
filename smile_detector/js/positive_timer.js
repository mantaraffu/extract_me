/**
 * Stopwatch of the time spent with a positive emotion.
 *
 * Runs while `feed(true, ...)` is called, stops on `feed(false, ...)` and
 * resumes from the previous total: what it holds is the cumulative time, not
 * the length of the current stretch.
 *
 * Time accrues by elapsed seconds between calls, not by frame count, so the
 * reading does not depend on the frame rate. A single step is capped at
 * `maxStepS`: with the tab in the background requestAnimationFrame stops, and
 * without the cap the first frame back would add the whole pause as if it had
 * been spent smiling.
 */
export class PositiveTimer {
  constructor({ maxStepS = 0.5 } = {}) {
    this.maxStep = maxStepS;
    this.seconds = 0;
    this.running = false;
    this.last = null;
  }

  /** Returns the cumulative seconds. nowS in seconds. */
  feed(positive, nowS) {
    // The stretch between two samples counts only when it is positive at both
    // ends: turning on never credits the time before it retroactively, and
    // turning off does not stretch past the last positive sample.
    if (positive && this.running && this.last !== null) {
      this.seconds += Math.min(nowS - this.last, this.maxStep);
    }
    this.last = nowS;
    this.running = positive;
    return this.seconds;
  }

  /** Back to zero: the stretch in progress is dropped, not credited. */
  reset(nowS) {
    this.seconds = 0;
    this.running = false;
    this.last = nowS ?? null;
  }
}

/** Seconds -> "mm:ss", or "h:mm:ss" from one hour on. */
export function formatDuration(s) {
  const total = Math.max(0, Math.floor(s));
  const ss = String(total % 60).padStart(2, "0");
  const mm = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${String(mm).padStart(2, "0")}:${ss}`;
}
