# Phase 7 讲话人资料与旧会议重匹配证据：SPK-01

状态：SPK-01 的功能纵切已完成。它在既有 migration v11/v12、本场 segment/cluster 修正与 correction outbox 上补齐账号 profile 同意/撤销、`future_profile`、服务端 correction v2、profile/model revision、异步样本状态、账号离线识别和旧会议 reprocess。证据达到服务端真实账号合同、Preview 编译/安装和模拟器入口；没有真实人声样本、第二台设备或 USB 真机，因此不把“功能已实现”写成“识别率已经提高”。

## 数据与隐私合同

- 继续区分 `speaker_cluster`、`speaker_assignment` 与账号级 `speaker_profile`。输入人名或修改本场同簇只生成 `segment/cluster` correction；只有用户选中既有资料并再次勾选“用于以后会议识别”才生成 `future_profile`。
- 游客不能创建或迁移 profile。登录迁移仍不复制声纹；本轮只使用服务器上当前账号明确建立的资料。
- profile SQLite 增加 `profile_revision`、`consent_state/version/consented_at/revoked_at` 与 `model_version`。新建和补录上传同时发送 `voiceprint-v1` 明示同意。撤销会把资料置为 revoked、推进 revision，并物理删除 embedding；历史 Transcript 只保留 assignment 的姓名快照。
- future profile 样本异步处理。只有总时长 2–15 秒、没有已知时间重叠、通过既有音频/embedding 质量检查且与目标 profile 余弦一致的片段才补充 embedding；其他状态落为 `rejected_quality` 或可重试失败，人工标签仍保留。
- correction、assignment 和 reprocess 使用账号隔离。旧会议 job 固化 profile revision/model version，人工 assignment 固定 `user_locked=1`；reprocess 只写 `source=reprocessed,user_locked=0`，跳过所有人工锁定行，并生成独立 `speaker-reprocess:<sha256>` revision。

## 服务端运行纵切

- 目标 18020 additive schema 新增 `meeting_speaker_corrections_v2`、`meeting_speaker_assignments_v2` 与 `meeting_speaker_reprocess_jobs_v2`。capability 现真实返回 `speaker_corrections=true`、`speaker_profiles_v2=true`、`speaker_reprocess_v1=true`。
- `POST /api/laoji/v2/meeting-notes/{id}/speaker-corrections` 核验 active MeetingNote 所有权、稳定服务端 Transcript revision、segment 集合、cluster、profile 所有权和逐会议 base revision。correction ID 与 `Idempotency-Key` 均不可复用；响应回显 client request ID 和 assignment revision。
- profile API 保留已有列表、新建、补录、改名和删除路径，新增 consent wire contract 及 create/get/latest/retry reprocess 路径。任务结果与请求生命周期分离，页面重开可读取 latest job。
- 离线 `OfflinePipeline` 过去调用 `get_all_speakers()`，只加载旧原型全局声纹，导致账号已录资料无法参与逐资产转写；空注册库同时会进入空矩阵索引。现在 per-asset worker 把 Meeting owner 传入 pipeline，账号路径只加载 `load_for_owner()`，空资料库直接保留匿名讲话人。
- 部署前备份：`/home/zhong/laoji-service-platform/backups/20260726-speaker-correction-v1`。最终 18020 PID 为 `149237`；18035 PID `3293181` 与旧 8020 PID `2152` 未重启或替换。
- 核心运行文件 SHA-256：`app_meeting_v2.py=f9faf129…a8d`、`app_speakers.py=0080559f…a3b`、`meeting_speaker_service.py=5b912dc2…d2b1`、`meeting_speaker.py=cc3ba777…242`。完整九文件哈希已在部署输出中核对。

## 移动端纵切

- `UpdateMeetingSpeakerAssignmentUseCase` 和 repository 现原子支持 `future_profile`，把 profile ID、consent、cluster assignments、Summary stale 与 outbox 写入同一事务。普通本场改名仍禁止携带 profile/consent。
- 修改讲话人 sheet 在账号态异步读取当前账号资料。资料候选和本场名字分区显示；选择资料后底部明确出现未勾选的“用于以后会议识别”，未确认时主操作保持 disabled。候选加载失败不阻止本场改名。
- 讲话人详情新增固定高度“重新匹配旧会议”设置行。开始前明确说明只更新未手动确认的讲话人；queued/running 不改变行高，失败可重试，完成后显示中文 Toast。页面重开从 latest job 恢复。
- 声纹上传 FormData 现在与 UI 同意状态一致地发送 consent version。名称“保存”仍只调用 rename endpoint，不触发录音上传或 profile 训练。

