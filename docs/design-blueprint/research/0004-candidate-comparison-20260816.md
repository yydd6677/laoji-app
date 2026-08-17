# 候选 0003/0004/0005 独立比较与下一轮门禁

## 当前证据

| 候选 | commit | 测试 | 已证明 | 不能宣称 |
|---|---|---:|---|---|
| 0003 Artifact Flow | `3f6a633` | Python 15/15 | 不可变 Artifact、水位替换、来源 CAS、编辑 overlay、重启/跨连接取消合同 | durable worker、真实 Provider、模型质量、Windows/Android |
| 0004 task owner bridge | `8faa61c` | Python 9/9 | `summary_tasks_v2` 单 owner + Artifact 事务、lease/recovery、提交回滚、来源失效 | 真实服务器 schema/worker、加密载荷、partial flow、旧内存 owner 可删除 |
| 0005 Detail Projection v2 | `2a14696` | Node 10/10 | 单详情 projection revision、surface/action/dismiss 身份、编辑保留、token route 过滤 | RN/Android 接入、Activity recreate、真实导航迁移 |

三者均为隔离原型。测试总数不是质量百分比，也没有一个候选进入 `validated` 或 `adopted`。

## 反向审查

### 不能直接合并三套抽象

如果把 0003 的 `operations`、0004 的 `summary_tasks_v2`、0005 的 projection reducer 全部并列接入，会得到至少两套 task owner、两套 source identity 和两套 projection identity；这违反蓝图的概念预算。0003 的 `operations` 表只能作为合同参考，不能进入生产。

### 0004 不是完整替代

0004 复刻了当前 task store 的核心字段，但没有实现服务器的 encrypted payload、checkpoint callback、retention、所有 stage 和 worker memory maps。它证明的是事务边界可行性，不是迁移脚本或兼容层。

### 0005 不是 UI 修复

0005 能拒绝 stale action/dismiss，但当前 Minutes 和 Calendar Search 仍运行旧 reducer；在真实页面接入前，不能报告用户可见问题已解决。尤其 token 过滤只存在候选 serializer，生产 `navigationState.ts` 仍接受 shared routes。

### 速度与质量尚无证据

0003 回放中的 220/900/1200ms 是合成事件时间；它们不代表 ASR、Qwen、网络或 Android 首屏延迟。当前服务器观测到 summary 约 20.7s、embedding 约 6.5s，但没有同输入候选对照。任何“更快/质量更高”结论都保持 `unverified`。

## 下一项推荐纵向切片：Summary Artifact Projection r1（已完成隔离版）

以下设计已由候选 0006 完成隔离回放；它不是生产接入，也没有通过真实代码门禁。

只做 `meeting.summary`，不先迁移全应用：

```text
现有 summary_tasks_v2 (唯一 claim/lease/retry owner)
  -> source snapshot + one transactional artifact result
  -> 本地 Detail Projection reducer
  -> 兼容旧 summary/mirror 只读投影
```

约束：

1. 不创建 `operations`、第二 task table 或第二 retry/cancel owner；
2. 复用现有 task request/source fingerprint/encrypted payload；新结果表只保存 artifact identity、source refs、output hash 和 projection pointer；
3. commit 事务同时检查 task lease、完整 source snapshot 和 active transcript revision，再写 artifact/result pointer；
4. 先输出一个 final facts artifact，证明血缘与回滚；partial/stable 增量要等 summary worker 能实际产出水位后再启用，不能用 fake replay 冒充；
5. RN/native 只在隔离 fixture 接入 0005 reducer；生产页面仍由旧状态 owner 驱动；
6. 旧 v2 summary 只读可用，候选结果不得覆盖 active production document。

## 硬门禁

- 同一生产 task owner 的 claim/retry/cancel 状态只有 `summary_tasks_v2` 一份；
- 100 次故障窗口（claim 前后、provider 返回后、commit 前后、ack 丢失、来源修订、进程重启）无重复 active result、无旧 source active commit、无永久 running；
- artifact 与 task success 必须同事务提交；rollback 后两者都不存在/可重试；
- 现有 encrypted payload TTL、日志脱敏、retention 和旧客户端查询行为不退化；
- candidate reducer 的 stale projection/action/dismiss 生效为 0，生产代码调用图仍无第二投影 owner；
- 同一真实样本旧链路与候选在 p50/p95、引用完整性、人工事实支持率和 GPU/CPU 峰值上对照；不得用合成回放代替；
- Python 3.12 service runtime 与 Windows/Linux CI 均实际运行；
- 至少删除一组旧 worker 内存 dedupe/serialization owner，否则不采用。

## 决策

当前保留 0003–0006 为互补候选证据，不宣布任何一个 adopted。0006 已通过隔离版 100 轮回放；下一轮必须转为真实代码切片设计/审查，仍不得直接双写生产。若真实切片无法删除旧 owner 或故障门禁失败，回退为只维护蓝图，不继续叠加抽象。
