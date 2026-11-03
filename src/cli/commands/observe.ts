import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildWeeklyReport } from '../../core/metrics.ts'
import type { MemoryLogEntry } from '../../core/types.ts'
import type { MemoryEngine } from '../../host/engine.ts'
import type { MemoryStore } from '../../store/store.ts'
import { healthExitCode, jsonText, renderLog } from '../output.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult, ResolvedCliConfig } from '../types.ts'

/**
 * `logs` 子命令：读回落盘的诊断日志（FR-F1）。
 *
 * ## 为什么必须有这个子命令
 *
 * 日志落盘之后，如果没人能把它读回来，那和没落盘没有区别——
 * 用户仍然查不到「上一次运行发生了什么」，而这正是 FR-F1 的目的。
 * 只写不读是「算了没人看得见」的同一种病。
 *
 * 直接读文件而不是走 engine：日志是**旁路数据**，不是记忆状态。
 * 为读日志去开一个完整引擎（重放全库）代价过高，而且读日志本来
 * 就不该有副作用。
 *
 * @param options - 解析后的参数；`--limit` 控制条数。
 * @returns 命令结果。
 */
export function runLogs(options: CliOptions, resolved: ResolvedCliConfig, storeDir: string, timeZone: string): CliResult {
  const file = resolved.config.storage.logFile
  if (file.length === 0) {
    return { code: EXIT_OK, stdout: '', stderr: '诊断日志落盘已关闭（storage.logFile 为空串）\n' }
  }
  // 必须用 store.dir，与 engine 落盘位置保持同一来源。
  // 用 config.storage.dataDir 会在相对路径下拼出另一个位置——
  // 两边都「成功」，事后无从判断该看哪个。
  const path = join(storeDir, file)
  if (!existsSync(path)) {
    // 文件不存在不是错误：可能是刚装好还没跑过，或日志被清理了。
    return { code: EXIT_OK, stdout: options.json ? jsonText([]) : '', stderr: '还没有诊断日志\n' }
  }
  const limit = options.limit
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
  // 取**最后** limit 条：运维要看的永远是「最近发生了什么」。
  const tail = limit > 0 ? lines.slice(-limit) : lines
  const entries: MemoryLogEntry[] = []
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line) as MemoryLogEntry)
    } catch {
      // 单行损坏不能让整条命令失败：日志是旁路数据，
      // 一行写了一半（进程被杀）不该让人看不到其余记录。
      continue
    }
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText(entries), stderr: '' }
  if (entries.length === 0) return { code: EXIT_OK, stdout: '', stderr: '诊断日志为空\n' }
  const text = entries.map((entry) => renderLog(entry, timeZone)).join('\n')
  return { code: EXIT_OK, stdout: `${text}\n`, stderr: '' }
}

/**
 * 读回已落盘的诊断日志（供 `logs` 与 `report` 共用）。
 *
 * 抽出来是因为两个子命令的**读法必须完全一致**：一个说「最近 50 条」、
 * 另一个说「这一周」，若各自实现，周报的窗口边界和 `logs` 看到的内容
 * 会在无人察觉时漂移——而周报的全部价值就是「它统计的确实是发生过的事」。
 *
 * @param path - 日志文件绝对路径。
 * @returns 可解析的日志条目（按文件顺序，单行损坏跳过）。
 */
export function readLogEntries(path: string): MemoryLogEntry[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
  const entries: MemoryLogEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as MemoryLogEntry)
    } catch {
      // 单行损坏不能让整条命令失败（进程被杀时最后一行常是半条）。
      continue
    }
  }
  return entries
}

/**
 * `report` 子命令：最小周报（FR-F3）。
 *
 * 「最小」是需求原文的用词，含义是**能回答「这一周系统在做什么」**，
 * 不是仪表盘。所以只报 FR-F3 点名的五个指标 + 一句人话结论。
 *
 * 默认窗口 7 天，可用 `--days` 覆盖。
 *
 * @param options - 解析后的参数。
 * @param resolved - 解析后的配置。
 * @param storeDir - 记忆库目录（日志与它同源）。
 * @param active - 活跃卡片数。
 * @param archived - 归档卡片数。
 * @param now - 当前时刻。
 * @returns 命令结果。
 */
