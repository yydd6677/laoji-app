# 0033 统一自适应会议整理

- status: `SELECTED; Slice A implemented in Android 1.1.63; Knowledge V4 shadow pending`
- scope: 会议整理事实协议、本地投影、板块交互、富内容、引用、分享、迁移和验收
- supersedes: 面向用户的 `通用 / 1:1 / 项目同步 / 访谈` 四模板投影与模板偏好
- preserves: immutable source、单 pack/章一次生成、Facts V3 历史、ActionItem 独立 owner、版本历史、精确引用
- production mutation: `client presentation only; no API/model/runtime restart`

## 1. 触发事实与结论

2026-08-23 在真机记录 `1436403866` 上逐项检查整理结果，至少“通用”和“访谈”显示了相同顺序、
相同正文和相同来源时间的条目；其余模板的可见差异主要是板块标题，而不是信息选择或组织方式。
源码审计确认这不是使用者误解，而是当前投影规则的确定性结果：

- 通用“主要议题”、1:1“讨论主题”和访谈“主题”都选择 `topic + context`，通用只额外加入
  `question`；当事实主要为 `context` 时三者必然相同。
- 项目同步“进展”选择 `completed` 或 `context/conclusion`，在汇报型记录中仍会吸收同一批
  `context`。
- 访谈“受访者观点”把“事实类型为 quote，或任一来源含 speaker”作为条件。Transcript 的普通片段
  天然含 speaker，连“未知讲话人”也满足条件，因此普通事实被重新显示为逐字转写观点。
- 每个富条目已经显示 `讲话人 · 时间` 并支持跳转，板块末尾又渲染同一批 citation chip，来源信息
  被重复展示。
- 既有“八种富块可见”回放只证明 renderer 能画出组件，不证明真实事实能够语义正确地触发这些组件。

因此，当前表现同时包含实现缺陷和产品抽象缺陷。缺陷不是“模板提示词不够不同”；模板根本没有参与
V3 生成，同一事实集合仅在客户端按粗粒度 fact type 重排。继续增加模板条件会扩大启发式分支，仍不能
保证区分度。

最终决定不是把四份结果首尾拼接。那会把同一事实显示四次。目标是把四类模板想表达的能力合并成
一份统一、自适应、证据驱动的整理：一次生成共享语义文档，本机只显示有足够证据的板块。

### 1.1 发布前实现审计

本次没有把完整 V4 协议直接塞进生产 Provider。对现役本地 9B 路径的真实审计显示，Facts V3 紧凑
结构已经存在首次输出需要一次 schema repair 的任务；此时同时扩大事实类型、主题、metric、viewpoint
和关系 DTO，会把用户提出的展示缺陷转化为生成可靠性和时延风险。因此采用两段式落地：

- Android `1.1.63` 先在现有、不可变 Facts V3 之上启用唯一的自适应投影，立即修复模板同质、speaker
  冒充观点、正文重复 owner 和逐条时间引用重复；
- V3 没有独立 viewpoint/metric 语义时必须失败关闭：不靠 speaker、标题或正则臆造观点，数据、流程、
  对比和时间线只在现有事实及关系满足保守准入时出现；
- Knowledge V4 仍是目标事实协议，但只允许按 Slice B 的 shadow、结构成功率、时延和事实支持门推进，
  不能把本次客户端采用写成 V4 已上线。

## 2. 产品合同

### 2.1 单一整理页面

整理页不再提供“通用/1:1/项目同步/访谈”选择。每个整理版本只有一个内容身份、一个来源指纹和一个
自适应展示结果：

```text
不可变 Transcript / 当前笔记 / 本次授权附件
  -> 单次结构化语义生成
  -> 来源、关系、重复和逐字复制校验
  -> 本机确定性自适应组装
  -> 一份整理 + 一份行动候选区 + 可展开依据
```

默认结构按信息存在性确定，不为凑版面创建空板块：

