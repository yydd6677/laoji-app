#!/usr/bin/env python3
"""Small HTTP candidate exposing the active deterministic parser.

This is a local contract harness, not a replacement for the deployed FastAPI
service.  It disables the model call so a parser candidate can be audited over
the full authored corpus without loading another Ollama instance.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BACKEND = Path(__file__).resolve().parents[4] / "LaoJi" / "server-staging" / "qwen35-9b-cutover" / "smart-meeting-ai" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services import schedule_parser_service as parser  # noqa: E402


_REQUEST_STATE = threading.local()


def no_model(*_args, **_kwargs):
    _REQUEST_STATE.model_attempted = True
    raise RuntimeError("model disabled in deterministic HTTP candidate")


if os.getenv("LAOJI_CANDIDATE_DISABLE_MODEL", "").strip().lower() in {"1", "true", "yes", "on"}:
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
            started = time.perf_counter()
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            raw_body = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
            request_sha256 = hashlib.sha256(raw_body).hexdigest()
            text = str(payload.get("text") or "")
            request_id = hashlib.sha256(
                json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()[:24]
            _REQUEST_STATE.model_attempted = False
            _REQUEST_STATE.model_success = False
            result = parser.parse_schedule_text_sync(
                text,
                reference_datetime=payload.get("reference_datetime"),
                timezone_name=payload.get("timezone"),
            )
            if result is None:
                self.send_json(
                    400,
                    {
                        "code": "not_schedule",
                        "message": "这段内容不是日程安排",
                        "route": "reject",
                        "model_attempted": False,
                        "model_success": False,
                        "fallback_used": False,
                        "parse_source": "rules",
                        "model_id": "qwen3.5:9b",
                        "request_id": request_id,
                        "request_sha256": request_sha256,
                        "parse_latency_ms": round((time.perf_counter() - started) * 1000, 3),
                    },
                )
                return
            model_attempted = bool(result.get("model_attempted", getattr(_REQUEST_STATE, "model_attempted", False)))
            model_success = bool(result.get("model_success", getattr(_REQUEST_STATE, "model_success", False)))
            route = str(result.get("route") or ("model" if model_success else ("fallback" if model_attempted else "quick")))
            result = dict(result)
            result.update(
                {
                    "route": route,
                    "model_attempted": model_attempted,
                    "model_success": model_success,
                    "fallback_used": model_attempted and not model_success,
                    "model_id": result.get("model_id") or "qwen3.5:9b",
                    "request_id": result.get("request_id") or request_id,
                    "request_sha256": request_sha256,
                    "parse_latency_ms": result.get("parse_latency_ms")
                    or round((time.perf_counter() - started) * 1000, 3),
                }
            )
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
