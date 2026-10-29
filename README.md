# 老记 · LaoJi

日程与会议记录应用，基于 React Native 和 Android 原生模块构建。

老记将日历、录音、文字记录和会议资料放在同一个工作流中：日程在本机管理，录音可实时转写或导入后处理，整理结果和问答保留可回到原文的依据。

## 功能

- 日程：文字与语音输入、编辑、搜索、日历视图和本机提醒。
- 会议：手机录音、音视频导入、实时与批量转写、讲话人和笔记。
- 阅读：结构化整理、行动候选、基于会议内容的问答和引用跳转。
- 管理：标签、录音回放、回收站、Markdown 分享和应用内更新。
- 外接录音：ESP32-S3 参考固件，支持 BLE 控制、实时音频及 BLE/Wi-Fi 文件接收。
- 界面：标准、绚彩、纸境和夜航四种主题。

## 数据与服务

应用免登录，以设备本地数据为准。日程与会议使用独立 SQLite 数据库；语音识别、复杂日程解析、整理和问答需要兼容的服务端。设备身份用于鉴权和任务恢复，不提供账号式跨设备同步。

服务端包含 FastAPI、ASR 和可替换的生成/embedding Provider；部署配置和密钥不随源码分发。详见[架构](docs/architecture.md)。

## 开始使用

- [Android 更新清单](https://laoji.cloud/downloads/android/latest.json)
- [开发与构建](docs/development.md)
- [硬件接口](docs/hardware/README.md)
- [Linux 部署模板](deploy/linux/README.md)

Android 是当前主要支持平台。原生功能依赖自定义模块，不能直接使用 Expo Go 运行。

## 分支

`master` 保存稳定版本，`develop` 保存进行中的开发。下载版本以公开更新清单为准，不以开发分支的版本字段代替发布状态。

## 许可证

源码采用 [MIT License](LICENSE)。第三方字体、依赖和模型分别遵循各自许可证；字体及资源声明随源码保留。安全问题见 [SECURITY.md](SECURITY.md)。
