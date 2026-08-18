# 协作者仓库指南

本文帮助新协作者在不依赖维护者本机环境的情况下理解仓库、选择正确分支并完成第一次构建。

## 1. 获取正确版本

```bash
# 稳定发布线
git clone --branch master --single-branch https://github.com/yydd6677/laoji-app.git

# 下一阶段开发线
git clone --branch vnext/implementation --single-branch https://github.com/yydd6677/laoji-app.git

# 精确复现 1.1.10
git clone --branch v1.1.10 --single-branch https://github.com/yydd6677/laoji-app.git
```

`master` 和 `v1.1.10` 的内容应保持稳定；vNext 允许快速变化，不能把它直接当作可发布 APK。

## 2. 第一次构建

需要 Node.js 20 LTS、npm 10+、JDK 17、Android SDK 36。进入仓库后执行：

```bash
npm ci
cp .env.example .env.local
npm run android
```

Windows 使用 `copy .env.example .env.local` 和 `gradlew.bat`。API 地址、隐私政策地址和协议地址通过 `.env.local` 或 CI secret 注入；不要提交真实值。

## 3. 目录职责

| 目录 | 责任 |
| --- | --- |
| `src/application` | 用例编排，连接界面、领域和仓储 |
| `src/domain` | 日程、会议、转写、整理、问答和待办的领域规则 |
| `src/data` | SQLite schema、迁移和本地业务仓储 |
| `src/services` | HTTP/WSS 客户端、任务恢复和本地服务适配 |
| `src/screens`、`src/components` | 页面和可复用界面 |
| `modules/laoji-native-platform` | Android 原生录音、媒体、日历、文件导入和投影 |
| `contracts/vnext` | 跨端 JSON Schema、生成代码和版本兼容合同 |
| `services/laoji-api` | FastAPI 业务 API、任务 owner 和服务编排 |
| `services/laoji-asr` | ASR provider 适配、批处理和实时协议 |
| `deploy`、`tools` | 部署模板、迁移、更新和审计工具 |
| `docs/design-blueprint` | 当前蓝图、阶段实施、决策和证据血缘 |

## 4. 运行边界

移动端的本地数据库和应用私有媒体是用户业务数据的权威。远端服务只处理设备授权范围内的识别、解析、整理、问答、分享和临时任务。生产服务地址不硬编码到文档之外的私密环境；开发环境使用变量覆盖公开默认值。

## 5. 提交和分支约定

- 功能开发从 `vnext/implementation` 建立短期分支。
- 稳定修复从 `master` 建立短期分支，并保留测试和迁移说明。
- 发布版本同时创建不可移动的 `vX.Y.Z` 标签。
- 提交前运行受影响模块的类型检查和测试；不要提交生成目录、凭据、用户媒体或整机日志。
- 需要描述本机或服务器外部资源时，使用 `$MOBILE_REPO`、`$SERVICE_REPO` 等变量名，不写真实绝对路径。

## 6. 文档入口

- [当前仓库状态](CURRENT_WORKSPACE.md)
- [vNext 蓝图](design-blueprint/CURRENT.md)
- [vNext 实施指示](design-blueprint/VNEXT-IMPLEMENTATION.md)
- [安全报告流程](../SECURITY.md)
