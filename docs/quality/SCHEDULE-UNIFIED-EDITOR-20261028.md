# 日程统一编辑重构：基线、交接与监督证据

## 仓库交接更新（2026-10-29）

用户随后已明确授权整理并公开推送仓库，替代本记录早期“等待推送确认”的历史边界。仅保留`master`稳定315/硬件联调与`develop`当前未完成开发两条分支；工作目录不移动，候选334/P3未通过状态不因提交而改变。侧聊在主线让出的写入窗口串行执行，具体来源、安全与验证边界见[仓库交付](REPOSITORY-HANDOFF-20261029.md)。恢复实施前须先确认整理已完成、当前分支为develop；不得据旧段落重新推送到已退役分支。

## 当前范围

实施合同：[统一编辑方案](../design-blueprint/SCHEDULE-UNIFIED-EDITOR-PLAN.md)。主线`老记开发III`，thread `01a00b55-b0d9-7c30-8f49-8ccc020c3e96`。监督侧聊`01a17db7-8841-7e63-bcb2-2beb071a2ab5`。本记录不是旧A–F续跑，也不改写其已完成结论。

## P0：已核实基线

- 当前正式1.3.2/315，本地清单、APK和CURRENT一致；主线最新最终回复确认已安装/发布315，明确跳过真实讲话，麦克风已停止。
- 主线当前idle，没有正在执行的开发回合。旧`automation`、`automation-2`均PAUSED；没有擅自恢复旧范围。
- 真实工作树HEAD及公网`vnext/implementation`均为`89ef1fd3ca5d238a6f4948a2d02309e5247ce3df`（8月31日）。核查时234个tracked修改、10个tracked删除、203个untracked顶层状态项，展开后的非忽略untracked共1539个文件，包含1240个output证据文件；不能把这些一股脑提交。
- 工作区剩余约30GiB、tmp约12GiB；不因备份再复制node_modules/output/生成Android工程。

## 一次性备份：已完成且校验

目录：`/home/yydd/LaoJi-backups/pre-schedule-unification-1.3.2-315-20261028/`。

| 对象 | 结果 |
| --- | --- |
| 当前工作源码 | 1033文件、33,213,948原始字节，包含未提交/未跟踪源码；10条已删除路径保存在清单，不恢复旧删除 |
| 压缩归档 | 19,665,080字节，SHA `29527a12990217ad0334c4895658e48b69f28a0d769c96b204790cb3ead4288b` |
| 逐文件manifest | SHA `e5b601d7bfe6d0cd4843405ae99680f38fc0613c32dd68642c67d2e8b5ae7e26` |
| 正式APK副本 | 46,007,111字节，SHA `86b0b680f4f601299aefcb82edcc458d92770bbff9ee34b3296954fc23289a89` |
| 公共manifest副本 | SHA `522c4b584c6596038ef509e33adec639dec7c7194857704bb9c807657a4dabf0` |
| 核验 | 重新读取归档所有成员校验，重新读取工作树文件校验，Git状态/HEAD在快照期间未变 |

没有读取或备份手机私有数据库、录音、签名密钥或服务器secret；源码归档不等于数据备份。迁移前本机SQLite backup仍为主线P1必要工作。备份目录0700、文件0600，不上传公网。生成器和`snapshot.json`保留在同目录；没有改Git index/HEAD或推送。

## Git协调

已向用户单独确认：是否将敏感信息审查后的当前源码和方案提交并推送到现有`vnext/implementation`，不合并main、不上传产物/录音/数据库/凭据。当前等待明确答复；允许实施方案与本地备份不等于无限自动push授权。

Git操作交主线串行处理，侧聊不竞争index。已经将原来只忽略部分硬件output的规则收敛为整个`/output/`不进入Git，未删除文件；实读该目录原本没有tracked文件。review过的结论继续存docs，不把截图、设备日志或通知内容当源码公开。此为本轮唯一既有仓库配置调整，没有产品代码修改。

## 交接与实际开发状态

侧聊已完成基线、备份和可实施方案，没有修改产品代码、服务、设备或固件。统一编辑版尚未构建或发布；后续产品改动由主线串行实施，不将交接完成计作功能完成。

2026-10-28已通过应用消息交接至`老记开发III`。随后读取主线实际回合，状态为active/inProgress；主线已确认读完整份方案，并开始P1时间精度和可恢复草稿，明确先让“晚上”成为真实时段、保留09:23准确分钟，再接统一编辑页。此为已接手和开始实施的证据，尚非候选通过或交付证据。

监督任务`automation-3`（“监督老记日程统一重构”）已创建并核对保存状态为ACTIVE，每30分钟在本侧聊运行；旧`automation`和`automation-2`仍PAUSED。监督读取主线进展与源码/产物证据，发现偏离时给具体纠偏，不并行编辑产品代码、操作设备、修改Git index或部署。任务范围仅本计划P0–P5，完成并复核后暂停，不扩为无限追加功能；电脑及应用需保持运行，未执行的间隔不视为持续监控。

每轮只追加实际变化、失败边界和下一步，不复制全部计划。当前Git提交/推送确认仍待用户答复；若确认，由主线做敏感信息审查并串行提交到既有分支。

## 主线第一批：P1候选及P2手动切片，进行中

主线完整读取方案/CURRENT/本记录，复核归档SHA一致；监督侧聊turns接口拒绝ephemeral回读，没有声称已独立读到全部侧聊原文。当前按已交接、已写入CURRENT的有限授权实施。只连接5562，不要求用户讲话，不动生产、固件或Git；公网/真机仍315。

### 已改真实owner

- 三精度/六时段互斥合同和CalEvent持久字段已建立；仅缺失精度的历史记录从rawText读模糊时段，显式编辑后的未设置/09:23不再被旧原文覆写。原生/RN详情、搜索、月历、系统近期日程和待办草稿已接入或调整；时段不作为全天忙闲占用，不虚构会议起止钟点。历史isAllDay未批量覆写，RN编辑器/时间页仍待整体切换。
- 日程库schema4候选由原初始化/写队列迁移：先用Expo SQLite backup API到唯一私有pre-editor-v4文件，检查完整性、逐ID/event_json一致，再在事务中建draft/迁移元数据并升版本。失败回滚、不清库；显式清本机日程库也清这个隐私副本。稳定schema4不反复全库检查。手机尚未执行迁移，源码备份不冒称设备数据备份。
- 单一ScheduleEditorDraft及持久CAS已实现，结构revision不被音量/phase/转写更新推进；迟到结果不能覆盖手改，撤销保留后续手动值，进程恢复不伪装模型继续运行。保存状态先查稳定请求回执，原子提交未成立则恢复可编辑，不永久锁在saving。
- Android AddEvent已使用此draft，native字段只是投影；正常返回保留有内容草稿，空白/未改不堆积。EventsStore原队列/事件事务同时完成事件、draft saved和hardware输入回执；固定requestId及已接受回执不被后续列表/通知读取否定。未增加第二事件writer。
- 原生时间页已替换三开关/五分钟取整：三精度、六时段、0–59分钟，未启用结束时摘要/结束控件均GONE。日期独立编辑，取消不提交；错误起止不自动补小时/次日，真实跨日日期保留。初始编辑页不自动弹键盘，沿用token/window owner，无新增主题/路由。

### 证据边界

`output/schedule-editor-20261028/p2-contracts.txt`的28项当前回放通过，其中Node SQLite真实WAL、备份/DDL失败回滚、逐原记录JSON、CAS/恢复、事件/草稿/input-job原子提交和重复回执实际执行；这不是语言语义质量。TypeScript及原连续性入口50项通过。原生compileReleaseKotlin和6项CalendarEditTimeContractTest实际JVM通过（60个分钟、六时段、错误结束/跨日、历史flag、缺日期不暗补）；不等于Android页面验收。

1.3.3/316已聚合构建为唯一x86_64 release候选并覆盖5562，compact生产配置/签名合同通过；正在真实UI回放，尚未正式采用/公开发布。没有arm64新包或真机覆盖。ADB root/run-as均被当前镜像/非debug release拒绝，不改镜像、不加生产取数后门；私有快照独立导出仍无证据，需以实际Expo迁移启动和保留数据流程核对，不能引用Node回放冒充设备备份已独立审阅。

### 首个未闭合边界

1. P2：316真实手动→时段/09:23→保存/重开、草稿恢复，修正实际失败，再接紧凑采集dock；当前没有dock或全部入口统一。
2. P3：结构化graph/edit、能力协商及隔离真实模型/ASR尚未实施；旧clarify仍有315真实caller，未动服务。
3. P4：加号/日期格/编辑/硬件/待办/RN统一、VoiceInputModal/wizard/radial专属清理、两项skill随采用改写均未完成。
4. P5：60会话/24音频/12旅程、四主题字号/速度、arm64/公开完整产物及侧聊复核仍未完成。安全门不放宽，不恢复旧A–F或其他目标。

## 续接：手动真实旅程与P3隔离失败，未采用

### 316实际手动旅程

- 在5562新建本轮唯一测试日程“周末整理书柜”，选择晚上，保存后详情显示“晚上”，没有全天或虚构时点。随后同一事件改成09:23、无结束时分，保存、强停重开均保留09:23。
- 再编辑备注“把旧书单独放好”，等待有界草稿落盘后强停重开，仍在同一编辑器、保留09:23和未保存备注；点击保存后详情显示该备注。没有新建第二条日程。
- 已仅删除此测试日程；`candidate316-cleanup.json`可见原“医院复查”“读书讨论会”仍各一条。没有操作原会议或真机数据。真机本轮未连；真实讲话按用户明确选择跳过。
- `candidate316-manual.mp4`为有效133.215秒录像，已抽成`candidate316-manual-contact.png`并实看；静态层级/空白时间页成立，不把抽帧接触表说成所有中间帧无闪。316主表单仍有偏大的备注/分组空隙，尚不算紧凑dock改造完成。
- 负例：快速同时拨小时和分钟时，小时结束回写会取消分钟的在途选择。`candidate316-wheel-0923.json`实际是09:22，不能按文件名当成09:23证据；正确最终值见`candidate316-wheel-0923-final.json`、保存及重开记录。
- 源码已改为只同步idle同伴滚轮，月份天数未变时不反复configure；`p3-wheel-android.txt`是5562实际Android instrumentation，唯一目标`neighboringTimeWheelsDoNotCancelEachOthersPendingSelection`通过，确认为09:01。它运行的是模块测试APK，不是说已安装主App316包含新修正。
- 同批补齐保存重放保护：已有编辑回执不改写之后独立保存的用户新值；空星期选择向事件省略而非传无效`[]`。这些源改及新补改协议未包含在316 APK。

### P3协议与真实调用

- 新增有界`ScheduleEditRequest`、八组类型化变更、固定revision/sequence回显；设备v2同一鉴权族增加`/schedule/graph/edit`。没有服务器日程副本、任意JSON路径或跨事件执行；服务不读取旧rawText。
- 客户端提交当前字段与本次表达，检查同草稿/operation、逐字UTF-16依据及完整协议，最后仍由canonical draft的整份revision CAS原子应用。未具备edit/time能力时不提交，不回旧clarify。现有315仍需的旧接口未删。
- 后端只经现有Provider一次生成；错误不逐字段修补、不自动二次请求。固定当前值的no-op不重复应用。模型/数据/本地及云端可交换边界保持。
- 最终`p3-backend-isolated.txt`：27 passed（新合同与原graph合同），使用服务器既有Python3.12依赖和独立候选源码目录`/home/tanyk/laoji-candidates/schedule-editor-20261028`，测试库仅位于该目录`test-deps`，未安装到生产环境。依赖/Provider stub用于合同，不算真实模型质量。`p3-contracts.txt`：25 passed（editor、补改客户端、硬件输入、请求恢复）；`p3-typescript.txt`为空且命令成功。
- 本机首次轻量测试环境缺torch，未为此下载GPU栈；改在上述隔离源码中使用既有服务环境执行，不修改生产环境或活动源目录。

### 两种生成表示均未通过，停止该方向的局部调参

六个输入在调用前固定预期，属自写工程边界诊断，不是自然语料或60会话验收。旧三份结果缺少逐行provenance字段，统一在此声明`authored_boundary / natural_benchmark=false / engineer_authored / internal-diagnostic / frozen manual protocol expectations`；探针后续输出已补齐这些元数据，不更改原失败结果。

1. 完整Schema grammar试调用：六条在推理前全部失败，Ollama500原因为`failed to load model vocabulary required for format`，无推理telemetry，不能算模型质量。未为此重启或换模型。当前补改候选明确使用既有chat单次生成、prompt携完整Schema、随后同一严格Pydantic验证，非失败后回退；未改共享Provider或其他业务链。
2. 稀疏patch表示：`p3-real-model-chat.json`，实际6次9B推理，严格4/6，约0.80–1.44秒服务函数等待。组合修改漏date；只有period的相对修改协议无效。保留失败，不以JSON成功遮盖遗漏。
3. 固定八组观察→确定性patch表示：`p3-real-model-slots.json`，实际6次推理，严格3/6，约0.83–1.95秒。日期补回，但把“下午”虚构为14:00；不确定及全局查询两分支协议失败。固定组没有带来足够收益，**不采用、不发布、不因加几句prompt继续刷同六题**。

这些耗时仅隔离Python函数到Provider结果，不是公网、手机采集到可编辑或p95。完整结构和原文引用匹配仍不能证明时间精度和语义完整性；后续必须在表示/可证明性边界解决，而非按本次失败词加例外。

当前源码中的edit候选有明确默认关闭的admission（`LAOJI_SCHEDULE_EDIT_V1_ENABLED`缺省0），capability及路由同步关闭；测试覆盖缺省不调用模型，避免未来无意部署源码就开放失败能力。它不是新客户端回旧链路的备用分支。只有P3/P5安全与语义门通过才允许采用；当前UI尚未调用它。

### 交付边界与续接

- 公网及真机交付仍315；本轮未构建317/arm64、未发布、未安装真机、未重启API/ASR/Ollama、未改固件、未提交或推送Git。5562主App仍316，instrumentation已退出；首轮原数据保留。
- 已完成：316手动保存/重开/备注恢复；滚轮修正源码与真实Android测试；重放/缓存字段源改；P3协议/客户端/隔离合同和明确失败的真实模型对照。
- 未完成：P2紧凑dock/同页采集；P3生成表示安全性、初次日期默认和真实ASR；P4全入口/旧wizard与radial清理/skill采用；P5完整语言、音频、主题、速度、正式产物与侧聊复核。不能把27/25项合同当这些边界已关闭。
- 下一片先实现紧凑dock及复用采集owner，并从当前反例比较少量表达表示/可靠的时间grounding方案；不恢复旧A–F、Q2或固件目标，不请求用户讲话。

源码指纹（本批结束时）：`scheduleEditor.ts=f77f4078…870ed6`、`scheduleEditV1.ts=d25c177b…58c95`、`schedule_edit.py=ced15d79…6122a`、`schedule_edit_service.py=87a9b3a6…15485`、`CalendarEditWheelView.kt=af03fc77…b37f4`。完整SHA可从工作树复核；后续编辑须刷新，不把此列表当已发布内容。

## 侧聊独立复查：撤销归属缺口，待主线修复

复读当前源与上述失败证据，维持P3未采用、能力默认关闭的结论；逐字跨度与Schema合法不能证明“下午→14:00”这样的归一化受来源支持，不将两种候选的部分成功算作验收。

通过Node+现有TypeScript依赖，只在内存中装载并调用当前`src/domain/scheduleEditor.ts`真实函数，未写文件/数据库、未操作设备或调用模型，复现撤销覆盖后续手动选择：初始标题“原来的标题”→语音patch“讨论需求”→手动“讨论排期”→手动“讨论需求”（origin=manual，revision=4）→undo变回“原来的标题”（revision=5）。应保留最后手动值；当前`undoScheduleEditorInput`只比较字段值，尚未保护后续手动归属。这是自写边界反例，不是自然语料或用户实录。

已向主线回传具体重放、owner和预期，请在同批字段归属/变更版本处修复并加窄回归。侧聊不改产品源、不抢设备；此项尚未确认修复，也不推翻316既有保存/恢复证据。后续按同一有限计划继续，不扩为新框架或循环调六题提示词。

## 主线闭合：P1撤销的字段归属与关联副作用

已用生产domain函数加入回归后先执行，`p1-undo-before.txt`实际复现两个失败：审阅给出的手动标题往返被覆盖，以及逆转exact→period时清掉已由用户重新选择的提醒。原本只测试“手动值不同于模型值”的用例仍通过，证实旧测试遗漏了值往返和关联副作用，不把原测试通过当成缺口不存在。

修正位于同一个`undoScheduleEditorInput`，未加页面锁、字段冻结或新writer：

- 字段仍由`explicit`语义写入拥有且值未变化，才可应用该字段逆变更；后来手动改走再改回时，既有持久`fieldOrigins=manual`继续保有归属，不因值恰好相同而被撤销。
- 候选逆变更先完整计算，包含时间精度对提醒的隐含影响；若任何manual字段会被间接改变，保留当前内容、消费本次undo，不偷偷擦除提醒。合法且独立的其他逆变更仍可恢复，例如保留手动标题而撤销未动过的地点。
- 不原地改输入对象或其legacy标志；无需新增数据库列或靠进程内锁记住“编辑过”，继续使用已有JSON中的字段归属。未把判断泛化为所有值相同都拒绝撤销。

`p1-undo-after.txt`：29 passed（editor/domain/实际SQLite、补改客户端、硬件输入、请求恢复）。新增覆盖12个可编辑字段的手动往返、对象冻结不变、只有受保护字段时不增加内容revision，以及真实SQLite落盘→关闭→重开→撤销→再落盘/重开，手动归属和值均保留。`p1-undo-typescript.txt`为空且命令成功。该SQLite证据是Node平台适配下运行实际repository，不冒称Android页面/真机验收。

源指纹更新：`scheduleEditor.ts` SHA `8648dad4f5f775d35b769a9d9ce467ee9ed50ce8ad633236f6f5bb0b229cb123`；测试SHA `6c80d321a879e8bcce2871889ab9d1253a6cb1bbb10c575e7122607cfe8f80cd`。未操作设备、服务或固件，未构建/安装/发布、未提交/推送；此修正仍待下一聚合候选进入。316及315边界不变，P2/P3/P4/P5继续开放。

## 侧聊复核：撤销源码缺口关闭，继续完整切片

