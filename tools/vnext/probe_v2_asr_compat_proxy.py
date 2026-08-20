#!/usr/bin/env python3
"""Loopback-only probe bridge from the v2 contract to an existing v1 ASR.

This is evidence tooling, not a production dependency.  It permits an
isolated vNext API/database to exercise the already-resident GPU model without
restarting or replacing the production 8030 process.  The bridge logs no
audio, text, identifiers, or responses and binds only to 127.0.0.1.
"""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import error as urllib_error
from urllib import request
from urllib.parse import urlparse


UPSTREAM_READY = "http://127.0.0.1:8030/ready"
UPSTREAM_BATCH = "http://127.0.0.1:8030/v1/asr/batch"
MAX_REQUEST_BYTES = max(
    1024 * 1024,
    int(os.getenv("LAOJI_VNEXT_ASR_PROBE_MAX_REQUEST_BYTES", str(96 * 1024 * 1024))),
)
OPENER = request.build_opener(request.ProxyHandler({}))


def _fetch_json(url: str, *, body: bytes | None = None) -> tuple[int, dict]:
    upstream = request.Request(
        url,
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with OPENER.open(upstream, timeout=900) as response:
            return int(response.status), json.load(response)
    except urllib_error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {"code": "upstream_error", "error": "语音服务暂时不可用"}
        return int(error.code), payload


def _v1_request(raw: bytes) -> bytes:
    payload = json.loads(raw.decode("utf-8"))
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != 2
        or payload.get("contract_revision") != "asr.batch.v2"
        or set(payload) != {"schema_version", "contract_revision", "priority", "items"}
        or not isinstance(payload.get("items"), list)
    ):
        raise ValueError("contract_invalid")
    return json.dumps(
        {"priority": payload["priority"], "items": payload["items"]},
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _v2_response(payload: dict) -> dict:
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError("upstream_response_invalid")
    converted = []
    for item in items:
        if not isinstance(item, dict) or not str(item.get("id") or ""):
            raise ValueError("upstream_response_invalid")
        text = str(item.get("text") or "").strip()
        converted.append({
            **item,
            "stable_segment_key": str(item["id"]),
            "segment_revision": 1,
            "text_state": "stable",
            "outcome": "text" if text else "no_speech",
            "text": text,
        })
    return {
        **payload,
        "schema_version": 2,
        "contract_revision": "asr.batch.v2",
        "items": converted,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "LaoJiV2AsrProbeBridge/1.0"

    def _json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if urlparse(self.path).path != "/ready":
            self.send_error(404)
            return
        try:
            status, payload = _fetch_json(UPSTREAM_READY)
        except Exception:
            self._json({"ready": False, "status": "not_ready"}, 503)
            return
        self._json(payload, status)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/v2/asr/batch":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > MAX_REQUEST_BYTES:
                self._json({"code": "request_too_large", "error": "转写请求过大"}, 413)
                return
            upstream_body = _v1_request(self.rfile.read(length))
            status, payload = _fetch_json(UPSTREAM_BATCH, body=upstream_body)
            if not 200 <= status < 300:
                self._json(payload, status)
                return
            self._json(_v2_response(payload))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._json({"code": "contract_invalid", "error": "转写请求格式无效"}, 422)
        except Exception:
            self._json({"code": "upstream_unavailable", "error": "语音服务暂时不可用"}, 503)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    port = int(os.getenv("LAOJI_VNEXT_ASR_PROBE_PORT", "8032"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"v2 ASR probe bridge listening on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
