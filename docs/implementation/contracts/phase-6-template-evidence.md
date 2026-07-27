# Phase 6 内置会议模板证据：TPL-01

状态：四个内置模板的移动端注册、请求身份、任务恢复、结果校验、不可变版本保护和模板选择 sheet 已形成纵向闭环；服务端 additive 适配已由目标 18020 加载。四模板均取得真实模型成功结果，非默认模板又修复了短会议误走 9B/2048-token 完整管线导致的 600 秒超时；定向访谈夹具证明四个访谈 section 和 canonical citation 均可生成。自动 ASR、物理设备和更广质量样本仍是独立边界。

## 当前移动端范围

- `templates.ts` 是唯一模板注册表。`general`、`one_on_one`、`project_sync`、`interview` 当前均为 revision 1，分别声明固定 section schema 与 `standard/follow_up_focused` 行动项抽取策略；默认模板为 `general@1`。
- 登录态 query 与游客 JSON 请求都发送 `template_id + template_revision`。模板只影响整理 schema 和 prompt，不改变录音、上传、转写、权限或媒体处理流程。
- pending summary task 持久化模板 ID/revision；无历史授权时使用 v2 input fingerprint，有授权时使用包含 request ID 与完整历史项目 identity 的 v3 fingerprint。两者首项均包含 `id@revision`，因此同一 Transcript 使用不同模板或不同历史授权不会错误复用旧任务。旧记录缺模板或模板失效时安全回落到 `general@1`。
- 恢复任务前同时比较 mode、模板和 input fingerprint；任一失配都清除旧 pending 并提交新任务。任务不存在时可以稳定重提，仍复用本次明确选择的模板。
- 成功结果必须含同一模板 ID/revision 的结构化文档，否则以中文合同错误拒绝保存。登录态轮询成功后优先解析该 task 自身 result，只有没有可用 task result 时才读取 durable detail，避免连续切换模板时误拿另一模板版本。
- 更换模板继续走现有 immutable Summary version 流程。人工编辑、已关联行动项或其他受保护版本不会被新模板结果原地覆盖；第一阶段没有自由 prompt 编辑器。
- Android 原生详情页与通用详情页共用 `MeetingTemplateSheet`。无整理结果时从“生成整理结果”进入，有结果时从“重新生成”进入；选择模板后 sheet 完整退出，再查询本场系列记忆并按候选情况直接生成或进入独立引用授权。

## 部署补丁与目标源码

本机补丁路径：`/home/yydd/桌面/light_plan/server-work/summary`。共享服务器目标工作区为 `/home/zhong/laoji-service-platform/smart-meeting-ai`；模板适配首次同步前备份在 `backups/20260724-meeting-contract-template-v2`，后续 carry-forward 增量前态保存在 `backups/20260724-summary-carry-forward-v1`。当前 18020 从该目标工作区运行，8020 仍来自另一旧工作区，未被当作模板运行证据。

- API 与 worker 共用四模板严格白名单；未知 ID 或 revision 返回中文 422，不把未知 prompt 透传给模型。
- 模板 prompt suffix 明确固定 key/title/kind、空值和禁止编造规则；CLI 新增 `--summary-prompt-suffix-file`，worker 使用临时文件传递并在子进程结束后清理。
- parser 对普通 section 优先读取模型的 `template_sections`；决定、承诺和行动项只使用既有事实清洗后的结果，模型不能通过模板字段绕过否定语义、未承诺事项、去重和来源一致性保护。缺字段时按确定性 fallback 和模板顺序产生 schema v2 sections。
- section ID、template ID/revision 和行动项稳定 ID 都包含模板身份。同一会议、相同行动文字在不同模板下不会错误折叠为同一生成候选。
- 当前真实 `FinalSummary` 表只有旧六列。本切片没有假定不存在的模板列，而是把 v2 envelope 合并进输出 JSON 的 `_laoji_structured_summary`，并用模板 sections 生成兼容 Markdown。
- 新输出文件使用带时间部分的 `final3_*` 前缀，匹配现有模型产物查找顺序，避免同日连续生成读到旧文件。
- App Summary 响应返回稳定 action candidate 和校验后的 schema v2；`full_text` 只使用兼容 Markdown/结构化 section/overview，不再因缺 Markdown 把 raw 模型 JSON 当正文，也不再向移动端返回 `raw_json`。
- 合并以服务器当前 worker 为基线，保留同会议串行、不同会议有界并发、task scope/meeting 归属、长轮询、短期幂等复用、失败不复用、墓碑阻止写入和原有总结质量清洗。无历史/无附件的四模板现在都走 4B、动态 JSON schema、受限 token 的精简路径；非默认模板使用独立无矛盾提示，并为模板专属 section 返回同段 `source_segment_id + source_quote`，继续经过 canonical 校验。带历史授权或附件的请求仍走支持完整上下文的管线，不因性能修复丢失授权内容。

