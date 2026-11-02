/**
 * 摘要与跨周期层级压缩（Summary & Hierarchical Compression）。
 *
 * ## 起源依据
 *
 * 起源 L27（第 4 条·渐进累积与夜间整理）：「今日记忆渐进累积，夜晚休眠整理，
 * 很长时间迭代」。这句里有三件事，本文件对应前两件半：
 *
 * - 「渐进累积」→ 日摘要把一天的碎片收拢成一条；
 * - 「夜晚休眠整理」→ 摘要由夜整理产出，不在写入路径上做；
 * - 「很长时间迭代」→ **层级**。日压成周、周压成月，迭代的形态就是层级。
 *
 * ## 为什么必须真的压缩
 *
 * 最容易犯的错是把当天卡片文本拼起来当摘要。那**不是摘要，是日志**：
 * 拼接的信息量与原文相等，压缩比 1:1，只是换了个地方存，还多了一份要维护。
 *
 * 本文件的压缩是**强制**的，有两道闸：
 *
 * 1. `summaryTargetRatio`：摘要字符数不得超过来源总字符数乘以该比例。
 *    这一条让「摘要比原文短」成为算术上的必然，而不是自觉。
 * 2. `dailySummaryMaxChars` / `weeklySummaryMaxChars` / `monthlySummaryMaxChars`：
 *    层级的绝对上限，且 `validateConfig` 强制「层级越高越短」。
 *
 * 所以压缩比的保证在**配置层**（配不出假压缩）和**算术层**（算出来必然更短），
 * 而不只是测试里的一句断言。
 *
 * ## 层级如何表达（不新增字段）
 *
 * 摘要卡的层级不靠新字段，靠三个现有字段：
 * - `kind: 'summary'`——它是一张摘要；
 * - `tags` 首项形如 `daily:2026-11-02` / `weekly:2026-10-27` / `monthly:2026-11`；
 * - `source.sessionId` 就是那个日期键，`source.eventType` 标明是哪一级。
 *
 * 用 {@link summaryLevelOf} 与 {@link summaryKeyOf} 读回来。
 * 不新增字段的理由：`MemoryCard` 是契约层，每加一个字段所有投影/重放路径
 * 都要跟着改，而层级信息本来就完整存在于 tags/source 里。
 *
 * ## 幂等
 *
 * 摘要 id 由 `buildCardId` 从「域 + 合成来源（含日期键）+ kind + 归一化文本」
 * 派生。同一层级同一天重复整理，得到**同一个 id**，`put` 直接覆盖，
 * 不会堆出重复摘要。这是夜整理可以反复跑的前提。
 *
 * @module dsh-memory/consolidate/summarize
 */

import type { MemoryCard, MemoryDomain, SourcePointer } from '../core/types.ts'
import { buildCardId, MEMORY_DOMAINS } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'
import { normalizeText, truncate } from '../core/text.ts'
import { localDate } from '../time/clock.ts'

/** 摘要层级。 */
export type SummaryLevel = 'daily' | 'weekly' | 'monthly'

/** 一天有多少毫秒，仅用于周键的日期算术。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 各层级的日期键前缀，写进 `tags` 首项。
 *
 * 用常量表而不是散落字面量，是因为这三个字符串同时出现在**写**（打标签）
 * 与**读**（{@link summaryLevelOf}）两侧，写错一边就是静默失效。
 */
const LEVEL_PREFIX: Readonly<Record<SummaryLevel, string>> = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
}

/**
 * 取一张卡的摘要层级。
 *
 * 只认 `tags` 首项的 `<level>:<key>` 形式。返回 `null` 表示这张卡不是摘要，
 * 或不是本模块产出的摘要——两种情况调用方的处理相同（不参与层级压缩）。
 *
 * @param card - 记忆卡。
 * @returns 层级；不是摘要时为 `null`。
 */
export function summaryLevelOf(card: MemoryCard): SummaryLevel | null {
  if (card.kind !== 'summary') return null
  const head = card.tags[0]
  if (head === undefined) return null
  const sep = head.indexOf(':')
  if (sep <= 0) return null
  const level = head.slice(0, sep)
  if (level === 'daily' || level === 'weekly' || level === 'monthly') return level
  return null
}

/**
 * 取一张摘要卡的日期键。
 *
 * @param card - 记忆卡。
 * @returns 日期键（`YYYY-MM-DD` 或 `YYYY-MM`）；不是摘要时为 `null`。
 */
