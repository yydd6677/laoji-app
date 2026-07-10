# 老记 Android 发布补全协作记录

## 2026-07-10 会议录音持久化与游客云端总结

### 变更记录
- 变更编号：`CHG-20260710-03`
- 维护类型：纠错性维护与完善性维护。
- 触发原因：Android 实时会议只保留转写，原生录音模块停止时不返回文件；客户端同时硬编码禁止游客生成云端总结。
- 移动端影响范围：`react-native-live-audio-stream` 补丁、`realtimeAsr`、实时会议/转写/详情页面、会议总结服务与 API 客户端。
- 服务端影响范围：工作区 `18020` App 会议接口、临时总结任务、会议总结模型配置和 Ollama 客户端；原协作者 `8020/8035` 服务未修改。
- 设计决策：Android 在 App 私有 `files/meeting-audio` 目录并行写入 PCM WAV，停止后补写 WAV 头并返回 `file://` URI；登录用户继续上传云端，游客保留本机 URI。游客转写通过不写 SQLite 的临时目录生成总结，结果只由随机任务 ID 返回并在 App 本机缓存。
- 资源策略：所有后续会议总结默认使用 `qwen3:8b`；Ollama 单次上下文默认 `8192`，超过 5000 个中文字符的会议继续走既有 Map-Reduce 分块；任务结束使用 `OLLAMA_BIN` 正确卸载模型。
- 限制策略：按需求移除游客接口的公网来源每小时次数限制、500 句限制和 5 万字符总长度限制；仍保留至少一条非空转写及单句结构校验。
- 风险与回滚方案：公开游客总结会增加算力滥用风险；服务器备份位于 `/home/zhong/laoji-service-platform/backups/20260710-guest-summary-audio`。回滚时恢复备份的后端、`meetingsummary` 文件和配置，重启 `18020`，移动端恢复本补丁前版本。

### 接口与验证
- 新增 `POST /api/laoji/meetings/guest-summary` 和 `GET /api/laoji/meetings/guest-summary/tasks/{task_id}`，均不要求登录；游客会议本体和总结不写共享会议数据库。
- 服务端候选导入与 Python 编译通过；契约测试连续调用 7 次、每次 501 句均进入任务提交逻辑，OpenAPI 的 `transcript_lines` 无 `maxItems`。
- 真实 8B 游客总结链路通过：8192 上下文冷请求约 60 秒，热模型请求约 28 秒；返回会议概览、关键决策和行动项，结束后 `ollama ps` 为空，GPU 回落到 ASR 基线。
- `18020/18035/8020/8035` 均保持监听，`18020 /health` 返回 ok；重启前检查无活动 WebSocket 连接。
- `npx tsc --noEmit`：通过；`npm test -- --runInBand`：11 suites / 88 tests passed。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：BUILD SUCCESSFUL。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，88294249 bytes，SHA-256 `6763b343b6e9a387da15c7880735c84f27825fa413dfb03f6de01338ab1c0283`。
- 按用户偏好，本次仅构建未覆盖安装手机；WAV 已通过 release Java 编译和 APK 构建，仍需在用户明确要求安装后做一次真机录制、重启 App 后回放及登录态上传验收。

## 2026-07-10 实时会议录音入口去重

### 变更记录
- 变更编号：`CHG-20260710-02`
- 维护类型：完善性维护。
- 触发原因：实时会议页面内容区录音按钮与全局底部麦克风重复，造成同一主操作出现两个入口。
- 影响范围：`src/screens/MeetingLiveScreen.tsx`；不修改录音、实时转写、音频上传、总结生成或服务端接口。
- 设计决策：移除内容区悬浮录音按钮，只保留现有底部凹形栏麦克风；会议状态、计时、音量和错误反馈继续显示在内容区。
- 测试与回归范围：静态重复入口检查、TypeScript、Jest 全量、Android release 构建、USB 覆盖安装和启动崩溃扫描。
- 风险与回滚方案：底部按钮继续复用原 `startRecording` / `stopRecording` 分支；如需回滚，可恢复本次提交前的 `fixedControls` 代码块和样式。

### 验证结果
- 静态检查：`MeetingLiveScreen` 不再包含 `fixedControls`、独立录音按钮或对应渐变/加载依赖；只保留 `BottomTabBar.onMic` 的开始/停止分支。
- `npx tsc --noEmit`：通过。
- `npm test -- --runInBand`：10 suites / 83 tests passed。
- `./gradlew assembleRelease --parallel --max-workers=$(nproc)`：BUILD SUCCESSFUL，Metro 重新生成 release JS bundle。
- `adb install -r android/app/build/outputs/apk/release/app-release.apk`：Success，保留原有 App 数据。
- 本地 APK 与手机已安装 `base.apk` 的 SHA-256 均为 `d95410bf6a37049f0540f74010ea8cb50f55fb5b75c8ef36b530a847307e5226`；设备更新时间为 `2026-07-10 09:08:24`。
- 真机检查：`com.laoji.app/.MainActivity` 正常运行，崩溃扫描为 0；实时会议页截图确认内容区无重复录音按钮，底部麦克风可启动实时转写。

