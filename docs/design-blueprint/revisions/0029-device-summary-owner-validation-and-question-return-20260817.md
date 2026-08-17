# Revision 0029: device summary owner validation and question return

- status: `current blueprint; isolated candidate validated; not adopted`
- parent: `0028-device-summary-v3-owner-cutline-20260817`
- production mutation: `none`

## Closed slice

`device-summary-v3-owner-0024` completed revision 0028's one allowed vertical
candidate and bounded repair re-audit. Candidate 0056 records independent
restart, concurrency, fault, privacy, damaged-database and compatibility
evidence. The final candidate is `103/103 PASS` and remains isolated.

This closes the infrastructure question posed by 0028: one capability can bind
device authority, source-envelope v2, encrypted payload, exact attempt and
immutable artifact/current publication under one SQLite transaction owner. It
does not authorize a production route or imply that the generic owner should be
expanded into a DAG, registry, event bus or second domain model.

## Decisions

- Mark proposal 0005's isolated implementation slice `validated`, not
  `adopted`.
- Stop generic task/summary infrastructure work after candidate 0056. A future
  production integration decision must start from the frozen hashes and a real
  API/ORM mapping; it may not quietly continue this candidate in place.
- Keep old `summary_tasks_v2`, FastAPI, provider, Android and migration paths
  unchanged. No dual write or cutover exists.
- Preserve successful historical artifacts after transcript changes. Exact
  replay is read-only; a new source snapshot uses a new task.
- Privacy deletion rejects wrong domains before reporting global integrity
  faults. Unattributable orphan attempts fail closed and require database
  repair rather than cross-capability deletion.

## Portfolio return

The next active architecture problem is meeting-question latency and semantic
citation support, not another task-kernel layer. Work resumes from the existing
Q2-S boundary:

1. finish the semantic review and correction of the 50-claim/54-sufficient-set
   natural meeting evidence contract;
2. separate retrieval sufficiency, reader semantics, citation integrity and
   provider execution in evaluation;
3. compare the current multi-pass Q0, a single attributed reader, and a compact
   specialized-reader replacement under identical public evidence conditions;
4. do not add a third prompt repair, dense fallback, NLI pass, prefix cache or
   production model call before the evaluation boundary can attribute failure.

Speed work must measure time to first answer and total calls, while quality work
must judge whether every displayed claim is semantically supported, not merely
whether a source ID belongs to the meeting. No private meeting, production
model, GPU reassignment or service change is authorized by this revision.

## Evidence

- [candidate 0056 independent pass](../evidence/candidate-0056-device-summary-v3-owner-independent-pass-20260817.md)
- [revision 0028 cutline](0028-device-summary-v3-owner-cutline-20260817.md)
- [meeting QA semantic attribution](../research/0022-meeting-qa-semantic-attribution-and-reader-challengers-20260816.md)
- [meeting QA evaluation lineage](../research/0023-meeting-qa-evaluation-log-and-blind-adjudication-20260816.md)

