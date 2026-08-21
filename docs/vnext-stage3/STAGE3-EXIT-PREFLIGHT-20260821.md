# Stage 3 退出预检（2026-08-21）

状态：`27/39 gates passed; independent human quality and public zero-legacy cycle pending; Stage 3 not adopted`。

## 目的

此前 Stage 3 的来源流、Facts、行动、Q2、Android 恢复、延迟、清理和隐私证据分别存在，但没有一个
失败关闭的聚合门。`tools/vnext/verify_stage3_exit_preflight.py` 现在统一检查：

- source stream 与 Q2 Android 静态 owner 合同；
- 隔离 API、source stream、Q2 capability 及冻结 Summary runtime revision；
- Facts 首次 Schema、Facts/Q2 显示引用、重复行动和单次模型调用；
- Facts/行动与 Q2 两份独立人工质量报告及 `>=95%` 指标；
- Summary 单包 p50/p95、长会 p95 和 Q2 暖态 p95；
- Summary/Q2 进程恢复、来源变化围栏、旧版升级、唯一 current version 和本地模板切换；
- Task/binding/临时载荷清理与正文日志命中；
- 公开 Summary V2/Q0 零旧提交周期。

工具只读取仓库和证据 envelope，固定输出 `candidate_only=true`、`production_mutation=false`；它不写
capability barrier、不调用生产接口，也不把缺失证据推断为通过。

## 当前机器结果

输入：`docs/vnext-stage3/stage3-exit-evidence-20260821.json`。其中运行 revision 已在隔离 `18030`
真实 capability 读取确认；自动质量、延迟、恢复、清理和隐私值逐项指向文件内 `evidence_sources`。
人工报告保持空对象，公开周期保持未完成，避免用占位值制造通过。

运行：

```bash
PYTHONPATH=tools/vnext:services/laoji-api \
  python3 tools/vnext/verify_stage3_exit_preflight.py \
  --evidence docs/vnext-stage3/stage3-exit-evidence-20260821.json
```

结果：39 门通过 27 门、阻断 12 门。12 个机器阻断实际收敛为三项外部门：

1. Facts/行动两份人工评审与第三人裁决尚未完成，因此血缘、总质量、事实支持/准确和行动真实性/
   日程适配共 6 门阻断；
2. Q2 两份人工评审与第三人裁决尚未完成，因此血缘、总质量、正确/完整/引用相关共 5 门阻断；
3. 公开 Summary V2/Q0 零旧提交完整发布周期尚未发生，共 1 门阻断。

静态 owner、隔离 capability、自动结构/引用/调用次数、四项延迟、八项恢复、三项清理和正文日志门均
通过。该结果不能越过上述三项外部门，也不等于 capability 已采用。

## 后续填充

人工流程完成后，把两个 `stage3-human-quality-v1` 内容无关报告写入 envelope 对应字段；公开周期完成
后填入 `complete=true` 和两个真实旧提交计数。预检全部通过后仍需人工激活 capability，不能由本工具
自动切生产。
