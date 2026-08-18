# 老记当前仓库状态

本文是面向协作者的公共状态入口，不记录任何开发机、服务器或个人目录。运行服务、发布地址和设备状态会变化；需要部署时，应以部署环境的实际检查结果为准。

## 分支和标签

| 引用 | 用途 | 采用边界 |
| --- | --- | --- |
| `master` | 稳定发布线 | 当前 `1.1.10`，可作为协作者默认基线 |
| `v1.1.10` | 稳定版本快照 | 固定引用，不随分支移动 |
| `vnext/implementation` | 下一阶段开发线 | 候选能力默认关闭，未自动等同于生产 |
| `rebuild/feishu-7.71.8-source-driven` | 历史源码重建线 | 仅用于追溯和差异研究 |

开发新功能从 `vnext/implementation` 分支开始；修复稳定版时从 `master` 建立短期修复分支，并通过合并请求回到 `master`。

## 文件结构

```text
App.tsx                         应用入口和顶层导航
src/
  application/                  用例编排和跨领域流程
  components/                   可复用界面、弹窗和状态组件
  data/                         SQLite、迁移和本地仓储
  domain/                       日程、会议、整理、问答等领域模型
  hooks/                        React 领域 hooks
  native/                       JS 与原生投影适配
  screens/                      页面级界面
  services/                     远端 API、任务和本地服务
  store/                        页面订阅状态，不作为业务数据权威
modules/laoji-native-platform/  Android 原生录音、日历、媒体和投影能力
contracts/vnext/                共享 JSON Schema、生成代码和兼容性合同
services/laoji-api/             FastAPI 业务 API、任务 owner 和编排
services/laoji-asr/             ASR 适配和批处理服务
plugins/                        Expo 配置插件
config/                         部署和构建配置解析
tools/                          更新、迁移、审计和开发工具
docs/                           产品蓝图、阶段记录、架构证据和协作说明
```

## 当前实现边界

- 手机本地 SQLite 和应用私有媒体是日程、会议索引和用户编辑数据的业务权威。
- 服务端负责设备鉴权、语音识别、复杂解析、整理、问答、分享和临时任务；服务端不应把客户端本地数据模型复制成第二个长期权威。
- `master` 是已发布稳定链路；vNext 文档和候选实现必须通过各自阶段合同后才能跨能力开关进入生产。
- `docs/design-blueprint/CURRENT.md` 是蓝图入口；历史 `research/`、`evidence/`、`revisions/` 和 `proposals/` 用于决策血缘，不是默认开发入口。

## 生成文件和本地配置

以下内容不应提交：`node_modules/`、根目录 `android/` 生成树、Gradle/CMake 缓存、`.env.local`、签名材料、APK/AAB 和用户媒体。依赖由 `package-lock.json` 锁定，使用 `npm ci` 重建；原生目录由 Expo/Gradle 按当前配置生成。

## 开发状态如何更新

提交功能时应同时更新受影响的合同、README 或阶段文档，并在提交信息中说明变更边界。不要把某台机器的绝对路径、临时端口、设备序列号或现场日志写入公共文档；需要描述外部资源时使用环境变量名或仓库相对路径。
