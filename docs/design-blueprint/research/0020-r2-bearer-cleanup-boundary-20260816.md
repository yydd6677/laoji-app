# 研究 0020：R2 bearer URL 与删除后写回边界

## 状态

- status: `research candidate; not adopted`
- date: `2026-08-16 Asia/Shanghai`
- scope: U2-A 的 presign、object key、checksum 与清理所有权
- production mutation: `none`

本轮只读取 Cloudflare 官方文档和老记现有源码，没有调用老记密钥、修改 bucket、创建对象
或上传私人内容。Web 搜索工具当时返回 `auth_not_found`，因此直接读取 Cloudflare 官方文档
站点对应的官方 GitHub 源文件；这不改变资料的候选性质。

## 官方约束

### Presigned URL 是到期前可重复使用的 bearer token

Cloudflare 明确说明 presigned URL 授权单个 operation/object，期限可从 1 秒到 7 天；拿到
URL 的任何人都能在有效期内执行对应操作，同一 URL 可以重复使用直至到期。PUT URL 只在
S3 API 域名工作，不支持 R2 custom domain。

来源：<https://developers.cloudflare.com/r2/api/s3/presigned-urls/>。

这对老记的直接后果是：single PUT 在取消后立即 `DeleteObject`，不代表对象不会被一个已经
在途或重试的旧 PUT 再次写回。multipart abort 会使旧 upload ID 失效，但仍应保留到期后
复核/清理门，不能把一次 best-effort abort 当作物理删除证明。

### 同 key 并发写不是免费 CAS

R2 limits 当前写明：同一 object key 每秒最多一个并发写，更高频率返回 HTTP 429；单对象
最多 10,000 parts，single-part 最大 5 GiB，multipart 最大约 4.995 TiB。

来源：<https://developers.cloudflare.com/r2/platform/limits/>。

因此不同 generation 复用同一个 key 既没有 exactly-once，也会把旧客户端重试变成新任务
的限流或覆盖风险。每个 operation 必须使用唯一 staging key；重试同 generation 才允许
复用同 key 和 multipart upload ID。

### R2 不能替代老记的最终 SHA-256

R2 S3 compatibility 当前支持 composite SHA-256，但不支持 `FULL_OBJECT` SHA-256。ETag 也
不是老记跨 single/multipart 都可依赖的内容摘要。

来源：<https://developers.cloudflare.com/r2/api/s3/api/>。

因此服务端下载 staging object 时固定缓冲计算 SHA-256 仍是必要的完整性边界；不能为了
减少一次读而信任 ETag、客户端 digest 或 R2 metadata。

### 生命周期规则只是延迟安全网

R2 官方说明对象通常会在 expiration 后 24 小时内删除；bucket 默认在 multipart initiation
七天后终止未完成 multipart。可以对特定 prefix 配置更早规则，但它仍不是同步删除事务。

来源：<https://developers.cloudflare.com/r2/buckets/object-lifecycles/>。官方 multipart 示例还
明确给出非末 part 最小 5 MiB：
<https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/>。

老记已有 24 小时 bucket safety net 只能限制最坏残留时间，不能替代 API/数据库中的清理
义务、删除状态或隐私删除完成判定。

## 对当前正式源码的影响

当前 `presign_put_object()` 与 `presign_upload_parts()` 使用固定 TTL 生成 URL，但正式 session
只保存 session `expires_at`，没有保存每次刷新 URL 后的 `last_presign_expires_at`。初始化、
查询或 resume 都可能重新生成 URL，因此 session expiry 与最后 bearer URL 到期并非天然
同一事实。

当前 cancel 对 single PUT 立即 delete，对 multipart 立即 abort；成功 complete 后也立即
best-effort delete。session 又通过 meeting/asset 外键级联删除。若旧 single PUT 在 delete
后、URL 到期前抵达，或者成功后的 delete 失败，现有记录可能已经没有可恢复的 object key
与再次清理时间。

