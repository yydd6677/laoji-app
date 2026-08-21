# Stage 3 Facts V3 富内容 Android 回放

状态：`all rich block shapes replayed on emulator-5562; source data restored; Stage 3 not adopted`。

## 验证范围

Facts V3 的富内容并不是模型直接生成的任意 UI。候选继续只允许
`paragraph/bullet_group/quote/timeline/flow/comparison/risk_card/stat` 八种本地白名单块，并由同一份
事实、关系、引用和行动候选确定性投影。本轮增加 Release-target Android 测试夹具，在一个已经关联
Facts V3 的现存会议上临时投影 10 条中性事实、3 条关系和 1 个行动候选，用于补齐真实样本不一定同时
覆盖全部块类型的可见验证。

夹具在替换 `summary_fact_documents.document_json/coverage_json` 前创建单行 SQLite 备份表；不创建会议、
整理版本、行动项、Transcript 或网络任务。恢复操作要求当前会议、版本和文档身份均未变化，否则拒绝
写回；写回原始 JSON 后删除备份表，并执行 `integrity_check` 和 `foreign_key_check`。

## 发现与修正

回放发现访谈模板的“后续问题”虽然由事实投影生成，却会在同一文档含行动候选时消失。根因是旧行动区
识别器以“后续”前缀兜底，把“后续问题”误判成重复行动区并隐藏。

候选把已规范化 section 标题分类提取为无依赖纯函数：问题、提问、疑问、待确认问题和开放问题（含
“后续/下一步”前缀）先明确排除；后续行动、待办、任务和跟进等仍归行动区。投影合同增加回归断言，
确认“后续问题”为非行动区而“后续行动”仍为行动区。与 activation fence 合并运行 `27/27` 通过，
TypeScript 和 Stage 3 Android 静态合同均通过。

## Android 结果

候选 APK `1.1.47 (155)` 已覆盖安装到老记专用 `emulator-5562`：

- Release APK 大小约 `79 MiB`，SHA-256 为
  `f1ea4931797de698c950f235272514574e04ce710de3b70cd06b3941f539fbc6`；
- Release androidTest APK 大小约 `371 KiB`，SHA-256 为
  `400795140a05ac3618d9e83361a2c7b2d385452f14ab280b326a5ac2dcc829e1`；
- 覆盖安装后的冷启动 `TotalTime=426ms`，恢复原数据后的冷启动 `TotalTime=555ms`，无白屏或崩溃；
- 标准蓝下验证段落、项目符号、引用、统计、时间线、流程、方案对比和风险卡；
- 绚彩下复核访谈引用/问题、项目风险卡、时间线、流程和方案对比；
- 1080×2400 窄屏上的流程块按合同退化为纵向编号列表，没有横向溢出；
- 访谈模板同时存在行动候选时，“后续问题”已可见；引用、风险卡和对比项没有文字截断或嵌套卡片；
- 全程只改变本地投影视图，没有生成新整理版本。

回放结束后，恢复测试返回 `OK (1 test)`；原始 Facts JSON/coverage 已写回，临时备份表已删除，SQLite
完整性和外键检查通过，测试包已卸载。主题恢复为“标准蓝”，目标会议模板偏好恢复为回放前的“访谈”；
设备只保留产品包 `com.laoji.app 1.1.47 (155)`。

## 边界

本证据关闭富块全类型、两主题可见回放和“后续问题”误隐藏，不代表模型生成内容通过独立人工质量门。
Stage 3 仍缺独立人工 Facts/行动/Q2 `>=95%`、公开零旧链路周期和 capability barrier，因此保持
`isolated candidate; not adopted`。生产 `18020/8030`、公网、GPU1、PCB、Smart Meeting 和
`emulator-5560` 均未改变。
