# Revision 0027: authority ledger and source-envelope repair

- status: `superseded by revision 0028; repaired hashes independently passed; not adopted`
- parent: `0026-stable-payload-and-attempt-claim-composition-20260817`
- candidate: `/home/yydd/LaoJi-candidates/generation-authority-resolver-0023`
- production mutation: `none`

## Why 0026 was blocked

The first independent audit exercised the candidate through the actual generic
kernel shape and found three concrete gaps:

1. The kernel passes a `sqlite3.Row`, not a plain dictionary. The resolver used
   `row.get(...)` and crashed before authority could be evaluated.
2. The transcript delete trigger attempted to recreate a revision row while a
   meeting was being deleted. With the revision table's foreign key enabled,
   deleting a meeting with transcript lines failed instead of completing the
   privacy/deletion path.
3. The payload metadata bound only task scope. A crafted encrypted payload could
   carry content that was not described by the meeting snapshot contract.

## Bounded repair

The isolated candidate now:

- normalizes the kernel row to a mapping before reading it and has a real
  `GenerationTaskKernel.claim_next` regression test;
- adds a per-meeting random ledger generation to the revision identity;
- guards the transcript delete trigger during parent cascade deletion while
  retaining revision increments for ordinary line deletion;
- validates a strict encrypted source envelope. The envelope carries the meeting
  ID, server transcript revision, note/attachment IDs and content digests, plus
  private note/attachment bodies. It explicitly has no transcript body. The
  worker re-reads transcript lines from the meeting owner and publication remains
  fenced by the live revision;
- treats device notes and selected attachments as immutable request snapshots,
  not as an invented long-lived server data owner.
- passes `state` and `logical_request_key` into authority before submit, rejects
  missing ciphertext before task creation, and binds the configured handler
  revision;
- returns no transcript authority whenever the current meeting has zero lines,
  regardless of whether it was always empty or became empty after edits;
- retains encrypted payload for retryable `failure` until retry, explicit
  privacy deletion or TTL instead of deleting the only retry input.

The source envelope is an adapter contract, not a client assertion. An
authenticated route must construct it after reading the server transcript and
must include its digest in task metadata and the snapshot digest.

## Evidence

- `21/21` authority, `90/90` kernel and `11/11` composition strict self-tests
  pass with `ResourceWarning` promoted to an error.
- Tests cover real `sqlite3.Row` invocation, kernel claim, rollback, concurrent
  writes, cross-meeting source mismatch, note hash mismatch, cascade delete and
  ledger recreation.
- Read-only live mapping on 2026-08-17 observed the production tables
  `meetings`, `transcript_lines`, device principal/epoch/tombstone tables and
  `summary_tasks_v2`; no trigger, revision table or generic authority was
  installed.

## Still blocked

This revision is not an adoption decision. The current production adapter only
passes a reduced authority binding and its summary metadata lacks the transcript
revision and source-envelope digest. The next candidate must build a
summary-v3-only adapter that writes the generic owner in one transaction while
leaving legacy `summary_tasks_v2` in bounded drain. It must also decide how the
question capability shares the owner without widening the summary adapter into a
second task state machine.

No production database, FastAPI route, worker, model, GPU, APK, device or public
route was changed.
