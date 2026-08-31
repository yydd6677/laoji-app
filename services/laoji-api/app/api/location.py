"""Authenticated-or-rate-limited reverse geocoding through Amap Web Service."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from collections import OrderedDict
from threading import Lock
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.services import device_identity
from app.services.device_identity import DeviceIdentityError


router = APIRouter()
security = HTTPBearer(auto_error=False)
MAX_RESPONSE_BYTES = 128 * 1024
CACHE_TTL_SECONDS = 15 * 60
CACHE_MAX_ROWS = 2_048
_CACHE: OrderedDict[str, tuple[int, dict[str, Any]]] = OrderedDict()
_CACHE_LOCK = Lock()
_QUOTA: OrderedDict[tuple[str, str], tuple[int, int]] = OrderedDict()
_QUOTA_LOCK = Lock()
_QUOTA_MAX_ROWS = 4_096


class ReverseLocationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=1, ge=1, le=1)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_meters: float | None = Field(default=None, ge=0, le=1_000_000)
    timestamp_ms: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)
    source: str = Field(default="live", pattern=r"^(live|cache)$")


def _coordinate_key(latitude: float, longitude: float) -> str:
    rounded = f"{latitude:.5f},{longitude:.5f}".encode("ascii")
    secret = settings.SECRET_KEY.encode("utf-8")
    return hmac.new(secret, rounded, hashlib.sha256).hexdigest()


def _cache_get(key: str) -> dict[str, Any] | None:
    now = int(time.time())
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if entry is None:
            return None
        created_at, payload = entry
        if now - created_at > CACHE_TTL_SECONDS:
            _CACHE.pop(key, None)
            return None
        _CACHE.move_to_end(key)
        return dict(payload)


def _cache_put(key: str, payload: dict[str, Any]) -> None:
    now = int(time.time())
    with _CACHE_LOCK:
        _CACHE[key] = (now, dict(payload))
        _CACHE.move_to_end(key)
        cutoff = now - CACHE_TTL_SECONDS
        for cache_key, (created_at, _) in list(_CACHE.items()):
            if created_at < cutoff:
                _CACHE.pop(cache_key, None)
        while len(_CACHE) > CACHE_MAX_ROWS:
            _CACHE.popitem(last=False)


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.split())
    return normalized or None


def _normalize_amap(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or str(payload.get("status")) != "1":
        raise RuntimeError("amap_response_failed")
    regeocode = payload.get("regeocode")
    if not isinstance(regeocode, dict):
        raise RuntimeError("amap_response_invalid")
    component = regeocode.get("addressComponent")
    component = component if isinstance(component, dict) else {}
    street_number = component.get("streetNumber")
    street_number = street_number if isinstance(street_number, dict) else {}
    pois = regeocode.get("pois")
    first_poi = pois[0] if isinstance(pois, list) and pois and isinstance(pois[0], dict) else {}
    city = component.get("city")
    if isinstance(city, list):
        city = city[0] if city else None
    parts = {
        "formattedAddress": _text(regeocode.get("formatted_address")),
        "country": _text(component.get("country")),
        "region": _text(component.get("province")),
        "city": _text(city),
        "district": _text(component.get("district")),
        "subregion": _text(component.get("township")),
        "street": _text(street_number.get("street")),
        "streetNumber": _text(street_number.get("number")),
        "name": _text(first_poi.get("name")),
    }
    if not any(parts.values()):
        raise RuntimeError("amap_address_empty")
    return {
        "schema_version": 1,
        "provider": "amap-web-service",
        "address_parts": parts,
    }


async def _fetch_amap(latitude: float, longitude: float, key: str) -> dict[str, Any]:
    timeout = httpx.Timeout(5.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
        async with client.stream(
            "GET",
            "https://restapi.amap.com/v3/geocode/regeo",
            params={
                "key": key,
                "location": f"{longitude:.7f},{latitude:.7f}",
                "extensions": "all",
                "radius": "1000",
                "output": "JSON",
            },
            headers={"Accept": "application/json"},
        ) as response:
            if response.status_code != 200:
                raise RuntimeError("amap_http_failed")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise RuntimeError("amap_response_too_large")
                chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("amap_response_invalid") from exc


def _optional_principal(
    credentials: HTTPAuthorizationCredentials | None,
    request: Request,
) -> tuple[str, str]:
    """Resolve a device or anonymous location quota identity.

    Device-primary clients intentionally do not have an account token.  Keep
    the device credential on the same Bearer header as the rest of the device
    API, and require the active epoch so a closed/reinstalled app cannot use
    the old identity to consume the location quota.
    """
    if credentials is None:
        return "guest", request.client.host if request.client and request.client.host else "unknown"
    if credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="登录信息无效")
    presented = credentials.credentials.strip()
    if presented.lower().startswith("dv1."):
        try:
            device_id, device_secret = device_identity.parse_bearer(f"Bearer {presented}")
            epoch_id = request.headers.get("x-laoji-data-epoch", "").strip()
            if not epoch_id:
                raise DeviceIdentityError("EPOCH_REQUIRED", "缺少本机数据域", 428)
            context = device_identity.authenticate(device_id, device_secret, epoch_id)
        except DeviceIdentityError as error:
            raise HTTPException(
                status_code=error.status_code,
                detail={"code": error.code, "message": error.message},
            ) from error
        return "device", f"{context.device_id}:{context.epoch_id}"
    raise HTTPException(status_code=401, detail="设备凭据无效")


def _enforce_quota(principal: tuple[str, str]) -> None:
    principal_type, identity = principal
    if principal_type == "device":
        scope = "location-reverse-device"
        limit, window = 1_000, 24 * 60 * 60
    else:
        scope = "location-reverse-guest"
        limit, window = 60, 60 * 60
    now = int(time.time())
    quota_key = (scope, identity)
    with _QUOTA_LOCK:
        started_at, count = _QUOTA.get(quota_key, (now, 0))
        if now - started_at >= window:
            started_at, count = now, 0
        count += 1
        _QUOTA[quota_key] = (started_at, count)
        _QUOTA.move_to_end(quota_key)
        while len(_QUOTA) > _QUOTA_MAX_ROWS:
            _QUOTA.popitem(last=False)
        retry_after = max(1, window - (now - started_at))
    if count > limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="地址查询过于频繁，请稍后重试",
            headers={"Retry-After": str(retry_after)},
        )


@router.post("/reverse")
async def reverse_location(
    payload: ReverseLocationRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict[str, Any]:
    principal = _optional_principal(credentials, request)
    _enforce_quota(principal)
    coordinate_key = _coordinate_key(payload.latitude, payload.longitude)
    cached = _cache_get(coordinate_key)
    if cached is not None:
        return cached
    amap_key = os.getenv("AMAP_WEB_SERVICE_KEY", "").strip()
    if not amap_key:
        raise HTTPException(status_code=503, detail="地址服务尚未配置")
    try:
        upstream = await _fetch_amap(payload.latitude, payload.longitude, amap_key)
        normalized = _normalize_amap(upstream)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="地址服务暂时不可用") from exc
    _cache_put(coordinate_key, normalized)
    return normalized
