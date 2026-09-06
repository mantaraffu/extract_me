/**
 * EMA over probabilities + hysteresis: the label changes only when the new
 * one beats the current by at least `margin`. Removes frame-to-frame flicker.
 */
export class EmotionSmoother {
  constructor({ alpha = 0.3, margin = 0.1 } = {}) {
    this.alpha = alpha;
    this.margin = margin;
    this.probs = null;
    this.label = null;
  }

  /** preds: [{label, score}] for one frame. Returns the smoothed list, current label first. */
  update(preds) {
    if (!this.probs) {
      this.probs = Object.fromEntries(preds.map(p => [p.label, p.score]));
    } else {
      for (const p of preds) {
        const prev = this.probs[p.label] ?? 0;
        this.probs[p.label] = this.alpha * p.score + (1 - this.alpha) * prev;
      }
    }
    const ranked = Object.entries(this.probs).sort((a, b) => b[1] - a[1]);
    const [best, bestP] = ranked[0];
    if (this.label === null || best === this.label) this.label = best;
    else if (bestP > (this.probs[this.label] ?? 0) + this.margin) this.label = best;
    return [{ label: this.label, score: this.probs[this.label] },
            ...ranked.filter(([l]) => l !== this.label).map(([label, score]) => ({ label, score }))];
  }

  reset() { this.probs = null; this.label = null; }
}
