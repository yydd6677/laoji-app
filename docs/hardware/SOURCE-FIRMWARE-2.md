# 新板完整源码固件 2.0

2026-10-21：第二块实板已升级为 2.0.3，采用逐流内部 DMA stdio 缓冲和持久校验索引；读取、重启、BLE、Wi-Fi 与真机结果见 [存储优化验收](STORAGE-OPTIMIZATION-20261021.md)。下文各旧镜像哈希与历史检查点不代表当前运行镜像。

当前追加检查点：实板已升为 2.0.2，真机 1.2.22 / 230 已覆盖安装。列表全量哈希阻塞、ES7210 MIC1/MIC2 槽位修正、实体短按和真实短句拾音通过边界见 `PHONE-FIRMWARE2-ACCEPTANCE.md`；下文 2.0.0 哈希和主机结果保留为上一检查点，不代表板上仍运行旧镜像。

用户决策：2026-10-17，放弃基于 donor 镜像的长期补丁路线，独立重写完整可构建的应用固件，备份后覆盖第二块板。沿用新板实际硬件与 BLE 1.3 协议，不要求协作者交付原工程后才能继续。

## 活动源码与构建

- 唯一新固件入口：`hardware/esp32s3-voice-memo/firmware/`，ESP-IDF v5.5.1 / commit `fcae32885b0296b32044cb99ecbdc50d98dddb83`。
- 独立 CMake 工程、维护的 sdkconfig.defaults、板级驱动、采集、存储、控制、BLE、Wi-Fi 与 HTTP；不链接原应用、没有 ABI 跳板或 donor 函数地址。
- 固件标识 `laoji-recorder-2.0.0`，保持 BLE wire major/minor=1/3；现有老记 1.2.21 无需为了协议号另造兼容分支。
- 原程序不是已恢复的完整源码工程。保留原厂镜像、改写前 hw5 整片镜像与旧局部修复源码，供审计/回刷，不再作为活动实现。

## 与旧链路的本质区别

一次 I2S 采集生成唯一 mono PCM，SD 写入、流式 SHA 和实时 ring 使用同一批字节。只有落盘成功后才推进 committed source offset。实时发送使用绝对源偏移，蓝牙失败不缩短偏移、不丢弃后伪装连续；超出 ring 的数据形成显式缺口，最终由同源 BLE 区间读取补齐。控制与音频使用独立有界 mbuf 池，避免音频堵塞时连暂停/结束都无法应答。

录音 owner 与无线连接独立：断开 BLE 后继续存卡，本次实时选择不在重连后偷偷重启。结束修正 WAV、fflush/fsync、rename 后才发布 finished；本工程自身 `.wav.part` 可在启动恢复，外来文件和原录音不被恢复器改写。源 generation、范围、长度和 SHA 始终保留。

状态/列表不读取全部 PCM。新录音使用采集过程中计算的 SHA，旧录音首次查询读全量，随后有界缓存；改名/删除失效。Wi-Fi 延迟分配，临时随机凭据、token 到期与关闭撤销、HTTP HEAD/GET/单 Range；不把 development_http 宣称为生产安全。

## 原镜像与写入边界

- 第二块板 USB MAC `7c:4f:ad:bb:38:b0`。
- 改写前完整 8,388,608-byte Flash SHA-256：`7be392a5c0198ca088412257805b370a2df6199fd1a6659ea97bde5cb3c8e709`。
- 原 hw5 app SHA-256：`91ffc6cb224556b9a48bdd323541295f0516d14a6620719d0484eebe7a2aaefb`，已从整片备份交叉核对。
- 只写 factory `0x10000`，上限 0x3e8000；原 bootloader、分区表、phy_init 和额外 storage 分区不写，SD 不格式化/删除旧录音，eFuse 不操作。
- SDK 启动刷新了 NVS 的射频校准 `cal_data`，未发出 NVS 擦除/写入命令；新旧快照均保留。不能宣称 NVS 全字节不变。
- 最终候选应用为 1,245,360 bytes，SHA-256 `cfbdc624fc13df7829f72749ff522d8d67ff949b29bbdfdc2e8c38d2bad4ce1b`。执行了整个 factory 分区擦除后写入与读回校验，不只覆盖旧镜像前缀；额外 storage 分区不在擦除范围。