1. `概述`：始终存在；是跨事实的紧凑综合，不是首条转写或若干事实机械拼接。
2. `主题与要点`：存在尚未被更精确结构认领的主题、背景或引用事实时显示；V4 后按显式主题聚类。
3. 条件板块：数据、对比、时间线、流程、风险与阻塞、待确认问题、观点与反馈。
4. `本场待办`：沿用现有唯一 ActionItem 区域，只出现一次；生成候选仍须由用户确认。
5. `依据`：默认收纳，按板块去重后展开；不再在每个普通条目末尾重复讲话人和时间。

“决定”不恢复为独立板块。确认结论进入概述、对应主题、时间线或流程节点。没有结论的会议不生成
“无决定”占位。

### 2.2 板块控制替代模板控制

整理页顶部原模板入口替换为“板块”。点击打开本地 sheet：

- 显示本版本所有已通过准入的可选板块及其当前显隐状态。
- `概述`、`主题与要点`和`本场待办`是固定结构，不允许通过隐藏制造“内容丢失”的误解；无行动时
  本场待办仍按现有空态处理。
- 时间线、流程、数据、对比、风险、问题和观点可隐藏或重新显示；关闭只改本机偏好，不删除事实。
- 未通过准入的板块不显示为可勾选项。例如没有可比较方案时，不提供空的“对比”开关。
- 提供“恢复自动”，删除本会议的自定义显隐偏好并回到自适应默认。
- 第一版不提供任意拖拽排序。顺序由合同固定，避免板块覆盖层与版本迁移形成第二布局 owner。
- 切换显隐不联网、不新建整理版本、不改变来源指纹，暖态目标低于 100 ms。

旧模板名称只在旧版本历史的兼容说明中出现，不再是新整理的交互或身份字段。

### 2.3 观点板块

“有讲话人”不等于“有观点”。观点板块只在以下条件全部满足时出现：

- 至少有两条明确表达判断、反馈、偏好、建议或关注的事实，或者存在两个可比较的不同立场；
- 每条观点都有可解析来源，正文是综合表达而不是转写逐字复制；
- 人名展示只接受已解析且非匿名的 speaker/profile/明确角色。未知讲话人的发言不得包装为“某人的观点”；
- 单个普通陈述、项目进展、事实背景和产品能力描述不进入观点板块；
- 只有一个孤立观点时并入所属主题，不单独成板块。

因此，`1436403866` 若没有满足上述条件的多条立场事实，应完全不显示观点板块。系统不根据标题、文件名
或用户曾选过“访谈”推断它是访谈。

## 3. 目标语义协议

### 3.1 MeetingKnowledgeDocumentV4

在保留 V3 历史可读性的同时，新增不可变 `MeetingKnowledgeDocumentV4`。模型仍不输出 UI、Markdown、
图标、颜色、坐标或图表代码；它只输出可校验的语义数据。

```text
MeetingKnowledgeDocumentV4
  schema_version = 4
  overview
    text <= 160 Chinese chars
    fact_ids[1..12]
  themes[1..8]
    theme_id
    title <= 24 Chinese chars
    synthesis <= 240 Chinese chars
    fact_ids[1..12]
  facts[1..40]
    fact_id
    fact_type = topic/context/conclusion/action/risk/question/quote/timeline/metric/viewpoint
    certainty = confirmed/proposed/uncertain/negated/completed
    content
    theme_ids[0..2]
    sources[1..3]
    evidence_score (server computed)
    conflict_group_id?
  relations[0..48]
    supports/contradicts/precedes/depends_on/alternative/part_of
  metrics[0..12]
    metric_id, label, value_text, unit?, scope?, comparison_group?, fact_ids[1..3]
  viewpoints[0..12]
    viewpoint_id, synthesis, stance, speaker_ref?, role?, fact_ids[1..4]
  action_candidates[0..10]
```

`stance` 只允许 `assessment/preference/feedback/suggestion/concern`。`speaker_ref` 必须解析到本次来源版本；
模型不能创造人物或把 `未知讲话人` 变成命名实体。`metric.value_text`、单位、范围和比较基准必须由引用
直接支持。模型生成的置信度继续不采用。

