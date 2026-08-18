# Revision 0024: question atomicity and real bridge handoff

- status: `candidate; not adopted`
- parent: `0023-durable-question-slice-b-contract-20260817`
- candidate: `$CANDIDATE_ROOT/meeting-question-slice-b-0019`
- production mutation: `none`

## Decision

Slice B remains the selected durable-question contract, but it is not sealed.
The first independent atomicity audit blocked it on two executable counterexamples:

1. a deleted task ID could be reused under the same meeting binding and then
   cancelled by an older DELETE whose cancel revision had also started at zero;
2. a claim with the real task/attempt/lease but forged provider-request or cancel
   identity could advance or fail the active attempt.

The candidate now binds route GET and DELETE to the persisted client request ID
as well as task ID and meeting binding. Worker mutations share one exact claim
contract over task snapshot, cancel revision, attempt ID/number, lease generation
and provider request ID. A cancel fence is recognized only when the server cancel
revision has advanced monotonically beyond the claim; a claim carrying a larger
invented revision is rejected without mutating the attempt.

The repaired candidate passes `86/86` self-tests and the updated adversarial
probe, but independent re-audit of these hashes is still required. This revision
therefore does not promote the candidate to `validated` or authorize production.

## Production mapping result

Read-only mapping of the real service changes the immediate implementation order.
The generic kernel cannot be wired first through the new question route while
existing persistent summaries still write directly to `summary_tasks_v2`.
Otherwise the service would run two execution owners with different recovery,
retention and privacy behavior.

The next isolated implementation slice is therefore a real-signature summary
bridge/drain facade:

```text
current summary_task_store function surface
  -> compatibility facade
     -> new submissions: generic GenerationTaskKernel only
     -> pre-cutover active legacy rows: legacy owner drain only
     -> reads: generic first, legacy fallback
```

It must cover the current `create/claim/renew/stage/success/failure/checkpoint/
get/recover/requeue/count/purge/latest/worker_state` call surface, plus readiness,
retention and epoch deletion. In-memory Futures may remain only as wakeups; they
cannot own task state. No old row may be migrated unless one transaction can
resolve its exact epoch, snapshot, policy, payload and handler identities.

## Real authority gaps retained as blockers

- `binding_id` currently equals `Meeting.id`; there is no independent binding owner.
- device transcript revisions are derived from `Meeting.updated_at + line count` in
  one route and from recording-job digests elsewhere; no single stable remote
  transcript revision exists.
- summary-v3 AES-GCM payload helpers open their own connections and use a
  summary-specific AAD. They must become capability-aware and connection-aware
  before a question task can use them in the kernel authority transaction.
- account question tables remain a separate compatibility domain and cannot own
  device-primary question delivery or final mobile history.

These gaps are not to be hidden with constants, current timestamps or task
metadata. After the summary facade proves a single execution owner, the next
server slice must add a same-transaction device authority resolver and a stable
server transcript revision owner before durable question routes are enabled.

## Scope boundary

This revision changes only isolated candidate code and blueprint documents. It
does not modify or restart a service, database, model, GPU, API, APK, device,
public route or production worktree implementation.
