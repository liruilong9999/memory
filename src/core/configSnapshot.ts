/**
 * 配置快照与回滚（FR-F4）。
 *
 * 需求原文（`docs/1-需求规格.md:178`）：
 * 「参数版本化与回滚：阈值/权重带版本」，验收「改坏能一键回滚」。
 * 设计原则 P7（`docs/1-需求规格.md:71`）：「参数可版本化、可回滚」，
 * 判据是「阈值/权重/策略带版本，改动可追溯」。
 *
 * ## 为什么需要这一层：`configVersion` 单独存在是够不着的
 *
 * 仓库里原本只有 `MemoryConfig.configVersion` 一个数字。它确实「带版本」，
 * 但它只能回答「这是第几版」，回答不了 P7 的两个真问题：
 *
 * 1. **改动可追溯**：改了哪些叶子？从多少改到多少？——数字里没有这些。
 * 2. **改坏能一键回滚**：回到哪一份？——只有一个数字，没有「那一份」。
 *
 * 更糟的是 `src/cli/memoryctl.ts` 的头注释曾把 `rebuild` 写成
 * 「那条回滚路径」。`rebuild` 重放的是**记忆数据**，一个字都不碰配置——
 * 用户按文档去「回滚」，配置原封不动，而他不会收到任何提示。
 * **能力存在但用户拿不到，比完全没实现更危险**：他会以为已经回滚了。
 *
 * 所以本模块补的正是那两件事：**把每一份生效过的配置存下来**（快照），
 * 并且能算出**两份配置之间的叶子级差异**（可追溯 + 可回滚的载体）。
 *
 * ## 本模块只有纯函数（ST-1）
 *
 * 序列化、指纹、摊平、求差全部无副作用、可重复调用得到相同结果，
 * 因此可以放在 `core/`。读写文件的部分在 `src/store/configLedger.ts`
 * ——`core/` 不许有 IO。
 *
 * ## 指纹为什么不是唯一判据
 *
 * {@link configFingerprint} 是 32 位 FNV-1a，碰撞概率对「几十条快照」这个
 * 规模可以忽略，但**不能忽略**：指纹相同会被判成「没变」而**少记一条快照**，
 * 而少记一条是静默的。所以判「有没有变」一律比 {@link canonicalConfig}
 * 的**完整字符串**（逐字节相等），指纹只用作人读短标签与文件名。
 * 这条与「靠巧合安全不是靠规则安全」同源。
 *
 * @module dsh-memory/core/configSnapshot
 */

import { DEFAULT_CONFIG, mergeConfig, validateConfig } from './config.ts'
import type { DeepPartial, MemoryConfig } from './config.ts'

/**
 * 快照记录格式版本。
 *
 * 与 `configVersion` 是两件事：`configVersion` 是**配置内容**的版本，
 * 这个是**台账文件结构**的版本。后者变了要能读回旧台账并迁移。
 */
export const CONFIG_SNAPSHOT_VERSION = 1

/**
 * 回滚覆盖层**不允许**改的顶层段。
 *
 * `storage` 段里有 `dataDir`——而回滚覆盖层本身就存在 `dataDir` 里。
 * 允许它改 `dataDir` 等于让回滚把自己指到另一个库：写的时候在 A 库，
 * 下次启动去 B 库读，于是「回滚了但没生效」，且**不报错**。
 *
 * 这条不是洁癖，是打断一个自指环。发现这类需求时的正解是拒绝并说明，
 * 而不是「允许它改，反正很少人这么干」。
 */
export const ROLLBACK_EXCLUDED_TOP_KEYS: readonly string[] = ['storage', 'configVersion']

/** 配置的一个叶子（摊平后的一行）。 */
export interface ConfigLeaf {
  /** 点分路径，例如 `recall.absoluteThreshold`。 */
  readonly path: string
  /**
   * 叶子值的确定性序列化。
   *
   * 用 `JSON.stringify` 而不是原值：数组/字符串/数字/布尔混在一张表里时，
   * 只有序列化形式能保证「相等」的判据一致（`[]` 与 `''` 都是「空」，
   * 但它们不是同一个配置）。
   */
  readonly value: string
}

/** 一个叶子的变化。 */
export interface ConfigLeafChange {
  /** 点分路径。 */
  readonly path: string
  /** 变化前的序列化值；新增时为 `undefined`。 */
  readonly before: string | undefined
  /** 变化后的序列化值；删除时为 `undefined`。 */
  readonly after: string | undefined
}

