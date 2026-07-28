# QA-01 单场有来源问答实现证据

## 实现边界

- `[PRODUCT]` 问答仅属于当前会议详情的次级能力，从“更多”进入，不增加底栏入口。
- `[PRODUCT]` 会议相关或有歧义的问题默认使用 active 文字记录和当前可读整理结果；“我的笔记”只有用户在该线程显式勾选后才进入请求。明显无关的问题走普通问答，不向模型注入会议来源。
- `[INFERENCE]` 老记没有可直接照搬的飞书问答页，因此使用会议次级页容器，复用 52dp 标题栏、UD 6dp 输入/按钮、语义色、固定反馈槽和 300ms 页面进退场。
- `[SOURCE]` 中性色阶、文字层级、按压色、主按钮状态和 22dp checkbox 来自现有 `feishu-ui-style` token/component 合同。

## 移动端数据合同

Migration v22 新增三张 canonical 表：

- `meeting_question_threads`：锁定 `meeting_id + scope_key`、完整输入 SHA-256、Transcript revision、可选 Summary version、可选 manual-note revision 和笔记授权位。
- `meeting_question_turns`：保存稳定 request identity、ordinal、问题、最终回答、回答类型和完成时间；不保存模型隐藏推理。
- `meeting_question_citations`：保存 Transcript segment、Summary section 或显式授权 note revision 的规范化来源快照。

迁移 v35 为 turn 增加 `answer_scope=meeting/general`。会议回答必须至少有一个引用；固定拒答 `当前会议记录中没有足够信息` 必须是 `meeting + insufficient + zero citations`；普通回答必须是 `general + answer + zero citations`。写入事务重新验证会议引用仍属于线程锁定版本，不能用服务端回显绕过本机事实源。

`prepareMeetingQuestionSession` 只接受 `ready` 的 final/reprocessed Transcript，且所有 segment 必须 final。证据指纹覆盖每段身份、来源身份、时间、讲话人和正文，以及 Summary section 与授权笔记全文。发送前重新读取 SQLite；指纹或任一 revision 变化会抛出 `MeetingQuestionEvidenceChangedError` 并创建新线程。

请求 ID 由 thread、ordinal 和 question SHA-256 决定。网络成功但本机落库前中断时，同一个问题重试仍使用相同身份；服务端可以幂等回放，不能生成第二轮回答。

## 远端合同

能力名为 `meeting_questions_v1`，发送前必须 fresh capability；legacy/cache 不能开放写入。

- 游客：`POST /api/laoji/meetings/guest-questions`，服务端响应 `transient=true`，移动端 canonical 保存完整线程。
- 账号：`POST /api/laoji/meetings/{meeting_id}/questions`，验证会议 owner 与 MeetingNote client identity，持久化 thread/turn/citation 和 request hash。

两条路径都重算与移动端相同的排序 JSON SHA-256。范围路由先处理高置信问候、身份、通用定义、显式会议词和连续追问；其余问题仅把当前问题与最近 scope/question 交给同一 9B 模型分类，不读取 Transcript、Summary 或笔记。只有判为 `meeting` 后才选择会议来源；`general` 通道的模型输入只有问题和连续普通问答上下文。服务端只接受请求集合内的 source ID，去除未知和重复引用；客户端严格校验回显 scope 与全部身份，并从本机证据生成可展示 label/excerpt，忽略服务端自报的显示文本。

## UI 行为

- 标题为“会议问答”，保留会议标题和“新对话”次级操作。
- 问题使用右侧 quiet-primary surface，回答使用白色 surface；来源卡显示可读名称和两行摘录。
- 点击 Transcript 来源关闭问答页，切换“文字记录”，按 segment/time 定位并在有录音时 seek。
- Summary/note 来源分别切到对应详情页。
- 输入和错误反馈有固定槽；加载、发送、禁用和错误状态不移动主输入。
- 所有可见错误和状态为中文，不出现供应商原始错误或飞书专有术语。

## 已执行的轻量证据

- TypeScript：`npx tsc --noEmit --pretty false`。
- SQLite：v22 DDL 在内存库执行；重复 ordinal 被拒绝，删除 MeetingNote 级联清理线程。
- 跨语言：同一证据的 JavaScript/Python stable JSON 得到相同 SHA-256。
- 模型窄合同：有效 source ID 保留；伪造 source ID 降级为固定拒答。
- Python：overlay 六个新增/修改模块通过 `python3 -m py_compile`。
- Preview：`assemblePreview` 成功，627 tasks；覆盖安装后冷启动无 fatal/React Native/SQLite 异常，数据库升级到 user_version 22 且三张表存在。
- 模拟器夹具：更多菜单出现“会议问答”；已保存问答与来源摘录可见；点击来源关闭页面并定位到对应 Transcript segment；夹具后恢复原 canonical DB/WAL/SHM 与 RKStorage，再覆盖安装 Preview。

