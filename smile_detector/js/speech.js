/**
 * Speech: a constrained-grammar command layer with occasional free windows.
 *
 * Two recognizers share one model. The command layer runs a closed word list
 * (a Vosk grammar), which keeps it small, fast and accurate; anything outside
 * that list comes back as `[unk]` and is dropped. One command opens a free
 * window, where a full-vocabulary recognizer takes over until the visitor
 * stops talking or the window times out.
 *
 * Closing the free window on a spoken command would not work: in free mode the
 * recognizer has the whole vocabulary, so "stop" is just a word, and a visitor
 * saying it mid-sentence would cut themselves off. Silence closes the window
 * instead - but not the first final result, because Vosk emits one at every
 * pause and a mid-thought breath would truncate the answer. The window stays
 * open until nothing new has arrived for `freeSilenceS`, with `freeMaxS` as
 * the hard ceiling for whoever never stops.
 *
 * Silence before the visitor has started is a different thing from silence
 * after they finished, and treating them alike closed the window on anyone who
 * paused to think: `freeLeadS` is the time they get to begin, and only once
 * something has been said does `freeSilenceS` take over.
 *
 * The switch to free mode happens on the command's own final result, so the
 * tail of that phrase - the "me" of "tell me" - is still in the audio the free
 * recognizer then receives, and it opened every window with a stray word. A
 * first result that is just an echo of the opening command is dropped.
 *
 * Both clocks run off `heard`, which any non-empty result sets - partial ones
 * included. Vosk only emits a final result at a pause, so a long sentence is
 * nothing but partials while it is being spoken: keying the clocks off final
 * results alone closed the window in the middle of it.
 *
 * The coach speaks through the same room the microphone listens to. In command
 * mode the grammar already protects us: the coach's lines are not in the word
 * list, so they decode to `[unk]`. In free mode they would be transcribed, so
 * a line matching a known coach phrase is dropped outright, and a segment that
 * overlapped the coach is flagged `coachOverlap` rather than silently trusted -
 * the caller can decide what a contaminated transcript is worth. Speech that
 * merely *overlaps* the coach cannot be cleaned up textually at all, which is
 * why `echoCancellation` belongs in the audio constraints.
 *
 * Pure logic: audio and recognizer live in `voskListener`, time comes in
 * through `result`/`tick`, results go out through the injected callbacks.
 */

/** Command words. A closed list: edit here, it becomes the Vosk grammar. */
export const COMMANDS = [
  "save session",
  "reset",
  "tell me",
];

/** The command that opens a free window. Must be one of COMMANDS. */
export const OPEN_FREE = "tell me";

/** Vosk's out-of-vocabulary token. In the grammar it keeps unknown audio from
 *  being forced onto the nearest command; without it every stray noise becomes
 *  a false positive. */
export const UNK = "[unk]";

/** Lowercase, drop punctuation, collapse runs of whitespace. Note that this
 *  turns Vosk's `[unk]` into a bare `unk`: use `stripUnk` on the result, never
 *  a comparison against UNK, which no normalized text can ever equal. */
