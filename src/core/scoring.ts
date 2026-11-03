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
import { applySpread, buildAdjacency, spreadActivation } from './spread.ts'
import { coverage, estimateTokens, tokenSet, truncate } from './text.ts'
import type { SpreadBoost } from './spread.ts'
import type {
  FocusPack, MemoryCard, MemoryEdge, ScoreBreakdown, ScoredCard, TimeState,
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
 * @returns 解释行数组。
 */
export function buildExplain(
  score: ScoreBreakdown,
  config: MemoryConfig,
  options: { goalApplied?: boolean } = {},
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
    lines.push(`冲突惩罚 -${fmt(score.conflictPenalty)} × 权重 ${fmt(w.conflict)} = -${fmt(score.conflictPenalty * w.conflict)}`)
  }
  // 相关分量必须显式列出：它是**决定去留**的那个数，而总分只决定排序。
  // 不列出来，用户看到「总分 0.45 却没进焦点包」会觉得系统坏了——
  // 实际是 relevance 不够。FR-B4 要求分数可解释，这一行是解释的核心。
  lines.push(`相关分量 ${fmt(score.relevance)}（闸门判据，阈值 ${fmt(config.recall.absoluteThreshold)}）`)
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
  edges: readonly MemoryEdge[] = [],
): ScoredCard[] {
  // 先按域过滤再打分：域外的卡连候选都不该算，否则白花 CPU 且会污染相对阈值。
  const inDomain = filterByDomain(cards, query.domains)
  const scored = inDomain.map((card) => scoreCard(card, query, config))
  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0
  })
  if (edges.length === 0 || config.spread.mode === 'off') return scored
  return mergeSpread(scored, edges, config)
}

/**
 * 把扩散结果合并进已排序的候选。
 *
 * 与 `spread.ts` 的 `applySpread` 分工不同：那个函数只做「加法」，本函数负责
 * 「谁当种子、护栏用哪个分数表」——那是打分链路的语境，属于本文件。
 *
 * **种子只取已过绝对阈值的卡。** 若让低分卡也当种子，一条刚过线的卡
 * 会把自己的弱激活撒给邻居，扩散就从「强化确定命中」退化成「放大噪声」。
 * 阈值在这里被复用为「值得传播」的判据，与它「值得展示」的判据一致。
 *
 * ## 影子模式（`mode === 'shadow'`）怎么工作
 *
 * 扩散**照常计算**，但结果只写进 `shadowSpread` 字段，**不动 `score.total`、
 * 不动排序**。返回的数组与 `off` 模式逐位相同，唯一区别是多了观察值。
 *
 * 为什么不让影子模式「只算一半」：影子模式的全部价值在于它算的是**真账**。
 * 若它用了不同的种子集合或不同的护栏，那它预测的就不是「打开后会怎样」，
 * 而是一个近似值——用近似值攒出来的证据，不足以支撑「该不该打开」的决定。
 *
 * 需求 FR-G1；护栏见 `SpreadPolicy.minSelfScoreRatio`。
 *
 * @param scored - 已按自身分数排序的候选。
 * @param edges - 全部图谱边。
 * @param config - 配置。
 * @returns 合并扩散加分并重新排序的结果（影子模式下只附加观察值）。
 */
