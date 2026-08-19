# Stage 3 Android Q2 纵向证据（隔离候选）

## 结论

`emulator-5562` 已完成当前会议 Q2 的失败任务重试、单次 reader、精确引用、引用跳转和
应用重启恢复纵向回放。候选仍为 `isolated candidate evidence; not adopted`：没有激活
question capability barrier，没有删除 Q0，也没有修改生产 `18020/8030`、GPU1、PCB、
Smart Meeting、真机或公网流量。

## 候选边界

- Android 候选：`1.1.27 (135)`，非调试 APK SHA-256 为
  `7c72908eaaa6751ddd532ded8d6eb89192237723265184a1287cf7ef028a04c0`。
- 设备：专用 `emulator-5562`，通过 `tcp:28121 -> tcp:28023` 访问隔离 API。
- 服务端：隔离 API `127.0.0.1:18023`、隔离 ASR `127.0.0.1:8031`，API release 为
  `/home/zhong/laoji-vnext-candidate/releases/vnext-q2-android-20260820`。
- 当前会议：`39799065_da2-1-16`；canonical meeting 为
  `c94d724d-c4f4-4235-ada8-ee7a2f7de16e`，只读取该会议的当前文字记录。
- Q2 页面来源栏只显示实际来源“文字记录”；没有把整理结果或历史回答声明为来源。

## 真实结果

1. 旧失败 turn 以新的 `retry` operation 接管，predecessor 指向旧失败 operation；原 turn
   ordinal 和问题身份不变。服务端 reader 返回 200 后只形成一份完成结果。
2. 问题“本次会议一共有几位同学介绍应用需求？”得到“五位同学对应用需求做简要介绍。”；
   唯一引用逐字匹配当前会议 `00:10` 的“由五位同学对应用需求做简要介绍”。
3. 引用默认收起。展开后点击来源会关闭问答页、切回当前会议“文字记录”，并定位至
   `00:10` 对应片段，不会跳转到其他会议。
4. 强制停止并重开应用后，完成 turn 从本机 SQLite 恢复，页面没有再次提交 Q2 operation
   或 `questions-v2` 请求。
5. 负向问题“会议中有没有提到联系电话？”返回 `not_stated`：“会议中未提及联系电话。”，
   该 turn 的 citation 数为 0，没有用无关片段装饰缺失信息回答。
6. 暖态负向请求从本机进入 operation 到成功为 2.336 秒，其中服务端 POST 为 1.766 秒；
   首个有引用回答的服务端 POST 为 2.269 秒。这里只是两次观察值，不冒充 p50/p95。

模拟器数据库只读复核结果：一个旧 `original/failure` operation、一个带 predecessor 的
`retry/success` operation、一个新问题的 `original/success` operation；两个完成 turn 分别有
1 条和 0 条引用。

## 回放发现并修复的真实缺陷

1. Q2 operation 原先把 snapshot、request 和 operation 全部拼进 generation ID，超过共享
   operation 的 240 字符边界，真实问题在 provider 前失败。generation 现使用完整身份的
   SHA-256，长度固定为 78。
2. 摘要输入曾使用 NUL 分隔三段身份；Expo 原生 Android SHA-256 路径实际在第一个 NUL
   截断，导致每次 retry 只哈希 snapshot 并碰撞幂等唯一键。输入现改为无控制字符的 JSON
   数组编码，完整三段身份均参与摘要。
3. 真实 Android 稳定 transcript source ID 最长 205 字符，服务端 direct Q2 和共享
   source-stream 合同曾限制为 180，导致 HTTP 422。原始稳定来源边界现统一为 512；模型
   内部仍只接收 `sN` 短别名，不扩大模型输出协议。
4. 长来源流的 transport item ID 曾直接拼接稳定 source ID，同样可能超过 180。item ID
   现由 ordinal 和内容哈希后缀组成，原始 source ID 仍在独立字段完整保留。
5. Q2 页面曾固定显示“文字记录 · 整理结果”，但 Q2 source builder 明确禁止整理结果。
   页面现按实际 thread 来源投影，避免向用户声称不存在的证据来源。
6. retry 创建的 operation 现在显式记录 `predecessor_operation_id` 和 `creation_reason=retry`；
   创建、重绑定、运行和 provider 阶段使用无正文诊断，创建后失败也会收敛为终态。

## 聚焦验证

- TypeScript：`npx tsc --noEmit` 通过。
- Android Q2 owner/来源/身份静态门：`verify_stage3_q2_android_contract.py` 通过。
- Python Q2 reader：22 passed；device-v2 API：7 passed；source stream：15 passed。
- 共享 contract 重新生成并通过 `--check`；真实 205 字符来源 ID 通过 direct reader、设备 API
  和 source bundle Pydantic 边界测试。
- 非调试 release APK 已覆盖安装到 `emulator-5562`；没有操作 `emulator-5560`。

## 尚未满足的 Stage 3 退出门

- 本轮 Android 纵向使用 6 分钟、2233 字的 direct reader 路径；尚未在 Android 上提交超过
  40000 字的 Q2 source stream。服务端长会议 source-stream 回放已有证据，但不能替代设备门。
- 本轮会议没有“我的笔记”，因此笔记来源进入 Q2、冲突处理和重启恢复仍需设备纵向证据。
- 两个问题不能证明问答人工相关性达到 95%，仍需更新样本的独立盲审。
- 旧结果后台迁移、公开零 v1 流量周期、capability barrier 和旧 reader 停写仍未完成。
- Stage 2 纯 CPU ASR 性能门未通过，继续阻止全局候选采用。
