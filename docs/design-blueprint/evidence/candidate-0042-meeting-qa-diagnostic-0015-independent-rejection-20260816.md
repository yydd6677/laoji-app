# Candidate evidence 0042: diagnostic 0015 independent rejection

## Result

`meeting-qa-diagnostic-0015` is rejected and retained only as a reproducible
counterexample. Python compilation and 9 unit tests pass; that result does not
establish a valid attribution contract.

## Blocking findings

1. Four conditions share caller-authored identity strings, not a digest-bound run
   manifest. Full, retrieved and oracle evidence can be empty or from the wrong
   meeting without rejection.
2. One `_semantic_success` value combines semantic support, requested-slot
   coverage and citation integrity. Citation-only failures are therefore
   mislabelled as reader, retrieval or long-context failures, while a correct
   no-evidence answer with invalid citations can evade parametric attribution.
3. The gold loader discards question context, claim structure, quotes, forbidden
   claims, category, corpus digest and promotion state. Missing observations can
   appear as diagnosed cases because the review gate returns early.
4. Runtime types are not strict: string booleans, boolean latency and fractional
   latency coercion are accepted; contradictory content/citation states are not
   rejected.
5. Answerable questions containing unsupported or forbidden claims are not
   labelled hallucinations.
6. Retrieval recall flattens all source IDs into one required union and cannot
   express alternative or jointly required evidence per claim/slot.
7. Provider execution, response protocol and content are not three separate
   layers; completed invalid JSON/schema and repair attempts cannot be represented
   faithfully.
8. The report merges policy, orchestration, dispatch uncertainty and transport
   failure, omits input/run hashes, and labels case counts ambiguously.

## Decision

Do not patch 0015 into Q2-S. Replacement candidate
`meeting-qa-diagnostic-0016` binds reviewed inputs and evidence payloads to exact
hashes, models original/repair attempts, validates strict types and separates
semantic, coverage, citation, hallucination, protocol and execution axes. It is
still not adopted until a second independent audit passes.
