/**
 * Speech to text: one recogniser, running while the switch is on, writing one
 * transcript for the whole session.
 *
 * There are no spoken commands. A phrase that starts and stops the recording
 * has to be recognised before anything is recorded, which is the least
 * reliable moment there is, and it competes with the visitor's own words: the
 * panel switch does the same job without being misheard. With the commands
 * went the constrained grammar they needed, so a single full-vocabulary
 * recogniser is all that remains.
 *
 * Nor is the transcript cut into segments. Silence is a bad delimiter for
 * speech - a pause to think looks exactly like the end of an answer - and
 * every threshold that tried to tell them apart ended up truncating somebody
 * mid-sentence. What a session heard is one string, and the switch decides
 * where it begins and ends.
 *
 * Vosk finalises on its own endpointing, which lags: the last thing said is
 * routinely still unfinalised when recording stops. The trailing partial is
 * therefore kept and joined on, cleared whenever a final supersedes it so
 * nothing is counted twice.
 *
 * The coach speaks into the room the microphone listens to. Its lines are
 * known, so one matching a coach phrase is dropped outright; speech that
 * merely overlaps the coach cannot be cleaned up textually at all, and is
 * counted instead, which is why `echoCancellation` belongs in the constraints.
 *
 * Pure logic: audio and recogniser live in `voskListener`, time comes in
 * through `result`/`setRecording`, and the transcript comes out of `text()`.
 */

/** Vosk's out-of-vocabulary token, as it appears before normalization. */
export const UNK = "[unk]";

/** Lowercase, drop punctuation, collapse runs of whitespace. Note that this
 *  turns `[unk]` into a bare `unk`: use `stripUnk`, never a comparison against
 *  UNK, which no normalized text can ever equal. */
export function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** What `normalize` leaves of UNK. */
export const UNK_WORD = normalize(UNK);

/**
 * Drop Vosk's out-of-vocabulary markers from normalized text. They arrive
 * inline ("i came [unk] here"), so this filters tokens rather than testing the
 * whole string, and a result that is nothing but markers comes back empty -
 * which is the truth: no words were recognised.
 */
export function stripUnk(clean) {
  return clean.split(" ").filter(w => w && w !== UNK_WORD).join(" ");
}

export class Transcriber {
  constructor({ coachPhrases = [], onText = null, nowS = 0 } = {}) {
    this.coachPhrases = new Set(coachPhrases.map(normalize));
    this.onText = onText;
    this.stats = { finals: 0, partials: 0, unknown: 0, coachDropped: 0, coachOverlaps: 0 };
    this.reset(nowS);
  }

  /** Empty transcript, recorder off, counters kept: they describe the session. */
  reset(nowS = 0) {
    this.parts = [];
    this.lastPartial = "";
    this.confs = [];
    this.recording = false;
    this.recordedS = 0;
    this.startedS = null;
    this.lastS = nowS;
  }

  /** Turn the recorder on or off. Off folds the trailing partial into the text. */
  setRecording(on, nowS) {
    if (on === this.recording) return this.text();
    if (on) {
      this.recording = true;
      this.startedS = nowS;
    } else {
      this.recording = false;
      this.recordedS += Math.max(0, nowS - (this.startedS ?? nowS));
      this.startedS = null;
      this.flush();                       // what Vosk had not finalised is still speech
    }
    this.lastS = nowS;
    if (this.onText) this.onText(this.text());
    return this.text();
  }

  /** Seconds the recorder has been on, including the stretch still running. */
  seconds(nowS) {
    return this.recordedS + (this.recording ? Math.max(0, nowS - (this.startedS ?? nowS)) : 0);
  }

  /**
   * One recogniser result. `final` marks the end of an utterance; partial ones
   * are the sentence in progress and are kept in case recording stops first.
   * `speaking` is whether the coach was talking as this arrived.
   */
  result({ text, conf = null, final = false, nowS = 0, speaking = false }) {
    if (!this.recording) return null;
    const raw = normalize(text);
    const clean = stripUnk(raw);
    if (final) this.stats.finals++; else this.stats.partials++;
    if (raw !== clean) this.stats.unknown++;
    if (!clean) return null;
    if (speaking) this.stats.coachOverlaps++;
    if (this.coachPhrases.has(clean)) { this.stats.coachDropped++; return null; }

    this.lastS = nowS;
    if (!final) { this.lastPartial = clean; return null; }
    this.parts.push(clean);
    this.lastPartial = "";                // finalised: the partial is now redundant
    if (conf !== null) this.confs.push(conf);
    if (this.onText) this.onText(this.text());
    return this.text();
  }

  /** Promote the unfinalised tail into the transcript. */
  flush() {
    if (!this.lastPartial) return;
    this.parts.push(this.lastPartial);
    this.lastPartial = "";
  }

  /** Everything heard this session, as one string. */
  text() {
    return [...this.parts, this.lastPartial].filter(Boolean).join(" ").trim();
  }

  /** Words in the transcript. */
  words() {
    const t = this.text();
    return t ? t.split(" ").length : 0;
  }

