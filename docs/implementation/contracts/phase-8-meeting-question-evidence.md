# QA-01 单场有来源问答实现证据

## 实现边界

- `[PRODUCT]` 问答仅属于当前会议详情的次级能力，从“更多”进入，不增加底栏入口。
- `[PRODUCT]` 默认范围是 active 文字记录和当前可读整理结果；“我的笔记”只有用户在该线程显式勾选后才进入请求。
- `[INFERENCE]` 老记没有可直接照搬的飞书问答页，因此使用会议次级页容器，复用 52dp 标题栏、UD 6dp 输入/按钮、语义色、固定反馈槽和 300ms 页面进退场。
- `[SOURCE]` 中性色阶、文字层级、按压色、主按钮状态和 22dp checkbox 来自现有 `feishu-ui-style` token/component 合同。

## 移动端数据合同

Migration v22 新增三张 canonical 表：

- `meeting_question_threads`：锁定 `meeting_id + scope_key`、完整输入 SHA-256、Transcript revision、可选 Summary version、可选 manual-note revision 和笔记授权位。
- `meeting_question_turns`：保存稳定 request identity、ordinal、问题、最终回答、回答类型和完成时间；不保存模型隐藏推理。
- `meeting_question_citations`：保存 Transcript segment、Summary section 或显式授权 note revision 的规范化来源快照。

普通回答必须至少有一个引用；固定拒答 `当前会议记录中没有足够信息` 必须是 `insufficient + zero citations`。写入事务重新验证引用仍属于线程锁定版本，不能用服务端回显绕过本机事实源。

`prepareMeetingQuestionSession` 只接受 `ready` 的 final/reprocessed Transcript，且所有 segment 必须 final。证据指纹覆盖每段身份、来源身份、时间、讲话人和正文，以及 Summary section 与授权笔记全文。发送前重新读取 SQLite；指纹或任一 revision 变化会抛出 `MeetingQuestionEvidenceChangedError` 并创建新线程。

请求 ID 由 thread、ordinal 和 question SHA-256 决定。网络成功但本机落库前中断时，同一个问题重试仍使用相同身份；服务端可以幂等回放，不能生成第二轮回答。

## 远端合同

能力名为 `meeting_questions_v1`，发送前必须 fresh capability；legacy/cache 不能开放写入。

- 游客：`POST /api/laoji/meetings/guest-questions`，服务端响应 `transient=true`，移动端 canonical 保存完整线程。
- 账号：`POST /api/laoji/meetings/{meeting_id}/questions`，验证会议 owner 与 MeetingNote client identity，持久化 thread/turn/citation 和 request hash。

两条路径都重算与移动端相同的排序 JSON SHA-256。模型输入只包含当前请求来源和最近单场上下文；输出只能是 JSON answer/refusal。服务端只接受请求集合内的 source ID，去除未知和重复引用；普通回答没有剩余引用时转成固定拒答。客户端随后严格校验全部回显身份，并从本机证据生成可展示 label/excerpt，忽略服务端自报的显示文本。

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
- 首次 follow-up 发现服务端会保存模型的全角逗号，却要求下一轮历史回答已为 NFKC，导致服务端拒绝自身上一轮输出。修复后模型回答在持久化前规范化，历史上下文兼容已有未规范化回答；隔离候选聚焦文件 8 项合同通过，热修复后真实两轮问答成功。
- 本轮模型运行在 CPU，因为共享服务器 NVIDIA 595.84 用户态库与 595.71.05 内核驱动不一致；这解释当前延迟，不把它误判为 QA 逻辑超时。未获授权前不重启共享服务器。
- 当前证据支持真实模型、账号持久化、引用约束、拒答和 follow-up。仍缺一场真实 final Transcript 从移动端问答页面进入、来源点击回跳、第二台移动设备和 USB 真机；evidence retrieval 的有界词项召回也仍需在真实长会议上观察质量。
