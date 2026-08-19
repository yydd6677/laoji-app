# Stage 2 实时 ASR drain 批量化

状态：`implemented in isolated candidate; runtime performance not yet proven`。

## 修改

`services/laoji-api/app/services/vnext_realtime_pipeline.py` 现在区分两条严格等价的推理入口：

- 一个 VAD drain 只产生一个新片段时，继续调用单段实时接口，避免人为增加等待窗口；
- 同一 drain 产生多个新片段时，使用现有 `/v2/asr/batch` 合同执行一次 realtime 批量推理，而不是在
  API worker 内逐段串行等待多个模型调用。

批量响应先对所有 item 的稳定 ID、源时间范围和数量做完整校验。任意 item 缺失或范围不匹配时，本批
不会提交任何 durable transcript event；全部通过后才按输入顺序逐段持久化和发布。已有稳定片段仍按
stable key 跳过，单调 event sequence、先持久化后发布和异步 speaker overlay 边界不变。

## 证据

- 新增 `tests/test_vnext_realtime_batching.py`，覆盖一个 drain 只调用一次 batch、源时间顺序提交，以及
  第二项错误时第一项也不得提前提交。
- Stage 2 realtime/import/speaker/ASR 聚焦回归：`41 passed`。
- `python3 tools/vnext/verify_stage2_android_contract.py`：通过。
- `python3 -m compileall` 与 `git diff --check`：通过。

## 未扩大声明

该修改消除了 API 侧可以避免的逐段串行调用，但没有制造实时延迟结论。服务器隔离 8031 当前仍以 CPU
运行，最近一次 8 段 offline batch 的真实推理为 `28,189ms`；生产 8030 的 GPU 结果不能直接当作候选
realtime p95。必须将本版本部署到隔离 18021/8031，使用 GPU0 但不改变生产进程，完成多次真实
realtime 回放后，才能判断 Stage 2 的 `p95 <= 2s` 是否通过。

本切片未安装 APK、未激活 capability barrier、未修改生产 `18020/8030`、GPU1、PCB 或 Smart Meeting。