## 2026-07-10 GitHub 提交与 USB 真机更新

### 变更记录
- 变更编号：`CHG-20260710-01`
- 维护类型：完善性维护与配置管理。
- 触发原因：将日程解析、会议闭环、用户隔离、本机缓存及发布加固成果提交到项目 GitHub，并将最新 release APK 更新到 USB 真机。
- 关联需求/用例：Android 发布候选、日程文字/语音输入、登录与访客数据隔离、会议录制/转写/总结/分享。
- 影响范围：移动端源码、单元测试、Android 构建配置、协作资料、设计参考、ASR 与日程鲁棒性测试资产；不修改服务器运行状态和接口契约。
- 设计决策：提交可复现的测试样本与诊断报告；忽略 `tmp/`、Python 字节码和本机构建产物；使用 `adb install -r` 保留现有 App 数据。
- 测试与回归范围：TypeScript、Jest 全量、Gradle release 构建、APK 哈希一致性、包版本/更新时间、启动与崩溃日志。
- 文档更新：本节记录提交前门禁、安装结果和验收边界。
- 风险与回滚方案：手机处于密码锁屏，无法完成安装后的可视化页面路线验收；如需回滚，可重新安装上一版同签名 APK，或从 Git 历史检出上一提交重新构建。

### 验证结果
- 敏感信息审查：未发现已知服务器密码、sudo 密码、私钥、GitHub token、AWS key 或 OpenAI key 模式；生产地址仍需在正式发布前替换为 HTTPS 域名。
- `npx tsc --noEmit`：通过。
- `npm test -- --runInBand`：10 suites / 83 tests passed。
- `./gradlew assembleRelease --parallel --max-workers=$(nproc)`：BUILD SUCCESSFUL。
- `adb install -r android/app/build/outputs/apk/release/app-release.apk`：Success，保留原有 App 数据。
- 本地 APK 与手机已安装 `base.apk` 的 SHA-256 均为 `8a7389f1aa4dbbed016bcaf13ec730503600cc9d31d325c14be7584e27f1ed89`。
- 设备包信息：`com.laoji.app`，`versionCode=1`，`versionName=1.0.0`，`lastUpdateTime=2026-07-10 08:59:26`。
- 启动验证：`com.laoji.app/.MainActivity` 可启动，安装后日志未发现 AndroidRuntime/ReactNativeJS 致命崩溃；手机停留在系统密码锁屏，因此未执行页面点击路线。

## 2026-07-09 App 会议系统发布候选

### 变更摘要
- 移动端会议模块从只展示外部原型会议列表，升级为 App 专用会议闭环：创建会议、实时录音、实时转写、录音保存/上传、转写缓存、总结生成、详情播放、导出和系统分享。
- 会议 API 切换到 App 专用安全接口 `/api/laoji/meetings`，登录用户按 Bearer token 隔离；游客会议只保存在本机缓存。
- 会议页底部麦克风在会议 Tab/会议详情/会议转写页中绑定会议录音入口，不再打开日程语音输入弹窗。
- 移除 `expo-dev-client` 依赖和 EAS development profile 的 `developmentClient` 配置，release APK/AAB 不再打入 Expo Dev Client / Dev Launcher / Dev Menu。

### 移动端文件
- 会议接口与类型：`src/services/api.ts`、`src/types/index.ts`。
- 实时 ASR：`src/services/realtimeAsr.ts`，WebSocket URL 支持 `access_token`，停止录音时返回本机音频路径。
- 会议状态与缓存：`src/store/MeetingsStore.tsx`，按 `user:<id>` / `guest` 隔离会议、转写和总结缓存。
- 页面：`src/screens/MeetingListScreen.tsx`、`src/screens/MeetingLiveScreen.tsx`、`src/screens/RecordingScreen.tsx`、`src/screens/TranscriptionScreen.tsx`、`src/navigation/index.tsx`。
- 发布依赖：`package.json`、`package-lock.json`、`eas.json`。

