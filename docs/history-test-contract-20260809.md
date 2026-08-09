# 去账号化改造后的历史测试合同对齐（2026-08-09）

## 测试环境边界

生产精简 Python 环境没有安装 pytest，这是刻意保留的运行时轻量化结果。本轮没有向生产 venv 写入开发依赖；通过服务器现有运行时依赖 + `/tmp/laoji-test-deps` 的临时 pytest/pytest-asyncio 目录执行，测试用 SQLite 和音频目录均位于 `/tmp`，结束后可删除。

## 已对齐的旧断言

服务器活动 compact 源码中的三组测试已按当前合同修正：

- `test_location_reverse.py`：地址缓存现在是有界进程内缓存，不再期待 SQLite 文件；断言改为检查缓存键为 HMAC、缓存正文不含坐标或原始高德响应。
- `test_schedule_asr_proxy.py`：日程短音频不再走旧 `SCHEDULE_ASR_PROXY_BASE_URL` 代理；测试改为验证共享 Qwen backend、解码失败和模型失败均返回空结果，并适配 `_qwen_transcribe(pcm, language, purpose)` 当前签名。
- `test_schedule_parser_quality.py`：保留“无日期不造今天日期”“普通倒置范围走确定性安全路径”“有限每天范围保持 daily”等当前安全契约，并增加全天推断、默认一小时结束、范围年份和模型提醒臆造清理的回归。

## 现场结果

使用生产服务器当前源码、临时依赖和隔离 SQLite，以下针对性集合 `91 passed`：

```text
test_device_v1_contract_static.py
test_compact_topology_policy.py
test_laoji_security.py
test_location_reverse.py
test_schedule_asr_proxy.py
test_llm_provider.py
test_meeting_retrieval_policy.py
test_storage_admission.py
test_schedule_parser_quality.py
```

第一次运行的 3 个失败均由上述旧断言造成；修正后没有发现新的运行时失败。日程质量文件单独为 `65 passed`。该结果只证明针对性合同，不等于完整历史 pytest 全量通过；完整历史套件在旧模板 revision、摘要结构和问答专题断言尚未全部迁移时仍有失败，且问答专题/声纹质量/真机验收按用户决定延期。

本轮测试后已定点删除服务器 `/tmp/laoji-test-deps`、pytest 隔离数据库/音频/speaker 目录、地址/ASR临时测试文件和三份日程 HTTP 请求文件；生产精简 venv 未写入开发依赖。

随后又完成模板 revision 合同对齐：`test_summary_task_parsing.py -k template` 为 `8 passed`，扩展合同的模板/上下文子集为 `3 passed`；`_preserve_contextual_structured_summary` 的生产硬编码 revision 也已修复并重启 API。其余摘要引用旧断言和会议问答专题仍未纳入本轮验收。
