# Readiness probe latency boundary (2026-08-19)

状态：`candidate code; not deployed`。

## 现场问题

只读访问隔离候选 `127.0.0.1:18021` 时，第一次 `/api/ready` 在 5 秒客户端超时；放宽到
35 秒后成功返回。返回体显示 embedding 真实探测约 `5528.98ms`，而 `/api/health` 约几十毫秒。
8031 `/ready` 正常，ASR 队列深度为 0，故阻塞来源是 readiness 中同步等待 Ollama embedding，
不是 ASR 或数据库故障。该观察来自隔离候选，生产 `18020/8030` 未访问或修改。

## 实现

`services/laoji-api/app/services/readiness_service.py` 现在采用单飞后台探测：

- 请求只读取最近一次完整的 provider 状态；
- 缓存过期时最多启动一个后台 `provider_state(probe=True)`；
- 冷启动或探测进行中立即返回明确的 `ready=false` 和 `readiness_probe_in_flight`，不误报就绪；
- 探测完成后下一次轮询得到真实 generation/embedding 状态；
- provider 异常只生成脱敏的 not-ready 状态，不让健康接口挂起或泄露异常正文。

## 验证

- `tests/test_readiness_service.py`：`2 passed`，覆盖慢探测快速返回、单飞和失败 fail-closed。
- `npx tsc --noEmit --pretty false`：通过。
- `python3 -m compileall -q services/laoji-api/app` 与 `git diff --check`：通过。

该修复尚未部署到远端候选，也未改变生产 readiness；部署后需要重新测量冷启动首个响应、第二次
轮询收到真实状态，以及探测期间不产生重复 embedding 请求。

