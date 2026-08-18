from __future__ import annotations

from pathlib import Path

from verify_legacy_submit_guards import inspect


def test_all_device_media_write_routes_are_guarded() -> None:
    root = Path(__file__).resolve().parents[2]
    report = inspect(root / "services/laoji-api/app/api/device_v1.py")

    assert report["passed"] is True
    assert report["write_route_count"] >= 6
    assert report["unguarded_count"] == 0


def test_probe_fails_for_new_unguarded_media_route(tmp_path) -> None:
    source = tmp_path / "device_v1.py"
    source.write_text(
        """
from fastapi import APIRouter
router = APIRouter()
@router.post('/assets/{asset_id}/new')
async def new_asset():
    return {}
""",
        encoding="utf-8",
    )

    report = inspect(source)

    assert report["passed"] is False
    assert report["unguarded_count"] == 1
