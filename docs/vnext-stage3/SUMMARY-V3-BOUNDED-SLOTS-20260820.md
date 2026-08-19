# Stage 3 Facts V3 有界生成与真实回放证据

## 结论

Facts V3 的公开文档、来源引用、确定性验证和 Android 本地投影均未改变。模型内部响应由可变长
`facts/relations/action_candidates` 数组改为固定槽位 DTO，服务器再确定性展开为原有
`MeetingFactsModelResponseV3`。同一 1,357 段 Android 长会议候选任务从约 66--101 秒降到
`34.53s`，模型输出从顶满 `4,096` tokens 降到 `617` tokens，并以 `done_reason=stop` 完成。

状态仍是 `isolated candidate evidence; not adopted`。没有激活 capability barrier，没有修改生产
`18020/8030`、GPU1、PCB、Smart Meeting、真机或公网流量。

## 根因与边界

原 r9 长会输出为 16,266 bytes、4,096 tokens、`done_reason=length`。隐私安全形状遥测显示它没有
生成超长单字段或空白，而是输出了 69 组 `fact_id/source_id/content` 字段；模型忽略 JSON Schema
的 `maxItems=12`，在关系和行动之前耗尽输出。

最终 r14 的 provider-only DTO 采用：

- `facts` 仅允许 `f1..f12`，`relations` 仅允许 `r1..r16`，`actions` 仅允许 `a1..a6`；
- fact ID、action ID、来源类型、逐字引用和内容哈希由服务器恢复，不再让模型重复；
- action 正文直接使用其已验证 action fact；缺失 `fit` 只保守投影为 `medium`，提议/不确定状态为
  `low`，绝不默认 `high`；
- 本地 Ollama 在准备输出 `f13/r17/a7` 时停止。结构解析器只重建停止前已完整解码的槽位，不编辑
  字符串或不完整事实；首个必需事实不完整时仍使用唯一一次模型修复；
- 单个可选槽位若枚举或结构无效，只删除该槽位及其悬空关系/行动，不为一个局部字段重跑整场会议。

生产提示词 revision 为 `facts-v3-r14`，不含评测会议标题、人物、原文、行业词或 few-shot 示例。

## 被拒绝的方案

- 8 facts / 8 relations / 4 actions 的 r10 限额在既有 9 组 holdout 仅 `8/9`，已回退。
- 将输出上限增至 5,120 tokens 后仍 `done_reason=length`，长会约 `93.70s`，已回退。
- 只把事实数降到 9 仍 `done_reason=length`，长会约 `75.45s`，已回退。
- r13 把每个槽位编码为竖线分隔字符串，虽能阻止内层键重复，但 9 组 holdout 只有 `7/9`，
  `report/equity` 一次修复后仍格式失败；该传输格式未部署。

这些负向结果说明速度改动不能以放弃结构可靠性或事实覆盖为代价。

## Android 长会议纵向回放

专用 `emulator-5562` 使用 `vNext 验收夹具·股权会议（SRT参考）` 的 1,357 个稳定转写片段，经
隔离 API `18023` 和隔离 ASR `8031` 运行。r14 任务
`…e4e63b5c2cd25856952d951fed9166ef`：

- 创建 `22:20:37.099Z`，终止 `22:21:11.632Z`，总计约 `34.53s`；一个 attempt、success；
- 证据覆盖：121 个规范片段中选择 58 个，`7/7` 主题组，含 transcript 和 manual note，输入估算
  10,220 tokens；
- 模型：一次调用，`20.44s`；load/context `12.26s`，prompt 8,724 tokens / `1.66s`，生成
  617 tokens / `4.64s`，输出 2,364 bytes，`done_reason=stop`；
- 模型形状：12 个 fact slots、1 个 relation slot、1 个 action slot；确定性引用/字段验证后为 7 条
  facts、1 条 relation、0 个 action candidates，7 条事实均有一个可解析来源；
- Android 生成期间继续显示上一份整理，完成后恢复“重新整理”，页面无失败状态、无半份结果或崩溃。

最终事实数量和结构通过协议门，但内容支持率、遗漏率及“0 行动是否符合该会议”仍需独立人工盲审；
本证据不把结构成功当作质量通过。

## 跨主题结构回归

最终机器报告为 `facts-v3-r14-slots-final-20260820.json`。9 个不同主题真实字幕窗口均通过弱主题、
引用、重复行动和宏观目标门，且全部只调用模型一次：

- facts 数量：`10/6/12/5/12/12/5/8/12`；action 数量：仅 equity 为 1；
- 延迟 p50 `7.883s`，最大 `12.549s`；
- `9/9` 首轮结构成功只是小样本证据，不能单独证明总体首次 Schema 合法率已达到 98%。

## 回归、隐私与剩余门

- Facts V3、Q2、provider、任务 worker 和 readiness 聚焦回归共 `120 passed`；22 个共享 contract
  产物校验通过，静态隐私日志扫描 `privacy_log_findings=0`，Python compileall、`git diff --check`
  均通过。
- 形状遥测只保存数字计数、耗时、token 数和结束原因，不保留 prompt、正文、标题、人物、引用、
  文件名或坐标。
- 仍缺独立人工事实支持率/行动有效性/Q2 引用相关性 95% 门、长会延迟分布、完整恢复矩阵、旧结果
  全量迁移、capability barrier，以及 Stage 2 CPU ASR 性能门。
