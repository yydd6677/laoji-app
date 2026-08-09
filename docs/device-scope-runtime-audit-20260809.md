# 设备主域与 `guest` 兼容键运行时审计（2026-08-09）

## 结论

当前 accountless Android 构建的 `guest` 不是旧的匿名网络会话，而是本机 SQLite 的历史兼容 scope key。真正的服务边界是设备 ID + data epoch + `Bearer dv1...`；启动、录音上传、转写、整理和问答的设备路径均通过 `/api/device/v1`，不会把本机转写回退到旧 `guest-*` 接口。

因此本轮不把所有本机 SQLite 行迁移成 `device:<uuid>`。这只会改变内部命名，却需要重写 `ScopeKey`、数据库主键/索引、缓存键、通知和历史迁移，不能增加隔离性，反而会给现有本机数据带来迁移风险。保留兼容键，并在审计日志中明确真实域，是当前风险最低且语义清晰的方案。

## 三条启动日志的真实含义

| 审计事件 | 实际来源 | 网络路径 |
| --- | --- | --- |
| `meeting_audio_upload_queue_inspected` | 本机待上传注册表；有任务时随后才会由设备上传器提交 | `device-v1` |
| `meeting_recording_reconciled` | 原生录音 journal 与本机 SQLite 对账 | `none` |
| `meeting_canonical_legacy_mirror` | SQLite canonical projection 写入旧 JSON 兼容镜像 | `none` |

这三类事件现在都带 `scope_kind=device-local`；旧 `scope=guest` 字段仅为日志解析和数据库兼容保留。`network_path=none` 明确表示该事件本身没有网络请求，`network_path=device-v1` 表示后续上传只允许走设备 API。

## 代码合同

- `AuthStore` 仍以 guest mode 启动，但不创建账号会话，也不向账号接口发起首帧请求。
- `MeetingsStore` 的 guest 分支只读/写本机 canonical SQLite；云端列表刷新在 guest mode 直接返回。
- `deviceApi.ts` 统一构造 `Bearer dv1.<deviceId>.<deviceSecret>` 和 `X-Laoji-Data-Epoch`。
- `meetingSummary.ts` 的 guest 分支只调用设备整理接口；设备绑定缺失、笔记/旧附件等不满足设备合同的请求明确失败，不回退 `guest-summary`。
- `meetingQuestions.ts` 的 guest 分支只调用 `askDeviceQuestion`；设备绑定缺失明确失败，不调用 `guest-questions`。
- Android 实时录音和导入路径不包含旧 `guest-sessions`、`guest_token` 或 `guest-summary` 调用。旧接口实现仍留在 `api.ts`/服务器中，仅供历史账号兼容代码审计，不属于当前 Android 运行路径。

## 模拟器现场证据

- 目标设备：`emulator-5562`（`LaoJi_API_35`）；没有操作 `emulator-5560`。
- 最终 release 覆盖安装后，版本仍为 `1.0.6`/`versionCode=106`，APK SHA-256 为 `f226843a3a53d59704dd2f1f01e9e395118f1f80921447fe3b2e57d00dd3fef4`；构建时临时注入引导密钥，未写入源码或工作区。
- 启动日志出现：
  - `meeting_audio_upload_queue_inspected`：`scope_kind=device-local, network_path=device-v1`；
  - `meeting_canonical_legacy_mirror`：`scope_kind=device-local, network_path=none, mirror_kind=local-sqlite-projection`；
  - `meeting_recording_reconciled`：`scope_kind=device-local, network_path=none, reconciliation_kind=native-journal-local-sqlite`。
- 启动未出现 `FATAL EXCEPTION`、`laoji_start_auth`、`guest-sessions`、`guest-summary` 或 `guest-questions`。

这证明原先看到的 `guest` 字样是本机兼容层日志，不是旧访客网络链路仍在接管设备主数据。问答专题和真机验收仍按当前计划延期，不能由本审计替代。
