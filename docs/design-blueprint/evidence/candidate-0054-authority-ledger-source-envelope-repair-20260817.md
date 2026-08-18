# Candidate 0054: authority ledger/source envelope repair

- candidate: `$CANDIDATE_ROOT/generation-authority-resolver-0023`
- status: `superseded; these hashes were blocked and repaired in candidate 0055; not adopted`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Independent audit findings that caused the repair

The preceding candidate was not tested only with dictionaries. A kernel-shaped
probe passed a real `sqlite3.Row` and reproduced `AttributeError` from `row.get`.
With `PRAGMA foreign_keys=ON`, deleting a meeting containing transcript lines
also reproduced `FOREIGN KEY constraint failed`: the child-delete trigger tried
to insert/update a revision row while its parent was being cascaded away. A
third probe showed that payload scope metadata alone did not prove the encrypted
source contents belonged to the meeting snapshot.

## Repair evidence

The candidate now:

- converts the row at the resolver boundary and runs a real kernel
  `claim_next` test;
- assigns each revision ledger row a random 32-hex generation and includes it in
  `server-transcript-v2:<meeting>:<generation>:<revision>`; dropping and
  reinstalling the ledger therefore cannot make an old snapshot look current;
- suppresses revision-row recreation while a parent meeting cascade is in
  progress;
- requires metadata keys `task_kind`, `task_scope`, `transcript_revision_id` and
  `source_snapshot_digest`;
- decrypts active payloads and validates a fixed source envelope. The envelope
  binds `subject_id` and transcript revision, checks note/attachment IDs,
  revisions and SHA-256 values against their private bodies, and rejects
  transcript plaintext in the private-source area.
- validates handler revision, rejects a missing payload during submit, makes all
  current-empty transcripts equally unavailable, and retains failed-task input
  for the kernel's explicit retry operation.

## Verification command

```sh
cd $CANDIDATE_ROOT/generation-authority-resolver-0023
PYTHONPATH=$CANDIDATE_ROOT/meeting-question-slice-b-0019:$CANDIDATE_ROOT/generation-payload-store-0021:. \
PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning \
  -m unittest discover -s tests -v
```

Observed result: `Ran 21 tests ... OK`; the changed kernel ran `90/90`, payload
composition ran `11/11`, and `py_compile` also passed.

## Live mapping, read-only

The live `laoji-api` process was inspected without changing it. Its SQLite
database contains the real `meetings`, `transcript_lines`, device identity and
legacy `summary_tasks_v2` tables. It has no authority revision table or
transcript triggers. The production adapter still emits only a reduced binding,
so this candidate cannot be imported into it yet.

The active SQLite database was then copied through SQLite's backup API into an
auto-deleted local temporary file. On that copy, the exact revision and payload
schemas installed successfully over 74 meetings and 2,844 transcript rows.
`integrity_check`, `foreign_key_check`, trigger rollback, current-empty
transcript behavior and a synthetic meeting/line delete all passed. No meeting
ID or transcript content was printed, and both remote and local temporary backup
files were deleted automatically.

## Remaining gate

An independent re-audit must exercise the repaired hashes. After that, a new
isolated service candidate may construct the envelope in an authenticated
summary-v3 submit transaction and write the generic task owner. Legacy task
drain and the question route remain separate until their capability contracts
are mapped. No self-test result here is a production or user-quality claim.

## Hashes

```text
generation_authority_resolver.py  e01cfdf4220ad6fd4bc2a5ab6b6b82a04719473853be8749a566454e7dad1147
tests/test_generation_authority_resolver.py  aae10ec60b5e3266b04bb609f87f3b23e28489e9f26a294b0e91999971e0bebc
README.md  bf275fc07d16c6fdec80306db24f5581d83b4ad1aa28ad3648b7d8174502e86f
generation_task_kernel.py  6e48b99e1625517887e6fcbd878e2578215b334ed89322eb6b0e11aa55b7a65c
tests/test_generation_task_kernel.py  eb9b015faf10933d493649c34d0c95757e3429fc86cc1b8211f382d0bf51f27b
summary_payload_composition.py  eba5529e7c2d3dbb76c17391998b70e999733e2e2e3b41f5fe7a27cb5198704e
tests/test_summary_payload_composition.py  7a67352280488242a4386603e6f694b79baa392910ef0bc772a2777ee31fca4f
```
