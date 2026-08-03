# 日程解析真实服务 10k 证据

## 运行边界

- 端点：`http://183.36.243.124:18035/api/laoji/parse`
- 语料：`tools/schedule-quality-v3/schedule-real-10k.jsonl`
- 标签：`authored_metadata_v1`，由语义种子元数据独立生成；运行器没有导入 parser，也没有从响应反推期望值。
- 运行方式：串行逐条 HTTP `POST`；每条请求完成后立即比较、追加 JSONL、flush 并 fsync，再进入下一条。
- 未调用 `/diagnostics/parse-quality` 批量接口，未调用本机 parser，未使用模拟器或 ASR。

## 语料审计

独立审计文件：`tools/schedule-quality-v3/schedule-real-10k-independent-audit-final.json`。

- 总量：10,000
- 文本唯一：10,000/10,000
- 语义签名唯一：10,000/10,000
- 事件概念：1,000 个，每个 10 次
- 口语、关联词、日期、时间、地点、提醒、模板等受控键最大使用次数：10
- 语义签名最大使用次数：1
- 十个测试家族各 1,000 条

## 逐条 HTTP 结果

逐条证据：`tools/schedule-quality-v3/schedule-real-10k-results.jsonl`。

- HTTP 请求数：10,000
- 结果行数：10,000
- case id 缺失/重复：0/0
- HTTP 状态：10,000 条均为 200
- 独立质量通过：1,335
- 独立质量失败：8,665
- 通过率：13.35%
- 结果完整性验证：`tools/schedule-quality-v3/schedule-real-10k-results-verification.json`，通过

主要失败字段计数：

- `field:title`：6,716
- `field:location`：1,547
- `field:start_date`：1,492
- `field:needs_clarification`：1,000
- `negative_control_accepted`：1,000
- `field:end_date`：256

这些失败是真实服务输出与独立期望的逐条比较结果，不应解释为网络失败或批量汇总失败。当前服务对口语前缀的标题提取、否定/不创建语义、地点不确定澄清和部分重复/日期场景存在明显质量问题。

## 身份边界

服务身份快照：`tools/schedule-quality-v3/schedule-real-10k-server-identity-check.json`。运行开始与结束时健康响应及 OpenAPI 响应哈希一致，均为 `uvicorn`；公开端点没有源码提交哈希或模型 digest，因此不能把响应哈希扩大解释为源码/模型版本证明。

本轮完成的是“真实服务逐条质量测量”，不是生产放行。由于失败率和否定语义缺陷，`promotion_eligible` 必须保持 `false`。

## 候选修复证据（2026-08-03）

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
当前源码 SHA-256 为 `ee2de3b52f715060af0fc2a55957ab70612f67a656185f416d947678dc624466`。

## 远端部署状态

同一语料在公开远端 `183.36.243.124:18035` 上重新抽测 50 条，结果为 5/50（10%）；失败仍集中在口语前缀标题、否定控制、不确定地点和日期字段，证明远端尚未加载上述候选修复。抽测结果保存在 `tools/schedule-quality-v3/reports/remote-canary-50-report.json` 及对应 JSONL。

当前本机没有 `18035` 监听，且 `ssh zhong@183.36.243.124` 返回 `Permission denied (publickey,password)`；没有远端写入或重启权限。因此不能把候选 100% 宣称为远端 95%+，也没有执行远端部署或重启。获得授权通道后，部署边界应仅覆盖 `schedule_parser_service.py`，先做源码备份，再确认 `18035` 无活动连接后重启并重新跑全量 10k。
