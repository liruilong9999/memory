import { fileURLToPath } from 'node:url'

import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../core/config.ts'
import type { DeepPartial, MemoryConfig } from '../core/config.ts'
import { loadPatchConfig } from '../host/patchConfig.ts'
import { readRollbackRecord } from '../store/configLedger.ts'
import type { CliIo, ResolvedCliConfig } from './types.ts'

/**
 * 解析 CLI 用的配置：**与宿主同源**——读同一个 `cordis.patch.yml`。
 *
 * 退回 `DEFAULT_CONFIG` 时必须在 `notes` 里说出来，绝不静默降级：
 * 静默降级正是本仓库反复吃亏的那一类问题（用户以为打开了突触效果，
 * 实际跑的是影子模式，而且没有任何东西告诉他）。
 *
 * @param io - 注入点（`configPath` 可覆盖 patch 路径）。
 * @param dataDirOverride - 命令行给出的数据目录；省略时用配置里的。
 *   必须传：回滚台账与存储目录必须是同一个，否则
 *   `--data-dir X config rollback` 会去改另一个库的覆盖层。
 * @returns 解析结果；`config` 一定可用。
 */
/**
 * 从一份配置里取出可用的数据目录。
 *
 * `mergeConfig` 不校验类型，所以 patch 写成 `dataDir: 42` 会原样传过来。
 * 直接拿它拼路径会得到 `resolve(42)` 而抛错，而那个错误
 * 会被报成「打不开记忆库」——真正的原因是配置写错了，不是库坏了。
 *
 * @param config - 待取目录的配置（通常是未校验的 `baseline`）。
 * @returns 数据目录；不是非空字符串时退回默认目录。
 */
function usableDataDir(config: MemoryConfig): string {
  const candidate: unknown = config.storage.dataDir
  if (typeof candidate === 'string' && candidate.length > 0) return candidate
  return DEFAULT_CONFIG.storage.dataDir
}

export function resolveCliConfig(io: CliIo, dataDirOverride: string | undefined): ResolvedCliConfig {
  const notes: string[] = []
  const path = io.configPath ?? fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
  const loaded = loadPatchConfig(path)
  if (!loaded.ok) {
    notes.push(`未能从 ${path} 读取配置（${loaded.reason}），本次使用库默认配置`)
    return {
      config: DEFAULT_CONFIG,
      baseline: DEFAULT_CONFIG,
      // 连 patch 都读不到时只能用默认目录——这里没有更好的选择，
      // 但已在 stderr 报了「配置提醒」，不是静默猜一个目录。
      dataDir: usableDataDir(DEFAULT_CONFIG),
      source: 'DEFAULT_CONFIG（未读到 patch）',
      degraded: true,
      notes,
    }
  }
  const merged = mergeConfig(DEFAULT_CONFIG, loaded.config as DeepPartial<MemoryConfig>)

  // FR-F4：回滚覆盖层必须与宿主同步叠加，否则又会出现「同一个库、
  // 终端与会话报两套配置」——那正是真缺陷九的形状，只是这次分歧点
  // 从「读不读 patch」变成了「叠不叠回滚层」。
  //
  // 叠加顺序与宿主一致：默认值 + patch → 叠加覆盖层 → 校验。
  // 宿主路径在 `src/host/adapter.ts` 的 `resolveConfig`，两处必须同序。
  const ledgerDir = dataDirOverride ?? merged.storage.dataDir
  const rollback = readRollbackRecord(ledgerDir)
  const effective = rollback === null ? merged : mergeConfig(merged, rollback.override)
  if (rollback !== null) {
    notes.push(
      `已叠加回滚覆盖层（目标快照 ${rollback.targetId}）：`
      + `patch 里与快照不同的参数被回滚值覆盖`,
    )
  }

  const validation = validateConfig(effective)
  if (!validation.ok) {
    notes.push(
      `patch 里的配置不合法，本次使用库默认配置：\n`
      + validation.errors.map((line) => `- ${line}`).join('\n')
      // 报错时必须把救自己的那条命令给出来。
      // 只报「配置非法」而不说怎么回滚，用户只能去手改
      // patch——而他很可能不知道自己刚改坏了哪一行。
      + '\n如果是刚刚改坏的，可以用 memoryctl config rollback <id> 一键回滚'
      + '（用 config list 查看可用快照）。',
    )
    // 注意这里返回的 `baseline` 是 `merged`（含坏掉的 `-5`），
    // 不是 `DEFAULT_CONFIG`。回滚靠它才能算出「要把 -5 改回 0.18」。
    return {
      config: DEFAULT_CONFIG,
      baseline: merged,
      // 从 `merged`（含 patch）取目录，不从 `DEFAULT_CONFIG`：
      // 配置坏了不代表用户的库没了，也不代表他想看默认那个空库。
      dataDir: usableDataDir(merged),
      source: 'DEFAULT_CONFIG（patch 非法）',
      degraded: true,
      notes,
    }
  }
  return {
    config: effective,
    baseline: merged,
    // 成功时也取 `merged` 而不取 `effective`：`storage` 在
    // `ROLLBACK_EXCLUDED_TOP_KEYS` 里，回滚层改不到它，两者本就相等。
    // 取同一个来源可以避免「成功与失败两条路用不同目录」。
    dataDir: usableDataDir(merged),
    source: rollback === null ? path : `${path} + 回滚层`,
    degraded: false,
    notes,
  }
}
