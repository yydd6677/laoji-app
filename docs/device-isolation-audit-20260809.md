# 设备与数据域隔离验收（2026-08-09）

使用两个临时设备身份和两个独立 data epoch，通过公网 `laoji.cloud` 验证：

- 设备 A 创建会议并读取成功（创建 `201`、读取 `200`，会议 ID 一致）。
- 设备 B 读取 A 的会议返回 `404 / MEETING_NOT_FOUND`。
- 设备 B 的会议列表返回 `200` 且 `total=0`，看不到 A 的会议。
- 设备 B 尝试向 A 的会议登记录音资产返回 `404 / MEETING_NOT_FOUND`。
- 设备 A 携带设备 B 的 epoch 返回 `409 / EPOCH_UNKNOWN`。
- 设备 A 使用错误 secret 返回 `401 / DEVICE_CREDENTIAL_INVALID`。
- 测试后临时会议、epoch 和两个设备主记录均清理；没有触碰现有用户数据。

这组证据覆盖设备身份、epoch 和业务对象三层隔离，不替代问答质量、声纹纵向质量或真机验收。
