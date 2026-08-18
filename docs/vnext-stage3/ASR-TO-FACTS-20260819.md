# ASR 到 Facts V3 端到端回放（2026-08-19）

状态：`isolated candidate evidence; not production`。

## 发现与修复

使用无字幕完整视频 `39799065_da2-1-16.mp4` 首次串联回放时，ASR 合同全部通过，但 Facts V3
模型输出在 4096 token 预算内截断；一次允许的结构修复也未闭合，任务以
`SUMMARY_V3_FORMAT_INVALID` 失败。该失败是真实长内容生成缺口，不是测试工具错误。

修复：

- `services/laoji-api/app/prompts/meeting_facts_v3_system.txt` 增加固定输出预算约束：默认最多
  12 facts、6 actions、16 relations，引用优先选择不超过 160 个中文字符的最短连续原文。
- `services/laoji-api/app/schemas/meeting_facts_v3.py` 将 prompt revision 从 `facts-v3-r5` 提升为
  `facts-v3-r6`，避免旧任务与新提示词混淆。
- 没有提高 `max_tokens`、增加第二个生成 owner 或把失败结果降级为部分总结。

## 复验结果

报告：`asr-to-facts-v3-39799065-r6-20260819.json`。

- ASR：26 个 14 秒分片、360,107 ms、26 个文字段，严格 v2 合同通过。
- Facts evidence：26/26 段纳入，source coverage `1.0`，estimated input `3121` tokens，未触发
  embedding 选段或静默截断。
- Facts 生成：一次模型调用，约 `10.216s`；2 条事实、1 条行动候选，结果通过确定性校验。
- ASR→Facts 总墙钟约 `110.674s`，其中 ASR 约 `100.121s`。
- 转写正文和生成正文只在进程内存中存在；报告只写入媒体哈希、计数、覆盖率、revision 和耗时。

## 未关闭

- 本次只覆盖一份 6 分钟视频；更长会议、证据超预算并触发 embedding 的完整链路仍需回放。
- 尚无人工事实支持率、行动有效性、引用相关性和 Android 页面/恢复验收。
- Stage 3 capability barrier、Stage 2 设备门和 Stage 5 删除审计仍关闭。

