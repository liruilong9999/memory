/**
 * 压缩台账（Compaction Ledger）：记录宿主每次压缩吞掉了哪些 `seq`（P1-6）。
 *
 * ## 这个台账为什么存在
 *
 * 宿主在上下文快满时会压缩对话：被压缩的那段原文会被一条摘要取代
 * （`docs/2-DSH宿主约束.md:100` 的三步配合）。**如果插件不在这一刻把尚未
 * 落盘的轮次写进记忆，那些对话就永久丢失了**——后续任何一轮都不会再提到
 * 它们，`agent/turn-stopping` 也不会为已经结束的轮次补发。
 *
 * 台账解决两件事：
 *
 * 1. **跨进程幂等**：同一个 `compactionId` 被投递两次时只处理一次。
 * 2. **可观测**：`engine.health()` 能报出「最近被吞掉了哪些 `seq`」。
 *
 * ## 为什么是独立文件，不是 `meta.json`，更不是事件日志
 *
 * 判据来自 `src/store/meta.ts` 模块注释里的两条。
 *
 * **判据二（语义纯净性，更硬的一条）直接否决「写进事件日志」。** 压缩是
 * **宿主**的动作，不是用户做的。写进日志会同时造成两件事：重放不再等于
 * 「重放用户做过什么」；以及挤占 `seq`——将来任何按 `seq` 分析用户行为的
 * 逻辑都会算错，**而且错了不会报错**。
 *
 * **判据一（可恢复性）这里不满足，但后果可接受。** 台账丢了无法从日志
 * 重建。可承受，因为最坏后果是**重复 flush 一次**：flush 的产物是记忆卡，
 * 卡片经 `putCard` 的 `deriveIdempotencyKey` 去重，重复 flush 不产生重复卡。
 * 丢掉的另一半是可观测历史（最近被吞了哪些区间）——那本来就只有「最近
 * 一段窗口」有用，而窗口外的记录正是我们会主动截掉的部分。
 *
 * **也不放 `meta.json`**：那个文件的 `coerceMeta` 是**逐字段构造 + 任何
 * 不合法整体重置**，加字段不同步改它就永远读不回且不报错；而且它是
 * 「派生状态反复覆写」的标量容器，本台账是**有界 FIFO 列表**，形状不同。
 *
 * ## 目录约定
 *
 * 放 `compaction/` 子目录而不是数据目录顶层，理由同 `src/store/configLedger.ts`：
 * 顶层是事件日志分片（`journal-<数字>.jsonl`）的地盘，任何「按 `.jsonl` 扫
 * 顶层」的外部工具都会把旁路文件当成事件日志。教训见 `docs/7-缺陷复盘.md`
 * 真缺陷十一。
 *
 * ## 与 `meta.ts` 不一致的两处，都是刻意的
 *
 * 1. **文件版本号不认识就重置整份台账**（与 `coerceMeta` 一致）：降级读
 *    未知格式比没有数据更危险——旧代码可能把新格式的字段读成「没有」，
 *    然后按默认值写回，把真实数据覆盖掉。
 * 2. **单条记录不合法只跳过那一条，不重置整份**（与 `coerceMeta` 的
 *    「任何不合法即整体重置」不同）。理由：`meta` 是**单个**状态，逐字段
 *    兜底会产出「一半上次的一半默认的」没人能解释的状态；而台账是**列表**，
 *    跳过一条的含义是明确的、局部的，代价上限是那一条的幂等记忆丢失，
 *    也就是「那个 `compactionId` 再来一次会重复 flush 一遍」——而重复
 *    flush 不产生重复卡。**有界的局部损失优于整份的静默清空。**
 *
 * @module dsh-memory/host/engine/compactionLedger
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 台账子目录名（同 `config/`、`logs/`，见模块注释）。 */
export const COMPACTION_LEDGER_DIR = 'compaction'

/** 台账文件名。`.json` 不会被任何「按 `.jsonl` 扫顶层」的外部工具误认。 */
export const LEDGER_FILE_NAME = 'ledger.json'

/** 台账文件格式版本。改结构就递增，理由见模块注释第 1 条。 */
export const COMPACTION_LEDGER_VERSION = 1

const NL = String.fromCharCode(10)

