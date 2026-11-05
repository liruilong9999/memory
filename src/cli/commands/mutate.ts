import type { MemoryEngine } from '../../host/engine.ts'
import { jsonText, usageFailure } from '../output.ts'
import { resolveCardRef } from '../resolveCard.ts'
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
    return usageFailure('restore 需要一个卡片 id，例如：memoryctl restore 1a2b3c4d')
  }
  const resolved = resolveCardRef(engine, id)
  if (!resolved.ok) return resolved.result
  const card = resolved.card
  const written = engine.restore(card.id)
  if (!written) {
    // 区分「本来就没归档」与「写库失败」——两者都不是错误，
    // 但告诉用户「它已经是活跃的」比只说「没做」有用得多。
    return {
      code: EXIT_UNHEALTHY,
      stdout: options.json ? jsonText({ id: card.id, restored: false, status: card.status }) : '',
      stderr: `这张卡没有被归档（当前状态：${card.status}），无需恢复\n`,
    }
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText({ id: card.id, restored: true }), stderr: '' }
  return { code: EXIT_OK, stdout: `已恢复：${card.id}\n`, stderr: '' }
}

/**
 * `pin` / `unpin` 共用的形状：把「改没改」与「改成了什么」分成两个字段。
 *
 * ## 为什么不照抄 `restore` 的 `{ restored: false }`
 *
 * `restore` 的 JSON 里 `restored` 是**动作动词**（这次恢复发生了没有），
 * 但当卡本来就是 active 时它会输出 `restored: false`——读到 `{restored: false}`
 * 的人无法判断「卡现在是活跃的」还是「卡还在归档里、只是这次没动」。
 * `pinned` 若沿用同一种写法，还会多一层危险：pin 一张**已经钉住**的卡时
 * `pinned: false` 会被读成「这张卡现在没有钉住」，与事实相反。
 *
 * 所以这里拆成两个字段：`pinned` 一律表示**调用之后的状态**，`changed`
 * 表示**这次有没有真的写记录**。两个问题两个答案，不需要读者猜。
 */
interface PinnedOutcome {
  /** 调用之后这张卡的 `pinned` 值。 */
  pinned: boolean
  /** 这次是否真的写了一条记录（`false` 表示状态本来就是目标值）。 */
  changed: boolean
}

/**
 * `pin` 子命令：手动钉住一张卡，让它免于自动归档（FR-C3 人工豁免）。
 *
 * ## 为什么 CLI 必须有它
 *
 * `shouldArchive` 里 `if (card.pinned) return false` 排在最前，`pinned` 字段
 * 在契约与数据面都齐备——但补这条命令之前，`src/` 里没有任何一处能把
 * `pinned` 置成 `true`。也就是说人工豁免**在真实数据上恒不生效**，
 * 而审计表上它会显示「已实现且有测试」。与 `restore` 同一种形态的缺口。
 *
 * 退出码语义沿用 `restore` / `revise`：写成功 0；卡不存在、或本来就已钉住 1
 * （并说明原因）。不抛异常——id 可能是手抄错的。
 *
 * @param options - 解析后的参数，`positionals[0]` 为卡片 id。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
export function runPin(options: CliOptions, engine: MemoryEngine): CliResult {
  return runSetPinned(options, engine, true)
}

/**
 * `unpin` 子命令：取消钉住，让这张卡重新受自动归档管辖（FR-C3）。
 *
 * 钉住是**人工豁免**而不是永久豁免：豁免必须能撤销，否则用户一次误操作就把
 * 「忘得掉」（起源 L11「细节会忘」）永久关掉了，而他没有任何办法改回来。
 *
 * @param options - 解析后的参数，`positionals[0]` 为卡片 id。
 * @param engine - 记忆引擎。
 * @returns 命令结果。
 */
export function runUnpin(options: CliOptions, engine: MemoryEngine): CliResult {
  return runSetPinned(options, engine, false)
}

/**
 * {@link runPin} 与 {@link runUnpin} 的共同实现。
 *
 * 两个命令只差「目标状态」与几句文案，逻辑（取 id → 解析引用 → 写库 →
 * 分三种结果）一模一样。写成两份的话，将来修一处文案或改一次退出码就会
 * 只改到一边——本仓库为此踩过「人读渲染有两份实现」的坑。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎。
 * @param target - 目标 `pinned` 值。
 * @returns 命令结果。
 */
function runSetPinned(options: CliOptions, engine: MemoryEngine, target: boolean): CliResult {
  const word = target ? 'pin' : 'unpin'
  const id = options.positionals[0]
  if (id === undefined || id.length === 0) {
    return usageFailure(`${word} 需要一个卡片 id，例如：memoryctl ${word} 1a2b3c4d`)
  }
  const resolved = resolveCardRef(engine, id)
  if (!resolved.ok) return resolved.result
  const card = resolved.card
  const changed = target ? engine.pin(card.id) : engine.unpin(card.id)
  // 调用之后的状态：写成功了就是目标值，没写就是卡原来的值。
  const outcome: PinnedOutcome = { pinned: changed ? target : card.pinned, changed }
  if (!changed) {
    return {
      code: EXIT_UNHEALTHY,
      stdout: options.json ? jsonText({ id: card.id, ...outcome }) : '',
      stderr: target
        ? '这张卡已经钉住了，无需重复操作\n'
        : '这张卡本来就没有钉住，无需取消\n',
    }
  }
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText({ id: card.id, ...outcome }), stderr: '' }
  }
  return { code: EXIT_OK, stdout: `${target ? '已钉住' : '已取消钉住'}：${card.id}\n`, stderr: '' }
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
    return usageFailure('revise 需要一个卡片 id，例如：memoryctl revise 1a2b3c4d "新的正文"')
  }
  const text = options.positionals.slice(1).join(' ').trim()
  if (text.length === 0) {
    return usageFailure('revise 需要新的正文，例如：memoryctl revise 1a2b3c4d "新的正文"')
  }
  const resolved = resolveCardRef(engine, id)
  if (!resolved.ok) return resolved.result
  const card = resolved.card
  const written = engine.revise(card.id, text, options.reason)
  if (!written) {
    return {
      code: EXIT_UNHEALTHY,
      stdout: options.json ? jsonText({ id: card.id, revised: false }) : '',
      stderr: `正文没有变化，未写入修正记录\n`,
    }
  }
  if (options.json) {
    return { code: EXIT_OK, stdout: jsonText({ id: card.id, revised: true, text }), stderr: '' }
  }
  return { code: EXIT_OK, stdout: `已修正：${card.id}\n`, stderr: '' }
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
