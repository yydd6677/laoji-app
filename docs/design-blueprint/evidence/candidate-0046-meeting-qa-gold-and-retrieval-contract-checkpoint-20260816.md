# Candidate evidence 0046: meeting-QA gold and retrieval contract checkpoint

## Boundary

- candidate: `$CANDIDATE_ROOT/meeting-qa-natural-holdout-0014`
- public source: four pinned AISHELL-4 TextGrid transcripts, 2,441 segments
- production prompt/reader/private meeting/service/device/GPU access: `none`
- source transcripts are natural meeting speech; authored questions are not
  natural LaoJi user-query evidence

## Gold review result

The first independent reviewer rejected and revised 19 of 44 draft cases. A
second reviewer read the complete meetings and accepted 18 revisions but
rejected broad `NAT-024`. Its question was limited to product and customer-service
training, its product quote narrowed to an exact substring and an explicit guard
added against interpreting the anomalous source phrase `客户儿企业`. A third
reviewer then read all 716 segments of that meeting and accepted the revision.

Current gold state:

- cases accepted: `44/44`;
- answer/insufficient: `34/10`;
- supported claims/evidence items/forbidden claims/follow-up contexts:
  `50/109/48/4`;
- corpus SHA-256:
  `585c742177ce31ed8d6cd8d558c8dc37bcbe6994672e0c2503437e091a95c218`;
- gold SHA-256:
  `f23b26485abfe5df9690c933a7dcc9474666242c8a0ccc2f28ff14a98f78ae44`;
- `promotion_eligible=false` remains deliberate.

The review chain is preserved in `REVIEW.md`, `SECOND_REVIEW.md`,
`POST_REVIEW_CORRECTIONS.md` and `THIRD_REVIEW.md`.

## Retrieval contract draft

`evidence_requirements.json` now binds all 50 claims to 54 sufficient sets:

- outer sets are OR; members inside one set are AND;
- 4 claims have alternative sets;
- 7 final-status claims require an exact complete-meeting snapshot rather than
  a local window;
- every claim binds question plus previous turns, fact, meeting and gold digest;
- every source binds content hash, quote hash and exact UTF-8 byte range;
- complete snapshots are recomputed from ordered source IDs/content hashes and
  raw source revision, not accepted as a caller-authored string;
- stale source hashes, incomplete AND sets and wrong complete snapshots fail the
  mechanical sufficiency function.

Current evidence artifact SHA-256 is
`d7bad863022834d5824850d308bb6b68948bf8a3d77b611a10c40164f5124bce` and
must be refreshed after any annotation edit. It remains `author_status=draft`
and `independent_review_status=pending`.

## Mechanical verification

- Draft 2020-12 gold and evidence schemas pass;
- domain source/digest/review gates pass;
- build/gold/evidence tests: `12/12`;
- accepted gold is not used to auto-promote the retrieval contract.

These checks do not prove semantic sufficiency. A local Claude Opus 5/max,
non-fast review was attempted twice in the same session, but both calls reached
the five-minute tool limit without returning findings. A subsequent four-way
meeting-slice orchestration returned no slice after about ten minutes and was
terminated. No partial output was adopted. This is an external audit block, not
a pass or rejection; the same MCP shape will not be retried again.

## Decision

The gold-review stage is closed for this 44-case diagnostic set. The retrieval
stage is not. Do not run a reader or construct 44x4 scores until another
independent reviewer checks every sufficient set and the seven closed-world
claims. Once a real model sees these cases, they become development diagnostics;
an unseen adoption set is still required.
