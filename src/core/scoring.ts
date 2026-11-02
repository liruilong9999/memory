/**
 * 打分内核：决定「此刻该想起哪几条记忆」。
 *
 * 需求 FR-B1：总分 = 语义相关 + 重要性 + 时间衰减 + 目标匹配 + 置信度 − 冲突惩罚。
 * 需求 FR-B3 / ST-1：同样状态、同样查询，必须得到完全相同的排序——
 * 因此本文件**没有随机数、没有 Date.now()、没有浮点累积误差陷阱**，
 * 时间一律由参数 `now` 传入。
 *
 * 起源 L29（第 5 条·专注当前位置）讲「人的注意力会自动屏蔽无关记忆，只保留和当前相关的」，
 * 这就是打分与阈值截断在做的事：不是「把库塞进上下文」，而是「把焦点放进上下文」。
 *
 * @module dsh-memory/core/scoring
 */

import type { MemoryConfig } from './config.ts'
import { coverage, estimateTokens, tokenSet, truncate } from './text.ts'
import type {
  FocusPack, MemoryCard, ScoreBreakdown, ScoredCard, TimeState,
} from './types.ts'

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
  const penalty = capConflictPenalty(rawPenalty, normalized, config)
  const total = clamp01(normalized - penalty * w.conflict)

  const score: ScoreBreakdown = {
    semantic, importance, recency, goal, confidence, conflictPenalty: penalty, total,
  }
  return {
    card,
    score,
    explain: buildExplain(score, config, {
      goalApplied,
      conflictCapped: penalty < rawPenalty,
    }),
    // `conflict` 判据用**原始惩罚**而不是封顶后的值：只要这张卡真的挂着冲突，
    // 就必须标 CONFLICT（FR-B5）。若用封顶值，边界情况下会算出 0 而漏标。
    conflict: rawPenalty > 0,
  }
}

/**
 * 给冲突惩罚封顶，保证它**只改排序、不改去留**。
 *
 * 需求 FR-B5 的原文是「冲突不隐藏，但要降权」——降权是排序手段，
 * 不是淘汰手段。原来的实现直接把 `penalty × w.conflict` 从总分里减掉，
 * 而 `w.conflict`（0.25）比 `absoluteThreshold`（0.18）还大：一条冲突数
 * 达到 3 的卡最多被扣 0.25，足以把它从阈值上方打到下方。结果就是
 * **互相冲突的两张卡一起消失**——恰恰是 FR-B5 要防的「隐藏」，
 * 而且是最坏的一种隐藏：模型连「这里存在矛盾」都不知道。
 *
 * 封顶的做法是让惩罚最多消耗「离绝对阈值还剩多少余量」，即
 * `penalty × w.conflict ≤ normalized − absoluteThreshold`。
 * 这样：只要一条卡本来能进包，冲突就绝不会让它掉出包外；
 * 但它仍会因此排在无冲突的同分卡之后——降权的语义完整保留。
 *
 * @param raw - 原始冲突惩罚（0..1）。
 * @param normalized - 归一化后的正向分（0..1，未扣冲突）。
 * @param config - 配置，提供冲突权重与绝对阈值。
 * @returns 封顶后的惩罚（0..1）。
 */
