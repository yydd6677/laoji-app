# SVC-00 Ollama priority broker (G1)

This directory contains an isolated, dependency-free prototype for sharing one
Ollama generation lane across the meeting and LaoJi candidate services. It does
not install, deploy, restart, or reconfigure any service by itself.

## Scope and safety

- The broker and its upstream must bind to loopback. The prototype has no
  remote-listen override.
- It forwards only `POST /api/chat` and `POST /api/generate` over HTTP/1.1.
- It never calls the upstream during startup or health checks.
- Defaults are candidate-only ports `28434` and `28435`. The upstream is a
  required command-line argument, so starting the file without an explicit
  candidate choice cannot contact the shared runner.
- No third-party Python package is required. The core and tests use APIs
  available on Linux and Windows.

The implementation deliberately does not include deployment units, TLS,
authentication, durable jobs, retries, model management, or `/api/embed`.
Those are outside the G1 scheduler question.

Shutdown uses a bounded drain when the command-line process receives SIGINT or
SIGTERM: listeners stop accepting new connections, queued jobs are cancelled,
and running requests get the drain window to finish. The current command-line
default is a five-second window; requests still running after it are cancelled
with the same best-effort upstream socket close used by explicit cancellation.
The Python API also exposes `BrokerServer.drain(timeout=...)` for an owned
service unit. `BrokerServer.close()` remains the immediate-cancel API used by
tests and callers that need a hard stop.

## Shared queue and priority contract

One process owns one `PriorityScheduler`, even when it listens on multiple
ports. Every listener therefore contributes to the same concurrency limit and
the same bounded queue.

Priority is resolved in this order:

1. `X-Laoji-Priority: interactive|background` request header;
2. `/interactive/api/chat`, `/background/api/chat`, and equivalent generate
   paths;
3. the listener's default priority.

Interactive work runs before ordinary background work. Once the oldest
background item reaches `--background-aging-seconds`, it gets the next slot.
When both queues remain non-empty and multiple background items have aged, the
broker alternates an aged background dispatch with an interactive dispatch.
This prevents permanent background starvation while preserving interactive
progress. The guarantee assumes finite upstream calls; the broker cannot
preempt an Ollama call that never finishes.

`--max-queue` is a strict bound on waiting jobs across both priorities. At most
`--concurrency` additional jobs can be running, and no more than
`--max-active-background` of them may be background jobs. When the background
limit is reached, another worker remains available for queued or newly arriving
interactive work. The background limit defaults to the total concurrency, which
preserves the original behavior unless it is explicitly lowered. A full queue
returns HTTP 429 with `Retry-After: 1`; it is not silently expanded.

The reservation is a broker admission rule, not an upstream capacity setting.
For the SVC-00A candidate, pair `--concurrency 2 --max-active-background 1`
with an owned Ollama candidate that can actually run two requests concurrently,
then verify memory, output quality, and queue time. Pointing two broker workers
at a serial upstream only moves the queue and does not reserve compute capacity.

## Current client integration

The inspected candidate uses a shared `meetingsummary.ollama_client` and sends
synchronous, non-streaming `requests.post(... /api/chat)` calls for schedule
parsing, meeting questions, and summary generation. The overlay now accepts a
validated `priority` and `telemetry_operation`: question calls send
`X-Laoji-Priority: interactive`, while summary/Map-Reduce calls send
`X-Laoji-Priority: background`; operation labels are sent as
`X-Laoji-Operation`. Calls without a priority remain header-compatible. Its
URL construction accepts a path-bearing base URL, so no client-library change
is required for an isolated trial:

```text
OLLAMA_BASE_URL=http://127.0.0.1:28434/interactive
```

The shared candidate client also accepts the opt-in environment variable
`LAOJI_BROKER_QUEUE_DEADLINE_MS`. When set to a bounded integer, it adds
`X-Laoji-Queue-Deadline-Ms` to labeled calls and rejects an invalid value before
HTTP. It is unset by default, so existing direct-Ollama behavior is unchanged.

Compact summary generation runs in the worker process, while the full pipeline
runs in a subprocess. The compact override is deliberately applied only in
`_compact_model_config`: meeting questions import the shared `_load_config` and
must remain interactive. To route both summary forms to the background entry,
apply the small two-site candidate override in
`candidate-overrides/summary-background-route.patch`, then configure either:

```text
SUMMARY_OLLAMA_BASE_URL=http://127.0.0.1:28435
```

or the same physical listener with a path entry:

```text
SUMMARY_OLLAMA_BASE_URL=http://127.0.0.1:28434/background
```

Both forms still use the broker's single shared queue. The patch is reference
material only and has not been applied to a remote service.

The broker forwards the operation label to the owned upstream while always
overwriting the priority with the scheduler's resolved priority. Schedule and
question operations should send `interactive`; summary passes should send
`background`.

## Run an isolated instance

Point the upstream at an owned fake or candidate Ollama port, not at a service
port:

