# Stage 2 ASR/讲话人独立人工质量证据链（2026-08-21）

状态：`scoring and lineage tooling complete; new first-party media and human reviews pending; Stage 2 not adopted`。

## 关闭的证据缺口

旧 `media_quality_evidence.py` 能验证最终 `media-human-quality-v1` 报告，却不负责生成报告。理论上可以
手填“两名评审”和五项指标后再封存，无法证明分数确实来自盲审、裁决和后置预测。

新增 `tools/vnext/media_human_review_evidence.py`，把质量证据顺序固定为：

```text
不可变音频 manifest
  -> 评审 A（看不到预测） ┐
  -> 评审 B（看不到预测） ┴-> 独立裁决并冻结参考
                                  -> 冻结后才生成候选预测
                                  -> 确定性计算指标并封存
```

工具强制：

- 两名中文母语评审使用不同匿名 ID，声明独立且未看预测；
- 裁决者与两名评审均不同，裁决时间不得早于任何评审；
- 两份评审存在差异时不能用 `reason_code=agree` 跳过裁决；
- predictions 的时间和 `reference_freeze_sha256` 必须晚于并精确绑定裁决文件；
- 第一方晋级音频与 development manifest 的任一音频哈希重叠即失败关闭；
- CER 中位/p95、逐样本数字时间准确率、按毫秒加权的 registered attribution F1、未知人强行命名率
  全部由正文和 speaker segment 计算，不能手填；
- 数字/时间参考 token 为空时准确率按 `0` 失败关闭，CER 保留真实值且允许超过 `1.0`，不做截断美化；
- 最终公开报告只包含计数、指标和六份资产哈希，不包含转写、姓名、音频路径或用户内容。

## 私有模板

私有 source manifest 采用 `media-human-review-pack-v1`，每条至少包含：

```json
{
  "case_id": "opaque-case-id",
  "audio_sha256": "sha256:...",
  "consent_reference": "受控授权引用",
  "duration_ms": 10000,
  "include_asr": true,
  "review_audio_ref": "review-audio/opaque-case-id.wav"
}
```

模板生成命令：

```bash
python3 tools/vnext/media_human_review_evidence.py make-templates \
  --manifest /受控目录/source-manifest.json \
  --output-dir /受控目录/stage2-media-review
```

输出的两份 review、adjudication、predictions 和 development manifest 均为 `0600`。评审只处理匿名
音频引用、逐字文本和匿名讲话人区间；裁决阶段才把区间标成 `registered/unknown`，登记区间必须填写
冻结的登记名，未知区间禁止姓名。候选 predictions 对应区间只提供实际输出的姓名或 `null`。

裁决完成、参考冻结并生成候选预测后：

```bash
python3 tools/vnext/media_human_review_evidence.py score \
  --manifest /受控目录/source-manifest.json \
  --review-a /受控目录/stage2-media-review/review-a.json \
  --review-b /受控目录/stage2-media-review/review-b.json \
  --adjudication /受控目录/stage2-media-review/adjudication.json \
  --predictions /受控目录/stage2-media-review/predictions.json \
  --development-manifest /受控目录/stage2-media-review/development-manifest.json \
  --output /受控目录/stage2-media-review/quality-report.json
```

最终报告仍必须通过 `media_quality_evidence.verify_quality_report` 和 Stage 2 聚合预检。

## 当前不能使用的样本

`/home/yydd/下载/会议视频样本` 已被用于 ASR、讲话人、Facts、Q2、恢复和性能迭代，其中 10 份 SRT
还用于选择并人工检查弱参考窗口。它们继续是功能/回归/恢复验收来源，但已经不是预测隔离的独立媒体
质量 holdout，不能把现有结果重新包装成 `first_party_human_reference`。

Stage 2 仍需新收集、明确授权且未进入开发流程的音频：至少 30 条 ASR 样本、含已登记讲话人的至少
10 条、含未知讲话人的至少 10 条，并由两名真实中文母语评审和一名独立裁决者完成上述流程。工具与
单元回归已经通过，但未伪造任何人工字段或质量分数。
