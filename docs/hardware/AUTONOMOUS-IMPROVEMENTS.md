# 离场期间持续改进记录

用户最初要求持续推进、无需提问或物理配合；最新指令改为“闭合还在进行的改进任务就结束目标”。本轮已收尾，不再执行下方历史段落的“下一轮”建议。仅操作老记、专用真机/5562 与已授权第二块板，不动其他项目、共享服务或用户原始录音。不自动提交/推送 Git。

最终交付接续点为本文末尾 **1.2.49 / 257、板端 2.1.2**；49 已通过 USB 覆盖安装真机，下方较早版本仅为诊断过程，不是当前运行版本。未公开发布 APK 或推送 Git。

## 当前切片（2026-10-21）

- 基线手机 1.2.29 / 237，板端 2.0.3。上轮 WLAN 关闭导致接收失败已修复并实机通过，不重复重做。
- 当前手机候选 **1.2.36 / 244** 已安装（arm64 APK SHA `89f1a8c7873eaebf359de6544177b0347663913714158b85bf8fa3b146eeb259`），5562 同源 x86_64 开发包也已安装。硬件 ASR spool 仅在 transport 存在时启动 pump；失败/完成后停止周期唤醒；复用只读文件句柄；恢复积压时每轮最多四个 6400-byte 块，服从真实 transport 背压，不推进被拒绝的游标。
- 同候选增加连接生命周期 owner：网络丢失会关闭正在连接/阻塞读取的 socket；失败连接不会泄漏 socket；保留完整性校验和续传文件。增加仅聚合字节数及耗时的 read/write/progress/verify/commit 日志，不记录正文、名称、地址或令牌。
- 硬件 JVM **86 项**、前端硬件回归 **26 项**通过；包含新积压、背压、lease 正常/失败/竞态和真实 loopback 阻塞读取中断测试、RIFF 额外块/截断/范围校验、扫描合并/限频、通知与唤醒续租策略、磁盘写入/同步失败与网络失败隔离、投影去重和活动会话优先。模拟 transport 的耗时不等于真实 ASR 提速。
- 正在用自有 40 秒录音做真实 Android 传输分项对照。fixture 及原目录保全清单：`output/hardware-autonomous-20261021/transfer-fixture.json`。只可删除这份清单声明的自有 fixture 及其本机接收副本，禁止删除原有 27 条。
- 可复用真机探针：`tools/hardware/verify_phone_transfer.py`，必须指定 serial/title/version，只使用新鲜 UI，不删除或导入数据；新接收必须同时有“已接收”和新产生的完整 SHA 成功日志。
- 板端 **2.0.5 已 app-only 写入并验证**，SHA `4b15da1395fc800a474e64c3f6f39a675b33224d3d841f9f68d51e2529a29a6a`：TCP_NODELAY、32 KiB TCP 发送窗口、聚合 read/send 计时及传输 admission 独立于凭据到期。测前新鲜 factory 读回、压缩回滚和 boot/table/PHY 不变证明见 `output/hardware-autonomous-20261021/window32k-update/update-manifest.json`。不能运行 `idf.py flash`。
- 同一自有 1,277,996-byte 录音，Android 纯 body 基线 10.360 秒；仅 TCP_NODELAY 的两轮为 3.327 / 5.634 秒；2.0.5 + 1.2.32 为 2.743 秒（read 2680 / write 15 / progress 32 ms），完整 SHA 成功。这是小样本组合结果，不当作统计稳定倍数，不把系统热点确认等待混入 body 耗时。
- 真机 pending 标题与源标题一致；删除自有接收副本后立即移除。新版本增加过期刷新版本围栏。后台通知只随可见操作变化而重发，不再按每个百分比反复 notify/renew。设备页仅在前台未连接时每 12 秒自动发现；原生扫描 7 秒窗口内合并并发/快速重复请求。
- 真实跨 120 秒期限的下载通过：到期前 1761 ms 入场、限速传输 22.285 秒后全文件和 PCM SHA 成功；传输期间到期但 AP 不撤销，过期新请求 401，完成后 AP 自动关闭。原 28 条（含自有 fixture）保留、电脑原网络恢复。见 `wifi-expiry-window16k.json`。前三轮分别是入场太晚、探针 ASCII 头假设、极小接收窗口超时，均不计通过。
- 只读检查服务器：18020/8030/21434 常驻就绪，ASR 为 CUDA0；9B 驻 GPU、embedding 驻 CPU。GPU0/1 仅余约 1.5 GiB，不移动其他服务或额外加载模型。未改服务器配置。
- 后续板端 **2.0.6 已 app-only 写入**，SHA `87d6deff0ce20cc899f1f3a801d5c42b438becdb2db10c03428002b455b2f8ab`：公开 AP 名从硬件 MAC 稳定派生，逐 offer 独立随机密码/令牌，不改 BLE/HTTP 字段。真机第一次需系统确认（connected 8911 ms），第二次未弹确认、复用已批准 AP（3538 ms），两轮 SHA 均成功；body 5030 / 6323 ms，明确存在无线环境波动。不是宣称每次总耗时固定缩短。
- 2.0.6 真实 Linux DHCP/HEAD/完整 SHA、Range/后缀、过时代际、非法路径与旧 token 401、原网络恢复和 28 条卡目录保全通过。固定公开名称但新密码、新 token；旧 token 明确被撤销。AP 扫描缓存首轮未列出名称但随后真实 DHCP 成功，不将扫描缓存诊断当成连接失败。
- 服务器真实烟雾：8 秒给定视频片段经当前严格 `asr.batch.v2` 返回实际中文文字，1347 ms（推理 1315 ms）；本地 9B 简短生成 1548 ms。仅证明这些实际请求可用，不外推日程/整理/问答质量；前两次探针遗漏协议版本被 422 正确拒绝，不算服务故障或推理结果。
- 当前板端 **2.0.7** 已 app-only 写入，SHA `cdb1ce970322fdf42bc9d571e405d5586cbccb852b46985b7e603b9c33a0ad07`。主动撤销先唤醒被阻塞的 socket，再由 HTTP owner 关闭；真实阻塞下载关闭 0.299 秒、残片未提交。补齐 401 challenge。完整读取/Range/凭据撤销/目录保全/电脑网络恢复仍通过，见 `wifi-revoke-http/results.json`。
- 真实 Android 中途关闭 WLAN 后自动恢复原开关：第一次保留 950816 bytes，重试 HTTP 206 仅传 327180 bytes，584 ms，最终 SHA 成功。1.2.34 复测中断提示为“录音接收中断，请重试”，body failure 到 native error 为 148 ms；此前约 8 秒的关闭清理等待已消除。1.2.35 随后跨覆盖安装续收另一次残片并全量校验成功；radio 已恢复。见 `phone-transfer-interruption-final.json`、`phone-transfer-resume-real.json`、`phone-transfer-resume-1235.json`。
- 1.2.33 起预览变化不反复查询全局会议库；稳定事件/持久状态变化及 3 秒强制校正不跳过。1.2.35 活动源优先、绑定与 lease 准备移到全局列表刷新前。前台实时文字与 canonical writer 分开，未增加页面文案、常驻空白或状态 owner。
- 5562 经虚拟 BLE 输入实际 12 秒视频语音，调用真实服务：停止前有 3 段持久 `realtime_draft`，不是预置文本。在源偏移 691200（21.6 秒，语音已结束后的静音尾部）出现模拟 GATT 缺口并正确封口；停止后补读、完整导入、同根 `final`（3 段、completing=false）成功，没有第二条会议。根 `41c33083-dd49-3b01-bec5-1926ee7b399c`；这不是物理射频或无丢包通过。已有 pending WAV 未清除。
- 两次电脑扬声器→实板拾音尝试均未获得可确认的样本语音，完整 SHA 成功但 RMS 51.4 / 52.4、peak 425 / 542，仍接近底噪。电脑原 10% 音量在临时 30% 测试后已恢复，默认蓝牙输出未改。不以此判定模型/硬件坏，也不盲调阈值/增益或声称质量通过。两份自有记录及文件身份位于 `physical-speaker-loop*.json`，待只清理自有数据。
- 生成验收材料、设备记录及固件镜像通过 `.gitignore` 的 hardware output 规则排除出公共源码；没有删除磁盘证据。未提交、推送或公开发布。

