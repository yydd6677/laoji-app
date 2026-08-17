# 移动端投影候选独立审计 2026-08-16

## 证据边界

本报告只读取当前 LaoJi 工作树和候选 0002；没有构建、安装、启动真机、修改 Android/RN 源码或写入导航存储。源码工作树仍有大量用户既有 dirty changes，因此行号是观察锚点，不是发布包证明。

## 已确认的现状问题

### Minutes detail 仍有多个状态时钟

- `src/native/nativeMinutesSnapshots.ts:151-179, 758-832` 保留 `pageGenerations`，为 notes/transcript/summary/speakers/info 分别保存 generation；另有 detail `tabGeneration`。
- `modules/.../MinutesState.kt:545-618` 按每个 tab 的 generation 合并快照，但仍把 `processingStatusLabel` 和 page state 混合成一个全局状态。
- 同文件 `:560-579` 用 `contains("整理")`、`contains("总结")`、`contains("文字")`、`contains("转写")` 推断摘要/转写所属；`MinutesDetailSurface.kt:589-600` 再用同样的中文文案决定当前 tab 是否展示。

这不是单一 projection reducer：generation、tabGeneration、page phase、processing label 和多个 action label 仍有不同 owner。候选 0002 的纯 envelope 不能自动消除它们。

### Calendar Search 的 dismiss 事件没有回到 JS owner

- `src/screens/ScheduleScreen.android.tsx:218-245` 只订阅 `addNativeWindowOverlayActionListener`，没有订阅 overlay dismiss。
- `WindowOverlayController.kt:88-95` 在 host 未 resumed 时发送 `onDismiss(reason=host-not-resumed)`；`:185-197` Activity destroy 以 `notify=false` 清空 entries。

因此 native overlay 已消失而 JS `searchVisible` 仍为 true 的状态分叉是源码可推导缺口；是否在某个 Activity 生命周期上复现仍需运行验证，不能写成已真机复现。

### Shared bearer route 仍可进入普通导航持久化

- `src/services/navigationState.ts:11-31` 把 `SharedAction`、`SharedMeetingContent` 纳入 root route allowlist。
- `:311-324` 的 `sanitizeRoute` 接受 token；`:403-415` 的 `sanitizeNavigationState` 会把它加入 persisted state。
- `src/services/navigationStatePersistence.ts:80-106` 会把经 sanitize 的整棵导航状态写入普通 app storage。

候选 0002 的 `sanitizePersistedNavigationState` 尚未接入这些真实路径；因此“token 不落盘”当前只是候选合同，不是现状事实。

## 对候选 0002 的判断

候选纯 Node 合同 11/11 通过，能拒绝 stale data/entity/view/surface identity，能处理 host dismiss，也能过滤 bearer route。但它仍有四类风险：

1. `dataEpoch + entityRevision + viewEpoch + surfaceInstanceId` 仍是四个 identity 维度；若上游继续维护 per-tab generation，它只是新适配层。
2. 没有真实 RN/Android reducer 接入，不能证明快照、action、dismiss 的所有路径都使用同一 envelope。
3. 只做 stale 拒绝，不定义 source revision 变化后页面事实、用户编辑和处理状态如何重建。
4. 没有证明普通导航 writer 已经排除 shared token；候选测试与生产 serializer 不是同一函数。

状态：`candidate; not validated`。

## 更窄的目标合同：Detail Projection v2

为减少时钟数量，下一原型只保留：

```text
DetailProjection {
  entityId
  projectionRevision       // 一个会议详情全局单调版本
  payload                  // 所有 tab 的可重建切片
  sourceRevisionDigest     // 本地事实快照指纹
}

SurfaceHandle {
  entityId
  surfaceInstanceId        // 仅内存，不持久化
}
```

- 不再为 tab 维护 generation；tab 是同一 projection 的切片，异步加载结果必须先写本地 canonical store，再由一个 reducer 产生新 `projectionRevision`。
- JS/native action、dismiss 和 mutation ack 携带 `entityId + projectionRevision + surfaceInstanceId + actionId`；旧 revision 或旧 surface 直接丢弃。
- `dataEpoch` 进入本地 canonical store 的 entity key/数据库 scope，不再成为每个 UI envelope 的独立时钟。
- 业务状态使用 typed enum/operation ID，不从中文展示文案推断；状态文案只是 projection 的一个字段。
- Overlay reducer 处理 `requested/presented/dismissed`，dismiss 必须带 intent/action ID；host 生命周期造成的 dismiss 不能只停留在 native。
- Navigation serializer 在写入前明确拒绝 shared bearer route；分享 token 只保留在一次性内存 intent 或独立短 TTL 安全存储，不能进入普通导航 snapshot。

这个合同比候选 0002 少一个 tab-generation 层，但仍需证明本地 canonical store 不会变成新的第二真相源。

## 下一隔离原型与门禁

建立纯 TypeScript/Node 原型 0005，输入使用当前 `NativeMinutesDetailSnapshot` 的脱敏 fixture，而不是改应用：

1. 同一 projection reducer 合并五个 tab 的乱序加载结果、summary/transcript 状态和 overlay dismiss；
2. 注入同 revision 乱序、旧 revision、旧 surface、Activity recreate、scope/epoch 切换；
3. 验证 token route 永远不进入 serializer 输出；
4. 验证用户编辑 overlay 在生成结果更新后仍可重建；
5. 统计旧候选的 identity/state 字段数量与 0005 的字段数量。

硬门槛：stale projection/action/dismiss 生效为 0；五个 tab 无独立 generation；同一输入重复 replay 字节一致；token 出现在普通持久化输出的次数为 0；文案替换不改变 reducer 结果。未达到前不改 RN/Android。

## 结论

当前 UI 架构存在真实源码层状态分叉，但没有真机复现证据。候选 0002 不应 adopted；应先验证 Detail Projection v2 的单 reducer 合同，再决定是否迁移一个页面。该路线不授权生产 UI 改动、导航清理或 token 数据迁移。
