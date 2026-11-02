/**
 * 图谱扩散激活（spreading activation）与突触可塑性（synaptic plasticity）。
 *
 * ## 这个文件对应起源的哪一条
 *
 * 起源 L15（无编号·图谱）：「我需要一种建立记忆图谱的方法，且跨层次关联。」
 *
 * 「跨层次关联」如果只是把边存进日志、查询时能看见，图谱就只是一张示意图：
 * 一张卡被想起时，与它相连的卡**不会因此更容易被想起**。真正让「关联」成立的
 * 是激活能沿边流动——这正是本文件做的事。
 *
 * 需求归属：`docs/1-需求规格.md` FR-G1「突触学习与图谱扩散」。
 * 该条在 §7.7「后续扩展」中，触发条件是「稳定记忆跑通、积累了 2 周真实数据」。
 * 本文件实现其**规则部分**：不含任何语义判断，不产出新边，只让已有边参与计算。
 *
 * ## 为什么全部是纯函数（ST-1）
 *
 * 扩散结果必须可复现：同样的候选集 + 同样的边 + 同样的配置，必须得到同样的分数。
 * 因此这里不读时钟、不读全局状态、不做 IO，时刻与随机性一律由调用方传入。
 * 迭代顺序也不依赖 `Map`/`Set` 的插入顺序，而是显式排序后再遍历——否则
 * 「同一个库在两台机器上重放得到不同排序」会成为无法复现的幽灵 bug。
 *
 * ## 两个机制的边界（说清它做不到什么）
 *
 * 1. **扩散不改变「够不够格」，只改变「排多前」。** 扩散收益受 `maxBoost` 限制，
 *    且受 `minSelfScoreRatio` 护栏约束：自身分数不达标的卡，扩散也救不了它。
 *    这条约束是为了保住 `absoluteThreshold` 的语义——阈值问的是「这条记忆本身
 *    够不够格」，不是「它的邻居够不够格」。
 * 2. **可塑性只改边权，不改边的存在与否**（除剪枝外），且边权变化必须由
 *    「共激活」这一可审计信号驱动。
 *
 * ## 可塑性目前**未接线**——不要以为它已经生效
 *
 * `reinforceEdges` / `decayEdges` / `prunableEdges` 三个函数已实现且通过测试，
 * 但**没有任何生产代码调用它们**，且 `spread.plasticityEnabled` 默认为 `false`。
 * 也就是说：真实运行中边权**从不变化**，始终停在建立时的初始值。
 *
 * 为什么不接上去：可塑性的驱动信号是「共激活」（这两张卡被一起用上了）。
 * 仓库里唯一能提供该信号的入口是 `Engine.confirmRecall`，而它**零调用方**
 * （原因见 `docs/3-架构设计.md` 与 AGENTS.md：确认信号必须来自「这条记忆
 * 真的影响了输出」的可审计证据，而非「被展示过」）。
 *
 * 已否决的三个替代信号（写在这里是因为它们看起来都很合理，会有人再提一次）：
 * - **把「被一起召回」当共激活**：召回是「看见」，不是「使用」。用它驱动强化，
 *   等于「一起被展示过的记忆互相加固」，会让焦点包逐渐自我固化——正是
 *   起源 L29（第 5 条·专注当前位置）要抑制的那种自我强化。
 * - **把「夜整理时同批处理」当共激活**：同批只是「同一天」，与「一起被用上」
 *   无关，且日摘要会批量处理几百张卡，一晚上能把整个图谱拉满权重。
 * - **把「上轮焦点包与本轮重叠」当共激活**：会让 recall 变成有状态的，
 *   「看见」间接影响「看见」，同一段对话里越看越强，同样违反 L29。
 *
 * 因此本模块的诚实状态是：**扩散已生效，可塑性是待接线的能力，不是已生效的
 * 功能。** 接上它的前提是 `confirmRecall` 有了真实调用方；在那之前打开
 * `plasticityEnabled` 只会让三个函数被调用而共激活集合始终为空，什么也不会发生。
 */

import type { EdgeRelation, MemoryEdge, MemoryCard } from './types.ts'
import type { MemoryConfig } from './config.ts'

