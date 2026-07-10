# 老记 Android 模拟器自检记录

## 基本信息
- 日期：2026-07-08
- 设备来源：本机 Android Emulator，不使用 USB 手机。
- AVD：`LaoJi_API_35`
- 设备序列号：`emulator-5554`
- 系统镜像：Android 15 / API 35 / Google Play x86_64
- 验收 APK：`android/app/build/outputs/apk/release/app-release.apk`
- 证据目录：`/tmp/laoji-emulator-smoke`

## 变更记录
- 变更编号：CHG-20260708-EMULATOR-SELF-CHECK
- 维护类型：完善性 / 预防性维护
- 触发原因：减少发布前验收对用户手机 USB 连接的依赖，建立可重复的本机模拟器验证通道。
- 关联需求/用例：Android 发布候选验收、日程首页、日历切换、会议 Tab、语音输入弹窗。
- 影响范围：新增模拟器冒烟脚本 `scripts/android-emulator-smoke.sh`；新增本自检记录文档。
- 设计决策：优先使用本机已安装 Android SDK 与 `LaoJi_API_35` AVD；验收脚本通过 `adb + uiautomator dump + screencap` 固化路线和证据。
- 测试与回归范围：静态检查、Jest、Gradle release 构建、模拟器安装启动、关键 UI 路线点击与断言。
- 文档更新：本文件记录环境、路线、结果、问题和遗留风险；`release-hardening-review.md` 记录摘要。
- 风险与回滚方案：如模拟器脚本影响团队使用，可删除 `scripts/android-emulator-smoke.sh`，不影响 App 运行逻辑。

## 模拟器可用性检查
- `emulator -accel-check`：KVM 可用。
- `avdmanager list avd`：存在 `LaoJi_API_35`。
- `adb devices`：无 USB 手机时只应出现 `emulator-5554`。
- 启动参数：headless、KVM、4 核、3072MB RAM、SwiftShader 图形。

## 自动化冒烟路线
1. 安装 release APK。
2. 启动 `com.laoji.app`。
3. 如处于登录页，点击“游客体验”。
4. 断言进入日程页，并能看到“今日待办”和当前日期。
5. 点击 7 月 17 日，断言出现“当日待办”“9天后”“当日暂无待办”。
6. 点击底部“会议”，断言进入“会议记录”。
7. 点击底部“日程”，断言回到日程页。
8. 点击底部麦克风，断言打开“老记，说出你的日程”弹窗。
9. 在语音弹窗文本框输入英文测试内容，断言出现“解析”入口。

## 手工/半自动检查路线清单
- 登录页：启动、游客体验、登录空输入提示、忘记密码空账号提示、用户协议/隐私政策入口。
- 日程首页：搜索框聚焦、今日待办固定四行、无待办占位、日期切换、周日右列、今日实心/选中空心、周末蓝色。
- 日历切换：上一月/下一月、选择非今日日期、相对日期提示。
- 会议模块：会议空态/失败态、刷新按钮、会议详情入口可恢复错误。
- 语音入口：弹窗打开/关闭、手动文字输入、解析按钮出现、录音权限弹窗。
- 账号页：默认中性头像、访客资料、退出登录/清除数据入口。
- 稳定性：冷启动、后台恢复、旋转保持竖屏、断网/恢复网络、日志无明显崩溃。

## 执行记录
### 21:09-21:24 模拟器安装/启动/冒烟通道
- `adb devices`：无 USB 手机，只存在 `emulator-5554`。
- `emulator -accel-check`：KVM 可用。
- `avdmanager list avd`：`LaoJi_API_35` 已存在，可作为本机验收设备。
- release APK 安装：`adb -s emulator-5554 install -r android/app/build/outputs/apk/release/app-release.apk` 成功。
- 扩展冒烟脚本：`OUT_DIR=/tmp/laoji-emulator-smoke-extended-2 scripts/android-emulator-smoke.sh` 通过。
- Manifest 修复后冒烟：`OUT_DIR=/tmp/laoji-emulator-smoke-after-manifest scripts/android-emulator-smoke.sh` 通过。

### 21:14-21:22 静态检查与构建
- `npx tsc --noEmit`：通过。
- `npm test -- --maxWorkers=75%`：7 个测试套件、58 个测试全部通过。
- `./gradlew :app:lintRelease --parallel --build-cache --max-workers=$(nproc)`：通过；Manifest 修复后为 0 errors / 46 warnings。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过。
- logcat 抽样：未发现 `FATAL EXCEPTION`、App ANR 或 ReactNativeJS fatal。

### 21:21 Manifest 权限修复
- 文件：`android/app/src/main/AndroidManifest.xml`
- 修复内容：
  - 新增 `android.permission.POST_NOTIFICATIONS`。
  - 新增 `android.permission.READ_MEDIA_IMAGES`。
  - 为 `READ_EXTERNAL_STORAGE` 添加 `android:maxSdkVersion="32"`。
  - 为 `WRITE_EXTERNAL_STORAGE` 添加 `android:maxSdkVersion="28"`。
