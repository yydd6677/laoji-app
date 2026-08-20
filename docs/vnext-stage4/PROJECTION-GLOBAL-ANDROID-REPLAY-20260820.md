# Stage 4 ProjectionEnvelope 全局 Android 回放（2026-08-20）

状态：`candidate-only Android replay passed; Stage 4 not adopted`。

本轮只验证默认关闭的 ProjectionEnvelope 候选。未修改生产 `18020/8030`、公网流量、
GPU1、PCB、Smart Meeting 或其他用户服务，也未在真机安装或发布 APK。

## 边界和构建

- 工作树：`vnext/implementation`；专用设备：`emulator-5562 / LaoJi_API_35`。
- 页面回放 APK：`1.1.31 (139)`，SHA-256
  `33ff13b42af470d178ec8c301f93c60ac3088f1eaafc6dfe7e981d6e524e47c6`。
- 收口候选 APK：`1.1.33 (141)`，82,586,351 bytes，SHA-256
  `e24333307a0c09bb2bb857c8a6fb49599586dfb2a8521dcd10b869cefd29ce8e`；APK Signature Scheme v2
  校验通过。它包含固定 payload 快照的竞态修复并继续编译五个候选开关。
- 收口候选首帧截图：`/dev/shm/vnext-1.1.33-first-frame.png`，SHA-256
  `32416024b53b92fd0835b46c9c10c44d6dedd06713b3c35f880944ed78c05600`；人工查看为完整日历首帧。
- 候选服务只经 `18023 -> 28023 -> emulator reverse 28121` 访问；隔离 ASR 为 `8031`。
- Android instrumentation 使用 release test APK 临时读取应用数据库；不写业务表，源码和
  `android/app/build.gradle` 均位于被 Git 忽略的生成目录，不属于候选提交。

## Action fence

新增 `src/native/projectionActionFence.ts`，在 native 已完成快照接收门之后，再由 JS 对跨 bridge
排队的 action 做最后一道校验。候选模式必须精确匹配：

- `deviceEpoch`
- `entityId`
- `entityRevision`
- `viewRevision`
- `surfaceInstanceId`
- `payloadSha256`

当前投影仍在计算、action 缺少投影或任一身份字段不一致时均失败关闭；稳定构建保持原交互合同。
协调器在异步计算哈希前冻结本次 render 的 payload，使持久 checkpoint 和 envelope 不会混用两个
render 的正文与哈希。
日历、实时录音和会议详情在执行 mutation/action 前统一调用该 fence，并只记录 surface、action type
与拒绝原因。日志不包含标题、正文、人物或来源内容。日历 mutation 被拒绝时显示
`日程页面已更新，请重新操作。`，没有新增常驻状态行。

## 页面重建回放

候选旗标开启后，在旧本机数据上对三个 native surface 做强停、重启和同一实体重开：

| surface | entity | 重建前 revision | 重建后 revision | 结果 |
|---|---|---:|---:|---|
| transcript | `...0c5d9190` | 284 | 287 | revision 单调，surface instance 已更换 |
| calendar | `calendar` | 241 | 244 | revision 单调，surface instance 已更换 |
| recording | `...6f2d4db2` | 7 | 8 | revision 单调，instance `b01a3fa6 -> 5ebbe9a2` |

无参数新录音在进程恢复时可能安全回到日历，不能证明同一录音实体的 recreate。为验证 recording，
本轮临时移除设备到候选 API 的 reverse，使 native 在创建本机 MeetingNote 后、AudioRecord 开始前
因服务不可达停止；恢复 reverse 后通过“继续录音”重开同一条记录，再做 checkpoint 重放。没有采集
音频或上传媒体。调试产生的 6 条“新录音”已通过界面移入回收站，未触碰原有会议夹具。

## 视觉稳定性回放

在会议 `vNext 验收夹具·股权会议（SRT参考）` 上真实切换
`整理结果 -> 文字记录 -> 整理结果 -> 讲话人 -> 文字记录`：

- 视频：`/dev/shm/vnext-stage4-detail-20260820.mp4`，11.691 秒，SHA-256
  `9435332a89091f1de1cf2c2db3d868352dbaf3309ef5519526815c3674a1b663`；
- 抽帧图：`/dev/shm/vnext-stage4-detail-contact.png`，SHA-256
  `721adfd616c93fd279c3e147b3a5dcf8eee52d4063bf345bee17d454ebe533a5`。

人工查看 23 个非黑帧：标题、日期、顶部 tab 和右侧按钮位置稳定；每帧只有当前 tab 的一条蓝色
下划线；未出现常驻空白状态行或固定控件可见跳动。该结论只覆盖这段实际回放，不代表所有 loading、
error 和异步终态组合均已证明无闪烁。

## 已通过的聚焦门

- action fence Node 合同：10 个用例通过；
- 三页面静态接线与隐私审计：通过；
- TypeScript 类型检查和候选 APK 构建：通过；
- 真实应用数据库的 calendar / recording / transcript checkpoint recreate：通过；
- 页面回放候选冷启动无崩溃、无白屏，测得 `TotalTime=872ms`。收口候选覆盖安装保留数据后冷启动
  `TotalTime=899ms`，未出现 native/React fatal 或 device-v1 HTTP error；设备反向映射和隔离 API
  `/api/ready` 均为 ready。

## 尚未证明

- 尚未通过 instrumentation 向 bridge 注入“旧 action 排队、随后新快照生效”的真实事件；当前只由
  纯函数合同、native reducer 和三页面 action 前置接线共同证明失败关闭。
- 尚缺第一方自然中文日程独立双人盲审与裁决、语音首字符/Draft p95、旧 schedule submit 的完整公开
  零流量周期和 capability barrier。
- 本证据不关闭 Stage 4，也不允许删除旧 parser、旧 projection reader 或兼容路径。
