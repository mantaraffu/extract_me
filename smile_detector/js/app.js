/**
 * emotionscript: face + emotion + blink + hands, all in the browser.
 * Source (webcam / file) -> Vision (MediaPipe) -> pure logic -> Canvas.
 * Every frame publishes `window.emotionState` and dispatches the
 * "emotionscript" event with the state as JSON, so another page or sketch
 * can draw on top of it.
 */
import { Vision } from "./vision.js";
import { BlinkCounter, LEFT_EYE, RIGHT_EYE } from "./blink.js";
import { HandsTracker } from "./hands.js";
import { EmotionSmoother } from "./smoother.js";
import { expressionsFromBlendshapes, LABELS } from "./expressions.js";
import { PositiveTimer, formatDuration } from "./positive_timer.js";
import { ZoomTracker } from "./zoom.js";
import { SmileCoach, browserSpeaker } from "./coach.js";
import { SessionLog, sessionFileName, transcriptFileName } from "./session_log.js";

/** The emotion labels that make the positive-time stopwatch run. */
const POSITIVE_LABELS = new Set(["happy"]);

/** Seconds the spoken line stays on screen as a caption. */
const COACH_CAPTION_S = 5;

/** Seconds between automatic saves of the session JSON. */
const AUTOSAVE_S = 30;

const $ = id => document.getElementById(id);
const ui = {
  canvas: $("view"), status: $("status"), panel: $("panel"),
  source: $("source"), file: $("file"), mirror: $("mirror"), overlay: $("overlay"),
  blink: $("blink"), blinkMode: $("blinkMode"), blinkThresh: $("blinkThresh"),
  hands: $("hands"), handsHold: $("handsHold"), handsResetOn: $("handsResetOn"), handsReset: $("handsReset"),
  emotion: $("emotion"), vitEvery: $("vitEvery"),
  posTimer: $("posTimer"), zoom: $("zoom"),
  coach: $("coach"), coachFirst: $("coachFirst"), coachEvery: $("coachEvery"), coachThresh: $("coachThresh"), coachTest: $("coachTest"),
  speech: $("speech"), speechRec: $("speechRec"), speechText: $("speechText"),
  speechModel: $("speechModel"), speechLib: $("speechLib"), speechInfo: $("speechInfo"),
  saveLog: $("saveLog"), saveNow: $("saveNow"), saveInfo: $("saveInfo"),
  stats: $("stats"), bars: $("bars"),
};
const ctx = ui.canvas.getContext("2d");

const video = document.createElement("video");
// Muted by default because the webcam path must be: its audio would come
// straight back out of the speakers the coach is talking through. A loaded
// file has no such problem and is unmuted in openFile.
video.muted = true; video.playsInline = true; video.loop = true;

const state = {
  source: null,        // {kind: "webcam"|"video"|"image", el, width, height}
  vision: new Vision(),
  blinker: null,
  hands: null,
  smoother: new EmotionSmoother(),
  positive: new PositiveTimer(),
  faceTime: new PositiveTimer(),   // time with a face and an emotion label, the base of the % happy
  zoom: new ZoomTracker(),
  zoomRoi: null,     // region fed to the face detector next frame, null = full frame
  coach: null,       // SmileCoach while the voice coach is on
  speech: null,      // Transcriber on the voice entry point, null on index.html
  speechListener: null,  // the Vosk listener, so the source switch can retarget its audio
  speechFailure: null,   // why it would not start, kept for the session JSON
  speechPhase: "idle",   // how far the start got: "never checked" and "hung at step N" look alike otherwise
  speak: null,       // speak(text) on the Web Speech API, null where unavailable
  blockedText: null, // a line the browser refused to speak, retried on the next click
  log: null,         // SessionLog, created with the first frame so it knows the frame width
  logFile: null,     // file name of this session on the Desktop
  transcriptFile: null,  // and of the file holding what it heard, written beside it
  vit: null,
  vitPreds: null,
  frame: 0,
  fps: 0,
  lastT: null,
  miss: 0,
  lastVideoTime: -1,
  running: false,
  dirty: false,        // image mode: re-render on the next tick
  startTime: performance.now(),  // wall-clock start, for the elapsed-time clock
  elapsed: 0,                    // seconds since startTime (updated each frame)
  pctPositive: 0,                // 0-100, positive.seconds / faceTime.seconds
};

const setStatus = msg => { ui.status.textContent = msg; };

// ---------- sources ----------

async function listCams() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    const cur = ui.source.value;
    ui.source.innerHTML = "";
    devs.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId; o.textContent = d.label || `camera ${i + 1}`;
      ui.source.appendChild(o);
    });
    const f = document.createElement("option");
    f.value = "__file"; f.textContent = "video / image file...";
    ui.source.appendChild(f);
    if ([...ui.source.options].some(o => o.value === cur)) ui.source.value = cur;
  } catch (e) { console.warn(e); }
}

function stopSource() {
  state.zoom.reset();
  state.zoomRoi = null;
  if (state.source?.kind === "webcam") video.srcObject?.getTracks().forEach(t => t.stop());
  if (state.source?.kind === "video") { video.pause(); URL.revokeObjectURL(video.src); }
  state.source = null;
}