function mergeSpread(
  scored: readonly ScoredCard[], edges: readonly MemoryEdge[], config: MemoryConfig,
): ScoredCard[] {
  // 护栏判据装的是 **relevance**，不是 total。
  //
  // 扩散护栏问的是「这张卡本身有没有资格被加分」，而资格 = 与查询有关系，
  // 那正是 `relevance` 的语义。用 `total` 会让一张「无关但新鲜」的卡
  // 凭新鲜度通过护栏——护栏就又变成了恒真（这正是它坏过两次的方式）。
  //
  // 顺带一个结构性的好处：`selfScores` 里没有的卡（池外邻居）依然被挡掉，
  // 而池外邻居按构造 semantic 恒为 0（见下方注释），所以「挡掉池外邻居」
  // 与「挡掉无关卡」在这里是同一件事。
  const selfScores = new Map(scored.map((item) => [item.card.id, item.score.relevance]))
  // 种子判据用 **seedRatio**，且门槛是**相对本次最高分**，不是绝对阈值。
  //
  // ## 这里曾经让整个机制在数学上恒为空（被实测抓出的设计缺陷）
  //
  // 最初是 `total >= absoluteThreshold`，与加分护栏
  // （`absoluteThreshold * minSelfScoreRatio`，校验强制 ≥ 1）**恰好相等**：
  //   能加分的卡一定已经是种子 → 而种子不因扩散加分 → boost 恒为空集。
  // 31 条单测全绿，因为它们各自构造了现实链路里不可能出现的状态。
  //
  // 第一次修复改成「阈值 × 倍数」（0.18 × 1.5 = 0.27），**实测仍然恒空**。
  // 原因是打分有基础分下限：完全不相关的两句话也有 0.33 左右
  // （importance / recency / confidence 各贡献一份），而 0.18 永远拦不住
  // 任何卡。实测 12 个样本最低 0.3295，无一低于 0.18。
  // **任何「阈值 × 倍数」的门槛都会落在所有卡之下。**
  //
  // ## 现在的做法：相对最高分
  //
  // 门槛 = 本轮候选池最高分 × seedRatio。无量纲，自动跟随本轮分数分布：
  // 查询精确时门槛高，模糊时门槛低。它衡量的不是「够不够格」，而是
  // 「在本轮里够不够强」——那才是「值得把激活撒出去」的判据。
  const maxScore = scored.reduce((m, item) => (item.score.total > m ? item.score.total : m), 0)
  const seedFloor = maxScore * config.spread.seedRatio
  const seeds = scored
    .filter((item) => item.score.total >= seedFloor)
    .map((item) => ({ id: item.card.id, score: item.score.total }))
  // 邻接表按**全部边**构造，但结果只对候选池内的卡生效。
  //
  // ## 这条注释的前半句曾经承诺了一个实现没有的能力
  //
  // 原文写的是「扩散才能从候选卡走到『本轮没被检索命中』的邻居」——
  // 读起来像是「池外邻居也能被扩散召回」。实际不会：`selfScores` 只含候选池，
  // `spreadActivation` 里 `selfScore === undefined` 的卡直接被护栏挡掉。
  // 前半句承诺能力、后半句取消它，等于把缺陷写成了事实。
  //
  // ## 不是缺陷，是**结构性必然**（已实测，别再试图「修」它）
  //
  // 候选池 = `store.search(query.tokens)` 的倒排命中，而 `semanticScore` 也基于
  // 词项重合。于是：
  //
  //   不在池内 ⟺ 倒排未命中 ⟺ 与查询零词项重合 ⟺ semantic 必然 = 0
  //
  // 实测 78 张卡 / 45 条边：池外邻居 33 个，**semantic 为 0 的 33 个（100%）**，
  // 大于 0 的 0 个。所以「让扩散拉入池外邻居」不是找回被漏掉的相关记忆，
  // 而是往焦点包塞**必然无关**的卡——正是 FR-B2「全低分时不硬塞」要防的事。
  //
  // 反事实重排也证实了这一点：把池外邻居强行加进池后，新增的 10 张卡
  // semantic 全是 0.000，而被挤掉的 2 张 semantic 是 0.090——净变差。
  //
  // 唯一理论上合法的扩池场景是 `distills` 边（感受卡文本是模板，与查询
  // 零重合却真的相关，起源 L11）。实测该语料下 `distills` 边产出 0 条，
  // 没有可验证的场景，因此**不实现**：与其写一个没有真实输入能走到的分支，
  // 不如把这个边界写清楚。
  const adjacency = buildAdjacency(edges)
  const boosts = spreadActivation(seeds, adjacency, selfScores, config)
  // 没有任何卡获得扩散加分时，返回入参本身而不是拷贝：调用方拿到的是同一份
  // 已排序数组，行为与不启用扩散时完全一致（零回归）。
  if (boosts.length === 0) return [...scored]

  if (config.spread.mode === 'shadow') return attachShadow(scored, boosts)

  const applied = applySpread(scored, boosts).map((item) => patchExplainForSpread(item, scored, config))
  applied.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0
  })
  return applied
}

