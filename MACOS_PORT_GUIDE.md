# macOS 密钥支持移植指南

## 1. 目标与归属

本仓库的 macOS 微信密钥与解密支持，正式归属在 `native-dlls/` 与 `electron/services/`。

- `native-dlls/` 是正式原生实现入口。
- `resources/macos/` 是正式运行时产物目录。
- `WxKey-CC/` 只保留为上游镜像参考，不作为运行时依赖目录。
- `WeFlow/` 只用于对照 TS 流程和资源布局，不直接参与当前项目发布。

当前已接入的 mac 产物命名如下：

- `resources/macos/libwx_key.dylib`
- `resources/macos/xkey_helper`
- `resources/macos/image_scan_helper`
- `resources/macos/libwcdb_api.dylib`
- `resources/macos/libwcdb_decrypt.dylib`

## 2. 关键事实

### 2.1 DbKey 获取不是直接靠 `GetDbKey()`

`WxKey-CC/platform/macos/exports.cpp` 中的 `GetDbKey()` 只负责：

- 定位微信主进程
- 附加进程
- 扫描出目标断点地址

它返回的不是最终 64 位 DbKey，而是目标地址或错误字符串。

真正的 DbKey 由 `helper_main.cpp` 对应的 helper 进程通过断点捕获得到。当前项目运行时走的是：

1. Electron 主进程调用 `wxKeyServiceMac.autoGetDbKey()`
2. 检查 SIP
3. 用 AppleScript `with administrator privileges` 拉起 `xkey_helper`
4. `xkey_helper <pid> <timeout_ms>` 附加微信并等待数据库访问
5. helper 从 stdout 返回 JSON，主进程解析出最终 64 位 DbKey

### 2.2 helper 协议

`xkey_helper` 的真实调用方式是：

```bash
xkey_helper <pid> [timeout_ms]
```

stdout 返回 JSON：

```json
{"success":true,"key":"64_hex_key"}
```

失败时 stdout 仍返回 JSON，但错误内容来自 helper 内部 `ERROR:*` 结果映射。

### 2.3 SIP 前置条件

本期接受以下现实限制，并且 UI 与文档都必须明确写出：

- DbKey 抓取要求关闭 SIP
- 图片密钥的内存扫描兜底要求关闭 SIP
- `kvcomm + wxid` 验真路径优先，不要求先做内存扫描

检查方式：

```bash
csrutil status
```

如果输出包含 `enabled`，当前项目会在 mac 上直接拒绝自动抓取 DbKey。

## 3. 当前仓库实现落点

### 3.1 Electron 主进程

- `electron/main.ts`
  - `wxkey:*` IPC 已做平台分支
  - `imageKey:getImageKeys` 已做平台分支
  - `dbpath:getBestCachePath` 已做平台分支
  - 新增 `app:getPlatformInfo`

### 3.2 Electron 服务层

- `electron/services/wxKeyServiceMac.ts`
  - DbKey helper 提权流程
  - SIP 检查
  - mac 微信进程识别
  - kvcomm 优先的图片密钥推导
  - `image_scan_helper` / Mach API 内存扫描兜底
- `electron/services/dbPathService.ts`
  - 支持旧版 `xwechat_files`
  - 支持 4.0.5+ 新路径 `~/Library/Application Support/com.tencent.xinWeChat/<version>`
- `electron/services/wcdbService.ts`
  - mac 加载 `resources/macos/libwcdb_api.dylib`
- `electron/services/nativeDecryptService.ts`
  - mac 加载 `resources/macos/libwcdb_decrypt.dylib`

### 3.3 前端与引导页

- `src/pages/WelcomePage.tsx`
- `src/pages/SettingsPage.tsx`

这两处已经需要按平台隐藏或替换：

- `Weixin.exe`
- Windows Hook 提示
- 盘符缓存目录提示
- Windows Hello 入口

## 4. 原生构建入口

正式构建入口是：

```bash
native-dlls/build-macos.sh
```

该脚本只负责构建 native 产物，不负责 Electron 整包构建。

脚本做的事情：

1. 使用 `native-dlls/sqlcipher_src` 构建 SQLCipher
2. 配置 `native-dlls/CMakeLists.txt`
3. 构建 `wx_key`、`wcdb_api`、`wcdb_decrypt`
4. 将产物输出到 `resources/macos/`
5. 为 helper 补 `chmod +x`
6. 在本机存在 `codesign` 时做 ad-hoc 签名

## 5. CMake 真实目标

当前 `native-dlls/` 下的 mac 目标如下：

- `wx_key`
  - 输出 `libwx_key.dylib`
  - 源码来自 `WxKey-CC/platform/common + platform/macos`
- `xkey_helper`
  - 输出 `resources/macos/xkey_helper`
  - 源码来自 `WxKey-CC/platform/macos/helper_main.cpp`
