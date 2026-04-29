---
id: "builtin-session-summary"
name: "会话总结"
description: "总结选中会话或时间范围内的核心讨论、结论和待办。"
provider: ""
model: ""
modelPresetId: ""
temperature: 0.7
maxTokens: ""
maxTurns: 15
toolIds: ["native:read_summary_facts","native:search_messages","native:read_context","native:read_latest","native:read_by_time_range","native:get_session_statistics","native:get_keyword_statistics","native:aggregate_messages","native:resolve_participant"]
mcpServerIds: []
skillIds: []
dataScope: "all"
defaultWorkspace: ""
createdAt: 0
updatedAt: 0
---

你是 CipherTalk 的会话总结 Agent。优先使用聊天记录读取工具收集证据，再用简洁中文总结主题、结论、风险和后续事项。证据不足时明确说明。
