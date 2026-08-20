# vNext 全局混合负载退出门（隔离候选）

状态：`passed; candidate-only; production untouched`。

## 结论

提交 `05d6183` 的隔离候选在全新迁移数据库、独立 R2 前缀和 `18030/8031` 上完成了蓝图规定的
10 分钟全服务混合负载。请求窗口为 600 秒，含清理的总墙钟时间为 `631.789s`；所有功能、延迟、
资源和清理门均通过，报告中的 `failed_gates=[]`。

本轮没有切换 capability barrier、生产 APK 或公网流量。生产 `18020` 与 `8030` 的进程在回放前后
保持原 PID；GPU1、PCB、Smart Meeting 和其他用户服务未操作。

权威脱敏报告：

- `docs/vnext-global/global-mixed-formal-clean-05d6183.json`
- SHA-256：`45e3100d0d468f29da0f1a42501ce4c391e118796fd9824f18e8e9369527c2f4`
- 报告只保存输入/输出哈希、计数、revision、时间和资源值，不保存正文、问题、回答或引用文本。

## 工作负载与结果

| 通道 | 实际工作量 | 结果 |
| --- | ---: | --- |
| 实时转写 | 600 秒 source-clock PCM，300 秒处断开恢复 | 1/1 完成，170 个 stable、唯一 final |
| 持续上传 | 33,600,078 字节 multipart，持有 600 秒 | 1/1 完成，R2 与 epoch purge confirmed |
| 导入转写 backlog | 同一合法 WAV 串行重复导入 | 10/10 完成，最大重启间隙 2.173 秒 |
| 日程 Graph | 每分钟一次 | 10/10 完成 |
| Q2 | 每两分钟一次 | 5/5 完成，引用逐字匹配 |
| Facts V3 Summary | 第 30 秒开始、每五分钟一次 | 2/2 完成，引用逐字匹配 |

实测延迟：

| 指标 | p50 | p95 | 最大值 | 门限 |
| --- | ---: | ---: | ---: | ---: |
| 实时 stable lag | 632.8ms | 1,844.9ms | 2,013.3ms | p95 <=2s |
| 导入首个 stable | 2,710ms | 3,291.1ms | 3,355ms | p95 <=8s |
| 导入 RTF | 0.111653 | 0.128744 | 0.131662 | p95 <=0.5 |
| 日程 Graph | 1,674ms | 1,794.1ms | 1,831ms | p95 <=3s |
| Q2 端到端 | 8,117ms | 11,248.6ms | 11,967ms | p95 <=15s |
| Summary 端到端 | 13,927ms | 13,953.1ms | 13,956ms | p95 <=45s |

## 根因和实现改动

上一份同输入报告 `b96847b` 的日程 p95 为 `14,369.1ms`、Q2 p95 为 `32,602.8ms`。真实 provider
遥测证明并非提示词推理本身占用这些时间，而是同一个 `qwen3.5:9b` 被日程以 8K context、
Summary/Q2 以 16K context 交替调用；Ollama 因 runner shape 不同而反复卸载和重建模型，每次
`load_duration` 约 12--13 秒。

`a06a0ee` 将本地生成 Provider 固定为一个部署级 context，默认 16K，并在合并业务 caller options
之后强制使用该值。日程、Summary、Q2 不再各自创建同模型 runner。正式回放中后续推理的
`load_duration` 约 0.35--0.39 秒；Q2 与第二轮 Summary 相邻时仍分别为约 7.26 秒和 9.58 秒，
说明结果不是通过错开请求获得。

`05d6183` 另让评测源 IP 包装器兼容 Python 3.10；正式候选仍按蓝图使用统一 Python 3.12 环境。
一次使用旧数据库副本的预跑因继承 24 小时 bootstrap 计数而被拒绝，没有纳入证据；权威回放使用
全新 API、日程、声纹和位置数据库，避免历史幂等结果或配额污染。

## 资源、隐私与清理

- 300 个两秒资源样本：CPU p95 `5.801` 核；总 RSS p95/峰值 `5.216/5.292 GiB`；老记 GPU0
  进程显存峰值 `14,850 MiB`；候选临时目录峰值 `0 GiB`。
- ASR 最大排队深度 1，持久任务队列最大深度 0；GPU0 最低余量 `2,110 MiB`。该余量包含同卡其他
  服务造成的占用，只用于候选验收，不授权调整其他服务。
- 数据库 `integrity_check=ok`，foreign key violations 为 0。
- 19 个 binding 全部 `purged`，upload session 为 0，11 个对象清理义务全部 `confirmed`，11 个
  reservation 全部 `released`，34 个 purge 全部 `confirmed`，加密 Summary 临时载荷为 0。

## 本证据关闭与不关闭的门

本报告关闭完整十分钟全服务混合负载中的实时、上传、导入 ASR、日程、Summary、Q2、资源和清理门。
它也关闭了此前 Q2 “混合负载暖态 p95 未证明”的缺口。

它不替代以下独立门：Stage 2/3/4 的 Android 真实恢复矩阵、ASR/讲话人质量、Facts/行动/Q2 独立人工
质量、自然日程盲审、公开 v1 零流量周期和 capability barrier。因此 Stage 3/4 仍是隔离候选，
Stage 5 尚不能删除 legacy reader 或旧写路径。