- 原因：`app.json` 已声明通知与图片权限，但 AndroidManifest 未同步；同时 lint 提示旧存储权限在 Android 13+ 已废弃。
- 回归：`lintRelease`、`assembleRelease`、扩展模拟器冒烟均通过。

### 21:28 三小时 soak 自检
- 命令：`DURATION_SECONDS=10800 INTERVAL_SECONDS=120 OUT_DIR=/tmp/laoji-emulator-soak-20260708 scripts/android-emulator-soak.sh`
- 范围：每轮执行完整扩展冒烟，轮后扫描 logcat；每 6 轮执行 TypeScript 检查，每 12 轮执行 Jest。
- 第 1 轮：通过，`/tmp/laoji-emulator-soak-20260708/run-001`，crash scan ok。
- 第 2-5 轮：通过，crash scan ok。
- 第 6 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 通过。
- 第 7-11 轮：通过，crash scan ok。
- 第 12 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 与 `npm test -- --maxWorkers=75%` 均通过。
- 第 13-17 轮：通过，crash scan ok。
- 第 18 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 通过。
- 第 19-23 轮：通过，crash scan ok。
- 第 24 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 与 `npm test -- --maxWorkers=75%` 均通过。
- 第 25-29 轮：通过，crash scan ok。
- 第 30 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 通过。
- 第 31-35 轮：通过，crash scan ok。
- 第 36 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 与 `npm test -- --maxWorkers=75%` 均通过。
- 第 37-41 轮：通过，crash scan ok。
- 第 42 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 通过。
- 第 43-45 轮：通过，crash scan ok。
- 第 46 轮：脚本断言误判，不是 App 崩溃。原因是长测跨过午夜后首页日期从 `2026年7月8日 周三` 正常变为 `2026年7月9日 周四`，旧脚本仍写死 7 月 8 日。

### 00:02 跨日断言修复
- 文件：`scripts/android-emulator-smoke.sh`
- 修复内容：将首页“今日”标题和选中 17 日后的相对日期从写死文案改为 `python3` 按运行当天动态计算。
- 验证：`OUT_DIR=/tmp/laoji-emulator-smoke-dynamic-date scripts/android-emulator-smoke.sh` 通过；脚本正确断言 `2026年7月9日 周四` 与 `8天后`。
- 补跑计划：启动 1 小时 resume soak，使累计 soak 时长超过 3 小时。

### 00:04 resume soak 自检
- 命令：`DURATION_SECONDS=3600 INTERVAL_SECONDS=120 OUT_DIR=/tmp/laoji-emulator-soak-20260709-resume scripts/android-emulator-soak.sh`
- 第 1-5 轮：通过，crash scan ok。
- 第 6 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 通过。
- 第 7-11 轮：通过，crash scan ok。
- 第 12 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 与 `npm test -- --maxWorkers=75%` 均通过。
- 第 13-17 轮：通过，crash scan ok。
- 第 18 轮：通过，crash scan ok；周期性 `npx tsc --noEmit` 通过。
- 完成：`soak complete; elapsed=3600s iterations=18`。

### 01:04 收尾审计
- 累计 soak：首段 45 轮完整通过，第 46 轮为跨日断言误判；补跑 18 轮完整通过。成功完整 soak 轮数合计 63 轮，另有跨日修复后的单轮冒烟通过。
- 累计时长：首段从 21:28 运行至 00:00 后触发脚本误判，补跑 3600 秒；整体自检窗口超过 3 小时。
- 崩溃扫描：`find /tmp/laoji-emulator-soak-20260708 /tmp/laoji-emulator-soak-20260709-resume -name crash-scan.txt -size +0 -print | wc -l` 返回 `0`。
- 最终 `npx tsc --noEmit`：通过。
- 最终 `npm test -- --maxWorkers=75%`：7 个测试套件、58 个测试全部通过。
- 最终 `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过，BUILD SUCCESSFUL。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116707023 bytes，SHA256 `200e869e86f0ec9e4183ea9e5977b49daafa40359f2e0935407555e8b936760a`。
- APK 权限抽查：包含 `POST_NOTIFICATIONS`、`READ_MEDIA_IMAGES`、`RECORD_AUDIO`、`INTERNET`；旧存储权限带 `maxSdkVersion`。
- `adb devices -l`：只有 `emulator-5554`，无 USB 手机参与。

## 当前静态风险
- 生产配置仍需替换裸 HTTP/IP：`app.json`、`eas.json`、`src/services/config.ts`、`src/services/realtimeAsr.ts` 中仍保留内网/协作环境地址。现有代码在 production 下有 `assertProductionApiConfig` 防线，但正式发布前仍应配置 HTTPS 域名。
- Android lint 剩余 warning 主要为 Android 14 图片部分访问提示、图标资源格式/形状提示、固定竖屏、未用资源、Gradle/依赖可升级；当前不阻塞 APK 构建和模拟器冒烟。
