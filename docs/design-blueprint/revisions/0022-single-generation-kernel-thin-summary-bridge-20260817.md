# Revision 0022: one generation kernel, thin summary bridge

- status: `candidate`; **not adopted**
- parent: `0021-meeting-question-summary-bridge-cutover-20260816`
- production/service/database/App/APK/device/GPU/model mutation: `none`

Revision 0021's bridge-and-drain cutover remains selected. The first adapter
implementation is rejected because it reproduced the kernel's task state machine.
The implementation boundary is now exact:

```text
GenerationTaskKernel
  owns submit/claim/attempt/lease/cancel/checkpoint/publish/fail/recover/TTL

SummaryBridge
  owns legacy read fallback/cutover marker/compat projection/privacy delete
```

The kernel receives a resolver that reads current meeting authority through the
same SQLite transaction. Test-only `fixture_policy_state` remains only the default
resolver for isolated kernel tests. No production adapter may mirror policy state.

The 24 bridge tests are retained as behavior contracts. Candidate 0048 currently
passes 55 strict tests after repairing seven fail-open paths and two migration/
trigger integrity gaps found by independent review, but it remains pending a
fresh independent adversarial audit.
Line-count reduction is not itself acceptance evidence, and a second
implementation of the state machine remains a blocking architecture defect.

`GO`: only after the fresh audit passes, enter isolated Slice B design. `NO-GO`:
production integration, real database cutover or API/App switch.
