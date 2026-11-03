/**
 * 写入时的冲突标记（FR-B5 / SC-4 / 起源 L19「感受经验」）。
 *
 * 冲突判定：共享实体（在谈同一个对象）+ 文本相似度低（说法明显不同）
 * 就说明两句话对同一件事给出了不同说法，需要并列展示而不是悄悄合并。
 *
 * ## 为什么在写入时标，而不是渲染时标
 *
 * 只算不写等于没做——`looksConflicting` 此前零调用点，`conflictOf` 恒为空，
 * 于是真实数据里永远不会出现冲突警告。冲突必须在写入时落到卡上。
 *
 * ## 已知缺陷（未修，故意的）
 *
 * 判据方向是反的，见 `docs/7-缺陷复盘.md` 缺陷二十五。调阈值只会在错的
 * 路上更精确，所以这里保持原样，**不要顺手改判据**。
 *
 * @module dsh-memory/host/engine/conflicts
 */

import { looksConflicting } from '../../core/extraction.ts'
import { cardSimilarity } from '../../consolidate/dedupe.ts'
import type { MemoryCard } from '../../core/types.ts'

/**
 * 给新写入的卡片标出与既有记忆的冲突。
 *
 * 两个方向都要标：既有卡是已落盘的不可变对象，所以这里返回需要**回写**的
 * 既有卡（带新 `conflictOf`），由调用方落库；新卡则原地标。
 *
 * 抽成纯函数（只读 `existing`、只原地改 `cards`）而不是留在引擎类里，
 * 是为了让「哪些卡需要回写」这件事可以被单独断言——它是这条路径上唯一
 * 有副作用的返回物，混在 `writeTurn` 里时只能靠整链路测。
 *
 * @param cards - 本轮新抽取的卡片（会被原地修改）。
 * @param existing - 库里的活跃卡（只读）。
 * @param relatedSimilarity - 「相关」阈值（来自 `config.dedup.relatedSimilarity`）。
 * @param at - 写入时刻。
 * @returns 需要回写的既有卡片（`conflictOf` 已更新）。
 */
export function markConflicts(
  cards: MemoryCard[],
  existing: readonly MemoryCard[],
  relatedSimilarity: number,
  at: number,
): MemoryCard[] {
  const updated: MemoryCard[] = []
  if (cards.length === 0) return updated
  const related = relatedSimilarity
  for (const card of cards) {
    for (const other of existing) {
      if (other.id === card.id) continue
      const similarity = cardSimilarity(card, other)
      if (!looksConflicting(card, other, similarity, related)) continue
      if (!card.conflictOf.includes(other.id)) card.conflictOf.push(other.id)
      if (!other.conflictOf.includes(card.id)) {
        // 既有卡是不可变对象，复制一份再改，避免就地修改已落盘状态。
        const patched: MemoryCard = {
          ...other,
          conflictOf: [...other.conflictOf, card.id],
          updatedAt: at,
        }
        updated.push(patched)
      }
    }
  }
  return updated
}
