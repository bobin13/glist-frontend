"""Local dev server for the frontend: serves src/html on http://localhost:8000.

Like `python3 -m http.server`, but tells the browser not to cache anything, so edits to
HTML/CSS/JS always show up on a normal refresh (no stale files in regular tabs).

    python3 dev-server.py          # port 8000
    python3 dev-server.py 8080     # another port
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent / "src" / "html"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=str(ROOT))
with http.server.ThreadingHTTPServer(("localhost", PORT), handler) as server:
    print(f"Serving {ROOT} at http://localhost:{PORT} (no caching)")
    server.serve_forever()
