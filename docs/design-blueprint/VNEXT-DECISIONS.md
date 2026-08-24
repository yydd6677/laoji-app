# 老记 vNext 决策与证据账本

- status: `architecture decisions closed for implementation`
- authority: [VNEXT.md](VNEXT.md)
- baseline: `1.1.10 (118)`

本文只记录会影响开发方向的决定、替代项、风险处理和证据。性能或质量门禁未实测通过不等于
架构待选；实施失败只有在触发全局反证条件时才允许重开架构。

## 1. 领域闭合表

| ID | 领域 | 结论 | 第一阶段 | 旧实现退出条件 |
| --- | --- | --- | --- | --- |
| D01 | 本机数据权威 | SELECTED | 日程库与会议库按生命周期隔离，各自由 canonical repository 独占 | 旧会议库日程表完成校验迁移并退役；会议库删除回放不影响日程 |
| D02 | 设备身份与隐私 | SELECTED | 配额化匿名 bootstrap + Keystore P-256 + 15 分钟 token/轮换；epoch/binding 单用途 purge capability；无账号 | APK 共享 enrollment secret、static bearer、action-share auth fallback 和旧 auth route 删除 |
| D03 | 日程解析 | STAGED | local fast producer + server graph producer，共用 validator | server quick/fallback/parser-normalizer 和本机第二语义 owner 删除 |
| D04 | 语音日程 | SELECTED | 先本地缓冲、WSS 后补发、同一 Graph/Draft 流程 | 阻塞连接提示与丢弃 pre-connect 音频路径删除 |
| D05 | 导入与上传 | STAGED | 全部先持久接纳 + 3 条内部本机准备 lane + MediaAudioExtractor + WorkManager + R2 generation | 全局/用户可见准备门限、JS Base64/轮询 registry、旧 chunk content path 无调用一周期 |
| D06 | ASR | SELECTED | 8030 Qwen3-ASR；段级 partial/stable/final | 批任务只在末尾整份回写的旧路径删除 |
| D07 | 讲话人与声纹 | SELECTED | CAM++ 异步 overlay；人工修正 CAS；服务端只缓存加密 embedding | speaker 阻塞 text-final、样本音频留存和原地改 transcript 的路径删除 |
| D08 | Transcript/笔记/附件 | SELECTED | immutable transcript/note/attachment-text revision + stable segments | mirror/reprocessed 原地覆盖和 remote sync 状态删除 |
| D09 | 整理与行动候选 | SELECTED | Knowledge V4；长会分章语义、代码合并；candidate 只作 provenance | v2 两轮模板、递归摘要、行动复核、关键词门禁和可见四模板退出 active path |
| D10 | 会议问答 | SELECTED | Q2 single reader + grounding + owner CAS | Q0 样本答案、多轮 verifier/editor/recovery 删除 |
| D11 | 标签/分类/搜索 | SELECTED | 显式标签 + 本地 FTS5；人物为 speaker 派生视图 | 整理主题分类和持久人物分类 owner 删除 |
| D12 | 回收站与删除 | SELECTED | local soft delete；永久删除 fence binding 并创建 purge/cleanup obligation | “未同步不能删除”、同步删除完成假象和可复活 binding 删除 |
| D13 | 分享 | RETAINED | 本地 Markdown 默认；device-auth 创建/撤销 binding-scoped 高熵公开 capability；公开字节只经撤销感知的 API 分块流式返回 | 旧账号分享、隐式上传原文、公开对象 URL 和脱离 purge 的公开 token 路径删除 |
| D14 | 更新 | RETAINED | current signed manifest/hash/size contract | 仅整理文档漂移；机制不重写 |
| D15 | UI 状态投影 | STAGED | ProjectionEnvelope 包住现有 JS/native snapshot | native/JS 第二 owner、中文文案状态判断和无 revision action 删除 |
| D16 | 任务 owner | SELECTED | immutable Task generation + append-only Attempt + ContentOutcome；长流使用固定两槽滚动 checkpoint；legacy bridge-and-drain | terminal reopen、逐章无界 checkpoint、domain retry owner 和 Celery/内存 future 删除 |
| D17 | Provider/资源 | SELECTED | 18020/8030/21434；16 GiB GPU、8 GiB RSS、16-core p95 与有界队列 | 业务直连端口、无界队列、11434/21436 静默 fallback 删除 |
| D18 | 可观察性 | SELECTED | traffic class + revision + stage + timing；正文禁止 | 空 client metadata 和无法区分自动/人工请求的日志格式删除 |
| D19 | 本场待办与提醒 | RETAINED | `action_items` 是唯一 mutable owner；保留手动/候选/标记 provenance、CRUD、提醒和后续日程 | 账号协作新写与整理重新生成覆盖已有待办删除 |
| D20 | 质量与观察门 | WAIVED_BY_OWNER | 独立人工质量和公开零旧调用周期明确记为 waived，不生成虚假指标 | 以后可由产品所有者另行恢复真实验收，不影响当前 Stage 5A 候选 |
| D21 | legacy 收敛 | RETAINED_COLD | Stage 5A 只保留冷回滚资产；单一活跃 owner、无双写、无静默 fallback | Stage 5B 获得产品所有者新授权后才物理删除 |
| D22 | 整理展示 | SELECTED | 单一自适应整理；本机板块显隐；图表证据准入；板块级去重依据 | 四模板 picker、任意 speaker 观点和逐条重复时间退出 active path；旧表冷保留 |

