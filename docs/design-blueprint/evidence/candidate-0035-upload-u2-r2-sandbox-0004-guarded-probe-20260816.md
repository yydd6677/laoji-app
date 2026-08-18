# 候选 0035：U2-A 真实 R2 sandbox 受控探针

## 状态

- candidate: `$CANDIDATE_ROOT/upload-u2-r2-sandbox-0004`
- local guard self-test: `5/5`
- real R2 execution: **not run**
- R2 evidence: `0`
- independent audit: `tool guard accepted; real R2 not run` (candidate 0036)
- adoption: **not adopted**
- production/Cloudflare mutation: `none`

该工具只为 research 0020 的真实外部边界准备可复现路径。默认模式只输出脱敏计划；execute
必须同时具备 `--execute`、精确确认环境变量、完整环境密钥、官方 HTTPS R2 endpoint 和
`sandbox/u2/` 前缀。工具不接受会议文件，只在临时目录生成合成字节，所有 key 都带随机
run ID，并在 `finally` 清理。

## 本地门禁

```sh
cd $CANDIDATE_ROOT/upload-u2-r2-sandbox-0004
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

```text
Ran 5 tests in 0.042s
OK
```

```text
ae1845a8319b680cc7a1d49918ef78c7e2357792add7888b4f31289628389b3f  README.md
1cb5a5e89b3d9807cbd60c6720fbcc35a665ce1524fbb2de8f8aeaeece92d20b  r2_sandbox_probe.py
be91e173d427fbe2c97ed26a5576eaf2f7a8fd9471b501c93223bef698cc522b  tests/test_probe_guards.py
```

本地仅证明：

- 非 `sandbox/u2/` prefix、伪造 R2 后缀域、URL userinfo、无确认或缺密钥会 fail closed；
- dry plan 不输出 bucket 名、access key、secret 或 URL，只报告字段是否存在；
- 非末 part 小于 5 MiB 被拒绝，part reader 不越过边界；
- 合成文件的 256 KiB 流式 SHA-256 精确且临时目录自动清理。

## execute 预注册场景

1. 5 秒 single PUT URL 第一次上传并 HEAD；
2. 立即 delete 后在 URL 到期前用同一 URL 再 PUT，检查 object 是否重现；
3. URL 到期后第三次 PUT 应被拒绝，随后最终 delete + HEAD missing；
4. 18 MiB+123 B 合成对象使用 8 MiB parts，通过 presigned part URL、ListParts、Complete，
   再流式下载并核对本地 SHA-256 与 256 KiB peak read；
5. 独立 multipart 上传一个 part 后 Abort；
6. 任一步失败都 best-effort abort/delete，不记录或打印 presigned URL/密钥。

## 不能声称的内容

- 上述场景一条也没有对 R2 执行；`5/5` 不是 R2、网络、凭据、ETag 或生命周期证据。
- 工具安全门已通过独立审计，但没有验证 production bucket lifecycle、服务端正式 session/CAS、
  cleanup obligation、Android、Cloudflare Tunnel 或真实吞吐。
- `finally` 是测试工具安全网，不是生产 durable cleanup；进程被 SIGKILL 仍需 sandbox
  prefix lifecycle 或手动审计。
- 当前持续目标不授权修改 Cloudflare/生产对象，所以不得自行填入现有密钥执行。

当前结论：真实 R2 门已经具备可复现、fail-closed 的探针，但仍保持 `ready; not executed`。
独立结论见 [candidate 0036](candidate-0036-upload-u2-server-r2-independent-audit-20260816.md)；
是否执行仍取决于明确的外部写入授权。
