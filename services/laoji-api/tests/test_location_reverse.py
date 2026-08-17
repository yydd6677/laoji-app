from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api import location


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
    monkeypatch.setattr(
        location.auth,
        "consume_auth_rate_limit",
        lambda *_args, **_kwargs: (True, 0),
    )
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
    monkeypatch.setattr(
        location.auth,
        "consume_auth_rate_limit",
        lambda *_args, **_kwargs: (True, 0),
    )
    with pytest.raises(HTTPException) as error:
        await location.reverse_location(
            location.ReverseLocationRequest(latitude=22.5, longitude=114.0),
            _request(),
            None,
        )
    assert error.value.status_code == 503
    assert error.value.detail == "地址服务尚未配置"
