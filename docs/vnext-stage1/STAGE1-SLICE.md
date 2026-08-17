# vNext Stage 1 纵向切片

状态：`in progress`，不是 Stage 1 exit gate。

## 已实现

- 移动端 0040–0042 迁移，包含设备 epoch、会议服务 binding、device operation、cutover tombstone、不可变笔记/附件来源和 Q2 表。
- 0042 的列添加使用 `PRAGMA table_info` 探测，进程在 DDL 后中断时可以安全重放。
- `src/data/repositories/vnext/` 提供设备权威、binding、operation 和 immutable source repository。
- `deviceTranscriptTasks` 由 SQLite `device_operations` 承担持久 owner；旧 AsyncStorage 只保留一次性逐项 promotion 适配器，不再作为新写入 owner。
- 删除会议时转写 operation 进入 `cancelled`，不再把未完成工作伪装成成功。
- 服务端新增隔离的 `/api/device/v1/vnext/*` binding/task/attempt 合同和 SQLite durable task/attempt owner；旧 v1 路由未切换。

## 证据

- `npm exec -- tsc --noEmit --pretty false`：通过。
- `python3 tools/vnext/verify_stage1_migrations.py`：通过，包含 DDL 重放、来源指针和外键检查。
- `PYTHONPATH=. ../../.venv-vnext/bin/pytest -q tests/test_device_v1_contract_static.py tests/test_vnext_task_store.py`：9 passed。
- `python3 -m compileall -q services/laoji-api/app services/laoji-api/tests`：通过。

## 尚未满足的 Stage 1 退出门

- meeting/schedule/action/note 写入尚未全部收敛到 canonical repository transaction。
- 旧同步 outbox 尚未停止新写，仍处于兼容 drain 前。
- 本机清除协调器尚未覆盖全部录音、通知、更新文件和 native projection。
- 新 vNext task API 尚未激活 capability barrier，也未接管生产业务调用。

生产 API、生产数据库、公网入口、真机、GPU 和同机其他服务均未修改。
