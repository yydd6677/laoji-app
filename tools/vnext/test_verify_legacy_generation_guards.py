from __future__ import annotations

from pathlib import Path

from verify_legacy_generation_guards import inspect


def test_v1_generation_routes_are_guarded() -> None:
    report = inspect(Path(__file__).resolve().parents[2])

    assert report["passed"] is True
    assert report["missing_count"] == 0
