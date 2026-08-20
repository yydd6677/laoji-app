# Stage 4 自然日程盲审与质量证据包（2026-08-20）

状态：`tooling complete; human evidence pending; candidate-only`。

## 本轮关闭的问题

旧 `verify_stage4_exit_preflight.py` 直接相信 evidence JSON 中的
`independent_human_adjudication=true` 和三个手填指标。它可以用于早期预检，但不能证明这些数字来自
两名独立评审、冲突裁决或同一份冻结预测，因此存在把声明误当证据的风险。

新增 `tools/vnext/schedule_holdout_evidence.py`，把质量证据固定为以下顺序：

```text
不可变来源清单
  -> 人工 A 盲审 ┐
  -> 人工 B 盲审 ┴-> 揭盲与逐行裁决 -> 冻结 gold -> 运行候选 parser -> 计算并封存报告
```

- 两名评审必须使用不同的匿名 ID，声明是中文母语人工、独立完成且未看 parser 输出；
- 两份盲审必须在揭盲时间之前完成；有分歧的行必须使用 `adjudicated` 和非空原因码；
- 规范日期、时间、标题、地点、重复和提醒都必须回指原句的精确字符区间；
- 预测必须在裁决完成后生成，且必须与来源文本哈希、holdout ID 和 producer revision 一致；
- 字段完全正确率、日期/时间/操作关键字段召回率和错误保存数均由工具计算，不能手填；
- 来源、两份盲审、裁决、预测和开发集清单全部进入 SHA-256 血缘，最终报告自身也有规范 JSON 哈希；
- 开发集文本、说话人组和 semantic-event 组任一重叠，均使报告不能晋级；
- 输出报告不含原句，日志也只输出数量、路径、布尔状态和指标。

`verify_stage4_exit_preflight.py` 现在新增 `schedule_quality_lineage` 门，并只从验证后的
`schedule-human-holdout-v1` 报告读取指标。原先只包含布尔值和手填分数的 envelope 会 fail closed。

## 来源边界

`natural-schedule-utterances` 的语料边界在工具中被落实为机器可检查的规则：

- `first_party_opt_in`：必须逐行有 consent reference、匿名 speaker group 和 semantic-event group；
  在与开发集零重叠且至少 30 行通过双人裁决后，才具备质量门资格；
- `public_localized`：可以生成同样的盲审包并做诊断，但即使两名人工完成，也保持
  `source_promotion_eligible=false`；
- `authored_diagnostic`：只能用于回归和边界检查，不能成为自然质量门。

软件无法仅凭文件内容验证现实中的人类身份，因此匿名 reviewer 声明仍需流程负责人核实；工具解决的是
标签来源、盲审顺序、逐行完整性、分歧裁决、预测隔离和指标计算的可追溯性，不虚构第二名人工。

## 使用方式

先准备本机 JSONL，每行保留原始用户表达、独立 `source_id`、带时区的 `reference_datetime`、
`timezone`、匿名 `speaker_group`、`semantic_event_group` 和用户授权引用。原文资产只能保存在本机受控目录，
不得提交到 Git 或写入服务日志。

```bash
python3 tools/vnext/schedule_holdout_evidence.py make-pack \
  --input /受控目录/first-party-schedule.jsonl \
  --output-dir /受控目录/stage4-holdout \
  --holdout-id laoji-stage4-field-holdout-v1 \
  --source-policy first_party_opt_in
```

分别交付 `review-a.json` 和 `review-b.json`，两人提交后再填写 `adjudication.json`。冻结 gold 后运行候选
Graph parser，生成不含原文的 predictions JSON，并准备实际训练/调试数据的哈希清单，然后计算报告：

```bash
python3 tools/vnext/schedule_holdout_evidence.py score \
  --manifest /受控目录/stage4-holdout/source-manifest.json \
  --review-a /受控目录/stage4-holdout/review-a.json \
  --review-b /受控目录/stage4-holdout/review-b.json \
  --adjudication /受控目录/stage4-holdout/adjudication.json \
  --predictions /受控目录/stage4-holdout/predictions.json \
  --development-manifest /受控目录/development-manifest.json \
  --output /受控目录/stage4-holdout/quality-report.json
```

本轮使用现有 MASSIVE 盲审队列实际生成 30 行诊断包，结果明确为
`source_policy=public_localized`、`promotion_eligible_source=false`。它验证工具能消费既有资产，但没有
产生人工 gold，也没有关闭 Stage 4。

## 自动验证

- 证据链和 Stage 4 预检聚焦测试：`9 passed`；
- 现有 30 行 public-localized 诊断包生成成功，未被误标为可晋级；
- 缺失 evidence 的 Stage 4 聚合预检继续返回 `passed=false`，并阻断
  `schedule_quality_lineage`、人工 holdout 和三个质量指标门。

## 剩余外部证据

仍需要收集至少 30 条明确授权、与开发数据隔离的第一方自然输入，并由两名真实中文母语评审独立标注和
完成分歧裁决。该工作不能由 parser、LLM、已有规则输出或同一个代理自审代替。因此 Stage 4 的质量门、
capability barrier、旧 parser 停写和 Stage 5 删除门继续关闭。