### 接口契约
- `POST /api/laoji/meetings`：登录用户创建 App-owned 会议。
- `GET /api/laoji/meetings`：仅返回当前用户会议。
- `GET/PATCH/DELETE /api/laoji/meetings/{meeting_id}`：仅允许当前用户访问自己的会议。
- `POST /api/laoji/meetings/{meeting_id}/audio`：上传会议录音文件。
- `GET /api/laoji/meetings/{meeting_id}/audio` 与 `/audio/file`：读取音频元信息和受鉴权保护的音频文件。
- `GET /api/laoji/meetings/{meeting_id}/transcripts`：读取转写。
- `POST /api/laoji/meetings/{meeting_id}/summaries/generate`、`GET /summaries/task/{task_id}`、`GET /summaries/final`：生成和读取最终总结。
- 实时转写 WebSocket：App-owned meeting 必须在 query 中传 `access_token` 或 `token`；旧原型会议仍兼容无用户隔离路径。

### 验证结果
- 移动端：`npx tsc --noEmit` 通过。
- 移动端：`npm test -- --runInBand` 通过，10 suites / 83 tests passed。
- Android：移除 `expo-dev-client` 后重新执行 `./gradlew assembleRelease bundleRelease --parallel --max-workers=$(nproc)`，BUILD SUCCESSFUL。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，88291421 bytes，约 85M。
- AAB：`android/app/build/outputs/bundle/release/app-release.aab`，60966767 bytes，约 59M。
- 依赖抽查：`npm ls expo-dev-client expo-dev-launcher expo-dev-menu expo-dev-menu-interface --depth=3` 返回 empty；release APK 中未发现 Expo dev launcher/menu 字符串。
- 服务器：`http://127.0.0.1:18020/health` 返回 ok；OpenAPI 暴露 `/api/laoji/meetings` 系列接口，旧 `/api/meetings` 仍保留。
- 用户隔离烟测：两个临时账号各自创建会议后，只能在自己的 `/api/laoji/meetings` 列表中看到自己的会议；临时会议已删除。
- WebSocket 鉴权烟测：App-owned meeting 带 token 的 `ws://127.0.0.1:18020/ws/meeting/{id}/funasr?access_token=...` 可连接；无 token 连接被拒绝；临时会议已删除。
- 音频烟测：临时会议上传 44-byte WAV 后返回 `/api/laoji/meetings/{id}/audio/file` 且 `requires_auth=true`；带 token 下载返回 `RIFF...WAVE`；临时会议已删除。

### 风险与回滚提示
- 当前本地 release 产物仍使用协作环境 HTTP 地址，适合真机/内测验证；正式上架 production 必须通过环境变量提供 HTTPS 域名，`app.config.js` 已在 production 下阻止裸 HTTP/IP。
- 会议总结质量、ASR 质量和 Qwen 推理速度属于外部服务能力；App 侧只验证调用、展示、失败态和缓存降级。
- 如会议新接口需要回滚，移动端可临时切回旧 `/api/meetings` 只读展示，但会失去 App 用户隔离、游客本机缓存和实时会议录入闭环。

## 2026-07-08

### 变更摘要
- 移动端补齐账号安全、云端资料/头像、日程提醒、会议录音播放、法律与帮助内容页。
- 当前工作区未发现后端服务源码；本次实现移动端调用和接口契约，后端需在对应服务仓库补齐接口。
- 新增原生能力：系统通知、照片选择。Android release 包需要重新构建后安装验证。

### 接口契约
- `POST /api/auth/change-password`
  - Header：`Authorization: Bearer <token>`
  - Body：`{ "current_password": string, "new_password": string }`
  - 用途：登录态修改密码。
- `POST /api/auth/password-reset-requests`
  - Body：`{ "account": string }`
  - 用途：忘记密码时提交人工重置请求。
- `GET /api/auth/me/profile`
  - Header：`Authorization: Bearer <token>`
  - 返回：`nickname/email/phone/avatar_initial/avatar_colors/avatar_url`。
- `PATCH /api/auth/me/profile`
  - Header：`Authorization: Bearer <token>`
  - Body：可选 `nickname/email/phone/avatar_initial/avatar_colors`。
- `POST /api/auth/me/avatar`
  - Header：`Authorization: Bearer <token>`
  - Body：`multipart/form-data`，字段名 `file`。
  - 返回：资料对象，至少包含最新 `avatar_url`。
- `DELETE /api/auth/me/avatar`
  - Header：`Authorization: Bearer <token>`
  - 用途：删除云端头像。
- `POST/GET/PUT /api/laoji/events`
  - 事件对象新增 `reminder_minutes: number | null`。
  - `null` 表示不提醒，`0` 表示开始时提醒，正数表示提前分钟数。
- `GET /api/meetings/:id/audio-url`
  - 返回：`{ "url": string, "mime_type": string, "duration_sec": number, "file_name": string, "expires_at": string }`。
  - 移动端只播放 `https://` 音频地址；无地址或非 HTTPS 地址会显示“仅有转写，无录音文件”。

