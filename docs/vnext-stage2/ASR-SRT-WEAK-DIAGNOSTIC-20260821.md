# Stage 2 ASR 弱字幕诊断（2026-08-21）

状态：`weak-reference diagnostic only; not promotion eligible; Stage 2 quality gate open`。

## 输入与方法

- 使用当前冻结样本中的 10 组同名 MP4/SRT，每组确定性选择 3 个不重叠窗口，共 30 条；
- 窗口 PCM 通过隔离 loopback `v2/asr/batch` 合同调用当前 Qwen3-ASR-1.7B revision
  `7278e1e70fe206f11671096ffdd38061171dd6e5`；没有重启或修改生产服务；
- 参考和预测做 Unicode NFKC、大小写和标点归一化后计算 CER；数字/时间将常见中文数字与百分比表达
  规范为同一语义 token；
- 持久诊断只记录来源/正文哈希、时间范围和指标，不保存字幕或 ASR 正文。明文逐条对照只存在本机
  `/tmp` 临时审阅包，不进入仓库、服务日志或退出门证据。

工具：`tools/vnext/evaluate_asr_srt_diagnostic.py`。报告合同固定为
`media-weak-reference-diagnostic-v1`，并硬编码 `promotion_eligible=false`。

## 结果

| 指标 | 30 条弱参考结果 | vNext 目标 | 是否关闭门 |
| --- | ---: | ---: | --- |
| CER 中位数 | `5.56%` | `<=8%` | 否 |
| CER p95 | `41.67%` | `<=18%` | 否 |
| 数字/时间 token 准确率 | `89.71%`（68 个参考 token） | `>=95%` | 否 |
| no-speech | `0/30` | 有声窗口应有文字 | 仅诊断一致 |

逐条检查最高误差窗口后，至少发现：字幕明显漏掉连续语句、字幕错词、阿拉伯数字与中文数字/百分比
表达差异，以及时间窗内字幕和实际讲话边界不完全一致。由此不能把 p95 高误差简单归因于 ASR，也不能
用中位数达标证明 ASR 已通过。

## 对退出门的影响

Stage 2 质量预检现只接受 `media-human-quality-v1`：第一方 opt-in 音频、双独立中文母语盲审、
裁决后冻结参考、再生成预测；ASR 至少 30 条，讲话人已登记/未知样本各至少 10 条，并保留完整血缘哈希。
弱 SRT、自动评分、脚本生成文本和单个布尔声明均不能晋级。

下一步不是按弱字幕结果调 prompt 或加样本规则，而是让两位独立审阅者校正这 30 个已冻结窗口，并为
同批音频补充按说话时长加权的已登记/未知讲话人参考。完成前 CER、数字时间、attribution F1 和未知人
强行命名率继续保持未通过。
