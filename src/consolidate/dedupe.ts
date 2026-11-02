/**
 * 去重与合并：把「说了好几遍的同一件事」压成一条。
 *
 * 设计依据：
 * - 需求 FR-C1「夜整理最小集：去重、合并、降权、归档」——本文件负责前两项。
 * - 需求 FR-C4「库增长有界」：重复卡是最主要的膨胀来源，必须自动合并。
 * - 需求 ST-2「幂等」：同一批卡反复整理，结果必须稳定，所以分组与合并
 *   全部按内容排序后计算，不依赖输入顺序、不依赖随机。
 * - 起源 L27（第 4 条·夜晚休眠整理）：合并是夜整理的压缩动作。
 *
 * 相似度复用 `core/text` 的 Jaccard（对称、0..1、与词项数量无关），
 * 阈值全部来自 `config.dedup`，本文件不写死任何数字。
 *
 * @module dsh-memory/consolidate/dedupe
 */

import type { MemoryCard } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'
import { jaccard, normalizeText, tokenSet, truncate } from '../core/text.ts'

/** 一组判定为重复的记忆卡。 */
export interface DuplicateGroup {
  /** 组内成员，按「创建时间升序、id 升序」排好，最早的在前。 */
  cards: MemoryCard[]
  /**
   * 组内两两相似度的**最小值**（保守口径）。
   *
   * 用最小值而不是平均值：传递闭包会把 A≈B、B≈C 但 A 与 C 并不像的三张卡
   * 拉进同一组，最小值能如实暴露这个组的「最弱一环」，便于人复核。
   */
  similarity: number
}

/**
 * 计算两张卡的相似度。
 *
 * 直接用卡片自带的 `normalized` 字段建词项集合：该字段写入时已归一化，
 * 且去重不需要再算一遍 `normalizeText`。为空时退回原文归一化，
 * 兼容上游漏填 `normalized` 的历史数据。
 *
 * @param a - 卡 A。
 * @param b - 卡 B。
 * @param cache - 可选的词项集合缓存，避免 O(n²) 扫描里重复分词。
 * @returns 0..1 的相似度。
 */
export function cardSimilarity(
  a: MemoryCard, b: MemoryCard, cache?: Map<string, Set<string>>,
): number {
  return jaccard(tokensOf(a, cache), tokensOf(b, cache))
}

/**
 * 取一张卡的词项集合，带缓存。
 *
 * @param card - 记忆卡。
 * @param cache - 缓存；不传则现算。
 * @returns 词项集合。
 */
function tokensOf(card: MemoryCard, cache?: Map<string, Set<string>>): Set<string> {
  if (cache === undefined) return buildTokens(card)
  const hit = cache.get(card.id)
  if (hit !== undefined) return hit
  const built = buildTokens(card)
  cache.set(card.id, built)
  return built
}

/**
 * 由卡片构造词项集合。
 *
 * @param card - 记忆卡。
 * @returns 词项集合。
 */
function buildTokens(card: MemoryCard): Set<string> {
  const normalized = card.normalized.length > 0 ? card.normalized : normalizeText(card.text)
  return tokenSet(normalized)
}

/**
 * 稳定排序：创建时间升序，同时间按 id 升序。
 *
 * 所有涉及顺序的地方都走这里，保证「同样输入 → 同样输出」（ST-1）。
 *
 * @param cards - 待排序的卡。
 * @returns 排好序的新数组，不改入参。
 */
export function sortByAge(cards: readonly MemoryCard[]): MemoryCard[] {
  return [...cards].sort((x, y) => {
    if (x.createdAt !== y.createdAt) return x.createdAt - y.createdAt
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  })
}

/**
 * 找出重复卡分组。
 *
 * 做法：先按「创建时间 + id」稳定排序，再做两两扫描，用并查集把
 * 「相似度 ≥ `config.dedup.duplicateSimilarity`」的卡连成连通分量。
 * 并查集的根取字典序较小的 id，因此分组结果与扫描顺序无关。
 *
 * 只考虑 `active` 且未被合并过的卡：已归档的卡不再参与整理，
 * 已被合并掉的卡（`mergedInto` 有值）已经是作废视图。
 *
 * **摘要卡不参与去重**（`kind === 'summary'`）。这不是优化，是必须：
 * 摘要卡的文本是模板化统计句（`2023-11-15：7 条记忆，主要涉及工作，关键词 …`），
 * 任意两天的日摘要字面相似度极高，会被判成重复卡合并掉——于是「每天一张
 * 日摘要」在去重之后只剩一张，跨周期层级压缩被自己的去重逻辑毁掉。
 * 实测：两天的日摘要确实进了同一分组。
 *
 * 也不能靠调高 `duplicateSimilarity` 绕开：那会同时放过真正的重复事件卡。
 * 摘要卡的重复性由 `buildCardId`（日期键进 id）保证，本就不需要文本去重。
 *
 * @param cards - 候选卡（通常是本轮工作集）。
 * @param config - 完整配置。
 * @returns 分组列表，只含成员 ≥ 2 的组；按组内最早卡的年龄排序。
 */
