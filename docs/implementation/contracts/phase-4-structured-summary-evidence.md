# Phase 4 整理结果与行动：首个纵向切片

状态：结构化整理结果、独立 Summary task、服务端引用生成与规范化、不可变本机版本、本机行动项、提醒/日程、action outbox、冲突选择，以及服务端 action upsert/pull 已形成纵切。目标 18020 已取得非平凡 `general@1` 结果、四模板真实模型运行、canonical 引用、durable result 和移动端消费证据；两个隔离 Android App 实例又完成提醒意图同步、设备通知重建、跨端完成后的双端取消，以及非协作行动项的离线分歧、版本选择和双端回拉收敛。这仍不代表自动 ASR、线上版本列表或全账号跨设备同步已完成。

## 独立 Summary 运行增量

- RecordingAsset transcript job 继续固定关闭 Summary；整理任务只由独立 `/summaries/generate` 提交，转写或整理任一失败不回滚另一阶段。
- 旧兼容 `SummaryService` 原先以文件路径直接执行 `meetingsummary/main.py`，运行日志真实报错 `attempted relative import with no known parent package`。目标源码现改为当前解释器执行 `-u -m meetingsummary.main`，保持既有 cwd、PYTHONPATH、Ollama endpoint 和输出目录；修改前备份为 `/home/zhong/laoji-service-platform/backups/20260726-summary-module-entry-v1`。
- 修复后的目标文件 SHA-256 为 `cd0d588be2260b0895234f791a7130db8fe340e78347a850a62e7c13d6369487`；18020 只重启自身为 PID `4142718`，cwd 仍是目标 backend，`CUDA_VISIBLE_DEVICES=0`，18035 与旧 8020 未动。
- 真实账号测试临时恢复一条已删除测试会议，独立 Summary 新任务未复用旧 ID，经过 `PENDING/STARTED` 后 27.1 秒 `SUCCESS`。最终 API 返回 `schema_version=2`、`template=general@1`、有序 section、字符串 `full_text` 且 `raw_json=null`，随后会议重新软删除。
- 服务重启后，旧内存 task ID 正确返回 404，但同一 durable final version `d587b3ee-d65a-4921-b5dd-f155c48ad1e6` 仍从最终结果 endpoint 返回。移动端既有恢复顺序先检查 durable 结果，只有无匹配结果时才以同一 fingerprint 重提，因此进程重启不要求把 Summary 重新塞回 Transcript job。
- 兼容 `SummaryService` 又以最短输入实际执行模块入口，subprocess `returncode=0` 并生成 JSON/Markdown；私有模型字典只在服务内解析，App API 仍只返回规范化结构，不把原始 JSON 展示给用户。
- 共享服务器 NVIDIA kernel `595.71.05` 与 NVML `595.84` 的版本失配影响 VibeVoice 转写，但本次 Summary 使用 CPU Ollama 完成；两者证据必须分开记录。
- 后续 Transcript 状态合同修复允许“已有正文且没有活动转写任务”的稳定 final revision 继续作为 Summary 输入；录制中、queued/running、空正文失败仍分别保持 incomplete/failed，Summary 必须绑定稳定 Transcript 的门禁没有放宽。目标 `app_meetings.py` 前态保存在 `backups/20260728-transcript-summary-recovery-v1`，部署文件 SHA-256 为 `1a316c964019ddcb21336c34f3f793aeb917b0f3fda8618e99e4dded358b691b`。
- 修复后登录态 `general@1` task `06b9ae52-581a-4847-8604-5f9b3be431e7` 约 92.3 秒成功，durable version 为 `10f1af3f-ef92-4a23-ae08-8164eede3dde`。结果包含 3 条决定、7 条待办和 9 个有效引用；`00:00`、`00:20`、`00:50` 分别在移动端跳到正确文字段和 `0 ms`、`20,712 ms`、`50,904 ms`。
- 同签名 Debug 停机实读确认 10 段 active final Transcript、1 个 ready Summary version、3 个 section、9 个 citation 和 7 个 action；冷启动后 canonical revision 保持 `23`，重复 durable 结果为 `unchanged`。这证明本场内容、来源跳转和幂等恢复，但十段 Transcript 来自测试 API 导入，不能写成 VibeVoice ASR 成功。

## 当前范围

