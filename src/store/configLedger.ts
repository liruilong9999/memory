/**
 * 配置快照台账与回滚覆盖层（FR-F4 的持久化部分）。
 *
 * 纯函数在 `src/core/configSnapshot.ts`（摊平、指纹、求差、最小覆盖）；
 * 本模块只负责**把它们落到磁盘**，以及把落盘的东西读回来。
 * 这样分层是仓库的硬约定：`core/` 不许有 IO。
 *
 * ## 两个文件，两种语义，不能合并
 *
 * | 文件 | 语义 | 谁写 | 丢了会怎样 |
 * |---|---|---|---|
 * | `config/snapshots.jsonl` | **历史**：每一份生效过的配置 | 每次启动 | 少一段可追溯的历史，行为不变 |
 * | `config/rollback.json` | **意图**：用户要求回到哪一份 | `memoryctl config rollback` | 回滚失效，行为回到 patch |
 *
 * 合并成一个文件的诱惑很大（都是「配置相关」），但那会让一件事变得不可能：
 * **回滚覆盖层必须能被单独清除**。用户执行 `config rollback --clear` 时
 * 要清的是「意图」，不是「历史」——历史清掉了就再也追不回来。
 *
 * ## 为什么历史用 JSONL 追加，而意图用原子覆写
 *
 * 与 `logs/diagnostics.jsonl` 同一套理由：
 *
 * - **历史是只追加的**：每条快照一旦写下就不再修改。追加写天然不怕
 *   「写一半」——最坏情况是最后一行不完整，读的时候跳过即可。
 * - **意图是反复覆写的单值**：同一时刻只可能有一个回滚目标。覆写必须原子
 *   （先写 `.tmp` 再 `rename`），否则一次断电会留下半截 JSON，
 *   而「读不出来」在这里的后果是**静默失去回滚**——用户以为回滚生效了。
 *
 * ## 为什么历史不进事件日志
 *
 * `src/store/meta.ts` 的模块注释给了两条判据，这里同样适用，而且判据二
 * （语义纯净性）在这里更硬：事件日志是**用户行为历史**，重放等于「重放
 * 用户做过什么」。配置快照是**系统自身的启动痕迹**，掺进去会挤占 `seq`，
 * 让任何「按 seq 分析用户行为」的逻辑把启动次数当成用户操作统计。
 *
 * ## 去重判据用完整文本，不用指纹
 *
 * 见 `src/core/configSnapshot.ts` 的模块注释。指纹碰撞会让「变了」被判成
 * 「没变」而**少记一条快照**，而少记一条是静默的。
 *
 * @module dsh-memory/store/configLedger
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CONFIG_SNAPSHOT_VERSION, canonicalConfig, coerceConfigSnapshot, configFingerprint,
} from '../core/configSnapshot.ts'
import type { ConfigSnapshot } from '../core/configSnapshot.ts'
import type { DeepPartial, MemoryConfig } from '../core/config.ts'

/**
 * 台账子目录名。
 *
 * 与日志一样**放在子目录**而不是数据目录顶层：顶层是事件日志分片
 * （`journal-<数字>.jsonl`）的地盘，任何「按 `.jsonl` 扫顶层」的外部工具
 * （备份脚本、日志采集器、用户自己 `ls *.jsonl`）都会把旁路文件当成事件日志。
 * 这条教训来自诊断日志改名（见 `docs/7-缺陷复盘.md` 真缺陷十一）。
 */
export const CONFIG_LEDGER_DIR = 'config'

/** 历史快照文件名。 */
export const SNAPSHOT_FILE_NAME = 'snapshots.jsonl'

/** 回滚覆盖层文件名。 */
export const ROLLBACK_FILE_NAME = 'rollback.json'

/**
 * 台账目录路径。
 *
 * @param dataDir - 数据目录。
 * @returns `config/` 子目录的完整路径。
 */
export function configLedgerDir(dataDir: string): string {
  return join(dataDir, CONFIG_LEDGER_DIR)
}

/**
 * 历史快照文件路径。
 *
 * @param dataDir - 数据目录。
 * @returns `config/snapshots.jsonl` 的完整路径。
 */
export function snapshotFilePath(dataDir: string): string {
  return join(configLedgerDir(dataDir), SNAPSHOT_FILE_NAME)
}

/**
 * 回滚覆盖层文件路径。
 *
 * @param dataDir - 数据目录。
 * @returns `config/rollback.json` 的完整路径。
 */
export function rollbackFilePath(dataDir: string): string {
  return join(configLedgerDir(dataDir), ROLLBACK_FILE_NAME)
}

/**
 * 读回历史快照。
 *
 * **不抛错**：文件不存在（首次运行）、单行损坏、结构不认识，一律跳过。
 * 理由与诊断日志一致——观测/历史坏掉不该让记忆库打不开。
 * 但**坏行不会被改写成看起来合法的快照**：`coerceConfigSnapshot` 返回
 * `null` 就跳过，绝不兜底成一份空配置（那会让「回滚」把库配置清空）。
 *
 * @param dataDir - 数据目录。
 * @returns 按写入顺序排列的快照列表；读不到时为空数组。
 */
export function readConfigSnapshots(dataDir: string): ConfigSnapshot[] {
  const path = snapshotFilePath(dataDir)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: ConfigSnapshot[] = []
  for (const line of raw.split(String.fromCharCode(10))) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      // 单行损坏（进程被杀在写一半）不是错误，跳过这一行即可。
      continue
    }
    const snapshot = coerceConfigSnapshot(parsed)
    if (snapshot !== null) out.push(snapshot)
  }
  return out
}