/**
 * 被压缩吞掉的一段 **surface 位置跨度**。
 *
 * ## 这不保证 `start <= end`，也不等于 `seq` 区间
 *
 * 宿主把新摘要节点放到**旧区间的位置上**，而摘要节点的 `seq` 比旧节点高。
 * 于是后续再次压缩那片区域时，`start` 可以**大于** `end`（宿主源码
 * `packages/compaction/compaction/src/types.ts:110-115` 明确写了这一点）。
 *
 * 因此**不能用 `range` 反推「吞了哪些 `seq`」**——真正的权威集合是
 * {@link CompactionRecord.shadowedSeqs}。两个字段都存，因为它们的用途不同：
 * `range` 描述「原文原本占多大一片版面」，`shadowedSeqs` 描述「具体哪些
 * 节点被替换掉了」（后者是稀疏的，不连续）。
 */
export interface ShadowedRange {
  /** 跨度起点（surface 位置，可能大于 `end`）。 */
  start: number
  /** 跨度终点。 */
  end: number
}

/** 一次压缩的台账记录。 */
export interface CompactionRecord {
  /**
   * 会话 id。**幂等键的一半**（另一半是 `compactionId`）。
   *
   * 必须带上：`compactionId` 由宿主生成，跨会话是否唯一取决于宿主的
   * `CompactionId` 生成方式，我们不能假设它全局唯一；而「同一会话的同一
   * 次压缩」才是我们要认出来的那个事实。
   */
  sessionId: string
  /** 宿主给的压缩标识。**幂等键的一半**。 */
  compactionId: string
  /** 最近一次投递的记账时刻（毫秒时间戳）。 */
  at: number
  /**
   * 被吞掉的 surface 位置跨度；载荷没给或不合法时为 `null`。
   *
   * **不保证 `start <= end`**，见 {@link ShadowedRange}。也**不用 `{0,0}`
   * 代表「不知道」**：那会让读者以为真有一个零点区间。真正能回答「吞了
   * 哪些 `seq`」的始终是 {@link CompactionRecord.shadowedSeqs}。
   */
  shadowedRange: ShadowedRange | null
  /** 被吞掉的节点 `seq`（宿主列出的权威集合，稀疏、不连续）。 */
  shadowedSeqs: number[]
  /** 被吞掉的 token 数（宿主自己算的）。 */
  shadowedTokenCount: number
  /**
   * 这个 `compactionId` **累计**回填了多少张记忆卡。
   *
   * 记在台账里而不是只写诊断日志，是因为它是唯一能回答「这步到底救回
   * 东西没有」的量。`0` 是合法值——那说明被吞的那几轮里没有值得记的内容，
   * 与「flush 根本没跑」是两件事，而后者只能靠 `deliveries` 与这个数字
   * 一起看才区分得开。
   *
   * 语义是**累计**而不是「最近一次」：重投同一个 `compactionId` 时通常不再
   * flush（已处理过），若写成覆盖，一次重投就会把「救回了 3 张」抹成 0。
   */
  flushedCards: number
  /**
   * 同一幂等键被投递了几次。
   *
   * 恒为 1 是常态。大于 1 说明宿主重投了同一个 `compactionId`——这是幂等
   * 真的起作用的证据，也是「压缩路径上有人重复触发」的唯一线索。
   */
  deliveries: number
}

/**
 * 幂等键：`sessionId` + `compactionId`。
 *
 * **刻意不含 `shadowedRange` / `shadowedSeqs`**：如果把范围拼进键，同一
 * `compactionId` 带着不同范围再来一次就会被当成一条新记录，于是同一个
 * 压缩被记两次——那是「该丢弃的丢弃」方向失守。不带范围则相反：同 id
 * 不同内容会被**更新**而不是丢弃，这正是「该更新的更新」方向要的行为
 * （`deriveIdempotencyKey` 的 `edge` / `put` 分支都在这上面踩过，见
 * `tests/host/` 与 `docs/7`）。
 *
 * 跨进程成立：键的两个成分都来自宿主的持久事件（写进台账文件），与进程
 * 内存无关；`readCompactionLedger` 在引擎构造时把整份台账读回内存。
 *
 * @param record - 台账记录。
 * @returns 稳定的键字符串。
 */
export function compactionKey(record: Pick<CompactionRecord, 'sessionId' | 'compactionId'>): string {
  return `${record.sessionId}${String.fromCharCode(0)}${record.compactionId}`
}

