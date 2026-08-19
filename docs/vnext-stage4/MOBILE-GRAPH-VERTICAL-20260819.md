# Stage 4 mobile Graph vertical replay (2026-08-19)

状态：`isolated candidate evidence; not adopted; not a Stage 4 exit`。

## 候选边界

- 工作树：`vnext/implementation`；APK `1.1.18 (126)`。
- APK SHA-256：`4913f0d87b9c4e389fca9f8b49d3d62542cf93c9a6922cbb8b2404ea2c7a0fac`；
  APK Signature Scheme v2 校验通过。
- 只覆盖安装到 LaoJi 专用 `emulator-5562`；没有操作 `emulator-5560`、真机、公开 APK manifest
  或生产服务。
- APK 以五个候选开关构建，设备 `28121` 仅通过 `adb reverse` 指向本机 SSH 隧道 `28023`，再到
  隔离 API `18023`。隔离服务报告 `schedule_graph_v2/source_stream_v2/question_reader_v2/realtime_asr_v2`
  可用，Stage 2 media barrier 仍关闭。

## 真实页面纵向回放

1. 覆盖安装保留原 SQLite 和 6 条会议；启动无白屏、崩溃或 migration 错误。首次可导航帧
   `44ms`，会议库打开总计 `239ms`；随后强停重启为 `71ms` 和 `153ms`。这些是本次模拟器观察，
   不是冷启动总体 p95。
2. 在“语音输入”面板的文本框提交一条包含相对日期、起止时间、地点和自我更正的中文日程。
   客户端先读取 device-v2 capability，再请求唯一 `schedule_graph` owner；HTTP 200。
3. 首次 Graph 显示可验证日期和时间，但保持 `needs_clarification`，没有在不完整状态下启用保存。
4. 在同一确认页补充地点和标题；客户端请求 `schedule_graph_clarify`，HTTP 200。页面投影为：
   标题“新版讨论”、`8月26日 周三`、`15:30 - 17:00`、地点“三号会议室”，保存按钮随后启用。
5. 保存回到日历后，8 月 26 日出现且只有一条该日程。强停 App 并重启后仍显示同一条日程，证明
   本机保存和页面重建没有退回远端业务 owner。
6. 验证结束后经详情页删除该测试日程，日历显示本机撤销条；系统输入法恢复为 LatinIME。

聚焦回归：服务端日程/ASR proxy/事件命令/编辑/Graph/recurrence 共 `134 passed`；Graph 静态 owner、
移动端 owner、0045 migration 与 Projection checkpoint 均通过。本轮临时 SQLite 的 12,000 条 FTS
workload p95 为 `14.96ms`。TypeScript 编译、评估工具语法和 `git diff --check` 通过。

## 数据库切换恢复

隔离数据库最初不包含模拟器已有的 device-v2 registration。旧逻辑只会重复请求 token 并永久得到
`DEVICE_NOT_REGISTERED`。候选现在只针对 `401 + DEVICE_NOT_REGISTERED`，用手机仍持有的 device ID、
epoch 和不可导出 P-256 key 重新完成 bootstrap；其他 401 不进入该路径。本轮较早的覆盖安装已观察到
challenge -> registration restore -> bootstrap -> token -> capabilities 全链 200；之后重启复用已恢复会话。

## 仍未满足的退出门

- 这次输入是明确编写的纵向用例，不是独立人工 LaoJi field holdout，不能计入字段准确率门。
- 未完成真实语音采集、首文字和 Draft 的 p50/p95；本次只验证了解析后的 Android 页面链路。
- 尚缺全局页面 recreate/stale action 故障注入 envelope、完整公开零提交周期和持久 capability barrier。
- Stage 2 性能门、Stage 3 质量/采用门仍未通过，因此 Stage 4 不能越级采用。
