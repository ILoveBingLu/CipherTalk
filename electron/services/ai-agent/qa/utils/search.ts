/**
 * 搜索查询处理：规范化、评分、去噪、扩展
 */
import { MAX_SEARCH_QUERIES } from '../types'
import { compactText } from './text'

/**
 * 规范化搜索关键词：去除标点、压缩空白
 */
export function normalizeSearchQuery(value: string, limit = 32): string {
  return compactText(value, limit)
    .replace(/[？?！!。，,；;：:"""''()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pushAlternativeQuery(target: string[], value: string, failedQuery: string) {
  const query = normalizeSearchQuery(value, 48)
  if (!query) return
  if (query.toLowerCase() === failedQuery.toLowerCase()) return
  target.push(query)
}

/**
 * 为 0 命中的检索生成字面量替代查询。
 */
export function generateAlternativeQueries(failedQuery: string, originalQuestion: string): string[] {
  const alternatives: string[] = []
  const failed = normalizeSearchQuery(failedQuery, 48)
  const compactQuestion = normalizeCompactQuestion(originalQuestion)

  if (/邮箱|邮件|email|e-mail/i.test(originalQuestion)) {
    pushAlternativeQuery(alternatives, '@', failed)
    pushAlternativeQuery(alternatives, '.com', failed)
    pushAlternativeQuery(alternatives, 'qq.com', failed)
    pushAlternativeQuery(alternatives, 'gmail.com', failed)
  }

  if (/电话|手机|号码|手机号|phone|tel/i.test(originalQuestion)) {
    for (const prefix of ['13', '14', '15', '16', '17', '18', '19']) {
      pushAlternativeQuery(alternatives, prefix, failed)
    }
  }

  if (/链接|网址|url|http|网站/i.test(originalQuestion)) {
    pushAlternativeQuery(alternatives, 'http', failed)
    pushAlternativeQuery(alternatives, 'www', failed)
    pushAlternativeQuery(alternatives, '.com', failed)
  }

  if (/微信|账号|帐号|id|ID/i.test(originalQuestion)) {
    pushAlternativeQuery(alternatives, 'wxid_', failed)
    pushAlternativeQuery(alternatives, '微信号', failed)
  }

  if (failed.length > 4) {
    const mid = Math.floor(failed.length / 2)
    pushAlternativeQuery(alternatives, failed.slice(0, mid), failed)
    pushAlternativeQuery(alternatives, failed.slice(mid), failed)
  }

  const questionWords = originalQuestion
    .replace(/[？?！!。，,；;：:"""''()（）【】\[\]{}\s]+/g, ' ')
    .split(' ')
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .filter((word) => !isGenericSearchQuery(word))

  for (const word of questionWords) {
    pushAlternativeQuery(alternatives, word, failed)
  }

  if (compactQuestion.length >= 4 && compactQuestion !== failed) {
    pushAlternativeQuery(alternatives, compactQuestion.slice(0, Math.min(8, compactQuestion.length)), failed)
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const query of alternatives) {
    const key = query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(query)
    if (unique.length >= 8) break
  }

  return unique
}

/**
 * 规范化并压缩问题用于比对
 */
export function normalizeCompactQuestion(value: string): string {
  return normalizeSearchQuery(value, 120).replace(/\s+/g, '')
}

/**
 * 判断搜索关键词是否过于宽泛
 */
export function isGenericSearchQuery(value: string): boolean {
  const normalized = normalizeSearchQuery(value).replace(/\s+/g, '')
  if (!normalized) return true
  return /^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|刚刚|刚才|我们|他们|对方|是否|有没有|是不是|可以|看到|知道|消息|聊天|内容|问题|回复|回答)$/.test(normalized)
}

/**
 * 判断搜索关键词是否为问句式（不适合直接搜索）
 */
export function isQuestionLikeSearchQuery(value: string): boolean {
  const normalized = normalizeCompactQuestion(value)
  if (!normalized) return true
  return /^(谁|哪个人|哪位|有没有人|有没有谁|有没有|是否|是否有人|我们|他们|大家|群里|这个聊天|这段聊天|当前|现在|最近)/.test(normalized)
    || /(吗|么|呢|啊|呀|吧|没有|没|是什么|怎么回事|多少|几次|哪条)$/.test(normalized)
}

/**
 * 去除搜索词中的噪音前缀/后缀
 */
export function stripSearchTermNoise(value: string): string {
  let text = normalizeSearchQuery(value, 48).replace(/\s+/g, '')
  text = text
    .replace(/^(关于|有关|围绕|那个|这个|一下|下|用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)/, '')
    .replace(/(的人|的情况|的消息|这件事|这事|相关内容|相关消息|吗|么|呢|啊|呀|吧|了|没有|没)$/g, '')
    .replace(/(谁|哪个人|哪位|什么时候|多少|几次|次数|频率|排行|最多|最少).*$/g, '')
  return normalizeSearchQuery(text, 48)
}

/**
 * 推送搜索词（去噪后）
 */
export function pushSearchTerm(target: string[], value: string) {
  const term = stripSearchTermNoise(value)
  if (!term || isGenericSearchQuery(term) || isQuestionLikeSearchQuery(term)) return
  target.push(term)
}

/**
 * 从问题中提取具体搜索词
 */
