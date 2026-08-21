# Stage 2 正式 8030 v2 handler 切换与实施结果（2026-08-21）

状态：`activated on production 8030; legacy/v1/v2 compatibility passed; candidate API recovery passed; capability remains closed`。

## 切换前现场差距

生产 `laoji-asr.service` 仍从
`/home/zhong/laoji-service-platform/compact-production/backend/qwen_asr_service/server.py` 启动，PID
`363049`，自 2026-08-09 起持续运行。只读检查得到旧源码 SHA-256
`00bfad570b634ddf209720d81bbee098dd31109be23a32842b01b8601c018333`；旧服务支持 `/asr` 和
`/v1/asr/batch`，对严格空 JSON 的 `/v2/asr/batch` 探针返回 HTTP `404`。

因此当前 `8031` 的兼容代理不是最终拓扑。Stage 2 的 8030 v2 缺口是真实部署差距，不是仓库合同缺失。

## 已封存候选

服务器候选目录：

`/home/zhong/laoji-vnext-candidate/releases/asr-v2-handler-66e0ac6`

| 资产 | SHA-256 |
| --- | --- |
| candidate `qwen_asr_service/server.py` | `4c50e089cc08765e134f1a0f416d539846849d7233d681431dbf85e895c86cac` |
| rollback `qwen_asr_service/server.py` | `00bfad570b634ddf209720d81bbee098dd31109be23a32842b01b8601c018333` |
| candidate `laoji-asr.service` | `32249102cc36d964fbc07ba0195face28327d40bc60465f8b92e976dd70c35aa` |
| rollback `laoji-asr.service` | `35dad2f632aaa45248057051f601eae4c114bc92b7e8eea8eacda33d4d70d431` |

候选 unit 只把 `ExecStart` 改到上述版本目录；用户、环境文件、GPU0、工作目录、超时、权限收紧和
重启策略保持当前生产值。候选不复制任何密钥，继续读取现有 root 管理的环境文件。

## 目标运行时兼容性

新增 `tools/vnext/probe_asr_v2_release.py`，用生产相同的
`/home/zhong/laoji-service-platform/.venvs/laoji-compact-py312/bin/python` 导入候选文件。探针不加载
Qwen、不占用 GPU、不绑定固定端口，只用 fake model 启动真实 `ThreadingHTTPServer/Handler`，结果：

- `/ready` 固定 revision：通过；
- legacy `/asr`：通过；
- `/v1/asr/batch` 向后兼容且不混入 v2 字段：通过；
- `/v2/asr/batch` schema/revision/stable segment/outcome：通过；
- 数字静音返回 `no_speech`：通过；
- 缺失 v2 contract revision 返回 `422 contract_revision_invalid`：通过。

这关闭源码、目标 Python 环境和 HTTP handler 的部署前兼容性，不等于真实 8030 已切换。真实模型推理、
优先级和性能已由同模型/revision 的 8030 经 8031 兼容入口完成既有候选回放；正式 handler 仍需下述一次
维护窗口验证。

## 切换与回滚合同

切换必须单独获准，并在没有实时会议请求的短维护窗口执行：

1. 再次核对当前 unit、源码和环境 revision 与本文件哈希一致，8030 队列为空；
2. 把 candidate unit 原子安装为 `/etc/systemd/system/laoji-asr.service`，执行 daemon-reload 和 restart；
3. 等待 `/ready` 的 model revision 为 `7278e1e70fe206f11671096ffdd38061171dd6e5` 且队列为空；
4. 顺序验证 legacy `/asr`、v1、严格 v2 文本、v2 NO_SPEECH 和一次 1--8 item batch；
5. 将候选 API 的 `QWEN_ASR_V2_BATCH_URL` 与 readiness 明确改到 `127.0.0.1:8030`，完成真实导入恢复
   回放；只有确认无 `8031` 引用后才能停止兼容代理；
6. capability 仍保持关闭，直到独立人工媒体质量和公开零旧提交周期同时通过。