- 当前可读 Summary section 已有 44dp 原子编辑入口和老记自有底部编辑层。保存只更新 `user_text/user_edited_at_ms`；migration v36 以 citation `user_removed_at_ms` 保存人工可见性，生成 citation 行不删除。恢复时清除正文与引用覆盖，并按其余人工 section、已移除引用、已编辑或已处理行动项重新计算 `summary_versions.user_edited`。
- 编辑事务同时校验 scope、当前版本、section 身份、打开时正文、可见引用集合与人工状态；删除会议、版本切换或并发变化均 fail closed。成功写入推进 canonical revision，页面重新读取 canonical Summary，兼容远端 ID 的临时文档不得覆盖本机结构化身份。分享、系列记忆和其他投影只消费未移除引用。
- 客户端归一化 `schema_version = 2`：sections、citations、action candidates、模板/输入版本和生成时间；旧 JSON/Markdown 仅通过 legacy adapter 进入同一文档模型，原始 JSON 不直接展示给用户。
- SQLite migration v5 为 Transcript segment 增加 provider `source_segment_id` 和 revision 内唯一索引。Summary citation 写入前必须解析到锁定 Transcript revision 内的 segment，且时间范围必须落在该 segment 内。
- 每次不同生成结果创建 immutable `summary_version`；重复响应幂等。当前版本无人工修改时可以自动激活；section 已编辑、关联行动项已编辑/完成/忽略，或 legacy 响应试图替换非 legacy 版本时，只保存候选而不替换当前可读投影。
- 详情更多菜单可打开本机可读版本列表，区分当前、新版本和历史版本，并标记人工修改/过期状态；受保护候选提示可直接进入该列表。显式切换只移动 `current_summary_version_id`，使用打开列表时的当前版本 ID 防止并发生成期间误切，不修改或删除 immutable 内容。
- compatibility cache 先完成 canonical mirror 决策，再决定是否替换旧投影；详情同步/重新生成后重新读取 canonical current，避免本轮页面先闪现并覆盖用户版本。
- Snapshot v5 直接传递结构化 sections、citations 和 action rows。引用点击由一个原生命令依次切到“文字记录”、定位 segment，并在有音频时 seek；无音频时仍完成前两步。
- 行动项使用规范化 content、assignee、due、排序后的 source segment IDs 和 template key 生成稳定 fingerprint，不把完成状态或 citation 返回顺序算入身份。
- 本机行动项支持 pending/completed 切换、内容/负责人/截止日期编辑和来源跳转；更新采用 `updated_at_ms` CAS。账号作用域 mutation 与 `action_item.upsert` outbox 同 SQLite transaction，游客只写本机。
- 有本机 canonical 整理结果但没有候选事项时，标题栏仍显示 44dp 新建入口。手动 action 使用稳定安全 ID、`source_kind='manual'` 和独立事务创建用例；账号作用域创建与 `action_item.upsert` outbox 同事务，重复 action ID 只允许完全相同的幂等结果，不覆盖已有对象。
- 编辑 sheet 支持将 action 设为 dismissed，并从 dismissed 恢复为 pending。忽略保留事项内容和创建时间，清除完成时间与提醒意图；恢复不会暗中重建旧提醒。已忽略行灰显、显示减号与“已忽略”，完成切换和后续日程命令不可执行，但编辑/恢复入口保留。
- SQLite migration v6 增加 `reminder_at_ms` 和待提醒索引。该字段保存用户提醒意图，`reminder_notification_id` 只保存当前设备注册；日期型截止默认当天 09:00，明确时间型截止保留原时间。完成/忽略清除提醒意图，账号作用域切换取消旧作用域注册并在返回时按 SQLite 重建。
- 编辑保存采用“先注册新通知、再原子写 action、失败撤销新通知、成功清理旧通知并对账”的顺序。通知点击经过作用域、App Lock 和会议存在性检查，进入对应会议的“整理结果”并携带 action 定位请求。
- 行动项可进入现有 AddEvent 编辑页创建后续日程：有截止时间时预填对应日期/时间，日期型截止使用 10:00–10:30；无截止时间时从当前时间向后取整到合理的半小时槽。创建结果返回稳定 `EventRef`，成功后以单向 CAS 写入 `followup_event_source_id`；已有相同链接幂等返回，已有不同链接禁止覆盖。
- 后续日程的 `client_request_id` 由 action ID 稳定派生。账号事件继续使用服务端同用户幂等约束；游客目录在 mutation queue 内按同键复用。若事件已创建而 action 关联失败，当前 AddEvent 实例只重试关联；进程恢复后的同键保存从事件目录找回原事件，不创建第二条。关联后 action 命令变为“查看后续日程”。
- SQLite migration v7 为 action 增加独立 `remote_revision`；本机 `updated_at_ms` 只做本机 CAS，不再伪装成服务端 entity revision。mutation outbox 保存 `expected_remote_revision` 与 `client_updated_at_ms`。
- SQLite migration v8 为 outbox 增加发送快照和 claim token。首次 claim 合并尚未发送的本机编辑并冻结最终 payload；网络结果不明确或进程中断后仍以同一 operation ID/快照重试，后续编辑进入下一 cohort。同一 action 串行，每批最多并行三个不同 meeting。
- 运行时只有实时 capability 明确返回 `action_items_v2=true` 才发送。Action API 使用稳定 client action ID、Idempotency-Key 和 If-Match/If-None-Match；成功写回远端 ID/revision，瞬时错误指数退避，409/412 写入既有 `sync_conflicts` 并阻塞该 action，合同/权限错误保留在 blocked/permanent_error。scope/token 改变会中止旧循环，迟到响应没有原 claim token 时不能落库。
- 触发器已覆盖 action 创建/编辑/完成/忽略/恢复/后续日程关联、App foreground、认证作用域进入和会议手动刷新。失败静默保留本机队列，不向用户暴露英文网络或合同错误。
- 409/412 现在把服务端中文错误码与 `current` payload 一起保存；读取仍兼容此前直接保存 current payload 的记录。payload 身份、revision、字段和时间严格解析，损坏或不完整数据 fail closed，不把未知 JSON 展示给用户。
- 未解决冲突进入会议 action 投影：对应行显示“同步冲突”，完成切换和后续日程命令停止，正文/编辑图标打开版本选择 sheet。选择本机版本会以云端当前 revision 或明确缺失状态创建全新 operation；选择云端版本只应用 content/status/assignee/due/reminder 等可跨设备表达字段，保留本机来源与创建身份，清除设备通知 ID 后重新对账。
- 解决事务会将该 action 旧的 blocked/pending/retry operation 全部标记为被本次选择取代，再原子更新 action、冲突状态、会议 sync state 和 canonical revision；本机版本的新 operation 与上述状态同事务插入。任何 action CAS、冲突 revision 或身份变化都保留冲突，不做静默 last-write-wins。
- 选择本机版本时，新 operation 的 `client_updated_at_ms` / `user_edited_at_ms` 必须使用严格晚于本机 action、会议根和云端候选的同一个 `resolvedAtMs`，本机 action 的两个时钟也在同一事务推进。只替换 `expected_remote_revision` 而沿用冲突前客户端时钟会被服务端以 `action_clock_regression` 拒绝，并再次形成同内容冲突。
- action v2 wire envelope 已补齐 `client_created_at_ms`、`user_edited_at_ms`、`completed_at_ms` 和 `generation_fingerprint`。pending/retry 的实时快照直接取 canonical action；旧冻结快照缺字段时只做可证明的兼容推导。创建/编辑/完成时间、提醒状态和 generated identity 在客户端发送前与服务端入参同时校验。
- SQLite migration v14 按会议保存 action pull cursor，cursor 与云端会议身份绑定并在同一合并事务内 CAS 推进。详情页进入和回到前台时，只有实时 `action_items_pull_v2=true` 才按页拉取；游客、缓存 capability 或缺字段均不拉取。
- pull 对整页完整 provenance 严格解析。本机不存在时插入；存在未完成 outbox/未解决冲突时，只有全字段相同才可附着云端 ID/revision 并收敛旧操作，否则保存云端副本且停止上行。无本机待写时仅应用单调更高 revision；同 revision 字段不同视为合同冲突。
- 上行 `source_segment_id` 已从本机 segment 主键改为 provider/server 稳定 identity。pull 仅在当前 active Transcript revision 中唯一映射时保留本机 segment link；不可唯一映射时保留来源时间但清除不可信链接。整页合并后统一对账设备提醒。

