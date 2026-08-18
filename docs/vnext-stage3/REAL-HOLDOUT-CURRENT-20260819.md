# Stage 3 当前真实来源回放

状态：`isolated candidate evidence; not adopted`。

## 来源边界

回放使用 `/home/yydd/下载/会议视频样本` 当前快照中的同名 SRT 窗口。SRT 只作为弱参考，未写入
生产 prompt、few-shot、规则或源代码；报告只保存 case ID、哈希、计数、延迟和错误码。
视频清单与 2026-08-17 冻结清单的 12 个视频、10 份字幕逐项一致。

## 结果

| 能力 | 用例 | 结果 | 说明 |
| --- | ---: | ---: | --- |
| Facts V3 | 9 | `9/9` | 结构、弱主题、引用、重复行动和宏观目标门通过 |
| Q2 reader | 27 | `27/27` | 回答、未提及拒答、部分回答和冲突来源门通过 |

报告：

- `facts-v3-real-holdout-current-20260819.json`
- `q2-real-holdout-current-20260819.json`

暖态 Q2 单题观测约 `0.97--4.46s`。Facts V3 单题观测约 `6.04--44.03s`，其中 negotiation
用例触发一次允许的结构修复（2 次模型调用）；其余用例一次调用。该延迟不是完整长会 p95 证明。

## 尚未关闭

- 完整视频转写作为来源的端到端回放，而不是字幕窗口。
- 长会议 Facts 的人工事实支持率、行动有效性和引用相关性盲审。
- Q2 完整长会检索、人工引用相关性、Android 页面重进/断网/进程恢复。
- 长会超预算证据包已在隔离候选触发真实 embedding 并完成一次 Facts 生成，见
  [长会 embedding 回放](LONG-EMBEDDING-REPLAY-20260819.md)；其选段比例不是事实支持率。
- Stage 2/3 capability barrier、旧任务排空、资源/privacy 门和生产切换。

本证据不改变稳定版 1.1.10 (118)、生产 18020/8030、GPU、公开流量或 APK。