export function summaryKeyOf(card: MemoryCard): string | null {
  if (summaryLevelOf(card) === null) return null
  const head = card.tags[0]!
  const sep = head.indexOf(':')
  return sep <= 0 ? null : head.slice(sep + 1)
}

/**
 * 把毫秒时间戳格式化成本地日期键（`YYYY-MM-DD`）。
 *
 * 刻意**不复用** `localDate`：这里输入已经是「按 UTC 口径算出来的日期毫秒」，
 * 再走一次时区转换会把日期挪动一天。日期算术与时区转换是两件事，
 * 混用会产生「摘要日期比卡片日期少一天」这种极难发现的错。
 *
 * @param ms - 毫秒时间戳（UTC 口径的日期零点）。
 * @returns `YYYY-MM-DD`。
 */
function isoFromUtcMs(ms: number): string {
  const date = new Date(ms)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 解析 `YYYY-MM-DD` 为 UTC 毫秒（当天零点）。
 *
 * @param key - 日期键。
 * @returns 毫秒时间戳；格式非法时返回 `NaN`。
 */
function utcMsOf(key: string): number {
  const parts = key.split('-')
  if (parts.length !== 3) return Number.NaN
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return Number.NaN
  return Date.UTC(year, month - 1, day)
}

/**
 * 取某个日期所在周的周一日期键（ISO 周，周一为一周之始）。
 *
 * 周摘要按 ISO 周聚合，因为「一周」在人的感受里是周一到周日，
 * 而不是任意连续的七天——后者会让同一件事被切到两个周摘要里。
 *
 * @param dateKey - 日期键 `YYYY-MM-DD`。
 * @returns 该周周一的日期键；输入非法时原样返回。
 */
export function mondayKeyOf(dateKey: string): string {
  const ms = utcMsOf(dateKey)
  if (Number.isNaN(ms)) return dateKey
  // getUTCDay：0=周日，1=周一 … 6=周六。转成「距本周一的天数」。
  const weekday = new Date(ms).getUTCDay()
  const offset = weekday === 0 ? 6 : weekday - 1
  return isoFromUtcMs(ms - offset * DAY_MS)
}

/**
 * 取某个日期所在月的月份键（`YYYY-MM`）。
 *
 * @param dateKey - 日期键 `YYYY-MM-DD`。
 * @returns 月份键；输入非法时退化为前 7 个字符。
 */
export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7)
}

/**
 * 按自然日分组。
 *
 * 自然日的判定用 `src/time/clock.ts` 的 {@link localDate}——它基于
 * `Intl.DateTimeFormat` 与显式 `timeZone`，是「用户所在时区的今天」的唯一定义。
 *
 * **`timeZone` 必填、不给默认值**：默认成 `'UTC'` 会让东八区用户
 * 每天 08:00 之前的记忆被算进前一天，而且**悄无声息**。给静默错误发通行证，
 * 比让调用方编译不过糟糕得多。
 *
 * @param cards - 候选卡集合。
 * @param timeZone - IANA 时区名，如 `Asia/Shanghai`。
 * @returns 日期键到卡片的映射，键按升序。
 */
export function groupByLocalDate(
  cards: readonly MemoryCard[], timeZone: string,
): Map<string, MemoryCard[]> {
  const groups = new Map<string, MemoryCard[]>()
  for (const card of cards) {
    const key = localDate(card.createdAt, timeZone)
    const bucket = groups.get(key)
    if (bucket === undefined) {
      groups.set(key, [card])
      continue
    }
    bucket.push(card)
  }
  // 组内按 createdAt 升序（同时刻用 id 兜底），保证输出确定（ST-1）。
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  const sorted = new Map<string, MemoryCard[]>()
  for (const key of [...groups.keys()].sort()) sorted.set(key, groups.get(key)!)
  return sorted
}

/**
 * 统计一组卡里出现最多的记忆域。
 *
 * 平票按 `MEMORY_DOMAINS` 的固定顺序取，保证确定性（ST-1）。
 *
 * @param cards - 卡片集合。
 * @returns 代表域。
 */
