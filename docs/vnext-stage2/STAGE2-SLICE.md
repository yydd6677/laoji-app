# vNext Stage 2 纵向切片

状态：`in progress`。0043/0044 已形成首个隔离 migration unit，上传/ASR capability barrier 未切换。

## 已实现

- 0043 为 Transcript 增加 source manifest/text-final 边界，为 segment 增加稳定 key、revision 和
  partial/final 状态。
- 旧 segment 的自动讲话人投影迁入 `speaker_overlay_*`；旧人工 assignment 迁入
  `speaker_manual_overrides`，两层不再互相覆盖。
- 搜索采用 external-content FTS5 trigram，内容表保存标题、当前 transcript 投影和当前笔记投影；FTS
  只是可重建索引，不成为会议正文 owner。
- 0044 为历史录音补随机 128-bit `asset_generation`，从可信 checksum 补 `source_sha256`，增加 upload
  operation/remote object revision；删除会议按原 `deleted_at_ms` 补 30 天 `purge_after_ms`。

## 证据

- `python3 tools/vnext/verify_stage2_migrations.py`：通过，覆盖 DDL 重放、overlay/override 分层、中文
  FTS、generation/hash、purge deadline 和 foreign key check。
- `npm exec -- tsc --noEmit --pretty false`：通过。

## 下一入口

1. repository 读取/写入 0043/0044 canonical 字段并实现 search/overlay owner。
2. v2 upload session、capacity reservation、verified asset 与 cleanup obligation。
3. native WorkManager 切入 v2 single/multipart R2，但 barrier 前保留显式旧协议。

生产服务、公网、APK、设备和 GPU 均未修改。