所有开发关键领域均已有选定路线；数据库隔离以 D01/A13 修订原单库决定，整理展示以 D09/D22/A15
修订原四模板决定。两项都重新打开对应实现门，但不留下需要实施者重新选择的架构分支。

## 2. 采用的跨领域决定

### A01 手机拥有业务数据

- 决定：日程、会议、媒体引用、转写、人工内容、生成结果和组织信息由手机的领域 SQLite/私有存储拥有。
- 原因：产品已放弃账号和跨设备同步；继续维护远端业务副本只会产生冲突和隐私成本。
- 删除收益：移除 `sync_outbox/sync_conflicts` 及 root/action/summary/occurrence/note/speaker/
  attachment/marker/tag 多套同步 owner。
- 证据：[能力矩阵](capability-matrix.md)、[架构异味](architecture-smells-20260816.md)。

### A02 采用关系型聚合，不采用全量事件溯源

- 决定：核心实体使用当前 SQLite 关系表、不可变 revision 和 active pointer；用户编辑用 overlay。
- 原因：能够闭合重生成、引用和恢复，同时避免为单用户 App 引入 event log/reducer/投影重建三套概念。
- 反证：若迁移必须复制第二份全量业务表才能运行，停止并重审，而不是长期双写。

### A03 最小任务 owner，不采用通用业务 DAG

- 决定：共享 owner 只处理 task/attempt/lease/cancel/replay/commit；领域输入输出仍由领域服务拥有。
- Task 拥有 immutable generation 和终态，Attempt 拥有一次租约执行；自动重试增加 Attempt，用户
  重试增加 Task。ContentOutcome 是成功结果，不是 ErrorEnvelope。
- 历史 `summary_tasks_v2` 使用 per-capability barrier 后的新写 generic + 旧 owner drain + 兼容读；
  缺 task-time 来源的旧行不迁移、不回填当前值，隐私删除覆盖两 store。
- 原因：此前统一 `EvidenceBundle -> DAG -> VerifiedResult -> Projection` 增加协议并容易重新串行化。
- 证据：[当前蓝图判断](CURRENT.md)、[device summary owner pass](evidence/candidate-0056-device-summary-v3-owner-independent-pass-20260817.md)。
- 删除收益：移除内存 Future、Celery 装饰、每领域任务状态机和第二 publication owner。

### A04 日程使用一个图合同和一个 validator

- 决定：本地高置信 producer 与服务端模型 producer 均输出 ScheduleMentionGraph；最终 validator
  只在手机执行，服务端不重复规则解析。
- 原因：保留简单输入即时性，同时闭合纠正、范围、跨轮补充和 query/delete target。
- 不采用：flat span encoder、字段级规则/模型拼接、服务端 quick parser、模型后全文重算。
- 证据：[revision 0006](revisions/0006-schedule-mention-graph-boundary-20260816.md)。

### A05 上传采用正式资产 generation + 原生 R2 executor

