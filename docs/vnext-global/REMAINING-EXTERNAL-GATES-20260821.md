# vNext 剩余外部门（2026-08-21）

状态：`all currently autonomous implementation work reconciled; production adoption and independent human evidence pending`。

本文件不是缩小蓝图，也不把外部门视为可选项。它只区分“仓库/隔离候选还能自主实现”与“必须由真实
人员、公开运行周期或获准生产维护产生”的证据，防止继续重复已经关闭的恢复矩阵和性能回放。

## Stage 2

已闭合：上传/恢复、连续稳定文字、NO_SPEECH、CAM++ 异步 overlay、GPU0 媒体性能、speaker overlay
暖态性能、混合负载、资源、隐私和 8030-v2 可回滚部署包。

剩余：

1. 第一方音频的两名独立中文母语评审与裁决：至少 30 条 ASR、10 条已登记讲话人、10 条未知讲话人；
   关闭 CER 中位/p95、数字时间准确率、registered attribution F1 和 unknown forced-name rate 七项门；
2. 获准维护窗口内把已封存 handler 切到生产 8030，完成真实模型的 legacy/v1/v2/NO_SPEECH/batch
   复验，再让候选 API 去除 8031 代理引用；
3. 激活前完成一个公开旧 media submit 为零的完整发布周期，然后才可人工采用 capability。

## Stage 3

已闭合：source stream、Facts V3、两槽恢复、确定性模板、行动候选边界、Q2 reader/grounding、Android
来源变化/进程死亡/旧版升级恢复、延迟和引用逐字匹配。

现有私有盲审资产保持在 Git 外：

- `/home/yydd/.cache/laoji-vnext/facts-human-review-20260821-r1.json`
- `/home/yydd/.cache/laoji-vnext/q2-human-review-20260821-r2.json`

剩余：两名独立评审完成 Facts 支持与遗漏、行动真实性/适用性、Q2 正确性/完整性/引用相关性裁决并达到
`>=95%`；随后完成公开 Summary-v2/Q0 零旧调用周期，才可人工采用 capability。自动引用 `100%` 和
模型回放通过不能替代这些字段。

## Stage 4

已闭合：MentionGraph/Validator/Draft owner、复杂输入模型 producer、补充 revision、FTS5、标签 owner、
ProjectionEnvelope、Android stale-action/page-recreate 与 30 暖样本语音性能。

剩余：至少 30 条明确授权、与开发集隔离的第一方自然日程表达；两名独立中文母语评审和分歧裁决；
冻结 gold 后再运行候选 parser。只有字段完全正确率 `>=95%`、关键字段召回 `>=98%`、保存错误为零，
且一个公开旧 schedule submit 为零周期完成后，才能采用 capability。公开 MASSIVE、合成十万条和
现有 parser 输出均不能冒充第一方自然 holdout。

## Stage 5

Stage 5 不能通过增加审计次数提前开始。只有 Stage 2--4 对应 capability 已采用、公开零旧调用周期、
legacy 队列/租约/客户端引用/reader-removal marker 全部满足后，`safe_to_delete` 才可能变为 true。
随后才允许物理删除旧 upload、summary v2、Q0、重复 parser、mirror、account/sync 和旧运行资产，并
构建最终候选 APK。生产发布与公网切换仍需独立授权。

## 需要的外部决定或输入

- 明确授权一次 8030 短维护窗口；窗口内需保证没有实时会议/导入正在使用 ASR；
- 指定两名彼此独立的中文母语评审者，或明确接受先由用户本人作为评审 A、另找评审 B；
- 为 Stage 4 提供/授权至少 30 条真实自然日程表达及 consent reference；
- 人工质量通过后，授权候选 capability 的受控采用和公开零旧调用观察周期。

在这些输入前，继续重跑同一模型、同一模拟器或自动自审只会制造更多候选证据，不会关闭蓝图要求的
外部门。
