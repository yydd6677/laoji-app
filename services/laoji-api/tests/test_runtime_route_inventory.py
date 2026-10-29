"""Executable guard for the device-primary production route graph."""

from __future__ import annotations

from app.api.qwen_ws import router as qwen_router
from app.api.router import api_router


def _paths(router, prefix: str = "") -> set[str]:
    return {prefix + str(route.path) for route in router.routes}


def test_runtime_routes_expose_current_device_capabilities() -> None:
    paths = _paths(api_router, "/api") | _paths(qwen_router)
    assert {
        "/api/device/v2/meetings/{binding_id}/questions-v2",
        "/api/device/v2/meetings/{binding_id}/source-streams",
        "/api/device/v2/schedule/graph",
        "/api/location/reverse",
        "/ws/meeting/{meeting_id}/qwen",
        "/ws/laoji/schedule/{session_id}/qwen",
    } <= paths


def test_runtime_routes_do_not_mount_account_sync_or_retired_summary_paths() -> None:
    paths = _paths(api_router, "/api") | _paths(qwen_router)
    forbidden_prefixes = ("/api/auth", "/api/laoji")
    assert not any(path.startswith(forbidden_prefixes) for path in paths)
    assert "/api/device/v1/meetings/{binding_id}/summary" not in paths
    assert "/api/device/v1/meetings/{binding_id}/summary-v3" not in paths
    assert "/api/device/v1/meetings/{binding_id}/questions" not in paths
