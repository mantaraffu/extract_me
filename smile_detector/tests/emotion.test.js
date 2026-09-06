import { test } from "node:test";
import assert from "node:assert/strict";
import { EmotionSmoother } from "../js/smoother.js";
import { expressionsFromBlendshapes, LABELS } from "../js/expressions.js";

const preds = o => Object.entries(o).map(([label, score]) => ({ label, score }));

test("smoother: first frame sets the label and sorts", () => {
  const s = new EmotionSmoother();
  const out = s.update(preds({ a: 0.2, b: 0.5, c: 0.3 }));
  assert.deepEqual(out.map(o => o.label), ["b", "c", "a"]);
});

test("smoother: a single spike does not flip the label", () => {
  const s = new EmotionSmoother({ alpha: 0.3, margin: 0.1 });
  for (let i = 0; i < 5; i++) s.update(preds({ happy: 0.8, sad: 0.2 }));
  assert.equal(s.update(preds({ happy: 0.3, sad: 0.7 }))[0].label, "happy");
});

test("smoother: a sustained change flips the label", () => {
  const s = new EmotionSmoother({ alpha: 0.3, margin: 0.1 });
  for (let i = 0; i < 5; i++) s.update(preds({ happy: 0.8, sad: 0.2 }));
  let out;
  for (let i = 0; i < 10; i++) out = s.update(preds({ happy: 0.1, sad: 0.9 }));
  assert.equal(out[0].label, "sad");
});

test("blendshape: resting face -> neutral", () => {
  const { preds, valence, arousal } = expressionsFromBlendshapes({});
  assert.equal(preds[0].label, "neutral");
  assert.equal(preds.length, LABELS.length);
  assert.equal(valence, 0);
  assert.equal(arousal, 0);
});

test("blendshape: smile -> happy, positive valence", () => {
  const { preds, valence } = expressionsFromBlendshapes({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8 });
  assert.equal(preds[0].label, "happy");
  assert.ok(valence > 0.5);
});

test("blendshape: open mouth + brows up -> surprise, high arousal", () => {
  const { preds, arousal } = expressionsFromBlendshapes({ jawOpen: 0.9, browInnerUp: 0.8, eyeWideLeft: 0.7, eyeWideRight: 0.7 });
  assert.equal(preds[0].label, "surprise");
  assert.ok(arousal > 0.6);
});

test("blendshape: normalized distribution", () => {
  const { preds } = expressionsFromBlendshapes({ browDownLeft: 0.9, browDownRight: 0.9 });
  const sum = preds.reduce((a, p) => a + p.score, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(preds[0].label, "angry");
});