/**
 * 把数值夹到 0..1。
 *
 * 这里刻意**不**从 `scoring.ts` 导入：`scoring.ts` 需要导入本文件的
 * `spreadActivation` 才能让扩散进入打分链路，若本文件反向导入 `scoring.ts`，
 * 两个模块就形成循环依赖。ESM 能容忍部分循环，但函数在模块初始化阶段
 * 被引用时会拿到 `undefined`——那类错误只在特定加载顺序下出现，极难复现。
 *
 * 六行重复换一个无环依赖图，这个交易是划算的。它是纯函数，没有「两份实现
 * 会漂移」的风险——漂移的前提是逻辑会演进，而夹取 0..1 不会演进。
 *
 * @param value - 待夹取的值。
 * @returns 落在 0..1 的值；非有限数一律返回 0。
 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 一条边在扩散时是否允许从 `from` 走到 `to`。
 *
 * `distills` 边的方向是「感受卡 → 来源事件卡」。起源 L11（无编号·细节会忘）
 * 说「大多数细节都会忘记，只会留下感受」——那么想起细节时，感受**应该**
 * 更容易浮现。严格按有向边传播会让这件事永远不发生，所以在
 * `spread.distillBidirectional` 打开时，只有 `distills` 允许反向。
 *
 * 其余边保持严格单向：`supersedes` 反向传播会让「新版本」把激活传回
 * 「已被取代的旧版本」，那是把废弃内容重新推上台面，与 FR-A5 相反。
 *
 * @param edge - 待判断的边。
 * @param reversed - 是否为反向遍历（true 表示正在问「能否从 to 走到 from」）。
 * @param config - 配置。
 * @returns 是否允许沿该方向传播。
 */
export function canTraverse(
  edge: MemoryEdge, reversed: boolean, config: MemoryConfig,
): boolean {
  // 参与扩散的关系白名单。不在这里的边（`supersedes` 与三类无产出语义边）
  // 一律不传播——理由见 {@link isDiffusible}。
  if (!isDiffusible(edge.relation)) return false
  if (!reversed) return true
  return edge.relation === 'distills' && config.spread.distillBidirectional
}

/** 邻接表：卡 id → 出边列表。 */
export type Adjacency = ReadonlyMap<string, readonly MemoryEdge[]>

/**
 * 由边集构造双向可用的邻接表。
 *
 * 表里同时存「正向」与「允许的反向」两种视图，遍历时用 `canTraverse` 判定，
 * 这样调用方不需要关心方向规则，规则只有一处。
 *
 * 排序是**必要**的：`Map` 的迭代顺序依赖插入顺序，而插入顺序依赖日志重放顺序。
 * 若不排序，同一份数据在不同重放路径下会得到不同的扩散累加次序，浮点加法
 * 不满足结合律，最终分数会出现末位差异——ST-1 要求「可重复调用得到相同结果」，
 * 末位差异已经违反了它。
 *
 * @param edges - 全部边。
 * @returns 邻接表。
 */
export function buildAdjacency(edges: readonly MemoryEdge[]): Adjacency {
  const map = new Map<string, MemoryEdge[]>()
  const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const edge of sorted) {
    const fromList = map.get(edge.from)
    if (fromList === undefined) map.set(edge.from, [edge])
    else fromList.push(edge)
    // 反向视图也建起来：是否需要反向由 `canTraverse` 在遍历时判定，
    // 建表阶段不做语义判断，避免规则散落两处。
    const toList = map.get(edge.to)
    if (toList === undefined) map.set(edge.to, [edge])
    else toList.push(edge)
  }
  return map
}

/** 一张卡的扩散输入：自身分数与 id。 */
export interface SpreadSeed {
  /** 卡片 id。 */
  id: string
  /** 自身归一化总分（0..1）。 */
  score: number
}

/** 单张卡的扩散结果。 */
export interface SpreadBoost {
  /** 卡片 id。 */
  id: string
  /** 获得的加分（0..`maxBoost`）。 */
  boost: number
  /**
   * 激活来源卡 id，按贡献降序。
   *
   * 保留它是因为 FR-B4 要求「能回答为什么想起这条」。只说「扩散得分 0.08」
   * 无法让人核对，说「因为 A 卡（同实体）传过来」才能。
   */
  sources: readonly string[]
}

/**
 * 计算扩散激活。
 *
 * 算法：从每个种子出发，沿边做广度优先传播，每跳乘以 `hopDecay` 与边权，
 * 累加到目标卡；累加后按 `maxBoost` 截平，按 `minSelfScoreRatio` 过滤，
 * 按 `maxAffected` 截断。
 *
 * ## 为什么按「源」而不是按「跳」迭代
 *
 * 按跳迭代（第 1 跳算完再算第 2 跳）需要维护一个「当前激活量」的中间表，
 * 且要处理「同一跳内先算的卡影响后算的卡」的顺序问题——那会让结果依赖
 * 遍历顺序，破坏 ST-1。这里改为**对每个种子独立做 BFS**，各自的激活量
 * 只在它自己的 BFS 内流动，多个种子的贡献最后线性相加。线性相加与顺序无关，
 * 所以结果是确定的。
 *
 * ## 为什么要护栏
 *
 * 没有 `minSelfScoreRatio` 时，一张自身分数 0.05 的卡只要挨着一个强命中，
 * 就能被推进焦点包——`absoluteThreshold` 从此只对「孤立的卡」有效，
 * 而这正是最坏的情况：**阈值看起来还在，实际上只对没朋友的那部分数据生效。**
 *
 * @param seeds - 已命中的卡及其分数。
 * @param adjacency - 邻接表（由 {@link buildAdjacency} 构造）。
 * @param selfScores - 全部候选卡的自身分数（用于护栏判定）。
 * @param config - 配置。
 * @returns 每张获得加分的卡一条记录，按加分降序、id 升序稳定排列。
 */