async function openWebcam(deviceId) {
  stopSource();
  setStatus("opening the webcam...");
  const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 },
                                 ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  state.source = { kind: "webcam", el: video, width: video.videoWidth, height: video.videoHeight };
  state.speechListener?.setSource("webcam").catch(() => {});
  ui.mirror.checked = true;
  await state.vision.setMode("VIDEO");
  await listCams();
  setStatus(`webcam ${video.videoWidth}x${video.videoHeight}`);
}

async function openFile(file) {
  stopSource();
  if (file.type.startsWith("image/")) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    state.source = { kind: "image", el: img, width: img.naturalWidth, height: img.naturalHeight };
    state.speechListener?.setSource("image").catch(() => {});   // no audio in a still: back to the room
    ui.mirror.checked = false;
    await state.vision.setMode("IMAGE");
    setStatus(`image ${img.naturalWidth}x${img.naturalHeight}`);
    return;
  }
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.muted = false;
  // Autoplay may refuse an unmuted element even after a file picker. Losing the
  // picture over the sound would be the wrong trade: fall back to muted.
  try {
    await video.play();
  } catch {
    video.muted = true;
    await video.play();
    setStatus("the browser refused to play the sound: click the page and reload the file");
  }
  state.source = { kind: "video", el: video, width: video.videoWidth, height: video.videoHeight };
  state.speechListener?.setSource("video").catch(() => {});
  ui.mirror.checked = false;
  await state.vision.setMode("VIDEO");
  setStatus(`video ${video.videoWidth}x${video.videoHeight}`);
}

// ---------- modules on/off ----------

async function syncModules() {
  if (ui.blink.checked || ui.emotion.value !== "off") await state.vision.loadFace(setStatus);
  if (ui.hands.checked) await state.vision.loadHand(setStatus);
  if (ui.blink.checked) {
    const mode = ui.blinkMode.value;
    const thresh = ui.blinkThresh.value === "" ? null : parseFloat(ui.blinkThresh.value);
    if (!state.blinker || state.blinker.mode !== mode || (thresh !== null && state.blinker.thresh !== thresh)) {
      state.blinker = new BlinkCounter({ mode, thresh });
    }
    ui.blinkThresh.placeholder = state.blinker.thresh;
  } else state.blinker = null;
  if (ui.hands.checked) {
    const resetS = ui.handsResetOn.checked ? (parseFloat(ui.handsReset.value) || 15) : 0;
    if (!state.hands) state.hands = new HandsTracker({ nowS: performance.now() / 1000 });
    if (state.hands.resetS !== resetS) { state.hands.resetS = resetS; state.hands.windowStart = performance.now() / 1000; }
    state.hands.hold = ui.handsHold.checked;
  } else state.hands = null;
  if (ui.emotion.value === "vit") {
    if (!state.vit) {
      const { EmotionViT } = await import("./emotion_vit.js");
      state.vit = new EmotionViT();
      try { await state.vit.load(setStatus); }
      catch (e) { setStatus(e.message); ui.emotion.value = "blend"; state.vit = null; }
    }
  }
  state.smoother.reset();
  state.vitPreds = null;
  if (/^loading/.test(ui.status.textContent)) setStatus("ready");
}

// ---------- loop ----------

function tick() {
  if (!state.running) return;
  requestAnimationFrame(tick);
  const src = state.source;
  if (!src) return;
  if (src.kind !== "image") {
    // process each video frame once
    if (video.readyState < 2 || video.currentTime === state.lastVideoTime) return;
    state.lastVideoTime = video.currentTime;
  } else if (state.frame > 0 && !state.dirty) return;
  state.dirty = false;
  processFrame(src);
}

