# 蓝图修订 0009：durable speech execution owner

## 状态

- revision: `0009-durable-speech-execution-owner-20260816`
- status: `candidate`; **not adopted**
- parent: `0008-speech-active-generation-owner-contract-20260816`
- observed: `2026-08-16 Asia/Shanghai`
- production mutation: none

## 被撤销的旧假设

0008 假设在真实 asset/job/draft/canonical 角色上增加 generation、attempt fence 和 trigger，
可以逐步让旧 worker 退出 owner。最终独立审计证伪：旧 recovery scanner 不理解新合同，
仍可先 claim v2 job；重分段仍会删除人工历史；speaker terminal 与 manual expected revision
也没有闭合。详见 [candidate 0020](../evidence/candidate-0020-speech-owner-convergence-final-rejection-20260816.md)。

因此：

- M1-O 正式停止，0004 不再修第三轮；
- 旧 job/draft/final worker 只能服务冻结的 C0 数据；
- 新合同不能再通过 `contract_version` 列让旧执行器“顺便支持”。

## 新目标边界

### 执行 owner 与 domain result 分离

```text
durable workflow runtime       immutable domain history         mobile projection
workflow ID / recovery    ->   text generations + overlays  ->  asset/gen/run/revision
```

- durable runtime 唯一拥有执行、恢复、step outcome、重试和代码版本；
- domain DB 只保存不可变 generation、active pointer、automatic speaker overlay、manual
  source overlay 和只读状态投影；没有第二套 claim/lease/recovery；
- 手机只消费 domain snapshot，不查询 workflow journal，也不自行铸造 revision。

### 不可变 generation

- 每次重做创建 generation；旧 text/segment/引用/人工覆盖永不因新分段删除。
- active pointer 只在同一 domain transaction 内切换；旧 workflow 的迟到提交返回
  superseded，不覆盖 active。
- 同 asset/source revision/sample boundary 产生同 source segment ID；边界变化产生新 ID。
  人工 source overlay只在 ID 相同的音频范围继续生效。

### Text、speaker 与 manual

- text generation 只有 source EOF 后才能原子关闭；空语音是合法空 generation。
- 自动 speaker 是 text 之后的独立 overlay；其 step 可迟到，不改 text revision。
- speaker terminal 只能在 text generation 的 `manifest_eof=1` 后提交。
- 人工操作必须带 expected active text revision + expected assignment revision；任一过期都
  fail closed。

### Request identity

- workflow ID 由服务端规范化的 source identity、处理合同/model revision 和操作 nonce
  派生；不接受调用方任意 ID。
- DBOS/Restate 的 workflow idempotency 不能替代 payload identity 校验。相同请求复用同
  workflow；任何输入变化必须得到不同 ID。

## 当前候选

### D1：embedded DBOS 0006

`$CANDIDATE_ROOT/speech-durable-owner-dbos-0006` 使用 DBOS 2.29：

- workflow system DB 是唯一 execution owner；
- datasource transaction 写 immutable domain history；
- 模拟 decode step 明确按 at-least-once 设计；
- 旧 worker/job 表完全不进入候选。

它已在隔离临时库通过最初的 `os._exit` 恢复、late generation、重分段历史和 manual CAS
测试，但尚未独立审计。DBOS SQLite 官方不推荐生产，因此候选通过也只能标记
`validated prototype`，不能直接 adopted。

### D2：Restate asset Virtual Object

Restate 作为 challenger 保留：每 asset key 原生 single writer，单节点是官方支持的
自托管形态；代价是新增 Restate stateful process、持久卷、durable log/RocksDB 和 retention
配置。若 DBOS 因 SQLite production、版本 drain 或锁竞争阻断，下一原型立即转 Restate，
不得回 M1-O。

完整比较见 [research 0014](../research/0014-durable-speech-owner-runtime-comparison-20260816.md)。

## 迁移规则

1. C0 与新 runtime 按 source contract 分流；同一个 asset generation 永不双投。
2. 新 runtime 不写旧 worker 可扫描的 queued/running job。兼容 API 读取新的只读 run view，
   或在 projector 中投影；projector 不得拥有 retry。
3. 旧 C0 在途任务 drain 后只读保留历史。禁用旧 recovery 对新任务不是 feature flag
   约定，而是结构隔离。
4. DBOS/Restate domain tables 与手机 projection 先 shadow 回放；真实服务、数据库和 APK
   未授权不得迁移。
5. 回滚停止创建新 workflow；已创建 workflow 必须由匹配代码版本 drain 或显式取消，
   不能换回旧 worker接管。

## 下一门禁

1. 独立审计 DBOS 0006 的真实 runtime ownership、step/transaction 边界和 system DB 丢失；
2. process exit 前后只产生一个 active domain result，外部 step 的重复次数可解释；
3. 两个 generation 并发时旧结果绝不 publish；历史与人工覆盖仍可读；
4. workflow 代码升级、取消、磁盘满、SQLite busy/WAL 和 system/app DB 单边损坏；
5. 同合同实现最小 Restate asset-key challenger，比较进程/RSS、磁盘增长、恢复时延和概念；
6. mobile 0005 独立审计并证明 speaker-only patch 不触发 transcript rewrite/summary stale。

当前没有任何生产 provider、worker、schema、API、Native 或部署发生变化。
