# Revision 0026: stable payload and exact-attempt composition

- status: `candidate; not adopted`
- parent: `0025-summary-real-signature-facade-20260817`
- candidates:
  - `$CANDIDATE_ROOT/meeting-question-slice-b-0019`
  - `$CANDIDATE_ROOT/summary-store-facade-0020`
  - `$CANDIDATE_ROOT/generation-payload-store-0021`
  - `$CANDIDATE_ROOT/summary-payload-composition-0022`
- production mutation: `none`

## Revised decision

The exact old summary worker signature is no longer a target constraint. The
independent audit proved that `task_id + process-wide owner` discards attempt
identity: a late callback can be made indistinguishable from the current retry.
Generic work must carry the kernel-issued `AttemptClaim` through every worker
lifecycle call. Legacy rows may retain the old backend only during bounded drain.

Source payload ownership is now:

```text
canonical private sources
  -> capability/scope/logical HMAC identity
  -> AES-GCM ciphertext first
  -> immutable generic task second
  -> exact claim + payload check in one transaction
  -> terminal cleanup or TTL
```

Committing ciphertext first intentionally chooses a bounded encrypted orphan as
the crash residue. Committing a task first would create executable work with no
input. Random encryption after a lookup was rejected because concurrent callers
retain a check/encrypt race; stable scoped identity makes retries converge.

Explicit privacy deletion is a transaction participant, not a later cleanup
request. A summary scope with tasks but no payload participant fails closed.
Candidate 0022 deletes its new payload rows and task rows in one adapter
transaction. It does not yet own the legacy `summary_v3_source_payloads` table,
so production cutover remains blocked.

## Audit-driven mobile correction

The second Slice B audit confirmed earlier task-ID ABA and forged-claim repairs,
then found two final mobile ownership holes. The latest candidate atomically
claims an unowned remote task when a result precedes attach, rejects cross-intent
task capture, and prevents a completed request ID from creating another intent.
These repairs are `89/89` self-tested and still await fresh independent audit.

## Complexity result

This revision adds one payload table and one worker token, but removes three
unsafe concepts from the target integration:

- random payload UUID per retry;
- process-memory current-attempt reconstruction;
- asynchronous privacy cleanup after task deletion.

The facade, payload store and composition total remain isolated modules. No
second task transition state machine was added; generic transitions still belong
only to `GenerationTaskKernel`.

## Next implementation order

1. Independently re-audit the latest 0019/0020/0021/0022 hashes.
2. Add a fenced worker-session generation so local restart can immediately
   expire its prior attempts without PID inference or waiting the full lease.
3. Implement the real same-connection authority resolver for device principal,
   epoch, meeting binding, stable transcript revision, policy and payload.
4. Only then map the facade, payload migration and worker token into a service
   worktree candidate; durable question FastAPI and RN intent wiring remain
   later slices.

No production code, database, service, model, GPU, APK, device or public route
is changed or authorized by this revision.
