# 候选 0002 投影合同证据

- candidate repo: `/home/yydd/LaoJi-candidates/revisioned-projection-0002`
- branch: `candidate/revisioned-projection-0002`
- commit: `922e990`
- runtime: Node standard library
- app/native integration: none

通过 11 项合同测试：

- identity 完全相同的 projection 才能更新 payload；
- stale data epoch、entity、entity revision、view epoch 和 surface instance 均被拒绝；
- native `host-not-resumed` dismiss 可把 JS requested 状态关闭；
- 旧 surface 的 dismiss 不能关闭当前 overlay；
- data epoch 切换会关闭旧 overlay；
- SharedAction/SharedMeetingContent bearer route 不进入持久化状态；
- view state key 按 data epoch 隔离。

该证据只证明纯合同状态机行为。它不证明 React Native、Android Activity recreate、真实 native overlay 或 AsyncStorage 迁移已完成，因此候选仍为 `candidate`。