用户本侧聊继续授权后，独立核对上述源码/测试SHA均一致，重新执行`node --test tools/tests/schedule-editor.test.cjs tools/tests/schedule-edit-client.test.cjs`，22项全部通过。再用与首次发现时相同的独立内存反例调用真实domain函数，结果保留“讨论需求”、`fieldOrigins.title=manual`及原内容revision；未读写用户数据库或操作设备。此为源码合同复核，不是316或真机包验证。

已确认主线当时idle，并发送一次具体续接：关闭此撤销问题，不继续围绕它打磨；优先交付紧凑dock/同页采集，继续P3时间来源与组合修改完整性、默认日期，再P4全入口/旧流程清理和P5聚合交付。保持失败补改能力关闭，不以普遍拒绝代替语义质量，不扩大到旧A–F、Q2或固件。消息送达不等于下一批已实施；后续读取主线实际状态和产物核对。

## 侧聊跟进：中断停点与下一批实际交付

用户再次要求继续监督后，读取主线最新完成回合，确认停在采集接线检查，尚未写入dock；同批quality无新切片，不能把此前续接送达记成P2新增进展。近期回合存在interrupted记录，单凭此记录不能判定为用户有效暂停或技术性中断。

已发送一次有边界的监督反馈，要求主线先遵守其掌握的最新人工暂停/停止；本侧“继续监督”不撤销主线任何有效暂停。随后主线实际新回合为active/inProgress，并明确确认当前可见指令无该方案人工暂停，将继续同页文字/麦克风输入、保留草稿且不启用失败补改候选。此为实际接手状态，不是新功能已完成。

下一复核点是可操作的同页输入、取消/晚到结果/键盘及恢复证据，再检查安全补改、全入口和旧流程清理。侧聊未重复运行已关闭的撤销测试，未改产品源、抢设备、构建或部署；监督任务automation-3保存状态仍ACTIVE。尚无新产物可供本轮独立UI或发布验收。

## 主线P2：紧凑同页输入已进入317候选，恢复显示修正续验

### 实际改动与用户收益

- AddEvent沿用同一持久draft，底部接入紧凑文字/麦克风dock，采集、转写、初次解析均就地填入字段，不再从这个入口跳只读确认。标题、日期、时间和备注仍可手改，正文不因每次电平回调重新构建；备注/分组间距已收紧。旧加号分支和独立VoiceInputModal的其他caller尚未清除，不把P4算完成。
- `useScheduleEditorInput`复用既有native AudioRecord/WSS和本机身份，进入/打字不注册、不起采、不解析；按下后本机采集，停止先释放麦克风再做语义处理。取消/后台/迟到结果由同一operation及内容revision约束；录音增量文字只推进持久状态revision，不让自己的解析请求失效。停止仅在native明确需要恢复时重传文件，不因静音重复调用。
- 输入文本持久保存。离开时无表单修改但有输入文字不能被当成空白草稿丢弃；此保护在317构建后才补入，待下一候选确认。不新增第二事件writer、远端草稿或新录音服务。
- 失败P3补改能力仍默认关闭；当前同页初次解析可以真实运行，但有内容草稿的补改/重说还未采用，不能以UI已接线宣称完整可用。

### 317真实模拟器证据与未通过项

- `1.3.4/317`为x86_64 release候选，已覆盖5562，未公开发布；`candidate317-build.txt`实际构建及compact生产配置/ABI/安装合同通过。正式315未改，真机未连接。
- 输入“明天下午三点半去图书馆还书”→应用→同页“图书馆还书 / 2026-10-29 / 15:30 / 无结束”→保存→重开详情，流程实走。地点仍留在标题而非独立地点字段，不称完整语义字段质量通过。有效证据为`candidate317-text-applied-real.{json,png}`和`candidate317-saved-detail.json`；较早同名未带real的applied文件是失败点击，不混用。
- 强停重开后文字仍在，但输入区折叠，必须点“文字”才看得到：这是显示恢复失败，不是数据丢失。源修正同时排除加载seed和构造空壳消费首份snapshot。`p2-dock-restoration-before.txt`实际Android失败`expected VISIBLE(0), was GONE(8)`；改后`p2-dock-restoration-after.txt`同一instrumentation通过，并检查四主题/电平更新中输入Editable和顶栏实例保留。模块测试APK不冒充主App317包含源修正。
- 真实虚拟麦克风回放5.064秒既有合成样本，317本机起采149ms，停止前已显示文字；但最后仅“下周二”，未完整接收预期，不计语音链路通过。`candidate317-voice.mp4`有效34.6869秒，实看mid/late截图均只有这三个字。早两份误在菜单/空等的录像不作为通过证据。
- 同一原始PCM经现有8030独立调用，返回完整“下周二上午九点去医院复查，提前半小时提醒我。”，音频5064ms、推理536ms、排队12ms。此只证明源文件及直接ASR路径可用，不证明虚拟麦克风/native流式链路正确，更不是自然人声质量。尚不能断言归因于ASR合并或宿主路由。
- 下一候选加入已有audit体系下的字节推算时长、片段数、来源终点、字符数及停止drain耗时；不记录正文/标题/人物。当前正在聚合构建318，尚不声称已构建/安装。

### 合同边界及下批

`p2-dock-contracts-current.txt`35项通过，`p2-dock-typescript-current.txt`为空且命令成功。新controller测试使用真实React hook/domain配显式native/provider seams，证明迟到、取消、持久文字和快速释放等合同，**不是实际ASR或模型语义证据**。原continuity50项通过。

P2仍需主App恢复披露/键盘及有界音频再验；P3时间grounding/完整性及日期默认仍开放；P4全入口/旧wizard与radial清理、P5聚合语料/旅程/正式产物及侧聊复核仍开放。本批仅自建“图书馆还书”测试事件待清理，原医院复查/读书讨论会及会议均不删除。宿主仅移动5562 QEMU自己的Pulse source-output到私有null sink，未改全局默认输入，验后须恢复/卸载；不以测试工具残留为产品交付。

### 318实测：恢复显示成立，键盘失败后替换错误通知owner

- 318构建/覆盖5562成功，版本1.3.5、唯一x86_64 release APK SHA `800f451b0efd90532e5350645b254bfb4ae368b231e9768fc2c8a9cee3cf93b4`，保存于同一output目录。主App重开后不点文字开关即能看到保留的“下周二”，`candidate318-restored.json`记录实际可见bounds；首次显示恢复缺口关闭。
- Gboard真实键盘检查**未通过**：一份过渡截图只露麦克风上半，静稳后的`candidate318-keyboard-stable.png`中整个dock及输入文字被键盘遮盖。对应a11y仍报告完整屏幕坐标；系统实际IME top=1517px，输入区bottom=2052px、麦克风bottom=2311px，不能仅凭节点bounds判断可用。没有把上一份坐标当通过证据。
- 原因/替换：当前页面的EditText在原生View内，却用RN Keyboard事件驱动JS `KeyboardFrame`；没有可靠收到此输入框的变化。移除此页的JS避让wrapper，用既有`installImeOverlapBottomPadding`接到原生page root，真实WindowInsets/动画回调负责重叠；正常已resize时不重复减高、IME消失恢复0，顶栏不随键盘移动。共享KeyboardFrame及其其他真实caller不删除，不新建一套全局键盘框架。
- `p2-dock-ime-android.txt`：5562实际2项instrumentation通过，包括真实Gboard展开（adjustNothing全高host）→完整麦克风在IME上方/Editable与焦点保留/顶栏bounds不变→隐藏后padding归零，以及原加载恢复/四主题实例检查。`p2-dock-ime-typescript.txt`命令成功，8项键盘/controller窄合同通过；这仍是模块测试，319主App正在聚合构建待实看。
- 第二轮音频回放记录实际source-output在整个播放期uncorked、同一私有monitor、paplay正常退出；318本机起采125ms，录入13850ms音频，停止drain1076ms，但native终态和监听合计0片段、无恢复标志，最终显示未识别到清晰语音。不能按麦克风启动正常称实际转写通过，也不能单凭source-output活动就断言PCM正确；目前只有“虚拟输入/流式边界未闭合”的证据，停止同方式重复尝试。`candidate318-audio-routing.txt`、`candidate318-voice-log.txt`与有效16.3589秒录像保留。
- 宿主收尾已执行并核验：仅5562的QEMU source-output14238恢复原source4758，私有module536870916卸载；没有改全局输入源/音量，Android无麦克风mute。自建“图书馆还书”已明确删除并等待撤销横幅后核对原两条事件，未触碰会议。四个本轮远端screenrecord文件已移除，有效317/318本地片段保留，早两份误操作录像不计成功。Gboard/stylus测试配置最终恢复原ADB Keyboard和未设置的stylus开关，319实看期间会临时再用Gboard后恢复。

本批不发布、不动生产服务/固件/Git；319仅候选验证。P2链路完整性/P3/P4/P5保持未完成，后续优先修正可靠补改表示及收敛全入口，而不是继续围绕这段音频做无界工具尝试。

### 319实际主App及侧聊补出的取消边界

- 1.3.6/319 x86_64 release构建/覆盖5562完成，46,747,865 bytes，SHA `82e648a3ba9d446973b33ee26f4590710a4bce9fa3db2f70968a14fbd600cb0f`；从已安装`base.apk`完整读取后SHA相同。正式arm64、公开清单和生产未切换。
- `candidate319-keyboard-stable.png`已实际查看：Gboard可见，系统IME顶部1517px，完整输入文字区和麦克风bottom1491px，顶栏仍原位置；不再像318被覆盖。隐藏后的布局恢复全高，原ADB Keyboard、stylus未设置状态已恢复。模块真实展开/隐藏与输入实例检查和主App实际画面相互补充，不声称所有转场中间帧无闪。
- 后续录像尝试中，切换IME后未重新建立输入连接，系统back实际返回了日历，因而“应用”目标不存在；`candidate319-period-applied*.json/png`虽沿用拟定文件名，内容是日历，**不得当作周五/下午解析通过**。`candidate319-keyboard.mp4`为有效31.088秒文件，但该混合操作不能算完整键盘/解析旅程通过；保留失败，不按时长计验收。此不是数据丢失证据；原医院复查/读书讨论会仍各一条，本轮图书馆测试事件已删除。此前317真实15:30同页解析/保存/重开证据独立成立。
- 监督侧聊用现有fixture及真实hook/domain独立发现：stop要求文件恢复→local auth挂起→用户取消→旧auth返回，仍会启动`transcribeNativeAudioFile`。主线加入同一测试文件回归，`p2-recovery-cancel-before.txt`实际复现cancel和background两条`1 !== 0`失败，没有网络/真实音频写入。
- 在`stopCapture`的恢复auth await之后再验`owns(active.operationId)`，失效即退出并走既有finally清理，不禁用合法恢复、不加UI锁、不改变新输入。回归还在取消后启动下一次采集，再放行旧auth，确认旧恢复调用0、新operation和recording状态不变、旧源完成清理。`p2-recovery-cancel-after.txt`37项通过，`p2-recovery-cancel-typescript.txt`成功；这些为controller/native/provider seam合同，不冒充ASR通过。
- 该guard修改发生在319构建之后；319 APK不含它，下次聚合构建必须纳入。最新关键源码SHA在`p2-current-source-sha256.txt`，不复用上轮hash。未再为这个源合同制造独立发布版本。

续接只做同一P2–P5：不要重跑已关闭的恢复披露/同伴滚轮/撤销问题，不恢复真实讲话请求；优先P3时间来源与组合完整性/日期默认、P4真实入口与旧流程清理，再聚合音频、完整旅程和正式产物。模拟器虚拟输入/流式完整性仍有明确失败，不能改验收口径；物理讲话验收为用户主动跳过，不声称通过。无Git index/HEAD变更或推送，无生产重启、固件或其他设备操作。

## 侧聊独立抽查：取消后的恢复调用原反例与源码闭合

本轮由主线进展通知触发复查，不冒称定时轮次自动完成。读取上述实际controller、318原采集日志与IME instrumentation输出：318记录13,850ms输入、0片段且recovery_required=false；因此继续保持真实语音链路未通过，直接8030同源成功不替代它。319主App/UI仍待主线实看，侧聊未占用5562；不把模块键盘检查等同正式主App验收。

独立异步反例使用当前`useScheduleEditorInput`真实React hook/domain，在内存中复用现有`tools/tests/schedule-editor-input.test.cjs`的native/provider seams，仅为取证暴露fixture对象；未改测试文件或产品源，未调用设备/网络/用户数据库。设native停止结果要求文件恢复，第二次本地身份读取挂起：取消前phase=parsing、恢复调用0；调用cancel后phase=editing、pending=null；再完成旧身份读取，实际仍调用一次`transcribeNativeAudioFile`，应为0。表明recovery分支在异步身份读取后未再次校验当前operation归属；这是可复现的代码层取消合同缺口，不是实体设备实际上传或ASR质量证据。

被复查controller SHA `28b390044bee7f7fedd38a664e81741e1b84359a7b3222d86e956a025a8fef7a`。已向主线回传owner、执行顺序与预期，请在同一输入生命周期及现有窄回归闭合取消/后台/下一次输入，不新增状态系统、不关闭全部合法文件恢复，不影响319主App及P3/P4/P5续接。当前仅已发现并回传，尚未确认修复。

收到主线修复通知后，侧聊已独立复核当前controller SHA `56ec056af38f5863c0fcbc32681fbd91396034c54f455e90498c927d9b6c4d33`：重跑现有controller文件8项全部通过，并另外调用真实hook及既有测试seams重放cancel/background两种中断，均在放行旧auth前启动下一次采集。旧文件恢复调用均为0，新operation与recording状态保留，旧文件finally清理成立。没有改源文件/测试文件或操作设备、网络、用户数据库。原反例在源码合同层关闭，不再循环打磨；该guard尚未进入319，须随下一聚合包复核，语音链路和P3/P4/P5不因此验收通过。

## 定时监督故障：临时侧聊无法由调度器恢复，已暂停失败任务

用户报告持续监督未生效后，已独立定位到真实失败，而非仅核对ACTIVE或last_run_at。2026-10-28系统用户journal记录automation-3在13:34:56、14:05:56、14:35:56、15:06:01反复`Scheduled run failed`，共同错误为`no rollout found for thread id 01a17db7-8841-7e63-bcb2-2beb071a2ab5`。该ID是当前临时侧聊，不在持久threads表中；应用read_thread也明确返回`ephemeral threads do not support thread/turns/list`。只读检查当前安装应用的heartbeat实现，确认它尝试恢复目标thread后再提交定时回合；计时字段推进不能证明回合执行完成。未修改应用代码、私有数据库或调度器实现。

因此此前的ACTIVE状态和最近调度时间只证明已配置及发起过尝试，不能称持续监督已生效。已完成的侧聊复查由用户消息或主线进展通知触发，不应归为这些失败的定时轮次。

已通过正式automation_update将原automation-3设为PAUSED，并核对TOML及应用数据库均为PAUSED、next_run_at为空，阻止反复失败；未新建cron替代、修改原始调度数据库或唤醒/暂停主开发任务。自动监督当前尚未恢复。可靠迁移需一个普通持久监督会话；按创建会话授权边界，先请求用户明确同意，再迁移原任务并验证真实自动触发、读取主线与监督结果的完整闭环，不能再次以任务创建成功充当修复。

## 定时监督恢复：用户指定直接运行主会话，真实自动验活通过

用户随后明确“就直接在主会话设置任务”。据此复用原automation-3，不新建会话/任务或cron，将目标从临时侧聊改为持久主会话`01a00b55-b0d9-7c30-8f49-8ccc020c3e96`。先以短间隔的只读验活验证自动调度，不发送手动续作消息来冒充触发；验活不改代码/Git/设备/服务或用户数据。

主线rollout实际存在automation_id=automation-3的heartbeat输入，时间为2026-10-28 15:56:26及15:58:26（北京时间）。对应自动回合`01a18182-a94a-71c3-abdb-5cbd7d24cb7c`和`01a18184-7df2-7980-b328-ee6b9c4d3b82`均completed；两个回合都实际执行CURRENT前35行和本quality末35行的读取，明确输出“主会话定时监督验活成功”及真实开放的语音/P3/P4/P5边界。核对了输入来源、工具执行和最终结果，不只依赖ACTIVE或last_run_at。短间隔出现的多次只读验活不是多次功能交付，不继续重复。

已恢复同一任务为ACTIVE、每30分钟及正式自查/续作提示词，TOML与应用数据库的目标/频率/状态一致；正式prompt SHA `9e2ad9901ca6214f81d1af3d4233943892d16216d43d3a42b94e3a60c58f316a`。16:02:52核对时下一次为16:29:40（北京时间，后续以应用调度实时值为准）。此前“临时侧聊无持久记录”的失败目标不再使用。正式回合将读取最新进展、审查后继续有限P0–P5，不再只读验活；主线有效暂停优先，不把本迁移当成绕过暂停的授权。

这恢复的是主会话自身定时自查/续作，不是一个独立旁观侧聊的常驻运行。源代码、319候选/315正式发布和语义/语音验收边界未因验活而改变；侧聊后续独立复核仍由用户或主线通知触发。

## 主线自动续作：时间来源表示对照失败，分钟截断修正尚未入包

本节承接08:30 UTC的automation-3正式开发heartbeat，不是前三次只读验活。只在同一工作树和`/home/tanyk/laoji-candidates/schedule-editor-20261028`隔离候选执行；没有部署服务、发布APK、Git提交/推送或修改真机/固件。目标是补改时完整保留日期、时段、分钟及未提到的字段，而不是提高JSON得分。

### 先记录失败的真实来源，不猜归因

- 新增冻结文件`tools/quality/schedule-editor-context-probe.json`：18条分别编写的工程诊断，推理前冻结预期及provenance，SHA `3b05d4be61d1babeb92044a539e2d424ac336f9522b2546bf1ea27ab4bdafcf7`。没有复用六题循环或从模型输出反推标签，也不将它们称为自然语料/盲测。语域检查实际有两项失败：裸祈使16.67%低于30%、字段称谓5.56%高于0.5%；原输出`p3-mentions-register.{json,txt}`保留，不改词句来刷门禁。查询、清除等是独立安全/边界诊断，不能混报普通补改质量。
- 第一表示让模型给date/time各自逐字短语，再由既有时间语法换算：18次真实本地9B调用，严格10/18。原结果`p3-mentions-real.json`保留；不能因为值有来源就接受组合字段遗漏。
- 只对五条原失败补取原始观察，不改预期、不扩大得分。`p3-mentions-diagnostic.json`显示：周六上午缺无关的必填null键；下周三被重复放进time而导致整份拒绝；明晚的钟点引用丢掉“明晚”；后天晚上范围被摘成“十点到十一点半”，实际输出10:00–11:30且漏日期。后两项是来源拆分导致的丢限定/错误值，不是依据最终输出猜测。
- 现有探针只对明确`engineer_authored/natural_benchmark=false`数据保存原始模型观察，记录调用次数、错误字段路径、输入/预期、源码/prompt/cases SHA；生产仍不记录正文或模型输出，没有增加产品日志/第二次修复调用。

