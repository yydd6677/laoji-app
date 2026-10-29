# 老记生产部署模板

这里保留一套用户级生产拓扑的无密钥模板。`LAOJI_USER` 只是必须在落盘前替换的示例用户名；仓库不记录真实部署账号。运行边界固定为：

- API：`127.0.0.1:18020`
- ASR：`127.0.0.1:8030`
- Ollama：`127.0.0.1:21434`
- 代码根：`/home/LAOJI_USER/laoji-service-platform/current`
- 持久数据：`/home/LAOJI_USER/laoji-service-platform/compact-production/backend`
- ASR 运行入口：`/home/LAOJI_USER/laoji-service-platform/runtime/asr/qwen_asr_service`
- Python：`/home/LAOJI_USER/laoji-service-platform/.venvs/laoji-compact-py312`
- 私有配置：`/home/LAOJI_USER/.config/laoji/laoji.env`

`current` 必须是由部署流程原子更新的只读发布链接；systemd 文件不再钉死某个 APK
版本目录，也不包含候选端口、密钥或关闭功能的历史开关。源码、模型和数据库仍是不同
生命周期的资产，切换 `current` 不得替换数据目录。

安装时把三个 `*.service.example` 复制到 `~/.config/systemd/user/` 并移除 `.example`
后缀；先在两个环境示例中替换 `LAOJI_USER`，再把需要的非密钥项合并到权限为 `0600` 的
`~/.config/laoji/laoji.env`。R2、高德、LLM 和来源载荷密钥只写入该私有文件。
兼容 device-v1 的注册 admission token 也从私有部署配置读取，但其客户端副本会进入 APK、
可以被提取，不能当作秘密或与其他用途的 secret 复用。本目录不提供占位凭据。ASR 模型
revision 必须替换为实际固定 revision。

安装或切换后依次执行 `systemctl --user daemon-reload`、重启三个服务，并分别检查
`/api/ready`、`/ready` 和 Ollama 模型列表。公网仍只由现有 Cloudflare/Nginx 入口连接 API，
不得直接暴露三个内部端口。

静态检查：

```text
python3 tools/verify_deployment_templates.py
```

验证通过后仍需单独完成进程启动、真实 R2、重启恢复和双上传加实时回放；模板检查不等于
生产验证。本目录只是模板，不表示当前服务器已部署这份工作树。