Provider 使用有界紧凑 DTO：每 pack 最多 `f1..f12`、`t1..t6`、`m1..m6`、`v1..v6`、
`r1..r16`、`a1..a6`。服务器恢复稳定 ID、来源类型、逐字引用、哈希、时间和讲话人。持久协议的较大
上限用于跨章确定性合并，不允许单次模型无限输出。

### 3.2 一次生成与长会

- 短/中会议每个 pack 正常只有一次 `summary.knowledge.v4` provider 调用；只有整体 JSON 无法通过
  Schema 时允许一次结构修复。不得增加模板、观点、图表、写作润色或逐行动第二次调用。
- 长会议继续按确定性章节处理，每章一次同协议生成，由代码合并。不得恢复递归模型摘要。
- 章节主题先按共享来源、标准化标题和语义向量确定性合并；默认候选规则为：来源有重叠且 cosine
  `>=0.76`，或 cosine `>=0.88` 且中文二元组 Jaccard `>=0.20`。阈值属于 revisioned reducer 配置，
  只能通过跨会议 holdout 调整，不能加入行业/样本专用词。
- 跨章 overview 从已验证主题和高证据事实确定性压缩，最多 160 字；不能为了语言润色再调用模型。
- 所有章完成前继续展示上一份可用结果，checkpoint 不作为部分整理发布。

### 3.3 语义和逐字复制校验

- 所有可见陈述都必须通过事实 ID 回到 1 至 3 个当前来源；引用原文匹配率为 100%。
- overview、theme synthesis 和 viewpoint synthesis 不得与单个来源 quote 完全相同。标准化后若可见
  综合文字的 85% 以上来自同一连续来源，且长度超过 16 个中文字符，标记 `VERBATIM_MASQUERADE`。
- `VERBATIM_MASQUERADE` 不触发第二次语义模型调用：对应综合块失败关闭，底层事实仍可进入普通主题；
  真正需要逐字保留的内容只能进入显式引用证据。
- 同一事实只拥有一个 primary block。overview 可以引用该事实作为高层综合依据，但不得再次逐字显示
  该事实正文。
- 规范化显示文本 hash 在同一页面只能出现一次；跨板块需要关联时显示“另见某板块”，不复制正文。
- 冲突事实保留在同一冲突组并显示“待确认”，不自动选边。

## 4. 自适应组装器

新增纯函数 `AdaptiveSummaryComposerV1`，输入 V4 文档和本机板块偏好，输出白名单 block tree。它不访问
网络、不调用模型、不读取会议标题猜类型。

### 4.1 事实分配顺序

1. 行动事实只进入行动候选；采用后由 ActionItem owner 管理。
2. 有效 metric 进入数据候选；已用于数据块的事实不再作为同文普通 bullet。
3. `alternative` 关系和共享比较维度进入对比候选。
4. `precedes/depends_on` 与明确时间事实进入时间线或流程候选。
5. risk 进入风险候选；只有来源同时明确影响和概率时才允许二维风险矩阵。
6. 满足观点准入的 viewpoint 进入观点候选。
7. 未分配的 conclusion/context/topic/question 按 theme 进入主题与要点；结论融入对应主题。

`primary_owner_by_fact_id` 在组装结束时必须覆盖所有可显示事实且无重复 owner。被多个语义结构引用的
事实只在主块显示正文，其他块保留内部 fact/source reference。

### 4.2 富内容准入

