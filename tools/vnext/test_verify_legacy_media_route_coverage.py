from __future__ import annotations

from pathlib import Path

from verify_legacy_media_route_coverage import inspect


def test_account_media_routes_are_guarded() -> None:
    report = inspect(Path(__file__).resolve().parents[2])

    assert report["passed"] is True
    assert report["missing_count"] == 0
