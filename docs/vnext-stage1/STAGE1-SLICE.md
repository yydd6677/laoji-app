# vNext Stage 1 纵向切片

状态：`passed in isolated worktree`。未切生产 capability barrier。

## 已实现

- 移动端 0040–0042 迁移，包含设备 epoch、会议服务 binding、device operation、cutover tombstone、不可变笔记/附件来源和 Q2 表。
- 0042 的列添加使用 `PRAGMA table_info` 探测，进程在 DDL 后中断时可以安全重放。
- `src/data/repositories/vnext/` 提供设备权威、binding、operation 和 immutable source repository。
- `deviceTranscriptTasks` 由 SQLite `device_operations` 承担持久 owner；旧 AsyncStorage 只保留一次性逐项 promotion 适配器，不再作为新写入 owner。
- 删除会议时转写 operation 进入 `cancelled`，不再把未完成工作伪装成成功。
- 本机清除使用 Android Keystore 独立 alias 保护的原生 purge-only capability journal；secret 不经过
  JS/SecureStore。旧 SecureStore 行只作为 v1 epoch close 的兼容 journal，并已更名隔离。
- 本机日程 repository 的单行 upsert/delete 改为同一 SQLite 事务内的行级操作，避免旧的“读全表再替换”
  在快速连续编辑时互相覆盖；现有批量替换仅用于一次性迁移/恢复。
- 服务端新增 v2 bearer 的 binding 与 generic task create/read/cancel 合同；attempt claim/commit 只属于
  worker owner，不暴露给设备 bearer。旧 v1 路由未切换。
- binding/epoch 删除会在 generic task store 内原子取消活跃 task/attempt，迟到 worker 只能得到终态拒绝，
  不会在本机清除后继续提交 artifact。
- 普通整理恢复 intent 已落到 SQLite `device_summary_task_intents`；AsyncStorage 的旧注册表只做逐条
  promotion，不能再产生新任务 owner。模板、指纹、任务 ID 和明确授权来源元数据可在进程重启后恢复。

## 证据

- `npm exec -- tsc --noEmit --pretty false`：通过。
- `python3 tools/vnext/verify_stage1_migrations.py`：通过，包含 DDL 重放、来源指针和外键检查。
- 聚焦后端合同与清理套件：19 passed，命令和边界见 `backend-test-evidence.txt`。
- `python3 -m compileall -q services/laoji-api/app services/laoji-api/tests`：通过。
- `python3 tools/vnext/verify_stage1_exit.py`：owner/fence/auth/purge/rollback、后端测试和原生编译证据门
  均通过，输出 `stage1_exit=passed_isolated`。
- 两个后续切片提交：`52e79fe`（purge journal）、`0a471c5`（日程行级写入）。
- 绑定清除 fence 提交：`3111a84`（本机 operation）、`d2d2177`（服务端 generic task）。
- 整理恢复 owner 提交：`c2ad18d`。
- v2 auth 隔离提交：`9765edb`、`81bcb4d`；服务端已具备 P-256 bootstrap/auth challenge、18-bit PoW、
  15 分钟 bearer、challenge 单次消费、bootstrap/auth 限流和旧/新密钥双签名轮换测试；本切片现已
  接入 Android Keystore 和 purge capability，但生产仍未切换。
- Android Keystore bridge 提交：`65c4708`；新增不可导出 P-256 生成/签名/轮换/删除接口，`fe98679`
  将其纳入本机身份清除；隔离树已完成 native 编译。
- v2 API client/native PoW 提交：`f6b5829`；已实现 token 缓存、bootstrap/auth 请求和 native PoW 调用。
  编译证据见本目录 `android-compile-evidence.txt`；这不等于 APK 安装、真机运行或 v2 网络验收。

## 后续切换门，不属于隔离 Stage 1 退出声明

- 当前 accountless `guest` 运行路径的 meeting/schedule/action/note 写入已走本机 repository transaction，
  owner 写入硬门已通过；旧 account 类型声明和只读兼容模块的物理删除留在 Stage 5。
- guest scope 的旧 `sync_outbox` 新写已在 repository 入口硬阻断；account 兼容代码和历史 outbox 仍保留到
  Stage 5 删除门，尚未完成全量 drain 计数与删除审计。
- 原生 journal 的进程中断/真实 HTTP 回放仍需在后续模拟器/候选服务验收中完成；当前已有 Kotlin 编译、
  JS 类型检查和服务端 exact purge 测试，不伪称真机验证。
- 新 vNext task API 尚未激活 capability barrier，也未接管生产业务调用；v1 静态凭据仍保留一个发布
  周期的显式兼容。
- legacy submit/read/active lease 的公开周期计数与最终 drain 属于逐 capability 切换门。

生产 API、生产数据库、公网入口、真机、GPU 和同机其他服务均未修改。
