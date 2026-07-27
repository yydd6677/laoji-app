# Phase 8 时间点附件证据：ATT-01 对象纵切

状态：绑定 Marker/时间点的短文字与相册照片、默认关闭的分层分享，以及账号附件的登记、图片上传/鉴权下载、列表、删除墓碑与父会议清理，已形成本机与线上功能纵切。两个全新、独立 Android 模拟器实例又完成同账号文字附件新增、pull 和墓碑删除收敛；`ATT-01` 的对象层能力记为完成。真实视觉模型与 USB/第二台物理手机仍是证据边界。本文件不把老记专属附件页描述成飞书已有功能。

## 数据与文件合同

- migration v21 新增 `meeting_attachments`。每行保存 `meeting_id + scope_key`、可空 `marker_id`、不可丢失的 `position_ms`、`text/image` 互斥载荷和创建/更新时间；会议复合外键阻止跨 scope 关联，Marker 外键使用 `ON DELETE SET NULL`。
- 页面只传导航会议 ID。用例先在当前 scope 内解析 canonical ID，再执行列表、新增或删除；不存在、已删除或其他 scope 的 MeetingNote 不能接收附件。
- 新增仍要求 Marker 存在且位置一致，避免页面用过期 Marker 把附件写到错误时间。Marker 删除后附件行继续保留时间点并从会议级总入口读取，但不再显示新增按钮。
- 文字经 NFKC、去首尾空白和 1–500 字符约束后落库；它不写入 Transcript，也不改变 active Transcript revision、Summary version 或用户人工笔记。
- 相册只接收 JPG、PNG、WebP、HEIC/HEIF，单文件上限 25 MB。系统 picker URI 先复制到应用私有 `documentDirectory/meeting-attachments/<meeting>/`，确认可读和真实大小后才落库；落库失败会回收已复制文件，不能长期引用 picker cache。
- 删除附件先原子删除行，再幂等清理对应私有文件。文件清理失败时记录已删除仍成立，页面用中文提示残留清理失败；不会因为文件系统故障恢复一条已经不存在的附件行。
- 会议可恢复删除保留附件行和文件，恢复后可再次读取；永久删除依靠 MeetingNote 级联清理行，并由 Store 清理会议附件目录。附件删除、Marker 删除和会议恢复都不改写 Transcript 或既有 Summary 历史。
- migration v32 增加远程 ID/revision、SHA-256、create/delete outbox 与失败重试。账号照片按 register→鉴权 upload→ACK 推进；拉取时校验远程 revision/checksum 后才更换本机私有文件，删除 ACK 前不提前回收尚可能需要重试的图片。
- 线上对象按 owner + meeting 隔离，create/delete 都保留幂等 operation 结果；图片限制 25 MB，同时校验真实文件头、MIME、字节数和 SHA-256。列表保留删除墓碑供其他设备收敛；父会议到期清理会先排队回收附件文件。

## 页面与交互合同

- 标记操作菜单固定显示 `附件（N）`，从该入口进入时可添加短文字或从系统相册选择照片。返回会议详情会重新读取附件计数，避免旧 snapshot 回写。
- 会议“更多”只在已有附件时显示总入口。即使 Marker 后续被删除，附件仍能按原时间点排序和删除；总入口是只读新增上下文，不擅自把游离附件重新绑定其他 Marker。
- 附件页使用固定标题栏、44dp 图标目标、16dp 页面边距、6/8dp Universe Design radius、语义浅蓝文件底色和中文空态/失败态。文字提交采用 36dp Middle action，保存保持 primary、取消保持 text hierarchy；加载不会改变操作边界。
- 当前不请求 CAMERA，也不添加拍照入口。相册由 Android Photo Picker/iOS 媒体权限负责；旧 `MediaTypeOptions` 已换成当前 `MediaType`，避免调试版把弃用警告直接浮到用户界面。
- 分层分享新增“附件”一类且默认关闭。用户显式勾选后，短文字和照片索引写入会议资料，原图复制进 ZIP，manifest 只记录 `attachments` 内容类别，不包含正文或本机绝对路径；缺失私有原图时整次准备失败并显示中文错误，不静默漏图。
- Summary 已经由独立选择 sheet 显式授权，并把附件身份写入 v6 input fingerprint；不复用分享勾选。照片只在 `meeting_attachments_v1 + summary_attachments_image` 都为 fresh true 且远程 revision/checksum 当前时可选，现线图片能力仍为 false。

## UI 证据分类

组件：会议时间点附件页和入口

- Classification：LaoJi-only；最近容器是现有飞书式会议详情操作 sheet 与设置列表页，不声称飞书 7.71.8 有相同附件功能。
- `[PRODUCT]`：只使用“会议记录、标记、附件”等老记术语；无说明书式文案；不新增相机权限；删除附件不得改变会议文字或整理历史。
- `[SOURCE]`：复用现有 Universe Design surface/body/divider、`primarySoft`、6dp UDButton radius、44dp 图标触控目标、16sp 正文和既有 AppActionSheet motion；浅蓝语义令牌由现有飞书式 token owner 统一提供。
- `[DEVICE]`：`emulator-5556` 的 Android 15、1080×2400 页面上，标记 sheet 显示 `附件（0）`，附件页可添加文字和照片；照片缩略图、文件名、大小、时间点和删除动作均实际显示。删除 Marker 后会议更多菜单显示 `附件（2）`，两项仍可读取。
- `[INFERENCE]`：附件行、Marker 数量和总览入口是老记对会议详情/设置容器的组合，不是飞书直接组件复刻。

## 轻量验证与恢复

