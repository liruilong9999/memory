/**
 * 感受蒸馏（Feeling Distillation）：从一堆事件卡里提炼出「感受卡」。
 *
 * ## 起源依据
 *
 * 起源 L11（无编号·细节会忘）：「其实我们大多数细节都会忘记，只会留下感受。」
 * 起源 L19（无编号·感受经验）：「那么如何出现感受和经验的写入和回忆呢？」
 *
 * 这两句是本文件存在的全部理由。没有蒸馏，系统只有「记住细节」这一半能力，
 * 细节一旦衰减，留下的就只有空白——而起源说的是「留下的应该是感受」。
 *
 * ## 必须先说清的局限（不要美化它）
 *
 * **本文件是规则版，不是真的在「理解」感受。** 它做的事是：
 *
 * 1. 用情绪词密度（`computeEmotional`）筛出「有情绪的事件」；
 * 2. 用主题共现统计（同一个词项反复出现在有情绪的卡里）找「反复经历的处境」；
 * 3. 把两者的交集按模板拼成一段可读的中文。
 *
 * 它**做不到**的事，写在这里防止后人误信：
 *
 * - 它不知道「被领导夸」和「被领导骂」在情绪上相反——`computeEmotional` 只算
 *   **强度**不算**极性**（valence），所以它产出的感受是「这件事让我情绪起伏大」，
 *   而不是「这件事让我开心」。产出文本刻意写成「X 让我反复情绪起伏」而非
 *   「我对 X 感到难过」，因为后者是它给不出的判断。
 * - 它不做因果推断。主题共现是**相关性**，不是「因为 A 所以 B」。
 * - 它不会随时间改变「对同一件事的看法」，那需要跨周期的态度漂移建模。
 *
 * 之所以仍然要做，是因为**规则版感受远好于没有感受**：它至少把「哪些处境反复
 * 牵动过我」这一层留了下来，让细节衰减后仍有东西可回忆。但请在任何文档与
 * 汇报里称它为「规则版感受蒸馏」，不要称它「理解了用户情绪」。
 *
 * ## 为什么在 core/
 *
 * 全部纯函数、无 IO、无时钟依赖（时间由入参给），符合 ST-1 确定性验收。
 * 边构造复用 `core/graph.ts` 的 {@link distillEdges}，不在这里另写一份。
 *
 * @module dsh-memory/core/distill
 */

import type { MemoryCard, MemoryDomain, MemoryKind, SourcePointer } from './types.ts'
import { buildCardId } from './types.ts'
import type { MemoryConfig } from './config.ts'
import { normalizeText, truncate } from './text.ts'

/**
 * 一条蒸馏出来的感受，尚未落成卡片。
 *
 * 保留 `theme` / `sources` / `emotional` 等字段而不是直接给 `MemoryCard`，
 * 是为了让调用方（以及测试）能看清「这条感受是从哪几张卡、因为什么被提炼出来的」。
 * 感受如果不可解释，它就只是噪声。
 */
export interface FeelingDraft {
  /** 主题词：反复牵动情绪的那个处境的代表词项。 */
  theme: string
  /** 可读的感受文本。 */
  text: string
  /** 归一化文本，用于派生 id 与建索引。 */
  normalized: string
  /** 支撑这条感受的来源事件卡 id，按 `createdAt` 升序。 */
  sourceIds: string[]
  /** 来源卡的平均情绪强度。 */
  emotional: number
  /** 来源卡数量，即这个处境被经历了几次。 */
  recurrence: number
  /** 所属记忆域：取来源卡里出现最多的域。 */
  domain: MemoryDomain
}

/** 蒸馏的中间产物：一个候选主题及其证据。 */
interface ThemeBucket {
  /** 主题词项。 */
  theme: string
  /** 命中的卡片，按 `createdAt` 升序。 */
  cards: MemoryCard[]
  /** 平均情绪强度。 */
  emotional: number
}

/**
 * 判断一张卡是否「有情绪」。
 *
 * 判据只有一条：`emotional` 达到 `config.consolidation.distillMinEmotional`。
 * 刻意不用 `kind === 'feeling'`——那会让蒸馏只能从已有的感受卡里再造感受，
 * 而起源 L11 要的恰恰是**从事件里长出感受**。
 *
 * @param card - 记忆卡。
 * @param config - 完整配置。
 * @returns 是否够格参与蒸馏。
 */
export function hasFeelingSignal(card: MemoryCard, config: MemoryConfig): boolean {
  if (card.status !== 'active') return false
  if (card.mergedInto !== undefined) return false
  // 感受卡本身不参与再蒸馏，否则会形成「感受生感受」的自激循环，
  // 几轮之后主题词就只剩感受卡自己的措辞，与真实经历脱钩。
  if (card.kind === 'feeling') return false
  return card.emotional >= config.consolidation.distillMinEmotional
}

