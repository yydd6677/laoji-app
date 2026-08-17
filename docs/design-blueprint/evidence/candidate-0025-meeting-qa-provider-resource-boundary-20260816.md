# 候选 0025：会议问答 Provider、reader 与资源边界

## 状态

- status: `observed candidate boundary; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- production mutation: `none`
- external data: 仅虚构评测会议进入 DashScope；无私人会议、笔记或附件

本证据回答三个问题：本地结构化输出为何失效、embedding 是否能修复隐式口语失败，
以及云端 reader 是否可以无损替换本地 9B。

## 1. Ollama 结构协议不是跨 transport 等价的

现场 Ollama 为 `0.24.0`。同模型、同 JSON Schema 和故意冲突的提示下：

| transport | 结果 |
|---|---|
| `/api/generate + think=false + schema` | canary 通过，返回协议要求的根对象 |
| `/api/chat + think=false + schema` | canary 失败，完整停止但忽略根对象和字段约束 |

这解释了此前首答出现完整错误根数组：它不是 31--40 token 提前截断。真正截断只发生
在旧 repair 复述完整 `original_request` 时。

候选因此暂用 `/api/generate`，同时保留 `finish_reason` 和 `eval_count`。repair 只接收
无效响应、脱敏字段错误和允许 source ID。未来升级 Ollama 后也必须先通过冲突 canary，
不能只按版本号恢复 chat。

证据文件：

- `schema-canary-generate-20260816.json`：通过；
- `schema-canary-chat-20260816.json`：失败。

## 2. embedding OOM 是现场资源事实

生产 9B 常驻时，GPU0 现场只余约 `2.5 GiB`。加载
`qwen3-embedding:0.6b` 触发 CUDA OOM，embedding runner 退出，随后 Ollama 重载 9B。
这不是模型不存在或 `/api/embed` 参数错误。

隔离 CPU-only Ollama 在 loopback `31436` 的一次资源探针显示：

- embedding runner RSS 约 `1.125 GiB`，Ollama server 约 `80 MiB`；
- 冷启动加两条文本约 `1.65 s`；
- 暖态一个问题加八段证据约 `1.0 s`；
- GPU 占用为 0。

该进程已关闭；服务器 `127.0.0.1:31436` 无监听。本机评测用
`31434 -> 21434` SSH 隧道也已关闭。生产 Ollama、GPU1、PCB 和其他服务未操作。

## 3. dense 不是当前质量根因的解答

四个隐式重点问题的 CPU dense 对照中，dense 选择均包含直接支持片段，但最终仅 1/4
回答通过。同预算 lexical-only 也已召回四个支持片段；dense 增加约 `1.0--1.23 s`，
没有形成增量召回证据。

其中“钱批多少”已正确召回五十万元所在段，本地 9B 仍返回不足。当前瓶颈主要是
reader 对口语问题与证据关系的理解，不只是 retrieval。因此不把 CPU embedding 直接
升级为 Q3，也不为短会议增加常驻 embedding 进程。

## 4. 云端模型只是能力上限，不是无损替换

`qwen3.7-flash` 在相同隐式 28 题的旧机械门从本地 `14/28` 提高到 `18/28`，恢复了
放量时间、报价期限、测试负责人/列表、旧方案停用和错误预算前提等多项本地失败。
但该运行同时出现：

- 两次 TLS `UNEXPECTED_EOF`；
- 一次结构 repair；
- “谁反对”问题从最终选择错误推断无人反对，旧机械门反而误放行；
- 仍有预算口语和完成状态过度拒答。

因此云端结果证明 reader 能力会改变边界，却没有证明隐私、可靠性、安全拒答或
Provider 语义等价。它不能成为默认生产替换。

## 当前选择边界

保留 Provider 可交换性，但 Provider 合同必须暴露而不能吞掉：

- schema canary 与 transport 能力；
- finish reason、token 使用、超时、取消和 retryability；
- model/provider/prompt revision；
- 本地、外部允许的数据级别；
- 外部网络失败不得被误写为“会议没有答案”；
- retry 只能复用同一不可变证据请求，不能产生第二历史 owner。

当前不采用云端默认、不常驻 CPU embedding、不在 GPU0 并驻第二 reader，也不继续
修改 prompt。下一门应在固定证据合同下比较更合适的本地 reader 与带明确隐私/可靠性
策略的可交换 Provider；若无法在 GPU0 资源内并驻，必须比较替换 resident 9B、CPU
低频 reader 或显式远端授权，而不是静默 fallback。
