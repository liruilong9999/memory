/**
 * 配置合并与旧字段迁移：{@link mergeConfig}、{@link DeepPartial}
 * 与私有的 `migrateSpreadMode`。
 *
 * 从 `core/config.ts` 拆出，**纯搬移**：迁移映射、合并顺序、数组复制语义
 * 与注释一字未改。
 *
 * @module dsh-memory/core/config/merge
 */

import type { MemoryConfig, SpreadMode, SpreadPolicy } from './types.ts'

/**
 * 把旧版 `spread.enabled`（布尔）迁移成 `spread.mode`（三态）。
 *
 * 为什么需要迁移而不是直接忽略：`enabled` 在配置版本 4 及以前是扩散的开关，
 * 版本 5 换成了三态 `mode`。若只是把新字段加进去，`{ spread: { enabled: true } }`
 * 这种旧配置会**静默降级**成默认的 `'shadow'`——用户明确要求「打开扩散」，
 * 系统却回答「好的，我不改排序」。不报错、不告警、行为与用户意图相反，
 * 而且事后无从发现。这正是本仓库反复吃亏的那一类缺陷。
 *
 * 映射关系（`enabled` 原本的语义就是这个）：
 * - `true`  → `'on'`：扩散真实参与排序，与旧版行为逐位一致。
 * - `false` → `'off'`：完全不计算，与旧版行为逐位一致。
 *
 * **显式写了 `mode` 时以 `mode` 为准**：新字段是新事实，旧字段只用来补空缺。
 * 两个都写是用户自己矛盾，不替他猜，`mode` 是更具体的那个。
 *
 * **写了 `mode` 但不合法时必须原样透传，不能退回 fallback。**
 * 这条是被实测逼出来的：YAML 1.1 里无引号的 `on` 是**布尔值**，用户在 patch
 * 里写 `mode: on`（极自然的写法）时，宿主拿到的是 `true`。若这里退回
 * fallback，结果是 `mode` 变成 `'shadow'`——**不报错、不崩溃、测试全绿**，
 * 用户以为打开了扩散，实际跑的是影子模式。静默降级比加载期崩溃更坏：
 * 崩溃会让人立刻改，降级会让人一直以为自己开了。
 *
 * 所以非法值一律透传成 `mode` 的值本身，交给 `validateConfig` 报错。
 * 类型上要 `as SpreadMode`——这是**故意的**：这一层的职责是把用户的输入
 * 原样送到校验层，而不是替校验层做决定。`validateConfig` 会因此给出
 * 「spread.mode 必须是 'off' / 'shadow' / 'on' 之一，实际为 true」。
 *
 * 迁移后**不把 `enabled` 带进结果**：留着一个已无读者的字段，下一个人会以为
 * 它还在起作用。配置对象的形状必须与代码实际读的字段一致。
 *
 * @param override - 用户提供的 spread 段（可能含旧字段）。
 * @param fallback - 合并前的 `mode`（默认值或 base 里的值）。
 * @returns 迁移后的 `mode`；用户写了非法值时原样返回该值，交给校验层拒绝。
 */
function migrateSpreadMode(override: unknown, fallback: SpreadMode): SpreadMode {
  if (typeof override !== 'object' || override === null) return fallback
  const partial = override as { mode?: unknown; enabled?: unknown }
  // 显式写了合法 mode 时，新字段优先。
  if (partial.mode === 'off' || partial.mode === 'shadow' || partial.mode === 'on') return partial.mode
  // 写了 mode 但不合法：原样透传给校验层，绝不静默退回 fallback。
  // 典型来源是 YAML 1.1 把裸 `on` 解析成布尔 `true`。
  if (partial.mode !== undefined) return partial.mode as SpreadMode
  // 没写 mode 时才退回旧布尔字段。
  if (partial.enabled === true) return 'on'
  if (partial.enabled === false) return 'off'
  return fallback
}

/**
 * 深合并用户配置与默认配置。
 *
 * 宿主的 patch 行是**整块替换 config**（不深合并），所以插件入口必须自己做
 * 这一层合并，否则用户只写一个字段就会把其余默认值清空。
 *
 * @param base - 默认配置。
 * @param override - 用户提供的部分配置。
 * @returns 合并后的新对象，不修改入参。
 */
export function mergeConfig(base: MemoryConfig, override: DeepPartial<MemoryConfig> = {}): MemoryConfig {
  // `spread` 段要单独处理：它可能含旧版布尔字段 `enabled`，见 `migrateSpreadMode`。
  const { spread: spreadOverride, ...restOverride } = override
  const spreadFields = { ...base.spread, ...spreadOverride } as Record<string, unknown>
  // 旧字段不许留在结果里——它已经没有任何读者，留着只会误导。
  delete spreadFields.enabled
  spreadFields.mode = migrateSpreadMode(spreadOverride, base.spread.mode)

  const merged: MemoryConfig = {
    configVersion: override.configVersion ?? base.configVersion,
    weights: { ...base.weights, ...restOverride.weights },
    recall: { ...base.recall, ...restOverride.recall },
    forgetting: { ...base.forgetting, ...restOverride.forgetting },
    dedup: { ...base.dedup, ...restOverride.dedup },
    extraction: { ...base.extraction, ...restOverride.extraction },
    storage: { ...base.storage, ...restOverride.storage },
    consolidation: { ...base.consolidation, ...restOverride.consolidation },
    reminder: { ...base.reminder, ...restOverride.reminder },
    graph: { ...base.graph, ...restOverride.graph },
    spread: spreadFields as unknown as SpreadPolicy,
    debugExplain: override.debugExplain ?? base.debugExplain,
  }
  // 数组字段必须整体替换，浅合并会让用户的自定义关键词被默认值覆盖。
  // 而且**无论覆盖与否都要复制**：直接沿用 base 的数组会让结果与 DEFAULT_CONFIG
  // 共享引用，调用方一句 `push` 就能污染全局默认值（跨测试、跨插件实例串味）。
  merged.forgetting.neverArchiveKinds = [...(override.forgetting?.neverArchiveKinds ?? base.forgetting.neverArchiveKinds)]
  merged.extraction.domains = [...(override.extraction?.domains ?? base.extraction.domains)]
  merged.extraction.signalKeywords = [...(override.extraction?.signalKeywords ?? base.extraction.signalKeywords)]
  merged.extraction.dueKeywords = [...(override.extraction?.dueKeywords ?? base.extraction.dueKeywords)]
  return merged
}

/** 任意深度的部分类型。 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}
