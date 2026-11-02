/**
 * 事件日志（Journal）：唯一真相源的持久化载体。
 *
 * 设计依据：
 * - 原则 P2「事件日志是唯一真相源，卡片是派生视图」：库里只追加记录，永不改写历史。
 * - FR-A3 原子性：一条记录一行 JSONL，写完立即 fsync；崩溃最多留下尾部半行，
 *   重启时 {@link Journal.open} 会把残缺尾行截断，绝不会出现「写了一半的卡片」。
 * - FR-A2 幂等：日志自己维护已见幂等键集合，重复键直接丢弃，不落盘。
 * - 分片：单文件超过 `segmentBytes` 后滚动到 `journal-000002.jsonl`，
 *   避免单文件无限增长拖慢重放与备份。
 *
 * 本模块只依赖 `node:` 内置模块，禁止 import 任何宿主包。
 *
 * @module dsh-memory/store/journal
 */

import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  statSync, truncateSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { fnv1a64 } from '../core/types.ts'
import type { JournalRecord } from '../core/types.ts'

/** 日志分片文件名前缀。 */
export const JOURNAL_FILE_PREFIX = 'journal-'

/** 日志分片文件名后缀。 */
export const JOURNAL_FILE_SUFFIX = '.jsonl'

/** 分片序号宽度，补零后便于字典序排序。 */
const SHARD_INDEX_WIDTH = 6

/** 日志里允许出现的全部操作标签，用于反序列化时做结构校验。 */
const KNOWN_OPS: ReadonlySet<string> = new Set([
  'put', 'revise', 'touch', 'archive', 'restore', 'merge', 'edge', 'purge',
])

/**
 * 派生幂等键。
 *
 * 需求 FR-A2 要求「同一事件重复处理不产生重复卡」。把参与判定的要素拼起来
 * 做 FNV-1a，得到稳定且可复现的键——同样的输入永远得到同样的键，重放才能幂等。
 *
 * @param parts - 参与判定的要素，按固定顺序传入。
 * @returns 16 位十六进制幂等键。
 */
export function buildIdempotencyKey(...parts: string[]): string {
  return fnv1a64(parts.join('\u0003'))
}

/**
 * 分片文件名。
 *
 * @param index - 从 1 开始的分片序号。
 * @returns 形如 `journal-000001.jsonl` 的文件名。
 */
export function shardFileName(index: number): string {
  return `${JOURNAL_FILE_PREFIX}${String(index).padStart(SHARD_INDEX_WIDTH, '0')}${JOURNAL_FILE_SUFFIX}`
}

/**
 * 从文件名解析分片序号。
 *
 * @param fileName - 文件名（不含目录）。
 * @returns 序号；不是日志分片时返回 `null`。
 */
function shardIndexOf(fileName: string): number | null {
  if (!fileName.startsWith(JOURNAL_FILE_PREFIX) || !fileName.endsWith(JOURNAL_FILE_SUFFIX)) {
    return null
  }
  const body = fileName.slice(JOURNAL_FILE_PREFIX.length, fileName.length - JOURNAL_FILE_SUFFIX.length)
  if (!/^\d+$/u.test(body)) return null
  const index = Number.parseInt(body, 10)
  return Number.isFinite(index) && index > 0 ? index : null
}

/**
 * 列出目录下全部分片文件名，按分片序号升序。
 *
 * 目录不存在时返回空数组（首次打开库的正常情况）。
 *
 * @param dir - 数据目录。
 * @returns 文件名数组，不含目录前缀。
 */
export function listShardFiles(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const indexed: Array<{ index: number; name: string }> = []
  for (const name of names) {
    const index = shardIndexOf(name)
    if (index === null) continue
    indexed.push({ index, name })
  }
  indexed.sort((a, b) => a.index - b.index)
  return indexed.map((item) => item.name)
}

/**
 * 序列化一条记录为一行 JSONL（含行尾换行）。
 *
 * @param record - 日志记录。
 * @returns 可直接追加写入的字符串。
 */