function processFrame(src) {
  const { width: W, height: H, el } = src;
  if (ui.canvas.width !== W || ui.canvas.height !== H) { ui.canvas.width = W; ui.canvas.height = H; }
  const nowS = performance.now() / 1000;
  const det = state.vision.detect(el, W, H, {
    wantFace: ui.blink.checked || ui.emotion.value !== "off",
    wantHands: ui.hands.checked,
    faceRoi: state.zoomRoi,
  });

  // --- blink + expressions on the closest face ---
  const face = det.faces[0] || null;
  let blink = null, expr = null, preds = null;
  if (face) {
    state.miss = 0;
    if (state.blinker) {
      const level = state.blinker.level(face.blendshapes, face.landmarks);
      const closed = state.blinker.isClosed(level);
      const blinked = state.blinker.feed(closed, nowS);
      blink = { level, closed, blinked, blinks: state.blinker.blinks, perMin: state.blinker.perMin(), mode: state.blinker.mode };
      if (blinked) console.log(`[blink] #${blink.blinks} level=${level.toFixed(2)} (${blink.perMin.toFixed(0)}/min)`);
    }
    expr = expressionsFromBlendshapes(face.blendshapes);
    if (ui.emotion.value === "blend") {
      preds = state.smoother.update(expr.preds);
    } else if (ui.emotion.value === "vit" && state.vit) {
      // ViT runs every N frames, asynchronously: rendering never waits for it
      const every = Math.max(1, parseInt(ui.vitEvery.value) || 3);
      if (state.frame % every === 0 || !state.vitPreds) {
        state.vit.classify(el, face.box, { width: W, height: H }).then(out => {
          if (out) { state.vitPreds = state.smoother.update(out); state.dirty = true; }
        }).catch(e => console.warn("[vit]", e));
      }
      preds = state.vitPreds;
    }
  } else {
    state.blinker?.resetClosure();
    if (++state.miss > 10) { state.smoother.reset(); state.vitPreds = null; }  // face really lost
  }

  // --- hands ---
  let rect = null;
  if (state.hands) {
    const keys = HandsTracker.assignKeys(det.hands.map(h => h.label));
    const palms = {};
    keys.forEach((k, i) => { palms[k] = HandsTracker.palmCenter(det.hands[i].landmarks); });
    rect = state.hands.feed(palms, nowS);
  }

  // --- adaptive zoom: this frame's detection picks the region for the next ---
  if (ui.zoom.checked) state.zoomRoi = state.zoom.feed(face?.box || null, nowS, W, H);
  else { state.zoomRoi = null; if (state.zoom.state !== "full") state.zoom.reset(); }

  // --- positive-emotion stopwatch ---
  // preds is null with no face and with emotion off, so the clock pauses on its own
  const positive = !!preds && POSITIVE_LABELS.has(preds[0].label);
  state.positive.feed(positive, nowS);
  state.faceTime.feed(!!preds, nowS);

  // --- elapsed-time clock (since the program started) + happy% ---
  // The share is over the time a face was being read, not over the clock:
  // an empty room neither adds nor subtracts. A live ratio of the two
  // stopwatches, not a third accumulator, so it always agrees with them.
  state.elapsed = nowS - state.startTime / 1000;
  state.pctPositive = state.faceTime.seconds > 0 ? 100 * state.positive.seconds / state.faceTime.seconds : 0;

  // --- smile coach: happy time over face time, a spoken verdict when due ---
  if (state.coach) {
    // the reference is the session share above, so "was" is that number
    const ref = state.faceTime.seconds > 0 ? state.pctPositive / 100 : null;
    const verdict = state.coach.feed(positive, !!preds, nowS, ref);
    if (verdict) state.log?.verdict(verdict, nowS);
    if (verdict) console.log(`[coach] ${verdict.kind}: "${verdict.text}" happy=${(verdict.frac * 100).toFixed(0)}%`
      + (verdict.prevFrac === null ? "" : ` (was ${(verdict.prevFrac * 100).toFixed(0)}%)`));
  }

  // --- session log: everything above, accumulated for the JSON on the Desktop ---
  if (!state.log) {
    state.log = new SessionLog({ startedAt: Date.now(), nowS, frameWidth: W });
    state.logFile = sessionFileName(state.log.startedAt);
    state.transcriptFile = transcriptFileName(state.log.startedAt);
  }
  state.log.feed({
    nowS, label: preds ? preds[0].label : null, positive,
    valence: expr?.valence ?? null, arousal: expr?.arousal ?? null,
    blinked: !!blink?.blinked, hands: det.hands.length, palms: state.hands?.palms || null, rect: !!rect,
  });

  // --- fps ---
  const t = performance.now();
  if (state.lastT !== null) {
    const inst = 1000 / Math.max(1, t - state.lastT);
    state.fps = state.fps ? 0.9 * state.fps + 0.1 * inst : inst;
  }
  state.lastT = t;
  state.frame++;

  render(src, { face, blink, preds, rect, nowS });
  publish({ face, blink, expr, preds, rect, hands: det.hands.length });
}

// ---------- rendering ----------

