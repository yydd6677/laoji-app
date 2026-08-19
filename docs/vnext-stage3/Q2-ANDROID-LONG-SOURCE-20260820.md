# Stage 3 Android 长来源 Q2 与笔记证据（隔离候选）

## 结论

`emulator-5562` 已完成 Android 长会议来源流、当前笔记、定量回答引用、引用定位和应用
重启恢复的纵向回放。状态仍是 `isolated candidate evidence; not adopted`：本轮没有激活
question capability barrier，没有删除 Q0，也没有修改生产 `18020/8030`、GPU1、PCB、
Smart Meeting、真机或公网流量。

## 候选边界

- Android 候选：`1.1.27 (135)`，非调试 APK SHA-256 为
  `0d55e331f792236d82b43c26b948716ad527a7de443d482693600cafba2726c6`。
- 设备：仅使用专用 `emulator-5562`，通过 `tcp:28121 -> tcp:28023` 访问隔离 API。
- 服务端：隔离 API `127.0.0.1:18023`、隔离 ASR `127.0.0.1:8031`，生产端口未触碰。
- 输入：`1377173065-1-160.srt` 的 1357 个参考字幕片段、15336 个字符以及一条当前笔记。
  字幕可能有错误或遗漏，只是长来源流和 Q2 交互夹具，不是 ASR 准确率或真实转写真值证据。
- 问答事实来源只有当前会议文字记录和当前笔记；整理结果、历史回答和其他会议不进入来源。

## 真实结果

1. 长会议从 Android 走 source-stream Q2，而不是把完整来源塞进 direct reader。问题
   “管理公司最后讨论到的股权比例是多少？”得到“中方占35%，华特迪士尼占65%”。
2. 两条显示引用分别定位到当前文字记录 `44:56` 的“上海上海升级在管理公司占35%”和
   `45:01` 的“华特迪士尼占65%”。点击第一条引用后问答页关闭、“文字记录”成为唯一
   选中标签，并滚动到 `44:56` 原文。
3. 当前笔记问题“我在笔记里标记的验收复核编号是什么？”只从“我的笔记”返回编号，
   引用逐字匹配当前 note revision，没有用相似转写替代笔记来源。
4. 强制停止并重开应用后，完成回答从手机 SQLite 恢复。隔离库中的 question task 总数
   在页面重进前后均为 8，证明只读投影没有再次提交 reader/model operation。
5. 隔离库 `PRAGMA quick_check=ok`。成功 Q2 的 source stream、manifest、bundle、item、
   加密正文和 checkpoint 已清理；当前只剩 1 条 cancelled Q2 流墓碑，Q2 加密 payload 为 0。
   另外 4 条 complete 流属于 Summary，不计入 Q2 残留。

## 回放发现并修复的缺陷

1. 原引用校验只确认逐字引用属于当前来源，无法阻止回答中的 35% 配上同一会议远处的
   44% 引用。reader 现在抽取回答的定量声明，删除冲突数字，并只在同来源、同 revision、
   相邻来源窗口内确定性补齐准确引用；没有安全邻近项时失败关闭，不采用远处同值文本。
2. 数字引用匹配现允许原文中的空白差异，但仍要求数值和百分号语义一致。邻近性优先于
   普通词汇重合，避免在长会议中被重复的“占比、公司”等泛词带到其他主题。
3. Android 引用回调曾由 `useCallback([navigation])` 捕获冷启动时尚未 hydrate 的
   `meeting=undefined`。点击会先关闭问答页，再被过期闭包静默拦截。回调现以稳定路由
   meeting ID 校验并将其纳入依赖，同时显式接管 RN/native 标签 generation。
4. 候选 APK 曾漏带 Q2 feature flag，页面重进误走旧问答并显示“暂无问答”。这不是数据
   丢失；正确候选构建重新启用 Q2 后，原完成 snapshot/thread/turn/citation 均可恢复。

## 聚焦验证

- `npx tsc --noEmit`、`git diff --check` 和 `verify_stage3_q2_android_contract.py` 通过。
- Q2 reader 聚焦回归包含冲突百分比、邻近同值、远距离同值拒绝和数字空白四类门。
- 非调试 release APK 覆盖安装、冷启动引用跳转和二次强停恢复均在 `emulator-5562` 完成。
- 验证结束后已恢复系统 Latin 输入法；没有操作 `emulator-5560`。

## 尚未满足的 Stage 3 退出门

- 单个长样本和两类问题不能证明全部更新样本的人工回答/引用相关性达到 95%；仍需独立
  盲审，并覆盖冲突、否定、无答案和多来源长会议。
- 当前笔记已进入来源、引用和持久恢复；笔记 revision 在问答运行中变化的冲突恢复也已
  在后续隔离候选完成，详见 `Q2-ANDROID-ACTIVATION-FENCE-20260820.md`。
- Facts V3 的人工事实支持率、行动候选质量、旧结果后台迁移、公开零 v1 流量周期、
  capability barrier 和旧 reader 停写仍未完成。
- Stage 2 纯 CPU ASR 的首段和 RTF 性能门仍未通过，继续阻止全局候选采用。
