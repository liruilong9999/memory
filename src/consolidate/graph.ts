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
 * @module dsh-memory/consolidate/graph
 */

import type { EdgeRelation, MemoryCard, MemoryEdge } from '../core/types.ts'
import { buildEdgeId } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'
import { jaccard, normalizeText, tokenSet } from '../core/text.ts'
import { clamp01 } from './decay.ts'

/**
 * 把数值压到两位小数的确定值，用于边权。
 *
 * 为什么做这一步：浮点运算的末位在不同 V8 版本 / 不同求和顺序下可能抖动，
 * 而边权会写进日志、参与打分。先四舍五入到两位小数，能让「同样输入同样输出」
 * 在跨版本重放时也成立（ST-1）。
 *
 * @param value - 原始数值。
 * @returns 0..1 之间、精度为 0.01 的数值。
 */
function stableWeight(value: number): number {
  return Math.round(clamp01(value) * 100) / 100
}

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
 * 构造一条边，边权做稳定化处理。
 *
 * @param from - 起点卡 id。
 * @param to - 终点卡 id。
 * @param relation - 边语义。
 * @param weight - 原始边权。
 * @param now - 建立时刻。
 * @returns 新的边对象。
 */
function makeEdge(
  from: string, to: string, relation: EdgeRelation, weight: number, now: number,
): MemoryEdge {
  return { id: buildEdgeId(from, to, relation), from, to, relation, weight: stableWeight(weight), createdAt: now }
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

  // 一、实体锚点索引：实体键 → 持有该实体的卡 id 列表。
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

  // 二、按「卡对」聚合共享实体。
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
  for (const pair of pairs.values()) {
    // 重合度 = 共享实体数 / 双方实体并集大小，而 |A ∪ B| = |A| + |B| − |A ∩ B|。
    const sizeFrom = keysById.get(pair.from)?.size ?? 0
    const sizeTo = keysById.get(pair.to)?.size ?? 0
    const unionSize = sizeFrom + sizeTo - pair.shared
    const weight = unionSize <= 0 ? 0 : pair.shared / unionSize
    push(makeEdge(pair.from, pair.to, 'same-entity', weight, now))
  }

  // 三、话题边：相似度落在 [relatedSimilarity, duplicateSimilarity) 之间。
  const lower = config.dedup.relatedSimilarity
  const upper = config.dedup.duplicateSimilarity
  const cache = new Map<string, Set<string>>()
  const tokensOf = (card: MemoryCard): Set<string> => {
    const hit = cache.get(card.id)
    if (hit !== undefined) return hit
    const built = tokenSet(card.normalized.length > 0 ? card.normalized : normalizeText(card.text))
    cache.set(card.id, built)
    return built
  }
  for (let i = 0; i < pool.length; i += 1) {
    const left = pool[i]
    if (left === undefined) continue
    for (let j = i + 1; j < pool.length; j += 1) {
      const right = pool[j]
      if (right === undefined) continue
      const similarity = jaccard(tokensOf(left), tokensOf(right))
      if (!(similarity >= lower) || similarity >= upper) continue
      push(makeEdge(left.id, right.id, 'same-topic', similarity, now))
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
