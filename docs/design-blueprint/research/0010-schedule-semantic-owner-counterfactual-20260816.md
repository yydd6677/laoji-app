# 日程语义 owner 反事实研究 0010

## 状态与证据边界

- status: `independent research; candidate narrowed; not adopted`
- observed: `2026-08-16 Asia/Shanghai`
- production mutation: none
- source worktree: `$MOBILE_REPO`
- service source inspected read-only:
  `$SERVICE_REPO/backend`
- 本文不修改 `CURRENT.md`、revision、生产 parser、API、APK、数据库、服务或模型，也不授权
  训练、部署或下载服务器模型。
- candidate 0011--0014、MASSIVE 和论文指标只证明各自明确写出的实验边界，均不等于老记
  真实中文质量。

本文把 0009 选中的
`joint intent/span encoder -> deterministic executor` 当成待证伪假设，而不是既定答案。
比较对象至少包括：当前双端多 owner 链、朴素 joint encoder、带关系的 joint encoder、
端侧小型 seq2seq/structured decoder，以及纯服务端生成模型。

标记约定：

- **事实**：可由当前源码、既有隔离证据或第一方资料直接核对。
- **工程推断**：由事实推得的老记候选判断，尚未经过目标设备/冻结集验证。
- **未验证**：缺少老记真实输入、目标手机、训练产物或许可证闭环，禁止写成收益。

## 先给结论

1. **朴素的 flat joint intent/span encoder 不足以成为下一目标架构。** 它能表达一句话的
   operation 和独立 span，却不能天然表达 `旧值 -> 新值`、时段限定钟点、起止配对、
   补充回答针对哪个字段、查询/删除针对哪个现有事件，以及由多个不连续片段组成的标题。
   如果这些关系继续由 executor 扫描完整原文判断，executor 就会重新长成第三套 parser。
2. 值得隔离验证的候选应收紧为
   **`relational mention graph -> single deterministic executor`**：一个共享 encoder 同时产生
   operation、来源 mention、mention role 和少量白名单 relation；executor 只读取已验证的
   mention graph、reference/timezone 和显式 draft/event context，禁止再次扫描完整 raw text。
3. 端侧 structured decoder 是必要的反事实候选，不应先验否决。它比 flat heads 更容易表达
   关系和变长结构；但 autoregressive 延迟、内存、语义幻觉和 Android 运行时成本明显更高。
   grammar 只能保证结构，不保证所选 span、operation 或关系正确。
4. 纯服务端模型是最容易删除客户端规则的路线，但会把所有文本请求变成网络请求，扩大远端
   数据面并失去离线首结果。它适合作为 teacher、复杂输入 producer 和同输入上界，不适合在
   没有真实延迟/可用性证明时直接成为高频默认路径。
5. 当前最合理的研究顺序不是先训练一个模型，而是先冻结**关系化语义合同和人工真值**，再让
   relational encoder 与 grounded structured decoder 在完全相同的 train/dev/frozen test 上
   竞争。只有胜者能删除旧 owner、改善冻结集并在目标手机上更快，才允许提出 shadow API。

## 当前真实 owner 不是“两套规则”

### 客户端

**事实。** `src/services/api.ts:426-480` 的 `parseText()` / `clarifyText()` 把以下决定串在一起：

1. `parseLocalScheduleText()` 先解释标题、日期、钟点、时段、地点、重复和提醒；
2. `classifyScheduleParseRoute()` 决定 local/clarify/server/reject；
3. `classifyScheduleParseIntent()` 又单独生成发给服务端的 intent；
4. 普通远端结果再次进入 `normalizeScheduleParseResult()`；
5. model-only 结果走另一条 `normalizeModelOnlyParseResult()`；
6. clarification 把 `original + supplement` 重新交给普通 normalizer。

`src/services/localScheduleParser.ts` 当前共 1,653 行。行数不是复杂度分数，但以下最终判定确实
同时存在于该文件：

- `normalizeScheduleText()`：删除/改写口头填充、唤醒词和部分 ASR 表面形式；
- `parseAuthoritativeDate/Time()`、`parseRecurrenceRule()`、`extractTitleAndDescription()`；
- `parseLocalScheduleText()`；
- `normalizeScheduleParseResult()`；
- `classifyScheduleParseIntent()` 与 `classifyScheduleParseRoute()`。

**事实。** `normalizeScheduleParseResult()` 会根据完整原文重新推断 category、time period、
all-day 和日期信号；这不是纯 schema 校验。`normalizeModelOnlyParseResult()` 虽然更窄，仍会从
`raw_text` 再取 time period。

### 服务端

