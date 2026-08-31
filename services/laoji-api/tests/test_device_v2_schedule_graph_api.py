from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import device_v2
from app.services.device_v2_identity import DeviceV2Context


def client() -> TestClient:
    app = FastAPI()
    app.include_router(device_v2.router, prefix="/api")
    app.dependency_overrides[device_v2.require_device_v2] = lambda: DeviceV2Context(
        "device-1", "epoch-1", 1, 1,
    )
    return TestClient(app)


def request_body(text: str = "明天下午三点半开会") -> dict:
    return {
        "schema_version": 1,
        "text": text,
        "reference_datetime": "2026-08-18T09:00:00",
        "timezone": "Asia/Shanghai",
        "client_request_id": "device-v2-graph-request",
    }


def test_device_schedule_graph_returns_source_bound_revision(monkeypatch) -> None:
    observed: dict[str, object] = {}

    async def parse(*_args, **kwargs):
        observed.update(kwargs)
        return {
            "title": "开会",
            "event_type": "once",
            "start_date": "2026-08-19",
            "start_time": "15:30",
            "end_time": "17:00",
            "parse_source": "rules",
            "needs_clarification": False,
        }

    monkeypatch.setattr(device_v2, "parse_schedule_text", parse)
    response = client().post("/api/device/v2/schedule/graph", json=request_body())
    assert response.status_code == 200
    graph = response.json()
    assert graph["source"]["content_sha256"].startswith("sha256:")
    assert graph["slots"]["start_time"] == "15:30"
    assert graph["provenance"]["draft_revision"] == 1
    assert observed["model_only"] is True


def test_device_schedule_graph_operation_does_not_call_model(monkeypatch) -> None:
    async def unexpected_model(*_args, **_kwargs):
        raise AssertionError("operation graph must not call model")

    monkeypatch.setattr(device_v2, "parse_schedule_text", unexpected_model)
    payload = request_body("查一下明天的日程")
    payload["client_intent"] = "query"
    response = client().post("/api/device/v2/schedule/graph", json=payload)
    assert response.status_code == 200
    assert response.json()["state"] == "operation"
    assert response.json()["intent"] == "query"