/**
 * 台账目录路径。
 *
 * @param dataDir - 数据目录。
 * @returns `compaction/` 子目录的完整路径。
 */
export function compactionLedgerDir(dataDir: string): string {
  return join(dataDir, COMPACTION_LEDGER_DIR)
}

/**
 * 台账文件路径。
 *
 * @param dataDir - 数据目录。
 * @returns `compaction/ledger.json` 的完整路径。
 */
export function compactionLedgerPath(dataDir: string): string {
  return join(compactionLedgerDir(dataDir), LEDGER_FILE_NAME)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function coerceRange(raw: unknown): ShadowedRange | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const start = record.start
  const end = record.end
  if (!isFiniteNumber(start) || !isFiniteNumber(end)) return null
  // 刻意**不**校验 start <= end：见 ShadowedRange 的注释，那会拒掉合法数据。
  return { start, end }
}

function coerceSeqList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null
  const seqs: number[] = []
  for (const item of raw) {
    if (!isFiniteNumber(item)) return null
    seqs.push(item)
  }
  return seqs
}

function coerceRecord(raw: unknown): CompactionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const sessionId = record.sessionId
  const compactionId = record.compactionId
  const at = record.at
  const shadowedTokenCount = record.shadowedTokenCount
  const flushedCards = record.flushedCards
  const deliveries = record.deliveries
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (typeof compactionId !== 'string' || compactionId.length === 0) return null
  if (!isFiniteNumber(at)) return null
  if (!isFiniteNumber(shadowedTokenCount) || shadowedTokenCount < 0) return null
  if (!isFiniteNumber(flushedCards) || flushedCards < 0) return null
  if (!isFiniteNumber(deliveries) || deliveries < 1) return null
  const shadowedRange = record.shadowedRange
  if (shadowedRange !== null && coerceRange(shadowedRange) === null) return null
  const shadowedSeqs = coerceSeqList(record.shadowedSeqs)
  if (shadowedSeqs === null) return null
  return {
    sessionId,
    compactionId,
    at,
    shadowedRange: shadowedRange === null ? null : coerceRange(shadowedRange),
    shadowedSeqs,
    shadowedTokenCount,
    flushedCards,
    deliveries,
  }
}

