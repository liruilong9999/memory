/**
 * 到期提醒（FR-D3 / SC-5 / 起源 L21「到点无需用户输入自行接力」）的三块纯逻辑。
 *
 * 这三件事必须住在一起，因为它们共享同一份「到期时刻」语义：
 * 写入时解析出 `dueAt` / `dueRepeat` / `cronExpression`，投递后按同一套
 * 字段推进下一次，渲染时再按同一套字段决定显示什么。拆开住时曾经出现过
 * 「写入只存 dueAt、推进时却要 dueRepeat」这类漂移，表现是**重复提醒永久静默**：
 * 提醒响过一次之后 `dueAt` 不再前进，第二天 `dueNow` 仍返回同一个 `dueAt`
 * 被过滤掉，于是再也不响，而且不报错。
 *
 * 从 `engine.ts` 抽出来的理由是：`MemoryEngine` 那些方法都要读 `this.store`，
 * 没法单独断言；这三块不碰 store，只碰卡片与时钟，所以可以直接测。
 *
 * @module dsh-memory/host/engine/reminders
 */

import type { MemoryConfig } from '../../core/config.ts'
import type { MemoryCard } from '../../core/types.ts'
import { formatTime } from '../../core/scoring.ts'
import { nextDueAfter, parseDue } from '../../time/due.ts'

/**
 * 把卡片正文里的「明天下午三点提醒我」解析成确定的到期时刻，原地写进卡片。
 *
 * 解析本身在时间层（`src/time/due.ts`），这里只负责把结果填进卡片字段。
 *
 * ## 为什么三个字段必须一起填
 *
 * 只存 `dueAt` 是不够的：曾经这里只取 `spec.dueAt` 就把 `spec.repeat` 丢掉，
 * 于是「每天早上九点提醒我喝水」在库里与「一次性提醒」完全无法区分——
 * 提醒响过一次、`markReminded` 记下 `(id, dueAt)` 之后，第二天 `dueNow`
 * 仍返回同一个 `dueAt` 被过滤掉，永久静默。
 * 探针实测：第 2 天 `dueNow = 0` 张，`dueAt` 始终停在第一天。
 *
 * `cronExpression` 也必须落盘：`'cron'` 不含「什么时候再响」的信息，
 * 提醒响过之后手上只有卡片、没有原始语境，无法重新解析用户那句话。
 *
 * @param cards - 本轮新抽取的卡片（会被原地修改）。
 * @param at - 写入时刻。
 * @param timeZone - 时区。
 * @param config - 生效配置（取 `reminder.cronSearchDays`）。
 */
export function applyDueSpecs(
  cards: readonly MemoryCard[],
  at: number,
  timeZone: string,
  config: MemoryConfig,
): void {
  for (const card of cards) {
    if (card.kind !== 'promise' && card.kind !== 'event') continue
    const spec = parseDue(card.text, at, timeZone, 9, config.reminder.cronSearchDays)
    if (spec !== null) {
      card.dueAt = spec.dueAt
      card.dueRepeat = spec.repeat
      if (spec.cronExpression !== undefined) card.cronExpression = spec.cronExpression
    }
  }
}

/**
 * 算出重复提醒的下一次到期时刻（FR-D3）。
 *
 * ## 为什么基准取 `max(now, dueAt)`
 *
 * 下一次必须**同时**晚于当前到期时刻和投递时刻。只用 `now` 时，若调用方传的
 * `now` 早于 `dueAt`（时钟回拨、或调用方忘了传而默认取 `clock()`），
 * `nextDueAfter` 会原样返回 `dueAt`，推进变成空操作——而它「没有报错」，
 * 看起来像成功了。只用 `dueAt` 时，宿主停摆数天后无法一次跳到未来，会连续补发。
 *
 * ## 一次性提醒返回 `null`
 *
 * `repeat` 为 `'once'` / 缺省时返回 `null`，调用方应保持 `dueAt` 不变——
 * 由夜整理的 `releaseExpiredDue` 负责把它置 null，让卡片能正常参与衰减归档。
 *
 * @param card - 刚投递过提醒的卡片。
 * @param now - 投递时刻。
 * @param timeZone - 时区。
 * @param config - 生效配置（取 `reminder.cronSearchDays`）。
 * @returns 下一次到期时刻；不重复或解析不出时 `null`。
 */
export function nextDueAt(
  card: MemoryCard,
  now: number,
  timeZone: string,
  config: MemoryConfig,
): number | null {
  const repeat = card.dueRepeat ?? 'once'
  if (repeat === 'once') return null
  if (typeof card.dueAt !== 'number') return null
  return nextDueAfter(card.dueAt, repeat, Math.max(now, card.dueAt), timeZone, {
    cronExpression: card.cronExpression,
    cronSearchDays: config.reminder.cronSearchDays,
  })
}

/**
 * 把到期事项渲染成一段可直接投递给模型的提醒文本（FR-D3）。
 *
 * 措辞刻意包含「无需用户输入」的说明，因为这句话会作为一条新的用户消息
 * 进入对话，模型需要知道它来自系统而不是人。
 *
 * @param cards - 已到期的卡片。
 * @param at - 提醒时刻。
 * @param timeZone - 时区。
 * @returns 提醒文本；`cards` 为空时返回空串。
 */
export function renderDueReminderText(
  cards: readonly MemoryCard[],
  at: number,
  timeZone: string,
): string {
  if (cards.length === 0) return ''
  const lines: string[] = []
  lines.push('## 到期提醒（由记忆系统定时投递，不是用户输入）')
  lines.push(`当前时间：${formatTime(at, timeZone)}`)
  lines.push('')
  for (const card of cards) {
    lines.push(`- ${card.text}`)
  }
  lines.push('')
  lines.push('这些事项的约定时间已到，请主动提醒用户或继续推进；不需要等待用户再次开口。')
  return lines.join('\n')
}
