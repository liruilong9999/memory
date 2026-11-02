/**
 * 归档判定：什么时候允许把一张卡「忘掉」。
 *
 * 设计依据：
 * - 需求 FR-C2「遗忘可逆：归档不删除，可恢复」——本文件只产出归档判定，
 *   真正的删除动作不在巩固面，归档永远是 `status: 'archived'` 而非移除。
 * - 需求 FR-C3「阈值可配 + 永不归档类别（承诺、核心事实、长期偏好）」。
 * - 需求 FR-C4「库增长有界」：`maxArchiveRatio` 是每次整理的成本上界（原则 P8）。
 * - 起源 L11（无编号·细节会忘只留感受）：情绪强度高的卡衰减慢（见 decay.ts），
 *   自然更难掉到阈值以下，本文件不需要额外特判。
 *
 * 全部纯函数，阈值只从 `config.forgetting` / `config.consolidation` 读。
 *
 * @module dsh-memory/consolidate/archive
 */

import type { MemoryCard } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'

/**
 * 判断卡片类型是否属于「永不自动归档」类别。
 *
 * 默认配置把承诺（promise）、概念（concept）、经验（experience）列为永不归档：
 * 承诺是未兑现的义务，概念与经验是沉淀下来的长期资产，忘掉它们是净损失。
 *
 * @param card - 记忆卡。
 * @param config - 完整配置。
 * @returns 是否受保护。
 */
export function isNeverArchiveKind(card: MemoryCard, config: MemoryConfig): boolean {
  return config.forgetting.neverArchiveKinds.includes(card.kind)
}

/**
 * 判断卡片是否带有未到期的承诺 / 提醒。
 *
 * 判据是 `dueAt` 有值。**到期与否由调用方先用 {@link releaseExpiredDue}
 * 清理**：`shouldArchive` 不接收 `now`，它无法判断一个 `dueAt` 是否已经过期，
 * 因此采取保守口径——只要还挂着到期时刻，就先不归档。
 *
 * @param card - 记忆卡。
 * @returns 是否挂着到期时刻。
 */
export function hasOpenDue(card: MemoryCard): boolean {
  return card.dueAt !== null && card.dueAt !== undefined
}

/**
 * 清理已经过期的到期时刻。
 *
 * 为什么要有这一步：承诺一旦到期，就不再是「未兑现的义务」，
 * 它的保护期结束，可以正常参与衰减与归档；否则一张早就过期的提醒卡
 * 会永远挡住归档路径（FR-C3 的保护不该变成永久豁免）。
 *
 * 未变化时返回原对象引用，调用方可用 `===` 判断是否需要写日志。
 *
 * @param card - 记忆卡。
 * @param now - 当前时刻（毫秒时间戳）。
 * @returns 清理后的卡，或原卡。
 */
export function releaseExpiredDue(card: MemoryCard, now: number): MemoryCard {
  if (!hasOpenDue(card)) return card
  const dueAt = card.dueAt
  if (dueAt === null || dueAt === undefined) return card
  if (dueAt > now) return card
  return { ...card, dueAt: null }
}

/**
 * 归档判定：这张卡现在可以被自动归档吗。
 *
 * 五个条件**全部**满足才返回 true（任一不满足即否决）：
 * 1. `config.forgetting.autoArchive` 打开；
 * 2. `status` 是 `active`（已归档的不重复归档）；
 * 3. 未被 `pinned` 钉住（FR-C3 的人工豁免，优先级最高）；
 * 4. `kind` 不在 `neverArchiveKinds` 里（FR-C3 的类别豁免）；
 * 5. 强度严格低于 `config.forgetting.archiveThreshold`（FR-C4），且没有未到期事项。
 *
 * 强度用严格小于而不是小于等于：阈值本身就是「低于它才算忘掉」。
 *
 * @param card - 记忆卡。
 * @param config - 完整配置。
 * @returns 是否可归档。
 */
export function shouldArchive(card: MemoryCard, config: MemoryConfig): boolean {
  if (!config.forgetting.autoArchive) return false
  if (card.status !== 'active') return false
  if (card.pinned) return false
  if (isNeverArchiveKind(card, config)) return false
  if (hasOpenDue(card)) return false
  if (!(card.strength < config.forgetting.archiveThreshold)) return false
  // 已被合并掉的卡已经是作废视图，归档它没有意义，交由合并流程处理。
  if (card.mergedInto !== undefined) return false
  return true
}

/**
 * 按强度升序截断归档候选，保证一次整理最多归档 `maxArchiveRatio` 的比例。
 *
 * 排序口径：强度升序 → 创建时间升序 → id 升序。三重键保证结果完全确定（ST-1），
 * 且在强度相同时优先归档更老的卡——老的、弱的，才是该被忘掉的。
 *
 * 上限用 `Math.floor` 是刻意的保守：宁可少归档，也不要在一次整理里
 * 把库砍掉一大块（原则 P8「成本有上界」、需求「避免一次性清空」）。
 * 因此活跃卡很少（例如不足 20 张而比例是 5%）时上限自然为 0，这是预期行为：
 * 小库没有膨胀压力，不需要归档。
 *
 * @param candidates - 通过 {@link shouldArchive} 的候选卡。
 * @param maxRatio - 单次归档比例上限，来自 `config.consolidation.maxArchiveRatio`。
 * @param totalActive - 活跃卡总数，比例的分母；缺省取候选数。
 * @returns 允许归档的卡，已按优先级排好序。
 */
export function applyArchiveRatio(
  candidates: readonly MemoryCard[], maxRatio: number, totalActive: number = candidates.length,
): MemoryCard[] {
  if (candidates.length === 0) return []
  const ratio = Number.isFinite(maxRatio) ? Math.min(1, Math.max(0, maxRatio)) : 0
  const base = Number.isFinite(totalActive) ? Math.max(0, Math.floor(totalActive)) : 0
  const cap = Math.floor(base * ratio)
  if (cap <= 0) return []
  const ordered = [...candidates].sort((x, y) => {
    if (x.strength !== y.strength) return x.strength - y.strength
    if (x.createdAt !== y.createdAt) return x.createdAt - y.createdAt
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  })
  return ordered.slice(0, cap)
}

/**
 * 归档动作**不在这里实现**，原因见下。
 *
 * 早期本文件有 `archiveCard(card, now, config)`，做两件事：改状态、乘一个
 * `archiveRetention` 打折强度。后来发现打折那一半根本无法重放（`archive` 操作
 * 只携带 `{op, id, at, reason}`，不带强度），于是把打折去掉——去掉之后剩下的
 * 「改状态 + 置 updatedAt」与数据面 `src/store/state.ts` 的 `archive` 分支
 * 是同一行逻辑。再留一份就是**两份真相**，而「两份真相各自漂移」正是本次
 * 缺陷的成因。所以这里不再提供归档投影函数，归档语义唯一定义在数据面：
 *
 * - 归档：`status → 'archived'`，`updatedAt → max(updatedAt, at)`，强度不动；
 * - 恢复：`status → 'active'`，`updatedAt → max(updatedAt, at)`，强度不动。
 *
 * 由此 FR-C2「遗忘可逆」才成立：归档 → 恢复往返后强度**严格相等**，
 * 不是「近似」也不是「打折后仍大于零」。衰减只由 `decay.ts` 按时间结算。
 */
