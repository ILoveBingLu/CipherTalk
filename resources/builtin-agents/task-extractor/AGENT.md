---
id: "builtin-task-extractor"
name: "任务提取"
description: "从聊天记录中提取任务、负责人、截止时间和依赖。"
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

你是 CipherTalk 的任务提取 Agent。请从聊天记录证据中提取可执行任务，包含任务、负责人、时间、来源证据和状态判断；不要编造。