export function findDuplicateGroups(
  cards: readonly MemoryCard[], config: MemoryConfig,
): DuplicateGroup[] {
  const pool = sortByAge(cards.filter((card) => (
    card.status === 'active'
    && card.mergedInto === undefined
    // 摘要卡按「层级 + 日期键」唯一，文本相似是设计使然，不是重复。
    && card.kind !== 'summary'
  )))
  if (pool.length < 2) return []

  const threshold = config.dedup.duplicateSimilarity
  const cache = new Map<string, Set<string>>()
  const parent = new Map<string, string>()
  /** 组内最小相似度，键为并查集根 id。 */
  const groupMin = new Map<string, number>()

  const find = (start: string): string => {
    let cursor = start
    for (;;) {
      const up = parent.get(cursor)
      if (up === undefined || up === cursor) return cursor
      cursor = up
    }
  }

  for (const card of pool) parent.set(card.id, card.id)

  const union = (left: string, right: string): void => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft === rootRight) return
    // 根取字典序较小者：结果与扫描顺序无关，重放稳定。
    if (rootLeft < rootRight) {
      parent.set(rootRight, rootLeft)
      const carried = groupMin.get(rootRight)
      if (carried !== undefined) {
        const current = groupMin.get(rootLeft)
        groupMin.set(rootLeft, current === undefined ? carried : Math.min(current, carried))
      }
      groupMin.delete(rootRight)
    } else {
      parent.set(rootLeft, rootRight)
      const carried = groupMin.get(rootLeft)
      if (carried !== undefined) {
        const current = groupMin.get(rootRight)
        groupMin.set(rootRight, current === undefined ? carried : Math.min(current, carried))
      }
      groupMin.delete(rootLeft)
    }
  }

  for (let i = 0; i < pool.length; i += 1) {
    const left = pool[i]
    if (left === undefined) continue
    for (let j = i + 1; j < pool.length; j += 1) {
      const right = pool[j]
      if (right === undefined) continue
      const similarity = cardSimilarity(left, right, cache)
      if (similarity < threshold) continue
      union(left.id, right.id)
      const root = find(left.id)
      const known = groupMin.get(root)
      groupMin.set(root, known === undefined ? similarity : Math.min(known, similarity))
    }
  }

  const buckets = new Map<string, MemoryCard[]>()
  for (const card of pool) {
    const root = find(card.id)
    const bucket = buckets.get(root)
    if (bucket === undefined) buckets.set(root, [card])
    else bucket.push(card)
  }

  const groups: DuplicateGroup[] = []
  for (const [root, members] of buckets) {
    if (members.length < 2) continue
    groups.push({
      cards: sortByAge(members),
      similarity: groupMin.get(root) ?? 0,
    })
  }
  // 按组内最早卡的年龄排序，保证输出顺序稳定。
  groups.sort((x, y) => {
    const firstX = x.cards[0]
    const firstY = y.cards[0]
    if (firstX === undefined || firstY === undefined) return 0
    if (firstX.createdAt !== firstY.createdAt) return firstX.createdAt - firstY.createdAt
    return firstX.id < firstY.id ? -1 : firstX.id > firstY.id ? 1 : 0
  })
  return groups
}

