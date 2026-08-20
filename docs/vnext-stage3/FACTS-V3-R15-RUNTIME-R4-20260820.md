# Facts V3 r15 / runtime r4 candidate evidence

Date: 2026-08-20

Status: isolated candidate evidence; not adopted; production was not mutated.

## Candidate identity

- API: `http://127.0.0.1:18023` through the local `28023` SSH tunnel.
- summary handler: `summary-facts-v3-chapter-r4`.
- provider adapter: `provider-v3-r2`.
- prompt: `facts-v3-r15`.
- model: `ollama:qwen3.5:9b`.
- candidate source directory:
  `/home/zhong/laoji-vnext-candidate/releases/vnext-stage3-runtime-fence-working`.
- production `18020/8030`, GPU1, PCB, Smart Meeting and other user services were not changed.

The API capability response supplies handler, prompt and model revisions. A summary source stream
must echo all three at admission, the durable stream/checkpoint stores the complete runtime identity,
and the artifact is rejected by the mobile candidate when prompt or model revision differs. The
provider adapter revision is stored in the artifact. A source, prompt, model or handler change creates
a new generation instead of silently resuming an older checkpoint.

## General fixes established by the holdout

- Long-evidence attention ordering now puts retained date/correction/responsibility sources first,
  without classifying them as facts or actions.
- Spaced Chinese dates such as `2026 年 8 月` participate in the same evidence-selection signal as
  compact dates.
- A provider action fact that redundantly repeats `owner/due/fit` no longer disappears. The adapter
  strips or relocates only those known projection fields; every other unknown field remains forbidden.
- A later final confirmation can resolve a correction conflict even when the old and new facts share
  the correction utterance and the new fact adds a later confirmation source.
- When the model emitted a verified action fact but omitted its root action projection, the server may
  recover one explicit bounded due phrase already present both in the fact and verbatim source. It does
  not infer an action, infer unbounded event time or add a keyword acceptance gate.
- The evidence package reserves 1,024 of the fixed 10,240 input tokens for fingerprints, coverage and
  up to 64 compact priority aliases. This closes the false `SUMMARY_EVIDENCE_INCOMPLETE` caused by
  metadata added after content selection while leaving at least 7,680 tokens for transcript evidence.

No production prompt contains a meeting example, evaluation title, sample-specific person, domain
term or style instruction. The evaluator scans every case title and every 16-character Chinese span.

## 24-case semantic manifest

Authoritative report:
`facts-v3-manifest24-r15-runtime-r4-20260820.json`

- SHA-256: `923cfd2e73e25697772cac3b787fc7d629e73179bf4c5340ff75ce718a56decd`.
- external manifest SHA-256:
  `6ce62e1fbfe1eb0c98e9f6f6634b9b00da25bd82e4d7a7ab7895b680fc76b038`.
- semantic cases: `24/24` passed.
- first-response Schema validity: `24/24`; repair calls: `0`.
- displayed citation exactness: `100%`.
- duplicate action cases: `0`.
- prompt few-shot count: `0`; prompt pollution findings: `0`.
- latency: p50 `4.455s`, p95 `35.372s`, maximum `46.122s`.

This is deterministic-manifest evidence, not an independent blind human fact-support or action-
usefulness review. It therefore does not close the blueprint's human `>=95%` gate by itself.

## Device-v2 real-source vertical

Report: `stage3-runtime-r4-vertical-smoke-20260820.json`

- SHA-256: `22de07aceb1239212753cf037b3d7a5eb82720d9faccfbddd3160d6064713bd4`.
- input: 72.1 minutes, 1,569 SRT items, two Android-aligned 48 KiB chapters.
- summary: success on attempt 1; end-to-end `67.917s`.
- final document: 21 facts, 48/48 displayed citations exact.
- artifact: `meeting.facts.v3`, `provider-v3-r2`, `facts-v3-r15`,
  `ollama:qwen3.5:9b`.
- encrypted binding/source/task data was purge-confirmed after artifact readback.

The first run failed with `SUMMARY_EVIDENCE_INCOMPLETE`; local reproduction proved that selected
source payload fit but the outer priority/coverage metadata exceeded the old 256-token reserve. After
the generic 1,024-token reserve fix, the same source completed. This failure was not a meeting-length
limit and no length rejection threshold was added.

## Thirty-run latency distribution

Authoritative report:
`stage3-full-source-latency-runtime-r4-20260820.json`

- SHA-256: `e4ac5ee100c602e0b60caf488ffc823ce4806d8681665a26689368f864baa5dd`.
- ten current SRT samples, three runs each: `30/30` succeeded, `0` failed.
- all tasks completed on attempt 1; all purge states were `confirmed`.
- one runtime identity across all runs: `chapter-r4 / facts-v3-r15 /
  ollama:qwen3.5:9b`.
- Facts citation exactness: `100%`.
- all samples: p50 `30.227s`, p95 `77.339s`, maximum `82.827s`.
- single-pack samples (`24`): p50 `21.724s`, p95 `58.925s`, maximum `63.671s`.
- at-most-one-hour samples are the same 24 single-pack runs and remain below the separate `90s`
  end-to-end ceiling.
- six two-chapter runs cover the two samples longer than one hour; all completed without a length
  rejection.

The single-pack p50 `<=20s` and p95 `<=45s` exit gates are not met. Stage 3 remains unadopted even
though completion, grounding and automated semantic checks passed.

## Rejected measurements

The following exploratory reports were deliberately removed and must not be used as evidence:

- a three-result run split at an artificial 600-second boundary;
- a run coupled to Q2, where question failures contaminated summary latency;
- a 30-run launcher whose local harness acquired new revision requirements while it was still
  spawning subprocesses, leaving 24 valid results and six local harness failures;
- the first manifest report whose evaluator checked nonexistent source byte offsets;
- intermediate focused smoke and pre-final 19/24 or 22/24 reports.

## Remaining Stage 3 exits

- reduce single-pack p50/p95 below `20s/45s` under a stable candidate;
- perform an independent blind human review for fact support, omission and action usefulness;
- complete the remaining attachment/epoch/binding recovery matrix and release-emulator negative
  SQLite mutation checks;
- close the complete Android template/action/history projection evidence;
- keep summary/Q2 capability barriers closed until all exit gates pass.

