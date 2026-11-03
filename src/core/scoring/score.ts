/**
 * 单卡打分：查询上下文、各分项与总分合成。
 *
 * 从 `src/core/scoring.ts` 拆出：本文件只负责「一张卡值多少分」，
 * 不涉及阈值截断（见 `pack.ts`）、扩散合并（见 `spread.ts`）、渲染（见 `render.ts`）。
 *
 * @module dsh-memory/core/scoring/score
 */

import type { MemoryConfig } from '../config.ts'
import { coverage, tokenSet } from '../text.ts'
import type { MemoryCard, ScoreBreakdown, ScoredCard } from '../types.ts'
import { buildExplain } from './render.ts'

/**
 * 一次查询的上下文：决定「此刻在找什么」。
 *
 * 显式建模而不是塞一堆参数，是因为 FR-B4 要求可解释：
 * 每条卡的解释行要能说清「因为和 query 的哪个部分匹配」。
 */
export interface RecallQuery {
  /** 查询原文，通常是用户最新一条消息。 */
  text: string
  /** 查询词项集合，预计算避免每条卡重复分词。 */
  tokens: ReadonlySet<string>
  /** 当前聚焦的记忆域；为空表示不限域。 */
  domains: readonly string[]
  /** 目标词项（来自当前任务/会话目标），用于「目标匹配」分项。 */
  goalTokens: ReadonlySet<string>
  /** 期望召回的时间点，通常是 now。 */
  now: number
}

/**
 * 构造查询上下文。
 *
 * @param text - 查询原文。
 * @param config - 配置，提供域列表。
 * @param now - 当前时刻（毫秒）。
 * @param goalText - 当前目标文本，可选。
 * @returns 查询上下文。
 */
export function makeQuery(
  text: string, config: MemoryConfig, now: number, goalText = '',
): RecallQuery {
  return {
    text,
    tokens: tokenSet(text),
    domains: config.extraction.domains,
    goalTokens: tokenSet(goalText),
    now,
  }
}

/**
 * 计算时间新鲜度。
 *
 * 需求 FR-D2：时间项必须由代码用 Δt 算出，不能交给模型推断。
 * 用指数衰减：Δt = 0 时为 1，Δt = 半衰期时为约 0.5，之后平滑趋零。
 *
 * @param ageMs - 距今毫秒数（≥0）。
 * @param halfLifeMs - 半衰期毫秒数。
 * @returns 0..1 的新鲜度。
 */
export function recencyScore(ageMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return 0
  if (ageMs <= 0) return 1
  // 2^(-Δt/半衰期)，与衰减面用同一个函数族，保证「打分的新鲜度」与「存活的强度」语义一致。
  return Math.pow(2, -ageMs / halfLifeMs)
}

/**
 * 计算重要性。
 *
 * 三项合成：写入时的显著性、情绪强度（起源「留下的只有感受」）、
 * 被反复召回的次数（用过的记忆更重要）。
 *
 * @param card - 记忆卡。
 * @returns 0..1 的重要性。
 */
export function importanceScore(card: MemoryCard): number {
  // 访问次数用对数压缩，避免高频卡碾压一切。
  const accessBoost = Math.min(1, Math.log1p(card.accessCount) / Math.log1p(12))
  const raw = card.salience * 0.55 + card.emotional * 0.25 + accessBoost * 0.20
  return clamp01(raw)
}

/**
 * 计算目标匹配度。
 *
 * 起源 L29（第 5 条）的「专注机制」：与当前目标相关的记忆才该被想起。
 * 卡片标签/实体/文本与目标词项的重合度即匹配度。
 *
 * @param card - 记忆卡。
 * @param goalTokens - 目标词项集合。
 * @returns 0..1 的匹配度。
 */
export function goalScore(card: MemoryCard, goalTokens: ReadonlySet<string>): number {
  if (goalTokens.size === 0) return 0
  const cardTokens = tokenSet(`${card.text} ${card.tags.join(' ')} ${card.entities.join(' ')}`)
  return clamp01(coverage(goalTokens, cardTokens))
}

/**
 * 计算语义相关度。
 *
 * 三路信号加权：
 * 1. 文本覆盖率（主）——查询词被卡片覆盖的比例
 * 2. 标签精确命中——标签是人工/规则提炼的高置信信号
 * 3. 实体精确命中——实体是图谱的连接点，命中意味着强关联
 *
 * @param card - 记忆卡。
 * @param query - 查询上下文。
 * @returns 0..1 的相关度。
 */
