# 老记当前工作区

状态基线：2026-08-16。运行状态、版本号和服务部署会变化，使用前仍需现场复核。

## 唯一入口

- 活跃移动端源码：`/home/yydd/LaoJi-worktrees/feishu-source-driven`
- Git 分支：`rebuild/feishu-7.71.8-source-driven`
- Git 元数据锚点：`/home/yydd/LaoJi/mobile/.git`
- 生产后端：服务器 `/home/zhong/laoji-service-platform/compact-production/backend`
- 会议整理 v3 开发副本：`/home/yydd/LaoJi-service-worktrees/compact-production-v3/backend`
- 公网入口：`https://laoji.cloud` 与同域 `wss://`

`/home/yydd/LaoJi/mobile` 是旧版本工作树，但其 `.git` 同时管理当前活跃 worktree。它已设置为只展开根文件的 sparse checkout；需要查看旧分支源码时可在该目录执行 `git sparse-checkout disable`。它不是当前开发入口，也不能整体移动或删除。当前业务实现只从活跃移动端源码和服务器真实运行目录判断，不能从旧 APK、候选 overlay、评测快照或历史工程指示反推。

## 当前发布

- Android 版本：`1.1.7`，versionCode `115`
- 本地稳定包：`/home/yydd/LaoJi-stable-builds/current/laoji-1.1.7-115.apk`
- 本地更新清单：`/home/yydd/LaoJi-stable-builds/current/latest.json`
- 公网更新清单：`https://laoji.cloud/downloads/android/latest.json`
- APK SHA-256：`ec40176cb6ca067e108bbf9cf711d56c7fa903a5726a03b2b3eb7dc36446d824`

版本发布前必须重新核对 `app.config.js`、APK metadata、本地 `latest.json`、公网响应头、文件大小和 SHA-256；本节只记录本次整理时的基线。

公网下载地址为 `https://laoji.cloud/downloads/android/laoji-1.1.7-115.apk`。旧版 APK 继续保留，真机是否已升级仍需读取设备实际 metadata 判断。

## 源码边界

- React Native 业务：`App.tsx`、`src/`
- Android 原生业务：`modules/laoji-native-platform/android/src/main/`
- Expo 与发布配置：`app.config.js`、`plugins/`、`config/`
- 自动更新发布资料：`tools/app-update/`
- 当前人工审查入口：`docs/meeting-real-sample-quality/global-app-audit-20260815.md`
- 会议整理 v3 工程入口：`docs/meeting-summary-v3-implementation.md`
- v3 结果血缘/单 owner 原子提交仍是候选切片，未进入生产；以
  `docs/design-blueprint/CURRENT.md` 和其 0003/0005 文档为准。

账号 UI 和旧服务客户端仍有少量兼容类型或被当前模块间接引用。未经过调用图、完整编译和真实启动验证前，不因文件名看似旧而删除运行源码。

## 历史归档

本次整理的重资产位于服务器：

`/home/zhong/laoji-workspace-archives/2026-08-15-local-consolidation`

归档包含整理前 dirty 源码快照、完整 Git bundle、旧设计与构建、`light_plan` 中的服务候选/评测/演示资料，以及历史会话修复备份。详细文件、哈希和恢复方式见 [归档索引](WORKSPACE_ARCHIVE_20260815.md)；恢复时解压到新目录，不覆盖当前工作树或生产服务。

## 不属于老记

- `/home/yydd/桌面/light_plan/captures` 是其他项目素材，本次未处理。
- `emulator-5560` 属于 KataCR；老记只使用 `emulator-5562`。
- 服务器上的 Smart Meeting、PCB、GPU1 和其他用户服务不属于老记归档范围。
