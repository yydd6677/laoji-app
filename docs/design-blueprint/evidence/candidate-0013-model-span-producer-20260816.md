# 候选 0013：9B 模型语义 span producer 探针

## 状态与边界

- status: `observed; isolated public-corpus model probe; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- model: Ollama `qwen3.5:9b`, 9.7B, Q4_K_M
- prompt: zero-example general contract; no evaluation meeting or utterance content
- input: candidate 0011 blind queue, 30 rows, source intent balanced 10/10/10
- server mutation: none; temporary local SSH tunnel closed after the probe
- production API, queue, database, device and APK: unchanged

探针只要求 operation 和来源 quote，不生成规范日期、默认结束时间或可保存日程。
MASSIVE source intent 仅用于诊断，不是人工老记 oracle。

## 失败设计与纠正

第一轮遗漏生产 Provider 已使用的 `think=false`/`/no_think`，模型把 4,096 output
tokens 全部耗尽并以 `done_reason=length` 结束，正文不可用，wall time 48.3 秒。这是
调用合同错误，不是模型字段质量结论。

第二轮关闭思考后，模型能返回内容，但根节点是 array 而不是 object；3 条 debug 又
确认让模型直接计算中文 Unicode start/end 不可靠。例如原文“销售会议”的真实范围为
12–16，模型报告 6–10。继续通过 prompt 教模型“数下标”没有结构价值。

因此协议改为 `span-text-r2`：

- 模型只输出逐字 `quote` 和同一 quote 在原文中的 1-based `occurrence`；
- 本地代码按原文确定性解析 start/end；
- quote 不存在时删除该 span，不猜近义词；
- quote 只出现一次时，将错误 occurrence 确定性归一为 1 并记录 repair；
- quote 重复时不替模型猜第几个。

## r2 结果

30 条同批无思考生成：

| metric | observed |
| --- | ---: |
| output rows | 30/30 |
| source-intent agreement | 26/30 |
| exact quote unresolved | 1 |
| unique-occurrence deterministic repairs | 3 |
| cross-field overlap errors | 0 |
| prompt tokens | 1,161 |
| output tokens | 3,243 |
| wall time | 28.50 s |

唯一不可解析 quote 是模型输出“删除”，但原文没有这两个字；校验器没有改写成近义的
“取消/清除”。三个 occurrence 错误都发生在 quote 只出现一次的情况下，归一后没有
歧义。

四个 operation 分歧：

- source query -> model reject：“我下周会是什么样子”；
- source create -> model delete：“取消我的所有的会议和三月二日的事件……”；
- source create -> model query：“告诉我什么时候有活动”；
- source query -> model create：“提醒我李雷的婚礼”。

至少后三条的 source label 与中文表面语义明显可疑，不能用 `26/30` 直接惩罚或奖励
模型；它们应进入独立复标队列。这也再次证明 public source intent 不能直接晋升为
LaoJi 真值。

可复现资产：

- `/home/yydd/LaoJi-candidates/schedule-span-producer-0001/span_probe.py`
- `/home/yydd/LaoJi-candidates/schedule-span-producer-0001/span-probe-output-30-r2-20260816.json`
- `/home/yydd/LaoJi-candidates/schedule-span-producer-0001/span-probe-output-30-r2-revalidated-20260816.json`
- `/home/yydd/LaoJi-candidates/schedule-span-producer-0001/span-probe-report-30-r2-revalidated-20260816.json`

## 决策

1. quote + deterministic resolver 优于让生成模型输出字符下标，保留为 M1 的候选
   evidence transport。
2. 当前 9B 整批 30 条需 28.5 秒，且所有结果在批次末尾一起返回；它不适合作为每次
   高频创建的无条件首路径。该观测不是 p95，但已足够否决“先调用 9B 再显示草稿”。
3. 9B 可以继续作为复杂输入或 shadow producer 候选；在 frozen holdout 前不接保存。
4. 下一比较对象应是低延迟专用 intent/span encoder 或蒸馏模型，以及 9B complex-only
   route；不能退回“扩大 preflight 正则 + 9B fallback”并称为新架构。
5. server probe 后 `/api/ready`、LLM 和 worker 仍 ready，queue depth 0；临时本机端口
   转发已关闭。
