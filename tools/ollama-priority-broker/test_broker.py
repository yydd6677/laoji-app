#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parent))

from broker import (  # noqa: E402
    BrokerServer,
    HttpError,
    ListenerSpec,
    OllamaProxy,
    PriorityScheduler,
    build_parser,
    parse_queue_deadline,
    read_request,
)


async def _send_response(
    writer: asyncio.StreamWriter,
    body: bytes,
    *,
    chunked: bool = False,
) -> None:
    if chunked:
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/x-ndjson\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"Server-Timing: inference;dur=7\r\n"
            b"Connection: close\r\n\r\n"
        )
        split = max(1, len(body) // 2)
        for part in (body[:split], body[split:]):
            if not part:
                continue
            writer.write(f"{len(part):X}\r\n".encode("ascii") + part + b"\r\n")
            await writer.drain()
            await asyncio.sleep(0.005)
        writer.write(b"0\r\n\r\n")
    else:
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n".encode("ascii")
            + b"Server-Timing: inference;dur=5\r\n"
            + b"Connection: close\r\n\r\n"
            + body
        )
    await writer.drain()


class FakeOllama:
    def __init__(self) -> None:
        self.server: asyncio.AbstractServer | None = None
        self.port = 0
        self.started_order: list[str] = []
        self.paths: dict[str, str] = {}
        self.request_headers: dict[str, dict[str, str]] = {}
        self.started: dict[str, asyncio.Event] = {}
        self.releases: dict[str, asyncio.Event] = {}
        self.upstream_closed: dict[str, asyncio.Event] = {}
        self.connections: set[asyncio.StreamWriter] = set()

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        assert self.server.sockets
        self.port = int(self.server.sockets[0].getsockname()[1])

    def event_for(self, mapping: dict[str, asyncio.Event], request_id: str) -> asyncio.Event:
        return mapping.setdefault(request_id, asyncio.Event())

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections.add(writer)
        try:
            request = await read_request(reader, max_body_bytes=1024 * 1024, header_timeout=2)
            payload = json.loads(request.body)
            request_id = str(payload.get("request_id"))
            self.started_order.append(request_id)
            self.paths[request_id] = request.target
            self.request_headers[request_id] = request.headers
            self.event_for(self.started, request_id).set()
            mode = payload.get("mode")
            if mode == "gate":
                await self.event_for(self.releases, request_id).wait()
            elif mode == "slow_headers":
                await asyncio.sleep(0.1)
            elif mode == "wait_for_disconnect":
                await reader.read()
                self.event_for(self.upstream_closed, request_id).set()
                return
            elif mode == "drop_before_headers":
                return
            if request.target.endswith("/api/chat"):
                if payload.get("stream"):
                    body = b'{"message":{"content":"a"},"done":false}\n{"done":true}\n'
                    await _send_response(writer, body, chunked=True)
                else:
                    body = json.dumps(
                        {"message": {"content": f"chat-{request_id}"}, "done": True},
                        separators=(",", ":"),
                    ).encode()
                    await _send_response(writer, body)
            elif payload.get("stream"):
                body = b'{"response":"a","done":false}\n{"done":true}\n'
                await _send_response(writer, body, chunked=True)
            else:
                body = json.dumps(
                    {"response": f"generate-{request_id}", "done": True},
                    separators=(",", ":"),
                ).encode()
                await _send_response(writer, body)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            self.connections.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        for writer in list(self.connections):
            writer.close()
        await asyncio.gather(
            *(writer.wait_closed() for writer in list(self.connections)),
            return_exceptions=True,
        )


async def _read_chunked(reader: asyncio.StreamReader) -> bytes:
    chunks: list[bytes] = []
    while True:
        line = await reader.readline()
        size = int(line.split(b";", 1)[0].strip(), 16)
        if size == 0:
            await reader.readline()
            return b"".join(chunks)
        chunks.append(await reader.readexactly(size))
        if await reader.readexactly(2) != b"\r\n":
            raise AssertionError("invalid chunk terminator")


