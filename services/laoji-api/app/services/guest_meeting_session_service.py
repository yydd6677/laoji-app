from __future__ import annotations

import hashlib
import hmac
import secrets
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone


GUEST_SESSION_TTL_SECONDS = 2 * 60 * 60
MAX_ACTIVE_GUEST_SESSIONS = 4096
GUEST_MEETING_PREFIX = "guest-session-"


class GuestSessionCapacityError(RuntimeError):
    pass


@dataclass(frozen=True)
class GuestMeetingSession:
    meeting_id: str
    token: str
    expires_at: str


@dataclass(frozen=True)
class _StoredGuestMeetingSession:
    token_digest: bytes
    expires_at: float


_sessions: dict[str, _StoredGuestMeetingSession] = {}
_transcripts: dict[str, list[dict[str, object]]] = {}
_lock = threading.RLock()


def create_guest_meeting_session(
    *,
    ttl_seconds: int = GUEST_SESSION_TTL_SECONDS,
) -> GuestMeetingSession:
    now = _now()
    expires_at = now + max(1, int(ttl_seconds))
    token = secrets.token_urlsafe(32)
    meeting_id = f"{GUEST_MEETING_PREFIX}{uuid.uuid4()}"

    with _lock:
        _purge_expired_locked(now)
        if len(_sessions) >= MAX_ACTIVE_GUEST_SESSIONS:
            raise GuestSessionCapacityError("游客实时会议容量已满，请稍后重试")
        _sessions[meeting_id] = _StoredGuestMeetingSession(
            token_digest=_digest(token),
            expires_at=expires_at,
        )

    return GuestMeetingSession(
        meeting_id=meeting_id,
        token=token,
        expires_at=datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(),
    )


def authorize_guest_meeting_session(meeting_id: str, token: str) -> bool:
    if not is_guest_meeting_id(meeting_id) or not token:
        return False
    now = _now()
    with _lock:
        _purge_expired_locked(now)
        session = _sessions.get(meeting_id)
        return bool(session and hmac.compare_digest(session.token_digest, _digest(token)))


def revoke_guest_meeting_session(meeting_id: str, token: str) -> bool:
    if not token:
        return False
    now = _now()
    with _lock:
        _purge_expired_locked(now)
        session = _sessions.get(meeting_id)
        if session is None or not hmac.compare_digest(session.token_digest, _digest(token)):
            return False
        del _sessions[meeting_id]
        _transcripts.pop(meeting_id, None)
        return True


def append_guest_transcript(
    meeting_id: str,
    *,
    speaker_id: str | None,
    speaker_label: str | None,
    text: str,
    start_time: float | None,
    end_time: float | None,
    confidence: float | None,
) -> dict[str, object] | None:
    """Store a final ASR line only while its guest session is active."""
    clean_text = str(text or '').strip()[:2000]
    if not clean_text:
        return None
    now = _now()
    with _lock:
        _purge_expired_locked(now)
        if meeting_id not in _sessions:
            return None
        clean_speaker_id = str(speaker_id or 'unknown').strip()[:120] or 'unknown'
        clean_speaker_label = str(speaker_label or clean_speaker_id).strip()[:120] or clean_speaker_id
        identity = '\x1f'.join(
            (
                meeting_id,
                clean_speaker_id,
                '' if start_time is None else str(float(start_time)),
                '' if end_time is None else str(float(end_time)),
                clean_text,
            )
        )
        line_id = hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]
        line = {
            'id': line_id,
            'meeting_id': meeting_id,
            'speaker_id': clean_speaker_id,
            'speaker_label': clean_speaker_label,
            'text': clean_text,
            'start_time': None if start_time is None else float(start_time),
            'end_time': None if end_time is None else float(end_time),
            'confidence': None if confidence is None else float(confidence),
            'created_at': datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        }
        lines = _transcripts.setdefault(meeting_id, [])
        existing_index = next((index for index, item in enumerate(lines) if item['id'] == line_id), None)
        if existing_index is None:
            lines.append(line)
        else:
            lines[existing_index] = line
        return dict(line)


def list_guest_transcripts(
    meeting_id: str,
    token: str,
    *,
    offset: int = 0,
    limit: int = 1000,
) -> dict[str, object] | None:
    """Return a token-scoped snapshot without extending the guest session TTL."""
    if not token:
        return None
    now = _now()
    with _lock:
        _purge_expired_locked(now)
        session = _sessions.get(meeting_id)
        if session is None or not hmac.compare_digest(session.token_digest, _digest(token)):
            return None
        safe_offset = max(0, int(offset))
        safe_limit = min(1000, max(1, int(limit)))
        lines = _transcripts.get(meeting_id, [])
        return {
            'items': [dict(line) for line in lines[safe_offset:safe_offset + safe_limit]],
            'total': len(lines),
        }


def is_guest_meeting_id(meeting_id: str) -> bool:
    return meeting_id.startswith(GUEST_MEETING_PREFIX)


def _digest(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def _now() -> float:
    return time.time()


def _purge_expired_locked(now: float) -> None:
    expired = [
        meeting_id
        for meeting_id, session in _sessions.items()
        if session.expires_at <= now
    ]
    for meeting_id in expired:
        del _sessions[meeting_id]
        _transcripts.pop(meeting_id, None)


def _reset_guest_meeting_sessions_for_tests() -> None:
    with _lock:
        _sessions.clear()
        _transcripts.clear()
