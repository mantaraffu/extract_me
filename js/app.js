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

const $ = id => document.getElementById(id);
const ui = {
  canvas: $("view"), status: $("status"), panel: $("panel"),
  source: $("source"), file: $("file"), mirror: $("mirror"), overlay: $("overlay"),
  blink: $("blink"), blinkMode: $("blinkMode"), blinkThresh: $("blinkThresh"),
  hands: $("hands"), handsHold: $("handsHold"), handsResetOn: $("handsResetOn"), handsReset: $("handsReset"),
  emotion: $("emotion"), vitEvery: $("vitEvery"),
  stats: $("stats"), bars: $("bars"),
};
const ctx = ui.canvas.getContext("2d");

const video = document.createElement("video");
video.muted = true; video.playsInline = true; video.loop = true;

const state = {
  source: null,        // {kind: "webcam"|"video"|"image", el, width, height}
  vision: new Vision(),
  blinker: null,
  hands: null,
  smoother: new EmotionSmoother(),
  vit: null,
  vitPreds: null,
  frame: 0,
  fps: 0,
  lastT: null,
  miss: 0,
  lastVideoTime: -1,
  running: false,
  dirty: false,        // image mode: re-render on the next tick
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
    f.value = "__file"; f.textContent = "file video / immagine...";
    ui.source.appendChild(f);
    if ([...ui.source.options].some(o => o.value === cur)) ui.source.value = cur;
  } catch (e) { console.warn(e); }
}

function stopSource() {
  if (state.source?.kind === "webcam") video.srcObject?.getTracks().forEach(t => t.stop());
  if (state.source?.kind === "video") { video.pause(); URL.revokeObjectURL(video.src); }
  state.source = null;
}

async function openWebcam(deviceId) {
  stopSource();
  setStatus("apro la webcam...");
  const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 },
                                 ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, audio: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  state.source = { kind: "webcam", el: video, width: video.videoWidth, height: video.videoHeight };
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
    ui.mirror.checked = false;
    await state.vision.setMode("IMAGE");
    setStatus(`immagine ${img.naturalWidth}x${img.naturalHeight}`);
    return;
  }
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  await video.play();
  state.source = { kind: "video", el: video, width: video.videoWidth, height: video.videoHeight };
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
  if (/^carico/.test(ui.status.textContent)) setStatus("pronto");
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
  if (blink) {
    const name = blink.mode === "blend" ? "blink" : "EAR";
    label(`${name} ${blink.level.toFixed(2)}  blink #${blink.blinks} (${blink.perMin.toFixed(0)}/min)${blink.blinked ? "  *BLINK*" : ""}`,
          10, H - 10, "#39f", "#fff");
  }
  if (state.hands) {
    ctx.fillStyle = "#fff";
    for (const p of Object.values(state.hands.palms)) { ctx.beginPath(); ctx.arc(mx(p.x), p.y, 5, 0, Math.PI * 2); ctx.fill(); }
    const ri = state.hands.resetIn(nowS);
    const txt = `mani=${Object.keys(state.hands.palms).length}${rect ? "  rect" : ""}${state.hands.hold ? " (bloccato)" : ""}${ri !== null ? `  reset in ${ri.toFixed(1)}s` : ""}`;
    label(txt, W - ctx.measureText(txt).width - 20, H - 10, "#000", "#fff");
  }
  label(`${state.fps.toFixed(1)} fps  faces=${face ? 1 : 0}`, 10, 30, "rgba(0,0,0,.6)", "#fff");
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
    valence: expr?.valence ?? null, arousal: expr?.arousal ?? null,
    blink: blink ? { level: blink.level, closed: blink.closed, blinked: blink.blinked, count: blink.blinks, perMin: blink.perMin } : null,
    hands, palms: state.hands?.palms || {}, rect,
  };
  window.emotionState = s;
  window.dispatchEvent(new CustomEvent("emotionscript", { detail: s }));
  if (state.frame % 5 === 0) renderStats(s);
}

function renderStats(s) {
  const lines = [`${s.fps.toFixed(1)} fps`, `volto: ${s.face ? "sì" : "no"}`];
  if (s.valence !== null) lines.push(`valenza ${s.valence.toFixed(2)}  attivazione ${s.arousal.toFixed(2)}`);
  if (s.blink) lines.push(`blink: ${s.blink.count} (${s.blink.perMin.toFixed(0)}/min)`);
  if (state.hands) lines.push(`mani: ${s.hands}`);
  ui.stats.textContent = lines.join("\n");
  const probs = s.probs ? Object.fromEntries(s.probs.map(p => [p.label, p.score])) : {};
  ui.bars.innerHTML = LABELS.map(l => {
    const v = probs[l] ?? 0;
    return `<div class="bar"><span>${l}</span><i style="width:${(v * 100).toFixed(0)}%"></i><b>${v.toFixed(2)}</b></div>`;
  }).join("");
}

// ---------- events ----------

async function onControls() {
  try { await syncModules(); } catch (e) { setStatus(`errore: ${e.message}`); console.error(e); }
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

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.key === "h") ui.panel.hidden = !ui.panel.hidden;
  if (e.key === "o") { ui.overlay.checked = !ui.overlay.checked; state.dirty = true; }
  if (e.key === "m") { ui.mirror.checked = !ui.mirror.checked; state.dirty = true; }
  if (e.key === "r") { state.hands?.reset(performance.now() / 1000); state.dirty = true; }
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
  try { await syncModules(); } catch (e) { setStatus(`errore: ${e.message}`); console.error(e); return; }
  const params = new URLSearchParams(location.search);
  if (params.get("image")) {
    // ?image=url : test image without a camera (e.g. ?image=test.jpg)
    try {
      const blob = await (await fetch(params.get("image"))).blob();
      await openFile(new File([blob], params.get("image"), { type: blob.type || "image/jpeg" }));
    } catch (e) { setStatus(`immagine: ${e.message}`); }
    state.dirty = true;
  } else if (params.get("source") !== "file") {
    try { await openWebcam(); } catch (e) { setStatus(`webcam non disponibile (${e.message}): scegli un file`); }
  }
})();
