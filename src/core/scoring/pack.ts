/**
 * 阈值截断与焦点包组装（FR-B2 / FR-E1 / FR-E3 / FR-B6）。
 *
 * @module dsh-memory/core/scoring/pack
 */

import type { MemoryConfig } from '../config.ts'
import { estimateTokens, truncate } from '../text.ts'
import type { FocusPack, ScoredCard } from '../types.ts'
import { formatCardLine } from './render.ts'
import type { RecallQuery } from './score.ts'

/**
 * 阈值截断：从已排序结果里挑出真正进焦点包的那几条。
 *
 * 需求 FR-B2：绝对阈值 + 相对阈值 + 硬上限，三者取最严。
 * 「全低分时不硬塞」——宁可空包，也不给模型一堆无关记忆（FR-B6）。
 *
 * ## 闸门看 `relevance`，不看 `total`（这是修缺陷二十六的核心）
 *
 * 原来的闸门是 `total >= absoluteThreshold`。它在真实数据上**恒真**：
 * `total` 里 0.48 权重给了与查询无关的维度，一张完全无关但新鲜的卡
 * 也有约 0.32。实测（161 张卡 × 19 个查询）无关卡总分区间
 * 0.3131~0.3767 与相关卡区间 0.3452~ 重叠 33.3%，
 * **任何阈值都分不开**，于是「全低分时不硬塞」这条验收不可能失败。
 *
 * 换成 `relevance` 后，同一个完全无关的查询下它精确为 0，
 * 闸门立刻能拒绝（实测「深海鮟鱇鱼」查询从硬塞 4 张变为空包），
 * 而真相关的卡一张都没掉（实测 19 个查询全部无召回损失）。
 *
 * **排序仍按 `total`**：那是「值不值得想起」，与「有没有关系」是两件事。
 *
 * @param scored - 已按总分降序排序的结果。
 * @param config - 配置。
 * @returns 通过阈值的卡片。
 */
export function applyThresholds(scored: readonly ScoredCard[], config: MemoryConfig): ScoredCard[] {
  if (scored.length === 0) return []
  const top = scored[0]
  if (top === undefined) return []
  // 两道闸用**两把不同的尺子**，这是修缺陷二十六时定下来的，别再合并：
  //
  // - 绝对闸 → `relevance`（只含 semantic + goal）。它回答「有没有关系」，
  //   是 FR-B2「全低分时不硬塞」的判据。扩散加分不进 relevance，
  //   所以「有个强邻居」在结构上无法把无关卡推过这道闸。
  // - 相对闸 → `total`。它回答「比本轮最好的差多少」，而「值不值得想起」
  //   本来就该含新鲜度/重要性。扩散加分进 total，所以扩散**天然**能改变
  //   成员，不需要任何豁免补丁。
  //
  // 曾经把相对闸也挪到 relevance（觉得「两把尺子不统一」），实测立刻误伤：
  // SC-2 场景里目标卡 relevance 0.1113、相对闸 0.1121，**差 0.0008 被挡出包**，
  // 而它在 total 尺度上（0.3925 vs 闸 0.2522）本该轻松通过。
  // 根因是 relevance 的相对离散度比 total 大（同批候选 0.546 vs 0.856），
  // 同一个 `relativeThreshold` 在 relevance 尺度上苛刻得多。
  // ⇒ **两把尺子不是不一致，是两道闸问的问题不同。**
  const relativeFloor = top.score.total * config.recall.relativeThreshold
  const picked: ScoredCard[] = []
  for (const item of scored) {
    if (picked.length >= config.recall.maxCards) break
    if (item.score.relevance < config.recall.absoluteThreshold) continue
    if (item.score.total < relativeFloor) continue
    picked.push(item)
  }
  return picked
}

/**
 * 组装焦点包（Focus Pack）。
 *
 * 需求 FR-E1 / FR-E3：只装摘要、有 token 硬上限、超限先砍低分卡。
 * 需求 FR-B6：空包时给出明确措辞，让模型说「没有相关记忆」而不是编造。
 *
 * @param scored - 已打分并排序的候选。
 * @param query - 查询上下文（用于回填 query 文本）。
 * @param config - 配置。
 * @returns 焦点包。
 */
/**
 * 空包文案的**唯一来源**（FR-B6 / ST-5）。
 *
 * 为什么单独导出一个常量：`pack.note` 只有 `buildFocusPack` 会写，
 * 而人读渲染（`render.ts`）此前把同一句话**又抄了一遍**，还抄成了
 * 「没有命中任何记忆」——ST-5 验收的原话是「明确回答"没有相关记忆"」，
 * 于是在终端里 grep 那句话是搜不到的。
 *
 * **同一件事有两份文案，就一定会有一份是错的**，而且没有任何机制会提醒。
 * 这里给出唯一来源，`render.ts` 直接引用，不再各写一份。
 */
export const EMPTY_PACK_NOTE = '没有相关记忆。'

export function buildFocusPack(
  scored: readonly ScoredCard[], query: RecallQuery, config: MemoryConfig,
): FocusPack {
  const picked = applyThresholds(scored, config)
  const budget = config.recall.tokenBudget
  // 头尾固定文本（标题/当前时间/免责尾注）也占上下文，必须先扣掉再分配卡片。
  // 不扣的话 pack.tokens 只统计卡片部分，实际注入必然超出 tokenBudget（FR-E3 失真）。
  const overhead = Math.max(0, config.recall.overheadTokens)
  const cardBudget = Math.max(0, budget - overhead)
  const kept: ScoredCard[] = []
  let used = 0

  for (const item of picked) {
    const text = truncate(item.card.text, config.recall.maxCardChars)
    const line = formatCardLine(item.card, text)
    const cost = estimateTokens(line)
    // 至少留一条，否则预算太小时焦点包会永远为空；其余按预算硬截断。
    if (kept.length > 0 && used + cost > cardBudget) continue
    if (used + cost > cardBudget && kept.length === 0) {
      // 单条就超预算：截断文本再试，仍超则放弃。
      const shrunk = truncate(item.card.text, Math.max(8, Math.floor(config.recall.maxCardChars / 2)))
      const shrunkCost = estimateTokens(formatCardLine(item.card, shrunk))
      if (shrunkCost > cardBudget) continue
      kept.push(item)
      used += shrunkCost
      continue
    }
    kept.push(item)
    used += cost
  }

  const empty = kept.length === 0
  return {
    cards: kept,
    // tokens 报「卡片 + 头尾固定开销」的真实占用，调用方据此判断是否超预算。
    tokens: empty ? 0 : used + overhead,
    budgetTokens: budget,
    maxCardChars: config.recall.maxCardChars,
    query: query.text,
    builtAt: query.now,
    empty,
    note: empty ? EMPTY_PACK_NOTE : '',
  }
}
