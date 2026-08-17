# Revision 0023: durable question Slice B contract

- status: `candidate; not adopted`
- parent: `0022-single-generation-kernel-thin-summary-bridge-20260817`
- candidate: `/home/yydd/LaoJi-candidates/meeting-question-slice-b-0019`
- production mutation: `none`

## Decision

The independently audited Slice A kernel remains the single task/attempt owner.
Meeting question work is no longer allowed to enter the summary compatibility
adapter. A dedicated `meeting.question.v1` capability projects the same kernel
into three durable device operations:

```text
POST   /api/device/v1/meetings/{binding_id}/question-tasks
GET    /api/device/v1/meetings/{binding_id}/question-tasks/{task_id}
DELETE /api/device/v1/meetings/{binding_id}/question-tasks/{task_id}
```

The isolated candidate is framework-neutral. It proves route semantics and
persistence contracts, not FastAPI or production ORM wiring.

## Active generation ownership

`generation_tasks_v1.active_slot_key` is a nullable immutable field. A partial
unique index covers `(capability, scope, epoch, subject, active_slot_key)` only
for `queued/running/retry_wait` tasks. Question tasks derive the key from
`thread + ordinal`; request ID and intent generation remain permanent logical
identity.

This allows a cancelled or terminal generation to be followed by another
generation while preventing two live generations. An old failed task cannot be
retried while a newer generation owns the slot. Summary tasks keep a null slot.

## Authority boundary

Server authority rechecks scope, data epoch, route binding ID, meeting ID,
server transcript `remoteId`, encrypted payload reference, request digest,
snapshot and policy. The server stores local transcript revision, summary
pointer, note revision and source-set digest as opaque request bindings; it does
not claim it can re-read those local sources.

The mobile store now has separate `local_transcript_revision_id` and
`server_transcript_revision_id` fields in both evidence state and intents. Both
participate in the input fingerprint and final atomic commit. Schema upgrade
copies the old local revision only into the local field; missing server identity
fails closed and is never inferred.

## Route and result behavior

- POST returns 202 only after the logical task is durable. Idempotent replay
  returns the existing task ID and its actual state.
- GET verifies route binding and current server authority before returning
  status or a result. Payload references are never part of the public response.
- DELETE increments the durable cancel revision. It promises publication
  fencing, not immediate interruption of an already dispatched model request.
- The worker still owns provider execution plus deterministic protocol and
  citation validation. Provider failure remains distinct from insufficient
  evidence.
- Final user-visible turn and citation ownership stays in the mobile repository;
  the server task result is temporary generated data.

## Remaining adoption gates

1. Independent audit of candidate 0019, including active-slot races, stale
   authority, cross-capability cleanup, migration and late-result fencing.
2. Map the contract to real `device_v1` binding/epoch rows and the AES-GCM
   temporary payload owner without adding a second task state machine.
3. Prove the real reader and citation validator consume only the task-bound
   evidence version.
4. Add Android migration/repository/coordinator behavior and process-death
   tests before replacing the synchronous device route.
5. Resolve the full-row summary migration-manifest schema-upgrade procedure
   before using a database that already ran the optional Slice A import.

No production API, database, model, service, APK or device change is authorized
by this revision.
