# Revision 0030: meeting-question single-reader target

- status: `current blueprint; architecture replacement selected; not adopted`
- parent: `0029-device-summary-owner-validation-and-question-return-20260817`
- production/service/database/App/APK/device/GPU/model mutation: `none`
- isolated evaluation mutation: `meeting-qa-natural-holdout-0014 only`

## Decision

Meeting question work leaves the infrastructure track and selects an
evidence-attributed single reader as the target architecture. This is an
architecture replacement, not another wrapper around the current question
module.

| Route | Role after this revision | Decision |
| --- | --- | --- |
| Q0 current multi-pass service | whole-route rollback for one release | frozen; no new prompt, repair, guard or fallback |
| Q1 remove literals but retain verifier/editor/recovery | migration convenience only | rejected as target |
| Q2 one attributed reader | target candidate | selected for an isolated vertical slice |
| Q3 reranker, late chunking or KV composition | retrieval/performance challenger | deferred until Q2 attributes an actual failure |

The device-summary owner candidate proved a bounded execution owner but is not
expanded into another generic framework. Question execution may reuse its
task/attempt ownership contract only through a real authority mapping. The
question domain still owns its snapshot and answer contract.

## Target topology

```text
durable mobile intent
  -> existing generation task/attempt owner
  -> authoritative MeetingSnapshotRef
  -> deterministic EvidenceView
  -> MeetingAnswerProvider.read() exactly once
  -> deterministic GroundingGate
  -> exact snapshot/policy/cancel publication CAS
  -> atomic mobile turn + clause-citation commit
```

The meeting-question surface answers only from the current meeting. General
knowledge is a separate product capability and cannot trigger a scope-model
call that already carries meeting content.

Every answer is an `AnswerEnvelope` whose clauses each own an `all_of` support
set. A support member binds source kind, stable source ID, source content hash
and exact UTF-8 quote range. Previous turns may resolve reference and requested
scope, but they are not factual sources. Generated summaries are not factual
sources. Manual notes and authorized attachments remain typed, revisioned
sources and cannot be relabeled as transcript text.

Execution, protocol, content outcome, grounding, policy and publication are
separate fields. Provider unavailable, timeout, invalid schema, invalid
citation, revoked source and incomplete coverage can never be projected as
`insufficient`. `not_stated` and `status_open` require an exact complete-meeting
coverage claim; a retrieved subset cannot prove absence or final status.

Normal execution allows one semantic provider call and zero model verifier,
editor, recovery, scope classifier or JSON-repair calls. A provider which
cannot satisfy the output contract is an incompatible provider, not a reason to
silently call Q0.

## Current evidence gate

The first independent review of the public retrieval contract produced
`42 ACCEPT / 11 REVISE / 1 REJECT` over 54 sufficient sets. The 12 non-accepted
items were recovered from the original review lineage and repaired in the
isolated candidate. The repaired artifact now contains 50 claims and 53 sets;
mechanical validation is `13/13 PASS`.

This is not yet an independent semantic pass. Its status remains
`author_status=draft`, `independent_review_status=pending` and
`promotion_eligible=false`. No real reader score may be produced until a fresh
reviewer checks all changed facts, questions, quote ranges and set minimality.
Authored questions also remain development diagnostics, not evidence of natural
LaoJi user-query distribution.

The separate framework contract gate is closed by candidate 0058: the isolated
single-reader boundary is `56/56 PASS` and independently contract-validated
after adversarial request mutation, TOCTOU, replay and exact-type repairs. This
unblocks real adapter development with a fake transport. It does not change the
semantic holdout status above and does not authorize a reader run or production
adoption.

## Concept and deletion budget

Persistent business concepts are limited to the existing task/attempt owner,
`MeetingSnapshotRef` and `AnswerEnvelope`. `EvidenceView`, provider request and
validator result are bounded attempt data. This revision does not authorize a
DAG, agent loop, NLI owner, question-specific retry table, second answer history
or copied evidence database.

