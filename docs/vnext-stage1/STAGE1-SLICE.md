# vNext Stage 1 纵向切片

状态：`in progress`，不是 Stage 1 exit gate。

## 已实现

- 移动端 0040–0042 迁移，包含设备 epoch、会议服务 binding、device operation、cutover tombstone、不可变笔记/附件来源和 Q2 表。
- 0042 的列添加使用 `PRAGMA table_info` 探测，进程在 DDL 后中断时可以安全重放。
- `src/data/repositories/vnext/` 提供设备权威、binding、operation 和 immutable source repository。
- `deviceTranscriptTasks` 由 SQLite `device_operations` 承担持久 owner；旧 AsyncStorage 只保留一次性逐项 promotion 适配器，不再作为新写入 owner。
- 删除会议时转写 operation 进入 `cancelled`，不再把未完成工作伪装成成功。
- 本机清除新增独立 SecureStore purge-only journal：只记录 epoch、状态和时间；清除超时保留
  `pending`，应用启动会幂等重试，确认远端清理后才删除设备身份和 journal。
- 本机日程 repository 的单行 upsert/delete 改为同一 SQLite 事务内的行级操作，避免旧的“读全表再替换”
  在快速连续编辑时互相覆盖；现有批量替换仅用于一次性迁移/恢复。
- 服务端新增隔离的 `/api/device/v1/vnext/*` binding/task/attempt 合同和 SQLite durable task/attempt owner；旧 v1 路由未切换。
- binding/epoch 删除会在 generic task store 内原子取消活跃 task/attempt，迟到 worker 只能得到终态拒绝，
  不会在本机清除后继续提交 artifact。
- 普通整理恢复 intent 已落到 SQLite `device_summary_task_intents`；AsyncStorage 的旧注册表只做逐条
  promotion，不能再产生新任务 owner。模板、指纹、任务 ID 和明确授权来源元数据可在进程重启后恢复。

## 证据

- `npm exec -- tsc --noEmit --pretty false`：通过。
- `python3 tools/vnext/verify_stage1_migrations.py`：通过，包含 DDL 重放、来源指针和外键检查。
- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_device_v1_contract_static.py tests/test_vnext_task_store.py tests/test_device_v2_identity.py`：11 passed。
- `python3 -m compileall -q services/laoji-api/app services/laoji-api/tests`：通过。
- `python3 tools/vnext/verify_stage1_exit.py`：8 项静态 owner/fence/auth 检查通过，并报告
  `android_native_compile=passed`；`v2_purge_capability=blocked`，因此 exit gate 仍阻塞。
- 两个后续切片提交：`52e79fe`（purge journal）、`0a471c5`（日程行级写入）。
- 绑定清除 fence 提交：`3111a84`（本机 operation）、`d2d2177`（服务端 generic task）。
- 整理恢复 owner 提交：`c2ad18d`。
- v2 auth 隔离提交：`9765edb`、`81bcb4d`；服务端已具备 P-256 bootstrap/auth challenge、18-bit PoW、
  15 分钟 bearer、challenge 单次消费、bootstrap/auth 限流和旧/新密钥双签名轮换测试，但尚未接入
  Android Keystore、purge capability，不能切换生产。
- Android Keystore bridge 提交：`65c4708`；新增不可导出 P-256 生成/签名/轮换/删除接口，`fe98679`
  将其纳入本机身份清除；隔离树已完成 native 编译。
- v2 API client/native PoW 提交：`f6b5829`；已实现 token 缓存、bootstrap/auth 请求和 native PoW 调用。
  编译证据见本目录 `android-compile-evidence.txt`；这不等于 APK 安装、真机运行或 v2 网络验收。

## 尚未满足的 Stage 1 退出门

- 当前 accountless `guest` 运行路径的 meeting/schedule/action/note 写入已走本机 repository transaction；
  仍需完成静态审计和旧 account 类型路径的彻底移除，才能把 owner 唯一性从运行时保证提升为代码边界。
- guest scope 的旧 `sync_outbox` 新写已在 repository 入口硬阻断；account 兼容代码和历史 outbox 仍保留到
  Stage 5 删除门，尚未完成全量 drain 计数与删除审计。
- 本机清除已覆盖录音、通知、更新文件和 native projection；仍缺少独立 Keystore purge-only capability
  的原生实现和清除 journal 的端到端回放测试。
- 新 vNext task API 尚未激活 capability barrier，也未接管生产业务调用。
- 设备 v2 仍未完成 purge capability、v1 业务路由迁移和真机回放；当前业务 API 仍保留 v1
  静态设备凭据兼容层。

生产 API、生产数据库、公网入口、真机、GPU 和同机其他服务均未修改。
