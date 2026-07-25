# Phase 5 默认私有与删除：永久删除与账号回收站纵向切片

状态：`PRIV-01` 已把永久删除和已同步会议的可恢复删除拆成两条诚实路径。Android 在实时、非陈旧 capability 明确返回 `meeting_notes_v2=true` 与正数 `soft_delete_days` 时，才为具备稳定远端身份的会议显示“移到回收站”和恢复入口；本机、未同步或仍有音频上传风险的会议继续明确永久删除。普通 Preview 的 canonical read/write、账号根写和账号上传写仍全部关闭，所以默认包不显示尚未在线验收的回收站。

## 当前范围

### 删除语义与 capability

- `meetingDeletionPresentation()` 仍是会议列表、详情和原生长按入口的统一文案来源；新增 `resolveMeetingDeletionPresentation()` 只为符合条件的已同步会议读取 capability，本机会议删除不等待网络。
- capability 只接受当次远端响应，不用陈旧缓存承诺恢复。确认删除和确认恢复时 Store 再次强制探测，并比较用户看到的保留天数；服务端改变期限时拒绝旧确认。
- capability 请求失败与“服务端明确不支持”不再混为一谈。网络错误会阻止已同步会议删除并显示中文“无法确认删除方式”，不会退化成永久删除。
- 可恢复删除还要求 canonical 根已经持有 `remote_id + remote_revision`。只有 legacy 远端 ID、但尚未取得 v2 revision 的记录必须先刷新，不能先隐藏后才发现无法恢复。
- `preparing / recording / paused / stopping / saving / finalizing` 继续在 UI 与 Store 双层阻止删除。

### 本机事务与同步

- migration v18 为 `meeting_notes` 增加 `deleted_from_lifecycle` 和回收站索引。可恢复删除在同一事务中保存删除前的 `draft / active / ended`、删除时间、canonical revision 和 `meeting.delete` outbox；永久删除故意不写恢复历史。
- 恢复用例校验账号作用域、远端 identity/revision、未解决冲突、删除历史和当前保留期限；随后原子恢复原 lifecycle、清空删除字段并插入 `meeting.restore` outbox。
- 立即恢复允许与尚未上行的 delete 排队共存；会议根 outbox 仍按单场真实插入顺序发送，形成 `delete -> restore`，不会跳过服务端 tombstone。
- 可恢复删除保留原生录音资产和本机音频文件；永久删除仍取消 WorkManager/待上传注册、清理原生 recording journal、播放器缓存、通知和文件。当前 capability eligibility 会排除待上传或上传受阻的音频，避免承诺一个不完整的恢复。
- 既有远端根的 update/delete/restore 使用已经严格解析的 `remote_id + revision / If-Match`；不再错误要求服务端 `client_note_id` 等于当前设备本机 ID。创建操作仍保留来源设备 identity 校验。
- canonical observer 在 mutation 后直接重载 owner state 并采用 canonical projection，不再拿过时 React state 做双读比较，避免恢复成功后仍显示“待同步”或加载错误。
- 旧 API 影子记录首次接收同 revision v2 快照时，只允许规范化缺失的 `origin / entry_point`；标题、参与人、地点、状态等其他根字段同 revision 改变仍按合同错误拒绝。

### Android 回收站界面

- capability 可用时，会议记录右上角更多菜单增加“回收站”；默认关闭或 capability 失败时入口不存在。
- 回收站复用会议记录原生标题栏与列表，使用 44dp 返回按钮、固定标题槽和列表卡片；隐藏搜索、视图切换、上传和录音操作，不保留无效空位。
- 条目显示会议标题、录制时间和“还可恢复 N 天”；短按或来源一致的长按菜单进入恢复确认。同步冲突条目可见但禁用恢复。
- 物理返回键只关闭回收站并恢复主列表原有网格/列表模式及滚动位置，不退出会议页。

## UI 证据分类

组件：回收站入口与列表

- Classification：LaoJi-only capability-reduced Minutes surface。
- `[PRODUCT]`：只有真实 soft-delete、恢复 endpoint 和保留期限同时成立时才承诺可恢复；默认私有且不自动创建分享链接。
- `[SOURCE]`：复用当前 Minutes 标题栏、锚点菜单、卡片列表、44dp icon button、状态文字层级和长按高亮副本；没有把 Android 默认按钮或另一套卡片语言带入页面。
- `[DEVICE]`：模拟器上已确认主列表网格、锚点菜单、回收站单列、恢复确认、物理返回和恢复后主列表收敛。
- `[INFERENCE]`：飞书当前来源没有同名老记账号回收站；“只保留恢复动作”和隐藏底部录音区是能力缩减后的布局推断，不声称为飞书原页面。