- `image_scan_helper`
  - 输出 `resources/macos/image_scan_helper`
  - 是当前项目自己的轻量包装器
- `wcdb_api`
  - 输出 `libwcdb_api.dylib`
  - mac 侧链接仓库内构建出的 SQLCipher
- `wcdb_decrypt`
  - 输出 `libwcdb_decrypt.dylib`
  - mac 侧使用 CommonCrypto

不是文档里旧写法的这些目标：

- 不是 `libwx_key` target
- 不是 `xkey_helper_macos` 运行时名称
- 不是直接从 `WxKey-CC/` 目录拿产物进包

## 6. 资源目录

运行时统一读取：

```text
resources/macos/
  libwx_key.dylib
  xkey_helper
  image_scan_helper
  libwcdb_api.dylib
  libwcdb_decrypt.dylib
  entitlements.mac.plist
  image_scan_entitlements.plist
```

Electron 打包时通过 `package.json -> build.extraResources` 带入整个 `resources/`，不需要单独再为 `WxKey-CC/` 配额外资源。

## 7. 数据路径识别

当前项目在 mac 上要识别两类微信数据目录：

### 7.1 旧路径

```text
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files
~/Documents/xwechat_files
```

### 7.2 新路径

```text
~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/<version>
```

对外给前端的仍然是“数据库根目录”概念，但后端会继续向下解析：

- 账号目录
- `db_storage`
- `session.db`

## 8. 图片密钥策略

当前项目在 mac 上使用的顺序是：

1. `kvcomm` 码收集
2. 基于 `wxid` 的候选验真
3. 如果失败，再调用 `image_scan_helper` 或 Mach API 做内存扫描

对外保持原有返回结构：

```ts
{ success, xorKey?, aesKey?, error? }
```

其中：

- `xorKey` 仍然给当前项目直接消费
- `aesKey` 仍然是 16 位字符串

## 9. WCDB 与解密

### 9.1 `wcdb_api`

当前做法是跨平台 C ABI，不再依赖 Windows 风格导出写法。

- Windows 仍可保留现有 `WCDB.dll` 资源装载
- mac 侧改为链接 SQLCipher
- 统一导出：
  - `wcdb_init`
  - `wcdb_open_account`
  - `wcdb_close_account`
  - `wcdb_exec_query`
  - `wcdb_get_sns_timeline`
  - `wcdb_test_connection`

### 9.2 `wcdb_decrypt`

- Windows 保留现有 CNG 版本
- mac 新增 CommonCrypto 版本
- 导出函数名不变：
  - `Wcdb_DecryptDatabase`
  - `Wcdb_DecryptDatabaseWithProgress`
  - `Wcdb_ValidateKey`
  - `Wcdb_IsDecrypted`
  - `Wcdb_GetLastErrorMsg`

## 10. 打包配置

`package.json` 已预留 mac 打包配置：

- `build.mac.hardenedRuntime`
- `build.mac.entitlements`
- `build.mac.entitlementsInherit`

注意：

- 这只是为后续打包接入准备
- 当前计划不包含执行 Electron 整包构建

## 11. 推荐开发流程

### 11.1 只开发 native

```bash
cd native-dlls
chmod +x build-macos.sh
./build-macos.sh
```

### 11.2 只验证产物

验证输出文件是否齐全：

```bash
ls -la resources/macos
```

检查 helper 是否可执行：

```bash
file resources/macos/xkey_helper
file resources/macos/image_scan_helper
```

检查 dylib 符号：

```bash
nm -gU resources/macos/libwx_key.dylib | grep GetDbKey
nm -gU resources/macos/libwcdb_api.dylib | grep wcdb_open_account
nm -gU resources/macos/libwcdb_decrypt.dylib | grep Wcdb_DecryptDatabase
```

### 11.3 只验证 helper 协议

```bash
resources/macos/xkey_helper <pid> 180000
```

预期 stdout 是 JSON，而不是裸字符串。

## 12. 本期边界

本期明确不做：

- Touch ID / Keychain 应用锁
- 在 mac 上伪装 Windows Hello
- 直接把 `WxKey-CC/` 当运行时资源目录
- 自动执行 Electron 整包构建

## 13. 后续同步规则

后续如果 `WxKey-CC` 上游更新：

1. 先对比 `WxKey-CC/platform/common` 与 `platform/macos`
2. 再手工回灌到 `native-dlls/` 的构建入口和项目包装层
3. 不直接改当前项目去依赖 `WxKey-CC/` 目录运行

这份文档以当前仓库事实为准。如果实现与文档再次偏离，优先修正文档和 `native-dlls/` 构建入口，不要继续在 Electron 层堆临时兼容逻辑。
