# Revision 0021: summary bridge cutover replaces impossible all-row migration

- status: `candidate`; **not adopted**
- parent: `0020-meeting-question-task-kernel-implementation-gate-20260816`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Changed assumption

The 0020 task kernel remains selected. Real source inspection showed that
`summary_tasks_v2` never persisted enough historical source/policy identity to migrate
every row honestly. Therefore the previous all-row migration instruction is superseded;
it is not an implementation blocker to be worked around with inferred values.

See [research 0025](../research/0025-legacy-summary-binding-and-drain-audit-20260816.md).

## Implementable Slice A

Slice A is now:

```text
durable cutover barrier
  -> new summary writes: generic GenerationTask/GenerationAttempt only
  -> existing legacy work: old owner drains to terminal
  -> status: generic reader, then legacy compatibility reader
  -> privacy delete/revoke: both stores, one transaction
  -> optional exact-binding import; otherwise natural expiry and removal
```

No request is dual-written. The generic worker never claims a legacy row. An optional
import remains fail closed and is not required for cutover.

## Unchanged decisions

- server result remains an expiring delivery artifact;
- meeting question history remains owned by mobile turn/citation tables;
- Slice B still adds durable question routes beside the synchronous route;
- Slice C still adds one mobile request-intent owner and no answer columns;
- Q2 retrieval/evaluation work remains independent and still blocks real reader promotion;
- production, real database, App, device, model and GPU remain frozen.

## Gate

- `GO`: implement and test the bridge, generic summary adapter, exact-binding submit and
  legacy drain in the isolated candidate;
- `NO-GO`: production cutover, real database migration, public API switch or adoption;
- one independent blocking-level audit is required after the Slice A code is stable.

