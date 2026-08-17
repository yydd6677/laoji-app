# Proposal 0005: device summary-v3 generic owner

- status: `authorized for one isolated candidate by revision 0028; not adopted`
- depends on: revision 0028 cutline
- production mutation: `none`

## Scope

Move only new device `summary-v3` submissions to the generic generation owner.
Do not activate the existing summary adapter's global cutover trigger. Existing
period/final/device-final writes and all legacy `summary_tasks_v2` rows continue
under the old owner until a later bounded drain. Meeting questions remain out of
this slice.

This is intentionally narrower than “migrate every generation route”. It is the
first vertical proof that the new owner can reduce duplicate state without
interrupting current service.

Revision 0028 further fixes the implementation boundary: this slice uses a
device-summary-v3-only owner rather than the global production summary facade.
It stops only new old-owner `device-summary-v3` writes when the isolated route
is enabled; it does not drain or fence the whole legacy task table.

## Submit path

The authenticated device route resolves principal, active epoch, meeting binding
and tombstone before constructing any authority data. It reads the current
server transcript revision and creates the source envelope itself:

```text
server meeting/transcript revision
  + current device note revision/body/hash
  + explicitly selected attachment revision/body/hash
  -> canonical source snapshot digest
  -> stable encrypted payload
  -> generic task submit under live authority
```

The client never supplies an opaque source-authority envelope. It supplies the
note/attachment values already present in the v3 request; the route normalizes
and binds them to the resolved meeting. Transcript text is not copied into the
encrypted payload. If transcript authority changes between source collection and
task submit, submit fails and leaves only a TTL-bounded ciphertext orphan.

Task metadata is immutable and exactly contains:

- `task_kind=device-v3`
- `task_scope=device:<principal>:<epoch>`
- `transcript_revision_id`
- `source_snapshot_digest`

Source-envelope schema v2 also binds each selected attachment's `position_ms`.
An empty manual note is canonical `None`, not a revision-bearing empty source.

Capability is `meeting.summary.device-v3`; handler and policy revisions are
explicit. The active slot is one device-summary-v3 generation per meeting. An
idempotent retry reuses the same payload and task; a changed source snapshot uses
a new logical request and does not overwrite the previous readable document.

## Worker path

The worker receives and retains the full kernel-issued `AttemptClaim`. It may
not reconstruct an attempt from task ID, process owner or current database row.

1. Claim and decrypt the exact payload in one transaction.
2. Reload transcript lines by meeting from `transcript_lines`.
3. Build the existing v3 evidence package and run the provider outside the DB
   transaction.
4. Re-enter with the same claim; recheck authority, cancellation, lease, source
   snapshot, policy and handler.
5. Verify the result and atomically publish the task result and activate the
   immutable `summary_v3_documents` row.

The fifth step requires a kernel publication participant executed inside the
same SQLite transaction immediately before the task success CAS. If the
participant raises, both document activation and task success roll back. A
separate `persist_document()` followed by `mark_success()` is forbidden because
it can expose an active document from a failed or cancelled attempt.

The task result contains only the immutable artifact ID and digest. The facts
document is stored once in the artifact table with a separate current pointer.

`force` retries the same failed immutable task. It does not replace an active or
successful same-source identity and does not create an untracked re-sample.

## Failure and cleanup

- `failure` remains retryable and retains its encrypted payload until retry,
  explicit privacy deletion or TTL.
- `success`, `cancelled`, `stale` and `revoked` may delete the payload after the
  publication transaction.
- Explicit device/epoch/meeting deletion removes generic task, attempts and
  payload in the existing privacy transaction participant; no asynchronous
  best-effort cleanup is acceptable.
- Expired payload makes queued/failure work stale and non-executable. It never
  falls back to a different source.

## Production-mode schema boundary

The kernel currently creates `fixture_policy_state` for isolated tests. In this
slice, a real authority resolver is mandatory and startup must assert that the
fixture table is absent or empty and unreachable through the service adapter.
The production schema migration should omit it after the generic kernel exposes
a production initialization mode. Device principal/epoch/meeting authority is
the only policy source.

Installation is first tested on a SQLite backup-API copy of the live database:

- `integrity_check` and `foreign_key_check` before and after;
- exact schema and trigger SQL hashes;
- revision backfill count equals meeting count;
- rollback, direct transcript edits, empty transcript and synthetic delete;
- legacy `summary_tasks_v2` bytes and row counts unchanged.

## Read compatibility

The v3 GET route first reads a verified generic-owned v3 document. If none
exists, it keeps returning the current old v3/legacy result. This is a read
projection, not a second task owner. No old row is rewritten or given invented
snapshot history.

## Acceptance before any production decision

- exact-hash authority dependencies independently pass;
- submit without ciphertext creates no task;
- transcript/note/attachment change fences stale publication;
- provider failure can retry with the same ciphertext after restart;
- process interruption before and after document insertion yields either both
  task/document success or neither;
- duplicate submit/claim/complete yields one task, one attempt publication and
  one active document;
- meeting/epoch privacy deletion leaves no generic task, attempt or payload;
- old summary rows remain writable/readable and byte-identical during the slice;
- no model, GPU, public route, APK or production service is changed until the
  isolated service copy passes these gates.

## Deletion target

After this slice is adopted and stable, the device-summary-v3 branch in
`summary_tasks_v2`, random `summary_v3_source_payloads` creation and the separate
document/task publication sequence become removable. Period/final legacy paths
are not removed by this slice.
