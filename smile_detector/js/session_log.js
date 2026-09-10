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
  return { minute, faceS: 0, smilingS: 0, blinks: 0, handsS: 0, commands: 0, words: 0 };
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
    this.speech = { commands: [], free: [] };
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

  /** A command as recognized by the constrained-grammar layer. */
  command(c, nowS) {
    this.speech.commands.push({
      atS: +(nowS - this.startS).toFixed(1), at: new Date(this.startedAt + (nowS - this.startS) * 1000).toISOString(),
      command: c.command,
    });
    this.minuteRow(nowS).commands++;
  }

  /**
   * A free-speech window as it closed. `conf` is the mean confidence Vosk gave
   * the window: the small model transcribes free speech roughly, and this is
   * what lets a reader tell a plausible transcript from noise. `coachOverlap`
   * marks a window the coach talked over, which no amount of text filtering
   * can clean up.
   */
  freeSegment(seg, nowS) {
    const words = seg.text ? seg.text.split(/\s+/).length : 0;
    this.speech.free.push({
      atS: +(seg.atS - this.startS).toFixed(1), at: new Date(this.startedAt + (seg.atS - this.startS) * 1000).toISOString(),
      durationS: seg.durationS, text: seg.text, conf: seg.conf, words,
      coachOverlap: seg.coachOverlap, endedBy: seg.endedBy,
    });
    this.minuteRow(nowS).words += words;
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
      app: "smile_detector", format: 2, reason,
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
      speech: {
        commands: this.speech.commands, free: this.speech.free,
        counts: {
          commands: this.speech.commands.length, freeSegments: this.speech.free.length,
          words: this.speech.free.reduce((n, f) => n + f.words, 0),
        },
        diagnostics: this.speechDiag,
      },
      timeline: this.timeline.map(t => ({ minute: t.minute, faceS: r(t.faceS), smilingS: r(t.smilingS), blinks: t.blinks, handsS: r(t.handsS), commands: t.commands, words: t.words })),
    };
  }
}

/** File name for a session started at `startedAt` (ms): smile_session_YYYY-MM-DD_HH-MM-SS.json, local time. */
export function sessionFileName(startedAt) {
  const d = new Date(startedAt);
  const p = n => String(n).padStart(2, "0");
  return `smile_session_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.json`;
}
