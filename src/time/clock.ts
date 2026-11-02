/**
 * 时间状态：把「现在几点、过了多久」变成代码算好的确定值。
 *
 * 起源 L21（第 1 条·时间观念与闹钟）：「解决 ai 没有时间观念问题，定闹钟」。
 * 需求 FR-D1 / FR-D2 / SC-3：所有相对时间读数必须由代码算出，
 * 绝不交给模型推断——模型对 Δt 的估计是不可靠的幻觉来源。
 *
 * 本文件是纯函数集合，`now` 一律由参数传入，便于单测与确定性验证。
 *
 * @module dsh-memory/time/clock
 */

import type { MemoryCard, TimeState } from '../core/types.ts'

/** 时间读数的输入素材。 */
export interface ClockInput {
  /** 当前时刻（毫秒）。 */
  now: number
  /** IANA 时区名，例如 `Asia/Shanghai`。 */
  timeZone: string
  /** 上一次会话结束的时刻；无历史为 `null`。 */
  lastSessionEndAt: number | null
  /** 上一轮对话的时刻；无历史为 `null`。 */
  lastTurnAt: number | null
  /** 本次会话开始时刻；无历史为 `null`。 */
  sessionStartedAt: number | null
  /** 当前已到期的事项。 */
  due: MemoryCard[]
}

/**
 * 计算本地自然日（`YYYY-MM-DD`）。
 *
 * 用 `Intl` 而不是手算偏移：跨时区、夏令时都能正确处理。
 * 需求 FR-D4 要求日摘要与日期一一对应，所以这个函数必须稳定。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区名。
 * @returns `YYYY-MM-DD`。
 */
export function localDate(at: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  // en-CA 的格式天然是 YYYY-MM-DD。
  return fmt.format(new Date(at))
}

/**
 * 计算两个时刻之间的毫秒差，负数视为 0。
 *
 * @param now - 当前时刻。
 * @param past - 过去时刻；为 `null` 时返回 `null`。
 * @returns 毫秒差或 `null`。
 */
export function elapsed(now: number, past: number | null): number | null {
  if (past === null) return null
  return Math.max(0, now - past)
}

/**
 * 组装时间状态。
 *
 * 这是适配面每轮要调用的入口：喂进原始读数，拿到可直接注入与打分的结构。
 *
 * @param input - 输入素材。
 * @returns 时间状态。
 */
export function buildTimeState(input: ClockInput): TimeState {
  return {
    now: input.now,
    timeZone: input.timeZone,
    localDate: localDate(input.now, input.timeZone),
    sinceLastSession: elapsed(input.now, input.lastSessionEndAt),
    sinceLastTurn: elapsed(input.now, input.lastTurnAt),
    sessionStartedAt: input.sessionStartedAt,
    due: [...input.due],
  }
}

/**
 * 渲染时间读数文本。
 *
 * 需求 FR-D1：新会话问「现在几点」要能答对。宿主自带的 `dsh-time-context`
 * 已经注入绝对时刻（决策 D-07 复用它），这里补的是**相对时间**——
 * 距上次会话多久、本次会话持续多久、有哪些事项到期。
 *
 * @param state - 时间状态。
 * @returns 注入文本；无任何相对信息时返回空串。
 */
export function renderTimeContext(state: TimeState): string {
  const lines: string[] = []
  if (state.sinceLastSession !== null) {
    lines.push(`距上次会话：${humanize(state.sinceLastSession)}`)
  }
  if (state.sinceLastTurn !== null) {
    lines.push(`距上一条消息：${humanize(state.sinceLastTurn)}`)
  }
  if (state.sessionStartedAt !== null) {
    lines.push(`本次会话已持续：${humanize(Math.max(0, state.now - state.sessionStartedAt))}`)
  }
  if (state.due.length > 0) {
    lines.push('到期事项：')
    for (const card of state.due) {
      lines.push(`- ${card.text}`)
    }
  }
  if (lines.length === 0) return ''
  return ['## 时间读数（由代码计算，非模型推断）', ...lines].join('\n')
}

/**
 * 把毫秒时长转成中文人话。
 *
 * 与 `scoring.formatDuration` 的区别：这里面向「经过时长」而不是「多久以前」，
 * 所以不带「前」字。
 *
 * @param ms - 毫秒数。
 * @returns 中文时长。
 */
