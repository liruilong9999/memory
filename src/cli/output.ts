import { formatTime } from '../core/scoring.ts'
import type { MemoryLogEntry } from '../core/types.ts'
import { CLI_NAME, EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE } from './types.ts'
import type { CliResult } from './types.ts'

/**
 * 把值序列化成「两个空格缩进 + 结尾换行」的 JSON。
 *
 * @param value - 任意可序列化的值。
 * @returns JSON 文本。
 */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * 把异常转成人可读的一行文本。
 *
 * @param error - 捕获到的任意值。
 * @returns 错误信息。
 */
export function describeError(error: unknown): string {
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
export function byId<T extends { id: string }>(a: T, b: T): number {
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
export function usageFailure(message: string): CliResult {
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
export function storeFailure(message: string): CliResult {
  return { code: EXIT_UNHEALTHY, stdout: '', stderr: `${message}\n` }
}

/**
 * 由健康检查结果推导退出码（FR-F5）。
 *
 * 单独抽成纯函数，是为了让判据能被直接断言：索引不一致是数据面内部的
 * 坏状态，端到端很难造出来，但退出码语义必须锁死。
 *
 * ## 为什么配置也在判据里（真缺陷十五）
 *
 * 原实现只看 `indexOk`。于是下面这个场景报了「健康：正常」、退出 0：
 *
 * ```text
 * patch 写成 recall.absoluteThreshold: -5
 *   → 宿主 resolveConfig 抛错，插件根本没法加载
 *   → memoryctl health 报「健康：正常」、exit 0
 * ```
 *
 * 而「一条命令报健康/异常」恰恰是为这种时候存在的：用户发现记忆不生效，
 * 跑一条 health，得到的答案是「一切正常」。**一个报错的观测点比没有
 * 观测点更危险，因为人会信它。**
 *
 * 配置降级（读不到 patch 或校验失败退回默认值）与索引不一致是**两件不同的事**，
 * 但对「这个库现在能不能用」而言同样是否。两个字段都**必填**：
 * 设成可选会让下一个调用方漏传，而漏传的后果恰恰是回到真缺陷十五。
 *
 * @param health - 只取判定所需字段，便于单测构造。
 * @param health.indexOk - 索引与卡片是否一致。
 * @param health.configOk - 配置是否真的被读到并通过校验（`!degraded`）。
 * @returns 两项都正常时 {@link EXIT_OK}，否则 {@link EXIT_UNHEALTHY}。
 */
export function healthExitCode(health: { indexOk: boolean; configOk: boolean }): number {
  return health.indexOk && health.configOk ? EXIT_OK : EXIT_UNHEALTHY
}

/**
 * 渲染一条结构化日志（FR-F1）。
 *
 * @param entry - 日志条目。
 * @param timeZone - 时区，用于把时间戳转成本地可读时间。
 * @returns 一行日志文本。
 */
export function renderLog(entry: MemoryLogEntry, timeZone: string): string {
  return `[${entry.kind}] ${formatTime(entry.at, timeZone)} ${entry.summary}`
}