### 移动端文件
- 账号与资料：`src/services/auth.ts`、`src/services/profile.ts`、`src/store/AuthStore.tsx`、`src/screens/AccountScreen.tsx`。
- 日程提醒：`src/services/notifications.ts`、`src/store/EventsStore.tsx`、`src/screens/AddEventScreen.tsx`、`src/screens/EventDetailScreen.tsx`。
- 会议录音：`src/services/api.ts`、`src/screens/RecordingScreen.tsx`。
- 法律与帮助：`src/screens/LegalDocumentScreen.tsx`、`src/navigation/index.tsx`、`src/screens/LoginScreen.tsx`、`src/screens/PrivacyScreen.tsx`。
- 原生配置：`app.json`、`package.json`、`package-lock.json`。

### 验证建议
- 客户端：`npx tsc --noEmit`、`npm test -- --runInBand`、`./gradlew assembleRelease`。
- 真机：安装 release APK 后验证相册权限、通知权限、改密失败态、忘记密码请求、默认 15 分钟提醒、会议无音频降级、HTTPS 音频播放。
- 后端：补齐接口后用登录账号验证资料同步、头像上传、事件提醒字段持久化和会议音频签名 URL。

### 回滚提示
- 如通知能力导致构建异常，可先移除 `expo-notifications` 依赖、`app.json` 插件和 `src/services/notifications.ts` 调用，事件字段保留为无害扩展。
- 如头像上传接口未就绪，移动端会提示上传失败；访客头像仍可本机保存。
- 如会议音频接口未就绪，移动端保持转写/总结可用，并显示无录音文件。

## 2026-07-08 模拟器自检与 Android 权限维护

### 变更摘要
- 新增 `scripts/android-emulator-smoke.sh`，用于本机 Android Emulator 安装 APK、执行登录/日程/会议/账号/语音入口冒烟验收，并保存截图与 UI dump。
- 新增 `scripts/android-emulator-soak.sh`，用于不少于三小时的循环冒烟、logcat 崩溃扫描、周期性 TypeScript/Jest 检查。
- 新增 `docs/collaboration/emulator-self-check-2026-07-08.md`，记录模拟器环境、检查路线、命令结果、风险与回滚。
- 修复 `android/app/src/main/AndroidManifest.xml` 权限：补齐通知和 Android 13+ 图片权限，并给旧存储权限添加版本上限。

### 验证结果
- 模拟器：`LaoJi_API_35` / `emulator-5554`，KVM 可用；无 USB 手机设备参与。
- `npx tsc --noEmit`：通过。
- `npm test -- --maxWorkers=75%`：7 suites / 58 tests passed。
- `./gradlew :app:lintRelease --parallel --build-cache --max-workers=$(nproc)`：通过，0 errors / 46 warnings。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过。
- `OUT_DIR=/tmp/laoji-emulator-smoke-after-manifest scripts/android-emulator-smoke.sh`：通过。
- 三小时以上模拟器自检完成：
  - 首段 `DURATION_SECONDS=10800` soak 从 21:28 跑到 00:00，45 轮完整通过；第 46 轮因脚本写死 7 月 8 日而在跨日后误判失败，非 App 崩溃。
  - 已修复 `scripts/android-emulator-smoke.sh` 的今日标题和相对日期断言，改为按运行当天动态计算。
  - 补跑 `DURATION_SECONDS=3600` resume soak 完成 18 轮，`soak complete; elapsed=3600s iterations=18`。
  - 成功完整 soak 合计 63 轮；另有跨日修复后单轮冒烟通过。
  - 两段 soak 的非空 `crash-scan.txt` 数量为 0。
  - 最终 `npx tsc --noEmit`、`npm test -- --maxWorkers=75%`、`./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)` 均通过。
  - APK：`android/app/build/outputs/apk/release/app-release.apk`，116707023 bytes，SHA256 `200e869e86f0ec9e4183ea9e5977b49daafa40359f2e0935407555e8b936760a`。

### 风险与回滚提示
- 如 Manifest 权限修复引发兼容问题，可回退 `POST_NOTIFICATIONS`/`READ_MEDIA_IMAGES` 与旧存储权限 `maxSdkVersion` 修改，但会降低通知、头像选择和 Android lint 的发布可信度。
- 生产发布仍需替换裸 HTTP/IP 为 HTTPS 域名；本次模拟器验收仍使用协作环境地址。

## 2026-07-09 USB 真机更新

