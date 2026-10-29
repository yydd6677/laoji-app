"""Privacy-safe operational logging helpers.

User-owned meeting text, names, filenames and opaque entity identifiers must
never be interpolated into runtime logs.  This module deliberately exposes a
small allow-list of bounded operational fields so new code cannot accidentally
turn an identifier into a log correlation key.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import Any


_ALLOWED_FIELDS = frozenset({
    "capability",
    "traffic_class",
    "revision",
    "bytes",
    "hash_prefix",
    "stage",
    "duration_ms",
    "error_type",
    "status",
    "count",
    "queue_depth",
    "purpose",
    "model_revision",
    "prompt_revision",
    "reason_code",
    "retry",
    "attempt",
    "kind",
    "segments",
    "duration_sec",
    "audio_ms",
    "queue_ms",
    "infer_ms",
    "wall_ms",
    "batch_ordinal",
    "first_batch",
    "items",
})

_UVICORN_PROTOCOL_PATH_RE = re.compile(
    r"(?:WebSocket|(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD))\s+/api/"
)


class UvicornProtocolPrivacyFilter(logging.Filter):
    """Drop protocol diagnostics that contain a raw API path.

    Uvicorn emits WebSocket acceptance lines through ``uvicorn.error`` rather
    than ``uvicorn.access``.  Disabling the access logger therefore does not
    prevent a realtime session identifier from appearing in the process log.
    LaoJi already emits bounded request/stage telemetry, so these path-bearing
    protocol lines are redundant and are rejected rather than redacted.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return _UVICORN_PROTOCOL_PATH_RE.search(record.getMessage()) is None


def install_uvicorn_protocol_privacy_filter() -> None:
    """Install the path filter once on Uvicorn's protocol logger."""
    logger = logging.getLogger("uvicorn.error")
    if any(isinstance(item, UvicornProtocolPrivacyFilter) for item in logger.filters):
        return
    logger.addFilter(UvicornProtocolPrivacyFilter())


def digest_prefix(value: object, length: int = 12) -> str:
    """Return a bounded, non-reversible correlation value for diagnostics."""
    raw = str(value).encode("utf-8", "replace")
    return hashlib.sha256(raw).hexdigest()[: max(8, min(32, int(length)))]


def privacy_log(event: str, **fields: Any) -> None:
    """Emit a JSON event containing operational metadata only.

    Unknown fields raise in development and are dropped in production callers
    that catch the exception.  Raising here is intentional: it makes a future
    privacy regression visible during service startup/tests instead of
    silently accepting a meeting ID or user text.
    """
    unknown = set(fields) - _ALLOWED_FIELDS
    if unknown:
        raise ValueError("privacy_log_field_not_allowed")
    payload: dict[str, Any] = {
        "event": str(event)[:80],
        "ts_ms": int(time.time() * 1000),
    }
    for key, value in fields.items():
        if value is None:
            continue
        if key in {
            "bytes",
            "count",
            "queue_depth",
            "retry",
            "attempt",
            "segments",
            "audio_ms",
            "queue_ms",
            "infer_ms",
            "wall_ms",
            "batch_ordinal",
            "items",
        }:
            payload[key] = max(0, int(value))
        elif key == "first_batch":
            payload[key] = bool(value)
        elif key in {"duration_ms", "duration_sec"}:
            payload[key] = round(max(0.0, float(value)), 3)
        else:
            payload[key] = str(value)[:120]
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), flush=True)