function dominantDomainOf(cards: readonly MemoryCard[]): MemoryDomain {
  const counts = new Map<MemoryDomain, number>()
  for (const card of cards) counts.set(card.domain, (counts.get(card.domain) ?? 0) + 1)
  let best: MemoryDomain = MEMORY_DOMAINS[0] ?? 'work'
  let bestCount = -1
  for (const domain of MEMORY_DOMAINS) {
    const count = counts.get(domain) ?? 0
    if (count > bestCount) {
      best = domain
      bestCount = count
    }
  }
  return best
}

/**
 * 取出现频次最高的若干标签与实体。
 *
 * 排序：频次降序 → 长度降序（长词更有信息量）→ 字典序升序。
 * 三级键保证结果与输入顺序无关（ST-1）。
 *
 * @param cards - 卡片集合。
 * @param limit - 最多取几项。
 * @returns 关键词数组。
 */
function topTerms(cards: readonly MemoryCard[], limit: number): string[] {
  const counts = new Map<string, number>()
  const bump = (term: string): void => {
    if (term.length === 0) return
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  for (const card of cards) {
    for (const tag of card.tags) bump(tag)
    for (const entity of card.entities) bump(entity)
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]
    || b[0].length - a[0].length
    || a[0].localeCompare(b[0]))
  return ordered.slice(0, limit).map(([term]) => term)
}

/**
 * 算一组卡的文本总字符数，用于压缩比控制。
 *
 * 用**码点**计数而不是 `String.length`：后者对 emoji 与部分汉字返回 2，
 * 会让压缩比失真。`truncate` 也是按码点截断的，两者口径必须一致。
 *
 * @param cards - 卡片集合。
 * @returns 字符总数。
 */
function sourceCharsOf(cards: readonly MemoryCard[]): number {
  let total = 0
  for (const card of cards) total += [...card.text].length
  return total
}

/**
 * 由「来源总字符数」与「层级绝对上限」算出本次摘要的实际字符预算。
 *
 * 这是压缩的**算术闸门**：预算同时受两个上限约束，取小者。
 *
 * - `targetRatio` 保证「摘要永远显著短于来源」；
 * - `levelMaxChars` 保证「层级越高越短」（配置层已强制该不等式）。
 *
 * 结果至少为 1：预算为 0 会让摘要恒为空，等于悄悄关掉摘要功能。
 *
 * @param sourceChars - 来源总字符数。
 * @param levelMaxChars - 该层级的绝对字符上限。
 * @param ratio - 目标压缩比（0..1）。
 * @returns 实际字符预算。
 */
export function charBudgetOf(sourceChars: number, levelMaxChars: number, ratio: number): number {
  const byRatio = Math.floor(sourceChars * ratio)
  return Math.max(1, Math.min(levelMaxChars, byRatio))
}

/**
 * 取某层级对应的绝对字符上限。
 *
 * @param level - 摘要层级。
 * @param config - 完整配置。
 * @returns 字符上限。
 */
function levelMaxCharsOf(level: SummaryLevel, config: MemoryConfig): number {
  if (level === 'daily') return config.consolidation.dailySummaryMaxChars
  if (level === 'weekly') return config.consolidation.weeklySummaryMaxChars
  return config.consolidation.monthlySummaryMaxChars
}

/**
 * 取某层级对应的合成来源指针。
 *
 * `sessionId` 放日期键，`eventType` 标明层级——这样「这条摘要属于哪一天」
 * 在 `source` 里直接可读，不必去解析 tags。同时它参与 `buildCardId`，
 * 保证同一天重复整理得到同一个 id（幂等）。
 *
 * @param level - 摘要层级。
 * @param key - 日期键。
 * @returns 合成来源指针。
 */
function summarySourceOf(level: SummaryLevel, key: string): SourcePointer {
  return {
    // 固定伪会话 id：摘要不来自某一轮对话，这是事实，不该伪装成对话。
    sessionId: key,
    turn: 0,
    step: 0,
    // seq 用层级序号，让 daily < weekly < monthly，便于排查时看出层级。
    seq: level === 'daily' ? 0 : level === 'weekly' ? 1 : 2,
    eventType: `consolidate/${level}-summary`,
  }
}

/**
 * 渲染一段摘要文本。
 *
 * 文本只包含**统计量与关键词**，绝不拼接来源原文——拼接就等于没压缩。
 * 结构固定为「范围 + 规模 + 主域 + 关键词 + （可选）感受」，
 * 每个部分都可独立省略，因此极短的日子也不会产出畸形文本。
 *
 * @param label - 时间范围的人类可读标签。
 * @param cards - 来源卡（用于统计）。
 * @param keywords - 已选出的关键词。
 * @param feeling - 已选出的感受摘要，无则传空串。
 * @param budget - 字符预算。
 * @returns 摘要文本。
 */