## 1.2.36 后续切片

- Wi-Fi 对源 PCM SHA 和完整文件 SHA 改为一次有界读取；蓝牙 PCM 在封装 WAV 的同一次复制中计算两份 SHA。失败 WAV 不入索引；损坏 PCM 仍只完整重取一次，不放松任何校验。删除无调用方的重复哈希函数；保存索引不再重读整份 WAV。
- 实时连接每次 attach 独占回调代次：旧连接迟到的握手失败、错误及文字不能污染新连接。无效恢复游标关闭新建 socket，同步 connect 异常释放 owner；迟到的成功回调也不能把 draining 回退为 streaming。正常 READY 前排队的最终文字仍须落盘，不能被代次门误丢。
- 前台安静发现先向 native owner 读实际连接状态；进入已连接页面不再额外启动低延迟扫描。用户显式刷新行为不变。
- 硬件 JVM **95 项**通过，包含双 SHA/奇数 RIFF 元数据/64 KiB 边界、损坏 PCM、迟到回调、同步连接异常、收尾文字与单调 phase。Node 硬件回归 26 项；构建保护与 Metro 回归另 6 项；类型检查通过。
- 新包真机同源 1,277,996-byte Wi-Fi body **2702 ms**（read 2640 / write 21 / progress 26 ms），verify 3 / commit 1 ms，完整 SHA 和 UI 已接收同时成立；已批准热点连接 3147 ms。不是稳定倍数或端到端 p95。见 `phone-transfer-onepass-1236.json`。
- 5562 坏 SHA：两次完整读取后拒收，精确中文结果、pending 四个旧 ID 不增不变、phase=ready，见 `emulator-checksum-onepass-1236.json`。正确已知音频：停止前 3 段 durable draft，观察首字上界 8.023 秒（含 CDP 采样开销），停止后同根 final 3 段且原生 session 自动归零，见 `emulator-{live,final}-onepass-1236.json`；根 `165d98fd-87d8-39bd-8901-e0c55610ddb7`。不充当实体麦克风或严格质量验收。
- 测试外设的 generation 不再只由长度决定，录制文件分别保存自己的创建时间；3 项独立夹具测试通过，不算产品验收数量。
- 本轮曾误启动重叠构建，第二个 Expo --clean 干扰前一个 Gradle，两个失败构建均未安装。新增跨 Linux/Windows 原子文件构建互斥，锁在 android/ 之外；异常残锁不因父 PID 消失就擅自清除（Gradle 子进程可能仍活跃）。5 项保护测试及真实第二构建拒绝通过。之后单独完整重建并通过正式包合同，才安装上述 hash。
- 同一 12 秒真实语音经现 8030：4 秒批次两轮 839/462 ms，6 秒批次 1019/612 ms，12 秒完整上下文 2043/1098 ms。短段有跨边界词语断裂，整段上下文更完整，但延长等待和推理并非无成本。仅小样本诊断、非准确率；保持生产分段不变，未重启或修改服务。官方原生 streaming 为 vLLM-only，且重送累计音频，不是免费无限上下文；当前无空闲显存可并行新运行时。
- 三份本轮自有板端录音经名称、generation、完整 SHA、大小逐一验证后删除；原始 **27 条目录逐项不变**。手机自有传输 fixture 副本也移除，其余 pending 未动。见 `owned-board-cleanup.json`。两份本轮自有 NoSpeech 手机会议（02:39 / 02:48）已逐条移到回收站，未永久删除，未清空全局回收站或用户数据，见 `owned-phone-cleanup.json`。

## 接续方向

1. 比较真实 Android transfer read/write/progress 耗时；测试 TCP Nagle、小发送窗口和 BLE/Wi-Fi 共存，不将猜测写成根因或增益。
2. 已关闭：长文件 120 秒 admission/expiry、RIFF 非固定头、pending 标题/删除 UI、通知与扫描降频。后续补真实断线/重试，不重做已完成单元项。
3. 继续压缩热点重复连接：参考 Android 官方的已批准 AP 复用机制，先做不改传输协议、不复用口令/令牌的稳定 AP 身份候选，实测后决定采用。
4. 设备发现与目录状态继续检查真实页面生命周期；保持一处状态、无新增教程、无空白槽位。
5. 已有已知音频的实时/最终完整链路新证据；接下来用同源音频比较固定短段与完整上下文，核实模型原生流式及资源条件，先隔离实验，不直接切生产。ASR 原生 streaming 在官方当前实现中是 vLLM-only；现部署运行时必须现场核实，不能把 transformers.transcribe 称原生流式。物理按键/电池/拔卡缺口不能冒充已验证。
6. 优先进入 [实时缺包恢复候选](LIVE-REPAIR-CANDIDATE.md)：当前首个缺包后安全封口会让其余实时文字一直等待结束；尝试已有 ring 的有限回读和单个连续源 assembler，不修改云端合同、不补零、不跳偏移。能力协商、纯函数和隔离故障测试通过前，不启用到实板。
   - 已新增精确 ring 范围复制纯函数和 20,000 例 ASan/UBSan 边界测试（其中 5,057 例有效范围），源环绕、已覆盖前缀、未来范围、偶数对齐、64-bit 偏移与输出围栏通过。测试曾发现随机参数绝大部分被拒绝的问题，改为显式保证至少 5,000 个有效复制范围，不降低门槛蒙混。这是合成内存合同测试，不是 20,000 条音频质量评测。
   - 新增未接线的 `HardwareLivePrefixAssembler`：128 KiB/512 帧有界缓存、原偏移连续排出、分段 missing 范围、冲突/重叠/超限封口、已提交副本不重写。12 项 JVM（含 200 种到达顺序及重复）与此前 95 项全通过，共 107 项。证据 `live-repair-foundation-checks.json`。当前仍没有 BLE 新操作、回读 ticket/期限 owner 或 native 接线，不能把这部分称为实时缺包已修复，也没有重新构建/安装该切片。
