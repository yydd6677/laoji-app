# 8030 实时微批候选（r3）

2026-08-09 在服务器 `/home/zhong/laoji-service-platform/compact-production/backend/qwen_asr_service/server.py` 实施并回归。

- 活动版本：服务器备份 `backups/asr-microbatch-20260809-r3/server.py.candidate`，SHA-256 `00bfad570b634ddf209720d81bbee098dd31109be23a32842b01b8601c018333`。
- 默认只启用单 worker；同优先级请求最多合并 8 项，但一批音频总时长不超过 14 秒，避免长会议段被合成过大批次。
- `/ready` 和 `/health` 的原有合同保持不变；`/v1/asr/batch` 的 item ID 映射按对象身份隔离，多个旧 `/asr` 请求都使用 `legacy` ID 时不会串结果。
- r4 双 worker 仅作实验，已回滚；实验备份仍保留在服务器，不属于活动运行版本。

当前实测仍未达到公网五路实时并发 p95 2 秒门槛，因此该改动是受控候选优化，不代表最终性能验收通过。
