/**
 * 夜整理（Nightly Consolidation）：把一天的记忆压一遍。
 *
 * 设计依据：
 * - 需求 FR-C1「夜整理最小集：去重、合并、降权、归档、重建索引，产出变更日志」。
 * - 起源第 6 条「今日记忆渐进累积，夜晚休眠整理，很长时间迭代」——本文件就是
 *   「夜晚休眠整理」那一步，白天只管写，晚上统一压缩。
 * - 原则 P8「成本有界」：`maxCardsPerRun` 限制单次处理量，
 *   `maxArchiveRatio` 限制单次归档比例，整理耗时与破坏力都有硬上限。
 *
 * 本文件是**编排层**，只负责按顺序调用四个纯函数模块并汇总成报告；
 * 它同样不碰文件系统、不读时钟（now 由调用方传入），产出的是待写入的
 * `JournalOp[]`，由数据面决定怎么落库（原则 P2：日志是唯一真相源）。
 *
 * @module dsh-memory/consolidate/nightly
 */

import type { ConsolidationReport, JournalOp, MemoryCard, MemoryEdge } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'
import { truncate } from '../core/text.ts'
import { decayCard, decayStrength } from './decay.ts'
import { findDuplicateGroups, mergeGroup } from './dedupe.ts'
import { applyArchiveRatio, archiveCard, releaseExpiredDue, shouldArchive } from './archive.ts'
import { buildEdges } from './graph.ts'

/** 夜整理需要的输入状态。 */
export interface ConsolidationInput {
  /** 当前全部卡片（含已归档，函数内部自行过滤）。 */
  cards: readonly MemoryCard[]
  /** 已知的图谱边（含历史边）；缺省视为空。 */
  edges?: readonly MemoryEdge[]
}

/** 夜整理的产物。 */
export interface ConsolidationResult {
  /** 人可读的整理报告（FR-C1）。 */
  report: ConsolidationReport
  /** 待写入日志的操作序列，顺序即应用顺序，重放后即为整理后的状态。 */
  ops: JournalOp[]
  /** 整理后的卡片视图（含未变更的卡），便于调用方直接替换内存状态。 */
  cards: MemoryCard[]
  /** 整理后的全部边（历史边 + 新边）。 */
  edges: MemoryEdge[]
}

/** 日志里摘要文本的截断长度，避免 notes 过长污染日志。 */
const NOTE_TEXT_CHARS = 24

/**
 * 截断文本用于报告，超长补省略号。
 *
 * @param text - 原文。
 * @returns 适合放进 notes 的短文本。
 */
function brief(text: string): string {
  return truncate(text, NOTE_TEXT_CHARS)
}

/**
 * 报告里的一条「合并」说明。
 *
 * @param merged - 合并后的卡。
 * @param absorbed - 被并入的卡。
 * @returns 人可读说明行。
 */
function mergeNote(merged: MemoryCard, absorbed: readonly MemoryCard[]): string {
  const names = absorbed.map((card) => `「${brief(card.text)}」`).join('、')
  return `合并重复卡：将 ${names} 并入「${brief(merged.text)}」`
}

/**
 * 执行一次夜整理。
 *
 * 处理顺序（与 FR-C1 的「去重、合并、降权、归档、重建索引」一一对应）：
 *
 * 1. **取工作集**：只处理 `active` 且未被合并的卡，按 `maxCardsPerRun` 截断；
 *    排序用「创建时间 + id」，保证同样输入取到同样的子集（ST-1）。
 * 2. **衰减**：对工作集算新强度，强度变化才产出 `put`，避免无意义日志。
 * 3. **去重合并**：相似度达 `duplicateSimilarity` 的组，产出一条 `merge` 操作。
 *    存活卡的 id 沿用组内最早那张，被并入的卡由 `merge` 操作标记作废。
 * 4. **归档**：`shouldArchive` 筛出候选，`applyArchiveRatio` 按比例上限截断，
 *    产出 `archive` 操作（可逆，FR-C2）。
 * 5. **连边**：`buildEdges` 重建图谱，只产出尚不存在的边，`buildEdgeId` 保证幂等。
 *
 * 工作集之外（超过 `maxCardsPerRun`）的卡原样返回、原样保留，本次不衰减也不归档，
 * 留给下一次整理——这比「一次处理完但可能跑几十分钟」更符合 P8。
 *
 * @param state - 输入状态。
 * @param config - 完整配置。
 * @param now - 整理时刻（毫秒时间戳），由调用方传入。
 * @returns 报告 + 待写入操作 + 整理后的卡与边。
 */
