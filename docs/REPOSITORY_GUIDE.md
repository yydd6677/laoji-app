# 老记仓库指南

## 1. 获取当前源码

```bash
git clone --branch vnext/implementation --single-branch https://github.com/yydd6677/laoji-app.git
```

`vnext/implementation` 是唯一活跃开发和发布分支。旧分支、标签和阶段材料只用于追溯；不要从它们复制文件来“恢复”当前实现。

## 2. 移动端开发

基础环境：Node.js 20 LTS、npm 10+、JDK 17、Android SDK 36。

```bash
npm ci
cp .env.example .env.local
npm run android:emulator:install   # 专用 emulator-5562
npm run android:device             # arm64 真机
npm run android:release            # 发布候选
```

Windows 使用 `copy` 和 Gradle 的 Windows wrapper。构建脚本会按目标选择 ABI；不要把模拟器 x86_64 包发布给真机，也不要把未使用 ABI 重新塞入正式 APK。

`.env.local` 只放环境覆盖值。当前非开发构建仍须注入兼容 device-v1 的 bootstrap admission token，并使用有效的 HTTPS 域名。该 `EXPO_PUBLIC` 值会进入 APK、可被提取，只用于过渡准入，不是秘密或鉴权边界，也不得复用其他 secret。任何 API key、签名材料、R2 凭据和设备私钥都不得进入 Git。

## 3. 服务端开发

- `services/laoji-api`：FastAPI 业务入口和持久任务编排。
- `services/laoji-asr`：Qwen3-ASR 实时/批量服务。
- Ollama：进程外的生成与 embedding provider；通过 `LlmProvider` 使用。

本地或隔离测试可覆盖端口，但生产合同固定为 API `18020`、ASR `8030`、Ollama `21434`，且内部端口只监听 loopback。生产切换必须核对实际 systemd user unit、工作目录、环境文件、模型 revision、readiness 和公网入口；源码存在不等于服务已运行。

## 4. 数据与状态边界

| 数据 | 权威位置 | 远端用途 |
| --- | --- | --- |
| 日程 | `laoji-schedule.db` | 仅复杂解析计算 |
| 会议及生成结果投影 | `laoji-meeting-memory.db` | 可恢复任务与显式允许的生成 artifact |
| 原始录音/导入音频 | 应用私有媒体目录 | R2 暂存和 ASR，按生命周期清理 |
| 外接设备采集 | 原生 pending media，确认后并入会议媒体 | 复用同一上传/转写链 |

Store、页面 state、native snapshot、WorkManager 和服务端 task 都只能投影状态，不能各自推进同一业务操作。遇到闪烁、重复任务或状态回退时，先找到 durable owner，不要增加新的锁、轮询或提示层。

## 5. 修改入口

| 需求 | 首先检查 |
| --- | --- |
| 日程与解析 | `src/data`、`src/store/EventsStore.tsx`、device-v2 schedule graph |
| 录音/导入/上传 | native recorder/importer、RecordingAsset、WorkManager、R2 session |
| 转写/讲话人 | transcript repository、realtime event ledger、8030、speaker overlay |
| 整理/待办 | immutable source、summary task、结构化 facts、adaptive projection、ActionItem |
| 会议问答 | Q2 source stream、grounding、当前会议来源版本 |
| 外接硬件 | `contracts/hardware`、native hardware runtime、`docs/hardware` |
| 页面卡顿/闪烁 | 数据装载时序、projection revision、组件身份和跨桥调用；不要只调动画 |
| 发布更新 | `app.config.js`、`android/app/build.gradle`、APK metadata、`tools/app-update/latest.json` |

## 6. 提交前最低检查

按改动范围执行，而不是无差别跑全部历史探针：

```bash
npx tsc --noEmit
npm run audit:ui-information
npm run verify:ui-known-regressions
npm run verify:ui-continuity
```

原生、服务端、数据库或发布修改还需运行对应单元测试/编译和真实边界验证。报告必须区分：源码已改、构建通过、服务已运行、设备已安装、公开已发布、真实流程已验证。

## 7. 文档入口

- [当前仓库状态](CURRENT_WORKSPACE.md)
- [当前设计蓝图](design-blueprint/CURRENT.md)
- [架构基线](design-blueprint/VNEXT.md)
- [实现约束](design-blueprint/VNEXT-IMPLEMENTATION.md)
- [有效决策](design-blueprint/VNEXT-DECISIONS.md)
- [外接硬件协议](hardware/LAOJI-HARDWARE-PROTOCOL-V1.md)

阶段证据和旧候选不属于默认搜索范围。需要追溯时按提交号查 Git，或从服务器校验归档恢复到仓库之外。