## 运行证据与剩余边界

- QA overlay 已随 38 个受控文件同步到目标工作区，目标 `local.db` 的 thread/turn/citation 三表存在且 `meeting_questions_v1=true`。18020/18035 从目标工作区运行，旧 8020 未参与本次证据。
- 使用测试账号和两条明确的合成 Transcript evidence 走真实 `qwen3.5:9b`：预算问题在 32.22 秒返回“五十万元 / 王芳”并只引用唯一允许片段；同 request ID 幂等回放到同一 turn；无来源的上海办公室问题在 18.73 秒返回固定拒答且零引用；更换同一 request ID 的问题返回 409。
- 首次 follow-up 发现服务端会保存模型的中文标点，却要求下一轮历史回答已被 NFKC 改成半角标点。当前问题、回答和来源正文改用 NFC，只统一换行，不再把中文逗号替换成英文逗号；身份和 wire ID 的独立校验保持不变。
- 当前 18020 使用 GPU 上的统一 9B 服务，并将精确词项/标识符召回与 Qwen3 嵌入语义召回通过 RRF 融合。Transcript 使用有界三段语义块，展示引用仍定位原始段；向量和查询有界缓存，嵌入失败时短路降级为词项检索，不使问答整体不可用。
- 当前评测矩阵有 350 条，覆盖 6 份独立会议夹具；110 条显式检查来源召回，35 条要求多个事实各有来源。部署后分组证据为检索 `110/110`、新增模型用例 `45/45`、受影响路由/概述类 `50/50`、Python 3.11 混合检索 `21/21`、旧问答合同 `10/10` 及最终线上 HTTP `7/7`。最后一次完整 350 条为 `347/350`；三个失败修复后在各自完整受影响类别中通过，不声称未执行的 `350/350`。
- v34 保留数据模拟器已覆盖升级到 migration v35：账号会议、整理结果、19 个行动项和播放状态保留，冷启动无 SQLite/React Native/native fatal。发送后问题立即出现、输入框立即清空；失败时原问题回填。这次真实路径发现并修复了第二设备的本机会议 ID 被错误要求等于创建设备 `client_note_id` 的 409；修复后同一模拟器、会议和问题在 4 秒内成功回答并持久化。线上回滚备份为 `/home/zhong/laoji-service-platform/backups/20260728-question-cross-device-local-id-v1`。
- 当前 Preview `03cc64d4…f752d89`（v104）与 `emulator-5556` 内安装包哈希一致。在 `V3_CANDIDATE_SPOKEN` 提问“这场会议的发布范围是什么？”，返回“只包含登录和日历模块，会议模块延期到下周”及 Transcript/Summary 引用；关闭重开和强杀冷启动后问题、回答、引用仍可见。证据内容改变时按既定指纹合同创建新线程，旧线程不会被删除或续接，但当前 UI 没有旧线程历史入口，因此不能把“SQLite 保留”扩写成“内容版本切换后仍可回看”。
- 真机此前已覆盖安装包含 v35 客户端的 Preview 并确认冷启动无 fatal；本次候选哈希复核时 USB 已断开。旧线程中已经保存的错误回答不会被静默改写；新问题和新线程使用新范围路由。仍需在真实长会议中继续观察语义召回和多轮指代的开放世界表现，评测矩阵不能证明任意问题都正确。

## 2026-07-27 真机回归增量

- USB 真机 `825f509d` 上的长会议问答复现了两个独立问题：首次请求在客户端 90 秒边界超时；模型预热后同一会议已有明确“会议概述”，但“这是一次什么会议”仍被错误降级为信息不足。
- 同一运行服务的三段合成短会议首请求用时 90.415 秒，热请求用时 26.595 秒，证明旧 90 秒客户端边界会丢弃本可成功的冷启动结果。
- 移动端问答超时已调整为 180 秒，原有页内固定加载/错误槽和取消信号保持不变。本地服务候选把模型来源上限从 60,000 字符收紧为 8,000，先保留最相关的 Summary 段再加 Transcript，且单个过大来源不再阻断后续来源；模型输出上限收紧为 512 tokens。
- 长 Transcript 纯合同确认首个模型来源为 `summary-overview`、仍含 Transcript，且总来源字符未超过 8,000；TypeScript、Python 编译和 Preview 构建通过。完整 Python 用例在本机因缺少 SQLAlchemy 未收集，未将该环境问题冒充为业务失败。
- 最新 Preview APK 已覆盖安装真机；范围路由、部分回答复核和引用约束已同步到运行中的目标 18020，18035 未重启。
