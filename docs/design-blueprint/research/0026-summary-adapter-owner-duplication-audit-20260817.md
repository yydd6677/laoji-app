# Research 0026: summary adapter owner duplication audit

- candidate: `$CANDIDATE_ROOT/meeting-question-task-kernel-0018`
- production mutation: `none`
- result: first production-shaped adapter is `rejected-current-shape`

The first adapter passed 16 isolated tests, but its 1,564 lines independently
implemented create, claim, lease expiry, renew, stage, checkpoint, publication,
failure, recovery, counts and purge. The accepted kernel already owns the same
state transitions. Passing the same fixtures twice does not make two owners safe;
it creates two SQL implementations that can drift on cancellation, TTL, policy
fencing and future schema changes.

Three choices were reconsidered:

1. keep both implementations because the adapter tests pass: rejected;
2. delete the generic kernel and make the summary adapter the kernel: rejected,
   because it is summary-shaped and cannot cleanly own durable question tasks;
3. make the generic kernel accept a transactional authority resolver and expose
   the few generic recovery/checkpoint/query primitives, then retain a thin
   summary projection plus legacy drain reader: selected.

The adapter may own only compatibility concerns: task-kind/stage projection,
legacy read fallback, durable cutover marker, privacy deletion across both stores,
and optional exact-binding import. It must not contain independent claim, lease or
publication SQL.

Candidate 0048 applied the first bounded blocker repair. It gates bridge result
reads and idempotent replays, records complete task/attempt import manifests,
repairs and validates the cutover trigger in one startup transaction, and makes
mobile source/revision authority repository-owned. It currently passes 55/55
strict isolated tests, but remains `independent re-audit pending`; the repair is
not a production adoption decision.