function render(src, { face, blink, preds, rect, nowS }) {
  const { width: W, height: H, el } = src;
  const mirror = ui.mirror.checked;
  const mx = x => mirror ? W - x : x;

  ctx.save();
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  if (rect) {
    // hands in view: black screen, the video shows only inside the rect between the palms
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const x = Math.max(0, rect.x1), y = Math.max(0, rect.y1);
    const w = Math.min(W, rect.x2) - x, h = Math.min(H, rect.y2) - y;
    if (w > 0 && h > 0) ctx.drawImage(el, x, y, w, h, x, y, w, h);
  } else {
    ctx.drawImage(el, 0, 0, W, H);  // no hands: full video
  }
  ctx.restore();

  // main indicators: not debug, so the overlay toggle does not hide them
  if (ui.posTimer.checked) {
    const elapsedBottom = drawElapsedTimer(W, H);
    const posBottom = drawPositiveTimer(W, H, elapsedBottom);
    drawPositivePct(W, posBottom);
  }
  if (state.coach) drawCoach(W, H, nowS);

  if (!ui.overlay.checked) return;
  ctx.lineWidth = 2;
  ctx.font = "16px system-ui, sans-serif";
  ctx.textBaseline = "bottom";

  if (face) {
    const b = face.box;
    const x1 = Math.min(mx(b.x1), mx(b.x2)), x2 = Math.max(mx(b.x1), mx(b.x2));
    ctx.strokeStyle = "#0f0";
    ctx.strokeRect(x1, b.y1, x2 - x1, b.y2 - b.y1);
    if (preds) label(`${preds[0].label} ${preds[0].score.toFixed(2)}`, x1, Math.max(24, b.y1), "#0f0", "#000");
    if (blink) {
      ctx.strokeStyle = "#39f";
      ctx.lineWidth = 1;
      for (const idx of [LEFT_EYE, RIGHT_EYE]) {
        ctx.beginPath();
        idx.forEach((i, k) => { const p = face.landmarks[i]; k ? ctx.lineTo(mx(p.x), p.y) : ctx.moveTo(mx(p.x), p.y); });
        ctx.closePath(); ctx.stroke();
      }
    }
  }
  if (state.zoomRoi) {
    // the region actually handed to the detector, so the zoom is never a mystery
    const z = state.zoomRoi;
    const zx = Math.min(mx(z.x), mx(z.x + z.w));
    ctx.strokeStyle = "#ff0"; ctx.lineWidth = 2; ctx.setLineDash([9, 7]);
    ctx.strokeRect(zx, z.y, z.w, z.h);
    ctx.setLineDash([]);
    label(`zoom ${state.zoom.state} ${(W / z.w).toFixed(1)}x`, zx, Math.max(24, z.y), "#ff0", "#000");
  }
  if (blink) {
    const name = blink.mode === "blend" ? "blink" : "EAR";
    label(`${name} ${blink.level.toFixed(2)}  blink #${blink.blinks} (${blink.perMin.toFixed(0)}/min)${blink.blinked ? "  *BLINK*" : ""}`,
          10, H - 10, "#39f", "#fff");
  }
  if (state.hands) {
    ctx.fillStyle = "#fff";
    for (const p of Object.values(state.hands.palms)) { ctx.beginPath(); ctx.arc(mx(p.x), p.y, 5, 0, Math.PI * 2); ctx.fill(); }
    const ri = state.hands.resetIn(nowS);
    const txt = `hands=${Object.keys(state.hands.palms).length}${rect ? "  rect" : ""}${state.hands.hold ? " (locked)" : ""}${ri !== null ? `  reset in ${ri.toFixed(1)}s` : ""}`;
    label(txt, W - ctx.measureText(txt).width - 20, H - 10, "#000", "#fff");
  }
  label(`${state.fps.toFixed(1)} fps  faces=${face ? 1 : 0}`, 10, 30, "rgba(0,0,0,.6)", "#fff");
}

/**
 * Cumulative positive time, top centre, big enough to read across a room.
 * Green with a dot while it runs, dimmed grey while it is stopped: the state
 * is legible at a glance without reading the digits. `topY`, when given,
 * overrides the default top margin - used to stack this under the
 * elapsed-time clock. Returns the box's bottom edge, so a caller can stack
 * more readouts under it.
 */
function drawPositiveTimer(W, H, topY = null) {
  const { seconds, running } = state.positive;
  const txt = formatDuration(seconds);
  const size = Math.max(18, Math.round(H / 10));
  const green = "#0f0", grey = "rgba(255,255,255,.5)";

  ctx.save();
  ctx.font = `600 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const padX = size * 0.45, padY = size * 0.3, r = size * 0.16;
  const gap = running ? r * 3 : 0;
  const tw = ctx.measureText(txt).width;
  const bw = tw + gap + padX * 2, bh = size + padY * 2;
  const bx = (W - bw) / 2, by = topY ?? size * 0.35, cy = by + bh / 2;

  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, bh * 0.26);
  else ctx.rect(bx, by, bw, bh);
  ctx.fill();

  if (running) {
    ctx.fillStyle = green;
    ctx.beginPath(); ctx.arc(bx + padX + r, cy, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = running ? green : grey;
  ctx.fillText(txt, bx + padX + gap, cy + size * 0.04);
  ctx.restore();
  return by + bh;
}

/**
 * Wall-clock time since the program started, drawn directly above the
 * positive-time stopwatch. It never stops, so there's no on/off state to
 * signal - just a plain, constant readout. Returns its bottom edge, which
 * becomes the stopwatch's topY so the two stack with no overlap.
 */
function drawElapsedTimer(W, H) {
  const txt = `elapsed ${formatDuration(state.elapsed)}`;
  const size = Math.max(14, Math.round(H / 22));
  ctx.save();
  ctx.font = `500 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,.75)";
  const y = size * 0.5;
  ctx.fillText(txt, W / 2, y);
  ctx.restore();
  return y + size * 1.4;
}

/**
 * % of face time spent positive, drawn directly under the stopwatch.
 * Takes the stopwatch's own bottom edge so it always sits right beneath it
 * regardless of the stopwatch's font size or running/stopped padding.
 */