### 设备与安装
- 设备：`825f509d`，`23013RK75C`，USB 已授权。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116707023 bytes，SHA256 `200e869e86f0ec9e4183ea9e5977b49daafa40359f2e0935407555e8b936760a`。
- 构建：`./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)` 通过，BUILD SUCCESSFUL。
- 安装：`adb -s 825f509d install -r android/app/build/outputs/apk/release/app-release.apk` 成功，未清除 App 数据。
- 安装后包信息：`versionCode=1`，`versionName=1.0.0`，`lastUpdateTime=2026-07-09 09:21:55`。

### 启动验证
- 冷启动：`adb -s 825f509d shell monkey -p com.laoji.app -c android.intent.category.LAUNCHER 1` 成功。
- UI dump：启动后可见“日程”“今日待办”。
- logcat：未匹配到 `FATAL EXCEPTION`、`ANR in com.laoji.app`、`E ReactNativeJS` 或 `JavascriptException`。

### 注意事项
- 本次是同版本号覆盖安装；正式面向用户更新前仍需提升 `versionCode`，否则应用商店/系统更新流程无法表达新版本。

## 2026-07-09 底部麦克风按钮尺寸调整

### 变更摘要
- 文件：`src/components/BottomTabBar.tsx`
- 将底部中央麦克风按钮直径从 `58` 调整为 `70`，约增大 20%。
- 将麦克风图标从 `24` 调整为 `29`，保持按钮和图标比例一致。

### 验证结果
- `npx tsc --noEmit`：通过。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过，BUILD SUCCESSFUL。
- USB 真机 `825f509d` 覆盖安装成功，未清除 App 数据。
- 安装后 `lastUpdateTime=2026-07-09 09:33:15`。
- 冷启动后 UI dump 可见“日程”“今日待办”，logcat 未匹配到 App fatal、ANR 或 ReactNativeJS fatal。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116707035 bytes，SHA256 `c4541b9d170edfdb74c31cd5cb0505794c1440634964e7d1a7900bc6a7358840`。

## 2026-07-09 日程搜索排序

### 变更摘要
- 新增 `src/utils/eventOrdering.ts`，为日程搜索结果提供稳定排序。
- 修改 `src/screens/ScheduleScreen.tsx`，搜索命中的日程不再沿用原始 `events` 顺序，而是按“今日、未来、过去”的相对日期规则展示。
- 新增 `__tests__/eventOrdering.test.ts`，覆盖今日优先、未来最近优先、过去最近优先、同日时间排序和跨日事件覆盖今天的排序。

### 排序规则
- 今日事件最先展示。
- 未来事件排在今日之后，离今天越近越靠前。
- 过去事件排在未来之后，离今天越近越靠前。
- 同一天内按开始时间、结束时间、标题、原始顺序排序；无明确开始时间的事件排在当天靠后。
- 跨日事件如果覆盖今天，按今日事件处理；如果在未来开始，按开始日期距离排序；如果已经结束，按结束日期距离排序。

### 验证结果
- `npx tsc --noEmit`：通过。
- `npm test -- --maxWorkers=75% eventOrdering taskOrdering`：2 suites / 5 tests passed。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过，BUILD SUCCESSFUL。
- USB 真机 `825f509d` 覆盖安装成功，未清除 App 数据。
- 安装后 `lastUpdateTime=2026-07-09 09:46:43`。
- 冷启动后 UI dump 可见“日程”“今日待办”，logcat 未匹配到 App fatal、ANR 或 ReactNativeJS fatal。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116708915 bytes，SHA256 `99d0bad82b106db5b2567a3c5dcdbf9a1d5b159458cca115ff710cf433edeef1`。

### 跨日期解析观察
- 当前移动端 `ParseResult` 只包含 `start_date`、`start_time`、`end_time`、`is_all_day` 等字段，没有 `end_date`。
- 语音/文字确认页只展示 `draft.start_date` 和当天时间段，保存时也只传 `startDate`、`startTime`、`endTime`，不会生成 `endDate` 或 `spanning`。
- 当前 `ApiEvent` 与 `POST /api/laoji/events` 调用也没有 `end_date` 字段，因此“某日到某日完成一件事”即使原文表达清楚，也无法在现有 App 接口链路中保存为跨日事件。
- 要支持跨日期日程，需要扩展解析结果、保存接口和本地事件映射：至少增加 `end_date`，并在移动端保存为 `endDate`/`spanning`。

## 2026-07-09 跨日期事件与云端事件字段补齐

### 变更摘要
- 服务器 LaoJi 后端补齐跨日期事件接口：解析、创建、更新、查询和详情响应新增 `end_date`。
- 服务器事件契约同步补齐移动端/设计中已有但后端未持久化的字段：`color`、`spanning`、`location`、`category`、`detail`、`status`、`reminder_minutes`。
- 移动端 `ParseResult`、`ApiEvent`、`EventsStore` 和语音确认页已接入新字段。
- 今日待办选择逻辑已支持“覆盖选中日期”的定时跨日事件；全天跨日事件仍不进入定时待办列表。

