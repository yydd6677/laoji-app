# Candidate 0052: capability-aware encrypted generation payload store

- candidate: `$CANDIDATE_ROOT/generation-payload-store-0021`
- status: `18/18 self-tested; independent audit pending; not adopted`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Implemented boundary

- Canonical JSON is encrypted with AES-256-GCM and a random 96-bit nonce.
- A domain-separated HMAC over capability, scope, epoch, subject, logical
  request and content digest produces a stable opaque payload ID.
- AES-GCM AAD binds that identity plus request/content digests; a separate HMAC
  covers metadata and ciphertext digest without decrypting user text.
- All operations require the caller's active SQLite transaction and never
  commit, so future domain authority and payload authority can be checked on one
  connection.
- Exact retries reuse one ciphertext without extending TTL. Changed content or
  request digest under one logical request fails closed.
- Table and expiry-index definitions are checked exactly at initialization.
- Capability-limited scope deletion is transactional and can remove a corrupt
  row for explicit privacy cleanup without first trusting its metadata.
- Test connections explicitly close; the full suite passes with
  `ResourceWarning` promoted to an error.

## Verification

```text
python3 -W error::ResourceWarning -m unittest discover -s tests -v
Ran 18 tests: OK

python3 -m py_compile generation_payload_store.py tests/*.py
PASS
```

The suite covers concurrent stable save, scope/request/content drift, expiry and
rollback, ciphertext/nonce/metadata corruption, wrong key/version, plaintext
absence after WAL checkpoint, malformed schema/index, capability isolation and
explicit scope deletion.

## Not proved

- No old `summary_v3_source_payloads` row is migrated or dual-read.
- No production task, authority resolver, worker or terminal hook uses it.
- Key rotation still needs a multi-version reader and retirement policy.
- Database/WAL metadata is not encrypted; opaque scope and timing relationships
  remain visible.

## Hashes

```text
generation_payload_store.py               bc32e0fac8d8c9bfb4f960261aa9c7932f455d36da426c8796139b8c283d5934
tests/test_generation_payload_store.py    49edffd096a275d596f453ee46034ff792b6ad5d58ceef2f49fd8055f9c6ec92
README.md                                  e887954ae406a71d49757dc1e736d782976ba437e82d980bf6b6b940bf4ff429
```