## 本轮真实下载暴露的结构问题

初版 HTTP 线程为 8 KiB，但 `download` 自动栈帧为 `0x1880`（6,272 bytes），其调用的 `lj_storage_meta` 又预留 `0x21f0`（8,688 bytes），即使命中缓存仍存在后一预留。该组合越过任务栈，实板表现为 HTTP 超时及调度器、Wi-Fi beacon 等不同位置崩溃，不能把末端 PC 当作真正错误 owner。串口崩溃、反汇编和 JTAG 诊断证据均保留；没有向 SDK 无源码库打补丁。

现把下载 4 KiB 和哈希 8 KiB 工作区移至各自唯一 owner 的有界 PSRAM；元数据函数栈帧降为 `0x1f0`（496 bytes）。所有应用 C 文件建立编译期栈帧上限：一般 3 KiB，独占 8 KiB PCM 线程的 TDM 读取例外为 5 KiB。高水位检查只能反映写入过的区域，不能代替静态调用栈预算。

最终无线配置为 HT20、8 个静态 RX、6 的 RX BA 窗口、8 个静态 TX 和 8 个 cache TX；Wi-Fi/LWIP 优先使用 PSRAM，DMA 保留内部内存。临时 AP 明确设置有效 Beacon/DTIM，不导入旧固件 Wi-Fi NVS 配置。BLE 监督超时从 4 秒扩展到 12 秒，以容纳单无线网卡主机切换 2.4 GHz 网络的短暂调度停顿。时序、内存策略和监督时长分别有适用边界，不能据此宣称它们单独解释所有早期失败。

## 已验证与待验证

- 独立构建成功；实际 ELF/bin/链接 map 可供后续源码定位。主机 ASan/UBSan：字节序、帧、路径/单次 URL 解码、HTTP Range、WAV 和实时绝对源 ring 约束通过。
- 第一次候选因裁掉 GATT_CLIENT 而无法处理此 SDK 的 Indicate confirmation，真实测试未通过；开启相关 SDK 功能后握手通过。没有修改 SDK 二进制。
- 第二轮候选暴露共享 mbuf 被音频占满，真实暂停/状态/结束未通过；分离控制/音频池、合并短尾后重验。
- `firmware2/real-acceptance-c`：326,656-byte 实时 PCM 与完整 SD PCM 逐帧/总量一致，664 个非空帧，首偏移=0，连续前缀=全部 PCM，mismatch=0；音轨为真实 ADC 麦克风环境输入，不是合成音，也不代表人声识别准确率。
- 同轮：完整/区间 BLE 读取、错误 generation 拒绝、中文改名后 generation/SHA 保持、暂停恢复、暂停后停止、删除本轮自己的 scratch、断线期间继续存卡和三轮 Wi-Fi offer/status/close 通过。原有约 4 MB 录音的 SHA 与重写前一致，开始时的全部卡上文件仍存在。
- 长回放 `real-acceptance-long`：1,238,016-byte 源/实时 PCM 完全一致、2,517 个非空帧、缺失/错位=0；原有文件保留。该轮在最终 HTTP 栈修正之前，不混称最终镜像重验。
- `recovery`：受控 ROM 进入/硬复位后，恢复本工程自身 journal；165,888-byte 恢复音频经 BLE 与 SHA 校验，原文件保留。实际等待超过 120 秒验证 Wi-Fi 凭据到期，并验证重新 offer 的凭据轮换。它不是物理断电测试。
- 最终镜像 `balanced-wifi`：真实主机通过 DHCP 接入板端 AP，HEAD/完整 GET/区间及 suffix GET 通过；4,002,860-byte WAV（4,002,816-byte PCM）17.784 秒、0.215 MiB/s，PCM SHA 与旧录音一致。无分块编码混入，错误 generation=412、越界=416（含 Content-Range）、错误 token=401、路径穿越=400。关闭事件 reason=app、全部初始卡上文件保留，原主机 Wi-Fi 自动恢复。此结果是主机/实板，不是 Android 验收。
- 最终镜像 `release-acceptance`：开始响应 0.180 秒（仅设备录音，不是 ASR），647,168-byte SD/实时音频完全一致、1,316 个非空帧、首偏移=0、缺失/错位=0。完整和区间读取、暂停恢复、暂停后停止、中文改名、generation 拒绝、三轮 Wi-Fi 控制、断线继续录音通过；初始 16 个文件保留。
- 最终镜像 `release-recovery`：受控复位恢复 133,120-byte 自有 journal，BLE/SHA 校验通过，开始时的 17 个文件保留。实际等待 122 秒后 AP/凭据到期，重新 offer 的凭据轮换和再次关闭通过。
- 最终镜像 `release-wifi-chinese`：复位后重新通过 DHCP 接入，中文改名录音的完整 HTTP/Range/鉴权/校验矩阵再次通过；647,212-byte WAV 用时 2.585 秒，PCM 与本轮 BLE 来源 SHA 一致。不是只验证 ASCII 旧文件。
- Android 联动和实体按键需在设备重连后补验。当前只识别到 emulator-5562，未清除手机数据，不以模拟器或旧 hw5 的手机证据代替新固件真机验收。未做物理断电、低电量、全天长跑或人声 ASR 质量验收。