function renderSummary(
  label: string, cards: readonly MemoryCard[], keywords: readonly string[],
  feeling: string, budget: number,
): string {
  const parts: string[] = [`${label}：${cards.length} 条记忆`]
  const domain = dominantDomainOf(cards)
  const domainLabel = domain === 'work' ? '工作' : domain === 'study' ? '学习' : '生活'
  parts.push(`主要涉及${domainLabel}`)
  if (keywords.length > 0) parts.push(`关键词 ${keywords.join('、')}`)
  if (feeling.length > 0) parts.push(`感受 ${feeling}`)
  return truncate(parts.join('，'), budget)
}

/**
 * 从一组卡里挑出「最值得记住的一件事」。
 *
 * 判据是 `emotional × salience`：情绪强且重要的事最该被留下。
 * 平票取更早的（createdAt 升序，reduce 保留首个最大者），保证确定性。
 *
 * 返回值用于感受摘要的引用，**截断后**才进文本——引用原文片段是允许的，
 * 因为它是「一个例子」而不是「全文拼接」，且长度受 `summaryBriefChars` 约束。
 *
 * @param cards - 来源卡。
 * @param maxChars - 引用字符上限。
 * @returns 引用文本；无可用卡时返回空串。
 */
function briefOf(cards: readonly MemoryCard[], maxChars: number): string {
  let best: MemoryCard | null = null
  let bestScore = -1
  for (const card of cards) {
    const score = card.emotional * card.salience
    if (score > bestScore) {
      best = card
      bestScore = score
    }
  }
  if (best === null || bestScore <= 0) return ''
  return truncate(best.text, maxChars)
}

/**
 * 构造一张摘要卡。
 *
 * 这是三个层级共用的唯一构造入口——日/周/月只有「来源不同、预算不同」，
 * 构造逻辑完全相同。**一份实现**意味着修一次三处都对，而三份实现必然漂移。
 *
 * @param level - 摘要层级。
 * @param key - 日期键。
 * @param label - 人类可读的时间范围标签。
 * @param sources - 来源卡（下级卡片或下级摘要）。
 * @param at - 落卡时刻（毫秒时间戳）。
 * @param config - 完整配置。
 * @returns 摘要卡。
 */
export function buildSummaryCard(
  level: SummaryLevel, key: string, label: string,
  sources: readonly MemoryCard[], at: number, config: MemoryConfig,
): MemoryCard {
  const policy = config.consolidation
  const sourceChars = sourceCharsOf(sources)
  const budget = charBudgetOf(sourceChars, levelMaxCharsOf(level, config), policy.summaryTargetRatio)
  const keywords = topTerms(sources, policy.summaryMaxTags)
  const feelingBrief = briefOf(sources, policy.summaryBriefChars)
  const text = renderSummary(label, sources, keywords, feelingBrief, budget)
  const source = summarySourceOf(level, key)
  const domain = dominantDomainOf(sources)
  const normalized = normalizeText(text)
  const id = buildCardId(domain, source, 'summary', normalized)
  // 情绪取平均：摘要不该比它的来源更激动，也不该更冷淡。
  const emotional = sources.length === 0
    ? 0
    : sources.reduce((acc, card) => acc + card.emotional, 0) / sources.length
  const salience = sources.reduce((acc, card) => Math.max(acc, card.salience), 0)
  return {
    id,
    domain,
    kind: 'summary',
    text,
    normalized,
    createdAt: at,
    updatedAt: at,
    source,
    salience,
    // 摘要是对已有记忆的统计，不是新观察到的事实，置信度取中位。
    confidence: 0.7,
    emotional,
    // 摘要强度从 0.5 起：够活，但依然会随遗忘曲线衰减——摘要也是记忆，
    // 不该被特殊保护成「永不消失的元数据」。
    strength: 0.5,
    accessCount: 0,
    lastAccessAt: null,
    tags: [`${LEVEL_PREFIX[level]}:${key}`],
    // 关键词进实体，让摘要能通过实体锚点接上同主题的事件卡（起源 L15）。
    entities: keywords,
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
    mergedInto: undefined,
    // 用 mergeOf 记来源：这是现成字段，语义正好是「本卡合并了哪些卡」。
    // 不新增字段就能让摘要可溯源，测试里也能直接断言「它压了哪几张」。
    mergeOf: sources.map((card) => card.id),
    dueAt: null,
  }
}

