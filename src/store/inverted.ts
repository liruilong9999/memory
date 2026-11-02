/**
 * 倒排索引（Inverted Index）：把「查询词项」快速映射到「候选卡片」。
 *
 * 设计依据：
 * - FR-A7 索引可重建：索引是纯派生数据，随时可以丢掉重算，绝不影响真相源。
 *   因此 {@link buildIndex} 是纯函数，不读写任何外部状态。
 * - NFR-1 性能：万级记忆单次预取 < 50ms。用词项到 id 集合的倒排 + 命中数计数，
 *   查询成本只与查询词项数量相关，与库大小弱相关。
 * - ST-1 确定性：排序规则固定（先命中数降序，再 id 升序），不依赖 Map 插入顺序。
 *
 * @module dsh-memory/store/inverted
 */

import { normalizeText, tokenize } from '../core/text.ts'
import type { MemoryCard } from '../core/types.ts'

/**
 * 倒排索引。
 *
 * 只读结构：构建后不再修改，重建时整体替换，避免增量更新带来的不一致。
 */
export interface InvertedIndex {
  /** 词项 → 卡片 id 集合。 */
  postings: Map<string, Set<string>>
  /** 卡片 id → 词项集合，删除卡片时用于反查清理。 */
  documents: Map<string, Set<string>>
  /** 参与索引的卡片数。 */
  size: number
  /** 构建时刻，仅供日志与调试使用。 */
  builtAt: number
}

/**
 * 收集一张卡参与索引的全部词项。
 *
 * 四个来源：归一化文本、原文（再归一化一次防止不同步）、标签、实体。
 * 标签与实体是「跨层次关联」的连接点，必须进索引，否则按实体检索会漏。
 *
 * @param card - 卡片。
 * @returns 去重后的词项集合。
 */
export function collectTerms(card: MemoryCard): Set<string> {
  const terms = new Set<string>()
  for (const token of tokenize(card.normalized)) terms.add(token)
  for (const token of tokenize(normalizeText(card.text))) terms.add(token)
  for (const tag of card.tags) {
    for (const token of tokenize(normalizeText(tag))) terms.add(token)
  }
  for (const entity of card.entities) {
    for (const token of tokenize(normalizeText(entity))) terms.add(token)
  }
  return terms
}

/**
 * 从卡片集合构建倒排索引。
 *
 * 纯函数：同样的输入永远得到同样的输出（ST-1）。卡片文本用 `text` 与 `normalized`
 * 一起建索引——`normalized` 已归一化，直接用；`text` 再归一化一次，防止两者不同步。
 *
 * @param cards - 卡片集合（任意可迭代对象）。
 * @param builtAt - 构建时刻；省略时取 0，保证纯函数可复现。
 * @returns 全新的倒排索引。
 */
export function buildIndex(cards: Iterable<MemoryCard>, builtAt = 0): InvertedIndex {
  const postings = new Map<string, Set<string>>()
  const documents = new Map<string, Set<string>>()
  let size = 0
  for (const card of cards) {
    if (documents.has(card.id)) continue
    const terms = collectTerms(card)
    documents.set(card.id, terms)
    for (const term of terms) {
      const bucket = postings.get(term)
      if (bucket === undefined) postings.set(term, new Set<string>([card.id]))
      else bucket.add(card.id)
    }
    size += 1
  }
  return { postings, documents, size, builtAt }
}

/**
 * 从状态里的全部卡片构建索引。
 *
 * @param cards - 卡片 Map（直接传 `state.cards` 即可）。
 * @param builtAt - 构建时刻；省略时取 0。
 * @returns 倒排索引。
 */
export function buildIndexFromMap(cards: ReadonlyMap<string, MemoryCard>, builtAt = 0): InvertedIndex {
  return buildIndex(cards.values(), builtAt)
}

/** 一次查询的命中。 */
export interface IndexHit {
  /** 卡片 id。 */
  id: string
  /** 命中的词项数量。 */
  hits: number
}

/**
 * 查询候选卡片。
 *
 * 结果按「命中数降序，id 升序」排序——固定规则保证 ST-1 的确定性。
 * 只做词项匹配，不打分：打分是 `core/scoring` 的职责，索引只管把候选池缩到可承受的规模。
 *
 * @param index - 倒排索引。
 * @param terms - 查询词项集合（通常来自 `tokenize(normalizeText(query))`）。
 * @param limit - 候选池上限；省略表示不限制。
 * @returns 命中数组。
 */