| 表现 | 准入条件 | 失败退化 |
| --- | --- | --- |
| 数据项 | label/value/context 都有来源；最多 4 个重点值 | 并入主题 bullet |
| 条形图 | 同一 comparison group 至少 2 个数值、单位一致且基准明确 | 数据表或 bullet |
| 饼图 | 第一版禁用；会议通常不能证明封闭全集与总和 | 数据表 |
| 对比表 | 至少 2 个方案、至少 2 个共享维度；每个单元格均有来源 | 方案 bullet；缺失值显示“未提及” |
| 时间线 | 至少 2 个可排序的明确时间/来源时间事实，节点语义不同 | 有序列表 |
| 流程图 | 2 至 8 节点、1 至 10 条明确 `precedes/depends_on` 边且无环 | 纵向步骤列表 |
| 风险卡 | 明确 risk 事实和影响；不从语气推断风险等级 | 风险 bullet |
| 风险矩阵 | 每项的概率和影响均被来源明确支持 | 风险卡；不得估算坐标 |
| 观点 | 满足 2.3 的多观点/多立场准入 | 并入主题或完全省略 |

图表是事实表达，不是装饰。没有符合条件的数据时，只有排版更好的文字也是正确结果；禁止为了让每份
整理“看起来丰富”而生成虚构维度、数字、关系或时间。

### 4.3 Android 展示

白名单扩展为：

```text
paragraph / bullet_group / quote / timeline / flow
comparison_table / metric_table / bar_chart / risk_card / question_group
```

- 图标由 block kind 映射到老记本地图标；模型不能指定。
- 标准蓝使用平面、紧凑分组和低饱和强调；绚彩只改变现有柔和表面和轮廓，不增加大面积渐变。
- 不把整理页改成 dashboard，不嵌套卡片；同级板块以标题、间距和细分隔组织。
- 窄屏优先纵向：流程自动退化为步骤，对比表允许单个区域水平滚动且冻结首列，条形图附等价文字值。
- 图表提供 TalkBack 摘要和逐项可访问文本；颜色不是唯一编码。
- 重新整理时保留上一份结果，单一状态 owner 继续单调推进，不因 block 数变化移动顶部固定控件。

## 5. 引用与跳转

来源仍是质量边界，但默认展示从“每条都重复”改成“按板块收纳”：

- 普通概述、主题、数据、时间线、流程和风险条目不再追加 `讲话人 · 时间`。
- 每个板块标题行最多显示一个 `依据 N 处` 按钮；N 是按 canonical source ID 去重后的数量。
- 点击后打开半屏依据 sheet，按当前板块中的首次使用顺序列出 `讲话人/来源类型、时间、短引用`；同一
  source 只出现一次。点击来源行跳到文字记录、笔记或附件的准确位置。
- 整个普通条目不再暗中作为跳转入口，避免用户不知道哪里可点；需要快速跳转时使用板块依据按钮。
- 显式 quote block 例外：讲话人和时间是引用语义的一部分，只显示一次，同时不再显示板块末尾重复 chip。
- 人工编辑的板块显示 `已编辑 · 原始依据 N 处`；来源仍指向生成时不可变版本，不声称支持用户新增文字。
- Markdown 分享将来源收纳为每板块末尾的脚注引用，同一 source 全文只定义一次；默认正文不重复时间。

## 6. 本机存储与 API

### 6.1 会议库迁移 0047

在 `laoji-meeting-memory.db` 新增：

```text
summary_knowledge_documents(
  summary_version_id PK/FK,
  schema_version CHECK(4),
  document_json,
  source_fingerprint,
  model_revision,
  prompt_revision,
  reducer_revision,
  created_at_ms
)

summary_layout_preferences(
  meeting_id PK,
  mode CHECK(auto/custom),
  hidden_block_keys_json,
  updated_at_ms
)

summary_block_overrides_v4(
  summary_version_id,
  stable_block_key,
  replacement_kind CHECK(paragraph/bullet_group),
  replacement_text,
  updated_at_ms,
  PRIMARY KEY(summary_version_id, stable_block_key)
)
```

`summary_fact_documents`、`summary_view_preferences` 和 `summary_view_overrides` 保持旧版只读，不能原地
改变模板列语义。新版本覆盖层不继承旧版本。block key 由 `document_id + semantic kind + stable
theme/group id` 决定，不使用可见标题。

### 6.2 Device V2

沿用现有 `POST /api/device/v2/meetings/{binding_id}/summaries` 和 generic operation，不增加第二任务
owner。请求仍不含模板 ID或布局偏好。新增：

