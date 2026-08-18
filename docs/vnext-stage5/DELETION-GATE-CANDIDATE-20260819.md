# Stage 5 候选删除门复核（2026-08-19）

状态：`safe_to_delete=false`，只读审计，未删除、未停服务、未改数据库。

审计对象是隔离 release `d193dd2` 和候选数据库
`/home/zhong/laoji-vnext-candidate/api-data/api-asr-retry.db`；生产数据库、18020/8030、GPU1、
PCB 和 Smart Meeting 不在写入范围内。

## 结果

| 检查 | 结果 |
| --- | --- |
| capability cutover 数据表 | 缺失，无法证明五个能力已激活/关停/移除旧 reader |
| 活动 legacy 引用 | `36` 个 |
| 完整公开周期记录 | 缺失，不能用“当前没有用户”代替 |
| 候选数据库状态 | `missing_capability_table` |
| 运行时进程 | 候选 API、候选 ASR 及既有运行时项均只读发现 |
| 删除执行 | `false` |

阻断项：

1. `media.upload`、`transcript.realtime`、`summary`、`question`、`schedule` 尚无完整 capability
   barrier 记录。
2. 活动代码仍保留 legacy handler/兼容引用，不能物理删除。
3. 没有外部可验证的完整公开周期记录。
4. 任务 lease、purge journal、R2 cleanup 和旧客户端查询尚未形成全部切换证明。

因此旧上传、旧 ASR、summary v2/Q0、Q&A 旧链路、旧日程 parser、mirror/fallback 和旧模型都必须
继续保留；这次只更新证据，不改变任何服务或能力开关。