/**
 * 取一张卡的主题词项集合。
 *
 * 优先用 `entities`（专名、代码标识符等，最能代表「哪件事」）；
 * 没有实体时退回 `normalized` 的词项，但**去掉过短的词项**——
 * 单字二元组（如「今天」的「今天」）共现率太高，几乎每张卡都有，
 * 拿它当主题等于没有主题。
 *
 * @param card - 记忆卡。
 * @param minChars - 词项最小字符数。
 * @returns 主题词项集合。
 */
function themeTerms(card: MemoryCard, minChars: number): Set<string> {
  const terms = new Set<string>()
  for (const entity of card.entities) {
    const key = normalizeText(entity)
    if (key.length >= minChars) terms.add(key)
  }
  if (terms.size > 0) return terms
  for (const token of card.normalized.split(' ')) {
    if (token.length >= minChars) terms.add(token)
  }
  return terms
}

/**
 * 把「有情绪的卡」按主题聚成桶。
 *
 * 这是整个蒸馏的统计核心：**同一个词项出现在多张有情绪的卡里**，
 * 就说明这个处境反复牵动过情绪。出现次数（recurrence）就是「反复」的度量。
 *
 * 桶按三个键排序，保证结果完全确定（ST-1）：
 * 平均情绪降序 → 出现次数降序 → 主题词升序。
 *
 * @param cards - 候选卡集合。
 * @param config - 完整配置。
 * @returns 排序后的主题桶。
 */
export function bucketByTheme(cards: readonly MemoryCard[], config: MemoryConfig): ThemeBucket[] {
  const minChars = config.consolidation.distillThemeMinChars
  const buckets = new Map<string, ThemeBucket>()
  for (const card of cards) {
    for (const term of themeTerms(card, minChars)) {
      const existing = buckets.get(term)
      if (existing === undefined) {
        buckets.set(term, { theme: term, cards: [card], emotional: card.emotional })
        continue
      }
      // 同一张卡可能贡献多个词项，但同一词项只该收这张卡一次。
      if (existing.cards.includes(card)) continue
      existing.cards.push(card)
    }
  }
  const result: ThemeBucket[] = []
  for (const bucket of buckets.values()) {
    // 出现次数不足的处境谈不上「反复」，直接丢弃。
    if (bucket.cards.length < config.consolidation.distillMinRecurrence) continue
    bucket.cards.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const sum = bucket.cards.reduce((acc, card) => acc + card.emotional, 0)
    bucket.emotional = sum / bucket.cards.length
    result.push(bucket)
  }
  result.sort((a, b) => b.emotional - a.emotional
    || b.cards.length - a.cards.length
    || a.theme.localeCompare(b.theme))
  return result
}

/**
 * 取来源卡里出现最多的记忆域。
 *
 * 平票时按 `MEMORY_DOMAINS` 的固定顺序取第一个，保证确定性。
 *
 * @param cards - 来源卡。
 * @param order - 域的全集与优先顺序。
 * @returns 代表域。
 */
function dominantDomain(cards: readonly MemoryCard[], order: readonly MemoryDomain[]): MemoryDomain {
  const counts = new Map<MemoryDomain, number>()
  for (const card of cards) counts.set(card.domain, (counts.get(card.domain) ?? 0) + 1)
  let best = order[0] ?? 'work'
  let bestCount = -1
  for (const domain of order) {
    const count = counts.get(domain) ?? 0
    if (count > bestCount) {
      best = domain
      bestCount = count
    }
  }
  return best
}

/**
 * 把主题桶渲染成一句可读的感受。
 *
 * 措辞刻意保守：写「反复情绪起伏」而不写「开心 / 难过」，因为
 * {@link hasFeelingSignal} 用的 `emotional` 只度量强度、不度量极性。
 * 写一个它判断不出的情绪名，就是让文本撒谎。
 *
 * **不引用来源原文**：早期版本在末尾拼了「其中一次：<原文>」，结果原文里的
 * 「特别开心」被读者当成了系统的情绪判断——模板说「不知道极性」，例子却
 * 明示了极性，等于让引用替实现表态。现在只报「最强那次的主题词」，
 * 不复述原句。
 *
 * @param bucket - 主题桶。
 * @param config - 完整配置。
 * @returns 感受文本。
 */
function renderFeeling(bucket: ThemeBucket, config: MemoryConfig): string {
  const times = bucket.cards.length
  // 「强度」而非「开心/难过」：只报它真的能测到的量。
  const intensity = bucket.emotional >= 0.7 ? '很强' : bucket.emotional >= 0.4 ? '明显' : '轻微'
  const base = `「${bucket.theme}」这件事反复牵动我的情绪，前后经历了 ${times} 次，每次感受都${intensity}`
  return truncate(base, config.consolidation.distillMaxChars)
}

