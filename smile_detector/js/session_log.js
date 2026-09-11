/**
 * Session log: everything the session measured, ready to be written as JSON.
 *
 * Fed once per frame with what that frame saw. Time is accrued by elapsed
 * seconds between samples, capped at `maxStepS` (a background tab stops
 * requestAnimationFrame and the first frame back would otherwise count the
 * whole pause), so every "seconds" figure here is comparable with the
 * on-screen stopwatches. Blinks and coach verdicts are counted as events.
 *
 * Pure: no DOM, no timers, so it is tested in Node.
 */

/** Per-minute row of the timeline. */
function newMinute(minute) {
  return { minute, faceS: 0, smilingS: 0, blinks: 0, handsS: 0 };
}

export class SessionLog {
  constructor({ startedAt = Date.now(), nowS = 0, maxStepS = 0.5, frameWidth = 0 } = {}) {
    this.startedAt = startedAt;
    this.startS = nowS;
    this.maxStep = maxStepS;
    this.frameWidth = frameWidth;   // for hand travel in frame widths; 0 = unknown
    this.last = null;               // previous sample instant
    this.frames = 0;
    this.face = { visibleS: 0, absentS: 0 };
    this.smile = { smilingS: 0, notSmilingS: 0 };
    this.emotions = { secondsByLabel: {}, valenceSum: 0, arousalSum: 0, samples: 0 };
    this.blink = { count: 0 };
    this.hands = { secondsWithHands: 0, secondsWithTwoHands: 0, rectS: 0, rectAppearances: 0, travelPx: 0 };
    this.prevPalms = null;
    this.prevRect = false;
    this.verdicts = [];
    this.speech = null;             // one transcript for the session, set at save time
    this.speechDiag = null;         // whatever the recogniser can say about itself
    this.timeline = [];
  }

  /**
   * One frame. `label` is the current emotion label or null (no face / emotion
   * off); `positive` whether it counts as smiling; `blinked` whether a blink
   * completed this frame; `hands` the number of hands seen; `palms` the
   * smoothed palms {key: {x, y}} or null; `rect` whether the window rect is up.
   */
  feed({ nowS, label = null, positive = false, valence = null, arousal = null,
         blinked = false, hands = 0, palms = null, rect = false }) {
    const dt = this.last === null ? 0 : Math.min(Math.max(0, nowS - this.last), this.maxStep);
    this.last = nowS;
    this.frames++;
    const row = this.minuteRow(nowS);

    if (label !== null) {
      this.face.visibleS += dt;
      row.faceS += dt;
      this.emotions.secondsByLabel[label] = (this.emotions.secondsByLabel[label] || 0) + dt;
      if (positive) { this.smile.smilingS += dt; row.smilingS += dt; }
      else this.smile.notSmilingS += dt;
      if (valence !== null && arousal !== null) {
        this.emotions.valenceSum += valence; this.emotions.arousalSum += arousal; this.emotions.samples++;
      }
    } else {
      this.face.absentS += dt;
    }

    if (blinked) { this.blink.count++; row.blinks++; }

    if (hands > 0) { this.hands.secondsWithHands += dt; row.handsS += dt; }
    if (hands > 1) this.hands.secondsWithTwoHands += dt;
    if (rect) { this.hands.rectS += dt; if (!this.prevRect) this.hands.rectAppearances++; }
    this.prevRect = rect;
    // travel: how far each palm moved since the last frame it was seen in
    if (palms && this.prevPalms) {
      for (const [k, p] of Object.entries(palms)) {
        const q = this.prevPalms[k];
        if (q) this.hands.travelPx += Math.hypot(p.x - q.x, p.y - q.y);
      }
    }
    this.prevPalms = palms && Object.keys(palms).length ? Object.fromEntries(Object.entries(palms).map(([k, p]) => [k, { x: p.x, y: p.y }])) : null;
  }

  /** A coach verdict as delivered. */
  verdict(v, nowS) {
    this.verdicts.push({
      atS: +(nowS - this.startS).toFixed(1), at: new Date(this.startedAt + (nowS - this.startS) * 1000).toISOString(),
      kind: v.kind, text: v.text,
      roundPct: +(v.frac * 100).toFixed(1), referencePct: v.prevFrac === null ? null : +(v.prevFrac * 100).toFixed(1),
    });
  }

