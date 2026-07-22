# Phase 0 会议契约快照

本文只记录不含凭据、主机地址和用户正文的契约证据。它不是目标 v2 API 的实现声明。

## 证据状态

| 证据 | 状态 | 可用于什么 |
|---|---|---|
| 配置中的日程服务 OpenAPI | 经本机代理返回 HTTP 502；绕过代理直连失败；手机网络直连未收到 HTTP 响应 | 只能证明当前无法读取，不能推断线上路由或模型 |
| 配置中的会议服务 OpenAPI | 经本机代理返回 HTTP 502；绕过代理直连失败；手机网络直连未收到 HTTP 响应 | 只能证明当前无法读取，不能推断线上路由或模型 |
| 移动端当前源码 | 已读取 | 证明客户端实际发送和消费的字段 |
| `server-work` 会议 API 副本 | 已读取并固定 SHA-256 | 证明该本机副本的行为，不等同线上 |
| `server-staging` 总结生成副本 | 已读取并固定 SHA-256 | 证明该本机副本的输出归一化逻辑，不等同线上 |

本机证据文件：

- `/home/yydd/桌面/light_plan/server-work/summary/api/app_meetings.py`：`0e911dd85ade9f20e420088e604347b615131fa07a407efa111b88fe077b77cb`
- `/home/yydd/桌面/light_plan/server-work/summary/summary_tasks.py`：`e16b91a85ab50906e8d789f8251df19542d1c19d677b729db632c900a928563f`
- `/home/yydd/LaoJi/server-staging/qwen35-9b-cutover/smart-meeting-ai/backend/app/services/app_summary_generator.py`：`0052c2ef8d68b73c46e8086f272280080ebf49090d195a5d60b7df1eef13c216`

## 当前客户端实际合同

当前移动端仍使用 `/api/laoji/meetings` 旧合同：

- 创建发送 `title`、`description`、`participants`、`mode`、`client_request_id`、`location`、`recorded_at`。
- 列表使用 page/size，客户端最多读取 50 页；不是稳定 cursor。
- Transcript 使用 offset/limit；没有 revision 或稳定 cursor。
- Summary 生成仍通过 `summary_type=final&force=...`，结果仍兼容字段对象、Markdown 和 raw JSON。
- Meeting 仍使用单一 `status`，上传另叠加本机 pending registry。

## 本机会议服务副本的已确认差异

`server-work` 的 `AppMeetingCreate` 仅声明 `title`、`description`、`participants`、`mode`：

- 未声明 `client_request_id`、`location`、`recorded_at`；Pydantic 默认会忽略客户端额外字段。
- `title` 要求至少一个字符，与目标合同“允许空标题”冲突。
- 创建使用随机服务端 UUID，没有客户端幂等键和 occurrence 唯一约束。
- `PATCH` 不支持 `location`。
- 删除是立即删除数据库行和音频文件，不是 soft delete/restore。
- Transcript 只有 offset 分页，没有 revision。
- Summary 生成路由未声明 `force`，客户端参数在该副本中没有语义。
- 每次读取 Final Summary 都为 action item 临时生成新 UUID，不能作为稳定可编辑对象。
- 没有 `/api/laoji/capabilities`、MeetingNote v2、独立 processing job、summary version/citation 或 sync cursor。

这些差异解释了为什么当前移动端接口不能直接升级为事实合同。它们也不能证明线上一定存在同样缺口。

## Phase 0 决策

1. v2 capability 默认全部关闭；服务端未明确返回能力时继续旧路径。
2. 改变服务端数据的 v2 操作必须强制重新读取 capability，不能只信缓存。
3. SQLite Release A 只做影子导入和计数/hash 对账；UI、录音 journal 和上传链路仍读旧事实源。
   构建级回滚开关为 `EXPO_PUBLIC_LOCAL_MEETING_DB_V1=false`。
4. 不向当前不可确认的线上服务发送探测性写请求。
5. 获取线上 OpenAPI、部署 migration 版本和实际响应模型后，新增一份脱敏快照并更新本文件；在此之前 Phase 0 的“线上契约冻结”退出条件尚未满足。

## Android Release A 运行证据

- Preview 原生构建成功，自动链接清单包含 `expo-sqlite` 与 `expo-crypto`。
- 使用覆盖安装保留原有账号数据，应用首屏正常显示且进程持续存活，没有老记进程的 FATAL EXCEPTION。
- 使用独立 WAL 读连接与串行写连接完成影子导入；写连接内重新计数并通过外键检查后才提交。
- 首次启动已完成影子导入；第二次启动返回 `unchanged`，证明 source hash 和实际数据库计数一致后走幂等跳过。
- SQLite repository 能读出全部 4 个列表投影、每场 5 个独立处理阶段以及首个完整 aggregate，结果为 `consistent`。
- 脱敏计数为 4 个 MeetingNote、7 个 Transcript segment、1 个 Summary version、4 个 Recording asset；未把标题、正文、地点、账号 ID、文件名或 URI写入日志。
- 本轮没有把 SQLite 切为 UI 事实源，也没有改变录音、上传、转写或总结调用路径。

## 清除后重建证据

- 只在指定 Android 模拟器执行破坏性验证，未清除用户真机数据。
- 在设置页执行“清除本机数据”后，应用退出活动 guest scope 并回到登录页。
- 重新进入游客 scope 后，影子导入结果为 `completed`，MeetingNote、Transcript segment、Summary version 和 Recording asset 计数全部为 0。
- repository 状态为 `consistent`，五阶段结构检查和 aggregate read 成功，无老记进程 FATAL EXCEPTION。

## 开发主机兼容证据

- Linux 主机下 TypeScript 编译和 Preview Android 构建通过。
- Windows 10 用户态环境中，使用官方 Windows Node.js `v20.20.2` 执行 TypeScript 编译通过。
- Windows Node.js 下动态配置可解析，SQLite plugin 和 feature flag 存在，生成的 Gradle 配置使用项目相对路径，未重新引入个人 Linux 绝对路径。
