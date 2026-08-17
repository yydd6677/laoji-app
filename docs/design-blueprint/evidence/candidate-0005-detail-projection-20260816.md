# 候选 0005：Detail Projection v2 证据

## 身份与边界

- candidate repository: `/home/yydd/LaoJi-candidates/detail-projection-v2-0005`
- branch: `candidate/detail-projection-v2-0005`
- commit: `2a14696`
- runtime observed: Node standard library on Linux
- React Native/Android/production calls: none

## 合同

一个会议详情只有一个全局 `projectionRevision`；tab 是同一 payload 的切片，不保存 per-tab generation。异步 action 还必须匹配当前 `entityId + projectionRevision + surfaceInstanceId`，surface ID 只存在内存。用户编辑独立于生成快照，overlay dismiss 使用 intent ID，普通导航序列化过滤 shared bearer routes 和 token。

## 验证结果

命令：`node --test tests/*.test.mjs`，结果 `10/10` 通过。

覆盖：

- 新 revision 接受、旧 revision/同 revision 冲突拒绝；
- 用户编辑跨新快照保留，目标块消失时编辑进入可恢复 orphan 列表；
- 旧 projection、旧 surface 和重复 action 拒绝；同 action 在新 revision 可重新处理；
- legacy `generation/pageGenerations/tabGeneration` 字段在合同边界拒绝；
- host-not-resumed dismiss 只关闭匹配 overlay intent；
- shared route/token 永不进入普通导航 serializer；
- 展示文案变化不改变状态 owner；
- 同一快照/action replay 产生字节一致 view。

## 未验证边界

- 没有挂载实际 RN/Android reducer；现有 `MinutesState.kt`、`ScheduleScreen.android.tsx` 和导航 serializer 尚未改变；
- 没有 Activity recreate、真实 native dismiss、AsyncStorage 迁移或真机测试；
- 没有证明 token 的 pending notification 临时存储已经安全隔离；
- 没有证明一个 projection reducer 能覆盖所有现有页面/路由能力。

结论：候选 0005 仅证明更窄的 projection 合同，仍为 `candidate`，不得标记 `validated`/`adopted`，不得直接迁移生产页面。
