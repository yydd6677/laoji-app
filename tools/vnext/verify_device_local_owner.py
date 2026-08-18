"""Fail-closed static audit for the device-primary mobile owner boundary.

This is intentionally narrower than a runtime/device replay.  It proves that
the checked-in accountless build has one explicit rollback switch for the old
JSON projection and that the active guest branches do not require an account
token before local CRUD.  It must not be used as evidence of Android runtime
or network behaviour.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def main() -> int:
    auth = read("src/store/AuthStore.tsx")
    meetings = read("src/store/MeetingsStore.tsx")
    events = read("src/store/EventsStore.tsx")
    flags = read("src/config/featureFlags.ts")
    config = read("app.config.js")

    checks = {
        "accountless_auth_mode": "mode: 'guest'" in auth and "accessToken: null" in auth,
        "canonical_projection_read": "buildCanonicalMeetingReadProjection" in meetings,
        "legacy_projection_explicit_flag": "localMeetingDbLegacyProjectionWriteV1" in flags,
        "canonical_default_disables_legacy_write": (
            "EXPO_PUBLIC_LOCAL_MEETING_DB_LEGACY_PROJECTION_WRITE_V1 ?? 'false'" in config
        ),
        "meeting_cache_write_guard": (
            "if (!legacyProjectionWritesEnabled && scope === 'guest') return Promise.resolve();" in meetings
        ),
        "guest_schedule_path": "if (mode === 'guest')" in events and "replaceLocalScheduleEvents" in events,
        "guest_meeting_path": "if (mode === 'guest')" in meetings and "createCanonicalGuestMeeting" in meetings,
        "guest_network_requires_capability": (
            "loadDeviceV2Capabilities" in meetings and "selectClosedVNextCapability" in meetings
        ),
    }

    for label, passed in checks.items():
        print(f"{label}={'passed' if passed else 'failed'}")
    passed = all(checks.values())
    print("device_local_owner_audit=" + ("passed_static" if passed else "blocked"))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