## 服务端 additive 合同

本机抽取副本 `server-work/summary` 已增加 v2 envelope、稳定 action ID、带 segment ID/时间/讲话人的单行模型输入和带时区的 UTC `generated_at`。旧字段继续返回，`due_at` 与旧 `due_date` 并存。

- compact、普通总结和 Map-Reduce 三条路径均保留 `source_segment_id + source_quote`。Map 阶段先在本 chunk 内校验或唯一恢复 segment ID，Reduce 输入继续携带来源 ID；相同 quote 跨不同 segment 时移除推断 ID，不猜归属。
- worker 以本次任务的 Transcript lines 建立 canonical segment 索引。合法 ID 仍必须有同段逐字 quote；缺失、未知或错配 ID 仅在规范化 quote 于整场 Transcript 唯一命中一个稳定 segment 时回填。模型时间完全忽略，服务端使用 canonical 秒值换算毫秒；缺失/倒序时间、空 quote、重复或不安全 segment identity、零命中和多命中均丢弃。
- `quote_hash` 为 `sha256:` 加完整 canonical segment 文本哈希，用于发现内容漂移；citation ID 包含 section/action owner identity。同一来源出现在不同 section 不再产生主键身份冲突。
- action 稳定 ID 加入排序后的来源 segment IDs；模型 citation 顺序不改变 action identity。历史参考仍明确不是本场证据，且历史-only quote 无法通过当前 Transcript 校验。
- 游客 summary 请求现在传递本机 Transcript line ID。旧实现由服务端创建 `guest:...:index`，无法映射客户端锁定 revision，因而会使所有游客 citation 在客户端 fail closed；该断链已消除。

上述 citation delta 已同步到共享服务器目标源码，修改前备份为 `backups/20260724-summary-citations-v1`。后续目标 18020 已从该工作区运行并取得上述 9 个 canonical 引用；8020 仍属于另一旧工作区，未作为证据来源。

行动项 additive delta 现已同步到同一目标源码：

