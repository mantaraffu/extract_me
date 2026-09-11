/**
 * Smile coach: periodic spoken verdicts on how much of the time the face was
 * happy.
 *
 * The first verdict comes after `firstS` seconds, then one every `everyS`
 * seconds. Each verdict compares the happy fraction of the window just closed
 * with a reference: smiling more than the reference earns the next line of
 * the encouragements, smiling less earns the next line of the reprimands, and
 * a share unchanged within `tieMargin` earns the steady line ("keep going!"),
 * which moves no cursor - but only above `steadyMin`, because a share stuck at
 * zero is not a tie worth praising, it is nobody smiling at all: it falls
 * through to the reprimands, whose cursor then escalates round by round.
 * Without that floor the coach said "keep going!" forever at 0%. The very first verdict has nothing to compare with
 * and goes by `threshold` instead. Each list keeps its own cursor, which only
 * moves forward (and wraps around at the end), so the tone escalates within a
 * list rather than repeating the same line.
 *
 * The reference is whatever the caller passes to `feed` (the app passes the
 * session-wide share, the big number on screen, so "was 35%" is that number),
 * and falls back to the previous window's fraction when none is given.
 *
 * The fraction is happy seconds over seconds with a face visible, not over
 * wall-clock time. A verdict comes at every deadline, no exceptions: a window
 * in which no face was seen counts as 0% happy (no smile was shown), but it
 * does not replace the previous reading, so the next comparison still starts
 * from the last fraction actually measured.
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

/** Said when the share is unchanged from the reference. */
export const STEADY = "keep going!";

export class SmileCoach {
  constructor({
    firstS = 120, everyS = 60, threshold = 0.3, tieMargin = 0.02, steadyMin = 0,
    encouragements = ENCOURAGEMENTS, reprimands = REPRIMANDS, steady = STEADY,
    speak = null, nowS = 0,
  } = {}) {
    this.firstS = firstS;
    this.everyS = everyS;
    this.threshold = threshold;
    this.tieMargin = tieMargin;
    this.steadyMin = steadyMin;   // a tie at or below this is a reprimand, not "keep going"
    this.steady = steady;
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
    this.prevFrac = null;   // last measured window, the fallback reference
    this.reference = null;  // caller-supplied reference, wins over prevFrac when not null
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
   * `reference` (0..1, or null) is the share the next verdict compares against.
   * Returns the verdict when one is due at this instant, otherwise null.
   */
  feed(happy, visible, nowS, reference = null) {
    this.visible.feed(visible, nowS);
    this.happy.feed(visible && happy, nowS);
    this.reference = reference;
    return nowS >= this.dueS ? this.check(nowS) : null;
  }

  /** Close the current window now and deliver its verdict; the next window starts here. */
  check(nowS) {
    const measured = this.fraction();      // null when no face was seen at all
    const frac = measured ?? 0;
    const visibleS = this.visible.seconds;
    const prev = this.reference ?? this.prevFrac;
    this.happy.reset(nowS);
    this.visible.reset(nowS);

    // Better than the reference is praise, worse is a scolding, unchanged is
    // "keep going". The very first verdict has no history: the threshold decides.
    let kind;
    if (this.last === null || prev === null) kind = frac >= this.threshold ? "encouragement" : "reprimand";
    else if (Math.abs(frac - prev) <= this.tieMargin && frac > this.steadyMin) kind = "steady";
    else kind = frac > prev ? "encouragement" : "reprimand";

    let text;
    if (kind === "encouragement") {
      this.encIdx = (this.encIdx + 1) % this.encouragements.length;
      text = this.encouragements[this.encIdx];
    } else if (kind === "reprimand") {
      this.repIdx = (this.repIdx + 1) % this.reprimands.length;
      text = this.reprimands[this.repIdx];
    } else {
      text = this.steady;
    }
    if (measured !== null) this.prevFrac = frac;   // an unseen face leaves the reference alone
    this.dueS = nowS + this.everyS;
    this.last = { kind, text, frac, prevFrac: prev, visibleS, atS: nowS };
    if (this.speak) this.speak(text);
    return this.last;
  }
}

/**
 * `speak` callback on the Web Speech API. Cuts short whatever is still being
 * said, so verdicts never queue up. Returns null where speech synthesis is not
 * available.
 *
 * The voice is pinned to English, deliberately and defensively. Leaving
 * `u.voice` unset does not mean "some English voice", it means the system
 * default: on an Italian machine, an Italian voice reading English lines. So
 * the search widens rather than giving up - the exact tag, then any variant of
 * it, then any voice of the same language at all - and only if the machine has
 * no English voice installed does it fall through, saying so through `onState`
 * instead of quietly sounding Italian. It never picks a voice of another
 * language: a wrong accent is a nuisance, a wrong language is gibberish.
 *
 * Tags are matched leniently. They are written "en-US" but turn up as "en_US"
 * and in any case, and a tag that fails to match is indistinguishable from
 * having no voice at all.
 *
 * Voices load asynchronously and `getVoices()` usually returns an empty array
 * on the first call, which is exactly when the coach says its first line. The
 * choice is therefore made lazily, retried until it succeeds, and redone when
 * the browser announces the list has arrived.
 *
 * `onState(state, text, detail)` reports "speaking", "done", "blocked" (the
 * browser refused to speak: Chrome wants a click on the page first) or
 * "error". Speech fails silently otherwise, which is the worst way to fail.
 */
export function browserSpeaker({ lang = "en_US", rate = 0.7, onState = null } = {}) {
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
