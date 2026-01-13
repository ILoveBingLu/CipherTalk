# 密语 CipherTalk

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.6-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)]()
[![Telegram](https://img.shields.io/badge/Telegram-Join%20Group%20Chat-blue.svg?logo=telegram)](https://t.me/your_group_link)

基于 Electron + React + TypeScript 构建的聊天记录查看工具界面，基于原项目 [EchoTrace](https://github.com/ycccccccy/echotrace) 重构。

## 🚀 功能特性

- 💬 **聊天记录界面** - 现代化的聊天记录查看界面
- 🎨 **主题切换** - 支持浅色/深色模式，多种主题色可选
- 📊 **数据可视化** - 图表展示和数据分析界面
- � **搜索功能**  - 全文搜索界面和交互
- 📤 **导出界面** - 数据导出功能的用户界面
- 🌍 **国际化** - 多语言支持框架

## 🛠️ 技术栈

- **前端框架**: React 19 + TypeScript + Zustand
- **桌面应用**: Electron 39
- **构建工具**: Vite + electron-builder
- **样式方案**: SCSS + CSS Variables
- **图表库**: ECharts
- **其他**: jieba-wasm (分词), lucide-react (图标)

## 📁 项目结构

```
ciphertalk/
├── src/                   # React 前端
│   ├── components/       # 通用组件
│   ├── pages/            # 页面组件
│   ├── stores/           # Zustand 状态管理
│   ├── services/         # 前端服务
│   ├── types/            # TypeScript 类型定义
│   ├── utils/            # 工具函数
│   └── styles/           # 样式文件
├── public/               # 静态资源
├── electron/             # Electron 配置
│   ├── main.ts           # 主进程入口
│   └── preload.ts        # 预加载脚本
└── docs/                 # 项目文档
```

## 🚀 快速开始

### 环境要求

- Node.js 18+
- Windows 10/11

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建应用

```bash
npm run build
```

## 📖 开发指南

### 前端开发

本项目使用现代化的前端技术栈：

1. **React 19** - 最新的 React 版本，支持并发特性
2. **TypeScript** - 类型安全的 JavaScript
3. **Zustand** - 轻量级状态管理
4. **SCSS** - 强大的 CSS 预处理器
5. **Vite** - 快速的构建工具

### 组件开发

- 使用函数组件和 Hooks
- 遵循 TypeScript 最佳实践
- 组件名使用 PascalCase
- 样式使用 BEM 命名规范

### 主题系统

项目支持多主题切换：

- 浅色/深色模式
- 多种主题色彩
- CSS 变量驱动
- 响应式设计

## 🤝 贡献指南

欢迎贡献代码！请查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详细信息。

### 贡献领域

- � 修复 UI 相关的 bug
- ✨ 改进用户界面和交互
- 📝 完善文档和注释
- 🎨 优化样式和主题
- 🌍 国际化和本地化

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

## ⚠️ 免责声明

- 本项目仅供学习和研究使用
- 请遵守相关法律法规
- 使用本项目产生的任何后果由用户自行承担

## 📞 联系方式

- 🐛 问题反馈: [GitHub Issues](https://github.com/ILoveBingLu/miyu/issues)

## 联致谢

感谢所有为开源社区做出贡献的开发者们！