# Stage 3 Facts V3 本机激活围栏矩阵（隔离候选）

## 结论

Facts V3 的迟到结果现在同时受两层来源身份约束：客户端取得远端完成产物时先核对 source stream
对应的当前 device epoch 和 meeting binding；进入本机 SQLite 原子事务后，再核对同一 epoch、binding
identity/revision/cancel revision，以及本次明确授权的文字附件位置、revision 和规范正文 SHA-256。
任一项变化均抛出 `SummaryV3ActivationFenceError`，页面沿用现有输入变化路径，保留上一份可用结果。

本证据状态为 `isolated candidate evidence; not adopted`。未激活 capability barrier，未改动生产
`18020/8030`、GPU1、PCB、Smart Meeting、真机或公网流量。

## 实现边界

- `MeetingSummaryActivationFenceV3` 只携带 epoch/binding 标识、revision 和附件哈希，不携带会议正文。
- source-stream success 和幂等恢复 success 共用 `completedSummaryActivationFence`，旧成功任务缺少完整
  source stream 时失败关闭，不把无来源结果激活为当前版本。
- `saveSummaryVersion` 在同一 SQLite 事务中读取 authority、binding 和已授权附件，然后调用纯领域比较器；
  检查通过后才写事实文档、版本、引用、行动候选和 current pointer。
- 未被本 generation 授权的新附件不会使旧任务失效；被授权附件删除、移位、改 revision、改正文或变为
  非文字附件均会拒绝激活。重复或格式异常的围栏同样失败关闭。
- `SummaryV3ActivationFenceError` 在整理页转换成 `MeetingSummaryInputChangedError`，不会把安全丢弃误报为
  服务不可用，也不会覆盖上一份可读结果。

## 可执行恢复矩阵

`node --experimental-strip-types --test tools/vnext/test_summary_activation_fence.mjs` 共 `23 passed`：

- 正向：epoch、binding 和授权附件完全一致；新增未授权附件不影响当前 generation。
- authority/binding：当前 epoch、binding epoch、binding ID、generation、revision、state、cancel revision
  任一变化或 binding 消失均拒绝。
- 附件：删除、类型变化、位置变化、revision 变化、正文哈希变化和重复授权均拒绝。
- 非法输入：空 epoch、非法 generation、非安全 revision、负 cancel revision、空附件 ID、负位置和非法
  SHA-256 均拒绝。

静态 Stage 3 合同进一步锁定：比较器由 canonical SQLite 写事务调用，且 epoch、binding、附件均从事务
中的当前表读取，不允许退回页面缓存判断。

## Android 正向纵向回放

- 候选 APK：`1.1.29 (137)`；SHA-256
  `34a993fbe72348da6a279d15775717c66d0c5eac601d982b16abb29f15ac668f`，仅安装到专用
  `emulator-5562`。
- 真实长会议 `vNext 验收夹具·股权会议（SRT参考）` 从 source-stream 创建、任务轮询、artifact 读取、
  完成流核对到本机原子激活全链成功；远端 task
  `vnext-summary:e2d63c79-6986-54fc-b044-185d0c5d9190:ec9f2c11f765623810c5d65a03532dc3`
  状态为 `success`。
- Android 审计记录 `meeting_summary_shadow_write={status:activated, sections:3, citations:14,
  rejected_citations:0, actions:0}`；界面恢复为可操作的“重新整理”，概述和主要议题仍可读，进程未崩溃。

## Android 原生竞态负向回放

- 使用独立 debug test APK 和受版本控制的
  `tools/vnext/android/VnextSummaryFenceDbMutationTest.java`，在专用 `emulator-5562` 的真实应用 SQLite
  中把目标会议 active binding revision 从 `1` 原子增加为 `2`。夹具要求显式 UUID，先保存原 revision，
  恢复时只接受精确的 `original + 1`，不携带任何样本正文。
- 远端 task
  `vnext-summary:e2d63c79-6986-54fc-b044-185d0c5d9190:eb2d9e31ab7063116c38aa6df2cdf5b8`
  已在 revision 变化前成功生成 artifact；App 进程在变化后恢复轮询，审计得到
  `meeting_summary_run_terminal={outcome:input_changed,error_name:SummaryV3ActivationFenceError}` 和
  `meeting_summary_processing_stage={signal:discarded,outcome:updated}`。
- 页面没有显示“整理失败”，上一份概述、主要议题和引用仍可读；当前 pointer 仍为
  `...:summary:general:ed9fd183...`，Facts 文档保持 `12` 份，最新仍是
  `ollama:qwen3.5:9b / facts-v3-r15 / generated_at_ms=1787203379092`，迟到 artifact 未生成本机版本。
- 首轮回放发现跨 source-stream 恢复的 binding 变化原先使用普通 `Error`，并且待恢复 intent 会残留。
  候选现统一发出稳定 `SummaryV3ActivationFenceError`，跨 Metro/Promise/native 边界按稳定错误名或固定内部
  sentinel 识别，输入变化时直接清理 SQLite intent。修复后 `device_summary_task_intents=0`，summary stage
  回到 `ready`、`job_id/error_code=NULL`、`retryable=0`。
- 故障注入结束后原 revision 已恢复为 `1`，数据库 `quick_check=ok`、`foreign_key_check=0`；未在模拟器
  留下人为 binding 变化或恢复任务。debug App SHA-256 为
  `1febc2a6a9eb74033288a4c2c1aeb8da9ca65dc13701329a3028a0e342afbeed`，只用于隔离诊断。
- 诊断结束后已覆盖恢复非调试候选 `1.1.30 (138)`，APK SHA-256 为
  `5ac16e200c0e339cd15da1f8e77d8b854e12a07cced57a00cf7f6c6903c60459`，大小 `82,585,371`
  bytes。`run-as` 被系统拒绝，启动后恢复 7 条会议、Facts V3 和五项候选 capability，无崩溃；测试 APK、
  Metro 与调试 reverse 已移除，仅保留 `28121 -> 28023` 的隔离 API 映射。

## 回归与仍未关闭的门

- TypeScript、Stage 3 source-stream 合同、`git diff --check` 通过；Facts V3、chapter merge、source stream、
  worker、Q2、provider、持久任务和 readiness 聚焦回归为 `131 passed`。
- 本次恢复边界变更另执行 summary/schema/chapter/worker/persistent/version 聚焦回归 `84 passed`，错误身份与
  activation fence 领域测试合计 `28 passed`；source-stream 与 Q2 Android 静态合同均通过。
- 当前矩阵已直接执行领域比较器，并完成 Android 正向激活与“远端成功、进程退出、binding revision
  变化、进程恢复”的真实 SQLite 负向竞态。其余 attachment/epoch 组合仍由 23 项纯领域矩阵覆盖；尚未
  对每个组合分别构建 Android test APK 重放。
- 还缺独立人工事实/行动/Q2 质量 `>=95%`、长会议延迟分布、旧结果全量迁移、公开零 v1 流量周期和
  capability barrier。Stage 2 纯 CPU ASR 首段与 RTF 性能门也仍未通过，因此 Stage 3 和全局候选均未采用。