export function encodeRecord(record: JournalRecord): string {
  return `${JSON.stringify(record)}\n`
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 反序列化一行 JSONL。
 *
 * 只做结构校验，不做业务校验：读日志时宁可丢掉一条坏行，也不能让整个库打不开
 * （FR-A3 崩溃恢复要求重启后可用）。
 *
 * @param line - 一行文本（可含行尾空白）。
 * @returns 日志记录；空行或结构不合法时返回 `null`。
 */
export function decodeRecord(line: string): JournalRecord | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed['v'] !== 1) return null
  const seq = parsed['seq']
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return null
  const at = parsed['at']
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  const key = parsed['idempotencyKey']
  if (typeof key !== 'string' || key.length === 0) return null
  const op = parsed['op']
  if (!isPlainObject(op)) return null
  const tag = op['op']
  if (typeof tag !== 'string' || !KNOWN_OPS.has(tag)) return null
  return parsed as unknown as JournalRecord
}

/**
 * 日志打开模式（三态）。
 *
 * 为什么是三态而不是「只读 / 可写」两态：`rebuild` 的职责就是**修残缺尾行**，
 * 它必须能写盘（`truncateSync`），但它绝不该追加新记录。两态会逼出一个二选一：
 * 要么把 `rebuild` 误锁成只读、失去修复能力，要么把它当成可写、允许并发写。
 * 两种都是错的，所以拆出中间的 `'repair'`。
 *
 * - `'readonly'`：纯读（CLI `query` / `health`）。跳过尾行修复，`append` 抛错。
 * - `'repair'`：修复性只读（CLI `rebuild`）。允许 `repairTail` 截断残缺尾行，
 *   但 `append` 抛错。
 * - `'write'`：全功能（插件、夜整理）。
 */
export type JournalMode = 'readonly' | 'repair' | 'write'

/**
 * 并发写入冲突（D-08）。
 *
 * 当另一个进程（通常是同时运行的 CLI）已经改动过日志目录时抛出。
 *
 * 为什么用独立错误类型 + 稳定 `code` 双通道：`instanceof` 供本仓库内调用方使用，
 * `code` 供跨包 / 跨 realm / 错误被序列化后使用——那些场景 `instanceof` 会失效，
 * 只靠它会让调用方把「并发冲突」误当成「磁盘满 / 权限错」而重试到死。
 */
export class ConcurrentWriterError extends Error {
  /** 稳定错误码，供不依赖 `instanceof` 的调用方判别。 */
  readonly code = 'MEMORY_CONCURRENT_WRITER' as const

  /**
   * @param message - 面向人的完整说明（含成因与恢复办法）。
   */
  constructor(message: string) {
    super(message)
    this.name = 'ConcurrentWriterError'
  }
}

/**
 * 在只读 / 修复模式下尝试追加记录。
 *
 * 与 {@link ConcurrentWriterError} 刻意分开：那是**运行时的外部状况**（可以恢复），
 * 这是**调用方的编程错误**（模式用错了，重试无用，只能改代码）。
 * 把两者混成一个错误，会让调用方对着一个永远不可能成功的重试循环打转。
 */
export class ReadOnlyModeError extends Error {
  /** 稳定错误码。 */
  readonly code = 'MEMORY_READONLY_MODE' as const

  /**
   * @param message - 面向人的完整说明。
   */
  constructor(message: string) {
    super(message)
    this.name = 'ReadOnlyModeError'
  }
}

/** 日志打开参数。 */
export interface JournalOptions {
  /** 数据目录（绝对路径）。 */
  dir: string
  /** 单片大小上限（字节），超过后滚动。 */
  segmentBytes: number
  /** 每次写入是否 fsync（FR-A3）。 */
  fsyncOnWrite: boolean
  /**
   * 打开模式（三态，见 {@link JournalMode}）。
   *
   * **必填，不给默认值**：本类是底层原语，三态在这里真正生效。给默认值意味着
   * 漏传的调用点会静默获得某种权限——默认 `'readonly'` 会让写入方静默失去写能力，
   * 默认 `'write'` 会让只读调用方静默获得写权限。两种静默都是事故。
   * 全部调用点都在本仓库内（`store.ts` 与 `tests/store/`），改成必填不产生破坏。
   *
   * 注意 `StoreOptions.mode` 是**可选**的，两者刻意不对称，理由见那里的注释。
   */
  mode: JournalMode
}

/** 一次追加的结果。 */
export interface AppendOutcome {
  /** 是否真正落盘；`false` 表示幂等键重复被丢弃。 */
  appended: boolean
  /** 落盘后的记录（被丢弃时是入参原样返回）。 */
  record: JournalRecord
  /** 重复时给出首次落盘的序号，便于调用方对齐。 */
  duplicateOfSeq?: number
}

