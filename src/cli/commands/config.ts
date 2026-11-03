import { resolve } from 'node:path'

import type { MemoryConfig } from '../../core/config.ts'
import {
  ROLLBACK_EXCLUDED_TOP_KEYS, describeConfigChange, describeConfigChanges, diffConfig, snapshotToConfig,
} from '../../core/configSnapshot.ts'
import { formatTime } from '../../core/scoring.ts'
import { applyRollbackToDisk, clearRollback } from '../../host/configRollback.ts'
import { readConfigSnapshots, readRollbackRecord } from '../../store/configLedger.ts'
import { storeFailure, usageFailure } from '../output.ts'
import { EXIT_OK, EXIT_UNHEALTHY } from '../types.ts'
import type { CliOptions, CliResult } from '../types.ts'

/* ------------------------------------------------------------------ *
 * 五之二、配置快照与回滚（FR-F4）
 * ------------------------------------------------------------------ */

/**
 * 打印配置快照台账（`config list`）。
 *
 * @param options - 命令行参数（用 `--limit` 限制条数）。
 * @param dataDir - 数据目录。
 * @param timeZone - 用于渲染时刻的时区。
 * @returns 命令行结果。
 */
export function runConfigList(options: CliOptions, dataDir: string, timeZone: string): CliResult {
  const snapshots = readConfigSnapshots(dataDir)
  if (snapshots.length === 0) {
    // 「没有快照」与「快照都一样」是两件事，不能都输出一个空表。
    // 前者的原因是「还没启动过」，后者的原因是「配置一直没变」。
    return {
      code: EXIT_OK,
      stdout: '还没有配置快照（启动一次宿主或执行任意子命令后会自动记下第一条）。\n',
      stderr: '',
    }
  }
  const limit = options.limit === 0 ? snapshots.length : Math.min(options.limit, snapshots.length)
  const shown = snapshots.slice(-limit)
  const rollback = readRollbackRecord(dataDir)
  if (options.json) {
    return {
      code: EXIT_OK,
      stdout: `${JSON.stringify({
        dataDir: resolve(dataDir),
        total: snapshots.length,
        rollbackActive: rollback !== null,
        snapshots: shown.map((item) => ({
          id: item.id,
          at: item.at,
          atText: formatTime(item.at, timeZone),
          configVersion: item.configVersion,
        })),
      }, null, 2)}\n`,
      stderr: '',
    }
  }
  const lines: string[] = [
    `配置快照台账（共 ${snapshots.length} 条，显示最近 ${shown.length} 条）：`,
    '',
  ]
  for (const item of shown) {
    lines.push(`  ${item.id}  ${formatTime(item.at, timeZone)}  版本 ${item.configVersion}`)
  }
  lines.push('')
  lines.push(rollback === null
    ? '当前没有生效中的回滚覆盖层。'
    : `当前存在回滚覆盖层（目标快照 ${rollback.targetId}，${formatTime(rollback.at, timeZone)}），想让 patch 重新生效请执行 config rollback --clear。`)
  lines.push('')
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * 打印「当前生效配置 vs 上一份快照」的差异（`config diff`）。
 *
 * 这就是 P7「改动可追溯」的可见形态：只报叶子级差异，
 * 而不是把两份配置全部打印出来让人自己找。
 *
 * @param options - 命令行参数。
 * @param current - 当前生效配置。
 * @param dataDir - 数据目录。
 * @returns 命令行结果。
 */
export function runConfigDiff(options: CliOptions, current: MemoryConfig, dataDir: string): CliResult {
  const snapshots = readConfigSnapshots(dataDir)
  const last = snapshots[snapshots.length - 1]
  if (last === undefined) {
    return {
      code: EXIT_OK,
      stdout: '还没有配置快照，无法对比。\n',
      stderr: '',
    }
  }
  const base = snapshotToConfig(last.canonical)
  if (base === null) {
    // 快照本身读不出来时必须明说，不能报「没有差异」——
    // 那会让人以为配置没改，而实际上是无法判断。
    return {
      code: EXIT_UNHEALTHY,
      stdout: '',
      stderr: `最新一条快照（${last.id}）无法还原成配置，无法对比。\n`,
    }
  }
  const changes = diffConfig(base, current)
  if (options.json) {
    return {
      code: EXIT_OK,
      stdout: `${JSON.stringify({ baseId: last.id, baseAt: last.at, changes }, null, 2)}\n`,
      stderr: '',
    }
  }
  if (changes.length === 0) {
    return { code: EXIT_OK, stdout: `与上一条快照（${last.id}）相比，配置没有变化。\n`, stderr: '' }
  }
  const lines = [
    `与上一条快照（${last.id}）相比，共 ${changes.length} 项变化：`,
    '',
    ...describeConfigChanges(changes, options.limit === 0 ? 0 : options.limit).map((line) => `  ${line}`),
    '',
  ]
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * 执行回滚（`config rollback <id>` 或 `config rollback --clear`）。
 *
 * ## 为什么这个函数不能走「先校验配置」那条路
 *
 * FR-F4 的验收是「改坏能一键回滚」。配置被改坏时，`validateConfig`
 * 会报错，而回滚正是为了修复那个错误——**先校验等于拒绝救自己**。
 * 所以回滚路径只需要：数据目录 + 快照台账 + 「当前生效配置」。
 * 而「当前生效配置」在配置已坏时用 `DEFAULT_CONFIG` 代替（见 `runCli` 的接线）。
 *
 * @param options - 命令行参数；位置参数 1 为目标快照 id。
 * @param current - 当前生效配置。
 * @param dataDir - 数据目录。
 * @param now - 当前时刻。
 * @param timeZone - 时区。
 * @returns 命令行结果。
 */
export function runConfigRollback(
  options: CliOptions, current: MemoryConfig, dataDir: string, now: number, timeZone: string,
): CliResult {
  if (options.clear) {
    const existed = clearRollback(dataDir)
    // 「清除了」与「本来就没有」必须分开报。报同一句话会让人以为
    // 自己刚刚撤销了一个生效中的回滚，而实际上可能根本没有回滚过。
    return {
      code: EXIT_OK,
      stdout: existed
        ? '已清除回滚覆盖层，patch 里的配置将从下次启动开始生效。\n'
        : '当前本来就没有回滚覆盖层，无需清除。\n',
      stderr: '',
    }
  }

  const target = options.positionals[1]
  if (target === undefined || target.length === 0) {
    return usageFailure('需要指定要回到哪一条快照（用 config list 查看），或用 --clear 清除回滚。')
  }
  const snapshots = readConfigSnapshots(dataDir)
  if (snapshots.length === 0) {
    return storeFailure('还没有配置快照，无法回滚。')
  }
  // 按 id 精确匹配，不按下标：下标会随台账截断变化，
  // 今天的 2 号明天可能是另一份配置。快照 id 是内容指纹，才能指向确切的一份。
  const snapshot = snapshots.find((item) => item.id === target)
  if (snapshot === undefined) {
    const known = [...new Set(snapshots.map((item) => item.id))].join('、')
    return usageFailure(`没有 id 为「${target}」的快照。已知：${known}`)
  }
  const config = snapshotToConfig(snapshot.canonical)
  if (config === null) {
    return storeFailure(`快照 ${snapshot.id} 无法还原成合法配置（可能由更旧版本写下），不能用于回滚。`)
  }

  const result = applyRollbackToDisk(dataDir, current, config, snapshot.id, now)
  if (result.outcome === 'noop') {
    return {
      code: EXIT_OK,
      stdout: `当前配置与快照 ${snapshot.id} 已经完全相同，无需回滚。\n`,
      stderr: '',
    }
  }
  if (result.outcome === 'excludedOnly') {
    // 只有被排除的段不同（`storage` / `configVersion`）。
    // 这时必须报失败而不是报成功：用户要求的回滚**一项也没做成**。
    return storeFailure(
      `快照 ${snapshot.id} 与当前配置的差异全部落在不可回滚的段上`
      + `（${ROLLBACK_EXCLUDED_TOP_KEYS.join('、')}），回滚无法执行。`,
    )
  }
  if (options.json) {
    return {
      code: EXIT_OK,
      stdout: `${JSON.stringify({
        rolledBackTo: snapshot.id, at: now, changed: result.changed, excluded: result.excluded,
      }, null, 2)}\n`,
      stderr: '',
    }
  }
  const lines = [
    `已回滚到快照 ${snapshot.id}（${formatTime(snapshot.at, timeZone)}），共固定 ${result.changed} 项参数。`,
    '',
  ]
  for (const change of diffConfig(current, config).slice(0, 20)) lines.push(`  ${describeConfigChange(change)}`)
  if (result.excluded > 0) {
    lines.push('')
    lines.push(`注意：还有 ${result.excluded} 项差异落在不可回滚的段上（${ROLLBACK_EXCLUDED_TOP_KEYS.join('、')}），本次未处理。`)
  }
  lines.push('')
  lines.push('下次启动宿主时生效。想让 patch 重新生效：memoryctl config rollback --clear')
  lines.push('')
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * `config` 子命令分派（FR-F4）。
 *
 * @param options - 命令行参数；位置参数 0 为动作名。
 * @param current - 当前生效配置。
 * @param dataDir - 数据目录。
 * @param now - 当前时刻。
 * @param timeZone - 时区。
 * @returns 命令行结果。
 */
export function runConfig(
  options: CliOptions, current: MemoryConfig, dataDir: string, now: number, timeZone: string,
): CliResult {
  const action = options.positionals[0]
  if (action === undefined || action === 'list') return runConfigList(options, dataDir, timeZone)
  if (action === 'diff') return runConfigDiff(options, current, dataDir)
  if (action === 'rollback') return runConfigRollback(options, current, dataDir, now, timeZone)
  return usageFailure(`未知的 config 动作「${action}」，可用：list / diff / rollback`)
}
