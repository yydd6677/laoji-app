# Stage 4 exit preflight (2026-08-19)

状态：`blocked; candidate-only; read-only`。

`tools/vnext/verify_stage4_exit_preflight.py` 聚合日程、语音日程、FTS、ProjectionEnvelope、候选能力和
旧 schedule submit 零流量门。它严格区分静态/迁移合同与真实 Android/人工质量 envelope；缺少任一项
或低于蓝图阈值时返回非零，不启用 Graph capability，不修改生产。

要求的运行证据包括：独立人工日程 holdout（至少 30 条、字段完全正确率 >=95%、关键字段召回率
>=98%、保存错误 0）、语音采集/首文字/Draft p95、全局 SQLite/页面重建/stale action/状态稳定回放、
FTS p95、显式标签 owner 和一个完整旧 schedule submit 零流量公开周期。

当前运行：

- Stage 4 migration：通过，12,000 条搜索 workload p95 约 `23.8ms`；
- Projection checkpoint：通过首次、幂等、stale、新版本和 SQLite reopen 回放；
- Graph owner、移动端 owner、语音采集顺序：通过静态门；
- Projection action fence：完整身份字段与 calendar/recording/transcript 三页面前置接线通过静态门；
- 日程服务端聚焦回归：`103 passed`；
- 候选 `1.1.31 (139)` 已完成三页面 checkpoint recreate 和会议详情 tab 视频抽帧回放；收口代码已以
  `1.1.33 (141)` 重建并覆盖安装到同一专用模拟器，见
  [ProjectionEnvelope 全局 Android 回放](PROJECTION-GLOBAL-ANDROID-REPLAY-20260820.md)；2026-08-21
  又以真实 native gesture -> JS bridge -> 新快照 -> 旧 action 恢复的时序验证了
  `projection_stale` 拒绝且业务数据未改变。人工质量、语音 p95 和公开周期仍阻断，因此聚合预检保持
  `passed=false`。

2026-08-21 的 5 次真实中文音频模拟器回放把语音门从“缺证据”推进为“已实测失败”：采集启动
p95 `125ms`（目标 `<=100ms`），首文字 p95 `9256ms`（目标 `<=1500ms`）。当前 VAD 闭段后调用 batch
ASR 的路径不是增量解码；继续压缩静音门会损害断句和句尾动作，不能作为通过方式。详见
[语音日程真实音频回放](SCHEDULE-VOICE-EMULATOR-REPLAY-20260821.md)。Stage 4 需要同一 ASR owner 下的
真正 streaming backend；当前 GPU0 余量不足且 GPU1 不在授权范围，候选未部署，预检继续失败关闭。

2026-08-20 起，日程质量不再接受手填的 `independent_human_adjudication` 布尔值和指标。
`schedule_quality_lineage` 要求由
[自然日程盲审与质量证据包](NATURAL-HOLDOUT-EVIDENCE-PACK-20260820.md)生成并封存的
`schedule-human-holdout-v1` 报告；旧格式会 fail closed。该变化只收紧证据入口，没有伪造人工 gold，
因此当前退出状态仍为 blocked。

这不是 Stage 4 退出证明。候选 Graph、旧 `/parse`、生产 `18020/8030` 和公网流量未改变。
