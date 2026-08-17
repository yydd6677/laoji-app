# 候选 0031：U2 上传只读 adapter map

## 状态

- result: `observed adapter map; not an implementation`
- date: `2026-08-16 Asia/Shanghai`
- production mutation: `none`
- source worktree: `/home/yydd/LaoJi-worktrees/feishu-source-driven`

本文件由源码只读核对产生，不表示 U2-A 已接入或任何旧入口已经删除。它的目的只有一个：
在下一隔离原型中逐条证明“一个旧写入口有且只有一个替代”。

## 现有写入口

| 现状入口 | 当前实际行为 | U2-A 目标位置 | 是否可直接删除 |
| --- | --- | --- | --- |
| `recordingReconciler.ts` | 采集结束后写正式 `recording_assets`/stage，并创建 pending registry | 同一事务 reserve asset + upload generation；stage 由资产派生 | 需纵向验证 |
| `attachImportedMeetingMedia.ts` | 导入/视频抽音频后写 asset，再写 pending registry | MediaIngestor 先形成 app-private source，事务 reserve generation | 需确认所有 URI 都可复读 |
| `createMeetingNote.ts`、`updateGuestMeetingCapture.ts` | 新建/结束会议时创建或更新录音资产和 capture/upload stage | 只写正式 asset/generation；不写会议 upload 状态镜像 | 需切片迁移 |
| `mergeAccountMeetingRemoteSnapshot.ts` | 远端资产回填本地 asset，可能触发 pending upload 重建 | 只接受带 epoch/source identity 的 remote projection；不能反向生成 registry | 需建立 replay 规则 |
| `meetingRecording.ts` 的 `upsertPendingMeetingAudioUpload` | 写 `pendingMeetingAudioUploads:v1/v2/v3`，合并 URI、远端身份、retry、WorkInfo | 只读迁移器；新写入改为正式 generation | 迁移发布周期后删除 |
| `meetingRecording.ts` 的 `retryPending...`/`mutatePendingUploads` | JS retry/backoff、失败分类、通知和进程内串行化 | WorkManager executor + domain CAS；JS 只发 ensure/inspect/cancel | 通过故障门后删除 |
| `attachNativeUploadRegistration` | 将 `workId/operationId/generation` 回写 AppStorage | 只保存 operation/generation 在正式 DB；不保存 `workId` | 需改 native bridge |
| `MeetingsStore.tsx` `reconcilePendingAudioUploads` | 从 registry 计算 inspection，并写 `audioSyncPending/Blocked` 和标签 | 从每资产 generation 事务派生详情状态；标签不再承载业务语义 | 需 UI 纵向验证 |
| `MeetingsStore.tsx` authenticated native enqueue | 发现 pending 后以 WorkManager `KEEP` 入队，但返回并持久化新 request UUID | native API 返回/查询 stable unique operation name | 需真实 KEEP/prune 测试 |
| `deviceApi.ts` guest `uploadDeviceAssetContentR2` | JS Base64 分片、临时片文件、最多 2 并行、R2 complete | Android Worker 直接从 app-private URI stream PUT/multipart | 通过速度/内存对照后删除 JS loop |
| `deviceApi.ts` guest chunk fallback | 512 KiB 经 API 隧道顺序上传，另有 complete | 仅在 R2 不可用时保留窄兼容 executor | 不得与默认路径双写 |
| 服务端 `device_v1.py` R2 routes | 建立/查询/完成/取消 device R2 session，下载到临时路径后提交 | 沿用 endpoint 形状，补 operation/epoch/source CAS、流式校验和 TTL | 需真实 R2 竞态测试 |
| 服务端 `meeting_recording_asset_service.py` | register/content 幂等和 revision CAS | 作为唯一 remote asset owner；R2 complete 只投影到它 | 保留，扩展合同 |

## U2-A 的唯一映射

```text
正式 SQLite recording_assets
  + recording_asset_upload_generations (同库、同事务)
          |
          +-- JS ensure/inspect/cancel(operation)
          |
          +-- Android WorkManager unique operation executor
                    |
                    +-- server register replay
                    +-- R2 private staging object
                    +-- server stream/hash/seal/CAS
          |
          +-- 同库派生 meeting processing_stages.upload
          +-- UI 只读派生 inspection
```

服务端幂等根不得只使用 asset/digest，必须至少编码
`scope + data_epoch + asset + role + origin + source_revision + source_digest`；否则同内容
但不同业务身份的录音会被错误合并。

禁止出现以下反向箭头：

- WorkInfo -> 业务事实；
- AppStorage registry -> 新 generation；
- 会议 `audioSyncPending/Blocked` -> asset 状态；
- R2 object key -> remote asset identity；
- server response -> 未检查 generation/epoch 的本地覆盖。

## 需在原型中补足的未知项

1. Expo/RN SQLite 文件能否被 Android Worker 安全读取/写入；首选 Worker 不直接写 DB，
   但必须验证 remote commit 后进程被杀时，server probe + 同库 CAS 能在有界时间内恢复；
   WorkInfo/R2 session 已 prune/过期时只能保持 `unknown/conflict`，不能伪造完成或删除旧项。
2. `MediaIngestor` 对 `content://`、视频抽取和录音 URI 是否始终产生 app-private、可重复
   读取的文件；如果不能，必须把复制作为显式 capture stage，而不是 Worker 隐式整文件复制。
3. 当前服务端 R2 complete 的下载、临时文件、提交和删除各阶段的崩溃点；需要每个阶段的
   operation 专属路径和 TTL，而非共用临时文件名。
4. guest device epoch 与 authenticated credential generation 的联合 fencing；两者不能
   用一个递增数混淆。
5. R2 multipart 非末片 5 MiB 最小值、URL/credential lease 到期、abort/TTL 和重复 complete。
6. 同一会议多资产、同 digest 不同业务身份、恢复/回收站/epoch purge 的真实数据库约束；
   purge 后仍需有限期 meeting/asset/generation late-result fence，restore 必须新 generation。
7. guest/device 与 authenticated/account 两个 scope 是否能共享完全相同的 domain/API；
   Android 14+ 的用户主动大文件需要比较 UIDT 与 WorkManager，旧系统回退不能产生第二状态机。

## 删除预算（只有 U2-A 通过后）

- `pendingMeetingAudioUploads:v1/v2/v3` 的写入口和 `nativeWorkId` 字段；
- `meetingRecording.ts` 的 JS retry/backoff owner；
- `MeetingsStore` 写回 `audioSyncPending/audioSyncBlocked` 和“待上传/上传受阻”标签；
- guest JS Base64/R2 分片循环及其 operation 临时片文件；
- duplicate legacy upload protocol 的新任务入口。

迁移器、旧读取和未完成历史任务的 drain 可以保留一个发布周期，但禁止双写。任何冲突项
必须保留旧数据并报告 `migration_conflict`，不得用 marker 或清理动作掩盖缺失。

## 当前结论

adapter map 已完成只读核对，但 U2-A 仍是 `candidate`。下一步不是改生产代码，而是在
独立工作树建立最小 Android/SQLite/R2 contract probe，首先验证 URI 可复读、unique work
查询和服务端 replay/CAS；若任一项不成立，回到 U2-B 或重新审查 owner 边界。
