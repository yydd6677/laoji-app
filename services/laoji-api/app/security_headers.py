"""Response headers for API routes that may contain account or meeting data."""

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class SensitiveApiHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = str(scope.get("path") or "")
        # Device-primary responses contain private meeting/transcript state,
        # while reverse-geocoding responses contain a user's location.  Both
        # must be explicitly non-cacheable at the edge; relying on the
        # provider's current API-cache defaults would make a future rule
        # change capable of serving one device's data to another request.
        sensitive = scope.get("type") == "http" and (
            path.startswith("/api/auth")
            or path.startswith("/api/laoji")
            or path.startswith("/api/device")
            or path.startswith("/api/location")
        )

        async def send_with_headers(message: Message) -> None:
            if sensitive and message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "no-store, max-age=0"
                headers["Pragma"] = "no-cache"
                headers["X-Content-Type-Options"] = "nosniff"
            await send(message)

        await self.app(scope, receive, send_with_headers if sensitive else send)