## 范围与交付

新工程实现老记所用录音、文件与 BLE/Wi-Fi 合同，不宣称逐项复制原 `usb_wireless_disk` 的全部演示功能。USB 只用于调试/刷写/串口，未恢复可写 USB 磁盘，以免与板上录音共享双写文件系统。电池、软件关机及正式 BLE/TLS 安全能力仍不虚报。

源码、维护的 SDK 默认配置、主机约束测试、实板验收驱动和 app-only 刷写工具可独立交付。最终 bin/ELF/map、实际 sdkconfig 和刷写 manifest 存在证据目录 `release/`。旧修复源码已移出活动工程，并连同原镜像、改写前整片备份收入私有归档；公共源码包不包含 Flash/NVS、录音、Wi-Fi 凭据或 JTAG 原始内存。

私有回滚归档 `pre-source-rewrite-private.tar.gz` 的 SHA-256 为 `d024f6a6dfb7f8f96c5a0496a27335fe3dde216f889ddb2089af7c673b6c3b81`，归档八个普通文件已逐项对照原文件；原固件不能被描述成恢复出的原源码。源码交付包为 `laoji-recorder-2.0.0-source.tar.gz`，不含 SDK、生成缓存和私有回滚材料；依赖由维护者按 README 安装。

交付核对：独立目录按维护的默认配置重建通过，与活动工程的实际 sdkconfig 一致；ASan/UBSan 主机测试、Python 工具编译和差异空白检查通过。板上镜像仍为上面的最终 SHA，后续仅补充文档/验收驱动，没有重写运行固件。当前边界为“完整源码已实现、构建并写入第二块实板，主机/实板已验”；不能升级成“Android、实体按键、人声识别质量和量产安全全部验收”。

后续 Android 模拟器验收已执行，详见 `EMULATOR-FIRMWARE2-ACCEPTANCE.md`：真板中继完成控制、字节完整性和缺口补读，虚拟人声完成实际上传/转写/整理/问答。物理手机 BLE/Wi-Fi、拾音质量、板端 live ASR、冷连接列表性能和整理行动语义质量仍有明确缺口；不能把模拟器核心链路通过当成全部 Android/产品验收。

证据目录：`/home/yydd/桌面/light_plan/output/hardware/new-board-20261015/firmware2/`。原始镜像含 NVS，应仅作私有备份，不上传到公开仓库。构建与刷写工具、主机测试和实板验收驱动随源码保存；本轮未提交/推送 Git 或发布新 APK。
