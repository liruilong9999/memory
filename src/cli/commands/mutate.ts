import type { MemoryEngine } from '../../host/engine.ts'
import { jsonText, usageFailure } from '../output.ts'
import { EXIT_OK, EXIT_UNHEALTHY } from '../types.ts'
import type { CliOptions, CliResult } from '../types.ts'

/**
 * `restore` 子命令：把一张归档卡恢复成活跃（FR-C2）。
 *
 * ## 为什么 CLI 必须有它
 *
 * 归档是**自动**发生的（`forgetting.autoArchive` 默认 `true`，夜整理每天跑）。
 * 在补这条命令之前，数据面的 `restore` 分支实现完整、测试全绿，
 * 却**没有任何生产入口**——用户被误归档后，唯一的办法是手改 JSONL。
 * FR-C2 整条需求就是为了保证归档**可逆**。
 *
 * 退出码语义：恢复成功 0；卡不存在或本来就没归档 1（并说明原因）。
 * 不抛异常——id 可能是手抄错的，抛异常会让整条命令失败而不告诉人错在哪。
 *
 * @param options - 解析后的参数，`positionals[0]` 为卡片 id。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
export function runRestore(options: CliOptions, engine: MemoryEngine): CliResult {
  const id = options.positionals[0]
  if (id === undefined || id.length === 0) {
    return usageFailure('restore 需要一个卡片 id，例如：memoryctl restore card_1a2b3c')
  }
  const card = engine.inspect(id)
  if (card === undefined) {
    return { code: EXIT_UNHEALTHY, stdout: '', stderr: `没有这张卡：${id}\n` }
  }
  const written = engine.restore(id)
  if (!written) {
    // 区分「本来就没归档」与「写库失败」——两者都不是错误，
    // 但告诉用户「它已经是活跃的」比只说「没做」有用得多。
    return {
      code: EXIT_UNHEALTHY,
      stdout: options.json ? jsonText({ id, restored: false, status: card.status }) : '',
      stderr: `这张卡没有被归档（当前状态：${card.status}），无需恢复\n`,
    }
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText({ id, restored: true }), stderr: '' }
  return { code: EXIT_OK, stdout: `已恢复：${id}\n`, stderr: '' }
}

/**
 * `revise` 子命令：修正一张卡的正文并保留旧版本（FR-A5）。
 *
 * 用法：`memoryctl revise <id> <新正文> [--reason 原因]`。
 *
 * 与 `restore` 同一类缺口：`revisions` 数组此前**恒为空**，
 * 「查看历史」能查到的历史永远是空的。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
export function runRevise(options: CliOptions, engine: MemoryEngine): CliResult {
  const id = options.positionals[0]
  if (id === undefined || id.length === 0) {
    return usageFailure('revise 需要一个卡片 id，例如：memoryctl revise card_1a2b3c "新的正文"')
  }
  const text = options.positionals.slice(1).join(' ').trim()
  if (text.length === 0) {
    return usageFailure('revise 需要新的正文，例如：memoryctl revise card_1a2b3c "新的正文"')
  }
  const card = engine.inspect(id)
  if (card === undefined) {
    return { code: EXIT_UNHEALTHY, stdout: '', stderr: `没有这张卡：${id}\n` }
  }
  const written = engine.revise(id, text, options.reason)
  if (!written) {
    return {
      code: EXIT_UNHEALTHY,
      stdout: options.json ? jsonText({ id, revised: false }) : '',
      stderr: `正文没有变化，未写入修正记录\n`,
    }
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText({ id, revised: true, text }), stderr: '' }
  return { code: EXIT_OK, stdout: `已修正：${id}\n`, stderr: '' }
}

/**
 * `rebuild` 子命令（FR-F4 的运维动作）。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
export function runRebuild(options: CliOptions, engine: MemoryEngine): CliResult {
  const report = engine.rebuild()
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText(report), stderr: '' }
  }
  const text = `索引已重建：扫描 ${report.records} 条日志记录，活跃 ${report.active} 张`
  return { code: EXIT_OK, stdout: `${text}\n`, stderr: '' }
}

/**
 * `consolidate` 子命令（FR-C1 / 起源 L27 的「夜晚休眠整理」手动触发）。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
export function runConsolidate(options: CliOptions, engine: MemoryEngine): CliResult {
  const report = engine.consolidate()
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText(report), stderr: '' }
  }
  const lines = [
    `整理完成：合并 ${report.merged} 组，归档 ${report.archived} 张`,
    `活跃 ${report.beforeActive} → ${report.afterActive} 张`,
    `降权 ${report.decayed} 张，重建索引 ${report.reindexed} 张卡`,
  ]
  if (report.notes.length > 0) {
    lines.push('')
    lines.push('变更：')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}
