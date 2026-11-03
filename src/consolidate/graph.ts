/**
 * 图谱连边：把孤立卡片织成记忆图谱（Memory Graph）。
 *
 * 设计依据：
 * - 起源 L15（无编号·记忆图谱跨层次关联）「我需要一种建立记忆图谱的方法」——本文件是它的落地。
 * - 需求 FR-C1「夜整理最小集」里的「重建索引」部分：连边是可重建的派生视图（FR-A7）。
 * - 原则 P2「事件日志是唯一真相源」：边只由卡片内容算出，任何时刻可丢可重建。
 *
 * 两种边：
 * - `same-entity`：共享实体锚点（同一个人、同一个项目、同一个文件），
 *   这是「跨层次关联」的主通道——实体天然跨域、跨类型。
 * - `same-topic`：文本相似度落在 [relatedSimilarity, duplicateSimilarity) 区间。
 *   低于 related 的是无关；达到 duplicate 的交给去重合并，不该再留一条边。
 *
 * 边 id 用 {@link buildEdgeId} 派生，因此「同起点 + 同终点 + 同关系」天然只有一条边，
 * 反复整理不会产生重复边（ST-2 幂等）。
 *
 * 边对象本身的构造（id 派生、边权稳定化）不在这里，而在 `src/core/graph.ts`——
 * 那是契约级的规则，数据面（`src/store/state.ts` 重放 `merge` 时自动建
 * `supersedes` 边）也要用同一份，不能各写一遍。
 *
 * @module dsh-memory/consolidate/graph
 */

import type { MemoryCard, MemoryEdge } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'
import { makeEdge } from '../core/graph.ts'
import { jaccard, normalizeText, tokenSet } from '../core/text.ts'

/**
 * 实体的归一化键。
 *
 * `normalizeText` 已经做了全角转半角、小写化、去掉标点与符号——
 * 而路径分隔符 `/` 与 `\\` 都属于标点，会被一并抹平。因此 Windows 的
 * `src\\a.ts` 与 Unix 的 `src/a.ts` 得到同一个键，符合「同一个文件就是同一个锚点」。
 *
 * @param entity - 原始实体字符串。
 * @returns 归一化键。
 */
function entityKey(entity: string): string {
  return normalizeText(entity)
}

/**
 * 取一张卡的实体键集合。
 *
 * @param card - 记忆卡。
 * @returns 去重后的实体键集合。
 */
function entityKeysOf(card: MemoryCard): Set<string> {
  const keys = new Set<string>()
  for (const entity of card.entities) {
    const key = entityKey(entity)
    if (key.length > 0) keys.add(key)
  }
  return keys
}

/**
 * 构建记忆图谱的全部边。
 *
 * 输入只取 `active` 且未被合并的卡：归档卡已退出活跃视图，不再连新边；
 * 被合并掉的卡由合并后的卡代表，否则图谱里会留下一堆指向幽灵节点的边。
 *
 * 处理顺序：先按「创建时间 + id」稳定排序，再建 `same-entity`，最后建 `same-topic`。
 * 排序是为了让「同样的卡集合」无论以什么顺序传入，产出的边数组完全一致（ST-1）。
 *
 * 同一对卡可能既有实体关联又有话题关联，此时两条边都保留——
 * 关系是正交的语义轴，合并会丢信息。
 *
 * @param cards - 候选卡。
 * @param config - 完整配置。
 * @param now - 建立时刻（毫秒时间戳），由调用方传入。
 * @returns 边数组，顺序稳定，id 幂等。
 */
