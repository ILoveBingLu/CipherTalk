# 📦 发布说明

## 触发方式

当前仓库不再使用本地 `npm run tuisong` 发布。

正式发布方式改为：

1. 修改 `package.json` 中的版本号
2. 提交代码并推送到 `main`
3. 推送一个与版本号完全一致的 Git tag，例如：

```bash
git tag v2.2.14
git push origin v2.2.14
```

只有推送 `v*` 标签时，GitHub Actions 才会自动构建和发布。

## GitHub Actions 会做什么

`.github/workflows/release.yml` 会在 `v*` 标签触发后执行：

1. 安装依赖
2. 重新编译原生模块
3. 执行 `npm run build`
4. 生成 `release/force-update.json`
5. 生成 `release/release-context.json`
6. 自动生成 `release/release-body.md`（AI 失败时自动降级为模板版）
7. 创建/更新 GitHub Release
8. 上传以下文件到 GitHub Release：
   - 安装包
   - `latest.yml`
   - `force-update.json`
   - 若存在则上传 `.blockmap`
9. 将以下文件同步到 Cloudflare R2：
   - 安装包
   - `latest.yml`
   - `force-update.json`
10. 向 Telegram 频道/群发送发布通知（AI 摘要 + 强制更新提醒）

## 版本要求

标签名必须与 `package.json.version` 完全对应：

- `package.json.version = 2.2.14`
- Git tag 必须是 `v2.2.14`

如果不一致，工作流会直接失败。

## 强制更新策略

工作流会调用：

```bash
npm run build:force-update-manifest
```

默认情况下不会触发强制更新。只有在仓库 Variables / Secrets 中提供以下值时，生成的 `force-update.json` 才会带上对应策略：

- `FORCE_UPDATE_MIN_VERSION`
- `FORCE_UPDATE_BLOCKED_VERSIONS`
- `FORCE_UPDATE_TITLE`
- `FORCE_UPDATE_MESSAGE`
- `FORCE_UPDATE_RELEASE_NOTES`

## Secrets / Variables

### Cloudflare R2 Secrets

需要在 GitHub 仓库配置以下 Secrets：

- `R2_ACCOUNT_ID`
- `R2_BUCKET_NAME`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

### 可选强制更新 Variables / Secrets

可以按需配置：

- `FORCE_UPDATE_MIN_VERSION`
- `FORCE_UPDATE_BLOCKED_VERSIONS`
- `FORCE_UPDATE_TITLE`
- `FORCE_UPDATE_MESSAGE`
- `FORCE_UPDATE_RELEASE_NOTES`

不配置时，`force-update.json` 仍会生成，但只包含当前版本信息，不会强制用户升级。

### AI Release Body Secret

发布工作流会自动生成标准化 Release body。

需要在 GitHub Environment `软件发布` 中配置：

- `GLM_KEY`

用途：
- 调用智谱 `glm-4.7-flash`
- 自动生成中文 Release 说明
- 若 AI 不可用，会自动降级为模板正文，不影响发版

### Telegram 通知配置

如果需要自动发 Telegram 通知，请在 GitHub Environment `软件发布` 中配置：

- Secret:
  - `TELEGRAM_BOT_TOKEN`

- Variable:
  - `TELEGRAM_CHAT_IDS`
  - `TELEGRAM_RELEASE_COVER_URL`（可选）

说明：
- `TELEGRAM_CHAT_IDS` 支持多个目标，用英文逗号分隔
- 可填写频道用户名或群/频道 chat_id
- 成功发布时会发送 AI 摘要版通知
- 发布失败时会发送失败通知

## 当前更新源角色

- **GitHub Release**：主更新源，负责安装包与 `latest.yml`
- **Cloudflare R2**：镜像下载源 + 策略补充源
- **force-update.json**：GitHub 优先，R2 回退
