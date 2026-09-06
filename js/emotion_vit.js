/**
 * Emotion ViT in the browser via transformers.js: Xenova/facial_emotions_image_detection
 * (ONNX export of dima806/facial_emotions_image_detection, 7 classes).
 * Loaded only on demand. Tries WebGPU (fp32), falls back to WASM (q8).
 * `?device=wasm` in the URL forces the WASM path.
 * Note: fp16 on WebGPU yields near-uniform probabilities with this model, hence fp32.
 */
const TF_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
const MODEL = "Xenova/facial_emotions_image_detection";

export class EmotionViT {
  constructor() {
    this.pipe = null;
    this.device = null;
    this.busy = false;
    this._canvas = new OffscreenCanvas(224, 224);
    this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
  }

  async load(onStatus = () => {}) {
    if (this.pipe) return;
    onStatus("carico transformers.js...");
    const tf = await import(TF_URL);
    this._tf = tf;
    const forced = new URLSearchParams(location.search).get("device");
    const hasGpu = !!navigator.gpu && forced !== "wasm";
    const attempts = hasGpu ? [["webgpu", "fp32"], ["wasm", "q8"]] : [["wasm", "q8"]];
    let lastErr = null;
    for (const [device, dtype] of attempts) {
      try {
        const size = dtype === "fp32" ? "~350MB" : "~90MB";
        onStatus(`carico ViT emotion su ${device} (primo avvio: ${size})...`);
        const seen = {};
        const progress_callback = p => {
          if (p.status === "progress" && p.file?.endsWith(".onnx")) {
            const pct = Math.round(p.progress || 0);
            if (seen[p.file] !== pct) { seen[p.file] = pct; onStatus(`scarico ViT ${dtype} su ${device}: ${pct}%`); }
          }
        };
        const p = await tf.pipeline("image-classification", MODEL, { device, dtype, progress_callback });
        // Warm-up inference: some ops fail on WebGPU, in which case we fall back to WASM.
        await p(await tf.RawImage.fromCanvas(this._blank()), { top_k: 1 });
        this.pipe = p;
        this.device = device;
        onStatus(`ViT emotion pronto su ${device}`);
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`[vit] ${device} failed:`, e);
      }
    }
    throw new Error(`ViT non caricabile: ${lastErr?.message || lastErr}`);
  }

  _blank() {
    this._ctx.fillStyle = "#808080";
    this._ctx.fillRect(0, 0, 224, 224);
    return this._canvas;
  }

  /** Square crop around the box (with margin) from the source, then classify.
   * Returns [{label, score}] or null when busy. */
  async classify(source, box, { margin = 0.4, width, height } = {}) {
    if (!this.pipe || this.busy) return null;
    this.busy = true;
    try {
      const cx = (box.x1 + box.x2) / 2, cy = (box.y1 + box.y2) / 2;
      let side = Math.max(box.x2 - box.x1, box.y2 - box.y1) * (1 + 2 * margin);
      side = Math.max(2, Math.min(side, width, height));
      const sx = Math.min(Math.max(0, cx - side / 2), width - side);
      const sy = Math.min(Math.max(0, cy - side / 2), height - side);
      this._ctx.drawImage(source, sx, sy, side, side, 0, 0, 224, 224);
      const img = await this._tf.RawImage.fromCanvas(this._canvas);
      const out = await this.pipe(img, { top_k: 7 });
      return out.map(r => ({ label: r.label, score: r.score }));
    } finally {
      this.busy = false;
    }
  }
}
