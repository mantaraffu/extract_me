#!/usr/bin/env python3
"""Static server for smile_detector.

- `Cache-Control: no-store`, so the browser always reloads the current JS
  files instead of stale cached copies.
- `POST /save?name=smile_session_....json` writes the request body to the
  Desktop (or to $SMILE_SAVE_DIR when set): the page cannot write files on
  its own, so this is how the session JSON lands there when the app closes.
  Only names of the form smile_session_<...>.json are accepted, and the file
  is overwritten on each save, so a session keeps updating a single file.
"""
import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

SAVE_NAME = re.compile(r"^smile_session_[A-Za-z0-9_-]+\.json$")
WRITE_LOCK = threading.Lock()   # an autosave and the closing beacon must not interleave


def save_dir():
    return os.environ.get("SMILE_SAVE_DIR") or os.path.expanduser("~/Desktop")


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/save":
            self.send_error(404)
            return
        name = parse_qs(url.query).get("name", [""])[0]
        if not SAVE_NAME.match(name):
            self.send_error(400, "bad file name")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            json.loads(body)  # only well-formed JSON gets written
        except ValueError:
            self.send_error(400, "body is not JSON")
            return
        target = os.path.join(save_dir(), name)
        os.makedirs(save_dir(), exist_ok=True)
        with WRITE_LOCK, open(target, "wb") as f:
            f.write(body)
        print(f"saved {target}", flush=True)
        out = json.dumps({"path": target}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"open http://localhost:{port}  (session files go to {save_dir()})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
