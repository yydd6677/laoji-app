# Phase 5 默认私有与删除：诚实删除语义本机纵向切片

状态：会议列表与详情的四个删除入口已统一表达当前真实能力。本机或尚未建立远端身份的会议明确永久删除；当前没有可验证回收站能力时，已同步会议也不显示“移到回收站”或“30 天可恢复”。录音活动态在 UI 和 Store 双层阻止。本文件只记录首个用户可见纵切，不代表离线远端 tombstone、服务端 soft-delete 或恢复页已经实现。

## 当前范围

- `meetingDeletionPresentation()` 是四个删除入口的唯一文案与状态来源，Android 原生会议列表、通用会议列表、Android 原生详情和通用详情不再各自维护模糊的“确定删除？”文案。
- 游客会议和 `statusSyncPending + clientRequestId === meeting.id` 的本机导入会议使用标题 `永久删除本机会议？`。存在本机录音时明确会议记录和本机录音都会永久删除；没有录音时明确会议记录从本机永久删除。
- 已建立远端身份的会议使用标题 `永久删除会议？`，明确会议记录及相关录音、文字记录和整理结果无法恢复。当前不依据旧缓存或仅存在于客户端的 `softDeleteDays` 字段承诺回收站。
- 所有可删除路径的 destructive action 统一为 `永久删除`，取消不修改数据。
- `preparing / recording / paused / stopping / saving / finalizing` 统一判定为活动录音状态。页面直接显示 `无法删除会议`，Store 的 `assertMeetingDeletionAllowed()` 使用相同判定，防止其他调用方绕过 UI。
- `failed` 和尚未开始的可恢复会议仍允许删除，因为它们不拥有活动 recorder；本切片不把“可继续”误判成“正在录音”。
- 游客删除在后续 Phase 1 canonical write opt-in 中已接通本机 tombstone、scope revision、全投影 legacy mirror 和本机清理；账号远端失败回滚仍沿用现有 Store。当前没有把尚未接通的 account meeting-delete outbox 或回收站恢复伪装成已完成。

## UI 证据分类

组件：永久删除确认

- Classification：LaoJi-only destructive confirmation，复用现有中文 App dialog 和 destructive action hierarchy。
- `[PRODUCT]`：删除不可恢复时必须直说“永久删除 / 无法恢复”；没有真实 soft-delete 与恢复入口时不得写“移到回收站”。
- `[SOURCE]`：沿用共享 danger 文本、白色 dialog surface、mask、分隔线和固定 action slot，不引入 Android 默认按钮或额外说明卡片。
- `[INFERENCE]`：本机会议与已同步会议使用不同标题和正文，是基于老记数据所有权的区分，不声称来自飞书同名页面。

组件：活动录音删除阻止

- Classification：user-owned safety contract。
- `[PRODUCT]`：必须先安全结束并保存录音，不能在删除确认后才发现当前录音仍活动。
- `[INFERENCE]`：UI 与 Store 共用状态集合；失败/未开始记录保留可删除，是为了避免不可清理的失败卡片。

## 轻量验证

- 当前配置的 `http://183.36.243.124:18035/api/laoji/capabilities` 与会议服务 `18020` 均在本轮拒绝连接；因此没有证据支持 `soft_delete_days`、恢复 endpoint 或回收站 UI，客户端保持永久删除语义。
- `npx tsc --noEmit --pretty false` 与 `git diff --check`：通过。
- `:app:assemblePreview`：通过，627 个 task，59 executed、568 up-to-date。
- 模拟器在原始游客会议 `OccueneSmoke` 上长按卡片并选择删除，实际显示标题 `永久删除本机会议？`、正文 `此会议记录将从本机永久删除，无法恢复。`、动作 `取消 / 永久删除`；布局无重叠。
- 选择取消后会议卡片仍存在，冷启动数据审计保持 `legacy_meetings=1`、`projected_meetings=1`、`context_mismatches=0`；本轮未破坏原始会议。
- 最终 Preview 冷启动进程存活，日志未发现应用 FATAL、`SQLiteException` 或 `no such column`。
- 后续 Phase 1 受控快照已真实执行游客 destructive action：可见会议 1→0、canonical mirror clean 1/1；强停后 legacy/repository 0/0、tombstone 2，关联日程动作恢复为“开始记录”。验证后恢复并删除快照，原始会议未受影响；详见 `phase-1-offline-data-plane-evidence.md`。
- 最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-24 03:26:49 +0800`，大小 `89,893,455` bytes，SHA-256 `ab98e75384547e3bddae8a2b11d94714fae398ceb0e760947f8edc5d43b34491`。已覆盖安装到唯一设备 `emulator-5556`，包版本为 `1.0.0-source-preview`。

## 未完成边界

1. 没有 USB 真机；物理返回、触觉、TalkBack 和不同 ROM dialog 尚未验证。
2. 当前夹具是 `failed` 会议；活动录音阻止分支已做共享实现与 TypeScript 检查，但会议服务不可达，未在真实 recording/paused 会话上触发。
3. 后续已在可恢复快照执行 destructive action并验证 canonical tombstone 与空投影；夹具没有本机音频、待上传任务或行动项提醒，因此真实文件、WorkManager、通知和播放器缓存的非空清理仍未覆盖。
4. 登录态远端会议、断网删除、进程强杀、迟到上传和刷新防复活尚未验证。当前 Store 对远端 DELETE 失败仍回滚本机列表，不是目标中的持久 tombstone + 重试。
5. 服务端只有在实时 capability 明确返回正数 `soft_delete_days`、DELETE 合同确认 soft-delete 且恢复 endpoint 可用后，客户端才可增加“移到回收站”和恢复页面。
