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
import { pathToFileURL } from 'node:url'

import { DEFAULT_CONFIG, validateConfig } from '../core/config.ts'
import type { MemoryConfig } from '../core/config.ts'
import { buildFocusPack, formatTime, makeQuery, scoreCards } from '../core/scoring.ts'
import type { RecallQuery } from '../core/scoring.ts'
import type { FocusPack, MemoryCard, MemoryEdge, MemoryLogEntry } from '../core/types.ts'
import { MemoryEngine } from '../host/engine.ts'
import { EXPORT_FORMAT_VERSION } from '../store/export.ts'
import { openStore } from '../store/store.ts'
import type { MemoryStore } from '../store/store.ts'
import { pickDue } from '../time/clock.ts'

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
 * 时区回退值。
 *
 * 优先级是「`--tz` 显式指定 → 系统时区 → 本常量」。跟随系统时区是刻意的：
 * 宿主侧（`src/host/adapter.ts` 的 `resolveTimeZone`）用的也是系统时区，
 * CLI 与宿主看同一个库时必须用同一套时间语义，否则「今天整理过没有」会打架。
 * 只有 `Intl` 解析不出来时才退到这个常量。
 */
export const FALLBACK_TIME_ZONE = 'Asia/Shanghai'

/** 全部子命令，顺序即用法文本里的展示顺序。 */
const COMMANDS = ['query', 'export', 'rebuild', 'health', 'consolidate', 'help'] as const

/** 子命令名。 */
type Command = (typeof COMMANDS)[number]

/** CLI 实际使用的配置：默认配置即全部阈值的唯一来源（硬性约定 6）。 */
const CLI_CONFIG: MemoryConfig = DEFAULT_CONFIG

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
    '  反复查询不会让某几张卡越来越容易被召回。需要「使用并强化」时由宿主',
    '  在真正注入上下文后显式确认，那才是「使用」的定义。',
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

/**
 * 只读召回：组装焦点包，但**绝不写库**。
 *
 * 为什么不直接调 `engine.recall()`：那个方法在返回前会对每张命中卡
 * `append({ op: 'touch', strength: +accessBoost })`——它是给宿主「真的把这批
 * 记忆注入了上下文、即将被模型使用」准备的。CLI 的 `query` 只是运维人员
 * 敲一下看看库里有什么，**没有人会使用这些记忆**，凭什么算「使用」？
 * 若沿用 `engine.recall`，每敲一次查询就悄悄强化那几张卡：`accessCount` 上涨、
 * 半衰期变长、越来越容易被召回——这是富者愈富的马太效应，恰好与
 * 起源 L29（第 5 条·专注当前位置）要求的**抑制**语义相反，等于给 CLI
 * 开了一条无意的数据污染通道。
 *
 * 所以这里只取引擎的**纯函数**部分，候选池的组装规则与 `engine.recall`
 * 逐条对齐（倒排命中 → 已到期 → 钉住），但跳过 `touch` 与 `recallCount += 1`。
 * 附带好处：CLI 不依赖引擎改动，recall-dev 后续把「看到」与「使用」分开时，
 * 这个文件一行都不用动。
 *
 * @param store - 记忆库，只读访问。
 * @param config - 配置，提供候选上限与预算。
 * @param timeZone - 时区，用于构造时间读数。
 * @param queryText - 查询原文。
 * @param now - 当前时刻（毫秒）。
 * @returns 焦点包与候选池大小。
 */
