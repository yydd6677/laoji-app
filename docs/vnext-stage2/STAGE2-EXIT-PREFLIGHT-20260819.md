# Stage 2 exit preflight (2026-08-19)

状态：`blocked; candidate-only; read-only`。

## 新增工具

`tools/vnext/verify_stage2_exit_preflight.py` 是 Stage 2 barrier 前的唯一聚合预检入口。它读取外部
证据 envelope，可选只读检查 candidate SQLite 和 loopback `/ready`，然后对每个退出门输出
`passed/blocked`。它不会启动服务、修改 SQLite、激活 capability、停止进程或删除旧代码。

预检要求证据明确提供：

- 专属 Android candidate APK、进程死亡恢复、网络切换恢复、页面投影无重复和 `NO_SPEECH` 成功；
- API/ASR ready；实时 p95、导入 RTF、首段 p95、API/总 RSS、CPU、临时盘和 GPU0 余量；
- candidate Task/cleanup 已排空；
- 一个外部记录的旧 upload/ASR submit 零流量公开周期。

缺少任意字段或类型不对时保持阻断，不用源码测试、单次样本或文档推断替代运行证据。

## 当前结果

- `python3 tools/vnext/verify_stage2_exit_preflight.py`：按无证据运行，正确返回 `passed=false`。
- `python3 tools/vnext/verify_stage2_exit_preflight.py --evidence docs/vnext-stage2/stage2-concurrency.json`：
  由于该旧报告不是完整 envelope，所有未提供的门保持 blocked；不会把 `stage2-concurrency.json`
  的单次回放当作 p95 通过。
- `PYTHONPATH=. .venv-vnext/bin/python -m pytest -q tools/vnext/test_verify_stage2_exit_preflight.py`：`3 passed`。
- `python3 tools/vnext/verify_stage2_android_contract.py`：通过。

## 阻断结论

当前真实外部状态仍缺专属 Android 实例；已知候选 realtime 单次墙钟约 `16.224s`，高于蓝图稳态
`p95 <= 2s` 目标；完整总 RSS、GPU0 安全余量和旧公开零流量周期也没有合格 envelope。因此该工具
当前应保持非零退出，Stage 2 capability barrier 不能激活，生产 `18020/8030` 和旧链路未触碰。

