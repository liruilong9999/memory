/**
 * 夜整理（Nightly Consolidation）：把一天的记忆压一遍。
 *
 * 设计依据：
 * - 需求 FR-C1「夜整理最小集：去重、合并、降权、归档、重建索引，产出变更日志」。
 * - 起源 L27（第 4 条·今日渐进累积、夜晚休眠整理、长时间迭代）——本文件就是
 *   「夜晚休眠整理」那一步：白天只管写，晚上统一压缩。
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
import { applyRecord, createEmptyState } from '../store/state.ts'
import { distillFeelings, feelingToCard } from '../core/distill.ts'
import { distillEdges } from '../core/graph.ts'
import { buildSummaries } from './summarize.ts'
import { decayCard } from './decay.ts'
import { findDuplicateGroups, mergeGroup, sortByAge } from './dedupe.ts'
import { applyArchiveRatio, releaseExpiredDue, shouldArchive } from './archive.ts'
import { buildEdges } from './graph.ts'

/** 夜整理需要的输入状态。卡片与边都接受数组或 Map，便于直接接数据面的 MemoryState。 */
export interface ConsolidationInput {
  /** 当前全部卡片（含已归档），函数内部自行过滤。 */
  cards: readonly MemoryCard[] | ReadonlyMap<string, MemoryCard>
  /** 已知的图谱边（含历史边）；缺省视为空。 */
  edges?: readonly MemoryEdge[] | ReadonlyMap<string, MemoryEdge>
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

/** 报告里摘要文本的截断长度，避免 notes 过长污染日志。 */
const NOTE_TEXT_CHARS = 24

/**
 * 把「数组或 Map」统一成数组。
 *
 * @param source - 数组或 Map，或缺省。
 * @returns 数组视图。
 */
function toArray<T>(source: readonly T[] | ReadonlyMap<string, T> | undefined): T[] {
  if (source === undefined) return []
  if (Array.isArray(source)) return [...(source as readonly T[])]
  return [...(source as ReadonlyMap<string, T>).values()]
}

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
 * 一张卡是否算「活跃」：状态 active 且未被合并掉。
 *
 * 被合并掉的卡虽然 `status` 仍是 active（归档与合并是两个正交概念），
 * 但它已经是作废视图，不应计入活跃数。
 *
 * @param card - 记忆卡。
 * @returns 是否计入活跃。
 */
function isLive(card: MemoryCard): boolean {
  return card.status === 'active' && card.mergedInto === undefined
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
 * 1. **取工作集**：只处理活跃且未被合并的卡，按 `maxCardsPerRun` 截断；
 *    排序用「创建时间 + id」，保证同样输入取到同样的子集（ST-1）。
 * 2. **衰减**：先释放已过期的到期时刻，再按遗忘曲线算新强度；
 *    有变化才产出 `put`，避免无意义日志。
 * 3. **去重合并**：相似度达 `duplicateSimilarity` 的组，产出一条 `merge` 操作。
 *    存活卡沿用组内最早那张的 id，被并入的卡标记 `mergedInto`（作废但保留溯源）。
 * 4. **归档**：`shouldArchive` 筛出候选，`applyArchiveRatio` 按比例上限截断，
 *    产出 `archive` 操作（可逆，FR-C2）。
 * 5. **连边**：`buildEdges` 重建图谱，只补尚不存在的边，`buildEdgeId` 保证幂等。
 *
 * 工作集之外（超过 `maxCardsPerRun`）的卡原样返回、原样保留，本次不衰减也不归档，
 * 留给下一次整理——这比「一次处理完但可能跑很久」更符合 P8。
 *
 * 确定性：全程无随机、无时钟读取、所有排序都有完整的决胜键，
 * 因此同样的 `(state, config, now)` 永远得到同样的 `ops` 与 `report`（ST-1）。
 *
 * **整理后的状态由重放得到，不手工维护第二份。** 早期版本在产出 `ops` 的同时
 * 另外维护一个 `Map` 当作「整理后的卡片视图」，两处各写一遍字段，很快就漂了：
 * 合并时 nightly 只写 `mergedInto`，而数据面（`src/store/state.ts`）还会写
 * `status: 'archived'` 与 `updatedAt`；数据面合并还会自动建 `supersedes` 边，
 * 而 nightly 的 `edges` 里没有。结果是「返回的 cards」与「重放 ops 得到的 cards」
 * 是两份不同的真相——违反原则 P2「事件日志是唯一真相源」。
 * 现在改为把每条 op 直接喂给 {@link applyRecord}，返回的就是重放结果，
 * 两份真相合并成一份，字段语义只由数据面定义。
 *
 * @param state - 输入状态。
 * @param config - 完整配置。
 * @param now - 整理时刻（毫秒时间戳），由调用方传入。
 * @param timeZone - IANA 时区名（如 `Asia/Shanghai`），**必填、无默认值**。
 *   自然日的边界由它定义（FR-D4）：东八区用户的「今天」与 UTC 的「今天」
 *   相差 8 小时，默认成 `'UTC'` 会让每天 08:00 前的记忆被算进前一天，
 *   而且**悄无声息**。给静默错误发通行证，比让调用方编译不过糟糕得多。
 * @returns 报告 + 待写入操作 + 整理后的卡与边。
 */
export function runConsolidation(
  state: ConsolidationInput, config: MemoryConfig, now: number, timeZone: string,
): ConsolidationResult {
  const notes: string[] = []
  const ops: JournalOp[] = []

  const allCards = toArray(state.cards)
  const priorEdges = toArray(state.edges)
  const beforeActive = allCards.filter(isLive).length

  // 重放容器：以输入状态为底，之后每条 op 都经由数据面语义落地。
  // 它既是「整理后状态」的唯一来源，也让 nightly 内部能查到中间状态
  // （例如归档候选要看到合并之后的样子）。
  const replayed = createEmptyState()
  for (const card of allCards) replayed.cards.set(card.id, card)
  for (const edge of priorEdges) replayed.edges.set(edge.id, edge)

  /**
   * 记录一条操作，并立即按数据面语义应用到重放容器。
   *
   * @param op - 待写入的操作。
   */
  const emit = (op: JournalOp): void => {
    ops.push(op)
    applyRecord(replayed, {
      v: 1,
      seq: ops.length,
      at: now,
      // 重放容器是本次调用的临时对象，幂等键只需唯一，不参与落库去重。
      idempotencyKey: `nightly:${ops.length}`,
      op,
    })
  }

  // 开关关闭时不做任何变更，但仍返回一份可读报告（FR-F1：整理要留痕）。
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
        summarized: 0,
        distilled: 0,
        reindexed: 0,
        notes,
      },
      ops,
      cards: [...replayed.cards.values()],
      edges: priorEdges,
    }
  }

  // 一、取工作集：稳定排序后按上限截断。
  const eligible = sortByAge(allCards.filter(isLive))
  const limit = Math.max(0, Math.floor(config.consolidation.maxCardsPerRun))
  const working = eligible.slice(0, limit)
  const deferred = eligible.length - working.length

  // 二、衰减：先释放已过期的到期时刻，再按遗忘曲线算新强度。
  let decayed = 0
  const decayedCards: MemoryCard[] = []
  for (const card of working) {
    const settled = decayCard(releaseExpiredDue(card, now), now, config)
    if (settled !== card) {
      emit({ op: 'put', card: settled })
      if (settled.strength < card.strength) decayed += 1
    }
    decayedCards.push(settled)
  }

  // 三、感受蒸馏（起源 L11 / FR-C5）：从「有情绪的事件」里提炼感受卡。
  //
  // **必须排在去重之前**，这是一个实测出来的顺序约束，不是风格偏好：
  // 「反复经历」的证据是「多张卡共享同一主题」。而夜整理的去重会把高度相似的
  // 卡合并成一张——三张「上线又出问题」的卡在去重后只剩一张，
  // `distillMinRecurrence = 2` 就永远达不到，感受层从此一条都产不出来。
  // 曾在去重之后接蒸馏，端到端测试直接暴露 `distilled = 0`。
  //
  // 顺序上的代价是：刚产出的感受卡会进入后续的去重候选池。这没有害处——
  // 感受卡的文本是「反复牵动情绪」的模板句，与来源事件卡的字面相似度很低，
  // 达不到 `duplicateSimilarity`。若将来调低该阈值，需重新审视这条顺序。
  let distilled = 0
  if (config.consolidation.distillEnabled) {
    const drafts = distillFeelings(decayedCards, config)
    for (const draft of drafts) {
      const sources = draft.sourceIds
        .map((id) => replayed.cards.get(id))
        .filter((card): card is MemoryCard => card !== undefined)
      if (sources.length === 0) continue
      const feeling = feelingToCard(draft, sources, now, config)
      // 已存在就跳过：`put` 覆盖会重置 createdAt/strength，等于每次整理
      // 都让同一条感受「变新」，遗忘曲线永远不推进。
      if (replayed.cards.has(feeling.id)) continue
      emit({ op: 'put', card: feeling })
      // `distills` 边：感受指向来源事件卡。这是七种边里第一个有真实产出的
      // 语义（起源 L15「跨层次关联」：感受层连回事件层）。
      const edgesOfFeeling = distillEdges(
        feeling.id, sources.map((card) => card.id), config.consolidation.distillEdgeWeight, now,
      )
      for (const edge of edgesOfFeeling) {
        if (replayed.edges.has(edge.id)) continue
        emit({ op: 'edge', edge })
      }
      distilled += 1
      notes.push(`蒸馏出感受「${brief(feeling.text)}」，连回 ${sources.length} 张来源卡`)
    }
  }

  // 四、去重合并。
  const groups = findDuplicateGroups(decayedCards, config)
  const absorbedIds = new Set<string>()
  for (const group of groups) {
    const merged = mergeGroup(group.cards, config)
    const absorbed = group.cards.filter((card) => card.id !== merged.id)
    for (const card of absorbed) absorbedIds.add(card.id)
    // 被并入的卡如何标记作废（`status`、`mergedInto`、`updatedAt`）、
    // 合并会自动建哪些 `supersedes` 边，全部由数据面的 merge 分支决定，
    // 这里只产出操作，不再自己拼一遍字段（否则就是两份真相）。
    emit({ op: 'merge', ids: group.cards.map((card) => card.id), into: merged, at: now })
    notes.push(mergeNote(merged, absorbed))
  }

  // 五、摘要与层级压缩（FR-D4 / 起源 L27）：事件 → 日 → 周 → 月。
  //
  // 排在归档之前：被归档的卡不该再进入当天的摘要——归档的语义是
  // 「这段记忆已经不重要了」，把它算进「今天发生了什么」是自相矛盾。
  // 排在蒸馏之后：日摘要要能把刚蒸馏出的感受也统计进去，否则
  // 「今天的感受」在日摘要里永远缺席。
  let summarized = 0
  if (config.consolidation.summaryEnabled) {
    const liveNow = [...replayed.cards.values()].filter(isLive)
    const batch = buildSummaries(liveNow, replayed.cards, now, timeZone, config)
    // 顺序固定为日 → 周 → 月：上层摘要的输入是本轮刚产出的下层摘要，
    // 顺序错了周摘要就会少算这一天。
    for (const summary of [...batch.dailies, ...batch.weeklies, ...batch.monthlies]) {
      if (replayed.cards.has(summary.id)) continue
      emit({ op: 'put', card: summary })
      summarized += 1
    }
    if (summarized > 0) {
      notes.push(
        `产出摘要 ${summarized} 张（日 ${batch.dailies.length}、`
        + `周 ${batch.weeklies.length}、月 ${batch.monthlies.length}）`,
      )
    }
  }

  // 六、归档：候选必须排除刚被合并掉的卡。
  const archiveCandidates: MemoryCard[] = []
  for (const card of decayedCards) {
    if (absorbedIds.has(card.id)) continue
    // 读重放容器而不是本地推算：合并之后的真实状态只有重放知道。
    const current = replayed.cards.get(card.id)
    if (current === undefined) continue
    if (!shouldArchive(current, config)) continue
    archiveCandidates.push(current)
  }
  const toArchive = applyArchiveRatio(
    archiveCandidates, config.consolidation.maxArchiveRatio, beforeActive,
  )
  for (const card of toArchive) {
    emit({ op: 'archive', id: card.id, at: now, reason: '强度低于归档阈值（夜整理自动归档）' })
  }

  // 七、连边：基于整理后的活跃卡重建图谱，只补尚不存在的边。
  const activeAfter = [...replayed.cards.values()].filter(isLive)
  const knownEdgeIds = new Set(replayed.edges.keys())
  const freshEdges = buildEdges(activeAfter, config, now).filter((edge) => !knownEdgeIds.has(edge.id))
  for (const edge of freshEdges) emit({ op: 'edge', edge })
  const edges = [...replayed.edges.values()]

  // 八、汇总报告（FR-C1：每次整理必须有一份可读报告）。
  const afterActive = activeAfter.length
  notes.unshift(
    `夜整理完成：活跃卡 ${beforeActive} → ${afterActive}，合并 ${groups.length} 组重复卡，`
    + `衰减 ${decayed} 张，归档 ${toArchive.length} 张低强度卡，新增 ${freshEdges.length} 条图谱边`,
  )
  if (summarized > 0) notes.push(`新增摘要 ${summarized} 张（起源 L27 层级压缩）`)
  if (distilled > 0) notes.push(`新增感受 ${distilled} 条（起源 L11 细节会忘，只留感受）`)
  if (deferred > 0) {
    notes.push(`本次处理上限 ${limit} 张，尚有 ${deferred} 张顺延到下一次整理`)
  }
  if (toArchive.length > 0) {
    notes.push('归档只改状态不删数据，可随时恢复（FR-C2）')
  }

  const report: ConsolidationReport = {
    startedAt: now,
    finishedAt: now,
    beforeActive,
    afterActive,
    merged: groups.length,
    decayed,
    archived: toArchive.length,
    summarized,
    distilled,
    // 索引是可丢弃可重建的派生视图（FR-A7）：重建索引 = 为每张活跃卡重新登记。
    reindexed: afterActive,
    notes,
  }

  return { report, ops, cards: [...replayed.cards.values()], edges }
}
