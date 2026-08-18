# Revision 0020：会议问答 task kernel 进入隔离实现

- revision: `0020-meeting-question-task-kernel-implementation-gate-20260816`
- status: `candidate`; **not adopted**
- parent: `0019-meeting-qa-contract-seam-and-eval-bundle-reset-20260816`
- production/service/database/App/APK/device/GPU/model mutation: `none`

## 本轮停止串行等待

0019 将 Q2-E2 与 Q2-C 正确拆开，但执行仍花了过多时间在 gold/retrieval 门上。当前进一步
锁定：retrieval truth 继续阻止真实 reader 评分，却不再阻止 deterministic task ownership
开发。用户要求尽快收敛，本修订不再比较第四种 durable runtime 或第三张专用问答表。

## 已锁定开发方案

首选 [research 0024](../research/0024-meeting-question-durable-attempt-kernel-comparison-20260816.md)
的 Q2-C2：先把 `summary_tasks_v2` 的真实 WAL/lease/recovery 能力迁移为 generic
`GenerationTask + GenerationAttempt`，再注册会议问答。不能把问答直接塞进原表，也不新增
一套重复的 `question_attempts` claim/retry owner。

设备问答顺序所有权固定为：

```text
mobile durable intent
-> server durable task/attempt
-> exact snapshot/policy/cancel publication CAS
-> mobile validates and atomically commits existing final turn/citations
```

服务端结果只是可过期 delivery artifact；最终用户问答历史仍只有手机现有 turn/citation
owner。账号服务端 turn 是发布周期兼容投影，不扩张为设备 owner。

## 可执行证据

隔离 `meeting-question-task-kernel-0018` 已通过 `21/21` 严格自测、py_compile、SQLite
integrity 和 foreign-key check。覆盖 duplicate submit、priority、lease expiry、旧 worker
late result、cancel fence、policy change/revoke、binding 伪造、typed citation、同 ordinal
冲突、local intent 重启和原子 final turn。

详见 [candidate 0047](../evidence/candidate-0047-meeting-question-task-kernel-selftest-20260816.md)。

结论为：

- `GO`：按固定 adapter map 进入隔离、production-shaped 实现；
- `NO-GO`：真实数据库迁移、生产服务、设备/API 切换或 adopted；
- 不再用 Q2-E2 阻塞 Slice A；
- 独立审计在真实接入前仍必须完成，但不再要求在写 adapter 前完成。

## retrieval truth 的独立状态

四场 54 个 sufficient set 已完成首轮语义检查，其中三个会议由独立代理检查，一个会议由
root 检查。当前汇总为 `42 ACCEPT / 11 REVISE / 1 REJECT`；这不是 reader 通过率。

缺口包括不充分 OR set、缺先行词、非最小 all-of、过宽 quote，以及 `NAT-015` 原问题把
楼梯/台阶语境写成活动区。任何 gold/quote 修改都必须重新生成 digest 并由另一审阅者复核。
因此 retrieval readiness 仍为 pending，`promotion_eligible=false` 不变。

这条修订路线继续并行，但不会推翻已经锁定的 task kernel。

## 下一步，不再重新规划

1. 按 `$CANDIDATE_ROOT/meeting-question-task-kernel-0018/ADAPTER_MAP.md` 实现
   Slice A：generic server owner + legacy summary migration fixture；
2. 对 Slice A 做一次独立代码审计，只有阻塞级缺陷允许修一轮；
3. 再实现 durable question API 和 mobile migration 0040；
4. Q2-E2 并行修 evidence contract，完成前不跑真实 reader；
5. production、GPU、私人会议、真机和公网继续冻结。

本修订没有用户可见收益，但已经把 Q2-C 从反复审阅推进为有固定文件映射、状态机、删除集
和可执行故障合同的实现候选。