- `MeetingActionItem` 以 `(user_id, meeting_id, client_action_id)` 唯一，保存稳定远端 ID、客户端更新时间、业务字段和单调 entity revision；`MeetingActionOperation` 以 `(user_id, idempotency_key)` 唯一，持久保存 request hash 与完整成功响应，记录不自动过期，满足至少 30 天重放窗口。
- `PUT /api/laoji/v2/meeting-notes/{meeting_id}/action-items/{client_action_id}` 首次创建只接受 `If-None-Match: *`，更新只接受 `If-Match: "revision"`。同 key 同 payload 返回原响应；key 被其他请求复用返回 409；实体已存在、缺失或 revision 陈旧返回 412，并携带当前 payload、revision 与可用 ETag。会议必须属于当前账号，用户可见错误均为中文。
- `GET /api/laoji/capabilities` 只在 action 表可查询时返回 `action_items_v2=true` 与独立 `action_items_pull_v2=true`。当前响应仍对未实现的 `meeting_notes_v2`、全局 `sync_cursor`、`speaker_corrections` 保守关闭，不用会议级 action pull 冒充完整 v2 数据面。
- `GET /api/laoji/v2/meeting-notes/{meeting_id}/action-items?cursor=&limit=` 只读取当前账号所有的会议，按 `(updated_at, id)` 升序返回完整 action envelope 和不透明 cursor。服务端修改会推进 entity `updated_at`，使已越过游标的 action 后续更新能再次出现。
- 服务端 action 表与响应现在保存客户端创建时间、人工编辑时间、完成时间和生成 fingerprint；创建/来源 identity 更新后不可改变。SQLite 兼容 helper 对已存在的 action 表 additive 补列，新建表直接包含完整字段。完成状态必须有有效完成时间，非 pending 不得保留提醒，手动/Marker action 不得伪装 generated fingerprint。
- 冲突选择 UI 和会议详情级 action list/cursor/pull 已完成源码纵切；全账号 change feed、全局 sync cursor、batch、删除 tombstone 与运行中跨设备验证仍未完成，因此不能称为完整跨设备同步。

同步前远端三份既有文件哈希无漂移，三个新生产文件和窄合同文件均不存在；修改前备份为 `backups/20260724-action-items-v2-v1`。后续目标服务已实例化新表，并用测试账号两个独立登录会话完成 action upsert/pull、真实 409/412 和显式版本选择；物理双机与全账号 change feed 仍不由该证据代替。

provenance 扩展同步前远端 5 个 action 文件与首个部署版本哈希一致，修改前备份为 `backups/20260724-action-items-v2-provenance-v1`。同步后目标源码重新通过同两项 action 合同与完成状态中文校验，5 个文件哈希与本机 overlay 一致；后续运行 action 往返沿用同一 provenance 合同。

会议级 pull 同步前远端上述 5 个 action 文件哈希与 provenance 版本一致，修改前备份为 `backups/20260724-action-items-v2-pull-v1`。隔离候选和正式目标源码均通过原两项 upsert 合同与一项所有权/分页/后续更新 cursor 合同，均为 `3 passed`；5 个正式目标文件与本机 overlay 哈希一致。后续 18020 已提供实时 capability 和真实账号拉取；跨物理设备与全账号 cursor 仍无运行证据。

## UI 证据分类

组件：结构化整理结果与引用

- Classification：capability-reduced Minutes surface + LaoJi-only citation control。
- `[SOURCE]`：沿用现有飞书来源映射的详情 pager、16sp 正文、17sp section title、中性 surface/text 层级和 Calendar/UD primary/primarySoft 语义色。
- `[PRODUCT]`：用户术语为“整理结果、文字记录、待办事项、来源”；所有错误提示为中文，不展示原始 JSON。
- `[INFERENCE]`：时间引用是 LaoJi 自定义 32dp quiet-blue 内容，外包 44dp 触控目标；飞书 7.71.8 没有相同的原生 Android citation chip，不声称直接复刻。

组件：待办事项行与编辑 sheet

- Classification：LaoJi-only；最近容器为 Minutes 整理内容，控件语义参考 Universe Design form/button。
- `[SOURCE]`：编辑 sheet 使用 12dp 顶角、16dp 页面边距、6dp input/button radius、48dp primary commit；文本、divider、pressed、disabled、danger 全部使用共享 Feishu tokens。
- `[SOURCE]`：“本场待办”复用既有 12dp 顶角、52dp 标题栏、语义 surface/divider/pressed 状态和固定 44dp 图标触控目标。
- `[PRODUCT]`：Summary 只展示 AI 生成的行动项且不提供新建入口；手动与 Marker 事项保存在 meeting-global action 集合，由会议“更多 → 本场待办”统一展示和创建，不新增底栏任务入口。
- `[INFERENCE]`：React Native 加号只承担熟悉的新建语义，不声称逐路径复刻飞书 glyph；22dp 完成圆位于固定 44dp 目标，正文打开编辑，日历图标进入后续日程。表单内容区可随软键盘滚动，标题栏保持固定。无渐变、装饰卡片或说明书文案。

组件：待办事项同步冲突 sheet