```text
python3 tools/ollama-priority-broker/broker.py \
  --upstream http://127.0.0.1:28433 \
  --listen 127.0.0.1:28434=interactive \
  --listen 127.0.0.1:28435=background \
  --concurrency 2 \
  --max-active-background 1 \
  --max-queue 64 \
  --background-aging-seconds 15 \
  --upstream-header-timeout 300
```

The CLI accepts bracketed loopback IPv6 listeners such as
`[::1]:28434=interactive`. It does not use Unix signals as its only shutdown
path, so `Ctrl+C` also works on Windows event loops without signal handlers.

`--header-timeout` limits how long a client may take to send request headers.
`--upstream-header-timeout` is separate because Ollama's non-streaming API does
not send response headers until generation finishes; its default is 300 seconds.

## Cancellation

Queued requests are removed when their client disconnects. They can also be
cancelled from a second connection when the original request supplied a stable
`X-Request-ID`:

```text
DELETE /_broker/requests/<request-id>
```

The cancellation endpoint returns 202 with `state=queued|running`, or 404 if
the ID is not active. A still-connected queued caller receives HTTP 499 and the
cancelled request never reaches Ollama.

For a running request, explicit cancellation or client disconnect closes the
upstream TCP connection as soon as the broker observes it. This is best effort:
Ollama may continue generation briefly after its client socket closes, and a
response that has already started cannot be replaced with a JSON cancellation
response.

## Streaming and response telemetry

The broker preserves upstream status, end-to-end response headers, and body
bytes. Chunked upstream bodies are decoded and re-chunked, so HTTP chunk
boundaries may differ while Ollama NDJSON bytes and ordering remain unchanged.
Content-Length responses retain their exact body and length. Each connection
handles one request and closes after the response.

Every proxied response adds:

- `Server-Timing: queue_wait;dur=<milliseconds>`;
- `X-Laoji-Queue-Wait-Ms`;
- `X-Laoji-Broker-Priority`;
- `X-Laoji-Broker-Request-ID` and `X-Request-ID`.

An optional `X-Laoji-Queue-Deadline-Ms` request header bounds only the time a
job may remain queued. It accepts `1..600000` milliseconds. When the budget is
exceeded before dispatch, the broker returns HTTP 408 with
`queue_deadline_exceeded` and never contacts the upstream. The expiry watcher
runs independently of workers, so a long generation cannot postpone this
admission decision. The header is deliberately opt-in; callers that do not
send it keep the original unbounded queue-wait behavior (subject to
`--max-queue`). This is a candidate contract, not a production SLO claim.

`queue_wait` is measured exactly from successful enqueue to worker dispatch.
Any upstream `Server-Timing` value is retained as an additional header. Final
upstream elapsed time is emitted in privacy-safe structured logs because it is
not known when streaming response headers are sent.

`GET /_broker/health` returns queue depth, total and per-priority running counts,
the configured total/background concurrency limits, scheduler settings, and
aggregate completion/rejection/cancellation counters. Request bodies are never
logged.

## Focused tests

```text
python3 -m unittest -v tools/ollama-priority-broker/test_broker.py
```

The tests start only ephemeral loopback fake servers. They cover:

- priority ordering across two listeners sharing one queue;
- background aging;
- reserved interactive capacity while the background limit is full;
- background aging after reserved-capacity contention;
- total/per-priority health counters before and after work completes;
- shutdown cancellation of running and capacity-blocked queued work;
- strict queue rejection;
- explicit cancellation and queued-client disconnect without upstream contact;
- running-client disconnect closing the upstream connection;
- both streaming and non-streaming `/api/chat` and `/api/generate` forwarding;
- an upstream disconnect before response headers mapping to HTTP 502;
- path and header priority overrides plus queue timing headers.
- optional queued-request deadlines, including expiry while every worker is
  occupied and strict invalid-header rejection.
- bounded graceful drain: queued work is rejected without upstream contact,
  running work is allowed to finish, and the timeout path cancels it.

## Known G1 boundaries

- State and cancellation IDs are process-local and non-durable.
- There is no request replay or retry; retrying generation automatically can
  duplicate expensive or non-idempotent work.
- Uploads require `Content-Length`; chunked request bodies are rejected.
- Slow clients can occupy a worker while the broker streams their response.
- Queue fairness is deterministic, but it is not a token/context budgeter.
- Reserved broker capacity cannot create upstream parallelism; the owned Ollama
  candidate needs a separately verified parallel configuration.
- Graceful drain only protects work while the upstream responds before the
  configured window; it cannot guarantee completion for a stuck model process.
- Queue deadlines bound admission wait only; they do not interrupt a request
  after it has been dispatched to Ollama.
- Closing an upstream socket is not proof that Ollama stopped GPU work. A later
  G3 trial must measure that behavior on the owned candidate runner.
- This prototype establishes the scheduling mechanism, not the SVC-00 latency,
  OOM, quality, shadow, or release gates.
