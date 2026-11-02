/**
 * 五字段 cron 表达式（分 时 日 月 周）的解析与「下一次」计算。
 *
 * 起源 L21（第 1 条·时间观念与闹钟）：「解决 ai 没有时间观念问题，定闹钟」。
 * 需求 FR-D3：「到期提醒：一次性/每日/每周/cron，到期投递并唤醒」——
 * cron 是这一条明确列出的第四种重复方式。
 *
 * 为什么自己写而不引依赖：`package.json` 里没有 cron 库，而这个文件只需要
 * 「解析 + 求下一次」两件事，约 200 行。引一个库会带进时区、任务调度、
 * 持久化等一大堆本插件不需要的语义，还要为它守一条供应链。
 *
 * 为什么放在时间层：它和 {@link nextDueAfter} 是同一类东西——纯函数、
 * 只依赖 `clock.ts` 的时区换算，可离线单测（ST-1）。放进适配面的话，
 * 离线 CLI 和单测就拿不到同样的结果。
 *
 * ## 支持的语法（不支持的返回 `null`，绝不猜）
 *
 * - `*`：全部
 * - `a`：单值
 * - `a-b`：闭区间
 * - `a,b,c`：枚举（可与区间混用）
 * - `*\/n` / `a-b/n`：步长
 * - 月份 `JAN`..`DEC`、星期 `SUN`..`SAT`（大小写不敏感）
 * - 星期 `0` 与 `7` 都表示周日
 *
 * **不支持**（明确返回 `null`，而不是静默当成别的意思）：
 * - `L` / `W` / `#` 等 Quartz 扩展
 * - 跨边界区间（`FRI-MON`）
 * - 秒字段（六字段表达式）
 *
 * 宁可不支持也不猜：一个被误解的 cron 会在**错误的时间**叫醒用户，
 * 而用户没有任何办法从「响得不对」反推出是解析错了。
 *
 * @module dsh-memory/time/cron
 */

import { ymd, zonedTimeToMs } from './clock.ts'

/** 解析后的 cron 规格。字段都已去重升序，便于确定性遍历（ST-1）。 */
export interface CronSpec {
  /** 原始表达式，便于解释「为什么这个时候响」。 */
  readonly expression: string
  /** 分钟，0-59。 */
  readonly minutes: readonly number[]
  /** 小时，0-23。 */
  readonly hours: readonly number[]
  /** 日，1-31。 */
  readonly daysOfMonth: readonly number[]
  /** 月，1-12。 */
  readonly months: readonly number[]
  /** 星期，0-6（0 为周日）。 */
  readonly daysOfWeek: readonly number[]
  /**
   * 「日」字段是否被限制（不是 `*`）。
   *
   * 与 {@link dowRestricted} 一起决定 Vixie cron 的 **或** 语义：
   * 两个都限制时，只要**任一**匹配就算当天命中。少了这个标志位，
   * `0 9 1 * 1` 会被算成「1 号且周一」，而 cron 的原意是「1 号**或**周一」。
   */
  readonly domRestricted: boolean
  /** 「周」字段是否被限制（不是 `*`）。 */
  readonly dowRestricted: boolean
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
}

const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
}

/** 一个字段的取值范围与名称表。 */
interface FieldSpec {
  min: number
  max: number
  names?: Record<string, number>
}

/** 解析结果：值列表 + 是否被限制（不是 `*`）。 */
interface ParsedField {
  values: number[]
  restricted: boolean
}

/** 把一个符号转成数字：支持阿拉伯数字与名称表。 */
function toNumber(token: string, spec: FieldSpec): number | null {
  const name = spec.names?.[token.toUpperCase()]
  if (name !== undefined) return name
  if (!/^\d+$/u.test(token)) return null
  const value = Number.parseInt(token, 10)
  return Number.isFinite(value) ? value : null
}

/**
 * 解析单个字段。
 *
 * @param text - 字段原文，例如 `*` / `1-5` / `*\/15` / `1,3,5` / `MON-FRI`。
 * @param spec - 取值范围与名称表。
 * @returns 值列表与「是否被限制」；语法非法时返回 `null`。
 */
function parseField(text: string, spec: FieldSpec): ParsedField | null {
  if (text.length === 0) return null
  const restricted = text !== '*'
  const collected = new Set<number>()

  for (const part of text.split(',')) {
    if (part.length === 0) return null

    // 步长：`*/n` 或 `a-b/n`。`a/n` 按 cron 惯例理解为 `a-max/n`。
    const slash = part.indexOf('/')
    let rangeText = part
    let step = 1
    if (slash >= 0) {
      rangeText = part.slice(0, slash)
      const stepText = part.slice(slash + 1)
      if (!/^\d+$/u.test(stepText)) return null
      step = Number.parseInt(stepText, 10)
      if (step <= 0) return null
    }

    let low: number
    let high: number
    if (rangeText === '*') {
      low = spec.min
      high = spec.max
    } else {
      const dash = rangeText.indexOf('-')
      if (dash > 0) {
        const lowText = rangeText.slice(0, dash)
        const highText = rangeText.slice(dash + 1)
        const lowValue = toNumber(lowText, spec)
        const highValue = toNumber(highText, spec)
        if (lowValue === null || highValue === null) return null
        low = lowValue
        high = highValue
        // 跨边界区间不支持：`FRI-MON` 在 cron 里没有公认语义。
        if (low > high) return null
      } else {
        const value = toNumber(rangeText, spec)
        if (value === null) return null
        // `a/n` 与 `a` 都从 a 起；步长形式一直走到上界。
        low = value
        high = slash >= 0 ? spec.max : value
      }
    }

    if (low < spec.min || high > spec.max) return null
    for (let value = low; value <= high; value += step) collected.add(value)
  }

  if (collected.size === 0) return null
  return { values: [...collected].sort((a, b) => a - b), restricted }
}

