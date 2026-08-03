#!/usr/bin/env python3
"""Opt-in server-side reverse-geocoder proxy for LaoJi.

The mobile client never talks to a public geocoder directly.  This service is
disabled unless ``NOMINATIM_URL`` and an identifying ``NOMINATIM_USER_AGENT``
are configured.  It enforces a single-flight cache, a minimum upstream
interval, bounded response bodies and a short request timeout.  A deployment
can replace Nominatim with another provider without changing the mobile API.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import json
import os
from time import monotonic
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field


MAX_RESPONSE_BYTES = 128 * 1024
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_MIN_INTERVAL_SECONDS = 1.05
DEFAULT_CACHE_TTL_SECONDS = 24 * 60 * 60
DEFAULT_CACHE_SIZE = 512
OFFLINE_CITY_ENV = "LAOJI_REVERSE_GEOCODER_OFFLINE_CITY"

_OFFLINE_COUNTRY_NAMES = {
    "CN": "中国",
    "HK": "中国香港",
    "MO": "中国澳门",
    "TW": "中国台湾",
    "US": "美国",
    "GB": "英国",
    "JP": "日本",
    "KR": "韩国",
}
_OFFLINE_REGION_NAMES = {
    "Guangdong": "广东省",
    "Beijing": "北京市",
    "Shanghai Shi": "上海市",
    "Zhejiang": "浙江省",
    "Jiangsu": "江苏省",
    "Sichuan": "四川省",
    "Hubei": "湖北省",
    "Fujian": "福建省",
}
_OFFLINE_CITY_NAMES = {
    "Shenzhen": "深圳市",
    "Guangzhou": "广州市",
    "Beijing": "北京市",
    "Shanghai": "上海市",
    "Hangzhou": "杭州市",
    "Chengdu": "成都市",
    "Wuhan": "武汉市",
    "Xiamen": "厦门市",
}


class ReverseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(default=1, ge=1, le=1)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_meters: float | None = Field(default=None, ge=0, le=1_000_000)
    timestamp_ms: int | None = Field(default=None, ge=0, le=9_007_199_254_740_991)
    source: str = Field(default="live", min_length=1, max_length=32)


OfflineCityLookup = Callable[[float, float], dict[str, Any] | None]


@dataclass(frozen=True)
class ProxyConfig:
    upstream_url: str
    user_agent: str
    email: str | None
    timeout_seconds: float
    min_interval_seconds: float
    cache_ttl_seconds: float
    cache_size: int
    offline_city_enabled: bool = False

    @property
    def external_enabled(self) -> bool:
        return bool(self.upstream_url and self.user_agent)

    @property
    def enabled(self) -> bool:
        return self.external_enabled or self.offline_city_enabled

    @property
    def provider_name(self) -> str | None:
        if self.external_enabled and self.offline_city_enabled:
            return "nominatim-proxy-with-offline-city-fallback"
        if self.external_enabled:
            return "nominatim-proxy"
        if self.offline_city_enabled:
            return "offline-city"
        return None


def _clean_upstream_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("NOMINATIM_URL must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("NOMINATIM_URL must not contain credentials or query parameters")
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "", ""))


def load_config(environ: dict[str, str] | None = None) -> ProxyConfig:
    source = os.environ if environ is None else environ
    raw_url = source.get("NOMINATIM_URL", "").strip()
    upstream_url = _clean_upstream_url(raw_url) if raw_url else ""
    try:
        timeout = max(0.2, min(15.0, float(source.get("NOMINATIM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))))
        interval = max(0.0, min(60.0, float(source.get("NOMINATIM_MIN_INTERVAL_SECONDS", DEFAULT_MIN_INTERVAL_SECONDS))))
        ttl = max(0.0, min(7 * 24 * 60 * 60, float(source.get("NOMINATIM_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS))))
        cache_size = max(1, min(10_000, int(source.get("NOMINATIM_CACHE_SIZE", DEFAULT_CACHE_SIZE))))
    except (TypeError, ValueError) as exc:
        raise ValueError("Nominatim proxy numeric configuration is invalid") from exc
    return ProxyConfig(
        upstream_url=upstream_url,
        user_agent=source.get("NOMINATIM_USER_AGENT", "").strip(),
        email=source.get("NOMINATIM_EMAIL", "").strip() or None,
        timeout_seconds=timeout,
        min_interval_seconds=interval,
        cache_ttl_seconds=ttl,
        cache_size=cache_size,
        offline_city_enabled=source.get(OFFLINE_CITY_ENV, "").strip().lower()
        in {"1", "true", "yes", "on"},
    )


def offline_city_available() -> bool:
    try:
        import reverse_geocoder  # type: ignore[import-not-found]
    except Exception:
        # Optional geocoder imports can fail on an ABI or data-loading error,
        # not only when the package is absent. Treat every such failure as
        # not-ready so /health and /ready remain stable and fail closed.
        return False
    return callable(getattr(reverse_geocoder, "search", None))


def _offline_label(value: object, mapping: dict[str, str]) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = " ".join(value.split())
    return mapping.get(normalized, normalized)


def lookup_offline_city(latitude: float, longitude: float) -> dict[str, Any] | None:
    """Return a deliberately coarse city estimate from local GeoNames data."""
    try:
        import reverse_geocoder  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("offline_city_dependency_missing") from exc
    rows = reverse_geocoder.search((latitude, longitude), mode=1)
    if not rows:
        return None
    row = rows[0] if isinstance(rows[0], dict) else {}
    city = _offline_label(row.get("name"), _OFFLINE_CITY_NAMES)
    region = _offline_label(row.get("admin1"), _OFFLINE_REGION_NAMES)
    country = _OFFLINE_COUNTRY_NAMES.get(str(row.get("cc") or "").upper())
    if not city:
        return None
    display = "城市级估计：" + city
    if region and region != city:
        display = f"{region}{city}（城市级估计）"
    return {
        "schema_version": 1,
        "provider": "offline-city",
        "granularity": "city",
        "confidence": "low",
        "address_parts": {
            "formattedAddress": display,
            "country": country,
            "region": region,
            "city": city,
            "name": city,
        },
        "offline": True,
    }


def _part(address: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = address.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())
    return None


def normalize_nominatim(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    raw_address = payload.get("address")
    address = raw_address if isinstance(raw_address, dict) else {}
    display = payload.get("display_name")
    display_name = " ".join(display.split()) if isinstance(display, str) and display.strip() else None
    parts = {
        "formattedAddress": display_name,
        "country": _part(address, "country"),
        "region": _part(address, "state", "province", "region"),
        "city": _part(address, "city", "town", "municipality", "county"),
        "district": _part(address, "district", "city_district", "suburb", "quarter"),
        "subregion": _part(address, "village", "hamlet"),
        "street": _part(address, "road", "street"),
        "streetNumber": _part(address, "house_number"),
        "name": _part(address, "amenity", "building", "shop", "name"),
    }
    if not any(value for value in parts.values()):
        return None
    return {
        "schema_version": 1,
        "provider": "nominatim-proxy",
        "address_parts": parts,
        "attribution": "地址数据来自 OpenStreetMap",
    }


FetchUpstream = Callable[[ProxyConfig, dict[str, str]], Awaitable[dict[str, Any] | None]]


async def _fetch_upstream(config: ProxyConfig, params: dict[str, str]) -> dict[str, Any] | None:
    headers = {
        "User-Agent": config.user_agent,
        "Accept": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if config.email:
        params = {**params, "email": config.email}
    timeout = httpx.Timeout(config.timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        async with client.stream(
            "GET",
            config.upstream_url,
            params=params,
            headers=headers,
        ) as response:
            if response.status_code < 200 or response.status_code >= 300:
                raise RuntimeError(f"upstream_status_{response.status_code}")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise RuntimeError("upstream_response_too_large")
                chunks.append(chunk)
    try:
        return json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("upstream_response_invalid") from exc


class ReverseGeocoderProxy:
    def __init__(
        self,
        config: ProxyConfig,
        fetch_upstream: FetchUpstream = _fetch_upstream,
        offline_lookup: OfflineCityLookup = lookup_offline_city,
    ) -> None:
        self.config = config
        self.fetch_upstream = fetch_upstream
        self.offline_lookup = offline_lookup
        self._lock = asyncio.Lock()
        self._rate_lock = asyncio.Lock()
        self._next_request_at = 0.0
        self._cache: OrderedDict[str, tuple[float, dict[str, Any] | None]] = OrderedDict()
        self._inflight: dict[str, asyncio.Task[dict[str, Any] | None]] = {}

    @staticmethod
    def _key(request: ReverseRequest) -> str:
        return f"{request.latitude:.5f},{request.longitude:.5f}"

    async def _clear_inflight(
        self,
        key: str,
        task: asyncio.Task[dict[str, Any] | None],
    ) -> None:
        async with self._lock:
            if self._inflight.get(key) is task:
                self._inflight.pop(key, None)

    async def _reserve_upstream_slot(self) -> None:
        # Reserve only the request start time. Do not hold the cache lock while
        # sleeping or waiting on the provider; unrelated coordinates can run
        # concurrently while the provider's global rate remains bounded.
        async with self._rate_lock:
            delay = max(0.0, self._next_request_at - monotonic())
            if delay:
                await asyncio.sleep(delay)
            self._next_request_at = monotonic() + self.config.min_interval_seconds

    async def _resolve_uncached(self, key: str, request: ReverseRequest) -> dict[str, Any] | None:
        normalized: dict[str, Any] | None = None
        if self.config.external_enabled:
            await self._reserve_upstream_slot()
            try:
                payload = await self.fetch_upstream(self.config, {
                    "lat": f"{request.latitude:.7f}",
                    "lon": f"{request.longitude:.7f}",
                    "format": "jsonv2",
                    "addressdetails": "1",
                    "zoom": "18",
                })
                normalized = normalize_nominatim(payload)
                # A successful HTTP status is not a usable address contract.
                # Do not cache or expose an empty 200 response: callers need a
                # stable failure so they can retain their coordinate fallback.
                if normalized is None and not self.config.offline_city_enabled:
                    raise HTTPException(status_code=502, detail="地址服务返回了无效结果")
            except Exception as exc:
                if isinstance(exc, HTTPException):
                    raise
                if not self.config.offline_city_enabled:
                    raise HTTPException(status_code=502, detail="地址服务暂时不可用") from exc
        if normalized is None and self.config.offline_city_enabled:
            try:
                normalized = self.offline_lookup(request.latitude, request.longitude)
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail="离线城市地址依赖未安装") from exc
            except Exception as exc:
                raise HTTPException(status_code=503, detail="离线城市地址服务暂时不可用") from exc
        if normalized is None and not self.config.external_enabled:
            raise HTTPException(status_code=503, detail="地址服务尚未配置")
        async with self._lock:
            if self.config.cache_size > 0:
                self._cache[key] = (monotonic(), normalized)
                self._cache.move_to_end(key)
                while len(self._cache) > self.config.cache_size:
                    self._cache.popitem(last=False)
        return normalized

    async def reverse(self, request: ReverseRequest) -> dict[str, Any]:
        if not self.config.enabled:
            raise HTTPException(status_code=503, detail="地址服务尚未配置")
        key = self._key(request)
        now = monotonic()
        async with self._lock:
            cached = self._cache.get(key)
            if cached and (self.config.cache_ttl_seconds <= 0 or now - cached[0] <= self.config.cache_ttl_seconds):
                self._cache.move_to_end(key)
                return cached[1] or {"schema_version": 1, "provider": "nominatim-proxy", "address_parts": []}
            if cached:
                self._cache.pop(key, None)
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.create_task(self._resolve_uncached(key, request))
                self._inflight[key] = task
                task.add_done_callback(
                    lambda completed, cache_key=key: asyncio.create_task(
                        self._clear_inflight(cache_key, completed),
                    ),
                )
        # A disconnected client must not cancel a provider request shared by
        # other callers. The completed task clears its own single-flight slot.
        normalized = await asyncio.shield(task)
        return normalized or {"schema_version": 1, "provider": "nominatim-proxy", "address_parts": []}

    def health(self) -> dict[str, Any]:
        host = urlparse(self.config.upstream_url).hostname if self.config.upstream_url else None
        return {
            "enabled": self.config.enabled,
            "provider": self.config.provider_name,
            "upstream_host": host,
            "external_provider_configured": self.config.external_enabled,
            "offline_city_enabled": self.config.offline_city_enabled,
            "offline_city_available": (
                offline_city_available() if self.config.offline_city_enabled else False
            ),
            "cache_entries": len(self._cache),
            "inflight_requests": len(self._inflight),
            "min_interval_seconds": self.config.min_interval_seconds,
        }


def create_app(proxy: ReverseGeocoderProxy | None = None) -> FastAPI:
    active_proxy = proxy or ReverseGeocoderProxy(load_config())
    service = FastAPI(title="LaoJi reverse geocoder proxy", version="1.0")

    @service.get("/health")
    async def health() -> dict[str, Any]:
        return active_proxy.health()

    @service.get("/ready")
    async def ready() -> dict[str, Any]:
        if not active_proxy.config.enabled:
            raise HTTPException(status_code=503, detail="地址服务尚未配置")
        health = active_proxy.health()
        if active_proxy.config.offline_city_enabled and not active_proxy.config.external_enabled:
            if not health["offline_city_available"]:
                raise HTTPException(status_code=503, detail="离线城市地址依赖未安装")
        return {"status": "ready", **health}

    @service.post("/reverse")
    async def reverse(request: ReverseRequest) -> dict[str, Any]:
        return await active_proxy.reverse(request)

    return service


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "server:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8079")),
        log_level="info",
    )
