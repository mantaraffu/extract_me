/**
 * Smile coach: periodic spoken verdicts on how much of the time the face was
 * happy.
 *
 * The first verdict comes after `firstS` seconds and compares the happy
 * fraction of that window with `threshold`. Every `everyS` seconds after that
 * the new window is compared with the previous one: smiling more than before
 * earns the next line of the encouragements, smiling less earns the next line
 * of the reprimands. Each list keeps its own cursor, which only moves forward
 * (and wraps around at the end), so the tone escalates within a list rather
 * than repeating the same line.
 *
 * The fraction is happy seconds over seconds with a face visible, not over
 * wall-clock time: a window with less than `minVisibleS` of face is skipped
 * in silence and does not become the "previous" reading, so the coach never
 * scolds an empty room.
 *
 * Pure logic: time comes in through `feed`/`check`, speech goes out through
 * the injected `speak(text)` callback (see `browserSpeaker`).
 */
import { PositiveTimer } from "./positive_timer.js";

export const ENCOURAGEMENTS = [
  "You're doing great",
  "keep smiling you're almost there",
  "a little smile?",
  "a big bright smile, that's what we want!",
  "alright, that's good, keep smiling",
  "could you smile a little bit more?",
  "could you smile a little bit more, please?",
];

export const REPRIMANDS = [
  "smile more please",
  "you should really smile more",
  "a little effort please",
  "smile more",
  "smile more!",
  "smile! you're on camera remember?",
  "you're not smiling nearly enough",
  "can you look happier to be here please?",
  "did you forget how to smile?",
];

export class SmileCoach {
  constructor({
    firstS = 120, everyS = 60, threshold = 0.3, minVisibleS = 10,
    encouragements = ENCOURAGEMENTS, reprimands = REPRIMANDS,
    speak = null, nowS = 0,
  } = {}) {
    this.firstS = firstS;
    this.everyS = everyS;
    this.threshold = threshold;
    this.minVisibleS = minVisibleS;
    this.encouragements = encouragements;
    this.reprimands = reprimands;
    this.speak = speak;
    this.happy = new PositiveTimer();
    this.visible = new PositiveTimer();
    this.reset(nowS);
  }

  /** Back to the start: window, cursors and the previous reading are all dropped. */
  reset(nowS = 0) {
    this.happy.reset(nowS);
    this.visible.reset(nowS);
    this.dueS = nowS + this.firstS;
    this.prevFrac = null;   // null until the first verdict
    this.encIdx = -1;
    this.repIdx = -1;
    this.last = null;       // the latest verdict, kept for the caption
  }

  /** Happy fraction of the current window, null while no face was seen. */
  fraction() {
    return this.visible.seconds > 0 ? this.happy.seconds / this.visible.seconds : null;
  }

  /** Seconds until the next verdict is due. */
  nextInS(nowS) {
    return Math.max(0, this.dueS - nowS);
  }

  /**
   * One sample per frame. `happy` only counts while `visible` is true.
   * Returns the verdict when one is due at this instant, otherwise null.
   */
  feed(happy, visible, nowS) {
    this.visible.feed(visible, nowS);
    this.happy.feed(visible && happy, nowS);
    return nowS >= this.dueS ? this.check(nowS) : null;
  }

  /**
   * Close the current window now and deliver its verdict (null when the face
   * was seen too briefly). The next window starts here either way.
   */
  check(nowS) {
    const frac = this.fraction();
    const visibleS = this.visible.seconds;
    const prev = this.prevFrac;
    this.happy.reset(nowS);
    this.visible.reset(nowS);
    this.dueS = nowS + (prev === null ? this.firstS : this.everyS);

    if (frac === null || visibleS < this.minVisibleS) return null;

    // Better than last time is praise, worse is a scolding; the very first
    // verdict, and a tie, fall back to the threshold.
    let good;
    if (prev === null || frac === prev) good = frac >= this.threshold;
    else good = frac > prev;

    let text;
    if (good) {
      this.encIdx = (this.encIdx + 1) % this.encouragements.length;
      text = this.encouragements[this.encIdx];
    } else {
      this.repIdx = (this.repIdx + 1) % this.reprimands.length;
      text = this.reprimands[this.repIdx];
    }
    this.prevFrac = frac;
    this.dueS = nowS + this.everyS;
    this.last = { kind: good ? "encouragement" : "reprimand", text, frac, prevFrac: prev, visibleS, atS: nowS };
    if (this.speak) this.speak(text);
    return this.last;
  }
}

/**
 * `speak` callback on the Web Speech API. Prefers an English voice and cuts
 * short whatever is still being said, so verdicts never queue up. Returns
 * null where speech synthesis is not available.
 *
 * `onState(state, text, detail)` reports "speaking", "done", "blocked" (the
 * browser refused to speak: Chrome wants a click on the page first) or
 * "error". Speech fails silently otherwise, which is the worst way to fail.
 */
export function browserSpeaker({ lang = "en", rate = 1, onState = null } = {}) {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return null;
  let current = null;   // held on purpose: Firefox drops an utterance that gets garbage-collected mid-speech
  return text => {
    const u = new SpeechSynthesisUtterance(text);
    const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(lang));
    if (voice) u.voice = voice;
    u.lang = voice?.lang || lang;
    u.rate = rate;
    u.onstart = () => onState?.("speaking", text);
    u.onend = () => onState?.("done", text);
    u.onerror = e => {
      // cutting the previous line short is not an error worth reporting
      if (e.error === "interrupted" || e.error === "canceled") return;
      onState?.(e.error === "not-allowed" ? "blocked" : "error", text, e.error);
    };
    current = u;
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return current;
  };
}