export function readOnlyRecall(
  store: MemoryStore, config: MemoryConfig, timeZone: string, queryText: string, now: number,
): { pack: FocusPack; candidates: number } {
  const query = makeQuery(queryText, config, now)
  // 候选池三路来源与 engine.recall 一致，缺一路就会漏掉「该想起的」。
  const hitIds = new Set(store.search(query.tokens).map((hit) => hit.id))
  const cards: MemoryCard[] = []
  for (const id of hitIds) {
    const card = store.getCard(id)
    if (card !== undefined && card.status === 'active') cards.push(card)
  }
  for (const card of pickDue(store.listCards({ status: 'active' }), now)) {
    if (!hitIds.has(card.id)) cards.push(card)
  }
  for (const card of store.listCards({ status: 'active', pinned: true })) {
    if (!cards.some((existing) => existing.id === card.id)) cards.push(card)
  }

  const limited = cards.slice(0, config.recall.candidateLimit)
  const scored = scoreCards(limited, query, config)
  return { pack: buildFocusPack(scored, query, config), candidates: limited.length }
}

/**
 * 渲染一次只读召回结果。
 *
 * 格式与 `src/index.ts` 的 `/memory explain` 逐行对齐。
 *
 * @param pack - 焦点包。
 * @param candidates - 候选池大小。
 * @returns 人读文本。
 */
function renderRecall(pack: FocusPack, candidates: number): string {
  if (pack.cards.length === 0) {
    return `没有命中任何记忆（候选 ${candidates} 张）`
  }
  const lines: string[] = [`焦点包 ${pack.cards.length} 张，候选 ${candidates} 张`]
  for (const scored of pack.cards) {
    lines.push('')
    lines.push(`■ ${scored.card.text}`)
    lines.push(`  总分 ${scored.score.total.toFixed(3)}${scored.conflict ? '（有冲突）' : ''}`)
    for (const line of scored.explain) lines.push(`  ${line}`)
  }
  return lines.join('\n')
}

/**
 * `query` 子命令（FR-F2）。
 *
 * 纯只读：不改 `accessCount`、不改 `strength`、不写事件日志，因此
 * 「查一下看看」不会污染记忆库。需要「使用并强化」请由宿主在真正注入
 * 上下文后走 `confirmRecall`，那才是「使用」的定义。
 *
 * @param options - 解析后的参数。
 * @param store - 记忆库。
 * @param timeZone - 时区。
 * @param now - 当前时刻（毫秒）。
 * @returns 命令结果。
 */
function runQuery(
  options: CliOptions, store: MemoryStore, timeZone: string, now: number,
): CliResult {
  const queryText = options.positionals.join(' ').trim()
  if (queryText.length === 0) return usageFailure('query 需要一个关键词，例如：memoryctl query "部署"')

  const result = readOnlyRecall(store, CLI_CONFIG, timeZone, queryText, now)
  if (!options.json) {
    return { code: EXIT_OK, stdout: `${renderRecall(result.pack, result.candidates)}\n`, stderr: '' }
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
function runHealth(options: CliOptions, store: MemoryStore, engine: MemoryEngine): CliResult {
  const health = engine.health()
  const code = healthExitCode(health)
  if (options.json) {
    return {
      code,
      stdout: jsonText({ ...health, dataDir: store.dir }),
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

  // FR-F4：配置版本自洽是「参数可版本化」的前提。默认配置被改坏时，
  // 宁可明确报错，也不要带着错误阈值跑出一堆诡异结果。
  const validation = validateConfig(CLI_CONFIG)
  if (!validation.ok) {
    return storeFailure(`配置校验失败：\n${validation.errors.map((line) => `- ${line}`).join('\n')}`)
  }

  const dataDir = options.dataDir ?? CLI_CONFIG.storage.dataDir
  let store: MemoryStore
  try {
    store = openStore({ config: CLI_CONFIG, dataDir })
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
      config: CLI_CONFIG,
      timeZone,
      clock,
      onLog: (entry: MemoryLogEntry) => {
        logEntries.push(entry)
      },
    })
    switch (options.command) {
      case 'query':
        result = runQuery(options, store, timeZone, clock())
        break
      case 'export':
        result = runExport(options, store, engine, clock())
        break
      case 'rebuild':
        result = runRebuild(options, engine)
        break
      case 'health':
        result = runHealth(options, store, engine)
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
  if (result.stderr.length > 0) stderrParts.push(result.stderr)
  if (closeError !== undefined) stderrParts.push(closeError)
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
