# 候选 0021：DBOS speech durable owner 0006 自测

## 状态

- candidate: `$CANDIDATE_ROOT/speech-durable-owner-dbos-0006`
- runtime: DBOS Python `2.29.0`, Python `3.13`, isolated venv
- status: `candidate self-tested`; **independent review pending; not adopted**
- production mutation: none
- blueprint: [revision 0009](../revisions/0009-durable-speech-execution-owner-20260816.md)

该候选不是在旧 worker 外包一层 DBOS。旧 job/draft/recovery 不存在；DBOS system DB 是
execution owner，应用 SQLite 只保存 immutable generation history、active pointer、read
view 和 speaker/manual overlay。

## 首轮自测

```text
test_generation_history_and_manual_expected_revision_survive_resegmentation ... ok
test_process_exit_recovers_and_domain_transactions_commit_once ... ok
test_recovered_old_workflow_cannot_publish_after_new_generation_reserves ... ok

Ran 3 tests in 18.608s — OK
```

已观察到的关键事实：

- 在 decode step 中注入 `os._exit(73)` 后，下一进程的 DBOS log 明确显示
  `Recovering 1 workflows`；workflow 完成。
- attempt log 有 2 次 decode，符合外部 step at-least-once；domain 中 run/text
  generation/segment 各只有 1 份。
- 旧 workflow crash 后启动新 generation，并在恢复进程让两者并行；旧 run 最终
  `superseded`，只有新 generation 可 publish。
- 改变 segment sample boundary 后旧 text generation 与 manual source overlay仍保留；
  旧 expected text revision 的迟到人工操作被拒绝。
- 回到同 source revision/sample boundary 后 source segment ID 相同，人工 overlay继续生效；
  新人工操作同时 CAS expected text revision 与 assignment revision。
- speaker transaction 读取 domain 中 `manifest_eof=1` 后才可提交。
- workflow ID 由规范 source/request material 派生；同请求复用，不同输入即使 operation
  nonce 相同也得到不同 ID。

## 文件与资源

- `workflow_app.py`: `360d3cc9ed4adc342c45ecfc1f721c177f06e7852ba496e9c35f03f07817e759`
- `tests/test_durable_owner.py`: `da24bb09e8cfd28add92632bd29a6d765917aa8bd56a1c7b744e16b669b47d6f`
- `requirements.lock`: `14d9dc950c265b03797ecbcaa3462183a05987449189d4131f825f79b243cb60`
- isolated venv: about `52 MiB`

## 尚未证明

1. DBOS SQLite 官方不建议生产；未证明它在老记单机上可接受，也没有 PostgreSQL。
2. 未测试 system DB 丢失/app DB 保留、反向单边损坏、磁盘满、WAL 增长和 SQLite busy。
3. 固定 application version 下恢复通过；升级/drain/patching 未测试。
4. 只有模拟 decode/CAM++，没有真实 ffmpeg/VAD/ASR/GPU/隐私 payload。
5. 没有 cancellation、优先级、实时 partial、长会议 step/journal 规模、API/Android。
6. 只有 3 个架构反例测试，不是语音质量或性能评测。
7. 尚无独立审计；不能升级为 validated，更不能进入生产。

## 下一门禁

由未参与实现的代理审计 DBOS workflow ID、system/app DB 原子边界、旧 runtime 隔离、
版本升级和真实 crash window；同时以 Restate per-asset single writer 建立最小 challenger，
防止因原型先完成就默认采用 DBOS。
