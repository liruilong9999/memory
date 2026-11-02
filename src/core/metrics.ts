/**
 * 从诊断日志聚合 FR-F3 要求的五个指标 + 最小周报。
 *
 * ## 为什么必须从日志聚合，而不是在 engine 里加计数器
 *
 * `engine.metrics()` 的 `recalls` 是**进程内计数器**（`this.recallCount`），
 * 重启即归零。FR-F3 要的是「召回次数、命中率、冲突数、库大小、注入 token」
 * 并「有最小周报」——周报天然跨进程、跨天，内存计数器根本支撑不了。
 *
 * 从日志聚合还有个附带好处：日志是**已经落盘的事实**（FR-F1），
 * 指标与「上一次运行发生了什么」同源，出问题时两者不会互相矛盾。
 *
 * ## 为什么是纯函数、放在 `core/`
 *
 * 输入「日志条目数组 + 时刻」，输出「指标 + 周报文本」，无 IO、无时钟、
 * 无宿主依赖，满足 ST-1 确定性。读文件那一步留给 CLI（它本来就要读）。
 *
 * @module src/core/metrics
 */

import type { MemoryLogEntry } from './types.ts'

/** FR-F3 要求的五个指标。 */
export interface MemoryMetrics {
  /** 时间窗口内的召回次数。 */
  recalls: number
  /**
   * 命中率：召回**产出非空焦点包**的次数 / 召回总次数。
   *
   * 定义必须写清，否则「命中率」会被理解成两种东西：
   * 「有卡进焦点包」还是「焦点包被填满」。这里取前者——它衡量的是
   * 「问了一个问题，系统有没有给出任何东西」，与 `pack.empty` 一一对应。
   */
  hitRate: number
  /** 冲突数：召回中出现过 `conflict === true` 的卡片次数（同一张卡多次召回重复计）。 */
  conflicts: number
  /** 库大小：活跃卡片数（调用方从 store 取，这里只占位透传）。 */
  active: number
  /** 注入 token：时间窗口内注入的 token 总量。 */
  injectTokens: number
}

/** 周报文本的输入。 */
export interface WeeklyReportInput {
  /** 日志条目（调用方已按时间窗筛选）。 */
  entries: readonly MemoryLogEntry[]
  /** 活跃卡片数。 */
  active: number
  /** 归档卡片数。 */
  archived: number
  /** 统计窗口起始时刻。 */
  since: number
  /** 统计窗口结束时刻。 */
  until: number
  /** IANA 时区。 */
  timeZone: string
}

/** 周报：可读文本 + 结构化指标。 */
export interface WeeklyReport {
  /** 人可读多行文本。 */
  text: string
  /** 结构化指标（供 `--json` 与将来画图）。 */
  metrics: MemoryMetrics
}

/** 窗口内没有召回时的命中率取值。 */
const NO_RECALL_HIT_RATE = 0

/**
 * 从日志条目聚合指标。
 *
 * 只统计 `kind === 'recall'` 的条目：`peek`（CLI 只读查询）**不写日志**，
 * 所以「召回次数」天然不含「运维看了一眼」，这与 FR-B7 的
 * 「看到与使用分离」一致——**看过不算用过，也不该算进使用指标**。
 *
 * 字段缺失时按 0 处理，不抛异常：日志是旁路数据，一行形状不对
 * 不该让整份周报失败。
 *
 * @param entries - 日志条目。
 * @param active - 活跃卡片数。
 * @returns 五个指标。
 */
export function aggregateMetrics(entries: readonly MemoryLogEntry[], active: number): MemoryMetrics {
  let recalls = 0
  let hits = 0
  let conflicts = 0
  let injectTokens = 0

  for (const entry of entries) {
    if (entry.kind !== 'recall') continue
    recalls += 1
    const detail = entry.detail
    // `empty` 是 `pack.empty`，与「有没有卡进焦点包」严格一一对应。
    if (detail['empty'] !== true) hits += 1
    const tokens = detail['tokens']
    if (typeof tokens === 'number' && Number.isFinite(tokens)) injectTokens += tokens
    // `picked` 里每一项形如 `{ id, total }`，冲突标记不在其中——
    // 冲突数从 `detail.conflicts` 读（`recall` 日志在 `conflict` 卡存在时写它）。
    const count = detail['conflicts']
    if (typeof count === 'number' && Number.isFinite(count)) conflicts += count
  }

  return {
    recalls,
    hitRate: recalls === 0 ? NO_RECALL_HIT_RATE : hits / recalls,
    conflicts,
    active,
    injectTokens,
  }
}

/**
 * 生成最小周报（FR-F3）。
 *
 * 「最小」的含义：**能回答「这一周系统在做什么」**，不是仪表盘。
 * 所以只报五个指标 + 一句人话结论，不画趋势、不算同比——
 * 那些没有需求承接，写进来就是给下一个人留维护负担。
 *
 * @param input - 周报输入。
 * @returns 周报文本与指标。
 */
export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const metrics = aggregateMetrics(input.entries, input.active)
  const lines: string[] = []
  lines.push(`记忆系统周报（${formatDay(input.since, input.timeZone)} ~ ${formatDay(input.until, input.timeZone)}）`)
  lines.push(`召回 ${metrics.recalls} 次，命中率 ${formatRate(metrics.hitRate)}，冲突 ${metrics.conflicts} 次`)
  lines.push(`注入 token 合计 ${metrics.injectTokens}，活跃 ${metrics.active} 张，归档 ${input.archived} 张`)
  lines.push(verdict(metrics))
  return { text: lines.join('\n'), metrics }
}

/**
 * 由指标给出一句结论。
 *
 * 为什么要有这一句：只报数字的周报需要读者自己判断「这算好还是坏」，
 * 而绝大多数人不会去算命中率的分母。**结论必须由系统给，且必须诚实**——
 * 没数据时就说没数据，不能拿 0 当「表现正常」。
 *
 * @param metrics - 指标。
 * @returns 一句结论。
 */
function verdict(metrics: MemoryMetrics): string {
  if (metrics.recalls === 0) return '结论：本窗口内没有任何召回，指标无参考价值（不是「表现正常」）。'
  if (metrics.hitRate === 0) return '结论：召回全部落空，检查库内容或召回阈值。'
  if (metrics.hitRate < 0.5) return '结论：命中率偏低，多数召回没给出任何记忆。'
  return '结论：召回工作正常。'
}

/**
 * 把毫秒时间戳格式化成 `YYYY-MM-DD`。
 *
 * 不引 `src/time/clock.ts` 的 `ymd`：那个模块面向「到期/时区换算」，
 * 而这里只要一个日期串。共用会让 `core/` 依赖 `time/`，方向反了
 * （依赖方向是 `time/ → core/`）。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区。
 * @returns 日期串。
 */
function formatDay(at: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date(at))
}

/**
 * 把 0~1 的比率格式化成百分比。
 *
 * @param rate - 比率。
 * @returns 形如 `72.5%`。
 */
function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}