export function extractConcreteSearchTerms(question: string): string[] {
  const normalized = normalizeSearchQuery(question, 160)
  const terms: string[] = []

  // 引号内容
  const quotedPattern = /[""'']([^""'']{2,48})[""'']/g
  let quotedMatch: RegExpExecArray | null
  while ((quotedMatch = quotedPattern.exec(question))) {
    pushSearchTerm(terms, quotedMatch[1])
  }

  // 英文标识符
  const latinPattern = /[A-Za-z][A-Za-z0-9._+#-]{1,}/g
  let latinMatch: RegExpExecArray | null
  while ((latinMatch = latinPattern.exec(normalized))) {
    const token = latinMatch[0]
    if (/^(http|https|www)$/i.test(token)) continue
    pushSearchTerm(terms, token)
  }

  // 动词+宾语
  const compact = normalizeCompactQuestion(question)
  const verbPattern = /(用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)(.{2,32})/g
  let verbMatch: RegExpExecArray | null
  while ((verbMatch = verbPattern.exec(compact))) {
    pushSearchTerm(terms, verbMatch[2])
  }

  // "关于/有关"引导
  const aboutPattern = /(关于|有关|围绕)(.{2,32})/g
  let aboutMatch: RegExpExecArray | null
  while ((aboutMatch = aboutPattern.exec(compact))) {
    pushSearchTerm(terms, aboutMatch[2])
  }

  const seen = new Set<string>()
  return terms.filter((term) => {
    const key = term.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_SEARCH_QUERIES)
}

/**
 * 评分搜索关键词的质量
 */
export function scoreSearchQuery(query: string, question: string): number {
  const normalized = normalizeCompactQuestion(query)
  const normalizedQuestion = normalizeCompactQuestion(question)
  if (!normalized || isGenericSearchQuery(query)) return -100

  let score = 0
  if (/[A-Za-z0-9]/.test(normalized)) score += 8
  if (/^[\u4e00-\u9fa5A-Za-z0-9._+#-]{2,20}$/.test(normalized)) score += 4
  if (normalizedQuestion.includes(normalized)) score += 2
  if (normalized.length >= 2 && normalized.length <= 16) score += 2
  if (isQuestionLikeSearchQuery(query)) score -= 8
  if (normalized === normalizedQuestion) score -= 10
  return score
}

/**
 * 扩展搜索关键词列表
 */
export function expandSearchQueries(question: string, modelQueries: string[]): string[] {
  const candidates: string[] = []
  const push = (value: string) => {
    const query = normalizeSearchQuery(value)
    if (!query || isGenericSearchQuery(query)) return
    candidates.push(query)
  }

  for (const query of modelQueries) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  for (const query of extractConcreteSearchTerms(question)) {
    push(query)
  }

  for (const query of extractHeuristicQueries(question)) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const query of candidates) {
    const normalized = query.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(query)
    if (unique.length >= MAX_SEARCH_QUERIES) break
  }

  return unique
    .sort((a, b) => scoreSearchQuery(b, question) - scoreSearchQuery(a, question))
    .slice(0, MAX_SEARCH_QUERIES)
}

/**
 * 合并多组搜索关键词
 */
export function mergeSearchQueriesForQuestion(question: string, ...groups: string[][]): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const group of groups) {
    for (const query of expandSearchQueries(question, group)) {
      const key = query.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      queries.push(query)
    }
  }
  return queries
    .sort((a, b) => scoreSearchQuery(b, question) - scoreSearchQuery(a, question))
    .slice(0, MAX_SEARCH_QUERIES)
}

/**
 * 从问题中启发式提取搜索关键词
 */
export function extractHeuristicQueries(question: string): string[] {
  const normalized = question
    .replace(/[？?！!。，,；;：:"""''()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const concreteTerms = extractConcreteSearchTerms(question)
  if (concreteTerms.length > 0) {
    return concreteTerms
  }

  const words = normalized
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|我们|他们|对方|是否|有没有|是不是)$/.test(item))

  if (words.length > 0) {
    return words.slice(0, MAX_SEARCH_QUERIES)
  }

  const compact = normalized.replace(/\s+/g, '')
  if (compact.length >= 4) {
    return [compact.slice(0, Math.min(8, compact.length))]
  }

  return []
}

/**
 * 判断是否为需要具体证据的问题
 */
export function isConcreteEvidenceQuestion(question: string, queries: string[]): boolean {
  if (!queries.some((query) => !isGenericSearchQuery(query) && !isQuestionLikeSearchQuery(query))) return false
  const compact = normalizeCompactQuestion(question)
  return /(谁|哪个人|哪位|有没有人|有没有谁|有没有|是否|是否有人|哪条|原文)/.test(compact)
    || /(用过|使用过|使用|提到过|提到|提及|聊过|聊到|聊起|说过|说起|发过|分享过|讨论过|问过|了解|会不会|会|懂|试过|推荐过|出现过|包含)/.test(compact)
}

/**
 * 获取第一个具体搜索关键词
 */
export function getFirstConcreteQuery(question: string, queries: string[]): string {
  return mergeSearchQueriesForQuestion(question, queries).find((query) => !isGenericSearchQuery(query) && !isQuestionLikeSearchQuery(query)) || ''
}

/**
 * 判断是否为关键词证据统计类问题
 */
export function isKeywordEvidenceStatisticsQuestion(question: string, firstQuery: string): boolean {
  if (!firstQuery) return false
  const compact = normalizeCompactQuestion(question)
  if (/(图片|照片|语音|视频|表情|文件|链接|红包|转账|说话最多|发言最多|谁.*最多|谁.*最少|活跃|几点|什么时候|多少条|总共|总量|类型)/.test(compact)) {
    return false
  }
  return /(关键词|这个词|这个短语|出现|提到|提及|说过|包含|几次|次数|频率|谁.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|哪个人.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|哪位.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|有没有.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过)|是否.*(用过|使用|提到|提及|聊过|说过|发过|分享过|讨论过|问过|了解|会|懂|试过|推荐过))/.test(compact)
}