### 一次结构替换及止损

候选内部协议用完整`temporal`来源操作替换原date/time双组；公开typed patch协议和本机CAS不变。日期、时段、分钟及起止从同一个被选原话换算，不再让模型分别生成规范日期/钟点。普通字段仍由一次语义观察决定，不增加逐字段调用、关键词意图否决或旧clarify回退。旧分离短语对象和compiler已从此候选替换，不另留备用路径；315仍在用的原clarify接口未误删。

同一18条、同一预期、同一本地`qwen3.5:9b`重新调用一次/条，结果仍严格10/18（`p3-temporal-spans-real.json`），**没有净收益，不采用**。只有后天晚上范围由错误的10:00–11:30/无日期改为正确日期和22:00–23:30；原本正确的“改成上午九点四十”反而被模型算成“23分钟”的shift且引用无此原话。其他失败包括指定周六/下周三被当相对时长、“下午吧，不用定死几点”被误当清除时间、地点补改篡改标题并引用旧备注、全局查询返回no_change、未定月份返回ambiguous。未将查询/未定分支换标签凑通过；它们与漏改/误改分开保留。

此轮18次调用服务函数等待最小983ms、中位1567ms、最大2456ms，只是隔离函数计时，非公网/UI端到端p95，也不是性能验收。原始模型输出在之后新增的来源顺序/重复和非法钟点检查下零推理重放18/18最终结果不变；`p3-temporal-spans-final-replay.json`明确model_calls=0，不把重放当新增模型调用或语义改善。新旧两表示相同得分后，停止沿此表示/这批题继续调prompt；下轮应重新定位语义执行owner，而不是再造第四种字段名。能力开关保持默认0，未部署失败候选。

只读复核还看到了Ollama模板`{{ .Prompt }}`；已回读`Q2-PROTOCOL-20261022.md`的归因纠正，不能再次把展示模板当作System丢失的证据。没有改Provider、模型模板、thinking、显存布局或其他服务。当前这个候选的语义失败不是需要用户配合才能解决的外部阻塞，不将任务标为整体完成或请求用户验收失败版本。

### 独立可证明的修正：完整分钟

合并来源的确定性测试先真实失败：完整“明晚七点二十三分”被既有语法读成19:20，而非19:23。原因是共用时间token及换算的分钟部分只允许最多两个中文字符，三字分钟被截掉末字；不是模型取整。相同缺口在手机`localScheduleParser.ts`也存在，现同步放宽完整分钟词法（含零/〇），保留合法时分边界及原规则路由，没有只给补改加特例。

- 后端对0–59每分钟的阿拉伯数字、中文、零前缀及有/无“分”260种组合，经token/authoritative/basic/补改compile共同核对；手机同260种组合真实调用本机parser，精确分钟与去除时间后的事项标题均正确。此为机械语法单测，不是260条自然语料或模型质量样本。
- 时间源检查拒绝丢失相邻上午/晚上或分钟后缀的引用；同一原话不能重复平移，明确重复说两次才可分别应用；非法“六十分”不能静默退化为下午时段并清掉原钟点。只验证值/来源，不用业务词判断用户意图。
- 隔离后端两个edit测试文件、原parser质量及原graph回归最终137项通过：`p3-temporal-spans-final-contracts.txt`。手机draft/input/client与新增完整分钟回归31项通过：`p3-mobile-minute-contracts.txt`；TypeScript命令成功，`p3-mobile-minute-typescript.txt`为空。合同层成功不抵消上述10/18的语义失败。
- 实际18次生成使用的schema SHA `755cfc06ed8c66b2e82a438f5ec794a30b19d26fa2713fe7e275470040c149b1`、service SHA `240a6fa52513334d8f3d5d3ac19d113069cbb31b6f3299105a0d16dfb3e41036`、parser SHA `c29bd2a695d07677eb9d30bfed3e0bb2a18005b3981ca3e231f327c6372e8675`均在结果文件中。生成后新增确定性来源重复/顺序及非法钟点检查，最终service SHA `24abccaf69c6465c7f6f2400e2ff42ff9963ff1c0842eaf70f60d0a7feda00a6`由零推理重放文件记录；不谎称后改源码已经原样做过新推理。手机parser SHA `b197ecb36b4abaa1f6d456848a20d042edd218099e379109bccf4d96433abf39`。

### 本批最终边界及下一片

源码、隔离合同和真实诊断已完成；补改语义仍失败。分钟修正、此前recovery-auth guard均在319包后，**未构建/安装/发布或服务采用**。5562现查仍1.3.6/319，未操作5560；未连接真机，不请求用户讲话。API PID473253及其生产cwd未变，ready=true；9B仍9,218,892,416 bytes VRAM/16384 context，embedding仍CPU。没有创建候选监听进程、重启生产或改变模型。

公网curl最新清单仍315、SHA `86b0b680f4f601299aefcb82edcc458d92770bbff9ee34b3296954fc23289a89`；本次未重下载旧APK、未宣称重复发布。Python urllib的单次清单读取曾403，随后curl200正常，不能把这一次客户端响应称为生产故障或发布失败。原Git HEAD与index未变；无关脏工作及用户日程/会议未改。

P2真实音频仍未闭合（318为13,850ms录入、0片段、recovery_required=false），P3初次日期默认/replace及整体可靠补改未闭合，P4全入口与旧wizard/radial清理、P5完整旅程/语料/主题/速度/正式产物仍未完成。不得重放已关闭的滚轮、披露、撤销或auth取消缺口。下一步先取得实际采集PCM与正常WSS之间的证据，不再把Pulse source-output活动等同录到有效语音，也不反复切sink盲重录；若设备沙箱/工具无法安全取得，应明确限制并换现有原生测试边界，而不是给生产加导出后门。全入口改造按有限消费者批量接通唯一editor，不以未启用P3为由保留第二套新产品流程；最终采用/发布仍须整体门禁通过。

## 主线续作：一次真实UI语音旅程与Android唯一编辑入口

本节是同一automation-3范围的实际开发续作。所有设备命令只指5562，真机和板未连接，不请求用户讲话。公网仍315，生产服务/模型/固件不改，Git未提交/推送。以下产物均在`output/schedule-editor-20261028/`。

### 实际采集边界，以及必须保留的工具失败

- 新增opt-in测试`RecorderCaptureInputProbeTest`，仅显式`capturePcmProbe=true`才运行。在独立test host内调用真实RecorderEngine、SCHEDULE/VOICE_RECOGNITION采12秒，仅复制自身WAV供分析，最后删除自己journal/WAV。无主App数据导出、后门或用户源读取；测试host麦克风权限测后撤回。
- 前两轮`p2-pcm-probe-*`和`p2-pcm-hostmicon-*`不能证明有效输入被录成静音。Python select配TextIO.readline使CAPTURE_STARTED滞后交付，epoch/文件mtime显示播放已在采集结束之后。曾执行5562控制台hostmicon=on，但初值不知，不能把此命令当已证明的修复根因。停止沿该日志同步工具重跑。
- 改用测试本身既有durable recording journal同步：`p2-pcm-journal-report.json`记录12秒、16kHz单声道PCM16、peak32328、RMS4215.07、非零72048采样。确认AudioRecord实际能收到虚拟输入，不等于ASR/UI完成。QEMU source-output仅当前5562 PID，私有sink测后卸载，原source4758恢复；未修改宿主默认source/音量。
- 第一次主UI尝试`p2-editor-voice-report.json`又混用宿主/guest墙钟筛日志，导致脚本未播放；实际audit已有起采31ms但文字0。guest时钟约落后2秒，不能把这轮标为起采失败或据此计算延迟。`p2-editor-voice-early-invalid.mp4`保留为无效尝试，不计验收。
- 有效正常UI旅程用已安装319，普通按住手势、正常速率播放既有5.064秒合成句，经真实采集与公网WSS，不直接调用ASR或注入转写字段。`p2-editor-voice-aligned-before-stop.png`已实际查看：仍在录音时有“下周二上午九点去医院复查，提前半小时”。最终`...-applied.json`完整原句“下周二上午九点去医院复查，提前半小时提醒我”，同页医院复查、2026-11-03、09:00、30分钟前，保存可用，无确认页跳转。
- `...-report.json`及audit：起采11ms、录入10,950ms、drain502ms、1final片段/21字、recovery_required=false。只计这一条合成语音端到端，不当24音频、真人准确率、P3补改或p95通过。未保存此测试事件，原两日程/会议仍保留；退页后的测试草稿按正常恢复合同保留，不清用户库。

### 入口、持久身份与删除映射

- Android全局plus直接进AddEvent，不继承刚浏览的历史日；日期格`create-date`/时间格继续明确提供上下文。native FAB48dp只拥有一个create，无voice/manual分支或延迟长按selector。
- `useScheduleInputEditorEntry`只协调日历导航，收到的ready job由现有scheduleEditorRepository按`input_job_id`打开一个稳定draft。它与手机解析复用domain的`initialScheduleEditorChanges`纯映射；无第二draft或硬件专属确认页。failed显式重试原ID，saved回执回原事件；页面leave/background/unmount均使旧导航失效。
- 真实SQLite回归先复现：dismiss后用旧ready对象仍能新建草稿。现在factory在同一数据库写屏障读取真实job和draft，拒绝已退休输入，重复接收保留手改；恢复saving仍用现有原子回执owner。dismiss与draft删除同事务，saving拒绝、saved不降级，不影响其他事件/草稿。`p4-entry-storage-before.txt`保留21pass/1fail。
- React真实hook+明确storage/native navigation seams先复现background→active旧读取仍导航。现在AppState离active推进epoch，取消旧归属；重复poll不重复开页，明确重试仍可用。`p4-entry-navigation-before.txt`保留4pass/1fail。这些是异步合同，不冒充硬件实体/模型语义验证。
- 删除`VoiceInputModal.android.tsx`，native `schedulevoice/{Models,HostView,Fields}.kt`及专属ExperienceTest、TS scheduleVoice桥接、WindowOverlay类型/创建/更新/back/slot分支、native radial参数/命令。保留真实采集/WSS/转写、通用overlay、持久retry/ack。非Android的VoiceInputModal/ScheduleCreateButton/AddEventScreen仍有活跃调用，未谎称已全局删除。
- 原设备/主题/硬件UI检查改指CalendarEditInputDock及真实共用音频转写→parseText链，catalog替换退役路径和旧确认态；不是删除安全检查来放行。现有system-bar检查本已滞后于真实NavigationBackdrop对比度owner，现核对overlay+surface组合。UI skill按方案替换旧放射/确认/详细编辑描述，并显式标非Android剩余依赖；quick_validate使用现有API venv通过（系统python3缺yaml的首次工具失败保留，未装新依赖）。

### 聚合验证与边界

- `p4-entry-contracts-final.txt`43pass，`p4-entry-typescript-final.txt`空/成功；已知UI17pass，continuity50pass。后者首次因catalog仍指被删HostView失败，现修正生产owner，不保留虚假样例；失败输出保留。设备/主题/硬件UI静态检查通过，不等同UI语义通过。
- `p4-entry-native-execution.txt`实际输入实例/真实IME两项pass，FAB一项fail；改用真实pointer后仍fail，`p4-entry-native-pointer-execution.txt`保留，未把工具变更当修复。最终确认FAB自身tooltip在长按接管触摸，删除该重复提示后`p4-entry-native-fab-execution.txt`真实pointer、四皮肤、release一次create及移出取消pass。未放宽原断言或伪造performClick。
- 关键源码SHA在`p4-entry-source-sha256.txt`：entry65cb0e9e、editor repo f2e90b29、input repo3950617a、FAB a4cc6860、domain19a434bb（全文见文件）。已聚合此前分钟修正、recovery-auth取消guard。
- 当前1.3.7/320 x86_64 release正在构建，尚未确认安装/主App入口验收，未公开发布。P3仍两表示各10/18，能力默认关闭；P2单旅程不关闭音频覆盖门。P4非Android/全部入口真实回放、P3默认日期/可靠补改/replace、P5自然语料/24音频/12旅程/完整主题速度及正式产物均仍开放。下一步先实走聚合候选日历plus、日期创建及恢复，再推进实际未闭合owner，不重跑已关滚轮/撤销/auth边界或围绕旧六题调prompt。

### 320构建、安装及主App实际续验（覆盖上述“构建中”状态）

- `candidate320-build.txt`真实release构建成功2分钟；既有脚本从源clean prebuild，x86_64单ABI，正式HTTPS/签名配置检查通过，仅安装5562。产物`laoji-1.3.7-320-x86_64-release.apk`46,696,885 bytes，SHA `60cf7d3a0641da410ebcf0c4af3b030b025cc635064077dd34f66de9884a88a3`；直接完整读取安装base.apk后SHA相同。版本1.3.7/code320已从dumpsys核对。恢复guard/分钟修正不再是源码未入包，但生产后端候选未采用。
- 覆盖安装后直接恢复319自己的未保存医院复查草稿，原话/11月3日/09:00/30分钟前保留。退出该草稿，日历原医院复查/读书讨论会各一条，未新增保存事件。真实global plus不经方法选择直接到空编辑页；浏览10月5日再点global plus仍显示10月28日，而10月6日空态里的“新建日程”保留10月6日。`candidate320-{plus,global-from-past,date-cell-editor}-ui.json`留证。页面全图`candidate320-editor.png`实际查看，首层字段/底部紧凑dock无独立语音阶段。
- 全局FAB与日期空态同时有“新建日程”是不同context的两个动作，辅助工具按desc唯一查找会失败；保留当次失败，不改产品a11y掩盖。后来用唯一text选择日期空态、用已读取bounds选择global FAB。日视图单次长按只创建可调整的预览，不立即打开editor，本次未完成第二次确认/范围调整，不计slot完整旅程通过。
- 使用正常文字dock经ADB IME输入“明天上午九点二十三分去取体检报告”，点应用后同页为取体检报告、2026-10-29、09:23（`candidate320-minute-final-ui.json`）。一次紧接应用的a11y读取为空，后续新鲜读取有完整结果；不能据此宣称所有中间帧无闪烁。force-stop主App后正常重启，`candidate320-restart-restored-ui.json`仍完整保留本次原话、明天/09:23/标题，未保存；最后停在此测试草稿，不触动用户原记录。
- `candidate320-entry.mp4`有效180.568秒/3,503,997 bytes，含入口连续操作和工具选择错误，不是流畅演示或全部验收片；已抽看70秒帧与独立全页图，不能仅凭静图断言无闪。sdcard本轮图片/视频已pull后清理。原IME仍ADBKeyboard，私有Pulse模块未残留。当前无录音服务。
- 安装后对实际源码再跑`p4-entry-contracts-installed-source.txt`43pass、TypeScript成功；未为普通控件另造发布版本。UI skill验证首次系统python3缺yaml后，改用现有API venv完成quick_validate；无安装新依赖。
- curl现查公开manifest仍1.3.2/315，原正式SHA不变；没有重复下载旧包或宣称发布320。Git HEAD仍`89ef1fd3ca5d238a6f4948a2d02309e5247ce3df`，无index/提交/推送、服务重启或其他设备操作。相关diff whitespace检查通过。

有限剩余：当前普通退出保存了草稿，但plus没有提供主动继续旧草稿的选择；进程导航重建可恢复不等于这个入口闭合。下一片在同一入口/持久owner补齐恢复选择与其他真实来源，继续保留手改/过期结果/单保存约束。P3可靠补改、默认日期/replace仍失败/未完成，不能启用；非Android真实旧消费者不能只删文件或用空页替代；自然/音频/主题/速度/正式产物整体验收仍开放，不转回旧A–F/Q2/固件目标。

## 主线续作：普通返回后的草稿入口与既有日程恢复

本节承接11:29 UTC的automation-3；唯一目标仍P0–P5。本批只改移动端入口/既有持久状态/共享菜单，没有改服务语义、重启生产、操作真机或固件、Git提交/推送。320阶段的普通返回后恢复缺口在本批有限闭合；不将此片延伸为一般表单打磨或会议改造。

### 当前实现和真实用户收益

- 原`useScheduleInputEditorEntry`重命名为`useScheduleEditorEntry`，由同一导航owner承接global/date/slot创建、收到的日程语音和既有事件编辑；删除旧文件，无转发alias。普通新建仅在现有SQLite确有内容草稿时打开现有AppActionSheet；没有草稿仍直接进编辑器，不新建草稿管理页面。空白默认日期不算有内容；录入文字、标题、地点、备注或明确手改才算。
- domain在入口身份边界隔离普通/硬件/会议待办来源，并比较明确日期/时段、eventRef及recurrenceScope；不让另一次日期创建悄悄继承不相干草稿。普通另建保留原草稿；原音频/待办是固定身份，不在恢复菜单里提供另起新save identity的选项。待办实际消费者尚未迁移到该入口，不能仅凭纯函数测试称该真实旅程完成。
- 恢复点击在repo重新读取当前草稿，saved回执仍去原EventDetail；不把列表快照重新播成一份draft，不覆盖手改。lookup/选择/后台/离页保留原epoch与一次性sequence fence；正在选草稿时硬件自动打开不得抢导航。既有EventDetail选择编辑范围后复用此入口，恢复仍携带原eventRef/scope，不成为addEvent。
- 已有输入选项增加明确“放弃草稿”，一次破坏确认后复用原CAS discard，仅删当前草稿；普通取消仍保留。硬件关联草稿不暴露该动作，本批不改变音频来源/ack清理合同。没有为了回滚保留第二编辑器或新备用状态。
- 共享AppActionSheet的item lane改为有界ScrollView，标题/取消位于外部；18项菜单可以找到末项，不再把取消挤出屏幕。native与RN均按半窗限制，native长标签单行截断但a11y保留全文；短菜单、原破坏/禁用/取消行为不变。未新建主题或token框架。UI skill原owner说明同步修订、quick_validate通过；CURRENT本批旧“319/未入包/无有效音频”等相互矛盾状态已合并，历史原始失败仍留本quality，不删失败证据。

### 合同与原生运行证据

