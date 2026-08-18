# 候选 0014：Qwen3-0.6B span producer 对照

## 状态与范围

- status: `observed; isolated local-GPU comparison; rejected raw candidate`
- observed: `2026-08-16 Asia/Shanghai`
- model: Ollama `qwen3:0.6b`, digest
  `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435`
- GGUF: Q4_K_M, reported parameter size 751.63M
- hardware: local RTX 4060 Laptop GPU 8 GiB, not production RTX 5090
- input/prompt: same 30 rows and `span-text-r2` prompt as candidate 0013
- production server, service, device, database and APK: unchanged

模型在独立 `127.0.0.1:31435` Ollama 进程运行，模型目录位于 `/tmp`。现有本机
11434 未修改；实验结束后进程、模型文件、临时 Ollama key 和 1.4 GiB 显存均已清理。

## 资源观测

- download footprint: 522,653,767 bytes；
- loaded VRAM at 8,192 context: about 1,440,019,906 bytes；
- all 29 layers offloaded to local GPU；
- prompt tokens: 1,195；output tokens: 2,539；
- cold wall: 52.55 s；其中 model load 19.17 s、prompt eval 13.76 s、generation
  19.62 s；按本次分解估算同配置 warm batch 仍约 33.38 s。

这些速度不能与 candidate 0013 的服务器 RTX 5090 直接横比；硬件不同，因此不能得出
“0.6B 比 9B 更慢”的模型结论。

## 质量观测

| metric | observed |
| --- | ---: |
| output rows | 29/30 |
| source-intent agreement | 6/29 |
| missing IDs | 1 |
| operation `clarify` | 23/29 |
| create/delete/query | 2/2/2 |

模型把 create、query、delete 三类大量压成 `clarify`。这不是 source label 少数歧义能
解释的分歧；在同一 public diagnostic 上，raw 0.6B 明显没有承担 joint intent/span
producer 的能力。把它部署到生产 5090 可能改善速度，不会自动修复 operation 语义。

复现结果：

- `$CANDIDATE_ROOT/schedule-span-producer-0001/span-probe-output-30-qwen3-06b-20260816.json`
- `$CANDIDATE_ROOT/schedule-span-producer-0001/span-probe-report-30-qwen3-06b-20260816.json`

## 决策

拒绝未微调的 Qwen3-0.6B 作为日程首路径或 9B 无损替代。暂不在服务器下载、加载或
保留该模型。未来若存在专门的 intent/span 蒸馏或 fine-tune，它必须作为新的 model
revision 重新评估，不能继承本次 raw 模型结论。
