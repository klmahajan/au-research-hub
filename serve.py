"""Minimal static server for local dev (v3 needs HTTP for fetch/CORS).
Serves this script's own directory, avoiding os.getcwd() at import time
(the preview launcher starts with an unreadable cwd on macOS)."""
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(sys.argv[0]))
os.chdir(ROOT)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4400


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always fresh JSON during dev
        super().end_headers()


if __name__ == "__main__":
    print(f"Serving {ROOT} at http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