- Classification：LaoJi-only；最近容器为现有 Minutes/UD bottom sheet 与版本选择列表，不声称飞书存在相同同步功能。
- `[SOURCE]`：复用 12dp sheet 顶角、16dp 页面边距、6dp bounded card/primary button、48dp 提交高度、17sp 提交文字、语义 mask/surface/divider/primary/pressed/disabled/danger tokens 和约 300ms 全高度进退。
- `[PRODUCT]`：只使用“本机版本、云端版本、同步冲突”等老记术语；不显示原始 JSON。必须先明确选择再提交；云端已不存在时只允许重新上传本机版本，云端 payload 不可信时不允许猜测处理。
- `[INFERENCE]`：两个对称版本卡先选择、底部单一 primary commit；action 行以固定 metadata 槽显示冲突并暂停会产生更多版本的完成/后续日程命令。来源查看仍可用。该交互用于老记冲突闭环，不伪装成飞书源码分支。

组件：待办提醒

- Classification：LaoJi-only；最近容器为 Minutes 编辑 sheet，控件语义参考 Universe Design form/switch 状态。
- `[SOURCE]`：继续使用 12dp sheet 顶角、16dp 页边距、6dp bounded row、共享 primary/pressed/disabled/divider tokens 和固定错误槽。
- `[PRODUCT]`：没有截止日期时提醒不可用；已完成/已忽略事项不能开启提醒；通知标题、正文、权限和过期错误全部为中文。
- `[INFERENCE]`：40x24dp 动画开关置于 48x44dp 触控目标内；提醒是老记本机能力，不声称飞书 7.71.8 存在相同编辑行。

组件：后续日程命令

- Classification：LaoJi-only；最近容器为 Minutes 待办事项行，目标页面复用 Calendar AddEvent。
- `[SOURCE]`：命令使用现有飞书来源日历图标、Calendar blue、`primarySoft`、6dp radius；按钮内容位于固定 44dp 触控槽，未引入 Minutes 渐变。
- `[PRODUCT]`：未关联显示“创建后续日程”，已关联显示“查看后续日程”；不增加说明书文案，不新增底栏任务入口。
- `[INFERENCE]`：36dp 浅蓝内容面置于 44dp 目标内，是 LaoJi action-to-event 能力所需，不声称飞书 7.71.8 存在相同待办命令。

组件：整理结果版本 sheet

- Classification：LaoJi-only；最近容器为现有 Minutes/UD bottom sheet 和选择列表。
- `[SOURCE]`：12dp 顶角、300ms 全高度进出、语义 mask/surface/divider/text/primary 状态沿用共享 Feishu tokens；关闭图标使用固定 44dp 以上触控目标。
- `[PRODUCT]`：入口位于详情更多菜单；列表只显示可读版本，使用“当前版本、新版本、历史版本、含人工修改、内容可能已过期”等中文产品术语。
- `[INFERENCE]`：72dp 双行版本 row、当前 checkmark 和滚动列表为 LaoJi 版本管理所需，不声称飞书 7.71.8 存在相同页面。

组件：整理 section 编辑 sheet

- Classification：LaoJi-only；最近容器为 Minutes 整理页与 Universe Design bottom sheet/input/button，不声称飞书存在同一编辑能力。
- `[SOURCE]`：使用 12dp 顶角、16dp 页面边距、6dp input/button radius、48dp primary commit、44dp 图标目标及共享 surface/divider/primary/pressed/disabled/danger tokens。
- `[PRODUCT]`：标题为“编辑整理内容”，只保留关闭、正文、已有引用、条件式“恢复生成内容”和“保存”；时间引用可通过明确的关闭图标移除，所有错误为中文，不增加说明书式帮助文案。
- `[INFERENCE]`：编辑入口位于 section 标题行右侧；引用使用 44dp 触控目标内的 quiet-blue 时间 chip。Android 软键盘出现时整层上移，较小高度由正文区滚动，固定错误槽与提交按钮不被遮挡。

