/**
 * 离线命令行（memoryctl）：不启动 DSH 宿主也能查、导、重建记忆库。
 *
 * 为什么需要它：宿主里的 `/memory` 命令只在会话里可用，而运维动作
 * （健康检查、导出备份、重建索引、手动夜整理）恰恰发生在**没有会话**的时候。
 * 数据面与引擎都不依赖宿主（NFR-7），所以 CLI 可以直接装配它们，不需要
 * 拉起 Cordis、也不需要任何第三方命令行库（零依赖原则）。
 *
 * 需求承接：
 * - FR-F1 结构化日志：`--verbose` 把引擎的写入/召回/整理日志打到 stderr。
 * - FR-F2 查询命令：`query` 不需要开数据库就能按关键词查记忆。
 * - FR-F3 指标：`health` / `rebuild` 输出活跃、归档、图谱边、索引一致性。
 * - FR-F4 参数版本化与回滚：启动时用 `validateConfig` 校验配置版本自洽；
 *   `rebuild` 是「索引怀疑坏了就重来」的那条回滚路径。
 * - FR-F5 健康检查：`health` 一条命令报「健康/异常」，异常时退出码为 1。
 * - NFR-8 可测试：核心逻辑全部收敛在 {@link runCli} 这个纯函数里，
 *   返回 `{ code, stdout, stderr }` 而不是直接写终端，单测无需捕获标准流。
 *
 * 对应起源：
 * - 起源 L27（第 4 条·今日记忆渐进累积，夜晚休眠整理）→ `consolidate` 子命令
 *   把「夜晚休眠整理」变成一个可以随时手动触发的动作。
 * - 起源 L31（第 6 条·上下文等同于某一瞬间的大脑信号瞬时状态）→ `query`
 *   只打印焦点包（Focus Pack，本轮真正会注入的那几张卡），绝不倾倒整库。
 * - 起源 L33（第 7 条·利用有限的上下文衍生智能）→ `query` 同时打印 token
 *   用量与预算，让「注入多少」这件事可被核对，而不是靠感觉。
 *
 * 退出码约定（脚本可依赖）：
 * - `0` 正常。
 * - `1` 健康检查异常，或记忆库打不开（库坏了本身就是「异常」）。
 * - `2` 用法错误：未知子命令、未知选项、选项缺值、缺关键词。
 *
 * @module dsh-memory/cli/memoryctl
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../core/config.ts'
import type { DeepPartial, MemoryConfig } from '../core/config.ts'
import { renderFocusPackExplain } from '../core/render.ts'
import { formatTime } from '../core/scoring.ts'
import type { MemoryCard, MemoryEdge, MemoryLogEntry } from '../core/types.ts'
import { MemoryEngine } from '../host/engine.ts'
import { loadPatchConfig } from '../host/patchConfig.ts'
import { EXPORT_FORMAT_VERSION } from '../store/export.ts'
import { openStore } from '../store/store.ts'
import type { MemoryStore } from '../store/store.ts'

/* ------------------------------------------------------------------ *
 * 一、常量与类型
 * ------------------------------------------------------------------ */

/** 正常退出。 */
export const EXIT_OK = 0

/** 健康检查异常，或记忆库打不开。 */
export const EXIT_UNHEALTHY = 1

/** 用法错误：未知子命令、未知选项、选项缺值。 */
export const EXIT_USAGE = 2

/** 命令行名字，用于错误提示与用法文本。 */
export const CLI_NAME = 'memoryctl'

/**
 * 时区回退值：**只在前两步都拿不到时区时才用到**。
 *
 * 为什么 `--tz` 的默认值不是直接写死本常量（虽然需求规格的初稿就是这么写的）：
 * 宿主侧（`src/host/adapter.ts` 的 `resolveTimeZone`）解析的是**系统时区**。
 * CLI 与宿主读的是同一个库、同一批 `createdAt`/`dueAt`/`lastConsolidationAt`，
 * 一旦两边默认时区不同，「今天整理过没有」「距上次会话多久」就会算出两个答案——
 * 同一个库在终端里说「3 小时前」，在会话里说「昨天」。这种不一致极难排查，
 * 而且会在跨时区机器上稳定复现。
 *
 * 因此取值顺序固定为：
 * 1. 显式 `--tz <IANA>`（用户说了算，也便于复现 bug）；
 * 2. 系统时区（与宿主天然一致，这是绝大多数情况）；
 * 3. 本常量（仅在 `Intl` 拿不到系统时区时兜底，保证永远有一个可用值）。
 *
 * 想改回写死：只改 {@link resolveTimeZone} 的第一行，别删这三步。
 */
