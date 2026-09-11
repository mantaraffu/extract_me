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
 * routinely still unfinalised when recording stops. `voskListener.finalize`
 * asks it to finalise before the switch goes off, which returns a real result -
 * words, timings and confidences - rather than the bare text a partial carries.
 * The trailing partial is still kept and joined on as a fallback, cleared
 * whenever a final supersedes it, in case that flush yields nothing.
 *
 * Per-word timings are kept, and moved onto the session's clock. Vosk counts
 * from the start of the audio it was given, and it is given audio only while
 * recording, so its clock runs slow by every pause: each stretch of recording
 * anchors the offset between the two. The mapping tracks fed audio against wall
 * time and can drift slightly if chunks are dropped - close enough to line words
 * up against smiles, not a timecode.
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

/**
 * Words that say nothing about what a session was about. The ranking exists to
 * surface subject matter, so it counts content words only: everything here is
 * frequent everywhere and specific to nothing.
 *
 * Grouped so it can be argued with. The first three groups are closed classes
 * and are not really a judgement call; the last two are. Where a light verb
 * stops being empty and starts being the point depends on what the installation
 * asks people - "felt" and "laughed" are subject matter here and deliberately
 * absent - so move words between the groups and the list as you learn what your
 * visitors actually say.
 */
const STOP_GROUPS = {
  // articles, pronouns, prepositions, conjunctions, demonstratives
  grammar: `
    a an the this that these those there here
    i me my myself mine we us our ours ourselves you your yours yourself yourselves
    he him his himself she her hers herself it its itself they them their theirs themselves
    who whom whose which what when where why how
    and or but nor so than then if because as while although though unless until since
    of in on at by for with without from to into onto out up down over under above below
    between through during after before again off own same other another each every
    all any both few more most much many some such no not only very just too also
  `,
  // auxiliaries and modals
  verbs_of_grammar: `
    am is are was were be been being
    do does did doing done
    have has had having
    can could shall should will would may might must need ought
    let s t don didn doesn isn aren wasn weren won wouldn couldn shouldn
  `,
  // interjections, hesitation and the sounds a recogniser turns them into
  noise: `
    ah aah ahh eh eeh er erm hm hmm mm mmm mhm uh uhm um umm huh ha haha aha
    oh ooh ow ugh oops wow yay hey hi hello bye yeah yep yes nope ok okay right
    well anyway actually basically literally really quite rather maybe probably
    please thanks thank sorry
  `,
  // light verbs and placeholder nouns: frequent, and never the subject
  filler: `
    say says said tell tells told mean means meant
    know knew think thought guess suppose wonder
    go goes going went come comes came get gets got getting
    make makes made take takes took put puts give gives gave
    look looks looked seem seems like likes
    thing things stuff kind sort bit lot way ways time times
  `,
};

/** The stop list, flattened. Edit `STOP_GROUPS` above, not this. */
export const STOP_WORDS = new Set(
  Object.values(STOP_GROUPS).join(" ").trim().split(/\s+/).filter(Boolean)
);

/** The `n` most frequent words that carry meaning, most frequent first. */
export function topWords(text, n = 5, stop = STOP_WORDS) {
  const counts = new Map();
  for (const w of (text || "").split(" ")) {
    // single letters survive normalization ("a", "i") and are never the subject
    if (!w || w.length < 2 || stop.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))   // alphabetical on ties, so it is stable
    .slice(0, n)
    .map(([word, count]) => ({ word, count }));
}

/**
 * The ranking as one line: "1: sister 2: happy 3: laughed". The array beside it
 * is what a program reads; this is what a person reads, and it goes last in the
 * file for the same reason a conclusion does.
 */
export function topLine(text, n = 3, stop = STOP_WORDS) {
  return topWords(text, n, stop).map((t, i) => `${i + 1}: ${t.word}`).join(" ");
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
    this.wordList = [];
    this.recording = false;
    this.recordedS = 0;
    this.startedS = null;
    this.anchor = null;    // {atS, stream}: session time of a point on Vosk's clock
    this.lastS = nowS;
  }

  /** Turn the recorder on or off. Off folds the trailing partial into the text. */
  setRecording(on, nowS) {
    if (on === this.recording) return this.text();
    if (on) {
      this.recording = true;
      this.startedS = nowS;
      // Vosk has been fed `recordedS` of audio so far, and is about to be fed
      // more starting now: that pairs its clock with the session's.
      this.anchor = { atS: nowS, stream: this.recordedS };
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
  /** A Vosk word time moved onto the session clock. */
  atSession(streamS) {
    if (!this.anchor || typeof streamS !== "number") return null;
    return +(this.anchor.atS + (streamS - this.anchor.stream)).toFixed(2);
  }

  result({ text, conf = null, final = false, nowS = 0, speaking = false, words = null }) {
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
    for (const w of words || []) {
      if (!w || !w.word) continue;
      this.wordList.push({
        word: normalize(w.word),
        atS: this.atSession(w.start), endS: this.atSession(w.end),
        conf: typeof w.conf === "number" ? +w.conf.toFixed(3) : null,
      });
    }
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

  /** Every word heard, with its instant on the session clock. */
  wordTimings() {
    return this.wordList;
  }

  /** The `n` most frequent meaningful words of the transcript. */
  top(n = 5) {
    return topWords(this.text(), n);
  }

  /** The same ranking as one readable line, "1: sister 2: happy 3: laughed". */
  topLine(n = 3) {
    return topLine(this.text(), n);
  }

  /**
   * Seconds actually spent talking, summed from the word timings rather than
   * from how long the recorder was on: a recorder left running in a quiet room
   * is not speech. Only finalised words carry timings, so a sentence still
   * unfinalised is not counted yet - it arrives with the next final result or
   * with the flush.
   */
  speakingS() {
    let total = 0;
    for (const w of this.wordList) {
      if (typeof w.atS === "number" && typeof w.endS === "number" && w.endS > w.atS) total += w.endS - w.atS;
    }
    return +total.toFixed(2);
  }

  /** Talking as a share of `elapsedS`, 0..1, null when no time has passed. */
  speakingShare(elapsedS) {
    return elapsedS > 0 ? Math.min(1, this.speakingS() / elapsedS) : null;
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
  let onFinal = null;          // set while a flush is waiting for its result
  const feed = final => m => {
    const res = m.result || {};
    const text = final ? res.text : res.partial;
    if (final && onFinal) { const f = onFinal; onFinal = null; f(); }
    if (!text) return;
    const words = res.result || [];
    const conf = words.length ? words.reduce((a, w) => a + (w.conf ?? 0), 0) / words.length : null;
    transcriber.result({ text, conf, final, nowS: nowS(), speaking: speaking(), words });
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
    /**
     * Ask Vosk to finalise whatever it is still holding, and wait for it.
     * Its own endpointing lags the moment a person stops talking, so without
     * this the last sentence arrives - if at all - after the recorder is
     * already off. Resolves on the flushed result, or gives up after `waitMs`
     * so a recogniser with nothing to say cannot hang the switch.
     */
    finalize(waitMs = 1500) {
      if (typeof rec.retrieveFinalResult !== "function") return Promise.resolve(false);
      return new Promise(resolve => {
        const timer = setTimeout(() => { onFinal = null; resolve(false); }, waitMs);
        onFinal = () => { clearTimeout(timer); resolve(true); };
        try { rec.retrieveFinalResult(); }
        catch { clearTimeout(timer); onFinal = null; resolve(false); }
      });
    },
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
