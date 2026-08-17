# Candidate 0048: durable question kernel blocker repair

- candidate: `/home/yydd/LaoJi-candidates/meeting-question-task-kernel-0018`
- status: `independently audited; Slice A candidate; production NO-GO`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Scope

This is one bounded repair pass after the independent audit of candidate 0047.
It does not connect the kernel to LaoJi production. The generic kernel remains
the only task-transition owner; the summary bridge remains a compatibility
projection.

## Repaired boundaries

1. Generic summary reads now pass successful results through the kernel's
   authority and result-TTL gate. Revoked and expired bodies are not projected
   by the compatibility bridge.
2. Idempotent submit replay rechecks current authority before returning a reused
   task.
3. A durable cutover marker repairs and verifies the legacy insert trigger on
   startup and before bridge operations.
4. Optional terminal import records a migration-item manifest and hashes the
   complete imported task plus attempt history. Removing an attempt or manifest
   entry makes replay fail closed. Intentional dual IDs are accepted only for a
   manifested import; otherwise they are an integrity error.
5. Mobile evidence authority now stores transcript revision, summary version,
   note revision and a typed source set. Intent creation and final commit query
   this local authority in the same transaction; caller-declared fabricated
   sources are rejected.
6. A late server task ID can attach after local cancellation and is exposed by
   `cancelled_remote_intents()` for remote cancellation fencing.
7. Privacy deletion fails closed when an unscoped legacy row has no exact domain
   binding resolver. Imported rows are deleted transactionally with their
   generic task.
8. Cutover construction and trigger creation run under `BEGIN IMMEDIATE`; an
   kernel schema, marker and trigger are initialized in that same transaction.
   An existing trigger is validated for both `BEFORE INSERT ON summary_tasks_v2`
   and the exact abort action. Invalid trigger shape fails closed without a
   DROP/CREATE window.
9. The migration target projection includes every task column plus every
   attempt column, and field-level tamper replay is rejected.
10. Summary bridge capability boundaries are explicit: only
    `meeting.summary.*` tasks may be created, migrated, claimed, read,
    counted, recovered, purged or deleted; claim fields are checked against
    the database task before any transition.
11. Mobile intent fingerprints are recomputed from every immutable field and
    the canonical typed-source list at final commit. A source-list or question
    field change without a matching fingerprint is rejected.
12. Recovery, purge and all stateful bridge calls perform a full integrity and
    cutover preflight before delegating to kernel methods. A damaged SQLite
    database therefore fails closed without first changing leases or results.
13. Migration marker metadata has its own digest, so completion-time or other
    manifest-row tampering cannot silently turn a replay into `reused`.

## Verification

```text
python3 -W error::ResourceWarning -m unittest discover -s tests -v
62/62 PASS

python3 -m py_compile generation_task_kernel.py production_summary_adapter.py \
  tests/test_generation_task_kernel.py tests/test_production_summary_adapter.py
PASS
```

Additional adversarial probes passed for expiry/revocation reads, trigger
repair after legacy-table recreation and restart, malformed trigger fail-closed,
deleted-attempt and security-field replay, fabricated typed sources,
cancel-before-response, unscoped privacy deletion, cross-capability filtering,
intent fingerprint tampering, manifest metadata tampering, and integrity
preflight before recovery/purge. The independent audit passed this slice;
these results are still not an adoption or production-readiness claim.

A 100-iteration restart-repair/legacy-writer stress probe with the writer
admitted after the repair transaction began produced
`legacy_insert_successes=0, unexpected_errors=0`. Recreating or dropping the
legacy table outside the cutover transaction remains a schema-corruption
condition; the bridge fails closed when its trigger shape is invalid.

Current candidate SHA-256 inputs (after capability, fingerprint and
fail-closed-integrity repairs):

```text
generation_task_kernel.py                 617dd7a4e45a06ab802f8dbde8b0eff5819ef05175afbbf1a451493ed8212a71
production_summary_adapter.py             b51805134b8085c104ac58ef9206e68240692efec03b343e9852955def5ac908
tests/test_generation_task_kernel.py      7ad1dc74459a66ded7a1b00c26bff2747287bb59ab43b65a3843c68ec6f85cd9
tests/test_production_summary_adapter.py  b2a468641b391fb9b054fbbbd7135c52a5b6cd5c8a7057e283c06da98830d4d0
ADAPTER_MAP.md                             3f6c878f8757a72e8b7da47294b765eaa3890237a32ed0f9b14e60047c6d1c41
README.md                                  fe915efad19b2da4c98fd9735053fba7bb9716ab97c60a41472ef6a0181f6ea0
```

## Remaining design warning

Slice B must add an active-slot uniqueness contract instead of relying only on
the kernel's permanent exact `conflict_key`: a new intent generation must be
able to run after a cancelled generation, while two live generations for one
thread/ordinal remain impossible. It must also keep local transcript revision
IDs separate from the server transcript `remoteId`.