export const FALLBACK_TIME_ZONE = 'Asia/Shanghai'

/** 全部子命令，顺序即用法文本里的展示顺序。 */
const COMMANDS = ['query', 'export', 'rebuild', 'health', 'consolidate', 'help'] as const

/** 子命令名。 */
type Command = (typeof COMMANDS)[number]

/**
 * 解析后的命令行参数。
 *
 * 所有字段都显式带上 `undefined` 而不是「可选属性」，这样调用方读
 * `options.dataDir` 时不必区分「没给」与「给空」两种状态。
 */
export interface CliOptions {
  /** 子命令。 */
  readonly command: Command
  /** 子命令之后的位置参数；`query` 用它拼关键词。 */
  readonly positionals: readonly string[]
  /** 数据目录；省略时取 `DEFAULT_CONFIG.storage.dataDir`。 */
  readonly dataDir: string | undefined
  /** 时区；省略时取系统时区。 */
  readonly timeZone: string | undefined
  /** 是否输出机器可读 JSON。 */
  readonly json: boolean
  /** 是否把结构化日志打到 stderr（FR-F1）。 */
  readonly verbose: boolean
  /** `export` 的输出文件；省略时写 stdout。 */
  readonly out: string | undefined
  /** `export` 是否连归档卡一起导出。 */
  readonly includeArchived: boolean
}

/** 参数解析结果。失败时只带一条人可读信息，不带异常。 */
export type ParseOutcome =
  | { readonly ok: true; readonly options: CliOptions }
  | { readonly ok: false; readonly message: string }

/** 一次 CLI 调用的结果。 */
export interface CliResult {
  /** 进程退出码。 */
  readonly code: number
  /** 标准输出文本（含结尾换行；空串表示不输出）。 */
  readonly stdout: string
  /** 标准错误文本（含结尾换行；空串表示不输出）。 */
  readonly stderr: string
}

/** 注入点：让单测可以固定时钟，跑出确定性结果。 */
export interface CliIo {
  /** 当前时刻（毫秒）；省略时取 `Date.now`。 */
  now?: () => number
  /**
   * patch 文件路径；省略时取本包自带的 `cordis.patch.yml`。
   *
   * 之所以要能注入：单测必须能验证「配置来源不同 ⇒ 结果不同」这个事实，
   * 而不是依赖仓库里那个文件的当前内容（那会把测试绑在别人的编辑上）。
   */
  configPath?: string
}

/** 导出文档：`export` 子命令的 JSON 结构。 */
interface ExportDocument {
  /** 导出格式版本，复用数据面的 {@link EXPORT_FORMAT_VERSION}。 */
  formatVersion: number
  /** 导出时刻（毫秒时间戳）。 */
  exportedAt: number
  /** 数据目录绝对路径，便于人确认「导的是哪个库」。 */
  dataDir: string
  /** 计数。 */
  counts: {
    /** 活跃卡数（与导出范围无关，始终是全库真实计数）。 */
    active: number
    /** 归档卡数。 */
    archived: number
    /** 图谱边数。 */
    edges: number
    /** 本次实际导出的卡数。 */
    exported: number
  }
  /** 导出的卡片，按 id 升序（保证同一状态导出结果可 diff，ST-8）。 */
  cards: MemoryCard[]
  /** 导出的图谱边，按 id 升序。 */
  edges: MemoryEdge[]
}

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
 * CLI 实际使用的配置**解析结果**。
 *
 * 关键点：这个类型存在的理由是「让配置来源成为可报告的事实」。
 * 曾经 CLI 写死 `DEFAULT_CONFIG`，而宿主读 patch，两者在 `spread.mode` 上
 * 分别是 `shadow` / `on`——同一个库、同一个查询，终端与会话报出不同分数
 * （实测 3/3 查询不一致）。CLI 的存在意义就是「让我看看记忆库现在是什么样」，
 * 它报的却不是模型看到的，那它比没有更糟：**一个说错的观测点比没有观测点
 * 更危险，因为人会信它。**
 */
