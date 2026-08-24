# vNext Android 发布记录：1.1.65（173）

## 结果

- 发布状态：曾短暂开放在线更新；真实终态检查发现列表阶段仍可能悬空，已由 `1.1.66 (174)` 取代。
- Android：`1.1.65`，`versionCode=173`，包名 `com.laoji.app`。
- 服务端离线转写编排从一条提升到三条；8030 模型、GPU1、PCB、Smart Meeting 和其他服务未改动。

## 修复

1. 所有用户确认的媒体导入先写入恢复日志并创建可见会议，再进入本机有界准备队列；不再用“两条正在准备”拒绝第三条及后续选择。
2. 本机最多同时执行三条昂贵的复制或音频提取，避免无限并发耗尽厂商编解码器或临时空间。
3. 服务器最多同时编排三条离线媒体的下载、解码和 VAD，8030 继续统一排队和微批推理，并保留实时会议与日程语音优先级。
4. 工作线程在任务排队和执行期间持续持有同一去重身份，维护扫描不会让其他通道重复解码同一媒体。
5. 排队、运行和失败状态从设备任务投影到会议权威阶段；`1.1.65` 已覆盖第一段稳定文字出现前的状态，但 final 后仍存在一次可中断的二次状态写入。
6. 任务重试进入运行态时清空旧错误码和旧终止时间，避免“正在运行但携带失败状态”。

## 验证

- `npx tsc --noEmit`：通过。
- `tools/vnext/verify_stage2_android_contract.py`：通过。
- `tools/verify_device_primary_source.py`：通过。
- `tests/test_vnext_import_transcription.py`：`20 passed`，包含三通道边界和执行中任务去重测试。
- 十条真机样本全部完成音频提取与上传；生产服务器真实观察到三条编排通道及 8030 微批调用。
- `:app:assembleRelease`：通过；生产域名、vNext 开关、设备引导密钥和更新签名连续性验证通过。

## 产物

- 本地产物：`artifacts/vnext-releases/1.1.65-173/laoji-vnext-1.1.65-173.apk`
- 公网地址：`https://laoji.cloud/downloads/android/laoji-1.1.65-173.apk`
- SHA-256：`c9c9fa855ce55637700da734424c6520c83a9fd8e2317af1c964ebe3f2d9dd4b`
- 大小：`82668395` bytes
- 签名证书 SHA-256：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