- 决定：`recording_assets` 是本机业务 owner；WorkManager 只执行；服务端 upload session 和 cleanup
  obligation 分别拥有远端传输与物理清理。
- 已确认导入全部先持久化；本机内部最多并行准备 3 条不同会议资产；stage/ingest/recover/acknowledge/discard/delete 按会议身份
  共用 keyed lock，第一条准备任务不禁用上传入口，同一会议仍保持串行幂等。
- 原因：平台原语已验证，且可删除 JS Base64、前台轮询和 Work UUID 业务身份。
- 不采用：U1 独立 owner、tus、整文件内存读取、shared object key。
- 证据：[revision 0014](revisions/0014-upload-u2-transfer-boundary-20260816.md)、
  [Android probe](evidence/candidate-0033-upload-u2-android-executor-0002-device-audit-20260816.md)、
  [bounded preparation revision](revisions/0032-bounded-concurrent-media-preparation-20260823.md)。

### A06 文字和讲话人分离发布

- 决定：VAD 后 ASR、CAM++ 分队列；Transcript text 与 speaker overlay 使用独立 revision。
- 原因：讲话人计算和声纹不应阻塞用户最先需要的文字，人工修正也不应被重转写覆盖。
- 不采用：EOF 前 speaker 终结整个 workflow、重分段删除历史、单个综合状态。
- 证据：[speech final rejection](evidence/candidate-0020-speech-owner-convergence-final-rejection-20260816.md)、
  [ASR live audit](evidence/live-asr-provider-audit-20260816.md)。

### A07 结构化语义层与自适应展示分离

- 决定：Knowledge V4 生成主题、事实、关系、数据、观点和行动候选；模板、图标和布局不参与模型
  生成。长会按章生成同一语义协议并确定性合并，本机 AdaptiveSummaryComposer 决定唯一可见结构。
- V3 定位：Facts V3 保持历史与过渡兼容，不再作为四个可见模板的 active projector。V3 文档先通过
  compatibility adapter 投影到同一自适应页面，不能强制用户重新生成才能修复重复展示。
- 原因：单次/分章结构化生成保留血缘和任意会议长度；显式 theme/metric/viewpoint 语义解决仅靠粗
  fact type 无法区分板块的问题；确定性准入避免图表和观点制造不存在的关系。
- 不采用：模板第二轮、递归摘要、逐行动模型复核、关键词硬否决、四模板拼接、任意 speaker 观点、
  模型布局和静默截断。
- 证据：[summary v3 implementation](../meeting-summary-v3-implementation.md)、
  [summary lineage](revisions/0003-summary-lineage-and-concept-boundary-20260816.md)、
  [adaptive summary revision](revisions/0033-unified-adaptive-meeting-summary-20260823.md)。

### A08 Q2 是唯一目标问答链

- 决定：一次 attributed reader，精确来源引用，owner 内原子提交；Q0 只保留一个发布周期整链回滚。
- 原因：当前生产链有样本固定答案和至少两轮模型调用，延迟与语义来源不可解释。
- 不采用：Q1 局部清理、多轮 verifier/editor/recovery、summary 作为事实、通用知识 scope model。
- 证据：[Q2 revision](revisions/0030-meeting-question-single-reader-target-20260817.md)、
  [contract pass](evidence/candidate-0058-meeting-question-single-reader-contract-independent-pass-20260817.md)、
  [live question audit](evidence/live-meeting-question-audit-20260816.md)。

### A09 JS repository 拥有持久业务状态，native 拥有系统能力与 surface 瞬时态

- 决定：React Native/TypeScript repository 生成持久业务 snapshot；Kotlin 独占录音、播放、媒体、
  WorkManager 运行态和 tab/滚动/焦点/输入/搜索/viewport 瞬时态，所有跨桥 action 回带 envelope。
- 原因：重写为全 Kotlin 风险过大，继续让两侧各自拼业务状态则会保留页面闪烁和迟到事件。
- 删除收益：移除 native SharedPreferences 业务真相、无 revision event 和中文文案驱动状态。

### A10 三进程服务拓扑保留

