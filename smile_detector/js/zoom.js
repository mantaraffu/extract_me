/**
 * Adaptive digital zoom for face detection at a distance.
 *
 * BlazeFace, the detector bundled in face_landmarker.task, resizes the whole
 * frame to about 128px before looking at it: what decides whether it sees a
 * face is the *fraction* of the frame the face covers, not how many pixels it
 * has. Raising the capture resolution therefore changes nothing, and past
 * roughly 2 m the face is gone. Cropping does change it — half the frame is
 * twice the fraction.
 *
 * So this picks, each frame, which region to hand the detector:
 *
 *   full  --- face lost --->  search  --- face found --->  track
 *     ^                         |                            |
 *     +-------------------------+------ lost for 0.4s -------+
 *
 * - full:   whole frame, the resting state, no field of view given up
 * - search: centre crop at `zoom`. While nobody is found it alternates back to
 *           full, so a far face at the centre and a near one at the edge are
 *           both reachable; searching only the centre would strand anyone who
 *           steps out of it.
 * - track:  crop following the face box with context around it, eased so the
 *           geometry handed to MediaPipe does not jump between frames.
 *
 * The crop is expressed as a single scale of the frame, which keeps the source
 * aspect ratio by construction: a stretched crop would hand MediaPipe distorted
 * faces and skew every landmark.
 *
 * Only the detector's input region lives here. `feed` is pure logic over
 * numbers, so it is testable without a canvas or a model.
 */
export class ZoomTracker {
  constructor({ zoom = 2, margin = 1.6, minCropRatio = 0.25, lostToleranceS = 0.4,
                searchPeriodS = 0.5, alpha = 0.35 } = {}) {
    this.zoom = zoom;
    this.margin = margin;
    this.minCropRatio = minCropRatio;
    this.lostToleranceS = lostToleranceS;
    this.searchPeriodS = searchPeriodS;
    this.alpha = alpha;
    this.reset();
  }

  get state() { return this._state; }

  reset() {
    this._state = "full";
    this._since = null;
    this._lostSince = null;
    this._crop = null;    // {s, cx, cy} in frame units, smoothed
  }

  /**
   * faceBox: {x1,y1,x2,y2} in frame pixels, or null when no face was found.
   * Returns the crop {x,y,w,h} to feed the detector, or null for the full frame.
   */
  feed(faceBox, nowS, W, H) {
    if (this._since === null) this._since = nowS;

    if (this._state === "full") {
      if (faceBox) this._since = nowS;                                  // still visible: stay wide
      else if (nowS - this._since >= this.searchPeriodS) this._enter("search", nowS);
    } else if (this._state === "search") {
      if (faceBox) this._enter("track", nowS);
      else if (nowS - this._since >= this.searchPeriodS) this._enter("full", nowS);
    } else {
      if (faceBox) this._lostSince = null;
      else {
        if (this._lostSince === null) this._lostSince = nowS;
        if (nowS - this._lostSince >= this.lostToleranceS) this._enter("full", nowS);
      }
    }

    if (this._state === "full") return null;
    if (this._state === "search") return this._rect(1 / this.zoom, W / 2, H / 2, W, H);
    if (faceBox) this._track(faceBox, W, H);
    return this._crop ? this._rect(this._crop.s, this._crop.cx, this._crop.cy, W, H) : null;
  }

  _enter(state, nowS) {
    this._state = state;
    this._since = nowS;
    this._lostSince = null;
    if (state !== "track") this._crop = null;
  }

  /** Ease the crop toward the one that frames this face box. */
  _track(b, W, H) {
    const bw = (b.x2 - b.x1) * this.margin, bh = (b.y2 - b.y1) * this.margin;
    const target = {
      s: Math.min(1, Math.max(this.minCropRatio, bw / W, bh / H)),
      cx: (b.x1 + b.x2) / 2,
      cy: (b.y1 + b.y2) / 2,
    };
    if (!this._crop) { this._crop = target; return; }   // first frame: snap, do not drift in
    const a = this.alpha;
    this._crop = {
      s: a * target.s + (1 - a) * this._crop.s,
      cx: a * target.cx + (1 - a) * this._crop.cx,
      cy: a * target.cy + (1 - a) * this._crop.cy,
    };
  }

  /** A crop of the frame at scale s centred on (cx, cy), kept inside the frame. */
  _rect(s, cx, cy, W, H) {
    const w = W * s, h = H * s;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
  }
}