function capConflictPenalty(raw: number, normalized: number, config: MemoryConfig): number {
  if (raw <= 0) return 0
  const weight = config.weights.conflict
  // 权重为 0 时惩罚不进总分，封顶无从谈起；原样报出供 explain 显示真实冲突程度。
  if (weight <= 0) return raw
  const headroom = normalized - config.recall.absoluteThreshold
  // 本来就在阈值下方：惩罚已无「淘汰」可言，报 0 避免 explain 出现误导性的扣分。
  if (headroom <= 0) return 0
  return Math.min(raw, headroom / weight)
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
 * 构造人可读的解释行。
 *
 * 需求 FR-B4：能回答「为什么想起这条」。
 *
 * 这里必须**如实**反映实际参与计算的维度：目标维度没参与时要明说「未启用」，
 * 不能显示成「目标匹配 0.000」——那是在告诉人「算了，但匹配度为零」，
 * 而真相是「这个维度根本没参与归一化」。FR-B4 的可解释性要求的是后者。
 *
 * @param score - 分数构成。
 * @param config - 配置，用于展示权重。
 * @param options - 渲染选项。
 * @param options.goalApplied - 目标维度是否参与计算；`false` 时标为未启用。
 * @param options.conflictCapped - 冲突惩罚是否被封顶过；`true` 时补一句说明。
 * @returns 解释行数组。
 */
export function buildExplain(
  score: ScoreBreakdown,
  config: MemoryConfig,
  options: { goalApplied?: boolean; conflictCapped?: boolean } = {},
): string[] {
  const w = config.weights
  const goalApplied = options.goalApplied ?? true
  const lines = [
    `语义相关 ${fmt(score.semantic)} × 权重 ${fmt(w.semantic)} = ${fmt(score.semantic * w.semantic)}`,
    `重要性   ${fmt(score.importance)} × 权重 ${fmt(w.importance)} = ${fmt(score.importance * w.importance)}`,
    `时间新鲜 ${fmt(score.recency)} × 权重 ${fmt(w.recency)} = ${fmt(score.recency * w.recency)}`,
    goalApplied
      ? `目标匹配 ${fmt(score.goal)} × 权重 ${fmt(w.goal)} = ${fmt(score.goal * w.goal)}`
      : `目标匹配 未启用（本次未提供目标，权重 ${fmt(w.goal)} 不计入分母）`,
    `置信度   ${fmt(score.confidence)} × 权重 ${fmt(w.confidence)} = ${fmt(score.confidence * w.confidence)}`,
  ]
  if (score.conflictPenalty > 0) {
    const capped = options.conflictCapped === true ? '（已封顶，冲突只影响排序不决定去留）' : ''
    lines.push(`冲突惩罚 -${fmt(score.conflictPenalty)} × 权重 ${fmt(w.conflict)} = -${fmt(score.conflictPenalty * w.conflict)}${capped}`)
  }
  lines.push(`总分 ${fmt(score.total)}`)
  return lines
}

/**
 * 按记忆域过滤候选卡。
 *
 * 起源 L13（无编号）：「可以把生活、学习、工作 3 个记忆模块，可插拔
 * （同时存在或者只有一个）」。可插拔的含义是**没启用的域不该出现在结果里**，
 * 否则「只开工作域」与「三个域全开」召回结果一样，可插拔就是假的。
 *
 * 空域列表表示不限域（兼容「域还没配置」的场景）。
 *
 * @param cards - 候选卡。
 * @param domains - 允许的记忆域；为空表示不限。
 * @returns 过滤后的卡片。
 */
export function filterByDomain(
  cards: readonly MemoryCard[], domains: readonly string[],
): MemoryCard[] {
  if (domains.length === 0) return [...cards]
  const allowed = new Set(domains)
  return cards.filter((card) => allowed.has(card.domain))
}

/**
 * 批量打分并按总分降序排序。
 *
 * 排序必须稳定：总分相同的情况下用 id 升序兜底，
 * 否则同分卡的顺序会随 Map 迭代顺序变化，破坏 ST-1 的确定性验收。
 *
 * @param cards - 候选卡。
 * @param query - 查询上下文。
 * @param config - 配置。
 * @returns 已排序的已打分卡。
 */
export function scoreCards(
  cards: readonly MemoryCard[], query: RecallQuery, config: MemoryConfig,
): ScoredCard[] {
  // 先按域过滤再打分：域外的卡连候选都不该算，否则白花 CPU 且会污染相对阈值。
  const inDomain = filterByDomain(cards, query.domains)
  const scored = inDomain.map((card) => scoreCard(card, query, config))
  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0
  })
  return scored
}

/**
 * 阈值截断：从已排序结果里挑出真正进焦点包的那几条。
 *
 * 需求 FR-B2：绝对阈值 + 相对阈值 + 硬上限，三者取最严。
 * 「全低分时不硬塞」——宁可空包，也不给模型一堆无关记忆（FR-B6）。
 *
 * @param scored - 已按总分降序排序的结果。
 * @param config - 配置。
 * @returns 通过阈值的卡片。
 */
export function applyThresholds(scored: readonly ScoredCard[], config: MemoryConfig): ScoredCard[] {
  if (scored.length === 0) return []
  const top = scored[0]
  if (top === undefined) return []
  const relativeFloor = top.score.total * config.recall.relativeThreshold
  const picked: ScoredCard[] = []
  for (const item of scored) {
    if (picked.length >= config.recall.maxCards) break
    if (item.score.total < config.recall.absoluteThreshold) continue
    if (item.score.total < relativeFloor) continue
    picked.push(item)
  }
  return picked
}

