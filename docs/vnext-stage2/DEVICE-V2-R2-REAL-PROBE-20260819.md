# Stage 2 device-v2 R2 真实上传回放（2026-08-19）

状态：`candidate evidence; production not changed`。

## 环境边界

- API：隔离 `127.0.0.1:18021`，release `d193dd2`。
- ASR：隔离 `127.0.0.1:8031`，未修改生产 `8030`。
- 连接方式：临时 SSH 本地端口转发，仅在探测期间存在；完成后关闭。
- R2 前缀：`vnext-staging-candidate`。生产前缀和公网入口未触碰。
- 媒体：`39799065_da2-1-16.mp4`，`19,188,136` bytes。

## 回放结果

| 项目 | 结果 |
| --- | --- |
| 上传模式 | `single`，1 个 R2 对象 |
| 源 SHA-256 | `sha256:085afae46e8b163df72230e97b3f1c1663a9b0b3516f7ecfb9d4ff9218e01999` |
| 任务终态 | `succeeded` |
| 事件总数 | `116` |
| 稳定事件 | `115` |
| 最终事件 | `1`，且为最后序号 |
| 模型 revision | `7278e1e70fe206f11671096ffdd38061171dd6e5` |
| ACK | 通过，确认到最后事件序号 |
| 端到端墙钟 | `276109 ms`，隔离 CPU 候选，不作为生产延迟承诺 |

## 清理回放

首次 purge 返回 `running`，原因是上传对象仍在预签名 URL 的保护窗口内；这不是上传或转写失败。
为了不等待真实 TTL，使用隔离候选内部测试时钟推进到该对象的 `not_before_epoch`，随后执行清理义务处理：

- `cleanup_confirmed=1`，尝试次数为 `1`，无错误码。
- purge 记录变为 `confirmed`。
- binding 变为 `purged`。
- 对应 R2 对象 `HEAD` 返回不存在（`object_present=false`）。

该时钟推进只作用于候选数据库和候选 R2 前缀，不改变生产数据，也不证明真实等待 TTL 的延迟。

## 门状态

这次回放关闭了 Stage 2 的 R2 单对象上传、最终事件、ACK 和 purge 证据缺口；仍未关闭：

- LaoJi 专属 Android 设备的断网、杀进程、token refresh 和本地连续文字投影回放；
- multipart 多片真实设备回放；
- GPU/生产延迟门、旧链路排空和 capability barrier。

因此不能据此切换生产或删除旧上传/ASR 链路。