function drawPositivePct(W, topY) {
  const size = Math.max(14, Math.round(ui.canvas.height / 22));
  ctx.save();
  ctx.font = `500 ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,.75)";
  const txt = `session ${state.faceTime.seconds > 0 ? state.pctPositive.toFixed(1) : "--"}% happy`;
  ctx.fillText(txt, W / 2, topY + size * 0.3);
  ctx.restore();
}

/**
 * Coach readout at the bottom centre: the running happy share and the time to
 * the next verdict, plus the last line spoken as a caption for a few seconds.
 */
function drawCoach(W, H, nowS) {
  const c = state.coach;
  const frac = c.fraction();
  const prev = c.prevFrac;
  const ref = c.reference ?? prev;
  const info = `this round ${frac === null ? "--" : (frac * 100).toFixed(0)}% happy`
    + (ref === null ? "" : `  vs session ${(ref * 100).toFixed(0)}%`)
    + `  ·  next verdict in ${formatDuration(c.nextInS(nowS))}`;
  const size = Math.max(14, Math.round(H / 32));
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `500 ${size}px system-ui, sans-serif`;
  const infoW = ctx.measureText(info).width;
  let y = H - size * 1.6;
  ctx.fillStyle = "rgba(0,0,0,.55)";
  ctx.fillRect(W / 2 - infoW / 2 - size * 0.6, y - size * 0.8, infoW + size * 1.2, size * 1.6);
  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.fillText(info, W / 2, y);

  const last = c.last;
  if (last && nowS - last.atS < COACH_CAPTION_S) {
    const big = Math.max(20, Math.round(H / 16));
    ctx.font = `600 ${big}px system-ui, sans-serif`;
    const tw = ctx.measureText(last.text).width;
    y -= size * 1.6 + big;
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.fillRect(W / 2 - tw / 2 - big * 0.6, y - big * 0.85, tw + big * 1.2, big * 1.7);
    ctx.fillStyle = last.kind === "encouragement" ? "#0f0" : last.kind === "reprimand" ? "#f66" : "#ff0";
    ctx.fillText(last.text, W / 2, y);
  }
  ctx.restore();
}

function label(txt, x, y, bg, fg) {
  const w = ctx.measureText(txt).width + 8;
  ctx.fillStyle = bg; ctx.fillRect(x, y - 22, w, 22);
  ctx.fillStyle = fg; ctx.fillText(txt, x + 4, y - 3);
}

// ---------- state for the outside world + panel ----------

function publish({ face, blink, expr, preds, rect, hands }) {
  const s = {
    t: Date.now(), fps: state.fps, face: !!face,
    box: face?.box || null, emotion: preds?.[0] || null, probs: preds || null,
    valence: expr?.valence ?? null, arousal: expr?.arousal ?? null, smile: expr?.smile ?? null,
    blink: blink ? { level: blink.level, closed: blink.closed, blinked: blink.blinked, count: blink.blinks, perMin: blink.perMin } : null,
    positiveTime: { seconds: state.positive.seconds, running: state.positive.running },
    elapsed: state.elapsed, faceTime: state.faceTime.seconds, pctPositive: state.pctPositive,
    coach: state.coach ? {
      happyFrac: state.coach.fraction(), reference: state.coach.reference, prevFrac: state.coach.prevFrac,
      nextInS: state.coach.nextInS(performance.now() / 1000), last: state.coach.last,
    } : null,
    hands, palms: state.hands?.palms || {}, rect,
  };
  window.emotionState = s;
  window.dispatchEvent(new CustomEvent("emotionscript", { detail: s }));
  if (state.frame % 5 === 0) renderStats(s);
}

function renderStats(s) {
  const probs = s.probs ? Object.fromEntries(s.probs.map(p => [p.label, p.score])) : {};
  // face size in px next to the raw smile is the distance diagnostic: it says
  // whether a far face is lost by the detector or just crushed by the formula
  const box = s.box ? `  box ${Math.round(s.box.x2 - s.box.x1)}x${Math.round(s.box.y2 - s.box.y1)} px` : "";
  const lines = [`${s.fps.toFixed(1)} fps`, `face: ${s.face ? "yes" : "no"}${box}`];
  if (s.smile !== null)
    lines.push(`smile ${s.smile.toFixed(3)} -> happy ${(probs.happy ?? 0).toFixed(2)} / neutral ${(probs.neutral ?? 0).toFixed(2)}`);
  if (ui.zoom.checked) lines.push(`zoom: ${state.zoom.state}`);
  if (s.valence !== null) lines.push(`valence ${s.valence.toFixed(2)}  arousal ${s.arousal.toFixed(2)}`);
  if (s.blink) lines.push(`blink: ${s.blink.count} (${s.blink.perMin.toFixed(0)}/min)`);
  lines.push(`elapsed: ${formatDuration(s.elapsed)}`);
  lines.push(`positive: ${formatDuration(s.positiveTime.seconds)} ${s.positiveTime.running ? "(running)" : "(stopped)"}`);
  lines.push(`face time: ${formatDuration(s.faceTime)}  ${s.pctPositive.toFixed(1)}% happy`);
  if (s.coach) {
    const pct = v => v === null ? "--" : `${(v * 100).toFixed(0)}%`;
    lines.push(`coach: this round ${pct(s.coach.happyFrac)} vs session ${pct(s.coach.reference)}  next in ${formatDuration(s.coach.nextInS)}`);
    if (s.coach.last) lines.push(`  last: ${s.coach.last.kind} "${s.coach.last.text}"`);
  }
  if (state.hands) lines.push(`hands: ${s.hands}`);
  ui.stats.textContent = lines.join("\n");
  ui.bars.innerHTML = LABELS.map(l => {
    const v = probs[l] ?? 0;
    return `<div class="bar"><span>${l}</span><i style="width:${(v * 100).toFixed(0)}%"></i><b>${v.toFixed(2)}</b></div>`;
  }).join("");
}

// ---------- events ----------

async function onControls() {
  try { await syncModules(); } catch (e) { setStatus(`error: ${e.message}`); console.error(e); }
  state.dirty = true;
}

ui.source.addEventListener("change", async () => {
  if (ui.source.value === "__file") { ui.file.click(); return; }
  try { await openWebcam(ui.source.value); } catch (e) { setStatus(`webcam: ${e.message}`); }
  state.dirty = true;
});
ui.file.addEventListener("change", async () => {
  const f = ui.file.files[0];
  if (!f) return;
  try { await openFile(f); } catch (e) { setStatus(`file: ${e.message}`); }
  state.dirty = true;
});
for (const el of [ui.blink, ui.blinkMode, ui.blinkThresh, ui.hands, ui.handsHold, ui.handsResetOn, ui.handsReset, ui.emotion, ui.vitEvery])
  el.addEventListener("change", onControls);
ui.mirror.addEventListener("change", () => { state.dirty = true; });
ui.overlay.addEventListener("change", () => { state.dirty = true; });
ui.posTimer.addEventListener("change", () => { state.dirty = true; });
ui.zoom.addEventListener("change", () => { state.zoom.reset(); state.zoomRoi = null; state.dirty = true; });

/** Panel settings of the coach, kept across reloads. */
const COACH_KEY = "smile_detector.coach";
function saveCoachSettings() {
  try {
    localStorage.setItem(COACH_KEY, JSON.stringify({
      on: ui.coach.checked, first: ui.coachFirst.value, every: ui.coachEvery.value, thresh: ui.coachThresh.value,
    }));
  } catch {}
}
function loadCoachSettings() {
  try {
    const c = JSON.parse(localStorage.getItem(COACH_KEY) || "null");
    if (!c) return;
    ui.coach.checked = !!c.on;
    if (c.first) ui.coachFirst.value = c.first;
    if (c.every) ui.coachEvery.value = c.every;
    if (c.thresh) ui.coachThresh.value = c.thresh;
  } catch {}
}

/** Speech feedback in the status line; a blocked line is retried on the next click. */
function onVoiceState(st, text, detail) {
  if (st === "speaking") { state.blockedText = null; setStatus(`voice: "${text}"`); }
  else if (st === "blocked") { state.blockedText = text; setStatus("voice blocked by the browser: click anywhere on the page to enable it"); }
  else if (st === "error") setStatus(`voice error: ${detail}`);
  console.log(`[voice] ${st}${detail ? ` (${detail})` : ""}: "${text}"`);
}
function ensureSpeaker() {
  if (!state.speak) state.speak = browserSpeaker({ onState: onVoiceState });
  return state.speak;
}
document.addEventListener("click", () => {
  // the click is the user activation the browser wanted: say the line it refused
  if (state.blockedText && state.speak) { const t = state.blockedText; state.blockedText = null; state.speak(t); }
}, true);

/**
 * (Re)build the coach from the panel. Any change restarts it: the windows
 * only make sense from the moment the settings were chosen.
 */
function syncCoach() {
  saveCoachSettings();
  if (!ui.coach.checked) { state.coach = null; state.dirty = true; return; }
  if (!ensureSpeaker()) setStatus("speech synthesis not available in this browser: the coach runs silently");
  state.coach = new SmileCoach({
    firstS: Math.max(5, parseFloat(ui.coachFirst.value) || 120),
    everyS: Math.max(5, parseFloat(ui.coachEvery.value) || 60),
    threshold: Math.min(1, Math.max(0, (parseFloat(ui.coachThresh.value) || 30) / 100)),
    speak: state.speak,
    nowS: performance.now() / 1000,
  });
  state.dirty = true;
}
for (const el of [ui.coach, ui.coachFirst, ui.coachEvery, ui.coachThresh]) el.addEventListener("change", syncCoach);
ui.coachTest.addEventListener("click", () => {
  if (ensureSpeaker()) state.speak("Smile coach ready"); else setStatus("speech synthesis not available in this browser");
});

/**
 * Speech, only on the voice entry point: `index.html` never imports the module,
 * so the plain version is byte for byte the one that was there before.
 *
 * The router is pure and always running once built; the Vosk listener is what
 * needs the microphone, and it is started on the first click because an
 * AudioContext may not be resumed before a gesture.
 */
const SPEECH_KEY = "smile_detector.speech";
const REC_KEY = "smile_detector.speechRec";
let starting_ish = () => false;
/**
 * Speech, only on the voice entry point: `index.html` never imports the module,
 * so the plain version is byte for byte the one that was there before.
 *
 * Two switches, and they mean different things. `speech` loads the model and
 * opens the microphone, which costs seconds and a permission prompt, so it is
 * done once. `recording` decides whether anything is decoded at all - it is
 * the one a visitor flips, and it replaced the spoken commands, which had to
 * be recognised before anything was being recorded and competed with the
 * visitor's own words.
 */
async function initSpeech() {
  const { Transcriber, voskListener } = await import("./speech.js");
  const { ENCOURAGEMENTS, REPRIMANDS, STEADY } = await import("./coach.js");
  const setSpeechInfo = t => { if (ui.speechInfo) ui.speechInfo.textContent = t; };

  state.speech = new Transcriber({
    coachPhrases: [...ENCOURAGEMENTS, ...REPRIMANDS, STEADY],
    nowS: performance.now() / 1000,
    onText: text => {
      if (ui.speechText) ui.speechText.textContent = text;
      state.dirty = true;
    },
  });

  /**
   * vosk-browser ships a UMD bundle, not an ES module: it installs a `Vosk`
   * global and exports nothing, so `import()` would run it and hand back an
   * empty namespace. A classic script tag is the documented way in.
   */
  function loadVosk(src) {
    if (window.Vosk) return Promise.resolve(window.Vosk);
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => window.Vosk ? resolve(window.Vosk) : reject(new Error(`${src} loaded but defined no Vosk global`));
      el.onerror = () => reject(new Error(`cannot load ${src}`));
      document.head.appendChild(el);
    });
  }

  const withTimeout = (ms, what, p) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} within ${ms / 1000}s`)), ms)),
  ]);

  let listener = null, starting = false;
  starting_ish = () => starting;
  /**
   * Every gesture retries this, so `starting` matters: without it a second one
   * during the model load - 39 MB, seconds of it - would begin a second load
   * racing the first.
   */
  async function startListening() {
    if (listener || starting || !ui.speech?.checked) {
      if (!ui.speech?.checked) state.speechPhase = "switch off";
      return;
    }
    starting = true;
    setSpeechInfo("loading the model, this takes a few seconds...");
    try {
      state.speechPhase = "loading the library";
      const vosk = await loadVosk(ui.speechLib?.value || "vendor/vosk-browser.js");
      state.speechPhase = "loading the model";
      // A load that neither resolves nor rejects leaves no trace at all: the
      // worker just never answers. Time it out so a hang becomes an error.
      const l = await withTimeout(120000, "the model did not load", voskListener({
        vosk,
        modelUrl: ui.speechModel?.value || "vendor/vosk-model-small-en-us-0.15.tar.gz",
        transcriber: state.speech, element: video,
        speaking: () => !!(window.speechSynthesis && window.speechSynthesis.speaking),
        onState: (s, d) => setSpeechInfo(d ? `${s}: ${d}` : s),
      }));
      state.speechPhase = "opening the audio";
      await l.setSource(state.source?.kind || "webcam");
      listener = l;
      state.speechListener = l;
      state.speechPhase = "ready";
      state.speechFailure = null;
      syncRecording();                     // honour a recording switch left on
    } catch (e) {
      // the panel is easy to miss and the console is not always open: the
      // session file has to carry this too, or the failure leaves no trace
      const failure = `${e.name || "Error"}: ${e.message || e}`;
      state.speechFailure = `failed while ${state.speechPhase}: ${failure}`;
      state.speechPhase = `failed while ${state.speechPhase}`;
      console.error("[speech] cannot start:", e);
      setSpeechInfo(`speech off - ${failure}`);
    } finally {
      starting = false;
    }
  }

  /**
   * Stopping asks Vosk to finalise first, and waits: its endpointing lags the
   * moment somebody stops talking, so the last sentence would otherwise land
   * after the recorder was already off - or not at all.
   */
  async function syncRecording() {
    const on = !!(ui.speechRec?.checked && listener);
    if (!on && state.speech.recording && listener) {
      setSpeechInfo("finishing the last sentence...");
      await listener.finalize();
    }
    state.speech.setRecording(on, performance.now() / 1000);
    console.log(`[speech] recording ${on ? "on" : "off"}`);
    if (on) setSpeechInfo("recording");
    else if (listener) setSpeechInfo("ready, not recording");
    state.dirty = true;
  }

  // Any gesture will do to resume a suspended context, and this page is driven
  // as much by keys as by clicks: a kiosk may never see a click at all.
  for (const ev of ["click", "keydown"]) {
    document.addEventListener(ev, () => { startListening(); listener?.resume(); });
  }

  // A restored switch is a promise the page has to keep. Assigning .checked
  // fires no change event, so persisting it once left the box claiming to be
  // on while nothing had started.
  try {
    if (localStorage.getItem(SPEECH_KEY) === "1" && ui.speech) ui.speech.checked = true;
    if (localStorage.getItem(REC_KEY) === "1" && ui.speechRec) ui.speechRec.checked = true;
  } catch {}
  if (ui.speech?.checked) startListening();

  ui.speech?.addEventListener("change", () => {
    try { localStorage.setItem(SPEECH_KEY, ui.speech.checked ? "1" : "0"); } catch {}
    if (ui.speech.checked) startListening();
    else {
      state.speech.setRecording(false, performance.now() / 1000);
      listener?.stop(); listener = null; state.speechListener = null;
      setSpeechInfo("switch speech on to start listening");
    }
  });
  ui.speechRec?.addEventListener("change", () => {
    try { localStorage.setItem(REC_KEY, ui.speechRec.checked ? "1" : "0"); } catch {}
    startListening();                      // recording implies wanting to listen
    syncRecording();
  });
  if (!ui.speech?.checked) setSpeechInfo("switch speech on to start listening");
}
if (window.SMILE_SPEECH) initSpeech();

