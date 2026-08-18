# 候选 0022：mobile speech projection 0005 自测

## 状态

- candidate: `$CANDIDATE_ROOT/mobile-speech-projection-0005`
- status: `BLOCK integration; rejected-current-shape`; **not adopted**
- production/App mutation: none
- related blueprint: [revision 0009](../revisions/0009-durable-speech-execution-owner-20260816.md)

该候选把当前手机的 final transcript/speaker 假耦合拆成：

```text
text projection + remote automatic speaker overlay + local manual source overlay
```

手机 cursor 持久化 `asset + generation + run + projection revision + local snapshot digest`；
manual 始终在渲染最后应用，不写回 remote text revision。

## 自测

- TypeScript strict compile 通过。
- Node `9/9`：partial/stable/final、迟到 speaker、manual priority、generation restart、同
  revision 异内容、delta gap、run conflict、closed text immutable、speaker monotonic、空语音。
- 临时 SQLite `2/2`：cursor/overlay CAS、meeting/asset cascade、digest/state constraint、
  meeting-wide manual assignment revision uniqueness。

文件哈希：

- `projection_contract.ts`: `f11222e52b9cd4b25fad18d9f180724d24924c97e831357324848ee2be31ed57`
- `sqlite_schema.sql`: `2a159531eff9de129b109605e9de3c26e834a821081cd712409196f630fad991`
- `tests/projection_contract.test.ts`: `b66df689429f2dad330da6a47479574301d67c727ce0682d8e8f99314834a079`
- `tests/test_sqlite_schema.py`: `08d8d1d82f84f03a43c519fdd19630b35497af69e65818352d364b74002a4086`

## 独立审计

独立复跑仍为 TypeScript `9/9`、SQLite `2/2`，但新增 Unicode 和跨会议反例直接阻塞
集成：实现用 UTF-16 `length/slice` 冒充 codepoint，会接受稳定 emoji 改写并拒绝合法
final；SQLite 还允许一个会议的 asset 绑定另一个会议的 cursor。候选另建 manual overlay，
但正式 App 已有 `speaker_corrections/speaker_assignments`，迁移和旧写权删除均不存在。
完整结论见
[candidate 0037](candidate-0037-mobile-speech-projection-0005-independent-rejection-20260816.md)。

## 尚未证明

1. 未接真实 `saveGuestMeetingTranscript`、Expo SQLite migrations、Device completion provider。
2. 现有 `speaker_assignments` 如何 backfill 到 stable source overlay、如何 dual-read 尚未实现。
3. snapshot digest 必须由手机对规范响应本地计算；候选 reducer 接收已验证 digest，没有实现
   Expo Crypto adapter。
4. 未测试 delete tombstone、不同 asset 多任务、真实 App 重启、UI speaker 渲染或 summary
   stale 行为。
5. TS/SQLite 自测不等于 APK、模拟器或真机验证。

当前形态不再接入或继续自我修补。下一候选直接映射真实 repository，复用既有跨语言
Unicode 合同；不得把自动 speaker patch 伪装成人工 correction，也不得新建第二套 manual
speaker owner。
