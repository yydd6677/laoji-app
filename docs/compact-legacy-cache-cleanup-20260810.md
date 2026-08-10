# 紧凑服务旧缓存清理（2026-08-10）

## 审计

现行 systemd 服务、进程 cwd 和 compact 源码没有引用 Whisper、VibeVoice、ModelScope、Nemo、Gradio、Celery、Redis、Neo4j 或 Chroma 作为老记运行依赖。服务器上仅发现两个明确属于旧链路的轻量残留：

- `/home/zhong/laoji-service-platform/.cache/modelscope`
- `/home/zhong/laoji-service-platform/backups/20260710-whisper-lazy`

两处均无打开文件或活动进程引用；第二处只含一个旧启动脚本（1,013 字节）。

## 处理

已删除上述两个残留目录；没有触碰其他用户服务、GPU1、PCB、SMART-MEETING2、现行模型、数据库、Tunnel token 或生产代码。四项老记 systemd 服务随后仍为 `active`，公网 ready 返回 `200`。

## 边界

历史迁移文档和审计文件中的旧字符串仍保留作证据，不属于运行依赖；未来回滚旧 Whisper 链路需要重新下载，不在服务器保留重资产副本。
