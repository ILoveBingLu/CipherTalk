---
id: "builtin-session-qa"
name: "会话问答"
version: "1.0.0"
description: "针对当前聊天记录的智能问答，自动搜索、阅读上下文、评估证据质量后生成回答。"
category: "qa"
builtin: true
agentId: "builtin-general-agent"
defaultAgentId: "builtin-general-agent"
allowAgentOverride: true
requiresContext: "session_or_contact"
toolIds: ["native:read_summary_facts","native:search_messages","native:read_context","native:read_latest","native:read_by_time_range","native:get_session_statistics","native:get_keyword_statistics","native:aggregate_messages","native:resolve_participant","native:answer"]
hookNames: ["sessionQaRoute","sessionQaEvidence","sessionQaFallback","sessionQaFinalAnswer"]
maxTurns: 15
maxToolCalls: 30
timeoutMs: 300000
enableThinking: true
decisionTemperature: 0.2
answerTemperature: 0.3
createdAt: 0
updatedAt: 0
---

# 会话问答工作流

回答关于当前聊天记录的问题，通过多阶段证据收集循环完成。

## 工作方式

1. 识别问题意图，判断是否需要读取聊天记录。
2. 使用摘要、搜索、上下文读取、时间范围读取、统计和聚合工具收集证据。
3. 根据证据质量决定继续检索、切换关键词、读取最近消息或进入回答阶段。
4. 最终回答只基于已收集证据生成，证据不足时明确说明不足。

## 质量规则

- 证据质量分为 none、weak、sufficient。
- 搜索无命中时允许自动换关键词或读取最近消息兜底。
- 工具预算耗尽或证据充分后进入最终回答阶段。
- 不编造聊天内容、发送者、时间、数量或结论。
