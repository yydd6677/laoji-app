# Phase 7 说话人反馈证据：SPK-01 本场修正

状态：段落级与本场同一匿名簇的讲话人更名，已形成游客本机纵向闭环；账号 correction 已具备 capability-gated outbox 客户端框架，但远端服务与账号端到端尚不可验证。当前实现刻意不创建账号级声纹资料，也不把本场临时名称伪装成未来识别能力。本文件记录 migration v11/v12、事务不变量、飞书来源映射、同步边界和模拟器实测；它不代表 `future_profile`、远端 correction endpoint、账号/跨设备同步、旧会议重新匹配、真实中文多人识别改善或 Phase 7 退出条件已经完成。

## 当前数据与事务合同

- migration v11 新增 `speaker_clusters`、`speaker_corrections` 和 `speaker_assignments`。`speaker_cluster` 只保存本场转写 revision 中的匿名簇身份；`speaker_assignment` 保存不可变的人工指派历史；当前展示名仍投影到 `transcript_segments.speaker_label_override`，原 ASR 标签和正文不重写。
- migration v12 为 `transcript_revisions` 增加独立的服务端 `remote_id`，为 correction 增加 `remote_assignment_revision`、`last_sync_error_code`、`synced_at_ms`，并增加按会议 assignment revision 和远端 Transcript 身份查询的索引。本机 canonical Transcript ID 仍是内容导出的稳定 hash，绝不冒充服务端 revision ID。
- `UpdateMeetingSpeakerAssignmentUseCase` 先按原生会议 ID 和 scope 找 canonical meeting，再读取 active Transcript。目标优先按稳定 line/source ID 唯一匹配，只有 ID 不可用时才允许用唯一的时间位置回退；已删除会议、歧义目标和 realtime draft 均拒绝修改。
- 第一版只开放 `segment` 与 `cluster`。`cluster` 必须有 canonical `speakerClusterId`，并只更新当前 active revision 中同一 source cluster 的段落；不得把账号 `speakerProfileId` 当成本场 cluster。
- correction、cluster 建立、assignment 写入、override 投影和 assignment revision 递增位于同一 SQLite transaction。每条人工 assignment 固定 `source=manual`、`user_locked=1`；同 correction ID 重试只允许完全相同身份，身份复用会拒绝。
- 游客 correction 固定 `sync_state=local_only`，不写 outbox。账号 correction 只有所有受影响段都具备非空、合法且不重复的服务端 `sourceId` 时才以 `pending` 与 `speaker_correction.submit` outbox 在同一事务写入；缺少服务端段身份时，本场修改仍成功，但 correction 固定为 `local_only`，不会把本机 hash 发送给服务端。两种作用域都固定 `speaker_profile_id=NULL`、`consent_to_profile_update=false`，本场更名不会创建或修改声纹资料。
- 真正发生修改后，只把当前 Summary version 标记为 `stale`；原 section、用户文本和行动项不清空。名字没有变化时不新增 correction，也不制造新 revision。

## 账号 correction 同步合同

- outbox payload 保存不可变的 correction ID、base revision、服务端 segment IDs、scope、名字与 consent；correction ID 同时作为 `Idempotency-Key`。真正 claim 前必须同时存在服务端 Meeting ID、服务端 Transcript revision ID 和已保存的服务端 segment IDs，三者任一缺失都不会发请求。
- 旧 Transcript API 仅在响应明确给出 `transcript_revision_id`、`revision_id` 或 `revision.id` 时保存服务端 revision 映射；分页中 revision 身份变化会拒绝镜像。映射落库后会触发 pending correction drain。
- 每次 drain 都强制刷新 capability，只有来源为真实远端且 `speaker_corrections=true` 才发送；缓存值和 legacy fallback 不能开启写操作。请求/响应执行结构化校验，成功响应必须回显同一 `client_request_id` 并提供非负 assignment revision。
- 网络、超时、408/425/429/5xx 使用有界指数退避；401 等待凭据刷新；其他 4xx 进入阻断/永久错误。409/412 保存有界远端 payload 与 revision 到 `sync_conflicts`，不做静默覆盖；90 秒陈旧 claim 可恢复，每场按 assignment revision 串行、最多三场并发。

