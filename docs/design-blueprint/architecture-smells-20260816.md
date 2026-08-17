# 架构异味地图初版

## 已观察异味

### 1. 解析职责分裂

移动端 `localScheduleParser` 同时承担传统字形归一化、日期时间识别、意图分类、拒绝和服务路由；服务端还有独立解析路径。规则一多，客户端与服务端就可能对同一句话产生不同结论。

### 2. 会议状态概念过多

`capture/upload/transcript/summary/speaker` 已有阶段模型，但 `realtime_draft/final/finalizing/reprocessed`、mirror、store、presentation 和兼容 API 同时参与状态表达。阶段模型存在不等于所有页面只使用一个权威状态。

### 3. Provider 和接口兼容层长期存活

源码同时出现 device v1、v2、legacy、多个会议 mode 和旧服务类型。兼容层可能已从边界适配器变成业务决策来源。

### 4. 语音链路可能以串行思维组织

实时录音、本机保存、WSS、ASR、VAD、讲话人和最终版本在不同模块交错处理；需要验证不可变音频段是否足以支撑真正的并行 DAG，而不是继续加一个线程或队列。

### 5. 整理 v3 仍是“新链路叠在旧链路上”

v3 已解决结构化事实和引用问题，但 v2 兼容、后台迁移、旧模板和旧任务仍然存在。长会议证据预算失败说明目标是证据编排问题，不只是把上下文窗口调大。

### 6. 文档、源码和发布事实漂移

源码配置为 `1.1.10/118`，工作区文档仍记录旧版本；dirty worktree 又包含大量删除和未跟踪内容。没有独立的发布快照就不能可靠判断哪条链路是真实版本。

### 7. Durable outbox 可能没有生产消费者

静态调用图显示 action、summary、occurrence、manual note、speaker correction、attachment、marker 和 tag catalog 的同步触发器都维护 listener 集合，但 `subscribeMeeting*Sync` 只出现在各自定义文件；对应 `claim/complete/fail*Sync` 也只看到 repository 定义和实现。当前只有 meeting root 有明确 drain 调用。

这不证明运行时绝对没有动态注册，但已经足以否定“outbox 存在就等于同步闭环存在”。后续必须用 bundle 调用图和运行日志确认；若属实，应删除悬空触发器或接入统一任务消费者，不能继续把永久待同步解释为偶发刷新问题。

### 8. 阶段状态只校验值域，没有合法边

`transitionProcessingStage` 校验同 stage、状态值域、进度和时间单调，但没有声明每个 stage 的合法状态边，也没有跨 stage 因果。大量 mirror、reconcile 和 repair 代码因此可以把阶段跳到任何同域状态，再由其他层补偿。目标任务内核必须让非法跃迁在写入前失败。

### 9. v3 整理结果丢失转写 revision 血缘

`generateDeviceMeetingSummaryV3` 向服务端提交 `transcript_revision`，返回模型也保留该字段；但 `projectMeetingFactsV3` 构造本地 `MeetingSummaryDocument` 时把 `transcriptRevisionId` 设为 `null`。随后 canonical mirror 读取保存时的 active transcript，因为 declared revision 为空而跳过一致性检查，并把结果绑定到当时 active revision。

若生成期间发生重新转写或 active revision 切换，整理正文可能被挂到错误版本；当前逻辑只剔除无法解析的 citation，仍可保存其余正文和行动候选。目标合同必须冻结 `EvidenceBundleId + revision + hash`，提交时 compare-and-set；任一来源不再匹配时整份结果隔离，不接受“删除坏引用后保存正文”。

### 10. UI 投影没有统一 revision envelope

Minutes detail 为 notes、transcript、summary、speakers、info 分别维护 generation，再由 native 手工逐字段合并。状态归属甚至通过 `processingStatusLabel` 是否包含中文词语判断。SharedPreferences 中的 meeting view state 不含 data epoch 或 entity revision，且静态调用图没有发现 `clear(meetingId)` 的使用。

Calendar Search 由 JS `searchVisible` 和 native overlay registry 共同拥有；native 在 host 未 resumed 时发送 dismiss，但页面只订阅 action 事件。导航恢复允许 SharedAction/SharedMeetingContent token，并把状态写入普通 AsyncStorage，最长 7 天。

这些不是四个独立补丁，而是缺少跨 JS/native 的 `(dataEpoch, entityRevision, viewEpoch, surfaceInstanceId)` 投影合同。

## 重做触发器

出现以下任一情况，禁止继续增加局部 fallback，必须更新蓝图并比较替代架构：

- 同一输入在本机、服务端和模型层需要不同规则才能通过；
- 页面状态需要从两个以上 store 拼接；
- 一项处理必须等待另一项结果才能显示已可用内容；
- 新代码无法明确指出将替代哪一套旧逻辑；
- 迁移只能依靠用户手动修复；
- 性能改善来自牺牲来源、隐私或可恢复性。

## 当前不应做的事

- 不因 v3 已存在就把它当作最终会议智能架构；
- 不直接把 GraphRAG、递归摘要或新模型加载到生产 GPU；
- 不把约束解码当成日期和意图语义校验；
- 不以增加更多服务、更多 fallback 或更多状态字段解决架构重复。
