# Candidate evidence 0043: diagnostic 0016 independent rejection

## Result

`meeting-qa-diagnostic-0016` is rejected. It retains useful contract tests, but
29 passing self-tests do not close the provenance chain from the real invocation
to the real output and its human assessment.

## Reproduced blockers

1. The final provider `output_sha256` is never compared with the reviewed
   `answer_sha256`; the fixture itself uses different hashes and still passes.
2. Provider request IDs need only be unique within one observation. All four
   conditions can reuse the same request/output and masquerade as independent
   evidence conditions.
3. `claim_coverage` is not derived from clause-to-claim links. An owner-only
   clause can self-declare deadline coverage.
4. Citation integrity checks only that a cited source belongs to the payload; a
   deadline clause may cite an owner-only source and self-declare integrity.
5. Gold/retrieval promotion and reviewer status are strings plus refreshed
   hashes, not a parsed review decision bound to the reviewed cases. Reviewer
   identity may also drift across all conditions.
6. Repair attempts do not bind provider/reader/prompt/schema identities per
   invocation. Reporting only the final attempt can hide the original schema
   failure behind a repair timeout.
7. Boolean schema versions are accepted, p95 can be lower than p50 for two
   samples, and the evaluator source revision is absent from the report.

## Preserved evidence

The following design constraints remain useful: full/empty/oracle payload
construction, content-hash binding, per-claim AND/OR retrieval requirements,
separate execution and response-protocol states, and separate semantic,
coverage and citation axes. They are requirements, not reusable implementation.

## Decision

This is the second failed custom attribution harness. The anti-local-optimization
rule now forbids a third patch series. Reframe Q2 evaluation as three separately
auditable artifacts:

1. authoritative raw run log;
2. deterministic offline scorer reading that raw output directly;
3. blinded human adjudication with provenance.

Only after those artifacts are joined by stable sample identity may a separate
attribution report compare four conditions.
