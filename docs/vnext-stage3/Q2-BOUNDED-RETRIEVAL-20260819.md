# Stage 3 Q2 bounded raw-source retrieval (2026-08-19)

状态：`candidate-only; default off`。

## 本次实现

- Q2 请求来源上限从 256 提升到 1,024 个 immutable source；移动端 snapshot 仍保存完整来源指纹和
  原始来源 revision。
- 当完整来源序列化估算不超过 10,240 tokens 时，模型继续读取完整来源。
- 超预算时，服务端只对本地 embedding provider 执行问题/来源相关性选择，按固定批次、修正/日期/负责人
  等显式证据信号和相邻上下文保留一个有界 raw-source view；没有生成摘要、关键词否决或第二模型调用。
- selected source 使用原始 alias（例如 `s217`），最终引用仍在完整 immutable snapshot 上做 hash、范围和
  逐字校验，避免子集重编号导致引用错绑。
- embedding 不可用或预算仍不足时显式失败为 `Q2_RETRIEVAL_UNAVAILABLE` / `Q2_EVIDENCE_INCOMPLETE`，
  不静默截断、不回退旧问答。

## 证据

- Q2 reader/device API 回归：`20 passed`；来源流、任务、Graph 聚焦回归合计：`58 passed`。
- 大来源集测试覆盖 320 个原始片段：模型输入被压缩为有界子集，但引用仍解析回原始 `line-217`；embedding
  不可用时失败关闭。
- `npx tsc --noEmit --pretty false`、Python compileall、Graph owner 静态门和 privacy log audit 均通过。

## 未关闭边界

该切片只解决 Q2 reader 的候选上下文预算，不等于 Stage 3 退出。随后完成的 Q2 source-stream
消费纵向切片见 [Q2 source-stream](Q2-SOURCE-STREAM-20260819.md)；专属 Android 回放、人工引用相关性、
长会语义 holdout、公开零流量周期和 capability barrier 仍未通过。生产 Q2、旧问答和公网流量均未改变。
