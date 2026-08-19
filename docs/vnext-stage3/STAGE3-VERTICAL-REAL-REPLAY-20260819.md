# Stage 3 真实纵向回放证据（隔离候选）

## 结论

Stage 3 的设备绑定、加密来源流、持久 Summary Task、Facts V3、Q2、幂等重放和
purge 已在隔离候选 `127.0.0.1:18023` 上形成可运行纵向切片。此证据仍是
`isolated candidate evidence; not adopted`，不能据此激活 capability barrier，也不表示
Stage 3 已通过人工质量退出门。

候选使用本地 `qwen3.5:9b` 和 `qwen3-embedding:0.6b`，事实提示词版本为
`facts-v3-r9`，章节 handler 为 `summary-facts-v3-chapter-r2`。生产 `18020/8030`、
GPU1、PCB、Smart Meeting 和其他用户服务未修改。

## 真实结果

| 样本 | 输入 | Facts V3 | Q2 | 清理 |
|---|---:|---:|---:|---:|
| `1300572695-1-192.srt` | 12.0 分钟，240 项，2 章 | 等待 21.803s；16 facts；16/16 引用逐字匹配 | 3.180s；2/2 引用匹配；183ms 幂等重放且结果一致 | confirmed |
| `1377173065-1-160.srt` | 57.0 分钟，1357 项，6 章 | 等待 25.054s；40 facts；48/48 引用逐字匹配；处理至第 5 章 | 24.687s；2/2 引用匹配；158ms 幂等重放且结果一致 | confirmed |

“Facts V3 等待”从全部来源章节提交后开始计时；章节生成已和受限预取上传流水并行，
不能把该值解释为整场整理的总墙钟时间。端到端总墙钟分别为 28.106s 和 119.263s。
长样本累计 evidence budget 为 61440 tokens，表示 6 个独立的 10240-token 章节预算，
不是单次模型上下文。

机器可读报告：

- `docs/vnext-stage3/stage3-vertical-1300572695-20260819.json`
- `docs/vnext-stage3/stage3-vertical-1377173065-20260819.json`

报告只保存哈希、计数、版本、覆盖率和耗时，不保存转写、概述、问题、答案、凭据或
不透明任务 ID。人工观察确认：短样本 Q2 回答使用李亚普诺夫优化；长样本 Q2 回答比赛
结束前完成备忘录且由 A 方记录，两者均由当前会议原始转写引用支持。

## 回放发现并修复的真实缺陷

1. `vnext_source_bundle_items.item_id` 曾是跨 stream 全局主键；同一稳定转写项复用于
   Summary/Q2 会触发 500。内部存储键现按 bundle 隔离，外部稳定 item ID 保持不变。
2. 章节 worker 曾把每条 SRT/ASR 碎片当成独立证据，导致跨碎片逐字引用全部被拒绝。
   Summary 和 source-stream 现共用同一确定性相邻字幕打包器。
3. `SummaryV3GenerationError` 曾被压成无信息错误并按温度 0 自动重试三轮。现在保留
   脱敏协议错误码；一次生成及一次可选结构修复完成后，协议失败立即终止。
4. Ollama JSON Schema grammar 不执行 `maxLength/maxItems`，模型会在 overview 或 quote
   上耗尽 4096-token 输出。Provider 现在只选择事实和来源别名；overview 从已验证事实
   投影，逐字 quote/哈希由服务器从不可变来源回填，事实/关系/行动在服务端再次限幅。
5. 章节合并器曾在 160 字边界直接截断下一条事实。现在只追加完整事实；单条事实确实
   超长时使用显式省略号，不再显示半个词或半句话。
6. Q2 首次响应包含 task/source stream ID，持久结果没有，导致重放不相等。现在首次和
   重放返回同一规范结果对象。
7. 来源组容量曾把已完成、等待 Q2 的章节算作并发上传，使长会议最多上传两章。现在
   group 数量只限制 open 上传；完整来源仍受设备/全局加密字节、TTL 和 manifest 限制。
8. Q2 曾直接处理 1357 个断句碎片、忽略原始 UTF-8 基准范围，并把不同位置的相同文字
   误判为重复。现在 embedding 只处理相邻打包检索单元，模型和引用仍使用原始行；稳定
   身份包含 revision、范围和内容哈希，最终引用范围恢复到整份文字记录坐标。
9. Q2 检索预算曾用重编号别名估算，恢复原始 `sN` 别名后可能越过 10240 tokens。选择
   阶段现按最终 wire payload 精确估算，仍保持超预算 fail-closed。

## 已有聚焦证据

- Summary/Facts/source stream/Q2/worker 聚焦回归：91 passed。
- device-v2 API 路由与 Q2 幂等响应：7 passed。
- source checkpoint 集成测试证明任意章节数只保留两个滚动 slot；真实长回放的最终
  artifact 为 `through_chapter_ordinal=5`，purge 后任务、来源流和加密 payload 均清除。
- 隔离数据库复核：来源流、bundle、item、任务和临时加密 payload 均为 0；113 条容量
  reservation 全部处于 `released`，活动预留字节为 0。reservation 是无正文的容量审计账本。
- 生产提示词污染测试继续通过；prompt 中没有样本标题、人物、专有内容或 few-shot。

## 尚未通过的 Stage 3 退出门

- 只有两个真实会议完成纵向回放，尚未对更新后的全部视频/SRT 和 24 组整理/行动基线
  进行同输入人工盲审，不能声称事实支持率或 Q2 相关性超过 95%。
- 精确引用只证明可追溯，不证明 ASR 本身正确。短样本概述仍能看到转写噪声；长样本
  已达到 40 facts 上限，需人工确认是否存在过度抽取。
- 两条样本各产生一个 action candidate，尚未完成“已完成、否定、纯提问、宏观目标不
  得成为可日程候选”的人工行动质量门。
- Android `emulator-5562` 的 Facts V3 本地表、四模板本地投影、引用跳转和重启恢复已完成
  候选纵向回放，详见 `ANDROID-SOURCE-STREAM-VERTICAL-20260820.md`；旧结果后台迁移、
  Q2 Android 纵向和人工质量门仍未完成。
- capability barrier 仍未登记；旧 Summary V2/Q0 reader 仍必须保留。
