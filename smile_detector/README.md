# smile_detector

The evolution of the version at the repo root, kept separate so that one stays
as it was. What is new here: a stopwatch of the time spent with a positive
emotion, and an adaptive zoom that recovers faces past ~1.8 m, where the
detector otherwise loses them entirely.


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
js/positive_timer.js PositiveTimer: stopwatch of the time spent smiling
js/zoom.js          ZoomTracker: adaptive crop for detection at a distance
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

Keys: `h` panel, `o` overlay, `m` mirror, `f` fullscreen, `r` reset rect,
`t` reset stopwatch.

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
- **Positive time**: a stopwatch, top centre of the canvas, of the cumulative
  time spent with a positive emotion. It runs while the current label is
  `happy`, stops otherwise, and picks up from the previous total when the smile
  comes back. Green with a dot while running, dimmed grey while stopped, so the
  state reads at a glance. It accrues by elapsed time rather than by frame
  count, and a single step is capped at 0.5 s: with the tab in the background
  `requestAnimationFrame` stops, and without the cap the first frame back would
  credit the whole pause. It is an indicator, not debug, so the `o` overlay
  toggle does not hide it; `t` resets it. Since it reads the smoothed label, it
  is inactive with emotion set to *off*.
- **Distance**: the detector bundled in `face_landmarker.task` is BlazeFace
  short-range, which resizes the whole frame to about 128 px before looking at
  it. What decides detection is the *fraction* of the frame the face covers,
  not its pixel count, so raising the capture resolution changes nothing and
  past roughly 1.8-2 m the face is simply gone. `ZoomTracker` crops instead:
  full frame while the face is visible, a centre crop when it is lost
  (alternating back to full, so a far face at the centre and a near one at the
  edge are both reachable), then a crop that follows the face once found. The
  crop is drawn at its native pixel size - the detector resizes its input
  anyway, so enlarging it would add no information. Cost is one `drawImage`:
  detection runs *on* the crop, not in addition to the full frame, so it stays
  one inference per frame. The crop is a single scale of the frame, which keeps
  the aspect ratio by construction; a stretched crop would skew every landmark.
  Hands keep using the full frame. The dashed yellow rectangle in the overlay
  is the region being fed to the detector.
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
  const s = e.detail;   // {fps, face, box, emotion, probs, valence, arousal,
                      //  blink, positiveTime, hands, palms, rect}
});
```
This is the hook for a p5.js sketch, a WebGL canvas or any other
visualization: perception stays here, rendering can live elsewhere.

## Tests
```bash
npm test
```
44 tests over the pure logic (blink, hands, smoother, expressions, positive
timer, zoom), no
models required.
