#!/usr/bin/env python3
"""
PayPhone preview server (sandbox-only shim).

The production artifact is the Next.js standalone server (`bun run start`).
Inside the z.ai sandbox, long-lived node processes get reaped, so this tiny
stdlib-only server serves the prerendered Next.js output and proxies /api to
the Rust engine — same contract, same headers, byte-exact bodies.

Usage:  python3 scripts/preview_server.py   (env: PORT=3000, ENGINE_URL, WEB_DIST)
"""

import json
import mimetypes
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "3000"))
ENGINE_URL = os.environ.get("PAYPHONE_ENGINE_URL", "http://127.0.0.1:8080")
ORACLE_URL = os.environ.get("PAYPHONE_ORACLE_URL", "http://127.0.0.1:8001")

# Standalone output layout (produced by `next build` with output: "standalone")
STANDALONE = Path(__file__).resolve().parent.parent / ".next" / "standalone"
STATIC_DIR = STANDALONE / ".next" / "static"
SERVER_APP = STANDALONE / ".next" / "server" / "app"
PUBLIC_DIR = STANDALONE / "public"

HOP_BY_HOP = {
    "connection", "keep-alive", "transfer-encoding", "upgrade",
    "proxy-authenticate", "proxy-authorization", "te", "trailer", "host",
    "content-length",
}


def content_type_for(path: str) -> str:
    ctype, _ = mimetypes.guess_type(path)
    if path.endswith(".js"):
        return "application/javascript; charset=utf-8"
    if path.endswith(".css"):
        return "text/css; charset=utf-8"
    if path.endswith(".html"):
        return "text/html; charset=utf-8"
    return ctype or "application/octet-stream"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- helpers --

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, status: int, body: bytes, ctype: str = "application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, path: Path) -> bool:
        if path.is_file():
            body = path.read_bytes()
            self._send(200, body, content_type_for(str(path)))
            return True
        return False

    # -------------------------------------------------------------- routes --

    def do_GET(self):
        path, _, query = self.path.partition("?")

        # API proxy (engine + health)
        if path.startswith("/api/"):
            self._proxy_api()
            return

        # Next.js static assets
        if path.startswith("/_next/static/"):
            rel = path.removeprefix("/_next/static/")
            if self._serve_file(STATIC_DIR / rel):
                return
            self._send(404, b'{"error":"not found"}')
            return

        if path == "/logo.svg" or path == "/robots.txt":
            if self._serve_file(PUBLIC_DIR / path.lstrip("/")):
                return

        # Prerendered app shell for every page route (single-route app)
        index = SERVER_APP / "index.html"
        if index.is_file():
            body = index.read_bytes()
            self._send(200, body, "text/html; charset=utf-8")
            return

        self._send(404, '{"error":"no prerendered output — run: bunx next build"}'.encode("utf-8"))

    do_HEAD = do_GET

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy_api()
            return
        self._send(404, b'{"error":"not found"}')

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST

    # ---------------------------------------------------------- api proxy --

    def _proxy_api(self):
        path, _, query = self.path.partition("?")

        # Stack health: probe engine + oracle, same contract as the Next route.
        if path == "/api/health":
            self._stack_health()
            return

        # /api/v1/* → engine /v1/* ; /api/health → engine /health
        if path.startswith("/api/v1/"):
            engine_path = path[len("/api"):]
        elif path == "/api/v1":
            engine_path = "/v1"
        else:
            engine_path = path[len("/api"):] if path.startswith("/api") else path
        target = f"{ENGINE_URL}{engine_path}"
        if query:
            target += f"?{query}"

        headers = {}
        for key, value in self.headers.items():
            if key.lower() not in HOP_BY_HOP:
                headers[key] = value
        # Preserve the public origin for payment-link construction.
        headers["x-forwarded-host"] = self.headers.get("Host", f"localhost:{PORT}")
        headers["x-forwarded-proto"] = "https" if os.environ.get("PP_HTTPS") else "http"

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        try:
            req = urllib.request.Request(target, data=body, method=self.command, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                self._relay(resp)
        except urllib.error.HTTPError as e:
            self._relay(e)
        except Exception as e:
            self._send(503, json.dumps({
                "error": {
                    "type": "engine_offline",
                    "message": f"PayPhone Engine unreachable ({e}). Start: ./scripts/supervise.sh",
                    "code": 503,
                }
            }).encode())

    def _stack_health(self):
        def probe(url):
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    return r.status == 200
            except Exception:
                return False

        payload = json.dumps({
            "web": True,
            "engine": probe(f"{ENGINE_URL}/health"),
            "oracle": probe(f"{ORACLE_URL}/health"),
        }).encode()
        self._send(200, payload)

    def _relay(self, resp):
        payload = resp.read()
        self.send_response(resp.status)
        ctype = resp.headers.get("Content-Type", "application/json")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    print(f"PayPhone preview: :{PORT} -> engine {ENGINE_URL} (dist: {STANDALONE})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