export function runReport(
  options: CliOptions, resolved: ResolvedCliConfig, storeDir: string,
  active: number, archived: number, now: number, timeZone: string,
): CliResult {
  const file = resolved.config.storage.logFile
  if (file.length === 0) {
    return { code: EXIT_OK, stdout: '', stderr: '诊断日志落盘已关闭（storage.logFile 为空串），无法生成周报\n' }
  }
  const days = options.days
  const since = now - days * 24 * 60 * 60 * 1000
  const logPath = join(storeDir, file)
  if (!existsSync(logPath)) {
    // 与 `logs` 子命令保持一致：文件不存在时说「还没有」，而不是输出一份
    // 全 0 周报。**全 0 周报会被读成「这一周系统没被用过」，而真相是
    // 「指标根本没记录」**——这两种情况需要的处置完全不同。
    return { code: EXIT_OK, stdout: '', stderr: '还没有诊断日志，无法生成周报' + String.fromCharCode(10) }
  }
  const all = readLogEntries(logPath)
  // 时间窗在这里筛选，`aggregateMetrics` 只负责算——这样「窗口边界」
  // 只有一处定义，纯函数也保持无时钟依赖（ST-1）。
  const windowed = all.filter((entry) => entry.at >= since && entry.at <= now)
  const report = buildWeeklyReport({
    entries: windowed,
    active,
    archived,
    since,
    until: now,
    // 时区由调用方传入，和 `logs` 用**同一个**已校验的 `timeZone`：
    // 两个子命令对同一批日志报出不同日期的周报，是「同一个库两套输出」的翻版。
    timeZone,
  })
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText({ days, since, until: now, ...report.metrics }), stderr: '' }
  }
  return { code: EXIT_OK, stdout: `${report.text}\n`, stderr: '' }
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
export function runHealth(
  options: CliOptions, store: MemoryStore, engine: MemoryEngine, resolved: ResolvedCliConfig,
): CliResult {
  const health = engine.health()
  // 配置降级与索引不一致都是「这个库现在不能信」。
  // 用 `!resolved.degraded` 而不是重新算一遍校验：判据只能有一份。
  const configOk = !resolved.degraded
  const code = healthExitCode({ indexOk: health.indexOk, configOk })
  if (options.json) {
    return {
      code,
      stdout: jsonText({
        ...health,
        // 首行的 `healthy` 必须与退出码一致，否则脚本读 json 与读 exit code
        // 会得到相反结论。不重新算，直接用同一个结果覆盖。
        healthy: code === EXIT_OK,
        configOk,
        dataDir: store.dir,
        configSource: resolved.source,
        spreadMode: resolved.config.spread.mode,
      }),
      stderr: '',
    }
  }
  const lines = [
    // 文案也由 `code` 推出，不单独算。原写法 `health.healthy ? ...`
    // 与退出码依赖两个不同字段，现在只靠巧合一致——
    // 一旦判据变形，就会出现「报异常却 exit 0」这种最坏的组合。
    `健康：${code === EXIT_OK ? '正常' : '异常'}`,
    `活跃：${health.active} 张`,
    `归档：${health.archived} 张`,
    `图谱边：${health.edges} 条`,
    `索引：${health.indexOk ? '一致' : '不一致'}`,
    `数据目录：${store.dir}`,
    // 配置来源与扩散模式必须报出来：健康检查是运维判断「这个库现在是什么样」
    // 的唯一入口，而 CLI 曾经用库默认值（shadow）而宿主用 patch（on），
    // 同一个库报出两套分数。报出来才能让人发现两边不一致。
    // 「配置来源」告诉人配置从哪来，但「配置是否可用」是另一件事。
    // 只报来源的话，`DEFAULT_CONFIG（patch 非法）` 这一行需要读者自己
    // 从括号里推断严重性——而它与第一行「健康」是同一个结论。
    `配置：${configOk ? '正常' : '异常（本次使用库默认配置，不是你配的那份）'}`,
    `配置来源：${resolved.source}`,
    `扩散模式：${resolved.config.spread.mode}`,
  ]
  return { code, stdout: `${lines.join('\n')}\n`, stderr: '' }
}
