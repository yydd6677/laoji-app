# Candidate 0047：会议问答 durable task kernel 首个可实施候选

## 边界

- candidate: `/home/yydd/LaoJi-candidates/meeting-question-task-kernel-0018`
- status: `self-tested; GO for isolated adapter implementation; NO-GO for production`
- production/service/database/App/APK/device/GPU/model mutation: `none`
- model/private meeting/network call: `none`
- source contract: [research 0024](../research/0024-meeting-question-durable-attempt-kernel-comparison-20260816.md)

## 实现结果

候选已建立两个明确 owner：

```text
server GenerationTask + append-only GenerationAttempt
mobile durable request intent -> existing final turn/citation owner
```

服务端候选包含：

- SQLite/WAL logical task、不可变 attempt history、priority claim；
- logical request 去重和同 thread/ordinal generation conflict key；
- lease generation、heartbeat、过期重试、旧 lease result fence；
- queued/running cancel revision 与迟到结果 fence；
- snapshot/policy/epoch authority、撤权、成功后再次取结果时的 policy check；
- task/snapshot/policy output binding、protocol/citation/policy 分离结果；
- result TTL 和不复制 legacy request body 的显式绑定迁移 fixture。

移动端候选包含：

- 网络前持久 request intent；
- 一个 thread/ordinal 只能有一个 active intent；
- 本地 authoritative evidence state，不接受 UI/网络自报 current revision；
- typed source identity，不能用同 source ID 冒充另一来源类型；
- final turn/citation 原子插入并删除 intent；
- 进程重开恢复、重复提交幂等、取消和 stale result 拒绝。

## 验证

严格运行：

```text
python3 -W error::ResourceWarning -m unittest discover -s tests -v
```

结果：`21/21 PASS`，无 ResourceWarning。并行 duplicate submit 为 8 threads/1 task。

另执行：

```text
python3 -m py_compile generation_task_kernel.py tests/test_generation_task_kernel.py
PRAGMA integrity_check
PRAGMA foreign_key_check
```

结果分别为：compile PASS、`ok`、`[]`。

当前 artifact hashes：

- `generation_task_kernel.py`: `daf86919746ff7f0f40ba17bbfce66becdec9606bdce8715dfbde131834746f1`
- `tests/test_generation_task_kernel.py`: `b2f9e836ead72625b4db0a551a24eca6ca785caea9fc1eb7590eb0f33da9789e`
- `README.md`: `973b0ef5651d7d797de276fd02caa8d53400aa9c13aac236177bd1ef8a6aa4cf`
- `ADAPTER_MAP.md`: `b09f8c4b46865aeeb6601295dc4d7e50ecc7c716336777b9a0639d580d194af7`

上述 hash 已在 21-test 版本上重新计算，并与本节严格命令的当前输入一致。后续任何文件
变化都必须先重跑严格测试，再更新 hash；本节不授权把候选接入生产。

## 独立审计状态

一次 `gpt-5.6-sol/ultra`、非 fast 的独立对抗审计因 stream disconnect 终止，没有返回任何
技术结论。该尝试不能计为通过，也不是候选缺陷证据。

为了避免评估门继续阻塞实际学习，本候选现在允许按
`ADAPTER_MAP.md` 进入隔离、production-shaped adapter 实现；但真实数据库迁移、运行服务、
设备/API 切换和 production adoption 继续被独立审计门阻止。

## 已知非能力

- 当前同步 `requests`/Ollama transport 不能证明立即停止 GPU 计算；cancel 只承诺不发布；
- fake policy table 不是生产 authority；真实 adapter 必须在同一 DB transaction 查询 meeting、
  epoch、transcript、summary 和 note；
- legacy migration fixture 不是当前数据库的完整 migration；
- Python 3.13/Linux 自测不等于 Windows/Python 3.12 通过；
- 本候选不改善 Q0 reader 质量或延迟。

## 实施决定

采用 [adapter map](/home/yydd/LaoJi-candidates/meeting-question-task-kernel-0018/ADAPTER_MAP.md)
的顺序：

1. Slice A 只让 summary 使用 generic owner；
2. summary recovery 闭合后才注册 durable question task；
3. mobile migration 只加 intent，不复制 answer owner；
4. 一个候选发布周期后才删除同步 route 和 summary 专用 owner。

该顺序已足够进入隔离开发，不再回到“独立问答表还是通用 kernel”的方案比较。
