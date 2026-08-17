# Candidate 0053: summary task and encrypted payload composition

- candidate: `/home/yydd/LaoJi-candidates/summary-payload-composition-0022`
- dependencies: candidates `0019`, `0020`, `0021`
- status: `10/10 self-tested; independent audit pending; not adopted`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## Implemented boundary

```text
scope + canonical sources
  -> stable encrypted payload commit
  -> request digest + immutable summary binding
  -> generic task submit
  -> exact AttemptClaim
  -> same-transaction task/attempt/lease/payload check
  -> plaintext only in worker memory
```

- Payload commits first. The only submit crash residue is encrypted and bounded
  by TTL; a runnable task can never be committed before its source payload.
- Exact and 12-way concurrent retries produce one payload row and one task row.
- A changed source under the same logical request is rejected before task drift.
- Worker load checks task, attempt, owner, lease generation, provider request,
  cancel revision, policy/snapshot binding and unexpired lease in the same
  transaction that verifies and decrypts the payload.
- Explicit scope privacy deletion injects payload cleanup into the adapter's task
  deletion transaction. Another scope remains untouched.
- Terminal cleanup removes only source ciphertext and retains the task result;
  missed cleanup falls back to TTL.

## Architecture decision

The lower-code alternative was "look up an existing task, then encrypt only when
missing." It retains a concurrent lookup/encrypt race and needs orphan
compensation. Stable scope-keyed identity removes the race. It does add HMAC key
rotation and equality-leakage considerations, which remain explicit costs.

The earlier goal of keeping the exact legacy worker signature was rejected by
evidence: task ID plus a process-wide owner cannot distinguish a late old attempt
from a current attempt. Production integration must carry the complete
`AttemptClaim`; an in-memory lookup that reconstructs a current claim is not an
acceptable compatibility mechanism.

## Verification

```text
python3 -W error::ResourceWarning -m unittest discover -s tests -v
Ran 10 tests: OK

python3 -m py_compile summary_payload_composition.py tests/*.py
PASS
```

## Remaining gates

- Independent adversarial audit of the latest dependency hashes and composition.
- Old payload migration/dual-read and one-owner retirement plan.
- Real worker call-surface change to retain `AttemptClaim`.
- Immediate fenced recovery for a dead local worker session.
- Real meeting/epoch/transcript/payload authority resolver on one connection.
- Real service import, startup, readiness, retention and fault-copy tests.

## Hashes

```text
summary_payload_composition.py             ad66c1bfec9ff69e5d03e5f02856b9434f56d0d58ff9af0ad97bf92990bd48ab
tests/test_summary_payload_composition.py  8e71b4a5644c31de40f453a737650a02dc23f04803dd67b446f351cbf183faff
README.md                                  5634aec6ee7ac77f3fa1ea15e299be7b932df8ee86e1a85bf60067d87ba306bb
```
