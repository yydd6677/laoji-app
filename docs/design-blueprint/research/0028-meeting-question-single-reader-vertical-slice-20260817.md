# Research 0028: meeting-question single-reader vertical slice

## Boundary

- date: `2026-08-17 Asia/Shanghai`
- status: `pre-registered architecture research; not adopted`
- production/private meeting/model/GPU/device mutation: `none`
- public evaluation data only: four pinned AISHELL-4 TextGrid transcripts

## Baseline observed again

Read-only SSH on 2026-08-17 found the deployed question module still at:

`/home/zhong/laoji-service-platform/compact-production/backend/app/services/app_meeting_question.py`

- 5,826 lines;
- SHA-256 `e156702b3f380b8c568c35b7a265f50dc05f4294da7da85f72d8cd390d1c9fcb`;
- a pre-model fixed-answer loop, unified generation, scope correction,
  transcript-only review, strict verifier, optional editor/slot extraction and
  recovery generation remain reachable.

The local synchronized service copy is 5,803 lines with a different hash. It is
useful for code analysis but is not evidence of the deployed bytes. The target
decision relies only on behavior shared by both copies.

## Why the slice starts with evidence ownership

The original retrieval annotation contained 54 sufficient sets. Human review
accepted 42, required revision of 11 and rejected one. A later mechanical
reduction audit incorrectly called the rejected `NAT-001.C1.S1` valid because
it treated `外省停车` as equivalent to all `外来车辆`. This shows why quote
existence, content hash and source membership cannot establish semantic scope.

The repaired candidate has 50 claims and 53 sets. It removes that false
alternative, narrows five quotes, restores a missing antecedent, corrects the
stair/location question, removes three redundant support members and preserves
complete-meeting scope for final-status claims. Schema/domain tests pass, but
the repaired hashes still require independent semantic review.

## Recent alternatives and limits

### Specialized attributed reader

[OCC-RAG](https://arxiv.org/abs/2606.00683) trains 0.6B and 1.7B Qwen3-base
models for context-grounded QA, abstention and structured source attribution.
Its official model cards list English and Russian, use synthetic multi-hop data
and cap evaluated reasoning depth at three hops. It supports the hypothesis
that a specialized small reader can replace several generic passes; it does not
justify direct Chinese production deployment. A Chinese/ASR challenger would
need separate training data, tokenizer/runtime checks and an unseen adoption
set.

### Natural evidence trails

[WildTrace](https://arxiv.org/abs/2607.09328) builds questions only after
identifying source-internal causal, temporal, comparative and other evidence
trails, and rejects candidates through leave-one-out and shortcut checks. Its
481 released tasks survived from 3,506 candidates. That source-first and
minimality discipline is directly useful for LaoJi evaluation. The benchmark
is mainly long-form technical and literary material, with only an initial
Chinese literature slice; it is not a meeting-QA score and does not replace the
AISHELL-4/public meeting gate or later natural user queries.

### Nugget KV reuse

[CoinRAG](https://arxiv.org/abs/2608.07458) pre-extracts exact source-span
nuggets, retrieves them in two stages and composes position-aligned cached KV
slices. It reports a 5.3% relative average F1 improvement under its LongBench
fast-prefill budget. The method needs offline nugget extraction, model-specific
KV storage/composition and preferably nugget-aware fine-tuning. It can reduce
repeated prefill for many questions over an unchanged meeting, but it introduces
snapshot invalidation, privacy cleanup, cache storage and runtime coupling.
Therefore it is Q3 performance research, not part of the first single-reader
slice. Raw exact spans and source hashes may be adopted without adopting its KV
runtime.

## Contract under test

```text
MeetingSnapshotRef
  scope + epoch + meeting + policy revision
  ordered typed sources + exact revisions + content hashes
  coverage = complete | selected

EvidenceView
  ordered source spans from exactly one snapshot
  no gold IDs, answer, forbidden claim or hidden sufficient-set metadata

ProviderRequest -> ProviderResult
  one dispatch only
  atomic clauses, each with an all_of citation set
  typed execution and content outcome

GroundingGate
  exact snapshot/source/hash/UTF-8 range/authorization
  citation dedupe and containment reduction
  numeric/date/entity surface checks
  no claim of general semantic entailment
```

Complete short meetings are passed in source order without embedding. Long
meetings may use selected contiguous windows, but `not_stated` and final
`status_open` remain unavailable unless the exact complete snapshot is supplied.
Question history is reference context only. Summary output is never a factual
source.

## Pre-registered public slice

The first semantic slice is frozen before reader execution:

`NAT-002, NAT-003, NAT-004, NAT-008, NAT-012, NAT-013, NAT-019, NAT-021,
NAT-023, NAT-029, NAT-041, NAT-044`.

It contains 20 claims across direct, implicit, enumeration, wrong-premise and
follow-up questions. The selection excludes complete-meeting absence/status
cases from the first reader run because the current gate is clause support and
retrieval attribution. Those cases remain mandatory in the next slice.

Two evidence conditions are fixed:

1. `oracle`: only independently approved sufficient evidence, without gold
   labels or answers;
2. `retrieved`: the candidate retrieval view from the same immutable snapshot.

No-evidence and full-context conditions remain diagnostic overlays; they cannot
change raw provider output or share mutable result records.

## Measures and stop rules

- semantic provider calls: exactly one;
- oracle supported claims: at least `19/20`;
- retrieved sufficient-set recall: at least `19/20`;
- unsupported or forbidden displayed clauses: zero;
- exact citation snapshot/hash/range resolution: 100%;
- typed execution/protocol/grounding failures projected as insufficient: zero;
- same-provider/model Q2 latency improvement over Q0 median and upper tail:
  at least 40%; candidate targets p50 <=10 s and observed p95 <=18 s;
- cross-scope, cross-epoch or revoked publication: zero.

The first implementation uses a deterministic fake provider to attack the
contract. Real reader execution waits for independent review of the repaired
53-set evidence contract. At most two pre-registered reader combinations are
allowed. If both miss quality or latency, the result is evidence for Q3 or a
different reader, not permission to restore multi-pass repair.

