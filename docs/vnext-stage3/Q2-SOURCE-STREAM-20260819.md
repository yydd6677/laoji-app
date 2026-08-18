# Stage 3 Q2 source-stream vertical slice

- status: `isolated candidate; not production`
- observed: 2026-08-19 Asia/Shanghai
- production mutation: `none`

## Closed in this slice

Q2 no longer needs to copy a long immutable source snapshot into the reader
request. The device can create a `question` source stream, upload one ordered
chapter in at most eight bundles, and submit only `source_stream_id`, `task_id`
and the source fingerprint to `questions-v2`. Short sources keep the existing
direct request path.

The server now distinguishes question streams from Facts streams at bundle
commit. The final question chapter enters `complete` without entering the Facts
worker. The reader path then:

1. validates the device/epoch/binding fence and the task input fingerprint;
2. decrypts and hash-checks every immutable source item;
3. performs the existing single Q2 reader call;
4. atomically marks the generic Task as `success/content_outcome`, removes the
   source stream and all encrypted payload/manifest reservations, and leaves no
   active task on success.

Provider or lease failures do not delete the source stream. The task remains
retryable and a request replay with the same task ID returns the committed
result after a successful transaction. No Q0 fallback, summary worker or
second model call is introduced.

Expired streams are cleaned opportunistically at the device source/Q2 API
boundary. Their task becomes terminal `SOURCE_STREAM_EXPIRED`, while the
stream cascade removes encrypted payloads and reservations; cleanup never
logs source text or identifiers beyond the opaque task boundary.

## Code boundary

- `vnext_source_stream_store.load_question_source_stream` is a read-only,
  complete-snapshot loader.
- `vnext_source_stream_store.commit_question_result` owns the single atomic
  success/cleanup transaction.
- `device_v2.Q2ReaderRequest` accepts optional `task_id` and `source_stream_id`
  while preserving direct `sources` requests.
- `questionQ2DeviceProvider` builds the source manifest/bundle hashes and uses
  the stream path only when the source text exceeds the bounded direct-path
  threshold and `source_stream_v2` is advertised.
- `SourceStreamSnapshotV2` now exposes the stream capability for strict client
  state handling.

## Verification

- Source-store regression, including encrypted payload recovery, question
  complete state, atomic result publication and TTL cleanup: `10 passed`.
- Device-v2 API regression, including direct compatibility and stream replay by
  task ID: `7 passed` in the focused file; combined source/API set: `17 passed`.
- Q2 reader regression, including the verified-stream larger-item path:
  `15 passed`; combined Q2/source/API set: `32 passed`.
- Contract artifacts regenerated and verified with
  `PYTHONPATH=services/laoji-api .venv-vnext/bin/python contracts/vnext/generate.py --check`.
- `npx tsc --noEmit --pretty false`, Python `compileall`, and `git diff --check`
  pass in the isolated worktree.

## Remaining gates

This is not a Stage 3 exit or production approval. Still required are long
meeting source-stream Android upload/restart/network replay, independent
human citation relevance review, real device recovery, resource/capability
barriers, legacy drain and the public zero-traffic period. Production Q2,
Summary V3, 18020/8030 and the public endpoint remain unchanged.
