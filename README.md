<div align="center">

<img src="welcome.jpg" alt="密语 CipherTalk" width="100%" />

# 🔐 密语 CipherTalk

**一款现代化的微信聊天记录查看与分析工具**

[![License](https://img.shields.io/badge/license-CC--BY--NC--SA--4.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-4.2.1-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg?logo=windows)]()
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron)]()
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)]()
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Group-26A5E4.svg?logo=telegram)](https://t.me/CipherTalk)

[在线说明文档](https://ilovebinglu.notion.site/ciphertalk)

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [技术栈](#️-技术栈) • [贡献指南](#-贡献指南) • [许可证](#-许可证)
</div>

## 开发者愿景

> 这不是一个只会读取聊天记录的工具。
>
> 我希望它能替人留住爱，提取证据，也守住每个人自己的数字人生。

### 1. 为思念留下可以触摸的温度

当亲人离世后，曾经的点点滴滴往往都留在逝者的手机里，手机也成了继续思念的唯一入口。我希望这款软件能把这些记录整理为真正属于家人的 **数字资产**: 一段反复叮嘱的文字，一条“儿子（闺女），爸（妈）想你了，啥时候回家呀，回来给你做你爱吃的！”的语音，一次平凡却再也无法重来的问候。

正如《寻梦环游记》中那句话所说：**死亡不是生命的终点，遗忘才是。** 愿技术能替你留住一点声音、一点温度，也留住一点未曾说完的爱。

### 2. 为不公保留足够有力的证据

当您遭遇不公、不平、不正，甚至被聊天中的恶意、羞辱、威胁反复消耗时，您不该只能忍受。我希望这款软件能帮您从海量记录中快速找出关键证据，把零散对话整理成清晰、完整、可追溯的 **事实链**，让每一句伤害都有据可查，让每一次压迫都有证可举。

人可以善良，但不该没有反击的凭据。

### 3. 让聊天记录真正回到用户手中

我也希望这款软件能帮助更多普通人重新掌握自己的 **数字人生**。聊天记录不该只是被困在某台设备里的碎片，它也可以是记忆的档案、关系的注脚、成长的年轮。

无论是回望过去、整理生活、备份重要信息，还是在关键时刻还原事实、保护自己，这些数据都应该真正属于用户，而不是在设备更换、账号异常或时间流逝中悄然消失。

<div align="center">

## YouTube 使用教程

[![观看使用教程](https://img.youtube.com/vi/ZpuO14UOJkc/0.jpg)](https://www.youtube.com/watch?v=ZpuO14UOJkc)
</div>

---

## 💖 赞助支持

如果这个项目对你有帮助，欢迎通过爱发电支持我们的开发工作！

<div align="center">

<a href="https://afdian.com/a/ILoveBingLu">
  <img src="aifadian.jpg" alt="爱发电" width="300" />
</a>

你的支持是我们持续更新的动力 ❤️

</div>

---

## ✨ 功能特性

<table>
  <tr>
    <td width="50%">
      <h3>💬 聊天记录查看</h3>
      <p>现代化的聊天界面，支持文字、图片、语音、视频等多种消息类型，完美还原聊天体验</p>
    </td>
    <td width="50%">
      <h3>🤖 AI 智能摘要</h3>
      <p>支持多家 AI 服务商（智谱、DeepSeek、通义千问、Gemini 等），一键生成聊天摘要，智能提取关键信息</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>👀 数据可视化分析</h3>
      <p>图表展示聊天数据，包括消息统计、活跃时段、词云分析等，深度洞察聊天习惯</p>
    </td>
    <td width="50%">
      <h3>🎨 多主题支持</h3>
      <p>浅色/深色模式自由切换，多种主题色可选，打造个性化的使用体验</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🔍 全文搜索</h3>
      <p>强大的搜索功能，支持关键词、日期范围筛选，快速定位目标消息</p>
    </td>
    <td width="50%">
      <h3>📤 数据导出</h3>
      <p>支持导出聊天记录为 TXT、HTML 等格式，方便备份和分享</p>
    </td>
  </tr>
</table>

## 🛠️ 技术栈

<div align="center">

| 类别 | 技术 |
|:---:|:---|
| **前端框架** | React 19 + TypeScript + Zustand |
| **桌面应用** | Electron 39 |
| **构建工具** | Vite + electron-builder |
| **样式方案** | SCSS + CSS Variables |
| **图表库** | ECharts |
| **AI 集成** | OpenAI SDK (支持多家 AI 服务商) |
| **其他** | jieba-wasm (分词) • lucide-react (图标) • marked (Markdown) |

</div>

---

## 🚀 快速开始

### 📋 环境要求

- **Node.js**: 22.12.0 或更高版本
- **操作系统**: Windows 10/11
- **内存**: 建议 4GB 以上

### 📦 安装依赖

```bash
npm install
```

### 🔧 开发模式

启动开发服务器（支持热重载）：

```bash
npm run dev
```

### 📦 构建应用

构建生产版本：

```bash
# 构建完整安装包
npm run build

# 仅构建核心版本（不包含依赖）
npm run build:core
```

构建产物位于 `release/` 目录。

---

## 📁 项目结构

```
密语 CipherTalk/
├── 📂 src/                      # React 前端源码
│   ├── 📂 components/          # 可复用组件
│   │   ├── ai/                 # AI 相关组件
│   │   ├── Sidebar.tsx         # 侧边栏
│   │   └── TitleBar.tsx        # 标题栏
│   ├── 📂 pages/               # 页面组件
│   │   ├── ChatPage.tsx        # 聊天页面
│   │   ├── AnalyticsPage.tsx   # 数据分析页面
│   │   └── SettingsPage.tsx    # 设置页面
│   ├── 📂 stores/              # Zustand 状态管理
│   ├── 📂 services/            # 前端服务层
│   ├── 📂 types/               # TypeScript 类型定义
│   ├── 📂 utils/               # 工具函数
│   └── 📂 styles/              # 全局样式
├── 📂 electron/                # Electron 主进程
│   ├── main.ts                 # 主进程入口
│   ├── preload.ts              # 预加载脚本
│   └── 📂 services/            # 后端服务
│       ├── ai/                 # AI 服务
│       ├── chatService.ts      # 聊天服务
│       └── database.ts         # 数据库服务
├── 📂 public/                  # 静态资源
└── 📂 Docs/                    # 项目文档
```

---

## 🎯 核心功能说明

### 🤖 AI 智能摘要

支持多家 AI 服务商，自动生成聊天摘要：

- **智谱 AI** (GLM-4)
- **DeepSeek**
- **通义千问** (Qwen)
- **Google Gemini**
- **豆包** (Doubao)
- **Kimi**
- **硅基流动** (SiliconCloud)

**特性：**
- ✅ 自动代理检测（支持系统代理）
- ✅ 思考模式（显示 AI 推理过程）
- ✅ 自定义摘要详细程度
- ✅ 历史记录管理
- ✅ 成本统计（虚拟）

### 📊 数据分析

- **消息统计**: 总消息数、发送/接收比例
- **时间分析**: 活跃时段、聊天频率趋势
- **词云分析**: 高频词汇可视化
- **群聊分析**: 成员活跃度、互动关系

---

## MCP Server

CipherTalk 现已提供基于 `stdio` 的独立 MCP Server，可供 Claude Desktop、Codex、Cherry Studio 等 MCP 宿主直接读取本地聊天数据。

### 开发态启动

```bash
npm run mcp
```

首次运行若缺少 `dist-electron/mcp.js`，会自动执行 `build:mcp` 后再启动。

### 打包态启动

安装版会附带平台对应的 MCP 启动器，可直接作为宿主的 `command` 使用：

- Windows：安装目录根部的 `ciphertalk-mcp.cmd`
- macOS：`CipherTalk.app/Contents/MacOS/ciphertalk-mcp`

### 强制更新清单

当前更新架构：

- **主更新源**：GitHub Release（安装包、`latest.yml`）
- **策略补充源**：`https://miyuapp.aiqji.com`
- **策略优先级**：GitHub 优先，自定义源仅在 GitHub 策略不可用时作为回退

应用启动时会按以下顺序请求 `force-update.json`，用于判定：

1. `https://github.com/ILoveBingLu/CipherTalk/releases/latest/download/force-update.json`
2. `https://miyuapp.aiqji.com/force-update.json`

策略字段含义：

- 最低安全版本 `minimumSupportedVersion`
- 被封禁版本列表 `blockedVersions`
- 强制更新提示文案 `title` / `message`

可用以下命令在 `release/force-update.json` 生成清单：

```bash
FORCE_UPDATE_MIN_VERSION=2.2.15 npm run build:force-update-manifest
```

示例结构：

```json
{
  "schemaVersion": 1,
  "latestVersion": "2.2.15",
  "minimumSupportedVersion": "2.2.14",
  "blockedVersions": ["2.2.13"],
  "title": "必须更新到最新版本",
  "message": "当前版本存在安全风险，请立即更新。",
  "releaseNotes": "修复关键安全问题",
  "publishedAt": "2026-04-01T00:00:00.000Z"
}
```

发布要求：

- **GitHub Release 必须上传**：安装包、`latest.yml`、`force-update.json`
- **自定义源可上传**：`force-update.json`
- 自定义源不再承担安装包和 `latest.yml` 分发
- GitHub Actions 同步到 R2 时只会清理旧安装包 `CipherTalk-*-Setup.exe`，不会删除桶里的其他文件

### 自动发布

仓库使用 GitHub Actions 自动发布。

触发方式：

1. 修改 `package.json.version`
2. 提交并推送代码
3. 推送同版本 Git 标签，例如：

```bash
git tag v2.2.14
git push origin v2.2.14
```

只有推送 `v*` 标签时才会正式构建并发布，不会在普通 `push main` 时自动发版。

自动发布内容：

- GitHub Release：安装包、`latest.yml`、`force-update.json`
- Cloudflare R2：安装包、`latest.yml`、`force-update.json`
- GitHub Release body：由工作流自动生成标准化中文版本说明
- Telegram：自动推送机器人风格的发布通知（支持多个频道/群）

AI 生成说明的密钥来源：

- GitHub Environment `软件发布`
- Secret 名称：`AI_API_KEY`
- 可选 Variable：`AI_API_URL`
- 可选 Variable：`AI_MODEL`

若 AI 不可用，工作流会自动回退为模板化 Release body，不影响正式发布。

默认情况下，发布说明生成会使用：

- `AI_API_URL`: `https://api.openai.com/v1/chat/completions`
- `AI_MODEL`: `gpt-5.4`

如配置 Telegram Bot，发布成功后还会自动发送：

- AI 摘要版发布通知
- 强制更新提醒（如存在）
- Release / 安装包按钮链接

若发布失败，也会自动发送失败通知和 Actions 日志链接。

### v1 工具

- `health_check`
- `get_status`
- `get_moments_timeline`
- `list_sessions`
- `get_messages`
- `list_contacts`
- `search_messages`
- `get_session_context`
- `get_global_statistics`
- `get_contact_rankings`
- `get_activity_distribution`

### 宿主配置示例（开发态）

```json
{
  "mcpServers": {
    "ciphertalk": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "E:/CipherTalk"
    }
  }
}
```

### 宿主配置示例（打包态）

Windows:

```json
{
  "mcpServers": {
    "ciphertalk": {
      "command": "E:/CipherTalk/ciphertalk-mcp.cmd",
      "args": [],
      "cwd": "E:/CipherTalk"
    }
  }
}
```

macOS:

```json
{
  "mcpServers": {
    "ciphertalk": {
      "command": "/Applications/CipherTalk.app/Contents/MacOS/ciphertalk-mcp",
      "args": [],
      "cwd": "/Applications/CipherTalk.app/Contents/MacOS"
    }
  }
}
```

macOS 打包态请直接指向 `.app` 内部的 `ciphertalk-mcp`，不要把 `CipherTalk.app` 本体当作 `command`。

### AI Copilot Skill

项目内置了 `ct-mcp-copilot` skill，用于让支持 Skills 的 Agent 更智能地使用 CipherTalk MCP：

- 模糊联系人 / 会话查找
- 先解析联系人真实 `contactId`，再查朋友圈时间线
- 线索补挖和候选比较
- 优先消费 `items[].text` / `items[].contentDesc` 等结构化字段，而不是停在 `Loaded N ...`
- 导出前补问和请求校验

在应用内的 MCP 页面可以一键安装到本机支持的 Agent：

- Codex：`~/.codex/skills`
- `.agents`：`~/.agents/skills`
- 以及主目录下发现的其他 `skills` 目录（如路径特征明显匹配 Agent）

Skill 使用独立版本号，不跟应用版本绑定。页面会显示：

- 当前内置 skill 版本
- 本机已安装版本
- 是否可更新（仅对比本地已安装版本是否落后）

还支持直接导出本地 skill 压缩包：

- 文件名格式：`ct-mcp-copilot-v<skillVersion>.zip`
- 默认导出到系统 Downloads 目录
- 可用于手动导入到支持 skills 的 Agent

安装后可直接这样使用：

- `使用 ct-mcp-copilot 帮我查这个人`
- `使用 ct-mcp-copilot 帮我补全导出问题`

说明：

- 安装器使用“复制安装”，不会创建软链接
- 当前只管理内置 skill `ct-mcp-copilot`
- 当前只检查本地已安装版本是否落后，不检查远程最新版本
- Cherry Studio 等 MCP 宿主继续使用 `mcpServers` 配置，不属于 skills 目录安装模型

### 参数示例

```json
{
  "name": "get_messages",
  "arguments": {
    "sessionId": "wxid_xxx",
    "limit": 20,
    "order": "asc",
    "includeMediaPaths": true
  }
}
```

朋友圈时间线示例：

```json
{
  "name": "get_moments_timeline",
  "arguments": {
    "limit": 20,
    "offset": 0,
    "usernames": ["wxid_xxx"],
    "keyword": "旅行",
    "startTime": 1704067200,
    "endTime": 1735689599,
    "includeRaw": false
  }
}
```

第一版返回朋友圈结构化时间线，不包含媒体下载或本地路径解析接口。

### 关键返回字段

- `list_contacts.items[].contactId`：联系人真实 username，可直接传给 `get_moments_timeline.usernames[]`
- `get_messages.items[].text`：聊天正文
- `get_session_context.items[].text`：最近上下文消息正文
- `search_messages.hits[].message.text`：搜索命中的消息正文
- `get_moments_timeline.items[].contentDesc`：朋友圈正文

### 推荐查询链路示例

当用户问“找找体育组张老师儿的最新三条朋友圈内容”时，推荐这样查：

1. `list_contacts(q="体育组张老师儿")`
2. 读取命中项里的 `contactId`
3. `get_moments_timeline(usernames=["zhangjunbai"], limit=3)`
4. 直接从 `items[*].contentDesc` 作答

当前 MCP 的 `content` 也会带最多 3 条预览，便于只消费文本摘要的宿主继续工作；完整结构化结果仍保留在 `structuredContent` 中。

---

## 💻 开发指南

### 代码规范

- **组件**: 使用函数组件 + Hooks
- **命名**: PascalCase (组件) / camelCase (变量、函数)
- **样式**: BEM 命名规范 + SCSS
- **类型**: 严格的 TypeScript 类型检查

### 主题系统

项目使用 CSS 变量实现主题切换：

```scss
// 定义主题变量
:root {
  --primary-color: #1890ff;
  --bg-color: #ffffff;
  --text-color: #333333;
}

[data-theme="dark"] {
  --bg-color: #1a1a1a;
  --text-color: #ffffff;
}
```

### 状态管理

使用 Zustand 进行状态管理：

```typescript
// stores/chatStore.ts
export const useChatStore = create<ChatStore>((set) => ({
  messages: [],
  setMessages: (messages) => set({ messages }),
}))
```

---

## 🤝 贡献指南

我们欢迎所有形式的贡献！无论是报告 Bug、提出新功能建议，还是提交代码改进。

### 如何贡献

1. **Fork** 本仓库
2. **创建**特性分支 (`git checkout -b feature/AmazingFeature`)
3. **提交**更改 (`git commit -m 'Add some AmazingFeature'`)
4. **推送**到分支 (`git push origin feature/AmazingFeature`)
5. **提交** Pull Request

### 贡献领域

| 领域 | 说明 |
|:---:|:---|
| 🐛 **Bug 修复** | 修复 UI 相关的 bug 和功能问题 |
| ✨ **功能改进** | 改进用户界面和交互体验 |
| 📝 **文档完善** | 完善文档、注释和使用说明 |
| 🎨 **样式优化** | 优化样式、主题和视觉效果 |
| 🌍 **国际化** | 添加多语言支持 |
| 🧪 **测试** | 编写和完善测试用例 |

### 开发建议

- 遵循现有的代码风格和规范
- 提交前确保代码通过 TypeScript 类型检查
- 为新功能添加必要的注释和文档
- 保持提交信息清晰明了

---

## 📄 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证  
（知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议）

<div align="center">

### ✅ 您可以自由地

| 权利 | 说明 |
|:---:|:---|
| 📥 **共享** | 复制、发行本软件 |
| 🔧 **演绎** | 修改、转换或以本软件为基础进行创作 |
| 👤 **个人使用** | 用于学习和个人项目 |

### 📋 但必须遵守

| 要求 | 说明 |
|:---:|:---|
| 📝 **署名** | 必须给出适当的署名，提供指向本许可协议的链接 |
| 🚫 **非商业性使用** | 不得用于商业目的 |
| 🔄 **相同方式共享** | 如果修改本软件，必须使用相同的许可协议 |

### ❌ 严格禁止

- 销售本软件或其修改版本
- 用于任何商业服务或产品
- 通过本软件获取商业利益

</div>

查看 [LICENSE](LICENSE) 文件了解完整协议内容。

---

## ⚠️ 免责声明

> **重要提示**
> 
> - 本项目仅供**学习和研究**使用
> - 请遵守相关**法律法规**和用户协议
> - 使用本项目产生的任何后果由**用户自行承担**
> - 请勿将本项目用于任何**非法用途**

---

## 📞 联系方式

<div align="center">

| 渠道 | 链接 |
|:---:|:---|
| 🌐 **官方网站** | [密语 CipherTalk](https://miyu.aiqji.com) |
| 🐛 **问题反馈** | [GitHub Issues](https://github.com/ILoveBingLu/CipherTalk/issues) |
| 💬 **讨论交流** | [GitHub Discussions](https://github.com/ILoveBingLu/CipherTalk/discussions) |
| 📱 **Telegram 群组** | [加入群聊](https://t.me/CipherTalkChat) |
| ⭐ **项目主页** | [GitHub Repository](https://github.com/ILoveBingLu/CipherTalk) |

</div>

---

## 🙏 致谢

感谢所有为开源社区做出贡献的开发者们！

特别感谢：
- **[WeFlow](https://github.com/hicccc77/WeFlow)** - 提供了部分功能参考
- **所有贡献者** - 感谢每一位为本项目做出贡献的开发者

---

## 📈 Star History

<div align="center">

<a href="https://www.star-history.com/#ILoveBingLu/CipherTalk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ILoveBingLu/CipherTalk&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ILoveBingLu/CipherTalk&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ILoveBingLu/CipherTalk&type=date&legend=top-left" />
 </picture>
</a>

---

<sub>一鲸落，万物生 · 愿每一段对话都被温柔以待 ❤️ by the CipherTalk Team</sub>

</div>