7. 连接准备延迟：上述 1.2.36 采样为 0.862/2.031 秒仍 waiting，3.225/4.413 秒 connecting，5.610 秒 streaming，8.023 秒首个 preview；这些是采样上界而非精确 native 耗时。现 `prewarmDeviceV2RealtimeRecording` 只在会议列表录音来源选择时调用，直接进入硬件页并不预热。可先测“在已明确进入硬件页时提前准备身份/能力/lease”（不创建会议、不打开麦克风、不发音频），按同源冷/暖实际回放判断是否采用；不先替换模型或堆新状态。

## 临时环境

USB ADB 仍会在大响应时掉线；本轮临时 `192.168.79.117:5555`（实际手机 `825f509d`）已恢复 USB，属性为 0、实际 TCP 5555 已关闭。首次立即探测尚在重启窗口，待稳定后重新确认关闭，见 `debug-restoration.json`。板端 `/dev/ttyACM0` 的临时 yydd 命名 ACL 已撤销。禁止把调试连接当作应用接收条件。共享 Metro 8083 不停止；5562 和虚拟外设是本轮自建，后续按需单实例重启。

## 1.2.37 / 固件 2.1.0 接续

- 第 6 项从基础函数推进到真实可选链路：固件环缓存精确快照/独立 2 秒发送 worker、能力声明、取消与会话围栏；native 128 KiB/512 帧 assembler、3 秒缺口期限、独立 repair stream，按原偏移送给现有镜像和 ASR。旧设备未声明能力时仍用安全封口。具体合同及正反证据见 [实时恢复切片](LIVE-REPAIR-CANDIDATE.md)，前文“未接线”仅为当时状态，不是当前事实。
- 5562 注入相邻/独立缺包后仍得到完全相等的源前缀和停止前真实文字；故意延迟补包后正确封口、停止后同根完整恢复。实板 32 KiB 快照约 1.17 秒，所有快照、live 和最终 SD 数据匹配；原 27 条保留。
- 手机已安装 1.2.37 / 245，APK SHA `92b84f5910571a371923b8a82b367236c6e662378e315ab51946370a4565745d`，签名/单 ABI/生产端点合同通过，未发布。实际暂停恢复后提前中断，未计通过；候选 1.2.38 增加设备中断归属与脱敏错误码，正定位原因。手机实余约 457 GB，不能沿旧文案认定本机存储不足。
- 显式进入已连接硬件页时预热身份/能力/lease，不创建会议、不启动麦克风/ASR session、不发送音频。只观察到一轮首 preview 上界从 8.02 到 5.64 秒，另一轮为 11.88 秒；分辨率/负载也不同，不能归因为固定加速或 p95 改善。
- 构建工具将 Metro 与有限 install/launch 分离。真实 Expo 发现 `--port` 与 `--no-bundler` 互斥后，改为精确 serial 的 ADB 安装、反向端口和 dev-client URI 启动，不让开发服务占着构建锁；真实 5562 重建/安装正常退出、锁释放。12 项工具保护测试通过。不停止未知工作区 Metro。
- 此刻为排查真机临时再次开启 `192.168.79.117:5555`，结束后必须恢复端口 0；单设备测试服务器 5038 已停止，未重启共享 5037。板串口临时 ACL 已再次撤销。5562 分辨率暂为 720×1600 / 280 dpi（DP 几何不变，减少宿主渲染负担），没有更改手机显示。

## 当前接续点：1.2.41 / 249

