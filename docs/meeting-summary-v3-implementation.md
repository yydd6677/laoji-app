# 老记会议整理 v3 工程状态

状态基线：2026-08-16。本文是会议整理 v3 的源码入口，不是线上运行证明；运行
PID、队列、活动 prompt/model revision、发布包和真实设备结果必须现场复核。

## 目标链路

```text
规范来源
  -> 确定性证据包
  -> summary.facts.v3（正常一次模型调用）
  -> Pydantic Schema 与确定性引用校验
  -> 不可变 MeetingFactsDocumentV3
  -> 手机本地四模板投影与用户覆盖层
```

模板不进入模型提示词。`general`、`one_on_one`、`project_sync`、`interview` 共享同一事实、关系、引用和行动候选；切换模板只写本地偏好，不生成新整理版本，也不发网络请求。

## 活跃实现

服务端开发副本：

`$SERVICE_REPO/backend`

生产部署：

`$SERVER_DEPLOYMENT_ROOT/compact-production/backend`

移动端：

`$MOBILE_REPO`

关键所有者：

- `app/schemas/meeting_facts_v3.py`：`MeetingFactsDocumentV3`、模型响应协议和完整 JSON Schema。
- `app/prompts/meeting_facts_v3_system.txt`：无 few-shot、无评测内容的生产提示词。
- `app/services/summary_v3_evidence.py`：来源规范化、embedding、相邻主题分组、MMR 和覆盖门禁。
- `app/services/summary_v3_generator.py`：单次生成、唯一一次结构修复机会、引用与字段确定性校验。
- `app/services/summary_v3_store.py`：AES-256-GCM 临时载荷和不可变事实文档。
- `app/workers/summary_tasks.py`：持久任务、单调阶段、恢复和幂等；v3 artifact
  与 task success 的同事务提交目前仍是待实现切片，不应写成已具备。
- `app/api/device_v1.py`：设备能力和隔离的 v3 API。
- `src/services/meetingSummaryV3.ts`：协议解析、四模板投影、白名单富块和 Markdown 投影。
- `src/data/db/migrations/0039SummaryFactsV3.ts`：事实文档、模板偏好、覆盖层和后台升级任务表。
- `src/data/repositories/meetingSummaryV3Repository.ts`：本地不可变版本、偏好、覆盖层和迁移队列。
- `src/components/MeetingSummaryV3UpgradeProvider.tsx`：每设备串行后台升级和前台工作让行。
- `src/screens/TranscriptionScreen.android.tsx`：上一可用结果保留、v3 状态所有权、引用跳转和本地模板切换。

## 协议与隐私

- `schema_version=3`。本地服务开发副本在本次审计中为
  `prompt_revision=facts-v3-r5`；若部署副本或公网返回其他 revision，必须按现场
  返回值记录，不能以本文的静态文字代替运行证据。
- 正常调用为 `summary.facts.v3`，`temperature=0`、`max_tokens=4096`；只在整体 JSON 无法通过协议时调用一次 `summary.facts.v3.repair`。
- 转写是主来源；当前我的笔记自动加入；附件仅加入本次明确授权的抽取文本。
- 引用必须解析到本次来源版本，正文只允许空白归一化差异。时间戳和讲话人由服务器回填。
- 数字、日期、负责人和期限没有引用支撑时清空；单条坏引用只删除受影响事实，不再次调用模型。
- `evidence_score` 由服务器按来源、引用、冲突和字段一致性计算，不采用模型自报置信度。
- 笔记与附件正文只存在于 AES-256-GCM 临时载荷，默认 TTL 24 小时；成功、永久失败或过期后删除。持久任务请求只保存载荷 ID 和脱敏元数据。
- 日志不得记录正文、引用、文件名、人物或坐标。

## 长会议证据包

- Ollama `num_ctx=16384`；模型输入预算固定 10,240 tokens，协议约 2,048 tokens，输出最多 4,096 tokens。
- 未超预算时发送全部规范来源；超预算时使用现有 `qwen3-embedding:0.6b`，不产生中间模型摘要。
- 转写预算至少 75%；笔记和附件各最多 15%。相邻转写按时间和语义分组，每组至少保留代表段，并优先保留上下文、首尾、否定纠正、明确时间数字、负责人和跨主题连接。
- 所有主题组和来源类型必须覆盖。最低必要证据超过预算时返回 `SUMMARY_EVIDENCE_INCOMPLETE`，不能用截断后的部分总结冒充完整结果。

历史评测中 10 条录音有 4 条在当时预算内完成、6 条因最低必要证据超过预算而
失败关闭。该结果只证明当时完整性门禁的行为，不等于当前服务的长会议成功率；
不得把它写成线上性能，也不得通过静默截断、样本规则或放宽引用要求伪造通过。