/** 台账里的一条配置快照。 */
export interface ConfigSnapshot {
  /** 台账格式版本，见 {@link CONFIG_SNAPSHOT_VERSION}。 */
  readonly v: number
  /** 配置指纹（短标签），见 {@link configFingerprint}。 */
  readonly id: string
  /** 记录时刻（毫秒）。 */
  readonly at: number
  /** 当时的 `MemoryConfig.configVersion`。 */
  readonly configVersion: number
  /** 当时的完整配置（确定性序列化），回滚的数据来源。 */
  readonly canonical: string
}

/**
 * 判断一个值是不是「朴素对象」（不是数组、不是 null、不是类实例）。
 *
 * @param value - 待判断的值。
 * @returns 是朴素对象时为 `true`。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把一个值摊平成叶子列表（递归，键名排序）。
 *
 * 数组**整体**当一个叶子：配置里的数组（`neverArchiveKinds`、`domains`、
 * `signalKeywords`）在 `mergeConfig` 里就是整体替换的语义，拆成下标
 * 会得到「`[0]` 从 a 改成 b」这种没人看得懂、也没法回滚的差异。
 *
 * @param value - 任意配置值。
 * @param prefix - 当前路径前缀。
 * @param out - 收集结果的数组（就地追加）。
 */
function flattenInto(value: unknown, prefix: string, out: ConfigLeaf[]): void {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value).sort()) {
      flattenInto(value[key], prefix.length === 0 ? key : `${prefix}.${key}`, out)
    }
    return
  }
  out.push({ path: prefix, value: JSON.stringify(value) })
}

/**
 * 把配置摊平成「路径 + 序列化值」的排序列表。
 *
 * @param config - 配置对象。
 * @returns 按路径升序的叶子列表。
 */
export function flattenConfig(config: MemoryConfig): ConfigLeaf[] {
  const out: ConfigLeaf[] = []
  flattenInto(config, '', out)
  return out
}

/**
 * 配置的确定性序列化（逐字节可比较）。
 *
 * 这是判「配置有没有变」的**唯一**判据：指纹会碰撞，字符串不会。
 *
 * @param config - 配置对象。
 * @returns 形如 `recall.maxCards=5\n...` 的多行文本。
 */
export function canonicalConfig(config: MemoryConfig): string {
  return flattenConfig(config).map((leaf) => `${leaf.path}=${leaf.value}`).join('\n')
}

/**
 * 计算配置指纹（32 位 FNV-1a，8 位十六进制）。
 *
 * 只用作人读短标签与文件名，**不**用作「有没有变」的判据——
 * 理由见模块注释「指纹为什么不是唯一判据」。
 *
 * @param config - 配置对象。
 * @returns 8 位小写十六进制指纹。
 */
export function configFingerprint(config: MemoryConfig): string {
  const text = canonicalConfig(config)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    // `Math.imul` 保证 32 位乘法不丢精度；末尾 `>>> 0` 转回无符号。
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 求两份配置的叶子级差异。
 *
 * 按路径对齐而不是按位置：配置段增删后位置全错，按位置比会报出一堆假差异。
 *
 * @param before - 变化前的配置。
 * @param after - 变化后的配置。
 * @returns 变化列表，按路径升序；没有变化时为空数组。
 */
export function diffConfig(before: MemoryConfig, after: MemoryConfig): ConfigLeafChange[] {
  const left = new Map(flattenConfig(before).map((leaf) => [leaf.path, leaf.value]))
  const right = new Map(flattenConfig(after).map((leaf) => [leaf.path, leaf.value]))
  const paths = new Set([...left.keys(), ...right.keys()])
  const changes: ConfigLeafChange[] = []
  for (const path of [...paths].sort()) {
    const a = left.get(path)
    const b = right.get(path)
    if (a === b) continue
    changes.push({ path, before: a, after: b })
  }
  return changes
}

/** 「这个子树没变」的哨兵值。用独立 symbol 而不是 `undefined`：`undefined` 是合法的配置值来源。 */
const UNCHANGED: unique symbol = Symbol('unchanged')

/**
 * 递归求「从 before 变到 after 所需的最小覆盖」。
 *
 * @param before - 变化前。
 * @param after - 变化后。
 * @returns 最小覆盖；完全相同时返回 {@link UNCHANGED}。
 */
function changedPartial(before: unknown, after: unknown): unknown {
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      const next = changedPartial(before[key], after[key])
      if (next !== UNCHANGED) out[key] = next
    }
    return Object.keys(out).length === 0 ? UNCHANGED : out
  }
  // 数组与标量都比序列化：数组整体替换，见 `flattenInto` 的理由。
  if (JSON.stringify(before) === JSON.stringify(after)) return UNCHANGED
  return after
}