/**
 * 事件日志。
 *
 * 只追加、不修改：任何「状态变更」都必须表达成一条新记录。
 * 序号由日志统一分配，保证严格单调递增——重放顺序只有这一个依据。
 */
export class Journal {
  /** 数据目录。 */
  readonly dir: string
  /** 打开模式（三态）。 */
  readonly mode: JournalMode

  private readonly segmentBytes: number
  private readonly fsyncOnWrite: boolean
  private shardIndex = 0
  private shardBytes = 0
  private maxSeq = 0
  private total = 0
  private opened = false
  private readonly seenKeys = new Set<string>()
  private readonly keySeq = new Map<string, number>()

  /**
   * @param options - 打开参数。
   */
  constructor(options: JournalOptions) {
    this.dir = options.dir
    this.mode = options.mode
    // 单片大小至少 1 字节，避免配置成 0 导致每行都换片。
    this.segmentBytes = Math.max(1, Math.floor(options.segmentBytes))
    this.fsyncOnWrite = options.fsyncOnWrite
  }

  /**
   * 打开日志：建目录、扫已有分片、恢复幂等键集合与序号水位。
   *
   * 顺带做崩溃修复：最后一个分片若没有以换行结尾，说明上次写到一半被强杀，
   * 这里把它截断到最后一个完整行，保证后续追加不会接在半个 JSON 后面（ST-3）。
   * **纯只读模式跳过这一步**——只读命令（`query` / `health`）不该改动磁盘，
   * 哪怕改动叫「修复」：一个查一眼的命令顺手截断文件，在事后审计里无法解释。
   *
   * 重复调用是安全的（幂等）。
   */
  open(): void {
    if (this.opened) return
    mkdirSync(this.dir, { recursive: true })
    // 先清零再累加：本方法可被 close() 之后再次调用，若在旧值上累加，
    // count() 会随每次重开翻倍（5 → 10 → 15），而 FR-F5 健康检查依赖它。
    this.resetWatermarks()
    const files = listShardFiles(this.dir)
    const canRepair = this.mode !== 'readonly'
    for (const file of files) {
      const path = join(this.dir, file)
      if (canRepair) this.repairTail(path)
      const text = readFileSync(path, 'utf8')
      for (const line of text.split('\n')) {
        const record = decodeRecord(line)
        if (record === null) continue
        this.total += 1
        if (record.seq > this.maxSeq) this.maxSeq = record.seq
        this.seenKeys.add(record.idempotencyKey)
        if (!this.keySeq.has(record.idempotencyKey)) {
          this.keySeq.set(record.idempotencyKey, record.seq)
        }
      }
      const index = shardIndexOf(file)
      if (index !== null && index > this.shardIndex) this.shardIndex = index
    }
    const lastFile = files[files.length - 1]
    this.shardBytes = lastFile === undefined ? 0 : statSync(join(this.dir, lastFile)).size
    this.opened = true
  }

