from __future__ import annotations

import asyncio

import httpx
import pytest

import server as server_module
from server import ProxyConfig, ReverseGeocoderProxy, ReverseRequest, create_app, load_config


def config(**overrides):
    values = {
        "upstream_url": "https://geo.example.test/reverse",
        "user_agent": "LaoJi-test/1.0",
        "email": None,
        "timeout_seconds": 1.0,
        "min_interval_seconds": 0.0,
        "cache_ttl_seconds": 3600.0,
        "cache_size": 8,
    }
    values.update(overrides)
    return ProxyConfig(**values)


@pytest.mark.asyncio
async def test_disabled_provider_fails_closed():
    app = create_app(ReverseGeocoderProxy(config(upstream_url="")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
    assert response.status_code == 503
    assert response.json()["detail"] == "地址服务尚未配置"


@pytest.mark.asyncio
async def test_readiness_is_fail_closed_when_provider_is_disabled():
    app = create_app(ReverseGeocoderProxy(config(upstream_url="")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        health = await client.get("/health")
        ready = await client.get("/ready")
    assert health.status_code == 200
    assert health.json()["enabled"] is False
    assert ready.status_code == 503
    assert ready.json()["detail"] == "地址服务尚未配置"


def test_load_config_rejects_provider_credentials_and_query_parameters():
    for key in ("https://user:secret@geo.example.test/reverse", "https://geo.example.test/reverse?token=secret"):
        with pytest.raises(ValueError):
            load_config({"NOMINATIM_URL": key, "NOMINATIM_USER_AGENT": "LaoJi-test/1.0"})


def test_offline_city_import_runtime_failure_is_not_ready(monkeypatch):
    original_import = __import__

    def failing_import(name, *args, **kwargs):
        if name == "reverse_geocoder":
            raise RuntimeError("ABI mismatch")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", failing_import)
    assert server_module.offline_city_available() is False


@pytest.mark.asyncio
async def test_normalizes_nominatim_and_caches_user_request():
    calls = []

    async def fake_fetch(_config, params):
        calls.append(params)
        await asyncio.sleep(0)
        return {
            "display_name": "金田路, 福中社区, 福田区, 深圳市, 中国",
            "address": {
                "road": "金田路",
                "quarter": "福中社区",
                "suburb": "莲花街道",
                "city": "福田区",
                "state": "广东省",
                "country": "中国",
            },
        }

    proxy = ReverseGeocoderProxy(config(), fetch_upstream=fake_fetch)
    app = create_app(proxy)
    payload = {"schema_version": 1, "latitude": 22.543095, "longitude": 114.057865, "source": "live"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        first = await client.post("/reverse", json=payload)
        second = await client.post("/reverse", json={**payload, "accuracy_meters": 5})
    assert first.status_code == second.status_code == 200
    assert first.json()["address_parts"]["street"] == "金田路"
    assert first.json()["attribution"] == "地址数据来自 OpenStreetMap"
    assert second.json() == first.json()
    assert len(calls) == 1
    assert calls[0]["format"] == "jsonv2"
    assert calls[0]["addressdetails"] == "1"


@pytest.mark.asyncio
async def test_same_coordinate_is_single_flight():
    started = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def fake_fetch(_config, params):
        calls.append(params)
        started.set()
        await release.wait()
        return {"display_name": "深圳市", "address": {"city": "深圳市"}}

    proxy = ReverseGeocoderProxy(config(), fetch_upstream=fake_fetch)
    first = asyncio.create_task(proxy.reverse(ReverseRequest(latitude=22.5, longitude=114.0)))
    await started.wait()
    second = asyncio.create_task(proxy.reverse(ReverseRequest(latitude=22.5, longitude=114.0)))
    await asyncio.sleep(0)
    assert len(calls) == 1
    release.set()
    assert (await first)["address_parts"]["city"] == "深圳市"
    assert (await second)["address_parts"]["city"] == "深圳市"
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_different_coordinates_do_not_hold_cache_lock_during_provider_call():
    started = []
    release = asyncio.Event()

    async def fake_fetch(_config, params):
        started.append(params["lat"])
        await release.wait()
        return {"display_name": params["lat"], "address": {"city": params["lat"]}}

    proxy = ReverseGeocoderProxy(config(), fetch_upstream=fake_fetch)
    first = asyncio.create_task(proxy.reverse(ReverseRequest(latitude=22.5, longitude=114.0)))
    second = asyncio.create_task(proxy.reverse(ReverseRequest(latitude=23.5, longitude=114.0)))
    for _ in range(20):
        if len(started) == 2:
            break
        await asyncio.sleep(0)
    assert len(started) == 2
    release.set()
    assert (await first)["address_parts"]["city"] == "22.5000000"
    assert (await second)["address_parts"]["city"] == "23.5000000"


@pytest.mark.asyncio
async def test_upstream_failure_does_not_leak_provider_error():
    async def failing_fetch(_config, _params):
        raise RuntimeError("secret upstream URL and token")

    app = create_app(ReverseGeocoderProxy(config(), fetch_upstream=failing_fetch))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
    assert response.status_code == 502
    assert response.json()["detail"] == "地址服务暂时不可用"
    assert "secret" not in response.text


@pytest.mark.asyncio
async def test_malformed_success_response_fails_closed_and_is_not_cached():
    calls = []

    async def malformed_fetch(_config, _params):
        calls.append(True)
        return {"unexpected": {"value": True}}

    proxy = ReverseGeocoderProxy(config(), fetch_upstream=malformed_fetch)
    app = create_app(proxy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        first = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
        second = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
    assert first.status_code == second.status_code == 502
    assert first.json()["detail"] == "地址服务返回了无效结果"
    assert second.json()["detail"] == "地址服务返回了无效结果"
    assert proxy.health()["cache_entries"] == 0
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_malformed_success_response_uses_explicit_offline_fallback():
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(server_module, "offline_city_available", lambda: True)
    try:
        async def malformed_fetch(_config, _params):
            return {"unexpected": {"value": True}}

        proxy = ReverseGeocoderProxy(
            config(offline_city_enabled=True),
            fetch_upstream=malformed_fetch,
            offline_lookup=lambda _latitude, _longitude: {
                "schema_version": 1,
                "provider": "offline-city",
                "granularity": "city",
                "confidence": "low",
                "address_parts": {"formattedAddress": "城市级估计：深圳市", "city": "深圳市"},
                "offline": True,
            },
        )
        app = create_app(proxy)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
        assert response.status_code == 200
        assert response.json()["provider"] == "offline-city"
        assert response.json()["offline"] is True
    finally:
        monkeypatch.undo()


@pytest.mark.asyncio
async def test_invalid_coordinates_rejected_before_provider():
    called = False

    async def fake_fetch(_config, _params):
        nonlocal called
        called = True
        return {}

    app = create_app(ReverseGeocoderProxy(config(), fetch_upstream=fake_fetch))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/reverse", json={"latitude": 95, "longitude": 114})
    assert response.status_code == 422
    assert called is False


@pytest.mark.asyncio
async def test_offline_city_mode_returns_explicit_low_granularity_result(monkeypatch):
    monkeypatch.setattr(server_module, "offline_city_available", lambda: True)

    def fake_lookup(_latitude, _longitude):
        return {
            "schema_version": 1,
            "provider": "offline-city",
            "granularity": "city",
            "confidence": "low",
            "address_parts": {
                "formattedAddress": "广东省深圳市（城市级估计）",
                "region": "广东省",
                "city": "深圳市",
                "name": "深圳市",
            },
            "offline": True,
        }

    proxy = ReverseGeocoderProxy(
        config(upstream_url="", user_agent="", offline_city_enabled=True),
        offline_lookup=fake_lookup,
    )
    app = create_app(proxy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        ready = await client.get("/ready")
        response = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
    assert ready.status_code == 200
    assert ready.json()["provider"] == "offline-city"
    assert response.status_code == 200
    assert response.json()["address_parts"]["formattedAddress"].endswith("城市级估计）")


@pytest.mark.asyncio
async def test_external_failure_can_fall_back_to_explicit_offline_city(monkeypatch):
    monkeypatch.setattr(server_module, "offline_city_available", lambda: True)

    async def failing_fetch(_config, _params):
        raise RuntimeError("upstream unavailable")

    proxy = ReverseGeocoderProxy(
        config(offline_city_enabled=True),
        fetch_upstream=failing_fetch,
        offline_lookup=lambda _latitude, _longitude: {
            "schema_version": 1,
            "provider": "offline-city",
            "address_parts": {"formattedAddress": "城市级估计：深圳市", "city": "深圳市"},
        },
    )
    app = create_app(proxy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/reverse", json={"latitude": 22.5, "longitude": 114.0})
    assert response.status_code == 200
    assert response.json()["provider"] == "offline-city"


@pytest.mark.asyncio
async def test_offline_readiness_fails_when_optional_dependency_is_missing(monkeypatch):
    monkeypatch.setattr(server_module, "offline_city_available", lambda: False)
    app = create_app(ReverseGeocoderProxy(config(upstream_url="", user_agent="", offline_city_enabled=True)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/ready")
    assert response.status_code == 503
    assert response.json()["detail"] == "离线城市地址依赖未安装"
