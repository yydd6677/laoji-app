# Candidate 0051: summary store real-signature facade

- candidate: `$CANDIDATE_ROOT/summary-store-facade-0020`
- dependency: `$CANDIDATE_ROOT/meeting-question-slice-b-0019`
- status: `independent audit BLOCK; repairs 13/13 self-tested; composition re-audit pending; not adopted`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Implemented

- Maps the current summary store create/claim/renew/stage/checkpoint/success/
  failure/get/recover/requeue/count/purge/latest/worker-state behavior onto a
  thin class facade.
- New writes resolve an explicit immutable binding and go only to the generic
  adapter. The pre-cutover table receives no dual write.
- Existing legacy rows are detected through the bridge projection and delegated
  only to the injected old backend for their bounded drain lifecycle.
- Generic claim returns the kernel-issued `AttemptClaim`; all later lifecycle
  calls require that exact token. The facade no longer reconstructs a current
  attempt from a process-wide owner.
- A recovery-time failure first claims queued/expired generic work, then fails
  that attempt; the facade has no administrative terminal-write bypass.
- Cutover fencing rejects any new legacy insert. A missing legacy backend fails
  before mutating the legacy row.
- Inline `worker_args` are rejected for new persistent tasks; only an opaque
  encrypted payload ID is accepted by the test binding resolver.
- A fresh proposed task UUID for the same immutable logical request returns the
  existing kernel task ID. `force` receives a new logical identity.

## Independent findings and repairs

The first independent audit reproduced a late-attempt publication: after an old
lease expired and the same process owner claimed a new attempt, the old callback
published into the new attempt. It also reproduced a wrong-task callback across
two tasks sharing the production process owner. The old signature had discarded
the only distinguishing identities, so this could not be fixed by another
lookup. Generic lifecycle calls now require the original full `AttemptClaim`;
missing, wrong-task, wrong-owner, expired and forged claims fail closed.

The audit also found that scope privacy deletion left encrypted payload rows and
that `task_kind` could drift from resolver-selected capability. The adapter now
requires a payload cleanup participant in the same deletion transaction, and the
facade requires exact `meeting.summary.<task_kind>` mapping. Candidate 0022 wires
the new payload participant; this standalone facade deliberately fails privacy
deletion when it is absent.

## Verification

```text
PYTHONPATH=$CANDIDATE_ROOT/meeting-question-slice-b-0019:. \
PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning \
  -m unittest discover -s tests -v
Ran 13 tests: OK

python3 -m py_compile summary_task_store_facade.py tests/*.py
PASS
```

## Findings that block real wiring

1. Generic restart recovery currently waits for durable lease expiry. The old
   PID shortcut remains only in the legacy backend. Immediate dead-local-owner
   recovery, if retained, must be a kernel transition rather than facade SQL.
2. Production workers currently pass only task ID and a process-wide owner.
   They must retain and pass `AttemptClaim` before this facade is usable.
3. Stable payload identity and atomic privacy participation are implemented only
   in isolated candidates 0021/0022; old `summary_v3_source_payloads` rows remain
   unmigrated.
4. This candidate imports the accepted kernel through `PYTHONPATH`; it is not yet
   a service-worktree patch and does not prove real imports, startup order,
   readiness, retention or epoch deletion.

## Hashes

```text
summary_task_store_facade.py               c8c5fdb0513a9f260945be29b0c1b6eaac5fab78165eee935470f0a8a171b511
tests/test_summary_task_store_facade.py    a8e8cedda93af64a5c7101b56a9bd12149b91ec38f8646eaf9b85eee3991ad9a
README.md                                  63e498ac788d47cd03b858fe2d5925dc7b338bc408ca6403a5617c3c1cd05b1d
```