## API 与任务

- `POST /api/device/v1/meetings/{binding_id}/summary-v3`
- `GET /api/device/v1/meetings/{binding_id}/summary-v3`
- 设备能力：`summary_contract_v3=true`
- 阶段：`queued -> preparing -> generating -> verifying -> persisting -> success|failure`

POST 不接收模板 ID。幂等身份由设备范围、会议、来源指纹、模型 revision 和 prompt revision 构成；相同成功身份复用已有事实文档。`force` 只允许重新调度失败或明确要求重做，不能制造同一身份的重复文档。

服务重启后任务从 SQLite 恢复。生成期间继续展示上一份可用结果；只有来源指纹变化才显示可更新。页面重进和模板切换不改变来源指纹。

## 本地投影

`summary_fact_documents` 关联不可变 `summary_versions`；`summary_view_preferences` 只保存当前模板；`summary_view_overrides` 按版本、模板和稳定块键保存用户编辑。

白名单块为：

`paragraph / bullet_group / quote / timeline / flow / comparison / risk_card / stat`

图标和布局完全由客户端语义映射。流程存在环或关系不足时退化为纵向列表；引用、时间线和流程节点复用稳定来源 ID 跳转文字记录。用户覆盖层不修改共享事实，新整理版本不继承旧版本覆盖层。

## 后台升级与兼容

- 数据库升级为已有旧整理且存在可用文字记录的会议创建持久升级任务。
- 每台设备一次只处理一条；录音、上传、用户主动整理或问答出现时立即让行。
- 失败按 5 分钟、30 分钟、6 小时重试，最多 3 次；v3 成功前继续读取旧结果。
- v3 成功后原子激活新本地版本，旧版保留在版本历史。

v2 API 和正式实现必须至少保留一个公开发布周期。模板第二轮调用、逐行动模型复核和递归模型摘要仅属于 v2 兼容链路；在 v3 客户端发布并稳定一个周期前不得删除。

## 历史验证（非当前生产证明）

- 本地后端 v3 门禁：78 passed。
- 服务器 Shadow v3 门禁：78 passed。
- TypeScript：`npx tsc --noEmit` 通过。
- 四模板投影契约通过；事实、关系、行动和引用哈希不变，暖态投影低于 100ms。
- 24 组整理/行动基线：24/24；首次 Schema 合法率 100%，修复后 100%，引用可解析率 100%，重复行动 0，模型正常调用一次。
- 24 组延迟：p50 约 6.0 秒，p95 约 34.5 秒。
- 历史公网 smoke 曾通过本地 `qwen3.5:9b`、幂等复用、临时载荷清零和测试设备域
  清理；当前 prompt、worker 和数据库状态需重新现场核对，不能沿用该结论。
- 公网 APK：`https://laoji.cloud/downloads/android/laoji-1.1.7-115.apk`，版本 `1.1.7/115`，SHA-256 `ec40176cb6ca067e108bbf9cf711d56c7fa903a5726a03b2b3eb7dc36446d824`。

## 尚未宣称完成的边界

- `1.1.7/115` 已公开发布但本轮未安装真机；旧整理后台升级只有设备完成更新后才会运行，真实设备迁移结果尚未验收。
- 当前唯一运行的 `emulator-5560` 属于 KataCR，不能用于老记 UI 验收，也不能同时启动第二台模拟器。
- 标准蓝、绚彩、页面跳动、流程退化、用户编辑和真实引用跳转仍需在指定老记模拟器或真机验收。
- 真实长会议的证据预算失败需要作为产品可见的中文结果处理；在保持完整性门禁的前提下，后续可评估更大上下文模型或经过协议审计的分层证据索引，本版不恢复模型 Map/Reduce。
- 当前 v3 仍有结果血缘缺口：客户端曾把 source fingerprint 当作
  `transcript_revision`，投影曾将 `transcriptRevisionId` 写为 `null`；服务端事实
  artifact 与 `summary_tasks_v2` success 也尚未在同一事务提交。详见蓝图 0003 和
  [lineage slice](design-blueprint/research/0005-summary-v3-lineage-slice-20260816.md)。

## 回滚和清理

生产切换前冻结包：

`$SERVER_DEPLOYMENT_ROOT/backups/summary-v3-precutover-20260815-215118`

数据库快照完整性均为 `ok`，冻结的 `backend-source.tgz` SHA-256 为 `c613ae94da08fed3fdf2f5ca708b36c4e331758271db85f266c63d9b81e10cbe`。

Shadow 测试虚拟环境、smoke 数据库、同步 staging、根目录旧迭代副本及生产 `app/**.before-*` 活动目录备份已在引用和开放文件审计后删除。质量报告、真实样本报告、正式 v2/v3 源码和冻结包均保留。
