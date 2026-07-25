# Phase 1 离线数据平面证据

本文只保留可复核的轻量契约、脱敏计数和未决项，不保存测试工程、截图、数据库副本、录音、正文或设备身份信息。

## 当前结论

Phase 1 的游客本机 cutover 已闭环；账号线上部分仍在进行中，因此整体仍不满足线上退出条件。当前普通 Preview 默认开启可自动回退的 canonical read/write：尚未取得 owner 的 scope 先完成 shadow import、内容级 preflight 和最终投影对账，游客首次 mutation 才原子取得 canonical owner/revision；三份旧缓存只作为 revision 管理的兼容镜像。媒体导入、游客会议创建、游客会议根字段编辑、游客软删除、游客录音 capture/asset、游客 Transcript 内容/revision 和游客 Summary version/section/action 七类写纵切都从已通过 preflight 的 canonical 投影解析主键，映射缺失时 fail closed。冷启动先按 owner/revision 修复 pending/failed mirror，不让旧快照反向导入。账号普通创建、标题/详情编辑、软删除、录音根状态、Transcript/Summary 内容、远端列表刷新和上传对账虽已接通独立 canonical 路径，但 `localMeetingDbAccountRootWriteV1` 与 `localMeetingDbAccountUploadWriteV1` 仍默认关闭；broad canonical write 不授权账号媒体导入取得 owner，启动时也不恢复被账号开关禁止的 canonical owner。部署中的账号 API、真实 WorkManager 上传和跨设备恢复尚未闭环，普通构建仍不取得账号 canonical 写所有权。

Phase 0 已取得目标部署源码生成 OpenAPI 和实际 SQLite schema 的只读快照，并同步旧 `/api/laoji/meetings` 兼容合同；但配置中的 18020/18035 未运行，尚无账号鉴权读写往返或 MeetingNote v2 capability。因此 MeetingNote v2 与账号 canonical 写入继续保持关闭。详见 [`phase-0-meeting-contract-snapshot.md`](phase-0-meeting-contract-snapshot.md)。

## 已实现合同

