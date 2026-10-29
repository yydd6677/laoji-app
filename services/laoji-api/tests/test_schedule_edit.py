from __future__ import annotations

import copy
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import device_v2
from app.schemas.schedule_edit import ScheduleEditRequest
from app.services import llm_provider, schedule_edit_service as service
from app.services.device_v2_identity import DeviceV2Context


@pytest.fixture(autouse=True)
def candidate_admission(monkeypatch):
    monkeypatch.setenv("LAOJI_SCHEDULE_EDIT_V1_ENABLED", "1")


def request_body():
    return {"schema_version": 1, "client_request_id": "draft-edit:test:3", "draft_id": "draft-1",
        "base_revision": 7, "input_sequence": 3, "reference_datetime": "2026-10-28T23:59:59+08:00",
        "timezone": "Asia/Shanghai", "mode": "patch", "utterance": "🍜晚一小时，地点清空",
        "draft": {"title": "整理资料", "start_date": "2026-10-29", "end_date": None,
            "time": {"precision": "exact", "period": None, "start_time": "09:23", "end_time": None},
            "location": "手动选的地点", "notes": "用户刚补的备注", "category": "其他",
            "recurrence": {"repeat": "weekly", "interval": 2, "weekdays": [1, 3], "until_date": None},
            "reminder_minutes": 10}}


def client(authenticated=True):
    app = FastAPI()
    app.include_router(device_v2.router, prefix="/api")
    if authenticated:
        app.dependency_overrides[device_v2.require_device_v2] = lambda: DeviceV2Context("device-1", "epoch-1", 1, 1)
    return TestClient(app)


def stub(monkeypatch, value, temporal=None):
    calls = []
    def generate(*args, **kwargs):
        calls.append((args, kwargs))
        observation = {field: None for field in ("title", "location", "notes", "category", "recurrence", "reminder")}
        observation["temporal"] = []
        observation["status"] = value["status"]
        for item in value["changes"]:
            if temporal and item["field"] in {"date", "time"}:
                continue
            observation[item["field"]] = {key: v for key, v in item.items() if key != "field"}
        observation.update(temporal or {})
        return json.dumps(observation, ensure_ascii=False)
    monkeypatch.setattr(llm_provider, "call_llm", generate)
    return calls


def test_current_draft_once_and_utf16_evidence(monkeypatch):
    changes = [{"field": "time", "op": "set", "value": {
        "precision": "exact", "period": None, "start_time": "10:23", "end_time": None}, "evidence": "晚一小时"},
        {"field": "location", "op": "clear", "value": None, "evidence": "地点清空"}]
    calls = stub(monkeypatch, {"status": "patch", "changes": changes}, {"temporal": [{
        "op": "shift", "duration": "一小时", "direction": "later", "text": "晚一小时"}]})
    response = client().post("/api/device/v2/schedule/graph/edit", json=request_body())
    assert response.status_code == 200
    result = response.json()
    assert (result["draft_id"], result["base_revision"], result["input_sequence"]) == ("draft-1", 7, 3)
    assert result["changes"] == changes
    assert result["evidence_spans"]["time"] == {"text": "晚一小时", "start": 2, "end": 6}
    assert len(calls) == 1
    args, options = calls[0]
    body = json.loads(args[2])
    assert body["draft"] == request_body()["draft"]
    assert "raw_text" not in body and "client_request_id" not in body
    assert options["telemetry_operation"] == "schedule.graph.edit.v1"
    assert options["priority"] == "interactive" and options["options"]["temperature"] == 0
    assert "response_format" not in options
    assert json.dumps(service.ScheduleEditModelObservation.model_json_schema(), ensure_ascii=False, separators=(",", ":")) in args[1]