组件：可恢复删除确认

- Classification：LaoJi-only destructive confirmation。
- `[PRODUCT]`：文案必须区分“永久删除”和“移到回收站”；网络失败不能成为选择破坏性更强路径的理由。
- `[SOURCE]`：沿用共享 App dialog 的 surface、mask、分隔线和固定 action slot。
- `[INFERENCE]`：正文使用服务端实时返回的天数，Store 在执行前再次验证该值。

## 服务端源码合同

- 共享服务器目标工作区 `/home/zhong/laoji-service-platform/smart-meeting-ai` 已在本轮早段同步 `meeting_note_root_service.py`、`app_meeting_v2.py` 和 `test_meeting_notes_v2.py`；同步前备份位于 `/home/zhong/laoji-service-platform/backups/20260725-priv-01-soft-delete-v1`。
- 目标 `.venv` 的 soft-delete/restore 窄合同为 `1 passed in 1.42s`。这只证明目标源码与隔离测试，不等于运行服务已经迁移或在线可用。
- 18020/18035 没有启动或重启；8020 属于旧工作区，未被当作本切片证据。

## 轻量验证

- `npx tsc --noEmit --pretty false`：通过。
- `git diff --check`：通过。
- 能力开启的临时 Preview：`BUILD SUCCESSFUL in 39s`，627 tasks，63 executed；内嵌 `127.0.0.1:18035` 和 canonical/account-root 临时开关，只用于模拟器验收，未作为最终包保留。
- 最新代码在 `emulator-5556` 经本机 mock 实跑：`季度复盘会议` 显示“移到回收站”确认；确认后主列表移除，回收站显示“还可恢复30天”；恢复确认后条目立即移出回收站；物理返回后主列表重新显示会议，无“待同步”和错误条。
- 同一最新包关闭 mock 后再次从会议长按删除：只显示 `无法确认删除方式 / 暂时无法连接老记服务，请检查网络后重试。`，UI hierarchy 中没有“永久删除”动作。
- 上述链路日志未发现应用 `FATAL EXCEPTION`、React Native error、`SQLiteException` 或 `no such column`。
- 最终默认 bundle 曾单独强制重建以排除临时环境复用；包含最终源码的 assemble 为 `BUILD SUCCESSFUL in 38s`，627 tasks，59 executed。
- 最终 APK：`android/app/build/outputs/apk/preview/app-preview.apk`，构建时间 `2026-07-25 20:15:10 +0800`，大小 `90,427,544` bytes，SHA-256 `7c4ad96dcb7c57a05c45b538242ec27c9bd8ed4713036f072b37c63e1b70c376`。
- APK 内嵌地址恢复为 `http://183.36.243.124:18035`；`localMeetingDbV1=true`，canonical read/write、account root write、account upload write 均为 false。已覆盖安装到 `emulator-5556`。
- 原始快照 `codex-laoji-priv01-pretest-20260725` 已恢复；最终默认包冷启动保留 `OccueneSmoke`，更多菜单只有“管理讲话人 / 个人资料”而无“回收站”，进程存活且无上述崩溃日志。

## 未完成边界

1. 目标 18020/18035 仍未运行，真实 capability、鉴权、运行数据库迁移、远端 tombstone/restore、断线重放和跨设备收敛尚未验证；普通构建开关因此保持关闭。
2. 30 天到期后的服务端物理清理、canonical Transcript/Summary/人工笔记/行动项/录音资产级联清理，以及本机过期 tombstone/文件自动清理尚未完整实现或证明。当前客户端只隐藏已过期条目，不能把这写成已完成的数据销毁。
3. USB 真机、不同 ROM、TalkBack、触觉和真实弱网切换未验证；当前设备证据仅为 Android 模拟器。
4. Android 原生回收站页面已完成；非 Android React Native fallback 目前只复用删除确认，没有独立回收站列表，不属于当前 Android 交付证明。
5. 真实活动录音、待上传音频、非空 WorkManager/通知/播放器缓存和子内容组合的删除/恢复矩阵仍未做高成本验证，留到 Phase 5 候选包门禁阶段。
