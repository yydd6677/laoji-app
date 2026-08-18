# Q2 当前样本复跑

状态：`isolated candidate evidence; not adopted`。

使用 `/home/yydd/下载/会议视频样本` 当前快照中的字幕窗口，字幕仅作弱参考，不作为生产提示词、
规则、few-shot 或源代码输入。Provider 为隔离 Ollama `qwen3.5:9b`，Q2 reader 每题一次
真实 provider 调用；冲突题由确定性冲突门直接关闭。

## 结果

- 用例：27
- 通过：27
- 失败：0
- 覆盖：正常回答、枚举、部分字段、明确未提及、来源冲突和引用结构

最终 r8 提交状态的机器可读报告：`q2-current-sample-r8-final-20260819.json`；此前 r2 报告仍保留
作为历史复跑记录。

这不等同于人工引用相关性通过率，也不关闭 Stage 3。仍缺独立母语盲审、完整长会来源流、
Android 页面/恢复回放和 capability barrier。