### 服务器文件
- `/home/zhong/SMART-MEETING2 (copy)(lx)/smart-meeting-ai/backend/app/schemas/schedule.py`
- `/home/zhong/SMART-MEETING2 (copy)(lx)/smart-meeting-ai/backend/app/laoji/router.py`
- `/home/zhong/SMART-MEETING2 (copy)(lx)/smart-meeting-ai/backend/app/services/schedule_db_service.py`
- `/home/zhong/SMART-MEETING2 (copy)(lx)/smart-meeting-ai/backend/app/services/schedule_parser_service.py`
- 服务器审阅记录：`/home/zhong/SMART-MEETING2 (copy)(lx)/smart-meeting-ai/backend/docs/collaboration/laoji-backend-review.md`

### 移动端文件
- `src/types/index.ts`
- `src/services/api.ts`
- `src/store/EventsStore.tsx`
- `src/components/VoiceInputModal.tsx`
- `src/screens/EventDetailScreen.tsx`
- `src/utils/taskOrdering.ts`
- `__tests__/taskOrdering.test.ts`

### 接口契约
- `POST /api/laoji/parse`、`POST /api/laoji/clarify`、`POST /api/laoji/parse-audio` 响应新增：
  - `end_date: string | null`
  - `color: string | null`
  - `spanning: boolean`
  - `location/category/detail/status: string | null`
  - `reminder_minutes: number | null`
- `POST/GET/PUT /api/laoji/events` 事件对象新增同名字段。
- `GET /api/laoji/events?year=&month=` 对一次性事件改为按 `[start_date, end_date]` 与目标月份是否相交查询；跨月事件会出现在起始月和结束月。

### 验证结果
- 服务器：`python3 -m py_compile app/schemas/schedule.py app/laoji/router.py app/services/schedule_db_service.py app/services/schedule_parser_service.py` 通过。
- 服务器临时 SQLite：`2026-07-30` 到 `2026-08-02` 事件可在 7 月、8 月和 `2026-08-01` 日查询返回。
- 服务器 HTTP：重启 8035 后 `/health` 返回 ok；`POST /api/laoji/parse` 对 `7月19日到7月25日完成笔记本制作` 返回 `end_date=2026-07-25`、`spanning=true`。
- 移动端：`npx tsc --noEmit` 通过。
- 移动端：`npm test -- --maxWorkers=75% taskOrdering eventOrdering api` 通过，3 suites / 31 tests passed。
- Android release：`./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)` 通过。
- USB 真机 `825f509d` 覆盖安装成功，安装后 `lastUpdateTime=2026-07-09 10:44:15`；冷启动后 logcat 未匹配到 App fatal、ANR 或 ReactNativeJS fatal。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116710879 bytes，SHA256 `211d5c0e2bc7f72663dd9e1523e1bddcde8a1aefac1eb95c264318ee75a464e1`。

### 回滚提示
- 服务器文件已备份为 `.bak-20260709-102915-cross-date` 后缀；如需回滚，停止 8035 进程后恢复这四个备份文件并重启 uvicorn。
- 本次 SQLite 迁移只新增可空列和索引；旧客户端可忽略新增字段。
- 若移动端出现旧数据兼容问题，可临时只保留 `end_date` 映射，继续让 `location/category/detail/status/reminder_minutes` 走本机 metadata 兜底。

## 2026-07-09 保存失败与通知触发修复

### 问题定位
- USB 真机 `825f509d` 上复现“今天11点15打球”确认页显示“保存失败，请重试”。
- 服务器 `logs/laoji-8035.log` 同时段只有 `POST /api/laoji/parse`，没有 `POST /api/laoji/events`，说明失败发生在移动端保存请求发出前。
- 该设备当前保存走访客/本机数据路径；默认 `reminder_minutes=15` 时，11:15 事件会尝试在 11:00 调度本机通知。
- `expo-notifications@0.32.17` 的 `scheduleNotificationAsync` 不再接受裸 `Date` trigger；旧代码传 `trigger: fireAt as any`，会在通知调度时抛出 invalid trigger，并中断保存流程。

### 变更摘要
- 文件：`src/services/notifications.ts`
- 新增 `notificationDateTrigger(date)`，按 Expo 当前契约生成 `{ type: 'date', date, channelId }`。
- `scheduleEventNotification` 改为捕获权限、通知 channel、通知调度异常；通知失败时返回 `null`，不再阻断日程保存。
- 文件：`__tests__/notifications.test.ts`
- 新增日期通知 trigger 结构测试，防止回退到裸 `Date`。

