/**
 * 批量打分与图谱扩散合并（FR-G1）。
 *
 * `mergeSpread` / `patchExplainForSpread` / `attachShadow` 是**本模块内部**的实现步骤，
 * 刻意不从 barrel（`src/core/scoring.ts`）导出：对外只有 `scoreCards` 一个入口。
 *
 * @module dsh-memory/core/scoring/spread
 */

import type { MemoryConfig } from '../config.ts'
import { applySpread, buildAdjacency, spreadActivation } from '../spread.ts'
import type { SpreadBoost } from '../spread.ts'
import { truncate } from '../text.ts'
import type { MemoryCard, MemoryEdge, ScoredCard } from '../types.ts'
import { fmt } from './render.ts'
import { scoreCard } from './score.ts'
import type { RecallQuery } from './score.ts'

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
  // ## 种子判据必须与护栏同尺（缺陷三十二）
  //
  // 上面刚说过「护栏与被护栏的量必须在同一把尺子上」——而**种子判据曾经不是**。
  // 它拿 `total` 算相对门槛，护栏拿 `relevance`，于是两道闸各用一把尺子：
  //
  //   total     有 0.48 的权重（importance / recency / confidence）与查询无关，
  //             它给每张卡垫了一层共同地板，把相对离散度压平。
  //             实测同质语料 最小/最大 = 0.9059，异质语料 0.9655。
  //   relevance 是纯相关性，离散度 0.7237 / 0.8158。
  //
  // `seedRatio = 0.85` 落在 `total` 的离散区间（0.91~0.97）**之下**，
  // 于是「所有卡都是种子」，受益者恒为 0，扩散在数学上又恒为空。
  // 实测 off / shadow / on 三种模式的总分**逐位相同**、影子观察值 0 条——
  // 和缺陷二十六之前那次恒为空**表现完全一样**，但根因在另一半。
  //
  // 同一个教训：「阈值换尺子之后，所有拿它做乘数的护栏都要逐个复查，
  // 而它们的失效方式一律是恒真。」缺陷二十六只复查了护栏那一半，
  // 种子这一半漏了。**两道闸用两把尺子，恒空只是时间问题。**
  //
  // 换成 relevance 后实测：同质语料种子 3/7、受益者 4；异质语料种子 2/3、
  // 受益者 1。注意 `maxScore` 也必须取 relevance 的最大值，否则门槛与
  // 判据又不同尺。
  const maxScore = scored.reduce((m, item) => (item.score.relevance > m ? item.score.relevance : m), 0)
  const seedFloor = maxScore * config.spread.seedRatio
  const seeds = scored
    .filter((item) => item.score.relevance >= seedFloor)
    // 种子的能量仍用 `total`：那是「这张卡有多强」的完整度量，
    // 撒出去的激活量应该按它算，而不是按相关分量算。
    // 判据用 relevance（够不够格当种子），能量用 total（能撒多少）——
    // 两个用途不同，用不同的量是**刻意的**，不是又一处尺子错配。
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
