/**
 * MediaPipe Tasks Vision wrapper (FaceLandmarker + HandLandmarker), loaded from CDN.
 * Returns results already in pixels, with blendshapes as a {name: score} map.
 */
const MP_VERSION = "0.10.35";
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

let _mp = null;
async function mp() {
  if (!_mp) _mp = await import(`${MP_BASE}/vision_bundle.mjs`);
  return _mp;
}

let _fileset = null;
async function fileset() {
  const { FilesetResolver } = await mp();
  if (!_fileset) _fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  return _fileset;
}

export class Vision {
  constructor({ numFaces = 3, numHands = 2, delegate = "GPU" } = {}) {
    this.numFaces = numFaces;
    this.numHands = numHands;
    this.delegate = delegate;
    this.face = null;
    this.hand = null;
    this.mode = "VIDEO";
    this._lastTs = -1;
  }

  async loadFace(onStatus = () => {}) {
    if (this.face) return this.face;
    onStatus("carico FaceLandmarker...");
    const { FaceLandmarker } = await mp();
    this.face = await FaceLandmarker.createFromOptions(await fileset(), {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: this.delegate },
      runningMode: this.mode,
      numFaces: this.numFaces,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    return this.face;
  }

  async loadHand(onStatus = () => {}) {
    if (this.hand) return this.hand;
    onStatus("carico HandLandmarker...");
    const { HandLandmarker } = await mp();
    this.hand = await HandLandmarker.createFromOptions(await fileset(), {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: this.delegate },
      runningMode: this.mode,
      numHands: this.numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    return this.hand;
  }

  /** "VIDEO" for webcam/video (tracking), "IMAGE" for single still images. */
  async setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.face) await this.face.setOptions({ runningMode: mode });
    if (this.hand) await this.hand.setOptions({ runningMode: mode });
  }

  // MediaPipe VIDEO mode needs strictly increasing timestamps.
  _ts() {
    const t = Math.round(performance.now());
    this._lastTs = Math.max(t, this._lastTs + 1);
    return this._lastTs;
  }

  _run(task, source) {
    if (this.mode === "IMAGE") return task.detect(source);
    return task.detectForVideo(source, this._ts());
  }

  /** Returns {faces: [{landmarks:[{x,y}px], blendshapes:{name:score}, box}], hands: [{label, landmarks}]}. */
  detect(source, width, height, { wantFace = true, wantHands = true } = {}) {
    const out = { faces: [], hands: [] };
    if (wantFace && this.face) {
      const r = this._run(this.face, source);
      (r.faceLandmarks || []).forEach((lm, i) => {
        const pts = lm.map(p => ({ x: p.x * width, y: p.y * height }));
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const p of pts) { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y); }
        const bs = {};
        for (const c of (r.faceBlendshapes?.[i]?.categories || [])) bs[c.categoryName] = c.score;
        out.faces.push({ landmarks: pts, blendshapes: bs, box: { x1, y1, x2, y2 } });
      });
      // largest = closest, first
      out.faces.sort((a, b) => (b.box.x2 - b.box.x1) * (b.box.y2 - b.box.y1) - (a.box.x2 - a.box.x1) * (a.box.y2 - a.box.y1));
    }
    if (wantHands && this.hand) {
      const r = this._run(this.hand, source);
      const lms = r.landmarks || [];
      const labels = (r.handedness || []).map(h => h?.[0]?.categoryName || "");
      while (labels.length < lms.length) labels.push("");
      out.hands = lms.map((lm, i) => ({
        label: labels[i],
        landmarks: lm.map(p => ({ x: p.x * width, y: p.y * height })),
      }));
    }
    return out;
  }
}
