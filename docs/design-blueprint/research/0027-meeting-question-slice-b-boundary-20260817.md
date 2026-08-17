# Research 0027: durable meeting-question Slice B boundary

- status: `candidate; not implemented`
- source: `/home/yydd/LaoJi-service-worktrees/compact-production-v3`
- production/service/database/App/APK/device/GPU/model mutation: `none`
- prerequisite: candidate 0048 must pass a fresh independent audit

## Current route facts

The device route is mounted at `/api/device/v1` and authenticates the device
epoch before loading a meeting. `POST /meetings/{binding_id}/questions` currently
rebuilds a server pseudo transcript revision from `meeting.updated_at` and line
count, calls the reader synchronously, and returns a transient answer. It does
not create a durable task or attempt. Existing generic task status routes cover
recording and legacy summary jobs, not questions.

The mobile question session has a local transcript revision object with a
separate server `remoteId`. Treating the local revision ID as the server
revision would make a valid local retry look stale, while accepting only the
server value would allow a local edit to be committed into the wrong turn.

## Selected contract

The new request carries both identities:

```text
local_transcript_revision_id       mobile repository identity
server_transcript_revision_id      immutable server projection identity
summary_version_id                 local summary pointer
manual_note_revision               local note revision
previous_turn_digests              local thread context
input_fingerprint                  digest over all of the above plus payload
```

The server authority check covers device epoch, meeting binding, server
transcript revision, encrypted payload reference/digest, task snapshot/policy,
and cancellation. It cannot re-read a phone's current note, summary pointer or
previous turns. The mobile final-commit transaction therefore rechecks those
local values and the repository-owned typed source set before inserting a turn.

## Active generation ownership

The generic kernel's current `conflict_key` is an exact permanent uniqueness
key. A key containing intent generation prevents accidental replay but also
prevents a new generation after a cancelled generation if reused as the only
constraint. Slice B must add:

- `active_slot_key = device scope + meeting + thread + ordinal`;
- a partial unique index over `state IN ('queued','running','retry_wait')`;
- logical request identity including request ID and intent generation;
- release of the active slot on cancellation, terminal failure or publication;
- publication CAS requiring both the exact task identity and active-slot
  generation.

Two live generations then cannot coexist, while a cancelled generation can be
retried with a new request identity.

## API shape

Add beside the synchronous route, behind a capability flag:

```text
POST   /api/device/v1/meetings/{binding_id}/question-tasks
GET    /api/device/v1/meetings/{binding_id}/question-tasks/{task_id}
DELETE /api/device/v1/meetings/{binding_id}/question-tasks/{task_id}
```

POST persists an encrypted temporary payload and returns `202` only after the
generic task and first attempt identity are durable. The worker wraps the
existing reader unchanged as a rollback reader, then records protocol,
citation and provider outcomes separately before kernel publication. A provider
timeout is execution failure, never an evidence-insufficient answer.

GET rechecks device epoch, meeting binding, server transcript revision and
current task authority before returning a body. DELETE increments the cancel
revision. Until the transport itself is cancellable, the API promises fencing
of late results, not immediate GPU interruption.

The old synchronous device route remains read-only rollback compatibility for
one mobile release. It receives no dual write from the new route.

## Open gates

- Do not implement Slice B against the current permanent `conflict_key` alone.
- Do not claim the server validates phone-local notes or turn history.
- Do not reuse account/guest question tables as the device answer owner.
- Do not enable the route until candidate 0048 receives a fresh independent
  audit verdict and the active-slot fault matrix is implemented.

## Implementation order after the gate

1. Extend the isolated kernel schema with `active_slot_key`, a partial unique
   index for live states, and a publication CAS that checks the slot owner.
   Prove cancelled-generation retry before adding HTTP code.
2. Add a server adapter that resolves the device binding and server transcript
   projection in one transaction, writes only an encrypted payload reference,
   and maps worker stages to the existing status vocabulary.
3. Add the three routes beside the synchronous route with a capability flag.
   GET must return the last stable state/result and never expose the temporary
   note payload. DELETE must be idempotent and return the cancel revision.
4. Add a mobile-only repository probe that stores the local/server revision pair,
   resumes after process death, and commits a turn only after both authority
   sides match. Only then map it into the existing React sheet.
5. Run the fault matrix in a new candidate worktree; no real API or device
   switch is part of Slice B implementation.

Required Slice B adversarial cases include two generations racing for one
ordinal, cancellation before and after POST response, server transcript update
while the reader runs, local note update while the reader runs, late answer after
epoch revocation, same source ID under another type, and a task/result whose
local revision matches but server `remoteId` does not.
