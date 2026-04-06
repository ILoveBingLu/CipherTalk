# macOS Native Resources

这个目录是 CipherTalk 的 macOS 原生产物落点。

当前仓库会长期保留的静态文件：

- `entitlements.mac.plist`
- `image_scan_entitlements.plist`

需要在 mac 机器上通过 `native-dlls/build-macos.sh` 生成的文件：

- `libwx_key.dylib`
- `xkey_helper`
- `image_scan_helper`
- `libwcdb_api.dylib`
- `libwcdb_decrypt.dylib`

检查是否齐全：

```bash
npm run native:macos:check
```

只构建 mac 原生产物，不构建 Electron 应用：

```bash
npm run native:macos
```
