# 老记目标架构候选：Local Memory + Verified Processing

状态：`candidate`，尚未 adopted。

## 设计意图

保留老记当前用户能力，但不保留当前规则、API、任务表、模型和页面状态实现。目标系统只围绕五个概念组织：本机记忆、不可变证据、持久任务图、可交换推理、带版本投影。

```text
Local Memory Core
  -> EvidenceBundle
  -> Durable Processing Graph
  -> Inference Gateway
  -> VerifiedResult
  -> Revisioned Local Projection
```

## 1. Local Memory Core

手机是日程、会议、录音、笔记、用户编辑、标签和删除状态的权威来源。核心写入以不可变事件或版本完成，页面只读取可重建投影。

最小身份：

```text
dataEpoch
entityId
entityRevision
eventId
createdAt
payloadHash
```

日程增删改查不依赖服务器确认。录音先成为本机 MediaAsset；远端服务不可用时，原始资产、笔记和已生成结果仍可读。

不再把 guest/account 当作主要数据模型。设备身份只用于授权远端任务和续跑，不改变本机数据所有权。

## 2. Evidence Bundle

所有生成或识别任务只接收不可变来源：

```text
EvidenceAsset {
  assetId
  revision
  kind
  sha256
  privacyScope
  sourceLocator
}

EvidenceBundle {
  bundleId
  assets[]
  contractRevision
  createdAt
}
```

`bundleId` 由排序后的 asset ID、revision、hash 和合同版本确定。标题、当前 active 状态和页面缓存不能充当证据身份。

整理、问答和行动候选只能引用 Bundle 中的来源。图、三元组、embedding、摘要片段和模型中间笔记只可参与路由，不能成为最终引用。

## 3. Durable Processing Graph

所有远端处理共享一个任务账本，不再为 summary、recording、speaker、sync 分别发明生命周期。

```text
queued -> admitted -> running -> verifying -> committed
                     |          |
                     +-> failed +-> failed
                     +-> cancelled
```

每个 capability 在启动时注册：

- 唯一 consumer；
- ProcessingGraph revision；
- 合法状态边；
- 资源需求；
- 输入/输出 schema；
- 取消、重试和恢复策略。

启动检查发现没有消费者的 durable operation 时失败关闭，不能留下永久待同步。非法状态跃迁在写入前失败，不能依赖 mirror/reconcile 修正。

## 4. Inference Gateway

业务代码不直接访问 Ollama、ASR 端口或云端模型。统一网关只负责：

- Provider 选择和显式版本；
- realtime / interactive / background 资源准入；
- 排队、取消、超时和故障隔离；
- structured output 和 telemetry；
- 相同任务身份的幂等复用。

Provider 是适配器，不拥有业务状态。当前 `8030`、`21434` 可以先作为 adapter；未来换成 vLLM、其他 ASR、本地小模型或云端 API 时，EvidenceBundle、任务身份和 VerifiedResult 不变。

网关不能演变成包含日程、会议和问答规则的巨型单体。

## 5. VerifiedResult

```text
VerifiedResult {
  taskId
  capability
  evidenceBundleId
  sourceRefs[{assetId, revision, sha256}]
  providerRevision
  contractRevision
  outputHash
  verificationRevision
  output
}
```

提交使用 compare-and-set：任务开始后的任何 source revision/hash 变化都会隔离整份结果。不能把旧整理绑定到新转写，也不能只删除坏引用后接受无依据正文。

用户编辑是独立覆盖层，重新生成不得覆盖它。

## 6. Revisioned Projection Envelope

React Native、原生 Android 和本地投影统一使用：

```text
ProjectionEnvelope {
  dataEpoch
  entityId
  entityRevision
  viewEpoch
  surfaceInstanceId
  projectionKind
  payload
}
```

native action、dismiss 和 mutation 回显相同信封。旧 entity revision、旧 view epoch 或旧 surface instance 的事件直接丢弃。展示文案不参与业务状态判断。

只持久化 tab、scroll、折叠等无敏感 view state；分享 token 和远端授权不进入普通导航持久化。

## 能力数据流

### 日程

```text
用户文本/语音 -> ScheduleDraft task -> Verified ScheduleDraft
              -> 用户确认 -> Local Memory event
```

解析永远无副作用。确定性时间/重复 validator 与语义模型可以替换组合，但只有用户确认或明确无歧义的本机合同才能写入日程。

### 实时与导入转写

```text
MediaAsset -> decode -> segment
                      -> ASR ---------+
                      -> speaker -----+-> reconcile -> TranscriptRevision
```

ASR 文字先可用，讲话人作为可撤销增强层；是否真正 GPU 并行由资源准入和回放数据决定，不由图形结构强制。

### 整理与行动候选

```text
EvidenceBundle -> fact generation -> deterministic verification
               -> MeetingFacts -> local template projection
```

模板不参与事实生成。行动候选与事实共享来源，不单独复制成第二份无血缘结果。

### 会议问答

```text
EvidenceBundle + question
  -> source retrieval
  -> answer generation
  -> claim/source verification
  -> cited answer or fail-closed
```

问答历史可作为会话意图，但不能成为事实来源。任何跨会议 source ref 在提交前失败。

## 候选公共接口

第一阶段只在隔离环境提供，不替换现有 API：

- `POST /api/device/v2/tasks`
- `GET /api/device/v2/tasks/{task_id}`
- `POST /api/device/v2/tasks/{task_id}/cancel`
- `GET /api/device/v2/capabilities`

POST 只接 capability、EvidenceBundle、contract revision、priority 和幂等键。模板、页面状态、模型端口和 provider 名称不属于业务请求。

## 迁移顺序

1. 用独立回放壳验证四类任务合同，不接生产。
2. 先迁移 v3 整理血缘：冻结 Bundle，CAS 提交，旧路径 shadow 对比。
3. 为 Minutes detail 与 Calendar Search 加 ProjectionEnvelope 候选，故障注入乱序/recreate。
4. 建立 capability registry，识别并关闭悬空 outbox；meeting root 作为第一适配器。
5. 将录音、转写和讲话人迁入 durable DAG；验证后才删除旧队列/mirror。
6. 日程解析以无副作用 ScheduleDraft 接入网关，再比较规则、模型和混合实现。
7. 所有能力稳定后，旧 API 只保留一个发布周期的投影适配，再登记 deprecated tombstone。

## 反证条件

出现任一项时必须重写本候选，而不是继续包装：

- 概念或状态数量高于现有实现；
- 为兼容而产生第二套任务真相源；
- 本机离线读取退化；
- 同一来源仍可产生多个不可解释的 active 结果；
- 推理网关开始拥有业务规则；
- 迁移必须依赖用户手动修复；
- 资源占用或延迟在同输入下没有可解释收益。

## 当前证据

- 合同原型：`$CANDIDATE_ROOT/cognitive-runtime-0001`，commit `92d27de`；
- 11 项标准库合同测试通过；
- 未运行真实模型、未接生产、未证明质量或性能收益；
- 源码级血缘、状态边、消费者注册和 projection ownership 缺口已由主代理独立复核。
