/**
 * 焦点包的**人类可读**渲染（FR-B4 可解释性）。
 *
 * 为什么放在 `core/`：这里是纯函数——输入 `FocusPack` 与候选数，输出字符串，
 * 没有 IO、没有时钟、没有宿主依赖，完全满足 ST-1 确定性。
 *
 * ## 为什么需要抽出来
 *
 * 这个格式原先在**两个地方各写了一遍**：
 * - `src/index.ts` 的 `/memory explain` 子命令（会话内自查）
 * - `src/cli/memoryctl.ts` 的 `query` 子命令（终端运维）
 *
 * 两处逐行对齐过，但那是**靠人肉同步**维持的一致性——改一处忘了另一处，
 * 同一个记忆库在终端和在会话里就会显示两种格式，而且没人会立刻发现。
 * 抽成单一实现后，一致性由类型系统保证，不再依赖记性。
 *
 * ## 为什么两处都需要它而不是合并成一个入口
 *
 * 两者的**数据来源不同**：
 * - `/memory explain` 走 `engine.recall()`，会刷新访问计数（那是宿主真实使用）；
 * - CLI 的 `query` 走只读召回，绝不能写库（运维查一眼不算使用）。
 *
 * 所以「取数据」必须分开，「渲染」必须共用。这里只负责后者。
 *
 * @module src/core/render
 */

import { formatCardRef, formatTime, kindLabel, renderEmptyNote } from './scoring.ts'
import type { FocusPack, MemoryCard, MemoryRevision, ScoredCard } from './types.ts'

/**
 * 渲染单张卡片的分数构成。
 *
 * @param scored - 已打分的卡片。
 * @returns 多行文本（不含前后空行）。
 */
function renderScoredCard(scored: ScoredCard): string[] {
  const lines: string[] = [
    `■ ${scored.card.text}`,
    `  卡片 id ${formatCardRef(scored.card.id)}`,
    `  总分 ${scored.score.total.toFixed(3)}${scored.conflict ? '（有冲突）' : ''}`,
  ]
  for (const line of scored.explain) lines.push(`  ${line}`)
  // 影子模式的观察值单独一段，**不混进 explain**：`explain` 的解释是「这个分数
  // 是怎么算出来的」，而影子值没有参与计算，混进去会让读者以为它已经生效了。
  // 这里用「假设」二字把语义钉死，并且必须显式标注「未生效」。
  if (scored.shadowSpread !== undefined) {
    const shadow = scored.shadowSpread
    lines.push(
      `  [影子] 若开启扩散：+${shadow.boost.toFixed(3)} → ${shadow.hypotheticalTotal.toFixed(3)}`
      + `，排名 ${shadow.actualRank} → ${shadow.hypotheticalRank}（当前未生效）`,
    )
    if (shadow.sources.length > 0) {
      lines.push(`  [影子] 激活来自 ${shadow.sources.length} 张种子卡`)
    }
  }
  return lines
}

/**
 * 渲染焦点包与候选统计。
 *
 * 输出格式（改动即为破坏性变更，CLI 与命令两侧同时生效）：
 *
 * ```text
 * 焦点包 3 张，候选 12 张
 *
 * ■ 用户偏好 PostgreSQL
 *   卡片 id 3f9a1c02
 *   总分 0.539（有冲突）
 *   recency 0.42 × 0.25 = 0.105
 *   ...
 * ```
 *
 * ## 为什么每张卡都印 id（FR-A5 / FR-C2 的前置条件）
 *
 * `restore` / `revise` / `history` 全部以**卡片 id** 为唯一入口。但在此之前，
 * 人读输出里从头到尾没有本卡的 id——用户看到「■ 用户偏好 PostgreSQL」，
 * 想修正它，却拿不到可以粘给 `revise` 的字符串。于是这三个命令在会话里
 * **事实上不可用**：能力在、路径缺。
 *
 * 印 id 的位置刻意选在这里而不是注入行（`formatCardLine`）：注入行进 LLM
 * 上下文，带 id 只会烧 token（FR-E1 的 token 预算理由，见该函数的 JSDoc）。
 * 而这里是**给人看的**，多 8 个字符换「命令能不能用」。
 *
 * 空包时返回一句明确说明，而不是空串：`/memory explain` 与 `memoryctl query`
 * 都是**给人看的**，静默无输出会让人以为命令坏了（FR-B6 的同一原则：
 * 宁可显式说明，也不要让人猜）。
 *
 * @param pack - 焦点包。
 * @param candidates - 参与打分的候选总数。
 * @returns 多行文本。
 */
