# Stage 3 Facts V3 Android 原子激活证据（隔离候选）

## 结论

Facts V3 的手机持久化已从“先写事实、再写整理版本、最后补关联”的三个事务，收敛为同一个
`saveSummaryVersion` 事务内写入不可变事实文档、整理版本、章节、引用、行动候选和 current pointer。
正常生成与后台升级共用这条原子提交路径。状态仍为
`isolated candidate evidence; not adopted`：本次没有激活 capability barrier，没有修改生产
`18020/8030`、GPU1、PCB、Smart Meeting、真机或公网流量。

## 已闭合的失败窗口

- 事务提交前核对 active transcript revision 和当前 manual-note revision；任一来源变化时，只保存为
  非当前候选或直接按输入变化收敛，不替换上一份可用整理结果。
- 页面在远端生成完成后、进入本机事务前，再核对当前会议/scope、转写、标题、日期、笔记、模板、
  carry-forward 和附件授权，完整输入指纹变化时丢弃 pending Task，并给出中文可重试结果。
- `summary_fact_documents.summary_version_id` 与不可变 document identity 在同一事务写入；重放只允许
  完全相同的正文、coverage、来源指纹、模型和 prompt revision，禁止把一个事实文档重新挂到另一版本。
- 后台旧结果升级不再用强制版本选择覆盖用户当前版本。若来源在生成期间变化，当前旧结果继续可读，
  upgrade task 不增加失败次数、清除旧 remote task ID，并在下次空闲时用新来源创建新 generation。
- 正常页面和后台升级均删除了活动路径上的 `saveMeetingFactsResultV3` +
  `linkMeetingFactsToSummaryVersion` 分段写入；旧函数仅保留为兼容 reader/Stage 5 删除对象。

## 真实 Android 纵向回放

1. 在专用 `emulator-5562` 上使用长会议
   `vNext 验收夹具·股权会议（SRT参考）`（1,357 个稳定转写片段）生成 Facts V3。
2. 页面状态单调经历“正在准备整理”与“正在整理会议记录”，约 40–50 秒后得到可读的概述和主要议题；
   生成期间上一层页面未崩溃、未出现半份事实文档。
3. 在同一事实结果上把模板从“通用”切到“项目同步”，立即出现“进展”投影；再切到“访谈”，立即
   出现“主题”投影。两个切换窗口内候选 API 日志均未新增请求，证明模板选择没有重新调用模型。
4. 强制停止并重新启动 App 后，当前模板仍为“访谈”，概述与主题继续可读；启动审计为
   `meeting_summary_v3_restore={status:facts_ready}`，无启动崩溃。启动时旧 device-v1 token 的一次 401
   随 device-v2 challenge/token 刷新自动恢复，随后 capability 请求为 200，不构成持久鉴权失败。

## 构建与聚焦验证

- 正式候选 APK：`1.1.27 (135)`，SHA-256
  `5de1646c4cc98291f35f7966e58b37bde078d5ed9653fa40575137d10a0471f8`；manifest
  `debuggable=false`，仅覆盖安装到 `emulator-5562`。
- TypeScript、Stage 3 source-stream 静态合同和 Q2 Android 静态合同通过。
- Facts V3、chapter merge、source stream、Task lifecycle、summary worker 和 Q2 reader 聚焦回归
  `118 passed`。
- 静态合同额外禁止正常页面和后台升级重新引入分段 Facts V3 写入，并要求 transcript + note 双来源
  激活围栏、原子 fact/version link 及后台输入变化 fresh-task 恢复。

## 尚未满足的 Stage 3 退出门

- 仍需对转写、笔记、附件授权和版本变化做完整的进程中断/竞态矩阵；本次真实 Android 回放没有逐一
  制造所有竞态组合。
- 更新会议样本的独立人工盲审尚未证明事实支持率、行动候选质量及 Q2 回答/引用相关性均达到 95%。
- 旧结果后台迁移尚未完成全量恢复验证，公开零 v1 流量周期与 capability barrier 尚未满足。
- Stage 2 纯 CPU ASR 的首段和 RTF 性能门仍未通过，因此全局候选仍不能采用。