export interface ResolvedCliConfig {
  /** 实际生效的配置。 */
  readonly config: MemoryConfig
  /** 配置来自哪里，供 `health` 与人读输出显示。 */
  readonly source: string
  /** 解析过程中的提醒（例如 patch 缺失后退回默认值）。 */
  readonly notes: readonly string[]
}

/**
 * 解析 CLI 用的配置：**与宿主同源**——读同一个 `cordis.patch.yml`。
 *
 * 退回 `DEFAULT_CONFIG` 时必须在 `notes` 里说出来，绝不静默降级：
 * 静默降级正是本仓库反复吃亏的那一类问题（用户以为打开了突触效果，
 * 实际跑的是影子模式，而且没有任何东西告诉他）。
 *
 * @param io - 注入点（`configPath` 可覆盖 patch 路径）。
 * @returns 解析结果；`config` 一定可用。
 */
function resolveCliConfig(io: CliIo): ResolvedCliConfig {
  const notes: string[] = []
  const path = io.configPath ?? fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
  const loaded = loadPatchConfig(path)
  if (!loaded.ok) {
    notes.push(`未能从 ${path} 读取配置（${loaded.reason}），本次使用库默认配置`)
    return { config: DEFAULT_CONFIG, source: 'DEFAULT_CONFIG（未读到 patch）', notes }
  }
  const merged = mergeConfig(DEFAULT_CONFIG, loaded.config as DeepPartial<MemoryConfig>)
  const validation = validateConfig(merged)
  if (!validation.ok) {
    notes.push(
      `patch 里的配置不合法，本次使用库默认配置：\n`
      + validation.errors.map((line) => `- ${line}`).join('\n'),
    )
    return { config: DEFAULT_CONFIG, source: 'DEFAULT_CONFIG（patch 非法）', notes }
  }
  return { config: merged, source: path, notes }
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
  let json = false
  let verbose = false
  let includeArchived = false
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
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }

    // 带值选项：拆出 `--name=value` 形式。
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(0, equals) : arg
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined
    if (name === '--data-dir' || name === '--tz' || name === '--out') {
      const value = takeValue(name, inline)
      if (value === undefined) return { ok: false, message: `选项 ${name} 缺少取值` }
      if (name === '--data-dir') dataDir = value
      else if (name === '--tz') timeZone = value
      else out = value
      continue
    }
    return { ok: false, message: `未知选项「${name}」` }
  }

  const first = positionals[0]
  if (helpRequested || first === undefined) {
    return {
      ok: true,
      options: {
        command: 'help', positionals: [], dataDir, timeZone, json, verbose, out, includeArchived,
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
      dataDir, timeZone, json, verbose, out, includeArchived,
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

/**
 * 把值序列化成「两个空格缩进 + 结尾换行」的 JSON。
 *
 * @param value - 任意可序列化的值。
 * @returns JSON 文本。
 */
function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * 把异常转成人可读的一行文本。
 *
 * @param error - 捕获到的任意值。
 * @returns 错误信息。
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 按 id 升序比较两张卡或两条边。
 *
 * 不用 `localeCompare`：它受 locale 影响，会让「同一状态导出结果一致」
 * 这条验收（ST-8）在不同机器上漂移。
 *
 * @param a - 左值。
 * @param b - 右值。
 * @returns 比较结果。
 */
function byId<T extends { id: string }>(a: T, b: T): number {
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * 拼一条用法错误的结果。
 *
 * @param message - 具体错误信息。
 * @returns 退出码为 {@link EXIT_USAGE} 的结果。
 */
function usageFailure(message: string): CliResult {
  return {
    code: EXIT_USAGE,
    stdout: '',
    stderr: `${message}\n提示：${CLI_NAME} --help 查看用法\n`,
  }
}

/**
 * 拼一条「库打不开」的结果。
 *
 * 打不开库本身就算「异常」，所以退出码用 {@link EXIT_UNHEALTHY}（FR-F5）。
 *
 * @param message - 具体错误信息。
 * @returns 退出码为 {@link EXIT_UNHEALTHY} 的结果。
 */
function storeFailure(message: string): CliResult {
  return { code: EXIT_UNHEALTHY, stdout: '', stderr: `${message}\n` }
}

/* ------------------------------------------------------------------ *
 * 四、用法文本
 * ------------------------------------------------------------------ */

/**
 * 生成中文用法说明。
 *
 * 默认数据目录从 {@link DEFAULT_CONFIG} 取，不在文本里另写一份字面量——
 * 否则改了默认值而忘了改帮助文本，用户会看到过期说明。
 *
 * @returns 用法文本（含结尾换行）。
 */
export function helpText(): string {
  const defaultDataDir = DEFAULT_CONFIG.storage.dataDir
  const lines = [
    'dsh-memory 离线命令行：不启动宿主也能查、导、重建记忆库',
    '',
    '用法：',
    `  ${CLI_NAME} <子命令> [参数] [选项]`,
    '',
    '子命令：',
    '  query <关键词>            召回并打印焦点包与分数构成（与 /memory explain 同格式）',
    '  export [--out <路径>]     导出全部记忆卡与图谱边为 JSON（默认写 stdout）',
    '  rebuild                   从事件日志重建索引，打印扫描记录数与活跃卡数',
    '  health                    健康检查；索引不一致时退出码为 1',
    '  consolidate               手动执行一次夜整理（去重、合并、降权、归档）',
    '  help                      显示本帮助（等同 -h / --help / 无参数）',
    '',
    '全局选项：',
    `  --data-dir <路径>         数据目录，默认 ${defaultDataDir}`,
    `  --tz <IANA>               时区，默认取系统时区（解析失败退回 ${FALLBACK_TIME_ZONE}）`,
    '  --json                    输出机器可读 JSON 而非人读文本',
    '  --verbose                 把结构化日志（FR-F1）打到 stderr',
    '  -h, --help                显示本帮助',
    '',
    'export 专用选项：',
    '  --out <路径>              写入文件而不是 stdout（父目录不存在时自动创建）',
    '  --include-archived        连归档卡一起导出',
    '',
    '退出码：',
    '  0  正常',
    '  1  健康检查异常，或记忆库打不开',
    '  2  用法错误（未知子命令、未知选项、选项缺值、缺关键词）',
    '',
    '说明：',
    '  query 与 export 都是只读的：不改访问计数、不改强度、不写事件日志，',
    '  反复查询不会让某几张卡越来越容易被召回。需要「使用并强化」时由宿主侧',
    '  显式确认（该能力在实现中）。',
    '',
    '示例：',
    `  ${CLI_NAME} health`,
    `  ${CLI_NAME} query "部署" --data-dir ./data`,
    `  ${CLI_NAME} export --include-archived --out backup.json`,
    `  ${CLI_NAME} consolidate --json --verbose`,
  ]
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------------ *
 * 五、子命令实现
 * ------------------------------------------------------------------ */

// 只读召回直接用 `engine.peek()`，本文件不再自己拼候选池。
//
// 这里原先有一份手写的 `readOnlyRecall`：自己走倒排命中 → 已到期 → 钉住三路
// 组装候选池，再 `scoreCards` + `buildFocusPack`。当时 `engine.recall` 还会写
// `touch`，CLI 想只读只能绕开引擎。后来引擎把「看到」与「使用」拆开了——
// `peek` 纯只读、`confirmRecall` 才写——那份手写实现就变成了纯粹的重复，
// 而且是会漂移的重复：它的 `candidates` 返回的是 `candidateLimit` 截断后的
// 数量，`peek` 返回的是完整候选池大小，同一个库在终端与会话里会报出两个
// 不同的候选数。少一份实现就少一处需要人肉同步的漂移点。
//
// 判断依据：`peek` 已在 `src/host/engine.ts` 里提供等价语义，且 CLI 本来就
// 会构造一个 `MemoryEngine`（export/rebuild/health/consolidate 都要用），
// 不存在「为了用 peek 额外拉起引擎」的代价。

// 人读渲染统一走 `src/core/render.ts` 的 `renderFocusPackExplain`。
// 这里原先有一份本地实现，与 `src/index.ts` 的 `/memory explain` 逐行重复，
// 靠人肉同步维持一致——改一处忘一处，同一个库在终端与会话里就会显示两种
// 格式，而且没人会立刻发现。现在一致性由共享实现保证。

/**
 * `query` 子命令（FR-F2）。
 *
 * 纯只读：走 `engine.peek()`，不改 `accessCount`、不改 `strength`、
 * 不写事件日志，因此「查一下看看」不会污染记忆库。
 * 「使用并强化」需要宿主侧显式确认（`engine.confirmRecall`），CLI 不提供、
 * 也不该提供——运维敲一眼不等于记忆被用过。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎（只调用其只读入口）。
 * @returns 命令结果。
 */
function runQuery(options: CliOptions, engine: MemoryEngine): CliResult {
  const queryText = options.positionals.join(' ').trim()
  if (queryText.length === 0) return usageFailure('query 需要一个关键词，例如：memoryctl query "部署"')

  const result = engine.peek(queryText)
  if (!options.json) {
    return { code: EXIT_OK, stdout: `${renderFocusPackExplain(result.pack, result.candidates)}\n`, stderr: '' }
  }
  const payload = {
    query: queryText,
    candidates: result.candidates,
    tokens: result.pack.tokens,
    budgetTokens: result.pack.budgetTokens,
    maxCardChars: result.pack.maxCardChars,
    empty: result.pack.empty,
    note: result.pack.note,
    cards: result.pack.cards.map((scored) => ({
      id: scored.card.id,
      kind: scored.card.kind,
      domain: scored.card.domain,
      text: scored.card.text,
      conflict: scored.conflict,
      score: scored.score,
      explain: scored.explain,
    })),
  }
  return { code: EXIT_OK, stdout: jsonText(payload), stderr: '' }
}

/**
 * `export` 子命令（FR-A6 的离线出口）。
 *
 * 顺序固定（id 升序），导出文件可 diff、可做哈希比对（ST-8）。
 *
 * @param options - 解析后的参数。
 * @param store - 记忆库。
 * @param engine - 记忆引擎。
 * @param now - 导出时刻。
 * @returns 命令结果。
 */
function runExport(
  options: CliOptions, store: MemoryStore, engine: MemoryEngine, now: number,
): CliResult {
  const cards = engine.query(options.includeArchived ? {} : { status: 'active' })
  const edges = [...store.snapshot().edges.values()]
  const document: ExportDocument = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now,
    dataDir: store.dir,
    counts: {
      active: store.count('active'),
      archived: store.count('archived'),
      edges: edges.length,
      exported: cards.length,
    },
    cards: [...cards].sort(byId),
    edges: [...edges].sort(byId),
  }

  if (options.out === undefined) {
    return { code: EXIT_OK, stdout: jsonText(document), stderr: '' }
  }

  const target = resolve(options.out)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, jsonText(document), 'utf8')
  } catch (error) {
    return storeFailure(`写入导出文件失败：${describeError(error)}`)
  }

  const summary = {
    out: target,
    exported: document.counts.exported,
    active: document.counts.active,
    archived: document.counts.archived,
    edges: document.counts.edges,
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText(summary), stderr: '' }
  const text = `已导出 ${summary.exported} 张卡片（活跃 ${summary.active} / 归档 ${summary.archived}）、`
    + `${summary.edges} 条图谱边 → ${target}`
  return { code: EXIT_OK, stdout: `${text}\n`, stderr: '' }
}

/**
 * `rebuild` 子命令（FR-F4 的运维动作）。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
function runRebuild(options: CliOptions, engine: MemoryEngine): CliResult {
  const report = engine.rebuild()
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText(report), stderr: '' }
  }
  const text = `索引已重建：扫描 ${report.records} 条日志记录，活跃 ${report.active} 张`
  return { code: EXIT_OK, stdout: `${text}\n`, stderr: '' }
}

/**
 * 由健康检查结果推导退出码（FR-F5）。
 *
 * 单独抽成纯函数，是为了让「索引不一致 ⇒ 退出码 1」这条约定能被直接断言：
 * 索引不一致是数据面内部的坏状态，端到端很难造出来，但退出码语义必须锁死。
 *
 * @param health - 只取判定所需字段，便于单测构造。
 * @returns 索引一致时 {@link EXIT_OK}，否则 {@link EXIT_UNHEALTHY}。
 */
export function healthExitCode(health: { indexOk: boolean }): number {
  return health.indexOk ? EXIT_OK : EXIT_UNHEALTHY
}

/**
 * `health` 子命令（FR-F5）。
 *
 * 索引与卡片不一致时退出码为 1——「一条命令报健康/异常」要能被脚本判断，
 * 只打印一行「异常」而退出 0 等于没报。
 *
 * @param options - 解析后的参数。
 * @param store - 记忆库。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
function runHealth(
  options: CliOptions, store: MemoryStore, engine: MemoryEngine, resolved: ResolvedCliConfig,
): CliResult {
  const health = engine.health()
  const code = healthExitCode(health)
  if (options.json) {
    return {
      code,
      stdout: jsonText({
        ...health,
        dataDir: store.dir,
        configSource: resolved.source,
        spreadMode: resolved.config.spread.mode,
      }),
      stderr: '',
    }
  }
  const lines = [
    `健康：${health.healthy ? '正常' : '异常'}`,
    `活跃：${health.active} 张`,
    `归档：${health.archived} 张`,
    `图谱边：${health.edges} 条`,
    `索引：${health.indexOk ? '一致' : '不一致'}`,
    `数据目录：${store.dir}`,
    // 配置来源与扩散模式必须报出来：健康检查是运维判断「这个库现在是什么样」
    // 的唯一入口，而 CLI 曾经用库默认值（shadow）而宿主用 patch（on），
    // 同一个库报出两套分数。报出来才能让人发现两边不一致。
    `配置来源：${resolved.source}`,
    `扩散模式：${resolved.config.spread.mode}`,
  ]
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * `consolidate` 子命令（FR-C1 / 起源 L27 的「夜晚休眠整理」手动触发）。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
function runConsolidate(options: CliOptions, engine: MemoryEngine): CliResult {
  const report = engine.consolidate()
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText(report), stderr: '' }
  }
  const lines = [
    `整理完成：合并 ${report.merged} 组，归档 ${report.archived} 张`,
    `活跃 ${report.beforeActive} → ${report.afterActive} 张`,
    `降权 ${report.decayed} 张，重建索引 ${report.reindexed} 条`,
  ]
  if (report.notes.length > 0) {
    lines.push('')
    lines.push('变更：')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * 渲染一条结构化日志（FR-F1）。
 *
 * @param entry - 日志条目。
 * @param timeZone - 时区，用于把时间戳转成本地可读时间。
 * @returns 一行日志文本。
 */
function renderLog(entry: MemoryLogEntry, timeZone: string): string {
  return `[${entry.kind}] ${formatTime(entry.at, timeZone)} ${entry.summary}`
}

/* ------------------------------------------------------------------ *
 * 六、入口
 * ------------------------------------------------------------------ */

/**
 * 执行一次 CLI 调用。
 *
 * 这是整个 CLI 的唯一副作用边界：解析参数、打开库、派发子命令、关闭库。
 * 它**不**写标准流、**不**调 `process.exit`，只把结果作为数据返回，
 * 因此单测可以直接断言退出码与输出，不需要捕获进程级副作用。
 *
 * @param argv - 不含 node 与脚本路径的参数数组（即 `process.argv.slice(2)`）。
 * @param io - 注入点；省略时用真实时钟。
 * @returns 退出码与标准输出/错误文本。
 */
export function runCli(argv: readonly string[], io: CliIo = {}): CliResult {
  const parsed = parseArgs(argv)
  if (!parsed.ok) return usageFailure(parsed.message)
  const options = parsed.options
  if (options.command === 'help') return { code: EXIT_OK, stdout: helpText(), stderr: '' }

  // 时区先校验：非法时区会让后面每一次时间格式化都抛 RangeError，
  // 与其在渲染阶段炸掉，不如在入口处直接报用法错误。
  const timeZone = resolveTimeZone(options.timeZone)
  if (!isValidTimeZone(timeZone)) return usageFailure(`无效时区「${timeZone}」`)

  // FR-F4：配置版本自洽是「参数可版本化」的前提。配置被改坏时，
  // 宁可明确报错，也不要带着错误阈值跑出一堆诡异结果。
  //
  // 配置**必须与宿主同源**（读同一个 patch）：曾经这里写死 `DEFAULT_CONFIG`，
  // 而宿主读 patch，两者在 `spread.mode` 上分别是 shadow / on ⇒ 同一个库、
  // 同一个查询，终端与会话报出不同分数（实测 3/3 查询不一致）。
  // 退回默认值时 `resolveCliConfig` 会在 `notes` 里说明，不静默降级。
  const resolved = resolveCliConfig(io)
  const cliConfig = resolved.config
  const validation = validateConfig(cliConfig)
  if (!validation.ok) {
    return storeFailure(`配置校验失败：\n${validation.errors.map((line) => `- ${line}`).join('\n')}`)
  }

  const dataDir = options.dataDir ?? cliConfig.storage.dataDir
  let store: MemoryStore
  try {
    store = openStore({ config: cliConfig, dataDir })
  } catch (error) {
    return storeFailure(`打开记忆库失败（${resolve(dataDir)}）：${describeError(error)}`)
  }

  const logEntries: MemoryLogEntry[] = []
  const clock = io.now ?? ((): number => Date.now())
  let result: CliResult
  let closeError: string | undefined
  try {
    const engine = new MemoryEngine({
      store,
      config: cliConfig,
      timeZone,
      clock,
      onLog: (entry: MemoryLogEntry) => {
        logEntries.push(entry)
      },
    })
    switch (options.command) {
      case 'query':
        result = runQuery(options, engine)
        break
      case 'export':
        result = runExport(options, store, engine, clock())
        break
      case 'rebuild':
        result = runRebuild(options, engine)
        break
      case 'health':
        result = runHealth(options, store, engine, resolved)
        break
      case 'consolidate':
        result = runConsolidate(options, engine)
        break
      default:
        // `help` 已在前面提前返回，这里是穷尽性兜底。
        result = { code: EXIT_OK, stdout: helpText(), stderr: '' }
        break
    }
  } finally {
    try {
      store.close()
    } catch (error) {
      // 关闭失败不该盖掉真正的结果，但要让人知道（在下面并入 stderr）。
      closeError = `关闭记忆库失败：${describeError(error)}\n`
    }
  }

  const stderrParts: string[] = []
  // 配置退回默认值必须让人看见。静默降级会让运维以为「我改的 patch 生效了」，
  // 而他看到的其实是默认行为——这与「用户以为打开了突触效果，实际跑的是
  // 影子模式」是同一类问题，只是发生在 CLI 侧。
  for (const note of resolved.notes) stderrParts.push(`配置提醒：${note}\n`)
  if (result.stderr.length > 0) stderrParts.push(result.stderr)
  if (closeError !== undefined) stderrParts.push(closeError)
  if (options.verbose) {
    stderrParts.push(`配置来源：${resolved.source}（spread.mode = ${cliConfig.spread.mode}）\n`)
  }
  if (options.verbose && logEntries.length > 0) {
    for (const entry of logEntries) stderrParts.push(`${renderLog(entry, timeZone)}\n`)
  }
  if (stderrParts.length === 0) return result
  return { code: result.code, stdout: result.stdout, stderr: stderrParts.join('') }
}

/**
 * 判断本模块是否被 `node` 直接执行（而不是被 import）。
 *
 * ESM 下没有 `require.main === module`，只能比较入口脚本的 file URL。
 *
 * @returns 直接执行时返回 `true`。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

/**
 * 进程入口：把 {@link runCli} 的结果写进标准流并设置退出码。
 */
function main(): void {
  const result = runCli(process.argv.slice(2))
  if (result.stdout.length > 0) process.stdout.write(result.stdout)
  if (result.stderr.length > 0) process.stderr.write(result.stderr)
  process.exitCode = result.code
}

if (isDirectRun()) main()
