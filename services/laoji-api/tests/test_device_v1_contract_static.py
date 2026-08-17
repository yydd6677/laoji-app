"""Dependency-free contract checks for the device-primary surface.

The developer workstation intentionally does not install the server's FastAPI
environment.  These checks still catch accidental route drift and private
module introspection before the overlay is exercised in the production venv.
"""

from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _tree(path: str) -> ast.Module:
    return ast.parse((ROOT / path).read_text(encoding="utf-8"))


def test_device_router_has_required_public_paths() -> None:
    tree = _tree("app/api/device_v1.py")
    paths: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr not in {"get", "post", "put", "delete"} or not node.args:
            continue
        if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            paths.add(node.args[0].value)
    required = {
        "/register",
        "/capabilities",
        "/meetings",
        "/meetings/{binding_id}",
        "/meetings/{binding_id}/assets",
        "/assets/{asset_id}/content",
        "/assets/{asset_id}/transcription",
        "/tasks/{task_id}",
        "/meetings/{binding_id}/transcript",
        "/meetings/{binding_id}/summary",
        "/meetings/{binding_id}/questions",
        "/speakers",
        "/speakers/audio",
        "/speakers/{speaker_id}/samples",
        "/speakers/{speaker_id}",
        "/transient-inputs",
    }
    assert required <= paths


def test_device_router_does_not_reach_into_private_module_state() -> None:
    source = (ROOT / "app/api/device_v1.py").read_text(encoding="utf-8")
    assert "__globals__" not in source
    assert "__dict__" not in source


def test_identity_exports_router_facing_helpers() -> None:
    tree = _tree("app/services/device_identity.py")
    names = {
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    assert {"control_connection", "utc_now", "activate_epoch", "record_meeting_tombstone"} <= names


def test_device_router_avoids_path_header_collision_and_sqlite_delete_lock() -> None:
    source = (ROOT / "app/api/device_v1.py").read_text(encoding="utf-8")
    # FastAPI rejects a dependency Header named like /epochs/{epoch_id}; the
    # header parameter must remain distinct from the path parameter.
    assert "header_epoch_id: str | None = Header" in source
    delete_start = source.index("async def delete_meeting_binding")
    delete_end = source.index("@router.post(\"/schedule/parse\")", delete_start)
    delete_block = source[delete_start:delete_end]
    assert "await db.commit()" in delete_block
    assert delete_block.index("await db.commit()") < delete_block.index(
        "device_identity.record_meeting_tombstone"
    )


def test_device_questions_accept_only_verified_local_context_sources() -> None:
    source = (ROOT / "app/api/device_v1.py").read_text(encoding="utf-8")
    question_start = source.index("async def ask_device_question")
    question_end = source.index('@router.get("/speakers")', question_start)
    question_block = source[question_start:question_end]
    assert "request.manual_note.content_sha256" in question_block
    assert "source_hash_matches(" in question_block
    assert "summary_sections=request.summary_sections" in question_block
    assert "context=request.context" in question_block
    assert 'kind == "manual_note"' in question_block
    assert 'kind == "summary"' in question_block
