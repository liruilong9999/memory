/**
 * 抽取内核：从一轮对话里决定「写什么记忆卡」。
 *
 * 需求 FR-A1：轮次边界异步写卡。本文件只负责**纯计算**——输入一轮对话的
 * 原始文本，输出待写入的记忆卡草稿；落库与调度由数据面/适配面负责。
 *
 * 起源第 10 条讲「专注机制」：不是所有输入都值得记。门控（gate）先于检索，
 * 也先于写入。这里是写入侧的门控：先看信号强度，再决定抽不抽、抽几条。
 *
 * 决策 D-11：记忆卡写入由系统驱动，不开放「模型写记忆」工具。
 * 所以抽取必须靠规则，规则必须可解释、可单测、确定性。
 *
 * @module dsh-memory/core/extraction
 */

import type { MemoryConfig } from './config.ts'
import { extractEntities, matchSignals, normalizeText, splitSentences, tokenSet, truncate } from './text.ts'
import type {
  MemoryCard, MemoryDomain, MemoryKind, SourcePointer,
} from './types.ts'
import { buildCardId } from './types.ts'

/** 一轮对话的输入素材。 */
export interface TurnInput {
  /** 会话 id。 */
  sessionId: string
  /** 轮次号。 */
  turn: number
  /** 步骤号。 */
  step: number
  /** 会话事件序号（来源指针用）。 */
  seq: number
  /** 用户消息原文。 */
  userText: string
  /** 助手回复原文；为空表示没有。 */
  assistantText: string
  /** 该轮所属记忆域。 */
  domain: MemoryDomain
  /** 事件发生时刻（毫秒）。 */
  at: number
}

/** 一张待写入的卡片草稿（还缺 id 与强度初值，由 {@link draftToCard} 补齐）。 */
export interface CardDraft {
  /** 卡片类型。 */
  kind: MemoryKind
  /** 摘要文本。 */
  text: string
  /** 归一化文本。 */
  normalized: string
  /** 显著性 0..1。 */
  salience: number
  /** 情绪强度 0..1。 */
  emotional: number
  /** 置信度 0..1。 */
  confidence: number
  /** 标签。 */
  tags: string[]
  /** 实体锚点。 */
  entities: string[]
  /** 命中的信号词。 */
  signals: string[]
  /** 来源指针。 */
  source: SourcePointer
  /** 归属域。 */
  domain: MemoryDomain
}

/**
 * 门控：判断这一轮是否值得写记忆。
 *
 * 需求 P8「成本有上界」与起源「专注」都要求先过滤。
 * 判据三条，满足任一即写：
 * 1. 用户消息命中信号关键词（决策、承诺、偏好、踩坑…）
 * 2. 用户消息足够长（信息量够）
 * 3. 助手回复足够长且有信号词（结论性的长回答）
 *
 * @param input - 一轮对话。
 * @param config - 配置。
 * @returns 是否写入，以及命中的信号词。
 */
export function gateTurn(
  input: TurnInput, config: MemoryConfig,
): { pass: boolean; signals: string[] } {
  const userSignals = matchSignals(input.userText, config.extraction.signalKeywords)
  const userLong = [...input.userText].length >= config.extraction.minTextChars
  const assistantLong = config.extraction.includeAssistant
    && [...input.assistantText].length >= config.extraction.minAssistantChars
  const assistantSignals = assistantLong
    ? matchSignals(input.assistantText, config.extraction.signalKeywords)
    : []

  const signals = [...new Set([...userSignals, ...assistantSignals])]
  const pass = userSignals.length > 0 || (userLong && userSignals.length > 0) || (userLong && assistantLong)
  return { pass, signals }
}

/**
 * 判断句子类型：承诺 / 事实 / 感受 / 经验 / 事件。
 *
 * 用规则而非模型：规则可解释（FR-B4 的精神）、可单测、零延迟。
 * 判据按优先级从强到弱，命中即返回。
 *
 * @param sentence - 单句文本。
 * @returns 卡片类型。
 */
export function classifySentence(sentence: string): MemoryKind {
  const s = sentence.toLowerCase()
  // 承诺类：明确的未来义务。优先级最高，因为承诺永不自动归档（FR-C3）。
  if (/(答应|承诺|保证|务必|必须|下周|明天|之后|回头|记得|别忘|一定要)/u.test(s)) return 'promise'
  // 感受类：主观体验。起源「留下的只有感受」。
  if (/(感觉|觉得|难受|开心|烦|累|喜欢|讨厌|担心|害怕|兴奋|失望|舒服)/u.test(s)) return 'feeling'
  // 经验类：从踩坑里沉淀的做法。
  if (/(踩坑|教训|下次要|以后要|经验|总结|建议|正确做法|应该先)/u.test(s)) return 'experience'
  // 事实类：稳定成立的结论、定义、约定。
  if (/(是|为|等于|指的是|定义|结论|决定|方案|选|用|配置|版本)/u.test(s)) return 'fact'
  // 兜底：事件。
  return 'event'
}

