import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings

settings.DATABASE_URL = os.environ["DATABASE_URL"]

from app.laoji import router as laoji_router


def _client(monkeypatch) -> TestClient:
    app = FastAPI()
    app.include_router(laoji_router.router, prefix="/api/laoji")
    return TestClient(app)


def _parsed(**overrides):
    result = {
        "title": "开会",
        "event_type": "once",
        "start_date": "2026-08-19",
        "start_time": "15:30",
        "end_time": "17:00",
        "parse_source": "rules",
        "needs_clarification": False,
    }
    result.update(overrides)
    return result


def test_graph_route_is_closed_by_default(monkeypatch):
    monkeypatch.delenv("LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED", raising=False)
    client = _client(monkeypatch)
    response = client.post(
        "/api/laoji/v2/schedule/graph",
        json={
            "schema_version": 1,
            "text": "明天下午三点半开会",
            "reference_datetime": "2026-08-18T09:00:00",
            "timezone": "Asia/Shanghai",
            "client_request_id": "graph-route-disabled",
        },
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "SCHEDULE_GRAPH_V2_DISABLED"


def test_graph_route_returns_source_bound_graph(monkeypatch):
    monkeypatch.setenv("LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED", "1")
    observed = {}
    async def fake_parse(*_args, **_kwargs):
        observed.update(_kwargs)
        return _parsed()

    monkeypatch.setattr(laoji_router, "parse_schedule_text", fake_parse)
    client = _client(monkeypatch)
    response = client.post(
        "/api/laoji/v2/schedule/graph",
        json={
            "schema_version": 1,
            "text": "明天下午三点半开会",
            "reference_datetime": "2026-08-18T09:00:00",
            "timezone": "Asia/Shanghai",
            "source_id": "source-route-1234",
            "client_request_id": "graph-route-enabled",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["source_id"] == "source-route-1234"
    assert body["source"]["content_sha256"].startswith("sha256:")
    assert body["route"] == "local_safe"
    assert body["spans"]["time"][0]["text"] == "下午三点半"
    assert observed["model_only"] is True


def test_graph_route_fails_closed_when_model_returns_no_observation(monkeypatch):
    monkeypatch.setenv("LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED", "1")
    async def empty_parse(*_args, **_kwargs):
        return None

    monkeypatch.setattr(laoji_router, "parse_schedule_text", empty_parse)
    client = _client(monkeypatch)
    response = client.post(
        "/api/laoji/v2/schedule/graph",
        json={
            "schema_version": 1,
            "text": "明天下午三点半开会",
            "reference_datetime": "2026-08-18T09:00:00",
            "timezone": "Asia/Shanghai",
            "client_request_id": "graph-route-empty-model",
        },
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "SCHEDULE_GRAPH_PROVIDER_UNAVAILABLE"


def test_graph_clarify_route_increments_existing_revision(monkeypatch):
    monkeypatch.setenv("LAOJI_VNEXT_SCHEDULE_GRAPH_ENABLED", "1")
    async def fake_parse(*_args, **_kwargs):
        return _parsed(start_time=None, end_time=None, needs_clarification=True)

    monkeypatch.setattr(laoji_router, "parse_schedule_text", fake_parse)
    client = _client(monkeypatch)
    created = client.post(
        "/api/laoji/v2/schedule/graph",
        json={
            "schema_version": 1,
            "text": "明天开会",
            "reference_datetime": "2026-08-18T09:00:00",
            "timezone": "Asia/Shanghai",
            "client_request_id": "graph-route-clarify-create",
        },
    )
    assert created.status_code == 200
    graph = created.json()
    clarified = client.post(
        "/api/laoji/v2/schedule/graph/clarify",
        json={
            "schema_version": 1,
            "graph": graph,
            "answer": "下午三点半",
            "client_request_id": "graph-route-clarify-answer",
        },
    )
    assert clarified.status_code == 200
    body = clarified.json()
    assert body["source_id"] == graph["source_id"]
    assert body["provenance"]["draft_revision"] == 2
    assert body["slots"]["start_time"] == "15:30"