  /**
   * 追加一条记录。
   *
   * 幂等键重复时直接丢弃并返回 `appended: false`，不写盘、不推进序号。
   *
   * 序号**由日志统一分配**（当前水位 + 1），入参的 `seq` 只当建议值忽略。
   * 为什么不让调用方决定：外部传入的历史序号可能带空洞或倒序，
   * 而重放顺序只认 `seq`，一旦出现倒序，重放结果就不再确定（ST-1）。
   *
   * @param record - 待追加记录；其 `seq` 会被日志覆盖。
   * @returns 追加结果。
   * @throws {ReadOnlyModeError} 模式不是 `'write'` 时。
   * @throws {ConcurrentWriterError} 检测到第二个写入者时（D-08）。
   */
  append(record: JournalRecord): AppendOutcome {
    this.ensureOpen()
    this.assertWritable()
    const existingSeq = this.keySeq.get(record.idempotencyKey)
    if (existingSeq !== undefined) {
      return { appended: false, record, duplicateOfSeq: existingSeq }
    }
    // 写之前先确认水位没被别人动过。放在幂等检查之后：重复键本来就不写盘，
    // 没必要为一个必然被丢弃的写入去 stat。
    this.assertSoleWriter()
    const seq = this.maxSeq + 1
    const stored: JournalRecord = {
      v: 1,
      seq,
      at: record.at,
      idempotencyKey: record.idempotencyKey,
      op: record.op,
    }
    const line = encodeRecord(stored)
    const bytes = Buffer.byteLength(line, 'utf8')
    // 当前片已写满（且不是空片）才滚动，否则单条超大记录会陷入「每行一片」。
    if (this.shardIndex === 0 || (this.shardBytes > 0 && this.shardBytes + bytes > this.segmentBytes)) {
      this.shardIndex += 1
      this.shardBytes = 0
    }
    const path = join(this.dir, shardFileName(this.shardIndex))
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, line)
      if (this.fsyncOnWrite) fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.shardBytes += bytes
    this.maxSeq = seq
    this.total += 1
    this.seenKeys.add(stored.idempotencyKey)
    this.keySeq.set(stored.idempotencyKey, seq)
    return { appended: true, record: stored }
  }

  /**
   * 按分片顺序、行顺序读出全部记录。
   *
   * 坏行与空行被跳过：宁可少一条，也不让整库打不开。
   *
   * @returns 记录数组。
   */
  readAll(): JournalRecord[] {
    this.ensureOpen()
    const records: JournalRecord[] = []
    for (const file of listShardFiles(this.dir)) {
      const text = readFileSync(join(this.dir, file), 'utf8')
      for (const line of text.split('\n')) {
        const record = decodeRecord(line)
        if (record !== null) records.push(record)
      }
    }
    return records
  }

  /**
   * 当前最大序号；空日志为 0。
   *
   * @returns 序号水位。
   */
  lastSeq(): number {
    this.ensureOpen()
    return this.maxSeq
  }

  /**
   * 已落盘记录条数。
   *
   * @returns 条数。
   */
  count(): number {
    this.ensureOpen()
    return this.total
  }

  /**
   * 判断幂等键是否已出现过。
   *
   * @param key - 幂等键。
   * @returns 是否已见。
   */
  hasKey(key: string): boolean {
    this.ensureOpen()
    return this.seenKeys.has(key)
  }

  /**
   * 关闭日志。
   *
   * 每次写入都是「打开—写入—fsync—关闭」，不持有常驻文件句柄，
   * 因此这里只需把打开标记复位，便于同一实例重复使用。
   * 水位字段由 {@link open} 在下次打开时清零，不在这里清——
   * 关闭后到重开前调用 `count()` 仍应读到上次的值，而不是 0。
   */
  close(): void {
    this.opened = false
  }

  /** 清零全部进程内水位，供 {@link open} 在重新扫描前调用。 */
  private resetWatermarks(): void {
    this.shardIndex = 0
    this.shardBytes = 0
    this.maxSeq = 0
    this.total = 0
    this.seenKeys.clear()
    this.keySeq.clear()
  }

  /**
   * 拒绝非写模式的追加。
   *
   * @throws {ReadOnlyModeError} 模式不是 `'write'` 时。
   */
  private assertWritable(): void {
    if (this.mode === 'write') return
    throw new ReadOnlyModeError(
      `记忆库以「${this.mode}」模式打开，不能写入：${this.dir}。`
      + `「${this.mode}」模式用于离线查询与修复，写入会被拒绝。`
      + '如果这个写入是预期的，请用可写模式重新打开（插件 / 夜整理走的就是可写模式）；'
      + '如果这个写入不该发生，说明有调用方用错了模式。',
    )
  }

  /**
   * 写入前确认水位仍与磁盘一致，不一致即判定存在第二个写入者（D-08）。
   *
   * ## 这里守的是什么，不守什么（诚实边界）
   *
   * **B 没有消除竞态，它消除的是「损坏必然发生且无人知晓」。**
   *
   * 检查与写入之间仍有 TOCTOU 窗口：另一个写入者若恰好在这个窗口里插入一条，
   * 那一条依然会被静默损坏。B 把「第二个实例一写就损坏」变成
   * 「只有极窄的窗口内损坏，其余情况一律响亮失败」。
   *
   * 所以下面这段 `statSync` 不是多余的防御性代码，它是**唯一的检测手段**：
   * 删掉它，第二个实例就会像以前一样把 `seq` 写成 `1,1,2,2`，
   * 而磁盘上一切看起来都正常，直到某天重放顺序错乱、派生状态与日志对不上，
   * 且**无从追溯是哪一次写入坏的**。这段代码的价值不在于它拦住了多少次，
   * 而在于它把「静默损坏」换成了「一个说得清的错误」。
   *
   * ## 为什么不会误伤自己
   *
   * 每次成功写入后都会同步更新 `shardIndex` / `shardBytes`，因此本实例自己的
   * 写入不会触发误报；而 `open()` 后的水位与磁盘严格一致，之后的任何增长
   * 只可能来自外部。
   *
   * ## 成本
   *
   * 一次 `readdirSync` + 一次 `statSync`，与分片数量无关（实测 1 片 0.022ms、
   * 3 片 0.022ms、10 片 0.024ms、50 片 0.036ms，约为一次 fsync 写入的 4%~6%）。
   *
   * ## 不要改成「逐片 statSync」——那会让成本涨十倍以上
   *
   * 下面的写法是**只 stat 最后一个分片**，不是漏了。将来看到「怎么只查了末片」
   * 时请先读完这段，再决定要不要「修」。
   *
   * 逐片 `statSync` 会随分片数线性增长，实测 50 片要 0.25ms，占一次 append
   * 的 **43%**；当前写法是 **3.8%~6.1%**。**改错一次就是十倍代价**，
   * 而且改完代码看起来更「严谨」、测试全绿、没人会怀疑。
   *
   * 更关键的是**逐片检查对判定没有额外价值**：
   *
   * - 旧分片一旦滚动就**再也不会被写入**（`append` 只写末片），
   *   它们的大小不变，查了也永远「一致」。
   * - 外部写者能留下的痕迹只有两种：末片变长，或多出新的分片。两种都已覆盖。
   *
   * 所以逐片 stat 不是「更保险」，是**把 O(1) 的检查做成 O(分片数) 的检查，
   * 换取零额外检测能力**。
   *
   * 顺带一提：分片数增长很慢（默认 4 MiB ≈ 12087 条/片；重度使用 1500 条/天
   * 一年也只有 45 片）。即使真按逐片写，也要一两年后才会痛——
   * **这种「很久以后才痛」的性能退化，正是最容易被后人无意中引入的一类。**
   *
   * @throws {ConcurrentWriterError} 磁盘状态与内存水位不一致时。
   */
  private assertSoleWriter(): void {
    const files = listShardFiles(this.dir)
    const lastFile = files[files.length - 1]
    // 用文件名解析出的序号，而不是 `files.length`：分片序号理论上可能出现空洞
    // （手工删过中间分片），那时长度与序号不相等，用长度会误判成「没有第二个写者」。
    const diskIndex = lastFile === undefined ? 0 : (shardIndexOf(lastFile) ?? 0)
    const diskBytes = lastFile === undefined ? 0 : statSync(join(this.dir, lastFile)).size
    if (diskIndex === this.shardIndex && diskBytes === this.shardBytes) return

    throw new ConcurrentWriterError(
      '检测到第二个写入者，已拒绝写入以免损坏记忆库。\n'
      + `  记忆库目录：${this.dir}\n`
      + `  内存水位：分片数 ${this.shardIndex}，末片 ${this.shardBytes} 字节\n`
      + `  磁盘实际：分片数 ${diskIndex}，末片 ${diskBytes} 字节\n`
      + '  为什么会这样：本实例打开记忆库时记录了一份磁盘水位，之后磁盘被别的进程'
      + '改动过（最常见的是同时运行的 CLI，或同一个记忆库被两个 agent 打开）。'
      + '两方各自从自己的水位分配序号，会写出重复或倒序的 seq，'
      + '而重放只认 seq，于是派生状态与日志对不上且事后无从追溯（ST-1）。\n'
      + '  怎么恢复：关闭并重新打开记忆库即可——重开会重新扫描磁盘、对齐水位，'
      + '之后可继续写入。\n'
      + '  长期方案：不要同时运行 CLI 与插件写同一个记忆库；'
      + '需要离线操作时先停掉插件，或改用只读模式（query / health 不会写盘）。',
    )
  }

  /** 懒打开，避免调用方漏调 {@link open}。 */
  private ensureOpen(): void {
    if (!this.opened) this.open()
  }

  /**
   * 截断尾部残缺行。
   *
   * @param path - 分片文件绝对路径。
   */
  private repairTail(path: string): void {
    const text = readFileSync(path, 'utf8')
    if (text.length === 0 || text.endsWith('\n')) return
    const cut = text.lastIndexOf('\n') + 1
    truncateSync(path, Buffer.byteLength(text.slice(0, cut), 'utf8'))
  }
}
