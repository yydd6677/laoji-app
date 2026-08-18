# 候选 0036：U2-A server domain 与 R2 probe 独立审计

## 状态与范围

- audited candidates:
  - `$CANDIDATE_ROOT/upload-u2-server-domain-0003`
  - `$CANDIDATE_ROOT/upload-u2-r2-sandbox-0004`
- server-domain verdict: **BLOCK**
- guarded-probe verdict: **tool guard accepted; real R2 evidence remains 0**
- adoption: **not adopted**
- production/R2 mutation: `none`

独立审计逐行复核两个候选，并分别复跑 `9/9` 与 `5/5` 本地测试。测试通过只证明候选
自身声明的窄边界；它没有执行 Cloudflare R2、Android 上传、正式 migration、服务端 API
或生产数据写入。

## 0034 的阻塞问题

`meeting_recording_r2_uploads_v1.asset_id` 使用 `ON DELETE CASCADE`。删除 asset 会同时
删除 session 行，但 R2 object、在途 presigned PUT 和 multipart parts 不会随 SQLite 外键
物理清除。当前 schema 只有 `cleanup_after_ms`，没有能脱离 meeting/asset 生命周期继续
存在的 cleanup obligation，因此删除会丢失最后一份持久清理责任。

同时缺少：

- 单调推进的 `last_presign_expires_at_ms` 与由它推导的 `cleanup_not_before_ms`；
- `upload_mode` 与 multipart `upload_id`，因此不能持久重放 abort；
- cleanup 的 `pending/claiming/cleaned/failed` 状态、claim lease、attempt 和脱敏错误；
- Delete/Abort/Head 的最后观察时间和结果分类。

这不是上传业务的第二 owner。窄 cleanup obligation 只能拥有 opaque bucket/object/upload
资源的物理清理，不得激活资产、触发转写或反写 upload generation。它必须在 session 被
cascade 或 purge 前同事务接管责任，并在最后一个 presigned URL 失效后再次
abort/delete/HEAD。

0034 仍只证明 SQLite generation/CAS、固定缓冲 seal 和一次本地 activation 合同。它没有
正式 Android Worker、server probe replay、API、migration 或真实 R2，不能进入 U2-A 纵向
集成。

## 0035 的准确结论

0035 的 fail-closed 工具安全门成立：

- 非 `sandbox/u2/` 前缀、非官方 R2 endpoint、缺 execute/ack 或缺环境凭据均拒绝；
- dry plan 不输出 bucket、access key、secret 或 presigned URL；
- 合成内容和临时目录边界明确。

README 已明确声明从未执行真实 R2，没有把 `5/5` 夸大为网络或对象存储证据。因此本轮
不修改工具，也不把条件通过写成 R2 通过。真实 single PUT 重放、multipart complete/abort、
URL refresh、delete race 和最终 HEAD 仍全部为未验证。

## 对审计报告误读的纠正

临时审计报告有两处不进入正式蓝图：

1. 0034 README 明确列出其不能证明 Android、R2、migration 和用户速度，不存在相反声明；
2. 0034 自测使用 `20 MiB + 123 B` 合成文件，不是报告中的 100 MiB。

这些纠正不改变 0034 的 `BLOCK`，也不提升 0035 的 R2 证据。

## 组合判断

U2-A 当前可保留的合同只有：

- operation name 至少含 `scope + data_epoch + asset + generation`；
- source idempotency root 与 executor name 分离；
- 正式 asset 域拥有 generation、终态 CAS、tombstone 与 activation；
- WorkManager/UIDT 只执行；
- C2 cleanup obligation 独立于业务级联删除，但不能成为业务状态 owner。

本轮不对 0034 做第三次自我补丁。若 U2 继续，只允许建立独立 C2 schema adapter，或在
获得明确外部写入授权后执行真实 R2 probe；否则先冻结 U2，按全局速度、质量和失败证据
重新选择下一领域。

