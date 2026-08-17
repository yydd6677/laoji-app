# 日程 intent/span encoder 路线比较 0009

## 状态与问题

- status: `research comparison; prototype direction selected; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- goal: 用一次低延迟语义前向同时替换 create/query/delete 正则 preflight 与标题/日期/
  recurrence 的重复扫描，再由一个确定性 executor 执行时间语义。

Candidate 0013 已证明现有 9B 能提出有用 quote spans，但 28.5 秒/30 条整批完成不适合
高频首结果；candidate 0014 又否决了“直接换 raw 0.6B 就会又快又准”的假设。因此需
比较专用 encoder，而不是继续在正则和通用生成模型之间来回切换。

## 外部路线核对

### GLiNER2

[GLiNER2 官方仓库](https://github.com/fastino-ai/GLiNER2)描述一个约 205M 参数、
CPU-first、单次前向支持实体抽取、文本分类和结构化抽取的 encoder，Apache 2.0；任务
形态非常接近老记需要的 intent + span。

但 [官方 `gliner2-multi-v1` 模型卡](https://huggingface.co/fastino/gliner2-multi-v1)
只列 `en/fr/es/de/it/pt` 六种语言，没有中文。它的 backbone 是
`microsoft/mdeberta-v3-base`，不等于现有 checkpoint 已具备中文日程能力。因此：

- 不下载并用英文 demo 外推中文质量；
- 不采用 unmodified checkpoint；
- 只保留“联合分类 + span encoder + CPU inference”的架构参考。

### INT multilingual SLU

[ACL 2025 INT 论文](https://aclanthology.org/2025.findings-acl.783/)直接研究 multilingual
intent detection 与 slot filling，并把 slot filling 改写成 span prediction；论文在
MASSIVE/MASSIVE-UG 上报告优于其 baselines。这个方向比 BIO 后处理更贴近 v2 exact
span 合同。

当前没有找到可直接审计、部署和许可闭合的作者代码/权重，因此 INT 只提供训练结构
依据，不是可立即安装的依赖。

### Qwen3-0.6B

[Qwen3 官方模型卡](https://huggingface.co/Qwen/Qwen3-0.6B)说明 0.6B、32K context、
100+ languages，并支持关闭 thinking；[Qwen3 官方仓库](https://github.com/QwenLM/Qwen3)
声明 open-weight models 为 Apache 2.0。它具备中文生成基础，但 candidate 0014 的同输入
探针只有 6/29 source-intent agreement，raw checkpoint 被否决。参数量和许可证不能代替
任务适配。

### ONNX 部署边界

[ONNX Runtime Execution Providers](https://onnxruntime.ai/docs/execution-providers/)
覆盖 CPU、CUDA、DirectML、NNAPI、XNNPACK 等后端；
[Optimum ONNX token classification](https://huggingface.co/docs/optimum-onnx/en/onnxruntime/package_reference/modeling)
支持 BERT/DeBERTa/DistilBERT/XLM-R 等 token-classification 导出。它为 Linux、Windows、
Android 共用同一模型合同提供现实路径，但不保证任一具体模型的速度或算子兼容。

## 路线对比

| route | 中文现成度 | 首路径潜力 | 资源 | 当前处分 |
| --- | --- | --- | --- | --- |
| 当前 regex + 9B fallback | 已运行但 owner 分裂 | quick 快、复杂慢 | 9B 常驻 | C0 回滚基线 |
| 9B quote span | public probe 26/30 | 不适合无条件首路径 | 已常驻 9B | complex-only/shadow |
| raw Qwen3-0.6B | public probe 6/29 | 质量不合格 | 0.5 GiB disk/1.4 GiB VRAM | rejected |
| GLiNER2 multi-v1 | 官方未列中文 | 理论上 CPU 单次前向 | 约 0.3B encoder | unmodified rejected |
| INT reimplementation | 论文覆盖 MASSIVE | 需要训练与工程化 | encoder 级 | research only |
| LaoJi joint encoder | 尚未训练 | 目标为一次 intent+span 前向 | 可量化 ONNX | isolated next candidate |

## 选中的隔离候选

建立一个 LaoJi-specific joint encoder，而不是包装现有正则：

1. 一个共享 encoder；sentence head 输出 operation，span head 输出
   `title/date/time/location/recurrence/reminder/control` 的 start/end 与 role。
2. 模型只输出 source span 和置信度，不输出 canonical date、默认结束时间或保存状态。
3. 一个纯 executor 读取 span + reference/timezone，完成 date/time/recurrence 计算；title
   span 永不进入时间执行，correction old 永不覆盖 final。
4. 训练先用 MASSIVE train/dev 的 source intent/slots 做 domain pre-adaptation，但保留
   source license，并把 translation/localization 方法作为 sample weight；不得把 source
   labels 当最终 LaoJi oracle。
5. `annotation-queue-blind-150` 和后续人工冻结 test 永不进入训练；correction、clarify、
   reject、context_edit 需要另外收集/标注，不能由笛卡尔模板补齐。
6. 9B quote producer可以生成 review candidate 或 teacher signal，但只能标
   `weak_model_label`，不能直接进入 gold。
7. 导出量化 ONNX，先在 Linux/Windows CPU 验证，再评估 Android NNAPI/XNNPACK；失败
   时保留服务端 encoder，不因“可移动”目标牺牲首结果。

## 概念与资源预算

候选只允许新增：一个 joint encoder artifact、一个 tokenizer revision、一个
span-to-slot executor。它必须删除或旁路：

- client/server create-query-delete 最终正则 owner；
- normalizer 对 full raw text 的 date/recurrence 二次扫描；
- title 长度/词面启发式 winner；
- 模型输出后再由另一组规则重新决定 intent。

若 encoder 只是给当前规则“多一个建议”，候选自动否决。

## 隔离门

- 独立复标 test 先冻结；source-intent agreement 不能代替 gold accuracy。
- operation macro-F1、span exact/partial F1、clarification recall、silent-create count 分开。
- 六个当前真实 hard cases 必须由 disjoint spans 解决，不得加入样本词补丁。
- warm server CPU p95 目标 <100 ms；cold <500 ms；Android 目标另测，不由 server 推断。
- 量化前后 intent/span 指标分别比较；模型包、RSS、CPU、GPU 和电量均记录。
- 只有能删除至少一个旧 owner 且 end-to-end 首结果更快，才进入 shadow API。

## 决策

下一隔离原型改为 joint intent/span encoder + deterministic executor。GLiNER2 只借鉴
架构，raw 0.6B 被拒绝，9B 保留 complex-only。该决定不授权训练生产模型、下载服务器
依赖、修改 API 或改变当前解析链路。