- `git diff --check` 与 `npx tsc --noEmit` 通过；附件分享增量后的最终 `:app:assemblePreview` 以 627 tasks（59 executed、568 up-to-date）在 41 秒内通过，没有恢复已归档测试或门禁。
- 在预试快照的 v20 保留数据库上覆盖 Debug 变体，启动前读取为 `user_version=20`、`quick_check=ok`、3 条 MeetingNote、0 条 Marker；启动后原位升级为 `user_version=21`、`quick_check=ok`，`meeting_attachments` 表存在，原会议数不变。
- Debug 夹具只增加一个 00:00 Marker。通过实际页面添加 `ATT01 note` 和一张 PNG；数据库记录分别为 `text/image`，照片 URI 位于应用私有附件目录、MIME 为 `image/png`、真实大小 130,912 bytes。强停并冷启动后两项仍存在。
- 从详情删除 Marker 后 `markers=0`，两条附件的 `marker_id=NULL`、`position_ms=0`，会议更多菜单仍能进入 `附件（2）`。删除照片附件后数据库只剩文字行，私有图片文件不存在，MeetingNote `OccueneSmoke` 仍为 `ended`，`quick_check=ok`。
- 分层分享夹具包含一张 141,016-byte PNG。分享 sheet 中“附件”可用但默认未勾选；显式勾选后系统 chooser 打开 `OccueneSmoke_会议资料_<timestamp>.zip`，审计为 `included_contents=info.attachments`、`artifact_kind=archive`。ZIP 内有会议资料、原图和 schema v1 manifest；原图 SHA-256 与私有源文件一致，manifest 不含路径，资料索引保留 `00:00` 和原文件名。
- 验收使用 Debug 只为可读数据库和 fixture；结束时恢复预试快照并覆盖安装最终 Preview，不保留 Marker、文字、照片或系统相册夹具。没有 USB 真机，本轮设备结论只覆盖模拟器。
- 最终 APK 为 `android/app/build/outputs/apk/preview/app-preview.apk`，大小 90,527,844 bytes，SHA-256 `3954445001ea8a97429a129d46846f59a586f49032438d1161b7eb2eea84e923`。最终普通包覆盖安装并冷启动后，再用未启动的 Debug 变体只读数据库：`user_version=21`、`quick_check=ok`、3 条 MeetingNote、0 条 Marker、0 条附件；随后已重新覆盖安装 Preview，版本名 `1.0.0-source-preview`。

### 账号附件线上纵切

- 部署以当前运行源码为基线合并附件增量，因此保留了后来加入的 `supersedes_meeting_id` 日程会议接替合同。隔离候选的附件、会议根接替和 occurrence 回归共 5 项窄合同通过。
- 目标 18020 已加载 `meeting_attachments_v1=true`；`summary_attachments_image=false` 继续显式关闭。生产库存在 `meeting_attachments_v1` 和 `meeting_attachment_operations_v1`，`PRAGMA quick_check=ok`。
- 真实测试账号完成短文字登记（201）及幂等重放、图片登记（201）/上传（200）/鉴权下载字节对账；未登录下载返回 401，陈旧删除 revision 返回 412。两项正常删除后列表保留墓碑，最后清理测试会议、附件和 operation，生产表当前为 0 条测试残留。
- 持久部署覆盖层 `/home/yydd/桌面/light_plan/server-work/summary` 已与运行候选的 19 个合并文件逐字节对齐，并通过 Python 编译检查。本次只重启了本会话创建的 18020，并在不输出密钥的前提下恢复其既有分享配置；18035 未触碰。

### 双模拟器账号收敛

- `LaoJi_V3_Account_A / emulator-5560` 与 `LaoJi_V3_Account_B / emulator-5562` 都从清空 App 数据开始，登录同一测试账号并安装 SHA-256 为 `ee24ffc2343f8edc52b1777ceff559e2aae82e39a2648ef2ae3719a8cdcc97e4` 的 Preview；保存游客夹具的 `emulator-5556` 未触碰。
- A 在约 `01:15.9` 的时间点新增唯一文字附件 `V3_A2B_1943`，上行诊断为 `meeting_attachment_sync pushed=1`。B 在显式云端刷新后从会议全局入口看到 `附件（1）` 及相同正文。
- A 删除附件并上传 revision 2 墓碑，B 再同步后自动变为“暂无附件”。验收会议随后跨设备进入回收站；最终在服务端按账号、标题和会议 ID 三重匹配物理清理，15,481,644-byte 测试录音、失败转写任务、附件墓碑和操作记录均清除，剩余引用 0，`quick_check=ok`。18020/18035 均未因此重启。
- A 录制时创建的 Marker 没有出现在 B 的文字记录页。B 能读取附件，是因为附件自身保存了 `meeting + position_ms` 并从会议级总入口拉取；本轮不能扩写为 Marker 已同步。Marker 服务端同步仍是 MRK-01 的独立缺口。
- 以上是两个独立 Android 模拟器实例，不是第二台物理手机；图片上传/下载已有真实账号 API 对账，但本轮双实例只使用文字附件。

## 未完成边界

1. 附件已进入 Summary v6 input fingerprint 和恢复重验；但真实照片理解仍缺已确认的视觉模型，因此线上 `summary_attachments_image` 必须保持 false。
2. 已有 outbox、服务端 schema、鉴权文件传输、revision 冲突和配额合同；两个独立模拟器已完成同账号文字附件拉取/墓碑收敛，但第二台物理手机和跨设备图片文件下载仍未抽查。
3. 没有相机入口、视频/通用文件附件、拖拽排序或附件编辑；这些都不是本纵切的隐含能力。
4. 没有 USB 真机、深色模式、字体缩放、25 MB 边界或存储不足设备验证；这些留作候选版抽查，不反向抹掉已完成的功能/线上纵切。
