# Candidate 0050: question atomicity audit and repair

- candidate: `$CANDIDATE_ROOT/meeting-question-slice-b-0019`
- status: `second independent audit BLOCK; second repairs 89/89 self-tested; re-audit pending`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Independent findings

The independent audit reproduced:

- same-binding task-ID ABA: an old DELETE cancelled a newly inserted task with
  the same ID, capability, binding and reset cancel revision;
- forged active claim: changing only `provider_request_id` or `cancel_revision`
  still allowed stage/failure mutation.

It separately confirmed that cross-binding lookup did not invoke authority or
scrub results, replacement tasks under another binding were not read/cancelled,
revoked successful result bodies were removed, and the direct API no longer had
a require-then-act binding window.

The second independent audit confirmed both earlier blockers were closed, then
reproduced two mobile-owner defects:

- an unattached intent could commit a `server_task_id` already attached to a
  different intent because `commit_result()` skipped the global owner check;
- a request ID already archived in a final turn could create another pending
  intent and permanently occupy the next ordinal.

## Repairs

- Device GET/DELETE now require the client request ID persisted before network
  delivery. Kernel lookup/cancel filters `logical_request_key` in the same
  `BEGIN IMMEDIATE` transaction as authority and state mutation.
- A same-binding replacement with a different request ID remains untouched by
  an older GET/DELETE.
- Kernel claim identity is split into immutable task identity, current cancel
  generation and immutable attempt identity. Renew, stage, checkpoint, complete
  and failure all verify the relevant task and attempt identities.
- Provider request ID and attempt number are checked alongside attempt/task IDs
  and lease generation.
- Completion treats only a server cancel revision greater than the claim as a
  late-cancel fence. A forged higher claim revision is rejected without changing
  task or attempt state.
- The question adapter requires current cancel identity for worker mutations but
  lets completion reach the kernel so a legitimate late result is durably fenced
  instead of becoming an adapter exception.
- The summary adapter now returns the existing kernel task ID when a caller
  proposes a fresh UUID for the same immutable logical request. It still rejects
  any request, payload, policy or handler drift. This matches the real service's
  create-then-dedupe call shape without creating a second row.
- `commit_result()` now checks both intent and turn owners inside its existing
  `BEGIN IMMEDIATE`; an unattached intent must atomically claim an unowned remote
  task before any result validation or turn insertion.
- `create_intent()` rejects request IDs already present in final turns before
  ordinal allocation.
- Summary scope privacy deletion now has a same-transaction participant contract
  and fails closed when scoped summary work exists without payload cleanup.

## Verification

```text
python3 -W error::ResourceWarning -m unittest discover -s tests -v
Ran 89 tests: OK

python3 -m py_compile generation_task_kernel.py production_summary_adapter.py \
  question_task_adapter.py device_question_api.py tests/*.py
PASS

updated adversarial probe:
- same-binding replacement GET: PermissionError; result not leaked
- same-binding replacement DELETE: PermissionError; replacement remains queued
- forged provider/cancel claim: no worker mutation
- cross-intent remote task capture: rejected; original owner unchanged
- completed request-ID recreation: rejected; no pending ordinal leak
```

Self-test success does not reverse the independent BLOCK. The exact repaired
hashes below require re-audit before sealing.

## Repaired hashes

```text
generation_task_kernel.py                 00d83b073ecd3f63bdab4398ae6780b1683535ee68aadcd09b6ba58c2ea6ca7c
production_summary_adapter.py             4f1f5eed883b8b32da19347371f032d6e90f28606c66007519d325aa9a94d646
question_task_adapter.py                  df12bbeff3f89d8b060e1b8c39722933a8fabfadb9ed6454ee0e04e966a475bd
device_question_api.py                    b12ee6aad95ce85842978061e8ed39903ce8d0a4bf6ce95720c934302fd59600
tests/test_generation_task_kernel.py      ad8979784413eceab69b26259ea26ee162f4f4eb184a31ded67697ab30a259fc
tests/test_production_summary_adapter.py  43ff5c4e2a4a37c4ef623d9b0515cdcbfa70970a95d9fc085ae168a6d703b365
tests/test_question_task_adapter.py       7fa3f46089d209d526cd8725d1a1df872944c2ac721611a3eb3d786fed606dab
README.md                                  b40378c065294a7b326f5e05a9d7713c1d09a18685338a90cb9f92f59ae2fa2f
ADAPTER_MAP.md                             d4f5810b54d89fae16cdfeb2b42091e402e812ec71f7f54caf95dcacf605c092
```
