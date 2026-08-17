# Candidate evidence 0057: meeting-QA retrieval-contract repair checkpoint

## Status

- candidate: `/home/yydd/LaoJi-candidates/meeting-qa-natural-holdout-0014`
- status: `root repaired; mechanically validated; independent semantic re-audit pending`
- production/service/database/App/APK/device/GPU/model/private meeting mutation: `none`

## Recovered review result

The complete historical review was recovered from the original root and child
rollouts. Its denominator is 54 sufficient-evidence sets over 50 supported
claims, not 44 gold cases and not a reader pass rate.

- `L_R003S01C02`: 10 accept / 4 revise / 1 reject;
- `M_R003S01C01`: 10 accept / 2 revise;
- `S_R003S01C01`: 14 accept / 4 revise;
- `L_R004S01C01`: 8 accept / 1 revise;
- total: `42 ACCEPT / 11 REVISE / 1 REJECT`.

The rejected set was `NAT-001.C1.S1`: its quote says `外省停车` while the
claim covers all `外来车辆`. A later automated reduction file marked it valid;
that result is superseded because it did not preserve the scope distinction.

## Bounded repairs

- removed the rejected `NAT-001` alternative and the unsupported temporal word
  `先`;
- narrowed quotes for `NAT-005`, `NAT-008`, `NAT-022` and `NAT-030`;
- removed the over-strong `只提出` wording in `NAT-009` while retaining exact
  complete-meeting scope;
- added the missing `年龄太小` antecedent to `NAT-013.C2`;
- changed `NAT-015` from an unsupported activity-area question to a stair
  question and bound stair context plus the carpet-protection statement;
- removed redundant sufficient-set members from `NAT-023`, `NAT-028` and
  `NAT-034`.

The generated contract now contains 50 claims and 53 sufficient sets. One
illegitimate OR branch was removed; no difficult case was deleted.

## Mechanical results

- gold schema/domain validation: 44/44 accepted cases;
- evidence schema/domain validation: 50 claims, 53 sets, 7 complete-meeting
  claims, 3 claims with alternatives;
- unit tests: `13/13 PASS`;
- Python compile: pass.

These results prove reproducibility and mechanical binding only. They do not
prove that every repaired set is semantically sufficient and minimal.

Current hashes:

- corpus: `585c742177ce31ed8d6cd8d558c8dc37bcbe6994672e0c2503437e091a95c218`;
- gold: `a53fb6e2be65fc9381bd7d6554f1c73d3392487bac7e84ea309c2eb7ec3c9d85`;
- evidence requirements: `fd4fde953e778dfda7f185cfb6126535e4c2dc590cf310178624e18593e95db1`;
- gold author: `e30dfed3f42d0b7804126c37325164ba1a36156133779a6fdf1df26b06e35455`;
- evidence author: `6ab28bfb3c0dfec52a01b53bc6cd4d33a0e95837036b6ac2517c9afc296f84dd`.

`author_status=draft`, `independent_review_status=pending` and
`promotion_eligible=false` remain unchanged. A bounded Claude Opus 5/max,
non-fast re-audit invocation exited before returning a review and is not
counted as evidence. No reader or quality score is authorized yet.

## Live source cross-check

Read-only SSH on 2026-08-17 found the deployed question module unchanged from
the 2026-08-16 live audit: 5,826 lines and SHA-256
`e156702b3f380b8c568c35b7a265f50dc05f4294da7da85f72d8cd390d1c9fcb`.
No file or service was modified. This corrects the stale assumption that the
5,803-line local synchronized copy is the deployed file.