### 验证结果
- `npx tsc --noEmit`：通过。
- `npm test -- --maxWorkers=75% notifications taskOrdering eventOrdering api`：通过，4 suites / 38 tests passed。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过，BUILD SUCCESSFUL。
- USB 真机 `825f509d` 覆盖安装成功，安装后 `lastUpdateTime=2026-07-09 11:05:27`。
- 冷启动后 logcat 未匹配到 App fatal、ANR 或 ReactNativeJS fatal。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116711103 bytes，SHA256 `1bb508cabc629a087843b3458dc4308fe7a61edd7bb5f49eb3a241daa359f27b`。

### 回滚提示
- 如需回滚，只回退 `src/services/notifications.ts` 和 `__tests__/notifications.test.ts` 本节相关修改；但旧版本在未来提醒时间存在时可能再次出现“保存失败”。

## 2026-07-09 跨日期待办展示与临近提醒策略

### 变更摘要
- 文件：`src/utils/taskOrdering.ts`
- 今日/当日待办改为展示覆盖选中日期的跨日期事件；单日全天事项仍不进入待办。
- 跨日期全天任务没有开始时间时按无时间任务排序，排在有明确开始时间的待办之后。
- 文件：`src/screens/ScheduleScreen.tsx`
- 待办行右侧时间文案改为使用统一 `fmtTime`，跨日期任务显示日期范围，不再显示空值。
- 文件：`src/services/notifications.ts`
- 提醒时间计算改为：如果“提前 N 分钟”的触发点已经过去，但事件开始时间仍在未来，则安排一个 5 秒后的近即时提醒；如果事件已经开始，则不再提醒。
- 文件：`__tests__/taskOrdering.test.ts`、`__tests__/notifications.test.ts`
- 增加跨日期全天待办展示和临近提醒计算测试。

### 验证结果
- `npx tsc --noEmit`：通过。
- `npm test -- --maxWorkers=75% notifications taskOrdering eventOrdering api`：通过，4 suites / 39 tests passed。
- `./gradlew assembleRelease --parallel --build-cache --max-workers=$(nproc)`：通过，BUILD SUCCESSFUL。
- USB 真机 `825f509d` 覆盖安装成功，安装后 `lastUpdateTime=2026-07-09 11:10:20`。
- 冷启动后 logcat 未匹配到 App fatal、ANR 或 ReactNativeJS fatal。
- APK：`android/app/build/outputs/apk/release/app-release.apk`，116711475 bytes，SHA256 `aa4dd431590d73b194a3de7d493a34351fa40feb2f5428eaf0ba9ef63d89d876`。

### 回滚提示
- 如需恢复旧行为，回退 `src/utils/taskOrdering.ts`、`src/screens/ScheduleScreen.tsx`、`src/services/notifications.ts` 和对应测试；旧行为会继续隐藏跨日期全天任务，并在默认提醒时间已过时不提醒。

## 2026-07-09 固定事件分类与分类上色

### 变更摘要
- 后端已约定固定 `category` 枚举：`工作`、`学习`、`健康`、`生活`、`社交`、`出行`、`财务`、`重要`、`其他`。
- 文件：`src/utils/eventColors.ts`
- 移动端颜色改为只由固定分类决定，不再由标题关键词、显式颜色或 `event_type` 重复规则决定。
- 文件：`src/screens/AddEventScreen.tsx`
- 手动新建/编辑页把颜色点改为分类选择 chip；保存时写入 `category`，`color` 由分类派生。
- 文件：`src/store/EventsStore.tsx`、`src/components/VoiceInputModal.tsx`、`src/services/api.ts`、`src/types/index.ts`
- 事件读写、语音解析保存和 API 类型都归一到固定分类；未知分类归为 `其他`。
- 文件：`src/services/notifications.ts`
- 临近提醒兜底延迟从 5 秒改为 1 秒。

### 验证结果
- `npx tsc --noEmit`：通过。
- `npm test -- --maxWorkers=75% eventColors notifications taskOrdering eventOrdering api`：通过，5 suites / 44 tests passed。
- 本次按用户要求未重新安装 APK 到手机。

### 回滚提示
- 如需恢复旧颜色行为，回退 `src/utils/eventColors.ts`、`src/screens/AddEventScreen.tsx`、`src/store/EventsStore.tsx`、`src/components/VoiceInputModal.tsx`、`src/services/api.ts`、`src/types/index.ts` 和 `__tests__/eventColors.test.ts`。

## 2026-07-09 ASR 语音样本生成与服务端转写测试

