# Candidate evidence 0041: natural meeting-QA gold review

> Historical first-review checkpoint. Post-review corrections, second/third
> adjudication and the current gold digest are recorded in
> [candidate 0046](candidate-0046-meeting-qa-gold-and-retrieval-contract-checkpoint-20260816.md).

## Boundary

- candidate: `$CANDIDATE_ROOT/meeting-qa-natural-holdout-0014`
- production prompt/model/private meeting/service/device/GPU access: `none`
- corpus: four pinned AISHELL-4 TextGrid transcripts, 2,441 segments
- corpus SHA-256: `585c742177ce31ed8d6cd8d558c8dc37bcbe6994672e0c2503437e091a95c218`

## Independent review result

The first independent reviewer read the four complete meetings and checked every
case, not only each cited window. The original 44-case draft was not accepted:

- accepted unchanged: 25;
- rejected and minimally corrected: 19;
- final frozen/accepted cases: 44;
- final answer/insufficient split: 34/10;
- supported claims/evidence items/forbidden claims/follow-up contexts:
  `50/111/47/4`.

The rejected cases and their concrete corrections are preserved in
`REVIEW.md`; they cover over-broad questions, unsupported presuppositions,
missing counterevidence, incorrect status certainty, ambiguous follow-up scope
and imprecise paraphrase. This is evidence that a real public meeting corpus is
not automatically trustworthy gold.

## Reproduction

- `build_holdout.py verify`: passed;
- `validate_gold.py`: 44 accepted, all eight categories present;
- unit tests: 4/4 passed;
- `gold.json` SHA-256:
  `cb53df62617762306550251990f4dd96206039c94311b3fe6e26694821f5c238`;
- `REVIEW.md` SHA-256:
  `6db7d78d74d3632a98ff2d14b53e6a8da2da1a0ed6dadb1e300d90208aa1f9d7`.

## Decision

The case content passed a first independent review, but
`promotion_eligible=false` remains deliberate. A second reviewer must check the
19 revised cases, and the 50 claims need explicit AND/OR sufficient-evidence
sets before retrieval attribution. Until both gates close, the suite may be
inspected but not scored and cannot support a quality-improvement claim.
