"""Privacy-safe operational logging helpers.

User-owned meeting text, names, filenames and opaque entity identifiers must
never be interpolated into runtime logs.  This module deliberately exposes a
small allow-list of bounded operational fields so new code cannot accidentally
turn an identifier into a log correlation key.
"""

from __future__ import annotations

import hashlib
import json
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


def digest_prefix(value: object, length: int = 12) -> str:
    """Return a bounded, non-reversible correlation value for diagnostics."""
    raw = str(value).encode("utf-8", "replace")
    return hashlib.sha256(raw).hexdigest()[: max(8, min(32, int(length)))]


def privacy_log(event: str, **fields: Any) -> None:
    """Emit a JSON event containing operational metadata only.

    Unknown fields raise in development and are dropped in production callers
    that catch the exception.  Raising here is intentional: it makes a future
    privacy regression visible during candidate startup/tests instead of
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