@pytest.mark.parametrize("output", [
    {"status": "patch", "changes": []},
    {"status": "no_change", "changes": [{"field": "location", "op": "clear", "value": None, "evidence": "地点清空"}]},
    {"status": "patch", "changes": [{"field": "event_id", "op": "set", "value": "other", "evidence": "地点清空"}]},
    {"status": "patch", "changes": [{"field": "title", "op": "set", "value": "新", "evidence": "不存在的原话"}]},
    {"status": "patch", "changes": [{"field": "title", "op": "clear", "value": "不是null", "evidence": "地点清空"}]},
    {"status": "patch", "changes": [{"field": "time", "op": "set", "value": {
        "precision": "period", "period": "night", "start_time": "19:00", "end_time": None}, "evidence": "晚一小时"}]},
    {"status": "patch", "changes": [{"field": "time", "op": "set", "value": {
        "precision": "exact", "period": None, "start_time": "09:23", "end_time": "08:00"}, "evidence": "晚一小时"}]},
])
def test_invalid_proposal_never_repairs_or_returns_partial_changes(monkeypatch, output):
    calls = stub(monkeypatch, output)
    response = client().post("/api/device/v2/schedule/graph/edit", json=request_body())
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "SCHEDULE_EDIT_INVALID"
    assert len(calls) == 1


@pytest.mark.parametrize("status", ["no_change", "unsupported", "ambiguous"])
def test_non_patch_has_no_change_and_no_invented_fields(monkeypatch, status):
    calls = stub(monkeypatch, {"status": status, "changes": []})
    response = client().post("/api/device/v2/schedule/graph/edit", json=request_body())
    assert response.status_code == 200
    assert response.json()["status"] == status
    assert response.json()["changes"] == [] and response.json()["evidence_spans"] == {}
    assert len(calls) == 1


def test_auth_and_request_safety_happen_before_model(monkeypatch):
    calls = stub(monkeypatch, {"status": "no_change", "changes": []})
    assert client(False).post("/api/device/v2/schedule/graph/edit", json=request_body()).status_code == 401
    for key, value in [("reference_datetime", "2026-10-28T23:59:59"), ("timezone", "invalid/zone"),
        ("base_revision", 0), ("input_sequence", True), ("utterance", " "), ("event_id", "other"), ("mode", "replace")]:
        payload = copy.deepcopy(request_body()); payload[key] = value
        assert client().post("/api/device/v2/schedule/graph/edit", json=payload).status_code == 422
    assert calls == []


def test_duplicate_group_fails_without_partial_patch(monkeypatch):
    item = {"field": "title", "op": "set", "value": "新", "evidence": "晚一小时"}
    with pytest.raises(ValueError):
        service.ScheduleEditProposal.model_validate({"status": "patch", "changes": [item, item]})


def test_provider_failure_is_not_content_error_or_fallback(monkeypatch):
    calls = []
    def fail(*args, **kwargs):
        calls.append(kwargs)
        raise llm_provider.LlmProviderError("provider-private-detail")
    monkeypatch.setattr(llm_provider, "call_llm", fail)
    response = client().post("/api/device/v2/schedule/graph/edit", json=request_body())
    assert response.status_code == 503 and "private" not in response.text
    assert len(calls) == 1


def test_unchanged_value_is_not_reapplied_as_a_new_edit(monkeypatch):
    payload = request_body(); payload["utterance"] = "地点保持原来"
    calls = stub(monkeypatch, {"status": "patch", "changes": [{"field": "location", "op": "set",
        "value": payload["draft"]["location"], "evidence": payload["utterance"]}]})
    response = client().post("/api/device/v2/schedule/graph/edit", json=payload)
    assert response.status_code == 200
    assert response.json()["status"] == "no_change" and response.json()["changes"] == []
    assert response.json()["evidence_spans"] == {}
    assert len(calls) == 1


def test_unvalidated_candidate_does_not_admit_generation_by_default(monkeypatch):
    monkeypatch.delenv("LAOJI_SCHEDULE_EDIT_V1_ENABLED")
    calls = stub(monkeypatch, {"status": "no_change", "changes": []})
    response = client().post("/api/device/v2/schedule/graph/edit", json=request_body())
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "SCHEDULE_EDIT_NOT_ENABLED"
    assert calls == []