## 原生桥接与页面合同

- canonical Transcript 单独透传 `speakerClusterId`。Kotlin `MinutesTranscriptLine`、snapshot parser 和 RecyclerView payload 均保留该字段。
- Transcript 每段的头像加姓名构成独立 44dp “修改讲话人”触控区；正文和时间区域继续执行原有回听。native action `editTranscriptSpeaker` 携带 meeting、line、position、speaker、cluster、label 和 revision kind，不在 Kotlin 层写业务数据。
- React controller 对 realtime draft 先显示中文阻止提示；稳定 revision 才打开编辑 sheet。保存后重新读取 active Transcript，并刷新文字记录、讲话人统计和当前 Summary，而不是只乐观修改一个 React state。
- 游客可以使用本场临时名字；账号级“管理讲话人”仍保持登录边界。用户可见成功、失败、目标变化和 draft 提示全部为中文。

## UI 证据分类

组件：修改讲话人 bottom sheet

- Classification：飞书直接容器的能力缩减版本；段落/本场 scope 与游客本机名称是老记产品合同。
- `[SOURCE]`：飞书 7.71.8 `decoded-resources/res/layout/mm_edit_speaker_list_dialog.xml` 使用左侧取消、居中标题、搜索/人名输入、候选列表和固定底部批量栏；checkbox 源码默认 `checked=false`，提交按钮为 `UDButton.Small.Primary`，分隔线为 0.5dp。中文资源明确给出“修改说话人”“批量修改 {number} 处“{name}””和“输入人名”。
- `[PRODUCT]`：默认只改当前段；用户明确勾选后才改本场同一簇；游客允许本场名称；仅改显示名不得建立声纹或增加教学式说明文字。
- `[DEVICE]`：API 35、1080x2400、density 420 的 `emulator-5556` 上，sheet 实际显示当前姓名、其他本场姓名候选、默认未勾选的“同时修改本场 2 处…”和 Small Primary“完成”。键盘出现时 IME 顶部为 y=1517，批量栏底部为 y=1453、完成按钮底部为 y=1418，均完整位于键盘上方。
- `[INFERENCE]`：候选名字来自当前会议已显示的其他名字；600dp 最大高度、Android 实时 IME inset 和固定错误槽用于在老记 React Native 容器中保持飞书式层级与键盘稳定，不声称是飞书原实现代码。

组件：Transcript 行内编辑入口

- Classification：现有飞书风格 Transcript 行的 LaoJi-only 语义扩展。
- `[SOURCE]`：编辑 sheet 和“修改说话人”术语有上述飞书源码证据；本轮没有证据证明飞书 7.71.8 使用完全相同的 44dp 头像姓名点击区域。
- `[PRODUCT]`：只点击头像/姓名才编辑；正文和时间仍回听，realtime draft 不可修改。
- `[DEVICE]`：UI tree 中每段头像+姓名是独立可点击节点，正文仍是独立文本节点。保存后姓名原位更新，行高、正文基线和列表位置没有跳动。
- `[INFERENCE]`：用 44dp 语义目标包住原 24dp 头像和姓名，在不改变已有视觉基线的前提下满足触控与无障碍要求。

## 轻量验证