- `p4-resume-contracts-final.txt`及安装后同源码`p4-resume-installed-contracts.txt`47pass；覆盖上下文身份隔离、空草稿/日期-only手改、重开不播原ASR、普通另建不删原草稿、lookup离页/后台、恢复菜单关闭后选择及重放不重复导航。React测试显式storage/native seams，真实SQLite CAS/回执另由原fixture验证，不混报真实硬件或模型。
- `p4-resume-installed-typescript.txt`成功；已知UI17pass、continuity50pass，输出分别在同前缀文件。`p4-resume-native-build.txt`成功；`p4-resume-native-execution.txt`2项实际instrumentation通过：原dialog/sheet/toast主题/action/lifetime回归，18项菜单title/cancel可见、滚动到底末项完整可达、四主题保持offset及唯一末项回调。并未以这些模块测试替代主App。
- 关键源码初始SHA在`p4-resume-source-sha256.txt`；完整本次构建源SHA在`p4-resume-built-source-sha256.txt`。hook为`96348f09c731f433f75c59ec1a9e82da261cc538a515cd6434549dd0aaeb9ea5`，共享恢复sheet为`328a21aabd548c30d8fca9a81648bebaef3ec0fcb9202e70fc544e0f1f79e004`。没有在构建后继续修改产品源码来冒充同包。

### 321真实主App旅程、清理与未验证边界

- `candidate321-build.txt`release成功1m49s，1.3.8/code321、x86_64单ABI、HTTPS/签名合同通过；`laoji-1.3.8-321-x86_64-release.apk`46,701,737 bytes，SHA `fda22638abde19d3a22c82fdfbbc39f4c3e258b770b0115ad13a9331a61c9086`。已覆盖5562，dumpsys与直接完整读取已安装base.apk后的SHA均一致；未构建arm64/公开发布。curl公开manifest仍1.3.2/315及原正式SHA，没有再下载旧包凑发布证据。
- 安装后320测试草稿原话/明天/09:23仍在。退出→plus出现4个真正未完成草稿，选择“取体检报告”恢复同份09:23；手改标题为“取体检报告并带医保卡”→普通取消→plus可见新标题，重开不被旧转写覆盖。选择“新建日程”是空主题/今天/未设置，取消后原草稿仍能恢复。文件`candidate321-{resume-menu,manual-resume-menu,manual-resumed,new-alongside}-ui.json`及实际查看的`candidate321-resume-menu.png`留证。
- 对本轮自己的“取体检报告并带医保卡”测试草稿：输入选项→放弃草稿→确认放弃→返回。再开plus，该条不再出现，其余3草稿还在。`candidate321-after-discard-menu-ui.json`证明只退役所选测试草稿；没有删除其他草稿、提交新事件或清用户库。
- 原“读书讨论会”详情仍15:00–16:00/图书馆。只在未保存编辑草稿把标题改成“读书讨论会带笔记”，取消后从详情再点编辑出现“未保存的修改”，仅含此event/scope的草稿和“重新编辑”，没有混入普通创建的3条草稿。恢复后标题/15:00/结束16:00完整；明确放弃后原详情标题及15:00–16:00/图书馆不变，再次编辑直接回原内容、无恢复菜单。全程未点保存/删除日程；最终日历医院复查和读书讨论会各一条，`candidate321-original-events-final-ui.json`留证。
- `candidate321-resume.mp4`5,803,747 bytes/ffprobe182.456秒；`candidate321-edit-resume.mp4`2,397,238 bytes/ffprobe100.147秒。后者screenrecord参数60秒但封装时间更长，故仅供连续内容/抽帧观察，不从PTS推导实际等待、首绘或服务耗时。已实际查看菜单全图及编辑恢复6秒帧；不能据此宣称全转场无闪或性能门通过。截图/录像均已pull并从sdcard清理。
- 一段批量UI脚本的exec返回running session后未及时取终态，早期部分a11y文件为空；已停止按这些文件下结论，后续所有UI动作取完session终态并fresh读取后再推进。不是App崩溃或数据丢失证据；没有为此给产品加后门或重复修测试平台。最终无剩余screenrecord/录音进程，停在日历，无未保存的新测试编辑；原IME/用户主题不改。

本片普通/既有事件恢复与明确放弃已闭合；仍不宣布P4全部退出。下一批优先P3初次日期默认、当前草稿可靠组合补改与replace：从冻结原始观察/错误路径确认理解与执行owner，比较少量实质不同方案，不再沿两轮无收益的span表示换字段，不靠普遍拒绝、关键词补丁、放宽预期或逐字段模型调用。P4硬件/待办真实完整旅程、非Android活跃旧链路迁移与清理、P5自然/24音频/12旅程/四主题字号/速度及正式交付继续开放。生产P3能力仍关；Git HEAD/index不变，无推送或生产重启，不恢复旧A–F/Q2/固件目标。

## 主线续作：日期默认执行、规则误拒边界与待办采用同一草稿

本节承接12:01:57 UTC的automation-3。真实用户任务是：省略日期时少一步补充，明确未定不能误落今天；会议待办转日程后可恢复自己尚未保存的修改。没有重做321已闭合的普通/既有事件恢复、滚轮或硬件手势。以下文件均在同一`output/schedule-editor-20261028/`。

### P3失败归因与停止的方案

- 对保存的18条原输出逐条核对：指定周六/下周三被模型解释成shift，明确时段被解释成clear，地点补改引用旧备注，主要是模型观察错误，不能靠日期换算补丁修复。
- 比较一次不同执行owner：模型给完整after-state，代码求差异并校验来源，仍用同一9B、一次调用/条、原冻结预期。`p3-after-state-real.json`记录18次真实调用、严格协议0/18；全部带Markdown fence，且引用结构、逐字依据不合合同。即使只看未采用的原始字段，也有只改开始却改了结束、日期跨日未移动、时长计算错误等，不能通过剥壳放宽协议凑分。p50 3118ms/p95 3480ms仅为这18次服务函数等待，不是手机端p95。活动工具中的after-state实现/开关已删除；失败源码仅作为证据`p3-after-state-failed-probe.py`保留，不是生产备用链路，服务器临时脚本也删除。

### 已实现但尚未入包/服务采用的实际改动

- `initialScheduleEditorDate`在既有domain执行日期政策：本次明确日期优先；明确未定留空；只有同次观察明确为omitted才使用日期格上下文或固定输入时区的当天。旧producer缺元数据、非法/无时区参照均不冒充省略。跨零点使用pending operation原参照，不使用处理/恢复时刻。Android seed为日期来源记录context/default/legacy/explicit，撤销保留来源且不覆盖后续手改。
- ParseResult、Graph slots新增可空`date_resolution=resolved/omitted/unresolved`；由同一次初始模型观察提供，不增加模型调用。日期空值本身不能证明omitted，候选要求模型明确date_status。未知板端时钟继续在原`scheduleInputDraft`边界强制unresolved，不能由新默认绕过。Graph拒绝日期与resolution矛盾；旧producer缺元数据仍可读。没有改已有表或清用户数据。
- 通用model-only normalizer将模型选中的真实模糊时段保存为period，不再把“下午/晚上”一律降成all-day；无重复来源的重复观察保持待选，不能因缺少来源静默获得日期默认。Graph provenance现在按真实parse_source记录server-model，不再把模型产出的needs_clarification误记recognizers。最终源码改变后没有伪称重新推理，见下述零调用重放。
- 真实路由审查发现6类输入在进入模型前被本机误拒。原因是`!parsed && !positive_signal`被当成非日程；已将此处统一改为server_required。原先明确控制/非日程拒绝仍在前面执行；没有新增动作词、样本关键词或业务白名单。此为路由修正，不是把规则空结果称为解析通过。
- P4 Android会议待办采用改接既有`useScheduleEditorEntry`与恢复sheet，保留action/clientRequestId；不再每次直接navigate而丢弃未保存draft。异步读取返回需同一会议、当前焦点和挂载实例；不自动接管其他硬件job。已关联日程仍走原详情入口，不另建日程。新源码晚于321，不能算321已安装的功能。

### 初次日期真实推理及质量边界

- 推理前冻结20条独立编写的初次工程诊断`tools/quality/schedule-editor-initial-probe.json`，SHA `f807d5d4e07864acb3ffe28c1af20f5e7e8f7746517db220b82426c86a20276e`。属于authored_boundary，非自然语料/盲测；不是替换原18条补改的成绩。探针明确标diagnostic_forced_model，每条保存完整原输出、真实调用数、耗时、源哈希与期望。
- 第一种“date_phrase空即omitted”20次真实调用严格18/20，`p3-initial-date-real.json`；“日期没定”“有空再去”两条被误当omitted，不能采用。这证明单靠空证据无法推导缺失语义。
- 显式date_status同20条一次重测为17/20、21次真实调用，`p3-initial-date-status-real.json`。未定/延期五条这轮保留空日期，但周末误判未定、相对时间首轮null后原parser重试仍漏时间、每天散步漏重复来源。不得以普通输入会走规则、移除失败题或字段合法率代替整体质量通过。原始forced-model失败继续保留；本轮共59次真实生成，没有逐字段推理。
- 这20条的第二轮服务函数p50 1483ms/p95 1960ms，不含手机、WSS、能力查询或网络传输，不能写成端到端提速。初次parse的既有重试在相对时间题真实发生，未说它符合补改严格一次调用门。
- 最终来源一致性/未定状态/重复缺口检查与provenance修正，用相同保存原输出在最终源码重放：`p3-initial-date-status-final-replay.{json,txt}`，真实调用0、inference为空，结果仍17/20；没有把重放毫秒算模型延迟。最终文件`p3-date-p4-action-source-sha256.txt`记录真实最终源码，区别于生成时各JSON中的源码哈希。

### 合同、运行边界与下一步

- `p3-p4-date-action-contracts-final.txt`：66项客户端实际domain/SQLite/React hook及既有动作合同通过；包括固定时区/跨零点、日期格、未知producer/硬件时钟、来源撤销、原手改保护、模型未覆盖输入交给模型及明确拒绝仍拒绝、待办同save身份恢复/不分叉/不接管硬件。它们不是手机真实语义测试。
- `p3-date-default-backend-local-final.txt`：135项本机合同通过。最初pytest缺PYTHONPATH，补后API导入因本机缺torch失败，原错误文件保留；未为此安装重依赖。完整API合同转既有服务器依赖隔离运行，`p3-date-default-backend-isolated-final.txt`最终151项通过，没有安装进生产环境。mock/协议通过不替代以上真实生成失败。
- TypeScript检查成功，`p3-date-default-typescript-final.txt`及`p4-action-entry-typescript.txt`为空。未构建候选APK：5562仍1.3.8/code321，公开manifest仍1.3.2/code315及原SHA。新增是源码/隔离验证，不是安装/发布/物理验收；未操作真机或用户记录。
- `p3-date-runtime-final.txt`核对API PID473253及production cwd不变，ready=true、ASR/LLM队列0、任务queued/running/active leases均0；本轮无服务重启、部署或模型变更。生成前真实Ollama为9B Q4_K_M、ctx16384、9,218,892,416 bytes VRAM，embedding CPU；没有触碰GPU1/PCB等。HEAD仍`89ef1fd3ca5d238a6f4948a2d02309e5247ce3df`、index为空，未提交/推送。

P3没有退出，edit能力仍关闭；明确停止同18/20题的prompt/字段继续微调。下一片核对单次生成的协议执行与有限推理预算，选择能经独立会话检验的执行方式，不用再增拒绝/回问或逐字段调用掩盖。日期执行策略已有候选合同，组合补改/replace及整体语义仍是发布关键路径。P4待办实际主App/非Android剩余迁移、硬件完整旅程，P5的自然语料、24音频、12旅程、主题/速度及正式交付继续开放；本轮未暂停automation-3或恢复旧目标。

## 主线续作：协议运行根因、最后有界补改对照、全端编辑 owner 归并

承接12:38:27 UTC的automation-3。先核对CURRENT、唯一方案、Git、真实Ollama与候选文件，不重做321已闭合的滚轮/撤销/普通恢复。真实用户任务是可靠改动当前日程、从待办继续自己的未保存编辑，以及取消多端第二份旧表单造成的行为分歧。所有文件在同一`output/schedule-editor-20261028/`；没有生产部署、重启或Git提交/推送。

### P3运行根因，不把格式故障误当模型质量

- 实际Ollama 0.24.0、9B Q4_K_M、ctx16384与renderer/parser=qwen3.5。`/api/show`的template虽为`{{ .Prompt }}`，实际renderer读取messages；带system/user对立值的结构探针确认system仍生效。不能据模板推断system被丢弃。核对官方0.24源码`server/prompt.go`、`server/routes.go`与`model/renderers/qwen35.go`；未改模板或Modelfile。
- 实际journal将`failed to load model vocabulary required for format`追溯到`TextEdit.value`的`char{0,65536}`展开：`number of repetitions exceeds sane defaults`，不是已证实词表缺失。小型字符串/中文enum/nullable/maxLength20均能生成，说明不能笼统宣称不支持Schema。原始证据`p3-grammar-cause.txt`、`p3-grammar-boundary.json`保留。
- 候选`LlmProvider._ollama_decoding_schema`在已存在的Ollama传输边界深拷贝Schema，仅移除Schema节点的maxLength解码指导；required、types、枚举、refs、列表上限及字面数据/同名用户属性保留。原始Pydantic仍拒绝notes超过65536、evidence超过2000；输出token预算不变，不新增重试、回退或协议宽松解析。`p3-grammar-provider-contracts-final.txt`27pass；首轮测试把nullable上限误当父节点，修正测试读取到anyOf[0]后通过，原失败保留。不把该修复当语义通过，尚未部署。
- `/chat`的小Schema canary HTTP200但没有遵循格式；现有结构传输`/generate`遵循小Schema。三条完整观察原Schema在推理前失败，适配后可输出合法JSON但仍存在scope/时间语义错误。对应`p3-native-structured-{canary,edit}.json`、`p3-grammar-bounded-edit.json`。HTTP200与JSON形状不能冒充可用日程。

### 有限替代比较及明确停止

- `p3-runtime-controls-canary.json`：presence_penalty=0与默认的三项底层协议探针输出相同，没有收益证据，不改生产采样参数。
- `p3-thinking-sentinel.json`：三个新工程输入的thinking路径均用完2048 tokens，约19秒且最终content为空；未启用thinking，也未保留新的产品开关。只保存reasoning字符计数，不持久化思维正文。
- 原18题after-state使用已修正的真实grammar再做一次有界比较，严格2/18，`p3-after-state-grammar-real.json`。问题仍是错值、缺依据、改错端点，而非JSON fence而已。停止after-state方案，活动工具/远程临时代码移除，失败源码只在output供追溯。
- `p3-native-tool-canary.json`三个独立输入均失败：tool arguments变成嵌套字符串、提醒单位算错、指定钟点当平移或回填旧字段。没有执行任何tool、增加原生tool传输或把字符串强制转成对象放行。
- 显式隔离进程用已有云端qwen3.7-flash作同协议参照，`p3-cloud-reference-real.json`严格10/18，约0.7–1.3秒/服务函数。duration换算后失去逐字来源、scope=range含义易误解、period清空和未定未处理等共同失败，说明不能简单归因“9B太小”。未持久修改Provider配置、没有自动云端fallback或生产切换。
- 最后回到计划的直接typed patch，不经过中间时间操作语言。先冻结20条新独立输入`tools/quality/schedule-editor-patch-holdout.json`，SHA `8156b4d5c5f00d14e5a42d7b0a59c752f9881ea3d9b9e3edf29b01702017da2d`，之后才编写诊断prompt。每条含author/provenance、固定当地参照、不同当前draft及人工独立期望；weekday用独立calendar核对，不从被测parser产标签。`p3-patch-holdout-register.json`语域预算通过，但仍是authored_boundary，绝非自然盲测或真人评分。
- `p3-direct-patch-holdout-real.json`为20次真实调用、严格12/20，不达95%。包括“两点”误成period、跨日钟点带错格式、周日下午解释错日期和时段、20分钟提醒变120、备注替换丢掉其余内容、明确日期误回ambiguous、同组起止拆为重复变更。没有放宽期望/剥壳/修补样本；本方案不采用、不继续调这20题。仅此服务函数p50=2313ms、nearest-rank p95=3236ms，不能作手机端速度通过。诊断脚本仅留`p3-direct-patch-frozen-probe.py`在output；远程临时脚本已删，无活动新fallback。
- 既有探针补记`provider_request_attempts`（调用前计数）、成功原响应数、零网络重放与Provider源码SHA，避免传输失败被记成“未尝试模型”。支持每条固定时区/参照和mode；不改变旧结果文件或将回放称真实推理。

P3仍失败且能力关闭。协议指导的语法问题已有候选修正，语义问题没有被掩盖。上面的每个方案都保留明确失败，后续不能再次用旧18/20题微调同路线凑分，也不能直接换云端宣布解决。

### P4替换旧 owner，而非再加一份新编辑器

- 将原Android已验证的`AddEventScreen.android.tsx`移为所有平台唯一`AddEventScreen.tsx`，删除原非Android第二套表单/提交状态。Android适配`ScheduleEditorSurface.android.tsx`只把现有snapshot/action接到原生LaojiCalendarEditView，不改原生EditText/手势/录音底层；RN `ScheduleEditorSurface.tsx`只展示和发语义动作，不持有另一份可保存草稿、解析器、事件writer或请求身份。
- 非Android日历global plus、明确日期/slot创建、既有事件编辑均改接同一个`useScheduleEditorEntry`/恢复sheet。全局plus不再无声继承浏览日；收到硬件输入沿用现有导航owner。不保留新客户端旧clarify/确认/详细编辑跳转。删除1406行旧VoiceInputModal及放射菜单专属状态、样式、回调；`ScheduleCreateButton`只留一个48dp创建动作。删除数量只是清理证据，不是体验收益评分。
- RN时间展示替换全天/5分钟取整旧子页，使用未设置/period/exact、0–59分钟及按需结束。打开/取消不修改主草稿，09:23保留；结束早于开始明确拒绝，不自动改次日。子编辑仅合并相对打开基线实际变化的字段，不让旧全量snapshot擦掉晚到标题/备注。实际事件合法性仍由同一domain/save owner校验，子页不直接写事件。
- 非Android底层原本就没有原生录音器，旧fallback最终同样调用native转写；本片未虚构其语音可用。现共用hook在缺能力时明确给可输入文字的结果，不再无响应；真实Web/iOS录音不在通过项。没有为了清理而增加第二个采集/ASR服务或新的fallback。
- 仅修改现有UI skill的owner引用和旧非Android待迁移描述，使用skill-creator校验通过；不加新规范。保留原domain、SQLite、底层录音/WSS、315旧服务兼容和真实数据。