- 决定：`laoji-api + laoji-asr + Ollama`，Cloudflare Tunnel 只是入口，R2 只是对象存储。
- 原因：满足紧凑生产约束；新问题来自链路和 owner，不需要新常驻数据库/队列/图服务。
- 不采用：Redis、Celery、PostgreSQL、Neo4j、Chroma、DBOS、Restate、VibeVoice、Whisper。
- 证据：[live server](evidence/live-server-20260816.md)、
  [pipeline metrics](evidence/live-pipeline-portfolio-metrics-20260816.md)。

### A11 设备、binding 和来源是显式合同

- 决定：Keystore 设备签名 + 单次 challenge + 短 token；手机生成 opaque binding generation；epoch/
  binding 单用途 purge capability 允许本机离线清除后继续远端清理；Summary/Q2 来源只走 immutable
  source stream/chapter bundle。
- 原因：手机是业务权威时，服务器不能依赖长期静态 secret、隐式创建 Meeting 或重读远端 mirror。
- 删除收益：移除静态 device secret bearer、来源双路径、删除后 late commit 和服务器“当前正文”。

### A12 ActionItem 与生成候选分离

- 决定：Facts action candidate 不可变且只提供 provenance；采用后与手动/标记来源共同进入本机
  ActionItem 聚合。编辑、完成、删除、提醒和后续日程不受重新整理覆盖。
- 原因：当前产品已有完整本场待办能力，不能用生成结果版本代替 mutable 用户对象。
- 边界：账号协作分享不进入 accountless vNext；历史只读后删除，本地导出可包含待办。

### A13 日程与会议使用独立数据库文件

- 决定：`laoji-schedule.db` 独占日程事件、重复规则持久载荷和日历投影检查点；
  `laoji-meeting-memory.db` 独占会议聚合、媒体引用、生成结果、问答和远端 operation 投影。
- 原因：日程与会议的数据体积、迁移频率、清理策略、损坏恢复和导出需求不同。repository 分层不能阻止
  文件级删除、错误重建或迁移失败扩大到另一个领域，必须同时建立物理存储边界。
- 迁移：新日程库先事务复制并逐行核对旧 `local_schedule_events`，提交完成标记后才退役会议库旧表；
  任一阶段中断均从完成标记恢复，不双写。旧安装的 AsyncStorage 日程兼容导入仍只写新日程库。
- 关联：会议只保存创建时的日程稳定 ID 和不可变快照；两库不建立外键，也不使用 `ATTACH` 制造跨库事务。
  “由行动创建后续日程”等跨领域操作使用幂等 application use case，失败可重试，不能回滚已提交会议事实。
- 清理：会议永久删除、会议数据库重建、媒体残留清理均不得打开或删除日程库。只有用户明确执行
  “清除全部本机数据”时，协调器才分别点名两库；`pm clear` 只属于卸载级操作，禁止作为领域修复手段。
- 反证澄清：Android `pm clear` 会清空整个应用沙箱，拆库不能抵御该命令；拆库解决的是应用内部的
  生命周期隔离和故障爆炸半径，完整安装级备份仍是另一项能力。
- 证据：[database isolation revision](revisions/0031-schedule-meeting-database-isolation-20260823.md)。

### A14 单一产品所有者豁免与两段式 Stage 5

- 决定：因无外部用户且不存在第二名独立人员，产品所有者明确跳过人工质量和正常使用/公开零旧调用
  周期。工具只把对应门标为 `waived`，不能改成 `passed` 或填入模拟指标。
- Stage 5A：允许在隔离候选数据库持久 capability barrier，完成单一 owner、迁移恢复、资源隐私和
  候选交付；legacy reader/writer 源码、表及运行资产保留为冷回滚材料，不登记 reader removal marker。
- Stage 5B：物理删除不在本次授权内；必须收到新的产品所有者授权，并重新核对任务/租约/引用/open
  file 和数据库生命周期。
- 不变边界：不双写、不静默 fallback、不自动发布生产、不切公网。风险豁免合同见
  `docs/vnext-global/product-owner-risk-waiver-20260821.json`。

### A15 一份自适应整理替代四个会议类型模板

- 状态：Android `1.1.63` 已采用 V3 compatibility presentation；Knowledge V4 与完整富内容仍在
  shadow/pending，不得表述为生产已采用。