  /** Mean confidence over the finalised utterances, null when there are none. */
  confidence() {
    if (!this.confs.length) return null;
    return +(this.confs.reduce((a, b) => a + b, 0) / this.confs.length).toFixed(3);
  }
}

/**
 * Microphone or video file -> Vosk -> Transcriber. The browser half: not
 * covered by the Node tests, which is why everything worth testing lives in
 * Transcriber.
 *
 * Audio follows the picture. With the webcam the microphone is the only sound
 * there is, and `echoCancellation` matters because the coach speaks into the
 * room the microphone listens to. With a file, the room is irrelevant and the
 * recogniser should hear the video, so the element feeds the graph instead.
 *
 * The context runs at 16 kHz, the rate Vosk wants, so the browser resamples
 * for us - and a file played through it sounds like a telephone. That is the
 * deliberate trade: a loaded video is a test source, not something an audience
 * listens to.
 *
 * Two traps, both about `createMediaElementSource`. It may be called only once
 * per element, so the node is cached. And it *takes over* the element's output:
 * from then on the sound only reaches the speakers through this graph, which is
 * why the node is wired to `destination` and why `stop()` leaves the context
 * open - closing or suspending it would silence the video for good.
 *
 * `modelUrl` points at a Vosk model archive served locally (nothing here talks
 * to the network): vosk-model-small-en-us is the ~40 MB one.
 */
export async function voskListener({
  modelUrl = "vendor/vosk-model-small-en-us-0.15.tar.gz",
  vosk = null,                 // the global the vosk-browser UMD bundle installs (window.Vosk)
  transcriber = null,
  element = null,              // the shared <video>, used when a file is the source
  deviceId = null,
  onState = null,              // (state, detail) for the status line
  nowS = () => performance.now() / 1000,
  speaking = () => false,      // is the coach talking right now
} = {}) {
  if (!vosk) throw new Error("voskListener needs the vosk-browser module");
  let statsState = () => {};
  const say = (s, d) => { statsState(s, d); if (onState) onState(s, d); };

  say("loading", modelUrl);
  const model = await vosk.createModel(modelUrl);

  const rec = new model.KaldiRecognizer(16000);
  rec.setWords(true);          // per-word confidence, averaged over the session

  // Vosk reports a final result as {result: {text, result: [{word, conf}]}}
  // and a partial as {result: {partial}}.
  const feed = final => m => {
    const res = m.result || {};
    const text = final ? res.text : res.partial;
    if (!text) return;
    const words = res.result || [];
    const conf = words.length ? words.reduce((a, w) => a + (w.conf ?? 0), 0) / words.length : null;
    transcriber.result({ text, conf, final, nowS: nowS(), speaking: speaking() });
    if (final) say("heard", text);
  };
  rec.on("result", feed(true));
  rec.on("partialresult", feed(false));
  rec.on("error", e => say("error", e.error || e.message || e));

  const ctx = new AudioContext({ sampleRate: 16000 });
  const stats = { chunks: 0, state: "starting", source: null, rms: 0 };
  // An AudioContext built before any gesture starts suspended, and a suspended
  // context delivers no audio at all: chunks stay at 0, exactly as they would
  // with no microphone. The first gesture resumes it, `context` records which.
  statsState = (st, d) => { stats.state = d ? `${st}: ${d}` : st; };

  // ScriptProcessor is deprecated but is what vosk-browser's own integration
  // uses, and it is the one path that behaves the same in every browser here.
  // Its output buffer is never written, so it feeds the speakers silence.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = e => {
    // Nothing is decoded while the switch is off: no CPU spent, and nothing
    // said in the room while nobody asked to be recorded is ever transcribed.
    if (!transcriber.recording) return;
    stats.chunks++;
    const d = e.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i += 16) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    if (peak > stats.rms) stats.rms = +peak.toFixed(4);
    try { rec.acceptWaveform(e.inputBuffer); }
    catch (err) { say("error", err.message || String(err)); }
  };
  proc.connect(ctx.destination);

  let micStream = null, micSrc = null, elSrc = null, active = null, kind = null;
  function route(node) {
    if (active === node) return;
    if (active) { try { active.disconnect(proc); } catch {} }
    active = node;
    if (active) active.connect(proc);
  }

  /** Point the recogniser at the room ("webcam", "image") or at the file ("video"). */
  async function setSource(sourceKind) {
    if (sourceKind === kind) return;
    kind = sourceKind;
    if (sourceKind === "video" && element) {
      if (!elSrc) {
        elSrc = ctx.createMediaElementSource(element);
        elSrc.connect(ctx.destination);   // the element has no other way out now
      }
      route(elSrc);
      say("ready", "video file");
      return;
    }
    if (!micSrc) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      micSrc = ctx.createMediaStreamSource(micStream);
    }
    route(micSrc);
    say("ready", "microphone");
  }

  return {
    setSource,
    get stats() { return { ...stats, source: kind, context: ctx.state }; },
    async resume() { if (ctx.state === "suspended") await ctx.resume(); },
    /** Stops listening. The context stays open on purpose: a file whose audio
     *  runs through it would go silent for good otherwise. */
    stop() {
      proc.onaudioprocess = null;
      route(null);
      if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; micSrc = null; }
      say("stopped", null);
    },
  };
}