### 合同、Web真实失败与322产物

- `p4-shared-owner-contracts-final.txt`60pass：原domain/真实SQLite、入口、异步/来源/recovery-auth合同及新增RN真实React组件状态测试。新增5项只把RN hosts/theme/navigation当明确seams，覆盖同一输入实例、minute23、无结束占位、取消、period/unset、子页不覆盖后来手改、跨日需明确选择与已退役路径；不是物理IME/真实滚动或语义质量通过。`p4-shared-editor-typescript-final.txt`成功；`p3-p4-aggregate-backend.txt`162pass，含新Provider/时间编译/parser/graph合同。
- 原continuity50pass；构建内known UI17pass和continuity通过。`p4-shared-ui-inventory.txt`是审查候选而非零冗余/语义通过。首次TypeScript导入错label/token及漏a11y参数已修正，原失败日志保留；不放宽合同。
- 首次Web导出失败指向已有SQLite Wasm，实际文件存在但Metro未登记wasm资产类型。只在原Metro owner登记后`p4-shared-editor-web-build-final.txt`完整导出成功。真实全App在临时localhost/浏览器启动却显示`LAOJI-START-RUNTIME`，console定位`calendar.ts`模块加载无平台保护调用requireNativeViewManager；`p4-web-runtime-failure.txt`留证。不把export或组件合同当Web/iOS运行通过，不为此另建harness平台。临时浏览器/localhost服务均关闭，未操作其他浏览器窗口或用户数据。
- 聚合构建`candidate322-build.txt`成功2m2s，版本1.3.9/code322、x86_64单ABI，既有签名/HTTPS合同通过，已覆盖5562。APK `laoji-1.3.9-322-x86_64-release.apk`46,703,913 bytes，SHA `33081d1ebd1f7b6e9b7f241a5615c968e6eabe8a314e82136ce76a2e1d1595c8`；dumpsys及完整读取已安装base.apk SHA一致。不是arm64正式发布，正式manifest仍1.3.2/315与原SHA，本轮没有重复完整下载旧315凑交付证据。

### 322真实主App待办恢复与清理

- 新plus选择新建直达原生统一空编辑，未设置钟点、提醒不虚构，四主题中的当前夜航保留。`candidate322-editor-ui.json`与实际查看的全页`candidate322-editor.png`确认仍是原生fields/dock，不是空View或RN占位。空草稿取消后退出，未保存事件。
- 对现有“三分钟项目介绍”的第一条待办，通过正常“创建后续日程”进入同一编辑器；用实际ADB IME将**未保存草稿**标题改为“整理问卷并核对回收数量”。普通取消后从同一待办再次进入，只出现该待办的手改草稿，没有另建save身份的选项；恢复后标题原样保留。通过既有“放弃草稿”明确退役本轮自己的测试草稿，再次看到原待办内容/状态未变、医院复查和读书讨论会仍在，没有点击事件保存/删除或修改待办。
- `candidate322-action-journey.{json,txt}`及各阶段`candidate322-action-*-ui.json`记录实际release UI与持久恢复，不等同模型/ASR/物理通过；复用现有Phone读取/操作helper，不改产品加测试入口。此前321普通/既有事件恢复证据继续有效，不重复声称全P4退出。
- `candidate322-entry.mp4`1,065,642 bytes，封装196.384秒而screenrecord参数160秒；和此前一样只可审阅内容连续性，不能由该PTS推算首绘/真实等待或性能达标。sdcard录像已pull后清理，无剩余screenrecord；本轮当前主题和原IME不改，最终停在日历。没有操作真机、板或用户原会议/日程。

### 运行与下一片

`p3-p4-final-runtime.txt`确认生产API仍PID473253和原production cwd，ready=true，ASR/LLM/持久任务队列与active/expired leases为0；9B仍GPU0/9,218,892,416 bytes VRAM/ctx16384，embedding仍CPU。本轮候选推理不等于再验证生产ASR，未重启/迁移服务、切换生产Provider或改GPU分配。HEAD仍`89ef1fd3ca5d238a6f4948a2d02309e5247ce3df`，index空，无提交/推送。关键最终源码SHA在`p3-p4-shared-source-sha256.txt`。

有限边界：P3的可靠组合补改/replace与初次整体质量未过，禁止发布/启用失败能力；P4源owner归并和Android待办恢复已有限闭合，非Android实际启动/语音及硬件完整交接仍开放；P5独立自然/24音频/12旅程/主题与速度及正式发布仍开放。下一轮从已记录的真实未闭合owner继续，不重复旧模型实验、已关滚轮/恢复/auth和旧A–F/Q2/固件目标；automation-3继续ACTIVE，未宣称计划完成。

## 主线续作：真实平台退出修正、合成音频部分失败及初次标题接纳缺陷

承接14:00:56 UTC的automation-3，核对唯一方案、CURRENT、脏工作区及322已完成状态。真实任务是打开/退出统一编辑、把完整语音事项填入同一草稿，而不是再比较旧18/20题的补改prompt。未新建会话或子代理；没有提交/推送、生产部署、服务重启或物理设备操作。本节全部文件位于`output/schedule-editor-20261028/`，除明确源码/测试路径外。

### 323前聚合的真实退出与平台边界修正

- `modules/laoji-native-platform/src/calendar.ts`沿用其他native模块的Android平台保护：只在Android注册真实LaojiCalendar，其他平台不在模块加载时触发不存在的native view。实际Web由此前启动报错进入日历；这不是Web日历交互或iOS支持通过。
- 真实Web进入统一编辑又暴露`addNativeRecorderTranscriptListener`调用不存在的native recorder。`useScheduleEditorInput`现在仅在`hasNativeRecorder()`成立时获取listeners；缺能力仍允许手动/文字，尝试录音按原合同明确不可用，不制造假录音或备用ASR。
- 实际恢复页发生旧草稿读取失败后无法取消：退出反复flush未读的placeholder。`AddEventScreen`允许尚未读到/读取失败且不可写的恢复页直接离开；`useScheduleEditorDraft`不在该状态退后台/卸载时重启读取或写入。原始未读数据不删除；新草稿及已经读到的可写草稿仍要求持久，不把异常都吞掉。
- `schedule-editor-restore-exit.test.cjs`实际React owner测试覆盖读取中/失败取消、系统返回、新建/已载入保护及失败后台不重复读写。首轮4/5中一个fixture把路由seed原话误当已读持久内容，修正测试seam而非生产逻辑后通过，原失败保留。与原domain/SQLite/入口/输入/client/surface聚合共67pass，`p4-platform-restore-contracts-final.txt`；TypeScript成功。此前Web日历/录音listener测试分别6/20pass，均有限合同而非全平台验收。
- 三次对应Web导出成功；实际最后一次失败恢复页点击取消已返回日历。但Web的SecureStore接口与本地存储运行缺口仍未闭合，不能说Web/iOS或其语音可用，未新增明文身份存储。停止扩张跨端port；临时IAB页和18351 localhost服务已关闭。
- 聚合323构建成功2m20s并覆盖5562，1.3.10/code323、46,704,125 bytes、SHA `ec3c756886972edde8b89852b2257e2d5ce3443351bfcecf7b82aa4faad19051`，实际安装base.apk SHA一致；只为x86_64候选，未公开。

### 冻结音频与真实回放失败，不将工具成绩混作质量

- 使用natural-schedule-utterances skill先冻结24条工程诊断及独立预期`tools/quality/schedule-editor-audio-24.json`，SHA `25c5a421692aa77d645ed4ed1c3ea4783f205b73536998cb8128a55c93399bce`。每条为authored_boundary、非自然benchmark；日期使用独立日历oracle与每次按键前的设备时区/时间计算，不从parser产标签。register零违规不是自然度/人工评分通过。24条全部带日期、13条非整点/半点精确分钟，属于精度压力而非真实分布；不能覆盖省日期核心旅程。
- 24条TTS均成功生成，`audio24/manifest.json`保存原文、Xiaoxiao声线、edge-tts 7.3.1、16kHz单声道PCM及逐文件SHA，23/24有额外首尾静音。最初候选venv无pip，改用已有uv将依赖仅装入output/tts-deps；未改生产/共享环境、未把音频/依赖打包APK。TTS原文只含自编测试，不含用户录音。
- 回放复用现有Phone helper、普通创建/录音手势、真实AudioRecord及公网WSS，不注入文字或App状态。只将明确`-port 5562`的QEMU PID1432847/source-output14238接到本次私有null sink，未改全局默认源或其他设备。记录播放退出码和播放期间source/cork状态，但它们不证明实际采集PCM、服务收到的字节游标或端到端完整性。
- 首次preflight因测试把“添加主题”placeholder误当非空而停止，未录音；只清理自己的空草稿，保留`*-preflight.{json,txt}`。随后音频01–07共7次真实普通UI录音：02/04/05逐字去标点后完整；01/06空，03/07缺尾。后四条尚缺实际PCM→服务接收→终态合并的边界证明，不能直接归因于ASR模型或服务丢尾，尤其`source_end_ms`不是音频送达游标。
- 01失败后仅对5562执行已有console `avd hostmicon`，并将后续回放改为等待实际QEMU uncork后重确认私有路由再播放；此前319也执行过hostmicon，没有独立保留下来的初始开关读值。02成功不足以区分开关、路由/播放时序或服务边界的因果，未声称定位根因或将其当修复。没有更改其他模拟器或宿主全局麦克风设置。
- 完整转写3条中，323只有02的标题/日期/时间全对；04变为标题“记着”、05为“定”。它们是已证实的初次解析错误。其余空/缺尾不和这三条混成语义准确率。`p5-audio-partial-summary.json`保留所有7条的实际ASR、最终字段和audit；总字段1/7只是该工程回放结果，绝不是人声/自然语义正确率。
- 原生audit起采14–281ms、stop drain444–1987ms，未据7条小样或UI自动化观察上界宣称p95/速度目标通过。实际App路由和逐条模型attempt未取证，保持null/unknown，不按最终文本/parse_source猜测。服务函数/直接ASR不替代这份实际失败。
- 批量工具分别在07前、08前的异步恢复菜单过渡态停止；后者后来确实进入自己新建的空编辑，不能将截图时菜单还在认作App不能打开。未继续反复修脚本盲跑23条；08–24未实际录音。只退掉该空编辑，未选择/删除菜单中原有三份草稿；所有已录本轮草稿均明确放弃，未保存测试日程。Pulse source恢复4758、临时模块卸载；最后回到日历，医院复查和读书讨论会仍可见，无活动录音/私有音频路由残留。

### 初次标题的结构性修正，以及324暴露的分钟失败

- 对04/05的完整ASR作纯本机零模型重放，`p5-audio-local-replay.json`记录此前parser SHA `5dc8ebfb8faf900c3bb1578bfec159e04419e88614f18d0b86cd012c1a3ae224`：确实产生错误标题并标local_safe，不只是9B推理差。复用原测试的theme-only seam，未mock parser；第一次直接加载theme牵入expo-modules-core失败，不以此作为解析结果。
- 根因是`normalizeTitle`按逗号首片或宽泛元数据边界截断，而local_safe只据日期/钟点与已有复杂性信号，没有检查未承接的尾部。候选将原边界正则抽为同一个常量，不改其识别词；在既有route owner检查去时间标记后仍有多个内容分句，或被当元数据截掉却没有地点/描述承接的尾部。此类原句交已有graph producer，不再认证为本机完整结果；不猜新标题，不加“记着/定”黑名单、动作词或样本补丁，不新建Provider/fallback。
- `p5-title-owner-contracts.txt`聚合68pass，覆盖上述结构、其他分句与仍可本机处理的简单输入；TypeScript成功。它证明接纳边界，不证明模型会正确接手。最终源指纹`p4-p5-source-sha256.txt`，parser变为`553c7757e5b3390198324e580f6a4b2ee3279ff4e20391e805847205cce0c8c9`。
- 必要的Android真实复验构建324，1.3.11/code324、46,704,489 bytes、SHA `37e8afd3af07d8ecc2dfdcda3b5d2c712b7e84cd455ac31168869f71b9586f78`；1m51s构建、签名/生产HTTPS配置和原known-UI/continuity合同通过，已覆盖5562，`candidate324-installed.txt`的dumpsys及完整base.apk哈希相同。
- `p5-title-ui-canary.{json,txt}`只用04/05原完整转写，普通文字输入→应用→字段，不声称是新盲测或音频。04标题恢复“送洗窗帘”，但**10:01变成10:00**；05为“拿蛋糕”/10月30日/12:10正确。严格字段仅1/2，不能把标题2/2当整个修正通过或发布依据。观察上界7.344/6.744秒含UI取证等待，不作模型/首绘延迟。逐条真实模型attempt仍未独立取证，保持unknown。
- 两次文字复验草稿已按原UI明确放弃，原两条可见日程保留。没有改prompt或扩大可接受标题/分钟标签来凑分；没有把已被确认的规则分钟值与另一份模型值盲目拼接，精确时间来源和原子应用仍需下一片在真实owner闭合。324保留为失败隔离候选，不正式发布。

### 当前运行、剩余与止损

`p4-p5-runtime-20261028.txt`只读确认API PID473253/原production cwd不变、ready=true、ASR及LLM队列0，9B仍GPU0/9,218,892,416 bytes VRAM/ctx16384，embedding CPU；未重启/切换任何服务。真实音频请求取得ASR推理记录，但不据health声称丢尾已排除。公开清单再次读取仍1.3.2/315及原SHA/46,007,111 bytes；本轮无正式新包，所以未重复完整下载旧315充当新交付。

下一片有限顺序：先闭合初次输入结构性内容丢失与明确分钟的证据归属，以及空/缺尾音频的真实采集/接收边界；不重复调整旧18/20题prompt。随后回P3可靠组合补改/replace，不用本轮标题或单条ASR成功开启edit能力。24音频余17条及省日期/明确未定/当前草稿补改重说语音旅程仍开放；P4硬件/非Android运行，P5自然语料、12完整旅程、全主题/速度与正式交付未过。HEAD仍89ef1fd，index空，未提交/推送；automation-3保持ACTIVE，不恢复旧A–F/Q2/固件或新增测试平台。

## 主线续作：分钟归因纠正与采用、实际PCM边界和WSS聚合失败

承接15:10:27 UTC的automation-3，执行跨至2026-10-29。本批真实任务是完整输入填入同一草稿；没有重做滚轮/撤销/旧P3模型实验。本节文件均在`output/schedule-editor-20261028/`，没有Git提交/推送、真机操作或正式APK发布。

### 精确分钟是词法错误，不是已证明的模型错误

- 读取原生产parser，SHA `7fdd1b2f402f8bf98745e21e3dea9da24636ff4a157aeb02dca91aeb3122a694`。原`_TIME_TOKEN_PATTERN`和`_parse_time_token`缺少零/〇和三字中文分钟。真实模型原响应已给`time_phrase=上午十点零一`，旧normalizer才变10:00；纠正上一节及此前CURRENT“模型改分钟”的归因，不能再重复该断言。
- 仅上述两个lexer改动，AST核对其他top-level owner完全一致。`p5-minute-isolated-real.json`包含两条已知工程输入各一次真实生成与同原响应零调用重放，04由10:00恢复10:01、05保持12:10；280种机械词法变体原失败108、候选失败0，非法60分仍拒绝。这些是词法/已知回归，不是自然语义得分。
- 原生产85项合同通过，`p5-minute-production-contracts-final.txt`；隔离测试第一次缺pytest，复用原有候选test-deps后通过，未装入生产。活动仓库新增十项分钟边界回归，连同原候选日期合同共103pass，`p5-minute-source-contracts.txt`，不把未采用日期逻辑混入生产diff。
- `p5-minute-before-maintenance-gate.txt`及采用脚本再次检查任务/租约/ASR/LLM队列均空，原子替换两个owner后只重启API。PID473253→2654800，停启约24秒；新parser SHA `3900073f4342c3f2d5e2d0e58a6299d1da4a917749fd9ad12b23d0ed3f0a86f4`，cwd不变、ready=true。`p5-minute-adoption.json`确认已采用且未回滚。ASR8030、Ollama21434、模型与GPU分配未动；P3 edit/Provider/schema/date-default等其余候选未部署。
- 首次正常App复验被模拟器auth超时阻断。公开graph无鉴权401、auth空body422/未知设备401只证明路由/拒绝边界，不证明真实会话成功。一次临时5562代理对照仍失败，已恢复`:0`；未重置设备身份、密钥、注册或数据。系统shell Java TLS探针后来ready200/auth422，临时dex已删除。恢复原网络并重启App后，`p5-emulator-network-restored-audit.txt`取得真实挑战/令牌/能力/graph均200，普通文字输入“送洗窗帘”/10月30日/10:01严格正确，草稿明确放弃。未证实先前超时根因，不包装成代码网络修复。

### 原生PCM、服务接收和真实录音不是同一证据

- `p5-audio-byte-boundary.json`将此前7次native字节统计与服务端privacy日志按时间窗和唯一字节数关联，逐条一致。没有服务session-ID关联或PCM内容hash，不能排除内容/路由问题；`source_end_ms`仍不是音频送达游标。
- release App不可run-as且设备非root，未尝试提权或导出其私有媒体。复用已安装debug test-host的现有`RecorderCaptureInputProbeTest`，真实AudioRecord/SCHEDULE/LOCAL_ONLY采12秒PCM。`audio03-native-boundary.json`：192000 samples、RMS3672.67、peak30230、50ms包络相关0.9613、lag800ms、WAV SHA `1f6d2d12eaf9363d271bd88ddace7fdfd47b8b2401ddd255397c86abed2aff3c`。不是当前release/WSS、逐字或真人质量验收。
- `p5-pcm-vad-boundary.json`在隔离进程加载当前生产StreamingVAD与CPU Silero JIT，仅调用现有8030；原合成wav及上述采集wav均为一个完整段，分段ASR和全PCM ASR都完整识别“安排十一月四号下午两点零三看牙”。原输入/采集段start分别112/912ms，duration均4336ms，四次ASR约348–427ms；不是网络/端到端速度。首轮导入未设置DATABASE_URL失败，明确改隔离内存库后重跑；未使用生产DB或新增服务/常驻模型。
- 随后324普通UI/AudioRecord/公网WSS的单条audio03回放完整填入“看牙”/11月4日/14:03，起采49ms、stop drain755ms，`p5-audio-ui-03-03-324-boundary.json`。该已知回归有限通过，不替代24条/自然语义/物理讲话。

