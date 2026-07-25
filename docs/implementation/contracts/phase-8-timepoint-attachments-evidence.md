# Phase 8 时间点附件证据：ATT-01 本机基础纵切

状态：绑定 Marker/时间点的短文字与相册照片已形成游客/账号作用域隔离的本机纵向闭环；附件尚未接入整理输入、分层分享或账号同步，因此 `ATT-01` 记为部分完成。本文件记录 migration v21、私有文件生命周期、会议详情入口和保留数据模拟器实测，不把老记专属附件页描述成飞书已有功能。

## 数据与文件合同

- migration v21 新增 `meeting_attachments`。每行保存 `meeting_id + scope_key`、可空 `marker_id`、不可丢失的 `position_ms`、`text/image` 互斥载荷和创建/更新时间；会议复合外键阻止跨 scope 关联，Marker 外键使用 `ON DELETE SET NULL`。
- 页面只传导航会议 ID。用例先在当前 scope 内解析 canonical ID，再执行列表、新增或删除；不存在、已删除或其他 scope 的 MeetingNote 不能接收附件。
- 新增仍要求 Marker 存在且位置一致，避免页面用过期 Marker 把附件写到错误时间。Marker 删除后附件行继续保留时间点并从会议级总入口读取，但不再显示新增按钮。
- 文字经 NFKC、去首尾空白和 1–500 字符约束后落库；它不写入 Transcript，也不改变 active Transcript revision、Summary version 或用户人工笔记。
- 相册只接收 JPG、PNG、WebP、HEIC/HEIF，单文件上限 25 MB。系统 picker URI 先复制到应用私有 `documentDirectory/meeting-attachments/<meeting>/`，确认可读和真实大小后才落库；落库失败会回收已复制文件，不能长期引用 picker cache。
- 删除附件先原子删除行，再幂等清理对应私有文件。文件清理失败时记录已删除仍成立，页面用中文提示残留清理失败；不会因为文件系统故障恢复一条已经不存在的附件行。
- 会议可恢复删除保留附件行和文件，恢复后可再次读取；永久删除依靠 MeetingNote 级联清理行，并由 Store 清理会议附件目录。附件删除、Marker 删除和会议恢复都不改写 Transcript 或既有 Summary 历史。

## 页面与交互合同

- 标记操作菜单固定显示 `附件（N）`，从该入口进入时可添加短文字或从系统相册选择照片。返回会议详情会重新读取附件计数，避免旧 snapshot 回写。
- 会议“更多”只在已有附件时显示总入口。即使 Marker 后续被删除，附件仍能按原时间点排序和删除；总入口是只读新增上下文，不擅自把游离附件重新绑定其他 Marker。
- 附件页使用固定标题栏、44dp 图标目标、16dp 页面边距、6/8dp Universe Design radius、语义浅蓝文件底色和中文空态/失败态。文字提交采用 36dp Middle action，保存保持 primary、取消保持 text hierarchy；加载不会改变操作边界。
- 当前不请求 CAMERA，也不添加拍照入口。相册由 Android Photo Picker/iOS 媒体权限负责；旧 `MediaTypeOptions` 已换成当前 `MediaType`，避免调试版把弃用警告直接浮到用户界面。
- 当前没有 Summary/分享消费者，等价于默认关闭而非已经支持。后续接入必须由用户显式勾选，并分别写入 Summary input fingerprint 和 share manifest；不能以“当前有附件”为由自动读取或导出。

## UI 证据分类

组件：会议时间点附件页和入口

- Classification：LaoJi-only；最近容器是现有飞书式会议详情操作 sheet 与设置列表页，不声称飞书 7.71.8 有相同附件功能。
- `[PRODUCT]`：只使用“会议记录、标记、附件”等老记术语；无说明书式文案；不新增相机权限；删除附件不得改变会议文字或整理历史。
- `[SOURCE]`：复用现有 Universe Design surface/body/divider、`primarySoft`、6dp UDButton radius、44dp 图标触控目标、16sp 正文和既有 AppActionSheet motion；浅蓝语义令牌由现有飞书式 token owner 统一提供。
- `[DEVICE]`：`emulator-5556` 的 Android 15、1080×2400 页面上，标记 sheet 显示 `附件（0）`，附件页可添加文字和照片；照片缩略图、文件名、大小、时间点和删除动作均实际显示。删除 Marker 后会议更多菜单显示 `附件（2）`，两项仍可读取。
- `[INFERENCE]`：附件行、Marker 数量和总览入口是老记对会议详情/设置容器的组合，不是飞书直接组件复刻。

## 轻量验证与恢复

- `git diff --check` 与 `npx tsc --noEmit` 通过；`:app:assemblePreview` 以 627 tasks（59 executed、568 up-to-date）在 36 秒内通过，没有恢复已归档测试或门禁。
- 在预试快照的 v20 保留数据库上覆盖 Debug 变体，启动前读取为 `user_version=20`、`quick_check=ok`、3 条 MeetingNote、0 条 Marker；启动后原位升级为 `user_version=21`、`quick_check=ok`，`meeting_attachments` 表存在，原会议数不变。
- Debug 夹具只增加一个 00:00 Marker。通过实际页面添加 `ATT01 note` 和一张 PNG；数据库记录分别为 `text/image`，照片 URI 位于应用私有附件目录、MIME 为 `image/png`、真实大小 130,912 bytes。强停并冷启动后两项仍存在。
- 从详情删除 Marker 后 `markers=0`，两条附件的 `marker_id=NULL`、`position_ms=0`，会议更多菜单仍能进入 `附件（2）`。删除照片附件后数据库只剩文字行，私有图片文件不存在，MeetingNote `OccueneSmoke` 仍为 `ended`，`quick_check=ok`。
- 验收使用 Debug 只为可读数据库和 fixture；结束时恢复预试快照并覆盖安装最终 Preview，不保留 Marker、文字、照片或系统相册夹具。没有 USB 真机，本轮设备结论只覆盖模拟器。
- 最终 APK 为 `android/app/build/outputs/apk/preview/app-preview.apk`，大小 90,525,336 bytes，SHA-256 `6aa881e86605d547eafbb2f8c48537eaedebdab32cad1eef0661e8482de275e3`。最终普通包覆盖安装并冷启动后，再用未启动的 Debug 变体只读数据库：`user_version=21`、`quick_check=ok`、3 条 MeetingNote、0 条 Marker、0 条附件；随后已重新覆盖安装 Preview，版本名 `1.0.0-source-preview`。

## 未完成边界

1. 附件尚未进入 Summary input fingerprint；没有逐附件/按种类选择、图片理解、远端任务恢复或模型引用证据。
2. 附件尚未进入分层分享和 `share_manifest.json`；当前默认不可分享，不等于分享能力已完成。
3. 当前没有附件 outbox、服务端 schema、跨设备文件传输、冲突或配额合同，不能宣称账号同步。
4. 没有相机入口、视频/通用文件附件、批量选择、拖拽排序或附件编辑；这些都不是本基础纵切的隐含能力。
5. 没有 USB 真机、深色模式、字体缩放、25 MB 边界或存储不足设备验证；按轻量目标留到功能批次/候选版，而不反向抹掉已完成的本机纵切。