export function humanize(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (ms < minute) return `${Math.floor(ms / 1000)} 秒`
  if (ms < hour) return `${Math.floor(ms / minute)} 分钟`
  if (ms < day) return `${Math.floor(ms / hour)} 小时`
  const days = Math.floor(ms / day)
  if (days < 30) return `${days} 天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月`
  return `${Math.floor(months / 12)} 年`
}

/**
 * 筛选已到期的事项。
 *
 * 需求 FR-D3 / SC-5：承诺与提醒到期后要能被主动提出。
 *
 * @param cards - 全部卡片。
 * @param now - 当前时刻。
 * @returns 已到期且未归档的卡片。
 */
export function pickDue(cards: readonly MemoryCard[], now: number): MemoryCard[] {
  const out: MemoryCard[] = []
  for (const card of cards) {
    if (card.status !== 'active') continue
    if (card.dueAt === null || card.dueAt === undefined) continue
    if (card.dueAt <= now) out.push(card)
  }
  // 按到期时间升序，最紧急的排最前。
  out.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
  return out
}

/**
 * 判断是否已跨过某个本地自然日的时刻（用于夜整理触发）。
 *
 * 需求 FR-D4 / FR-C1：夜整理按自然日聚合，必须能判断「今天整理过了吗」。
 *
 * @param lastRunAt - 上次运行时刻；从未运行为 `null`。
 * @param now - 当前时刻。
 * @param timeZone - IANA 时区。
 * @param dailyAt - 目标时刻，`HH:mm`。
 * @returns 是否应当触发。
 */
export function shouldRunDaily(
  lastRunAt: number | null, now: number, timeZone: string, dailyAt: string,
): boolean {
  const [hourText, minuteText] = dailyAt.split(':')
  const targetHour = Number.parseInt(hourText ?? '0', 10)
  const targetMinute = Number.parseInt(minuteText ?? '0', 10)
  if (!Number.isFinite(targetHour) || !Number.isFinite(targetMinute)) return false

  const nowParts = zonedParts(now, timeZone)
  const nowMinutes = nowParts.hour * 60 + nowParts.minute
  if (nowMinutes < targetHour * 60 + targetMinute) return false

  if (lastRunAt === null) return true
  // 只有「今天还没跑过」才触发。
  return localDate(lastRunAt, timeZone) !== localDate(now, timeZone)
}

/**
 * 取某个时刻在指定时区的小时与分钟。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区。
 * @returns 小时与分钟。
 */
export function zonedParts(at: number, timeZone: string): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(at))
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  return { hour, minute }
}

/**
 * 取某时刻在指定时区的年/月/日。
 *
 * 定义在本文件而不是 `due.ts`：`due.ts` 与 `cron.ts` 都要用它，
 * 放在任一侧都会让两个模块互相 import 成环，而 ESM 循环依赖会在
 * 求值顺序上给出 `undefined`，表现为运行时 `TypeError`。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区。
 * @returns 年月日三元组。
 */
export function ymd(at: number, timeZone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const parts = fmt.formatToParts(new Date(at))
  const get = (type: string): number => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10)
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * 构造「某地某日某时某分」对应的毫秒时间戳。
 *
 * 用迭代法修正时区偏移：先按 UTC 造一个候选时刻，量出它在该时区与目标的差，
 * 补偿后重测一次。两次足够收敛（夏令时切换日可能有 ±1 小时残差，
 * 但提醒场景可接受，且不会无限循环）。
 *
 * @param year - 年。
 * @param month - 月（1..12）。
 * @param day - 日（1..31）。
 * @param hour - 时（0..23）。
 * @param minute - 分（0..59）。
 * @param timeZone - IANA 时区。
 * @returns 毫秒时间戳。
 */
export function zonedTimeToMs(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  let candidate = target
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = zonedParts(candidate, timeZone)
    const actualDate = ymd(candidate, timeZone)
    const actualMs = Date.UTC(
      actualDate.year, actualDate.month - 1, actualDate.day, actual.hour, actual.minute, 0, 0,
    )
    const diff = target - actualMs
    if (diff === 0) break
    candidate += diff
  }
  return candidate
}