/**
 * `on` 模式下，把扩散加分补进 `explain`，并让末行总分跟上新值。
 *
 * ## 这里曾经让 explain 自相矛盾（被实测抓出的真缺陷）
 *
 * `explain` 由 `scoreCard` 生成，那时扩散**还没发生**（`mergeSpread` 在打分
 * 之后才跑）。`applySpread` 只改 `score.total`，不改 `explain`。于是 `on`
 * 模式下同一张卡在人读渲染里报出**两个互相矛盾的总分**：
 *
 * ```text
 * ■ 约定 Redis 的过期时间设成 300 秒，注意踩坑
 *   总分 0.449          ← 头行取 score.total（已含 +0.12）
 *   语义相关 0.500 ...  ← 五项加起来 = 0.329
 *   冲突惩罚 -1.000 ...
 *   总分 0.329          ← 末行取 explain，是加分前的值
 * ```
 *
 * 实测 5 张卡里 3 张如此，差额恰好等于 boost（0.1200）。
 * 比「少一行」更糟：少一行是漏了，**两行矛盾是自相矛盾**，读者只会认为
 * 系统算错了。FR-B4「可解释」的判据是能回答「为什么想起这条」，
 * 而这里给出的答案是错的。
 *
 * ## 为什么补一行而不是重算整个 explain
 *
 * 重算要把 `scoreCard` 的上下文（`goalApplied` / `conflictCapped`）一起搬过来，
 * 等于复制一份打分逻辑。补一行只加「外部证据」那一项——扩散加分本来就不是
 * 这张卡自身的属性（见 `applySpread` 的注释：它不参与归一化）。
 *
 * ## 为什么这一行必须说明「来自哪几张卡」
 *
 * 用户要的是「类似神经的突触效果」。突触效果的可感知形态不只是「分数高了」，
 * 而是**能说出「因为想起 A，所以想起 B」**。只说「+0.120」等于「莫名高了
 * 一点」，从用户视角看就是噪声。`sources` 已经在 `spreadActivation` 里算出
 * （按 id 升序，可复现），这里只是给它一个出口。
 *
 * 注意这一行**只进人读渲染**：`explain` 的唯一消费方是
 * `renderFocusPackExplain`（`/memory explain` 与 CLI `query`），注入路径
 * `renderFocusPack` 不读它——起源 L17（无编号·上下文污染）要求注入文本
 * 里不能有这类解释。
 *
 * @param item - 已合并扩散加分的卡片。
 * @param pool - 本轮候选池（用于把来源 id 换成可读文本）。
 * @param config - 配置（取 `explainSourceChars`）。
 * @returns 补好解释行的新对象（不修改入参，ST-1）。
 */
function patchExplainForSpread<T extends {
  card: MemoryCard
  score: { total: number }
  explain: string[]
  spreadBoost: number
  spreadSources: readonly string[]
}>(item: T, pool: readonly ScoredCard[], config: MemoryConfig): T {
  // 没被扩散推动的卡：explain 本来就是对的（总分没变），不要动它。
  if (item.spreadBoost <= 0) return item
  const lines = item.explain.slice()
  const boostLine = `扩散加分 +${fmt(item.spreadBoost)} × 权重 1.000 = +${fmt(item.spreadBoost)}`
  // 来源卡必须说出**是哪几条**，否则读者只知道「有来源」却不知道「因为想起什么」，
  // 扩散在观感上仍是莫名加分。这就是「突触」的可感知形态。
  //
  // 来源 id 一定在候选池里：种子从 `scored` 里挑（见 `mergeSpread`），
  // 所以 `pool` 足够把每个 id 换成文本。查不到时退回只报数量——
  // 不猜、不编造（信条 5）。
  const sourceTexts = item.spreadSources
    .map((id) => pool.find((c) => c.card.id === id))
    .filter((c): c is ScoredCard => c !== undefined)
    .map((c) => truncate(c.card.text, config.spread.explainSourceChars))
  const sourceNote = config.spread.explainSourceChars > 0 && sourceTexts.length > 0
    ? `，因为想起了：${sourceTexts.join(' / ')}`
    : item.spreadSources.length > 0
      ? `（来自 ${item.spreadSources.length} 张关联卡）`
      : ''
  // 末行是 `总分 X`，必须换成**加过分之后**的值，否则和头行矛盾。
  const tailIndex = lines.length - 1
  const tail = lines[tailIndex]
  if (tail !== undefined && tail.startsWith('总分 ')) {
    lines[tailIndex] = boostLine + sourceNote
    lines.push(`总分 ${fmt(item.score.total)}`)
  } else {
    // 末行不是总分 ⇒ `buildExplain` 的格式变了。不猜，把两项都补在最后：
    // 宁可多两行也不能让总分消失（总分是 explain 里唯一的汇总行）。
    lines.push(boostLine + sourceNote, `总分 ${fmt(item.score.total)}`)
  }
  return { ...item, explain: lines }
}

