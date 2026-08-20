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

## Android 文字附件竞态与恢复收敛

- device-primary 客户端不再向已退出目标架构的 account capability 查询文字附件能力。隔离
  `device/v1` 明确宣告 `summary_attachments_text=true`，手机按 device capability 完成选择、授权、
  source-stream 上传和结果读取；服务端静态合同禁止 guest/device 路径退回 account endpoint。
- 页面在打开附件选择层期间被杀死时，曾留下没有 task ID 的“正在提交整理任务”。候选只在不存在
  本地 preparation、sheet、pending intent、job ID 和运行中 generation 时清理这个孤儿阶段；已有结果
  继续显示，不新增状态行。真实恢复审计为
  `meeting_summary_orphaned_preparation_recovery={outcome:updated,had_current_summary:true}`。
- source-stream 首次提交和重启恢复现在都从本机 canonical transcript revision 重建来源，不再把页面
  临时 legacy transcript cache 作为 task 身份。重启后 transcript/attachment 来源变化统一抛出
  `MeetingSummaryInputChangedError`，而不是普通生成错误。
- 在 `emulator-5562` 为目标会议创建一条确定性文字附件后，远端 task
  `vnext-summary:e2d63c79-6986-54fc-b044-185d0c5d9190:972c828857022a3770ae44f757861431`
  已进入 `consuming`，App 随即被强制停止；独立 test APK 将该附件 `updated_at_ms` 精确增加 `1`。
  服务端随后独立成功，artifact 为 `49c2e2e6-2f0c-532a-8b88-164737f728e9`，来源 manifest SHA-256 为
  `ec2d797e8e123555aebe0ccbb404648ae6bd64daed0d8939e9734cf5c9ca1732`。
- 覆盖安装并启动 `1.1.37 (145)` 后，审计顺序为 `meeting_summary_v3_restore=facts_ready`、
  `meeting_summary_processing_stage=task_status`、
  `meeting_summary_run_terminal={outcome:input_changed,error_name:MeetingSummaryInputChangedError}`、
  `meeting_summary_pending_task_discard={status:cleared}` 和 `processing_stage=discarded`。旧来源 artifact
  未写入本机；上一份 current pointer 保持
  `...:summary:general:031925b92e7fedb20f1f1c05bd771395100a84818d65404f5ddcc77c72e17ef2`，
  页面继续显示可读概述且“重新整理”可操作，无错误或持续 loading。
- 数据库复核得到 `device_summary_task_intents=0`，被拒绝 artifact 的 output SHA 未出现在本机 Facts
  文档，`integrity_check=ok`。注入 revision 已先恢复，随后 marker、附件和 immutable text revision
  均按固定 ID、固定正文和 SHA-256 精确删除，最终计数全部为 `0`；test APK 已卸载。
- 最终模拟器为非调试 Release `1.1.38 (146)`，APK SHA-256
  `87fe10f90b131d86db4e452ca43d98c024934e8d76f2a45602bf94c74c36687a`，大小 `82,588,383`
  bytes；v2 签名验证通过。隔离 API `18023` readiness 仍为 ready；生产服务未改变。

## 回归与仍未关闭的门

### 原生来源变化矩阵补齐

- `tools/vnext/android/VnextSummaryFenceDbMutationTest.java` 增加了可精确恢复的 binding epoch、附件删除、
  附件移位和附件正文哈希变化注入。每个注入都要求显式 meeting UUID、固定派生夹具 ID 和严格前置状态；
  恢复只接受该测试制造的唯一后继状态。直接打开应用 SQLite 时显式启用 foreign keys，附件删除真实触发
  immutable text revision 级联，而不是留下不可达 revision。
- 在 `emulator-5562` 上逐项执行了四次完整竞态：手机先把含明确授权附件的 source stream 提交到远端，
  等待 generic Task 获得真实 attempt 后停止 App，再注入来源变化；四个远端 Task 均独立进入 `success`：
  `b4572da1.../2688c9aa...`（移位）、`739f716a.../7f672f1a...`（正文）、
  `9abbafc8.../e2f3eba1...`（删除）、`15472d51.../4cc09d3e...`（binding epoch）。斜线后为
  artifact ID 前缀，仅用于隔离候选证据定位。
- 每次重新启动 Release 后均出现
  `meeting_summary_run_terminal={outcome:input_changed,error_name:MeetingSummaryInputChangedError}`，随后
  `pending_task_discard=cleared` 和 `processing_stage=discarded`；没有 `shadow_write=activated`，页面保持
  上一份“概述/主要议题”，按钮恢复为“重新整理”，未显示失败或永久 loading。
- 最终原生审计为 `facts=15, intents=0, integrity=ok, foreign_keys=0`；binding epoch 已恢复为当前 authority
  epoch，附件位置、正文和 immutable revision 全部恢复后再按固定身份删除。测试 APK SHA-256 为
  `64f41bd9d7f1a1c65137a43a0bf189a85dc167b3b9036a74779ceba9eb5a7311`，大小 `367879` bytes，验收后已
  卸载；模拟器恢复非调试 Release `1.1.38 (146)`，7 条会议仓储投影重新达到 consistent。
- 一次在 attempt 创建前过早停止 App 的非正式试跑留下 active source stream；它未作为通过证据，最终使用
  正式 `cancel_source_stream` 领域入口原子取消 Task、释放 checkpoint 并将 stream 标记为 cancelled，未直接
  改表掩盖残留。

- TypeScript、Stage 3 source-stream 合同、`git diff --check` 通过；Facts V3、chapter merge、source stream、
  worker、Q2、provider、持久任务和 readiness 聚焦回归为 `131 passed`。
- 本次恢复边界变更另执行 summary/schema/chapter/worker/persistent/version 聚焦回归 `84 passed`，错误身份与
  activation fence 领域测试合计 `28 passed`；source-stream 与 Q2 Android 静态合同均通过。
- 当前矩阵已直接执行领域比较器，并完成 Android 正向激活，以及 binding revision、binding epoch、授权
  附件 revision、附件删除、附件移位和附件正文变化六种“远端成功、进程退出、本机来源变化、进程恢复”
  的真实 SQLite 负向竞态。Summary V3 的选定来源身份组合不再只有纯领域覆盖。
- 还缺 Q2 剩余原生来源恢复矩阵、独立人工事实/行动/Q2 质量 `>=95%`、旧结果全量迁移、公开零 v1
  流量周期和 capability barrier。全局混合负载已经单独通过，但这些采用门仍开放，因此 Stage 3 和
  全局候选均未采用。