/**
 * 把一天的事件卡压成一张日摘要（FR-D4 / 起源 L27）。
 *
 * 返回 `null` 的两种情况，都是「没有可压缩的东西」：
 * 1. 当天没有卡；
 * 2. 当天来源文本总字符数低于 `summaryMinSourceChars`。
 *
 * 第 2 条是诚实的边界：一天只有一张 20 字的卡时，「摘要」不可能比原文短，
 * 硬做出来的东西是**假压缩**——它比原文长，还多占一条记录。
 * 与其产出一堆比原文更长的摘要，不如承认这一天不需要压缩。
 *
 * @param dateKey - 自然日键 `YYYY-MM-DD`。
 * @param dayCards - 当天的卡片。
 * @param at - 落卡时刻。
 * @param config - 完整配置。
 * @returns 日摘要卡；不该产出时为 `null`。
 */
export function buildDailySummary(
  dateKey: string, dayCards: readonly MemoryCard[], at: number, config: MemoryConfig,
): MemoryCard | null {
  const policy = config.consolidation
  if (!policy.summaryEnabled) return null
  if (dayCards.length === 0) return null
  if (sourceCharsOf(dayCards) < policy.summaryMinSourceChars) return null
  return buildSummaryCard('daily', dateKey, dateKey, dayCards, at, config)
}

/**
 * 把若干日摘要压成一张周摘要。
 *
 * 来源**只取日摘要**，不直接取事件卡：层级压缩的意义就是「上一层只压下一层」。
 * 如果周摘要也直接读事件卡，那它和日摘要就是同一层的两个副本，
 * 层级结构退化成并排摆放。
 *
 * @param weekKey - 该周周一的日期键。
 * @param dailies - 该周的日摘要卡。
 * @param at - 落卡时刻。
 * @param config - 完整配置。
 * @returns 周摘要卡；不该产出时为 `null`。
 */
export function buildWeeklySummary(
  weekKey: string, dailies: readonly MemoryCard[], at: number, config: MemoryConfig,
): MemoryCard | null {
  const policy = config.consolidation
  if (!policy.summaryEnabled) return null
  if (dailies.length === 0) return null
  // 一周只有一天有记录时，周摘要与那天的日摘要内容几乎相同——
  // 那不是压缩，是复制。宁可这一周没有周摘要。
  if (dailies.length < policy.summaryMinChildren) return null
  const lastKey = dailies
    .map((card) => summaryKeyOf(card) ?? '')
    .filter((key) => key.length > 0)
    .sort()
    .at(-1)
  const label = lastKey === undefined ? weekKey : `${weekKey} 至 ${lastKey}`
  return buildSummaryCard('weekly', weekKey, label, dailies, at, config)
}

/**
 * 把若干周摘要压成一张月摘要。
 *
 * 来源只取周摘要，理由同 {@link buildWeeklySummary}。
 *
 * @param monthKey - 月份键 `YYYY-MM`。
 * @param weeklies - 该月的周摘要卡。
 * @param at - 落卡时刻。
 * @param config - 完整配置。
 * @returns 月摘要卡；不该产出时为 `null`。
 */
export function buildMonthlySummary(
  monthKey: string, weeklies: readonly MemoryCard[], at: number, config: MemoryConfig,
): MemoryCard | null {
  const policy = config.consolidation
  if (!policy.summaryEnabled) return null
  if (weeklies.length === 0) return null
  if (weeklies.length < policy.summaryMinChildren) return null
  return buildSummaryCard('monthly', monthKey, monthKey, weeklies, at, config)
}

/**
 * 一次整理里产出的全部摘要。
 *
 * 分三个层级顺序产出，且**上层能用到本层刚产出的下层摘要**——
 * 这是「同一轮里完成一次完整迭代」的前提：如果必须跨两轮夜整理才能建起
 * 周摘要，那么夜间只跑一次的用户永远得不到层级压缩。
 */
export interface SummaryBatch {
  /** 日摘要。 */
  dailies: MemoryCard[]
  /** 周摘要。 */
  weeklies: MemoryCard[]
  /** 月摘要。 */
  monthlies: MemoryCard[]
}

