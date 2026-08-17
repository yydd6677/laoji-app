# 蓝图修订 0014：上传 owner 证伪与 U2 传输边界

## 状态

- revision: `0014-upload-u2-transfer-boundary-20260816`
- status: `candidate`; **not adopted**
- parent: `0013-upload-owner-convergence-boundary-20260816`
- production change: `none`

## 本轮判断

U1 的两个隔离候选都已被独立证据阻塞。继续增加第三版状态机会违反反局部优化规则：它
不能同时修复正式表接入、Android Worker 交接、R2 临时对象生命周期、删除 fence 和迁移
身份。0014/0015 统一冻结为 `rejected-current-shape`，不再作为实现分支。

这次否决不等于上传目标被放弃。它把问题重新定义为：

> 现有正式资产/处理表如何成为唯一领域 owner，同时用一个不增加常驻服务的原生传输
> executor 消除 JS Base64、前台轮询和错误 WorkInfo 身份。

## 蓝图变化

### 保留

- `recording_assets`、`processing_stages`、转写任务、R2 session、device epoch 和现有
  register/content API 作为现状证据及兼容边界；
- WorkManager 的网络约束、系统重启恢复和重试能力，但只作为执行器；
- 本地原始录音的用户保留/删除权与服务端原音频临时保留边界。

### 质疑/废弃为目标设计

- AppStorage v1/v2/v3 registry、JS retry/backoff、`nativeWorkId` 持久字段和会议状态
  标签不再作为新任务 owner；
- 会议级 `processing_stages.upload` 不再直接承载多资产事实，只能是事务内派生投影；
- R2 共享 object key、JS Base64 分片临时文件、`WorkRequest.id` 作为业务身份均禁止进入
  新链路；
- 0014/0015 的独立 server 表、completion inbox、整文件内存校验和无条件 failure 回写
  不采用。

### 下一候选

研究 0019 的 **U2-A 原生 R2 executor**：扩展正式 SQLite 资产域加入 per-asset upload
generation/fence；native Worker 以 stable operation name 执行现有 R2 single/multipart；
服务端用包含 scope/epoch/role/origin/source revision 的幂等根、operation 专属 staging key、
流式校验、同域 CAS 和及时清理完成接管。U2-B 精简 chunk endpoint 只作为无 R2 兼容实验，
U2-C tus 暂不引入。

### Android 真实边界结果

隔离 `upload-u2-android-executor-0002` 已在 API 35 模拟器完成独立复跑。真实 WorkManager
KEEP/query/prune、force-stop 后 WorkSpec 可查询、app-private seekable `content://` 定长
读取、5 MiB 非末分片布局和可见 Activity 下 UIDT 调度通过。它只证明平台原语可用：
prune 后名称不可查询，force-stop 后没有继续真实上传，UIDT 也没有覆盖长传、取消、配额或
API 34。正式 SQLite/R2/CAS/完整幂等身份仍未证明，因此 U2-A 继续 `BLOCK`。证据见
[candidate 0033](../evidence/candidate-0033-upload-u2-android-executor-0002-device-audit-20260816.md)。

### 正式 SQLite 终态候选

隔离 `upload-u2-server-domain-0003` 使用真实 SQLite/WAL 与文件流建立第一份终态探针，
实现者自测 `9/9`。它证明并发 generation reserve、epoch-qualified operation name、终态 CAS、
tombstone/restore/purge fence、completion claim lease、固定 256 KiB seal 和 activation + 单一
transcription job 可以在一个数据库合同内表达。它没有独立审计、正式 Alembic/API 或真实
R2，且 purge 前的持久 object/sealed cleanup obligation 尚未实现，继续 `BLOCK`。详见
[candidate 0034](../evidence/candidate-0034-upload-u2-server-domain-0003-selftest-20260816.md)。

本候选同时纠正原 operation name：真实游客 scope 长期为 `guest`，epoch 独立，因此名称
必须从 `scope + asset + generation` 收紧为 `scope + epoch + asset + generation`；否则数据
epoch 更换后会命中旧 WorkManager unique work。

