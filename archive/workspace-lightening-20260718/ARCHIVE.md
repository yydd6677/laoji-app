# Workspace Lightening Archive

Archived on 2026-07-18 at the user's request.

This batch contains development-only tests, fixtures, evidence ledgers, static
gates, CI workflows, reports, and source-inspection helpers. It is not part of
the active application build. Production TypeScript, Kotlin, Android resources,
Expo plugins, and runtime business data remain in their original locations.

Archived groups:

- `__tests__/` and `__mocks__/`
- `modules/laoji-native-platform/src/__tests__/`
- `modules/laoji-native-platform/android/src/test/`
- `modules/laoji-native-platform/android/src/androidTest/`
- `scripts/`
- `tools/`
- `evidence/`
- `test-assets/`
- `.github/`
- gate-oriented files under `docs/`
- generated gate reports under `build/`

The Android and Expo build files were simplified at the same time so they no
longer invoke the archived Feishu evidence/lint gates. To restore the old
verification workflow, move the archived groups back and restore the related
build/package changes from version control.

Jest/testing dependencies and all audit, test, report, sync, and verification
package scripts were removed from the active package manifest. Generated
Android/Expo build trees and caches were moved to the system trash instead of
being copied into this archive; they are reproducible and are not source
artifacts.

The production `AppReadinessGate`, `AppLockGate`, and Android
`FeishuEvidence` runtime metadata remain active because application code still
uses them at runtime. They are not build-time quality gates.

This archive is historical and must not be treated as current UI evidence or
as a current release result.
