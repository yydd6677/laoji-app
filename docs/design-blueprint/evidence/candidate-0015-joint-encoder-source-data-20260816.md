# 候选 0015：日程语义 producer 公共源监督资产

## 状态与边界

- status: `candidate data; mechanically validated; not LaoJi gold; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- candidate root: `$CANDIDATE_ROOT/schedule-joint-encoder-data-0001`
- source: AmazonScience/MASSIVE `zh-CN` calendar, CC BY 4.0
- production mutation: none

该候选把 MASSIVE 原始 `train/dev` 的 source intent 与 `annot_utt` span 可复现地投影为
operation/mention 预适配监督。它不把 crowd-localized assistant text 写成老记用户日志、语音
真值或人工 LaoJi oracle，也不包含 relation、纠正、跨轮、OOD 或提醒的充分真值。

## 已验证结果

- train 保留 1,651 行，其中 1,648 行可训练；3 条已知跨 split 语义骨架近重复保留为
  zero-weight review-only quarantine；
- dev 280 行；完整 source test 398 行没有输出到训练；
- 冻结 blind packet 150 行，仍等待两名独立中文母语人工标注和裁决；
- 恢复 3,000 个逐字 source spans，2,629 个保守映射到候选 head，371 个未映射 slot 原样保留；
- frozen 与 train/dev 的 source ID、原文和规范化原文重叠为 0；已知活动 semantic skeleton
  跨 split 组为 0；
- `audit-report.json` 为 `errors=[]`、`promotion_ready=false`；隔离测试 7/7 通过；skill validator
  对 train/dev 均为 0 hard error；SHA-256 清单通过。

关键资产哈希：

- train: `916d6bf4d232219b92d105785680c2829bb403e7146081ab10dfee344c3a2394`
- dev: `8ed1524132747eb01fcb5d6d6ac7a638b5091aab7780898eaeee70bf69b2ebca`
- frozen human packet: `db6bd1bd602a36469b8d6b4f476a7d438e0dcf3854eda71036724f486eca5bdf`

完整复现、许可、review flag 和 schema 见候选目录中的 `README.md`、`EVIDENCE.md`、
`manifest.json`、`split-lock.json` 与 `review/PROTOCOL.md`。

## 不能由此推出

- 不能报告 LaoJi operation/span/relation 质量；
- 不能用 source intent agreement 替代两人人工 frozen test；
- 不能证明 speaker-held-out 或 semantic-event-held-out，因为 MASSIVE 没有这些身份；
- 不能训练 correction/clarify/context_edit/reject/OOD/query target/delete target 的完整关系 owner；
- 不能授权 shadow、生产接入、旧 owner 删除或 APK 模型打包。

该资产只允许进入同 split 的隔离预适配。冻结 150 条不得用于训练、prompt、阈值/权重选择、
模型选择迭代或错误补丁。

