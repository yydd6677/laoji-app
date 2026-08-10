# 本机主数据启动与回写路径审计（2026-08-10）

本轮只做源码和入口合同审计，没有修改业务代码，也没有操作当前连接的真机或 `emulator-5560`。目标是排除去账号化之后最容易遗漏的三类回归：启动/通知仍调用账号 CRUD、设备转写完成后不回写本机、打开会议详情改变列表顺序。

## 审计结论

在当前生产入口中未发现新的调用越权或“打开即重排”路径。发现的旧账号函数仍作为兼容源码保留，但生产导航和设备分支均有明确边界；因此本轮没有为了“清理文件”而删除兼容代码，也没有把静态通过写成全量运行验收。

## 证据

### 启动与通知

- `App.tsx` 的生产 Provider 树只挂载 `AuthProvider`、`EventsProvider`、`MeetingsProvider`、`DeviceServiceCoordinator`、`DeviceMeetingCompletionProvider` 和本机 UI/通知协调器；没有挂载账号转写完成 Provider。
- `AuthStore` 的 `AuthProvider` 只加载本机 profile，固定返回 guest/session-null/device-only 状态。
- `EventsStore` 的 guest 分支从本机日程仓库读取；日程通知通过本机 scope registry 调度，网络不可用不会阻塞日程 CRUD。
- 账号兼容函数仍保留 `accessToken` 参数，但 `requireAccountAccessToken` 位于每个网络函数的首个请求路径；无令牌时不会发起匿名账号 CRUD。

### 设备转写完成回写

- `DeviceMeetingCompletionProvider` 只在 `mode === 'guest'` 时启动；它读取本机 `deviceTranscriptTasks`，调用设备任务/转写接口，过滤空文本和无声终态，再通过 `saveCachedTranscript` 写入 canonical transcript，并更新本机会议状态。
- 本机转写任务提示有串行 mutation 队列、7 天过期和有界退避；设备任务 404 会清理过期提示后再尝试可读的转写结果，不会无限每 15 秒撞击旧任务。
- Android 详情页先读取 canonical active transcript；在访客或无令牌时结束转写加载，不进入 `fetchMeetingTranscriptSnapshot` 等账号接口。摘要同样先读取本机 canonical document。
- 原生录音恢复使用 `native-journal-local-sqlite` 语义，删除/恢复路径不把本机数据伪装成 guest HTTP session。

### 会议排序

- canonical repository 的展示顺序由 `meeting_list_order` 单独保存，拖动后以事务方式替换完整 ID 顺序并重新投影到兼容缓存。
- 没有手动顺序时，`sortMeetingDisplayItems` 按 `recordedAtMs → startedAtMs → createdAtMs` 降序；同一时间用稳定 ID 作为 tie-breaker。
- 新建、导入或恢复的未排名会议只在已有手动序列之前出现；打开详情只读取会议和内容，不写入 `meeting_list_order`，所以不会因打开而重排。

## 执行结果

以下检查在当前工作树通过：

```text
python3 tools/verify_device_primary_source.py                  PASS
python3 tools/verify_compact_source_config.py                  PASS
python3 tools/verify_compact_apk_config.py android/...apk     PASS
npx tsc --noEmit                                               PASS
git diff --check                                                PASS
```

## 边界

这是设备主数据入口的静态/源码合同审计，不等于真机录音、断网恢复、通知点击和多设备质量全部通过。`emulator-5562` 当前离线，真机验收按用户要求跳过；问答、真实声纹纵向质量和完整历史 pytest 继续保持延期状态。