/**
 * Session JSON to the Desktop through the local server. `sendBeacon` is the
 * one request a page may still make while it is being closed; the manual save
 * uses fetch so the reply (the path written) can be shown.
 */
function sessionBody(reason) {
  // the recogniser's own account of the session, so a JSON with no transcript
  // still says which link of the chain broke
  if (state.log && state.speech) {
    const nowS = performance.now() / 1000;
    state.log.transcript({
      text: state.speech.text(), words: state.speech.words(),
      conf: state.speech.confidence(), recordedS: +state.speech.seconds(nowS).toFixed(2),
      top: state.speech.top(5), top3: state.speech.topLine(3), timings: state.speech.wordTimings(),
      file: state.transcriptFile, sessionFile: state.logFile,
    });
    state.log.speechStats({
      ...state.speech.stats,
      ...(state.speechListener?.stats || {
        listener: state.speechFailure || (starting_ish() ? `still ${state.speechPhase}` : "never started"),
      }),
      phase: state.speechPhase,
      checkbox: ui.speech ? (ui.speech.checked ? "on" : "off") : "absent",
    });
  }
  return JSON.stringify(state.log.toJSON({ nowS: performance.now() / 1000, reason }), null, 2);
}
/**
 * Post one document to the local server. `sendBeacon` caps the payload
 * (~64 KB) and returns false rather than throwing; only a transcript can grow
 * that far, and a silent loss of the final save is not a thing to find out
 * about later, so it falls back to a keepalive fetch.
 */