**事实。** `app/api/device_v1.py:624-687` 暴露 text/audio/clarify 三个入口。文本入口根据
`client_rule_status=unresolved && client_intent=create` 决定 `model_only`；服务端不是无条件
运行同一条路径。

**事实。** `app/services/schedule_parser_service.py` 当前共 4,598 行，并不全是文本 parser，
但最终语义至少由以下组件共同决定：

- `classify_schedule_intent()`；
- `_parse_schedule_text_quick()` 与 `_deterministic_complex_fallback()`；
- 9B/云端 Provider prompt、一次 repair retry 和 `_parse_llm_response()`；
- `_normalize_llm_result()` 对完整原文再次解析 title/date/time/recurrence/location/reminder；
- `apply_schedule_clarification()` 对回答和旧 `raw_text` 再做字段目标与时间推断。

**事实。** `_normalize_llm_result()` 不是 validator：它会用 quick parser 补 recurring anchor，
覆盖模型日期/钟点，默认一小时结束时间，并根据完整原文重新决定多个字段。

**工程推断。** 因此最终生产 owner 至少有六类，而不是简单的“手机规则 + 服务端规则”：

```text
mobile semantic parser
mobile route/intent classifier
mobile post-normalizer
server intent preflight + quick/fallback parser
server model producer + full-text post-normalizer
server clarification parser
```

新合同如果只是包住它们而不删除其中至少一组，只会成为第七个 owner。

## 对 flat joint encoder 的最强反对意见

### 1. span 不是关系

考虑下列结构，而不是记住这些具体句子：

```text
把原定 <旧时间> 的 <事项> 改到 <新时间>
<日期> <时段> <钟点> 到 <结束钟点> <事项>
不是 <旧日期>，最后定在 <新日期>
补充回答：下午
删除 <时间窗口> 里关于 <主题> 的那一条
```

operation head 和 `date/time/title/control` span head 可以找出片段，却不能说明：

- 哪个时间是 `correction_old`，哪个是 `correction_final`；
- `下午` 限定哪个裸钟点；
- 哪两个 mention 构成同一个 range；
- 补充回答修改旧草稿的哪个字段；
- delete/query mention 是检索过滤条件还是新建字段；
- 多个 title 片段应如何组合且不注入原文没有的词。

0009 已经提出 role，但还没有证明 role 足以替代 relation。若依靠完整原文正则完成配对，
只是把现有规则从 producer 搬到了 executor。

### 2. query/delete 不是只有 operation label

**事实。** candidate 0011 暴露了 query/delete 被误路由成 create 的风险；candidate 0012 能
把它们表示成不可保存 operation。

**工程推断。** 这只解决安全路由，不等于实现 operation。真正的 query/delete 还需要时间窗口、
主题、参与者、地点、重复条件、指代目标和多候选确认。若 M1 只输出 `intent=delete`，当前服务端
仍必须保留另一套 target parser，owner 并没有被删除。

### 3. confidence 不是可直接使用的安全阈值

专用 encoder 可输出低延迟置信度，但 raw softmax 不是校准概率。类别不平衡、MASSIVE 本地化
噪声、ASR 同音词、distribution shift 和量化都可能使高置信错误增加。

候选必须同时输出并校准：operation、mention、relation 和 out-of-domain score。路由阈值只能由
独立 dev 校准，并在 frozen test 上报告 silent-create、over-clarification 和 selective risk；
不能凭 `confidence > 0.7` 保存。

### 4. 当前训练证据远远不够

**事实。** MASSIVE calendar train/dev 可以做 domain pre-adaptation，但 test 150 尚未独立复标；
MASSIVE 是 CC BY 4.0 的 crowd-localized assistant 文本，不是老记用户日志或语音真值。

**事实。** candidate 0013 的 30 条 9B probe 说明 quote transport 可行，但只有 source-intent
agreement；candidate 0014 只否决 raw Qwen3-0.6B。两者都不是 joint encoder 的训练集或质量门。

**未验证。** correction、clarify、context edit、reject/OOD、ASR 扰动和 query/delete target
目前没有足以训练关系 head 的独立 LaoJi gold。先写模型再补这些标签，会让现有规则悄悄成为
伪标签和新模型的永久上限。

## 候选语义合同：Schedule Mention Graph v0

这是研究候选，不修改 `ScheduleSemanticDraft v2`。它用于验证 Draft 之前是否需要更强的来源层：

