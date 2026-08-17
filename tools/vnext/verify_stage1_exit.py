"""Static Stage 1 exit probe for the isolated vNext worktree.

This is intentionally a fail-closed inventory, not a production readiness
claim. It reports the implementation boundaries that can be checked without
starting the API or installing an APK.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require(path: str, needle: str, label: str) -> tuple[str, bool]:
    value = (ROOT / path).read_text(encoding="utf-8")
    return label, needle in value


def main() -> int:
    checks = [
        require("src/store/AuthStore.tsx", "mode: 'guest'", "accountless_scope"),
        require("src/data/repositories/sqliteMeetingNoteRepository.ts", "本机数据不允许写入旧同步队列", "guest_outbox_fence"),
        require("src/services/purgeJournal.ts", "purge-only.v1.journal", "purge_journal"),
        require("src/data/repositories/vnext/deviceOperationsRepository.ts", "ALLOWED_STATE_TRANSITIONS", "operation_monotonicity"),
        require("src/data/repositories/vnext/deviceAuthorityRepository.ts", "remote_state = 'cancelled'", "local_binding_cancel_fence"),
        require("services/laoji-api/app/services/vnext_task_store.py", "def cancel_binding_tasks", "remote_binding_cancel_fence"),
        require("src/services/meetingSummaryTasks.ts", "device_summary_task_intents", "summary_intent_sqlite_owner"),
        require("services/laoji-api/app/api/device_v2.py", "/auth/keys/rotate", "v2_auth_surface"),
    ]
    failures = [label for label, passed in checks if not passed]
    for label, passed in checks:
        print(f"{label}={'passed' if passed else 'failed'}")
    # These gates intentionally remain explicit until the native build and
    # production-compatible purge capability are available.
    print("v2_purge_capability=blocked")
    android_evidence = ROOT / "docs/vnext-stage1/android-compile-evidence.txt"
    native_compiled = android_evidence.is_file() and "result: BUILD SUCCESSFUL" in android_evidence.read_text(encoding="utf-8")
    print("android_native_compile=" + ("passed" if native_compiled else "unverified"))
    print("stage1_exit=" + ("blocked" if failures else "blocked_by_external_gates"))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