- 决定：新整理不再要求用户先判断会议是通用、1:1、项目同步或访谈。系统显示一份共享内容，只有
  通过语义和来源准入的时间线、流程、对比、数据、风险、问题或观点板块才出现。
- 交互：原模板入口改为本机“板块”sheet，用户可隐藏/恢复已存在的可选板块；该操作不联网、不改变
  source fingerprint、不创建整理版本。
- 引用：普通条目不再追加讲话人和时间；每板块只显示一个去重的“依据 N 处”，显式 quote 才保留一次
  讲话人/时间。
- 图表：模型只输出语义数据，Android 根据白名单和证据条件渲染。没有共享单位、比较维度、显式时间
  或关系时退化为列表；第一版禁用饼图和推断式风险矩阵。
- 迁移：V3、旧模板偏好和覆盖层保留只读冷兼容；active UI 先用 V3 adapter 修复现有记录，再采用 V4。
  本决定不授权物理删除旧 reader/table。
- 证据：[真实问题、目标 schema、组装、迁移和验收合同](revisions/0033-unified-adaptive-meeting-summary-20260823.md)。

## 3. 明确冻结的否决项

| 方案 | 状态 | 冻结原因 |
| --- | --- | --- |
| 全量 Local Memory event sourcing | REJECTED | 概念和迁移成本高于当前关系型聚合，无证据证明收益 |
| 所有能力共用 Durable Processing Graph | REJECTED | 容易形成第二业务 owner 和统一串行门 |
| DBOS/Restate 作为老记任务核心 | REJECTED | 新常驻依赖、升级/双存储恢复和资源成本不适合单机紧凑部署 |
| 日程 flat span encoder | REJECTED | 无法原生表达 correction/range/cross-turn，executor 会重造 parser |
| 上传 U1 第三版 | REJECTED | 会继续包装第二 owner，未闭合 WorkManager/R2/delete fence |
| VibeVoice/Whisper/8002 ASR | REJECTED | 与 8030 重叠并增加模型、环境和服务资源 |
| speaker 阻塞 text final | REJECTED | 增加首文字延迟并放大失败域 |
| Summary v2 两轮/递归模型摘要 | REJECTED | 事实血缘漂移、调用次数和长会错误不可控 |
| 四模板换标题或首尾拼接 | REJECTED | 同一事实重复出现，会议类型先验没有得到内容证据支持 |
| 任意 speaker 自动成为观点 | REJECTED | 普通 Transcript 天然有 speaker，不能证明观点或访谈角色 |
| 无证据装饰性图表 | REJECTED | 会把排版偏好伪装为数字、关系、时间或风险事实 |
| QA 样本答案与多轮修复 | REJECTED | 污染真实质量、增加延迟且引用不可解释 |
| summary 作为 QA 事实来源 | REJECTED | 生成文本不能替代原始证据 |
| 自动主题/持久人物分类 | REJECTED | 将单次整理或 speaker 推断提升为长期分类 owner；speaker 派生人物视图仍保留 |
| 静默 provider fallback | REJECTED | 可能外传私人内容且无法解释模型 revision |

## 4. 风险登记与已选处理