async def http_request(
    port: int,
    method: str,
    path: str,
    *,
    payload: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    body = (
        json.dumps(payload, separators=(",", ":")).encode()
        if payload is not None
        else b""
    )
    request_headers = {
        "Host": f"127.0.0.1:{port}",
        "Connection": "close",
        "Content-Length": str(len(body)),
        "Content-Type": "application/json",
        **(headers or {}),
    }
    writer.write(f"{method} {path} HTTP/1.1\r\n".encode("ascii"))
    for name, value in request_headers.items():
        writer.write(f"{name}: {value}\r\n".encode("iso-8859-1"))
    writer.write(b"\r\n" + body)
    await writer.drain()
    raw_head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=3)
    lines = raw_head[:-4].decode("iso-8859-1").split("\r\n")
    status = int(lines[0].split(" ", 2)[1])
    response_headers: dict[str, str] = {}
    for line in lines[1:]:
        name, value = line.split(":", 1)
        lowered = name.lower()
        cleaned = value.strip()
        response_headers[lowered] = (
            f"{response_headers[lowered]}, {cleaned}"
            if lowered in response_headers
            else cleaned
        )
    if "chunked" in response_headers.get("transfer-encoding", "").lower():
        response_body = await _read_chunked(reader)
    elif "content-length" in response_headers:
        response_body = await reader.readexactly(int(response_headers["content-length"]))
    else:
        response_body = await reader.read()
    writer.close()
    await writer.wait_closed()
    return status, response_headers, response_body


class BrokerIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fake = FakeOllama()
        await self.fake.start()
        self.broker: BrokerServer | None = None
        self.interactive_port = 0
        self.background_port = 0

    async def asyncTearDown(self) -> None:
        if self.broker is not None:
            await self.broker.close()
        await self.fake.close()

    async def start_broker(
        self,
        *,
        concurrency: int = 1,
        max_active_background: int | None = None,
        max_queue: int = 8,
        aging: float = 1.0,
        upstream_header_timeout: float = 2.0,
    ) -> None:
        self.broker = BrokerServer(
            [
                ListenerSpec("127.0.0.1", 0, "interactive"),
                ListenerSpec("127.0.0.1", 0, "background"),
            ],
            OllamaProxy(
                f"http://127.0.0.1:{self.fake.port}",
                header_timeout=upstream_header_timeout,
            ),
            concurrency=concurrency,
            max_active_background=max_active_background,
            max_queue=max_queue,
            background_aging_seconds=aging,
            header_timeout=2,
        )
        bound = await self.broker.start()
        self.interactive_port = bound[0].port
        self.background_port = bound[1].port

    async def wait_for_queue(self, priority: str, count: int) -> None:
        assert self.broker is not None
        for _ in range(100):
            snapshot = await self.broker.scheduler.snapshot()
            if snapshot["queued"][priority] == count:  # type: ignore[index]
                return
            await asyncio.sleep(0.005)
        self.fail(f"queue {priority} did not reach {count}")

    async def test_interactive_overtakes_background_across_two_listeners(self) -> None:
        await self.start_broker()
        gate = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "gate", "mode": "gate", "stream": False},
        ))
        await self.fake.event_for(self.fake.started, "gate").wait()
        background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "background", "stream": False},
        ))
        await self.wait_for_queue("background", 1)
        interactive = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "interactive", "stream": False},
        ))
        await self.wait_for_queue("interactive", 1)
        self.fake.event_for(self.fake.releases, "gate").set()
        results = await asyncio.gather(gate, background, interactive)
        self.assertTrue(all(result[0] == 200 for result in results))
        self.assertEqual(self.fake.started_order, ["gate", "interactive", "background"])

    async def test_aged_background_gets_a_turn_before_interactive(self) -> None:
        await self.start_broker(aging=0.04)
        gate = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "gate", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "gate").wait()
        background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "aged", "stream": False},
        ))
        await self.wait_for_queue("background", 1)
        background_two = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "aged-two", "stream": False},
        ))
        await self.wait_for_queue("background", 2)
        interactive = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "new-interactive", "stream": False},
        ))
        await self.wait_for_queue("interactive", 1)
        interactive_two = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "new-interactive-two", "stream": False},
        ))
        await self.wait_for_queue("interactive", 2)
        await asyncio.sleep(0.06)
        self.fake.event_for(self.fake.releases, "gate").set()
        await asyncio.gather(
            gate,
            background,
            background_two,
            interactive,
            interactive_two,
        )
        self.assertEqual(
            self.fake.started_order,
            ["gate", "aged", "new-interactive", "aged-two", "new-interactive-two"],
        )

    async def test_background_limit_reserves_capacity_for_interactive(self) -> None:
        await self.start_broker(concurrency=2, max_active_background=1)
        first_background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "background-gate", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "background-gate").wait()

        second_background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "background-queued"},
        ))
        await self.wait_for_queue("background", 1)
        self.assertNotIn("background-queued", self.fake.started_order)

        interactive = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "interactive-gate", "mode": "gate"},
        ))
        await asyncio.wait_for(
            self.fake.event_for(self.fake.started, "interactive-gate").wait(),
            timeout=1,
        )

        health_status, _, health_body = await http_request(
            self.interactive_port,
            "GET",
            "/_broker/health",
        )
        self.assertEqual(health_status, 200)
        health = json.loads(health_body)
        self.assertEqual(health["concurrency"], 2)
        self.assertEqual(health["max_active_background"], 1)
        self.assertEqual(health["running"], 2)
        self.assertEqual(
            health["running_by_priority"],
            {"interactive": 1, "background": 1},
        )
        self.assertEqual(health["queued"], {"interactive": 0, "background": 1})

        self.fake.event_for(self.fake.releases, "interactive-gate").set()
        await interactive
        await asyncio.sleep(0.02)
        self.assertNotIn("background-queued", self.fake.started_order)

        self.fake.event_for(self.fake.releases, "background-gate").set()
        await asyncio.gather(first_background, second_background)
        self.assertEqual(
            self.fake.started_order,
            ["background-gate", "interactive-gate", "background-queued"],
        )
        final_snapshot = await self.broker.scheduler.snapshot()
        self.assertEqual(final_snapshot["running"], 0)
        self.assertEqual(
            final_snapshot["running_by_priority"],
            {"interactive": 0, "background": 0},
        )
        self.assertEqual(final_snapshot["counters"]["completed"], 3)

    async def test_aged_background_keeps_fair_turn_with_reserved_capacity(self) -> None:
        await self.start_broker(
            concurrency=2,
            max_active_background=1,
            aging=0.04,
        )
        first_gate = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "interactive-gate-one", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "interactive-gate-one").wait()
        second_gate = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "interactive-gate-two", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "interactive-gate-two").wait()

        aged_background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "aged-background"},
        ))
        await self.wait_for_queue("background", 1)
        queued_interactive = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "queued-interactive"},
        ))
        await self.wait_for_queue("interactive", 1)
        await asyncio.sleep(0.06)

        self.fake.event_for(self.fake.releases, "interactive-gate-one").set()
        await asyncio.wait_for(
            self.fake.event_for(self.fake.started, "aged-background").wait(),
            timeout=1,
        )
        await asyncio.wait_for(
            self.fake.event_for(self.fake.started, "queued-interactive").wait(),
            timeout=1,
        )
        self.assertLess(
            self.fake.started_order.index("aged-background"),
            self.fake.started_order.index("queued-interactive"),
        )

        self.fake.event_for(self.fake.releases, "interactive-gate-two").set()
        await asyncio.gather(
            first_gate,
            second_gate,
            aged_background,
            queued_interactive,
        )

    async def test_shutdown_cancels_reserved_running_and_queued_work_cleanly(self) -> None:
        await self.start_broker(concurrency=2, max_active_background=1)
        running_background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={
                "request_id": "shutdown-background",
                "mode": "wait_for_disconnect",
            },
        ))
        await self.fake.event_for(self.fake.started, "shutdown-background").wait()
        queued_background = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "shutdown-queued"},
        ))
        await self.wait_for_queue("background", 1)
        running_interactive = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={
                "request_id": "shutdown-interactive",
                "mode": "wait_for_disconnect",
            },
        ))
        await self.fake.event_for(self.fake.started, "shutdown-interactive").wait()

        assert self.broker is not None
        await self.broker.close()
        responses = await asyncio.gather(
            running_background,
            queued_background,
            running_interactive,
        )
        self.assertEqual([response[0] for response in responses], [499, 499, 499])
        self.assertNotIn("shutdown-queued", self.fake.started_order)

        snapshot = await self.broker.scheduler.snapshot()
        self.assertEqual(snapshot["status"], "stopping")
        self.assertEqual(snapshot["running"], 0)
        self.assertEqual(
            snapshot["running_by_priority"],
            {"interactive": 0, "background": 0},
        )
        self.assertEqual(snapshot["queued"], {"interactive": 0, "background": 0})
        self.assertEqual(snapshot["counters"]["cancelled_running"], 2)
        self.assertEqual(snapshot["counters"]["cancelled_queued"], 1)
        self.assertEqual(snapshot["counters"]["completed"], 0)
        self.assertEqual(snapshot["counters"]["failed"], 0)

    async def test_graceful_drain_keeps_running_request_and_rejects_queued_work(self) -> None:
        await self.start_broker(concurrency=1)
        running = asyncio.create_task(http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "drain-running", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "drain-running").wait()
        queued = asyncio.create_task(http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "drain-queued"},
        ))
        await self.wait_for_queue("interactive", 1)

        assert self.broker is not None
        drain_task = asyncio.create_task(self.broker.drain(timeout=0.5))
        queued_result = await queued
        self.assertEqual(queued_result[0], 499)
        await asyncio.sleep(0.02)
        self.assertFalse(running.done())

        self.fake.event_for(self.fake.releases, "drain-running").set()
        running_result = await running
        await drain_task
        self.assertEqual(running_result[0], 200)
        snapshot = await self.broker.scheduler.snapshot()
        self.assertTrue(snapshot["draining"])
        self.assertEqual(snapshot["counters"]["completed"], 1)
        self.assertEqual(snapshot["counters"]["cancelled_queued"], 1)
        self.assertEqual(snapshot["counters"]["cancelled_running"], 0)

    async def test_graceful_drain_cancels_running_request_after_timeout(self) -> None:
        await self.start_broker(concurrency=1)
        running = asyncio.create_task(http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "drain-timeout", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "drain-timeout").wait()

        assert self.broker is not None
        await self.broker.drain(timeout=0.02)
        result = await running
        self.assertEqual(result[0], 499)
        snapshot = await self.broker.scheduler.snapshot()
        self.assertEqual(snapshot["counters"]["cancelled_running"], 1)
        self.fake.event_for(self.fake.releases, "drain-timeout").set()

    async def test_queue_bound_rejects_without_contacting_upstream(self) -> None:
        await self.start_broker(max_queue=1)
        gate = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "gate", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "gate").wait()
        queued = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "queued"},
        ))
        await self.wait_for_queue("interactive", 1)
        rejected = await http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "rejected"},
        )
        self.assertEqual(rejected[0], 429)
        self.assertEqual(json.loads(rejected[2])["error"], "queue_full")
        self.fake.event_for(self.fake.releases, "gate").set()
        await asyncio.gather(gate, queued)
        self.assertNotIn("rejected", self.fake.started_order)

    async def test_explicit_queued_cancellation_never_reaches_upstream(self) -> None:
        await self.start_broker()
        gate = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "gate", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "gate").wait()
        cancelled = asyncio.create_task(http_request(
            self.background_port, "POST", "/api/chat",
            payload={"request_id": "cancel-me"},
            headers={"X-Request-ID": "cancel-me"},
        ))
        await self.wait_for_queue("background", 1)
        cancel_response = await http_request(
            self.interactive_port,
            "DELETE",
            "/_broker/requests/cancel-me",
        )
        self.assertEqual(cancel_response[0], 202)
        cancelled_response = await cancelled
        self.assertEqual(cancelled_response[0], 499)
        self.fake.event_for(self.fake.releases, "gate").set()
        await gate
        self.assertNotIn("cancel-me", self.fake.started_order)

    async def test_queued_request_deadline_expires_while_worker_is_busy(self) -> None:
        await self.start_broker()
        gate = asyncio.create_task(http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "deadline-gate", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "deadline-gate").wait()
        expired = asyncio.create_task(http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "deadline-expired"},
            headers={"X-Laoji-Queue-Deadline-Ms": "30"},
        ))
        await asyncio.sleep(0.08)
        status, headers, body = await asyncio.wait_for(expired, timeout=1)
        self.assertEqual(status, 408)
        self.assertEqual(json.loads(body)["error"], "queue_deadline_exceeded")
        self.assertIn("queue_wait", headers["server-timing"])
        self.assertNotIn("deadline-expired", self.fake.started_order)
        self.fake.event_for(self.fake.releases, "deadline-gate").set()
        await gate
        assert self.broker is not None
        snapshot = await self.broker.scheduler.snapshot()
        self.assertEqual(snapshot["counters"]["expired_queued"], 1)

    async def test_queue_deadline_is_optional_and_valid_request_still_dispatches(self) -> None:
        await self.start_broker()
        status, _, body = await http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "no-deadline"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["message"]["content"], "chat-no-deadline")
        status, _, body = await http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "valid-deadline"},
            headers={"X-Laoji-Queue-Deadline-Ms": "2000"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["message"]["content"], "chat-valid-deadline")

    async def test_invalid_queue_deadline_is_rejected_before_upstream(self) -> None:
        await self.start_broker()
        for value in ("0", "600001", "2.5", "-1"):
            with self.subTest(value=value):
                status, _, body = await http_request(
                    self.interactive_port,
                    "POST",
                    "/api/chat",
                    payload={"request_id": f"invalid-{value}"},
                    headers={"X-Laoji-Queue-Deadline-Ms": value},
                )
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(body)["error"], "invalid_queue_deadline")
        self.assertEqual(self.fake.started_order, [])

    async def test_running_client_disconnect_closes_upstream(self) -> None:
        await self.start_broker()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.interactive_port)
        body = b'{"request_id":"disconnect","mode":"wait_for_disconnect"}'
        writer.write(
            b"POST /api/chat HTTP/1.1\r\n"
            + f"Host: 127.0.0.1:{self.interactive_port}\r\n".encode()
            + b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"Connection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        await self.fake.event_for(self.fake.started, "disconnect").wait()
        writer.close()
        await writer.wait_closed()
        await asyncio.wait_for(
            self.fake.event_for(self.fake.upstream_closed, "disconnect").wait(),
            timeout=1,
        )
        del reader

    async def test_queued_client_disconnect_removes_job_before_upstream(self) -> None:
        await self.start_broker()
        gate = asyncio.create_task(http_request(
            self.interactive_port, "POST", "/api/chat",
            payload={"request_id": "gate", "mode": "gate"},
        ))
        await self.fake.event_for(self.fake.started, "gate").wait()
        reader, writer = await asyncio.open_connection("127.0.0.1", self.background_port)
        body = b'{"request_id":"disconnect-queued"}'
        writer.write(
            b"POST /api/chat HTTP/1.1\r\n"
            + f"Host: 127.0.0.1:{self.background_port}\r\n".encode()
            + b"Content-Type: application/json\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"Connection: close\r\n\r\n"
            + body
        )
        await writer.drain()
        await self.wait_for_queue("background", 1)
        writer.close()
        await writer.wait_closed()
        await self.wait_for_queue("background", 0)
        self.fake.event_for(self.fake.releases, "gate").set()
        await gate
        self.assertNotIn("disconnect-queued", self.fake.started_order)
        del reader

    async def test_chat_stream_and_generate_nonstream_are_preserved(self) -> None:
        await self.start_broker()
        stream_status, stream_headers, stream_body = await http_request(
            self.background_port,
            "POST",
            "/interactive/api/chat",
            payload={"request_id": "stream", "stream": True},
        )
        self.assertEqual(stream_status, 200)
        self.assertEqual(
            stream_body,
            b'{"message":{"content":"a"},"done":false}\n{"done":true}\n',
        )
        self.assertEqual(stream_headers["x-laoji-broker-priority"], "interactive")
        self.assertIn("queue_wait", stream_headers["server-timing"])
        self.assertIn("inference", stream_headers["server-timing"])

        status, headers, body = await http_request(
            self.background_port,
            "POST",
            "/api/generate",
            payload={"request_id": "generate", "stream": False},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["response"], "generate-generate")
        self.assertEqual(headers["x-laoji-broker-priority"], "background")
        self.assertEqual(self.fake.paths["generate"], "/api/generate")

        chat_status, _, chat_body = await http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "chat-nonstream", "stream": False},
        )
        self.assertEqual(chat_status, 200)
        self.assertEqual(json.loads(chat_body)["message"]["content"], "chat-chat-nonstream")

        generate_status, _, generate_body = await http_request(
            self.background_port,
            "POST",
            "/api/generate",
            payload={"request_id": "generate-stream", "stream": True},
        )
        self.assertEqual(generate_status, 200)
        self.assertEqual(
            generate_body,
            b'{"response":"a","done":false}\n{"done":true}\n',
        )

    async def test_header_priority_overrides_listener_and_path(self) -> None:
        await self.start_broker()
        status, headers, _ = await http_request(
            self.background_port,
            "POST",
            "/background/api/chat",
            payload={"request_id": "override", "stream": False},
            headers={"X-Laoji-Priority": "interactive"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["x-laoji-broker-priority"], "interactive")

    async def test_operation_header_is_forwarded_to_upstream(self) -> None:
        await self.start_broker()
        status, _, _ = await http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "operation", "stream": False},
            headers={"X-Laoji-Operation": "question.general"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            self.fake.request_headers["operation"]["x-laoji-operation"],
            "question.general",
        )

    async def test_upstream_disconnect_before_headers_is_502(self) -> None:
        await self.start_broker()
        status, headers, body = await http_request(
            self.interactive_port,
            "POST",
            "/api/chat",
            payload={"request_id": "upstream-drop", "mode": "drop_before_headers"},
        )
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body)["error"], "upstream_truncated")
        self.assertIn("queue_wait", headers["server-timing"])

    async def test_upstream_header_timeout_cleans_reader_task_and_counts_failure(self) -> None:
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()
        unhandled: list[dict[str, object]] = []
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
        try:
            await self.start_broker(upstream_header_timeout=0.02)
            status, _headers, body = await http_request(
                self.background_port,
                "POST",
                "/api/chat",
                payload={"request_id": "slow-headers", "mode": "slow_headers"},
            )
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(body)["error"], "upstream_header_timeout")
            await asyncio.sleep(0.05)
            assert self.broker is not None
            snapshot = await self.broker.scheduler.snapshot()
            self.assertEqual(snapshot["counters"]["completed"], 0)
            self.assertEqual(snapshot["counters"]["failed"], 1)
            self.assertFalse(any(
                "Task exception was never retrieved" in str(item.get("message") or "")
                for item in unhandled
            ))
        finally:
            loop.set_exception_handler(previous_handler)


