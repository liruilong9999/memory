/**
 * 命令行日期参数解析（`--since`）。
 *
 * 为什么单独一个文件而不是塞进 `args.ts`：`args.ts` 是**纯文本切分**，
 * 它不需要知道时区，也不该知道——它只负责把 `--since` 后面的字符串
 * 原样搬到 `CliOptions.since` 上。把「这个日期是哪一刻」的判断放在那里，
 * 会逼着 `parseArgs` 接受一个时区参数，而 `--tz` 在参数序列里可能出现在
 * `--since` 之后（`parseArgs` 单遍扫描，扫到 `--since` 时还不知道时区）。
 * 于是在解析阶段猜时区，等于给静默错误发通行证：东八区用户写
 * `--since 2024-03-01` 会拿到 UTC 的那一天，偏差 8 小时，而命令正常返回 0。
 *
 * 所以分成两步：**切分**在 `args.ts`（无时区知识），**解释**在这里
 * （时区已由 `resolveTimeZone` 确定）。这一步与 `src/host/adapter.ts`
 * 里「先读 patch 再校验」的顺序约束是同一类：有依赖的步骤不能提前合并。
 *
 * @module dsh-memory/cli/dateArg
 */

import { zonedTimeToMs } from '../time/clock.ts'

/** 日期参数解析结果。 */
export type DateArgResult =
  | { readonly ok: true; readonly at: number }
  | { readonly ok: false; readonly message: string }

/** `YYYY-MM-DD`，可选跟 `T` 或空格再加 `HH:mm`（秒可写可不写）。 */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/u

/**
 * 把命令行日期文本解释成毫秒时间戳。
 *
 * 接受两种写法：
 *
 * | 写法 | 含义 |
 * |---|---|
 * | `2024-03-01` | 该日在**指定时区**的 00:00 |
 * | `2024-03-01 09:30`（或 `T` 分隔） | 该时刻 |
 * | `2024-03-01T09:30:00` | 同上，秒可写可不写 |
 * | `1709251200000` | 纯数字按毫秒时间戳直取（脚本里算好的值） |
 *
 * 刻意**不做**自然语言解析（「上周」「上个月」）：这类相对表述的语义边界
 * 在跨时区、跨夏令时下没有唯一答案，而 CLI 的过滤结果要能被脚本复现。
 * 解析不了就报错，让人写清楚——比猜一个「差不多」的时刻好。
 *
 * @param text - 用户输入。
 * @param timeZone - 已确定的 IANA 时区。
 * @returns 解析结果；格式不认识时 `ok: false`。
 */
export function parseDateArg(text: string, timeZone: string): DateArgResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, message: '日期参数是空的' }

  // 纯数字按毫秒时间戳处理。判据是「全部是数字」，不按长度猜：
  // `20240301` 这种紧凑写法既像日期又像时间戳，猜错一次就是 1970 年。
  if (/^\d+$/u.test(trimmed)) {
    const at = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(at)) return { ok: false, message: `日期参数「${text}」不是有效的时间戳` }
    return { ok: true, at }
  }

  const matched = DATE_PATTERN.exec(trimmed)
  if (matched === null) {
    return {
      ok: false,
      message: `日期参数「${text}」看不懂，请写成 2024-03-01 或 2024-03-01T09:30`,
    }
  }
  const year = Number.parseInt(matched[1] ?? '', 10)
  const month = Number.parseInt(matched[2] ?? '', 10)
  const day = Number.parseInt(matched[3] ?? '', 10)
  const hour = matched[4] === undefined ? 0 : Number.parseInt(matched[4], 10)
  const minute = matched[5] === undefined ? 0 : Number.parseInt(matched[5], 10)
  const second = matched[6] === undefined ? 0 : Number.parseInt(matched[6], 10)

  // 月份与日期要自己查范围：`Date.UTC(2024, 1, 31)` 会**静默进位**成 3 月 2 日，
  // 于是 `--since 2024-02-31` 会得到 3 月 2 日，而用户以为自己筛的是 2 月。
  // 这不是理论风险：正则允许 `\d{2}`，`02-31` 是能写出来的。
  if (month < 1 || month > 12) return { ok: false, message: `月份 ${month} 超出 1..12` }
  if (day < 1 || day > 31) return { ok: false, message: `日 ${day} 超出 1..31` }
  if (hour > 23) return { ok: false, message: `小时 ${hour} 超出 0..23` }
  if (minute > 59) return { ok: false, message: `分钟 ${minute} 超出 0..59` }
  if (second > 59) return { ok: false, message: `秒 ${second} 超出 0..59` }
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { ok: false, message: `日期「${text}」在日历上不存在` }
  }

  // 秒没有专门的入参：`zonedTimeToMs` 只到分钟（提醒场景本来也只需要分钟）。
  // 先把「时:分」换算成毫秒，再补秒，避免为了秒去改时间模块的公开签名——
  // 那个签名被提醒链路依赖，为 CLI 的一个便利写法改它会牵连无关代码。
  return { ok: true, at: zonedTimeToMs(year, month, day, hour, minute, timeZone) + second * 1000 }
}
