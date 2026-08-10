# 老记去账号化冻结清单（2026-08-10）

这是一份不含录音正文、转写正文、设备密钥或 Tunnel token 的工程快照，用于在继续改造前确认“从哪一个客户端源码、哪个 APK、哪一份服务器运行态”开始。它不是数据库或音频备份；真正回滚仍依赖本地 Git 检查点和服务器迁移备份。

## 快照元数据

- 采集时间：2026-08-10 09:55（Asia/Shanghai）。服务器时间与本机一致到秒级。
- 客户端工作树：`/home/yydd/LaoJi-worktrees/feishu-source-driven`。
- 分支：`rebuild/feishu-7.71.8-source-driven`。
- 采集时源码 HEAD：`f281794eeabb655c139f4dd2d3fcfbb9e297832f`（`docs: record decoder capability gate`）。
- 已有稳定检查点：tag `laoji-device-primary-freeze-20260809`，目标 commit `7ad25e41365c574c5c58e97d681fcf1435933058`。
- 采集时 Git 工作树：已跟踪文件无 modified/staged 项，未跟踪项 `713` 个；未跟踪清单的捕获前 SHA-256 为 `54a2caec02fd89810603f4c328948dc087c1c0d8d1eecdb3f34120075ef741c7`。
- 采集时已跟踪文件整体清单 SHA-256 为 `5a1f30992d7d0a017d947d22ac08ecc5041ebc6ffc4bf2b177cea54d66c4854e`。未跟踪语料、问答审计和历史测试资料不纳入提交，也未删除或重置。

## 客户端发布物

- Release APK：[`/home/yydd/LaoJi-stable-builds/laoji-v106-device-capabilities-20260810.apk`](/home/yydd/LaoJi-stable-builds/laoji-v106-device-capabilities-20260810.apk)。
- 构建产物副本：`android/app/build/outputs/apk/release/app-release.apk`。
- `versionName=1.0.6`，`versionCode=106`。
- 文件大小：`82,143,414` bytes。
- SHA-256：`633e642caabc6955222aa3df5fe9c7f5a731cafe83bd10911066d6d71f7e1f83`。
- APK 配置指向 `https://laoji.cloud`，设备引导密钥长度门禁通过；没有安装到当前连接的 `emulator-5560` 或 USB 真机。本次不把设备在线写成验收证据。

## 服务器运行态

- 主机：`183.36.243.124`（hostname `zhong-server`）。
- compact 源码根：`/home/zhong/laoji-service-platform/compact-production`。
- `laoji-api.service`：`active/running/enabled`，PID `521289`，cwd `/home/zhong/laoji-service-platform/compact-production/backend`，loopback `127.0.0.1:18020`。
- `laoji-asr.service`：`active/running/enabled`，PID `363049`，cwd `/home/zhong/laoji-service-platform/compact-production/backend`，loopback `127.0.0.1:8030`。
- `laoji-ollama.service`：`active/running/enabled`，PID `2436429`，cwd `/home/zhong/laoji-service-platform/compact-production`，loopback `127.0.0.1:21434`。
- `cloudflared.service`：`active/running/enabled`，PID `2738599`；Tunnel 只转发到 `127.0.0.1:18020`。老记没有把 18020、8030 或 21434 暴露到公网。
- `/api/ready`：`ready=true`；ASR、9B 生成、0.6B embedding、VAD/CAM++、任务 worker 和三库健康检查均为 ready；三个队列深度和活动租约均为 `0`。
- 数据库：`main`、`schedule`、`speaker` 均 `integrity=ok`、外键违规 `0`、`journal_mode=wal`。
- 磁盘：根分区可用约 `113 GiB`，`/home` 可用约 `517 GiB`；ready 报告 `free_gib=516.775`，仍接收新音频。
- GPU：GPU0 `27395/32607 MiB`，GPU1 `31756/32607 MiB`。GPU1、PCB 和其他用户进程未触碰；当前老记计算进程为 API、ASR 和两个 Ollama runner。

### 服务器源码与模型身份

以下只记录身份哈希，不复制服务器源码或模型：