export function buildEdges(
  cards: readonly MemoryCard[], config: MemoryConfig, now: number,
): MemoryEdge[] {
  const pool = [...cards]
    .filter((card) => card.status === 'active' && card.mergedInto === undefined)
    .sort((x, y) => {
      if (x.createdAt !== y.createdAt) return x.createdAt - y.createdAt
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
    })
  if (pool.length < 2) return []

  const edges: MemoryEdge[] = []
  const seen = new Set<string>()
  const push = (edge: MemoryEdge): void => {
    if (edge.from === edge.to) return
    if (seen.has(edge.id)) return
    seen.add(edge.id)
    edges.push(edge)
  }

  const keysById = new Map<string, Set<string>>()
  for (const card of pool) keysById.set(card.id, entityKeysOf(card))

  // 一、实体边：双向度数上限 + 贪心取边（P2-9）。
  //
  // 加这个上限之前，`same-entity` 是**全量两两连边**：共享同一实体的卡互相连满，
  // 边数 O(n²)。实测生产 5000 张卡 → 122500 条 entity 边、130000 条总边、
  // 3621 ms，违反 P8「耗时可控」。
  //
  // 现在边数上界是 **`n × entityNeighbors / 2`**（双向计数：每条边同时占用
  // 两端的额度，所以是 n×K 的一半，不是 n×K）。这个 /2 不能漏写——
  // 写成 `n × entityNeighbors` 会让审计者按 40000 去核对实测 19990，
  // 误判成「实现只做到一半」。
  //
  // **诚实边界一：上限约束的是「边数」，不是「候选计算量」。** 候选对仍然要
  // 按实体桶两两枚举，所以计算量仍是 O(Σ|桶|²)，耗时仍随 n² 增长。
  // 同规模对照实测（单个高频实体桶，全部卡共享同一实体，话题边关断）：
  //
  //   n= 500：边 124750 → 1990，耗时 216 ms →  58 ms（3.7x）
  //   n=1000：边 499500 → 3996，耗时 873 ms → 145 ms（6.0x）
  //   n=2000：边 1999000 → 7993，耗时 4749 ms → 842 ms（5.6x）
  //
  // 所以上限**确实**把耗时降下来了（同规模 4~6 倍），但**没有**把它变成线性：
  // K=8 下 n 从 1000 到 5000，耗时 231 → 9842 ms，仍是平方级。
  // 换句话说：P2-9 修的是「图谱被撑爆」，耗时只是顺带改善，**不是根治**。
  // 要真正降耗时，必须限制桶大小或改成分桶采样，那是另一件事，本轮没做。
  // （写这段时踩过一次：第一版对比用的是「n=2000 无上限 5200 ms」对
  //  「n=5000 有上限 9627 ms」，跨了规模，得出「加了上限反而更慢」的假结论。
  //  同一张表里两个数字必须同规模，否则它证明的是规模差异，不是上限效果。）
  //
  // **诚实边界二：产出顺序变了。** 改成「全局候选排序后贪心」之后，边数组
  // 的顺序变成按 `(权重, from, to)` 排序；旧实现是按实体桶顺序产出。
  // 探针实测 36 组稀疏语料**顺序全部改变、集合全部相同**（默认 K=8 时
  // 度数 ≤ 8 的卡一条边都不会被砍）。边是集合语义、id 由 `buildEdgeId`
  // 派生、唯一消费者 `nightly.ts` 只按 id 过滤，所以顺序不影响结果——
  // 但「默认值不改变任何东西」是句假话，别这么写。
  //
  // `entityNeighbors > 0` 是**性能短路**，与下面 `topicNeighbors` 的 `k > 0`
  // 同一口径：0 表示不建 entity 边，此时度数检查 `0 >= 0` 恒真、一条边也产不出来，
  // 保留判断是为了跳过 O(n²) 的候选计算。语义上「0 = 关断」而不是「0 = 未定义」。
  //
  // 短路必须**包住整个候选计算**（实体索引 + 卡对聚合 + 挑选），而不只是
  // 包住挑选那一步：真正的 O(n²) 在「按实体桶做两两聚合」那一层——一个
  // 5000 卡的实体桶要枚举 C(5000,2) = **12497500** 个卡对。只短路挑选那一步
  // 的话，配成 0 仍然会跑满 O(n²)，「关断能省时间」就是一句假话。
  // （这里原写「122500 个卡对」，是把**全库边数**误抄成了**单桶卡对数**，
  //  两个数量级差 100 倍；实测 n=5000 全量边数 122500 是另一个量。）
  const entityK = config.graph.entityNeighbors
  if (entityK > 0) {
    // 二、实体锚点索引：实体键 → 持有该实体的卡 id 列表。
    const byEntity = new Map<string, string[]>()
    for (const card of pool) {
      const keys = keysById.get(card.id)
      if (keys === undefined) continue
      for (const key of keys) {
        const holders = byEntity.get(key)
        if (holders === undefined) byEntity.set(key, [card.id])
        else holders.push(card.id)
      }
    }

    // 三、按「卡对」聚合共享实体。
    const pairs = new Map<string, { from: string; to: string; shared: number }>()
    for (const holders of byEntity.values()) {
      if (holders.length < 2) continue
      for (let i = 0; i < holders.length; i += 1) {
        const from = holders[i]
        if (from === undefined) continue
        for (let j = i + 1; j < holders.length; j += 1) {
          const to = holders[j]
          if (to === undefined || to === from) continue
          const pairKey = from < to ? `${from}\u0003${to}` : `${to}\u0003${from}`
          const existing = pairs.get(pairKey)
          if (existing === undefined) pairs.set(pairKey, { from, to, shared: 1 })
          else existing.shared += 1
        }
      }
    }

    // 先算出全部候选对，再统一挑选——理由与话题边相同：下面要按「双方度数
    // 都还有余量」的顺序贪心取边，而不是按单向分数。
    const candidates: { from: string; to: string; weight: number }[] = []
    for (const pair of pairs.values()) {
      // 重合度 = 共享实体数 / 双方实体并集大小，而 |A ∪ B| = |A| + |B| − |A ∩ B|。
      const sizeFrom = keysById.get(pair.from)?.size ?? 0
      const sizeTo = keysById.get(pair.to)?.size ?? 0
      const unionSize = sizeFrom + sizeTo - pair.shared
      const weight = unionSize <= 0 ? 0 : pair.shared / unionSize
      candidates.push({ from: pair.from, to: pair.to, weight })
    }
    // 排序键必须完全确定：权重降序，同权重按 (from, to) 升序。
    // 只按分数排会让同权对的取舍依赖数组顺序，破坏 ST-1 确定性——
    // 而 entity 边**比话题边更容易同权**：共享单个实体的卡对权重恒为
    // `1 / (|A| + |B| − 1)`，一簇大小相同的卡会产出一大批完全相同的权重。
    // 所以这个次级排序键在这里不是「保险」，是主要判据。
    candidates.sort((x, y) => {
      if (x.weight !== y.weight) return y.weight - x.weight
      if (x.from !== y.from) return x.from < y.from ? -1 : 1
      return x.to < y.to ? -1 : x.to > y.to ? 1 : 0
    })
    // 贪心取边，**两个端点各自都受 `entityNeighbors` 约束**。
    //
    // 为什么必须双向计数（与 `topicNeighbors` 同因）：配置名承诺的是「每张卡
    // 最多连几条」，而用户看到的度数是**入度 + 出度**。只限制单向时，一张卡
    // 可以自己选 K 个邻居、又被 K 个别人选中，度数到 2K，配置名就成了谎话。
    //
    // 诚实边界：两条边是正交语义轴，同一对卡可能既有 entity 边又有 topic 边，
    // 所以单卡**总**度数上界是 `entityNeighbors + topicNeighbors`，不是 8。
    const degree = new Map<string, number>()
    for (const candidate of candidates) {
      const fromDeg = degree.get(candidate.from) ?? 0
      const toDeg = degree.get(candidate.to) ?? 0
      if (fromDeg >= entityK || toDeg >= entityK) continue
      degree.set(candidate.from, fromDeg + 1)
      degree.set(candidate.to, toDeg + 1)
      push(makeEdge(candidate.from, candidate.to, 'same-entity', candidate.weight, now))
    }
  }

  // 四、话题边：k 近邻 + 绝对下限。
  //
  // 原先是「相似度落在 [relatedSimilarity, duplicateSimilarity) 之间就连边」，
  // 即纯绝对阈值。两个问题：
  //
  // 1. **作用域错了**：`relatedSimilarity`（0.45）是为去重标定的，衡量的是
  //    「是不是在说同一件事」。连边要的是「有没有关系」，弱得多。实测真实
  //    中文语料上相似度 99.9 分位只有 0.275，0.45 落在极尾 ⇒ 图谱恒空。
  // 2. **边数随语料漂移**：绝对阈值下边数是 O(n²) 的函数，3000 卡时可能
  //    上万条，违反 P8「耗时可控」。
  //
  // 改成 k-NN 后边数上界是 `n × topicNeighbors`，与语料规模无关；
  // `topicFloor` 只作下限兜底，防止给完全无关的卡强行连边。
  // 实测同量级边数下精确率 57.5% vs 绝对阈值 50.7%，孤立卡 62 vs 143。
  const floor = config.graph.topicFloor
  const upper = config.dedup.duplicateSimilarity
  const k = config.graph.topicNeighbors
  const cache = new Map<string, Set<string>>()
  const tokensOf = (card: MemoryCard): Set<string> => {
    const hit = cache.get(card.id)
    if (hit !== undefined) return hit
    const built = tokenSet(card.normalized.length > 0 ? card.normalized : normalizeText(card.text))
    cache.set(card.id, built)
    return built
  }
  // `k > 0` 是**性能短路**，不是行为开关：k=0 时下面的度数检查 `0 >= 0`
  // 恒为真，一条边也产不出来。保留它是为了在关断时跳过 O(n²) 的候选
  // 计算——反向验证里把这里改成 `if (true)` 是**等价变异**（fail=0），
  // 那正好证明了它是纯性能优化。
  if (k > 0) {
    // 全局候选对：只保留相似度落在 [floor, upper) 的。先全算出来再统一挑选，
    // 因为下面要按「双方度数都还有余量」的顺序贪心取边，而不是按单向分数。
    const candidates: { from: string; to: string; similarity: number }[] = []
    for (let i = 0; i < pool.length; i += 1) {
      const left = pool[i]
      if (left === undefined) continue
      const leftTokens = tokensOf(left)
      for (let j = i + 1; j < pool.length; j += 1) {
        const right = pool[j]
        if (right === undefined) continue
        const similarity = jaccard(leftTokens, tokensOf(right))
        if (!(similarity >= floor) || similarity >= upper) continue
        candidates.push({ from: left.id, to: right.id, similarity })
      }
    }
    // 排序键必须完全确定：分数降序，同分按 (from, to) 升序。
    // 只按分数排会让同分对的取舍依赖数组顺序，破坏 ST-1 确定性。
    candidates.sort((x, y) => {
      if (x.similarity !== y.similarity) return y.similarity - x.similarity
      if (x.from !== y.from) return x.from < y.from ? -1 : 1
      return x.to < y.to ? -1 : x.to > y.to ? 1 : 0
    })
    // 按全局分数从高到低贪心取边，**两个端点各自都受 K 约束**。
    //
    // 为什么必须双向计数：`topicNeighbors` 这个配置名承诺的是「每张卡最多
    // 连几条边」，而用户看到的度数是**入度 + 出度**。只限制单向出度时，
    // 一张卡可以自己选 2 个邻居、又被 3 个别人选中，最终度数 5 > K，
    // 配置项的名字就成了谎话。实测 4 张卡 K=2 时卡 a 的度数确实到了 3。
    //
    // 代价：双向约束让结果略少于 n×K/2，换来的是「配置值即上界」这个
    // 可以对外承诺的性质。
    const degree = new Map<string, number>()
    for (const candidate of candidates) {
      const fromDeg = degree.get(candidate.from) ?? 0
      const toDeg = degree.get(candidate.to) ?? 0
      if (fromDeg >= k || toDeg >= k) continue
      degree.set(candidate.from, fromDeg + 1)
      degree.set(candidate.to, toDeg + 1)
      push(makeEdge(candidate.from, candidate.to, 'same-topic', candidate.similarity, now))
    }
  }

  return edges
}

/**
 * 实体重合度：两张卡共享的实体数 / 双方实体并集大小。
 *
 * 单独导出是因为它同时服务于「连边」和「解释为什么连边」（FR-B4 可解释）。
 * 大小写不敏感、全半角不敏感、路径分隔符不敏感。
 *
 * @param a - 卡 A。
 * @param b - 卡 B。
 * @returns 0..1 的重合度；任一卡无实体时返回 0。
 */
export function entityOverlap(a: MemoryCard, b: MemoryCard): number {
  return jaccard(entityKeysOf(a), entityKeysOf(b))
}