/**
 * 组装焦点包（Focus Pack）。
 *
 * 需求 FR-E1 / FR-E3：只装摘要、有 token 硬上限、超限先砍低分卡。
 * 需求 FR-B6：空包时给出明确措辞，让模型说「没有相关记忆」而不是编造。
 *
 * @param scored - 已打分并排序的候选。
 * @param query - 查询上下文（用于回填 query 文本）。
 * @param config - 配置。
 * @returns 焦点包。
 */
export function buildFocusPack(
  scored: readonly ScoredCard[], query: RecallQuery, config: MemoryConfig,
): FocusPack {
  const picked = applyThresholds(scored, config)
  const budget = config.recall.tokenBudget
  // 头尾固定文本（标题/当前时间/免责尾注）也占上下文，必须先扣掉再分配卡片。
  // 不扣的话 pack.tokens 只统计卡片部分，实际注入必然超出 tokenBudget（FR-E3 失真）。
  const overhead = Math.max(0, config.recall.overheadTokens)
  const cardBudget = Math.max(0, budget - overhead)
  const kept: ScoredCard[] = []
  let used = 0

  for (const item of picked) {
    const text = truncate(item.card.text, config.recall.maxCardChars)
    const line = formatCardLine(item.card, text)
    const cost = estimateTokens(line)
    // 至少留一条，否则预算太小时焦点包会永远为空；其余按预算硬截断。
    if (kept.length > 0 && used + cost > cardBudget) continue
    if (used + cost > cardBudget && kept.length === 0) {
      // 单条就超预算：截断文本再试，仍超则放弃。
      const shrunk = truncate(item.card.text, Math.max(8, Math.floor(config.recall.maxCardChars / 2)))
      const shrunkCost = estimateTokens(formatCardLine(item.card, shrunk))
      if (shrunkCost > cardBudget) continue
      kept.push(item)
      used += shrunkCost
      continue
    }
    kept.push(item)
    used += cost
  }

  const empty = kept.length === 0
  return {
    cards: kept,
    // tokens 报「卡片 + 头尾固定开销」的真实占用，调用方据此判断是否超预算。
    tokens: empty ? 0 : used + overhead,
    budgetTokens: budget,
    maxCardChars: config.recall.maxCardChars,
    query: query.text,
    builtAt: query.now,
    empty,
    note: empty ? '没有相关记忆。' : '',
  }
}

/**
 * 格式化一条卡片为注入行。
 *
 * 格式刻意简短：`- [类型] 摘要（时间）`。不带来源指针、不带分数——
 * 那些进上下文只会烧 token，不进焦点包（FR-E1）。
 *
 * @param card - 记忆卡。
 * @param text - 已截断的摘要文本。
 * @returns 一行文本。
 */
export function formatCardLine(card: MemoryCard, text: string): string {
  const tag = kindLabel(card.kind)
  return `- [${tag}] ${text}`
}

/**
 * 卡片类型的中文标签。
 *
 * 为什么必须处理「未知类型」而不是靠 `switch` 的隐式 `undefined`：
 * 投影层（`src/store/state.ts` 的 `coerceKind`）对未知 `kind` 采取**忠实透传**
 * 策略——日志里写的是 `summary`，重放出来就必须还是 `summary`，不许静默改成
 * `fact`（那样日志写 A、重放得 B，破坏 ST-1 且事后无从发现）。既然未知类型
 * 能走到渲染层，这里就不能让它变成 `undefined`——那会渲染出
 * `- [undefined] xxx`，比降级更难查。
 *
 * 因此兜底返回**类型名本身**：不发明中文、不假装认识，把真相摆出来。
 *
 * @param kind - 类型。
 * @returns 中文标签；未知类型返回其原始名称。
 */
export function kindLabel(kind: MemoryCard['kind']): string {
  switch (kind) {
    case 'event': return '事件'
    case 'fact': return '事实'
    case 'promise': return '承诺'
    case 'concept': return '概念'
    case 'feeling': return '感受'
    case 'experience': return '经验'
    case 'summary': return '摘要'
    default: return String(kind)
  }
}

/**
 * 把焦点包渲染成注入文本。
 *
 * 需求 FR-E2：追加式、KV 安全——所以这里只产出**一段独立的文本块**，
 * 由适配面整体作为 context 内容追加，绝不改写系统提示词头部。
 *
 * @param pack - 焦点包。
 * @param time - 时间状态，用于渲染时间读数。
 * @returns 注入文本。空包时返回空串——**这是刻意的**：
 *   空包应当什么都不注入，让模型自己去问，而不是塞一句「没有相关记忆」诱导它
 *   说「我查过了，没有」。要拿提示语请用 `renderEmptyNote`。
 */