When Q2 is adopted, the same migration must remove the production scope model,
sample/domain fixed-answer functions, normal strict verifier, transcript-only
review call, final editor, exact-slot model, recovery generation and summary as
factual evidence. Q0 is retained only as an explicit whole-route rollback for
one release and is then deleted; it is not a permanent fallback.

## First vertical slice

The first candidate is
`/home/yydd/LaoJi-candidates/meeting-question-single-reader-0025`.
Before any real reader call it may implement only the framework-neutral
snapshot, one-call provider, clause-citation and typed failure contracts with a
deterministic fake provider.

## Development handoff (now unblocked)

The isolated contract is sufficiently closed to start the real adapter in a
separate branch. The implementation order is intentionally narrow:

1. Add a server-side `MeetingSnapshotRef` builder at the existing question
   service boundary. It must read the immutable transcript revision and the
   current note revision under one meeting-scoped transaction, then issue the
   owner-held complete-meeting attestation. Attachment text is added only from
   the request's explicit authorization list.
2. Map the existing question task/attempt owner to the candidate's exact
   `AttemptClaim`. The owner, not the HTTP handler or provider adapter, owns
   request identity, lease generation, cancel revision, authority CAS and the
   publication row. A replay must return the stored result without dispatch.
3. Implement one `MeetingAnswerProvider.read()` adapter. Its input is a newly
   constructed provider DTO, never a mutable repository/model object. The
   adapter has one transport call, one idempotency key, and a receipt bound to
   the exact request and response hashes. No verifier, editor, scope model,
   fallback route or hidden repair call may be reached from this path.
4. Run the deterministic grounding gate before owner commit. It validates
   source ownership, revision/hash, exact UTF-8 quote ranges, clause coverage,
   numeric/date anchors and complete-coverage claims. Semantic entailment stays
   explicitly unevaluated until the independent holdout review.
5. Add the mobile response projection only after the server result is durable:
   persist the turn and citations atomically, then expose the existing question
   sheet shape. Preserve the current Q0 route behind an explicit release fence
   for one rollback window; do not let capability negotiation silently select
   both routes.

The first adapter milestone is therefore a real request/receipt/owner
integration with a fake transport, not a model-quality claim. Production model
calls, private meetings and device rollout remain prohibited until the
holdout gate below is independently closed.

After independent retrieval-contract review, the pre-registered public slice is
`NAT-002/003/004/008/012/013/019/021/023/029/041/044`: 12 cases and 20
claims. Oracle evidence and retrieved evidence are separate conditions. The
reader never receives gold claim IDs, sufficient-set IDs, reference answers or
forbidden claims.

Immediate fail conditions are any cross-meeting/epoch source, second semantic
call, Q0 implicit call, execution failure presented as insufficient, unsupported
displayed clause or publication after cancellation/revocation. The oracle and
retrieved claim gates are each at least `19/20`; all displayed citation ranges
must resolve exactly. Under the same provider/model, median and upper-tail
latency must improve by at least 40% over Q0. Two pre-registered reader
combinations may be attempted; failure then moves the architecture to Q3 rather
than a third prompt repair.

## Superseded assumptions

- A valid source ID is not semantic support.
- Invalid grounding cannot be downgraded to insufficient.
- A model JSON repair is still a second call and is absent from the target
  normal path.
- Prefix cache and nugget KV reuse improve prefill, not reader semantics.
- Small specialized-reader benchmark claims do not prove Chinese meeting
  performance.
- Full-context absence claims are not available from arbitrary top-k retrieval.

## Evidence

- [single-reader contract independent pass](../evidence/candidate-0058-meeting-question-single-reader-contract-independent-pass-20260817.md)
- [retrieval-contract repair checkpoint](../evidence/candidate-0057-meeting-qa-retrieval-contract-repair-checkpoint-20260817.md)
- [single-reader vertical-slice research](../research/0028-meeting-question-single-reader-vertical-slice-20260817.md)
- [live question audit](../evidence/live-meeting-question-audit-20260816.md)
- [previous owner closeout](0029-device-summary-owner-validation-and-question-return-20260817.md)
