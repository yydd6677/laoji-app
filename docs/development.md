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

device-v1 准入值会进入 APK，不属于秘密配置，必须与服务端主密钥分离。device-v2 采用设备 P-256 密钥、challenge 和短期 token。自建服务需要配置 API 地址、设备鉴权、模型及上传存储。

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

构建脚本使用原生输入的 SHA-256 标记检查生成目录是否可复用；输入不匹配时执行 prebuild。版本号与 Android versionCode 以 `app.config.js` 为准，`package.json` 必须与之保持一致。

## 检查

```sh
npx tsc --noEmit
npm run verify:android-native-source
npm run verify:ui-known-regressions
npm run verify:ui-continuity
```

`tools/tests/` 包含客户端与构建合同测试；服务端和固件分别维护测试集。涉及录音、任务恢复、模型或硬件的变更还需要端到端验证。

## 发布构建

```sh
npm run android:release
```

正式包需要私有签名配置；没有原签名密钥的构建不能覆盖原安装。构建会核对版本、原生输入、ABI 和资源。发布时使用新的版本号与文件名，并核对 APK 的 SHA-256、大小及更新清单 `tools/app-update/latest.json`。

构建产物与公开发行分别管理。签名、APK、依赖、缓存和生成目录不纳入源码版本控制。

## 服务端与固件

API 依赖清单位于 `services/laoji-api/requirements-compact.txt` 和 `requirements-dev.txt`。GPU运行时和模型单独安装；服务启动前应检查各自的环境配置，不要把开发配置直接用于生产。

- [服务架构](architecture.md)
- [部署配置](../deploy/linux/README.md)
- [固件构建与板级配置](../hardware/esp32s3-voice-memo/firmware/README.md)

## 提交范围

技术文档应独立说明所述版本的机制、前提和限制，不要求读者了解开发历史。实现规范与设计提案分别标注，规范中的接口说明应与对应源码一致。

公开文档包括项目说明、架构、接口、构建和安全策略。`docs/` 中的发布文件由 `.gitignore` 显式指定。

凭据、设备诊断、真实用户数据、内部计划和工作记录不纳入公开提交；测试夹具与示例应使用可公开的数据。
