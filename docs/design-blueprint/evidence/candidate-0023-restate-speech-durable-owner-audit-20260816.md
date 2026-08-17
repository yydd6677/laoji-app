# 候选 0023：Restate speech durable owner 实测与否决边界

## 状态

- candidate: `/home/yydd/LaoJi-candidates/speech-durable-owner-restate-0007`
- runtime: Restate Server `1.7.2` + Python SDK `1.0.4` + Hypercorn `0.17.3`
- result: `self-tested`; independent runtime contract audit `BLOCK`
- adoption: **not adopted**
- production mutation: none

该候选是 0009 要求的 Restate challenger。它没有导入老记生产配置、数据库、模型或旧
worker，也没有修改服务、APK、设备、公网、GPU1 或 PCB。

## 已证明的边界

当前候选以 `SpeechAsset/{asset_id}/transcribe` 的 exclusive Virtual Object handler 执行
decode、ASR、不可变 text commit、speaker 和 speaker commit。请求身份只由 source
identity/revision/checksum、合同、模型和 operation nonce 派生，不包含合成转写正文。

本地复跑结果：

- domain 单测 `8/8`；
- 真实 Restate + Hypercorn 集成检查 `6/6`；
- 六个同 asset 请求 generation 严格为 `1..6`，外部阶段最大并发为 `1`；
- service process 在 domain commit 后退出，`commit_text` 外部 action 实际执行 `2` 次，
  domain generation 只提交 `1` 行；
- Restate Server 被强制终止后使用同一 base-dir 重启，原 invocation 恢复并只返回一份
  domain result；
- 空语音仍按 `decode -> asr -> commit_text -> speaker -> commit_speakers` 闭合，结果为
  `completed + speaker unavailable`；
- speaker commit 在 text manifest EOF 前 fail closed；迟到 speaker 不覆盖 active generation；
- 重分段保留旧 generation 和人工 source overlay；source checksum + sample boundary identity
  可跨纯 metadata revision稳定；manual 同时检查 expected text revision 与 assignment revision。
- Restate state 和 domain DB 任一侧单独缺失时均返回 `409 authority mismatch`，证明当前
  候选 fail closed；这只是检测，不是灾难恢复。

这证明 Restate 能拥有 invocation replay，同 key exclusive handler 也确实是 single writer。
它不证明外部副作用 exactly-once：effect 已发生但 journal 尚未确认时，`ctx.run_typed` 会
重新执行。所有真实 ffmpeg、ASR、CAM++、R2 和 domain 写仍必须接受稳定 operation ID 并
自行幂等。

## 资源实测

同机隔离复跑的暖态观测为：

| 项目 | 观测 |
|---|---:|
| Restate RSS | 多次复跑 `253.5-303.1 MiB` |
| Python/Hypercorn service RSS | 多次复跑 `27.9-28.1 MiB` |
| Restate base-dir 逻辑文件大小 | `0.7 MiB` |
| Restate base-dir 实际分配块 | `273.3 MiB` |
| Restate server binary | `220,913,096 bytes` |
| Python venv | 约 `20 MiB` |
| service 恢复到 health | 约 `0.302 s` |
| Restate 恢复到 admin health | `0.103-0.110 s` |

逻辑文件大小不能代表运行中磁盘成本；RocksDB/log 的预分配使空候选运行时分配约
`273 MiB`，正常关闭后测试目录会收缩，不能把其中任一数字单独当作长期增长率。
作为非完全等价参考，DBOS 0006 在 30 秒合成 decode 期间观测约 `72.4 MiB` RSS、约
`256 KiB` 两个 SQLite 文件和 `52 MiB` venv。Restate 的资源仍可接受，但它不是“免费”
的紧凑替换。

## 采用阻断项

### 1. 长 exclusive handler 阻止新 generation 抢占

当前 handler 将整条 decode/ASR/speaker 长链放在 per-asset exclusive invocation 内。
这能证明串行，却意味着同 asset 的重试、重做和新 source revision只能排在旧长任务之后。
只要旧 invocation持续恢复，新 generation 就不能先 reserve，也无法验证 0009 的“旧迟到
结果被新 generation fence”。

若继续 Restate，下一形态必须比较：短 exclusive reserve + 独立 request Workflow +
回调式 fenced publish；不能把当前“排队到旧任务完成”误写成 supersession。

### 2. Journal 当前持久化明文内容

独立运行时审计直接读取 `sys_journal.entry_json`，确认 ingress payload、headers、
`ctx.run_typed` 返回值和 handler输出均被持久化。当前 fixture 的 `spoken_text`、decoded unit
和 ASR segments 会以明文进入 journal，默认 retention 为一天。

真实候选必须只把 opaque source reference、合同、revision、nonce 和 digest 交给 Restate；
外部 ASR 以稳定 ID 幂等写入受控暂存/domain，再只返回引用和哈希。把完成后 retention 改为
零不能消除运行中 replay 所需的数据。

### 3. Restate state 与 domain DB 的单边损坏未闭合

当前 generation 由 Restate object state拥有，domain DB 只接受该 generation 并以 CAS 拒绝
迟到提交。运行时恢复成立，但两套持久介质仍需要一致快照和恢复协议：

- Restate state丢失、domain 保留时，不能静默从 domain 铸造新的 runtime authority；
- domain 丢失、Restate journal 保留时，已确认成功的 domain action不会自动重做；
- 当前只能 fail closed 为 authority mismatch，不能恢复用户结果。

在备份/恢复演练、版本化 deployment drain、取消和磁盘故障通过前，不能采用。

### 4. 还不是老记真实链路

候选只使用 fixture adapter，没有真实 ffmpeg、8030、CAM++、R2、优先级、长录音、取消、
移动 projection 或删除链路。默认消息上限和 journal增长也未在真实长会议上验证。

## 运行与网络事实

- 默认端口为 ingress `8080`、admin `9070`、fabric `5122`；`9071` 不是 1.7.2 默认端口。
- 默认绑定不能作为生产安全配置；三类监听都必须显式 loopback 或 Unix socket，admin 不得
  暴露公网。
- 注册 deployment 要先 dry-run，正式注册保持 `force=false`；同 URI强制覆盖不能替代旧
  deployment drain。

## 决策

Restate 0007 停在 `self-tested + independently blocked`。它成功证实 durable runtime 能
替换旧 recovery owner，也证实了当前长 Virtual Object 形态不满足抢占、隐私和双存储灾备。
后续不得把 `6/6` 自测扩写成 production validation，也不得回到 M1-O。

下一轮只允许两个反事实进入比较：

1. Restate 短 reserve object + 每 request Workflow，明确 active generation fence、opaque
   journal payload 和双存储恢复；
2. 单 domain SQLite 的 clean-room durable executor，把 operation、step outcome、immutable
   generation 和 active pointer放进同一故障域，证明它没有重造第二 owner。

DBOS 0006 仍需独立审计；mobile 0005 仍需真实 repository transaction审计。三者都没有
进入生产。

## 复现

```bash
cd /home/yydd/LaoJi-candidates/speech-durable-owner-restate-0007
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests -v
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/integration_restate.py
```

官方语义参考：

- [Durable steps](https://docs.restate.dev/develop/python/durable-steps)
- [Services and per-key ownership](https://docs.restate.dev/foundations/services)
- [Self-hosted server](https://docs.restate.dev/server/overview)
- [Service retention](https://docs.restate.dev/services/configuration)