/**
 * 计算显著性：这句话值不值得记。
 *
 * 信号词命中、长度适中、含实体（可关联）、含决策性措辞，都会提高显著性。
 *
 * @param sentence - 单句。
 * @param signals - 命中的全局信号词。
 * @param entities - 该句抽到的实体。
 * @returns 0..1 的显著性。
 */
export function computeSalience(
  sentence: string, signals: readonly string[], entities: readonly string[],
): number {
  const chars = [...sentence].length
  // 长度项：太短信息量不足，太长通常是复述；20~80 字最优。
  const lengthScore = chars < 8 ? 0.15 : chars < 20 ? 0.5 : chars <= 80 ? 1 : 0.7
  const signalScore = Math.min(1, signals.length / 3)
  const entityScore = Math.min(1, entities.length / 3)
  const raw = lengthScore * 0.42 + signalScore * 0.36 + entityScore * 0.22
  return Math.min(1, Math.max(0, raw))
}

/**
 * 计算情绪强度：起源第 1 条「激素是关键」。
 *
 * 本阶段不做情绪系统，只把情绪词密度作为**记忆强度的调制量**：
 * 情绪越强，衰减越慢、越不容易被归档。
 *
 * @param sentence - 单句。
 * @returns 0..1 的情绪强度。
 */
export function computeEmotional(sentence: string): number {
  const strong = (sentence.match(/(非常|特别|超级|极其|太|巨|特别|崩溃|爆炸|气死|爽|绝了)/gu) ?? []).length
  const medium = (sentence.match(/(很|挺|比较|有点|感觉|觉得|担心|害怕|开心|难受|烦|累)/gu) ?? []).length
  // 感叹号与问号也是情绪信号。
  const marks = (sentence.match(/[!！?？]/gu) ?? []).length
  const raw = Math.min(1, strong * 0.4 + medium * 0.18 + marks * 0.12)
  return Math.max(0, raw)
}

/**
 * 计算置信度：这句话有多可信。
 *
 * 用户直述 > 助手推测；含「可能/也许/大概」的降置信；
 * 含「确定/一定/实测/验证」的提置信。
 *
 * @param sentence - 单句。
 * @param fromUser - 是否来自用户。
 * @returns 0..1 的置信度。
 */
export function computeConfidence(sentence: string, fromUser: boolean): number {
  let base = fromUser ? 0.85 : 0.62
  if (/(可能|也许|大概|或许|不确定|好像|似乎|据说)/u.test(sentence)) base -= 0.25
  if (/(确定|一定|实测|验证过|确认|确实|必然)/u.test(sentence)) base += 0.12
  return Math.min(1, Math.max(0.05, base))
}

/**
 * 从一轮对话里抽取记忆卡草稿。
 *
 * 流程：
 * ```text
 * 门控 → 切句 → 逐句分类与打分 → 排序取前 N → 转草稿
 * ```
 * 单轮最多写 `config.extraction.maxCardsPerTurn` 张，保证写入成本有上界（P8）。
 *
 * @param input - 一轮对话。
 * @param config - 配置。
 * @returns 卡片草稿数组，按显著性降序。
 */