## 当前真实模型证据

- 目标 18020 以 PID `702467` 从目标 backend 运行，并继承原 34 项环境；18035 保持 PID `3293181`，本轮未触碰。Transcript/Summary 恢复补丁前态保存在 `backups/20260728-transcript-summary-recovery-v1`；非默认模板性能与引用增量的连续前态保存在 `backups/20260728-template-compact-v3`、`backups/20260728-template-citations-v4` 和 `backups/20260728-template-prompt-v5`。
- 登录态 `general@1` task `06b9ae52-581a-4847-8604-5f9b3be431e7` 约 92.3 秒成功，durable version 为 `10f1af3f-ef92-4a23-ae08-8164eede3dde`。结果包含 3 个 section、3 条决定、7 条待办和 9 个有效引用，未把 raw JSON 展示为正文。
- 三个抽查引用在 Android 详情页分别定位到 `0 ms`、`20,712 ms` 和 `50,904 ms`；冷启动后同一版本保持当前，重复 durable 响应为幂等 `unchanged`，没有覆盖用户版本选择或重复推进 canonical revision。
- 初次真实 `one_on_one@1` task `dd2f3d12-ebe5-4d7b-98c5-33542a23a34b` 走 9B 完整管线并在 600 秒 Ollama ReadTimeout 后失败，证明旧实现的非默认模板并非只是“缺验证”。接入模板精简路径并清除旧 9B orphan runner 后，`one_on_one@1` task `ba284d56-a144-4cd3-8d2a-521793dbbce2` 在 113.6 秒成功，version `17277b84-a86e-4814-865c-26eb59eee02f`，生成 3 个非空 section、7 条行动和 16 个引用对象。
- `project_sync@1` task `39cd4497-e9dd-4f36-ac14-42f6d411ca9c` 在 136.2 秒成功，version `78a7912a-ebf6-4d7a-94bb-a08402993c47`，生成进展/决定/行动项、9 条行动和 16 个引用对象；无可靠风险时没有编造风险 section。
- `interview@1` task `3328c8b5-b8b3-4194-b428-1bc1b4d21067` 在 135.4 秒成功，version `ebc24d95-6005-423c-8b8c-fefdfe935fc6`；模拟器冷启动从 durable endpoint 激活该版本，真实 UI 显示“主题/受访者观点”和待办，未见致命日志。该账号样本本质是项目协调内容，因此访谈专属来源为空，不能据此判断访谈 prompt 质量。
- 为排除样本不匹配，游客真实模型 task `0a62ea84-809f-40fd-b6bb-267b1c3dc012` 使用四段定向合成访谈，在 157.6 秒生成 `topics/interviewee_views/evidence_quotes/follow_up_questions` 全部四个 section；四类分别有 `2/1/1/1` 个通过 canonical segment/逐字 quote 校验的引用，且没有凭空生成行动项。
- 账号十段 Transcript 和游客四段访谈都来自测试夹具，不是 VibeVoice 自动转写；它们证明四模板运行、模板区分、结构化来源和移动端消费，不证明 ASR 或真人会议长期质量。

## UI 证据分类

组件：整理模板底部 sheet

- Classification：LaoJi-only capability；最近容器为飞书风格底部 sheet，不声称飞书 7.71.8 存在同一四模板页面。
- `[SOURCE]`：沿用现有 Feishu token owner 的浮层、遮罩、divider、primary、pressed、标题与图标语义；12dp 顶角、44dp 图标触控目标和约 300ms 全高度进出遵循当前 sheet 规范。
- `[PRODUCT]`：只显示“整理模板”和四个内置选项，不出现其他产品专有术语，不增加 prompt 编辑器或解释性说明；服务错误使用中文。
- `[DEVICE]`：`emulator-5556` 的 1080x2400 Preview 上四行均完整显示；默认“通用”有勾选，遮罩点击关闭；选择“项目同步”后 sheet 关闭，服务失败时显示中文页内错误和中文“生成失败”对话框，再次打开时“项目同步”保持选中。
- `[INFERENCE]`：72dp 双行 option row、右侧勾选和能力缩减后的单页选择流程是老记对最近 Feishu sheet/container family 的组合，不是直接来源页面复刻。

