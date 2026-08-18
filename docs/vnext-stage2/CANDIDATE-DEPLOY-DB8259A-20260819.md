# 隔离候选部署 db8259a（2026-08-19）

状态：`candidate-only`，生产未触碰。

- API：`127.0.0.1:18021`，PID `1147733`。
- ASR：`127.0.0.1:8031`，未重启生产 `8030`。
- release：`/home/zhong/laoji-vnext-candidate/releases/db8259a`。
- 回滚 release：`d193dd2`，仍保留。
- 服务端包：`laoji-vnext-server-candidate-db8259a.tar.gz`。
- 服务端包 SHA-256：`7934c3094c825244a4a60858e40c669d645f0936a991a862b5c09c1a9518c807`。

## 启动验证

- `/api/ready`：`ready=true`。
- ASR、Ollama 生成、embedding、VAD/CAM++、任务 worker 均 ready。
- main/schedule/speaker SQLite 完整性均为 `ok`，WAL 开启。
- `capability_cutovers` 表已创建，当前行数为 `0`；没有任何能力在启动时被激活。
- `R2_OBJECT_PREFIX=vnext-staging-candidate`，与生产对象前缀隔离。

这次只验证了持久 barrier 控制表的启动初始化，未激活 media/realtime/summary/question/schedule
任何生产切换，也没有改变公开流量。
