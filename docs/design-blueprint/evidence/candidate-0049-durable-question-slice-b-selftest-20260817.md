# Candidate 0049: durable question Slice B self-test

- candidate: `/home/yydd/LaoJi-candidates/meeting-question-slice-b-0019`
- status: `self-tested; independent audit pending; production NO-GO`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Implemented

1. Added an immutable `active_slot_key` and a live-state partial unique index to
   the generic task owner. Cancelled and terminal generations release the slot;
   stale retries cannot displace a newer live generation.
2. Added a dedicated `meeting.question.v1` adapter with durable submit, exact
   capability recovery, lease/stage/checkpoint, publication, failure, retry,
   cancellation, authority-gated read, TTL purge and capability-scoped delete.
3. Added framework-neutral POST/GET/DELETE route semantics. Route binding ID is
   separate from meeting ID, idempotent POST reports the real current state,
   and public responses omit encrypted payload references.
4. Server authority binds device scope, data epoch, route binding, meeting,
   server transcript `remoteId`, payload reference, request digest, snapshot and
   policy. Local-only revisions remain opaque bindings.
5. Split mobile local transcript revision from server transcript `remoteId` in
   evidence and intent rows. Both enter request fingerprints and final commit
   checks. Legacy rows copy only the known local ID and fail closed when the
   server ID is absent.
6. Verified summary and question adapters can share the kernel database without
   cross-capability claim, recovery, read, purge or privacy deletion.

## Verification

```text
PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning \
  -m unittest discover -s tests -v
78/78 PASS

PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile \
  generation_task_kernel.py production_summary_adapter.py \
  question_task_adapter.py device_question_api.py \
  tests/test_generation_task_kernel.py \
  tests/test_production_summary_adapter.py \
  tests/test_question_task_adapter.py
PASS
```

Fresh kernel, summary adapter, question adapter and mobile-store databases each
reported `integrity_check=ok` and `foreign_key_check=[]`.

Concurrency coverage includes duplicate logical submit, 12-way generic active
slot contention, 10-way question generation contention and shared-kernel
capability isolation. Fault coverage includes lease expiry, late result after
cancel, stale server transcript authority, old-generation retry, process
reopen, SQLite FK corruption and legacy mobile rows without a server `remoteId`.

## Current hashes

```text
generation_task_kernel.py                 b3b597f7a4fd77fbf1d99cb0289d9c074a107fe4f72454b3fbf8c2727e4ad251
production_summary_adapter.py             e316bb10a66a838564dcf5140fdb1c298c3b2b4946f2a9a46ba2b49530663ac2
question_task_adapter.py                  d9f20788216892675ab52b472332cea0cd1c2555a0af2d55e99911ea8afbe670
device_question_api.py                    40fded415de77f6eda073df49fd07792b277e0cbc9db4fba6a0396257d45127f
tests/test_generation_task_kernel.py      e0c30073a4edf667b0e4e695b1bdc93f3f12fe47640143a47a50a88164f028eb
tests/test_production_summary_adapter.py  b2a468641b391fb9b054fbbbd7135c52a5b6cd5c8a7057e283c06da98830d4d0
tests/test_question_task_adapter.py       6b75d7c056128c48ee6a21c026dc55de897e6466444cf461e8bbec8b489800ff
README.md                                  de43ee0cc312e14f7afb4e2847ea4bae966a6cd5445b0f253f348b12e19c2619
```

## Limits

This candidate does not contain a real FastAPI route, production ORM migration,
reader invocation, encrypted payload implementation, Android repository or
network cancellation. It also deliberately fails closed on a database whose
optional Slice A migration manifest predates the new full-row task column;
production mapping must resolve that schema-upgrade sequence explicitly.