export function runConsolidation(
  state: ConsolidationInput, config: MemoryConfig, now: number,
): ConsolidationResult {
  const notes: string[] = []
  const ops: JournalOp[] = []

  const allCards = [...state.cards]
  const priorEdges = [...(state.edges ?? [])]
  const beforeActive = allCards.filter((card) => card.status === 'active').length

  // 一、取工作集：稳定排序后按上限截断。
  const eligible = allCards
    .filter((card) => card.status === 'active' && card.mergedInto === undefined)
    .sort((x, y) => {
      if (x.createdAt !== y.createdAt) return x.createdAt - y.createdAt
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
    })
  const limit = Math.max(0, Math.floor(config.consolidation.maxCardsPerRun))
  const working = eligible.slice(0, limit)
  const deferred = eligible.length - working.length

  const next = new Map<string, MemoryCard>()
  for (const card of allCards) next.set(card.id, card)

  if (!config.consolidation.enabled) {
    notes.push('巩固已禁用（consolidation.enabled = false），本次不做任何变更')
    return {
      report: {
        startedAt: now,
        finishedAt: now,
        beforeActive,
        afterActive: beforeActive,
        merged: 0,
        decayed: 0,
        archived: 0,
        reindexed: 0,
        notes,
      },
      ops,
      cards: allCards,
      edges: priorEdges,
    }
  }

  // 二、衰减：先把过期的到期时刻清掉，再按衰减曲线算新强度。
  let decayed = 0
  const decayedCards: MemoryCard[] = []
  for (const card of working) {
    const cleared = releaseExpiredDue(card, now)
    const before = decayStrength(cleared, now, config)
    const after = decayCard(cleared, now, config)
    const changed = after !== cleared || before !== cleared.strength
    const settled = changed ? after : cleared
    if (settled !== card) {
      next.set(card.id, settled)
      ops.push({ op: 'put', card: settled })
      decayedCards.push(settled)
      if (settled.strength < card.strength) decayed += 1
    }
  }

  // 三、去重合并。
  const groups = findDuplicateGroups(decayedCards, config)
  const absorbedIds = new Set<string>()
  const absorbedCards: MemoryCard[] = []
  for (const group of groups) {
    const merged = mergeGroup(group.cards, config)
    // 组内其余卡：标记 mergedInto，交给 merge 操作统一处理。
    const absorbed = group.cards.filter((card) => card.id !== merged.id)
    for (const card of absorbed) {
      absorbedIds.add(card.id)
      absorbedCards.push(card)
    }
    // 存活卡自身的衰减结果可能被 mergeGroup 覆盖，这里以合并结果为准。
    next.set(merged.id, merged)
    ops.push({ op: 'merge', ids: group.cards.map((card) => card.id), into: merged, at: now })
    notes.push(mergeNote(merged, absorbed))
  }
  const mergedCount = groups.length

  // 四、归档：候选必须排除刚被合并掉的卡。
  const archiveCandidates: MemoryCard[] = []
  for (const card of decayedCards) {
    if (absorbedIds.has(card.id)) continue
    const current = next.get(card.id)
    if (current === undefined) continue
    if (!shouldArchive(current, config)) continue
    archiveCandidates.push(current)
  }
  const toArchive = applyArchiveRatio(
    archiveCandidates, config.consolidation.maxArchiveRatio, beforeActive,
  )
  for (const card of toArchive) {
    const archived = archiveCard(card, now, config)
    next.set(archived.id, archived)
    ops.push({ op: 'archive', id: archived.id, at: now, reason: '强度低于归档阈值（夜整理自动归档）' })
  }

  // 五、连边：基于整理后的活跃卡重建，只补尚不存在的边。
  const activeAfterMerge = [...next.values()].filter(
    (card) => card.status === 'active' && card.mergedInto === undefined && !absorbedIds.has(card.id),
  )
  const knownEdgeIds = new Set(priorEdges.map((edge) => edge.id))
  const freshEdges = buildEdges(activeAfterMerge, config, now).filter((edge) => !knownEdgeIds.has(edge.id))
  for (const edge of freshEdges) ops.push({ op: 'edge', edge })
  const edges = [...priorEdges, ...freshEdges]

  // 六、汇总报告（FR-C1：每次整理必须有一份可读报告）。
  const afterActive = [...next.values()].filter((card) => card.status === 'active').length
  const archivedCount = toArchive.length
  notes.unshift(
    `夜整理完成：活跃卡 ${beforeActive} → ${afterActive}，合并 ${mergedCount} 组重复卡，`
    + `衰减 ${decayed} 张，归档 ${archivedCount} 张低强度卡，新增 ${freshEdges.length} 条图谱边`,
  )
  if (deferred > 0) {
    notes.push(`本次处理上限 ${limit} 张，尚有 ${deferred} 张顺延到下一次整理`)
  }
  if (archivedCount > 0) {
    notes.push('归档只改状态不删数据，可随时恢复（FR-C2）')
  }

  const report: ConsolidationReport = {
    startedAt: now,
    finishedAt: now,
    beforeActive,
    afterActive,
    merged: mergedCount,
    decayed,
    archived: archivedCount,
    // 连边即索引重建的产物：图谱是可丢弃可重建的派生视图（FR-A7）。
    reindexed: freshEdges.length,
    notes,
  }

  return { report, ops, cards: [...next.values()], edges }
}
