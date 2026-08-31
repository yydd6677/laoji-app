# Android 构建目标

老记不再生成同时携带手机与模拟器原生库的通用 APK。

| 使用场景 | 命令 | 唯一 ABI |
|---|---|---|
| 正式发布 | `npm run android:release` | `arm64-v8a` |
| 已连接真机调试 | `npm run android:device` | 从目标设备读取 |
| 老记模拟器调试 | `npm run android:emulator:install` | 从 `emulator-5562` 读取，通常为 `x86_64` |
| 仅有一个 Android 目标 | `npm run android` | 从该目标读取 |

存在多个目标时必须通过 `--serial` 明确选择，避免误操作其他项目的模拟器。`android/` 是忽略的生成目录，不是原生代码来源；正式构建每次先执行干净的 Expo prebuild，从 `app.config.js`、包配置、`plugins/`、`modules/laoji-native-platform/` 和原生字体/图标输入重建原生树，再编译 APK。真机和模拟器构建会校验同一组输入的 SHA-256 生成标记，缺失或变化时同样干净重建，只有完全匹配时才复用。版本号和构建号以 `app.config.js` 为唯一来源；`package.json` 只是必须保持一致的包元数据镜像，构建脚本会在 Gradle 前拒绝漂移。发布校验还会拒绝缺失当前配置插件产物、含非 `arm64-v8a` 原生库或多余图标字体的 APK。若未来需要支持 32 位旧设备，应新增独立 APK/AAB 分包，而不是恢复通用 APK。