## UI 证据分类

组件：修改讲话人 sheet 的账号资料扩展

- Classification：既有飞书修改讲话人 sheet 的 LaoJi-only 能力扩展。
- `[SOURCE]`：取消/标题/搜索候选/固定底栏/Small Primary 继续沿用 `mm_edit_speaker_list_dialog.xml` 与既有 evidence 中的 UDButton、0.5dp divider、6dp radius。
- `[PRODUCT]`：只改本场名称不得创建生物特征；选中账号资料后必须再次显式同意用于以后会议；游客不显示 profile。
- `[DEVICE]`：新 APK 已在 `emulator-5556` 保留数据覆盖安装；现有会议详情、讲话人 Tab、讲话人管理和新建采集页均可进入，无启动崩溃。测试账号当前无真实 profile，因此 future profile 候选 sheet 只完成代码/编译证据，不伪造设备截图。
- `[INFERENCE]`：profile/本场名称分区、radio 状态和底部 consent checkbox 是老记语义桥接，不声称飞书存在相同生物特征授权流程。

组件：讲话人详情的旧会议重匹配行

- Classification：LaoJi-only secondary setting action。
- `[SOURCE]`：沿用当前讲话人详情的 neutral surface、16/15sp 层级、6dp radius、48dp action slot 和蓝色 secondary action 语义。
- `[PRODUCT]`：必须由用户主动触发；不覆盖人工 assignment；无需在页面常驻说明书式帮助文字。
- `[DEVICE]`：临时合成 profile 仅用于入口验证。详情 UI tree 显示 48dp“重新匹配旧会议”可点击行；点击后出现中文确认框“只更新未手动确认的讲话人；已有人工修改会保留”。实际任务 durable 完成并返回零匹配片段，随后 profile、job 与全部测试会议均从测试账号清理为 0。
- `[INFERENCE]`：详情设置行是最接近现有页面的次级操作，不复制飞书未确认存在的 reprocess 页面。

## 轻量运行证据

- schema 副本探针：meeting 三表与 profile 六列均可在现有 SQLite 副本上幂等升级。
- 真实测试账号 correction：首次提交 `201 / assignment_revision=1`；完全相同请求重放 `200`；新请求沿用 `base_revision=0` 返回 `412 / current=1`；随后旧 Transcript GET 已显示修正姓名。三轮最终部署后均重复通过，测试会议清理为 0。
- 合成 profile reprocess：移动端确认框实际发起任务；服务端返回 `completed`、`matched_segments=0`、`retryable=false` 和独立 result revision。该结果只证明任务身份、持久状态、页面恢复和零资产安全完成，不证明真实声纹匹配质量。
- `npx tsc --noEmit`、`:app:compilePreviewKotlin --parallel --max-workers=$(nproc)` 与 `:app:assemblePreview --parallel --max-workers=$(nproc)` 通过；未恢复归档测试或门禁。
- 最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-26 09:46:37 +0800`，大小 `90,772,180` bytes，SHA-256 `b267d976d04ae69dff2469c8a22c96a655bb1800a2524781dbc717bdc0ebb591`。已覆盖安装 `emulator-5556`，版本 code 104；冷启动 resumed activity 正常，相关 logcat 无应用 FATAL。

## 未完成证据边界

1. 用户先前明确允许跳过声纹功能验证；本轮没有采集或伪造真实人的生物特征，也没有把合成向量结果写成准确率证据。
2. 共享服务器 VibeVoice 仍受 NVIDIA kernel/user-space driver mismatch 阻塞；per-asset 自动转写成功与真实 profile 命名需等 GPU 恢复。健康接口和 CAM++ 启动日志不能替代这项证据。
3. future profile 的有效录音片段 accepted/rejected 质量分支、真实多人旧会议匹配、低置信度保持匿名和识别改善率尚未实测。
4. 没有第二台物理设备或 USB 手机；跨设备 correction 收敛、资料撤销传播、真实麦克风与物理设备 UI 仍归候选版窗口。
