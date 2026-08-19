# Q2 引用归一化修复

状态：`candidate evidence; Stage 3 exit still blocked`。

## 触发问题

在更新后的 27 题弱参考字幕回放中，`un-countries`、`energy-ui-plan` 和
`partial-owner-phone` 失败。三项均返回 `Q2_GROUNDING_INVALID`，根因不是跨会议
来源，而是本地 Qwen 在 UTF-8 字节坐标和“部分已知、部分未提及”回答上的输出不稳定：

- 单个分句的坐标可以是一个合法但不完整的 UTF-8 前缀，后续正确引用因此被拿去和
  前缀比较；
- 对“联系电话未提及”这类没有正向来源片段的分句，模型可能附带无关引用。

## 候选修复

`services/laoji-api/app/services/vnext_question_reader.py` 现在先检查所有回答分句
是否连续覆盖完整答案且落在 UTF-8 边界。坐标不完整时，引用相关性使用完整的模型答案，
而引用范围仍由服务端根据逐字来源重建，不信任模型坐标。

对于明确表达“未提及/未说明/无法确认”的分句，若同一回答已有至少一个通过校验的
正向来源，只丢弃该分句的无关引用并折叠为服务端拥有的单一回答范围；没有任何有效
来源时仍 fail-closed。这样不会把无关引用展示给用户，也不会把缺少正向证据的回答
静默变成有依据事实。

新增两个回归用例覆盖上述边界。

## 证据

- `test_vnext_question_reader.py`: `18 passed`。
- 3 个原失败题定向复跑：`3/3`。
- 更新样本完整 Q2 复跑：`27/27`，一次 reader 调用/题，冲突题仍在 provider 前
  确定性返回 `cannot_confirm`。
- 报告：
  - `q2-holdout-20260819-rerun.json`（修复前，保留失败证据）
  - `q2-holdout-20260819-rerun-fixed-full.json`（修复后）

字幕仍只是弱参考评测输入；本报告不构成完整转写真值、人工引用相关性或 Android
运行时验收，也没有改变稳定版和生产 capability。
