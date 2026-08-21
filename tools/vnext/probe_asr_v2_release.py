#!/usr/bin/env python3
"""Probe a staged LaoJi ASR server with a fake model and real HTTP handlers.

This loads the exact release file in the target Python environment without
loading Qwen or binding a fixed port. It verifies that legacy, v1 and v2 routes
can coexist before an operator schedules the real 8030 process replacement.
"""

from __future__ import annotations

import argparse
import base64
from http.client import HTTPConnection
import importlib.util
import json
from pathlib import Path
import struct
import sys
import threading
from types import ModuleType
from typing import Any


def _load(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("laoji_asr_release_probe", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("asr_release_import_spec_unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(spec.name, None)
        raise
    return module


def _request(
    port: int,
    method: str,
    path: str,
    payload: dict[str, Any] | bytes | None = None,
) -> tuple[int, dict[str, Any]]:
    if isinstance(payload, dict):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {"Content-Type": "application/json"}
    else:
        body = payload
        headers = {"Content-Type": "application/octet-stream"}
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        parsed = json.loads(raw.decode("utf-8"))
        if not isinstance(parsed, dict):
            raise RuntimeError("asr_probe_response_not_object")
        return response.status, parsed
    finally:
        connection.close()


def probe(path: Path) -> dict[str, Any]:
    module = _load(path.resolve())

    class Result:
        text = "probe"
        language = "Chinese"

    class Model:
        def transcribe(self, *, audio, language):
            del language
            return [Result() for _ in audio]

    module.MODEL = Model()
    module.MODEL_ID = "release-probe-model"
    module.MODEL_REVISION = "release-probe-revision"
    coordinator = module.InferenceCoordinator(lambda: module.MODEL)
    module.COORDINATOR = coordinator
    httpd = module.ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        speech = struct.pack("<" + "h" * 320, *([4_096] * 320))
        encoded_speech = base64.b64encode(speech).decode("ascii")
        encoded_silence = base64.b64encode(bytes(len(speech))).decode("ascii")
        common_item = {
            "id": "release-probe-item",
            "pcm_base64": encoded_speech,
            "sample_rate": 16_000,
            "source_start_ms": 100,
            "source_end_ms": 120,
        }

        ready_status, ready = _request(httpd.server_port, "GET", "/ready")
        legacy_status, legacy = _request(
            httpd.server_port,
            "POST",
            "/asr?priority=realtime&language=Chinese",
            speech,
        )
        v1_status, v1 = _request(
            httpd.server_port,
            "POST",
            "/v1/asr/batch",
            {"priority": "offline", "items": [common_item]},
        )
        v2_status, v2 = _request(
            httpd.server_port,
            "POST",
            "/v2/asr/batch",
            {
                "schema_version": 2,
                "contract_revision": "asr.batch.v2",
                "priority": "offline",
                "items": [common_item],
            },
        )
        silence_item = dict(common_item)
        silence_item["id"] = "release-probe-silence"
        silence_item["pcm_base64"] = encoded_silence
        silence_status, silence = _request(
            httpd.server_port,
            "POST",
            "/v2/asr/batch",
            {
                "schema_version": 2,
                "contract_revision": "asr.batch.v2",
                "priority": "offline",
                "items": [silence_item],
            },
        )
        invalid_status, invalid = _request(
            httpd.server_port,
            "POST",
            "/v2/asr/batch",
            {},
        )

        gates = {
            "ready": ready_status == 200 and ready.get("ready") is True,
            "legacy_asr": legacy_status == 200 and legacy.get("text") == "probe",
            "v1_compat": (
                v1_status == 200
                and v1.get("items", [{}])[0].get("text") == "probe"
                and "contract_revision" not in v1
            ),
            "v2_contract": (
                v2_status == 200
                and v2.get("schema_version") == 2
                and v2.get("contract_revision") == "asr.batch.v2"
                and v2.get("items", [{}])[0].get("stable_segment_key")
                == "release-probe-item"
                and v2.get("items", [{}])[0].get("outcome") == "text"
            ),
            "v2_no_speech": (
                silence_status == 200
                and silence.get("items", [{}])[0].get("outcome") == "no_speech"
                and silence.get("items", [{}])[0].get("text") == ""
            ),
            "v2_fail_closed": (
                invalid_status == 422
                and invalid.get("code") == "contract_revision_invalid"
            ),
        }
        return {
            "schema_version": 1,
            "candidate_only": True,
            "model_loaded": False,
            "fixed_port_bound": False,
            "gates": gates,
            "passed": all(gates.values()),
        }
    finally:
        httpd.shutdown()
        thread.join(timeout=5)
        httpd.server_close()
        coordinator.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("server", type=Path)
    args = parser.parse_args()
    report = probe(args.server)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
