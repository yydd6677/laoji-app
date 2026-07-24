# Phase 0 会议契约快照

本文只记录不含凭据、主机地址和用户正文的契约证据。它不是目标 v2 API 的实现声明。

## 证据状态

| 证据 | 状态 | 可用于什么 |
|---|---|---|
| 当前 8020 运行实例 | 2026-07-24 只读检查为旧工作区进程；`/openapi.json` 可读，但只包含 `/api/meetings` 等旧路由，没有 App 的 `/api/laoji/meetings` | 证明当前可访问实例不是移动端账号会议合同，不能把它当作 18020 的替代 |
| 配置中的 18020/18035 服务 | 2026-07-24 无监听；未启动、未重启 | 证明当前 APK 配置的会议/日程账号链路不可用，不证明已同步源码的运行行为 |
| 目标部署工作区生成 OpenAPI | 已从实际 Python 环境只读生成；包含 `/api/laoji/meetings` 完整兼容路由 | 证明待启动源码的请求模型和路由，不等同在线端到端成功 |
| 目标部署 SQLite schema | 已用只读连接检查实际 `local.db` | 证明 `client_request_id`、`location`、`recorded_at` 列及用户内唯一索引已经存在 |
| 移动端当前源码 | 已读取 | 证明客户端实际发送和消费的字段 |
| `server-work` 部署补丁 | 已与目标部署工作区当前源码三方合并并固定 SHA-256 | 证明待启动源码与本机补丁一致，不等同运行态 |

本机证据文件：

- `/home/yydd/桌面/light_plan/server-work/summary/api/app_meetings.py`：`bd9c9a227ba4edbf6283fb927bb79e5d2f517d6c9e22bbb76d38d2759fe3283b`
- `/home/yydd/桌面/light_plan/server-work/summary/summary_tasks.py`：`d304a0ebd5ff0cbdcfd6a19d2affe17488dbb4397a47cfc841e70ac4cbb180e1`
- `/home/yydd/桌面/light_plan/server-work/summary/meetingsummary/main.py`：`fe63e8e3f5e1199b00f6c33ad2ddcc2ff07fe87d44382bf47b2dea1022739697`

以上三个 SHA-256 与共享服务器目标部署工作区逐项一致；同步前原文件保存在服务器 `backups/20260724-meeting-contract-template-v2`。没有启动或重启服务，当前 8020 进程仍来自另一旧工作区。

## 当前客户端实际合同

当前移动端仍使用 `/api/laoji/meetings` 旧合同：

- 创建发送 `title`、`description`、`participants`、`mode`、`client_request_id`、`location`、`recorded_at`。
- 列表使用 page/size，客户端最多读取 50 页；不是稳定 cursor。
- Transcript 使用 offset/limit；没有 revision 或稳定 cursor。
- Summary 生成通过 `summary_type=final&force=...&template_id=...&template_revision=...`；移动端优先消费 schema v2，仍保留旧字段兼容投影。
- Meeting 仍使用单一 `status`，上传另叠加本机 pending registry。

## 目标部署源码与数据库的已确认合同

- `AppMeetingCreate` 要求客户端发送 `title` 字段，但空字符串合法；同时声明 `client_request_id`、`location` 和 `recorded_at`。
- 同一用户内 `(user_id, client_request_id)` 有实际 SQLite 唯一索引。首次请求、并发唯一冲突后的重读和相同 payload 重放返回同一远端 ID；同键不同 payload 返回 409。
- `Meeting` 模型与实际 `local.db` 均已有 `client_request_id VARCHAR(96)`、`location VARCHAR(500)` 和 `recorded_at DATETIME`。schema helper 对旧 SQLite 安装执行 additive column/index 修复，不重建会议表。
- `PATCH` 允许空标题；`description` 与 `location` 使用 Pydantic `model_fields_set` 区分未提供和显式 `null`，后者可以真正清空。
- 四个固定模板的 `id@revision` 进入任务指纹、prompt 和 schema v2 结果。决定/行动项只能来自既有事实清洗结果，模型的 `template_sections` 不能绕过该清洗。
- Summary action candidate 使用稳定内容身份；兼容响应不再临时生成随机 ID，也不再把 raw 模型 JSON 返回移动端。每次生成使用唯一 `final3_*` 产物名，避免同日重生成读取旧文件。
- 已保留原服务的同会议串行、不同会议有界并发、任务归属校验、长轮询、失败不复用、删除墓碑检查、摘要事实清洗和 compact/general 路径；模板增量没有用旧副本覆盖这些保护。
- Summary carry-forward 为 additive request body：最多八项，request ID 和项目 identity 进入去重指纹；账号端只接受当前用户拥有的来源会议并拒绝引用本场自身。结构化结果回传同一 request ID，移动端不匹配时拒绝保存；有历史授权时禁用不接收上下文的 compact 快路径。
- 兼容 DELETE 仍是立即删除数据库行和音频文件；Transcript 仍是 offset 分页。当前仍没有 `/api/laoji/capabilities`、MeetingNote v2、独立 processing job、soft delete/restore、summary citation 或 sync cursor。

模板部署后在目标 Python 环境执行 81 项 API/任务/解析合同与 34 项 meetingsummary 底层测试，另行验证模板 prompt CLI 参数，均通过。carry-forward 增量又在目标源码隔离候选中通过 56 项相关合同，并按 SHA 防并发覆盖后同步至目标源码。这里只证明源码与数据库合同，未证明 18020/18035 运行态、账号鉴权或真实模型输出质量。

## Phase 0 决策

1. v2 capability 默认全部关闭；服务端未明确返回能力时继续旧路径。
2. 改变服务端数据的 v2 操作必须强制重新读取 capability，不能只信缓存。
3. SQLite Release A 只做影子导入和计数/hash 对账；UI、录音 journal 和上传链路仍读旧事实源。
   构建级回滚开关为 `EXPO_PUBLIC_LOCAL_MEETING_DB_V1=false`。
4. 不向当前不可确认的线上服务发送探测性写请求。
5. 目标部署源码、生成 OpenAPI 和 SQLite schema 已取得脱敏快照，但 18020/18035 尚未运行，未完成账号鉴权读写往返；因此 Phase 0 的“线上契约冻结”退出条件仍未满足。

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
