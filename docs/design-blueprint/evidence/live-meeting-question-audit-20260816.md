# 会议问答生产现场审计 2026-08-16

## 状态与边界

- status: `observed; production read-only audit`
- time: `2026-08-16 Asia/Shanghai`
- production source was read through SSH only; no service, configuration,
  database, question, answer, transcript, note, or device was modified.
- request timing used metadata-only service logs. No user text was read.

## 生产事实

生产文件：

`/home/zhong/laoji-service-platform/compact-production/backend/app/services/app_meeting_question.py`

- SHA-256: `e156702b3f380b8c568c35b7a265f50dc05f4294da7da85f72d8cd390d1c9fcb`
- lines: `5,826`
- the production file contains the same reachable sample-specific repair
  families as the local service copy. It additionally contains a later manual
  note retrieval change, so the local copy is not an exact production snapshot.
- static inventory: 25 pre-model repair entries, 24 `*_evidence_answer`
  functions and 61 literal answer assignments. Not every extractor is
  sample-specific, but many reachable branches name exact evaluation subjects
  and return fixed answers such as `产业大厦`, `科技厅`, `电荷密度波`, `宠物项圈`,
  five-country nuclear-pollution proposals, fixed prices and fixed project outputs.

The fast-repair loop executes before the normal model path. Therefore matching
queries can return a hard-coded answer instead of testing retrieval and model
reasoning. The same helpers are invoked again during deterministic guarding and
after model verification. This is production behavior, not a test-only fixture.

## Model-call topology

For a normal meeting question that does not hit a fast repair:

1. unified generation calls the 9B model;
2. strict verification calls the model again;
3. concrete or exhaustive questions can add a transcript-only review;
4. long or structured answers can add a final editor and exact-slot repair;
5. a failed verification can add recovery generation.

The ordinary path therefore has at least two generation calls and can exceed
four. Scope classification can add another call because this meeting feature
also attempts to answer general-knowledge questions.

## Live latency and context

Eleven production question requests observed in metadata-only logs on 2026-08-16:

- minimum: `3,763.900 ms`
- median: `24,052.603 ms`
- arithmetic mean: `26,295.553 ms`
- maximum: `39,923.662 ms`

This is a small observational sample, not p50/p95 for all users. It is sufficient
to reject a claim that the current path is already a low-latency baseline.

`laoji-ollama.service` currently sets `MAX_LOADED_MODELS=2`, `NUM_PARALLEL=1`
and infinite keep-alive, but no explicit context-length environment variable.
`/api/ps` reported the resident `qwen3.5:9b` runner at context length `8192`.
The question code requests `num_ctx=12288` and treats up to 12,000 transcript
characters as a complete-input path. Character count is not a tokenizer budget,
and the observed runner context does not prove this request fits without
truncation or reload.

The embedding model was not resident at the observation instant. The provider
uses Ollama `/api/embed`, returning one pooled vector per input. It does not expose
token hidden states needed for late chunking.

## Current mobile projection mismatch

The isolated mobile speech candidate assumes an asset/generation projection
cursor, independent automatic speaker overlays and stable manual overlays.
The real Expo SQLite repository instead stores text and automatic speaker fields
inside `transcript_segments`; manual corrections are tied to a specific local
transcript revision/segment and also write `speaker_label_override` into that row.

`saveTranscriptRevision()` atomically replaces an active realtime draft inside
the repository transaction, but there is no remote projection cursor or atomic
cursor + text + automatic-speaker apply operation. A new final/reprocessed
revision can therefore change the active segment identities independently from
the old manual correction rows. Candidate 0005 remains `BLOCK integration`.

## Decision impact

The question path simultaneously violates four blueprint review triggers:

- sample and keyword branches keep growing;
- normal service work is unnecessarily serial;
- code, production source and model-context assumptions drift;
- quality fixes add more fallback paths instead of deleting concepts.

Meeting Q&A therefore moves ahead of upload owner convergence for the next
architecture candidate. Production remains frozen. The audit does not authorize
deleting current guards before a shadow replacement proves retrieval, citation,
abstention and latency quality.