- handler revision: `summary.knowledge.v4`
- artifact kind: `meeting_knowledge_v4`
- contract capability: `summary_knowledge_v4=true`
- presentation capability: `summary_adaptive_v1=true`
- 幂等根：source fingerprint + schema/prompt/model/reducer revisions

artifact 只保存不可变语义文档和覆盖元数据；显隐偏好永不上传。旧客户端继续读取 V3 artifact；新客户端
在服务端 capability 缺失时用 V3 compatibility adapter 生成统一布局，不恢复可见四模板。

## 7. 兼容、迁移与回滚

1. 首个客户端切片先对现有 V3 文档启用统一布局：删除模板入口，按事实类型/关系生成最保守板块，关闭
   “任意 speaker 即观点”，收纳重复引用。此步不要求重新生成，能立即修复现有记录的重复展示。
2. 旧 V3 当前版本继续可读；旧 template preference 不再影响 active view。若存在模板覆盖层，只把当前
   选中模板的人工覆盖作为“旧版自定义内容”保留在该历史版本，其他覆盖仍可在版本历史查看。
3. V4 服务 shadow 通过后，新生成写 V4；本机只有在 artifact、来源指纹和 activation fence 同时通过后
   原子切换 current version。
4. 旧记录不在数据库升级事务内批量调用模型。空闲迁移每台设备一次只处理一条，用户主动录音、上传、
   日程、问答或整理时立即让出；V4 成功前继续显示 V3 compatibility view。
5. 回滚只切 presentation/handler capability；V4 数据保持不可变历史，V3 reader 和旧表作为冷回滚资产
   保留。此次修订不授权 Stage 5B 物理删除。
6. 一个真实使用周期后，产品所有者另行授权才可删除旧模板入口代码、template preference 写入、V3
   active projector 和历史兼容 handler；版本历史 reader 仍须能解释旧版本。

## 8. 实施切片

### Slice A：立即纠正现有 V3 展示

状态：`IMPLEMENTED / RELEASED IN 1.1.63`。

- 新增 `AdaptiveSummaryComposerV1` 和 V3 compatibility adapter。
- 删除 active UI 的四模板 picker；改为“板块”sheet。
- 普通条目移除 speaker/time 尾注，新增去重依据 sheet。
- 修复观点条件、正文重复 owner 和 Markdown 引用重复。
- 不改服务端、不重生成即可验证 `1436403866`。

### Slice B：V4 语义合同

状态：`PENDING SHADOW; NOT PRODUCTION`。

- 新增 Pydantic/TypeScript schema、紧凑 provider DTO 和通用 prompt。
- 扩展事实/主题/metric/viewpoint 校验、逐字复制门、章节 reducer 和 artifact handler。
- 使用现有真实会议和 24 组整理/行动基线做 shadow；评测正文只进入 fixture，不进入生产 prompt 或源码
  分支。

### Slice C：语义富内容

状态：`PARTIAL V3 COMPATIBILITY`。Android 已有时间线、线性流程、显式方案对比、数据项和风险卡
renderer；V4 metric/viewpoint schema、表格/条形图和更完整的可访问性验收仍未实施。

- 实现 metric table、bar chart、comparison table、timeline/flow 退化和可访问性。
- 标准蓝/绚彩分别完成真实内容回放；所有图表先通过准入 fixture，再做截图测试。
- 分享投影与依据 sheet 同步接入。

### Slice D：采用与后台升级

状态：`PENDING`。本次发布不创建 0047、不写 V4 artifact、不切换服务端 capability。

- 0047 迁移、V4 repository、activation fence、版本历史和重启恢复。
- 先激活 `summary_knowledge_v4`，再激活 `summary_adaptive_v1`；禁止请求内静默回退。
- 发布后保留 V3 冷回滚，观察真实使用；不执行 Stage 5B 删除。

## 9. 验收门

### 9.1 结构与内容