| 范围 | 当前合同 |
|---|---|
| MeetingNote 创建 | Meeting、空人工笔记、五个处理阶段、可选 occurrence/snapshot、可选主录音资产和账号 outbox 在一个事务中提交 |
| 根字段 mutation | 标题允许空字符串；描述、参与人、地点、模式和录制时间统一归一化。账号 mutation 缺少同事务 sync operation 时拒绝提交，游客 mutation 不创建远端 outbox |
| 软删除 | 只写 MeetingNote tombstone，不删除录音、Transcript、Summary 或行动项；preparing/recording/paused/finalizing capture 拒绝删除。账号 tombstone 与 delete outbox 同事务提交 |
| Outbox 幂等 | 同一 operation ID 与完全相同的 scope/aggregate/type/base revision/payload 重试返回既有操作且不重复 mutation；复用 ID 携带不同语义时整个 transaction 拒绝 |
| ID 与幂等 | 本机 ID 只允许安全 UUID；同一 occurrence 的非删除 MeetingNote 被重复创建时复用现有聚合 |
| 空标题 | 空字符串是合法数据；“未命名会议”或“新录音”只在展示边界生成，不写回真实标题 |
| 独立状态 | capture、upload、transcript、summary、speaker 分表保存并独立转换、重试和报告 |
| SQLite v2/v3/v4 | v2 新增 `legacy_source_id`、`native_session_id`、`last_verified_at_ms` 和三项唯一不变量；v3 additive 增加六项会议上下文；v4 只新增 scope write ownership/revision 表，不重建 MeetingNote 或内容表 |
| Scope 写所有权 | 无状态行等价于 legacy owner、revision 0、mirror clean。首次明确 canonical mutation 与 owner/revision 1/pending 同事务提交；后续 revision 单调递增，旧 revision 不能把新 revision 标为 clean |
| 降级镜像协调 | canonical projection 的会议、Transcript、Summary 三份旧缓存全部写成功后，才用 revision CAS 标记 clean；部分失败只记录脱敏错误类型。写入期间 revision 漂移会重读最新投影，clean 后到达的同 revision failure 不能反向污染状态 |
| Store 写纵切 | 媒体导入、游客会议创建、游客会议标题/详情、游客删除、游客 capture/asset、游客 Transcript 及游客 Summary 仅在 `localMeetingDbCanonicalWriteV1=true` 时 canonical-first；提交后由 scope 绑定 writer 覆盖 meetings/Transcripts/Summaries 三份兼容缓存。镜像失败不撤销已提交的数据，当前会话继续采用 canonical 投影，重启按 owner/revision 重试 |
| 游客会议创建 | 显式写开关下先以 canonical `MeetingNote` 建立事实源与 owner/revision，再从稳定全 scope 投影更新 Store；普通创建和 occurrence 创建均保留原请求 ID、入口、日程快照与关联。投影、scope 或提交后主键缺失时 fail-closed，不回退成双事实源 |
| 游客录音 capture/asset | capture stage、会议 lifecycle、主录音资产、guest upload stage、可选 Transcript stage 与 canonical revision 在一个事务中更新。开始录音创建或复用 `capturing` 主资产并绑定 native session；暂停/恢复不重复增加 attempt；有效本机 URI 才允许 `local_ready`；启动失败保留 `failed_recoverable + missing` 资产供 journal 恢复；guest upload 固定 `not_required` |
| 账号录音上传对账 | pending registry 与 WorkManager 保持唯一上传调度权；前台、录音结束和 JS/native 重试前后读取当前 worker state，归一化 queued/uploading/uploaded/failed_retryable/blocked。事务只更新主 RecordingAsset、upload stage、attempt、稳定 operation ID 与 credential generation；同 operation 的 uploaded 不被迟到失败降级，相同证据不增加 revision，新 operation 才可替换本机资产 URI。账号专用写开关独立且默认关闭，普通构建只 shadow write |
| 账号根 outbox 消费 | 本机 MeetingNote ID 永不替换，远端 UUID 独立写 `remote_id`。每场只 claim 最早未完成 operation，create/update/delete 不乱序；90 秒陈旧 in-flight 可回收，指数退避保留同一 request snapshot。create 使用稳定 `client_request_id`，PATCH 只发送显式设值字段，DELETE 404 为幂等成功；409 保存冲突副本，401/网络重试，合同缺失或非法 payload 终止并阻止同场后续操作。成功/终态与 canonical revision 同事务推进 |
| 账号 outbox 持久唤醒 | MeetingNote 根、occurrence、人工笔记、行动项与讲话人 correction 的 provider 不再只依赖当前进程创建的 timer。claim 返回空时从 SQLite 读取仍可发送 cohort 的 `next_attempt_at_ms`，并把 fresh `in_flight` 的最后更新时间加 90 秒作为 stale 回收时间；根队列只看每场最早 operation，行动项/笔记等待整个在途 cohort，occurrence 按 operation，blocked/permanent 继续排除。持久绝对时间与本轮相对退避取更早者 |
| 账号 Store 与远端合并 | 独立根写开关下，创建、根字段、删除、capture、Transcript、Summary 和上传状态都从 canonical 投影解析本机 ID；根 outbox、领域 mutation 与 revision 同事务。远端列表按 `remote_id`/`client_request_id` 绑定，未完成根操作保护本机字段，墓碑不复活，列表缺项不删除，远端内容可用性不覆盖本机正文或录音资产，已上传证据不被延迟列表降级 |
| 游客 Transcript | Store 复用游客 mutation 队列并从 canonical 投影解析主键；用例过滤空行、规范时间/说话人/置信度，使用内容指纹生成稳定 revision/segment ID。realtime draft 只显式全量替换自身；final/reprocessed immutable；稳定 final 阻止迟到 draft 激活；明显较短 final 保存为 inactive 且阶段保持 finalizing；active 内容变化才 stale Summary。Transcript/stage/Summary stale/Marker 对账与 canonical revision 同事务，提交后只采用全 scope canonical 投影 |
| 游客 Summary | Store 复用游客 mutation 队列并校验 canonical 主键；严格模式沿用 schema v2/legacy adapter、内容指纹、immutable version/section/citation 和生成 action 复用。realtime draft、显式 Transcript revision 错配与主键错配 fail-closed；事务内二次确认 active Transcript，输入已过期或当前版本有用户编辑/已处理 action 时只保存 inactive 候选，当前 Summary、阶段状态和 fingerprint 不被覆盖；候选与 canonical revision 同事务 |
| 游客根字段编辑 | 只接受当前 canonical 投影的 `legacy ID -> canonical ID` 映射；投影或映射缺失时拒绝写入，不以运行时查询、临时导入或抢占 owner 绕过 preflight。标题和详情共用游客 mutation 队列；提交与 mirror 期间仓库观察器等待稳定投影，避免旧缓存短暂回闪 |
| 游客软删除 | Store 与用例双层拒绝活动录音；事务只写 tombstone、deleted sync state 与 canonical revision，历史 RecordingAsset/Transcript/Summary/Action 不物理删除。全投影 clean 并从界面移除后，再尽力取消上传/提醒和清理本机文件；清理失败沿用“记录已删除、部分本机数据未清”的中文错误 |
| canonical owner 启动恢复 | 写开关显式开启且 scope 已归 canonical 所有时，启动先修复或确认 legacy mirror，再直接采用稳定 canonical 投影并跳过 legacy shadow import；未声明 owner 的 scope 继续原有 shadow/preflight 流程 |
| 会议上下文 | canonical `(scope_key, client_request_id)` 唯一，旧影子行豁免历史重复；`date/time/duration/tags` 分别从时间、录音资产和独立阶段派生，不重复落根表 |
| 旧数据导入 | v4 只重建 `entry_point='legacy_store'` 行；canonical 行不会因 AsyncStorage source hash 变化被删除；已有 canonical identity 会排除对应旧行；`Meeting.createdAt` 对账为 `recorded_at_ms` |
| 双读对账 | 对非法/重复旧身份、missing、extra、重复 repository 身份、可见顺序、标题、lifecycle、六项上下文和五阶段集合输出脱敏诊断，不记录正文、标题值、位置、URI 或账号 ID |
| 删除墓碑 | `deleted` 行不计入可见 meeting/extra，也不进入 canonical 列表；墓碑数量单独脱敏报告，五阶段完整性仍接受检查。legacy shadow 墓碑会在下一次 v4 全量影子重建时随旧影子行回收，非 legacy canonical 行不受该重建影响 |
| 游客创建 | 描述、参与人、地点、录制模式、请求 ID 和录制时间先完整写入旧 Store，再按相同归一化规则增量镜像，避免切换前数据先行丢失 |
| 录音恢复 | 以 exact native session ID 和 scope 对账；只有 journal 明确证明所属 scope 时才为孤儿录音创建恢复 MeetingNote；无 scope 或其他 scope 的 journal 不被当前账号收养 |
| 文件缺失 | 只更新 recording asset 和 capture 阶段，不覆盖已存在的 Transcript、Summary 或其他处理阶段 |
| Transcript 写入 | realtime draft 可以显式替换完整 segment snapshot；final/reprocessed revision 不可原地覆盖；同一场只允许一个 active revision；revision、segment 和 source reference 全部按 scope 校验 |
| Summary 写入 | 每次结果写不可变 version 和有序 section；旧 JSON 只经归一化后成为 paragraph/bullets/action section，不作为展示正文；只有 ready/stale version 可激活 |
| 行动项保护 | 新 Summary 可复用相同生成 fingerprint 的 pending action；已编辑、已完成或已忽略 action 的内容、状态和来源不会被新版本覆盖或复活 |
| 内容级双读 | 前置报告比较 active Transcript segment 数量和 current Summary 可用性；构建投影后再比较会议可见字段、逐行 Transcript 的说话人/正文/时间/置信度语义和最终 Summary 展示文本。同数量但正文不同仍拒绝切换 |
| 内容读取 | 可按 scope 读取指定或 active Transcript revision 的有序 segments，以及指定或 current Summary version 的有序 sections 和 meeting-level actions；不存在或跨 scope 时返回空 |
| 用户覆盖层 | Transcript 同时保留原说话人标签和覆盖标签；Summary 同时返回 generated/user text。读取 current version 时从 section/action 实际编辑字段推导用户所有权，不只信根标记 |
| 空内容语义 | 旧缓存变空时只取消 legacy active/current 指针并重置对应阶段；历史 revision、version、action 不删除。server revision 或任何用户接管的 Summary 保持当前状态 |
| 读切换接线 | `localMeetingDbCanonicalReadV1` 已默认开启并接入列表及同步 Transcript/Summary getter；基础 DB flag 关闭或 preflight/最终投影不一致时仍自动回退。SQLite 投影和旧 Store refs 分离，兼容缓存只由 revision mirror 协调器更新 |
| 开关作用域隔离 | broad canonical read 可在账号 shadow/preflight 一致后采用只读投影，但 broad write 只授权游客取得 owner；账号媒体导入、owner 启动恢复、根 outbox 与上传状态必须再满足各自账号开关 |
| 写后再验证 | 旧路径写入前立即撤销 canonical getter；repository 提交通知会同步使所有在途读取失效，30 ms 合并后用最新旧 Store 快照重新 preflight。上传待处理状态也先镜像独立阶段，再尝试恢复 SQLite 读取 |
| 自动回退 | 只有双读和最终兼容投影全部一致且仍是同 scope 的最新请求才返回 SQLite 投影；非法/重复身份、missing/extra、顺序、阶段、上下文、可见字段、同数量正文漂移、分页变化或读取异常均恢复原旧 Store 快照 |

