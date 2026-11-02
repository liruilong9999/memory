/**
 * 到期时刻解析：把「明天下午三点提醒我」变成确定的毫秒时间戳。
 *
 * 起源 L21（第 1 条·时间观念与闹钟）：「解决 ai 没有时间观念问题，定闹钟」。
 * 需求 FR-D3：「到期提醒：一次性/每日/每周/cron，到期投递并唤醒」，
 * 验收要点是「到点无需用户输入自行接力」。
 *
 * 为什么放在时间层：解析结果要进记忆卡（`MemoryCard.dueAt`），而卡是纯数据；
 * 同时它依赖 `clock.ts` 的时区换算，放在 `src/time/` 与 FR-D3 的架构归属一致。
 * 若把解析放在适配面，离线 CLI 和单测就拿不到同样的结果（ST-1）。
 *
 * 设计取舍：**只做规则解析，不做模型推断**。
 * 规则能覆盖的中文时间表达有限，但每一条都可解释、可单测、零延迟；
 * 解析不出来就返回 `null`，宁可不提醒也不乱提醒（FR-B6 不编造的精神）。
 *
 * @module dsh-memory/time/due
 */

import type { DueRepeat } from '../core/types.ts'
import { localDate, zonedParts } from './clock.ts'

/** 重复方式：一次性 / 每日 / 每周。定义在契约层，此处仅转出。 */
export type { DueRepeat } from '../core/types.ts'

/** 一次解析出的到期信息。 */
export interface DueSpec {
  /** 首次到期时刻（毫秒）。 */
  dueAt: number
  /** 重复方式。 */
  repeat: DueRepeat
  /** 命中的原文片段，便于解释「为什么认为有到期」。 */
  matched: string
}

/** 中文数字到阿拉伯数字。 */
const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/** 一周的中文名到 ISO 星期几（周一 = 1）。 */
const WEEKDAYS: Readonly<Record<string, number>> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
}

/**
 * 把中文或阿拉伯数字转成数值。
 *
 * @param text - 例如 `3`、`三`、`十五`、`二十`。
 * @returns 数值；无法解析时为 `null`。
 */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  if (/^\d+$/u.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10)
    return Number.isFinite(value) ? value : null
  }
  // 十位表达：十五 → 15、二十 → 20、二十三 → 23。
  const tenMatch = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(trimmed)
  if (tenMatch !== null) {
    const tens = tenMatch[1] === undefined ? 1 : (CN_DIGITS[tenMatch[1]] ?? 0)
    const ones = tenMatch[2] === undefined ? 0 : (CN_DIGITS[tenMatch[2]] ?? 0)
    return tens * 10 + ones
  }
  const single = CN_DIGITS[trimmed]
  return single === undefined ? null : single
}

/**
 * 取某时刻在指定时区是星期几。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区。
 * @returns ISO 星期几，周一 = 1，周日 = 7。
 */
export function isoWeekday(at: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
  const name = fmt.format(new Date(at))
  const table: Readonly<Record<string, number>> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  }
  return table[name] ?? 1
}

/**
 * 取某时刻在指定时区的年/月/日。
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

/**
 * 从文本里解析出「几点几分」。
 *
 * 支持：`下午三点`、`15:30`、`晚上 8 点`、`上午十点一刻`、`中午`、`半夜`。
 *
 * @param text - 文本。
 * @returns 小时与分钟；解析不到为 `null`。
 */