class BrokerConfigurationTests(unittest.TestCase):
    @staticmethod
    async def worker(_job) -> None:
        return None

    def test_background_limit_defaults_to_total_concurrency(self) -> None:
        scheduler = PriorityScheduler(
            self.worker,
            concurrency=3,
            max_queue=8,
            background_aging_seconds=1,
        )
        self.assertEqual(scheduler.max_active_background, 3)

    def test_background_limit_must_fit_total_concurrency(self) -> None:
        for invalid in (0, 3):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "max_active_background"):
                    PriorityScheduler(
                        self.worker,
                        concurrency=2,
                        max_active_background=invalid,
                        max_queue=8,
                        background_aging_seconds=1,
                    )

    def test_cli_accepts_explicit_background_limit(self) -> None:
        args = build_parser().parse_args([
            "--upstream", "http://127.0.0.1:28433",
            "--concurrency", "2",
            "--max-active-background", "1",
        ])
        self.assertEqual(args.concurrency, 2)
        self.assertEqual(args.max_active_background, 1)

    def test_queue_deadline_parser_is_strict_and_bounded(self) -> None:
        self.assertIsNone(parse_queue_deadline(None))
        self.assertEqual(parse_queue_deadline("2000"), 2000)
        for value in ("", "0", "600001", "2.5", "-1"):
            with self.subTest(value=value):
                if value == "":
                    self.assertIsNone(parse_queue_deadline(value))
                else:
                    with self.assertRaises(HttpError):
                        parse_queue_deadline(value)


if __name__ == "__main__":
    unittest.main()
