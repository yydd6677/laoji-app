from __future__ import annotations

import pytest
import httpx
from fastapi import HTTPException
from starlette.requests import Request

from app.api import location


@pytest.mark.asyncio
async def test_system_gps_is_converted_before_amap_regeo(monkeypatch):
    paths = []
    def handler(request):
        paths.append(request.url.path)
        if request.url.path.endswith('/convert'):
            assert request.url.params['coordsys'] == 'gps'
            assert request.url.params['locations'] == '116.397000,39.908000'
            return httpx.Response(200, json={'status': '1', 'locations': '116.403243,39.909403'})
        assert request.url.params['location'] == '116.4032430,39.9094030'
        assert request.url.params['radius'] == '100'
        return httpx.Response(200, json={'status': '1', 'regeocode': {}})
    client = httpx.AsyncClient
    monkeypatch.setattr(location.httpx, 'AsyncClient',
        lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    await location._fetch_amap(39.908, 116.397, 'not-a-real-key')
    assert paths == ['/v3/assistant/coordinate/convert', '/v3/geocode/regeo']


@pytest.mark.asyncio
async def test_failed_coordinate_conversion_never_queries_wrong_location(monkeypatch):
    calls = []
    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, json={'status': '0'})
    client = httpx.AsyncClient
    monkeypatch.setattr(location.httpx, 'AsyncClient',
        lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(RuntimeError, match='amap_coordinate_conversion_failed'):
        await location._fetch_amap(39.908, 116.397, 'not-a-real-key')
    assert len(calls) == 1


def _request(host: str = "127.0.0.1") -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/location/reverse",
            "headers": [],
            "client": (host, 12345),
        }
    )


@pytest.mark.asyncio
async def test_amap_result_is_normalized_and_cached_without_plain_coordinates(
    monkeypatch,
):
    monkeypatch.setenv("AMAP_WEB_SERVICE_KEY", "test-key")
    location._CACHE.clear()
    location._QUOTA.clear()
    calls = 0

    async def fetch(_latitude, _longitude, _key):
        nonlocal calls
        calls += 1
        return {
            "status": "1",
            "regeocode": {
                "formatted_address": "广东省深圳市南山区科技园",
                "addressComponent": {
                    "country": "中国",
                    "province": "广东省",
                    "city": "深圳市",
                    "district": "南山区",
                    "township": "粤海街道",
                    "streetNumber": {"street": "科技南路", "number": "1号"},
                },
                "pois": [{"name": "科技园"}],
            },
        }

    monkeypatch.setattr(location, "_fetch_amap", fetch)
    first = await location.reverse_location(
        location.ReverseLocationRequest(latitude=22.543096, longitude=114.057865),
        _request(),
        None,
    )
    second = await location.reverse_location(
        location.ReverseLocationRequest(latitude=22.5430961, longitude=114.0578651),
        _request(),
        None,
    )

    assert first == second
    assert calls == 1
    assert first["provider"] == "amap-web-service"
    assert first["address_parts"]["city"] == "深圳市"
    # The compact production contract uses a bounded process-local HMAC-keyed
    # cache. It must not create a SQLite file or retain raw coordinates and
    # provider response bodies.
    assert len(location._CACHE) == 1
    key, (_created_at, cached_payload) = next(iter(location._CACHE.items()))
    assert len(key) == 64
    assert "22.543096" not in key and "114.057865" not in key
    assert "22.543096" not in str(cached_payload)
    assert "114.057865" not in str(cached_payload)


@pytest.mark.asyncio
async def test_missing_amap_key_fails_cleanly_for_client_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("AMAP_WEB_SERVICE_KEY", raising=False)
    location._QUOTA.clear()
    with pytest.raises(HTTPException) as error:
        await location.reverse_location(
            location.ReverseLocationRequest(latitude=22.5, longitude=114.0),
            _request(),
            None,
        )
    assert error.value.status_code == 503
    assert error.value.detail == "地址服务尚未配置"
