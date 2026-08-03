#!/usr/bin/env python3
"""Small HTTP candidate exposing the active deterministic parser.

This is a local contract harness, not a replacement for the deployed FastAPI
service.  It disables the model call so a parser candidate can be audited over
the full authored corpus without loading another Ollama instance.
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[4] / "LaoJi" / "server-staging" / "qwen35-9b-cutover" / "smart-meeting-ai" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services import schedule_parser_service as parser  # noqa: E402


def no_model(*_args, **_kwargs):
    raise RuntimeError("model disabled in deterministic HTTP candidate")


parser.call_ollama = no_model


class Handler(BaseHTTPRequestHandler):
    server_version = "LaoJiDeterministicCandidate/1"

    def log_message(self, *_args):
        return

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "service": "laoji-deterministic-candidate"})
        else:
            self.send_json(404, {"code": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/api/laoji/parse":
            self.send_json(404, {"code": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            text = str(payload.get("text") or "")
            result = parser.parse_schedule_text_sync(
                text,
                reference_datetime=payload.get("reference_datetime"),
                timezone_name=payload.get("timezone"),
            )
            if result is None:
                self.send_json(400, {"code": "not_schedule", "message": "这段内容不是日程安排"})
                return
            self.send_json(200, result)
        except Exception as exc:  # pragma: no cover - harness diagnostics
            self.send_json(500, {"code": "parser_unavailable", "message": str(exc)[:300]})


def main() -> int:
    cli = argparse.ArgumentParser()
    cli.add_argument("--host", default="127.0.0.1")
    cli.add_argument("--port", type=int, default=18036)
    args = cli.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(json.dumps({"host": args.host, "port": args.port, "status": "ready"}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
