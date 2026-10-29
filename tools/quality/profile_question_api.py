"""Isolated real Q2 HTTP profiler; never starts production background workers.

The runtime configuration is read privately, the control database is backed up
read-only, and every write goes to that new copy. Timings contain no bodies,
headers, device IDs or source IDs. Models/providers and auth remain real.
"""
from __future__ import annotations

import argparse
from contextvars import ContextVar
from functools import wraps
import json
import importlib.util
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time

_TRACE: ContextVar[dict | None] = ContextVar("question_profile", default=None)


def instrument(owner, name):
    original = getattr(owner, name)

    @wraps(original)
    def measured(*args, **kwargs):
        trace = _TRACE.get()
        started = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            if trace is not None:
                with trace["lock"]:
                    trace["events"].append({"phase": f"{owner.__name__.rsplit('.', 1)[-1]}.{name}",
                        "start_ms": round((started - trace["started"]) * 1000, 3),
                        "wall_ms": round((time.perf_counter() - started) * 1000, 3)})
    setattr(owner, name, measured)
    return original


def main(args):
    for row in Path(f"/proc/{args.runtime_pid}/environ").read_bytes().split(b"\0"):
        key, sep, value = row.partition(b"=")
        if sep:
            os.environ[key.decode()] = value.decode()
    from app.config import settings
    from sqlalchemy.engine import make_url
    url = make_url(settings.DATABASE_URL)
    if not url.drivername.startswith("sqlite") or not url.database:
        raise RuntimeError("sqlite_control_store_required")
    source, target = Path(url.database).resolve(), args.database_copy.resolve()
    if source == target or target.exists():
        raise RuntimeError("new_isolated_database_required")
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as live:
        with sqlite3.connect(target) as isolated:
            live.backup(isolated)
    target.chmod(0o600)
    settings.DATABASE_URL = f"sqlite+aiosqlite:///{target}"
    os.environ["DATABASE_URL"] = settings.DATABASE_URL
    settings.R2_ENABLED = False
    os.environ["R2_ENABLED"] = "false"

    if args.module_dir:
        import app.services
        app.services.__path__.insert(0, str(args.module_dir.resolve()))
    if args.api_module:
        import app.api
        spec = importlib.util.spec_from_file_location('app.api.device_v2', args.api_module)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        setattr(app.api, 'device_v2', module)
        spec.loader.exec_module(module)
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from app.api import device_v2
    from app.services import (device_identity, device_v2_identity, question_inline_sources,
        vnext_question_reader, vnext_source_stream_store, vnext_task_store,
        question_evidence_verifier, llm_provider)
    assert device_identity._database_path() == target
    for owner, names in (
        (device_v2_identity, ["authenticate_bearer"]),
        (vnext_task_store, ["get_binding", "get_task", "claim_attempt"]),
        (question_inline_sources, ["prepare"]),
        (vnext_source_stream_store, ["ensure_vnext_source_stream_schema", "purge_expired_source_streams",
            "create_source_stream", "append_manifest_page", "create_bundle_group", "append_bundle",
            "commit_bundle_group", "load_question_source_stream", "commit_question_result"]),
        (vnext_question_reader, ["read_q2", "_select_model_sources", "pack_sources", "call_llm"]),
        (question_evidence_verifier, ["call_llm"]),
    ):
        for name in names:
            instrument(owner, name)
    app = FastAPI()
    app.include_router(device_v2.router, prefix="/api")
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    report_lock = threading.Lock()

    @app.middleware("http")
    async def profile(request: Request, call_next):
        if request.url.path == "/profile-ready":
            return JSONResponse({"ready": True, "isolated": True})
        allowed = (request.method == "GET" and re.fullmatch(r"/api/device/v2/meetings/[^/]+", request.url.path)
            or request.method == "POST" and re.fullmatch(r"/api/device/v2/meetings/[^/]+/questions-v2", request.url.path))
        if not allowed:
            return JSONResponse({"code": "profile_route_not_allowed"}, status_code=404)
        trace = {"started": time.perf_counter(), "events": [], "lock": threading.Lock()}
        token = _TRACE.set(trace)
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            return response
        finally:
            _TRACE.reset(token)
            result = {"boundary": "isolated HTTP, copied database, real auth and provider",
                "method": request.method, "status": status,
                "wall_ms": round((time.perf_counter() - trace["started"]) * 1000, 3),
                "events": trace["events"], "inference": llm_provider.provider_state(probe=False)["inference"]}
            with report_lock:
                # Open privately before writing even when the parent umask is permissive.
                fd = os.open(args.output, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                with os.fdopen(fd, "a") as report:
                    report.write(json.dumps(result, ensure_ascii=False) + "\n")
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-pid", type=int, required=True)
    parser.add_argument("--database-copy", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--port", type=int, default=18023)
    parser.add_argument("--module-dir", type=Path)
    parser.add_argument("--api-module", type=Path)
    main(parser.parse_args())