### 变更摘要
- 生成 68 条老记语音输入测试文案的 TTS 音频。
- 输出格式：`mp3`、`wav`、`aac`、`m4a`，每种 68 个文件。
- 素材目录：`test-assets/asr-voice-samples/`，约 13 MB。
- 清单文件：`test-assets/asr-voice-samples/manifest.json`，包含文案、声音、语速、预期转写和预期解析字段。
- 报告目录：`test-assets/asr-voice-samples/reports/`。

### 验证结果
- MP3 全量 68 条通过服务器 `/api/laoji/diagnostics/audio-quality` 测试。
- ASR 转写相似度：平均 `1.0`，最低 `1.0`，`>=0.95` 为 `68/68`，`<0.85` 为 `0/68`。
- WAV/AAC/M4A 各抽测 6 条代表样本，转写相似度均为 `1.0`。
- 结构化解析字段 mismatch 为 `11/68`，主要集中在跨日期 `end_date`、起止时间 `end_time`、出行/生活分类和每年重复识别；这不是 TTS/ASR 转写问题。
- 原始报告：
  - `test-assets/asr-voice-samples/reports/asr_diagnostics_mp3_20260709-134104.json`
  - `test-assets/asr-voice-samples/reports/asr_diagnostics_mp3_20260709-134104.md`
  - `test-assets/asr-voice-samples/reports/asr_format_spotcheck_20260709-134104.json`

### 回滚提示
- 本节只新增测试素材与报告；如需清理，可删除 `test-assets/asr-voice-samples/`。

## 2026-07-09 服务端解析修复后 ASR 样本复测

### 变更摘要
- 修正本地样本 `test-assets/asr-voice-samples/manifest.json` 中 `012` 的期望：`2026-07-09` 当天是周四，因此“明天”和“周五”都是 `2026-07-10`，不是跨日期。
- 服务端修复了规则解析的跨日期、中文三字日期、起止时间、每年重复、分类关键词和低信息记事追问。
- 服务端 LLM fallback 增加当前时间提示、相对时间后处理、固定分类后处理，并把日程解析请求调整为小上下文 `num_ctx=2048`、默认输出上限 `256`。
- 子代理只读调查显示：`qwen3:8b` 热推理约 1.4 秒；此前 18-20 秒主要来自冷加载、共享 GPU 显存压力和 32K 上下文 KV cache，而不是模型生成本身。

### 验证结果
- 最新 MP3 全量 68 条通过服务器 `/api/laoji/diagnostics/audio-quality` 测试。
- 结果：`68/68` 通过，失败 `0`，结构化字段 mismatch `0`。
- 解析来源：`rules=63`，`local_llm=5`。
- ASR 转写相似度：平均 `1.0`，最低 `1.0`，`>=0.95` 为 `68/68`。
- 最新报告：
  - `test-assets/asr-voice-samples/reports/asr_diagnostics_mp3_20260709-150727.json`
  - `test-assets/asr-voice-samples/reports/asr_diagnostics_mp3_20260709-150727.md`

### 剩余注意
- 未修改共享 Ollama 的全局环境变量；`CUDA_LAUNCH_BLOCKING=1` 和 Ollama 常驻/并发策略需要单独协调后再改。
- 本次未重新安装 APK 到手机。

## 2026-07-09 强制模型解析测试

### 变更摘要
- 服务端新增并启用 `SCHEDULE_FORCE_LLM=1` 测试模式，用于跳过快速规则、让 `/api/laoji/parse` 和相关诊断都直接走 `local_llm`。
- 当前 8035 老记后端仍处于该测试模式；恢复规则优先需要重启服务并移除 `SCHEDULE_FORCE_LLM=1`。

### 验证结果
- 直接接口验证：`明天下午三点开会`、跨日期、时间段、每日重复和低信息记事样本均返回 `parse_source=local_llm`。
- 文本-only 68 条诊断结果：
  - `68` 条总计，`56` 条通过，`12` 条失败或字段不符。
  - 来源分布：`local_llm=67`，`NULL=1`。
  - 总耗时 `91.61s`。
- 主要模型-only 问题：
  - 周几/下周日期偏移错误。
  - 提前提醒分钟数被模型忽略或改回默认值。
  - 边界分类不稳定。
  - `记一下那个事情` 这类低信息输入有一次返回 null。
- 报告：
  - `test-assets/asr-voice-samples/reports/parse_diagnostics_force_llm_20260709-154132.json`
  - `test-assets/asr-voice-samples/reports/parse_diagnostics_force_llm_20260709-154132.md`

### 结论
- 模型-only 能跑，但结构化质量明显低于“规则优先 + 模型兜底”。
- 当前可用于真机/App 体验模型-only 的延迟和失败形态，但不建议作为发布默认策略。