/**
 * 影子模式：算出「假设打开扩散会怎样」，但**不改动排序**。
 *
 * 返回的数组与入参**顺序完全相同**，只在每张卡上附加 `shadowSpread`。
 *
 * ## 为什么要同时给出 `actualRank` 和 `hypotheticalRank`
 *
 * 只给 boost 不足以判断影响：+0.05 的加分作用在第一名身上毫无意义，
 * 作用在阈值边缘的卡上可能让它直接挤进焦点包。**扩散真正的影响是排序变化，
 * 不是分数变化。** 两个排名放在一起，一眼就能看出这次扩散到底改变了什么。
 *
 * 排序键与真实链路（`applySpread` 之后那次 sort）**必须完全一致**：
 * 分数降序 + id 升序。若这里用了不同的 tie-break，影子模式算出的排名
 * 与真打开后的排名会对不上，那份证据就废了。
 *
 * @param scored - 已按自身分数排序的候选。
 * @param boosts - 扩散结果。
 * @returns 顺序不变、每张卡带影子观察值的结果。
 */
function attachShadow(
  scored: readonly ScoredCard[], boosts: readonly SpreadBoost[],
): ScoredCard[] {
  const applied = applySpread(scored, boosts)
  const hypothetical = [...applied].sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total
    return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0
  })
  const hypotheticalRank = new Map(hypothetical.map((item, index) => [item.card.id, index + 1]))
  const actualRank = new Map(scored.map((item, index) => [item.card.id, index + 1]))
  // 原总分从 `scored` 里取，**不用减法还原**：`applySpread` 内部有 `clamp01`，
  // 分数本来接近 1 时加分会先被截断，`total - boost` 得不到原值。
  // 这种误差在正常分数区间（0.2~0.6）看不出来，只在边界上出现——
  // 正是最难发现的那一类，所以从一开始就不走这条路。
  const originalTotal = new Map(scored.map((item) => [item.card.id, item.score.total]))
  return applied.map((item) => {
    const base = originalTotal.get(item.card.id) ?? item.score.total
    // 影子模式下必须把 `applySpread` 挂上的 `spreadBoost` / `spreadSources`
    // **摊掉**。它们是 `on` 模式的字段，而影子模式的唯一真相源是
    // `shadowSpread`。两个同时存在时：
    //   - 读 `spreadBoost` 的消费方会以为加分已经生效（实际没有）；
    //   - `shadowSpread.boost` 是假设值、`spreadBoost` 是原始值，
    //     clamp 后两者可能不同，出问题时无从判断该信哪个。
    //
    // 这与 `ShadowSpread` 文档里「让『实际生效』和『假设生效』在类型层面就是
    // 两件事」是同一个要求：光在注释里写不算，必须在数据里真的分开。
    const { spreadBoost, spreadSources, ...rest } = item
    // 原总分从 `scored` 里取，**不用减法还原**（见 `originalTotal` 的注释）。
    const restored: ScoredCard = { ...rest, score: { ...rest.score, total: base } }
    // 只有**真的被扩散推动**的卡才留观察值。
    //
    // 若照搬就会让所有卡都带一条 `boost: 0` 的影子记录——那会把
    // 「观察到了什么」和「什么都没发生」混成同一件事。
    // 观察值非空必须等价于「扩散对这张卡有意见」。
    if (spreadBoost <= 0) return restored
    return {
      ...restored,
      shadowSpread: {
        boost: spreadBoost,
        sources: spreadSources,
        hypotheticalTotal: item.score.total,
        hypotheticalRank: hypotheticalRank.get(item.card.id) ?? 0,
        actualRank: actualRank.get(item.card.id) ?? 0,
      },
    }
  })
}