/**
 * 回滚覆盖层：把「当前配置」拉回「目标配置」所需的最小覆盖。
 *
 * ## 为什么是最小覆盖，而不是整份配置
 *
 * 整份写回会把**用户没碰过的字段**一起冻住：将来他想调别的参数，
 * 改了 patch 却发现没生效——因为回滚层用一份旧值把它盖住了。
 * 那种失败是静默的（配置看起来改了、行为没变），本仓库吃过太多次。
 *
 * 最小覆盖只冻结「这次要回滚的那几个叶子」，其余照常跟随 patch。
 *
 * ## 为什么排除 `storage`
 *
 * 见 {@link ROLLBACK_EXCLUDED_TOP_KEYS}：允许回滚改 `dataDir` 会造出自指环。
 * 被排除的叶子**必须**报出来（{@link RollbackPlan.excluded}），
 * 否则用户会以为整份都回滚了。
 *
 * @param current - 当前生效的配置。
 * @param target - 要回到的配置。
 * @returns 覆盖层与本次无法回滚的叶子。
 */
export function buildRollbackPlan(
  current: MemoryConfig,
  target: MemoryConfig,
): { readonly override: DeepPartial<MemoryConfig>; readonly changes: ConfigLeafChange[]; readonly excluded: ConfigLeafChange[] } {
  const all = diffConfig(current, target)
  const excluded = all.filter((change) => ROLLBACK_EXCLUDED_TOP_KEYS.includes(change.path.split('.')[0] ?? ''))
  const rollbackable = all.filter((change) => !excluded.includes(change))
  const partial = changedPartial(current, target)
  if (partial === UNCHANGED || !isPlainObject(partial)) {
    return { override: {}, changes: rollbackable, excluded }
  }
  const override: Record<string, unknown> = { ...partial }
  for (const key of ROLLBACK_EXCLUDED_TOP_KEYS) delete override[key]
  return { override: override as DeepPartial<MemoryConfig>, changes: rollbackable, excluded }
}

/**
 * 把一条叶子变化渲染成人读的一行。
 *
 * @param change - 叶子变化。
 * @returns 例如 `recall.absoluteThreshold：0.18 → 0.3`。
 */
export function describeConfigChange(change: ConfigLeafChange): string {
  const before = change.before === undefined ? '（无）' : change.before
  const after = change.after === undefined ? '（无）' : change.after
  return `${change.path}：${before} → ${after}`
}

/**
 * 把一串叶子变化渲染成人读的多行文本。
 *
 * @param changes - 叶子变化列表。
 * @param limit - 最多渲染几条，其余折叠成「还有 N 项」；`0` 表示不限制。
 * @returns 每行一条的文本数组。
 */
export function describeConfigChanges(changes: readonly ConfigLeafChange[], limit = 20): string[] {
  const shown = limit > 0 ? changes.slice(0, limit) : changes
  const lines = shown.map(describeConfigChange)
  if (limit > 0 && changes.length > shown.length) {
    lines.push(`……还有 ${changes.length - shown.length} 项`)
  }
  return lines
}

/**
 * 把一条台账记录投影成 {@link ConfigSnapshot}。
 *
 * 与 `coerceCard` 同一套原则（`docs/3-架构设计.md` §4.2）：**已知保留、
 * 缺失才兜底**，绝不把读不懂的值改写成另一个看起来合法的值——
 * 那会让「日志写 A、重放得 B」，破坏 ST-1 且事后无从发现。
 *
 * 但这里有一条比卡片更硬的边界：`canonical` 不是合法配置字符串时，
 * 这条快照**无法用于回滚**，必须判为无效而不是兜底成空配置。
 * 兜底成空配置的后果是「回滚了，结果把库配置清空了」。
 *
 * @param raw - 从台账读出的原始值。
 * @returns 有效快照；结构不认识时返回 `null`。
 */
export function coerceConfigSnapshot(raw: unknown): ConfigSnapshot | null {
  if (!isPlainObject(raw)) return null
  const id = raw['id']
  const at = raw['at']
  const configVersion = raw['configVersion']
  const canonical = raw['canonical']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (typeof configVersion !== 'number' || !Number.isFinite(configVersion)) return null
  if (typeof canonical !== 'string' || canonical.length === 0) return null
  const v = raw['v']
  return {
    v: typeof v === 'number' && Number.isFinite(v) ? v : CONFIG_SNAPSHOT_VERSION,
    id,
    at,
    configVersion,
    canonical,
  }
}

