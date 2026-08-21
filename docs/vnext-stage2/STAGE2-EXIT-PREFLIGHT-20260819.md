# Stage 2 exit preflight (2026-08-19)

状态：`blocked; candidate-only; read-only`。

## 新增工具

`tools/vnext/verify_stage2_exit_preflight.py` 是 Stage 2 barrier 前的唯一聚合预检入口。它读取外部
证据 envelope，可选只读检查 candidate SQLite 和 loopback `/ready`，然后对每个退出门输出
`passed/blocked`。它不会启动服务、修改 SQLite、激活 capability、停止进程或删除旧代码。

预检要求证据明确提供：

- 专属 Android candidate APK、进程死亡恢复、网络切换恢复、页面投影无重复和 `NO_SPEECH` 成功；
- API/ASR ready；实时 p95、导入 RTF、首段 p95、speaker overlay p95、API/总 RSS、CPU、临时盘和
  GPU0 余量；
- 带完整血缘的 `media-human-quality-v1`：双人盲审/裁决、CER 中位数与 p95、数字时间准确率、
  已登记讲话人 duration-weighted attribution F1 和未知人强行命名率；
- candidate Task/cleanup 已排空；
- 一个外部记录的旧 upload/ASR submit 零流量公开周期。

缺少任意字段或类型不对时保持阻断，不用源码测试、单次样本或文档推断替代运行证据。

## 当前结果

- `python3 tools/vnext/verify_stage2_exit_preflight.py`：按无证据运行，正确返回 `passed=false`。
- `python3 tools/vnext/verify_stage2_exit_preflight.py --evidence docs/vnext-stage2/stage2-concurrency.json`：
  由于该旧报告不是完整 envelope，所有未提供的门保持 blocked；不会把 `stage2-concurrency.json`
  的单次回放当作 p95 通过。
- `PYTHONPATH=tools/vnext .venv-vnext/bin/pytest -q tools/vnext/test_verify_stage2_exit_preflight.py
  tools/vnext/test_media_quality_evidence.py`：`7 passed`。
- `python3 tools/vnext/verify_stage2_android_contract.py`：通过。

2026-08-21 先补交了运行/资源 candidate evidence envelope，并以隔离 `18031`、GPU0 `8031`、
`emulator-5562` 和只读 SQLite backup 执行聚合预检。20 个运行/资源门中 19 个通过；Android candidate、
网络中断恢复、进程死亡恢复、页面投影无重复、`NO_SPEECH` 成功、混合负载资源和 cleanup 均已有真实证据。
机器可读输入与结论分别为 `stage2-exit-evidence-20260821.json` 和
`stage2-exit-preflight-20260821.json`，设备回放见
[Android v2 网络与进程恢复](ANDROID-V2-NETWORK-PROCESS-RECOVERY-20260821.md)。

同日质量门复核发现上述 20 门并未把蓝图已经要求的 CER、数字时间和讲话人质量纳入机器判定，因而
“19/20”只能称为历史运行/资源子集，不能称为 Stage 2 聚合退出结果。预检 schema v2 已补入
speaker overlay 至少 30 条样本及 p95、严格 `media-human-quality-v1` 血缘和五项质量阈值。随后在隔离
候选完成 30 次真实 speaker overlay 暖态回放，`30/30` 成功，p95 为 `629.6 ms`，binding/epoch 清理均
确认；质量感知 envelope 现在为 `20/28`。剩余 8 个阻断为：质量血缘、独立人工 holdout、CER
中位数/p95、数字时间、已登记 attribution F1、未知人强行命名率和公开零旧提交周期。旧 SQLite
只读审计仍是历史已通过证据，但本次命令未把临时 backup 路径作为附加门重新传入。overlay 证据见
[30 次暖态回放](SPEAKER-OVERLAY-WARM30-20260821.md)。

10 组视频/SRT 的 30 窗口弱参考诊断见
[ASR 弱字幕诊断](ASR-SRT-WEAK-DIAGNOSTIC-20260821.md)。结果可定位校正窗口，但 SRT 有错漏，合同强制
`promotion_eligible=false`，不会关闭任何人工质量门。

同日补齐了从双盲 review、独立裁决冻结、后置 predictions 到五项质量指标和最终血缘报告的确定性
生成器，见 [ASR/讲话人独立人工质量证据链](MEDIA-HUMAN-QUALITY-EVIDENCE-20260821.md)。它同时拒绝
第一方晋级音频与 development manifest 的任何哈希重叠。现有会议样本已参与多领域开发与诊断，只能
继续做回归，不能重新包装为独立晋级集；因此完整质量门仍等待新的第一方音频和真实人工流程。

## 阻断结论

2026-08-20 的 GPU0 全链路和混合负载证据已关闭首段、RTF、realtime、RSS、CPU、临时盘及 GPU0
安全余量；2026-08-21 的 Android v2 回放又关闭设备恢复、连续投影、去重、`NO_SPEECH` 和清理门。
当前运行/恢复/overlay 性能子集只有 `legacy_submit_zero_public_cycle` 一个阻断，但完整 Stage 2 聚合
退出还缺上述独立媒体质量门与公开零旧提交周期。生产 8030 已在 2026-08-21 获准维护窗口部署 v2
handler，完成真实 legacy/v1/v2/NO_SPEECH/batch 复验；隔离 18030 直连 8030 后完成真实导入及 API
中断恢复，旧 8031 代理已停止。该部署证据见
[8030 v2 handler 切换结果](ASR-V2-8030-CUTOVER-CANDIDATE-20260821.md)，但它不替代人工质量、公开
周期或 capability 人工采用。因此工具仍应非零退出，生产 `18020`、公网和旧提交路径保持不变。