## 已执行验证

- `npx tsc --noEmit --pretty false`：通过。
- outbox 持久唤醒增量：`npx tsc --noEmit`、`git diff --check` 与临时纯时间合并合同通过；静态复核四个新增查询与原 claim 使用相同 scope、远端身份、生命周期、aggregate、operation type 和 blocker 条件。没有恢复归档测试/门禁，没有生成 APK；Expo SQLite、真实进程强杀、系统时钟跳变和远端恢复仍未实测。
- `node /tmp/laoji-phase1-contract.cjs`：通过。结果为 3 个 MeetingNote、4 个 outbox；覆盖账号根字段 mutation 必须携带同事务 outbox、空标题与其他上下文归一化、相同 operation 重试不重复、不同 payload 复用 ID 被拒绝、active capture 拒绝删除、软删除保留 recording asset 及 tombstone 重试幂等。录音对账 matched 2、创建恢复 MeetingNote 1、更新 recording asset 2、跨 scope 忽略 2、冲突和未决失败均为 0。该脚本是当期临时验证材料，不纳入轻量工作树。
- `node /tmp/laoji-phase1-content-contract.cjs`：通过。覆盖 v2→v3→v4 原行保留与安全默认值、scope 默认 legacy owner、canonical revision 递增、镜像 clean/failed CAS、clean 后晚到 failure 拒绝、投影期间 revision 漂移重试、三份旧缓存完整修复和失败后恢复；同时覆盖 canonical 请求 ID 唯一、legacy 重复请求 ID 豁免、六项上下文对账、默认关闭/一致时生成完整兼容投影、删除墓碑隔离、重复旧身份拒绝、可见字段漂移拒绝、同数量 Transcript 正文漂移拒绝和 mismatch 自动回退，以及内容版本不变量。空投影后仍保留 2 个 revision、1 个 version、1 个 action。该脚本和临时数据库不纳入轻量工作树。
- 临时 canonical mirror 契约：通过。首次 revision 2 将三份缓存各写一次并 clean；重复调用零写入；Summary writer 失败时 mirror revision 保持 2、状态为 failed 且只保存 `TypeError`；恢复后 clean 到 revision 3；写入期间 revision 3→4 漂移会把三份缓存完整重写第二轮并最终 clean。脚本执行后删除，未恢复测试目录。
- 当前 Expo public config：默认输出 DB/read/write/account-root/account-upload=`true/true/true/false/false`；显式关闭 read 会强制关闭 write 和两项账号写，基础 DB=false 时其余四项也均强制关闭。
- `git diff --check`：通过。
- SQLite v1→v2→v3→v4 迁移：既有 MeetingNote 原行保留，六个新字段取得安全默认值，v4 ownership 表可用且外键检查为 0；第二个 primary recording 和 canonical 重复请求 ID 被唯一索引拒绝，legacy 重复请求 ID 可导入。
- Kotlin release 编译和 Android Preview 构建：通过。最终默认配置使用 `--rerun-tasks` 完整执行 627 个 task，耗时 2 分 29 秒，避免复用此前 opt-in bundle。
- 模拟器保留数据升级：`PRAGMA user_version` 从 1 升为 2，预置 canonical MeetingNote 保留，新列存在，外键检查为 0；人为制造的 legacy 0 / repository 1 差异被双读报告识别。
- 模拟器清空后的独立重装：影子导入为 `completed`，repository 为 `consistent`，录音对账为 `completed`，没有应用进程 FATAL EXCEPTION。破坏性验证只发生在模拟器。
- 最新 Preview 在空数据模拟器独立安装并启动：应用进程持续存活；meeting、stage、Transcript count、Summary availability 均为 `consistent`，录音对账为 `completed`，没有应用进程 FATAL EXCEPTION。
- `LaoJi_API_35` 保留应用数据覆盖安装 v4 Preview：PackageManager 明确采用 `Retain data and using new`，随后冷启动成功；guest shadow import 为 `unchanged`、repository read 为 `consistent`、录音对账为 `completed`，没有应用进程 FATAL EXCEPTION。Preview 不可调试，因此不以越权方式导出模拟器私有数据库；v4 表与 revision/CAS 的结构验证由上述临时迁移契约承担。
- 显式开启 canonical read 的模拟器 Preview：空数据启动为 `active`；创建失败态会议后可见 meeting 为 1，非法/重复身份、missing/extra、顺序、标题、lifecycle、阶段、上下文、可见字段、Transcript 正文和 Summary 文本 mismatch 全为 0，读源保持 `active`。
- 同一模拟器长按删除后旧 Store 和可见 repository meeting 均为 0，SQLite 保留 1 个 legacy 删除墓碑；墓碑未被计为 `extra`、未泄漏到列表，读源继续为 `active`。再次冷启动时 v4 影子重建按设计回收该 legacy shadow 墓碑，计数回到 0，读源仍为 `active`。
- 真机无清数据覆盖安装 SQLite v3 Preview：升级前后脱敏计数均为 4 个 MeetingNote、7 个 Transcript segment、1 个 Summary version、4 个 Recording asset；首次启动 shadow v4 为 `completed`，missing/extra/duplicate/title/lifecycle/stage/Transcript/Summary/context mismatch 全为 0，应用进程持续存活。
- 真机再次冷启动：shadow v4 为 `unchanged`，上述计数与全部 mismatch 继续为 0，证明 source hash 与实际 v3 投影计数一致后可幂等跳过。
- API 35 模拟器受控 write opt-in：先保存全量 AVD 快照，再用内嵌 read=true/write=true 的 Preview 导入 2 秒 WAV。日志明确为 `canonical_revision=1`、`legacy_mirror_revision=1`、mirror `clean`；repository 可见会议从 1 增至 2，missing/extra/duplicate/order/title/lifecycle/stage/context/Transcript/Summary mismatch 全为 0，详情播放器识别 00:02 音频。
- 同一 opt-in 模拟器强制停止后冷启动：mirror 为 `unchanged`，repository 2→2，读源理由为 `canonical_owner_recovered`，两条列表记录和导入详情继续可见；没有应用 FATAL、React Native exception 或 SQLite error。随后加载预试快照，包安装时间和原始日程/会议数据恢复，测试音频与 canonical owner 未留在常用模拟器状态。
- API 35 模拟器受控游客根字段编辑：在全量 AVD 快照内开启 read/write 后，从真实会议详情标题编辑和录音页定位动作分别触发 `updateMeetingTitle`、`updateMeetingDetails`。标题和非空反向地理编码地址依次提交为 revision 1、2，legacy mirror 均在同 revision clean；强停冷启动后 mirror 为 unchanged 2/2，读源为 `canonical_owner_recovered`，标题、地点及 repository 1/1 全部 mismatch 为 0。协调补丁后的再次标题编辑为 revision 3/3 clean，写入期不再出现旧投影 fallback；空标题随后作为真实空字符串提交为 revision 4/4 clean，冷启动仍一致，会议列表只在展示边界显示“未命名会议”。日志无应用 FATAL、React Native exception 或 SQLite error。
- API 35 模拟器受控游客软删除：在独立全量 AVD 快照中开启 read/write，从原生会议卡片长按菜单确认永久删除。可见会议立即从 1 变为 0，mirror 为 clean 1/1，写入期没有旧记录 fallback，也没有调用 legacy delete shadow；强停冷启动后 mirror unchanged 1/1、legacy/repository 为 0/0、tombstone 为 2 且 mismatch 全零。关联日程仍保留，详情动作由“继续记录”恢复为“开始记录”。日志无应用 FATAL、React Native exception 或 SQLite error；快照随后恢复并删除。
- API 35 模拟器受控游客创建与 capture/asset：在全量应用数据备份内显式开启 read/write，先删除旧记录，再从真实录音入口创建并进入录音。revision 依次为删除 `1/1 clean`、创建 `2/2 clean`、开始录音 `3/3 clean`；会议服务不可达后保存为 revision `4/4 clean`。最终记录为 `ended + local`，capture 为 `failed_recoverable`、attempt 1、错误码 `recording_interrupted`；主资产保留相同 native session ID 且 local state 为 `missing`，legacy 投影为一条 `failed` 记录。强停冷启动后为 `canonical_owner_recovered`、revision `4/4`、1 条可见记录、2 个 tombstone，全部 mismatch 为 0；日志无应用 FATAL、React Native exception 或 SQLite error。测试后 RKStorage、canonical DB 与删除标记偏好逐项恢复为测试前 SHA，默认关闭开关的 Preview 覆盖安装后原始 `OccueneSmoke` 数据仍保留。服务不可达，因此真实暂停/恢复与带有效音频的 `local_ready` 路径没有运行验证。
- 临时游客 Transcript canonical 事务契约：通过。连续 6 次 revision 覆盖 realtime draft 创建和增长、final 激活、同一 immutable final 后补 remote revision ID、较长迟到 draft、明显较短 reprocessed final。结果保留 3 个 revision，active 始终为 3 段 final；迟到 draft 和短 final 均未降级 active，Summary 只在三次 active 内容真实变化时进入 stale。契约直接加载实际 use case 并注入内存 repository/digest，脚本执行后删除，不纳入轻量工作树；它不替代 Expo SQLite、真实录音或服务端验证。
- 本批默认关闭开关的 Preview 增量构建：`assemblePreview` 通过，627 个 task 中 59 个执行、568 个 up-to-date，JS bundle 重新生成，耗时 45 秒。APK 内可检出新 canonical Transcript 代码，内嵌 DB=true、canonical read=false、canonical write=false。
- `emulator-5556` 保留数据覆盖安装本批 Preview 后冷启动：应用进程存活，guest shadow 为 unchanged，legacy/repository 为 1/1、tombstone 1、全部 mismatch 为 0，`OccueneSmoke` 仍可见；没有应用 FATAL、React Native exception 或 SQLite error。默认 write 关闭，因此该检查只证明交付包和旧数据安全，不宣称真实 canonical Transcript UI 闭环。
- 临时游客 Summary canonical 实际函数契约：通过。直接调用严格模式的 `mirrorLegacySummaryContent`，4 次 canonical revision 保存 3 个 immutable version 和 3 个生成 action；覆盖初次激活、用户保护后只存候选、解除保护后激活、事务内 active Transcript 漂移后保留当前版本与阶段 fingerprint。realtime draft、canonical 主键错配和显式 Transcript revision 错配均 fail-closed 且不增加 revision；空结果不会清除非 legacy current。脚本执行后删除，不纳入轻量工作树；它不替代真实 Expo SQLite、服务端 Summary 或 UI 版本选择验证。
- 最终默认关闭开关的 Preview 增量构建：`assemblePreview` 通过，627 个 task 中 59 个执行、568 个 up-to-date，JS bundle 重新生成，耗时 48 秒。APK 内可检出 canonical Summary 过期输入保护代码，内嵌 DB=true、canonical read=false、canonical write=false。
- `emulator-5556` 保留数据覆盖安装最终 Preview 后冷启动：应用进程存活，guest shadow 为 unchanged，legacy/repository 为 1/1、tombstone 1、全部 mismatch 为 0，`OccueneSmoke` 与日程/会议入口仍可见；没有应用 FATAL、React Native exception 或 SQLite error。默认 write 关闭，因此该检查不宣称真实 canonical Summary UI 闭环。
- 临时账号上传实际用例事务契约：通过。直接加载 `ReconcileMeetingAudioUploadUseCase` 与 pending/WorkManager 状态归一化函数，9 次有效 canonical revision 覆盖 queued、uploading、WorkManager backoff、retryable failure、显式 retry、uploaded、同 operation 迟到失败、新 operation 替换资产、blocked 后 retry及本机文件缺失；相同证据为幂等 no-op，uploaded 不被迟到失败降级，attempt 单调且 operation ID/credential generation 保留，`file_missing` 同事务把 RecordingAsset 标为 missing。脚本执行后删除，不纳入轻量工作树；它不替代真实账号、WorkManager 网络请求或服务端验证。
- 账号上传开关组合：`account upload write` 只有 DB、canonical read、canonical write 和自身四项均开启时才为 true；缺少任一上游开关均强制 false。默认 Expo public config 为 DB=true、canonical read=false、canonical write=false、account upload write=false。
- 临时账号根同步/远端合并契约：通过。直接加载实际 create/update/delete、远端 merge、根消费者和原生传输协调器，覆盖同毫秒 create→update→delete 插入顺序、重复 operation 幂等、远端 ID 绑定、未完成根字段保护、墓碑不复活、远端列表缺项不删除、uploaded 不被延迟列表降级、同 scope drain 串行、旧 claim 失效后的新 claim 接管、retry/blocked/conflict/permanent 终态以及上传 local/remote ID 分离。脚本位于 `/tmp`，验证后删除，不纳入轻量工作树；它不替代 Expo SQLite、真实账号服务或 WorkManager 网络闭环。
- 账号根/上传开关组合：两项都要求 DB、canonical read、canonical write 及各自开关显式开启；默认输出五项依次为 true/false/false/false/false，基础 DB=false 时其余四项均强制 false。
- 本批最终默认关闭开关的 Preview 增量构建：`assemblePreview --parallel --max-workers=16` 通过，627 个 task 中 59 个执行、568 个 up-to-date，耗时 34 秒；APK 可检出 upload reconciler、credential generation fingerprint、WorkManager backoff 和脱敏 audit 代码。
- `emulator-5556` 保留数据覆盖安装本批 Preview 后冷启动：应用进程存活，guest shadow unchanged，legacy/repository 为 1/1、tombstone 1、全部 mismatch 为 0，`OccueneSmoke` 与日程/会议入口仍可见；没有应用 FATAL、React Native exception、SQLite exception 或 bundle load error。模拟器没有账号 pending upload 且会议服务不可用，因此本条只证明默认关闭包和旧数据安全，不宣称真实上传闭环。
- 账号 Store/根同步批次的最终默认 Preview：显式设置 DB=true、canonical read/write=false、account root/upload=false 后执行 `assemblePreview --parallel --max-workers=16`，627 个 task 中 79 个执行、548 个 up-to-date，1 分 34 秒通过。直接读取 APK `assets/app.config` 再次确认五项开关为 true/false/false/false/false。
- 同一 `emulator-5556` 保留数据覆盖安装并冷启动：PackageManager `lastUpdateTime` 更新，启动状态为 COLD 且进程持续存活；日历页仍有 `OccueneSmoke`，会议页仍有同名失败态记录，repository 为 consistent、legacy/repository 1/1、tombstone 1、全部 mismatch 为 0；没有应用 FATAL、React Native exception、SQLite exception 或 bundle load error。当前无 USB 真机，因此不宣称真实账号同步或上传闭环。
- 游客普通包 cutover：默认 flags=`true/true/true/false/false` 的 Preview 对保留数据覆盖安装后，预检为 `canonical_projection_ready`，legacy/repository 1/1、tombstone 2，身份、顺序、标题、lifecycle、阶段、上下文、Transcript 与 Summary mismatch 全为 0。详情页把原标题临时改为验证值时首次 canonical mutation 得到 owner=`canonical`、revision/mirror=`1/1 clean`；强停冷启动以 `canonical_owner_recovered` 恢复。改回原标题后为 `2/2 clean`，第二次冷启动仍一致。停止进程后用同签名 Debug 变体只读导出，SQLite `quick_check=ok`，canonical 根与 RKStorage fallback 副本标题一致。随后恢复 `codex-laoji-cutover-pretest-20260725` 快照并重新覆盖当前 Preview；常用模拟器回到无 owner 的原始数据，启动理由恢复为 `canonical_projection_ready`，未残留验证标题。

