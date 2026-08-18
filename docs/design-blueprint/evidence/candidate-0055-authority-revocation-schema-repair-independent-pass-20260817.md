# Candidate 0055: authority revocation and schema repair independent pass

- status: `independently audited PASS; isolated only; not adopted`
- candidate roots:
  - `$CANDIDATE_ROOT/generation-authority-resolver-0023`
  - `$CANDIDATE_ROOT/meeting-question-slice-b-0019`
  - `$CANDIDATE_ROOT/generation-payload-store-0021`
  - `$CANDIDATE_ROOT/summary-payload-composition-0022`
- production/service/App/APK/device/GPU/model mutation: `none`

## Why the previous hashes were blocked

The bounded dependency audit reproduced three relevant fail-open paths before
its final response transport was interrupted by repeated gateway timeouts:

1. a live task revoked through the real device authority could still renew its
   lease, advance stage and replace the terminal meaning with provider failure;
2. same-name SQLite task/mobile index objects could omit the required uniqueness
   contract and still be accepted at startup;
3. the transcript ledger installer accepted a nullable meeting owner, allowing
   detach-edit-reattach to bypass both update triggers.

The nullable transcript shape is not the live schema, but installation claimed
to validate its base authority contract. It is therefore rejected explicitly.

## Bounded repairs

- `renew`, `advance_stage`, `save_checkpoint` and `fail` now resolve live
  authority before mutation. A stale, missing or revoked authority atomically
  terminalizes the exact task and attempt as `stale/revoked` with
  `policy_fenced`; it cannot extend the lease or become an ordinary failure.
- kernel initialization validates both task identity/conflict unique indexes,
  attempt uniqueness and the attempt-to-task cascade foreign key.
- the mobile active-ordinal index is validated for owner table, columns,
  uniqueness, partial predicate and canonical SQL before and after setup.
- transcript authority installation requires a non-null `meeting_id` foreign
  key to `meetings.id` before creating any ledger object.

## Strict verification

All commands used `python3`, `PYTHONDONTWRITEBYTECODE=1` and
`-W error::ResourceWarning`:

- generic kernel and its adapters: `93/93 PASS`;
- real authority resolver: `23/23 PASS`;
- summary facade: `13/13 PASS`;
- encrypted payload store: `18/18 PASS`;
- payload/task composition: `11/11 PASS`;
- `py_compile`: PASS.

The independent exact-hash audit separately ran the four requested modules as
`99/99 PASS`, replayed the nine earlier blockers, and built fresh probes rather
than relying only on author tests. Four independent real-resolver tasks proved
that each old-worker action is independently fenced. Fault injection after
payload deletion proved scope privacy deletion rolls back both payload and task,
then commits both together on retry.

The audit classified explicit task-ID reuse after privacy deletion as a
privileged internal capability, not a current route blocker: the public question
POST has no task-ID input and stale GET/cancel calls both fail their persisted
logical-request binding. A future untrusted explicit-ID route would reopen this
decision.

## Real database copy

The running database was copied through SQLite's backup API to a mode-0600
temporary file. The repaired ledger and payload schemas were installed only on
that copy:

- 74 meetings and 2,844 transcript rows;
- 74 revision rows, of which 28 represented non-empty transcripts;
- integrity and foreign-key checks passed before and after;
- all four triggers existed and rollback on a real transcript row passed;
- all 67 legacy `summary_tasks_v2` rows retained the same canonical digest;
- both remote and local temporary copies were deleted.

The copy exposed a source/runtime drift: the ORM currently declares
`ON DELETE CASCADE`, while the live `transcript_lines.meeting_id` foreign key is
`NOT NULL` with SQLite `NO ACTION`. The authority contract therefore binds
non-null ownership and the referenced table/column, not an untrue cascade mode.
Deletion behavior remains a separate production migration concern.

## Frozen hashes

```text
generation_authority_resolver.py       935634efd3635d79d7db8e19d289344166e18227d213838e96aea86049844c43
test_generation_authority_resolver.py  c8ffe2c3f989f61edffaf36a4e0944dd7b65dce67164b9cf102c80538d6daf8c
generation_task_kernel.py              3f9835abdd786c9d61ec85c450a3fc277b7497d5ea4059baa7ca435c9a4ae121
test_generation_task_kernel.py         63f53a0c312502ab7017e4b02f050cc66dcddc1e8ffc6a620eb36b0f6c42131b
generation_payload_store.py            bc32e0fac8d8c9bfb4f960261aa9c7932f455d36da426c8796139b8c283d5934
test_generation_payload_store.py       49edffd096a275d596f453ee46034ff792b6ad5d58ceef2f49fd8055f9c6ec92
summary_payload_composition.py          eba5529e7c2d3dbb76c17391998b70e999733e2e2e3b41f5fe7a27cb5198704e
test_summary_payload_composition.py     7a67352280488242a4386603e6f694b79baa392910ef0bc772a2777ee31fca4f
```

Independent audit session: `01a00cc6-ab59-7ad2-b026-b657a8e74bad`.

## Remaining boundary

This PASS seals only the authority/payload dependency for isolated integration.
It does not validate a FastAPI route, production schema profile, model call,
atomic summary document publication, mobile task recovery or user-visible
summary quality.
