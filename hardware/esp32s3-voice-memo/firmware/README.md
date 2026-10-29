# LaoJi Recorder

ESP32-S3语音录音设备的参考固件，基于ESP-IDF构建。支持存卡录音、BLE控制和实时音频、BLE范围读取及可选Wi-Fi文件下载。通信定义见 [硬件接口](../../../docs/hardware/README.md) 和 [BLE 1.3协议](../../../docs/hardware/BLE-1.3.md)。

## 构建

SDK固定为ESP-IDF **v5.5.1**，commit `fcae32885b0296b32044cb99ecbdc50d98dddb83`，包含对应submodule。安装目标为esp32s3，Linux使用SDK的 `install.sh` / `export.sh`，Windows使用 `install.bat` / `export.bat`。

在此目录执行：

```sh
idf.py build
```

`sdkconfig.defaults` 是维护配置。binary、ELF、map、完整sdkconfig和SDK缓存由构建生成，不放入源码仓库。`partitions.csv` 定义构建布局；刷写前必须核对设备实际分区。

## 板级配置

| 部分 | 配置 |
| --- | --- |
| 主控 | ESP32-S3R8，8MiB外部Flash及octal PSRAM |
| Codec | ES7210，I2C地址0x41；SCL=1，SDA=2 |
| I2S | DI/WS/BCK/MCK=10/11/12/13；16kHz，4个16-bit TDM slot，MCLK=256x |
| 麦克风 | wire顺序MIC1、MIC3、MIC2、MIC4；单声道取slot 0与2的平均值 |
| SDMMC | 1-bit；DAT0/CLK/CMD=14/21/47 |
| 录音键 | GPIO38，active-low |
| 按键 | 待机长按800ms开始会议、双击320ms窗口开始日程；录制中短按暂停/继续、长按停止 |
| USB | 调试、控制台和刷写，不提供手机音频传输或可写USB磁盘 |

BOOT和reset保留硬件功能。未定义的扩展引脚不驱动；不声明未实现的电池、充电控制或软件关机能力。缺卡或codec故障不会触发格式化。

## 模块

| 文件 | 职责 |
| --- | --- |
| `control.c` | 串行控制、命令响应、有限重放缓存和传输准入 |
| `recorder.c` | I2S采集、PCM队列、单一存储writer、流式SHA及完成落盘 |
| `storage.c` | RIFF解析、文件generation、元数据索引和中断文件恢复 |
| `ble.c` | 分片重组、JSON指示、PCM通知、MTU和背压 |
| `wifi.c` | 临时SoftAP/HTTP、Range、鉴权、到期和撤销 |
| `wire.c` | 帧格式、文件名、Range和源偏移规则 |
| `capture_context.c` | 用途、原始时刻、时区及采集身份持久化 |

## 音频与存储

I2S任务将完整PCM16块写入256KiB PSRAM FIFO；独立writer负责SD、SHA和提交后的实时环形缓冲。采集不等待文件同步、蓝牙或HTTP。停止时先排空已接收前缀，再完成头、flush/fsync和原子改名。

FIFO耗尽或真实I2S丢失应封存中断来源，不通过丢弃、重编号或补静音伪装完整录音。周期flush不构成断电零丢失保证，接收端仍须验证最终长度和SHA。

`/disk/.laoji-meta` 保存有版本和CRC的元数据索引；缓存失效时重新扫描，写入失败不影响已保存录音。该索引不是签名，接收端仍须验证完整PCM。文件改名和删除同步失效索引。

实时PCM与存卡PCM共用偏移原点。可选实时范围恢复只在能力声明后使用；缺口超出保留范围时，不伪造已恢复的数据。

## Wi-Fi与安全

HTTP支持HEAD、GET和单范围Range。每次offer生成独立随机密码和Bearer token；offer到期后不接纳新请求，已接纳请求可完成，显式close会撤销活动I/O。HTTP worker是唯一socket关闭所有者。

AP名绑定公开硬件身份，凭据不从MAC派生，也不写入Wi-Fi NVS。当前安全模式为development BLE/HTTP；生产配对、隐私地址和端到端加密不在此模式中隐含提供。设备文件名、音频正文和凭据不写普通日志。

## 测试

帧格式测试可在host运行：

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -I main main/wire.c tests/wire_test.c -o wire-test
./wire-test
python3 -m unittest discover -s tests -p 'test_*.py'
```

Python合同测试需要 `jsonschema`。其他host测试覆盖按键、采集上下文、声道映射、FIFO、索引和Wi-Fi lease。

构建和host测试之外，设备需验证codec/SD、全部控制、实时与最终PCM一致性、缺包恢复、暂停/重连、改名与generation拒绝、HTTP Range及token到期。

## 刷写

`tools/flash_app.py` 和 `tools/update_app.py` 具有特定参考板的MAC、现有镜像和分区保护，不是通用刷写脚本。首次迁移前保存完整Flash；后续更新使用当前镜像校验、应用分区写入、写后验证及失败回刷。备份和设备诊断资料不提交Git。

不要直接对已有设备执行未经核对的整片擦除或默认全量flash。新板应先适配板级配置和刷写流程，保留启动程序、分区、存储及设备数据。
