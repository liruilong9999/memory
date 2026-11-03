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
 * - FR-F4 参数版本化与回滚：`config list` 列出每一份生效过的配置快照，
 *   `config diff` 报叶子级变化（P7「改动可追溯」），`config rollback <id>`
 *   把配置拉回某一份快照（验收「改坏能一键回滚」）。
 *
 *   **这里曾经是错的**：原注释写「`rebuild` 是那条回滚路径」。
 *   `rebuild` 重放的是**记忆数据**，一个字都不碰配置——
 *   用户按文档去「回滚」，配置原封不动，而他不会收到任何提示。
 *   **能力存在但用户拿不到，比完全没实现更危险。**
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

import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { validateConfig } from '../core/config.ts'
import type { MemoryLogEntry } from '../core/types.ts'
import { MemoryEngine } from '../host/engine.ts'
import { recordConfigSnapshot } from '../store/configLedger.ts'
import { openStore } from '../store/store.ts'
import type { MemoryStore } from '../store/store.ts'
import { isValidTimeZone, parseArgs, resolveTimeZone } from './args.ts'
import { runConfig } from './commands/config.ts'
import { runExport } from './commands/export.ts'
import { runImport } from './commands/import.ts'
import { runRebuild, runConsolidate, runRestore, runRevise } from './commands/mutate.ts'
import { runHealth, runLogs, runReport } from './commands/observe.ts'
import { runQuery } from './commands/query.ts'
import { helpText } from './help.ts'
import { describeError, renderLog, storeFailure, usageFailure } from './output.ts'
import { resolveCliConfig } from './resolveConfig.ts'
import { EXIT_OK } from './types.ts'
import type { CliIo, CliResult } from './types.ts'

// barrel（桶文件）：拆分后对外公开的名字一个不少，调用方仍从本文件 import。
export {
  CLI_NAME, EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE, FALLBACK_TIME_ZONE,
} from './types.ts'
export type { CliIo, CliOptions, CliResult, ParseOutcome, ResolvedCliConfig } from './types.ts'
export { isValidTimeZone, parseArgs, resolveTimeZone } from './args.ts'
export { helpText } from './help.ts'
export { healthExitCode } from './output.ts'

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
  const resolved = resolveCliConfig(io, options.dataDir)
  const cliConfig = resolved.config

  // `config` 子命令必须在「校验」与「开库」**之前**处理。
  //
  // FR-F4 的验收是「改坏能一键回滚」。配置被改坏时，下面那两步都会失败
  // （校验报错 / 开库报错），而回滚正是为了修复那个错误——
  // **先校验等于拒绝救自己**。它也不需要开库：台账是目录里的独立文件，
  // 不经事件日志（见 `src/store/configLedger.ts` 的模块注释）。
  const configDataDir = options.dataDir ?? resolved.dataDir
  if (options.command === 'config') {
    // 传 `baseline` 而不是 `cliConfig`：patch 已坏时 `cliConfig` 已退回默认值，
    // 拿它当「当前值」会让回滚误以为「已经就是目标值」而什么都不写。
    // 参见 `ResolvedCliConfig.baseline` 的注释。
    return runConfig(options, resolved.baseline, configDataDir, (io.now ?? ((): number => Date.now()))(), timeZone)
  }

  const validation = validateConfig(cliConfig)
  if (!validation.ok) {
    return storeFailure(`配置校验失败：\n${validation.errors.map((line) => `- ${line}`).join('\n')}`)
  }

  // 与 `config` 子命令同一个来源：配置坏掉时也要看用户那个库，
  // 不能因为配置降级就把整个库换成默认目录（真缺陷十六）。
  const dataDir = options.dataDir ?? resolved.dataDir
  let store: MemoryStore
  try {
    store = openStore({ config: cliConfig, dataDir })
  } catch (error) {
    return storeFailure(`打开记忆库失败（${resolve(dataDir)}）：${describeError(error)}`)
  }

  const logEntries: MemoryLogEntry[] = []
  const clock = io.now ?? ((): number => Date.now())

  // FR-F4：执行任意子命令也记一条快照。
  //
  // 不记的话，`config list` 的空表文案「执行任意子命令后会自动记下
  // 第一条」就是假的——而**错误文案是承诺，不是装饰**。
  // 另一层理由：只有宿主启动才记快照的话，一个只用 CLI 维护
  // 的库永远没有回滚点，而恰恰是 CLI 会员手改配置。
  //
  // 降级态（patch 读不到或校验失败、已退回默认值）**不记**快照。
  // 它不是用户意图：记下去会在需要回滚的那一刻成为最新的「回滚点」，
  // 而那个点里没有任何用户真正想要的值——回滚到它等于回滚到「一个错误」。
  try {
    if (!resolved.degraded) {
      recordConfigSnapshot(store.dir, cliConfig, clock(), cliConfig.storage.configSnapshotMaxEntries)
    }
  } catch (error) {
    // 不阻断命令：快照是旁路可观测能力。但要报出来，
    // 否则「没有回滚点」会在需要回滚的那一天才被发现。
    logEntries.push({
      kind: 'error',
      at: clock(),
      summary: `记录配置快照失败（回滚点将不完整）：${describeError(error)}`,
      detail: {},
    })
  }

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
        result = runQuery(options, engine, timeZone)
        break
      case 'export':
        result = runExport(options, store, engine, clock())
        break
      case 'import':
        result = runImport(options, store)
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
      case 'restore':
        result = runRestore(options, engine)
        break
      case 'revise':
        result = runRevise(options, engine)
        break
      case 'logs':
        result = runLogs(options, resolved, store.dir, timeZone)
        break
      case 'report':
        result = runReport(
          options, resolved, store.dir, store.count('active'), store.count('archived'), clock(), timeZone,
        )
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