/**
 * 合并一组重复卡，产出一张存活卡。
 *
 * 合并规则（每条都对应需求编号）：
 * - **身份**：沿用组内最早那张卡的 id / domain / kind / source。
 *   最早者代表「这件事第一次被记住」的原点，来源指针（FR-A4）最完整。
 * - **时间**：`createdAt` 取最早（记忆的年龄不变老也不变新），
 *   `updatedAt` 取最新（内容确实刚刚被整理过）。
 * - **强度**：`strength` 取最大值。取最大而不是平均：合并的卡不该因为
 *   一条弱副本而被拉低到归档阈值以下（FR-C2 遗忘可逆的前提是别误删）。
 *   `accessCount` 求和，访问频次是累加事实。
 * - **显著性 / 情绪**：都取最大值。起源 L11（无编号·只留感受）——
 *   强烈的感受不能因为合并而稀释。
 * - **文本**：取最长的那条（信息量最大），再按 `config.dedup.mergeTextChars` 截断。
 * - **标签 / 实体 / 冲突**：并集去重，保持首次出现顺序，跨层次关联不丢失。
 * - **修正记录**：全部保留并按时间升序排列，FR-A5「可查改过什么」。
 * - **溯源**：`mergeOf` 记录被并入的其余 id（含它们各自此前并入的 id），
 *   合并后卡片随时能追回原始事件。
 *
 * @param members - 同组卡，至少一张。
 * @param config - 完整配置。
 * @returns 合并后的卡（新对象，不修改入参）。
 */
export function mergeGroup(members: readonly MemoryCard[], config: MemoryConfig): MemoryCard {
  const ordered = sortByAge(members)
  const winner = ordered[0]
  if (winner === undefined) {
    throw new RangeError('mergeGroup 需要至少一张记忆卡')
  }

  let longestText = winner.text
  for (const card of ordered) {
    if ([...card.text].length > [...longestText].length) longestText = card.text
  }

  const mergedIds: string[] = []
  const seenIds = new Set<string>([winner.id])
  for (const card of ordered) {
    for (const id of card.mergeOf ?? []) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
      mergedIds.push(id)
    }
  }
  for (const card of ordered) {
    if (seenIds.has(card.id)) continue
    seenIds.add(card.id)
    mergedIds.push(card.id)
  }

  const revisions = ordered.flatMap((card) => card.revisions).sort((x, y) => x.at - y.at)
  const conflictOf = unionExact(ordered.map((card) => card.conflictOf)).filter((id) => id !== winner.id)

  let strength = 0
  let salience = 0
  let emotional = 0
  let confidence = 0
  let accessCount = 0
  let updatedAt = winner.updatedAt
  let lastAccessAt: number | null = winner.lastAccessAt ?? null
  let pinned = false
  let dueAt: number | null = winner.dueAt ?? null

  for (const card of ordered) {
    strength = Math.max(strength, card.strength)
    salience = Math.max(salience, card.salience)
    emotional = Math.max(emotional, card.emotional)
    confidence = Math.max(confidence, card.confidence)
    accessCount += card.accessCount
    updatedAt = Math.max(updatedAt, card.updatedAt)
    if (card.lastAccessAt !== null && card.lastAccessAt !== undefined) {
      lastAccessAt = lastAccessAt === null ? card.lastAccessAt : Math.max(lastAccessAt, card.lastAccessAt)
    }
    if (card.pinned) pinned = true
    if (dueAt === null && card.dueAt !== null && card.dueAt !== undefined) dueAt = card.dueAt
  }

  const text = truncate(longestText, config.dedup.mergeTextChars)

  return {
    id: winner.id,
    domain: winner.domain,
    kind: winner.kind,
    text,
    // normalized 供后续去重使用，取未截断的完整文本，保证下一轮仍能命中新的重复卡。
    normalized: normalizeText(longestText),
    createdAt: winner.createdAt,
    updatedAt,
    source: winner.source,
    salience,
    confidence,
    emotional,
    strength,
    accessCount,
    lastAccessAt,
    tags: unionFolded(ordered.map((card) => card.tags)),
    entities: unionFolded(ordered.map((card) => card.entities)),
    revisions,
    status: 'active',
    conflictOf,
    pinned,
    mergeOf: mergedIds,
    dueAt,
  }
}

/**
 * 大小写不敏感并集，保留首次出现的原始写法。
 *
 * 标签与实体用于检索与连边，`Deploy` 与 `deploy` 必须视为同一个。
 *
 * @param lists - 多个字符串数组。
 * @returns 去重后的数组。
 */
function unionFolded(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const item of list) {
      const key = item.toLowerCase()
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/**
 * 大小写敏感的并集，用于 id 列表。
 *
 * @param lists - 多个字符串数组。
 * @returns 去重后的数组。
 */
function unionExact(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const item of list) {
      if (item.length === 0 || seen.has(item)) continue
      seen.add(item)
      out.push(item)
    }
  }
  return out
}