## 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- `:app:compilePreviewKotlin`：通过。
- `:app:assemblePreview`：通过。
- SUM-03 本批在保留数据的 `emulator-5556` 完成当前 section 编辑、页面即时刷新、强停冷启动保留、“恢复生成内容”及再次冷启动；恢复后生成原文精确回到页面，人工修改标记清除。另切换到标准 LatinIME 复现并修复了初版只剩标题栏、正文与保存按钮被键盘遮挡的问题；修复后输入区、恢复操作和 48dp 保存按钮均位于键盘上方。logcat 无应用 FATAL、React Native 致命异常或 SQLiteException。
- v35 保留数据覆盖安装后正常读取既有会议与版本，证明 v36 citation 覆盖列已迁移并参与普通查询。真实 `V3_CANDIDATE_SPOKEN` 的“决定”section 初始显示 `00:00/00:20/00:50`；编辑层移除 `00:00` 后页面和冷启动均只显示后两条，section 标记人工修改；“恢复生成内容”后 3 条引用全部回归且标记清除。两轮恢复成功，最终切回测试前的 03:00“访谈”当前版本并恢复 ADB Keyboard。首次旧进程恢复曾返回通用失败，后续包加入不含用户正文的 `meeting_summary_section_edit` 原因审计；新包冷启动及重复恢复未再出现该审计或失败。
- action sync 本批再次通过 TypeScript、diff whitespace、Preview Kotlin 与 assemble；后续运行批次已在目标 18020 取得 fresh action capability、测试账号写入/pull 和真实冲突选择。此前端口未监听只保留为首次同步时的历史边界，8020 仍来自另一旧工作区。
- 服务端 `python3 -m py_compile`：通过；抽取生产函数的 AST 合同验证 schema v2、稳定 action ID、`due_at`、空 citation 和 UTC `Z` 时间通过。抽取副本不是完整 `app.workers` 包，现有 pytest 在收集阶段因缺少 `app` 包停止，不记为断言通过或失败。
- SUM-02 使用目标源码隔离候选运行 61 项 backend 摘要/API/生命周期合同和 38 项 Map-Reduce/chunker 合同，全部通过。同步后直接针对目标源码再次运行同样的 61 + 38 项合同并通过；生命周期测试中的预期失败任务会打印受控 traceback，但测试断言通过。目标 8 个 delta 文件与本机 overlay 的 SHA-256 逐一一致。
- `action_items_v2` 在目标源码执行 Python 编译、两项窄纵向合同与路由静态检查：创建 revision 1、同 key 原样重放、If-Match 更新至 revision 2、陈旧 revision 412，以及第二次 If-None-Match 不覆盖已有 action，结果 `2 passed`。目标 7 个 action delta 文件与本机 overlay 的 SHA-256 逐一一致；未运行全量测试。
- action 冲突选择纵切通过 TypeScript、原生模块 Kotlin、diff whitespace 和 Preview assemble；纯解析器窄检查覆盖新 wrapper、旧 direct payload、云端缺失与损坏 payload 四条分支；内存 SQLite 窄状态检查覆盖“使用云端后旧 operation 全部结束”和“保留本机后只留下一个新 pending operation”两条路径。后续两个独立账号会话又取得真实 409/412 与显式版本选择证据，仍不把双会话写成物理双机。
- action provenance 扩展通过移动端 TypeScript 与服务端 Python 编译；目标源码两项 action 合同再次 `2 passed`，另有一个 Pydantic 窄检查确认 completed action 缺少完成时间时以中文拒绝。未增加全量门禁。
- action 会议级 pull 通过移动端 TypeScript 与服务端 Python 编译；目标源码窄合同 `3 passed`，覆盖上行幂等/冲突、会议所有权、不透明分页和越过游标后的后续更新。后续目标服务已运行并完成测试账号详情级 pull；未运行全量后端套件。
- 模拟器原始数据从 `PRAGMA user_version = 4` 升至 6；meeting/Transcript/Summary/action 关键计数迁移前后未减少，v5 citation identity 与 v6 reminder 列/索引均存在，冷启动无应用 FATAL。
- synthetic 文档可见 section、citation 和待办行；citation/行动来源在无音频时切到正确 Transcript segment。
- 行动项首次运行时更新稳定复现 `meeting_action_update_failed/error_code=action_missing`。根因是详情 route 使用 legacy meeting ID，而结构化行动项属于 canonical meeting；mutation 现通过当前 canonical Summary 状态取得 canonical meeting ID，行动项 ID 与 `updated_at_ms` CAS revision 保持不变。
- 修复后在 `LaoJi_API_35` 模拟器完成一次 pending -> completed、强制停止/冷启动、一次内容编辑和再次冷启动；均显示 canonical 最新值，logcat 无新的 `meeting_action_update_failed` 或应用 FATAL。SQLite 复核 `p4-action-1` 为 `status=completed`、`content='整理验证清单--v2'`，`user_edited_at_ms=updated_at_ms=1784810010016`，首次完成时间 `completed_at_ms=1784809925500` 被后续内容编辑保留。
- 双版本 synthetic 冒烟先以受保护 v1 为当前、较新 v2 为候选：版本 sheet 正确显示“新版本/当前版本/含人工修改”；切至 v2 后正文立即更新，强制停止/冷启动仍保持。再次打开显示“当前版本/历史版本”，切回 v1 后旧 section、已完成且编辑过的 action 均保留。SQLite 最终仍有两条 immutable `summary_versions`，只更新 `meeting_notes.current_summary_version_id`。
- 提醒 synthetic 冒烟从编辑 sheet 开启未来提醒后，页面显示 `提醒：7月23日 21:27`，AlarmManager 登记对应 `RTC_WAKEUP`；实际通知栏显示中文 `老记待办提醒` / `待办事项：完成提醒链路验证`。点击后回到正确会议并选中“整理结果”，目标 action 可见且过期后显示“已提醒”。该 synthetic 文档较短，未把首屏可见误记为长距离滚动已验证。
- 第二次未来提醒在完成前存在系统闹钟；勾选完成后 AlarmManager 记录 `Reason=alarm_cancelled`，SQLite 复核 action 为 `completed` 且 `reminder_at_ms`、`reminder_notification_id` 均为 NULL。全程无新的 `meeting_action_update_failed`、SQLiteException 或应用 FATAL。
- 跨设备提醒使用同一 v104 Preview、同一隔离账号和会议 `e297e061-3681-41ad-9d5d-2730efe3366b`。A 端 App 从“更多 → 本场待办”创建 `ACT REMINDER CROSS DEVICE 941401`，服务端 action `0bf41770-bdf4-4c9f-aadd-52f06f4a2295` / client action `8f813a2c-af0f-4872-9245-6f7dead3f22b` 初始为 `revision=1/status=pending`，`due_at_ms=1785168000000`、`reminder_at_ms=1785200400000`；A 的 AlarmManager 同时登记 `2026-07-28 09:00`。
- B 端在 action 尚不存在的基线上强停冷启动，详情 pull 后 canonical SQLite 插入同一 client/remote ID、revision 1 和完整 13 位时间，并生成设备专属通知 ID `c26d75b9-90f8-41ac-b197-91e110ac39fd`；AlarmManager 同样登记 09:00，sheet 正确显示“待完成 · 截止：7月28日”。B 在 App 内完成后，18020 推进同一 action 为 `revision=2/status=completed`，保留 due、清空 reminder 并写入 `completed_at_ms=1785185095169`；B 的 SQLite 同步清空 reminder/notification ID，系统闹钟不再存在。
- B 完成后、A 拉取前，A 的旧 09:00 闹钟仍真实存在；A 强停冷启动重新进入详情后显示同一 action“已完成 · 截止：7月28日”，原设备闹钟也被 pull 后的提醒对账取消。该轮证明跨端同步的是业务提醒意图，每台设备只保存自己的通知 ID；没有把 A 的通知标识复制到 B，也没有因完成操作残留重复闹钟。两端日志无应用 FATAL、React Native 致命异常或 SQLiteException。
- 非协作 action 冲突继续复用会议 `e297e061-3681-41ad-9d5d-2730efe3366b`。服务端 action `802aaf14-caed-44df-8318-210c42d30612` / client action `b9e2ec67-6b64-4868-8e35-cd273e46b6cd` 以 `ACTCONFLICT0505`、revision 1 为基线；B 断网编辑为 `ACTCONFLICT0505BLOCAL`，A 在线编辑为 `ACTCONFLICT0505ACLOUD` 并推进到 revision 2。B 恢复网络后行显示“同步冲突”，完成与后续日程均禁用，版本 sheet 同时显示两份正文。
- 修复前第一次“使用本机版本”正确结束旧 operation，但新 operation `fdff60eb-6df0-4b17-84f4-84bc5083a57b` 因沿用旧 `client_updated_at_ms` 被 18020 以 `action_clock_regression` 拒绝，形成第二个 unresolved conflict；这证明仅换 base revision 不能闭环。修复后保留数据覆盖安装同版本 Preview，再次选本机版本：两条旧 operation 均为 `completed/superseded_by_conflict_resolution`，新 operation `2803651d-1948-4bea-a3b8-3a62276ea301` 一次完成，两条 conflict 均 resolved。
- B 的 canonical action 和 18020 均收敛为 revision 3、`ACTCONFLICT0505BLOCAL/status=pending`，两个客户端时钟同为 `1785187169096`；行恢复“待完成”，完成与后续日程重新可用。A 强停冷启动后详情 pull 报告 `updated=1/conflicted=0`，页面显示同一正文和正常状态。两端无应用 FATAL、React Native 致命异常或 SQLiteException；该轮是两个隔离 Android App 实例，不冒充两台物理设备。
- 所有 synthetic 冒烟后已恢复 SHA-256 `fa9a2d50a3bf62e3fb3f751fd228288d352a63fdef3e0756c6a64aa0f15ec6bf` 的模拟器原始数据备份；最终迁移态 `user_version = 6`，`p4-*` 和 `reminder-*` synthetic 计数均为 0、现存 action reminder 数为 0，最终 Preview 冷启动无应用 FATAL。
- 后续日程 synthetic 冒烟以日期型截止预填 `2026-07-24 10:00–10:30`，首次保存后 action 从“创建后续日程”变为“查看后续日程”，点击进入同标题、同时间的 EventDetail。随后模拟“事件已创建但 action 链接丢失”，第二次保存仍保持游客事件总数 2（原有事件 1 + 后续事件 1），`action-followup:*` 事件严格为 1，action 重新链接到同一 `guest-*` source ID；无 SQLiteException、应用 FATAL 或 `meeting_action_update_failed`。
- 后续日程冒烟后已恢复 SHA-256 `f40728a1adad19f3963191494e82c0b0b1db3fd07d82e761170ac0da5dcbed0b` 的测试前模拟器备份。复核 `user_version = 6`、meeting 数 1、action 数 0、follow-up link 数 0、游客事件数 1、`followup-smoke` 存储/UI 命中数 0；通知权限恢复为未授权，最终 Preview 冷启动无应用 FATAL。
- 手动 action synthetic 冒烟从“整理结果有 section、无 action”开始：44dp 加号打开“新建待办事项”，输入后软键盘表单可滚动并显式 `on-drag` 收起，创建结果严格为一条 `source_kind='manual'`、`status='pending'` 的 action。忽略后完成圆和后续日程命令均不可执行；强制停止/冷启动仍显示“已忽略”，编辑页显示“恢复”；恢复后回到 pending，原 `created_at_ms` 保留且 `updated_at_ms` 前进。全程无 `meeting_action_*_failed`、SQLiteException 或应用 FATAL。
- 后续产品修正保留上述数据与恢复证据，但废止“整理结果标题栏加号”的信息架构：“更多 → 本场待办”成为 meeting-global action 的唯一手动新建入口，Summary 投影排除 `manual` / `marker`，提醒和搜索携带 action ID 时打开同一待办列表。
- 手动 action 冒烟前备份 `/tmp/laoji-action-phase4-pre-20260723.tar` 的 SHA-256 为 `fbb04830db08aacaa46f73bfeeb6b6b07d51716e53c8b3f92419d2b37b1bcb3d`；恢复后以同一目录顺序重新打包，SHA-256 完全相同。最终 UI 不含 `manual-action-smoke`、synthetic summary version 或 synthetic section。
- 上一稳定 Preview：`android/app/build/outputs/apk/preview/app-preview.apk`，当时构建时间 `2026-07-23 22:47:53 +0800`，大小 `89,782,623` bytes，SHA-256 `cc1034081193fad6b167f521df7c92ebf670fd29b8c5669ea2a04b70e8d8ff29`；已被本批构建取代。
- action sync migration 前通过同签名 Debug 包的 `debuggable` 只读窗口归档模拟器数据：`/tmp/laoji-pre-action-sync-v8-20260723.tar.gz`，大小 `1,549,596` bytes，SHA-256 `f011af7279ee44af3b7fe6023b790d86ae2df7140b6e25759d1332037bdfd6f7`。归档内 SQLite 为 `user_version=6`、meeting 1、action/outbox/conflict 均为 0。
- 最终 Preview 首次启动后再次只读归档，SQLite 为 `user_version=8`、meeting 1、action/outbox/conflict 均为 0；`remote_revision`、`request_payload_json`、`claim_token` 和三个目标索引均存在，`foreign_key_check` 无输出。post 归档 SHA-256 为 `5c92f86d803b1fb6d1fb519a1f6d9c74879876e4544ff643b4b2fd5a31d73d21`。
- 上一可安装 Preview：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-28 05:16:01 +0800`，大小 `91,061,920` bytes，SHA-256 `46a4e412dfa3e3e055c6671a7506a4a4288e2faeb86334c649d93213d41a1ec8`。该包曾完成上述 action 冲突双端收敛；本轮未触碰既有第二模拟器。
- 上一可安装 Preview：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-29 00:51:07 +0800`，大小 `91,083,336` bytes，SHA-256 `eeb63d04bf49edb273a820233f206aff0be170be3d2050e01712a8e0abfa75cf`。已被 v36 引用覆盖候选取代。
- SUM-03 当轮 Preview：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-29 01:17:52 +0800`，大小 `91,091,112` bytes，SHA-256 `b5a1068f3299457535cc85db7115813841696b7190ba863c929b8a007d769fcb`。该包已保留数据覆盖安装到 `emulator-5556` 并完成上述 SUM-03、v36 引用覆盖和正常软键盘纵切；最新候选包身份以 [`candidate-v3-evidence.md`](candidate-v3-evidence.md) 为准，USB 仍已断开。

## 未完成边界

1. 版本列表、当前指针切换、section 人工覆盖和引用移除目前只覆盖本机 canonical 数据；没有跨设备当前版本/人工内容同步，也没有线上版本列表/切换合同。列表读取最近 50 个版本并无条件补入当前版本，尚无分页；更细版本预览仍未实现。
2. action capability/API/outbox、会议详情级 cursor/pull、真实账号 ACK、409/412、显式版本选择、双 Android 实例提醒及非协作 action 冲突收敛均已有运行证据；仍缺物理双机收敛、全账号 change feed、全局 sync cursor、batch 和 action tombstone。
3. 四模板均取得真实模型 section/action 与 durable identity，定向访谈又取得四类 section 和 5 个 canonical 引用；仍缺自动 ASR 直连样本、更多真人/长会议与历史/附件授权质量抽查，以及线上版本列表/切换合同。
4. 当前只有模拟器，没有 USB 真机。引用 seek、编辑键盘/inset、完成动效、通知及后续日程命令仍缺真机轻量复核；通知回跳的长文档 action 长距离定位也未单独验证。
5. 按当前目标不执行已归档门禁、60 分钟样本、压力/穷举交互；这些留到候选功能框架稳定后。