/**
 * 阈值截断：从已排序结果里挑出真正进焦点包的那几条。
 *
 * 需求 FR-B2：绝对阈值 + 相对阈值 + 硬上限，三者取最严。
 * 「全低分时不硬塞」——宁可空包，也不给模型一堆无关记忆（FR-B6）。
 *
 * ## 闸门看 `relevance`，不看 `total`（这是修缺陷二十六的核心）
 *
 * 原来的闸门是 `total >= absoluteThreshold`。它在真实数据上**恒真**：
 * `total` 里 0.48 权重给了与查询无关的维度，一张完全无关但新鲜的卡
 * 也有约 0.32。实测（161 张卡 × 19 个查询）无关卡总分区间
 * 0.3131~0.3767 与相关卡区间 0.3452~ 重叠 33.3%，
 * **任何阈值都分不开**，于是「全低分时不硬塞」这条验收不可能失败。
 *
 * 换成 `relevance` 后，同一个完全无关的查询下它精确为 0，
 * 闸门立刻能拒绝（实测「深海鮟鱇鱼」查询从硬塞 4 张变为空包），
 * 而真相关的卡一张都没掉（实测 19 个查询全部无召回损失）。
 *
 * **排序仍按 `total`**：那是「值不值得想起」，与「有没有关系」是两件事。
 *
 * @param scored - 已按总分降序排序的结果。
 * @param config - 配置。
 * @returns 通过阈值的卡片。
 */
export function applyThresholds(scored: readonly ScoredCard[], config: MemoryConfig): ScoredCard[] {
  if (scored.length === 0) return []
  const top = scored[0]
  if (top === undefined) return []
  // 两道闸用**两把不同的尺子**，这是修缺陷二十六时定下来的，别再合并：
  //
  // - 绝对闸 → `relevance`（只含 semantic + goal）。它回答「有没有关系」，
  //   是 FR-B2「全低分时不硬塞」的判据。扩散加分不进 relevance，
  //   所以「有个强邻居」在结构上无法把无关卡推过这道闸。
  // - 相对闸 → `total`。它回答「比本轮最好的差多少」，而「值不值得想起」
  //   本来就该含新鲜度/重要性。扩散加分进 total，所以扩散**天然**能改变
  //   成员，不需要任何豁免补丁。
  //
  // 曾经把相对闸也挪到 relevance（觉得「两把尺子不统一」），实测立刻误伤：
  // SC-2 场景里目标卡 relevance 0.1113、相对闸 0.1121，**差 0.0008 被挡出包**，
  // 而它在 total 尺度上（0.3925 vs 闸 0.2522）本该轻松通过。
  // 根因是 relevance 的相对离散度比 total 大（同批候选 0.546 vs 0.856），
  // 同一个 `relativeThreshold` 在 relevance 尺度上苛刻得多。
  // ⇒ **两把尺子不是不一致，是两道闸问的问题不同。**
  const relativeFloor = top.score.total * config.recall.relativeThreshold
  const picked: ScoredCard[] = []
  for (const item of scored) {
    if (picked.length >= config.recall.maxCards) break
    if (item.score.relevance < config.recall.absoluteThreshold) continue
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
/**
 * 空包文案的**唯一来源**（FR-B6 / ST-5）。
 *
 * 为什么单独导出一个常量：`pack.note` 只有 `buildFocusPack` 会写，
 * 而人读渲染（`render.ts`）此前把同一句话**又抄了一遍**，还抄成了
 * 「没有命中任何记忆」——ST-5 验收的原话是「明确回答"没有相关记忆"」，
 * 于是在终端里 grep 那句话是搜不到的。
 *
 * **同一件事有两份文案，就一定会有一份是错的**，而且没有任何机制会提醒。
 * 这里给出唯一来源，`render.ts` 直接引用，不再各写一份。
 */
export const EMPTY_PACK_NOTE = '没有相关记忆。'

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
    note: empty ? EMPTY_PACK_NOTE : '',
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