export function searchIndex(index: InvertedIndex, terms: Iterable<string>, limit?: number): IndexHit[] {
  const counter = new Map<string, number>()
  for (const term of terms) {
    const bucket = index.postings.get(term)
    if (bucket === undefined) continue
    for (const id of bucket) counter.set(id, (counter.get(id) ?? 0) + 1)
  }
  const hits: IndexHit[] = []
  for (const [id, count] of counter) hits.push({ id, hits: count })
  hits.sort((a, b) => (b.hits - a.hits) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (limit !== undefined && limit >= 0 && hits.length > limit) return hits.slice(0, limit)
  return hits
}

/**
 * 便捷查询：直接从原文出发查候选。
 *
 * @param index - 倒排索引。
 * @param text - 查询原文。
 * @param limit - 候选池上限；省略表示不限制。
 * @returns 命中数组。
 */
export function searchText(index: InvertedIndex, text: string, limit?: number): IndexHit[] {
  return searchIndex(index, tokenize(normalizeText(text)), limit)
}

/**
 * 增量加一张卡（写路径专用，避免每次写入都全量重建）。
 *
 * @param index - 原索引（不会被修改）。
 * @param card - 新增卡片。
 * @param builtAt - 更新时间戳；省略时沿用原索引的时间戳。
 * @returns 新的索引。
 */
export function addToIndex(index: InvertedIndex, card: MemoryCard, builtAt?: number): InvertedIndex {
  const postings = new Map<string, Set<string>>()
  for (const [term, bucket] of index.postings) postings.set(term, new Set(bucket))
  const documents = new Map<string, Set<string>>()
  for (const [id, terms] of index.documents) documents.set(id, new Set(terms))
  const terms = collectTerms(card)
  const oldTerms = documents.get(card.id)
  // 同 id 覆盖写（例如 revise 改了摘要）时必须先摘掉旧词项，
  // 否则旧词项会一直指向这张卡，查询出现「幽灵命中」。
  if (oldTerms !== undefined) {
    for (const term of oldTerms) {
      if (terms.has(term)) continue
      const bucket = postings.get(term)
      if (bucket === undefined) continue
      bucket.delete(card.id)
      if (bucket.size === 0) postings.delete(term)
    }
  }
  documents.set(card.id, terms)
  for (const term of terms) {
    const bucket = postings.get(term)
    if (bucket === undefined) postings.set(term, new Set<string>([card.id]))
    else bucket.add(card.id)
  }
  return {
    postings,
    documents,
    size: oldTerms === undefined ? index.size + 1 : index.size,
    builtAt: builtAt ?? index.builtAt,
  }
}

/**
 * 增量删一张卡。
 *
 * @param index - 原索引（不会被修改）。
 * @param cardId - 卡片 id。
 * @param builtAt - 更新时间戳；省略时沿用原索引的时间戳。
 * @returns 新的索引。
 */
export function removeFromIndex(index: InvertedIndex, cardId: string, builtAt?: number): InvertedIndex {
  const terms = index.documents.get(cardId)
  if (terms === undefined) return index
  const postings = new Map<string, Set<string>>()
  for (const [term, bucket] of index.postings) {
    if (!terms.has(term)) {
      postings.set(term, new Set(bucket))
      continue
    }
    const next = new Set(bucket)
    next.delete(cardId)
    // 空桶直接删掉，避免索引里堆积大量无效词项。
    if (next.size > 0) postings.set(term, next)
  }
  const documents = new Map<string, Set<string>>()
  for (const [id, set] of index.documents) {
    if (id !== cardId) documents.set(id, new Set(set))
  }
  return { postings, documents, size: Math.max(0, index.size - 1), builtAt: builtAt ?? index.builtAt }
}

/**
 * 判断索引与卡片集合是否一致（FR-A7 / FR-F5 健康检查用）。
 *
 * @param index - 倒排索引。
 * @param cards - 当前卡片 Map。
 * @returns 是否一致；不一致说明该重建了。
 */
export function isIndexConsistent(index: InvertedIndex, cards: ReadonlyMap<string, MemoryCard>): boolean {
  if (index.size !== cards.size) return false
  for (const id of cards.keys()) {
    if (!index.documents.has(id)) return false
  }
  for (const id of index.documents.keys()) {
    if (!cards.has(id)) return false
  }
  return true
}

/**
 * 索引统计信息，供日志与运维命令使用（FR-F3）。
 *
 * @param index - 倒排索引。
 * @returns 词项数与卡片数。
 */
export function indexStats(index: InvertedIndex): { terms: number; cards: number } {
  return { terms: index.postings.size, cards: index.size }
}