export function renderFocusPack(pack: FocusPack, time: TimeState): string {
  if (pack.empty) return ''
  const lines: string[] = []
  lines.push('## 相关记忆（由记忆系统自动召回，非用户输入）')
  lines.push(`当前时间：${formatTime(time.now, time.timeZone)}`)
  lines.push('')
  for (const item of pack.cards) {
    // 截断长度必须来自配置，不能硬编码：硬编码会让实际注入长度与 pack.tokens 的估算脱钩。
    const text = truncate(item.card.text, pack.maxCardChars)
    lines.push(formatCardLine(item.card, text))
    if (item.conflict) {
      // FR-B5 / SC-4：冲突必须**同时暴露双方**，只说「有冲突」等于让模型知道
      // 有矛盾却看不到矛盾的另一半，它要么忽略要么编造。
      // 标记词用 CONFLICT：FR-B5 原文就要求「标 CONFLICT」，规格与实现用同一个词，
      // 才能被 grep 验证，也方便模型把这个词当成确定信号。
      lines.push(`  ⚠ CONFLICT 与其他记忆冲突，冲突对象：${describeConflictPeers(item, pack)}`)
    }
  }
  lines.push('')
  lines.push('以上是系统召回的旧记忆，可能过时或不完整；与当前对话冲突时以当前对话为准。')
  return lines.join('\n')
}

/**
 * 把毫秒时间戳格式化为本地可读时间。
 *
 * 用 `Intl` 而不是手算时区偏移：夏令时、历史时区变更都能正确处理。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区名。
 * @returns `YYYY-MM-DD HH:mm` 形式。
 */
export function formatTime(at: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(at))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/**
 * 把毫秒时长格式化为中文人话。
 *
 * 需求 FR-D2 / SC-3：「距上次聊这个多久了」的回答必须与代码计算一致，
 * 所以这里输出的是确定性的中文表述，而不是让模型自己算。
 *
 * @param ms - 毫秒数。
 * @returns 如「3 天 2 小时前」。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (ms < minute) return '刚刚'
  if (ms < hour) return `${Math.floor(ms / minute)} 分钟前`
  if (ms < day) return `${Math.floor(ms / hour)} 小时前`
  const days = Math.floor(ms / day)
  if (days < 30) {
    const restHours = Math.floor((ms - days * day) / hour)
    return restHours > 0 ? `${days} 天 ${restHours} 小时前` : `${days} 天前`
  }
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
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

/**
 * 保留三位小数的格式化，用于解释行。
 *
 * @param value - 数值。
 * @returns 三位小数字符串。
 */
function fmt(value: number): string {
  return value.toFixed(3)
}

/**
 * 渲染空焦点包的说明文本（FR-B6 / ST-5）。
 *
 * 为什么要单独一个函数：\`pack.note\` 此前是**纯死字段**——写进去了、测了、
 * 然后没有任何地方读它（\`grep -rn "\.note" src/\` 零命中）。FR-B6「不编造」
 * 这条 P0 验收靠的正是这句提示，结果模型永远收不到。
 *
 * 语义上仍要区分两件事：
 * - \`renderFocusPack\` 空包时返回空串：**不注入**记忆块，不污染上下文；
 * - \`renderEmptyNote\` 供需要明确告知的场合（如命令输出、诊断）使用。
 *
 * @param pack - 焦点包。
 * @returns 空包时的说明；非空包返回空串。
 */
export function renderEmptyNote(pack: FocusPack): string {
  return pack.empty ? pack.note : ''
}

/**
 * 描述一张冲突卡的「对方是谁」。
 *
 * FR-B5 要求冲突**双方同时暴露**。只写「有冲突」等于让模型知道有矛盾却
 * 看不到另一半，它只能忽略或编造——两种都违反 FR-B6。
 *
 * @param item - 当前被打分的卡片。
 * @param pack - 焦点包，用于查找对方是否也在包内。
 * @returns 形如 `「另一张卡的文本」` 的描述；找不到时退回 id。
 */
export function describeConflictPeers(item: ScoredCard, pack: FocusPack): string {
  const ids = item.card.conflictOf
  if (ids.length === 0) return '（对方已不在活跃记忆中）'
  const described: string[] = []
  for (const id of ids) {
    const peer = pack.cards.find((other) => other.card.id === id)
    if (peer === undefined) {
      described.push(`（另一条记忆 ${id.slice(0, 8)}，不在本次焦点包内）`)
      continue
    }
    described.push(`「${truncate(peer.card.text, pack.maxCardChars)}」`)
  }
  return described.join('；')
}
