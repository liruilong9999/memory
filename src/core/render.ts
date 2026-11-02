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

import type { FocusPack, ScoredCard } from './types.ts'

/**
 * 渲染单张卡片的分数构成。
 *
 * @param scored - 已打分的卡片。
 * @returns 多行文本（不含前后空行）。
 */
function renderScoredCard(scored: ScoredCard): string[] {
  const lines: string[] = [
    `■ ${scored.card.text}`,
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
 *   总分 0.539（有冲突）
 *   recency 0.42 × 0.25 = 0.105
 *   ...
 * ```
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
    return `没有命中任何记忆（候选 ${candidates} 张）`
  }
  const lines: string[] = [`焦点包 ${pack.cards.length} 张，候选 ${candidates} 张`]
  for (const scored of pack.cards) {
    lines.push('')
    for (const line of renderScoredCard(scored)) lines.push(line)
  }
  return lines.join('\n')
}
