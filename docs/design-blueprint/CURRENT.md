# 老记设计蓝图当前入口

- current architecture: `LaoJi vNext global development baseline`
- architecture revision: `vnext-1`
- baseline release: `1.1.10 (118)`
- design status: `global development baseline frozen`
- production/App/APK/device/GPU mutation: `none`
- source worktree: `/home/yydd/LaoJi-worktrees/feishu-source-driven`
- observed source commit: `48e3b36` plus dirty release source; APK includes migration v39 while HEAD ends at v38

## 权威文件

1. [VNEXT.md](VNEXT.md)：唯一产品画像、全局拓扑、数据所有权、领域合同和质量预算。
2. [VNEXT-IMPLEMENTATION.md](VNEXT-IMPLEMENTATION.md)：真实模块/API/schema 映射、Stage 0-5、迁移、删除和验收。
3. [VNEXT-DECISIONS.md](VNEXT-DECISIONS.md)：SELECTED/STAGED/RETAINED 决策、否决项、风险和证据。

历史 `revisions/`、`research/`、`evidence/` 和 `proposals/` 只提供事实与决策血缘，不再作为开发入口。
用户更新且明确的产品决定始终高于本文。

## 全局结论

vNext 不是某一个会议能力升级，而是覆盖日程、录音/导入、上传、ASR、讲话人、Transcript、
整理/行动、问答、组织/搜索/删除/分享/更新、UI 投影和服务器资源的整体版本。

核心结构：

```text
mobile SQLite + app-private media (business authority)
  -> domain-specific remote intent
  -> laoji-api minimal task/attempt owner
  -> laoji-asr / Ollama / R2 adapters
  -> revisioned result
  -> atomic local projection
```

手机拥有用户业务数据；服务器只拥有设备授权、临时加密任务、生成 artifact、上传 session 和 R2
清理义务；R2 只保存有 TTL 的 staging object。账号和跨设备同步不进入 vNext。

## 领域闭合

| 领域 | 状态 |
| --- | --- |
| 本机数据、设备、隐私、删除 | SELECTED |
| 日程文字/语音解析 | STAGED |
| 实时录音、导入、上传 | STAGED |
| ASR、讲话人、Transcript | SELECTED |
| 整理、行动、模板和编辑 | SELECTED |
| 本场待办、提醒和后续日程 | RETAINED |
| 会议问答 Q2 | SELECTED |
| 标签、分类、搜索、回收站、分享、更新 | SELECTED/RETAINED |
| JS/native 页面投影 | STAGED |
| Provider、任务、资源、可观察性 | SELECTED |

`STAGED` 的目标路线已经确定，只保留一个发布周期的受限适配器；它不是待研究或待选路线。

## 实施顺序

- Stage 0：冻结 1.1.10、导入并版本化真实后端源码、生成共享 schema。
- Stage 1：手机业务权威与 device v2 最小任务 owner。
- Stage 2：原生 R2 上传、文字优先 ASR、讲话人异步 overlay。
- Stage 3：Facts V3 长会闭合、行动候选、Q2 single reader。
- Stage 4：Mention Graph 日程、FTS、ProjectionEnvelope 和全局本地功能。
- Stage 5：删除 account/sync、旧上传、summary v2、Q0、重复 parser、mirror/fallback 并发布。

## 当前边界

三份 vNext 文件已经冻结为全局开发基线，但不是生产采用证明。Q2 和部分 task owner 有独立组件证据，
其余性能与质量数字仍是阶段验收目标；本轮没有把任何 vNext 路线接入服务或手机。后续开发从
Stage 0 开始，不再恢复局部多路线竞争；只有 Stage 1-5 的实施、迁移和发布门通过后才可声明生产采用。