## 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- 移动端相关 `git diff --check`：通过。
- 本机补丁与共享服务器目标文件 SHA-256 逐项一致；目标 Python 3.11 环境 `py_compile` 通过。
- 目标部署源码生成 OpenAPI 已确认创建字段含 `title/client_request_id/location/recorded_at`，空标题没有 `minLength`，PATCH 标题同样允许空字符串。
- 目标 `local.db` 只读 schema 检查确认 `client_request_id/location/recorded_at` 三列和 `(user_id, client_request_id)` 唯一索引存在；未读取标题、正文、账号或音频路径。
- 部署后 API、任务生命周期、总结质量清洗、模板、空标题、幂等、显式清空和稳定 action ID 共 81 项通过；meetingsummary chunker/Ollama/阈值共 34 项通过，CLI template prompt 参数另行断言通过。
- carry-forward 增量在再次从目标源码复制的隔离候选中执行 56 项相关合同并通过，覆盖账号来源归属、授权指纹/结构化结果往返、compact 路径隔离和短会议 durable identity 保留；目标文件与本机补丁最终 SHA-256 一致。
- 首个模板 UI Preview 于 `2026-07-24 17:12:11 +0800` 构建，大小 `90,121,368` bytes，SHA-256 `06b4225234b6b72de1a98355d3b0f95424563c43d6805c541c652ef399fa7c91`；`emulator-5556` 覆盖安装时间为 `2026-07-24 17:12:23`，冷启动无应用崩溃。
- `:app:assemblePreview --parallel --max-workers=$(nproc)`：通过；627 个 task，59 executed，耗时 34 秒。
- Preview 已覆盖安装到唯一设备 `emulator-5556`，安装变体确认为 `versionName=1.0.0-source-preview`、`versionCode=101`，包 flags 不含 `DEBUGGABLE`。
- 先验证默认选中和四项布局，再点击遮罩，UI tree 确认 sheet 完整移除。重新打开选择“项目同步”，sheet 正常关闭；当前服务不可达时页内显示“暂时无法连接老记服务，请检查网络后重试。”，对话框显示“生成失败 / 知道了”。
- 关闭错误对话框后再次打开，UI tree 为 `项目同步 selected=true`、`通用 selected=false`。进程保持存活，清空后的 logcat 没有应用 FATAL、React Native exception、SIGSEGV 或 SIGABRT。
- 验证使用的临时 ended meeting 和一条测试转写均已恢复：最终会议列表重新显示 `OccueneSmoke，7月22日 21:04，失败`，临时 Transcript cache 已删除，最终仍安装 Preview；本轮 `/tmp` 备份、截图和设备 XML 已清理。
- 当前可安装 Preview 于 `2026-07-28 01:50:37 +0800` 构建，大小 `91,061,768` bytes，SHA-256 `618d405d47345db9c19e8decbab22da0b22d3b47a117dfedc12d419812574458`；已保留数据覆盖安装到 `LaoJi_Candidate_V34 / emulator-5554`，设备 `base.apk` 与构建产物逐字节一致。
- 非默认模板增量通过目标 Python `py_compile`、2 项模板动态 schema/来源保留合同和 compact gate 定向检查。Android 冷启动激活访谈 durable 结果时日志为 `meeting_summary_shadow_write status=activated`，无 App FATAL、React Native 致命异常、SQLiteException、SIGSEGV 或 SIGABRT。

## 未完成边界

1. 当前没有 USB 真机；不同物理设备密度、字体缩放、深色模式、手势导航 inset 和真实触觉尚未验证。
2. 四模板均有真实模型成功结果，访谈另有匹配语料的四 section/引用证据；仍不是长 Transcript、真人多人会议、模板污染率或大样本 prompt 遵循率。
3. 测试账号已完成通用与访谈的移动端恢复，并由 task/durable identity 核对 1:1 与项目同步；快速连续切换、跨设备版本选择和每个中间版本都在移动端下载仍未验证。
4. 历史参考和附件请求按设计不走模板精简路径；其真实利用质量与未选内容隔离仍需带授权样本，不能由本轮空授权任务代替。
5. 本轮遵循轻量工作区约束，没有恢复归档测试、门禁或大样本矩阵；只执行类型检查、服务端纯函数 smoke、Preview 构建、定向模拟器交互和崩溃日志检查。
