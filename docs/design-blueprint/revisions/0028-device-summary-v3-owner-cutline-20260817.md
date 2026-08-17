# Revision 0028: device summary-v3 owner cutline

- status: `current blueprint; isolated implementation authorized; not adopted`
- parent: `0027-authority-ledger-and-source-envelope-repair-20260817`
- production mutation: `none`

## Evidence change

The repaired authority, kernel and encrypted payload hashes independently pass
their bounded re-audit. A backup-API copy of the live SQLite database also
accepts the repaired transcript ledger without changing legacy summary rows.
This closes the dependency gate for one isolated integration candidate; it does
not authorize production wiring.

See [candidate 0055](../evidence/candidate-0055-authority-revocation-schema-repair-independent-pass-20260817.md).

## Exact implementation cutline

The next and last infrastructure candidate in this sequence is a single
`DeviceSummaryV3Owner` with fixed capability `meeting.summary.device-v3`:

```text
authenticated device summary-v3 request
  -> one SQLite transaction: authority + source envelope + payload + task
  -> one exact AttemptClaim and payload load
  -> provider outside SQLite
  -> one SQLite transaction: verify authority + artifact + task success + cleanup
```

It must not reuse `ProductionSummaryAdapter`, activate its global cutover or
move question tasks. Existing `summary_tasks_v2` continues to own period, final
and device-final work. Existing device-summary-v3 rows may drain under the old
worker; only the new isolated route writes the generic owner.

## Locked corrections to proposal 0005

- production schema creates task/attempt, encrypted payload, transcript ledger,
  immutable v3 artifact and current pointer only. It contains no
  `fixture_policy_state`, candidate migration table or global cutover table;
- payload and task are inserted in one transaction; claim and exact payload
  decryption occur in one transaction; provider execution never holds a SQLite
  lock;
- artifact insertion/current activation, task/attempt success and terminal
  payload deletion are one transaction. The task result stores only artifact ID
  and digest, never a second facts document;
- attachment `position_ms` is part of source-envelope schema v2 and its digest.
  It cannot be encoded into a source ID or silently discarded;
- an empty note normalizes to `None`; revision-only changes to no content do not
  create a new source identity;
- `force` on failed work retries the same immutable task. Queued, running and
  successful same-source requests reuse their task. Re-sampling an unchanged
  source requires a future explicit generation revision, not identity mutation;
- privacy deletion can target one meeting or one epoch and atomically deletes
  task, attempts, payload, artifact and current pointer without affecting other
  meetings in the same device scope;
- GET is a projection: verified generic artifact first, old v3 document second.
  It never dual-writes or invents history for an old row.

## Hard stop

This line gets one implementation candidate and at most one repair re-audit for
reproducible critical/high defects. It does not grow a DAG, event bus, generic
handler registry, source catalog or second retry state machine. After an
independent isolated PASS, or after the bounded repair budget is exhausted, the
portfolio returns to meeting-question speed and citation quality.

No production database, service, route, model, GPU, APK or device is changed by
this revision.
