/**
 * 意图路由：启发式分类 + 路由强化
 */
import type {
  IntentRoute,
  SessionQAIntentType,
  ToolLoopAction
} from '../types'
import { stripThinkBlocks } from '../utils/text'
import { inferTimeRangeFromQuestion } from '../utils/time'
import {
  extractHeuristicQueries,
  getFirstConcreteQuery,
  isConcreteEvidenceQuestion,
  isKeywordEvidenceStatisticsQuestion,
  mergeSearchQueriesForQuestion
} from '../utils/search'
import {
  matchesAny,
  STATS_PATTERNS,
  SUMMARY_PATTERNS,
  MEDIA_PATTERNS,
  EVIDENCE_PATTERNS,
  PARTICIPANT_PATTERNS,
  RECENT_PATTERNS
} from './patterns'

/**
 * 构建意图类型的默认工具执行计划
 */
function buildDefaultPreferredPlan(intent: SessionQAIntentType): ToolLoopAction['action'][] {
  switch (intent) {
    case 'direct_answer':
      return ['answer']
    case 'summary_answerable':
      return ['read_summary_facts', 'answer']
    case 'recent_status':
      return ['read_summary_facts', 'get_session_statistics', 'read_latest', 'answer']
    case 'time_range':
      return ['read_by_time_range', 'aggregate_messages', 'answer']
    case 'participant_focus':
      return ['resolve_participant', 'read_by_time_range', 'answer']
    case 'exact_evidence':
      return ['search_messages', 'read_context', 'answer']
    case 'media_or_file':
      return ['search_messages', 'read_context', 'answer']
    case 'broad_summary':
      return ['read_summary_facts', 'get_session_statistics', 'read_latest', 'aggregate_messages', 'answer']
    case 'stats_or_count':
      return ['get_session_statistics', 'answer']
    default:
      return ['read_summary_facts', 'get_session_statistics', 'read_latest', 'answer']
  }
}

/**
 * 基于启发式规则进行意图路由
 */
export function routeFromHeuristics(question: string, summaryText?: string): IntentRoute {
  const timeRange = inferTimeRangeFromQuestion(question)
  const hasSummary = Boolean(stripThinkBlocks(summaryText || '').trim())
  const queries = mergeSearchQueriesForQuestion(question, extractHeuristicQueries(question))
  const firstQuery = getFirstConcreteQuery(question, queries)
  const concreteEvidenceQuestion = isConcreteEvidenceQuestion(question, queries)
  const keywordEvidenceStats = isKeywordEvidenceStatisticsQuestion(question, firstQuery)
  const participantHints = extractHeuristicQueries(question)
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(0, 2)

  let intent: SessionQAIntentType = 'unclear'
  if (keywordEvidenceStats) {
    intent = 'stats_or_count'
  } else if (matchesAny(question, STATS_PATTERNS)) {
    intent = 'stats_or_count'
  } else if (concreteEvidenceQuestion) {
    intent = 'exact_evidence'
  } else if (timeRange) {
    intent = 'time_range'
  } else if (matchesAny(question, SUMMARY_PATTERNS)) {
    intent = hasSummary ? 'summary_answerable' : 'broad_summary'
  } else if (matchesAny(question, MEDIA_PATTERNS)) {
    intent = 'media_or_file'
  } else if (matchesAny(question, EVIDENCE_PATTERNS)) {
    intent = 'exact_evidence'
  } else if (matchesAny(question, PARTICIPANT_PATTERNS)) {
    intent = 'participant_focus'
  } else if (!firstQuery && matchesAny(question, RECENT_PATTERNS)) {
    intent = 'recent_status'
  } else if (firstQuery) {
    intent = 'exact_evidence'
  } else if (!firstQuery && !timeRange && question.length <= 16) {
    intent = 'direct_answer'
  } else if (hasSummary) {
    intent = 'summary_answerable'
  }

  return {
    intent,
    confidence: 'medium',
    reason: '本地启发式路由',
    timeRange,
    participantHints,
    searchQueries: queries,
    needsSearch: intent === 'exact_evidence' || keywordEvidenceStats,
    preferredPlan: keywordEvidenceStats
      ? ['get_keyword_statistics', 'search_messages', 'read_context', 'answer']
      : buildDefaultPreferredPlan(intent)
  }
}

/**
 * 强化具体证据路由：发现有具体关键词/实体时强制走检索
 */
export function enforceConcreteEvidenceRoute(route: IntentRoute, question: string): IntentRoute {
  if (route.intent === 'direct_answer') {
    return {
      ...route,
      searchQueries: [],
      needsSearch: false,
      preferredPlan: ['answer']
    }
  }

  const searchQueries = mergeSearchQueriesForQuestion(question, route.searchQueries, extractHeuristicQueries(question))
  const firstQuery = getFirstConcreteQuery(question, searchQueries)
  const concreteEvidenceQuestion = isConcreteEvidenceQuestion(question, searchQueries)
  const keywordEvidenceStats = isKeywordEvidenceStatisticsQuestion(question, firstQuery)

  if (!concreteEvidenceQuestion && !keywordEvidenceStats) {
    return {
      ...route,
      searchQueries
    }
  }

  const preferredPlan: ToolLoopAction['action'][] = keywordEvidenceStats
    ? ['get_keyword_statistics', 'search_messages', 'read_context', 'answer']
    : ['search_messages', 'read_context', 'answer']
  const intent: SessionQAIntentType = keywordEvidenceStats
    ? 'stats_or_count'
    : route.intent === 'media_or_file'
      ? 'media_or_file'
      : 'exact_evidence'

  return {
    ...route,
    intent,
    reason: route.intent === intent
      ? route.reason
      : `${route.reason || '模型路由'}；检测到具体关键词/实体问题，强制检索证据`,
    searchQueries,
    needsSearch: true,
    preferredPlan
  }
}

/**
 * 获取意图类型的中文标签
 */
export function getRouteLabel(intent: SessionQAIntentType): string {
  const labels: Record<SessionQAIntentType, string> = {
    direct_answer: '直接回答',
    summary_answerable: '摘要可答',
    recent_status: '最近进展',
    time_range: '时间范围',
    participant_focus: '参与者聚焦',
    exact_evidence: '精确证据',
    media_or_file: '媒体文件',
    broad_summary: '趋势总结',
    stats_or_count: '统计计数',
    unclear: '不明确'
  }
  return labels[intent]
}
