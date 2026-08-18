# 老记

老记是一个 Android 优先的 React Native 日程与会议应用，支持文字和语音创建日程、本机提醒、实时会议转写、录音导入、会议整理、问答、回放和分享。

当前应用采用免登录、设备身份鉴权和本机数据优先的形态。日程、会议索引和用户编辑内容以设备本地数据为准；语音识别、复杂解析、整理、问答、分享和更新由兼容的远端服务提供。

## 仓库状态

- `master`：当前稳定发布基线 `1.1.10`，Android `versionCode=118`。
- `v1.1.10`：固定的稳定发布标签，可用于精确回溯。
- `vnext/implementation`：下一阶段开发线，默认候选能力不应直接视为生产能力。
- `rebuild/feishu-7.71.8-source-driven`：历史源码重建分支，保留用于追溯，不是默认协作入口。

分支、标签、当前阶段和文件边界见 [协作者仓库指南](docs/REPOSITORY_GUIDE.md) 与 [当前状态说明](docs/CURRENT_WORKSPACE.md)。

## 环境要求

- Node.js 20 LTS
- npm 10 或更高版本
- JDK 17
- Android Studio 与 Android SDK 36

## 快速开始

```bash
git clone --branch master --single-branch https://github.com/yydd6677/laoji-app.git
cd laoji-app
npm ci
cp .env.example .env.local
npm run android
```

`.env.local` 不纳入版本控制。默认 API 地址为 `https://laoji.cloud`，实时语音地址由同一地址派生为 `wss://laoji.cloud`。协作者应按自己的部署环境补齐隐私政策、用户协议和其他公开地址，不要把凭据写入仓库。

## 验证和构建

```bash
npx tsc --noEmit
cd android
./gradlew assemblePreview --parallel
```

Windows 使用 `gradlew.bat`。根目录 `android/`、依赖目录和构建缓存由工具生成，不要求提交。

生产构建还需要受保护的 Android 签名配置。没有原签名密钥时可以生成新的安装包，但不能覆盖已经使用另一密钥签名的安装包。EAS 配置中的 `preview` 生成 APK，`production` 生成 AAB；发布前必须核对版本号、签名、更新清单和服务端兼容性。

## 隐私和安全边界

公开仓库只包含源码、可公开配置、协议、测试和不含隐私的数据样例。服务器凭据、签名私钥、设备注册材料、用户录音、真机证据、内部日志和部署机密不属于仓库内容，应通过本机环境变量、密钥管理器或私有归档提供。

不要使用 `git add -f` 绕过忽略规则，也不要在 Issue、提交信息或测试夹具中写入真实令牌、密码、用户内容或私有服务器路径。安全问题请按照 [SECURITY.md](SECURITY.md) 报告。

## 许可证

项目源码使用 MIT License。依赖项、模型和第三方工具分别遵循各自的许可证。