## 收紧后的 cleanup contract

### 必须持久的字段

每个 R2 operation 至少保存：

- opaque operation-specific object key；
- upload mode 与 multipart upload ID；
- `last_presign_expires_at`，每次生成或刷新 URL 只能单调延后；
- `cleanup_not_before = last_presign_expires_at + clock_skew_margin`；
- `cleanup_status = pending/claiming/cleaned/failed`、claim lease、attempt 与脱敏 error code；
- 最后一次 `HeadObject/DeleteObject/AbortMultipartUpload` 的观察时间与结果分类。

这些是物理资源清理事实，不拥有 asset/generation 业务状态，也不得反向把上传改成成功。

### 删除顺序

1. 业务事务先 tombstone asset/generation，拒绝所有旧 complete/activate。
2. 立即 best-effort abort/delete，降低当前暴露窗口。
3. 在删除 meeting/asset/session 前，将 bucket、opaque object key、multipart ID、
   `cleanup_not_before` 原子移交到不会被业务外键级联删除的 cleanup obligation。
4. `cleanup_not_before` 后再次 abort/delete，再以 HEAD 不存在作为 cleaned 观察；临时网络失败
   有界重试，bucket lifecycle 只作最后安全网。
5. cleanup obligation 只在 object 不存在且 multipart 已 abort/不存在后删除或压缩归档；
   不记录文件名、会议标题、用户正文或坐标。

### 成功路径也需要 obligation

single PUT 完成、服务端 seal 并激活后，即使第一次 delete 成功，也要保留到 bearer URL
到期后的第二次 delete/HEAD。multipart complete 后旧 upload ID 通常不能继续写 part，但
统一保留有界 obligation 可以覆盖 delete 失败和状态不确定，不需要另造成功特殊分支。

## 两种实现选择

| 选择 | 形态 | 优点 | 风险 | 当前判断 |
| --- | --- | --- | --- | --- |
| C1 session 脱离业务 FK 后保留 | asset/meeting 删除时把 session 改为 detached cleanup row | 少一张表 | session 同时表达传输和清理，nullable identity/约束复杂，容易再次成为 owner | 不首选 |
| C2 有限 cleanup obligation | 删除前从 session 原子投影到只负责 opaque 物理资源的表 | 业务 owner 与物理清理职责清楚，可跨 cascade/restart | 多一张窄表和 reaper；必须禁止反向写业务状态 | **首选候选** |

C2 不是通用 task ledger：它只接受 R2 object/multipart 与 operation-private sealed temp 两种
资源；没有任意 payload、业务 retry、用户文案或 meeting stage。清理完成与否只影响隐私/
磁盘 ready，不把 asset 重新激活。

## 下一真实门

- 独立审计 candidate 0034 的 SQLite/CAS，不在实现者自测上继续补第三轮；
- 建立 C2 的最小正式 schema adapter，并证明 asset/meeting cascade 后 obligation 仍在；
- 真实 R2 sandbox 要覆盖 single PUT cancel 后旧 URL 再 PUT、到期后二次 delete/HEAD，及
  multipart abort、complete 后进程死亡、URL refresh 延长 cleanup horizon；
- 受控 sandbox 工具已准备完成但没有执行，见
  [candidate 0035](../evidence/candidate-0035-upload-u2-r2-sandbox-0004-guarded-probe-20260816.md)；
  其本地 `5/5` 只能证明安全门和合成流，不能作为 R2 证据；
- 未经当前持续目标的 Cloudflare 生产变更授权，不写现有 bucket。可以准备 probe 与合成
  文件，但不能把本地 filesystem 结果冒充 R2 结果。

当前结论：U2-A 的 cleanup 不是普通 TTL 补丁，而是 bearer URL 生命周期的一等合同。
candidate 0034 仍 `BLOCK`，但 C2 是下一次正式 schema 候选的明确方向。
