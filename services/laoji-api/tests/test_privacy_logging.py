from __future__ import annotations

import logging

from app.privacy_logging import (
    UvicornProtocolPrivacyFilter,
    install_uvicorn_protocol_privacy_filter,
)


def _record(message: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="uvicorn.error",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=None,
    )


def test_uvicorn_protocol_filter_rejects_raw_api_paths() -> None:
    privacy_filter = UvicornProtocolPrivacyFilter()

    assert privacy_filter.filter(_record("WebSocket /api/device/v2/realtime/session-secret [accepted]")) is False
    assert privacy_filter.filter(_record("GET /api/device/v2/tasks/task-secret")) is False
    assert privacy_filter.filter(_record("Application startup complete.")) is True
    assert privacy_filter.filter(_record("connection open")) is True


def test_uvicorn_protocol_filter_installation_is_idempotent() -> None:
    logger = logging.getLogger("uvicorn.error")
    original = list(logger.filters)
    try:
        logger.filters = []
        install_uvicorn_protocol_privacy_filter()
        install_uvicorn_protocol_privacy_filter()
        assert sum(isinstance(item, UvicornProtocolPrivacyFilter) for item in logger.filters) == 1
    finally:
        logger.filters = original
