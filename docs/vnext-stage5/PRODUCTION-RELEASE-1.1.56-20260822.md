# vNext 生产发布记录：1.1.56（164）

## 结论

- 发布状态：已完成生产切换并开放在线更新。
- Android：`1.1.56`，`versionCode=164`。
- 服务端热修复版本：Git `a870010`，运行目录
  `/home/zhong/laoji-service-platform/production-releases/1.1.56-164-h1`。
- 公网入口：`https://laoji.cloud`，Cloudflare Tunnel 仍转发到固定的
  `127.0.0.1:18020`。
- 路径政策：五项业务能力均由 vNext 单一 owner 处理；不双写、不做请求级旧链路回退。
- 旧实现：仅保留为整版冷回滚资产，未删除，未标记 reader 已移除。

本次发布依据
`docs/vnext-stage5/production-release-authorization-20260822.json`；人工质量门和正常使用观察周期由唯一产品所有者明确豁免。该豁免允许发布，不等于对应质量指标已经通过。

## 发布产物

| 产物 | 位置 | SHA-256 |
|---|---|---|
| Android APK | `artifacts/vnext-releases/1.1.56-164/laoji-vnext-1.1.56-164.apk` | `cfb04ddfba793f54254af4ab89375dd291aab66d4107543905d06270c3b8f5ee` |
| 服务端 h1 包 | `artifacts/vnext-releases/1.1.56-164/laoji-vnext-server-a870010.tar.gz` | `992db7be3966afa98a04d1a5277bcd441d6e2e4fd8045ce7ffbed8a31ffa11a9` |

APK 大小为 `82619999` bytes，包名 `com.laoji.app`。签名证书 SHA-256 与旧稳定版 1.1.10 一致。生产构建只包含 `https://laoji.cloud`；不存在隔离候选地址 `127.0.0.1:28133`。

在线更新清单：

- `https://laoji.cloud/downloads/android/latest.json`
- `https://laoji.cloud/downloads/android/laoji-1.1.56-164.apk`

公网下载的长度和 SHA-256 已与本地产物核对一致。

## 数据与回滚

切换前快照位于：

`/home/zhong/laoji-service-platform/production-backups/vnext-1.1.56-164-precutover`

| 文件 | SHA-256 |
|---|---|
| `local.db` | `ef30568e2743e4897e250e0e7e6c74231e4c4e0ee81191b001d41c32ff645ca9` |
| `local-adoption.db` | `284cd6e31c5443cee66b85b1aa2e1b4ae2f76897fd77c00777895f341ed8ef4c` |
| `schedule.db` | `d7ab2004232112dacd01785b28b17fec884886ed9b004363cd3d754fc5576485` |
| `speaker_voiceprints.db` | `4a0749364fd55c4b56e92666208802d6db4d38014ba3112e5424e622837686b5` |
| `location_reverse_cache.db` | `66ce3fbe48df4c5701f3ab56d1c0ae956ed9d3ffb2215ccdf63f87fd704972da` |
| `latest-1.1.10.json` | `66303c3a838f426dd710ce111bcade9ed30612dfd120c84cf3bfe0529b2726a7` |
| `laoji-api.service` | `04b39e50690041eb90848394733f3b867c53348a32883e35b8b2541a40506f00` |

整版回滚必须同时恢复旧 systemd 配置、旧发布目录和相应数据库快照。不得在单次请求内静默切回旧实现。

## 生产采用状态

生产主库已登记并关闭以下 capability barrier：

- `media.upload` -> `device-v2-r2+import-transcript-events-v2`
- `transcript.realtime` -> `device-v2-realtime-v2`
- `summary` -> `facts-v3-source-stream-v2`
- `question` -> `question-reader-v2`
- `schedule` -> `schedule-mention-graph-v2`

采用时和重启前，上传、转写、整理、问答、清理任务均无 queued/running lease。主库、日程库、声纹库完整性为 `ok`，foreign-key violation 为 0，WAL 已启用。

## 验证结果

- `https://laoji.cloud/api/ready` 返回 `ready=true`。
- ASR 8030、Ollama 9B、0.6B embedding、Silero VAD、CAM++、任务 worker、数据库和 R2 均为 ready。
- 公网 Device v2 能力探测返回上传、导入转写事件、实时 ASR、日程图、来源流和 Q2 reader 全部启用。
- 公网日程图真实请求“明天下午三点半到五点开会”得到 2026-08-23 15:30 至 17:00；探测设备随后已 purge。
- APK 构建、签名连续性、生产配置和更新清单均已检查。
- h1 切换后整理 worker 启动、就绪和日志检查通过；未再出现 `vnext summary scan failed` 或 `OperationalError`。

未执行真机安装和真机端到端回放：发布时没有 ADB 设备，且产品所有者明确要求跳过人工验证和正常使用周期。用户可通过应用内“检查更新”安装本版。

## 切换中发现并处理的问题

### 隔离迁移命令的环境优先级

第一次数据库迁移预演通过 `systemd-run` 同时使用 `EnvironmentFile` 和覆盖环境变量；同名变量被环境文件覆盖，导致该次预演打开了生产主库。实际写入仅为向后兼容的空表：`capability_cutovers` 和 vNext 通用任务表；未登记 capability barrier，未创建业务任务，完整性和外键检查通过。随后使用进程内 `/usr/bin/env` 显式覆盖，在数据库快照上重新完成隔离迁移验证。

### 整理来源流建表时序

首次生产启动后，来源流恢复 worker 在新库缺少来源流表时先于 API 请求运行，每两秒记录一次 `OperationalError`。当时没有整理任务，因此没有任务或结果丢失。已先在线执行幂等 schema bootstrap 止血，再在 `a870010` 中把 bootstrap 固化到 worker 启动前，并部署到独立 h1 目录。重启后的来源流表完整且为空，日志不再出现该错误。

## 明确保留的风险与待办

- 人工事实支持率、行动质量、Q2 引用相关性、自然日程 holdout 和正常使用观察周期未通过，只是被发布授权豁免。
- 旧 reader、旧 parser、summary v2、Q0、mirror 和账号/同步实现继续保留为冷回滚；`legacy_reader_removed_at` 均为空，Stage 5 物理删除门保持关闭。
- 隔离候选 `18030`、`18032` 仍有到期前的 R2 cleanup obligation，暂时保留为清理 worker；完成后才可停止并归档，不影响公网生产路径。
- 后续真实使用问题应在 vNext 主链修复；只有整版事故回滚才启用旧版，不恢复双写或请求级 fallback。
