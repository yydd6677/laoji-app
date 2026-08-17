# LaoJi vNext 隔离候选部署包

这些文件只描述候选运行方式，不会修改当前生产 systemd、GPU、Nginx 或公网流量。

默认端口为：

- ASR：`127.0.0.1:8031`
- API：`127.0.0.1:18021`

ASR 默认使用 CPU，避免与线上 GPU0 的 8030/Qwen 模型争抢显存；这适合合同、恢复和 R2
链路验收，不代表生产延迟。只有在明确安排资源窗口后，才可以把候选 ASR 迁移到 GPU。

安装前必须把候选源码、Python 环境、模型和数据库副本放入 `/opt/laoji-vnext`，并把真实
凭据写入 root 可读的 `/etc/laoji-vnext/*.env`，不能把生产密钥填入本目录。`api.env.example`
默认关闭 R2 和 capability barrier，避免误切生产。

静态检查：

```text
python3 tools/vnext/verify_deployment_templates.py
```

验证通过后仍需单独完成进程启动、真实 R2、重启恢复和双上传+实时回放；不得把模板检查
当作部署或 Stage 2 退出证明。
