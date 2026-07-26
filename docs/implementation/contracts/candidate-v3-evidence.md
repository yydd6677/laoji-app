# 候选版 V3 集中证据

状态：当前默认 Preview 已在独立、只读模拟器完成 V3 第 2 条“录制主链”；这补齐的是同一候选 APK 的录制运行证据，不代表 V3 七条全部通过，也不替代 USB 真机、第二台物理设备或尚未部署的附件服务合同。

## 候选身份

- APK：`android/app/build/outputs/apk/preview/app-preview.apk`
- 功能基线：`0594d42 feat: add multimodal meeting attachments`；完成状态对账基线：`78929aa docs: reconcile candidate completion state`
- 版本：`versionCode=104`，`versionName=1.0.0-source-preview`
- 大小：`90,961,888` bytes
- SHA-256：`b8f710ad0f308cdc24237f395fa980735d2e635c35ad99b178cae5ede058b8ad`
- 稳定回溯标签继续固定在 `stable-before-meeting-memory-roadmap -> cde96f9d5266961e380957893ecba39855aea39b`。

## 隔离环境

- 使用 AVD `LaoJi_CAL_EDIT_RT`、序列号 `emulator-5558`，以 `-read-only -no-snapshot-save` 启动；安装候选 APK 后清空该临时实例的 App 数据并进入游客模式。主模拟器 `emulator-5556` 的既有会议和数据未修改。
- Android Emulator 的 headless QEMU 不提供可用 PulseAudio 驱动，因此改用 `-qt-hide-window` 的完整 QEMU，并将输入/输出接到临时 PipeWire/Pulse null sink。录制期间注入两段不同幅度的纯音，用于证明采集、分贝波形和播放器读取的不是固定占位数据。
- 该输入只适合验证本机音频链，不是人声样本，不用于证明转写、讲话人识别或真实麦克风质量。

## V3 第 2 条：录制主链

1. 从空会议列表点击“录音”后进入“新录音”页面，系统中 `LaojiRecordingService` 以前台服务运行，录音计时持续推进。
2. 暂停后主按钮变为继续图标，计时停在 `01:41`；继续后计时恢复。注入测试音时，底部波形从近似静音的短柱变为随幅度变化的高低柱，随后回落。
3. 点击停止先显示中文“结束录音？”确认框；确认后录音服务退出，本机提交成功并进入同一会议详情，没有闪退或把会议标成失败。
4. 详情播放器显示总时长 `02:22`。首次播放时 MediaSession 为 `PLAYING`、位置 `5,938 ms`；随后可暂停。拖到接近结尾后位置为 `126,201 ms`、buffered 为 `142,600 ms`，再次播放推进到 `129,211 ms`，证明不是只播放文件开头。
5. 录制过程抓取了 `88.518 s`、`1080x2400` 的临时屏幕录像，覆盖录制、暂停、继续及停止确认；录像和诊断截图经检查后不提交二进制，保持轻量工作区。
6. 本轮日志未发现应用进程的 `FATAL EXCEPTION`、React Native 致命异常、`SQLiteException`、Media3/ExoPlayer 播放错误或保存阶段错误。系统镜像中 Google 消息组件的旧 SQLite 探测噪声不属于 `com.laoji.app`，未误归类为老记缺陷。

## 当前外部边界

- `18020 /api/health` 返回 HTTP 200，`models_ready=true`。
- `18020 /api/laoji/capabilities` 返回 HTTP 200；根、RecordingAsset、行动项、QA、协作、片段和讲话人能力仍在线，但 `summary_attachments_image=false`，响应仍没有 `meeting_attachments_v1`。
- `18035 /api/laoji/capabilities` 返回 HTTP 404。
- 对 `zhong@183.36.243.124` 的非交互公钥认证仍为 `Permission denied (publickey,password)`；没有猜测密码、部署 overlay 或重启共享服务。
- USB 真机当前断开，因此本轮没有安装或真机结论。

## 对完成状态的影响

- V3 第 2 条现在具备当前候选 APK 的集中模拟器证据，可以锁定，不再重复录制主链。
- V3 第 1、3–6 条仍是此前分散证据；第 7 条仍缺第二台移动设备、当前候选的账号恢复集中闭环和附件运行合同。
- ATT-01 仍是唯一带“部分完成”的优化项：移动端、账号同步和多模态 overlay 源码已完成，但运行服务未部署附件 schema/能力，不能把 fail-closed 当作线上完成。