### R2 bearer cleanup 边界

Cloudflare 官方资料又收紧了删除合同：presigned PUT 在到期前可重复使用，single PUT 在
取消后立即 delete 仍可能被在途旧请求重新写回；R2 lifecycle 通常在 expiration 后 24 小时
内才完成，不是同步删除证明。因此 session 必须单调记录最后一次 presign 到期时间，删除
时立即 best-effort 清理，并把“到期后再次 abort/delete/HEAD”的有限 obligation 原子移交
到不随 meeting/asset 级联删除的窄表。该表只拥有物理清理，不得反向写业务状态。详见
[research 0020](../research/0020-r2-bearer-cleanup-boundary-20260816.md)。

真实 R2 的受控 probe 已在 `upload-u2-r2-sandbox-0004` 形成，默认只输出脱敏 dry plan，
外部执行需要显式 execute/ack、环境密钥、官方 endpoint 和 `sandbox/u2/` 前缀。本地门禁
`5/5`，但从未访问 R2，所以 R2 证据仍为 `0`。见
[candidate 0035](../evidence/candidate-0035-upload-u2-r2-sandbox-0004-guarded-probe-20260816.md)。

## 采用门和停止门

进入真实代码前，必须在隔离工作树证明：

1. 正式 migration 对旧 registry/WorkInfo/R2 session 生成带 scope/epoch/业务身份的 manifest；
   已 prune/过期/不可观测项必须标为 `unknown/conflict`，不能声称完整或删除旧项；
2. Worker 被杀、force-stop、重启、断网、KEEP、prune 后，stable operation + server probe
   只产生一个服务端幂等逻辑资产；remote commit 后再次杀进程仍能通过 probe + 同库 CAS
   收敛，无法观测时保持 `unknown/conflict`；
3. 同 asset 多 generation、同内容不同业务身份、删除/恢复/epoch 变更和 digest 改变不
   会复活或覆盖；物理 purge 后有限期 late-result fence 仍在，restore 产生更高 generation；
4. R2 1 GiB 流式路径的峰值内存不随文件大小线性增长，所有 operation 临时文件可回收；
5. 与 U0 有真实速度、CPU、RSS、磁盘和故障率对照，且至少删除一个旧 owner；
6. `uploaded/superseded/cancelled` 终态不可回退，blocked 重试只创建更高 generation；
   `unknown/conflict` 只是迁移/观察结果，不成为第二套 generation 状态；
7. guest/device 与 authenticated/account 同合同覆盖；1 GiB 主动上传对比普通 WorkManager
   与 Android 14+ UIDT，核心 schema/API 仍保持 Linux/Windows 可移植；
8. 未通过前不改生产服务、真实数据库、APK 或真机。

若 U2-A 证明 R2/网络入口才是瓶颈，再比较 U2-B；若需要新增常驻 transfer 服务才能达到
恢复目标，必须重新进行全局资源和 owner 审查，不得自动采用 tus。

## 当前用户可见收益

本修订没有用户可见生产改进，明确记为 `0`。文档和候选证据收紧了未来方向，但没有把
自测、编译或 ready 状态写成体验完成。

## 后续队列

- adapter map 已完成只读核对（candidate 0031）；第一份 Python fake probe 已被独立审计否决（candidate 0032），不再加深；
- Android 平台原语已完成独立窄审计；SQLite 终态合同已有实现者自测候选但尚未独立审计；
  第一未完成项是对该候选做对抗审计并建立 research 0020 的 C2 cleanup schema adapter，
  再在明确外部写入授权后执行已准备的真实 R2 sandbox，
  随后才把这些原语串成完整上传恢复纵切；
- Q2、speech、schedule 继续遵守 0013 之前的停止门；
- 蓝图下一轮优先审查“原生 Worker 能否安全消费现有 SQLite/URI、以及 R2 直传是否真能
  降低端到端等待”，而不是继续调整 U1 状态机。