function postSave(name, text, reason, report) {
  const url = `save?name=${encodeURIComponent(name)}`;
  const body = new Blob([text], { type: "application/json" });
  if (reason === "close") {
    if (!navigator.sendBeacon(url, body)) fetch(url, { method: "POST", body, keepalive: true }).catch(() => {});
    return;
  }
  fetch(url, { method: "POST", body })
    .then(async r => {
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const { path } = await r.json();
      if (report) ui.saveInfo.textContent = `saved ${path} (${reason}, ${new Date().toLocaleTimeString()})`;
    })
    .catch(e => { if (report) ui.saveInfo.textContent = `save failed: ${e.message}. Serve with serve.py (npm run serve).`; });
}

/**
 * A session writes two files: what it measured, and what it heard. They are
 * kept apart because they are different kinds of record - read by different
 * people, kept for different reasons, shared under different rules - and the
 * transcript is written only when there is one, so a silent session leaves no
 * empty file behind.
 */
function saveSession(reason) {
  if (!state.log || !ui.saveLog.checked) return;
  const body = sessionBody(reason);            // also folds the transcript into the log
  postSave(state.logFile, body, reason, true);
  const t = state.log.transcriptJSON({ nowS: performance.now() / 1000, reason });
  if (t) postSave(state.transcriptFile, JSON.stringify(t, null, 2), reason, false);
}
setInterval(() => saveSession("autosave"), AUTOSAVE_S * 1000);
window.addEventListener("pagehide", () => saveSession("close"));   // close, reload, navigation away
ui.saveNow.addEventListener("click", () => saveSession("manual"));
ui.saveLog.addEventListener("change", () => { try { localStorage.setItem("smile_detector.saveLog", ui.saveLog.checked ? "1" : "0"); } catch {} });
try { if (localStorage.getItem("smile_detector.saveLog") === "0") ui.saveLog.checked = false; } catch {}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "s") saveSession("manual");
  if (e.key === "h") ui.panel.hidden = !ui.panel.hidden;
  if (e.key === "o") { ui.overlay.checked = !ui.overlay.checked; state.dirty = true; }
  if (e.key === "m") { ui.mirror.checked = !ui.mirror.checked; state.dirty = true; }
  if (e.key === "r") { state.hands?.reset(performance.now() / 1000); state.dirty = true; }
  if (e.key === "t") { const t = performance.now() / 1000; state.positive.reset(t); state.faceTime.reset(t); state.dirty = true; }
  if (e.key === "c") { state.coach?.check(performance.now() / 1000); state.dirty = true; }
  if (e.key === "v" && ui.speechRec) { ui.speechRec.checked = !ui.speechRec.checked; ui.speechRec.dispatchEvent(new Event("change")); }
  if (e.key === "f") document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});

// drag & drop a file onto the page
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", async e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) { try { await openFile(f); } catch (err) { setStatus(`file: ${err.message}`); } state.dirty = true; }
});

// ---------- startup ----------

(async () => {
  state.running = true;
  requestAnimationFrame(tick);
  await listCams();
  try { await syncModules(); } catch (e) { setStatus(`error: ${e.message}`); console.error(e); return; }
  loadCoachSettings();
  syncCoach();
  const params = new URLSearchParams(location.search);
  if (params.get("image")) {
    // ?image=url : test image without a camera (e.g. ?image=test.jpg)
    try {
      const blob = await (await fetch(params.get("image"))).blob();
      await openFile(new File([blob], params.get("image"), { type: blob.type || "image/jpeg" }));
    } catch (e) { setStatus(`image: ${e.message}`); }
    state.dirty = true;
  } else if (params.get("source") !== "file") {
    try { await openWebcam(); } catch (e) { setStatus(`webcam unavailable (${e.message}): pick a file`); }
  }
})();