- 正式 arm64 候选已安装真机，SHA `bcefb402a0f607d6ff130efd80f74ef1a0ce59f7ae217008a5add00ec6aacd54`；5562 安装同源 x86_64 开发包。签名/架构/生产配置门通过。没有改公网清单、提交或推送 Git，目标仍 active。
- 1.2.38 和 1.2.39 真机开始、暂停、继续、结束均通过；板端各保存 1,142,784 / 1,169,408 bytes，停止请求后板端落盘约 0.23 / 0.18 秒。UI 探针观察就绪约 3 秒，包含 UI dump 时间，不是精确录制响应指标。1.2.37 的那次中断未复现定位；其自有恢复源 812,032 bytes / 25.376 秒已完整 SHA 验证，仍留在卡上，不能说故障根因已修复。原 27 个文件未删除，新增自有诊断录音也不冒充原有记录。
- 设备的 `audio_failed/storage_failed/未知` 中断改为设备音频/存储卡/通用设备中断，不能再错误诊断手机磁盘。模拟器真实 native/GATT 注入音频中断时，正确中文结果与同根 interrupted 状态成立。错误日志仅白名单代码。
- 一次恢复检查点写入失败会跳过网络关闭和 pump 清理：新增 JVM 先在旧实现复现（状态 unavailable 但连接不关闭），再修复。即使 checkpoint 不可写仍释放网络和周期 pump，保留源文件、身份和游标；恢复后只发送未提交后缀。硬件 JVM **116 项**通过。
- 电平订阅从整个设备页移动到独立两 View 小组件，按 capture ID 围栏并在页面不聚焦时移除监听；不再由每条电平事件重绘设备目录/录音列表。未宣称某个量化帧率增益。
- 1.2.40 重新回放：同一 12 秒语音经真实部署 ASR；注入 3 个当前 capture 缺口，另观察到一次 7,700-byte 的非预设 GATT 缺口，全部补回。停止前 3 段持久文字，580,608-byte 前缀逐字节等于源，停止后同根 final 3 段。`live-repair-scoped-1240.json`。旧 `live-repair-full-1240.json` 因故障计数混入上一 capture，已明确降为不采纳，不混算；探针与两项用例改为按最近 capture 边界读取注入证据。
- 实际截图发现自定义字体的紧凑 Text 框令“接收”仅画出首字；1.3 倍字体下还影响“断开/开始录音/加入会议”。保持既有字体和颜色，为控制家族预留随 fontScale 缩放的标签宽/高与像素取整余量，显式单行；不缩小字体、不删字或堆解释。四主题在 1.3 倍字体截图审阅通过，默认主题/字体已恢复。证据 `theme-controls-1241/`；开发 warning 覆层不是正式包界面。
- 已连接设备不一定继续广播，重进/重建页面时要投影 native 的已验证设备，而不是“没有发现”。不虚构 RSSI，握手未完成不造已连接行。设备录音按实际创建时间倒序，未知/同时间保持稳定，标题/重命名不参与排序，不改变来源 ID。真机 1.2.41 确认 05:15 / 05:02 最新两条排在前面、已连接行存在、数据未清除：`phone-catalog-1241.json/png`。
- 最新 Node 回归 **50 项**、虚拟外设 **9 项**、控制 Schema **3 项**、故障证据作用域 **2 项**、TypeScript、UI 已知回归/连续性与 `git diff --check` 通过；这些是结构/状态/故障测试，不是自然语音质量通过数。
- 仅重启了本轮自建、核实工作区身份的 Metro；旧 10-worker 池改为独立托管默认最多 4 worker（可显式配置），避免与 Gradle/模拟器争抢 16 GiB 内存而频繁交换。不停止其他工作区服务。真实启动与 5 项 owner/启动/复用保护用例通过。当前 Metro PID/日志以忽略的 `.laoji-metro-8083.json` 为准；构建锁不再被长期开发服务占用。
- 临时 TCP ADB 已关闭，USB 恢复为 `825f509d`，`service.adb.tcp.port=0`，实测 5555 不能连接；5038 已停。板串口临时命名 ACL 已撤销；手机 WLAN/主题未改变，模拟器主题恢复 neutral / 字体 1.0。板端空闲，真机已主动断开 BLE 并退出设备页；没有录音任务需要用户结束。
  - 随后只读 USB 查询再次掉线，最终 `adb devices` 暂只有 5562；TCP 5555 仍实测关闭。不要把调试传输掉线误写成 APK 未安装或应用/板端链路失败，也不要因此重启共享 ADB 或要求离场用户操作。

### 下一轮优先项（不重复已完成内容）

1. 保留那次实板提前中断为开放项；下次复现需同时捕获设备 reason/原始源完整性/耗时，而不是根据旧错误文案猜本机磁盘。不要盲改麦克风增益、VAD、I2S 缓冲或丢包期限。
2. 主题 Activity 重建时，开发日志出现旧 Expo SQLite shared object 已释放的警告；应审查异步 DB 任务的生命周期与代次所有者，先证明用户写入/新上下文是否受影响，不简单吞错。日志 `/tmp/laoji-metro-45ca0068a03b-8083.log`，不能把开发 warning 本身当作正式包崩溃。
3. 继续衡量真实首字耗时，把本地会议落盘/绑定/lease、WSS 建立、服务排队/推理分别归因；当前只有观察上界，不能称稳定 p95 加速。服务资源不扩展、不触碰他人 GPU/进程。
4. 最新虚拟外设源码已补真实命名、预览分页和空闲身份；当前运行旧进程不自动热更新 Python。下一次需要这些新夹具合同的回放时，在无活动 capture 后重启本轮自有进程，并声明虚拟证据边界。仅保留专用 5562。

## 1.2.42 开发切片与实板长录音复现

- 读取当前文字记录新增专用 read model，不再先加载手写笔记、日程关联、快照、全部阶段和录音资产再读文字。身份解析继续使用原生 session 优先级，作用域、删除、active revision、draft/final 和 finalizing 语义不变；8 次 SQL 减到 2 次，不增加缓存/自动重试/新写者。真实 SQLite 四项边界回归及四主题下现有 19 条会议全量新旧结果相等，主题恢复 neutral；完整性均 ok。暖态 20 次原读取 5–9 ms，新读取 2–3 ms，只是本地查询样本，不代表网络或 ASR p95。
- SQLite 并发独立库三轮各 200×8 组读写、共 9,600 个语句，均完成且 integrity ok；四主题重载后现有库也完整。未复现先前 shared-object 警告，当前日志仍只有旧 72–78 行那一次。上游类似 issue 使用不同 SDK，不能作为本项目根因；没有盲目串行化全部 DB 或吞错。证据 `database-concurrency-baseline.json`、`transcript-focused-read.json`；重复检查工具只写自己的独立 probe DB 并自动删除。
- **实板未定位问题现已再次复现，但还没有根因结论**：2.1.0 长录音/暂停恢复在首轮约 100 秒、3,216,384 PCM bytes 时主动 `audio_failed`，停止余下轮次，未删除失败源 `LJ_1792535946109_9cca2753.wav`（重启后可能带 RECOVERED 前缀）。证据 `board210-long-soak.json`。这比此前短录音通过更强，不再只写“尚未复现”。
- 板端临时诊断候选 **2.1.1** 已 app-only 写入，SHA `cffe4f1f277f9d1026f404caff7409839b354451b3ba5ed2b5315fee1f641c55`，精确 2.1.0 baseline、压缩回滚、boot/table/PHY 保全均验证：`input-timing-update/update-manifest.json`。只增加失败时的聚合 read/error/overrun/FS wait/write/fsync 耗时，不改变采样、DMA、增益、阈值、校验或协议。正做 180 秒复现并被动读 USB console：`board211-long-soak.json`、`board211-input-timing.log`。串口临时 ACL 测后须撤销；监视器有限 360 秒，不发串口指令。
- 手机仍 1.2.41 / 249；1.2.42 / 250 正构建安装到 5562，尚未安装真机/发布。当前真机 ADB 未出现，不要求离场用户配合。不提交、推送或改公网清单。

## 当前接续点：1.2.43 / 251、板端 2.1.2

