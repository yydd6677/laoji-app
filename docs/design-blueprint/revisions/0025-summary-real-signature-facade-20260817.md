# Revision 0025: summary real-signature facade

- status: `candidate; not adopted`
- parent: `0024-question-atomicity-and-real-bridge-handoff-20260817`
- candidate: `/home/yydd/LaoJi-candidates/summary-store-facade-0020`
- production mutation: `none`

## Decision

The bridge/drain order selected in 0024 is now executable at the current summary
store call surface. `SummaryTaskStoreFacade` does not recreate transition SQL:

```text
new summary request -> explicit immutable binding -> generic kernel
pre-cutover legacy ID -> old backend only -> terminal drain
status/recovery/readiness -> one compatibility projection over both
```

The existing module can eventually retain its function names while delegating
to this configured facade. The in-memory Future may wake a worker, but the
durable task/attempt rows own claim, lease, checkpoint and terminal publication.

The facade is not ready to move into the service worktree. Its self-tests expose
two owner-level prerequisites rather than hiding them in compatibility code:

- encrypted source payload identity must be stable for an idempotent logical
  request, or an existing task must be resolved before a new payload is written;
- immediate local-process orphan recovery needs an explicit generic-kernel
  transition, otherwise restart waits for normal lease expiry.

Legacy result bodies remain rollback-readable during the bounded drain window;
scope/epoch privacy deletion is explicit and may remove both stores. New inline
worker arguments are rejected, so `device-final` and `device-summary-v3` must
also use the encrypted payload path before real cutover.

## Next implementation

Build an isolated capability-aware temporary payload store with:

- AES-256-GCM and capability-specific AAD;
- caller-supplied SQLite connection for same-transaction authority checks;
- scoped keyed-content identity, ciphertext digest, request digest and expiry;
- no plaintext, filename, person or transcript text in logs;
- idempotent save that returns the same payload identity only for the same scope,
  capability, meeting and content digest;
- immediate delete on terminal success/failure/revocation and TTL purge fallback.

The store must be compared with “resolve task before encrypting” as a lower-
complexity alternative. It may supersede summary-v3 payload helpers, but it may
not add a second payload owner beside them in production.

No production code, service, database, model, GPU, APK, device or public route is
changed or authorized by this revision.
