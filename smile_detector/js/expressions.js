/**
 * Expressions from the 52 FaceLandmarker blendshapes (heuristic, zero cost).
 *
 * Returns the 7 classes of the ViT model (sad, disgust, angry, neutral, fear,
 * surprise, happy) as a normalized distribution, plus continuous valence and
 * arousal. This is not a trained classifier: it is a readable, editable map,
 * meant for an installation where continuous values matter.
 */
export const LABELS = ["sad", "disgust", "angry", "neutral", "fear", "surprise", "happy"];

const avg = (...v) => v.reduce((a, b) => a + b, 0) / v.length;
const clamp01 = v => Math.min(1, Math.max(0, v));

/** bs: {blendshapeName: score 0..1}. */
export function expressionsFromBlendshapes(bs) {
  const g = n => bs[n] ?? 0;
  const smile = avg(g("mouthSmileLeft"), g("mouthSmileRight"));
  const frown = avg(g("mouthFrownLeft"), g("mouthFrownRight"));
  const browDown = avg(g("browDownLeft"), g("browDownRight"));
  const browInnerUp = g("browInnerUp");
  const eyeWide = avg(g("eyeWideLeft"), g("eyeWideRight"));
  const eyeSquint = avg(g("eyeSquintLeft"), g("eyeSquintRight"));
  const jawOpen = g("jawOpen");
  const mouthPress = avg(g("mouthPressLeft"), g("mouthPressRight"));
  const mouthStretch = avg(g("mouthStretchLeft"), g("mouthStretchRight"));
  const noseSneer = avg(g("noseSneerLeft"), g("noseSneerRight"));
  const upperUp = avg(g("mouthUpperUpLeft"), g("mouthUpperUpRight"));
  const shrug = avg(g("mouthShrugLower"), g("mouthShrugUpper"));

  const raw = {
    happy: clamp01(smile * 1.2),
    surprise: clamp01(0.5 * jawOpen + 0.3 * browInnerUp + 0.2 * eyeWide),
    angry: clamp01(0.6 * browDown + 0.2 * eyeSquint + 0.2 * mouthPress),
    sad: clamp01(0.5 * frown + 0.3 * browInnerUp * (1 - jawOpen) + 0.2 * shrug),
    fear: clamp01(0.4 * eyeWide + 0.3 * browInnerUp + 0.3 * mouthStretch),
    disgust: clamp01(0.5 * noseSneer + 0.5 * upperUp),
  };
  const maxOther = Math.max(...Object.values(raw));
  raw.neutral = clamp01(1 - 2 * maxOther);
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const preds = LABELS.map(label => ({ label, score: raw[label] / sum }))
                      .sort((a, b) => b.score - a.score);
  const valence = Math.max(-1, Math.min(1, smile - frown - 0.5 * browDown - 0.5 * noseSneer));
  const arousal = clamp01(0.4 * jawOpen + 0.3 * eyeWide + 0.2 * browInnerUp + 0.1 * browDown);
  // `smile` is returned raw: it is what drives happy, and watching it next to
  // the resulting scores tells a weak signal apart from a crushed one.
  return { preds, valence, arousal, smile };
}
