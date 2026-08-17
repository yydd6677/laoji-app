from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.security_headers import SensitiveApiHeadersMiddleware


def test_sensitive_api_responses_are_never_cacheable():
    app = FastAPI()
    app.add_middleware(SensitiveApiHeadersMiddleware)

    @app.get("/api/laoji/private")
    def private_route():
        return {"private": True}

    @app.get("/health")
    def health_route():
        return {"status": "ok"}

    client = TestClient(app)
    response = client.get("/api/laoji/private")
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert response.headers["pragma"] == "no-cache"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "cache-control" not in client.get("/health").headers


def test_production_settings_reject_default_secrets_and_wildcard_cors():
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(
            _env_file=None,
            ENV="production",
            SECRET_KEY="change-me-in-production",
            CORS_ORIGINS='["https://app.example.com"]',
        )

    with pytest.raises(ValueError, match="wildcard"):
        Settings(
            _env_file=None,
            ENV="production",
            SECRET_KEY="x" * 32,
            CORS_ORIGINS='["*"]',
        )


def test_production_settings_accept_https_origins_or_no_browser_origins():
    explicit = Settings(
        _env_file=None,
        ENV="production",
        SECRET_KEY="x" * 32,
        CORS_ORIGINS='["https://app.example.com"]',
    )
    native_only = Settings(
        _env_file=None,
        ENV="production",
        SECRET_KEY="y" * 32,
        CORS_ORIGINS="[]",
    )
    assert explicit.ENV == "production"
    assert native_only.CORS_ORIGINS == "[]"
