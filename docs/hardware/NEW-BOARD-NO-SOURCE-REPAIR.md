# 第二块板：无源码诊断与最小二进制补丁

**历史记录**：2026-10-17 起不再使用 donor 二进制补丁作为活动固件。用户已授权并实施独立源码重写，入口见 [完整源码固件 2.0](SOURCE-FIRMWARE-2.md)。本页 hw5、“当前板上”等描述仅指当时的修复检查点，不是现在的新固件。

## 边界与可恢复性

2026-10-15 用户授权在第二块测试板试刷最小缓冲配置补丁。仅写 factory 应用分区，不写 bootloader、分区表或 eFuse，不格式化或删除 SD 录音。不以二进制镜像冒充原始源码。

- 板 USB MAC：`7c:4f:ad:bb:38:b0`；BLE：`7c:4f:ad:bb:38:b2`。
- 原程序：`usb_wireless_disk`，版本 1，构建于 2026-09-24 13:51:56。
- 原 ELF 标识：`6398ad0b1f897b26cf4a3f074694f5ad6fe17980a35e7b167da366e3f3070a78`。
- factory：Flash `0x10000`，长度 `0x3e8000`。
- 原应用读取范围：`0x10000..0x21ffff`，2,162,688 bytes；SHA-256：`3d3ad5a686de8d793f9e4f035a49d9900b6c17df85bcd36c2c4579a2315942c4`。
- 去除擦除尾部后的原镜像：2,042,784 bytes；SHA-256：`193d5a4b3f6a0310134294d7fbb23481292761f9a13784487ebf56f50534983e`。

原始镜像、生成器、逐轮 manifest、串口和真机证据均在 `/home/yydd/桌面/light_plan/output/hardware/new-board-20261015/`。原始镜像不可覆盖。生成器以原镜像 SHA 固定输入，逐指令校验原字节，仅允许指定指令和镜像 checksum/SHA 改变，所有段地址、大小和启动元数据保持不变。刷写工具还会校验设备端写入哈希。

## 已确认的问题

1. **Wi-Fi 内部内存不足**。原配置静态 RX/TX 各 16、动态 RX 64、TX cache/管理短缓冲 32。串口显示仅分配到 6 个静态 RX，随后 `ESP_ERR_NO_MEM`。启动早期内部 RAM 约 66 KiB，PSRAM 约 8 MiB；后者不能代替所有内部/DMA 分配。
2. **文件服务另有内部内存压力**。`0x4200e944` 申请 16 KiB、capability=8（DMA）的读缓冲，HTTP 栈配置为 8 KiB。先缩 Wi-Fi 缓冲虽能启动 AP，但首次 HTTP 任务未成功；后续 `listen(112)` 是失败清理留下监听 socket 的证据，不能解释成电脑/服务器端口占用。
3. **原 BLE 文件发送遇背压即退出**。文件 worker 在 `0x42012ed1` 调用发送函数；任意非零返回即清 active 并退出，没有等待/重试。原程序读取约 4 MB 文件只收到 6 个连续包 / 2,952 bytes。后续源码化修复和实测见下文，不再以此描述当前候选。
4. **状态/列表慢来自重复全文件工作**。反汇编可见元数据查询执行完整 WAV 的 SHA-256，1024 bytes 分块读取。实测状态/列表约 12.6 秒，约 4 MB 单文件查询/读取应答约 9.3 秒。手机增加异步等待不是板端性能修复。

## 补丁迭代（不得混淆首次启动和完整验收）

| 候选 | 内容 | 实机结果 |
|---|---|---|
| Wi-Fi buffer | 3 条配置指令，RX/TX 16→4、动态 RX 64→32、共享值 32→8 | AP 可启动；文件服务失败，未通过 |
| HTTP stack | 上述 + HTTP 栈 8192→4096 | 首次 offer/close 成功；重复 offer 超时，手机路径出现 BLE malloc 和 SD 内存不足，未通过 |
| HTTP buffer | Wi-Fi 配置 + DMA 读缓冲 16384→4096，并同步全部相关读取上限；HTTP 栈保持原 8192 | 完整读回匹配；连续三轮 offer/close + BLE hello 通过；手机约 4 MB 下载校验通过 |

当前第三候选 SHA-256：`bfd0824b5e7b5c0d012d53197711656eabce345b8f91adb0c91cacb993d871f2`。

第三候选仅修改 7 条指令：

| 虚拟地址 | 修改 |
|---|---|
| `0x4200da4c` | 静态 RX/TX 共享值 16→4 |
| `0x4200da50` | 动态 RX 64→32 |
| `0x4200da65` | TX cache、rx_ba_win、mgmt_sbuf 共享值 32→8 |
| `0x4200e944` | DMA 文件读缓冲申请长度 16384→4096 |
| `0x4200e0e9` | 传统文件读取长度 16384→4096 |
| `0x4200e7ca` | Range 读取长度比较阈值 16384→4096 |
| `0x4200e7d5` | Range 单次读取上限 16384→4096 |

