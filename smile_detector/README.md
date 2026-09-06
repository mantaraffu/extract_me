# extract_me

Face, emotion, blink and hand tracking entirely in the browser. No Python,
no virtualenv, no multi-gigabyte downloads: one HTML page, MediaPipe Tasks
Vision and, optionally, transformers.js for a ViT emotion classifier.

```
index.html          page: full-screen canvas + control panel
js/app.js           loop: source -> Vision -> logic -> Canvas -> published state
js/vision.js        MediaPipe FaceLandmarker + HandLandmarker wrapper (CDN)
js/emotion_vit.js   ViT emotion via transformers.js (loaded only when selected)
js/blink.js         BlinkCounter: blendshape or EAR, time-based counting
js/hands.js         HandsTracker: two-palm rectangle, smoothing, hold, reset
js/smoother.js      EmotionSmoother: EMA + hysteresis on the label
js/expressions.js   blendshapes -> 7 emotions + valence/arousal (heuristic)
serve.py            static server with caching disabled
tests/              Node tests for the pure logic (npm test)
```

## Run
```bash
./serve.sh            # or: npm run serve
# open http://localhost:8000
```
A local server is required because `getUserMedia` only works over http(s)
or localhost. On first load the browser downloads the MediaPipe models
(about 10 MB) and caches them. Recent Chrome or Edge recommended; Safari and
Firefox work without WebGPU.

Sources other than the webcam:
- drag a video or an image onto the page, or pick "file..." in the menu;
- `http://localhost:8000/?image=test.jpg` loads an image from the folder
  (handy for testing without a camera; `test.jpg` is git-ignored).

Keys: `h` panel, `o` overlay, `m` mirror, `f` fullscreen, `r` reset rect.

## What it does
- **Face**: FaceLandmarker (478 points + 52 blendshapes) in VIDEO mode with
  tracking. The largest face, i.e. the closest, is used.
- **Blink**: by default from the `eyeBlinkLeft/Right` blendshapes, threshold
  0.5, no calibration needed. Alternatively EAR on the landmarks, threshold
  0.21. Counting is time-based (a closure between 40 and 700 ms), so it also
  works at low frame rates.
- **Emotion**, three options in the panel:
  - *blendshape*: a heuristic over the 52 coefficients, zero cost, also
    yields continuous valence (-1..1) and arousal (0..1). The rules live in
    `expressions.js` and are meant to be edited.
  - *ViT*: `Xenova/facial_emotions_image_detection`, the ONNX export of
    `dima806/facial_emotions_image_detection` (7 classes). fp32 on WebGPU
    (~350 MB, downloaded once and cached) or q8 on WASM (~90 MB). Runs every
    N frames asynchronously, so rendering never stalls. `?device=wasm` forces
    the WASM path. Note: fp16 on WebGPU produces near-uniform probabilities
    with this model, hence fp32.
  - *off*.
  In both cases probabilities are smoothed and the label only changes with a
  margin, so it does not flicker.
- **Hands**: HandLandmarker, hands keyed by handedness, smoothed palms. With
  no hands in view the video is shown in full; when two hands are visible the
  screen goes black and the video appears only inside the rectangle whose
  opposite corners are the two palms. It returns to full video when a hand
  leaves (0.4 s tolerance to dropped frames, so no flicker). Minimum
  rectangle height is 1.2 times the hand size seen in the video. Options:
  *lock the rect on appearance* (it stops following the hands until they
  leave), *periodic reset* every N seconds, `r` for a manual reset.

## Per-frame state for the outside world
Every frame the page writes `window.emotionState` and dispatches the
`emotionscript` event with the same object:
```js
window.addEventListener("emotionscript", e => {
  const s = e.detail;   // {fps, face, box, emotion, probs, valence, arousal, blink, hands, palms, rect}
});
```
This is the hook for a p5.js sketch, a WebGL canvas or any other
visualization: perception stays here, rendering can live elsewhere.

## Tests
```bash
npm test
```
23 tests over the pure logic (blink, hands, smoother, expressions), no
models required.
