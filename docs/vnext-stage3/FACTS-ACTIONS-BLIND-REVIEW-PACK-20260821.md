# Stage 3 Facts/行动候选完整来源盲审包

状态：`isolated candidate automated replay passed; human review pending; Stage 3 not adopted`。

## 回放边界

- 候选 API：经本机 `28030` 连接服务器 loopback `127.0.0.1:18030`。
- 路径：Android 同构的完整 source stream、持久 Task/Attempt、Facts V3 artifact 和 binding purge。
- Provider：本地 `qwen3.5:9b`；运行 revision 由候选 capability 返回并在任务准入时冻结。
- 输入：当前 10 份完整 SRT，共含单章节和两章节长会议；字幕只是弱参考，不进入生产 prompt、规则
  或样本补丁。
- 生产 `18020/8030`、GPU1、PCB、Smart Meeting 和公网流量没有修改。

## 自动化结果

- 完整来源：`10/10` 成功。
- 输出：104 条事实、4 个行动候选、233 条显示引用。
- 引用逐字匹配：`100%`；10 个 binding 均 purge-confirmed。
- 单章节：p50 `14.923s`，p95 `41.791s`，最大 `42.835s`，低于 `20s/45s` 路径门。
- 两章节：p50 `64.101s`，p95 `65.063s`，最大 `65.170s`，低于完整证据路径 `90s` 门。
- 评估器私有路径、盲审字段、resume 血缘测试：`4/4`。
- 内容安全报告：`/dev/shm/facts-human-review-20260821-r1-report.json`，SHA-256
  `d39a2c1fa5eb4915dd4c500c99584b3b271dbed141b0bcd6022df62862ef4b5f`。

公开报告只保存样本名/哈希、来源指纹、章节/事实/关系/行动/引用计数、revision、耗时和清理状态，
不保存转写、概述、事实、行动、引用正文或凭据。

## 私有盲审包

- 路径：`/home/yydd/.cache/laoji-vnext/facts-human-review-20260821-r1.json`（Git 工作树外）。
- 权限：`0600`；大小约 1.68 MiB。
- 行数：10，随机会议顺序，不包含样本文件名、自动通过状态或期望输出。
- SHA-256：`25de522aa617b098aec338303fa0e3d05a195ebbf3276bd13cd426c821b223f2`。
- 每行包含完整按时间排序的来源上下文和 Facts V3 文档。
- 会议级待审：概述准确、重要遗漏、冲突保留、严重错误。
- 事实级待审：来源支持、实质准确、certainty 正确、重要性。
- 行动级待审：真实承诺、具体有用、负责人/期限依据、日程适配、重复项。
- 每个样本后同时原子写入公开哈希检查点和私有包；支持不中断已完成样本的 `--resume` 与
  只替换失败样本的 `--resume --retry-failed`。

## 未关闭项

自动 schema、引用和延迟通过不等于事实质量。当前盲审字段仍为空，所以事实支持率、完整会议重要遗漏、
行动候选真实性/适用性和严重错误率尚无独立人工结论；尤其 10 份会议只产生 4 个行动候选，既不能据此
证明召回充分，也不能据此证明应增加行动。Stage 3 的人工 `>=95%`、公开零旧链路周期和 capability
barrier 仍开放，不能采用 Facts V3、切生产或删除 Summary V2。
