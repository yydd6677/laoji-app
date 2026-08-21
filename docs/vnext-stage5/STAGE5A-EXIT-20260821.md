# vNext Stage 5A 退出记录

结论：Stage 5A 已完成，候选版本为 `1.1.55 (163)`；Stage 5B legacy 物理删除延期。

这里的“完成”只表示 vNext 候选已经具备单一 owner、可恢复任务、隔离 capability barrier、可回溯
APK/服务包和显式整链回滚能力。它不表示人工质量被测量通过，也不表示生产已发布。

## 门禁结论

| 项目 | 结论 |
| --- | --- |
| Stage 2 | 通过；28 项中 8 项产品所有者风险豁免，阻断 0 |
| Stage 3 | 通过；39 项中 12 项产品所有者风险豁免，阻断 0 |
| Stage 4 | 通过；29 项中 6 项产品所有者风险豁免，阻断 0 |
| 五项 capability adoption | 通过，provenance 均绑定同一 waiver SHA-256 |
| 单一 active path | 通过；无双写、无请求级静默 fallback |
| 数据库迁移/恢复 | 通过；integrity、FK、任务/上传/清理 drain 均闭合 |
| APK 与服务端交付物 | 通过；身份、签名、哈希、敏感文件名审计通过 |
| legacy 删除 | 未执行、未授权，`safe_to_delete=false` |
| 生产发布/公网切换 | 未执行、未授权 |

waiver 是产品风险决定，不是质量证据。被豁免门的原始失败证据完整保留在三个退出预检 JSON 的
`underlying_evidence` 中。

自动化回归：vNext 工具门 `118/118`、服务端 API（含冷保留 legacy 合同）`642/642`、vNext 主路径
聚焦子集 `242/242`、TypeScript `tsc --noEmit` 通过；候选 Android release 构建成功。测试仅剩既有
`datetime.utcnow()` 与 pytest-asyncio 配置弃用警告，不影响本次候选合同。

## 真实纵向证据

- `emulator-5562` 覆盖安装候选后正常首帧，旧 device identity 收到 `DEVICE_NOT_REGISTERED` 后自动
  完成 challenge/bootstrap，六项 device capability 全部为 true。
- 真实会议转写生成 Facts V3：240 段、9 个 facts、27/27 引用逐字可解析；进程在 worker 停止后重启，
  同一持久任务恢复成功。
- 同一 immutable source 的 Q2 可回答问题为 3 个 clause、8/8 精确引用；幂等重放结果一致且暖态
  约 182ms。不可确认的问题失败关闭为 `cannot_confirm`，不拼模板答案。
- 复杂中文日程走 `server-model` MentionGraph，约 1.98s，source hash 和完整 graph 均持久化。
- Stage 2 的真实导入、连续 stable transcript、NO_SPEECH、CAM++ overlay 和中断恢复证据继续有效。

人工事实支持、行动质量、Q2 主观相关性、自然中文日程字段质量以及正常使用零旧调用周期均按用户明确
决定跳过，因此只能写 `waived`，不能从上述自动化证据推导为人工 `>=95%`。

## 运行和资源边界

最终候选 API 为 loopback `18034`，RSS 约 700 MiB，无 GPU compute context；服务器剩余磁盘约
462 GiB。它复用既有 8030/Ollama 服务，不新增常驻模型。GPU1 未改动。静态和真实候选日志扫描均为
0 项正文/敏感字段发现。

测试候选 `18030/18032/18033` 尚有同一组 R2 cleanup obligation 等待 presigned URL 安全窗口；为避免
远端对象在仍可能被合法读取时被删除，本次不强制完成、不删除数据库。最终 `18034` 自身生命周期已
全部排空。

## 后续边界

下一步若发布，属于独立的生产切换授权：部署正式 loopback 服务、备份/迁移生产库、切公开 APK 和观察
实际使用。旧链路继续冷保留。只有以后用户再次明确授权 Stage 5B，才重新审计 reader removal、旧任务
查询、进程 cwd/open files、源码引用和零旧调用，再执行物理删除。
