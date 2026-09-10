# vendor/

Everything the voice entry point (`index_voice.html`) needs offline. Nothing
here is committed: these are third-party blobs, and the point of Vosk in this
project is that no audio and no request leaves the machine.

Two files, both fetched once by hand:

- **`vosk-browser.js`** — the WASM build of vosk-browser, plus the `.wasm` and
  worker files it loads next to itself. Take them from the published package
  and drop the whole set in here.
- **`vosk-model-small-en-us-0.15.tar.gz`** — the ~40 MB English model, from the
  Vosk model list. The archive is loaded as-is, do not unpack it.

Both paths are fields in the panel, so a different model or a different build
is a matter of typing the new path, not of editing the code.
