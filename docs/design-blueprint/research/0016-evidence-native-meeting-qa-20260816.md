# 研究 0016：证据原生会议问答反事实

## 状态

- status: `research candidate; not adopted`
- date: `2026-08-16`
- target: replace sample repairs and multi-pass generation, not add another
  compatibility facade around them.

## Current, minimum and replacement routes

| Route | Shape | Expected result | Decision |
|---|---|---|---|
| Q0 current | hybrid retrieval + sample fast repairs + generation + verifier/editor/recovery | preserves rollback, but slow and non-general | frozen baseline |
| Q1 minimum refactor | delete sample literals but keep the multi-pass topology | removes contamination but retains latency and hidden state | not enough as target |
| Q2 evidence-native reader | immutable evidence snapshot, adaptive full-context/retrieval, one structured generation, deterministic source validation | fewer calls and owners; direct citations | next isolated candidate |
| Q3 dedicated reranker/late chunking | Q2 plus token-aware embedding or a 0.6B cross-encoder | potentially higher long-meeting recall, but adds runtime/resource cost | deferred challenger |

## Research inputs and limits

1. [LongRAG](https://arxiv.org/abs/2406.15319) reports that long retrieval units
   and long readers can reduce retrieval fragmentation. Its Wikipedia metrics
   are not LaoJi evidence. For one short meeting, they support testing the full
   transcript as one evidence unit before building a complicated chunk graph.
2. [Late Chunking](https://arxiv.org/abs/2409.04701) embeds the long context before
   pooling chunks. Current Ollama `/api/embed` exposes pooled vectors only, so
   adopting it would require a different embedding runtime. It is not a free
   configuration change and is deferred until Q2 shows a retrieval miss.
3. [LongMemEval](https://arxiv.org/abs/2410.10813) separates indexing, retrieval
   and reading, and reports value from temporal/query-aware retrieval. Its
   multi-session chat benchmark is not a meeting-QA score, but the separation is
   applicable to transcript revisions and conversational follow-ups.
4. [RAGChecker](https://arxiv.org/abs/2408.08067) evaluates retrieval and
   generation failures separately. LaoJi should report evidence recall,
   citation support, answer support and abstention separately rather than one
   pass rate that can be raised by fixed answers.
5. The official
   [Qwen3-Embedding-0.6B model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
   states 32K input, instruction-aware queries and Matryoshka dimensions. LaoJi
   currently requests 256 dimensions, but model-card benchmark claims cannot
   replace a Chinese meeting retrieval evaluation.
6. The official
   [Qwen3-Reranker-0.6B model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)
   provides an instruction-aware 32K cross-encoder. It adds another model and
   should only enter Q3 if measured retrieval recall justifies the resource.

## Q2 target contract

### Product scope

The meeting question surface answers from the current meeting. General knowledge
is not silently mixed into this capability. A general assistant, if retained in
future product design, must be a separate mode and contract. Previous turns can
resolve pronouns and requested scope, but are never factual evidence.

### Evidence snapshot

```text
MeetingQuestionEvidence {
  meeting_binding_id
  transcript_revision + transcript_hash
  ordered transcript segments(id, time, speaker, text, hash)
  manual_note_revision + note_hash + content
  authorized attachment revisions
  question_thread_context
}
```

The snapshot is immutable for one request. A citation must resolve to this exact
snapshot. Generated summary text can help navigation or overview display, but a
specific factual answer must resolve to transcript, note or authorized attachment.

### Adaptive evidence reader

- Count provider tokens, not characters.
- If the complete snapshot fits the measured input budget, send the complete
  ordered transcript and note. Do not retrieve away relevant middle evidence.
- Otherwise build contiguous, time-ordered windows over stable segment IDs.
  Use SQLite FTS lexical rank plus instruction-aware dense embeddings, reciprocal
  rank fusion, adjacent-window expansion and diversity selection.
- Always retain corrections, negations, question/answer adjacency, explicit
  numbers/times and sources pinned by the previous turn. These are selection
  signals, not answer rules.
- Preserve direct source segment IDs after window selection. A window is not a
  user-visible citation.

### One generation

Normal requests call `meeting.answer.v2` once at temperature zero. Output is a
schema with `answer_kind`, concise answer clauses and source IDs per clause.
Only invalid JSON may receive one format repair. There is no normal-path scope
classifier, verifier, final editor, exact-slot model or partial recovery model.

Deterministic validation checks schema, current-snapshot identity, citation
existence, quote/hash consistency, source type authorization and unsupported
numeric/name/time fields. It cannot claim semantic entailment from string overlap;
unsupported clauses fail closed or the complete answer becomes insufficient.

## Migration and deletion budget

1. Add an isolated shadow endpoint and request identity. Do not change current UI.
2. Replay identical evidence through Q0 and Q2. Log only hashes, stages, call
   counts and timing; never log question, answer, transcript or note text.
3. Promote Q2 only after independent held-out review.
4. In the same migration that selects Q2, delete the general-scope model call,
   all sample-specific repair/answer branches, normal strict-verifier call,
   final editor, recovery generation and summary-as-factual-source fallback.
5. Keep Q0 as whole-route rollback for one release. Do not dual-write two
   answer histories or call both paths for real private meetings without explicit
   local evaluation authorization.

## Gates

- production prompt/source scan: no evaluation title, person, topic or fixed
  answer; no 16-character Chinese overlap with held-out transcript/answer assets;
- normal model calls exactly 1, invalid-JSON repair at most 1;
- 100% returned citations resolve to the exact meeting snapshot and authorized
  source revision;
- strict human claim support at least 95%, with separate retrieval recall,
  answer support, abstention and follow-up scores;
- no cross-meeting source, no unsupported number/date/person, no sample answer;
- on the same warm local model and evidence, median and upper-tail latency must
  improve by at least 40%; candidate target is median <=10 s and observed p95
  <=18 s, but relative comparison remains authoritative for a small sample;
- Q2 must remove more production concepts and branches than it adds;
- short and long meetings, manual note conflict, correction, negation,
  enumeration, multi-turn pronoun, unavailable evidence and malicious source text
  all belong to the held-out gate.

If two Q2 iterations cannot meet support and latency gates without adding sample
rules or a second normal model pass, reject Q2's reader/model combination and
compare Q3. Do not patch a third time.
