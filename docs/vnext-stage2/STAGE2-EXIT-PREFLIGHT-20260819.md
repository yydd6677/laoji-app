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

2026-08-21 已补交完整 candidate evidence envelope，并以隔离 `18031`、GPU0 `8031`、
`emulator-5562` 和只读 SQLite backup 执行聚合预检。20 个运行/资源门中 19 个通过；Android candidate、
网络中断恢复、进程死亡恢复、页面投影无重复、`NO_SPEECH` 成功、混合负载资源和 cleanup 均已有真实证据。
机器可读输入与结论分别为 `stage2-exit-evidence-20260821.json` 和
`stage2-exit-preflight-20260821.json`，设备回放见
[Android v2 网络与进程恢复](ANDROID-V2-NETWORK-PROCESS-RECOVERY-20260821.md)。

## 阻断结论

2026-08-20 的 GPU0 全链路和混合负载证据已关闭首段、RTF、realtime、RSS、CPU、临时盘及 GPU0
安全余量；2026-08-21 的 Android v2 回放又关闭设备恢复、连续投影、去重、`NO_SPEECH` 和清理门。
当前聚合预检唯一阻断为 `legacy_submit_zero_public_cycle`：尚无外部公开周期的旧 upload/ASR submit
零流量记录。更广的 Stage 2 退出仍需独立 CER/数字时间及已登记/未知讲话人质量证据，并需正式 8030
部署 v2 handler 后才能人工激活 capability barrier。因此工具继续非零退出，生产 `18020/8030`
配置和旧链路均未改变。