/**
 * 解析五字段 cron 表达式。
 *
 * @param expression - 形如 `0 9 * * 1-5` 的表达式（分 时 日 月 周）。
 * @returns 解析结果；语法非法时返回 `null`（**不抛异常**，因为输入来自用户文本）。
 */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) return null

  const minutes = parseField(fields[0] ?? '', { min: 0, max: 59 })
  const hours = parseField(fields[1] ?? '', { min: 0, max: 23 })
  const dom = parseField(fields[2] ?? '', { min: 1, max: 31 })
  const months = parseField(fields[3] ?? '', { min: 1, max: 12, names: MONTH_NAMES })
  const dow = parseField(fields[4] ?? '', { min: 0, max: 7, names: DOW_NAMES })
  if (minutes === null || hours === null || dom === null || months === null || dow === null) {
    return null
  }

  // 星期 7 也是周日，归一化到 0，否则 `*` 与 `0-6` 会算出不同的集合。
  const daysOfWeek = [...new Set(dow.values.map((value) => (value === 7 ? 0 : value)))]
    .sort((a, b) => a - b)

  return {
    expression: expression.trim(),
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  }
}

/**
 * 判断某个自然日是否命中「日 / 月 / 周」三个字段。
 *
 * 按 Vixie cron 的规则：**日与周都受限时取「或」**，只有一个受限时取那一个。
 * 这不是实现细节，是 cron 的历史语义——写成「且」会让 `0 9 1 * 1`
 * 从「每月 1 号**和**每周一」变成「每月 1 号且恰好是周一」，
 * 后者一年只命中几次，用户会以为提醒坏了。
 *
 * @param spec - cron 规格。
 * @param year - 年。
 * @param month - 月（1-12）。
 * @param day - 日（1-31）。
 * @param weekday - 星期（0-6，0 为周日）。
 * @returns 是否命中。
 */
function dayMatches(
  spec: CronSpec, year: number, month: number, day: number, weekday: number,
): boolean {
  void year
  if (!spec.months.includes(month)) return false
  const domHit = spec.daysOfMonth.includes(day)
  const dowHit = spec.daysOfWeek.includes(weekday)
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit
  if (spec.domRestricted) return domHit
  if (spec.dowRestricted) return dowHit
  return true
}

/**
 * 算出严格晚于 `now` 的下一次命中时刻。
 *
 * ## 为什么按「自然日」遍历而不是逐分钟
 *
 * 逐分钟最坏要扫 `cronSearchDays × 1440` 次，每次都要做一次时区换算
 * （`zonedTimeToMs` 内部要跑两轮 `Intl.DateTimeFormat`）。按日遍历后，
 * 只在**命中日**才枚举时分，典型表达式当天就返回。
 *
 * ## 为什么用 UTC 做「加一天」的日历运算
 *
 * 这里要的是**民用日期**的推进（11 月 15 日 → 11 月 16 日），不是
 * 时间轴上的 +86400000 毫秒。用 `Date.UTC` 做纯日历运算可以避开
 * 夏令时那天的 23/25 小时问题；真正的时刻由 `zonedTimeToMs` 按
 * 目标时区重建。
 *
 * @param spec - cron 规格。
 * @param now - 当前时刻（毫秒）。
 * @param timeZone - IANA 时区。
 * @param searchDays - 最多向后找多少天；`0` 或负数视为 1。
 *   必须有上界，否则 `0 0 30 2 *`（2 月 30 日，永不存在）会死循环。
 * @returns 下一次命中时刻；找不到时返回 `null`。
 */
export function nextCronAfter(
  spec: CronSpec, now: number, timeZone: string, searchDays: number,
): number | null {
  const limit = Number.isFinite(searchDays) && searchDays >= 1 ? Math.floor(searchDays) : 1
  const today = ymd(now, timeZone)
  // 民用日期的日历起点，仅用于「第 N 天」的加减，不代表真实时刻。
  const civilBase = Date.UTC(today.year, today.month - 1, today.day)

  for (let offset = 0; offset <= limit; offset += 1) {
    const civil = new Date(civilBase + offset * 24 * 60 * 60 * 1000)
    const year = civil.getUTCFullYear()
    const month = civil.getUTCMonth() + 1
    const day = civil.getUTCDate()
    const weekday = civil.getUTCDay()
    if (!dayMatches(spec, year, month, day, weekday)) continue

    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const candidate = zonedTimeToMs(year, month, day, hour, minute, timeZone)
        // 严格大于：`now` 恰好命中时不能返回它自己，否则「推进」变成空操作，
        // 提醒会被反复投递同一次（这正是 FR-D3 修的那个缺陷的形状）。
        if (candidate > now) return candidate
      }
    }
  }
  return null
}
