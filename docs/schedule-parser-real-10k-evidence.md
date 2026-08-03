# 日程解析真实服务 10k 证据

## 运行边界

- 端点：`http://183.36.243.124:18035/api/laoji/parse`
- 语料：`tools/schedule-quality-v3/schedule-real-10k.jsonl`
- 标签：`authored_metadata_v1`，由语义种子元数据独立生成；运行器没有导入 parser，也没有从响应反推期望值。
- 运行方式：串行逐条 HTTP `POST`；每条请求完成后立即比较、追加 JSONL、flush 并 fsync，再进入下一条。
- 未调用 `/diagnostics/parse-quality` 批量接口，未调用本机 parser，未使用模拟器或 ASR。
- 本轮是远端公开 HTTP 服务的逐条质量测量，不等同于真实语音 ASR、真机噪声或长时间线上负载测试。

## 语料审计

独立审计文件：`tools/schedule-quality-v3/schedule-real-10k-independent-audit-final.json`。

- 总量：10,000
- 文本唯一：10,000/10,000
- 语义签名唯一：10,000/10,000
- 事件概念：1,000 个，每个 10 次
- 口语、关联词、日期、时间、地点、提醒、模板等受控键最大使用次数：10
- 语义签名最大使用次数：1
- 十个测试家族各 1,000 条

## 远端最终结果

逐条证据：`tools/schedule-quality-v3/reports/schedule-real-10k-remote-final-results.jsonl`。

汇总：`tools/schedule-quality-v3/reports/schedule-real-10k-remote-final-report.json`。

完整性验证：`tools/schedule-quality-v3/reports/schedule-real-10k-remote-final-verification.json`。

- 实际 HTTP 请求：10,000
- 结果行数：10,000
- 唯一 case：10,000
- 缺失/重复/未知 case：0/0/0
- 独立质量通过：10,000
- 独立质量失败：0
- 通过率：100%
- 失败代码：无
- HTTP 状态：9,000 条 `200`，1,000 条 `422`
- 7,000 条完整日程返回 `200` 并通过字段比较
- 2,000 条需要澄清的日程返回 `200` 并通过澄清字段比较
- 1,000 条否定控制返回 `422`，响应码为 `not_schedule`，没有被错误保存为日程

`422` 在本轮不是传输失败：它是语料明确要求拒绝的“不是日程”输入，运行器将 `422/not_schedule` 作为通过条件。所有请求均是对 `/api/laoji/parse` 的单条 `POST`，每条结果保留原始请求、原始响应和独立比较结果。

## 服务身份边界

服务快照保存在每条结果和汇总文件中：健康检查与 OpenAPI 响应哈希一致，服务头为 `uvicorn`。公开端点没有源码提交哈希或模型 digest，因此响应哈希只能证明本次 HTTP 评估所见的 API 快照，不能单独证明源码或模型版本。

本轮评估开始前已将修复后的日程解析服务部署到 `18035`。部署侧记录的服务 PID 为 `2274575`，部署后源码 SHA-256 为 `e94482febc1b8ec2c29db9d7de4097c5c51f4f67bca261024cd5f5d1bd0d9580`；这属于部署操作记录，不能由公开 HTTP 接口独立复核。远端服务本轮没有再次重启。

本轮完成的是“修复版本在真实 HTTP 文本输入上的逐条质量证据”。`promotion_eligible` 仍保持 `false`，因为真实 HTTP 评估不能替代真实 ASR、真机语音噪声、并发和长时运行验收；它也不表示已经完成生产放行。

## 候选修复证据

本机候选使用与服务端相同的 `schedule_parser_service.py`，通过独立 HTTP 包装器禁用模型调用，仅验证确定性解析逻辑。它不是远端 `18035`，也不包含真实 ASR。

- 候选端点：`http://127.0.0.1:18036/api/laoji/parse`
- 逐条结果：`tools/schedule-quality-v3/reports/schedule-real-10k-candidate-v3-results.jsonl`
- 汇总：`tools/schedule-quality-v3/reports/schedule-real-10k-candidate-v3-report.json`
- 完整性验证：`tools/schedule-quality-v3/reports/schedule-real-10k-candidate-v3-verification.json`
- 结果：10,000/10,000 通过；9,000 条 HTTP 200，1,000 条否定控制 HTTP 400；缺失、重复、未知 case 均为 0。
- 分类专项：`tools/schedule-quality-v3/reports/event-category-server-candidate-v2.json`，249/249，通过率 100%，Macro-F1 1.0。
- 服务端回归：`test_schedule_parser_quality.py` 为 66 passed；新增“十五分钟后提醒我提交材料”边界，保留完整事项名。
- 移动端解析契约：31/31；冻结语料 3,200 条的 C0/C1 静默保存风险为 0，关键日期/时间/重复/提醒字段 1,214/1,214 精确匹配；`npx tsc --noEmit` 通过。

本次候选源码备份位于：
`/home/yydd/LaoJi/server-staging/qwen35-9b-cutover/smart-meeting-ai/backend/backups/schedule-real10k-title-action-20260803/`。
候选阶段记录的源码 SHA-256 为 `ee2de3b52f715060af0fc2a55957ab70612f67a656185f416d947678dc624466`；它与部署侧记录的远端修复版本摘要不同，不能混用。

## 后续覆盖范围

仍需单独覆盖真实 ASR 转写误差（口音、噪声、断句、同音字）、真机语音输入与权限状态、并发/超时/重试、服务重启恢复和长时间负载。以上事项不能用本次 10,000 条文本 HTTP 结果替代。
