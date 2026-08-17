# 蓝图修订 0016：语音发布原子投影边界

## 状态

- revision: `0016-speech-projection-atomic-seam-20260816`
- status: `candidate`; **not adopted**
- parent: `0015-speech-publication-portfolio-rebalance-20260816`
- production/service/database/App/APK mutation: `none`

## 本轮架构判断

M1-T 的用户结果继续保留：文字先可见，讲话人迟到增强，speaker 失败不隐藏文字。但 0008
和 0009 分别从 server 与 mobile 两端证明，先建独立 probe schema/reducer、以后再映射真实
repository，会增加新的正文、finality、speaker 和 closure 状态。

- server 0008 原 `12/12` 自测有效，但独立审计判定 `rejected-current-shape`；它只证明单进程
  三条 speaker 等待边可删除，没有 attempt/generation/restart/manual/真实 route 合同。
- mobile 0009 修复了 0005 的 Unicode scalar bug且没有新 manual 表，但 close delta、merged
  ordinal、digest 自证、跨会议 manual helper、双 finality 与 exact revision 缺口使其同样被
  否决。

详见 [candidate 0038](../evidence/candidate-0038-mobile-speech-projection-0009-independent-rejection-20260816.md)
和 [candidate 0039](../evidence/candidate-0039-speech-publication-m1t-server-0008-independent-rejection-20260816.md)。

## 路线变更

不再修 0008/0009。当前路线切换为
[P2 原子投影边界](../research/0021-speech-projection-atomic-seam-20260816.md)：

```text
formal transcription job attempt/generation
  -> formal draft/final transcript revision transaction
  -> strict canonical projection envelope
  -> mobile exact-revision consumption cursor
  -> existing transcript + manual speaker owner
```

wire envelope、消费 cursor 和 replacement lineage 是三个窄技术概念；它们不能成为第二
transcript/task/manual owner。

## P2 冻结合同

### Wire

- 只有 `decodeProjectionEnvelope(bytes, expectedIdentity)` 能产生 validated envelope；不暴露
  local digest 参数。
- strict I-JSON schema + RFC 8785 JCS；拒绝 unknown/duplicate key、trim 后 identifier、孤立
  surrogate 和非规范数组顺序。
- delta 不能 close 或 replacement；合并后重验全局 source/ordinal/revision/range 不变量。
- text/speaker close 只来自 full snapshot，且为不可回退终态。
- stable watermark 仍用 Unicode scalar count，但 server 只能在 extended grapheme boundary
  发布新的可见稳定水位。

### 正式 owner

- 现有 `transcript_revisions/transcript_segments` 是唯一正文 owner；现有 `is_final` 是唯一
  finality，不新增 `text_maturity`。
- active transcript revision 是 meeting-level unique；cursor 按 recording asset 记录 slice 水位
  并绑定 exact aggregate revision。单 asset 更新/final 必须保留同会议其他 asset slices，不能
  把一个资产的 final 误设为整场会议唯一 active 内容。
- meeting/scope 通过正式 join 校验，不由 cursor 再拥有一份。
- attempt/generation/run/asset revision/checksum/scope/epoch 进入所有 server write CAS；旧 worker
  fail closed。
- no-speech 与 text 是同 source 的排他 outcome；无声 source 不进入 CAM++。
- speaker close 只在每个有声 source 都有 terminal outcome 后 CAS；closed 后拒绝 patch。

### Final 与 manual

- provisional -> final 使用 old revision segment -> new revision segment 的 many-to-many lineage；
  每个 old 必须 linked 或有显式 dropped reason，每个 final 必须有来源。
- final revision、segments、lineage、active pointer、cursor 与 closed fingerprint 单事务提交。
- 不复制人工姓名。显示层先读 final 正式 locked assignment，再沿 lineage 读旧正式 assignment；
  同名继承，冲突显示 unresolved/unknown。用户在 final 上的新修正仍写正式表并最高优先。
- automatic patch 只能更新 base speaker 字段和它自己的 revision/state，不写 override/manual，
  不改变正文 fingerprint。

## 下一隔离候选

`speech-projection-atomic-seam-0010` 直接从当前真实 migration/repository 形状建立临时库和
adapter，不修改主工作树或生产。它必须先证明：

1. strict decoder 内部 hash 与跨语言 fixture；
2. exact revision/asset/scope/epoch CAS；
3. delta merge、full close 和 speaker terminal closure；
4. split/merge/many-to-many lineage 与 final 原子切换；
5. existing manual assignment 经 lineage 解析且永不被 auto 覆盖；
6. no-speech/text 排他、过载持久终态、process kill/restart 恢复；
7. account/device/guest 的 meeting-level 多 asset projection 同定义。
8. 双 asset 反例：A final + B running 时，B 的 initial/delta/final/retry/delete 不得隐藏或改写
   A 的正文、manual、引用或 active 可见性。

禁止把手写宽松 stub、同函数 wrapper、测试完成时间或静态 schema 当作通过。候选最多完成一轮
实现与一轮独立审计；若仍需第二正文/finality/manual owner，停止当前 speech 组合并回到 Q2-S。

## 投入组合

这是连续第二个 speech 修订。0010 完成一次独立审计后，无论通过或失败，下一蓝图轮次都转到
会议问答 Q2-S shadow，避免第三轮连续深挖同一旧链。U2 继续冻结；不执行真实 R2。日程仍补
人工 graph gold，整理仍补 lineage/atomic commit。

## 用户可见收益

本修订没有修改生产服务、App、APK、数据库、设备或模型。0008/0009 都未接入；当前用户可见
收益仍为 `0`。
