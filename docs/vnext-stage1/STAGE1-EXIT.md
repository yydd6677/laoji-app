# vNext Stage 1 隔离退出记录

状态：`passed in isolated worktree`。这不是生产切换、APK 发布或真机验收。

## 已关闭的退出门

- generic owner 已从早期 `principal_id` 重建为唯一 `device_id + epoch_id`；旧 probe 行通过
  `device_principals.device_id` 一次性迁移，不新增映射 owner 或双写。
- v2 bootstrap 在创建 epoch 的同一 SQLite 事务登记 native 预生成的 epoch purge capability；meeting
  PUT 在创建 binding generation 的同一事务登记 binding capability。
- Android 原生日志使用独立 `laoji_purge_only_v1` AES-GCM Keystore alias 和 app-private
  `noBackupFilesDir/purge-only/` 原子文件。JS 只接收 capability ID、secret SHA-256 和 registration ID，
  不存在读取 secret 的 bridge。
- purge-only 端点只接受 `Authorization: LaojiPurge <secret>` 与
  `X-Laoji-Purge-Request-Id`。status 不列举 scope、binding、任务或删除对象。
- binding purge 会 fence binding、删除对应 generic task/attempt/result 并保留最小 purged tombstone；
  epoch purge 还会撤销 token、关闭 epoch、清除全部 generic task/result 并 purge 所有 binding。
- 设备 v2 bearer 已能登记/查询 binding，并创建、查询、取消 generic task。worker attempt claim/commit
  没有暴露给设备 bearer。
- bootstrap/auth challenge 可按同 request/body 重放原响应；bootstrap complete 可重放原 receipt；同
  request ID 不同内容返回冲突。
- v1 静态设备凭据和业务路由仍是公开稳定版兼容路径，未切 barrier；Stage 1 没有物理删除 legacy 表。

## 回滚边界

1. 未激活任何生产 capability barrier，因此回滚只需停止 v2 route admission，稳定客户端继续使用 v1。
2. `v2_*`、`vnext_*` 表和 native purge journal 保留，不反写 legacy owner，也不删除未确认清理义务。
3. 已创建的 generic task 继续由 generic owner drain/cancel；不得迁回 legacy task store。
4. 已进入 `pending/pending_probe/executing` 的原生 purge 行继续重试；回滚不得删除
   `laoji_purge_only_v1` alias 或 journal。
5. 0040–0042 只停止新写，不执行 down migration，不恢复 AsyncStorage/SecureStore 业务 owner。

## 证据

- `backend-test-evidence.txt`：19 个聚焦测试通过。
- `android-compile-evidence.txt`：`laoji-native-platform` 与 app Kotlin 编译通过。
- `npm exec -- tsc --noEmit --pretty false`：通过。
- `python3 tools/vnext/verify_stage1_migrations.py`：通过。
- `python3 tools/vnext/verify_stage1_exit.py`：所有静态边界与证据门通过。

## 未扩大声明

- 未部署服务器、未修改生产数据库、未切公网流量、未安装 APK、未做模拟器或真机网络回放。
- v1 提交计数的公开周期、capability barrier 与 legacy drain 属于后续阶段切换门，不由本隔离退出记录
  伪称完成。
