# 日程 quick 解析回归快照 2026-08-16

## 证据边界

- status: `observed; isolated service worktree; not production approval`
- source: `/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`
- runtime: `/home/yydd/LaoJi-service-worktrees/compact-production-v3/.venv/bin/python`
- 未启动、重启或修改服务器，也未修改服务源码。

## 执行

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=. ../.venv/bin/python -m pytest -q \
  tests/test_schedule_parser_quality.py tests/test_schedule_recurrence.py
```

结果：`81 passed, 10 failed`。

另行加入 `tests/test_schedule_asr_proxy.py` 时，测试收集因该隔离环境缺少
`httpx` 而停止；这不是 ASR 质量结论，只是依赖缺口。

## 失败聚类

- 纠正尾句的旧主题提取仍返回“ 不/想排 ”等残片，而测试要求丢弃旧主题；
- 模型结果规范化没有始终以纠正后的尾句覆盖日期，导致相对日期和星期更正失败；
- surface title 优先级测试失败（半年度、预订重要酒店等）；
- 复合标题中的“工作日”触发了错误的澄清/日期清空；
- 生产 prompt 长度为约 2331 字符，而现有测试门禁要求小于 1800。

这些失败集中说明：当前解析仍把规则、模型输出后处理和 prompt 长度作为多个
相互耦合的 owner。它们不能被本轮隔离合同测试覆盖，也不能据此宣称 M1 已解决。

## 处理决定

本快照加入蓝图门禁，但不在未获明确生产修改授权时直接修复服务源码。后续
ScheduleSemanticDraft 回放必须把纠正、标题优先级、复合标题和 prompt contract
作为独立字段级门；只有在当前回归集合恢复通过后，才可比较外部时间引擎。
