<div align="center">

<img src="welcome.png" alt="密语 CipherTalk" width="100%" />

# 🔐 密语 CipherTalk

**一款现代化的微信聊天记录查看与分析工具**

[![License](https://img.shields.io/badge/license-CC--BY--NC--SA--4.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.2.8-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg?logo=windows)]()
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron)]()
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react)]()
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Group-26A5E4.svg?logo=telegram)](https://t.me/CipherTalk)

[功能特性](#-功能特性) • [快速开始](#-快速开始) • [技术栈](#️-技术栈) • [贡献指南](#-贡献指南) • [许可证](#-许可证)

## YouTubu使用教程

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

- **Node.js**: 18.x 或更高版本
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
| 🌐 **官方网站** | [密语 CipherTalk](https://miyuapp.aiqji.com) |
| 🐛 **问题反馈** | [GitHub Issues](https://github.com/ILoveBingLu/CipherTalk/issues) |
| 💬 **讨论交流** | [GitHub Discussions](https://github.com/ILoveBingLu/CipherTalk/discussions) |
| 📱 **Telegram 群组** | [加入群聊](https://t.me/+toZ7bY15IZo3NjVl) |
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