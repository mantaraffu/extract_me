#!/usr/bin/env python3
"""Static server for emotionscript with Cache-Control: no-store, so the
browser always reloads the current JS files instead of stale cached copies."""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"open http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