- `npx tsc --noEmit`：v12 与服务端 segment 身份门禁通过。
- `:app:compilePreviewKotlin --parallel --max-workers=$(nproc)`：通过；232 个 task，8 executed、224 up-to-date，耗时 24 秒。
- 最终 `:app:assemblePreview --parallel --max-workers=$(nproc)`：通过；627 个 task，75 executed、552 up-to-date，耗时 2 分 8 秒。
- `git diff --check`：通过。没有恢复归档测试或门禁。
- 临时夹具包含 4 段 final Transcript：`cluster-a` 与 `cluster-b` 各两段，另有一条 ready Summary，正文为“这是原始整理结果，修改讲话人后仍应保留。”。
- 不勾选批量把第一段改为 `Alice`：UI 第一段更新，第二段仍为“讲话人 1”；SQLite 只有 1 条 `scope=segment` correction 和 1 条 assignment，revision=1、`sync_state=local_only`。Summary 变为 `stale`，原 20 字 section 完整保留；重装 Preview 后 `Alice` 仍存在。
- 勾选批量把 `cluster-b` 改为 `Bob`：第三、第四段同时更新；第二条 correction 为 `scope=cluster`，`base_revision=1`、`assignment_revision=2`，生成两条 `user_locked=1` assignment。最终总数为 2 条 correction、3 条 assignment，所有 correction/assignment 的 profile 引用计数均为 0。
- 把 active revision 临时改为合法的 `kind/status=realtime_draft` 后点击姓名，编辑 sheet 未打开，Android 创建了 Toast；实际分支文案为“文字记录还在生成，完成后才能修改讲话人。”。操作后 correction/assignment 计数仍为 2/3。
- 实测中发现局部 payload 刷新后，视觉姓名已更新但整段无障碍描述仍缓存旧姓名。已把行的 active 状态和 accessibility 描述改为在 metadata/body/active 任一 payload 后统一刷新；最终 Kotlin 编译和 Preview 构建通过。恢复夹具后未再次执行 TalkBack 朗读任务，因此该补丁只记为代码/编译验证，不记为最终设备朗读实证。
- 测试结束后恢复原始 RKStorage 和 user_version 10 数据库，恢复前后 SHA-256 一致。先前 Preview 冷启动已完成 v10→v11；本轮又从停止状态备份 v11 主库/WAL/SHM，覆盖安装 v12 Preview 后导出验证：`PRAGMA integrity_check=ok`、`user_version=12`，远端 revision 列、三项 correction 同步列和两个目标索引均存在。迁移前后两条 `meeting_notes` 的 ID、scope、标题、lifecycle、创建时间和删除时间逐项一致，原 `OccueneSmoke` 在日历中可见，测试 fixture/correction/assignment 计数均为 0；日志无应用 FATAL、SQLiteException、损坏或缺表错误。
- 配置中的 `18035 /api/laoji/capabilities` 与 `18020 /` 先前实测为 HTTP 502；最终绕过代理直连复核均未收到 HTTP 响应（curl `000`）。因此本轮没有伪造 capability、账号 correction 或冲突响应；同步部分证据限于事务/代码复核、TypeScript、Preview 构建与本机迁移，不记为远端端到端通过。
- 后续 SERIES-01 验证把同一原始数据真实迁移到 v13。最终恢复库 `integrity_check=ok`、`user_version=13`，v12 的 correction 同步列、远端 Transcript revision 列及两个索引仍存在；speaker correction/assignment/cluster 均为 0，说明系列夹具恢复没有留下说话人测试数据。
- 当前统一交付 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 10:09:36 +0800`，大小 `90,033,124` bytes，SHA-256 `00724c12c3d7b3d46ca224d84c09546dd20f26a75885114c7716ed4f968392c0`。已覆盖安装到唯一设备 `emulator-5556`，版本 `1.0.0-source-preview`，`lastUpdateTime=2026-07-24 10:12:28`。

## 未完成边界

1. `future_profile`、关联现有讲话人资料、显式声纹同意、样本质量阈值和资料撤销尚未实现；当前 UI 不提供这些未完成能力。
2. 客户端 outbox、幂等请求、重试和 409/412 冲突记录已实现，但远端当前不可达，尚未证明 capability 开启、endpoint 请求/响应、真实账号 correction 或跨设备同步；远端链路仍是硬阻塞。
3. 旧会议重新匹配 job、模型/profile revision 元数据、手工 assignment 不被 reprocess 覆盖的跨 revision 合并尚未实现。
4. 当前没有可用的真实中文多人识别样本和服务端声纹链路，无法证明人工反馈会提高未来会议识别率；本轮只证明本场人工修正不会损坏原内容。
5. 当前只有模拟器，没有 USB 真机；物理设备键盘、TalkBack、字体缩放、长会议性能和真实录音中的说话人统计仍未验证。
6. 本轮遵循轻量目标，没有恢复归档测试/门禁，也没有执行并发 correction、故障注入、进程中断或大 Transcript 压力矩阵。