| 风险 | 级别 | 已选处理；不需要实施者重新选架构 |
| --- | --- | --- |
| 生产后端源码不在当前工作区 | HIGH | Stage 0 从运行 cwd 冻结并导入 `services/laoji-api`，记录 hash；未导入不得改服务 |
| 发布 APK 与 Git HEAD schema 漂移 | HIGH | 1.1.10 APK 已观察到 v39，而 HEAD 仅到 v38；Stage 0 冻结 dirty source/APK 对应关系并形成可回溯提交 |
| 现有 39 次迁移和同步表复杂 | HIGH | 原库备份后原位 canonical migration；不建立长期第二数据库；同步表只读 drain 后删除 |
| legacy summary task 无历史来源血缘 | HIGH | generic 新写 + legacy drain + 兼容读 + 双 store purge；禁止 all-row migration 和当前值回填 |
| 匿名 bootstrap 资源滥用与来源 mirror | HIGH | 注册 PoW + IP/全局配额 + device 隔离/业务配额；opaque binding 和唯一 source-stream 路径 |
| 长会议超 context | HIGH | 时间/主题分章 facts，一章一次调用，代码以固定两槽、每槽 4 MiB 的滚动 checkpoint 合并；不截断、不恢复递归摘要、不逐章累积行 |
| GPU0 与其他进程争用 | HIGH | 老记常驻 `<=16 GiB`、embedding CPU/按需、整卡 1 GiB 安全门和队列 backpressure；GPU1/外部服务不动 |
| R2 presign 取消后仍可晚写 | HIGH | 独立 cleanup obligation 等到最后 expiry 后 abort/delete/HEAD |
| 旧客户端与 v2 API 共存 | HIGH (OWNER ACCEPTED) | Stage 5A 跳过零调用周期；候选只允许 vNext 单路写入，legacy 只作冷回滚资产；禁止 adapter 伪造新合同、双写或请求内 fallback |
| 未执行独立人工质量验收 | HIGH (OWNER ACCEPTED) | 对应门只标记 waived；保留自动结构、引用、恢复、性能与隐私证据，不能声称人工质量达标 |
| Transcript 重分段导致人工修正悬空 | HIGH | stable source ID + overlay expected revision + deterministic rebase/待确认，不删除修正 |
| 长会 Q&A 无法证明“未提及” | MEDIUM | 超完整上下文时明确返回无法确认；不从 top-k absence 推断 |
| 语义文档变复杂导致 9B 输出不稳定 | HIGH | 有界 compact slots；正常每 pack 一次调用；整体 Schema 才允许一次修复；无效可选块丢弃而不二次润色 |
| 图表或观点错误准入 | HIGH | primary fact owner + typed eligibility + exact source validation；不满足时退化列表；真实跨类型样本设负向门 |
| 旧模板人工覆盖迁移丢失 | MEDIUM | 当前模板覆盖保留为旧版自定义历史；其他覆盖仍只读可查；不把模板列原地改成新布局语义 |
| 云端 provider 可用但隐私不同 | HIGH | 只允许部署级显式选择；本地失败不自动外传 |
| 无外部用户但当前设备有数据 | MEDIUM | Stage 0 备份和回放真实本机 schema；不以“无用户”跳过当前设备数据迁移 |

## 5. 证据强度说明

- `observed`：当前源码、公开包或只读生产现场事实。
- `validated component`：隔离合同和独立审阅通过，只证明该组件边界。
- `selected architecture`：本文已作出全局实现决定；性能/质量仍由阶段门验证。
- `adopted production`：只有完成实施、迁移和发布验收后才可使用；本文没有此声明。

性能目标、人工质量比例和迁移成功率均是验收门，不是已完成事实。开发不得因某一门尚未实测而
恢复多路线长期竞争；如果选定路线未达到门，先在同一边界内优化一次，仍失败才形成全局修订。

## 6. 全局终审与冻结

冻结前的固定哈希独立终审只接受会阻止全局实施的问题，不审命名、低风险 DTO 或已通过的局部候选。
首轮发现的公开分享撤销绕过和长流 checkpoint 无界增长已分别改为撤销感知的 API 分块流式读取、
固定两槽滚动聚合；限定复审结论如下：

| 门 | 结论 | 冻结依据 |
| --- | --- | --- |
| 跨领域一致性 | PASS | authority、binding、Task/Attempt、source、artifact、share 与 purge 使用同一 revision/fence |
| 概念数量与最小性 | PASS | 共享层只保留技术合同，领域 owner 独立，不引入通用业务 DAG 或第二业务真相 |
| 等待链与单调性 | PASS | awaiting source、retry、cancel、cleanup、purge 均有终态、过期和继续推进路径 |
| 迁移与回滚 | PASS | `0040-0045` 顺序闭合；barrier 后只切 handler revision，不恢复 legacy writer/双写 |
| 固定资源与容量 | PASS | 三进程及 GPU/RSS/CPU/temp/R2/source/share/cleanup/queue 均有硬上限；长流不逐章累积行 |

结论：19 个领域均为 `SELECTED/STAGED/RETAINED`，五门全部通过，无需实施者重新选择关键架构。
本基线冻结为 `global development baseline`，实施从 Stage 0 开始。冻结不代表性能目标已验证，也不代表
生产已经采用。
