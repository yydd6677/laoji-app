# Phase 8 单待办轻协作证据：COLLAB-01 移动端与服务端 overlay

## 产品与披露边界

- `[PRODUCT]` 当前只共享一条 ActionItem，不共享整场 MeetingNote。整场内容继续走 SHARE-01 的用户逐项勾选导出。
- `[PRODUCT]` 权限只有 `viewer` 和 `action_editor`；editor 只能改状态、负责人和截止日期，不建设 Workspace、Channel、用户组或组织角色树。
- `[PRODUCT]` capability 链接的公开投影只含待办正文、状态、负责人、截止日期、revision、更新时间和通用 actor label；不含会议标题、Transcript、录音、Summary、我的笔记、来源 segment 或所有者身份。
- 创建和撤销要求已登录所有者；链接本身是 capability，接收方打开和受权编辑不要求登录。

## 移动端事实源与恢复

- migration v24 新增 `meeting_action_shares`，通过 `(meeting_id, scope_key)` 和 ActionItem 外键绑定 canonical 聚合；不向 `meeting_notes` 增加协作可空字段。
- 本机回执状态为 `pending/active/failed_retryable/blocked/revoking/revoked`。create/revoke 各有稳定 operation ID、尝试次数、错误码和远端 revision；网络成功而本机完成前中断时可用同一幂等身份重试。
- 独立 `meetingActionCollaborationV1` flag 只控制入口和新写入；服务端 capability 必须来自 fresh remote 探测，缓存或 legacy 响应不能开放写入。
- 待办未同步时保留 failed-retryable 回执并唤醒既有 action sync；待办 revision 冲突刷新 expected revision 后只重跑共享创建，不改写待办内容。
- 协作者使用应用私有存储中的稳定安全随机 UUID。它只作为 actor event identity，不冒充账号或可读姓名。

## 入口、深链与冲突

- 会议整理结果中的待办保留原有编辑按钮，协作 flag 开启时并列增加 44dp 共享按钮；共享能力不得夺走 ACT-01 编辑/冲突入口。
- 所有者 sheet 支持权限选择、创建、系统发送、失败重试和撤销。游客只看到“登录后可共享”，不会创建本机假成功链接。
- 深链严格限定为 `laoji://collaboration/action?token=<base64url>`，只接受唯一 token query、32–256 个安全字符，并注册 Android host/path。pending 深链和导航状态都校验 token 后才恢复。
- 独立共享待办页中 viewer 只读；editor 可改三项授权字段。每次提交带 ActionItem revision 与新幂等请求；412 冲突读取最新投影并提供“使用最新版本 / 保留我的修改”。
- 页面离开会取消加载请求；所有者快速关闭或切换共享目标时以请求代次丢弃旧列表结果，避免把 A 待办的链接显示到 B 待办。

## 界面分类

- `[SOURCE]` 飞书 7.71.8 没有与该 capability 流程完全相同、可直接声明复刻的组件。
- `[INFERENCE]` 所有者入口采用会议详情同族 bottom sheet：52dp 标题栏、16dp 页边距、6dp UD M 控件圆角、48dp 主按钮、固定反馈槽和约 300ms 全高度进出场。
- `[INFERENCE]` 接收方页面复用老记会议次级页标题栏、中性色阶、UD 输入/按钮状态与至少 44dp 操作目标。该页面是 LaoJi-only，不宣称为飞书原页面。
- 所有用户错误、状态、撤销确认和无权限反馈均为中文；没有供应商原始错误或飞书专有术语。

## 服务端 overlay 合同

- owner endpoint 以账号所有权、meeting ID、client action ID、If-Match 和 Idempotency-Key 创建/撤销链接。
- token 由 `LAOJI_ACTION_SHARE_SECRET`、owner、client share ID 和 remote share ID 通过 HMAC-SHA256 派生；数据库只保存 token SHA-256。secret 少于 32 字节、表未创建或 capability 探测失败时 `action_collaboration_v1=false`。
- 匿名 GET 只返回单待办投影；匿名 PUT 先验证 token、share status、permission 和 expected action revision，再更新既有 `meeting_action_items` 行。
- 每次有效协作者变更推进同一 ActionItem revision，清理不再适用的提醒，并写 actor、changed fields 和 action revision 事件；原 owner pull/conflict 入口可看到同一行的变化。
- 撤销后 capability GET/PUT 返回 410；operation 回放不在持久响应中保存原始 token。
- overlay 位于 `/home/yydd/桌面/light_plan/server-work/summary`，不属于移动端 Git 提交。同步到目标源码前必须按 README 映射复制，并在完整目标依赖环境执行聚焦合同。

## 当前证据与明确未完成

- 已通过 `npx tsc --noEmit --pretty false`、`:laoji-native-platform:compileReleaseKotlin`、`git diff --check` 和 overlay 五个 Python 模块的 `python3 -m py_compile`。
- 最终 Preview v103（`versionName=1.0.0-source-preview`）于 2026-07-26 04:10:31 +08:00 生成，大小 90,702,684 字节，SHA-256 为 `7b5516b51f8387ede3854f24103ba9669c8cd3e0d4b3d6f6dc26e0f3db4f40f3`。
- `[DEVICE]` 最终 APK 已覆盖安装 `emulator-5556` 并完成冷启动。此前 v24 升级后的 `OccueneSmoke · 录音中断` 仍在会议列表；Android 能把严格共享 URI 解析到 `com.laoji.app/.MainActivity`，伪 token 进入“共享待办”并只显示中文连接错误，不产生假数据。冷启动、返回列表和深链过程未出现 FATAL、React Native 致命错误或 SQLite 损坏/异常日志。
- overlay 聚焦 pytest 文件已准备，但 sparse overlay 缺完整基线 `app.database`，当前收集失败不是断言失败；不要把它记为合同通过。
- 18020/18035 未运行，overlay 未同步/部署；没有真实 capability、测试账号所有者、真实链接创建/撤销、第二设备 viewer/editor 往返或 USB 真机证据。
- 因此本证据只支持“COLLAB-01 移动端与服务端 overlay 纵切已完成、整体部分完成”，不支持“线上协作已可用”或“跨设备已验收”。