## 当前安装包

- 路径：`android/app/build/outputs/apk/preview/app-preview.apk`
- 包名：`com.laoji.app`
- 版本：`1.0.0-source-preview`（versionCode 101）
- 大小：90,447,528 bytes
- SHA-256：`16d55464447eb07ed2ad2ce0b25a695242aa2633d8ebd97ffdeb0c33b67fed15`
- 构建时间：`2026-07-25 22:05:30 +0800`
- 内嵌开关：`localMeetingDbV1=true`、`localMeetingDbCanonicalReadV1=true`、`localMeetingDbCanonicalWriteV1=true`、`localMeetingDbAccountRootWriteV1=false`、`localMeetingDbAccountUploadWriteV1=false`
- 安装状态：本包已在 `emulator-5556` 对恢复后的预试数据保留覆盖安装，`lastUpdateTime=2026-07-25 22:13:07`；冷启动 repository 为 consistent、legacy/repository 为 1/1、tombstone 2 且 mismatch 全零，原始 `OccueneSmoke` 会议记录可见，没有应用 FATAL。当前没有 USB 真机，真机 4/7/1/4 基线复核留待重连。

## 未决项与停线边界

1. 游客普通包已完成 canonical cutover；这只证明本机游客事实源和回退镜像成立，不等价于部署服务已支持账号字段、幂等、冲突和空值语义。账号根写及上传开关继续默认关闭。
2. broad canonical flag 不授权账号取得 owner。只有真实账号 create/update/delete/upload、离线重试、冷启动恢复和回滚闭环后，账号根写/上传开关才可进入普通包。
3. 账号 outbox 已能从持久时间重建唤醒，但尚无真实 pending registry/WorkManager 网络请求、进程强杀后的定时恢复、服务端成功/失败、跨设备刷新或冲突闭环；服务不可达，账号 Transcript/Summary 也没有真实 Expo SQLite/UI 内容闭环。大数据量性能、真实 mirror I/O 故障和授权 USB 真机 cutover 均未完成。
4. 本批已通过一台授权真机的无损升级计数，但后续任何 canonical cutover 仍须保持 4 个 MeetingNote、7 个 Transcript segment、1 个 Summary version、4 个 Recording asset 的计数下限且不得清除真机数据。
5. 线上 MeetingNote v2 契约仍未验证，不得发送探测性 v2 写请求或开启 v2 capability；本批根 outbox 已接旧 API 消费器，但只能在独立实验开关、已通过 preflight 的 canonical owner 和真实授权账号下验证，不得进入普通包。
