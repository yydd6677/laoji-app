# 候选 0010：Recognizers-Text 时间实体适配器

## 状态与范围

- status: `candidate; isolated-library-probe; not adopted`
- observed: 2026-08-16 Asia/Shanghai
- package: `@microsoft/recognizers-text-suite@1.3.1`
- license shown by package metadata: MIT
- installation location: `/tmp/laoji-recognizers-20260816` only
- no private audio, transcript, notes, database, production service or APK was touched

## Reproduction

```bash
npm install --prefix /tmp/laoji-recognizers-20260816 --no-audit --no-fund \
  @microsoft/recognizers-text-suite@1.3.1
NODE_PATH=/tmp/laoji-recognizers-20260816/node_modules \
  node /home/yydd/LaoJi-candidates/schedule-semantic-draft-0001/recognizers_replay.mjs
```

The installed `node_modules` occupied about 43 MiB; the suite package itself
occupied about 11 MiB. This is a local package footprint, not an Android bundle
or server RSS measurement.

## Observed temporal behavior

Using `zh-cn` and reference `2026-08-16T10:00:00+08:00`:

| Input | Raw entity result | Safe M1 interpretation |
|---|---|---|
| 明天下午三点半到五点开会 | one `datetimerange`, 15:30-17:00 | candidate interval |
| 明天三点开会 | two datetime values, 03:00 and 15:00 | preserve ambiguity; require clarification |
| 下午三点开会 | time-only 15:00 | no invented date |
| 下周一上午九点 | datetime 2026-08-17 09:00 | candidate date/time |
| 明天下午开会 | range 12:00-16:00 | period candidate, not an explicit end time |
| 每周一下午三点 | `set`, `value: not resolved` | unresolved recurrence; do not save silently |

The raw result contains source spans and TIMEX-like values, which is useful for
the `ScheduleSemanticDraft` evidence contract. It does not provide a title,
create/query/delete intent, reminder semantics, user confirmation, or LaoJi
category mapping.

## Narrow runtime observation

On this host, after warm-up, 6,000 calls over the six phrases took about
2,964 ms (`0.494 ms/call`). This is a Node warm microbenchmark with synthetic
short text; it is not an Android, server p95, cold-start, concurrent, or quality
measurement.

## Decision

Keep as a read-only temporal candidate extractor inside the M1 comparison. Do
not replace either current parser, do not let it choose a single ambiguous
value, and do not infer that its MIT code license covers every future model or
runtime dependency. A production proposal requires Chinese natural holdout,
timezone/DST/repetition tests, adapter parity, and a deletion plan for existing
rule owners.
