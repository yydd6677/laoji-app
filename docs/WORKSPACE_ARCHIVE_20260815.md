# 2026-08-15 工作区归档索引

远端目录：`/home/zhong/laoji-workspace-archives/2026-08-15-local-consolidation`

归档创建期间没有停止或重启本机模拟器、老记生产服务、Cloudflare Tunnel、Smart Meeting、PCB、GPU1 或其他用户服务。所有压缩包均已通过 `zstd -t` 和 `tar -t`；代表性源码、Markdown 和 APK 已从远端归档解出并与本地 SHA-256 一致。

## 文件

| 文件 | 大小（字节） | SHA-256 | 内容 |
|---|---:|---|---|
| `git-all-refs.bundle` | 22,401,463 | `04a87f18bc5e050accba2407fcad4996983d78f8bb6789401771d8d555cb402b` | 11 个本地/远端 refs、标签及完整 Git 历史 |
| `pre-clean-active-worktree-source.tar.zst` | 68,280,176 | `5eac99b701db668225224d371a71913dfb49ea51083860a331f8b4f973caaac3` | 整理前活跃 dirty 工作树，排除依赖、生成 Android 目录、缓存和 `.env.local` |
| `historical-local-roots.tar.zst` | 1,483,115,286 | `b62414102e852746e079fa8e7404d2141d2e5627a691134ba9117ef8eb7ce38d` | 旧设计、旧根目录文档、Figma 生成物、飞书参考、旧 staging、旧 APK/AAB/mapping、Git bundle 备份 |
| `pre-feishu-main-worktree-evidence.tar.zst` | 203,160,063 | `0092cb71eadae9d3e255bf2294180db0d19a403a502c47d5707ae03f8b5764f0` | 旧主工作树中未受 Git 管理的截图、日志、录音和安装 APK 证据 |
| `pre-feishu-test-assets.tar.zst` | 18,224,690 | `544fa0a4587da8846057735bed86a9c89a38d89dc4e64c2fb6a6bcebbe3b5107` | 旧主工作树中 tracked/ignored 混合的 ASR、会议与日程测试素材 |
| `light-plan-laoji-history.tar.zst` | 656,118,765 | `b201f0cfb6f5a0a1fcd370bb0bfbf3b9c196f8c8c0f26b8a153d0b011e3fb785` | `light_plan` 的服务候选、评测、demo v1-v5、重录中间帧和本轮全局审查证据 |
| `codex-laoji-context-backup.tar.zst` | 328,560,094 | `3fe8051bac58d30528a0441a6a1d9ef8f8cbcd85cf711d201f700ac1854b2538` | 2026-08-04 的旧会话 JSONL 修复前备份 |
| `loose-local-materials.tar.zst` | 149,588 | `ac6342def20c5ad70a491f196c6a8196ea885c2843b0ef6903cf9cf710810ec1` | 早期 Figma/Expo Go 会话上下文和独立 XMind 设计资料 |
| `current-release/laoji-1.1.4-112.apk` | 82,213,763 | `01cef1c902d4e2b5b2bd5ed488178127396612a12bcba7ae8d872b1a85d3c454` | 整理时的当前公网 APK |
| `current-release/latest.json` | 601 | `bf23dd11c519a6c9957782100d1a32380bd76d3a5d968066bd59164900e7e490` | 与当前 APK 对应的更新清单 |

远端 `SHA256SUMS` 是机器校验入口。当前发布 APK 在归档目录中使用硬链接指向生产 releases 文件，归档副本不会额外占用一份 APK 空间。

## 本地保留

- `/home/yydd/LaoJi-worktrees/feishu-source-driven`：唯一活跃移动端源码
- `/home/yydd/LaoJi/mobile/.git`：当前 worktree 依赖的 Git 元数据；旧主工作树仅展开根文件的 sparse checkout
- `/home/yydd/LaoJi-stable-builds/current`：唯一当前稳定 APK 与更新清单
- 当前 `node_modules`、`.env.local`、签名配置和 Android 生成源码
- 当前全局审查报告及本文件

## 本地移出

- 旧根目录设计、Figma 生成物、飞书参考、staging 和早期构建
- `light_plan` 中老记候选服务、评测、演示视频和重录中间产物
- 活跃仓库内旧工程指示、阶段合同、测试门禁、评测语料、旧 UI 证据和报告
- 旧主工作树中被忽略的证据、依赖、Android 构建树、coverage 和 dist
- 旧稳定 APK、mapping/debug symbols、测试虚拟环境、ASR 0.6B 本机缓存和重复格式夹具
- Android/Gradle/CMake/Python 可再生构建缓存

`/home/yydd/LaoJi/auth.json` 是与当前 Codex 配置不同的 7 月遗留凭据文件。为避免继续扩散旧令牌，它只从本机移除，不进入归档。

## 恢复

只恢复到新目录，不覆盖当前工作树或生产目录。例如：

```bash
mkdir -p /path/to/restore
tar --zstd -xf pre-clean-active-worktree-source.tar.zst -C /path/to/restore
git clone git-all-refs.bundle /path/to/restore/git-history
sha256sum -c SHA256SUMS
```

`historical-local-roots.tar.zst` 保存的是相对 `/home/yydd` 的路径；`light-plan-laoji-history.tar.zst` 同时含相对 `light_plan` 的历史目录与 `tmp/laoji-audit-20260815`。恢复前先用 `tar --zstd -tf` 查看成员，不要直接解到 `/home`。

## 清理后验证

- 先以 Android 平台解析规则审查 `index.ts -> App.tsx` 的静态导入图；最初候选中的 23 个文件仍属于非 Android/TypeScript fallback，已从整理前快照恢复。
- 最终移出 31 个无应用入口的源码文件：旧账号/资料页、旧账号同步 Provider 与服务、旧分享页和测试快照。保留仍被本机数据、设备鉴权、位置或平台 fallback 引用的兼容代码。
- `npx tsc --noEmit --pretty false` 通过。
- `npx expo export --platform android` 完成 1640 个模块的 Android bundle。
- `./gradlew assemblePreview --parallel --max-workers=16` 从已清理构建树完成 524 个任务，构建成功；验证包 metadata 为 `1.1.4-source-preview` / versionCode `112`。
- 验证后停止 Gradle daemon，并再次删除 Android/Gradle/CMake 中间产物。当前稳定 APK 和公网 APK 的 SHA-256 仍为 `01cef1c902d4e2b5b2bd5ed488178127396612a12bcba7ae8d872b1a85d3c454`。
