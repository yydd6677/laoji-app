#!/usr/bin/env python3
"""Prepare the generated Android tree for Stage 3 Release-target replays.

The repository intentionally ignores ``android/``. Expo prebuild can therefore
replace both the test harness and Gradle's selected instrumentation target.
This helper restores those two generated inputs without changing a product
build's default Debug test target.
"""

from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BUILD_GRADLE = ROOT / "android" / "app" / "build.gradle"
HARNESS_SOURCE = ROOT / "tools" / "vnext" / "android" / "VnextSummaryFenceDbMutationTest.java"
HARNESS_TARGET = (
    ROOT
    / "android"
    / "app"
    / "src"
    / "androidTest"
    / "java"
    / "com"
    / "laoji"
    / "app"
    / HARNESS_SOURCE.name
)
GRADLE_LINE = "    testBuildType (findProperty('android.testBuildType') ?: 'debug').toString()"
GRADLE_ANCHOR = "    ndkVersion rootProject.ext.ndkVersion"


def prepare_gradle() -> bool:
    if not BUILD_GRADLE.is_file():
        raise SystemExit("generated android/app/build.gradle is missing; run Expo prebuild first")
    source = BUILD_GRADLE.read_text(encoding="utf-8")
    if GRADLE_LINE in source:
        return False
    if GRADLE_ANCHOR not in source:
        raise SystemExit("unable to locate the Android Gradle insertion anchor")
    replacement = (
        f"{GRADLE_ANCHOR}\n\n"
        "    // vNext candidate instrumentation build target; Debug stays the default.\n"
        f"{GRADLE_LINE}"
    )
    BUILD_GRADLE.write_text(source.replace(GRADLE_ANCHOR, replacement, 1), encoding="utf-8")
    return True


def prepare_harness() -> bool:
    if not HARNESS_SOURCE.is_file():
        raise SystemExit(f"tracked instrumentation harness is missing: {HARNESS_SOURCE}")
    unchanged = HARNESS_TARGET.is_file() and HARNESS_TARGET.read_bytes() == HARNESS_SOURCE.read_bytes()
    if unchanged:
        return False
    HARNESS_TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HARNESS_SOURCE, HARNESS_TARGET)
    return True


def main() -> None:
    gradle_changed = prepare_gradle()
    harness_changed = prepare_harness()
    print("android_test_build_type_ready=true")
    print(f"generated_gradle_changed={str(gradle_changed).lower()}")
    print(f"instrumentation_harness_changed={str(harness_changed).lower()}")


if __name__ == "__main__":
    main()