### 聚合WSS失败，停止把传输失败混进模型质量

- 324全批实际完成audio01–20录音尝试，21在新建菜单过渡处停止、未录音，22–24未执行，`p5-audio-ui-01-24-324-full.json`。20条均未填成日程：01只到“记一下，后天早上”，stop drain10031ms并需恢复；02–20均无终态文字且需要恢复。全部本轮已录草稿明确放弃、未保存测试事件；原2事件/3草稿保留。此失败不能称20条真实语义不合格，也不能拿空结果算模型准确率。
- 服务端journal证明01连接接受后只收到184000 bytes，native统计272000 bytes，随后断线；02–20没有到达该WSS处理器的连接记录。现有native层把Throwable统一抹为连接不可用，缺DNS/TLS/connect/HTTP/stream归因。只读ready显示队列空、最近ASR仍为01，不能据此声称公网WSS正常。没有调整VAD/ASR参数或加timeout/重试来掩盖。
- 因此在现有AudioProtocol/RealtimeAsrSocket补固定枚举的native失败审计（阶段、DNS/TLS/connect/timeout/protocol/io、HTTP状态），不记exception message/URL/凭据/正文，不改变重试、鉴权或UI文案；补嵌套cause/循环及隐私合同。诊断候选325正在构建，未安装、未发布，不称用户体验改善。后续只做有界真实复现读取该owner，不再盲跑同一24条或继续修批量工具。

本轮P3仍失败/能力关闭，P4/P5其余缺口保持；正式315未变。临时Pulse路由已恢复4758、模块卸载、无活动录音。automation-3保持ACTIVE，不恢复旧目标。

### 325产物、网络边界与模拟器快照事故（最新，覆盖上面的设备运行状态）

- `candidate325-build.txt`：1.3.12/code325的x86_64 release构建3m8s成功，正式HTTPS/签名配置检查通过并覆盖5562。46,704,489 bytes，SHA `54bdee91b8f05ecc526c9e9a4527256abc2a2c0b34d907f1c789a54fc31312a4`，`candidate325-installed.json`对完整安装base.apk核验一致。原生`AudioContractsTest`3pass，`p5-transport-native-contracts.txt`；这是诊断源码的有限合同/安装，不是修复ASR或正式发布。
- 325只复现一条已知audio01，仍空文字且需恢复，已放弃本轮草稿。没有取得native onFailure回调；静态核对RecorderEngine在连接总期限到达后先cancel，因此不能把未出现分类日志解释为网络没错。没有继续加探针APK、延长timeout或反复跑24题。既有批量工具已在清理自己的失败草稿后遇到未恢复传输即停止，避免再次将20条相同传输失败混成语义回放。
- `p5-emulator-address-boundary.txt`：系统Java TLS现在ready/auth请求同样超时；虚拟TCP connect返回不证明公网TLS已建立。电脑同一时刻直连ready200约2.13秒，临时host proxy本身也超时，不把代理作为已验证方案或持久配置。5562 proxy恢复`:0`。公网manifest `p5-public-manifest-final.json`仍315/46,007,111 bytes/原SHA；本轮没有发布新APK。
- **我在诊断时重启5562，错误沿用了只有`-no-snapshot-save`的旧启动参数。它禁止保存但不禁止启动加载快照。首次启动日志明确加载`default_boot`（2026-08-16），后续真实dumpsys变为1.0.6-source-preview/code106。近期测试环境已发生回退，当前不能再声称原2事件/9会议/3草稿或325仍在设备上，更不能用重装候选冒充恢复。该事故是本轮操作引入，不归因用户、ASR或服务器。**
- 发现后立即force-stop旧App并停机；未清数据、wipe、重注册身份或操作真机。`/home/yydd/LaoJi-backups/emulator5562-snapshot-incident-20261029/`保留**事故后**userdata/key及各自backing镜像，userdata约6.4GiB物理占用、SHA `cb8b622cb27c48e42b4357cddb38785149ca3abdc2d9ff239684ae3cd97419ea`，key SHA `ada7aa6c7b4e89075449e26b12c7242380aac3cb6b29e59a5cc41a6e02601707`。这只是保全残留，不是事故前数据库恢复点。此前P0备份只有源码/APK，不能用于恢复模拟器私有业务数据。
- qemu-img只读check发现21个泄漏cluster；未对保全镜像做修复。只读扫描残留L2元数据，另复制工作镜像尝试恢复一组映射及key，并仅在副本修复引用计数。结构检查零错误，但同一5562使用该副本冷启动后仍是106，**恢复失败**，未将候选映射写回原AVD。失败工作镜像及临时overlay已清理，仅保留一份事故保全镜像和小型复现/扫描记录；没有继续猜测映射或格式化。`p5-qcow-{readonly-map,key-readonly-map,recovery-candidate-final,recovery-references}.json/txt`记录边界。一次大文件hash探针误用read_bytes，已在写映射前中断并改为流式digest；未把中断结果当恢复校验。
- **5562最新为停机保全，近期数据尚未恢复，存在丢失风险；不再自动启动旧环境或继续UI/语音验收。** 活动启动入口`package.json:android:emulator`已固定5562并禁用快照自动加载/保存；既有Android构建合同新增回归，4pass，`p5-emulator-launch-contracts.txt`。这是防复发措施，不是数据恢复证明。
- API仍PID2654800、分钟lexer SHA不变、队列/租约空；ASR PID2377671未重启，9B仍GPU0/ctx16384，embedding CPU，生产OpenAPI没有graph/edit。`p5-minute-final-runtime.txt`、`p5-last-ready-after-emulator-incident.txt`为最新只读证据。仅清理本轮上传的两份自写音频和PCM探针；没有变更生产模型、数据库或其他服务。

续接优先：保全/恢复模拟器，不能将数据重建当恢复；同时可推进不依赖它的P3源合同和独立质量方案，仍禁止重调旧18/20题、开启失败edit或发布聚合候选。P0–P5未完成、automation-3继续ACTIVE；未提交或推送Git。

## 主线续作：重新输入的完整替换合同（2026-10-29 08:45–09:00，本机源码）

本批承接`automation-3`的00:45:45 UTC输入。先核对CURRENT、同批quality、唯一方案、两项LaoJi skill与Git：HEAD仍89ef1fd，505个脏条目、index空。5562无运行进程/ADB设备；继续停机保全，没有新恢复证据，不再猜测磁盘映射，也未重装、重注册或清数据。真机与生产未操作，不重做325或已闭合输入控件。

### 真实问题与替换范围

“重新输入”已有明确replace操作，但`observeScheduleEditorInput`将它与patch一起发给graph/edit。该协议只返回本次提到的字段，编译器从当前草稿起算且会丢掉等值变更，因此无法保证整体替换：新句没有说地点、备注、重复或提醒时旧值继续存在；不能靠强迫模型为省略字段伪造clear原话解决。

- 在现有输入owner改为initial/replace共用一次`parseText`及初次映射，只有patch进入当前草稿编辑接口。replace只带本次表达、固定reference/timezone，不把旧草稿内容当生成上下文。省略日期使用该时区本次输入日，明确未定保持null；旧手改日期不冒充新输入的入口上下文。没有新Provider、重复规则解析、模型重试或额外链路。
- domain要求replace提议包含全部12个可编辑内容字段；先整体校验再应用，缺项/非法不部分改写。新内容清掉旧全天兼容flag；草稿id、eventRef、事件revision、重复编辑范围、来源job、saveRequestId保持，不能变成新建第二条。录音开始、解析等待、失败及取消期间旧内容保持可见；原operation/CAS保护不变。
- 一次撤销保存完整替换的逆变更，包括值恰好相等的字段来源；否则原手改标题虽字面相同仍无法正确恢复manual所有权。旧全天flag的独立变化也计结构revision，撤销可恢复，但后续手改时间/其他字段仍优先。未增加第二份草稿或存储表。
- 清除尚未采用的server replace语义：请求Schema仅允许patch、客户端拒绝initial/replace误发、删除两句replace专用生产提示词。候选producer revision改为`schedule-current-draft-edit-v1-patch-only-temporal-spans`。这不是重新调旧18/20题prompt或声称P3语义改进。
- 对应修正唯一方案7.2/8.3；没有另建规则文档、技能或测试平台。保留现有初次解析、部分补改、来源job和事件提交owner；不删除315仍在用的服务接口。

### 验证、原始失败与边界

文件均在`output/schedule-editor-20261028/`：

- 新增合同先在旧代码执行，`p3-replace-contracts-before-final.txt`：53项中8项明确失败，含不完整替换被接受、旧全天flag未清及路由错误。最初直接service测试的未解析edit seam导致挂起，只终止本次测试子进程；将同一deferred同时提供给两个显式transport seam后得到有限失败，原`p3-replace-contracts-before.txt`保留，不当作App故障。
- 修正后`p3-replace-contracts-after.txt`53pass；补实际SQLite close/reopen/恢复/撤销并聚合既有surface和restore-exit后，`p3-replace-aggregate-contracts.txt`65pass。覆盖新表达不带旧内容、固定跨零点日期、明确未定、完整重置、事件身份、取消/失败/手改/CAS、一次撤销、原生语音hook的同一owner接线；ASR、系统与transport是明确seam，不是真实录音或语义评价。
- `p3-replace-backend-contracts.txt`完整API组收集失败：本地API导入链缺torch。没有安装大型依赖、伪造torch、调整生产或把未执行组计通过。独立既有纯后端组`p3-replace-backend-pure.txt`30pass，包含patch-only Schema拒绝replace/initial/delete；不据此声称完整HTTP验收。
- `p3-replace-typescript.txt`TypeScript通过；`p3-replace-known-ui.txt`原17项已知UI回归通过。未改页面几何/主题/动画或新建状态条。copy inventory将domain/service判为非UI、0文件被扫描，`semanticVerdict=review_required`，**不把0候选当作UI语义审查通过**；新异常沿用现有输入错误owner，不另加说明或弹窗。没有可用模拟器，因此没有本轮页面/性能通过结论。
- `p3-replace-source-sha256.txt`记录10个实际源码/测试文件指纹。候选未构建、未安装、未部署、未发布；版本仍325源码基线，公网/上次真机315不变。没有Git提交或推送，index仍空；没有操作GPU/模型/服务、其他模拟器或用户记录。

P3总门保持失败/关闭：本批只闭合replace的本机内容/身份/逆变更合同，不证明初次解析的17/20已改善，更不证明可靠组合补改。继续项仍为不同输入的可靠补改、语音传输与完整内容回放、全入口聚合、自然语料/12旅程/四主题/速度及正式产物；旧18/20题的同方案调prompt已经停止，不重开。5562数据恢复仍未解决；若无新恢复证据，保持原镜像停机，不用重建数据冒充恢复。automation-3保持ACTIVE，未宣称P0–P5完成。

## 主线续作：无效观察的安全边界、独立5562及326部分回放（2026-10-29 09:16起）

本批先核对唯一合同、CURRENT、quality、Git与两项LaoJi skill；读取natural-schedule-utterances及来源参考后仅复用已冻结工程样本，不生成/宣称新自然语料。不新建会话或子代理，不重复已闭合滚轮、撤销、恢复/auth及旧补改模型实验。以下文件均在`output/schedule-editor-20261028/`。

### 初次观察：不把重复改成单次，不把内容失败冒充服务故障

保存的真实模型原响应中，每日散步的event_type已是daily，但缺recurrence_phrase；原normalizer有意不信任缺依据的重复，却把event_type改为once。统一编辑忽略旧wizard的全局needs_clarification，之后手填日期即可误存单次。这不是可以直接信任无依据daily的理由，也不能归因“模型根本没识别每天”。

- 候选`_normalize_model_only_result`在声明重复却无有效来源、来源虚构、规则无法表示或event_type非法时不返回另一份once安排；有效引用仍复用既有规范化owner，没有扫描原句补重复、关键词判意、新推理或额外重试。删除不可达的recurrence_unsupported降级/提示分支，没有保留第二套实现。
- Graph及旧clarify的空观察原被抛成ScheduleParserUnavailable。候选改为422/SCHEDULE_MODEL_NO_RESULT，复用客户端已有内容错误映射；真实Provider异常仍503，不向用户暴露原异常。没有改页面/增加状态说明或弹窗；旧草稿/本次文字由原hook保留。唯一方案7.1补充这项合同。
- `p3-recurrence-content-before.txt`新增防降级合同先明确失败（5 fail/103 pass）；修改后纯后端聚合`p3-recurrence-content-after.txt`139pass，客户端`p3-content-client-aggregate.txt`57pass。它们是安全/读写/错误边界，不是语义得分。
- 为补本地无torch导致的上一轮完整API缺口，在服务器自己的临时候选目录用独立源码/DB和现有Python3.12/torch运行目标组。pytest及纯Python依赖仅复制到候选目录，未修改生产venv；初次漏带py.py，`p3-content-isolated-api.txt`保留，补该纯Python兼容模块后`p3-content-isolated-api-retry.txt`161pass，含真正FastAPI/TestClient路由、鉴权seam和mock模型，不是公网/真实模型语义通过。源码包/依赖包SHA逐字核验。取回证据后服务器候选目录及测试依赖已删除，未起隔离监听进程。
- `p3-content-replay.{py,json,txt}`对既有20条原模型输出零调用重放仍17/20；每日重复从错误once变为无效观察，严格失败数没有被改好看。`p3-content-real-http.{py,json,txt}`另用当前模型真实调用经过隔离HTTP：每日重复原调用和原有repair各一次，仍缺依据/非法类型，最终422，严格失败、3.164s；每周二傍晚游泳对照一次调用成功、2.089s。仅身份鉴权为seam，模型调用是真的，但不是手机/公网HTTP验收。没有声称安全拒绝等于正确解析。
- 随后仅在output比较一次小型联合Schema约束，沿用原prompt、同一9B/ctx16384、不换模型、不增加生成轮数。`p3-observation-schema-canary.{py,json,txt}`中每日恢复，但每周对照漏掉傍晚，1/2、没有整体收益。已停止，不接入活动parser、不调这两题prompt、不改标签；试验代码仅作失败证据。生产prompt和Provider未因此变化。9B仍9,218,892,416字节VRAM/ctx16384，embedding CPU；没有新常驻模型。

### 原盘未恢复；一个独立临时测试环境不是数据恢复

原5562与事故副本继续保全。为避免把“不能动原盘”错误扩成“所有独立Android工作永远停摆”，使用同一个AVD硬件/5562端口、但另指定`emulator5562-isolated-data/`作为所有userdata/key/SD/cache路径；不启动原盘、不导入原身份、不重置原注册或清旧记录。

- 启动采用`-no-snapshot -no-snapstorage -read-only`，独立datadir/data/key、缺省SD卡指向该独立目录且不挂原卡，no-cache。仅一个LaoJi QEMU PID1193151，没有操作5560。新盘首次启动无com.laoji.app；这是清洁测试环境，原2事件/9会议/3草稿没有恢复。
- `p5-isolated-canonical-before.sha256`在启动前完整读取原userdata/key，仍分别为`cb8b622c...19ea`和`ada7aa6c...1707`；启动后及末尾再次完整核验均OK，见`p5-isolated-canonical-after.txt`及`p5-isolated-canonical-final.txt`。事故副本未写。启动日志`p5-isolated-emulator-launch.txt`保留完整参数和冷启动信息。read-only临时环境退出会丢弃本批临时App数据，不把它当持久恢复点；后续不能直接执行默认原盘启动命令来延续这份测试身份。
- 复用已有shell TLS probe，不新增测试平台。`p5-isolated-emulator-network.txt`真实ready200/1.098s、空body挑战422/0.976s；只证明HTTPS/拒绝边界。临时dex已删，没有凭据/令牌/用户正文。
- 326聚合构建1m51s，版本1.3.13/code326，x86_64-only 46,704,853 bytes，SHA `7fd9afa3bdb2d12d9d8f6d97ed2ea8701db845eb29ef0d0b8e8a209ed530000c`。`candidate326-build.txt`及`candidate326-installed.json`核对完整base.apk一致。它包含上一轮replace合同，但没有arm64/公开发布，也不含服务端本轮候选采用。只在新临时盘授权麦克风并跳过提醒opt-in；原手机/原盘权限和偏好未改。新测试盘按正常流程自动注册新身份，没有修改旧身份或重置服务器配额。

### HTTPS成功不等于WSS成功，代理整改也不是总根因

- 326先回放已知audio03仍失败：8.8秒本机音频、起采162ms、0文字、需要恢复，已放弃本次草稿。`p5-audio-ui-03-03-326-isolated.*`保留。服务端/客户端auth与capability已有真实200，不能再笼统说模拟器未注册；也不能用HTTPS200声称WSS好。
- 电脑端WebSocket在默认环境代理下两条探针约5秒reset，websockets还触发了自己的关闭回调异常，原输出`p5-public-wss-noauth-boundary.txt`保留；不是App栈。相同库显式proxy=None则1.316秒握手成功，未鉴权按1008关闭，见`p5-public-wss-direct.txt`。curl直连HTTP/1.1升级也得101（等待关闭期间工具超时不是握手失败）。QEMU环境确实继承127.0.0.1:7897的HTTP/HTTPS代理，Android系统代理字段本身却为null。
- 通过console自带`proxy clear`仅清除5562实例转发代理，未修改全局代理、手机或路由器，也没重启App/模拟器。`p5-isolated-proxy-clear.txt`记录OK。同一audio03、同一326/进程普通UI重新录入后完整ASR并填入“看牙”/11月4日/14:03；起采16ms、stop drain2691ms，recovery_required=false，`p5-audio-ui-03-03-326-direct.*`。这是一次同输入失败→成功对照，不是全部旧断线的已证实总根因。
- 为保护旧证据，只将既有回放脚本的audit文件名也加入run-label，避免覆盖先前同id审计；没有修改App或继续修出另一套测试工具。

### 部分批次的严格结果与开放门

audio03通过后不重录它；只串行执行01–02及04–24。到12再次空转写/恢复失败即按原保护停止，13–24未运行，不再盲跑剩余条目。

