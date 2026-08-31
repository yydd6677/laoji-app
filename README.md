# 老记

老记是一个 Android 优先的 React Native 日程与会议应用，支持文字和语音创建日程、本机提醒、实时会议转写、录音导入、会议整理、问答、回放和分享。

当前应用采用免登录、设备身份鉴权和本机数据优先的形态。日程、会议索引和用户编辑内容以设备本地数据为准；语音识别、复杂解析、整理、问答和更新由兼容的远端服务提供，会议资料由手机直接导出分享。

## 仓库状态

- 唯一活跃开发与发布分支：`vnext/implementation`。
- 当前移动版本：`1.1.97`，Android `versionCode=205`。
- `master`、旧标签和旧重建分支只用于 Git 追溯，不是构建或恢复当前实现的来源。

分支、标签、当前阶段和文件边界见 [协作者仓库指南](docs/REPOSITORY_GUIDE.md) 与 [当前状态说明](docs/CURRENT_WORKSPACE.md)。

## 环境要求

- Node.js 20 LTS
- npm 10 或更高版本
- JDK 17
- Android Studio 与 Android SDK 36

## 快速开始

```bash
git clone --branch vnext/implementation --single-branch https://github.com/yydd6677/laoji-app.git
cd laoji-app
npm ci
cp .env.example .env.local
npm run android:emulator:install
```

`.env.local` 不纳入版本控制。默认 API 地址为 `https://laoji.cloud`，实时语音地址由同一地址派生为 `wss://laoji.cloud`。协作者应按自己的部署环境补齐隐私政策、用户协议和其他公开地址，不要把凭据写入仓库。

## 验证和构建

```bash
npx tsc --noEmit
npm run verify:android-native-source
npm run verify:ui-known-regressions
npm run verify:ui-continuity
npm run android:release
```

Windows 使用 `gradlew.bat`。根目录 `android/`、依赖目录和构建缓存由工具生成，不要求提交。

发布构建需要受保护的 Android 签名配置。构建脚本会从当前配置生成干净的原生工程，并按目标限制 ABI；发布前必须核对版本号、构建号、签名、APK 哈希、更新清单和服务端兼容性。没有原签名密钥时生成的安装包不能覆盖已安装的正式包。

## 隐私和安全边界

公开仓库只包含源码、可公开配置、协议、测试和不含隐私的数据样例。服务器凭据、签名私钥、设备私钥、用户录音、真机证据、内部日志和部署机密不属于仓库内容，应通过本机环境变量、密钥管理器或私有归档提供。

当前兼容 device-v1 的 bootstrap 值会随发布包进入 `EXPO_PUBLIC` 配置，因此可从 APK 提取。它只是过渡期注册准入 token，不是秘密、设备身份或持久授权边界；不得复用任何服务器主密钥或其他用途的 secret。device-v2 使用设备 P-256 密钥、challenge 和短期 token，现有 v1 调用迁移后应删除该发布值。

不要使用 `git add -f` 绕过忽略规则，也不要在 Issue、提交信息或测试夹具中写入真实令牌、密码、用户内容或私有服务器路径。安全问题请按照 [SECURITY.md](SECURITY.md) 报告。

## 许可证

项目源码使用 MIT License。依赖项、模型和第三方工具分别遵循各自的许可证。
