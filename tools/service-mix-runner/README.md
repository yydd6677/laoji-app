# SVC-00 isolated mixed-load runner

This directory contains a narrow measurement runner for the SVC-00 scheduling
candidate. It is intentionally separate from `schedule-quality-v3`: it does not
score schedule semantics, replace archived gates, deploy services, or make a
release decision.

## Safety boundary

- Requests are limited to plain HTTP on `localhost`, `127.0.0.0/8`, or `::1`.
- The only accepted ports are `28000` through `28999`.
- Production ports `18020` and `18035`, and shared model ports `21434` and
  `21436`, are hard rejected. There is no override flag.
- URLs nested in request payloads are checked as well. A manifest cannot use a
  candidate endpoint to pass a production/model URL as downstream configuration.
- `run` additionally requires `--confirm-candidate-run`; validation and self-test
  never contact an external service.
- Reports omit request bodies and headers. Do not put test credentials into a
  committed manifest.

## Workload contracts

The runner models the contracts currently used by the mobile client:

| Kind | Current service shape | What the runner measures |
|---|---|---|
| `rule_schedule` | synchronous `POST /api/laoji/parse` | one request; rule routing must be checked against timing telemetry |
| `model_schedule` | synchronous `POST /api/laoji/parse` | one request; the label alone is not evidence of model use |
| `question` | `POST /api/laoji/meetings/guest-questions` or authenticated meeting route | full request latency and response timing |
| `long_summary` | submit `guest-summary`/account summary task, then poll task status | submit-to-terminal latency and summed timing segments |

For a `model_schedule` request, the report only treats a positive
`Server-Timing: inference;dur=...` (or equivalent `X-Laoji-Timing-*`/JSON timing)
as route evidence. A profile name cannot prove that a request left the rule path.

`poll` supports the existing summary response contract: extract `task_id`, poll a
URL containing `{task_id}`, read `status`, and stop at configured success/failure
states. Dot paths may be used when a candidate wraps these fields.

## Mixed waves and hooks

Each profile controls `count_per_wave`, `arrival_offset_ms`, optional deterministic
`jitter_ms`, request timeout, and priority. The runner can execute:

- isolated samples for a per-kind p95 baseline;
- configurable mixed waves;
- queued future cancellation;
- running HTTP cancellation by closing the active client connection;
- client disconnect by closing the active client connection.

Hook selection is deterministic. `every: 5, offset: 1` targets profile ordinals
`1, 6, 11, ...`; `phases` defaults to `mixed`. Only the first matching hook is
applied to a job.

Queued cancellation measures the runner's client queue, not the server scheduler.
Running cancellation and client disconnect verify client behavior only. They do
not prove that a server-side asynchronous task stopped; candidate task telemetry
must establish that separately.

## Output

The JSON report contains:

- SHA-256 identities for the runner and the exact manifest used for the run;
- p50/p95/p99/max for successful client, dispatch, and completion latency;
- all `Server-Timing` segments, including queue/load/inference/verification;
- HTTP/contract/transport error code counts without response text;
- a stable `X-Request-ID` reused by a job's submit and polling requests, plus any
  trace ID echoed by the candidate;
- requested and observed cancellation/disconnect hooks;
- interactive queue and background completion starvation indicators;
- mixed-versus-isolated p95 degradation by workload kind;
- sanitized per-request records and trace IDs.

If `queue_wait` is absent, server starvation is reported as unmeasured. Total
latency is never silently substituted for queue time.

## Commands

Run the self-contained mock server and safety checks:

```text
python3 tools/service-mix-runner/runner.py self-test
```

Validate a manifest without sending requests:

```text
python3 tools/service-mix-runner/runner.py validate \
  tools/service-mix-runner/manifest.example.json
```

Run only after replacing example fixtures with valid candidate-owned data:

```text
python3 tools/service-mix-runner/runner.py run path/to/private-manifest.json \
  --confirm-candidate-run \
  --json-out path/to/report.json
```

The example manifest demonstrates all four workload shapes, but its IDs,
fingerprints, transcript, and model-route text are placeholders. A 200 response
from that file is not expected and would not be valid quality evidence.
