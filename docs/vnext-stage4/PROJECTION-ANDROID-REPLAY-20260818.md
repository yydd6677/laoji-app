# ProjectionEnvelope Android 回放证据

状态：`candidate runtime replay passed; Stage 4 not adopted`。

## 环境

- 设备：`emulator-5562`，AVD `LaoJi_API_35`，Android 15 / API 35。
- 安装前版本：`1.0.6-source-preview (106)`；安装后候选包：`1.1.10 (118)`。
- 安装使用 `adb install -r -d`，保留旧本机数据库以覆盖迁移路径；未操作 `emulator-5560`。
- 仅在隔离 Debug 构建中开启 `meetingQuestionsQ2Candidate`、
  `meetingSummarySourceStreamCandidate` 和 `nativeProjectionEnvelopeCandidate`；稳定构建默认均为关闭。

## 回放

1. 首次候选包启动后，日志确认旧数据库升级到 `PRAGMA user_version=45`，启动导航可用；`0045` 表
   `meeting_search_documents_v45` 与 `native_projection_checkpoints` 均存在。
2. 初版 hook 在页面权威 epoch 尚未写入时会把 checkpoint 外键错误当作永久失败；补上本机
   `ensureDeviceEpoch` 后重新加载，SQLite 出现：

   ```text
   epoch=<active> | surface_key=calendar | entity_id=calendar | entity_revision=3 | view_revision=3
   ```

3. 强停应用、重新启动并等待首屏恢复，再次强停读取同一 SQLite/WAL，得到：

   ```text
   surface_key=calendar | entity_id=calendar | entity_revision=6 | view_revision=6
   ```

   revision 单调提升且没有回到 1。启动 generation 和日期快照在重建时变化，因此这次不是同 hash
   幂等重试；没有发现旧 fence 覆盖新 fence 或跨 surface 写入。

## 结果

- Android 原生宿主和 JS 页面均可启动并显示日历；Metro 真实 bundle 成功加载。
- 本机 epoch 外键初始化、checkpoint 写入、强停/重启恢复通过。
- 该回放不覆盖 WorkManager 断网/进程死亡、真实会议页面重建、Q2/Facts V3 语义质量或服务端
  capability barrier；因此不能作为 Stage 2/3/4 退出或生产采用证据。