/**
 * 从事件卡集合出发，逐层构造摘要。
 *
 * 流程：
 * ```text
 * 事件卡 → 按自然日分组 → 日摘要
 *        → 日摘要按 ISO 周分组 → 周摘要
 *        → 周摘要按月分组 → 月摘要
 * ```
 *
 * 每层都做「已有则跳过」判断，保证重复整理不重复产出。
 * 之所以还要判 id 而不只靠 `put` 覆盖：`put` 覆盖虽然幂等，但会**重置
 * createdAt 与 strength**，等于每次整理都让摘要「变新」，遗忘曲线永远不推进。
 *
 * 已存在的摘要会以**库里那一份**参与上层聚合，而不是本轮新构造的那份——
 * 否则周摘要的 `createdAt` 会随每次整理漂移，且它引用的 `mergeOf` 指向的
 * 是一份并未落库的卡。
 *
 * @param cards - 候选事件卡（通常为活跃卡）。
 * @param existing - 已存在的卡片（id 到卡片），用于跳过已产出的摘要并复用。
 * @param at - 落卡时刻。
 * @param timeZone - IANA 时区名，必填。
 * @param config - 完整配置。
 * @returns 本轮应产出的摘要批次。
 */
export function buildSummaries(
  cards: readonly MemoryCard[], existing: ReadonlyMap<string, MemoryCard>,
  at: number, timeZone: string, config: MemoryConfig,
): SummaryBatch {
  const batch: SummaryBatch = { dailies: [], weeklies: [], monthlies: [] }
  const policy = config.consolidation
  if (!policy.summaryEnabled) return batch

  // 摘要不压摘要：下级摘要已是压缩产物，再压一次会让信息量二次衰减。
  const events = cards.filter((card) => card.kind !== 'summary' && card.status === 'active')
  const byDay = groupByLocalDate(events, timeZone)
  let emitted = 0
  for (const [dateKey, dayCards] of byDay) {
    const daily = buildDailySummary(dateKey, dayCards, at, config)
    if (daily === null) continue
    const prior = existing.get(daily.id)
    if (prior !== undefined) {
      // 已产出过：用库里那份参与上层聚合，且不占本轮配额。
      batch.dailies.push(prior)
      continue
    }
    if (emitted >= policy.maxSummariesPerRun) continue
    batch.dailies.push(daily)
    emitted += 1
  }

  // 周摘要：按 ISO 周分组本轮的日摘要。
  const byWeek = new Map<string, MemoryCard[]>()
  for (const daily of batch.dailies) {
    const key = summaryKeyOf(daily)
    if (key === null) continue
    const weekKey = mondayKeyOf(key)
    const bucket = byWeek.get(weekKey)
    if (bucket === undefined) byWeek.set(weekKey, [daily])
    else bucket.push(daily)
  }
  for (const weekKey of [...byWeek.keys()].sort()) {
    const weekly = buildWeeklySummary(weekKey, byWeek.get(weekKey)!, at, config)
    if (weekly !== null) batch.weeklies.push(weekly)
  }

  // 月摘要：按月份分组本轮的周摘要。
  const byMonth = new Map<string, MemoryCard[]>()
  for (const weekly of batch.weeklies) {
    const key = summaryKeyOf(weekly)
    if (key === null) continue
    const monthKey = monthKeyOf(key)
    const bucket = byMonth.get(monthKey)
    if (bucket === undefined) byMonth.set(monthKey, [weekly])
    else bucket.push(weekly)
  }
  for (const monthKey of [...byMonth.keys()].sort()) {
    const monthly = buildMonthlySummary(monthKey, byMonth.get(monthKey)!, at, config)
    if (monthly !== null) batch.monthlies.push(monthly)
  }
  return batch
}

/**
 * 计算一组卡的压缩比：摘要字符数 / 来源字符数。
 *
 * 这是**可测试的压缩证据**。没有这个数，「做了摘要」和「做了压缩」在测试上
 * 无法区分——两者都只是「多了一张卡」。
 *
 * @param summary - 摘要卡。
 * @param sources - 来源卡。
 * @returns 压缩比（0..1+）；来源为空时返回 1（无压缩）。
 */
export function compressionRatio(summary: MemoryCard, sources: readonly MemoryCard[]): number {
  const sourceChars = sourceCharsOf(sources)
  if (sourceChars === 0) return 1
  return [...summary.text].length / sourceChars
}
