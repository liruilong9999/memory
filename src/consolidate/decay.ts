/**
 * 强度衰减：遗忘曲线（Forgetting Curve）的确定性实现。
 *
 * 设计依据：
 * - 需求 FR-C4「库增长有界」：归档的前提是「强度已掉到阈值以下」，强度从本文件来。
 * - 需求 FR-C3「阈值可配 + 永不归档类别」：阈值只从 config 读，本文件不判断归档。
 * - 起源第 1 条「我们大多数细节都会忘记，只会留下感受」：
 *   情绪强度（emotional）越高，有效半衰期越长，忘得越慢。
 * - 起源第 6 条「今日记忆渐进累积，夜晚休眠整理」：本文件是夜整理的第一步。
 *
 * 全部纯函数：不读时钟、不读文件、无随机。时间由调用方以 now 传入，
 * 因此同样输入永远得到同样输出（ST-1 确定性验收）。
 *
 * @module dsh-memory/consolidate/decay
 */

import type { MemoryCard } from '../core/types.ts'
import type { MemoryConfig } from '../core/config.ts'

/**
 * 把数值夹到 0..1。非有限数（NaN / Infinity）视为 0。
 *
 * 强度、权重、边权都约定在 0..1，统一走这里，避免各处散落分支。
 *
 * @param value - 待夹紧的数值。
 * @returns 0..1 之间的有限数。
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 衰减起算时刻：当前强度是在哪一刻被「定下」的。
 *
 * 取 createdAt / updatedAt / lastAccessAt 的最大值：
 * - updatedAt 在每次「写强度」时刷新，所以它是强度快照的时刻；
 * - lastAccessAt 是最后一次召回，召回同样会刷新强度；
 * - createdAt 兜底，防止上游给出不合理的时间。
 *
 * 这个定义让衰减可以**分次叠加**而不失真：
 * 先在 t1 衰减一次得到 s1 并把 updatedAt 置为 t1，再在 t2 衰减一次，
 * 结果等于从 t0 直接衰减到 t2（见 {@link decayCard} 的注释）。
 *
 * @param card - 记忆卡。
 * @returns 毫秒时间戳。
 */
export function decayOriginAt(card: MemoryCard): number {
  const base = Math.max(card.createdAt, card.updatedAt)
  if (card.lastAccessAt === null || card.lastAccessAt === undefined) return base
  return Math.max(base, card.lastAccessAt)
}

/**
 * 有效半衰期（毫秒）：在基准半衰期上叠加情绪与访问两个调制量。
 *
 * 调制公式（全部参数来自 config，不写死字面量）：
 *
 * ```text
 * 情绪因子 = 1 + emotional × (emotionalHalfLifeBoost − 1)
 * 访问因子 = 1 + accessCount × accessBoost
 * 有效半衰期 = halfLifeMs × 情绪因子 × 访问因子
 * ```
 *
 * 为什么访问加成复用 `forgetting.accessBoost`：配置里没有单独的
 * 「访问延长半衰期」参数，而 accessBoost 表达的就是「一次召回给记忆带来多少巩固」，
 * 拿它作为「每次召回带来的半衰期延长比例」是同一语义的另一种用法，
 * 比新加一个字面量更符合「阈值全部落在 config」的约定。
 *
 * @param card - 记忆卡。
 * @param config - 完整配置。
 * @returns 有效半衰期，恒为正数。
 */
export function effectiveHalfLifeMs(card: MemoryCard, config: MemoryConfig): number {
  const policy = config.forgetting
  const emotional = clamp01(card.emotional)
  const emotionalBoost = Math.max(1, policy.emotionalHalfLifeBoost)
  const emotionalFactor = 1 + emotional * (emotionalBoost - 1)

  const accessCount = Number.isFinite(card.accessCount) ? Math.max(0, card.accessCount) : 0
  const accessFactor = 1 + accessCount * Math.max(0, policy.accessBoost)

  const base = policy.halfLifeMs > 0 ? policy.halfLifeMs : 1
  return base * emotionalFactor * accessFactor
}

/**
 * 计算某一时刻的记忆强度。
 *
 * 指数衰减：`strength(t) = strength0 × 0.5 ^ ((t − t0) / 有效半衰期)`。
 * 选指数而不是线性：遗忘曲线本来就是先快后慢，指数是它的标准形状，
 * 且「过一个半衰期掉一半」这个性质直观、可单测、可解释。
 *
 * 时间倒流（now ≤ t0，例如回填历史数据）时原样返回当前强度，
 * 绝不做「反向增强」——那会让重放结果依赖处理顺序。
 *
 * @param card - 记忆卡。
 * @param now - 当前时刻（毫秒时间戳），由调用方传入。
 * @param config - 完整配置。
 * @returns 衰减后的强度，落在 0..1。
 */
export function decayStrength(card: MemoryCard, now: number, config: MemoryConfig): number {
  const current = clamp01(card.strength)
  if (!Number.isFinite(now)) return current
  const elapsed = now - decayOriginAt(card)
  if (!Number.isFinite(elapsed) || elapsed <= 0) return current
  const halfLife = effectiveHalfLifeMs(card, config)
  return clamp01(current * Math.pow(0.5, elapsed / halfLife))
}

/**
 * 生成衰减后的新卡：只改 `strength` 与 `updatedAt`，其余字段原样保留。
 *
 * 为什么要把 updatedAt 置为 now：{@link decayOriginAt} 以 updatedAt 作为
 * 「强度快照时刻」，这样下一次整理从 now 继续算，两次衰减叠加的结果
 * 与一次算到底完全一致（半衰期没变时严格相等）。
 *
 * 无变化时返回**同一个对象引用**，调用方可以用 `=== ` 判断是否需要写日志。
 *
 * @param card - 记忆卡。
 * @param now - 当前时刻（毫秒时间戳）。
 * @param config - 完整配置。
 * @returns 新卡，或原卡（未发生变化时）。
 */
export function decayCard(card: MemoryCard, now: number, config: MemoryConfig): MemoryCard {
  const strength = decayStrength(card, now, config)
  if (!(strength < card.strength)) return card
  return { ...card, strength, updatedAt: now }
}
