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

2026-08-20 的 30 条真实全链路回放已为选定 GPU0 架构提供 `first_segment_p95_ms=2877` 和
`import_rtf_p95=0.140411`，这两个数值门已单独通过，见
[校验媒体复用与 GPU0 回放](VERIFIED-MEDIA-CACHE-GPU-20260820.md)。但当前仍缺专属 Android 的网络/
进程恢复和端到端 realtime p95，以及完整总 RSS、GPU0 安全余量、质量门和旧公开零流量周期；正式
8030 也尚未部署 v2 handler。因此还不能形成全字段合格 envelope，该工具必须继续非零退出，Stage 2
capability barrier 不能激活，生产 `18020/8030` 配置和旧链路均未改变。