不改共享 literal `0x420002f8`（其他业务也用 16384），而只改上述指令的 literal 引用。分配和两个读取路径必须一起改，不能只缩分配产生越界。Wi-Fi 库的 `rx ba win:32` 打印仍是编译期常量，不作为传入配置实际生效的证明。

## 交接要求

没有源码仍可提取可读镜像、反汇编、验证调用链并尝试局部修复；这不等于恢复了完整工程。协作者仍应把通过验证的缓冲调整、BLE 背压处理、完成文件元数据缓存移植回原工程，并提供 sdkconfig、依赖锁、分区表和可重建版本。当前补丁保留原 app_desc / ELF 标识，实际版本必须以外部补丁 manifest 和镜像 SHA 区分。

## 手机端兼容修复与最终证据

板端能够启动热点后，1.2.18 手机路径仍未完成接收。反汇编显示服务手动设置 Content-Length，随后调用 ESP-IDF 的分块发送；1.2.19 真机响应日志进一步确认 `status=200 chunked=true declared_bytes=4002860 expected_bytes=4002860`。旧客户端按未分块正文读取，会把分块边界当成 WAV 字节。

新增 `HardwareHttpBody`，在已限定为测试板的 development_http 路径中解码分块、核对冗余长度、处理有界 trailer，拒绝截断/超长/无效帧。续传按解码后的文件字节计数。源 generation、最终 WAV 格式、长度和 SHA 校验未放宽。日志只记录状态码、字节数和校验是否匹配，不写 URL、Wi-Fi 密码、token 或内容。

实测记录：

- 手机安装并 dumpsys 确认 **1.2.19 / 227**。APK SHA-256：`797e6aa19667cc68dfebfa7d757358e6dae6bcf2ecce8a38ff77d52309ee0e3b`，46,066,526 bytes，arm64-v8a。
- 设备原录音 `20261015_093115.wav`，2 分 5 秒，PCM 4,002,816 bytes、WAV 4,002,860 bytes，来源 PCM SHA-256：`a255d8342d9fd92592472f1299954ebc204ed1666c382b773bfcab8c122dda73`。
- 20:44:32.205 收到响应头，20:44:35.714 `wifi_download_verified bytes=4002860 sha_match=true`，约 **3.509 秒**。该耗时不含系统 WLAN 授权、关联与板端响应前的全文件 hash；不是完整点击到完成耗时。
- 20:44:36 板端停止 HTTP、释放读缓冲和 Wi-Fi；之后 recording.list 应答成功，手机仍为“设备已就绪”，该文件为“已接收”。未删除板上源文件、未自动加入会议。
- 原生硬件单元测试 **41/41**（其中新增 HTTP 18 项），TypeScript、UI 构建门禁和 arm64 release 构建通过。
- `http-buffer-three-cycles.json`：无需重启连续 3 轮 offer/close/hello 全部成功，每次 offer 约 0.30–0.36 秒。控制台未发现 malloc、SD 内存不足或端口占用错误。
- `http-buffer-candidate-flash-readback.bin`：读回前 2,042,784 bytes 与候选完全一致，其余读取尾部与原备份完全一致。

证据：`app-1.2.19-phone-verification.log`、`app-1.2.19-http-real.jsonl`、`http-buffer-three-cycles.json`、`http-buffer-three-cycles-console.jsonl`、`http-buffer-readback.log`。

第三候选作为已验证的 Wi-Fi 恢复基线保留，当前板上已更新为下述源码化候选。本次 APK **仅覆盖安装真机，未公开发布**。二进制绑定仅限本板镜像，不作为所有量产设备通用固件。

## 源码化局部修复（2026-10-15 后续）

源码位于 `hardware/esp32s3-voice-memo/firmware-repair/`，包含 C 实现、ABI 跳板、固定镜像生成器和主机 ASan/UBSan 测试，不是反编译恢复出的完整原工程。设备当前应用候选：`hw5/laoji-hw2.bin`，SHA-256 `91ffc6cb224556b9a48bdd323541295f0516d14a6620719d0484eebe7a2aaefb`，2,044,864 bytes；esptool 写入哈希校验通过。

