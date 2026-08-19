# Stage 3 Android 来源流纵向证据（隔离候选）

## 结论

`emulator-5562` 已完成一次从设备来源流、Facts V3 生成、本地持久化、四模板投影到
引用跳转的纵向回放，并验证应用重启后继续读取同一份事实文档。此结果只补齐 Stage 3
的 Android 候选实现证据，状态仍是 `isolated candidate evidence; not adopted`：没有激活
capability barrier，没有切断 Summary V2/Q0，也没有触碰生产 `18020/8030`、GPU1、PCB、
Smart Meeting、真机或公网流量。

## 候选边界

- Android 候选：`1.1.26 (134)`，最终非调试 APK SHA-256 为
  `57e0dbd997fe1a9b8c20c39cecfbe7018f3bc0836f1d428418c3e0aff77d4fc0`。
- 设备：只使用专用 `emulator-5562`，通过 `tcp:28121 -> tcp:28023` 访问隔离 API。
- 服务端：隔离 API `127.0.0.1:18023`、隔离 ASR `127.0.0.1:8031`、数据库副本
  `/home/zhong/laoji-vnext-candidate/vnext-all-07bdd4a-data/api.db`。
- 设备 binding：`c495c158-7761-4bc2-890d-7c0a363a9756`；canonical meeting：
  `c94d724d-c4f4-4235-ada8-ee7a2f7de16e`。
- 真实纵向回放得到 4 个成功 Summary generation；后三个 generation 前缀分别为
  `e68766a27195c6b1e855cf70f9a93d0b`、`70528953cda5fcb4930d4ff30ec8abde`、
  `2826fc8d72bd27e28f4d8315fc8cbc36`。强制重新生成创建新 generation，普通重放恢复
  已有 generation，不改变不可变结果。

## 已闭合的真实缺陷

1. 候选服务曾从旧 release 启动，缺失最新 source-stream handler；隔离部署已改为实际候选
   release，并通过 API 重启恢复同一持久任务。
2. 客户端丢失本地 pending 指针后会为同一任务随机创建 source stream，触发服务端幂等
   冲突。stream ID 现由 task ID 确定性派生；已有 active/success task 优先恢复，终态失败
   才创建明确的新 generation。
3. 服务端生成的 Facts 文档 ID 曾把长 task ID 和来源哈希直接拼接，超过 Android 合同长度。
   新文档 ID 为 `vnext:` 加 64 位确定性 SHA-256；客户端仍能只读解析早期候选文档。
4. `summary_fact_documents` 曾以来源、模型和 prompt 组合做唯一约束，错误地合并用户强制
   重新生成。v48 重建表后仅文档主键和非空 summary-version 关联唯一，同源的不同
   generation 可并存。
5. Facts 文档与 summary version 关联失败曾被静默忽略。现在缺失目标版本、缺失文档或
   文档已关联其他版本都会失败关闭，并记录不含正文的持久化阶段诊断。
6. 详情页的本地 Facts 恢复 callback 曾依赖持续变化的 transcript 数组，导致 loader 被反复
   重建；页面 generation 又会把已经读出的合法 SQLite 结果当成过期响应丢弃。投影现读取
   稳定 `transcriptRef`，本地权威恢复仅按 meeting/scope 隔离，远程响应仍保留严格 request
   token。这消除了结果已落库但界面间歇退回旧整理的竞态。
7. 服务端相邻字幕打包后，引用的内部来源 ID 不一定对应 Android 原始行。唯一移动端片段
   保留原 source ID；投影时再以片段 ID、时间起点或包含区间锚定到当前文字记录，无法
   锚定的引用不显示。
8. worker 租约从 300 秒收紧到 30 秒、每 10 秒心跳；任务扫描只选择下一章已完整提交的
   active stream，避免重启后长时间等待，也避免空转领取未具备输入的任务。

## 数据和界面证据

- 模拟器数据库升级为 schema v48；副本 `PRAGMA quick_check=ok`，foreign key check 无结果。
- 当前 summary version 只关联一份 Facts V3 文档；最新文档使用紧凑 ID，来源指纹、模型和
  prompt revision 与远程 artifact 一致。
- 当前本地投影为 3 个 section、10 个可解析引用、0 个被拒引用、0 个行动候选。这里的
  `0` 行动只描述该样本结果，不表示行动质量门已经通过。
- 强制停止并重新打开应用后，诊断结果为 `meeting_summary_v3_restore=facts_ready`，仍恢复
  同一 Facts 文档和已保存的“访谈”模板，不发起新生成。
- 依次切换“通用、1:1、项目同步、访谈”时均记录 `mode=local_projection`，没有 device-v2
  HTTP、source-stream 或整理任务请求；四种视图共享同一 facts/relations/actions/citations。
- 点击整理引用后切换到“文字记录”，并定位到当前会议的 `00:00` 原始片段。没有使用
  整理结果或其他会议作为引用来源。

## 尚未满足的 Stage 3 退出门

- 本轮证明模板切换不联网，但没有加入单独的高精度计时点，因此不能声称暖态低于 100ms。
- 仍缺更新后全部会议样本和 24 组基线的独立人工盲审，不能声称 Facts 支持率、行动质量或
  Q2 回答/引用相关性达到 95%。
- Q2 仍缺 Android 当前会议来源的提交、恢复、重启和人工相关性纵向证据。
- 旧结果后台迁移、一个完整公开零 v1 流量周期、capability barrier 与旧 reader 停写仍未
  完成。
- Stage 2 的纯 CPU ASR 首段和 RTF 性能门未通过，资源边界仍阻止全局候选采用。