| 文件/身份 | SHA-256 或 revision |
| --- | --- |
| `backend/app/main.py` | `26985c899d4fc7474172b28d187fca8efa0c3166254282ba1f3a17792eca402c` |
| `backend/app/api/device_v1.py` | `10dde960b88d5f1213280045965bcb644ee0d71a2902d95a6c9a2831cc12bac3` |
| `backend/app/services/device_identity.py` | `fc4025425677a21d7470368f7188b15ed7b06fa30901a7a685cd2105578c6c5b` |
| `backend/qwen_asr_service/server.py` | `00bfad570b634ddf209720d81bbee098dd31109be23a32842b01b8601c018333` |
| Qwen3-ASR-1.7B revision（`/api/ready`） | `7278e1e70fe206f11671096ffdd38061171dd6e5` |
| Qwen `config.json` | `2e74a751548b8ad7d7526d29365ad8144c345d8b412b1152d25dc6698452712f` |
| Qwen `preprocessor_config.json` | `45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d` |
| Qwen `model.safetensors.index.json` | `f994739fe38e5210b9e3e8ce6c6307315e2ceac3cb630e7b7414d69dce520f60` |

常驻模型名以 `/api/ready` 为准：`qwen3.5:9b`、`qwen3-embedding:0.6b`。Ollama 的本地模型索引命令在该部署中不返回可用列表，因此本清单不把无法独立确认的 blob digest 冒充已核验身份。

## 服务器数据与音频资产清单

当前生产 `local.db` 位于 `/home/zhong/laoji-service-platform/compact-production/backend/local.db`，`schedule.db` 位于同目录，声纹库为 `backend/data/speaker_voiceprints.db`。快照只记录文件元数据和哈希，不保存正文：

| 数据库 | 大小 | SHA-256 |
| --- | ---: | --- |
| `local.db` | `7,155,712` bytes | `7a3a855753fea2c5e8d5110fb61a9c5d46b40b7c0af860404cfe037fc882d4f6` |
| `schedule.db` | `221,184` bytes | `41679f6b9e1bc6cc540fa389a70e295ac3ea0a668553a8e40e714af7b9947004` |
| `speaker_voiceprints.db` | `1,310,720` bytes | `3ebec60d1504e5637bb41bdf886fc81c89d8a86641c121f1ecf8474970f1781c` |

只读数据库统计：`meetings=7`、`meeting_recording_assets_v2=6`、`meeting_recording_transcription_jobs_v2=6`、`transcript_lines=230`、`summary_tasks_v2=0`。音频资产全部为已处理状态，`storage_path` 非空资产为 `0`；服务器没有保留这批设备源音频。为避免写入会议标题、文件名或转写正文，资产/任务/会议/转写的脱敏字段清单摘要分别为：

- meetings：`8cd221b7a01033a14b75cca1d343c577de5452201b2b0849f060c3425c183ee7`
- recording assets：`3f38e6f7fe43517c55850dbd596b7a7ddb4750cf32784aeaec874dd2fe521e39`
- transcription jobs：`22fd194c93fe7a8e55aa9e06466b4100b3d5b468ef7881df0ea867e2453eb104`
- transcript timeline（不含文字字段）：`8eda84c99b0df3c8206a6870d1edb7f4c5a21f66acd780f4f3737c024f375576`

## 本机主数据链路审计结果

- `AuthStore` 固定为 `guest`、`session=null`、`accessToken=null`；首帧只读本机 profile，不发起账号启动请求。
- `EventsStore` 的 guest 路径从本机日程 SQLite/WAL 读取，新增、修改、删除和提醒通知都在本机队列/存储完成；账号兼容函数在无令牌时 fail-closed。
- `MeetingsStore` 的 guest 路径使用本机 canonical meeting repository；设备录音只通过 device/epoch 上传器临时处理，删除通过本机 outbox 触发远端清理。
- `DeviceMeetingCompletionProvider` 仅在 guest scope 运行，按本机任务提示轮询设备任务和设备转写，并将最终文字原子回写本机 canonical transcript；失败按退避处理，不调用旧账号摘要/转写接口。
- 账号 `MeetingTranscriptCompletionProvider` 不在 `App.tsx` 的生产 Provider 树中；Android 详情页在 `isGuest || !accessToken` 时先返回本机文字/整理结果，再进入任何账号接口分支。
- 会议列表通过 `sortMeetingDisplayItems` 应用本机持久化拖动顺序；未手动排序的条目按录音/开始/创建时间降序，打开详情不会改变顺序。
- 当前源码静态门禁、TypeScript、APK 配置门禁和 diff 检查均通过；这证明入口合同，不替代真机质量验收。

## 设备边界与未完成验收

本次只读 `adb devices -l` 发现 USB 真机 `825f509d` 和 KataCR 所有的 `emulator-5560`；老记专用 `emulator-5562` 离线。没有对这两个已连接设备安装、停止、卸载或清除数据。真机验收、会议问答专题、真实声纹纵向质量和完整历史 pytest 仍按用户明确决定延期，不能由本清单推断为完成。