export function extractCards(input: TurnInput, config: MemoryConfig): CardDraft[] {
  const gate = gateTurn(input, config)
  if (!gate.pass) return []

  const drafts: CardDraft[] = []
  const seen = new Set<string>()

  /**
   * 处理一段文本（用户或助手），把句子变成草稿。
   *
   * @param text - 原文。
   * @param fromUser - 是否来自用户。
   */
  const consume = (text: string, fromUser: boolean): void => {
    if (text.trim().length === 0) return
    for (const sentence of splitSentences(text)) {
      const chars = [...sentence].length
      if (chars < config.extraction.minTextChars) continue
      const entities = extractEntities(sentence)
      const signals = matchSignals(sentence, config.extraction.signalKeywords)
      // 无信号且无实体的长句通常是寒暄或复述，跳过。
      if (signals.length === 0 && entities.length === 0 && chars < 40) continue

      const kind = classifySentence(sentence)
      const salience = computeSalience(sentence, signals, entities)
      // 显著性太低的不写，防止噪声入库。
      if (salience < 0.25) continue

      const text = truncate(sentence.trim(), config.recall.maxCardChars)
      const normalized = normalizeText(text)
      if (normalized.length === 0 || seen.has(normalized)) continue
      seen.add(normalized)

      drafts.push({
        kind,
        text,
        normalized,
        salience,
        emotional: computeEmotional(sentence),
        confidence: computeConfidence(sentence, fromUser),
        tags: signals,
        entities,
        signals,
        source: {
          sessionId: input.sessionId,
          turn: input.turn,
          step: input.step,
          seq: input.seq,
          eventType: fromUser ? 'user/message' : 'assistant/message',
        },
        domain: input.domain,
      })
    }
  }

  consume(input.userText, true)
  if (config.extraction.includeAssistant) consume(input.assistantText, false)

  // 按显著性降序，同显著性按文本长度降序（长句信息量更大），再按文本字典序兜底保证确定性。
  drafts.sort((a, b) => {
    if (b.salience !== a.salience) return b.salience - a.salience
    const la = [...a.text].length
    const lb = [...b.text].length
    if (lb !== la) return lb - la
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0
  })

  return drafts.slice(0, config.extraction.maxCardsPerTurn)
}

/**
 * 把草稿转成完整记忆卡。
 *
 * 强度初值 = 显著性 × 置信度，让「重要且可信」的记忆一开始就更强。
 *
 * @param draft - 卡片草稿。
 * @param at - 写入时刻（毫秒）。
 * @returns 完整记忆卡。
 */
export function draftToCard(draft: CardDraft, at: number): MemoryCard {
  const id = buildCardId(draft.domain, draft.source, draft.kind, draft.normalized)
  return {
    id,
    domain: draft.domain,
    kind: draft.kind,
    text: draft.text,
    normalized: draft.normalized,
    createdAt: at,
    updatedAt: at,
    source: draft.source,
    salience: draft.salience,
    confidence: draft.confidence,
    emotional: draft.emotional,
    strength: Math.min(1, draft.salience * draft.confidence + 0.15),
    accessCount: 0,
    lastAccessAt: null,
    tags: [...draft.tags],
    entities: [...draft.entities],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: draft.kind === 'promise',
    mergedInto: undefined,
    mergeOf: undefined,
    dueAt: null,
  }
}

/**
 * 从一轮对话直接产出可写入的记忆卡。
 *
 * 这是数据面与适配面唯一需要的入口：给输入，拿卡片。
 *
 * @param input - 一轮对话。
 * @param config - 配置。
 * @returns 完整记忆卡数组。
 */
export function extractMemoryCards(input: TurnInput, config: MemoryConfig): MemoryCard[] {
  return extractCards(input, config).map((draft) => draftToCard(draft, input.at))
}

/**
 * 判断两张卡是否可能冲突。
 *
 * 需求 FR-B5：冲突必须显式暴露。冲突的判据是「共享实体 + 文本相似度低」——
 * 在说同一件事，但说法不一样，就值得人工/整理时对照。
 *
 * @param a - 卡片 A 的实体集合与词项集合。
 * @param b - 卡片 B 的实体集合与词项集合。
 * @param similarity - 两张卡的文本相似度。
 * @param relatedThreshold - 同一话题的下限。
 * @returns 是否构成冲突。
 */
export function looksConflicting(
  a: { entities: readonly string[] }, b: { entities: readonly string[] },
  similarity: number, relatedThreshold: number,
): boolean {
  if (a.entities.length === 0 || b.entities.length === 0) return false
  const setB = new Set(b.entities.map((e) => e.toLowerCase()))
  const shared = a.entities.some((e) => setB.has(e.toLowerCase()))
  // 共享实体说明在谈同一个对象；相似度又不高说明说法不同 → 可能矛盾。
  return shared && similarity < relatedThreshold
}

/**
 * 合并两张卡的标签与实体（去重保序）。
 *
 * @param a - 标签/实体数组 A。
 * @param b - 标签/实体数组 B。
 * @returns 合并后的新数组。
 */
export function unionTags(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...a, ...b]) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * 计算两张卡的文本相似度（供冲突判定与去重复用）。
 *
 * @param a - 卡片 A 的归一化文本。
 * @param b - 卡片 B 的归一化文本。
 * @returns 0..1 的 Jaccard 相似度。
 */
export function textSimilarity(a: string, b: string): number {
  const setA = tokenSet(a)
  const setB = tokenSet(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}