- 对已构造的同一音频帧重试，仅处理 NimBLE `EAGAIN/ENOMEM/EBUSY`，不重新分配序号。文件最多等待 5 秒，另有次数上限；实时音频仅短重试。保留取消与永久错误退出。
- 文件名列表和文件数量统计只验证文件/WAV，不计算随后丢弃的整份 SHA。完整元数据、BLE read 和 HTTP 仍要求全量 SHA。
- 完成文件增加本次开机内的 16 项 PSRAM 哈希缓存（6,016 bytes），键包含完整路径、区间、stat 和变更 epoch。写入/改名使缓存失效，录音/暂停不使用缓存，重启失效，分配失败回到全量校验。
- 状态区 64 bytes 从固定 heap 区域末端显式扣除并由新 DRAM 加载段清零，不借用未知 BSS。保留原六段加载地址，仅扩展 IROM、修改指定调用/literal/heap 长度并追加状态段。
- 首次读取改为 POSIX 分块直读，避免 nano-newlib 小缓冲反复读取；SHA 算法和范围不变。NimBLE 逐包 INFO 日志关闭，保留警告/错误。

真实证据（均不是手机端最终验收）：

| 边界 | 结果 |
|---|---|
| hw3 `status.get` / `recording.list` | 约 12.5 秒分别降至 0.127 / 0.110 秒；列表检查实现与 hw5 相同 |
| hw5 冷态约 4 MB 元数据 | 9.2 秒降至 2.779 秒；旧路径计时中读取约 8.9 秒、SHA 约 90 ms |
| hw5 已缓存读取应答 | 0.128 / 0.134 秒 |
| hw5 无 USB 日志读取程序、连续两次 BLE 全量接收 | 每次 4,002,816 bytes / 8,136 包；序号/offset 连续，最终 SHA 与原来源完全一致；100.834 / 96.582 秒 |
| hw3 连续三轮热点开关 | offer 0.288–0.351 秒，close 和后续 hello 均成功；仍需对最终 hw5 做手机 Wi-Fi 回归 |

不能抹去的未通过项：

1. Linux 实时录音存在断连，尚未证明是真机 Android 同样的问题。另一轮实时录音控制和 SD 完整读取成功，但实时镜像与源不一致；一段镜像头部在源的 offset 7168 才找到。此值是该样本观测，**不能硬编码成修复偏移**。App 现有全量 SHA 拒收/重读仍是安全边界。
2. 部分无 USB 日志读取的早期候选长传输失败；最终 hw5 两次完整接收通过，只能证明这两次，不代表长时间稳定性已经验收。
3. 初次原始 SHA 仍有实际 SD 读取成本；缓存命中不得冒充冷态加速。正式固件还需统一 PCM 来源与稳定源 offset，不能只把镜像错位隐藏到 App。

证据：`hw5/no-reader-full.json`、`hw5/live-bytes-check/`、`hw3/first-probe.json`、`hw3/warm-full-regression.json`。源录音和手机既有数据未清除。

## 模拟器先行验证边界

用户要求先模拟器、再真机。仅启动 LaoJi 专用 `emulator-5562`，安装当前源码的 1.2.19 / 227 debug。`tools/hardware/virtual_board13.py` 通过 Android netsim 提供显式虚拟 GATT 外设；未在生产 App 加模拟开关。原生扫描、系统附近设备授权、hello、校时、状态、列表、完整 BLE 接收已跑通，虚拟 128,000-byte PCM 落为 128,044-byte WAV 并显示“已接收”。

首轮实时测试出现模拟器 `/vendor/bin/bt_vhci_forwarder` 自身 SIGABRT（`Received invalid packet type 0x57`），继发 Bluetooth HAL 和系统蓝牙进程退出；不将该结果冒充老记/实板录音故障。重新启动模拟器蓝牙、将虚拟外设 DLE 设置为 251 bytes 后，有界复测完成开始、暂停、继续、结束和完整接收，未再出现该 HAL 崩溃。这是模拟环境配置，不是生产链路或板端补丁。

复测显式注入晚起步的实时镜像：最终长度正确但内容 SHA 不匹配，原生日志记录 `pcm_integrity_failed`、`pcm_integrity_refetch`；App 拒绝提交错误镜像并完整重读，最终显示“设备已就绪”和“已接收”。以下字节比较通过 `adb exec-out run-as` 读取实际落盘文件，不仅检查状态文案：

| 本地结果 | WAV / PCM bytes | 结果 |
|---|---|---|
| 原有虚拟录音，4 秒 | 128,044 / 128,000 | 单声道 16 kHz / 16-bit，元数据长度、整份 WAV SHA、PCM 与虚拟来源逐字节一致 |
| 实时虚拟录音，45.280 秒 | 1,449,004 / 1,448,960 | 暂停/继续/结束完整，补读后同上各项校验通过，`interrupted=false` |

证据：`virtual-board-dle.log`、`emulator-local-verification.json`。本轮只验证本地硬件接收，不将测试音频上传生产服务；模拟器旧设备身份的云端 bootstrap 返回 409，不混作硬件测试结果。虚拟外设是测试设施，不是实体设备无线、SD、麦克风、真实语音或吞吐性能证据。

这一轮真机原无线地址随后不可达，mDNS 未发现、USB 未接入；后续真实手机回归待连接恢复，不把上一轮安装/通过记录当成本轮验证。
