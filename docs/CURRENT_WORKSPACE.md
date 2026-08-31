# 老记当前仓库状态

这是协作者进入仓库后的第一份文档。本文只描述当前产品边界；历史阶段、候选回放和旧版界面证据不再留在活跃文档树中。

## 唯一活跃基线

| 项目 | 当前值 |
| --- | --- |
| 活跃分支 | `vnext/implementation` |
| 当前移动版 | `1.1.97`（Android `versionCode=205`） |
| 版本权威 | `app.config.js`；生成的 Gradle metadata 必须由构建门禁核对一致 |
| 产品形态 | 去账号、单设备、本地数据权威 |
| 公网入口 | `https://laoji.cloud` / `wss://laoji.cloud` |

`master`、旧标签、`rebuild/*` 和旧 Stage 文档只用于 Git 追溯，不是开发、构建或发布入口。新工作直接在
`vnext/implementation` 上建立短期分支；不得从 `master` 或旧工作树复制实现回当前链路。

## 当前所有权

- `laoji-schedule.db`：日程、重复规则和日历投影。
- `laoji-meeting-memory.db`：会议、媒体引用、转写、整理、问答、待办、标签和任务投影。
- 应用私有媒体目录：录音、导入后音频和外接设备 pending media。
- 手机是上述业务数据的唯一长期权威；日程与会议数据库物理隔离，不建立跨库外键或双写。
- 服务端只拥有设备鉴权、上传会话、可恢复计算任务、明确允许保留的生成结果和清理义务，不是第二份用户数据仓库。

## 生产拓扑合同

```text
Android app
  -> laoji.cloud (HTTPS/WSS)
  -> laoji-api :18020       设备能力、任务、上传编排、日程复杂解析、整理、问答、地址
  -> laoji-asr :8030        Qwen3-ASR 实时与批量识别
  -> Ollama :21434          生成模型与本地 embedding；provider 可显式切换，禁止静默回退
  -> Cloudflare R2          有 TTL 的上传暂存对象，不是业务权威
```

内部端口只监听 loopback。Cloudflare Tunnel/Nginx 属于入口层；GPU1、PCB、Smart Meeting 和其他用户服务不属于老记。本表描述源码和部署模板的合同，不证明服务器已切换到当前工作树；本轮清理没有部署，现场状态仍须按进程、cwd、unit 和 readiness 单独核对。

## 当前产品边界

- 日程：本机创建、编辑、删除、搜索和视图投影；复杂文字或语音只把解析意图交给服务端，最终校验与保存仍在手机。
- 会议：手机录音、音视频导入、后台上传、实时/批量转写、讲话人异步覆盖、笔记、标签、回收站和 Markdown 分享。
- 整理：一份统一自适应整理；模型产出结构化事实与引用，本机决定板块、图表准入和展示。旧四模板只存在于历史 schema/迁移记录，当前运行时不读取、不展示也不生成。
- 问答：以当前会议的转写、笔记和获准附件为来源；答案引用必须绑定当前来源版本。
- 外接录音：`LJHW/1` 为唯一协议；测试板已支持 USB/BLE 实时采集，正式硬件可按能力增加本地对象和 Wi-Fi 传输，但不建立第二套会议链。
- 音频片段：独立创建/管理入口已退役；播放、搜索、引用和时间跳转直接使用原录音与转写。

## 目录职责

| 目录 | 当前责任 |
| --- | --- |
| `src/domain`、`src/application` | 领域合同与跨领域用例 |
| `src/data` | 两个本地 SQLite 的 schema、迁移和 repository |
| `src/services` | 设备任务、上传、解析、整理、问答和平台适配 |
| `src/screens`、`src/components` | 页面与复用界面；不得成为第二状态 owner |
| `modules/laoji-native-platform` | Android 录音、媒体、日历 surface、硬件 transport、WorkManager |
| `services/laoji-api` | API、持久任务 owner、R2/ASR/LLM 编排 |
| `services/laoji-asr` | 统一 ASR 协议与模型服务 |
| `contracts/hardware`、`docs/hardware` | `LJHW/1` 机器合同与当前集成说明 |
| `config`、`plugins` | 构建和原生配置 |
| `tools` | 当前构建、发布和可执行审计；阶段性探针不得重新成为生产依赖 |

## 文档和历史资料

- 当前架构入口是 [design-blueprint/CURRENT.md](design-blueprint/CURRENT.md)。
- 实现约束是 [design-blueprint/VNEXT-IMPLEMENTATION.md](design-blueprint/VNEXT-IMPLEMENTATION.md)。
- 仍有效的架构决定是 [design-blueprint/VNEXT-DECISIONS.md](design-blueprint/VNEXT-DECISIONS.md)。
- 历史 Stage、候选、回放、截图和旧版研究由 Git 历史及服务器校验归档恢复；它们不应被活跃源码或文档链接引用。

## 工作规则

1. 先核对分支、版本、真实运行进程和数据 owner，再修改。
2. 新写只能进入当前 owner；兼容 reader 不能重新获得写权，也不能因错误自动回退。
3. 每次发布同时递增并核对 `versionName` 与 `versionCode`，再验证 APK、更新清单和公开文件一致。
4. 不提交凭据、用户媒体、APK、构建缓存、虚拟环境或开发机绝对路径。
5. 文档中的“实现、构建、运行、安装、发布、验证”必须分别有对应证据，不能互相替代。
