# 开发与构建

## 环境

- Node.js 20 LTS、npm 10 或更高版本。
- JDK 17、Android SDK 36，以及可用的 `adb`。
- 服务端使用 Python 3.12；音视频处理需要 FFmpeg。GPU、PyTorch、ASR 和生成模型按部署环境配置。

构建脚本兼容 Linux 与 Windows。Android 是主要运行目标；Web/iOS 入口不代表录音、后台任务或硬件功能具有相同支持范围。

## 安装依赖

```sh
git clone https://github.com/yydd6677/laoji-app.git
cd laoji-app
npm ci
cp .env.example .env.local
```

Windows 可用 `Copy-Item .env.example .env.local`。按实际环境设置 API、隐私政策和用户协议地址；生产构建拒绝示例域名。设备注册及服务端私有配置不包含在仓库内。

当前兼容的 device-v1 准入值会进入 APK，不应当作秘密或复用服务端主密钥。device-v2 采用设备 P-256 密钥、challenge 和短期 token。自建服务需提供与客户端能力匹配的设备鉴权配置，不能只更换一个 URL。

## 运行 Android

```sh
adb devices
npm run android:device
```

多个目标同时在线时，明确指定设备：

```sh
node tools/android-build.cjs --target device --serial SERIAL
node tools/android-build.cjs --target emulator --serial SERIAL
```

脚本从设备读取 ABI，仅打包目标架构。正式发布使用 `arm64-v8a`，模拟器通常使用 `x86_64`。原生代码位于 `modules/laoji-native-platform/` 和 `plugins/`；根目录 `android/` 由 Expo prebuild 生成，不是维护源。

原生输入的 SHA-256 标记与当前配置匹配时才可复用生成目录；否则重新 prebuild。版本号与 Android versionCode 以 `app.config.js` 为准，`package.json` 必须与之保持一致。

## 检查

```sh
npx tsc --noEmit
npm run verify:android-native-source
npm run verify:ui-known-regressions
npm run verify:ui-continuity
```

按修改范围运行 `tools/tests/`、服务端或固件测试。单元测试不代替真实录音、恢复、模型输出或设备通信验证。

## 发布构建

```sh
npm run android:release
```

正式包需要私有签名配置；没有原签名密钥的构建不能覆盖原安装。构建会核对版本、原生输入、ABI 和资源。发布时使用新的版本号与文件名，并核对 APK 的 SHA-256、大小及更新清单 `tools/app-update/latest.json`。

构建成功不自动代表已经公开发布。不要提交签名、APK、依赖、缓存或生成目录。

## 服务端与固件

API 依赖清单位于 `services/laoji-api/requirements-compact.txt` 和 `requirements-dev.txt`。GPU运行时和模型单独安装；服务启动前应检查各自的环境配置，不要把开发配置直接用于生产。

- [服务架构](architecture.md)
- [部署配置](../deploy/linux/README.md)
- [固件构建与板级配置](../hardware/esp32s3-voice-memo/firmware/README.md)

## 文档范围

仓库保留经过整理的项目介绍、架构、接口、构建和安全说明。个人工作记录、实验过程、逐次修复日志、设备诊断、内部计划及原始验收材料留在本地，不作为项目文档发布。新增公开文档应说明当前机制，而不是复述开发过程。

`docs/` 使用明确的公开文件范围，其他本地资料默认忽略。凭据、真实录音、数据库和个人信息不得写入文档、测试夹具或提交信息。
