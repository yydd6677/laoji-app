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


def forbid(path: str, needle: str, label: str) -> tuple[str, bool]:
    value = (ROOT / path).read_text(encoding="utf-8")
    return label, needle not in value


def main() -> int:
    checks = [
        require("src/store/AuthStore.tsx", "mode: 'guest'", "accountless_scope"),
        require("src/data/repositories/sqliteMeetingNoteRepository.ts", "本机数据不允许写入旧同步队列", "guest_outbox_fence"),
        require(
            "modules/laoji-native-platform/android/src/main/java/com/laoji/nativeplatform/PurgeOnlyJournalStore.kt",
            'KEY_ALIAS = "laoji_purge_only_v1"',
            "native_purge_journal",
        ),
        forbid("modules/laoji-native-platform/src/deviceAuth.ts", "capabilitySecret", "purge_secret_not_exposed_to_js"),
        require("src/data/repositories/vnext/deviceOperationsRepository.ts", "ALLOWED_STATE_TRANSITIONS", "operation_monotonicity"),
        require("src/data/repositories/vnext/deviceAuthorityRepository.ts", "remote_state = 'cancelled'", "local_binding_cancel_fence"),
        require("services/laoji-api/app/services/vnext_task_store.py", "def cancel_binding_tasks", "remote_binding_cancel_fence"),
        require("services/laoji-api/app/services/vnext_task_store.py", "device_id TEXT NOT NULL", "canonical_device_task_owner"),
        require("services/laoji-api/app/services/vnext_purge_store.py", "DELETE FROM vnext_tasks", "purge_deletes_task_payload"),
        require("src/services/meetingSummaryTasks.ts", "device_summary_task_intents", "summary_intent_sqlite_owner"),
        require("services/laoji-api/app/api/device_v2.py", "/auth/keys/rotate", "v2_auth_surface"),
        require("services/laoji-api/app/api/device_v2.py", "/purge-capabilities/{capability_id}/execute", "v2_purge_surface"),
        require("services/laoji-api/app/services/device_v2_identity.py", "v2_bootstrap_receipts", "bootstrap_idempotent_receipt"),
        require("docs/vnext-stage1/STAGE1-EXIT.md", "不反写 legacy owner", "rollback_record"),
    ]
    failures = [label for label, passed in checks if not passed]
    for label, passed in checks:
        print(f"{label}={'passed' if passed else 'failed'}")
    print("v2_purge_capability=" + ("passed" if not failures else "failed"))
    android_evidence = ROOT / "docs/vnext-stage1/android-compile-evidence.txt"
    native_compiled = android_evidence.is_file() and "result: BUILD SUCCESSFUL" in android_evidence.read_text(encoding="utf-8")
    print("android_native_compile=" + ("passed" if native_compiled else "unverified"))
    backend_evidence = ROOT / "docs/vnext-stage1/backend-test-evidence.txt"
    backend_tested = backend_evidence.is_file() and "result: 19 passed" in backend_evidence.read_text(encoding="utf-8")
    print("backend_focused_tests=" + ("passed" if backend_tested else "unverified"))
    passed = not failures and native_compiled and backend_tested
    print("stage1_exit=" + ("passed_isolated" if passed else "blocked"))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