export function parseClockTime(text: string): { hour: number; minute: number } | null {
  // 先试 HH:MM / H:MM 形式。
  const colon = /(\d{1,2})\s*[:：]\s*(\d{2})/u.exec(text)
  if (colon !== null) {
    const hour = Number.parseInt(colon[1] ?? '', 10)
    const minute = Number.parseInt(colon[2] ?? '', 10)
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  }

  const periodMatch = /(凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|半夜)/u.exec(text)
  const period = periodMatch?.[1]

  // 「N 点 M 分」/「N 点半」/「N 点一刻」/「N 点」。
  const pointMatch = /([零一二两三四五六七八九十\d]{1,3})\s*[点时](?:([零一二两三四五六七八九十\d]{1,3})\s*分|半|一刻|三刻)?/u.exec(text)
  if (pointMatch === null) {
    // 只说了时段没说钟点：给该时段的默认时刻。
    if (period === '中午') return { hour: 12, minute: 0 }
    if (period === '半夜') return { hour: 0, minute: 0 }
    return null
  }

  const rawHour = parseNumber(pointMatch[1] ?? '')
  if (rawHour === null) return null
  let hour = rawHour
  let minute = 0
  const minuteText = pointMatch[2]
  if (minuteText !== undefined) {
    const parsed = parseNumber(minuteText)
    if (parsed !== null) minute = parsed
  } else if (pointMatch[0].includes('半')) {
    minute = 30
  } else if (pointMatch[0].includes('一刻')) {
    minute = 15
  } else if (pointMatch[0].includes('三刻')) {
    minute = 45
  }

  // 12 小时制换算：下午/晚上 + 12，但 12 点本身不加。
  const isPm = period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里'
  if (isPm && hour < 12) hour += 12
  if (period === '中午' && hour < 12) hour += 12
  if ((period === '凌晨' || period === '半夜') && hour === 12) hour = 0

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * 从文本里解析出相对的天偏移。
 *
 * 支持：`今天`、`明天`、`后天`、`大后天`、`N 天后`、`下周X`、`周X`。
 *
 * @param text - 文本。
 * @param now - 当前时刻。
 * @param timeZone - IANA 时区。
 * @returns 目标日与「是否有明确日期」标志；无日期线索为 `null`。
 */
export function parseDayOffset(
  text: string, now: number, timeZone: string,
): { dayOffset: number; explicit: boolean } | null {
  if (/大后天/u.test(text)) return { dayOffset: 3, explicit: true }
  if (/后天/u.test(text)) return { dayOffset: 2, explicit: true }
  if (/明天|明日|明早|明晚/u.test(text)) return { dayOffset: 1, explicit: true }
  if (/今天|今日|今晚|今早/u.test(text)) return { dayOffset: 0, explicit: true }

  const daysLater = /(\d+|[一二两三四五六七八九十]{1,3})\s*天\s*(?:后|以后|之后)/u.exec(text)
  if (daysLater !== null) {
    const value = parseNumber(daysLater[1] ?? '')
    if (value !== null && value > 0) return { dayOffset: value, explicit: true }
  }

  const weekLater = /下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u.exec(text)
  if (weekLater !== null) {
    const target = WEEKDAYS[weekLater[1] ?? '']
    if (target !== undefined) {
      const today = isoWeekday(now, timeZone)
      // 「下周一」= 本周一 + 7 天；若今天已过本周一，则再 +7。
      const thisWeek = target - today
      const offset = thisWeek + 7
      return { dayOffset: offset, explicit: true }
    }
  }

  const thisWeekDay = /(?:这|本)?(?:周|星期|礼拜)([一二三四五六日天])/u.exec(text)
  if (thisWeekDay !== null) {
    const target = WEEKDAYS[thisWeekDay[1] ?? '']
    if (target !== undefined) {
      const today = isoWeekday(now, timeZone)
      // 已经过了就顺延到下周同一天（提醒不能说「昨天」）。
      let offset = target - today
      if (offset <= 0) offset += 7
      return { dayOffset: offset, explicit: true }
    }
  }

  return null
}

/**
 * 解析文本里的到期时刻。
 *
 * 需求 FR-D3：一次性 / 每日 / 每周三种重复方式。
 * 解析优先级：明确的「每天/每周」→ 明确日期 → 只有钟点（今天或明天）。
 *
 * @param text - 单句文本。
 * @param now - 当前时刻（毫秒）。
 * @param timeZone - IANA 时区。
 * @param defaultHour - 只说了日期没说钟点时使用的默认小时，通常取配置值。
 * @returns 到期信息；无到期线索为 `null`。
 */
/**
 * 算出「下一次」到期时刻（FR-D3）。
 *
 * 提醒响过之后必须把 `dueAt` 推进到下一次，否则第二天的 `dueNow` 仍然
 * 返回**同一个** `dueAt`，被「已提醒过」的记忆过滤掉 —— 每日提醒
 * 在响过一次之后就永久静默。这正是 FR-D3 的验收原文
 * 「到点无需用户输入自行接力」在重复场景下的真实形态。
 *
 * 只在 `repeat` 为 `'daily'` / `'weekly'` 时有意义：
 * 一次性提醒响完就该结束，返回 `null` 表示「不再有下一次」。
 *
 * ## 为什么按本地自然日推进，而不是简单 +86400000
 *
 * 夏令时切换日一天可能是 23 或 25 小时。加固定毫秒数会让
 * 「每天早上九点」在切换后变成八点或十点，且此后永久偏移。
 * 所以按「本地日期 + N 天 + 原钟点」重建时刻。
 *
 * ## 为什么用 while 而不是 if
 *
 * 宿主可能停摆数天，重新上线时 `dueAt` 已经落后好几轮。
 * 用 `if` 只推进一天，于是接下来几天会**连续补发**同一批提醒；
 * 用 `while` 一次跳到「严格晚于 now」的下一次，只提醒一次。
 * 上限 `maxCatchUp` 防止时钟异常（例如 now 是 1970 年）时无限循环。
 *
 * @param dueAt - 当前到期时刻。
 * @param repeat - 重复方式。
 * @param now - 当前时刻；推进目标必须严格晚于它。
 * @param timeZone - IANA 时区。
 * @param maxCatchUp - 最多补推多少轮，超出则返回 `null`（当作放弃）。
 * @returns 下一次到期时刻；不再重复时返回 `null`。
 */
export function nextDueAfter(
  dueAt: number, repeat: DueRepeat, now: number, timeZone: string, maxCatchUp = 400,
): number | null {
  if (repeat === 'once') return null
  const stepDays = repeat === 'weekly' ? 7 : 1
  const clock = zonedParts(dueAt, timeZone)
  let cursor = dueAt
  let rounds = 0
  while (cursor <= now) {
    if (rounds >= maxCatchUp) return null
    const base = ymd(cursor, timeZone)
    // 按「本地日期 + stepDays + 原钟点」重建，避免夏令时把钟点推歪。
    const shifted = zonedTimeToMs(base.year, base.month, base.day + stepDays, clock.hour, clock.minute, timeZone)
    // 夏令时回拨可能让重建结果不变（极罕见），兜底加一天防止死循环。
    cursor = shifted > cursor ? shifted : cursor + stepDays * 24 * 60 * 60 * 1000
    rounds += 1
  }
  return cursor
}

export function parseDue(
  text: string, now: number, timeZone: string, defaultHour = 9,
): DueSpec | null {
  // 先确认这句话真的在说「未来要做的事」，否则「今天很累」也会被解析成提醒。
  if (!/(提醒|记得|别忘|不要忘|到点|到期|截止|deadline|闹钟|叫我|通知我)/u.test(text)) {
    return null
  }

  const clock = parseClockTime(text)
  const repeat: DueRepeat = /每(?:天|日|晚|早)/u.test(text)
    ? 'daily'
    : /每(?:周|星期|礼拜)/u.test(text) ? 'weekly' : 'once'

  const hour = clock?.hour ?? defaultHour
  const minute = clock?.minute ?? 0

  const today = ymd(now, timeZone)
  const todayDate = localDate(now, timeZone)

  // 每日/每周：即使没有明确日期也要能算出一个「下一次」时刻。
  if (repeat === 'daily' || repeat === 'weekly') {
    const base = zonedTimeToMs(today.year, today.month, today.day, hour, minute, timeZone)
    if (repeat === 'daily') {
      const dueAt = base > now ? base : base + 24 * 60 * 60 * 1000
      return { dueAt, repeat, matched: text.trim() }
    }
    // 每周：优先用「周X」指定，否则按今天算，过了就 +7 天。
    const weekdayMatch = /(?:每(?:周|星期|礼拜))([一二三四五六日天])/u.exec(text)
    const target = weekdayMatch === null ? isoWeekday(now, timeZone) : WEEKDAYS[weekdayMatch[1] ?? '']
    const todayWeekday = isoWeekday(now, timeZone)
    let dayOffset = (target ?? todayWeekday) - todayWeekday
    if (dayOffset < 0) dayOffset += 7
    let dueAt = base + dayOffset * 24 * 60 * 60 * 1000
    if (dueAt <= now) dueAt += 7 * 24 * 60 * 60 * 1000
    return { dueAt, repeat, matched: text.trim() }
  }

  // 一次性：必须有明确日期或明确钟点，否则不猜。
  const day = parseDayOffset(text, now, timeZone)
  if (day === null && clock === null) return null

  const dayOffset = day?.dayOffset ?? 0
  let dueAt = zonedTimeToMs(today.year, today.month, today.day, hour, minute, timeZone)
    + dayOffset * 24 * 60 * 60 * 1000
  // 只说了钟点且该时刻已过 → 顺延到明天（「提醒我下午三点」在下午四点说，指明天）。
  if (day === null && dueAt <= now) {
    dueAt += 24 * 60 * 60 * 1000
  }
  // 说了「今天」但时刻已过，不硬造未来时刻——保留过去的到期时刻，让它立即被 pickDue 命中。
  if (dayOffset === 0 && day !== null && dueAt > now) {
    // 未来时刻，原样返回。
  }
  if (localDate(dueAt, timeZone) === todayDate && dueAt <= now && day === null) {
    dueAt += 24 * 60 * 60 * 1000
  }
  return { dueAt, repeat, matched: text.trim() }
}
