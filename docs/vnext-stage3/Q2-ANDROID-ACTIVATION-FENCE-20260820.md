# Stage 3 Android Q2 激活围栏与失败清理证据（隔离候选）

## 结论

`emulator-5562` 已完成“模型运行期间当前笔记发生变化”的真实竞态回放。服务端可以完成旧
Task，但手机不会把基于过期来源的回答激活到当前会议；失败后遗留的完整加密来源流也可以被
用户取消并立即清理。状态仍为 `isolated candidate evidence; not adopted`：question capability
barrier 没有激活，Q0 没有删除，生产 `18020/8030`、GPU1、PCB、Smart Meeting、真机和
公网流量均未修改。

## 激活围栏

Q2 回答写入 clauses/citations 前，在同一个手机 SQLite 事务中重新核对以下身份：

- 当前会议、snapshot 来源指纹和 active transcript revision；
- device epoch、operation capability/entity/input/state；
- binding ID、generation、revision、cancel revision 和 active 状态；
- 本次包含笔记时的当前 note revision、immutable revision ID 和 SHA-256；本次确实没有笔记
  时仍要求当前笔记为空。用户明确排除笔记时，后续笔记变化不影响该次回答。

任一条件变化都会在插入回答 clauses/citations 之前抛出 `Q2ActivationFenceError`，将本地
operation 收敛为 `failure/Q2_EVIDENCE_CHANGED`，UI 切换到新的问答记录；迟到的成功响应不会
形成半份答案，也不会混入当前 snapshot。

## 真实 Android 竞态结果

1. 使用长会议 `vNext 验收夹具·股权会议（SRT参考）` 的 1357 个稳定转写片段和当前笔记
   revision 3，提交问题“管理公司最后讨论到的股权比例是多少？”。
2. 本地 operation 进入 `running` 后，把当前笔记原子推进至 revision 4；隔离服务端仍正常完成
   旧 Task，证明测试确实命中了“远端成功、本地来源已变”的激活边界。
3. 手机最终 operation 精确为 `failure/Q2_EVIDENCE_CHANGED`；对应 turn 的
   `completed_at_ms` 保持空值，回答 clause 和 citation 均为 0。界面显示
   “会议内容已更新，已切换到新的问答记录。”，没有展示旧答案。
4. 测试后笔记恢复为原 revision 3 和原正文，本机数据库 `PRAGMA quick_check=ok`。

## 恢复窗口和来源清理

- 同一长来源任务曾在旧 120 秒手机恢复窗口结束后约 1 秒才由服务端成功收敛。候选将 durable
  Task 恢复等待提高为 180 秒，期间继续轮询同一 Task，不创建重复问答 operation。
- 一次真实 `Q2_GROUNDING_INVALID` 留下了 `active` Task 和状态为 `complete` 的来源流。
  原取消实现把所有 complete 流误判为不可取消，导致加密来源只能等待 TTL。
- 取消事务现先确认同一 owner Task 仍为 active 并原子取消，再释放 reservation、删除 manifest、
  bundle/checkpoint 和加密正文，最后把来源流记为 cancelled。若 Task 已为 success/failure 等终态，
  事务回滚并保留其来源，避免迟到取消误删终态证据。
- 隔离数据库真实遗留任务从 `active/Q2_GROUNDING_INVALID` 变为 `cancelled`，完整来源流变为
  `cancelled`；该流的 bundle group、manifest page 和 encrypted payload 计数均为 0。

## 聚焦验证

- `npx tsc --noEmit` 通过；Q2 Android 静态合同通过。
- source stream、generic Task 和 Q2 reader 聚焦回归共 54 项通过，其中新增了“complete +
  retryable failure 可清理”和“terminal Task 的 complete 来源不得误删”两个反向场景。
- 正式候选 APK 为 `1.1.27 (135)`，SHA-256
  `a6cdeb97b7ce7763f5ec434276c598e12f5d456dc1e218a2bd24b22a44abc6e8`；APK manifest
  `debuggable=false`，覆盖安装后 `run-as` 被系统拒绝，启动首帧正常且无启动崩溃。
- 诊断 SQLite 工具、临时开放权限和 ADB Keyboard 已移除/恢复；系统输入法为 Latin。

## 尚未满足的 Stage 3 退出门

- 本次只证明当前笔记变化；附件授权/版本变化、epoch/binding 变化和真正迟到 worker 的全部组合
  仍需系统化恢复矩阵。
- 更新样本的独立人工盲审尚未证明 Q2 回答与引用相关性达到 95%。
- Facts V3 人工事实支持率、行动候选质量、旧结果后台迁移、公开零 v1 流量周期和 capability
  barrier 尚未完成。
- Stage 2 纯 CPU ASR 首段和 RTF 性能门仍未通过，继续阻止全局候选采用。