- 2.1.1 诊断固件的一轮 180 秒录音未再次中断，5,736,448 bytes 完整 SHA 和 live/source 一致，31 条原文件保全。它没有证明旧故障唯一根因，也不能覆盖 2.1.0 的真实失败。诊断镜像只作为私有回退/比较证据，不是最终改进。
- **2.1.2 已 app-only 写入并核验**，SHA `94a70d4eb19749068d050876c84e79f984d8294ee12f34e8280584edc913057c`。I2S producer 只做读取和短锁 PCM FIFO；唯一 storage writer 负责 SD/SHA/committed ring。增加 256 KiB PSRAM（8.192 s）与一个 8 KiB writer task stack，不增加 DMA/常驻模型/GPU 使用。stop 排空已接受前缀；pause 不接新样本但不丢排队数据；队列满或真实 I2S 丢失仍 fail closed，不补零。原 flush/sync 周期保留，断电持久性不被夸大。固件纯 C FIFO **100,000 次模型对照操作**在 ASan/UBSan 下通过，10 项 Python 契约/边界检查通过；不是 10 万条真实录音。
- 两轮真实 180 秒（包含 0.8 秒暂停）均完整：5,748,736 / 5,751,808 PCM bytes，完整 SHA 和所有收到的 live 字节逐字节一致；原 31 个文件均保留，仅删除本轮精确 generation 的成功诊断录音。首轮/次轮最大写盘耗时 **277,932 / 378,367 us**，max FS wait **32,190 / 20,590 us**，max sync **66,137 / 65,946 us**，FIFO 峰值 **25,600 / 11,264 bytes**，accepted=committed。超过旧约 192 ms DMA 时间的真实写盘停顿被隔离，不只是调整超时。证据 `board212-long-soak.json`、`board212-decoupled.log`。旧失败源仍保留为 `RECOVERED_LJ_1792535946109_9cca2753.wav`，并未因新测试通过而删除。
- 同 2.1.2 实板短范围恢复：532/32,768/4,096 bytes 用时 319/1,167/308 ms（包含探针等待），4 份快照及全部 live 与最终 316,416-byte 源相等；错误范围/过期前缀拒绝、暂停期间源不前进、恢复后完整校验、原目录 31 条保全通过：`board212-live-repair.json`。Linux BLE 证据，不冒充手机射频/拾音质量。
- 1.2.42 虚拟回放两次未通过：旧夹具连接/GATT 控制发送失败，一次未收到开始操作。保留 `live-repair-focused-1242.json`、`live-repair-focused-fresh1242.json`、`live-repair-focused-confirm1242.json`，不得算成通过。一个单独 UI 手动触发链路 `4186f7f3-c64d-3f57-afef-b3b6e0d79f35` 确实在停止前有 draft 3、停止后同根 final 3，但不混入自动回放通过率。已关闭自有旧夹具，未操作真实板录音来修复模拟器。
- 审查发现控制写 admission 失败/回调超时后原 transport 可继续被使用，UI 因而长时间保留 recording。1.2.43 对 API33+ **明确未准入的 BUSY** 最多等待 300 ms / 21 次，不重复已接受的片段；其他拒收、回调超时或中断使旧连接失效并关闭，迟到回调不能完成新连接。权限失败保留权限归属；不改手机麦克风或板上独立 SD 录音。仅日志记录平台 status，无正文/设备地址。4 个新 JVM 用例；实际异常 admission status 尚未在新包复现，不将旧现象假称已确定为 201。依据 [Android API](https://developer.android.com/reference/android/bluetooth/BluetoothStatusCodes#ERROR_GATT_WRITE_REQUEST_BUSY)。
- **1.2.43 / 251 已安装 5562**；重启本轮自有虚拟外设后，真实 Android/GATT + 已部署 ASR 回放成功：当前 capture 的 3 处缺包补齐、865,280-byte 前缀与源完全一致，停止前 draft 3，停止后同根 final 3。根 `94f181ad-5284-36d9-ab9d-fbb5296e1e74`，证据 `live-repair-control1243.json/png`。实际截图审阅控件文字完整、单一状态和真实预览。此轮 28 秒收集窗口不是首字 p95，不声称物理拾音准确率通过。
- 测试工具也收敛了证据：accessibility busy 快照有界重读、不点任意重复控件；停止 intent 不能当作设备确认；清理只匹配自己的 virtual session。目录保全按协议分页，不再把首 32 条当作全目录。硬件 JVM **120 项**、本轮 Node 选择集 **52 项**、TypeScript/UI 已知回归与连续性通过。
- 当前真机仍 1.2.41，无 ADB，未清数据、未改变手机网络/主题；串口监视器已自然退出且临时命名 ACL 撤销。板端 ready，所有本轮实板成功源已精确删除，旧失败源未删除。模拟器 neutral / fontScale 1.0，专用实例 5562；不操作 5560。1.2.43 arm64 正式候选已构建并通过生产配置/签名/单 ABI 合同，`output/hardware-autonomous-20261021/laoji-1.2.43-251-arm64.apk` SHA `dcd9ab16fcbedb89ca0d744ef8e1367250c915a0e3a11dccb0a2d36d39ca8ac2`；未安装真机、未公开发布、未提交或推送 Git。

### 下一轮可继续项

1. 新包控制写 admission/迟到回调故障需进一步真实注入验证，不能用 4 个纯策略测试代替完整 GATT 生命周期。应先核对当前自有 fixture 空闲，再设计一次可复现拒收/回调延迟；不修改用户板 SD 数据或要求用户配合。
2. 旧 shared-object 警告仍不称根治；三轮并发与四主题重载未复现。新轻量文字读模型已验证，避免为猜测全局加锁/吞错。进一步减少全局 full projection 要先审查 revision 与 mutable-live 一致性。
3. 继续首字耗时分项归因（local/binding/lease/WSS/排队/推理），不要把本地 SQL 从 8 次到 2 次当作整体 ASR 提速。
4. 1.2.43 构建结果/APK SHA 已保存，真机可用时再自主装机；发布、Git 远端及其他服务本轮仍不扩权。目标保持 active。

## 1.2.44 / 252 当前开发接续

- 已安装 5562，尚未构建 arm64/装真机/发布。实板继续 2.1.2，未改动；无新串口 ACL。当前仅 5562 在线，手机仍 1.2.41。
- 真实 GATT 注入（设备先执行 pause、ATT 写确认延迟 4.5 s）：1.2.43 在约 3.6 s 退出失效连接、恢复同一 paused 源、resume/pause/stop、新接收关联原会议、同根 final 3 段通过：`gatt-timeout-recovery1243.json`。不能以最初工具的 case 名称推断重连必与迟到返回重叠；当时 UI 截图耗时未单独证明该窗口，后续用显式时间戳收紧。
- 对上述真实错误截图审阅，发现连接状态行与 modal 重复显示相同超时。1.2.44 新增公开结果归一化 ownership 判断：仅新鲜、同 locator、有明确公共结果的 native 状态可取代弹窗；未知错误、陈旧状态、其他设备和文件/校验问题仍保留独立操作结果。原生 direct control-write failure 在操作拒绝前同步退出当前 connection 并发布状态，不等 reader 下一轮 poll；旧 transport/epoch 的失败不能关闭新连接，响应等待超时/repair 逻辑不随之扩大为断链。
- 1.2.44 同一 4.5 s 故障已实测单一错误位置、无 modal（`gatt-timeout-recovery1244.png/mp4`，录屏 15.24 秒；已检查 4/7/11 秒帧，标题稳定、错误后重连动作直接可用）。该整轮后半接收发生额外 GATT 中断，原报告保持 **not_passed**，不能全部改绿。源未重录/夹具未重启；原 490,032-byte PCM 断点恢复后与最终 501,804-byte WAV 前缀相等、完整 SHA 一致、原会议 `222f4b8e-9115-3720-b03e-070217760db2` final 3 段：`gatt-timeout-same-source-resume1244.json`。这是同源续接的独立通过边界，不是覆盖失败证据。
- 新增直接测试实际 HardwareRuntime 私有 request owner 的 3 个 JVM 用例：同步失败先发布状态、旧失败不污染新连接、非传输拒绝不关闭健康连接。原 120 项里的 checkpoint 注入曾在 mkdir 处失败：PCM 已发送不等于连接 checkpoint 已完成；改为等待持锁的 streaming 持久态，并为跨线程 Fake 标志加 volatile，未用固定 sleep 或放松生产校验。故障用例连续 12 轮注入；硬件 JVM **123 项通过**。
- 调试观察本身的默认 12 s 不适合长接收。检查工具增加显式 500..50,000 ms 观察预算，RPC/connect 有界、断开会及时拒绝，消息按独立 ID 分派；观察失败绝不取消或重启 native work。4 个工具协议测试通过。原接收超时后先查真实 phase，确认 terminal error 才续接；没有因为观察超时直接重跑。
- **8 s 时序窗口已检查**：新连接返回 paused 后 753 ms，外设旧 ATT response 才尝试返回；之后同一来源 resume/pause/stop 正常。这里不是证明 Android 必然收到已断开连接的 characteristic callback。整轮后半再次接收失败，`gatt-overlap-recovery1244.json` 保持 not_passed；单独续接 `gatt-overlap-same-source-resume1244.json` 通过，254,856-byte 前缀与最终 498,732-byte WAV 一致、完整 SHA、原会议 final 3 段。

## 当前接续点：1.2.46 / 254

- **1.2.45 / 253** 新增两个确定性竞态回归：旧 reader failure、旧 foreground-service failure 在 owner lock 前等待时，新连接接管后旧实现仍会将它关闭。修改前两个实际 runtime 测试均失败（replacement 变为 null），修改后通过。连接失效统一在同一个锁内检查 transport 身份和 epoch，再退出/发布结果；handshake 和同步 write failure 同用此路径。没有增加第二个锁、超时或自动重试 owner。
- **1.2.46 / 254 已安装 5562**。PCM packetizer 不再为每次捕获读入反复复制并拼接 pending，改为单个固定缓冲，仍是原 16,000-byte 分包及至少 32-byte 末段保留。每包内容、每次 append 的发出数量和 finish/cancel 语义与原算法一致，4 档包长 × 2,000 组随机读入（含奇数长度、空读、复用源 buffer）对照通过。主机 JVM 处理相同 32,000,000 bytes 时，分配观察为旧 289,312,024、新 32,863,992 bytes；**不是 Android GC/帧率/ASR 速度指标**。硬件+audio JVM 共 **133 项通过**，Node 选择集 44 项、fixture 11 项、UI 已知回归/连续性通过。
- 延迟观察改为 App 内 125 ms 采样，不为每次采样拉取整个 bundle。1.2.45 首轮 native→streaming **2.938 s**、preview **4.499 s**、stable **6.972 s**，同根 final 3；第二轮 **3.258/4.992/7.008 s**，随后 stop 因系统蓝牙崩溃失败，不能计完整通过。已以原会话正常结束，2,741,292-byte WAV 完整接收关联原会议 `556c751f-38fe-3c63-a8f9-ed94b2de1db1`；结果 `latency1245-source-receive.json`。1.2.46 一轮 **4.136/6.851/7.401 s**，无缺口、同根 final 3，tap→capture App 时钟上界 278 ms；不能由此声称首字比 45 更快或得出 p95。
- 首轮工具曾将宿主 tap 时间减 native 时钟，出现 -355 ms；该字段不采用，当前工具在 App 同一时钟中对 tap 前后取界。采样间距也记录，不把 125 ms 配置当真实精度：46 轮最大间距 592 ms。`hardware-latency1245-round1/round2.json`、`hardware-latency1246-round1.json` 保留原始结果，不将 stop 失败涂绿。
- 两次额外接收/stop 异常已读到模拟器系统证据：`bt_vhci_forwarder` 先因 `Received invalid packet type` abort，随后 HAL `Broken pipe` 和 Bluetooth service death；与 App 的 GATT timeout 顺序吻合。`emulator-gatt-overlap-hal-crash1244.log`、`emulator-latency-hal-crash1245.log`。这不等于定位物理板/手机故障，也未为掩盖模拟器问题放松超时或校验。
- 调试工具从当前 Metro registry 精确解析 module，不再每次 ADB 拉取几十 MB bundle、扫描旧 ID。缺失/重复/不可用直接拒绝，不猜模块或缓存跨 reload ID；只接受唯一的老记 emulator target，不按列表顺序选其他 App/歧义实例。5 个 helper 回归与实际 5562 只读状态查询通过。此为测试开销改进，不记入用户 App 提速。
- 服务端仅只读验活：API/ASR/生成/embedding/VAD/CAM++ 均 ready，实时 ASR 当时 queue 12 ms / inference 663 ms，GPU0/1 各约 1.5 GiB 余量；未移动模型、修改配置、停止服务或触碰其他用户进程。固定资源下首字还有网络/启动/音频累积等成本，不把全部等待归咎于 ASR 模型。
- 收尾复核一度将 `exec-out cat` 的“临时文件已不存在”文本误作音频算 SHA；没有改 App 或重接收来掩盖。查明 pending 已由 canonical import 接管，正式路径读取 **2,741,292 bytes**，完整 SHA `46775082f392008b5501fa27152c62845244fa36f860e1dbac09fc78029ef361`，PCM SHA `a471740e19ec8e7e06449008c4509edd8aba231a223c1e6884c36eaa70a9bf9b`，与 receipt 和设备源分别一致。会议 `556c751f-38fe-3c63-a8f9-ed94b2de1db1` 与 46 新录音均为 final/completing=false/3 段。工具改用关闭 PTY 的 shell-v2、验证命令退出和实际媒体；只允许消失的 pending 向同根同 ID/大小/SHA 的 canonical owner 重查，不对损坏内容回退或重启；5 项观察工具回归及当前文件实读通过。
- **46 arm64 候选构建完成**，44 MiB，SHA `b47423d6047361ea9cdc98e40fc76cbe76454a5c55f7e4690fe14e36590120c1`，保存为 `output/hardware-autonomous-20261021/laoji-1.2.46-254-arm64.apk`，签名连续性/单 ABI/字体/原生版本/生产端点合同通过。手机仍 1.2.41、无 ADB；实板仍 2.1.2，未动 SD/固件；5562 已结束当前 capture 并主动断开。未发布、提交或推送 Git。专用 5562 保留一个实例，目标继续 active。

### 下一轮优先项

1. 继续拆分 WSS HTTP upgrade、服务器 ready、native replay 的首字准备成本；当前样本显示 connecting→streaming 的差异显著，不能靠缩 VAD/分包策略掩盖网络等待。先增加隔离/脱敏测量或使用已有时间线，再决定是否值得连接预热，不预建空会议或占 ASR session。
2. 审查 device-v2 socket 多代 WebSocket 的 queued callback：`SocketListener.isCurrent()` 目前在排入 IO executor 前判断，需用实际执行队列证明旧 ready/ack 是否可能晚于新 generation 执行。**尚未复现，不称根因或已修复**；不能以外层硬件 epoch 测试替代内层 socket 的证明。
3. 模拟器 `bt_vhci_forwarder` 的 H4 crash 与物理板分开处理，保留每次失败，不通过扩大产品超时、放松 SHA 或无界重试换取“通过”。需要真机/物理操作的剩余边界继续记账，不询问离场用户。

## 当前接续点：1.2.47 / 255

- 上述 queued callback 已在实际 `DeviceV2RealtimeAsrSocket.SocketListener` 和 IO executor 复现：8 项初始用例中旧实现 6 项失败；旧 preview、ACK、ready、complete 在排队后失去代次，却仍能修改新连接。现在执行时在现有单个 IO owner 内重新核对 generation、socket 身份和终止状态；不引入第二个状态 owner。`onOpen` 的非阻塞发送仍不等待磁盘队列，但在原锁内检查代次。迟到 `newWebSocket` 返回也受终止围栏约束。
- 同一 owner 的重连退避由阻塞 sleep 改为 scheduled delay，既有 250 ms..4 s、最多 6 次策略不变。失效连接在退避前立即退出代次，退避期间仍可持久保存 PCM。两项回归在修改前失败；当前 socket 11 项、硬件+audio JVM **144 项**通过，Node 选择集 **52 项**通过；不是自然语音准确率。
- 首轮探针误把 board capture ID 当 ASR session ID，后续又遇开发 URL 约束，均保留失败记录，没有放松生产 URL 校验。使用正确 `hwrt-<meetingUUID>`、只作用于新虚拟 capture 的临时 loopback 透明代理后，真实 WSS 在首条 stable 后断开一次，恢复游标正确、无重复 PCM、停止前持续真实文字。代理不产生任何 ready/ACK/转写，只记录类型、序号、字节数和哈希，临时 wrapper/reverse/代理均已撤除。
- 原整轮一度在最终上传处失败；现场确认模拟器 netsimd 固定在旧宿主网络 DNS，R2 为 unknown host，而宿主和服务器能解析/读取。仅重启自有 5562 并使用当前宿主 DNS（192.168.2.1），没有修改路由器、真机或服务。重启前后两库 ID/会议 lifecycle 清单和完整性一致，未清除数据。原会议 `f2890e6d-00a1-3972-aa7b-95f89d2f2ae9` 的原 WorkManager 自动成功，完整 SHA、远端 immutable asset/task 身份和同根 final 3 段核验通过：`websocket-reconnect-final1247.json`。原失败报告没有重写为绿。
- 修复环境后再次完整回放：`websocket-reconnect-postdns1247.json` / `websocket-reconnect-postdns-final1247.json`，两次真实连接、一次主动断线，第二次 ready chunk ACK 12 / durable event 1；36 包、567,296 PCM bytes，与已知输入和静音尾部逐字节相等，0 个重复音频包。同根 final 3 段；原 WorkManager 一次尝试完成上传，远端 task success、SHA/大小/asset/generation 一致。服务器后续 `cleanup_pending` 是已验证接纳后的隐私清理生命周期，不等于上传失败。此证据不包含物理 BLE 射频、拾音或人工语义质量。
- 该轮代理观察 WSS upgrade 1,237 ms、upgrade 后 ready 550 ms、ready 后首 stable 4,403 ms；第二次 upgrade 971 ms、ready 614 ms。只作分项诊断，含代理路径，不是正式直连 p95。尚未据此修改 VAD/采样或占用额外模型。
- 调试工具增加每个 Metro 的有界互斥，避免两个 CDP 观察器互相踢下线导致假失败。实际 Metro 源码确认每 runtime 只允许一个 debugger；两项互斥和实际读取回归通过。这是测试可靠性，不计用户体验提速。
- **47 arm64 候选已构建**，约 44 MiB，SHA `417ee109a22b16ec150760ec01e2c5708e1b529e77a101b66c662f5751bbb8f1`；`output/hardware-autonomous-20261021/laoji-1.2.47-255-arm64.apk`。签名/版本/单 ABI/字体/生产配置合同通过；5562 已安装同源 x86_64 开发包。真机仍 1.2.41、无 ADB；实板仍 2.1.2，本轮未写固件或 SD。没有公开发布、提交或推送，目标仍 active。

### 下一轮边界

1. 继续依据上述时间线审查连接准备，不以预建空会议/ASR session 换取表面首字速度。
2. 较早自有上传 work `8349e289-4fe5-4983-9791-86dad2a9dd26` 最后仍 enqueued / attempts 8，需等待原任务真实终态；不得因其他上传成功就称全部修复，不取消重建以规避退避。
3. 保留实板中断唯一根因、物理拾音与手机最新版验证缺口，不要求离场用户配合。

## 当前接续点：1.2.48 / 256

- 对实际 socket IO owner 新增四项故障注入：有效 audio ACK、server event ACK、本机 canonical ACK 的 SharedPreferences commit=false，以及已有加密事件 envelope 损坏。旧实现四项均失败：IO task 异常被 executor 吞在后台，连接仍 accepting 或初始 connect future 永久不完成。现将这些实际任务接入统一异常出口，关闭失效 transport、释放等待/通知现有 consumer，源文件不删除、不更换身份、不另建重试链。硬件+audio JVM **148 项通过**。
- 同一 binding fence 的并发登记现在仅共享尚未结束的请求，结束立即释放，不缓存远端 ACK。epoch、generation、revision、cancelRevision 任一变化都不能合并，原序列补齐和服务端确认仍有效。10 项新回归中旧实现 3 项失败（20 次同一请求、失败结果分裂、重复补齐），修改后全通过；结合身份/硬件/转写 Node 选择集共 **69 项通过**。实际 5562 对同一已有会议同时请求 4 次只产生 **1 次 HTTP 登记**，紧接的独立请求仍产生 1 次，绑定全部一致：`binding-singleflight-live1248.json`。这是并发请求数改进，不宣称单次 ASR 延迟固定缩短。
- 48 完整真实服务回放：`websocket-reconnect1248.json` / `websocket-reconnect-final1248.json`，2 次 WSS、1 次故障、0 个重复音频包；36 包 / 569,344 PCM bytes 与已知源逐字节相等，同根 `a457d802-bcdd-3b61-beee-8a60bac11a51` final 3 段，原 WorkManager 一次完成，R2 和 task 的 SHA/asset 身份匹配。临时代理、wrapper、reverse 18024 均撤除。夹具不是物理拾音质量验证。
- **48 已安装 5562，arm64 候选已构建并通过合同**，44 MiB，SHA `0340b9f1305d6e6d14a620cd135d27c14f152ffacf2d57bb6af0a5bf1aecf8dc`；`output/hardware-autonomous-20261021/laoji-1.2.48-256-arm64.apk`。TypeScript、UI 连续性/已知回归通过。真机仍 41、实板仍 2.1.2，未公开发布、提交或推送。
- **新发现、尚未修复的真实旧任务边界**：原 work `8349e289-4fe5-4983-9791-86dad2a9dd26` 第 9 次成为 failed / invalid-input。只读核对证明其媒体大小/SHA、设备 epoch、asset/generation 均正确；同一云端 session 已有 immutable verified asset，转写 task 已 success，却因任务完成进入 `cleanup_pending`、PUT URL=null。native 只识别 `verified`，将清理中的已完成会话错当需重新 PUT；服务端 complete 重放也只识别 `verified`。不是音频丢失或身份错误，不能取消/重录掩盖。下一切片需让已验证 receipt 在隐私清理生命周期仍可严格重放，再恢复原 source；当前旧失败保持原样记录。

## 最终收尾：1.2.49 / 257

- 48 末尾的 receipt 生命周期问题已修复：native 对 `verified/cleanup_pending/consumed` 只在 session、immutable asset 和 task 标识一致时重放完成凭据；不会把清理状态本身当成功。结果继续严格核对 asset/generation、大小、SHA、task/entity、协议和服务端实际 object revision，不猜 revision=1。JSON null/非法 PUT URL 明确为 response 问题，不再误报用户输入错误。
- 服务端 complete 允许已验证 asset/task 在清理阶段幂等读取完成凭据，不重开 R2、不新建转写、不回退清理状态；未验证就取消的 session 仍拒绝，已有 verified 重放也必须保持同一输入 SHA。14 项服务测试通过，包括清理前后零 R2 访问与取消/输入围栏。初轮有缺 numpy 的环境失败，补齐独立测试依赖后完整通过；不是把缺依赖算产品故障。
- 生产只更新 `vnext_upload_store.py`：更新前源码 SHA 与当前 Git HEAD/实服一致；双重检查运行租约和排队任务均为 0，再原子换入。新 SHA `69079b0b53ddfadea5277f6fdef9bad15ff0de0f1255dd213d7f8c9a9ea93426`，仅重启自己的 laoji-api（3830555 → 292959），ASR/Ollama PID 不变；无数据库迁移。公网 `/api/ready` 仍 ready。一份小型原文件回退保留在 tanyk 私有 cache，未留下重资产备份。
- 原会议 `9eb7ea87-b240-344d-b8a6-786ba456d122` 不是重新录制/上传：579,628-byte 媒体与原 SHA 完全一致，真实 complete 返回原 asset/task、reused=true；经现有 canonical use case 接纳媒体状态。该自建测试记录此前已被旧客户端写为 failure，因此在校验远端 task success、源 SHA/generation 和已提交本机 receipt 后，对**这一条旧测试投影**做事务 CAS 修复；正常 operation 的终态转换门禁未放松。原失败报告仍保留，未改成“旧 work 第 9 次通过”。随后激活同一个已完成 task，原会议 final 3 段、completing=false，音频逐字节不变：`committed-receipt-recovery1249.json`。
- 49 实际 Android worker 又对该相同源做完成凭据重放，独立 executor `ecbc262f-6c65-401e-843b-b3909111c7c8` 一次成功，取得原 remote asset/revision/task；它不是将旧失败 worker 伪称成功：`native-receipt-replay1249.json`。没有新录音、替换源或新模型推理。
- 最终原生硬件/audio/receipt JVM **155 项**、Node 选择集 **69 项**、服务端上传 **14 项**、TypeScript、UI 连续性/已知回归和 diff 空白检查通过。48 的真实 WSS 注入故障/全量上传/同根 final 仍是最近完整语音纵向证据；49 没有修改音频/ASR 分段，也不额外宣称物理拾音准确率或服务 p95。
- **1.2.49 / 257 arm64 包**：`output/hardware-autonomous-20261021/laoji-1.2.49-257-arm64.apk`，约 44 MiB，SHA `3fc8064efe01ef4c05a82e55e416d3db305b3afc325ecc76b75b3d561cf5759e`。生产端点/签名/单 ABI/字体/原生版本合同通过；USB 真机 `825f509d` 已覆盖安装，实际 package 49/257、启动成功且进程存活。5562 同源 x86_64 也构建安装通过。
- 最终只读检查：模拟器待上传 0、活动硬件 capture 0、两库 quick_check 均 ok。临时代理、故障 wrapper、18024 reverse、虚拟板均不再运行；自有 5562 已安全退出，空的临时测试 `.venv` 已移除。板串口无临时命名 ACL，真机 TCP 5555 配置仍 0，未改路由器。保留共享 Metro 和其他项目进程，未清用户会议/日程/音频。
- 按最新用户指令结束持续目标，不再开展历史“下一轮”建议。物理拾音质量、旧实板单次中断唯一根因等已有边界保留为未来参考，不冒充已验收；本轮在途实现、构建、原样本恢复与临时测试收尾已关闭。未公开发布、提交或推送 Git。
