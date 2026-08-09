# 存量生成文本简体化迁移（2026-08-09）

## 迁移范围

仅处理服务生成或转写的文本：`transcript_lines.text`、整理结果 JSON、整理任务结果、历史整理版本和公开分享冻结内容。没有改原始音频、会议标题、用户笔记、标记、用户问题、文件名或任何身份/幂等 ID。

## 迁移结果

- 转写文本：`948` 条由 OpenCC `t2s` 转换，迁移后 `4540/4540` 条无需再转换。
- 整理结果和历史版本：`98 + 80 + 3 + 94 + 2` 个 JSON 字段值被转换；迁移后所有扫描字段均为简体稳定状态。
- 数据库行数保持不变：会议 `105`、转写 `4540`、整理 `169`、整理任务 `40`。
- `PRAGMA integrity_check=ok`、`foreign_key_check` 违规数为 0，WAL 保持开启。

## 回滚与运行状态

- 迁移前在线备份：`/home/zhong/laoji-service-platform/compact-production/backend/backups/simplified-migration-20260809-r1/local.db`
- 备份 SHA-256：`ff4ac89bd2b168509796eb9d71a2c8147a088a71d54c0d1bbd45e1b922777571`
- 使用单事务脚本 `deploy/scripts/migrate-simplified-existing-data.py`；迁移期间仅停写 `laoji-api.service`，完成后重新启动。
- 迁移后公网 `/api/ready=true`，ASR、LLM、任务队列和活动租约均为 0；ASR、Ollama、Cloudflare Tunnel 未重启。

这项迁移修复的是旧存量，不替代新转写链路中的 OpenCC 转换；新链路继续在服务端和客户端双侧保持简体策略。
