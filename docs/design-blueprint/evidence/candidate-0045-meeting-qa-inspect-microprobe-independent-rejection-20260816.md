# Candidate evidence 0045: Inspect micro-probe independent rejection

## Boundary

- candidate: `/home/yydd/LaoJi-candidates/meeting-qa-inspect-microprobe-0017`
- verdict: `BLOCK; fixture-only; rejected for Q2-E proof`
- production/private meeting/real model/device/GPU mutation or access: `none`
- audit method: clean rerun plus adversarial temporary copies; candidate logs were
  not overwritten

## Clean-snapshot controls

The unmodified candidate still proves a narrow mechanism boundary:

- 16 samples, 17 model events and one repair rebuild successfully;
- 17 request IDs are unique within the raw log;
- raw/scored/reviewed completions and the current manifest hashes agree;
- raw has no scores; offline scoring and score-edit history are separate;
- attachment resolution works;
- scorer tests `5/5` and the 84-package environment check pass.

Current log SHA-256 values are raw
`d2435a4470486b96958bca0543b3de10c780474a236b02b1698d3aa2f857bad3`,
scored `1ad1d05c9670bac582b0f47a2b70c150f1b9ae4aeb2fbd7d12e35606e6293733`
and reviewed
`bf4af4f3e7f69f7f0672bab6a97d84541cbb8f83cb07852226824b79312fbf6a`.

These facts show that Inspect can host the stages; they do not establish a
trustworthy provenance chain.

## Reproduced blockers

1. `ModelCall` request/response and invocation identity are provider-authored.
   Actual `ModelEvent.input` can differ from the recorded request, and repair
   provider/runtime/reader/prompt/schema/messages can all change after
   recomputing the self-reported digest. Fresh offline scoring and verification
   still pass.
2. Scored and reviewed logs are full mutable copies, not overlays bound to one
   raw parent. All derived-log request IDs can be replaced by one reused value
   without rejection.
3. The private condition map can regroup samples arbitrarily. The verifier only
   checks that four labels are present, not that each label corresponds to its
   precommitted question/evidence transform.
4. The blind export is only label-masked. The actual model name can be inserted
   without rejection, and evidence amount reveals no/full/oracle conditions.
5. Review authors are unauthenticated fixture strings. Most histories can be
   removed and the sole correction made a no-op while verification passes.
6. Scorer source can drift after the logs were produced. Recorded source hashes
   exist but are not fail-closed inputs to verification.
7. A false deadline can cite the correct source ID but quote an unrelated
   substring from that source; schema, citation and grounded coverage still
   report true. Gold claim IDs are also leaked to the fake output contract even
   though a production reader cannot receive them.
8. The 17 deterministic request IDs are reused across rebuilds, so they are only
   unique within one log, not globally.

Detailed commands and the exact temporary mutations are preserved in the
candidate's `INDEPENDENT_AUDIT.md`.

## Decision

Freeze the current proof shape. Do not fix the blacklist typo or add another
layer of verifier assertions and then connect a real reader. Keep only Inspect's
mechanics for raw logging, attachment resolution, separate offline scoring and
append-style score edits.

A successor must use production-equivalent reader I/O without gold IDs; digest
actual messages/config and the repair parent outside the provider; precommit and
verify condition transforms; represent derived stages as overlays on a raw
parent digest; use field allowlists plus access isolation for review; authenticate
review provenance; and leave semantic clause-to-gold mapping to blinded humans.
