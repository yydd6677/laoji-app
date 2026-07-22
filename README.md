# 老记

老记是一个 Android 优先的 React Native 日程与会议应用。它支持文字或语音创建日程、跨日期与重复事件、本机提醒、实时会议转写、会议总结、录音回放与资料分享。登录用户使用云端隔离数据，访客数据和会议录音保存在本机。

本仓库只包含移动端源码。日程解析、语音识别、会议转写与总结由部署方配置的服务提供；仓库不包含生产地址、服务器凭据、签名私钥或内部运维记录。

## 环境要求

- Node.js 20 LTS
- npm 10 或更高版本
- JDK 17
- Android Studio 与 Android SDK 36

## 本地运行

```bash
npm ci
cp .env.example .env.local
npm run android
```

`.env.example` 只使用文档域名。请在本机 `.env.local` 中设置自己的 API、WebSocket、隐私政策、用户协议和账号删除地址；`.env.local` 已被 Git 忽略。

实时语音配置中的 `EXPO_PUBLIC_REALTIME_ASR_HOST` 只填写主机名，不包含协议或路径。生产构建必须使用 HTTPS/WSS 域名，并将 `EXPO_PUBLIC_REALTIME_ASR_SECURE` 设为 `true`。

## 验证

```bash
npm run typecheck
npm run test:ci
npm run audit:dependencies
npm run audit:public
```

`audit:dependencies` 检查会进入生产安装图的依赖漏洞。`audit:public` 检查即将进入版本控制的文件边界、真实公网 IP、个人绝对路径和常见凭据，并要求本机安装 `gitleaks`。发布前还应对重写后的完整 Git 历史运行 Gitleaks，并从全新克隆再次执行以上命令。

## 当前开发目标

日历与会议记录后续优化的目标架构、数据契约和阶段路线见 [工程实施指示](docs/meeting-memory-engineering-directive.md)，老记语音创建入口见 [语音交互合同](docs/voice-schedule-interaction-contract.md)。

## 构建

开发 APK 可通过 Expo 本地原生构建生成。生产 AAB 使用 `eas.json` 的 `production` profile，并要求 EAS production environment 中存在全部 `EXPO_PUBLIC_*` 配置。正式 production 配置会拒绝裸 IP、明文 HTTP、不安全 WebSocket、保留域名和明显占位域名。

`APP_ENV=production-rehearsal` 只用于以 `example.com` 等脱敏域名验证本地签名、HTTPS/WSS、AAB 拆分和安装链路。该模式同样关闭 Android 明文流量并要求 release signing，但生成物不能提交应用商店；EAS `production` profile 会强制切回正式 production 规则。

## 隐私边界

以下内容仅在开发工作区本地保存，不属于公开源码：协作者原始资料、服务器审阅记录、真机截图、录音素材、质量报告、环境配置和签名材料。公开前不要使用 `git add -f` 绕过 `.gitignore`。

## 安全问题

请按照 [SECURITY.md](SECURITY.md) 提交安全报告，不要在公开 Issue 中披露漏洞或凭据。

## 许可证

项目源码使用 [MIT License](LICENSE)。依赖项和设计工具产生的第三方代码仍分别遵循其原始许可证。