```json
{
  "schema_version": 0,
  "sources": [
    {"source_id": "turn-1", "text_hash": "...", "reference_datetime": "...", "timezone": "Asia/Shanghai"}
  ],
  "operation": {"kind": "create|query|delete|clarify|context_edit|reject", "score": 0.0},
  "mentions": [
    {
      "mention_id": "m1",
      "source_id": "turn-1",
      "field": "title|date|time|time_period|location|recurrence|reminder|control|target",
      "role": "value|range_start|range_end|correction_old|correction_final|intent_control|query_filter|operation_target",
      "start": 0,
      "end": 2,
      "text": "逐字原文",
      "score": 0.0
    }
  ],
  "relations": [
    {"kind": "qualifies|pairs_with|replaces|negates|targets|composes|refers_to", "from": "m1", "to": "m2", "score": 0.0}
  ],
  "ood_score": 0.0,
  "producer": {"family": "encoder|structured_decoder|server_model", "revision": "..."}
}
```

合同硬约束：

1. mention 必须逐字匹配自己的 source revision；字符 offset 由 tokenizer offset map 回填并复核，
   模型不得直接数 Unicode 下标。
2. operation、mention 和 relation 都是候选；只有 graph validator 与 executor 通过后才能形成 Draft。
3. `correction_old` 不能进入最终 slot；`correction_final` 必须通过 `replaces` 或字段唯一性闭合。
4. query/delete mention 只能成为 operation filter/target，永远不能投影成 saveable create。
5. relation 白名单、出入度、无环约束和同 source/跨 source 规则由确定性 validator 执行。
6. executor 只读取 graph、reference/timezone、显式 draft revision 和候选 event snapshot；不得接收完整
   raw text。它可解释单个已选 date/time/recurrence mention 的表面形式，但不得在全句重新找 token。
7. title 若由不连续来源组成，必须以有序 `composes` 关系保留所有片段；执行器不能补写模型想象的
   人名、动作或事项。
8. clarification 是 `parent_revision + new source turn + graph patch`，使用 CAS；不能把补充文本当新的
   独立日程，也不能把完整旧 `ParseResult` 当可变真相。

**最关键的否决门：** 如果 relation head 的训练数据不足，或 graph exact/operation target 指标明显
低于 structured decoder，停止 joint encoder；不得把关系逻辑转回手写全文正则来“补齐”。

## 路线 A：relational joint encoder + single executor

### 可实现形态

- 一个中文或多语 encoder，共享 hidden states；
- sentence heads：operation、OOD、是否需要 clarification；
- span proposal heads：start/end + field + role；
- relation head：仅对白名单 mention pair 打分；
- graph validator + deterministic executor；
- 最终导出一个量化 ONNX artifact 和一个 tokenizer revision。

