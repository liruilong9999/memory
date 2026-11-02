/**
 * 回滚覆盖层的**生效点**（FR-F4）。
 *
 * 纯函数在 `src/core/configSnapshot.ts`，落盘在 `src/store/configLedger.ts`，
 * 本模块负责把两者接到配置装配链路上——以及决定**在哪一步**插入覆盖层。
 *
 * ## 覆盖层必须插在「合并之后、校验之前」
 *
 * 这是本功能唯一一个真正容易做错的地方，值得写清楚。
 *
 * 直觉做法是在 `resolveConfig` 之后（即已经校验通过的配置上）再合并覆盖层。
 * 那样做的话，**patch 一旦被改坏，宿主在校验处就抛错退出了，覆盖层根本没机会生效**——
 * 而「patch 被改坏」恰恰是 FR-F4 要救的那个场景。结果是：
 * 用户按文档执行了回滚命令，命令报告成功，宿主下次启动**仍然崩溃**。
 * 那比没有回滚更糟，因为它消耗了用户唯一一次信任。
 *
 * 所以顺序必须是：
 *
 * ```text
 * 默认值 + patch（不校验）
 *        ↓
 *   叠加回滚覆盖层        ← 覆盖层能修好被改坏的那几个叶子
 *        ↓
 *      校验
 * ```
 *
 * 只有这样才能做到「改坏了也能一键回滚」。
 *
 * ## 为什么 `dataDir` 不会造成自指
 *
 * 读覆盖层需要 `dataDir`，而 `dataDir` 来自配置——看起来是个循环。
 * 破解它的是 `ROLLBACK_EXCLUDED_TOP_KEYS`：`storage` 段**不允许**被回滚覆盖，
 * 所以 `dataDir` 永远只由「默认值 + patch」决定，与覆盖层无关。
 * 两边的 `dataDir` 必然一致，不存在「写进 A 库、从 B 库读」的分裂。
 *
 * 这条约束不是可选的洁癖：一旦允许覆盖层改 `dataDir`，回滚会把自己指到
 * 另一个库上，下次启动去那边读不到覆盖层 ⇒ 回滚**静默失效**。
 *
 * @module dsh-memory/host/configRollback
 */

import { DEFAULT_CONFIG, mergeConfig } from '../core/config.ts'
import type { DeepPartial, MemoryConfig } from '../core/config.ts'
import { clearRollbackOverride, readRollbackRecord, writeRollbackOverride } from '../store/configLedger.ts'
import { buildRollbackPlan } from '../core/configSnapshot.ts'

/** 回滚覆盖层的当前状态。 */
export interface RollbackState {
  /** 要回到的那份快照 id。 */
  readonly targetId: string
  /** 覆盖层本身（最小覆盖，见 `buildRollbackPlan`）。 */
  readonly override: DeepPartial<MemoryConfig>
}

/**
 * 从原始配置里算出数据目录（**不校验**）。
 *
 * 专门用于「配置已经坏了、但仍要找到覆盖层文件」这一步。
 * 不能复用 `resolveConfig`：它校验失败会抛错，而这里恰恰要在配置非法的
 * 情况下还能算出路径。
 *
 * @param raw - 宿主传入的原始配置。
 * @returns 数据目录；`storage.dataDir` 不是非空字符串时退回默认值。
 */
export function resolveDataDirLoose(raw: unknown): string {
  const partial = (typeof raw === 'object' && raw !== null ? raw : {}) as DeepPartial<MemoryConfig>
  const storage = partial.storage as { dataDir?: unknown } | undefined
  const candidate = storage?.dataDir
  // `mergeConfig` 不校验类型，所以 `dataDir: 42` 会原样过来。
  // 这里退回默认值而不是抛错：算不出路径时唯一可做的事就是用默认路径，
  // 而默认路径在绝大多数安装里就是真实路径。
  if (typeof candidate === 'string' && candidate.length > 0) {
    return mergeConfig(DEFAULT_CONFIG, partial).storage.dataDir
  }
  return DEFAULT_CONFIG.storage.dataDir
}

/**
 * 读取回滚覆盖层。
 *
 * @param dataDir - 数据目录（见 {@link resolveDataDirLoose}）。
 * @returns 覆盖层状态；没有回滚或文件损坏时返回 `null`。
 */
export function readRollbackState(dataDir: string): RollbackState | null {
  const record = readRollbackRecord(dataDir)
  if (record === null) return null
  return { targetId: record.targetId, override: record.override }
}

/**
 * 写入回滚覆盖层：把当前配置拉回目标配置。
 *
 * ## 拒绝执行的情况必须报出来，不能返回一个「成功」
 *
 * 三种情况会走到这里：
 *
 * 1. **两份配置完全相同** ⇒ 没有需要回滚的东西。返回 `noop` 而不是写一个空覆盖层：
 *    写空覆盖层会让 `rollback.json` 存在但不起作用，用户下次 `config list`
 *    看到「已回滚」而实际什么都没变。
 * 2. **只有被排除的段不同**（`storage` / `configVersion`）⇒ 回滚什么也做不了。
 *    这种情况返回 `excludedOnly`，由调用方明确告知「这几项改不了」。
 * 3. 正常情况 ⇒ 写最小覆盖。
 *
 * @param dataDir - 数据目录。
 * @param current - 当前生效的配置。
 * @param target - 要回到的配置。
 * @param targetId - 目标快照 id。
 * @param at - 写入时刻（毫秒）。
 * @returns 执行结果，供 CLI 生成人读输出。
 */
export function applyRollbackToDisk(
  dataDir: string,
  current: MemoryConfig,
  target: MemoryConfig,
  targetId: string,
  at: number,
): {
  readonly outcome: 'written' | 'noop' | 'excludedOnly'
  readonly changed: number
  readonly excluded: number
} {
  const plan = buildRollbackPlan(current, target)
  if (plan.changes.length === 0 && plan.excluded.length === 0) {
    return { outcome: 'noop', changed: 0, excluded: 0 }
  }
  if (plan.changes.length === 0) {
    return { outcome: 'excludedOnly', changed: 0, excluded: plan.excluded.length }
  }
  writeRollbackOverride(dataDir, plan.override, targetId, at)
  return { outcome: 'written', changed: plan.changes.length, excluded: plan.excluded.length }
}

/**
 * 清除回滚覆盖层。
 *
 * @param dataDir - 数据目录。
 * @returns 之前是否存在覆盖层。
 */
export function clearRollback(dataDir: string): boolean {
  return clearRollbackOverride(dataDir)
}