export function semanticScore(card: MemoryCard, query: RecallQuery): number {
  if (query.tokens.size === 0) return 0
  const cardTokens = tokenSet(`${card.text} ${card.tags.join(' ')} ${card.entities.join(' ')}`)
  const textCoverage = coverage(query.tokens, cardTokens)

  let tagHits = 0
  for (const tag of card.tags) {
    if (query.tokens.has(tag.toLowerCase())) tagHits += 1
  }
  const tagScore = card.tags.length === 0 ? 0 : Math.min(1, tagHits / card.tags.length)

  let entityHits = 0
  for (const entity of card.entities) {
    // 实体可能很长（路径），用包含判断而不是等值，避免切词把路径打散。
    for (const token of query.tokens) {
      if (entity.toLowerCase().includes(token)) {
        entityHits += 1
        break
      }
    }
  }
  const entityScore = card.entities.length === 0 ? 0 : Math.min(1, entityHits / card.entities.length)

  // 文本是主体，标签与实体是增强项；三者相加上限 1。
  return clamp01(textCoverage * 0.72 + tagScore * 0.14 + entityScore * 0.14)
}

/**
 * 计算冲突惩罚。
 *
 * 需求 FR-B5：冲突不隐藏，但要降权——两条互相矛盾的记忆同时高分会让模型无所适从。
 * 做法是「冲突双方各扣一点」，让它们在焦点包里都出现（可对照），但排在确定事实之后。
 *
 * @param card - 记忆卡。
 * @returns 0..1 的惩罚值，0 表示无冲突。
 */
export function conflictPenalty(card: MemoryCard): number {
  if (card.conflictOf.length === 0) return 0
  // 冲突数越多惩罚越重，但封顶，避免一条卡因多处冲突被彻底埋掉。
  return clamp01(Math.min(1, card.conflictOf.length / 3))
}

/**
 * 给单张卡打分。
 *
 * 总分计算流程：
 * ```text
 * 正向分 = 语义×w1 + 重要性×w2 + 新鲜度×w3 + 目标×w4 + 置信×w5
 * 归一化 = 正向分 / (w1+w2+w3+w4+w5)
 * 总分   = 归一化 − 冲突惩罚×w冲突
 * ```
 * 归一化保证总分落在 0..1，让绝对阈值可解释、可调（FR-B2）。
 *
 * @param card - 记忆卡。
 * @param query - 查询上下文。
 * @param config - 配置，提供权重与半衰期。
 * @returns 带分数构成的已打分卡。
 */
