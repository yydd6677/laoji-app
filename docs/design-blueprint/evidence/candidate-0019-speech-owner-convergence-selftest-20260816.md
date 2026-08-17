# 候选 0019：语音 owner convergence 0004 自测证据

## 状态与边界

- 候选目录：`/home/yydd/LaoJi-candidates/speech-owner-convergence-0004`
- 状态：`candidate self-tested`; **independent review pending; not adopted**
- 生产修改：无；没有修改真实服务源码/数据库、进程、模型、设备或 APK。
- 父证据：[candidate 0018 rejection](candidate-0018-speech-revision-owner-rejection-20260816.md)
- 蓝图合同：[revision 0008](../revisions/0008-speech-active-generation-owner-contract-20260816.md)

该候选不是新的平行 ledger。它从与真实角色同名、包含关键 FK/列的最小 v1 SQLite
副本开始，对现有 asset/job/draft/`TranscriptLine` 做 additive v2 migration；新增 manifest
只有到现有 job 的级联 FK，没有独立 claim、retry 或 worker。

## 本轮实现

### 唯一 owner 与恢复

- 新 job 显式 `contract_version=2`；迁移前 `running/attempt=3` 的 v1 job 保持原值。
- 创建 run 要求 expected active generation CAS；scheduler claim 要求 expected attempt CAS。
- 每次 manifest、cursor、text、speaker 和 final 写都检查当前 job attempt 与 asset active
  generation。旧 worker 即使发送 revision 999 也被拒绝。
- close intent、decode cursor、source total 和 manifest EOF 持久化；close/final/EOF 六种
  到达顺序均收敛到同一 closed 结果。
- checkpoint 只有 run、active generation 和 attempt 全匹配时可用，否则视为可删缓存。

### 文字与讲话人

- `max(segment.end)` 不再授权 close。source total 不能早于任一 manifest 末端，cursor
  不能回退或停在已登记 segment 内部。
- manifest ordinal/sample 严格单调且区间不重叠；浮点 revision/prefix fail closed。
- 空 manifest + 完整 EOF 是成功的无语音文字结果。
- draft/final 复用同一 `source_segment_id` 和稳定 `TranscriptLine.id`；同一 segment 重做
  时人工 speaker assignment 不因 delete/reinsert 丢失。
- text/speaker 有独立终态；speaker 永久不可用可关闭 lane，不阻塞已闭合文字。
- 自动 speaker patch 只更新 base，snapshot 始终让 `user_locked=1` assignment 优先。

### 手机投影与删除

- 全量 snapshot 返回 run/projection/text/speaker/source cursor 和 per-segment 双 revision。
- 手机 fixture 对同 revision 异内容 fail closed；重复/过期忽略；delta 跳号或 run 变化要求
  全量重取，不铸造远端 revision。
- 删除 device data epoch 对测试中的 meeting/asset/job/manifest/draft/canonical/speaker
  assignment 完成级联闭包，foreign-key check 为 0。

## 自测结果

```bash
cd /home/yydd/LaoJi-candidates/speech-owner-convergence-0004
python3 -m unittest discover -s tests -v
```

结果：`28/28 passed`。在所有 CPU 并行重复 64 次完整套件也通过；这是时序偶发性扫描，
不是 1792 条独立用户质量样本。另有：

- additive migration 中断回滚；
- final promotion 注入失败后 job/draft/current pointer/canonical 同事务回滚；
- speaker patch 与 final promotion 并发不丢 lane；
- SQLite busy 映射到稳定 retryable `owner_store_busy`；
- `PRAGMA integrity_check=ok`，foreign-key violation 为 0。

资产 SHA-256：

- `README.md`: `cc54f2bab3883ce54f318ca170f0378ead6547fc2dcef7239168b6ecc097226b`
- `owner_contract.py`: `bd1a7cdb0cb9884153bc0b7b5d9cae666a44d7e46a0b426ef7adc9e3eb25d7aa`
- `tests/test_owner_contract.py`: `f0bf167cdbd009efdd04d1388065d8ee8d7c5f5796d4899e31c5cef6a1e68544`

## 尚未证明

1. v1 副本只覆盖真实表的相关列，不是生产数据库字节副本；尚未运行 SQLAlchemy 模型、
   真实 migration 启动顺序和大库锁时长。
2. 没有接入真实 queue、partial callback、final transaction、device API 或 Android SQLite；
   因此不能宣称生产已有 fencing、stable ID 或 mobile CAS。
3. 没有真实 PCM、ASR、CAM++、WebSocket、CER/DER、首字延迟或 GPU 证据。
4. fault hook 证明 Python 异常回滚，尚未对 0004 做 `os._exit`/断电/WAL 恢复矩阵。
5. active/current generation 对旧摘要引用、文字搜索和分享快照的影响尚未审计。
6. realtime capture identity 仍只有合同，没有断线重连和 stop 后 asset 绑定原型。
7. 独立审计尚未完成；自测不能把状态提升为 `validated in isolation`。

## 下一门禁

先由全新独立代理对照真实 server/mobile schema 复核第二 owner、迁移、人工锁定、删除
和历史引用。通过修订后，再在隔离服务副本嵌入 SQLAlchemy migration/transaction，跑
真实 v1 数据库快照迁移、API snapshot 与手机 reducer fixture。此后才允许同一脱敏 PCM
做 C0/M1-O 延迟对照；仍不修改生产。
