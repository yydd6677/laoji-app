# Candidate evidence 0044: Inspect provenance micro-probe self-test

> Historical self-test only. Independent audit subsequently rejected this
> candidate for Q2-E provenance proof; see [candidate 0045](candidate-0045-meeting-qa-inspect-microprobe-independent-rejection-20260816.md).

## Boundary

- candidate: `$CANDIDATE_ROOT/meeting-qa-inspect-microprobe-0017`
- status: `self-tested snapshot; superseded and independently rejected; not adopted`
- production/private meeting/real model/device/GPU access: `none`
- Inspect: PyPI `inspect-ai==0.3.258`, isolated Python 3.10 venv
- environment size: approximately 242 MiB; not a production dependency

## Architecture exercised

Four public fixture cases expand to sixteen condition-blind samples. A registered
deterministic `ModelAPI` runs through Inspect's normal generation path, so raw
requests, responses, configurations and outputs are framework-owned
`ModelEvent/ModelCall` records rather than LaoJi-authored observation booleans.

The raw `--no-score` log is never overwritten. A separate offline scorer reads
the raw completion directly and derives schema, source/quote validity and
per-claim grounded coverage. A separate blind export removes condition/model
labels. A reviewed log then appends fixture-only `ScoreEdit` provenance; one
deliberate correction preserves both reviewer histories. The private condition
map is joined only after review.

## Reproduced evidence

`run_microprobe.py` rebuilt the complete chain from empty `artifacts/` and
`logs/` directories in about five seconds:

- samples: 16;
- model attempts: 17;
- schema-triggered repair: 1, with both model events retained;
- globally unique request IDs: 17;
- deterministic negative controls: citation 2, grounded coverage 4;
- two-author correction histories: 1;
- scorer unit tests: 5/5;
- aggregate accuracy: `null`.

Artifact SHA-256:

- raw log: `e73aac039ed6f23c9495a5b10524b1d14f3c03ce567a81e123acde516e7a241d`;
- deterministic-scored log:
  `5b81dccb3cfd5f2c7f435006eccc9442be2bfdb9aae95e60db6bfdd72240c6e6`;
- reviewed log:
  `853a3be97897e48e4b2698091d87ec21e21bfa03fd3b1941439a922cc9f11007`;
- blind review bundle:
  `3b885c18f6434e988d4620a5a81c50007f374b543c42332045b94cf79d838ccb`.

Inspect de-duplicates repeated event content as attachments. Verification
explicitly resolves attachments before hashing; an `attachment://` reference is
not mistaken for raw output.

## What this does not prove

- no natural gold or real reader was run;
- fixture review is not human quality evidence;
- Inspect files are content-hashed but not cryptographically signed;
- no production adapter, latency or quality claim exists;
- the candidate has not passed independent adversarial review.

The next gate is an independent attack on output/event binding, request reuse,
repair identity, offline-score derivation, blind leakage and review history.
