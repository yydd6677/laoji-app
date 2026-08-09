# 移动端讲话人删除队列加固（2026-08-10）

## 修复

讲话人本机删除会先隐藏姓名和本机 profile，再把匿名服务端 profile ID 写入删除 outbox。此前 outbox 写入使用 `bestEffort`，AsyncStorage 写入失败时会被静默吞掉，可能导致服务端声纹未进入重试队列。

现在删除队列使用严格持久写入：写入失败会向调用方返回错误，页面不会把服务端清理未排队的删除显示成成功；写入成功后仍由启动/前台 drain 按幂等请求和退避策略清理服务端。服务端 epoch 清理作为最终兜底仍会删除该设备域的所有匿名声纹。

## 验证

- `npx tsc --noEmit` 通过。
- `python3 tools/verify_device_primary_source.py` 通过。
- `git diff --check` 通过。
- 本轮未重建或安装 APK：当前没有真机验收请求，且该改动未改变已部署服务合同；下一次设备构建应覆盖安装后再做删除队列 UI 现场验证。
