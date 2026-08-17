# Research 0025: legacy summary binding and drain audit

- observed source: `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`
- production mutation: `none`
- conclusion: all-row lineage migration is not recoverable from current data

## Evidence

`summary_tasks_v2` stores task/scope/meeting/dedupe/request/status/lease/checkpoint/result
state. It does not store the task-time transcript snapshot, data epoch, policy revision,
policy digest or handler revision. Those values cannot be reconstructed by reading the
current meeting after the fact.

The four persistent task kinds have different recoverability:

| kind | exact historical source binding |
|---|---|
| `device-summary-v3` | normally recoverable only when its immutable v3 document exists, or while its exact encrypted source payload remains valid |
| `period` / `final` | input existed in a temporary encrypted payload and is deleted after terminal completion; most terminal rows cannot be rebound |
| `device-final` | worker reloads whichever transcript is current when it runs; no immutable task-time transcript revision was persisted |

No kind persisted a historical policy revision. `dedupe_key`, current meeting state and
current device epoch are not substitutes for a task-time binding.

## Rejected migration

Migrating every legacy row by assigning `legacy-epoch`, a constant policy revision or a
digest of current meeting content would manufacture provenance. It would make stale or
revoked results look current and contradict the publication CAS contract. The existing
fixture's fixed epoch and migration-time 24-hour result TTL are therefore not production
mappings.

## Selected cutover

Use a bridge-and-drain cutover:

1. initialize the generic task/attempt tables without changing the legacy table;
2. after the cutover barrier, every new persistent summary write goes only to the generic
   owner and includes an exact source/policy binding at submission time;
3. legacy queued/running work remains owned by the old worker until it reaches a terminal
   state; it is never claimed by the generic worker;
4. status reads route by task identity: generic first, then the read-only legacy reader;
5. privacy deletion is the only permitted legacy mutation during the bridge and removes
   matching rows from both stores in one database transaction;
6. an optional importer may copy a legacy row only when an explicit resolver proves every
   binding and retention field; one missing row rolls back that import batch;
7. after no legacy work is active, its result retention has elapsed, and one mobile release
   no longer references legacy task IDs, remove the fallback reader and then the table.

This keeps one execution owner per task. The bridge is a compatibility reader, not a
second writer and not a dual-write path.

## Required implementation gates

- the cutover barrier and store choice are durable, not process memory;
- a task ID cannot exist in both stores;
- generic submission fails closed without exact binding;
- legacy running work cannot be reclaimed by the generic worker;
- deletion and epoch revocation fence late publication in both stores;
- task status, result TTL, checkpoint, scope and meeting identity retain their public
  compatibility shape;
- migration/import preflight and writes use the same SQLite transaction;
- `integrity_check=ok` and an empty `foreign_key_check` are required before recording any
  optional import manifest.

