---
id: "builtin-session-summary"
name: "会话摘要"
version: "1.0.0"
description: "对选中会话在指定时间范围内的聊天记录进行结构化分析，自动提取关键信息并生成流式摘要。"
category: "summary"
builtin: true
agentId: "builtin-general-agent"
defaultAgentId: "builtin-general-agent"
allowAgentOverride: true
requiresContext: "session_or_contact"
toolIds: ["native:read_summary_facts","native:read_by_time_range","native:get_session_statistics","native:get_keyword_statistics","native:aggregate_messages","native:resolve_participant","native:answer"]
hookNames: ["summaryPreprocess","summaryEnrich","summaryFinalGenerate"]
maxTurns: 5
maxToolCalls: 15
timeoutMs: 300000
enableThinking: true
decisionTemperature: 0.2
answerTemperature: 0.3
createdAt: 0
updatedAt: 0
---

# 会话摘要工作流

对选中会话在指定时间范围内的聊天记录生成结构化摘要，通过预处理 + Agent 决策 + 流式生成三阶段完成。

## 工作方式

1. **预处理阶段**：加载消息、标准化、分块、结构化抽取、证据解析、记忆上下文组装。
2. **Agent 决策阶段**：Agent 可选调用统计、聚合、时间范围读取等工具补充信息（通常 1-2 轮即进入回答）。
3. **流式生成阶段**：基于结构化分析结果（或 legacy 兜底）流式输出 Markdown 摘要。

## 质量规则

- 结构化抽取在预处理中完成，对每次摘要确定性执行。
- Agent 循环仅用于可选的信息补充，不负责核心抽取。
- 最终摘要只基于已收集证据生成，证据不足时明确说明不足。
- 不编造聊天内容、发送者、时间、数量或结论。
- 长会话无法完整覆盖时，必须说明覆盖策略和遗漏风险。
