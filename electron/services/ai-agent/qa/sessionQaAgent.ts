/**
 * SessionQA Agent 入口 —— barrel re-export
 *
 * 原 3400+ 行单文件已拆分为以下模块：
 *   types.ts          — 类型、常量
 *   utils/text.ts     — 文本工具
 *   utils/time.ts     — 时间推理
 *   utils/search.ts   — 搜索查询处理
 *   utils/message.ts  — 消息格式化
 *   intent/router.ts  — 意图路由
 *   evidence.ts       — 证据质量评估
 *   progress.ts       — 进度事件
 *   agentContext.ts    — Agent 上下文状态（含超时/取消）
 *   agentDecision.ts   — Agent 决策解析
 *   prompts/decision.ts — 决策 prompt
 *   prompts/answer.ts   — 回答 prompt
 *   tools/search.ts     — 搜索工具
 *   tools/statistics.ts — 统计工具
 *   tools/participant.ts — 参与者解析
 *   tools/aggregate.ts  — 消息聚合
 *   orchestrator.ts    — 主编排循环
 *
 * 本文件仅导出公共类型。SessionQA 执行入口已统一到 Workflow + Worker。
 */

// ─── 公共类型（对外导出）────────────────────────────────────
export type {
  SessionQAHistoryMessage,
  SessionQAToolCall,
  SessionQAToolName,
  SessionQAProgressStage,
  SessionQAProgressStatus,
  SessionQAProgressSource,
  SessionQAProgressEvent,
  SessionQAAgentOptions,
  SessionQAAgentResult
} from './types'