export function normalize(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** The word list handed to Vosk: the commands plus the unknown token. */
export function grammar(commands = COMMANDS) {
  return [...commands.map(normalize), UNK];
}

/**
 * Drop Vosk's out-of-vocabulary markers from normalized text. They arrive
 * inline ("i came [unk] here"), so this is a filter over tokens rather than a
 * test on the whole string, and a result that is nothing but markers comes back
 * empty - which is the truth: no words were recognised.
 */
export function stripUnk(clean) {
  return clean.split(" ").filter(w => w && w !== UNK_WORD).join(" ");
}

/** What `normalize` leaves of UNK. */
export const UNK_WORD = normalize(UNK);

export class SpeechRouter {
  constructor({
    commands = COMMANDS, openFree = OPEN_FREE,
    freeMaxS = 20, freeSilenceS = 1.5, freeLeadS = 4,
    coachPhrases = [],
    onCommand = null, onFree = null, onOpen = null, nowS = 0,
  } = {}) {
    this.commands = commands.map(normalize);
    this.openFree = normalize(openFree);
    this.freeMaxS = freeMaxS;
    this.freeSilenceS = freeSilenceS;
    this.freeLeadS = freeLeadS;   // grace to start talking, before freeSilenceS applies
    this.coachPhrases = new Set(coachPhrases.map(normalize));
    this.onCommand = onCommand;
    this.onFree = onFree;
    this.onOpen = onOpen;
    this.reset(nowS);
  }

  /** Back to command mode, dropping anything the open window had collected. */
  reset(nowS = 0) {
    this.mode = "command";
    this.parts = [];       // final results collected in the current free window
    this.confs = [];
    this.heard = false;    // anything at all said in this window, partials included
    if (!this.stats) this.stats = {   // survives reset(): it is about the whole session
      finals: 0, partials: 0, unknown: 0, opened: 0, matched: 0, unmatched: [],
    };
    this.openedS = nowS;
    this.lastSpeechS = nowS;
    this.overlap = false;  // the coach spoke at some point during this window
    this.last = null;      // the latest command or segment, for the caption
  }

  /** Seconds left before the free window closes on its own, null in command mode. */
  freeLeftS(nowS) {
    if (this.mode !== "free") return null;
    const ceiling = this.freeMaxS - (nowS - this.openedS);
    const near = this.heard
      ? this.freeSilenceS - (nowS - this.lastSpeechS)
      : this.freeLeadS - (nowS - this.openedS);
    return Math.max(0, Math.min(ceiling, near));
  }

  /**
   * One recognizer result. `final` marks the end of an utterance (Vosk emits
   * one at every pause); partial results only keep the window alive.
   * `speaking` is whether the coach was talking as this arrived.
   * Returns the command or the closed segment when one comes of it, else null.
   */
  result({ text, conf = null, final = false, nowS, speaking = false }) {
    const raw = normalize(text);
    const clean = stripUnk(raw);
    if (speaking) this.overlap = true;

    if (final) this.stats.finals++; else this.stats.partials++;
    if (raw !== clean) this.stats.unknown++;

    if (this.mode === "command") {
      if (!final || !clean) return null;
      if (!this.commands.includes(clean)) {                // outside the grammar
        // what it heard instead is the one thing worth keeping: a grammar that
        // never matches looks exactly like a microphone that never worked.
        if (this.stats.unmatched.length < 12) this.stats.unmatched.push(clean);
        return null;
      }
      this.stats.matched++;
      if (clean === this.openFree) { this.openWindow(nowS); return null; }
      this.last = { kind: "command", command: clean, atS: nowS };
      if (this.onCommand) this.onCommand(this.last);
      return this.last;
    }

    // free mode
    if (!clean) return null;
    if (!this.heard && this.echoesOpen(clean)) return null;   // tail of "tell me"
    this.heard = true;                                        // partials count: they are the sentence
    this.lastSpeechS = nowS;
    if (!final) return null;
    if (this.coachPhrases.has(clean)) return null;         // the coach, verbatim
    this.parts.push(clean);
    if (conf !== null) this.confs.push(conf);
    return null;
  }

  /** Drives the timeouts; call it once per frame with the current instant. */
  tick(nowS) {
    if (this.mode !== "free") return null;
    const started = this.heard;
    const quiet = started
      ? nowS - this.lastSpeechS >= this.freeSilenceS
      : nowS - this.openedS >= this.freeLeadS;      // nobody ever started
    const expired = nowS - this.openedS >= this.freeMaxS;
    return quiet || expired ? this.closeWindow(nowS, expired && !quiet ? "timeout" : "silence") : null;
  }

  /** Is this the tail of the command that opened the window, rather than speech? */
  echoesOpen(clean) {
    const open = this.openFree;
    if (!open || !clean) return false;
    return open === clean || open.endsWith(` ${clean}`) || open.startsWith(`${clean} `);
  }

  openWindow(nowS) {
    this.mode = "free";
    this.parts = [];
    this.confs = [];
    this.heard = false;
    this.openedS = nowS;
    this.lastSpeechS = nowS;
    this.overlap = false;
    this.stats.opened++;
    if (this.onOpen) this.onOpen({ atS: nowS });
  }

  /** Close the free window and hand over whatever it collected. */
  closeWindow(nowS, endedBy = "silence") {
    const text = this.parts.join(" ").trim();
    const conf = this.confs.length ? this.confs.reduce((a, b) => a + b, 0) / this.confs.length : null;
    const seg = {
      kind: "free", text, conf: conf === null ? null : +conf.toFixed(3),
      atS: this.openedS, durationS: +(nowS - this.openedS).toFixed(2),
      coachOverlap: this.overlap, endedBy,
    };
    this.mode = "command";
    this.parts = [];
    this.confs = [];
    this.heard = false;
    this.overlap = false;
    if (!text) return null;               // an empty window is not a segment
    this.last = seg;
    if (this.onFree) this.onFree(seg);
    return seg;
  }
}

/**
 * Audio -> Vosk -> SpeechRouter. The browser half: not covered by the Node
 * tests, which is why everything worth testing lives in SpeechRouter.
 *
 * Two recognizers share one loaded model: `cmd` runs the grammar, `free` the
 * full vocabulary, and audio goes to whichever the router is currently in.
 * Building both up front costs a little memory and removes the pause that
 * rebuilding a decoding graph would put at the start of every free window.
 *
 * Audio follows the picture. With the webcam the microphone is the only sound
 * there is, and `echoCancellation` matters because the coach speaks into the
 * room the microphone listens to. With a file, the room is irrelevant and the
 * recognizer should hear the video, so the element feeds the graph instead.
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
  commands = COMMANDS,
  router = null,
  element = null,              // the shared <video>, used when a file is the source
  deviceId = null,
  onState = null,              // (state, detail) for the status line
  nowS = () => performance.now() / 1000,
  speaking = () => false,      // is the coach talking right now
} = {}) {
  if (!vosk) throw new Error("voskListener needs the vosk-browser module");
  const say = (s, d) => { statsState(s, d); if (onState) onState(s, d); };
  let statsState = () => {};

  say("loading", modelUrl);
  const model = await vosk.createModel(modelUrl);

  const cmd = new model.KaldiRecognizer(16000, JSON.stringify(grammar(commands)));
  const free = new model.KaldiRecognizer(16000);
  free.setWords(true);         // per-word confidence, averaged over the window

  // Vosk reports a final result as {result: {text, result: [{word, conf}]}}
  // and a partial as {result: {partial}}.
  const feed = final => m => {
    const res = m.result || {};
    const text = final ? res.text : res.partial;
    if (!text) return;
    const words = res.result || [];
    const conf = words.length ? words.reduce((a, w) => a + (w.conf ?? 0), 0) / words.length : null;
    router.result({ text, conf, final, nowS: nowS(), speaking: speaking() });
    if (final) say("heard", text);
  };
  for (const [rec, tag] of [[cmd, "cmd"], [free, "free"]]) {
    rec.on("result", feed(true));
    rec.on("partialresult", feed(false));
    rec.on("error", e => say("error", `${tag}: ${e.error || e.message || e}`));
  }

  const ctx = new AudioContext({ sampleRate: 16000 });
  // ScriptProcessor is deprecated but is what vosk-browser's own integration
  // uses, and it is the one path that behaves the same in every browser here.
  // Its output buffer is never written, so it feeds the speakers silence.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const stats = { chunks: 0, state: "starting", source: null, rms: 0 };
  // An AudioContext built before any gesture starts suspended, and a suspended
  // context delivers no audio at all: chunks stay at 0, exactly as they would
  // with no microphone. The first click resumes it, `context` records which.
  statsState = (st, d) => { stats.state = d ? `${st}: ${d}` : st; };
  proc.onaudioprocess = e => {
    stats.chunks++;
    // peak level over the session: a silent input and a missing input look the
    // same in the transcript, and only one of them is a wiring problem.
    const d = e.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i += 16) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    if (peak > stats.rms) stats.rms = +peak.toFixed(4);
    try { (router.mode === "free" ? free : cmd).acceptWaveform(e.inputBuffer); }
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

  /** Point the recognizer at the room ("webcam", "image") or at the file ("video"). */
  async function setSource(sourceKind) {
    if (sourceKind === kind) return;
    kind = sourceKind;
    if (sourceKind === "video" && element) {
      if (!elSrc) {
        elSrc = ctx.createMediaElementSource(element);
        elSrc.connect(ctx.destination);   // the element has no other way out now
      }
      route(elSrc);
      say("listening", "video file");
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
    say("listening", "microphone");
  }

  return {
    setSource,
    get stats() { return { ...stats, source: kind, context: ctx.state }; },
    get mode() { return router.mode; },
    get source() { return kind; },
    async resume() { if (ctx.state === "suspended") await ctx.resume(); },
    /** Stops recognising. The context stays open on purpose: a file whose audio
     *  runs through it would go silent for good otherwise. */
    stop() {
      proc.onaudioprocess = null;
      route(null);
      if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; micSrc = null; }
      say("stopped", null);
    },
  };
}