- `p5-audio-326-direct-summary.{py,json,txt}`合并独立12条：11条收到文字，去空白/标点后与原合成句逐字完整，严格标题/日期/时间9/12；06为“复印店装订资料”不在冻结多解列表（可能是标签范围过窄，仍保留严格失败），09“还借来的伞”变“借伞”（ASR仅多逗号，存在实质动作错误，不能放行）。12无文字，不把它计成模型语义失败。没有事后放宽fixture或把这些自编TTS称自然/人声质量。
- 本次补取同一release PID完整privacy-safe HTTP审计并按实际capture起止窗口关联：6条本机规则，5条server graph模型，1条未进入解析。`p5-audio-326-direct-client-audit.txt`保留，summary逐条列HTTP次数/状态；模型内部repair次数不可见，model_inference_calls保持null，不把一次POST当一次推理或从最终文本猜模型路径。
- 12次起采样本p50=15ms/p95=33ms；11条收到文字的stop drain p50=673ms/p95=2691ms，首条代理环境冷失败162ms另存，没有剔掉它来报全场景速度达标。脚本post_release_observation_ms含uiautomator取证等待，不当真正端到端p95。不是完整24条、12旅程或物理讲话验收。
- 批量进程已退出；每个本次草稿均明确放弃，没保存测试事件，Pulse输出恢复4758、临时null-sink全部卸载；5562仍是独立临时盘326，原盘SHA不变。不得宣称代理清除已经根绝故障；下一片从12的真实连接/恢复边界继续，没新原因不重跑24条，不调整ASR/VAD或再调旧补改prompt。
- 公网清单`p3-p5-public-manifest-20261029.json`仍315/46,007,111 bytes/原SHA，本轮不重复下载旧315冒充新交付。API PID2654800不变，无生产重启、部署或P3 capability启用；无Git提交/推送。`p3-content-source-sha256.txt`记录实际候选文件，不把相对HEAD中更早的脏修改全算成本轮工作。

P0–P5仍未完成：可靠补改/初次语义、12之后的语音边界、恢复/replace完整旅程、省日期/未定、自然语料、主题/速度与正式产物继续开放。原盘恢复失败亦继续单列，不再阻止独立测试环境推进，但绝不冒充已恢复。automation-3继续ACTIVE，不恢复旧A–F/Q2/固件或新建任务。

## 主线续作：握手收尾、327有限回放及时段生产owner（2026-10-29 10:21–11:10）

本批读取唯一方案、CURRENT、上批原始回放/审计、两项LaoJi skill及适用UI参考，Git仍为原HEAD、空index和大量既有脏工作；未新建会话/代理、未提交/推送。本批真实任务是避免一次已采集的短语音被过早转入重传，并定位完整原话为何丢失时段；不是重调旧18/20题prompt或扩大ASR目标。以下证据均在`output/schedule-editor-20261028/`。

### 连接与停止：真实缺口、有限修正与失败取证

- 实际owner是日程使用的`RealtimeAsrSocket`，不是会议的v2 socket。`RecorderEngine.stopInternal`原先只在asrConnected=true时收尾：短语音结束时握手仍在原8秒期限内，却立即关闭连接、要求文件重传。新Android合同`RecorderPendingConnectTest`用真实AudioRecord、延迟HTTP升级及PCM字节计数复现：旧短录音失败，真正超时控制通过，见`p5-pending-connect-before-network.txt`。本地服务器只回传transport ACK，不伪装ASR质量。
- 327保留原连接Future和绝对期限；停止先释放麦克风，再仅用剩余预算等同一握手、发送原缓冲PCM及end-frame。没有增加总连接期限、新重试/回退或ASR/VAD参数。取消/关闭会结算尚未完成的Future，晚到onOpen不能重新打开；服务端拒绝不会挂到另一轮完整期限。沿用唯一engine/socket owner，没有新服务层或产品状态。
- 补上连接关闭/失败及文件恢复的白名单诊断：阶段、耗时、固定分类/状态码，不记录URL、身份、令牌、异常正文或音频正文。OkHttp 4.12真实字节码会覆盖WebSocket EventListener，故没有添加无效EventListener工具；DNS阶段与其后的连接/TLS/升级仍只按可观察粒度报告，没有假装已细分TCP/TLS。
- 原工具失败保留：测试host初缺INTERNET权限；补test-only权限后获得上述真实旧实现失败。修正后首次测试服务器未应答close，随后误用server侧cancel（MockWebServer没有client Call）导致两次清理失败；最终只保留正确close回应，`p5-pending-connect-final.txt`2/2通过，匹配缓冲PCM字节及原deadline。host单测最初触发未mock的Android Log，移除未启动连接的无意义日志后通过；最终`p5-pending-connect-audio-contracts.txt`43项音频host测试通过。没有隐藏工具失败或把它们当产品根因，停止继续扩建测试设施。
- `candidate327-build.txt`2m39s构建并覆盖独立5562：1.3.14/code327，x86_64-only，46,704,849 bytes，SHA `835a1179719c1276efd75d91b67ec7551015887150431be0958d604bc2e1c22c`，`candidate327-installed.json`完整安装base.apk一致。仅候选安装，没有arm64发布。`p5-pending-connect-source-sha256.txt`记录三个原生owner；后端源码改变不属于这个APK的采用证据。

### 真实回放：保留失败与1037ms异常值，不混合版本报通过

- `p5-audio-ui-12-12-327-pending.*`中旧12不再进入恢复，完整ASR后却漏上午。此时仅确认该次收尾可用，不声称此前326原12连接失败的所有原因都已证明。
- 随后仅继续未跑的13–24，不重复01–11；`p5-audio-ui-13-24-327-pending.*`正常结束，无新增重传失败。327本批12–24共13条，12条收到终态文字、8条去标点逐字完整、冻结字段5/13。13/16/21/22缺少原话字词，24无文字；19有完整改口原话却未生成字段；09借/还反转旧失败仍开放。06“复印店装订资料”的语义可接受复评与冻结多解列表遗漏分列，原标签不改；审阅者复评不是独立真人验收。
- `p5-327-audio-summary.json`关联同release PID9695 HTTP审计：6本机规则、6server模型、1未到解析；模型内部repair次数unknown。起采p50=18ms/样本p95=1037ms（24的1037ms保留）；所有stop drain p50=772ms/p95=2947ms。不把UI轮询等待当端到端p95、不剔除慢/空结果来宣称速度通过。与326前11条合并仅为24条独立工程来源已尝试，混合版本原始严格14/24，不是327整版验收、自然语料或真人质量。
- `p5-327-client-audit.txt`、`p5-327-server-audio-bytes.txt`可按时间窗关联各次传输计数；字节数相同不等于PCM哈希相同。journal必须按真实时区/Unix时间查，旧查询无行不能当没有连接的证明。最终报告保留每行可核验匹配结果，不以HTTP200代替语义。

### 已采用：模型已选中的时段没有进入生产规范化

- `p5-327-failure-attribution.{py,json,txt}`在独立进程使用实际生产source/config/provider，新观察09、12、14并保留真实模型原响应。09原响应title就是借伞，normalizer未把还伞删成借伞；这不是历史原调用的原始输出，但新观察重现了模型动作错误。12/14模型已给`time_phrase=上午/中午`，生产结果却time_period=null/is_all_day=true；不能继续说模型漏掉时段。
- 对照实际生产源码确认`time_period = None if start_time else spoken_period`只处理少数明早/今晚等缩写，没有转换已校验的模型time_phrase。候选源码原已包含该转换但未采用。仅移植这个表达式；另在同一词法owner补方案既定早晨→morning别名，不扩枚举、不捏钟点、不重新规则扫描整段原话。其余P3日期默认/安全错误/补改/Provider候选均未采用。
- `p5-period-isolated.{py,json,txt}`用同一真实原响应零调用比较生产copy与窄候选，AST检查其余owner完全一致：48个时段/日期表面/模型全天声明组合旧48失败、候选0失败；3个未选取/无依据/精确时间控制保持正确。12/14恢复morning/noon，09仍借伞，未伪造语义提升。本机新增通用引用/精度回归后`p5-period-local-quality-only.txt`120pass；先暴露早晨缺别名并修正，失败保留。附加temporal组因系统python3缺pydantic未收集，记录在`p5-period-local-quality-after.txt`，未安装依赖或称其通过。
- `p5-period-adoption.{py,json,txt}`在实时队列、任务、租约均空的gate后原子替换仅3行差异并短重启API一次。旧PID2654800/SHA3900073f…，新PID1439099/SHA `104e0f76ff0251c93e4a0188565c2cf3c3b2bc0c48e1ce6795887701e9f497d4`，ready恢复，未回滚；ASR2377671/Ollama3393180未重启，模型/上下文/显卡分配未改，P3能力仍关闭。
- `p5-audio-ui-12-12-327-period.*`和`p5-audio-ui-14-14-327-period.*`在新运行版正常UI录入：完整ASR、标题/日期及上午/中午均通过，2/2是此窄修正复验；起采17/24ms，drain522/608ms，不推广为整体p95。因为运行owner确实改变才重测这两条，没有调prompt或反复刷全24条。

### 缺尾尚未归因；保持有限续接

- 对13/16原TTS经当前生产VAD和8030做隔离对照，full PCM和VAD段均完整识别，未改VAD/ASR。另复用原有opt-in捕获工具取得16真实AudioRecord本机PCM，包络相关0.962904；`audio16-native-boundary.*`及`p5-audio16-pcm-vad.*`中捕获PCM经同VAD/ASR也完整。这不是原失败release会话PCM，故不能冒充UI成功、认定丢包或宣称总根因已解决。下一片须在release实际采集/传输与回放起播边界取证，先证明音频真正进入，不盲调ASR/VAD或重跑全24条。
- 所有本批音频草稿已明确放弃，没保存测试事件；三个远程临时候选目录取回证据后删除，无额外监听/常驻模型。独立测试host的录音文件/权限及Pulse路由/模块已按原值恢复；`p5-327-canonical-disks-final.txt`原userdata/key全量SHA均OK，旧数据仍未恢复。未动原身份、真机、5560、其他服务/固件/GPU1或路由器。
- 正式APK仍315，327仅构建/安装，无Git提交/推送。可靠P3补改/初次语义、replace完整正常UI/身份旅程、省日期/未定、自然语料/12旅程/主题/速度与正式产物门仍开放；不以合同/直接ASR通过开启失败能力。automation-3继续ACTIVE，维持P0–P5，不扩回旧目标。

## 主线续作：实际PCM、快速键入丢字与330有限旅程（2026-10-29 11:11–12:10）

本批核对同一方案、CURRENT、quality、Git、运行owner及两项LaoJi skill/相关输入和状态参考。没有新建会话/代理、恢复旧目标、提交或推送；保留原508项既有脏工作及空index。真实任务仍是完整接纳一次日程表达并在同一草稿可编辑，不以继续调旧18/20题prompt、重录全24条或增建测试平台替代。证据仍在`output/schedule-editor-20261028/`。

### 缺尾发生在实际录音内，不再盲调后端

- 一次性328（1.3.15）inspection-only包仅在独立5562允许run-as，保留embedded release JS、不连Metro；其JS与327字节一致，SHA `f92d63316a416b18186d1f5ea2680d3c82775486d3576fe58a375cff59dd4b35`。APK 50,437,658 bytes、SHA `f6737aeb4900f3cd37b18f8a8d7fd9149141ab2ef014ddc9350435481431f68c`，安装完整哈希一致。它不是正式release/性能验收，不发布。只给本批新合成canary的WAV.part保留只读fd，正常rename/unlink照常，不读取身份/令牌/数据库/既有媒体，也不加App导出接口。
- 初次exec-out对shell引用解析错误，所谓WAV只有446字节错误文本，`p5-audio-ui-16-16-328-pcm.json`明确fd未打开且断言失败，不能推断音频；当时UI却完整接收原话，保存到`p5-audio16-failed-fd-ui.json`后明确放弃自建草稿。改用无PTY的adb shell -T并分离stderr后，`p5-audio-ui-16-16-328-pcm2.json`真正捕获8350ms WAV（SHA `8ac5f65bf812719157760a3c577008d26c97234390c6efaeab9b16c6aa23eae3`），正常UI只得到“下个月三号凌晨”。这是实际失败会话，不是另一test-host录音。
- `p5-release-pcm16-vad.json`在隔离进程使用现行生产VAD和8030：原TTS的完整PCM/VAD段都完整，实际失败WAV的完整PCM/VAD段都只得到前半句。`p5-release-pcm-boundary.json`中失败WAV与原音频50ms包络相关0.636738，尾部语音已为静音。由此可确定该次损失早于WSS/文本解析，但不能区分QEMU、宿主输入或AudioRecord的全部责任，也不能推广为全部旧失败的总根因。未改ASR/VAD、Provider、模型或prompt。
- 有限增加宿主私有monitor对照，正常路由13/16/24共三条ASR均完整；宿主与原音频包络相关分别约0.995/0.994/0.995，native约0.979/0.924/0.964。13/24冻结字段通过，16标题“车站接人”不在冻结多解列表，严格失败保留，不改金标或称人工通过。不能凭这三次宣称增加monitor就是根治，更不能把它们混成327整批或正常release验收。没有继续全24条盲跑。远程临时`candidates/schedule-captured16-20261029`取回证据后删除，无额外监听/模型。

### 用户可见修复：旧桥接回写覆盖刚打出的字符

- 329恢复正常非调试构建后，尝试手填正常草稿，Android快速key events实际将`Editor329Canary / OldPlace329 / OldNote329`变为`Editor39Canry / OldPlace39 / OldNe329`，见`p3-replace329-seed-ui.json`。未保存任何事件。没有通过放慢输入绕过；静态owner确认`commitProps`总是用较旧JS draft覆盖native draft，`syncText`随后setText重写刚输入的内容，文字dock同样无输入确认边界。
- 在现有`NativeThemeContinuityTest`补真实原生View的可控顺序回归：本机依次输入甲、乙，再投递仅含甲的旧快照。旧实现稳定失败为“甲乙→甲”，见`p5-native-echo-before.txt`；不是截图推断或mock输入控件。
- 替换该回写合同：当前View生成不含内容的递增编辑token；表单draftChange及文字dock inputTextChange共用确认，JS将实际处理过的最新token随原snapshot返回。最新本机编辑未获确认前拒绝旧draft/文字回写，确认后仍拒绝乱序旧token；其他状态/音量继续刷新，当前确认下的模型结果、撤销仍可更新字段。token不持久化、不改业务revision/CAS，不做失焦豁免、输入延迟、按键节流、第二草稿或备用实现。页面/文案/几何/主题token没有改变，沿用原对象、状态、提交与恢复owner；无新增提示。
- 新原生回归、四主题输入实例稳定性及真实IME覆盖共3项仪器合同通过（`p5-native-echo-after.txt`），包括旧echo、已确认后乱序echo、文字dock、确认后合法替换、保留EditText/Editable；时间与确认host合同7项通过。JS ack镜像、输入/恢复/撤销、实际SQLite提交与回放聚合61项通过，TypeScript通过（`p5-native-echo-client-final.txt`、`p5-native-echo-typescript-final.txt`）。中间客户端fixture不触发业务rerender，导致无token可移植动作断言失败，原`p5-native-echo-client-contracts.txt`保留；修正该既有hook seam为稳定change+真实rerender，不改产品来迎合测试。源码指纹见`p5-native-echo-source-sha256.json`，其中相对HEAD的大量既有变更不算本批新增。
- 方案8.1纳入同一短期确认合同，没有新规范体系。按LaoJi skill检查的是旧回写对用户输入的实际影响，而非只保住截图/输入框实例；保留当前单一草稿、取消和撤销语义。三份实际UI owner的定向inventory存于`p5-native-echo-ui-inventory.json`，fingerprint `6cb5452e7ea2b074f8d2b8392fb9cf29a3e12d3b34acd3c92ea88bd90d43b96a`，仍为review_required，不当作自动语义审查通过；本批只改回写确认，正常/录音/解析/取消/撤销原对象、状态与操作owner不变，没有新增可见文字或占位。

### 正常330采用、有限旅程及明确未通过范围

- 329（1.3.16）先经clean prebuild撤掉inspection设置，46,704,849 bytes、SHA `1a98928f9c3b52e60f1f8feaf0f0eba31dde78f351e6e85d856ae7c89f3a6196`，run-as已拒绝。新发布检查在原`verify_compact_apk_config.py`拒绝application-debuggable；真实328被明确拒绝、其余合同无误，5项窄检查通过。没有另造一条发布旁路。
- 聚合330（1.3.17/code330）clean prebuild与构建2m完成，x86_64-only 46,704,997 bytes、SHA `c09bb1df2b85d2ce8a2a1545ed1a0f9b9ce94ce80dbbe554d4df985e7a4af3d6`；既有UI检查、正式endpoint/签名/ABI检查通过，覆盖安装完整base.apk SHA一致，run-as拒绝。见`candidate330-build.txt`、`candidate330-installed.json`。328诊断可读权已随正常包覆盖移除；不发布inspection包。
- `p3-replace330-fast-input.json`在正常330/default IME同速输入上述三字段，全部逐字保留。一次辅助入口检查假定install后一定停日历而失败；读取实际界面确认它恢复了本批自己的未保存草稿，未盲选/删其他草稿。后续只编辑这条明确归属的草稿，不把入口取证假设当App错误。
- `p3-replace330-journey.json`为真实完整的未保存草稿旅程：手填标题/地点/备注后设每天；菜单重新输入启动录音，取消后全部保留；再次重新输入经真实AudioRecord/公网WSS输入既有audio03，完整显示看牙/11月4日/14:03，并清掉旧地点、备注及每天重复；一次撤销恢复旧内容和每天，最后明确放弃仅此草稿。8项观察通过，未注入转写、访问DB、模拟模型或保存事件。取消起采151ms、后一次21ms，后一次drain545ms，见`p3-replace330-capture-audit.txt`；151ms保留，不报起采/端到端p95门已过。该旅程不是当前draft局部patch质量，也没闭合既有事件改期/保存身份。
- 全部回放和本次fd读取已结束；Pulse仍只路由专用5562、最终恢复4758并卸载临时模块；所有本批草稿明确放弃，没有测试事件。仅一个独立read-only临时盘QEMU1193151；未启动原盘、改原身份或清用户数据。原盘近期记录仍未恢复，末次完整SHA结论仍是上一批，不冒充本批再次恢复。
- 本批没有服务重启/部署，实时复核API1439099、ASR2377671、Ollama3393180均原PID，ready及实时/后台队列、租约为空。`p5-330-public-manifest.json`仍315及原SHA，只复核未变manifest、不重复下载旧包冒充交付。没有arm64发布/真机安装，真实讲话仍skipped；P3 edit关闭不变。Git HEAD/分支未变、index空，见`p5-330-git-boundary.json`。