  /**
   * Everything the session heard, as one string. Speech is not cut into events:
   * silence is a bad delimiter, so the recorder switch decides where a
   * transcript begins and ends, and what comes out is one transcript.
   * `conf` is the mean confidence Vosk gave it - the small model transcribes
   * free speech roughly, and this is what lets a reader tell a plausible
   * transcript from noise.
   *
   * It does not go in the session file. What people said is a different kind of
   * record from how long they smiled - read by different people, kept for
   * different reasons, shared under different rules - so it is written beside
   * it, and the session file carries only the name of the file holding it.
   */
  transcript(t) {
    this.speech = t || null;
  }

  /**
   * The transcript as its own document, or null when nothing was recorded.
   * `session` names the file this belongs to: the two are written at the same
   * instant and share a timestamp, but a pointer beats a convention.
   */
  transcriptJSON({ nowS, reason = "manual" } = {}) {
    const t = this.speech;
    if (!t || !t.text) return null;
    const elapsedS = nowS === undefined ? (this.last ?? this.startS) - this.startS : nowS - this.startS;
    return {
      app: "smile_detector", kind: "transcript", format: 1, reason,
      session: t.sessionFile || null,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(this.startedAt + elapsedS * 1000).toISOString(),
      recordedS: t.recordedS, words: t.words, conf: t.conf,
      text: t.text,
      top: t.top || [],
      timings: t.timings || [],
      diagnostics: this.speechDiag,
      // last, where a reader ends up: the three words this session was about
      top3: t.top3 || "",
    };
  }

  /**
   * What the speech layer knows about itself, written straight into the JSON.
   * A session with no transcript is otherwise indistinguishable from one where
   * speech was switched off, and the file is the only thing that survives it.
   */
  speechStats(diag) {
    this.speechDiag = diag || null;
  }

  minuteRow(nowS) {
    const m = Math.max(0, Math.floor((nowS - this.startS) / 60));
    while (this.timeline.length <= m) this.timeline.push(newMinute(this.timeline.length));
    return this.timeline[m];
  }

  /** The whole session as a plain object, `reason` says what triggered the save. */
  toJSON({ nowS, reason = "manual" } = {}) {
    const r = v => +v.toFixed(2);
    const elapsedS = nowS === undefined ? (this.last ?? this.startS) - this.startS : nowS - this.startS;
    const faceS = this.face.visibleS;
    const em = this.emotions;
    const counts = {};
    for (const v of this.verdicts) counts[v.kind] = (counts[v.kind] || 0) + 1;
    return {
      app: "smile_detector", format: 3, reason,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date(this.startedAt + elapsedS * 1000).toISOString(),
      elapsedS: r(elapsedS), frames: this.frames,
      face: { visibleS: r(faceS), absentS: r(this.face.absentS) },
      smile: {
        smilingS: r(this.smile.smilingS), notSmilingS: r(this.smile.notSmilingS),
        pctOfFaceTime: faceS > 0 ? r(100 * this.smile.smilingS / faceS) : null,
      },
      emotions: {
        secondsByLabel: Object.fromEntries(Object.entries(em.secondsByLabel).map(([k, v]) => [k, r(v)])),
        meanValence: em.samples ? +(em.valenceSum / em.samples).toFixed(3) : null,
        meanArousal: em.samples ? +(em.arousalSum / em.samples).toFixed(3) : null,
      },
      blink: { count: this.blink.count, perMinOfFaceTime: faceS > 0 ? r(60 * this.blink.count / faceS) : null },
      hands: {
        secondsWithHands: r(this.hands.secondsWithHands), secondsWithTwoHands: r(this.hands.secondsWithTwoHands),
        rectS: r(this.hands.rectS), rectAppearances: this.hands.rectAppearances,
        travelPx: Math.round(this.hands.travelPx),
        travelFrameWidths: this.frameWidth > 0 ? r(this.hands.travelPx / this.frameWidth) : null,
      },
      coach: { verdicts: this.verdicts, counts },
      speech: this.speech?.text
        ? { transcript: this.speech.file || null, words: this.speech.words, recordedS: this.speech.recordedS }
        : null,
      timeline: this.timeline.map(t => ({ minute: t.minute, faceS: r(t.faceS), smilingS: r(t.smilingS), blinks: t.blinks, handsS: r(t.handsS) })),
    };
  }
}

/** Timestamp shared by the files of one session: YYYY-MM-DD_HH-MM-SS, local time. */
function stamp(startedAt) {
  const d = new Date(startedAt);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** File name for a session started at `startedAt` (ms). */
export function sessionFileName(startedAt) {
  return `smile_session_${stamp(startedAt)}.json`;
}

/** File name for that session's transcript, sharing its timestamp. */
export function transcriptFileName(startedAt) {
  return `smile_transcript_${stamp(startedAt)}.json`;
}
