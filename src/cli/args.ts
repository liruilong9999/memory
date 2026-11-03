import { COMMANDS, FALLBACK_TIME_ZONE } from './types.ts'
import type { Command, ParseOutcome } from './types.ts'

/* ------------------------------------------------------------------ *
 * 二、参数解析
 * ------------------------------------------------------------------ */

/**
 * 判断一个字符串是不是内置子命令。
 *
 * @param value - 待判断的字符串。
 * @returns 是子命令时返回 `true`，并让 TypeScript 收窄类型。
 */
function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value)
}

/**
 * 解析命令行参数。
 *
 * 刻意手写而不是引第三方库：零依赖原则，而且我们只需要「子命令 + 几个
 * 带值选项」，一个 `while` 循环比任何库都直白、都可测。
 *
 * 支持两种带值写法：`--data-dir <路径>` 与 `--data-dir=<路径>`。
 * `--` 之后的全部参数都当位置参数，便于传以 `-` 开头的关键词。
 *
 * @param argv - 不含 node 与脚本路径的参数数组（即 `process.argv.slice(2)`）。
 * @returns 解析结果；失败时给出可直接打印的中文错误信息。
 */
export function parseArgs(argv: readonly string[]): ParseOutcome {
  const positionals: string[] = []
  let dataDir: string | undefined
  let timeZone: string | undefined
  let out: string | undefined
  let input: string | undefined
  let json = false
  let verbose = false
  let includeArchived = false
  let limit = 50
  let days = 7
  let reason = ''
  let clear = false
  let domain: string | undefined
  let kind: string | undefined
  let tag: string | undefined
  let since: string | undefined
  let helpRequested = false
  let onlyPositionals = false
  let index = 0

  /**
   * 取一个选项的取值。
   *
   * 先看 `=` 后面的内联值；没有就吃掉下一个参数。下一个参数看起来像
   * 长选项时视为「缺值」，而不是把 `--json` 当成路径吞掉。
   *
   * @param name - 选项名，仅用于报错。
   * @param inline - `=` 后面的内联值。
   * @returns 取到的值；缺值时返回 `undefined`。
   */
  const takeValue = (name: string, inline: string | undefined): string | undefined => {
    if (inline !== undefined) return inline.length > 0 ? inline : undefined
    const candidate = argv[index]
    if (candidate === undefined || candidate.startsWith('--')) return undefined
    index += 1
    return candidate.length > 0 ? candidate : undefined
  }

  while (index < argv.length) {
    const arg = argv[index] ?? ''
    index += 1
    if (onlyPositionals) {
      positionals.push(arg)
      continue
    }
    if (arg === '--') {
      onlyPositionals = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      helpRequested = true
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--verbose') {
      verbose = true
      continue
    }
    if (arg === '--include-archived') {
      includeArchived = true
      continue
    }
    if (arg === '--clear') {
      clear = true
      continue
    }
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }

    // 带值选项：拆出 `--name=value` 形式。
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined
    if (name === '--limit') {
      const value = takeValue(name, inline)
      if (value === undefined) return { ok: false, message: `选项 ${name} 缺少取值` }
      const parsed = Number.parseInt(value, 10)
      if (!Number.isInteger(parsed) || parsed < 0) return { ok: false, message: `选项 ${name} 需要非负整数` }
      limit = parsed
      continue
    }
    if (name === '--days') {
      const value = takeValue(name, inline)
      if (value === undefined) return { ok: false, message: `选项 ${name} 缺少取值` }
      const parsed = Number.parseInt(value, 10)
      // 0 天没有意义（窗口恒空），且会让周报永远说「没有召回」——
      // 那是个看起来正常的错误结论，比报错更难发现。
      if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, message: `选项 ${name} 需要正整数` }
      days = parsed
      continue
    }
    if (name === '--data-dir' || name === '--tz' || name === '--out' || name === '--reason'
      || name === '--in') {
      const value = takeValue(name, inline)
      if (value === undefined) return { ok: false, message: `选项 ${name} 缺少取值` }
      if (name === '--data-dir') dataDir = value
      else if (name === '--tz') timeZone = value
      else if (name === '--reason') reason = value
      else if (name === '--in') input = value
      else out = value
      continue
    }
    // `query` 的四个过滤 flag（FR-F2）。取值原样保留，语义由数据面
    // `MemoryFilter` 定义——这里**不做**第二套判据，否则同一个「域」
    // 会有两处解释，而两处解释迟早会漂移（缺陷二十五的形状）。
    if (name === '--domain' || name === '--kind' || name === '--tag' || name === '--since') {
      const value = takeValue(name, inline)
      if (value === undefined) return { ok: false, message: `选项 ${name} 缺少取值` }
      if (name === '--domain') domain = value
      else if (name === '--kind') kind = value
      else if (name === '--tag') tag = value
      else since = value
      continue
    }
    return { ok: false, message: `未知选项「${name}」` }
  }

  const first = positionals[0]
  if (helpRequested || first === undefined) {
    return {
      ok: true,
      options: {
        command: 'help', positionals: [], dataDir, timeZone, json, verbose, out, input, includeArchived,
        reason, limit, days, clear, domain, kind, tag, since,
      },
    }
  }
  if (!isCommand(first)) {
    return { ok: false, message: `未知子命令「${first}」，可用：${COMMANDS.join(' / ')}` }
  }
  return {
    ok: true,
    options: {
      command: first,
      positionals: positionals.slice(1),
      dataDir, timeZone, json, verbose, out, input, includeArchived, reason, limit, days, clear,
      domain, kind, tag, since,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 三、时区与输出小工具
 * ------------------------------------------------------------------ */

/**
 * 判断一个 IANA 时区名是否可用。
 *
 * 用 `Intl` 试构造一次：非法名字会抛 `RangeError`，这是最可靠的校验方式，
 * 比维护一张时区白名单便宜且不会过期。
 *
 * @param timeZone - 待校验的时区名。
 * @returns 合法时返回 `true`。
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * 决定本次调用使用的时区。
 *
 * 优先级：显式 `--tz` → 系统时区 → {@link FALLBACK_TIME_ZONE}。
 *
 * @param explicit - 命令行给出的时区；省略时取系统时区。
 * @returns 可用的 IANA 时区名。
 */
export function resolveTimeZone(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  try {
    const detected = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof detected === 'string' && detected.length > 0) return detected
  } catch {
    // 拿不到系统时区不是错误，退回固定值时区即可。
  }
  return FALLBACK_TIME_ZONE
}