- 新整理可见模板数量为 `0`；每个来源指纹只有一份 active 内容投影。
- 同一 normalized display text 在页面重复次数为 `0`；同一 fact 的 primary block 数恰好为 `1`。
- overview/theme/viewpoint 的 `VERBATIM_MASQUERADE` 可见数量为 `0`；只有 quote 允许逐字正文。
- 引用解析和原文匹配率 `100%`，事实人工支持率维持 `>=95%`，重复行动为 `0`。
- 观点 precision `>=95%`；未知讲话人被命名为观点主体的数量为 `0`。
- 图/表准入 precision `100%`：任何缺少单位、比较维度、显式关系或时间依据的 fixture 都必须退化。
- 生产 prompt 的评测标题、人物、专有词和连续 16 个中文字符样本污染命中为 `0`；few-shot 为 `0`。

### 9.2 真机回归

- `1436403866` 只显示一份整理；不得出现仅标题不同而正文相同的板块；没有有效观点时不显示观点。
- `/home/yydd/下载/会议视频样本` 中有字幕和无字幕样本均覆盖：汇报、多人讨论、项目同步、访谈、
  无行动、含数字、含冲突、含明确流程和超长会议。
- 24 组整理/行动基线同输入重放；旧 V3 与新 V4 分开统计，不把 renderer 可见当语义质量通过。
- 板块显隐 100 次不发网络请求、不创建版本，暖态 p95 `<100ms`；强制重启后偏好恢复。
- 每板块只有一个依据入口；展开后 source 去重，跳转位置准确；普通条目末尾无重复 speaker/time。
- 标准蓝和绚彩分别检查窄屏、字体缩放 1.3x、TalkBack、横竖屏重建、编辑覆盖和错误/生成状态。

### 9.3 任务与恢复

- 正常短会 provider 调用严格为 1，只有整体 Schema 失败允许 2；无模板、观点或图表第二调用。
- 生成、验证、artifact commit、本机激活四阶段分别中断，恢复后只产生一个 current V4 版本。
- 迁移失败始终保留 V3 compatibility view；来源未变不显示“整理结果可更新”。
- 现有 Summary/Q2 混合负载和资源预算不得退化；不增加常驻模型、数据库服务或 GPU1 依赖。

## 10. 研究取舍

QMSum 表明长会议很难由一个固定短摘要同时满足不同信息需求，合理方向是先定位相关跨度再进行聚焦
总结；这支持“统一事实层 + 用户可见板块”，而不是把会议强行归入四个互斥模板。事实一致性研究也表明
应把可见陈述与来源跨度一起验证，不能只用流畅度判断整理质量。

本修订不采用完整 GraphRAG。图结构对大语料全局主题有价值，但老记处理的是单场会议、固定服务器和
一次性生成；引入图数据库、社区摘要和多轮 map/reduce 会违反紧凑拓扑与延迟目标。这里只保留轻量的
事实关系、主题和来源图，并由本机确定性组装。

参考：

- [QMSum: A New Benchmark for Query-based Multi-domain Meeting Summarization](https://aclanthology.org/2021.naacl-main.472/)
- [Evaluating the Factual Consistency of Abstractive Text Summarization](https://aclanthology.org/2020.emnlp-main.750/)
- [From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://www.microsoft.com/en-us/research/publication/from-local-to-global-a-graph-rag-approach-to-query-focused-summarization/)

## 11. 不采用项

- 四份旧模板顺序拼接或默认全部展开。
- 继续用 fact type + 标题重命名伪造模板差异。
- 根据任意 speaker、文件名、会议标题或用户历史选择推断“访谈观点”。
- 每个 bullet 末尾重复讲话人和时间，同时再显示 citation chips。
- 模型直接输出图标、颜色、坐标、HTML/SVG、流程图代码或布局。
- 为每份整理强制生成图表、饼图、风险矩阵或装饰性卡片。
- 为观点、模板、图表或写作润色增加第二次模型调用。
- 在本次修订中删除 V3、旧模板表或其他 Stage 5B 冷回滚资产。
