# Stage 2 正式 8030 v2 handler 切换候选（2026-08-21）

状态：`release staged; target runtime compatibility passed; production unchanged; maintenance-window activation required`。

## 现场差距

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

本轮没有安装 candidate unit、没有重启 8030、没有修改 18020/18030、公网或 capability；结束时
`laoji-asr.service=active`，生产 `/v2/asr/batch` 仍为 `404`。