/**
 * 记录一份配置快照（只在**确实变化**时追加）。
 *
 * ## 去重判据：与**最后一条**比完整文本
 *
 * 只与最后一条比，而不是与全表比：配置的语义是「当前生效的那一份」，
 * 回到一份更早出现过的配置（A → B → A）是**真实变化**，必须记下来，
 * 否则历史里看不出「回滚过」。
 *
 * ## 环形截断保留**最后** N 条
 *
 * 保留最早 N 条会让台账停在很久以前，最近的改动反而查不到——那与
 * 「改动可追溯」正好相反。`maxEntries <= 0` 表示不限制。
 *
 * @param dataDir - 数据目录。
 * @param config - 本次生效的配置。
 * @param at - 记录时刻（毫秒）。
 * @param maxEntries - 最多保留多少条；`<= 0` 表示不限制。
 * @returns 写入结果；`recorded: false` 表示与上一条相同、没有追加。
 */
export function recordConfigSnapshot(
  dataDir: string,
  config: MemoryConfig,
  at: number,
  maxEntries: number,
): { readonly recorded: boolean; readonly snapshot: ConfigSnapshot } {
  const canonical = canonicalConfig(config)
  const snapshot: ConfigSnapshot = {
    v: CONFIG_SNAPSHOT_VERSION,
    id: configFingerprint(config),
    at,
    configVersion: config.configVersion,
    canonical,
  }
  const existing = readConfigSnapshots(dataDir)
  const last = existing[existing.length - 1]
  if (last !== undefined && last.canonical === canonical) return { recorded: false, snapshot }

  mkdirSync(configLedgerDir(dataDir), { recursive: true })
  appendFileSync(snapshotFilePath(dataDir), `${JSON.stringify(snapshot)}${String.fromCharCode(10)}`, 'utf8')

  if (maxEntries > 0 && existing.length + 1 > maxEntries) {
    const kept = [...existing, snapshot].slice(-maxEntries)
    const text = kept.map((item) => JSON.stringify(item)).join(String.fromCharCode(10))
    // 覆写而不是「删前面几行」：JSONL 无法原地删行，重写整表最简单也最可靠。
    writeFileSync(snapshotFilePath(dataDir), `${text}${String.fromCharCode(10)}`, 'utf8')
  }
  return { recorded: true, snapshot }
}

/** 回滚覆盖层的完整记录（覆盖层 + 元信息）。 */
export interface RollbackRecord {
  /** 要回到的那份快照 id。 */
  readonly targetId: string
  /** 写入时刻（毫秒）。 */
  readonly at: number
  /** 最小覆盖层。 */
  readonly override: DeepPartial<MemoryConfig>
}

/**
 * 读回回滚覆盖层的完整记录。
 *
 * 返回目标快照 id 与时刻，供人读输出与事后追溯用；解析逻辑集中在
 * {@link parseRollbackRecord} 一处，不写两遍——**少一份实现就少一处漂移点**。
 *
 * @param dataDir - 数据目录。
 * @returns 记录；没有回滚、或文件损坏时返回 `null`。
 */
export function readRollbackRecord(dataDir: string): RollbackRecord | null {
  let text: string
  try {
    text = readFileSync(rollbackFilePath(dataDir), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return null
  }
  return parseRollbackRecord(parsed)
}

/**
 * 把读出的 JSON 解析成 {@link RollbackRecord}。
 *
 * `targetId` / `at` 缺失时用占位值而**不判整份无效**：
 * 它们只是人读标签，丢了不影响回滚本身能不能生效。
 * 但 `override` 缺失或不是对象时必须判无效——那时回滚确实什么也做不了。
 *
 * @param parsed - 从文件读出的 JSON 值。
 * @returns 解析结果；结构不认识时返回 `null`。
 */
function parseRollbackRecord(parsed: unknown): RollbackRecord | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as { override?: unknown; targetId?: unknown; at?: unknown }
  const override = record.override
  if (typeof override !== 'object' || override === null || Array.isArray(override)) return null
  const targetId = typeof record.targetId === 'string' && record.targetId.length > 0
    ? record.targetId
    : '（未知）'
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0
  return { targetId, at, override: override as DeepPartial<MemoryConfig> }
}

/**
 * 写入回滚覆盖层（原子写）。
 *
 * @param dataDir - 数据目录。
 * @param override - 覆盖层（`buildRollbackPlan` 的产物）。
 * @param targetId - 回到的那份快照 id，供人读输出与事后追溯。
 * @param at - 写入时刻（毫秒）。
 */
export function writeRollbackOverride(
  dataDir: string,
  override: DeepPartial<MemoryConfig>,
  targetId: string,
  at: number,
): void {
  mkdirSync(configLedgerDir(dataDir), { recursive: true })
  const path = rollbackFilePath(dataDir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ v: 1, at, targetId, override })}${String.fromCharCode(10)}`, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    // 清理失败绝不能掩盖原始错误，理由同 `src/store/meta.ts` 的 `writeMeta`。
    try {
      unlinkSync(tmp)
    } catch {
      // 尽力而为。
    }
    throw error
  }
}

/**
 * 清除回滚覆盖层。
 *
 * @param dataDir - 数据目录。
 * @returns 之前是否存在；`false` 表示本来就没有回滚，调用方应如实报出。
 */
export function clearRollbackOverride(dataDir: string): boolean {
  const path = rollbackFilePath(dataDir)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}
