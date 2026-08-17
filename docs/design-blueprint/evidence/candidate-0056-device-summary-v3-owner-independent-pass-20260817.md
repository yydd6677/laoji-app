# Candidate 0056: device summary-v3 owner independent pass

- status: `independently audited PASS; isolated only; not adopted`
- candidate: `/home/yydd/LaoJi-candidates/device-summary-v3-owner-0024`
- blueprint parent: revision 0028
- production/service/database/App/APK/device/GPU/model mutation: `none`

## What this candidate proves

The fixed capability `meeting.summary.device-v3` has one bounded SQLite owner:

```text
authenticated domain values
  -> authority + source-envelope v2 + encrypted payload + task transaction
  -> exact attempt claim + payload decrypt + transcript reload transaction
  -> provider boundary outside SQLite
  -> artifact/current + attempt/task success + payload delete transaction
```

The task result stores only the immutable artifact ID and digest. A changed
transcript creates a new source identity while the previous verified artifact
remains readable. Meeting and epoch deletion remove this capability's task,
attempts, payload, artifact and current pointer without crossing domains.

The owner deliberately does not accept client-observed transcript revision or
transport idempotency fields. Those remain request guards for a future
authenticated API adapter; server transcript authority is derived inside the
owner transaction.

## Independent adversarial audit

The first independent audit added 17 black-box tests without editing the
implementation. It covered:

- process reopen after lease expiry and fencing of the old worker;
- concurrent duplicate submit converging to one task and one ciphertext;
- faults at payload insert/load/delete, task insert/success, artifact insert,
  current insert and current replacement;
- meeting delete, epoch delete/closing, revocation and late workers;
- cross-device, cross-epoch and cross-meeting reads;
- byte-stable, read-only replay of an already successful historical artifact.

All publication fault points rolled back artifact/current, task/attempt state
and payload deletion together. Removing the injected failure allowed the same
valid claim to complete once.

## Bounded repair and re-audit

A root-only damaged-database probe then found that an attempt orphaned while
foreign-key enforcement was disabled could survive explicit privacy deletion
while the report stated `attempts=0`. The same explicit methods also accepted a
wrong caller domain as a silent no-op. The single authorized repair:

- validates the meeting/epoch caller domain before mutation;
- rejects an unattributable orphan attempt instead of deleting it globally or
  reporting a false successful cleanup;
- preserves idempotent cleanup when the meeting or epoch owner row is already
  absent but exact same-domain residue remains;
- removes the misleading owner-level client revision/idempotency parameters.

The independent repair audit first found that scanning global orphan state
before domain validation disclosed a database-integrity condition to a wrong
domain. Validation was reordered before the orphan scan. Six final independent
probes then passed: wrong-domain non-disclosure, orphan fail-closed rollback,
missing-meeting cleanup, missing-epoch cleanup, exact isolated deletion and the
owner signature boundary.

## Verification

All commands used `python3`, `PYTHONDONTWRITEBYTECODE=1` and the candidate tests
used `-W error::ResourceWarning`.

- complete candidate: `103/103 PASS`;
- first independent adversarial suite: `17/17 PASS`;
- independent repair suite: `6/6 PASS`;
- current payload store: `18/18 PASS`;
- current composition and v1 compatibility: `11/11 PASS`;
- current authority resolver: `23/23 PASS`;
- summary facade: `13/13 PASS`;
- question kernel, production summary adapter and question adapter:
  `47/47`, `31/31`, `15/15 PASS`;
- `py_compile`: PASS.

Before the final deletion-method repair, the same schema was installed and the
owner submit/claim/publish path was exercised only on a SQLite backup-API copy
of the running database: 74 meetings, 2,844 transcript rows and 67 legacy
`summary_tasks_v2` rows; integrity and foreign-key checks passed and legacy row
counts/digests did not change. The repair changed no schema. Remote and local
temporary copies were deleted; production was never opened for mutation.

## Frozen hashes

```text
device_summary_v3_owner.py                  99f04fef7e5944b608f9003d4da0b0d4b2a27426436664dfda6b55af080195e6
generation_task_transactions.py             9366b2edba61b41dc0c5270a3e36cdbd8a56168d942b3e932898b4134a778f8c
generation_authority_resolver.py            935634efd3635d79d7db8e19d289344166e18227d213838e96aea86049844c43
generation_payload_store.py                 2cbdb74da77ab17eb8b5138531102e7511a1db946210d15e74b75a5ebd0074d0
generation_task_kernel.py                   3f9835abdd786c9d61ec85c450a3fc277b7497d5ea4059baa7ca435c9a4ae121
summary_payload_composition.py              202c221baf0db13f0b0519eb952f1e90d051643cf60062fa9038d90db577fb14
tests/test_device_summary_v3_owner.py        2deee6d4ba0b17c53361e1f43499620a8f2e026a5468d825c0ce9e6cd4ed8d41
tests/test_device_summary_v3_adversarial.py  2a53a301f9c281217303a3835c54623caad77b332ae1614bc2e8fd85eca9a230
tests/test_device_summary_v3_repair_reaudit.py 9b19934796ea484d1c177daff8a5dbc6969df120899d3f4b4d78d0e79146c4d4
README.md                                    ab48087e431edea6a13ef08e1f0658b8f711471a6d1b92636c046da0733e993b
```

## Remaining boundary

This PASS validates one isolated owner contract, not production adoption. It
does not validate FastAPI/ORM wiring, a real provider call, facts-v3 quality,
Android state recovery, migration or user-visible behavior. Generic
`IntegrityError` classification can still hide a lower-level database cause,
but rollback remains atomic; this low-risk diagnostic item does not justify
another infrastructure repair round.

Revision 0028's bounded infrastructure budget is exhausted. The next blueprint
work returns to meeting-question latency and semantic citation quality.

