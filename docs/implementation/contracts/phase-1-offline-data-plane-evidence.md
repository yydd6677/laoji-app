# Phase 1 离线数据平面证据

本文只保留可复核的轻量契约、脱敏计数和未决项，不保存测试工程、截图、数据库副本、录音、正文或设备身份信息。

## 当前结论

Phase 1 仍在进行中，不满足退出条件。当前批次完成了 SQLite v2 基础不变量、additive v3 会议上下文、创建与独立阶段用例、旧 Store 双读/增量影子写、按原生 session 和作用域执行的录音 journal 对账，以及 Transcript/Summary 的 repository 读写契约。界面和远端拉取仍先写旧 Store，SQLite 目前只接收同内容的增量影子写，尚未完成 canonical read/write cutover。

Phase 0 的线上 OpenAPI 和实际部署 migration 版本仍不可读取，因此 MeetingNote v2 线上写入继续保持关闭。详见 [`phase-0-meeting-contract-snapshot.md`](phase-0-meeting-contract-snapshot.md)。

## 已实现合同

| 范围 | 当前合同 |
|---|---|
| MeetingNote 创建 | Meeting、空人工笔记、五个处理阶段、可选 occurrence/snapshot、可选主录音资产和账号 outbox 在一个事务中提交 |
| ID 与幂等 | 本机 ID 只允许安全 UUID；同一 occurrence 的非删除 MeetingNote 被重复创建时复用现有聚合 |
| 空标题 | 空字符串是合法数据；“未命名会议”或“新录音”只在展示边界生成，不写回真实标题 |
| 独立状态 | capture、upload、transcript、summary、speaker 分表保存并独立转换、重试和报告 |
| SQLite v2/v3 | v2 新增 `legacy_source_id`、`native_session_id`、`last_verified_at_ms` 和三项唯一不变量；v3 additive 增加描述、参与人、地点、录制模式、客户端请求 ID、录制时间，不重建旧表 |
| 会议上下文 | canonical `(scope_key, client_request_id)` 唯一，旧影子行豁免历史重复；`date/time/duration/tags` 分别从时间、录音资产和独立阶段派生，不重复落根表 |
| 旧数据导入 | v4 只重建 `entry_point='legacy_store'` 行；canonical 行不会因 AsyncStorage source hash 变化被删除；已有 canonical identity 会排除对应旧行；`Meeting.createdAt` 对账为 `recorded_at_ms` |
| 双读对账 | 对 missing、extra、重复身份、标题、lifecycle、六项上下文和五阶段集合输出脱敏诊断，不记录正文、标题值、位置、URI 或账号 ID |
| 游客创建 | 描述、参与人、地点、录制模式、请求 ID 和录制时间先完整写入旧 Store，再按相同归一化规则增量镜像，避免切换前数据先行丢失 |
| 录音恢复 | 以 exact native session ID 和 scope 对账；只有 journal 明确证明所属 scope 时才为孤儿录音创建恢复 MeetingNote；无 scope 或其他 scope 的 journal 不被当前账号收养 |
| 文件缺失 | 只更新 recording asset 和 capture 阶段，不覆盖已存在的 Transcript、Summary 或其他处理阶段 |
| Transcript 写入 | realtime draft 可以显式替换完整 segment snapshot；final/reprocessed revision 不可原地覆盖；同一场只允许一个 active revision；revision、segment 和 source reference 全部按 scope 校验 |
| Summary 写入 | 每次结果写不可变 version 和有序 section；旧 JSON 只经归一化后成为 paragraph/bullets/action section，不作为展示正文；只有 ready/stale version 可激活 |
| 行动项保护 | 新 Summary 可复用相同生成 fingerprint 的 pending action；已编辑、已完成或已忽略 action 的内容、状态和来源不会被新版本覆盖或复活 |
| 内容级双读 | 除 meeting/title/lifecycle/五阶段外，对每场 active Transcript segment 数量和 current Summary 可用性做脱敏比较 |
| 内容读取 | 可按 scope 读取指定或 active Transcript revision 的有序 segments，以及指定或 current Summary version 的有序 sections 和 meeting-level actions；不存在或跨 scope 时返回空 |
| 用户覆盖层 | Transcript 同时保留原说话人标签和覆盖标签；Summary 同时返回 generated/user text。读取 current version 时从 section/action 实际编辑字段推导用户所有权，不只信根标记 |
| 空内容语义 | 旧缓存变空时只取消 legacy active/current 指针并重置对应阶段；历史 revision、version、action 不删除。server revision 或任何用户接管的 Summary 保持当前状态 |