export function renderFocusPackExplain(pack: FocusPack, candidates: number): string {
  if (pack.cards.length === 0) {
    // 文案来自 `renderEmptyNote`（`pack.note` 的唯一读取口），不在这里另写一份。
    // 候选数附在后面：它是**诊断信息**（「库是空的」还是「库有卡但都不相关」
    // 是两种完全不同的故障），对 ST-5 的判据没有影响。
    return `${renderEmptyNote(pack)}（候选 ${candidates} 张）`
  }
  const lines: string[] = [`焦点包 ${pack.cards.length} 张，候选 ${candidates} 张`]
  for (const scored of pack.cards) {
    lines.push('')
    for (const line of renderScoredCard(scored)) lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 修正记录的来源说明（`MemoryRevision.actor` 的中文说法）。
 *
 * 三个取值是封闭集合，但**不写 `default` 静默吞掉**：将来新增一种 actor 时，
 * 让这里出编译错，而不是让人读输出里冒出一个英文单词。
 *
 * @param actor - 修正发起方。
 * @returns 中文说明。
 */
function revisionActorLabel(actor: MemoryRevision['actor']): string {
  switch (actor) {
    case 'manual':
      return '手动修正'
    case 'consolidation':
      return '夜整理'
    case 'system':
      return '系统'
  }
}

/**
 * 渲染一张卡的修正历史（FR-A5「修正后可查『改过什么、为什么』」）。
 *
 * ## 为什么必须有这个出口
 *
 * `revisions` 早已有生产者（`engine.revise` / CLI `revise` / `/memory revise`），
 * 也有 15 条测试守着它写进去了。但在此之前，`grep -n revision` 在渲染层
 * **零命中**——`reason` 写进去了，却没有任何出口能读它。写入而没有出口，
 * 等于「记了但查不到」，而需求原文要的恰恰是「可查」。
 *
 * ## 三条边界（都照 FR-B6 的「宁可显式说明，也不要让人猜」）
 *
 * 1. **没有历史时说「从未修正过」**，不返回空串——空输出会被读成「命令坏了」。
 * 2. **`reason` 为空时写「未填写原因」**，不留空白行——空白会被读成「渲染漏了一行」。
 * 3. **时间按传入的时区渲染**，与 `query` / `logs` 同一套格式化，不在这里另写一份。
 *
 * 顺序按**修正发生的先后**（与 `revisions` 数组一致，最早的在前）：
 * 这条历史是「这张卡怎么变成现在这样」的叙事，倒序会让它读起来像随机排列。
 *
 * @param card - 目标卡片（已由调用方解析出来）。
 * @param timeZone - 时区，用于把 `at` 渲染成本地时间。
 * @returns 多行文本。
 */
export function renderCardHistory(card: MemoryCard, timeZone: string): string {
  const head = `卡片 id ${card.id}［${kindLabel(card.kind)}］`
  const current = `当前正文：${card.text}`
  if (card.revisions.length === 0) {
    return [head, current, '从未修正过。'].join('\n')
  }
  const lines: string[] = [head, current, `修正过 ${card.revisions.length} 次（最早的在前）：`]
  for (const [index, revision] of card.revisions.entries()) {
    lines.push('')
    lines.push(`第 ${index + 1} 次 · ${formatTime(revision.at, timeZone)}（${revisionActorLabel(revision.actor)}）`)
    lines.push(`  旧正文：${revision.previousText}`)
    // 空原因必须显式写出来，不能留空：留空与「渲染漏了一行」在终端里长得一样。
    lines.push(`  原因：${revision.reason.trim().length === 0 ? '未填写原因' : revision.reason}`)
  }
  return lines.join('\n')
}
