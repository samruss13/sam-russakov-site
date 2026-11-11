"""Local dev server for the site: like `python -m http.server`, but tells the
browser not to cache, so edits show up on a normal reload."""
import http.server, functools, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("", PORT), functools.partial(NoCache, directory=ROOT)).serve_forever()
