# 候选 0002：带版本信封的 UI 投影协议

状态：`candidate`

## 触发原因

React Native、原生 Android、SQLite 和页面本地状态分别维护 generation、缓存和展示状态。Minutes detail 甚至通过 `processingStatusLabel` 是否包含“整理/总结/文字/转写”判断状态归属；这说明业务状态所有权已泄漏到文案。

## 目标合同

所有 JS 到 native 的业务快照使用统一信封：

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

native action、dismiss 和 mutation 必须回显同一信封。接收端只有在 data epoch、entity revision、view epoch 和 surface instance 都匹配时才应用事件；文案不能参与状态判断。

## 持久化边界

- 只持久化无敏感的 tab、scroll 和折叠位置；
- key 必须包含 data epoch 和 entity ID；删除实体或切换 epoch 时清理；
- SharedAction、SharedMeetingContent 和任何 bearer token 都是一次性导航意图，不进入 AsyncStorage；
- capability 缓存按 API origin、scope/data epoch 和 contract revision 隔离，兼容死路径优先删除而不是继续扩展。

## 第一原型

只在隔离候选中覆盖两个边界：

1. Minutes detail：用一个 entity projection revision 替代按 tab 手工拼 generation 和中文文案判断；
2. Calendar Search：把 requested/presented/dismissed 变成单一握手状态，JS 同时消费 action 和 dismiss。

故障注入：snapshot 乱序、Activity recreate、前后台切换、epoch 切换、会议删除和 native host 未 resumed。

候选门槛：stale snapshot/action 生效为 0，overlay intent/visible 最终一致，AsyncStorage 中 token 为 0，删除或换 epoch 后旧 view state 为 0。

## 当前原型

独立仓库 `$CANDIDATE_ROOT/revisioned-projection-0002` 已建立纯合同原型，commit `922e990`，11 项 Node 标准库测试通过。尚未接入 React Native 或 Android，因此不能升级为 `validated`。

## 明确不采用

- 继续给每个 tab 增加独立 generation；
- 通过中文文案识别业务阶段；
- 同时让 JS boolean 和 native 是否挂载作为两个真相源；
- 把分享 token 加密后继续长期持久化；它应根本不落盘。
