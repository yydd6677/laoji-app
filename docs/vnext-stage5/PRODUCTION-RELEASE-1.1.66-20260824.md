# vNext Android 发布记录：1.1.66（174）

## 结果

- 发布状态：已安装到真机并开放在线更新。
- Android：`1.1.66`，`versionCode=174`，包名 `com.laoji.app`。
- 继承 `1.1.65` 的不限选择数量、有界本机准备、三条服务端离线编排和任务执行期去重；8030 模型、GPU1、PCB、Smart Meeting 和其他服务未改动。

## 修复

1. 转写最终文本落库后，直接以单一终态事务把会议阶段收敛到 `ready`，不再先回写一次 `running/finalizing`。
2. 只有可读的最终转写版本存在时才允许文本任务进入成功终态；无语音任务进入 `no_speech`。
3. 清除持久完成操作前先完成终态投影；进程在两者之间中断时仍可恢复，不会留下永久转圈。
4. 启动时审计旧版本遗留的“已有最终文本但阶段仍在生成”记录；仍有待处理任务的会议不会被误修复。
5. 列表和详情继续读取同一权威阶段，终态修复后刷新会议列表。

## 验证

- `npx tsc --noEmit`：通过。
- `tools/vnext/verify_stage2_android_contract.py`：通过。
- `tools/verify_device_primary_source.py`：通过。
- `git diff --check`：通过。
- `:app:assembleRelease`：通过；`verifyLaojiReleaseContract` 通过。
- APK 签名证书 SHA-256：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`。
- 真机覆盖安装成功，包版本确认为 `1.1.66 (174)`。
- 十条样本在列表上下两屏均无等待上传、正在上传、正在准备、正在转写或失败等残留状态。
- 打开 `829384557-1-208` 后，详情无不稳定状态且最终文字记录可读；强制停止应用并冷启动后再次检查，列表仍保持终态。
- 十条服务端转写运行均为 `succeeded` 且无错误码；每条最终事件序号均与真机确认序号一致。
- 十条 R2 暂存对象均在最后一张上传签名失效后自动删除并确认；每条一次成功且无清理错误。
- 公网 `latest.json` 已返回 `1.1.66 (174)`；公网 APK 实际下载大小和 SHA-256 与本地产物一致。

## 产物

- 本地产物：`artifacts/vnext-releases/1.1.66-174/laoji-vnext-1.1.66-174.apk`
- 公网地址：`https://laoji.cloud/downloads/android/laoji-1.1.66-174.apk`
- SHA-256：`f595c956735428e74c81854f1d4f47698f3a346ad2cb28583d3725d81349447e`
- 大小：`82670263` bytes