**工程推断。** 首个可审计 backbone 可从 Apache-2.0 的
[`bert-base-chinese`](https://huggingface.co/google-bert/bert-base-chinese) 做上限/teacher 开始：
官方模型卡明确为 Chinese、Apache-2.0，FP32 safetensors 约 412 MB。它不是端侧最终尺寸；
只有在任务训练有效后才讨论 4--6 层蒸馏 student。`huawei-noah/TinyBERT_*_zh` 当前模型卡缺失，
不能仅凭组织名继承代码仓库许可证或训练语料结论。

[`mdeberta-v3-base`](https://huggingface.co/microsoft/mdeberta-v3-base) 明确包含中文且为 MIT，
但官方卡列出 86M backbone 加 190M embedding，端侧体积不利；更适合 server/teacher 对照，
不能因为 GLiNER2 使用 DeBERTa 就直接采用。

### 部署边界

**事实。** [ONNX Runtime Mobile](https://onnxruntime.ai/docs/tutorials/mobile/) 支持 Android
Java/C/C++，Android 可选 CPU、NNAPI 和 XNNPACK；官方建议量化模型先从 CPU EP 开始，并明确
要求在目标设备测二进制大小、模型大小、延迟和功耗。ONNX Runtime 为 MIT。

**工程推断。** 相同 ONNX graph 可在 Android、Linux 和 Windows 使用 CPU EP；Windows 可另测
DirectML，Android 可另测 XNNPACK/NNAPI，但 accelerator 只应是优化，不是语义正确性前提。
NNAPI 算子分区可能反而变慢，不能从“可加载”推出“更快”。

**未验证。** React Native 端仍需要一个一致的 WordPiece/tokenizer offset 实现；ONNX 文件本身
不包含完整 tokenizer 和字符 offset 合同。Android、Python 和 Windows 三端必须对同一 Unicode
输入产生相同 token IDs/offsets，否则 exact source span 会漂移。

### 优点

- 非 autoregressive，一次前向同时得到 operation、mention 和 relation，理论上最适合高频首结果；
- 原文不出设备即可产生可审计 Draft；
- 输出空间封闭，无法生成不存在的 quote；
- 量化 ONNX 有清晰的 Linux/Windows/Android 路径；
- 若质量成立，可以实质删除 client/server 的最终 regex owner。

### 风险

- 关系和跨 turn 指代可能超过小 encoder 的容量；
- 标注成本最高，弱 teacher 很容易把旧 owner 偏差蒸馏进去；
- span proposal、relation 和 operation 的联合误差会相乘；
- 中文字符/子词 offset、量化校准和 OOD 校准都需独立验证；
- executor 对时间 mention 的解释仍可能膨胀，必须用“不读整句”静态门约束。

## 路线 B：端侧小型 seq2seq / structured decoder

### 两类可审计基础

1. [`google/mt5-small`](https://huggingface.co/google/mt5-small)：Apache-2.0，模型卡明确覆盖
   Chinese/101 languages，但约 300M 参数且必须下游 fine-tune。
   [Optimum ONNX](https://huggingface.co/docs/optimum-onnx/en/onnxruntime/package_reference/modeling_ort)
   官方支持 `mt5` 的 `ORTModelForSeq2SeqLM`，这证明可导出/桌面执行，不证明 Android 上已经有
   符合老记延迟和内存的生产生成循环。
2. [`Qwen3-0.6B`](https://huggingface.co/Qwen/Qwen3-0.6B)：Apache-2.0、0.6B、100+ languages；
   [`llama.cpp`](https://github.com/ggml-org/llama.cpp) 为 MIT，提供 Android build 和 GBNF/
   JSON-schema grammar。candidate 0014 已否决 raw checkpoint，但专门 SFT/蒸馏后的新 revision
   仍可作为新候选，不能继承 raw 结论，也不能假定微调一定修复。

### 结构化生成不等于正确语义

**事实。** `llama.cpp` grammar 可限制 JSON/GBNF 结构。2025 ACL SchemaBench 研究仍指出，最新
LLM 对有效 JSON schema 存在困难；结构合法与字段真实是两道门。

**事实。** 2025 EMNLP
[`Grammar Pruning`](https://aclanthology.org/2025.emnlp-main.858/) 用高召回 rule NER 动态裁剪
grammar，在其 FoodOrdering/APIMix 基准报告较高执行准确率；作者官方仓库为 MIT。论文附录同时
展示：完整 grammar 仍会选择语义不相关值，小模型会漏抽实体；其 Raspberry Pi 上 Qwen2.5-0.5B
Q4 总延迟仍为秒级。这些数字不是中文手机或老记指标。

**工程推断。** 把 Grammar Pruning 原样搬进老记会重新引入“规则 NER 是高召回 owner”，与本轮
删除双规则的目标冲突。若用 encoder 为 decoder 裁剪 grammar，就变成两个模型/两次前向；只有
当它在关系 exact 和复杂句质量上显著胜过单 encoder，额外等待才有意义。

### 适合老记的受限对照协议

- decoder 只输出 operation、exact quote、occurrence、role 和 relation；不输出 canonical date；
- grammar 中的 quote 值必须由当前输入的候选 substring 动态生成，不能是任意字符串；
- 输出同一 Schedule Mention Graph，再走同一 executor；
- 无效 quote、重复 occurrence 歧义和不支持 relation 一律 fail-closed；
- 输出 token 上限必须很小，并记录 TTFT 与完整 graph 完成时间，不能只报 tok/s。

### 优点与风险

- 优点：自然表达变长关系和多 turn patch；schema 演进比固定 heads 灵活；可做 constrained decode。
- 风险：autoregressive 首结果慢；模型/运行时包大；grammar 只保 syntax；quote/operation 仍可能错；
  Android 内存和电量压力大；当前 raw 0.6B 隔离质量已经很差。

**当前处分：** 保留为同数据 countercandidate；不作为默认首路径，也不在服务器下载/部署。

## 路线 C：纯服务端模型 + single executor

### 当前可用基础

**事实。** `app/services/llm_provider.py:70-84` 已将 generation provider 显式限制为 Ollama 或
DashScope，并禁止静默云/本地 fallback。当前 cloud transport 会把部分 Ollama JSON schema
降为 `json_object`，详细字段仍由 prompt 和本地 validator 保证。

**事实。** 百炼官方文档说明 Qwen3.5 Flash 支持 structured output、Function Calling 和 context
cache；JSON mode 仍要求下游 jsonschema 校验，且官方明确提供无效 JSON 的修复建议。这不是
字段语义或低延迟保证。

**事实。** candidate 0013 中本地 9B quote producer 同批 30 条全部返回、26/30 与 source intent
一致、出现 1 个不存在 quote，wall 28.5 秒且整批末尾返回。该批处理时间不是单请求 p95，也不能
与云端或目标手机比较。

### 优点

- 不增加 APK 模型、tokenizer 和本机 RSS；
- 对纠正、上下文和关系表达能力最强；
- Provider 已有 local/cloud 显式切换，可复用同一 graph schema 和 validator；
- 最容易作为 weak teacher、shadow ceiling 或低置信复杂输入 producer。

### 风险

- 所有简单文本都需网络、认证、排队和模型完整输出，失去当前近同步本地路径；
- 简单输入也离开设备，扩大隐私和故障面；
- JSON 合法不等于 source-grounded，仍需逐字 quote/relation validator；
- 本地 9B 与云端模型 revision 会变化，必须记录 model/prompt/provider revision；
- outage 时若回退到旧规则，双 owner 永久存在；如果不回退，则需可编辑的 fail-closed 本地草稿。

**当前处分：** 作为 teacher、complex-only producer 和质量/延迟对照；未证明真实联网 p95、成本、
可用性和隐私接受前，不采用为无条件首路径。

## 路线 D：维持当前双规则 + 9B fallback

### 仍然成立的优势

- 常见 local-safe 文本无需网络，首结果快；
- 当前已有大量边界处理和用户确认 UI；
- 不新增模型资产、训练流水线或 Android native runtime；
- 生产可回滚基线已存在。

### 结构性代价

- client/server intent、日期、重复、标题和 clarification 分别演化；
- model 输出后仍由全文正则改写，无法辨别“模型成功”与“规则挽救”的真实质量；
- 新自然表达往往通过添加词面和特殊分支修补，测试对 owner 的归因困难；
- 多次全文重扫会让 title 中的时间词污染 date/recurrence；
- 服务端不可用、model-only 无结果和 fallback 的用户结果不同且难以统一解释。

**当前处分：** 保持生产与回滚，不再新增长期词面分支；候选未通过前不删除。

## 同一尺度的路线比较

下表的“潜力/风险”是工程推断，不是实测分数。

| 维度 | 当前多 owner | flat joint encoder | relational encoder | 端侧 structured decoder | 纯服务端模型 |
| --- | --- | --- | --- | --- | --- |
| 中文现成度 | 已运行但漂移 | 无训练产物 | 无训练产物 | mT5/Qwen 有中文预训练，任务未适配 | 9B/百炼可调用，任务质量仅窄 probe |
| 纠正/补充/关系 | 规则很多 | 表达不足 | relation head 显式表达 | 结构表达最灵活 | 结构表达最灵活 |
| 端侧首结果 | 常见句最快 | 理论上快 | 理论上快但 pair head 增量 | autoregressive 风险高 | 必经网络/队列 |
| source grounding | 多次重扫，难归因 | span 强 | mention + relation 强 | 需动态 quote grammar + validator | 需 quote + validator |
| Android 包/RSS | 低 | 中 | 中 | 高 | 低 |
| 离线 | 常见句可用 | 可 | 可 | 可但资源重 | 不可 |
| 训练/标注 | 无新增 | 中 | 高 | 高 | prompt/eval 中，fine-tune 另计 |
| 删除旧 owner 潜力 | 无 | 中，但 executor 易膨胀 | 高 | 高 | 高 |
| 最大风险 | 永久漂移 | 关系缺失 | gold 不足/校准失败 | 慢且合法错误 | 网络、隐私、可用性 |
| 当前角色 | C0/rollback | rejected as target | primary isolated candidate | countercandidate | teacher/ceiling/complex-only |

## 许可证与供应链闭环

| artifact / dependency | 第一方已见条款 | 当前可作何种结论 | 仍需闭合 |
| --- | --- | --- | --- |
| MASSIVE calendar train/dev | CC BY 4.0（candidate 0011 已留 manifest） | 可做带署名的隔离 pre-adaptation | 每个派生训练集保留 source ID、split、license 和修改说明 |
| `bert-base-chinese` | Apache-2.0 | 可作 encoder teacher/上限候选 | 派生权重 NOTICE、训练数据、量化工具和 tokenizer 版本 |
| `mdeberta-v3-base` | MIT | 可作较大 encoder 对照 | 体积、词表来源、派生权重和移动算子实测 |
| GLiNER2 / multi-v1 | Apache-2.0 | 可借鉴联合分类/抽取结构 | checkpoint 无中文，不能直接进入中文候选 |
| mT5-small | Apache-2.0 | 可作中文 seq2seq 对照 | Android decoder/runtime、派生权重和 tokenizer 包 |
| Qwen3-0.6B | Apache-2.0 | 专门 fine-tune 可作为新候选 | raw checkpoint 已失败；GGUF 转换、LoRA merge、NOTICE 和设备资源 |
| ONNX Runtime | MIT | 可作共同跨平台 inference runtime | Android AAR、自定义 build、ThirdPartyNotices 和 EP 依赖 |
| llama.cpp | MIT | 可作 decoder/grammar runtime | GGUF 模型许可与转换工具链独立审计 |
| Grammar Pruning 作者实现 | MIT | 可复核 structured-decoder 设计 | 其改编数据、规则抽取器和论文基准不自动授权老记训练 |
| 百炼 API | 商业服务条款，不是开源权重许可 | 可作远端 provider/teacher | 地域、数据处理、留存、费用、配额和模型 revision 合同 |

**工程推断。** “代码 Apache/MIT”只闭合 runtime 源码，不自动闭合 checkpoint、训练语料、
派生权重或商店分发。候选 manifest 必须把四者分别列出；缺任一项时只能留在隔离环境。

## 训练、导出与评估设计

### 数据隔离

1. MASSIVE `train/dev` 只做 operation/slot 的 domain pre-adaptation；保留 source ID、原始 split、
   CC BY 4.0、translation/localization provenance 和样本权重。
2. `candidate-test-150`、盲审队列及其任何人工修订永不进入训练、prompt、阈值选择或错误补丁。
3. correction/clarify/context_edit/OOD/query target/delete target 建立独立 LaoJi gold；必须包含真实自然
   来源或明确标记 authored，不能靠笛卡尔替换伪装自然覆盖。
4. 9B/cloud 输出只能是 `weak_model_label`。任何进入 gold 的 span/relation 必须人工逐项确认。
5. split 按 source、semantic event group、说话人/音频来源和近重复簇隔离；同一基础语句的改写不能
   跨 train/test。
6. 2024 PPCL 论文显示 oronym、synonym、paraphrase 会使 IC/SF 退化，并提出 consistency learning。
   老记可把 ASR 同音、同义改写和口语填充作为**训练候选**，但论文结果不证明中文收益；必须对
   clean/perturbed pair 分开报告，不能用增强样本污染冻结集。

### 训练目标候选

relational encoder 不采用“一个 BIO loss 就完成 joint parsing”的假设。隔离训练至少显式比较：

```text
L = w_op * CE(operation)
  + w_ood * CE(in_domain)
  + w_span * (start/end + field/role loss)
  + w_rel * relation loss
  + w_consistency * clean/perturbed consistency loss
```

- loss 权重只用 train/dev 选择，不读取 frozen test；
- operation 类别与罕见 relation 使用 class-balanced sampler 或 loss，但必须报告原始分布指标；
- span 必须以原始字符 offset 标注，再投影到 tokenizer；被截断或无法对齐的行不静默改标签；
- hard negatives 包括 title 内的日期词、时间名词、否定旧值、相同 quote 多次出现和 query/delete
  target，但只能来自 train/dev；
- teacher logits/quote 只可做 distillation 辅助项，人工 gold 始终单独保留并可审计；
- relation head 若靠 gold mentions 才有好指标，必须另报 end-to-end predicted-mention relation 指标。

### 模型与导出接口

relational encoder 的 ONNX 输出必须固定并可在无 Transformers 运行时下解释：

```text
operation_logits[B, operation]
ood_logits[B, 2]
mention_start_logits[B, T, field_role]
mention_end_logits[B, T, field_role]
mention_pair_logits[B, K, relation]
```

K 只包含 top-k 候选 mention pair，避免 `T^2` 无界输出。模型 artifact、tokenizer、label map、
normalization revision、training manifest 和量化参数分别 hash。导出后至少验证：

- PyTorch 与 ONNX FP32/INT8 输出语义等价；
- Linux/Windows/Android token IDs、offsets、graph 和 Draft 一致；
- 动态长度、空输入、超长输入、繁简混排、emoji、数字/英文地点和 surrogate pair；
- CPU EP 为合同基线，XNNPACK/NNAPI/DirectML 只做可关闭优化；
- 模型加载、首请求、warm p50/p95、RSS、包体、电量和四路并发。

### 质量门

- operation macro-F1；每类 precision/recall；
- mention exact F1、partial F1，按 field/role 分解；
- relation exact F1；完整 graph exact；
- executor 后 slot exact、Draft state、clarification precision/recall；
- query/delete target exact 与多候选确认正确率；
- silent-create count 必须为 0，尤其是 query/delete/reject/context_edit；
- unsupported/ambiguous 输入的 selective risk 与 over-clarification rate；
- clean、自然口语、ASR perturbation、跨 turn 和量化后分别报告；
- 六个当前真实 hard case 全部通过，禁止样本词补丁。

论文或 public source label agreement 不替代上述任何门。人工门必须展示 blind annotation、一致率、
分歧 adjudication 和冻结 hash。

### 性能与 owner 删除门

- 端侧 warm p95 目标 `<100 ms`、cold `<500 ms` 仍只作为候选目标，必须由目标真机证明；
- 报告从用户提交到可编辑 Draft 的端到端时间，而不是只有 model forward；
- server-only 分开报告 DNS/TLS、认证、queue、inference、完整 graph 和 executor；
- structured decoder 报 TTFT 和完整 graph，不能用 TTFT 代替用户结果；
- 任何候选在切生产前必须删除或旁路至少一个现有最终 owner，并提交静态调用图证明。

## 迁移与回滚设计

### Phase 0：冻结反事实基线

- 固定相同的 text、audio transcript、reference/timezone、draft context 和 expected graph/Draft；
- 保存 C0 的 local/remote/model/fallback/clarify route 与分段延迟；
- 不新增生产字段或 telemetry 正文。

### Phase 1：离线双候选

- relational encoder 和 structured decoder 读取相同 train/dev；冻结 test 只由评估 runner 读取；
- 二者都只输出 Schedule Mention Graph，使用同一 validator/executor；
- pure server 以 quote/relation prompt 生成同一 graph，作为 teacher/ceiling；
- 不把任一路结果写入生产 Draft 或事件。

### Phase 2：只读 shadow

- 只有离线门通过后，新增内部 shadow envelope；旧请求结果保持不变；
- 客户端可在本机计算 candidate hash/metrics，但不上传原文 shadow 日志；服务端只记 route、hash、
  latency、model revision 和错误码；
- shadow 不允许把 candidate 字段混进旧结果。

### Phase 3：能力位切换

- 新客户端按 capability 读取 graph -> Draft；旧接口只做 legacy projection；
- producer 选择必须 request-scoped：一次请求只能由 encoder、decoder 或 server model 之一成为候选
  producer，禁止字段级合并；
- 低置信 encoder 可以整体升级到 server producer，但 server 必须重新产完整 graph，不能让两者
  各自决定部分字段；
- executor 和 save confirmation 始终唯一。

### Phase 4：删除旧 owner

最终采用门必须明确删除/旁路：

- 客户端 `parseLocalScheduleText()` 的最终语义职责；
- `classifyScheduleParseIntent/Route()` 的 create/query/delete 最终正则；
- `normalizeScheduleParseResult()` 对完整原文的时间/日期/重复二次扫描；
- 服务端 `classify_schedule_intent()` 与 `_parse_schedule_text_quick()` 的最终语义职责；
- `_deterministic_complex_fallback()` 的可保存结果；
- `_normalize_llm_result()` 对 raw text 的 title/date/time/recurrence 重算；
- `apply_schedule_clarification()` 对完整旧 draft/raw text 的重推断。

可暂留一个发布周期的 legacy **整链** kill switch。回滚时整体切回 C0，不允许长期逐字段 fallback；
否则双 owner 会被永久保留。新合同在切保存前不改变事件表，因此早期回滚不需要数据库逆迁移。

## 采用/否决判定

### relational encoder 进入 shadow 的必要条件

1. 至少 120 条独立人工冻结 test 闭合，并另有 relation/cross-turn/OOD split；
2. 六个真实 hard case 无样本词补丁通过；
3. silent create 为 0，operation/mention/relation/target 指标逐项达到 adopted 门；
4. 目标真机端到端首 Draft 快于 C0 的同 route，并满足 RSS/包体/功耗预算；
5. INT8 后质量、offset 和跨平台一致性通过；
6. 删除清单能在调用图上真实移除至少一个旧 owner；
7. executor 不接收 full raw text，不含新的 intent/title/range 全句扫描。

### 立即否决条件

- 需要把 frozen test、source labels 或 9B weak labels 当 gold 才能过门；
- flat spans 无法表达关系，却通过手写完整原文规则补齐；
- encoder 仅成为旧 parser 的“建议”，旧 owner 仍决定最终字段；
- Android token offset 与 server 不一致；
- 量化使高置信 silent-create 上升；
- structured decoder/纯服务端模型在同输入上明显更准且仍满足用户延迟预算；
- 候选增加常驻模型/队列/状态 owner，却没有删除旧 owner。

## 尚未验证且不能提前承诺

- LaoJi-specific relational encoder 能否用现有数据训练到可用质量；
- `bert-base-chinese` 或蒸馏 student 在目标真机的真实 p50/p95、RSS、电量和包体；
- NNAPI/XNNPACK/DirectML 是否比统一 CPU EP 更快；
- mT5/Qwen structured decoder 在中文 LaoJi graph 上是否优于 encoder；
- 百炼或本地 9B 的真实单请求联网 p95、可用性和成本；
- relation gold 的标注成本和人工一致率；
- query/delete 真实产品是否要在本阶段执行，还是只安全识别并交给后续 operation owner；
- 当前 Qwen/Ollama 打包权重、所有训练数据和 transitive dependency 的完整分发许可。

## 外部第一方资料

- [INT: Establishing Information Transfer for Multilingual Intent Detection and Slot Filling
  (ACL 2025)](https://aclanthology.org/2025.findings-acl.783/): multilingual ID/SF，slot 改写为 span
  prediction；未找到可直接审计采用的官方训练代码/权重。
- [GLiNER2 官方仓库](https://github.com/fastino-ai/GLiNER2) 与
  [multi-v1 官方模型卡](https://huggingface.co/fastino/gliner2-multi-v1): Apache-2.0、联合
  extraction/classification 架构参考；multi-v1 只列 `fr/en/es/de/it/pt`，不含中文。
- [Prompt Perturbation Consistency Learning (EACL 2024)](https://aclanthology.org/2024.findings-eacl.91/):
  IC/SF 对 oronym、synonym、paraphrase 的鲁棒性证据；不是中文 LaoJi 指标。
- [Grammar Pruning (EMNLP 2025)](https://aclanthology.org/2025.emnlp-main.858/) 与
  [作者官方实现](https://github.com/octatrifan/grammar-pruning): 动态 grammar + 小模型的边缘
  structured decoder 反事实；代码 MIT，基准和延迟不可外推老记。
- [Learning to Generate Structured Output with Schema Reinforcement Learning
  (ACL 2025)](https://aclanthology.org/2025.acl-long.243/): JSON schema 合法性仍需独立验证。
- [Qwen3-0.6B 官方模型卡](https://huggingface.co/Qwen/Qwen3-0.6B) 与
  [Qwen3 官方说明](https://qwenlm.github.io/blog/qwen3/): Apache-2.0、0.6B、多语和本地运行边界。
- [llama.cpp 官方仓库](https://github.com/ggml-org/llama.cpp)、
  [Android build](https://github.com/ggml-org/llama.cpp/blob/master/docs/android.md) 与
  [GBNF/JSON schema grammar](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md):
  MIT、跨平台 decoder 与语法约束；不提供任务语义保证。
- [mT5 官方研究](https://research.google/pubs/mt5-a-massively-multilingual-pre-trained-text-to-text-transformer/)、
  [mt5-small 官方模型卡](https://huggingface.co/google/mt5-small) 与
  [Optimum ONNX seq2seq](https://huggingface.co/docs/optimum-onnx/en/onnxruntime/package_reference/modeling_ort):
  Apache-2.0、Chinese、多语 seq2seq 和 ONNX 对照路径。
- [ONNX Runtime Mobile](https://onnxruntime.ai/docs/tutorials/mobile/)、
  [Execution Providers](https://onnxruntime.ai/docs/execution-providers/) 与
  [MIT license](https://github.com/microsoft/onnxruntime/blob/main/LICENSE): Android/Linux/Windows
  候选 runtime；真实性能必须逐设备测量。
- [百炼 Qwen structured output](https://help.aliyun.com/zh/model-studio/qwen-structured-output) 与
  [Qwen3.5 Flash](https://help.aliyun.com/zh/model-studio/qwen3-5-flash): 纯服务端 JSON-mode
  反事实；文档要求下游校验，未提供老记延迟/质量。

## 最终研究处分

- 0009 的“joint intent/span encoder”不原样晋升；**flat 版本作为目标架构被否决**。
- 下一隔离主候选改为 `Schedule Mention Graph + relational joint encoder + single executor`。
- `grounded structured decoder` 必须使用完全相同的 graph、executor 和 frozen split 做反事实；若它
  在关系/跨 turn 上显著更好且目标真机延迟可接受，应允许它胜出，不保护 encoder 路线。
- pure server model 保留为 teacher/ceiling/complex-only；C0 保留为整链 rollback。
- 在独立人工 gold、关系合同、目标真机延迟和 owner 删除证明闭合前，所有路线继续
  `candidate; not adopted`，生产保持不变。
