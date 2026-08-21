# vNext 剩余外部门（2026-08-21）

状态：`superseded by explicit product-owner waiver; Stage 5A completed; Stage 5B deletion and production release remain separate`。

> 2026-08-21 后续决定：产品所有者明确跳过下文列出的独立人工质量和正常使用/公开零旧调用周期。
> 这些门已在 `vnext-product-owner-risk-waiver-v1` 下记为 `waived`，没有改写为测量通过。Stage 5A 已按
> 单一 owner、无双写、无静默 fallback、legacy 冷回滚保留的合同完成。本文其余内容保留为被豁免风险
> 的历史说明，不再阻塞 Stage 5A；生产发布与 Stage 5B 物理删除仍需以后分别授权。

本文件不是缩小蓝图，也不把外部门视为可选项。它只区分“仓库/隔离候选还能自主实现”与“必须由真实
人员、公开运行周期或获准生产维护产生”的证据，防止继续重复已经关闭的恢复矩阵和性能回放。

## Stage 2

已闭合：上传/恢复、连续稳定文字、NO_SPEECH、CAM++ 异步 overlay、GPU0 媒体性能、speaker overlay
暖态性能、混合负载、资源、隐私，以及生产 8030-v2 可回滚部署、真实协议复验、候选直连和中断恢复。

剩余：

1. 第一方音频的两名独立中文母语评审与裁决：至少 30 条 ASR、10 条已登记讲话人、10 条未知讲话人；
   关闭 CER 中位/p95、数字时间准确率、registered attribution F1 和 unknown forced-name rate 七项门；
2. 激活前完成一个公开旧 media submit 为零的完整发布周期，然后才可人工采用 capability。

双盲/裁决/后置预测的模板和确定性评分器已经完成。现有会议视频已进入开发与诊断，不能再作为独立
质量 holdout；外部输入必须是新的、明确授权且未参与调试的第一方音频。

## Stage 3

已闭合：source stream、Facts V3、两槽恢复、确定性模板、行动候选边界、Q2 reader/grounding、Android
来源变化/进程死亡/旧版升级恢复、延迟和引用逐字匹配。

现有私有盲审资产保持在 Git 外：

- `/home/yydd/.cache/laoji-vnext/facts-human-review-20260821-r1.json`
- `/home/yydd/.cache/laoji-vnext/q2-human-review-20260821-r2.json`

两份文件现在只作为冻结来源包；原单 `reviewer` 结构不足以证明独立人工门。两评审、第三人裁决、哈希
绑定和确定性评分合同及 `0600` 私有模板已经补齐，见
`docs/vnext-stage3/HUMAN-QUALITY-EVIDENCE-CONTRACT-20260821.md`。

Stage 3 聚合退出预检现为 `27/39`；12 个机器阻断收敛为 Facts/行动人工质量、Q2 人工质量和公开
Summary V2/Q0 零旧提交周期三项外部门，见
`docs/vnext-stage3/STAGE3-EXIT-PREFLIGHT-20260821.md`。

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

- 指定两名彼此独立的中文母语评审者，或明确接受先由用户本人作为评审 A、另找评审 B；
- 为 Stage 4 提供/授权至少 30 条真实自然日程表达及 consent reference；
- 人工质量通过后，授权候选 capability 的受控采用和公开零旧调用观察周期。

在这些输入前，继续重跑同一模型、同一模拟器或自动自审只会制造更多候选证据，不会关闭蓝图要求的
外部门。