首个下一片是既有事件重新输入/改期/保存身份及恢复的正常Android旅程；可靠组合补改、初次语义、省日期/未定、P4硬件/非Android、自然语料/12旅程/主题/速度及正式产物仍开放。不要再次修同一fd工具、盲重录24条、重做已闭合滚轮/恢复/撤销或旧18/20题同方向调prompt。当前实际安装是330而非328/329；automation-3继续ACTIVE，不宣称P0–P5完成，不恢复A–F/Q2/固件目标。

## 主线续作：既有事件改期保存与重启恢复（2026-10-29 12:11–12:55）

本批真实任务是编辑已有日程后保存、退出、恢复、重开，而不是继续打磨输入控件或调旧题prompt。沿用两项LaoJi skill，保留当前表单、主题、文案、录音和单一草稿owner；无新增可见提示、页面或回退入口。未新建会话/代理、提交、推送或改动服务/模型/固件。证据仍在`output/schedule-editor-20261028/`。

### 实际失败与负责owner

- 正常330先通过UI创建明确自有的`Owner331Canary`，再在同一既有事件内重新输入既有合成audio03，真实AudioRecord/公网WSS得到看牙/11月4日/14:03并清掉旧地点备注；点击保存却落入“日程不存在”。见`p3-owner331-existing-journey.*`及`p3-owner331-after-existing-save-ui.json`，不是仅凭截图或新接口合同推断。
- 父级AddEvent持续用旧occurrence解析live投影，自己的改期commit发布后就卸载仍在结算的编辑器；EventsStore又将旧ref写入saved回执，原详情/恢复replace路径仍指旧地址。另在同一mutation发现endDate沿用旧范围、重复转一次性从后来occurrence编辑时错移到旧根日期。旧失败记录是真正落过盘的自建样例，不为它另造迁移或旧地址兼容分支。

### 同一提交与导航合同替换

- `guestRecurrenceEdit`的唯一caller仍是EventsStore：mutation同时返回事件集合和实际结果ref；source ID不变，整组/一次性改期返回新occurrence，例外仍保留既有锚点。范围采用本次validated endDate或明确清除；重复转一次性使用本次请求日期。删除旧array-only返回合同，不留双重分支。
- repository在事件写事务中校验原目标/revision，再解析实际结果ref并匹配草稿payload，跨source和不存在的结果拒绝；saved回执保存实际结果。EventsStore在写队列内先查已提交回执，再尝试旧地址和当前版本，不能因旧occurrence消失而重复写。后续手改不会被一次重放覆盖。
- AddEvent按进入身份固定不可变编辑基线，避免自己的投影刷新卸载当前保存；仍用revision栅栏拒绝外部冲突。正常保存和已保存恢复都用回执`popTo`唯一详情，恢复effect不与当前save竞争。不改schema、P3开关、模型调用、主题/布局/状态文案，方案第10节已合并此合同，没有另叠标准。
- `p3-existing-owner-before.txt`保留三项新合同失败（其中array返回形状失败不等价真实UI根因）；`p3-existing-series-stop-before.txt`保留重复转一次性日期反例；`p3-existing-recovered-navigation-before.txt`保留恢复replace而非popTo失败。最终`p3-existing-owner-332-contracts.txt`66/66通过、TypeScript exit0（同名typescript文件为空正常输出），覆盖8种重复/编辑范围、范围清除、实际SQLite close/reopen、原ID/数量、幂等、后续手改、跨source拒绝、stale revision及事务回滚。`p3-existing-owner-source-sha256.json`已刷新到最终源码。合同不替代实际UI或P3语义质量。

### 最终332正常旅程与取证边界

- 331曾构建/安装，332聚合最终恢复导航修正：`candidate332-build.txt`2m2s完成，1.3.19/code332、x86_64-only、46,705,713 bytes、SHA `d3857e52aa740665ea1b16ee7a3fba3f6ddf4d9a983b8f1034f020fd1b54e8a2`。完整安装base.apk SHA一致，run-as拒绝；既有签名/ABI/endpoint/UI检查通过。见`candidate332-installed.json`。仅隔离模拟器候选，没有arm64构建、公开发布或真机安装。
- 初次332的直接改期保存已经进入有效新详情（`p3-owner332-first-save.*`）。早期fixture清理与332自动覆盖安装重叠，一份partial探针声称删除、另一探针却没到目标；此期间不能从画面推断删除复活或重复commit。后续真实11月日历发现两条同名自建样例（330旧样例和332首测），只通过正常UI删除这两条，重启核对清空，见`p3-owner332-fixtures-cleaned.json`的2→1→0边界。没有读原盘/真机数据、清库、重注册或为旧坏回执加特例。
- 确认干净后创建`Owner332Final`/旧地点备注，global加号日期为10月29日而非浏览月份（`p3-owner332-final-source.*`）。同一332真实AudioRecord/公网WSS重新输入audio03、改到11月4日14:03、旧地点备注清空，保存进入有效详情，返回一次到日历，旧日期行消失、新日期只有一行；见最终`p3-owner332-existing-journey.*`、`p3-owner332-single-moved-record-ui.json`。不是注入转写或模型mock。
- 随后手改标题`Owner332Recovered`及备注，正常退出，旧已提交结果仍可见；force-stop并重启，重新打开未保存修改，标题/备注/日期/分钟完全恢复。保存进入正确详情、返回一次到日历、11月只有更新后的单条、重开内容不变。`p3-owner332-resume-journey.json`8项实际检查通过。中途探针误以为重启仍浏览11月，在10月数新行断言失败；原failure转存probe_failures、真实UI保留，正确切到11月后继续核对，未改App迎合脚本。UI单行不是直接设备DB身份证明，原ID/原子性由上述SQLite合同另证。
- `p3-owner332-save.mp4`实际约4.07秒/44画面帧，已抽帧审阅保存前后的正常内容与有效详情；contact sheet黑色区域是未填的格子，不是App黑屏。没有“日程不存在”结果；此视频不是全帧预算、点击首绘或p95性能通过。样例输入仍为工程合成音频，不冒充真实讲话或自然语料质量。
- 定向沿用现有UI inventory，`p3-owner332-ui-inventory.json`覆盖最终AddEvent SHA，fingerprint `14ad7ce0342afa5500e9d6d59f4c3731c44de12e9dc9b7e3bdc8779e438e3988`，但词法工具copyCount=0与源码现存中文不符，只能证明切片指纹、不能作为文案零冗余通过。没有为了分数改产品注释或继续扩建工具。实际源码和上述UI逐状态审阅：编辑/保存仍同一表单；成功是单一新详情；恢复先选择草稿再编辑；错误合同不新增解释提示，既有冲突/失败操作仍保留。此次没有改可见文案、组件几何或主题，不冒充四主题全量重验。
- 只将本批自建事件正常删除，并重启/浏览新日期复核无残留，见`p3-owner332-final-cleanup.json`。QEMU1193151仍为唯一5562、独立read-only临时盘/禁快照，原盘未启动，原近期数据仍未恢复；本批没有再次全量校验原盘，不扩大历史SHA结论。Pulse source-output23495恢复4758、临时模块已卸载，见`p3-owner332-audio-restored.json`。Git HEAD89ef1fd不变、index空；509条默认porcelain与614条-uall是不同计数口径，不伪称都由本批新增，见`p3-owner332-git-boundary.json`。

本片闭合有限的既有事件重新输入/改期保存/退出/重启恢复，不再将它列为下一片。P3可靠组合补改/初次模型语义门仍失败且关闭；省日期/未定、P4剩余硬件ready/待办真实入口及非Android边界、P5自然语料/聚合12旅程/主题/速度和正式产物仍未全交付。下一片先核对P4剩余真实生产caller，不重复本片、旧18/20题调prompt、全24重录或测试工具修理。正式315未变，automation-3继续ACTIVE，不恢复旧目标、不要求用户守候。

## 侧聊监督：额度中断与333未完成交接（2026-10-29）

用户手动唤醒本侧聊监督。本轮只读取主会话、当前源码/证据、Git和进程清单，完整校验候选APK，并补这份现有交接；未操作模拟器UI、真机、服务或产品源码，未提交/推送，也未发送会触发又一失败回合的续作消息。

- 主线`01a18603-997c-7a02-96b0-28d79cebc562`于北京时间12:55:45开始、13:23:51因使用额度耗尽失败；后四轮13:25:46、13:55:45、14:25:50、14:55:50均在产生工作前被同类错误拒绝。直接读取的主会话状态为systemError；不能宣称它持续在做功能，也不从automation配置ACTIVE推断执行成功。本侧未改模型、充值、使用重置或变更定时任务。
- 中断前主线实现了待办关联补齐：日程提交不再等待跨会议域关联，保存草稿回执保留关联意图，后台仅补关联而不重建事件。`p4-followup-contracts-final.txt`记录89/89通过，另有TypeScript及源码指纹；侧聊本轮未重跑，不将合同当完整实际旅程通过。
- `candidate333-installed.json`记录1.3.20/code333、x86_64、debuggable=false、安装base.apk与构建APK完整哈希一致。侧聊再次完整读取`laoji-1.3.20-333-x86_64-release.apk`，确认46,712,173字节、SHA `88620b80cd57a8b0336577401eec9ba85b8c7be92e0aa7e5ebbd31a696ead39c`；没有重新安装或读取设备base.apk，也无arm64/公开发布证据。正式仍315，P3能力仍关闭。
- 最后普通UI取证为`p4-adoption333-after-create-attempt-ui.json`：测试会议“日程来源333”，新待办sheet中已有`PrepareAgenda333`文本、“创建待办事项”enabled=true；创建后25秒工具等待未找到“创建后续日程”而失败，界面仍在编辑sheet。它只证明该次创建流程未完成，不能凭按钮可用认定创建成功，不能直接定性产品根因，也没有到达后续日程保存/关联。相关App审计和创建前取证均已保留。短录音等待上传是独立未通过边界，不扩成当前上传改造目标。
- 当前仍只有一个LaoJi QEMU1193151/5562，命令明确使用独立datadir/data/key、read-only、禁快照；本轮未发现仍运行的本批回放或screenrecord。原盘近期数据未恢复，本侧未再次全盘哈希，不扩大历史保全结论。临时实例退出会丢弃本轮数据，后续先确认当前实例/样例，不用默认原盘命令或清库续测。

恢复可用后的首个步骤：保留已闭合332旅程，核对333当前待办创建的真实结果与入口，再完成“待办→统一编辑→只提交一条日程→关联补齐/重进/中断恢复”的有限实际旅程；不得重放整批24音频或旧补改prompt实验。随后仍回可靠组合补改、初次日期默认/未定和聚合验收。侧聊只补中断点，不宣称已修复待办创建或完成发布。

## 主线恢复：待办采用、关联恢复与键盘内提交（2026-10-29 15:25–17:15）

15:25恢复执行，先核对CURRENT、同一quality末节、Git和333源码指纹，未把额度拒绝期间记成开发。沿用两项LaoJi skill：跨域保存由既有本机生命周期补齐，键盘布局复用现有组件，不靠额外错误提示或另建提交链；不增加规范/测试平台/Provider。此前332保存恢复锁定，本批只闭合待办来源到同一编辑器的有限真实任务。

### 同一保存回执与关联补齐

- 333前源码审计发现日程已提交而会议关联失败后只剩UI临时状态，重新保存被saved phase拒绝，重进还可能撞同一save_request_id。不是注入真机故障得到的结论。现在`ScheduleEditorDraft`的可选followup保存来源身份、pending/linked/retired、attempts/retryAt；仍在同一draft JSON，无新表/迁移/第二事件写者。旧无来源草稿继续可读，匹配旧route时只绑定元数据。
- repository按draft ID/唯一保存请求/hardware job恢复，拒绝同一请求偷换来源；事件提交与saved回执不变。独立attempt fence结算关联，不改已发出的编辑stateRevision；被删除事件不能复活，后续手改不能被回放覆盖。现有EventsStore在启动、前台、提交后触发单飞补齐/有界退避，只重放原会议关联事务；删除或已关联其他事件则retired，不覆盖。没有pending时不常驻空轮询。
- AddEvent删除等待直接跨库关联的旧UI链、临时createdFollowupEventRef和“日程已创建，关联未完成”警告。保存先结束并回来源会议，已有观察者刷新入口；再次采用已保存来源直接打开原event，不创建第二draft/事件。方案第10节已合入同一合同，旧即时link封装改为服务内部使用，没有备用入口。
- 扩展原`tools/tests/schedule-editor.test.cjs`、restore-exit及entry套件，真实SQLite close/reopen覆盖唯一保存请求、恢复、来源绑定、重复提交、后续手改、deleted/conflict；服务 seam覆盖单飞、短暂失败、有界重试及会议link提交后checkpoint异常。该seam不等价Android真实双库进程中断；本批未制造此实机故障。原初49/50、effect变量错位TypeScript失败及后续模块loader失败保留，最终`p4-followup-contracts-final.txt`89/89、TypeScript exit0。没有提高P3语义分数。

### 实际键盘遮挡及334修正

- 恢复333时自有会议“日程来源333”的待办编辑sheet仍未提交。截图`p4-adoption333-create-obstruction.png`与真实IME状态证明底部提交落在键盘下；点它实际向文本输入空格。accessibility enabled/bounds不代表物理可点，先前等待失败不能归因会议服务/归档状态。手动收键盘后才能创建`PrepareAgenda333`，此步骤只是fixture准备，未当修复验收。
- `MeetingActionEditorSheet.tsx`用已有`KeyboardFrame`替换自己的KeyboardAvoidingView，遵循原生实际IME overlap/host测量和iOS既有padding；提交按钮移出字段ScrollView到同sheet固定footer。无新键盘算法、全局键盘配置、教程文案或重复保存动作；既有主题/字号语义保持，文件中的既有主题订阅改动不冒充本批新成果。
- 原dialog-owner套件新增共享键盘owner及提交不在滚动祖先内回归；`p4-action-ime-before.txt`先失败，修正后与原keyboard-frame/保存/恢复/入口套件聚合`p4-followup-ime-contracts.txt`95/95、`p4-followup-ime-typescript.txt`exit0。合同不是物理键盘证明。
- 334实际聚焦内容、键盘展开，快速改为`PrepareAgenda334`；`p4-adoption334-edit-keyboard.png`真实显示保存位于IME上方，`...edit-ime.txt`记录mInputShown/mIsInputViewShown=true。未先收键盘，直接保存，随后来源待办确实显示新内容（`...action-saved-ui.json`）。完成窄区域布局/真实提交验证，不声称四主题/1.3字号完整旅程已过。

### 334真实采用、产物与清理边界

- 334（1.3.21/code334）x86_64-only release构建2m15s，46,712,241 bytes、SHA `1ed95118932d69c420f94a0e3afe525b4c40e09b7e0ae06b1baafeaba93466c4`；签名/ABI/生产endpoint检查通过，正常覆盖安装完整base.apk SHA相同、run-as拒绝。见`candidate334-build.txt`、`candidate334-installed.json`。无arm64构建/真机安装/公开发布，正式315未变；333原包保留。
- 待办“创建后续日程”进入同一统一编辑器，默认2026年10月29日、钟点未设置；改为`Followup334`及`LinkedNote334`，只按一次保存，回到来源待办sheet，入口变为“查看后续日程”。打开得到正确标题/日期/备注；返回后force-stop重启，再从同一来源打开，内容与关联保持；日历暴露一条该事件。见`p4-adoption334-journey.json`及引用的原始UI。UI单条不是设备DB稳定ID证明，原ID/幂等由真实SQLite合同另证。
- 一次探针用“更多会议记录操作”作为返回谓词而等待失败，实际原生工具栏被来源待办sheet遮住；fresh UI已是“查看后续日程”，后续真实详情/重启通过。保留`...save-wait-ui.json`及原错误，不将工具假设当产品保存失败；没有为脚本修改返回产品行为。
- 源会议由普通文件选择/导入确认创建，音频副本142,990 bytes；整个旅程仍“等待上传录音”，审计pending=1/uploaded=0/skipped=1。未完成ASR，不能把这条当会议上传或音频语义通过，也未因此扩张本轮目标。待办为正常手工新建，不是模型行动候选质量证据。
- 仅上述自建日程经删除确认移除，自建会议经正常回收站单条永久删除（不是清空全部）并重启核对；清理时短按回收站行实际是正常恢复，随后重新删除/长按/永久确认，相关步骤不作为新产品缺陷。最终回收站空、日历无`Followup334`，自有`/sdcard/Download/日程来源333.wav`已移除；没有清库或操作原用户记录。原5562盘近期数据仍未恢复，本批未再次启动/全盘哈希原盘。唯一QEMU1193151继续独立read-only临时盘/禁快照，真机/板未连，真实讲话skipped。
- 最终16个源码/测试/版本文件指纹在`p4-followup-source-sha256.json`。现有UI inventory缩到AddEvent和ActionSheet两实际owner，fingerprint `68b62ab7fd454988d5c6dc80af178cdbb99dfe70b2b9579f8a8d2e32358d6251`；2个重复组是互斥分支的未设置/未开启，不是同屏重复。AddEvent词法零提取仍是已知工具边界；结合真实UI与源码审阅，不报自动语义零冗余通过。无新增可见文字、错误提示或状态行。
- Git HEAD89ef1fd/分支不变、index空，默认porcelain510与-uall615是不同口径，非本批新增数；见`p4-adoption334-git-boundary.json`。未提交/推送/切分支/重启服务/改模型或固件。没有新跑同一50次性能、旧18/20题prompt或全24音频。

### 有限未完成与写入窗口交接

P3可靠组合补改及初次语义、省日期/未定、P4硬件ready/非Android真实边界、P5自然语料/聚合12旅程/四主题/速度和正式产物仍开放；P3能力继续关闭，不能发布失败语义候选。332保存恢复及334待办采用不再列为首个未完成项；受控双库异常只有合同，不写成Android真实中断通过。

收到用户已授权的仓库整理侧聊协调消息：本批正常收尾写完CURRENT/quality后，**仓库写入窗口已让出**。待侧聊通知整理完成前，不启动源码/构建/Git写入，不自行stage/commit/push/改分支；后续heartbeat先只读检查交接，不能因定时触发与整理争抢工作区。未改automation-3配置、模型或使用额度，不将协调等待冒充整个P0–P5完成/用户永久暂停。整理完成后先核对新的分支/SHA/原工作树映射，再继续首个未闭合切片；不通过消息绕过窗口。
