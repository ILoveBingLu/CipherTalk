[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/ilovebinglu-ciphertalk-badge.png)](https://mseep.ai/app/ilovebinglu-ciphertalk)

<div align="center">

<img src="welcome.jpg" alt="密语 CipherTalk" width="100%" />

# 🔐 密语 CipherTalk

**一款现代化的微信聊天记录查看与分析工具**

[![License](https://img.shields.io/badge/license-CC--BY--NC--SA--4.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.0.1-green.svg)](package.json)
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

## 🤝 贡献指南

我们欢迎所有形式的贡献！无论是报告 Bug、提出新功能建议，还是提交代码改进。

---

## 📄 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证  
（知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议）

<div align="center">

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
| 📱 **Telegram 群组** | [加入群聊](https://t.me/CipherTalkChat) |

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