export function spreadActivation(
  seeds: readonly SpreadSeed[],
  adjacency: Adjacency,
  selfScores: ReadonlyMap<string, number>,
  config: MemoryConfig,
): SpreadBoost[] {
  const sp = config.spread
  if (!sp.enabled) return []
  if (seeds.length === 0) return []

  // 护栏下限：自身分数必须达到 absoluteThreshold × minSelfScoreRatio。
  // minSelfScoreRatio 由配置层保证 ≥ 1，所以这条下限**不会低于**绝对阈值。
  const selfFloor = config.recall.absoluteThreshold * sp.minSelfScoreRatio

  const accumulated = new Map<string, number>()
  const sourcesOf = new Map<string, string[]>()

  // 种子按 id 排序，保证多种子累加顺序固定（浮点加法不满足结合律）。
  const orderedSeeds = [...seeds].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  for (const seed of orderedSeeds) {
    // 单个种子的 BFS：visited 防环（边集可能成环，`same-topic` 天然对称）。
    const visited = new Set<string>([seed.id])
    let frontier: { id: string; energy: number }[] = [{ id: seed.id, energy: seed.score }]

    for (let hop = 0; hop < sp.maxHops; hop += 1) {
      const next: { id: string; energy: number }[] = []
      for (const node of frontier) {
        const edges = adjacency.get(node.id)
        if (edges === undefined) continue
        for (const edge of edges) {
          // 判断这条边在这个方向上能否走：正向直接走，反向看 canTraverse。
          const reversed = edge.from !== node.id
          if (reversed && !canTraverse(edge, true, config)) continue
          const target = reversed ? edge.from : edge.to
          if (visited.has(target)) continue
          visited.add(target)

          // 传播能量 = 上游能量 × 边权 × 每跳衰减。
          // 边权参与是「突触」的核心：连接越强，传得越多。
          const energy = node.energy * edge.weight * sp.hopDecay
          if (energy <= 0) continue
          next.push({ id: target, energy })

          // 累加（同一目标可能被多条路径/多个种子触达）。
          const prev = accumulated.get(target) ?? 0
          accumulated.set(target, prev + energy)
          const list = sourcesOf.get(target)
          if (list === undefined) sourcesOf.set(target, [seed.id])
          else if (!list.includes(seed.id)) list.push(seed.id)
        }
      }
      if (next.length === 0) break
      frontier = next
    }
  }

  const results: SpreadBoost[] = []
  for (const [id, raw] of accumulated) {
    // 种子自身不因扩散加分：它的分数已经由自身维度算出来了，
    // 再给自己加一份等于「命中自己还额外奖励」，那是重复计分。
    if (seeds.some((s) => s.id === id)) continue
    // 护栏：自身不够格的卡，扩散不给它加分。
    const selfScore = selfScores.get(id)
    if (selfScore === undefined || selfScore < selfFloor) continue
    const boost = Math.min(sp.maxBoost, raw)
    if (boost <= 0) continue
    results.push({ id, boost, sources: sourcesOf.get(id) ?? [] })
  }

  // 排序：加分降序，同分按 id 升序（稳定，不依赖 Map 迭代顺序）。
  results.sort((a, b) => {
    if (b.boost !== a.boost) return b.boost - a.boost
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  // 受影响面截断：只保留最强的 maxAffected 张。
  return results.slice(0, sp.maxAffected)
}

/**
 * 把扩散加分合并进已排序的候选列表。
 *
 * 需求 FR-B2：阈值截断必须看到**最终分数**。所以扩散必须在
 * `applyThresholds` **之前**完成，否则「扩散把卡推进了焦点包」永远不会发生。
 *
 * ## 加分为什么不参与归一化
 *
 * 归一化分是「自身维度的加权平均」，取值范围 0..1。扩散加分是**外部证据**
 * （「你的邻居被命中了」），它不是这张卡自身的属性。若把它塞进归一化分子，
 * 等于把「邻居的语义匹配度」算成「这张卡的语义匹配度」，`explain` 会开始撒谎。
 * 所以加分直接加在总分上，并单独记录在 `spreadBoost` 字段里供解释使用。
 *
 * @param scored - 已打分并按自身分数排序的候选。
 * @param boosts - 扩散结果。
 * @returns 合并加分后的新数组（不修改入参，ST-1）。
 */
export function applySpread<T extends { card: MemoryCard; score: { total: number } }>(
  scored: readonly T[], boosts: readonly SpreadBoost[],
): (T & { spreadBoost: number; spreadSources: readonly string[] })[] {
  const byId = new Map(boosts.map((b) => [b.id, b]))
  return scored.map((item) => {
    const hit = byId.get(item.card.id)
    if (hit === undefined) return { ...item, spreadBoost: 0, spreadSources: [] }
    return {
      ...item,
      score: { ...item.score, total: clamp01(item.score.total + hit.boost) },
      spreadBoost: hit.boost,
      spreadSources: hit.sources,
    }
  })
}

/**
 * 边权强化：共激活的一对卡之间的边变强（赫布学习）。
 *
 * 「一起被激活的神经元连得更紧」。这里严格限定为**已经存在边**的一对卡——
 * 本函数不新建边。理由：新建边需要语义判断（这两张卡是什么关系？），
 * 那是 `consolidate/graph.ts` 的策略职责，不该在可塑性里偷偷发生。
 *
 * @param edges - 当前边集。
 * @param coActivated - 本次共激活的卡 id 集合。
 * @param config - 配置。
 * @returns 需要更新的边（含新权重），未变化的边不返回。
 */
export function reinforceEdges(
  edges: readonly MemoryEdge[], coActivated: ReadonlySet<string>, config: MemoryConfig,
): MemoryEdge[] {
  const sp = config.spread
  if (!sp.plasticityEnabled) return []
  if (coActivated.size < 2) return []

  const updated: MemoryEdge[] = []
  const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const edge of sorted) {
    // 只有两端都在本次共激活集合里，才算「一起被激活」。
    if (!coActivated.has(edge.from) || !coActivated.has(edge.to)) continue
    const next = Math.min(sp.maxEdgeWeight, edge.weight + sp.reinforceDelta)
    // 权重没变（已在上限）时不产生更新，避免日志里堆积无意义的记录。
    if (next === edge.weight) continue
    updated.push({ ...edge, weight: Math.round(next * 100) / 100 })
  }
  return updated
}

/**
 * 边权衰减：所有边按 `decayFactor` 变弱（久不用的连接变细）。
 *
 * @param edges - 当前边集。
 * @param config - 配置。
 * @returns 需要更新的边。
 */
export function decayEdges(
  edges: readonly MemoryEdge[], config: MemoryConfig,
): MemoryEdge[] {
  const sp = config.spread
  if (!sp.plasticityEnabled) return []
  const updated: MemoryEdge[] = []
  const sorted = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (const edge of sorted) {
    const next = Math.round(edge.weight * sp.decayFactor * 100) / 100
    if (next === edge.weight) continue
    updated.push({ ...edge, weight: next })
  }
  return updated
}

/**
 * 突触剪枝：边权低于阈值的边被删除。
 *
 * 与衰减配对使用：衰减让所有边变弱，剪枝把弱到没有意义的边清掉。
 * 分开而不是合并成一个函数，是因为它们的**时机不同**——衰减每次都做，
 * 剪枝受 `maxPrunePerRun` 限制，可能需要多次整理才清完。
 *
 * @param edges - 当前边集。
 * @param config - 配置。
 * @returns 应被删除的边 id（按 id 升序，受 `maxPrunePerRun` 截断）。
 */
export function prunableEdges(
  edges: readonly MemoryEdge[], config: MemoryConfig,
): string[] {
  const sp = config.spread
  if (!sp.plasticityEnabled) return []
  const victims = edges
    .filter((edge) => edge.weight < sp.pruneThreshold)
    .map((edge) => edge.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return victims.slice(0, sp.maxPrunePerRun)
}

/**
 * 判断某种边关系是否参与扩散。
 *
 * 只有真正有产出点的边才该参与计算。`causes` / `part-of` / `contrasts`
 * 三类边当前**没有任何产出点**（见 `types.ts` 的说明），所以它们不可能出现在
 * 边集里；但若将来有人手工写入了这类边，扩散也不该假装它们有语义含义。
 *
 * 这个函数存在的意义是**把「哪些边算数」写成可执行代码**，而不是散落在注释里。
 *
 * @param relation - 边关系。
 * @returns 是否参与扩散。
 */
export function isDiffusible(relation: EdgeRelation): boolean {
  // `supersedes` 不参与：它表示「旧版本已被取代」，让激活沿它流动等于
  // 把废弃内容重新推上台面，与 FR-A5 的意图相反。
  // `distills` 参与：感受与来源事件之间的关联正是「想起细节就想起感受」的通道。
  return relation === 'same-topic'
    || relation === 'same-entity'
    || relation === 'distills'
}