export function scoreCard(card: MemoryCard, query: RecallQuery, config: MemoryConfig): ScoredCard {
  const semantic = semanticScore(card, query)
  const importance = importanceScore(card)
  const ageMs = Math.max(0, query.now - card.createdAt)
  const recency = recencyScore(ageMs, effectiveHalfLife(card, config))
  const confidence = clamp01(card.confidence)

  // 目标维度：没提供目标时**贡献 0，但权重仍留在分母里**。
  //
  // 这里曾经写反过，记下来免得后人再改回去：
  // 我最初的做法是「没目标就把 `w.goal` 从分母里摘掉」，理由是「不知道不该算 0 分」。
  // 归一化分因此整体上浮 1/0.9 ≈ 11%，一张 100 个半衰期、语义相关为 0 的死卡
  // 从 0.168 抬到 0.187，越过了 `absoluteThreshold: 0.18`——测试当场抓到。
  //
  // 真正的问题是「上浮」这件事本身：`goalText` 为空曾经是一个**宿主侧 bug**
  // （`src/index.ts` 只传了 queryText）。按摘分母的写法，这个 bug 会让每张卡的
  // 分数都涨 11%、更容易进焦点包——**缺陷反而让召回看起来更好**。
  // 这是最坏的一类失败：输入缺失被当成优势，没人会去修它。
  //
  // 所以取「缺失即中性」：目标没给，这一维贡献 0，分母基准不动。
  // 分数与阈值刻度的历史语义因此完全不变（FR-B2 的绝对阈值是拿这把尺子量的）。
  // 代价是：`weights.goal` 配得越大，缺目标时整体越难达标。这个代价是可接受的，
  // 因为它把压力加在「宿主该给而没给」上，而不是加在「记忆内容好不好」上。
  // 目标维度是否参与，只在 explain 里如实标注，不改数值（FR-B4）。
  const goalApplied = query.goalTokens.size > 0
  const goal = goalApplied ? goalScore(card, query.goalTokens) : 0

  const rawPenalty = conflictPenalty(card)
  const w = config.weights
  // 分母恒为「全部维度权重之和」，不随查询条件变化。
  const positiveWeight = w.semantic + w.importance + w.recency + w.goal + w.confidence
  const positive = semantic * w.semantic
    + importance * w.importance
    + recency * w.recency
    + goal * w.goal
    + confidence * w.confidence
  const normalized = positiveWeight > 0 ? positive / positiveWeight : 0

  // 相关分量：只由**与查询有关**的维度合成（semantic + goal），供闸门使用。
  // 详见 `ScoreBreakdown.relevance` 的注释：total 上不存在能分开相关/无关的阈值。
  const relevantWeight = w.semantic + w.goal
  const relevance = relevantWeight > 0
    ? clamp01((semantic * w.semantic + goal * w.goal) / relevantWeight)
    : 0

  // 冲突惩罚**不再按 absoluteThreshold 封顶**，直接扣总分。
  //
  // 原来的封顶写法是 `penalty ≤ (normalized − absoluteThreshold) / w.conflict`，
  // 目的是让冲突「只降权、不淘汰」（FR-B5）。它确实做到了，但代价是：
  //
  // 1. 任何带冲突且冲突够重的卡，`total` 被**精确钳在 `absoluteThreshold` 上**。
  //    实测 10 张卡总分完全相同（0.180000000），封顶前它们分布在
  //    0.3457~0.3767，那 0.0310 的分辨力被整个丢弃。排序退化成按 `id`
  //    （内容哈希）——与相关性无关。
  // 2. 语义分 0.180 的卡与语义分 0.000 的卡拿到**完全相同**的总分。
  //    封顶注释里写「降权的语义完整保留」，而实际发生的是「降权让区分度归零」。
  // 3. 它把 `absoluteThreshold` 当成了分数地板，于是那道闸对所有卡恒真。
  //
  // FR-B5 的「冲突不隐藏」现在由**结构**保证，不再靠封顶这个补丁：
  // 闸门看的是 `relevance`，而 `relevance` **完全不含冲突项**，
  // 所以冲突在数学上不可能影响一张卡的去留，只影响它排第几。
  // 这比「算一个恰好不越界的上限」更可靠——后者依赖两个参数的具体数值。
  const penalty = rawPenalty
  const total = clamp01(normalized - penalty * w.conflict)

  const score: ScoreBreakdown = {
    semantic, importance, recency, goal, confidence, conflictPenalty: penalty, relevance, total,
  }
  return {
    card,
    score,
    // 不再有「封顶」这回事：惩罚原样扣进 `total`，而闸门看的是 `relevance`，
    // 后者完全不含冲突项，所以冲突在结构上无法影响去留（FR-B5）。
    explain: buildExplain(score, config, { goalApplied }),
    // `conflict` 判据用原始惩罚：只要这张卡真的挂着冲突就必须标 CONFLICT（FR-B5）。
    conflict: rawPenalty > 0,
  }
}

/**
 * 有效半衰期：情绪与访问频次会延长记忆寿命。
 *
 * 起源 L3（无编号·激素是关键）：强烈情绪的事件记得更久。这里把它做成半衰期的乘数，
 * 而不是额外加分——因为「忘得慢」和「分得高」是两件事。
 *
 * @param card - 记忆卡。
 * @param config - 配置。
 * @returns 毫秒为单位的有效半衰期。
 */
export function effectiveHalfLife(card: MemoryCard, config: MemoryConfig): number {
  const base = config.forgetting.halfLifeMs
  const emotionalBoost = 1 + clamp01(card.emotional) * (config.forgetting.emotionalHalfLifeBoost - 1)
  const accessBoost = 1 + Math.min(1, Math.log1p(card.accessCount) / Math.log1p(20))
  return base * emotionalBoost * accessBoost
}

/**
 * 把数值夹到 0..1。
 *
 * @param value - 任意数。
 * @returns 0..1 之间的数。
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