function coerceLedger(parsed: unknown): CompactionRecord[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const file = parsed as Record<string, unknown>
  // 版本不认识就重置整份台账（理由见模块注释第 1 条）。
  if (file.v !== COMPACTION_LEDGER_VERSION) return []
  const raw = file.records
  if (!Array.isArray(raw)) return []
  const records: CompactionRecord[] = []
  for (const item of raw) {
    const record = coerceRecord(item)
    // 单条不认识只跳过那一条（理由见模块注释第 2 条）。
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * 读取台账。
 *
 * 任何异常都不抛：文件不存在是最常见的情况（首次运行），不是错误；
 * 内容损坏也只当作空台账。理由同 `readMeta`——**读旁路数据失败不该让
 * 插件加载失败**。
 *
 * @param dataDir - 数据目录。
 * @returns 台账记录（可能为空数组）。
 */
export function readCompactionLedger(dataDir: string): CompactionRecord[] {
  let raw: string
  try {
    raw = readFileSync(compactionLedgerPath(dataDir), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return coerceLedger(parsed)
}

/**
 * 原子写入台账（tmp + rename）。
 *
 * 与 `writeMeta` 同款，包括那条 Windows 细节：`renameSync` 覆盖已存在文件
 * 是允许的（`MoveFileEx` 带 `REPLACE_EXISTING`），**不需要先删目标**——
 * 先删会制造一个「目标不存在」的窗口，把原子性毁掉。清理 tmp 失败不能
 * 掩盖原始错误。
 *
 * 与 `writeMeta` 一样**不 fsync**：实测 fsync 占单次写入的大头（`meta.ts`
 * 记录的是 82%），而本台账丢了只损失「一次重复 flush」。
 *
 * **会抛错**：调用方负责决定怎么处置。引擎侧会把它包起来降级，
 * 因为压缩路径上不能让记忆插件把宿主弄崩。
 *
 * @param dataDir - 数据目录。
 * @param records - 要写入的记录。
 */
export function writeCompactionLedger(dataDir: string, records: readonly CompactionRecord[]): void {
  const path = compactionLedgerPath(dataDir)
  mkdirSync(compactionLedgerDir(dataDir), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ v: COMPACTION_LEDGER_VERSION, records })}${NL}`, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 清理失败不能掩盖原始错误。
    }
    throw error
  }
}

/**
 * 按幂等键查找已有记录（**纯函数**，不碰磁盘）。
 *
 * @param records - 台账记录。
 * @param sessionId - 会话 id。
 * @param compactionId - 压缩标识。
 * @returns 命中的记录；没有则 `undefined`。
 */
export function findCompactionRecord(
  records: readonly CompactionRecord[], sessionId: string, compactionId: string,
): CompactionRecord | undefined {
  const key = compactionKey({ sessionId, compactionId })
  return records.find((record) => compactionKey(record) === key)
}

/**
 * 合并一条记录并做环形截断（**纯函数**，不碰磁盘）。
 *
 * 幂等键命中时**替换**旧记录（该更新的更新），未命中时**追加**（该记录的
 * 记录）。两种情况都用「先摘掉旧键、再追加到末尾」，于是列表顺序恒等于
 * 「最近一次投递时间序」，`compactionStats` 取末条即为最近一次。
 *
 * @param records - 现有记录。
 * @param next - 新记录（`deliveries` 由调用方算好）。
 * @param maxEntries - 上限；`<= 0` 表示不限制（校验层已挡掉 0，这里仍容错）。
 * @returns 新数组（不修改入参）。
 */
export function upsertCompactionRecord(
  records: readonly CompactionRecord[], next: CompactionRecord, maxEntries: number,
): CompactionRecord[] {
  const key = compactionKey(next)
  const kept = records.filter((record) => compactionKey(record) !== key)
  const appended = [...kept, next]
  if (maxEntries > 0 && appended.length > maxEntries) {
    // 保留**最后** N 条。写成 `slice(0, N)` 会留住最旧的、扔掉最新的，
    // 与「记住最近发生了什么」正好相反（`configSnapshotMaxEntries` 的
    // 校验注释里记过同一个坑：负数会让 `slice(-(-5))` 变成 `slice(5)`）。
    return appended.slice(appended.length - maxEntries)
  }
  return appended
}

/** 压缩回填的观测视图（`engine.health()` 的那一段）。 */
export interface CompactionStats {
  /** 台账里的压缩次数（跨进程累计，受 `storage.compactionLedgerMaxEntries` 截断）。 */
  count: number
  /** 最近一次投递的记账时刻；从未压缩过为 `null`。 */
  lastAt: number | null
  /** 最近一次的 surface 位置跨度；**不保证 `start <= end`**。 */
  lastShadowedRange: ShadowedRange | null
  /** 最近一次被吞掉的节点 `seq`（权威集合，稀疏）。 */
  lastShadowedSeqs: number[]
  /** 最近一次被吞掉的 token 数。 */
  lastShadowedTokens: number
  /** 最近一次回填写入的卡片数（该 `compactionId` 的累计值）。 */
  lastFlushedCards: number
  /** 台账里累计被吞掉的节点数（各次 `shadowedSeqs.length` 之和）。 */
  shadowedSeqsTotal: number
  /** 被重复投递过的压缩次数（`deliveries > 1` 的记录数）。 */
  duplicateDeliveries: number
}

/**
 * 汇总台账为观测视图（**纯函数**）。
 *
 * @param records - 台账记录。
 * @returns 观测视图；空台账返回全零/全 `null` 的形状。
 */
export function summarizeCompactions(records: readonly CompactionRecord[]): CompactionStats {
  const last = records.length === 0 ? undefined : records[records.length - 1]
  return {
    count: records.length,
    lastAt: last === undefined ? null : last.at,
    lastShadowedRange: last === undefined ? null : last.shadowedRange,
    lastShadowedSeqs: last === undefined ? [] : [...last.shadowedSeqs],
    lastShadowedTokens: last === undefined ? 0 : last.shadowedTokenCount,
    lastFlushedCards: last === undefined ? 0 : last.flushedCards,
    shadowedSeqsTotal: records.reduce((sum, record) => sum + record.shadowedSeqs.length, 0),
    duplicateDeliveries: records.filter((record) => record.deliveries > 1).length,
  }
}
