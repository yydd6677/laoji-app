# Candidate 0007: summary-v3 lineage atomic commit

## Evidence boundary

- candidate path: `$CANDIDATE_ROOT/summary-v3-lineage-0007`
- source: isolated standard-library SQLite prototype
- production code, server process, database, device, model and APK: untouched
- runtime: local Python 3.13.5 (Python 3.12 and Windows not yet run)

## Result

Command:

```text
python3 -m unittest discover -s tests -v
```

Result: `7/7 passed`.

Covered contracts:

- one existing `summary_tasks_v2` owner and no `operations` table;
- artifact, current identity and task success in one transaction;
- injected failure after artifact insertion rolls back all visible writes;
- transcript revision mismatch performs zero writes;
- expired lease cannot publish a late result;
- immutable same-identity replay does not create a second artifact;
- restart/reopen preserves exactly one active artifact and the task pointer.

## Limitations

The prototype does not include the production SQLAlchemy connection, encrypted
payload table, real transcript writer, worker heartbeat, cancellation marker,
old v2 adapter, or model/provider calls. It therefore demonstrates a contract,
not a production fix. The next gate is an isolated copy of the actual server
schema and worker call graph, followed by Python 3.12 and Windows runs.

The prototype keeps an explicit `summary_v3_current` table to make pointer
atomicity observable. The research note currently prefers an `active` flag on
the single artifact table to spend fewer persistent concepts. That schema
choice is intentionally unresolved; passing this prototype does not authorize
the extra pointer table in production.

The local server source files pass `python3 -m py_compile`. The existing
`tests/test_summary_v3.py` suite could not be collected in the workspace
environment because `pydantic_settings` is not installed; no dependency was
installed and this is recorded as an environment gap, not a test pass.

The fresh call-graph audit agent separately reports `53` v3/task/version/
transcript tests passing in a temporary SQLite setup using the service virtual
environment. That report was not reproduced by this shell and does not include
the missing 404-identity, cross-transaction crash, or duplicate-start gates;
it remains agent evidence rather than a production acceptance result.

The isolated candidate also includes `audit_source_gaps.py`, which currently
reports the four known source-level gaps. It is deliberately non-gating today;
the adoption gate requires the same scan to report zero findings after the
identity-CAS and atomic-commit changes are implemented.
