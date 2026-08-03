# Phase 5 到期物理清理证据：PRIV-01

状态：账号会议的 30 天回收站现已接通服务端与本机到期物理清理纵切。实现只处理已由远端确认删除且恢复窗口已经结束的 tombstone；网络失败、陈旧 capability、未完成根同步、根冲突或未完成录音合并都不会降级为物理删除。当前服务与本机均没有真实到期会议，因此证据是运行服务 schema/调度、真实数据库副本夹具和本机 v27 窄合同，不把它写成真实用户数据已经到期销毁。

## 本机事务与文件合同

- migration v27 新增无 Meeting 外键的 `meeting_retention_cleanup_jobs`。账号 provider 在启动、回前台及六小时周期先恢复旧清理任务，再强制读取 fresh `meeting_notes_v2 + soft_delete_days`；能力不可达时只继续已提交的文件清理，不选择新的 tombstone。
- 只有 `lifecycle=deleted`、`sync_state=deleted`、保留了 `deleted_from_lifecycle`、具备远端 ID/revision 且已超过当前服务端期限的账号根可进入清理。未完成 root outbox、未解决 root conflict 和未完成 occurrence 录音合并均 fail closed；游客和本机永久删除不走该后台路径。
- SQLite 事务先保存 canonical/navigation ID 和录音、附件、媒体片段的本机 URI，再删除 completed outbox/conflict、detached history 和 MeetingNote。Meeting 外键级联清除 Transcript/Summary/人工笔记/行动项/附件/片段/讲话人/问答等子内容，并推进 canonical revision。
- DB 提交后幂等清理 pending upload、Transcript/Summary 恢复项、WorkManager、原生录音/导入/片段目录、播放器缓存、附件目录和通知。进程在 DB 删除后强杀时，独立 job 仍在；文件删除后强杀时，下一次重复删除仍安全。只有全部外部清理成功才移除 job。
- 本机 SQL 窄合同真实应用 v1→v27 migration。只有一个 expired+synced 夹具被选择；未到期、delete 尚未同步和存在 pending merge 的三条记录均保留。夹具的人工笔记、录音、附件和片段级联为 0，三个文件 URI 留在 durable job，`foreign_key_check/integrity_check=ok`。

## 服务端事务与文件合同

- 目标 18020 新增 `meeting_retention_cleanup_jobs_v2` 和六小时后台任务，启动时立即运行。每批最多 20 条，只选择 `meeting_note_roots_v2.lifecycle=deleted` 且 `deleted_at <= now-30d` 的当前所有者记录。
- 服务端先在同一事务保存 `meetings.audio_path`、`meeting_segments.audio_path` 与全部 RecordingAsset `storage_path`；SQLite 使用 `BEGIN IMMEDIATE`，PostgreSQL 使用 `SERIALIZABLE`，再显式清除四类历史 NO ACTION 子表并删除 Meeting。其余 root/operation、occurrence、manual note、action/share、question、RecordingAsset/job 和 speaker 表由外键级联。
- 文件任务只允许删除 `settings.audio_storage_abs_path` 内的普通文件；越界、目录或无效 JSON 均保留 job 并记稳定错误码。DB 删除后、文件删除前崩溃可恢复，文件删除后、job ACK 前崩溃可幂等重放。
- 真实 `local.db` 副本加入 expired 与 recent 两条夹具、RecordingAsset、Transcript、segment 及两个临时 WAV 后，单次任务返回 `queued=1/completed=1/failed=0`；expired 及子内容和两个文件均消失，recent 保留。副本原有 7 条历史外键孤儿前后不变，`integrity_check=ok`。

### 多 worker 调度归属补充

- 清理循环在 PostgreSQL 每轮执行前获取固定命名空间的事务级 advisory lock；锁未取得的 worker 跳过整轮，不能进入队列扫描或文件删除。事务结束、取消或连接异常会自动释放锁，不留下连接级孤儿锁。
- SQLite 仅承诺单进程 scheduler；进程内使用串行锁，跨进程由既有 `BEGIN IMMEDIATE` 与唯一会议约束保证队列幂等。多进程 SQLite 开发部署必须只启一个 scheduler，或关闭内置监督并交给外部调度器。
- 两个完整候选源和本地部署 overlay 的静态合同均通过，SQLite 探针无重叠；一次性 PostgreSQL 16 loopback 两连接抢锁探针通过（持锁连接 `true`，第二连接 `false`）。证据：`tools/service-quality-evidence/svc09/svc09-retention-scheduler-guard-r1.json`。overlay 修改前备份位于 `/home/yydd/桌面/light_plan/server-work/backups/20260802-retention-scheduler/`。

## 运行部署证据

- 部署备份：`/home/zhong/laoji-service-platform/backups/20260726-retention-cleanup-v1`。只重启目标 18020：PID `149237 → 248982`；18035 PID `3293181` 与旧工作区 8020 PID `2152` 未动。
- 运行文件 SHA-256：`app_meeting_schema.py=f65cc786…b848`、`meeting_retention_service.py=3e3d01a…2444`、`app/main.py=6b3041c…07e1`。启动后 health/capability 正常，`meeting_retention_cleanup_jobs_v2` 已存在，`integrity_check=ok`。
- 部署时服务端 cutoff 为 `2026-06-26`，真实数据库 eligible=0；现有 7 条回收站记录均从 7 月 25 日以后删除，cleanup jobs=0，因此本次没有借验证名义提前删除真实记录。
- 移动端 `npx tsc --noEmit`、`git diff --check` 与 Preview 整包通过；assemble 为 627 tasks、59 executed。APK 构建时间 `2026-07-26 10:33:33 +0800`，大小 `90,786,232` bytes，SHA-256 `1a430c08899aa3e512fa878049283dbd72cd76d08f6ce6a3568500a6fe14ad9f`。
- APK 已保留数据覆盖安装唯一设备 `emulator-5556`，版本 code 104；`com.laoji.app/.MainActivity` resumed，启动日志未发现应用 FATAL、SQLite 缺表/缺列或 retention cleanup failure。Preview 不可 `run-as`，因此没有把设备内 `user_version=27` 写成已直接读取的证据。

## 未完成证据边界

1. 没有真实等满 30 天的用户会议；运行证据证明调度、schema、单 scheduler 归属和“零到期安全”，真实销毁行为来自隔离副本夹具。
2. 本机尚未用带真实 WorkManager、播放器缓存、通知、附件和多段录音的同一账号组合做高成本到期抽查；该组合与 USB 真机留在候选版。
3. 尚未在生产 systemd/容器编排中验证 scheduler 角色注入、PostgreSQL 故障转移、连接池耗尽、吞吐、重启恢复或两小时 soak；`promotion_eligible=false` 保持。
4. 共享服务器仍有既存的 7 条 `final_summaries → meetings` 历史孤儿；本切片未增加，也没有越界清理与当前 tombstone 无关的旧数据。