任一 readiness、旧接口、v2 合同、真实推理或延迟门失败时，立即恢复 rollback unit，daemon-reload 并
重启；恢复 `/ready` 后再次验证 legacy `/asr` 和 v1。切换前后均不得修改 GPU1、PCB、Smart Meeting
或其他用户服务。

## 维护窗口实施结果

用户于 2026-08-21 明确授权 8030 短维护，并确认当时没有会议或导入任务。切换前再次核实：

- 8030 queue depth 为 0、active priority 为空，且没有 established 8030 连接；
- 18020 持久任务 `queued=0/running=0`，三库完整性、foreign keys 和 WAL 正常；
- 线上源码 SHA-256 与本文 rollback 源码一致；线上 unit 原样备份到
  `/home/zhong/laoji-vnext-candidate/activations/asr-v2-20260821T2110`，未依赖候选包中的注释版
  rollback unit。

随后原子安装候选 unit、daemon-reload 并重启 `laoji-asr.service`。当前生产进程 PID 为 `800304`，
只监听 `127.0.0.1:8030`；unit SHA-256 为
`32249102cc36d964fbc07ba0195face28327d40bc60465f8b92e976dd70c35aa`，实际 handler SHA-256 为
`4c50e089cc08765e134f1a0f416d539846849d7233d681431dbf85e895c86cac`。`/ready` 返回固定 revision
`7278e1e70fe206f11671096ffdd38061171dd6e5`、`cuda:0`、队列为空。

真实 Qwen3-ASR-1.7B 复验全部通过：

- legacy `/asr` 与 `/v1/asr/batch` 均返回非空文字和相同固定 revision；
- 严格 v2 对 8 个 4 秒真实语音 item 返回 8 个唯一 stable item 和 8 个 text outcome，总墙钟
  `1839 ms`、RTF `0.0575`；
- 2 秒数字静音返回 `no_speech`、空文字、stable state；
- 缺失 v2 contract revision 返回 `422 contract_revision_invalid`。

隔离候选 API `127.0.0.1:18030` 已从 8031 改为直接读取 8030 readiness 并调用
`127.0.0.1:8030/v2/asr/batch`，生产 `18020` 未修改。一次 360.133 秒真实 MP4 普通回放得到 115 个
stable 和唯一 final，首个 stable `2333 ms`、RTF `0.096836`、ACK 与 binding/epoch purge 均确认。
第二次同输入在 transcript attempt 1 为 `running/admitted` 时终止候选 API PID `836532`，以同一候选
SQLite 重启为 PID `849223`；原探针跨中断继续轮询，最终仍得到 115 个 stable、唯一 final、ACK 和
两级 purge confirmed，RTF `0.186973`。该中断回放的首段 `36698 ms` 包含故意进程中断与租约恢复，
不得混入正常暖态延迟统计。

旧 `8031` 进程已核实为 `probe_v2_asr_compat_proxy.py`；停止前没有 established 连接，所有运行中
Python/Uvicorn 环境只有代理自身引用 8031。候选 API 改指 8030 后，该代理及其父 shell 已停止，8031
不再监听。最终生产 8030、生产 18020 和候选 18030 均 ready，8030 与候选任务队列均为空。

一次正式恢复回放前的诊断探针已完成转写，但因候选当时沿用 `3600s` 预签名 TTL，在 60 秒探针清理
等待内未到达安全删除时间；它留下 1 条仅属于隔离候选前缀的 cleanup obligation，状态为 `pending`、
`not_before_epoch=1787321881`。后续两次正式回放均使用 60 秒测试 TTL 并已 purge confirmed；候选最终
恢复 3600 秒部署配置。未通过篡改 not-before 或提前标记 confirmed 来掩盖该诊断残留，常驻候选 worker
会在预签名失效后按正常合同删除。这不占用 ASR/Task 队列，也不涉及生产会议资产。

本次只关闭正式 handler 部署、真实协议复验、候选直连和恢复回放缺口；没有激活 media capability、
没有切换公网或 APK，也没有触碰 GPU1、PCB、Smart Meeting 或其他用户服务。独立媒体人工质量与公开
零旧提交周期仍阻断 Stage 2 退出。机器可读摘要见
`asr-v2-8030-cutover-20260821.json`。
