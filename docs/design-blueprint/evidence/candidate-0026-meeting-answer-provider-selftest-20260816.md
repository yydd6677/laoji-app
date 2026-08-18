# 候选 0026：MeetingAnswerProvider 隔离合同自测

## 状态

- candidate: `$CANDIDATE_ROOT/meeting-answer-provider-0013`
- result: `self-tested; independent code audit pending`
- adoption: **not adopted**
- production mutation: `none`

该候选把 revision 0012 的 Provider 边界做成可执行纯 Python 合同。它没有导入生产服务、
模型、数据库、API、APK 或真实会议内容。

## 实际包含的边界

`MeetingAnswerRuntime` 只负责：

- 当前 evidence snapshot digest 与请求绑定；
- deadline 和 provider context 预算预检；
- `private_local/public_synthetic/external_explicit` 隐私分类；
- 外部授权绑定 authorization ID、evidence digest、精确 Provider identity 和有效期；
- canary 绑定 provider、runtime、model revision、transport、schema revision 和有效期；
- 一次 primary 调用；只有调用者明确标记 shape invalid 后允许同 session 一次 repair；
- provider error 暴露 dispatch state；只有确定尚未 dispatch 才标 retryable，runtime 本身
  仍不自动重试；
- `answered/insufficient_evidence/invalid_output/provider_unavailable/stale_snapshot` 分离。

它明确不拥有 evidence 选择、answer parse/validation、问题历史、任务恢复、持久化、
provider 选择、自动 fallback、重试或 UI 状态。若接入后仍保留现有多轮问答链，它就只会
成为新的 facade，按蓝图自动否决。

## 自测证据

冻结哈希：

```text
491cff626f5b663d1300c9eb1dc4a617ce962af683c9b3ebc1b4b4332fc2cc01  meeting_answer_provider.py
53a1d391f7e80ab0f98b9b1a0670144e7efe94a2f003a0797268b908811ad2b9  tests/test_meeting_answer_provider.py
```

Python 编译和 `18/18` 单元合同通过，覆盖：

- 私有证据在 external dispatch 前拒绝；
- public synthetic 可走外部；explicit external 必须有精确授权；
- stale snapshot、过期 deadline、context 超限和 canary 不匹配均不触发 provider；
- canary 过期、runtime/model/transport/schema 漂移均 fail closed；
- primary 严格一次，evidence invalid 不能开启 repair；
- known-not-dispatched 与 unknown dispatch 的 retryability 不混淆；
- terminal outcome 后不能隐藏调用；
- 穷举 `primary/mark/repair/finalize` 所有四步序列，最大调用数始终为 2，且 repair 前
  必有且只有一个 primary。

第一次自测因 model revision 合法值包含 `@artifact` 而正则未允许 `@`，14 项均在构造
阶段失败；修正标识语法后才通过。随后自审发现 canary 无有效期、external authorization
只是一段字符串，又补成绑定对象后重跑通过。这些是候选迭代记录，不是生产回归。

## 未通过的门

- 没有独立代码 reviewer；
- 没有真实 Ollama `/api/generate` 或 DashScope adapter；
- 没有 canary issuer、external authorization issuer 或密钥/签名边界；
- 没有真实 HTTP timeout、cancel、断线、未知执行结果和进程重启；
- 没有把 production provider failure 从 insufficient 中迁出；
- 没有接 Q2 evidence reader、API、repository 或手机；
- 没有证明采用时能删除现有分支；
- 没有改善 reader 质量或用户延迟。

## 下一门

先由未参与实现的 reviewer 检查该 394 行合同是否确实替换概念、授权对象是否只能由
可信 server policy mint、deadline/cancel/unknown dispatch 是否能映射到真实 adapters。
只有审查通过，才允许写两个隔离 adapter 和 conflict canary；仍不接生产。

reader 质量继续由 research 0017 的冻结 27B 对照处理，两条证据不得混成“问答已升级”。
