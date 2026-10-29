# 实时转写断线恢复与真实任务观测

## 已采用的修复

本轮修复并部署服务端，不修改 APK。公开移动版仍为 `1.2.61 / 269`；真机未连接，不宣称安装或真机验收。

生产 readiness 之前统计退役的 `summary_tasks_v2`，显示 51 成功、16 失败、零队列；真实 vNext 内核却存在两条数小时前断开的实时任务。两条均无活动连接，但 current attempt 仍为 `running/admitted`，租约已过期。断线释放函数只清空录音连接名额，没有释放 Task lease，这是本轮确认的原因，不归因于 ASR 太慢。

- 连接释放与 current attempt 归还处于同一事务。只允许当前 worker generation 释放，旧连接不能释放新连接。普通断线不算推理失败，同一 attempt 可续接，不消耗三次失败预算。
- Socket 先取得资源名额，再 claim attempt；名额不足不留下空占的执行租约。
- 实时 owner 启动时、每 30 秒恢复双租约均过期的执行。只过期一份租约不会接管，正常暂停的心跳仍续两份租约。恢复不生成 final、不推断录音结束、不删除 PCM 或文字。
- 原有 session TTL 到期时明确失败为 `REALTIME_SESSION_EXPIRED`，不再等六小时 payload 清理才终结计算。TTL 终态由恢复和原清理共用一个事务 owner。已取消及成功结果不复活。
- readiness 与维护探针共享一次只读 SQLite 快照，统计真正的 vNext Task/Attempt。`waiting_for_client` 单独可见，不混入执行队列。健康查询不修复租约或修改任务，不公开设备/会议 ID。

## 两条真实旧会话

私有控制库副本重放和生产 owner 调用均检查了音频 checkpoint、加密文字 ledger、来源游标和结果字段的哈希。恢复操作没有改变这些内容，没有直接改库标记成功。最初两条都仍可续接；跨夜后第一条超过原有期限。

| 原进度 | 最终处理 | 保留边界 |
| --- | --- | --- |
| chunk 21678、event 386 | TTL 到期，Task 明确失败，不伪造 final | 恢复时来源不变；随后原有启动 retention 按到期策略释放服务端暂存，进度元数据仍在。未操作手机本地音频/文字 |
| chunk 2071、event 66 | `reconnecting`，current attempt 归还 `queued`，等待原客户端 | 349 个 spooled checkpoint、66 个 stable event 和原游标保留；没有宣称录音已处理完成 |

没有延长既有隐私保留期。客户端未连接，不能把服务端事实扩大成手机当前页面已刷新。

## 验证

- 生产源码形态的隔离候选，仅此次六个文件；隔离库，不启动导入、整理或 retention worker。CPU 支持模型、既有真实 8030 推理，不增加常驻模型。
- 服务端合同 **33 项通过**：释放/续接、重复断线、双租约、旧 generation、TTL、取消、持久化顺序、pipeline、健康只读及缓存等。
- 只读维护门 **6 项通过**：普通排队、活动/过期租约均拒绝。完整空闲与持久无连接的续接等待严格区分，查询不改变数据库字节。
- 12 秒现有视频真实音轨，16 kHz 单声道 PCM，384,000 bytes；SHA-256 `c655bb6c20c458f2b22fade3db11175b7e55a860be282c9ccf3a04b49d712e01`。5562 当前真实设备令牌/binding，经隔离 WebSocket 四次断线、第五次续接，得到 3 条真实文字、1 个 final；唯一任务成功，`attempt_number=1`。
- 上线后再次经**公开 WSS**重放同一音轨、四次断线及续接，仍为 3 条文字、1 个 final、同一第一次 attempt 成功。停止输入到完成约 1,916 ms；不是录音到首字时延、p95 或语义质量分数。
- 这是实际鉴权、传输、VAD/ASR、游标及任务终态证据，不是原生采集/UI、真实无线电或长录音识别质量验收。异常退出接管有合同及真实旧库重放，未冒充一次新录音的物理 crash 实验。

测试准备失败也留边界：一次旧库副本不含模拟器新刷新的 token，返回 `BEARER_INVALID`；在令牌有效时重取一致快照后通过。一次端口尚未监听返回 ECONNRESET。生产形态合同首次缺少既有 capability 开关，31/32，通过同生产开关后 32/32；新增 TTL 合同后 33/33。未为测试绕过生产鉴权/capability fence。

## 部署与维护门

只替换 realtime store、新 realtime maintenance、task health、readiness、生产 main 启停钩子和 router claim 顺序。保留生产独有的历史初始化/capability 检查，不顺带覆盖其他未部署工作。

API 短重启一次，PID `1799157 -> 4021830`；ASR/Ollama 未重启，GPU1、PCB、Smart Meeting 和其他服务不动。

重启前 queued=0、running=0、live lease=0、expired lease=0，ASR/LLM 队列及活动推理为空；另有 `waiting_for_client=1`，所以**不是所有任务终结后的完整空闲**。显式 `--require-maintenance-safe` 仅允许这种无连接、无租约、有持久恢复来源的等待；原 `--require-idle` 仍拒绝，不偷改其语义。重启没有承接或中断该等待会话的执行。

公开 ready 确认三服务就绪、数据库完整，时点计数 success=357、failure=14、waiting_for_client=1，执行队列/活动及过期租约为零。不能把这些动态数字硬编码成未来验收值。

| 部署文件 | SHA-256 |
| --- | --- |
| realtime store | `febf3bc86f96e5a0e3ac8a9232ac4add4a4885f086014bbeba06ac6817836b15` |
| realtime maintenance | `dd170dd67959327fdd859f548acbe182d1f60678762b87bde62a7e034d651389` |
| task health | `c8094c261290d61651e5df1a7b4bd3a0b4e0c4c8699b4a0cc27c992bfacc3fa0` |
| readiness | `9d1e9461760a3cdf2e5172681bdb1c251c173c1cbb85885e4a87a415605f95be` |
| production main | `108cc231f3e5b838d87c437e44b53144ffae6cb16875b4c31804335902c0cce4` |
| production router | `9eedc9386c78355919d793b595ae93e86961a9f4a28b878c364d6f434ad29e4e` |

小型私有证据在 `output/realtime-recovery-20261022/`。隔离服务、数据库副本、测试依赖、临时源码副本和 SSH 转发完成后清理，不留测试后台进程。未提交或推送 Git。

## 下一片

回到长会议 Q2 的漏答、无关引用、笔记归责和等待，沿用前轮同输入基线，不重复已否决的样本规则、查询计划或输入裁剪候选。不重做已交付的移动端链路。
