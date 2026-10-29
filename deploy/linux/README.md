# 老记生产部署模板

本目录提供 Linux systemd 用户级服务模板。安装时将 `LAOJI_USER` 替换为部署用户名。默认服务与目录配置如下：

- API：`127.0.0.1:18020`
- ASR：`127.0.0.1:8030`
- Ollama：`127.0.0.1:21434`
- 代码根：`/home/LAOJI_USER/laoji-service-platform/current`
- 持久数据：`/home/LAOJI_USER/laoji-service-platform/compact-production/backend`
- ASR 运行入口：`/home/LAOJI_USER/laoji-service-platform/runtime/asr/qwen_asr_service`
- Python：`/home/LAOJI_USER/laoji-service-platform/.venvs/laoji-compact-py312`
- 私有配置：`/home/LAOJI_USER/.config/laoji/laoji.env`

`current` 是由部署流程原子更新的源码发布链接。systemd 单元引用该链接，模型与持久数据使用独立目录。切换源码版本不替换模型或用户数据。

安装时把三个 `*.service.example` 复制到 `~/.config/systemd/user/` 并移除 `.example`
后缀；先在两个环境示例中替换 `LAOJI_USER`，再把需要的非密钥项合并到权限为 `0600` 的
`~/.config/laoji/laoji.env`。R2、高德、LLM 和来源载荷密钥只写入该私有文件。
兼容 device-v1 的注册 admission token 也从私有部署配置读取，但其客户端副本会进入 APK、
可以被提取，不能当作秘密或与其他用途的 secret 复用。本目录不提供占位凭据。ASR 模型
revision 必须替换为实际固定 revision。

安装或切换后依次执行 `systemctl --user daemon-reload`、启动相应服务，并分别检查
`/api/ready`、`/ready` 和 Ollama 模型列表。公网通过 Cloudflare Tunnel 或 HTTPS 反向代理连接 API，
不得直接暴露三个内部端口。

静态检查：

```text
python3 tools/verify_deployment_templates.py
```

静态检查覆盖模板配置；运行环境还需验证真实 R2、任务重启恢复，以及并发上传与实时录音。
