# vNext Android 发布记录：1.1.57（165）

## 结果

- 发布状态：已开放在线更新。
- Android：`1.1.57`，`versionCode=165`，包名 `com.laoji.app`。
- 本次仅发布客户端；生产 API、ASR 和其他服务未重启。
- 上一版 APK 与更新清单归档继续保留。

## 用户可见变更

- 回收站右上角新增“清空”入口。
- 清空前显示待永久删除的会议数量，并要求二次确认。
- 清理过程复用单条永久删除链路，清除对应本机录音、播放缓存、附件、文字记录、整理任务和通知，并持久登记服务端清理任务。
- 个别记录失败不会阻止其他记录清理；失败记录继续保留在回收站并可重试。

## 产物与验证

- 本地产物：`artifacts/vnext-releases/1.1.57-165/laoji-vnext-1.1.57-165.apk`
- 公网地址：`https://laoji.cloud/downloads/android/laoji-1.1.57-165.apk`
- SHA-256：`37af64a4616f7a1fd5f80c1b4a2e166ce8ecc1ca3a07176c8b53d07215bbbb0c`
- 大小：`82621599` bytes
- 签名证书 SHA-256：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`，与 `1.1.56` 一致。

已通过 TypeScript 检查、Android release Kotlin 编译、release APK 构建、生产配置审计、APK 元数据检查和公网下载哈希核对。未在用户真机上执行清空操作；由用户通过在线更新安装并自行确认删除。
