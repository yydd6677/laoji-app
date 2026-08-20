# Summary V3 CPU-embedding performance candidate

Date: 2026-08-20

Status: isolated performance candidate; warm distribution gate subsequently passed; production API was not
redeployed or switched.

## Bottleneck evidence

The r4 35.5-minute single-pack sample completed in `41.602s`, `58.089s` and `58.037s` across the
authoritative 30-run distribution. A content-free local phase diagnostic on the same input measured:

- evidence package / embedding: `10.252s`;
- generation and verification: `46.929s`;
- Ollama load duration inside generation: `23.626s`;
- prompt evaluation: `4.030s` for 8,328 provider tokens;
- output evaluation: `14.754s` for 1,251 tokens;
- deterministic verification: less than 10ms.

The long-meeting GPU embedding runner therefore evicted the warm 9B generator. Prompt or verifier
changes cannot recover the 23.6-second model reload.

## Candidate change

- `embed_texts` accepts a call-scoped context length while preserving the existing default for Q2.
- Summary evidence selection defaults to `SUMMARY_V3_EMBED_NUM_CTX=2048` and
  `SUMMARY_V3_EMBED_NUM_GPU=0`.
- Q2's existing cold/warm embedding policy is unchanged.
- Both values remain environment-configurable for a future host with more GPU headroom.
- Handler revision advances to `summary-facts-v3-chapter-r5`; prompt, provider adapter and model remain
  `facts-v3-r15 / provider-v3-r2 / ollama:qwen3.5:9b`.

The evidence chunks are bounded to 360 characters. The 2,048-token context is therefore conservative
and does not truncate a chunk. CPU placement does not change the embedding model or MMR algorithm.

## Resource probes

Before the change, GPU0 had approximately 1.6 GiB free. An obsolete disconnected LaoJi Stage 2
candidate on `18021` held approximately 498 MiB; it was stopped without deleting its source or data.
Production `18020/8030`, current candidate `18023/8031`, GPU1, PCB, Smart Meeting and other user
services remained running.

- GPU embedding at 2,048 context used approximately 1.157 GiB VRAM and left only about 518 MiB free.
- CPU embedding used `0` VRAM and approximately 1.113 GiB model memory while the 9B generator kept
  its 16,384 context and approximately 9.219 GiB VRAM residency.
- GPU0 returned to approximately 2.1 GiB free after CPU placement.

## Real device-v2 smoke

Reports:

- `stage3-runtime-r5-cpu-embed-smoke-35166292748-20260820.json`, SHA-256
  `1ff222e5a49ea383c96611cff080a845a137bc3c936ef1d9c7d7547d56b8f89b`;
- `stage3-runtime-r5-cpu-embed-warm-smoke-35166292748-20260820.json`, SHA-256
  `339164915e81340948969a2504038a8d0e6f6e01d3d0e77d2b377bd771d28f5c`.

Both runs used the same 782-item, 35.5-minute source fingerprint and produced the same overview hash,
3 facts, 2 action candidates and 9/9 exact citations. Both completed on attempt 1 and purge-confirmed
their candidate binding.

- first r5 run: `55.564s` end-to-end;
- subsequent warm run: `27.074s` end-to-end.

A warm local phase diagnostic after both runners were resident showed 15.359s Ollama total duration,
0.415s load duration, 1.939s prompt evaluation and 9.969s output evaluation. CPU evidence selection
was exposed to unrelated host load and is not promoted as a formal latency result.

## Stable distribution follow-up

At the initial measurement time the server load average was approximately 67, with another project using several
CPU emulators and extraction jobs. Those services were not stopped, so the distribution was initially deferred.
It has now been rerun after the host returned to a lower starting load, while retaining the real shared-load spikes:
30/30 succeeded, single-pack p50/p95 were `15.368s/35.498s`, and the complete evidence path p95 was `60.483s`.
See [r5 stable latency](SUMMARY-V3-R5-STABLE-LATENCY-20260820.md). The Summary warm performance gate is now
closed; cold-start, mixed Q2, independent human quality and capability gates remain separate.