## 已执行验证

- `npx tsc --noEmit --pretty false`：通过。
- `node /tmp/laoji-phase1-contract.cjs`：通过。结果为 3 个 MeetingNote、2 个 outbox；录音对账 matched 2、创建恢复 MeetingNote 1、更新 recording asset 2、跨 scope 忽略 2、冲突和未决失败均为 0。该脚本是当期临时验证材料，不纳入轻量工作树。
- `node /tmp/laoji-phase1-content-contract.cjs`：通过。覆盖 v2→v3 原行保留与安全默认值、canonical 请求 ID 唯一、legacy 重复请求 ID 豁免、六项上下文对账，以及 draft 完整替换、final 不可覆盖、唯一 active revision、跨 scope 拒写/读取、结构化 Summary、用户行动项保护、说话人/用户文本覆盖层、镜像写入顺序、空投影历史保留和内容级 mismatch 检出。空投影后仍保留 2 个 revision、1 个 version、1 个 action。该脚本和临时数据库不纳入轻量工作树。
- `git diff --check`：通过。
- SQLite v1→v2→v3 迁移：既有 MeetingNote 原行保留，六个新字段取得安全默认值，外键检查为 0；第二个 primary recording 和 canonical 重复请求 ID 被唯一索引拒绝，legacy 重复请求 ID可导入。
- Kotlin release 编译和 Android Preview 构建：通过。
- 模拟器保留数据升级：`PRAGMA user_version` 从 1 升为 2，预置 canonical MeetingNote 保留，新列存在，外键检查为 0；人为制造的 legacy 0 / repository 1 差异被双读报告识别。
- 模拟器清空后的独立重装：影子导入为 `completed`，repository 为 `consistent`，录音对账为 `completed`，没有应用进程 FATAL EXCEPTION。破坏性验证只发生在模拟器。
- 最新 Preview 在空数据模拟器独立安装并启动：应用进程持续存活；meeting、stage、Transcript count、Summary availability 均为 `consistent`，录音对账为 `completed`，没有应用进程 FATAL EXCEPTION。
- 真机无清数据覆盖安装 SQLite v3 Preview：升级前后脱敏计数均为 4 个 MeetingNote、7 个 Transcript segment、1 个 Summary version、4 个 Recording asset；首次启动 shadow v4 为 `completed`，missing/extra/duplicate/title/lifecycle/stage/Transcript/Summary/context mismatch 全为 0，应用进程持续存活。
- 真机再次冷启动：shadow v4 为 `unchanged`，上述计数与全部 mismatch 继续为 0，证明 source hash 与实际 v3 投影计数一致后可幂等跳过。

## 当前安装包

- 路径：`android/app/build/outputs/apk/preview/app-preview.apk`
- 包名：`com.laoji.app`
- 版本：`1.0.0-source-preview`（versionCode 101）
- 大小：89,597,155 bytes
- SHA-256：`a5eccda469957274739f5b0a28c0c3388dfd62f9c2df713cc3ca9a943861a408`
- 构建时间：`2026-07-22 19:15:15 +0800`

## 未决项与停线边界

1. Transcript/Summary repository 写接口和内容级对账已存在，但当前调用仍是 AsyncStorage 成功后再影子写 SQLite；失败不会影响旧界面，因此还不是 canonical write path。
2. Transcript/Summary 读取 projection 和空内容语义已经存在，但尚未接入 Store。Meeting 列表/详情 projection 已承载切换所需的六项临时会议上下文；在增加可关闭的 cutover flag、完成旧模型兼容投影和故障恢复验证前，不得切换读源。
3. 本批已通过一台授权真机的无损升级计数，但后续任何 canonical cutover 仍须保持同一计数下限且不得清除真机数据。
4. 线上契约未验证，不得发送 MeetingNote v2 探测性写请求，也不得开启 v2 capability。
