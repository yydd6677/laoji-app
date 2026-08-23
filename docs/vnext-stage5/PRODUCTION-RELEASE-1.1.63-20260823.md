# vNext Android 发布记录：1.1.63（171）

## 结果

- 发布状态：已开放在线更新。
- Android：`1.1.63`，`versionCode=171`，包名 `com.laoji.app`。
- 本次仅改变客户端会议整理投影；生产 API、ASR、Ollama、GPU 和其他服务未重启。
- 旧 APK、`1.1.62` 清单和 V3/旧模板历史 reader 均继续保留。

## 设计审计与落地边界

真机记录 `1436403866` 暴露的是产品抽象和投影实现共同造成的问题：四模板把相同 `context` facts
换标题重复展示，“访谈”把任意 speaker 片段当观点，普通条目和板块 citation 又重复显示讲话人/时间。

本版没有把更大的 Knowledge V4 schema 直接切入生产 9B Provider。现役 Facts V3 输出已有少量任务需要
一次 schema repair，直接扩大 provider DTO 会增加生成失败和延迟风险。1.1.63 先采用已审计的 V3
compatibility adapter：

- 四个 active 模板合并为一份自适应整理，旧模板字段只保留历史/线协议兼容；
- 每条 fact 只有一个可见 primary owner，并按归一化正文跨板块去重；
- 时间线、线性流程、显式方案对比、数据项、风险和问题满足证据条件才显示，否则省略；
- 不再以“存在 speaker”推断观点，V3 没有明确 viewpoint 语义时失败关闭；
- 普通条目移除讲话人/时间尾注，每个板块只保留一个去重的“依据 N 处”入口；
- “板块”sheet 仅保存本机显隐偏好，快速连续切换使用串行持久化，不联网、不新建整理版本。

Knowledge V4、显式 viewpoint/metric schema、表格/条形图和 0047 artifact 迁移仍属于后续 shadow，
本记录不将它们伪报为已上线。

## 验证

- `npx tsc --noEmit`：通过。
- V3 自适应投影/去重/行动/分享合同：`4/4` 通过。
- TypeScript projection contract：通过。
- Release Kotlin 编译和完整 APK 构建：通过。
- `verifyLaojiReleaseContract`：生产域名、vNext 开关、设备引导密钥和更新签名全部通过。
- 专用 `emulator-5562`：覆盖安装后为 `1.1.63 (171)`，冷启动无白屏/崩溃；真实 6 分钟视频导入从
  “等待上传录音”推进到“正在生成文字记录”，并在最终完成前显示稳定文字片段。
- 同一真实视频在转写完成后点击生成，约 22 秒得到自适应结果；V3 证据只支持概述和主题时页面没有
  伪造观点、流程或图表，也没有四模板入口。概述的 7 条引用收纳为一个依据入口，点击其中 `00:26`
  的来源准确切回对应文字记录。
- 公网 `latest.json` 返回 `1.1.63 (171)`；公网 APK 流式 SHA-256 与本地产物一致。

## 产物

- 本地产物：`artifacts/vnext-releases/1.1.63-171/laoji-vnext-1.1.63-171.apk`
- 公网地址：`https://laoji.cloud/downloads/android/laoji-1.1.63-171.apk`
- SHA-256：`2279f63b09bb9d8f65a51ad0fdd217f33b61f319b47eebbe38d3aff10b2b9515`
- 大小：`82665955` bytes
- 签名证书 SHA-256：`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