/**
 * 从事件卡里蒸馏出感受草稿。
 *
 * 流程：
 * ```text
 * 筛有情绪的卡 → 按主题聚桶 → 过滤出现次数不足 → 排序取前 N → 渲染成草稿
 * ```
 *
 * 返回的是草稿而非卡片：落卡需要派生 id、写来源指针，那是调用方（巩固面）的事。
 * 这样本函数保持纯函数，测试里可以直接断言「为什么提炼出这条感受」。
 *
 * @param cards - 候选卡集合（通常是某一天的活跃卡）。
 * @param config - 完整配置。
 * @returns 感受草稿数组，按情绪强度降序。
 */
export function distillFeelings(cards: readonly MemoryCard[], config: MemoryConfig): FeelingDraft[] {
  if (!config.consolidation.distillEnabled) return []
  const policy = config.consolidation
  const candidates = cards.filter((card) => hasFeelingSignal(card, config))
  if (candidates.length < policy.distillMinRecurrence) return []
  const buckets = bucketByTheme(candidates, config)
  const drafts: FeelingDraft[] = []
  for (const bucket of buckets) {
    if (drafts.length >= policy.distillMaxPerRun) break
    const text = renderFeeling(bucket, config)
    drafts.push({
      theme: bucket.theme,
      text,
      normalized: normalizeText(text),
      sourceIds: bucket.cards.map((card) => card.id),
      emotional: bucket.emotional,
      recurrence: bucket.cards.length,
      domain: dominantDomain(bucket.cards, config.extraction.domains),
    })
  }
  return drafts
}

/**
 * 为感受草稿派生一个**稳定**的来源指针。
 *
 * 为什么不能沿用来源卡的 `source`：一张感受由多张卡提炼而来，没有单一出处。
 * 但 `MemoryCard.source` 是必填字段，且它参与 id 派生——所以这里造一个
 * 「合成来源」：`sessionId` 固定为 `distill`，`seq` 取来源卡的最小 `seq`。
 *
 * 关键在于**确定性**：同一批来源卡无论何时蒸馏，都得到同一个指针、同一个 id。
 * 这是幂等的前提——夜整理重复跑不会堆出重复的感受卡。
 *
 * @param draft - 感受草稿。
 * @param sources - 来源卡（用于取最小 seq 与会话 id）。
 * @returns 合成来源指针。
 */
export function distillSource(draft: FeelingDraft, sources: readonly MemoryCard[]): SourcePointer {
  const ordered = [...sources].sort((a, b) => a.source.seq - b.source.seq)
  const first = ordered[0]
  return {
    // 固定的伪会话 id：让「这条记忆不是来自某一轮对话」在数据层面可见，
    // 而不是伪装成某轮对话里的原话。
    sessionId: 'distill',
    turn: 0,
    step: 0,
    seq: first?.source.seq ?? 0,
    // 事件类型标明它是派生数据，排查时可据此区分「原话」与「提炼」。
    eventType: 'consolidate/feeling',
  }
}

/**
 * 把感受草稿落成完整的记忆卡。
 *
 * 强度刻意由情绪与出现次数共同决定：反复出现且情绪强烈的感受更牢固。
 * `pinned` 保持 `false`——`feeling` 已在 `neverArchiveKinds` 里受保护，
 * 再钉住会让它连「用户手动归档」都挡掉，那是过度保护。
 *
 * @param draft - 感受草稿。
 * @param sources - 来源卡。
 * @param at - 落卡时刻（毫秒时间戳）。
 * @param config - 完整配置。
 * @returns 完整记忆卡。
 */
export function feelingToCard(
  draft: FeelingDraft, sources: readonly MemoryCard[], at: number, config: MemoryConfig,
): MemoryCard {
  const source = distillSource(draft, sources)
  const kind: MemoryKind = 'feeling'
  const id = buildCardId(draft.domain, source, kind, draft.normalized)
  // 反复出现的处境更牢固：出现 2 次即满额的一半，出现 4 次及以上接近满额。
  const recurrenceBoost = Math.min(1, draft.recurrence / 4)
  const strength = Math.min(1, draft.emotional * 0.6 + recurrenceBoost * 0.3 + 0.1)
  return {
    id,
    domain: draft.domain,
    kind,
    text: draft.text,
    normalized: draft.normalized,
    createdAt: at,
    updatedAt: at,
    source,
    salience: Math.min(1, draft.emotional * 0.5 + 0.4),
    confidence: 0.6,
    emotional: draft.emotional,
    strength,
    accessCount: 0,
    lastAccessAt: null,
    // 主题词进标签与实体，让它能被检索到——感受如果检索不到，等于没留下。
    tags: [draft.theme],
    entities: [draft.theme],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
    mergedInto: undefined,
    mergeOf: undefined,
    dueAt: null,
  }
}