/**
 * 把一条快照还原成可用配置。
 *
 * ## 为什么要过 `mergeConfig` + `validateConfig`，而不是直接信任快照
 *
 * 快照是**历史**：它可能由旧版本的插件写下，字段集合与今天不同
 * （新增字段缺失、废弃字段还在）。直接拿它当配置用，会让回滚把库带进一个
 * 当前代码不认识的状态——那比不回滚更糟。
 *
 * 所以还原路径与「读 patch」完全相同：`parseCanonicalConfig` 得到部分配置 →
 * `mergeConfig(DEFAULT_CONFIG, ...)` 补全今天的新字段 → `validateConfig`
 * 拒绝非法值。**少一份实现就少一处漂移点**：回滚出来的配置与启动时读到的
 * 配置走同一条装配链路，不会出现「启动能用、回滚不能用」这种分叉。
 *
 * @param canonical - 快照里的确定性序列化文本。
 * @returns 还原后的配置；文本损坏或校验不通过时返回 `null`（**绝不兜底成默认配置**，
 *   那会让「回滚」变成「静默重置」）。
 */
export function snapshotToConfig(canonical: string): MemoryConfig | null {
  const partial = parseCanonicalConfig(canonical)
  if (partial === null) return null
  const merged = mergeConfig(DEFAULT_CONFIG, partial as DeepPartial<MemoryConfig>)
  const validation = validateConfig(merged)
  if (!validation.ok) return null
  return merged
}

/**
 * 从确定性序列化文本还原配置对象。
 *
 * 只用于台账里的 `canonical` 反序列化：它是 `path=JSON值` 的行集合，
 * 逐行还原成嵌套对象。
 *
 * ## 为什么不用 `JSON.parse` 存整份配置
 *
 * 可以，但那样「差异」就只能靠再摊平一次去算，而摊平逻辑会成为第二份
 * 真相源（台账里的形状 vs 内存里的形状）。用同一套摊平文本，存与比
 * 天然一致——**少一份实现就少一处漂移点**。
 *
 * @param canonical - {@link canonicalConfig} 的产物。
 * @returns 嵌套的朴素对象；任何一行不合法时返回 `null`。
 */
export function parseCanonicalConfig(canonical: string): Record<string, unknown> | null {
  const root: Record<string, unknown> = {}
  // 计数器就是「有没有解出至少一个叶子」的判据。
  //
  // 这是一个真缺陷：旧版本里这里直接进循环，空串一行都不进，
  // 于是返回 `{}`；而 `snapshotToConfig` 拿 `{}` 去 `mergeConfig(DEFAULT_CONFIG, {})`
  // 得到**完整的默认配置**、校验也能通过 ⇒ 返回一份「合法」配置。
  // 于是一条被截断成空行的快照，回滚时会**静默把整库配置重置为默认值**。
  // 用户要的是「回到那一份」，拿到的是「全部重置」，而且两者都报成功。
  //
  // 与模块注释里「绝不兜底成默认配置」那条承诺同源：
  // **承诺写在注释里不算，得有代码挡住那条路。**
  //
  // 一度写成两层（先判 `trim().length === 0`、末尾再判 `parsed === 0`），
  // 但两层**严格重叠**：只要一行解析成功，trim 必非空；
  // trim 为空时必一行也解不出。多出的那层在反向验证里
  // 变成了**等价变异**（改坏它 fail=0）——那不是双保险，是死代码。
  // 只保留这一层，它直接对应「拿不到真实配置」这个本质判据。
  let parsed = 0
  for (const line of canonical.split(String.fromCharCode(10))) {
    if (line.length === 0) continue
    const splitAt = line.indexOf('=')
    if (splitAt <= 0) return null
    const path = line.slice(0, splitAt)
    const text = line.slice(splitAt + 1)
    let value: unknown
    try {
      value = JSON.parse(text) as unknown
    } catch {
      return null
    }
    parsed += 1
    const segments = path.split('.')
    let cursor: Record<string, unknown> = root
    for (let index = 0; index < segments.length; index += 1) {
      const key = segments[index]
      if (key === undefined || key.length === 0) return null
      if (index === segments.length - 1) {
        cursor[key] = value
        break
      }
      const existing = cursor[key]
      if (!isPlainObject(existing)) cursor[key] = {}
      cursor = cursor[key] as Record<string, unknown>
    }
  }
  // 一行都没解出来（空串、只有换行符、只有空白）时返回 `null`。
  // 这个结果**绝不能**被当成一份可用配置。
  return parsed === 0 ? null : root
}
