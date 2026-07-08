# 老记 Android 发布补全协作记录

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
