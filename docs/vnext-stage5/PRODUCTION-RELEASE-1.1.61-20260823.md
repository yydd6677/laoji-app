# vNext Android 发布记录：1.1.61（169）

## 结果

- 发布状态：已开放在线更新。
- Android：`1.1.61`，`versionCode=169`，包名 `com.laoji.app`。
- 本次仅发布客户端；生产 API、ASR、Ollama 和其他服务未重启。
- `1.1.56`、`1.1.57` APK 与 `latest-1.1.57-165.json` 继续保留。

## 用户可见变更

- 日程数据迁入独立 `laoji-schedule.db`；会议数据库清理、重建和迁移不再删除日程。
- 会议媒体导入最多允许两条不同会议资产同时进行本机复制、校验或视频抽音。
- 第一条录音处于“正在准备录音”时，会议页上传入口保持可用；两条槽位均占用时才暂时停止接纳。
- 导入恢复不再因普通会议列表更新反复重启，避免恢复状态重新锁住上传入口。

## 产物与验证

- 本地产物：`artifacts/vnext-releases/1.1.61-169/laoji-vnext-1.1.61-169.apk`
- 公网地址：`https://laoji.cloud/downloads/android/laoji-1.1.61-169.apk`
- SHA-256：`26d1544278b08d2d2bc9356e33d242c758c6e3f51ea542c86dfb0349ae61ca35`
- 大小：`82655827` bytes
- 签名证书 SHA-256：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`，与上一公开版一致。

TypeScript、Stage 2 Android 合同、数据库隔离测试、Release Kotlin 编译和 APK 构建通过。服务器先验证
临时 APK 的 SHA-256/大小，再保留旧清单并原子替换 `latest.json`。公网无查询参数清单已返回
`1.1.61 (169)`，完整公网 APK 流式 SHA-256 与本地产物一致，生产 `/api/ready` 返回 `ready`。

发布时无线 ADB 设备处于 offline，因此本记录不声称真机在线检查更新或双文件并行准备已经完成。
