/**
 * 数据面门面（Store Facade）：把日志、状态、索引聚合成一个可用的记忆库。
 *
 * 设计依据：
 * - 原则 P2：写入只写日志，内存状态与索引都是派生视图，随时可丢可重建。
 * - FR-A1：写入是同步的纯本地 IO，不依赖宿主、不发网络请求，因此不会拖慢回复。
 * - FR-A2：`append` 带幂等键，重复事件直接丢弃。
 * - FR-A3：每条记录追加后立即 fsync；重启时由日志截断残缺尾行。
 * - FR-A7：`rebuildIndex()` 可随时重建索引，`state` 才是唯一可信数据。
 *
 * @module dsh-memory/store/store
 */

import { resolve } from 'node:path'

import type { MemoryConfig } from '../core/config.ts'
import { DEFAULT_CONFIG } from '../core/config.ts'
import { buildCardId, buildEdgeId } from '../core/types.ts'
import type { JournalOp, JournalRecord, MemoryCard, MemoryEdge, SourcePointer, MemoryKind } from '../core/types.ts'
import { Journal, buildIdempotencyKey } from './journal.ts'
import type { JournalMode } from './journal.ts'
import type { MemoryState, MemoryFilter } from './state.ts'
import {
  applyRecord, countCards, createEmptyState, edgesOf, filterCards, getCard, rebuildState,
} from './state.ts'
import {
  addToIndex, buildIndexFromMap, indexStats, isIndexConsistent, removeFromIndex, searchIndex,
  searchText,
} from './inverted.ts'
import type { InvertedIndex, IndexHit } from './inverted.ts'
import { exportJsonl } from './export.ts'

/** 打开记忆库的参数。 */
export interface StoreOptions {
  /** 完整配置；省略时使用 {@link DEFAULT_CONFIG}。 */
  config?: MemoryConfig
  /** 数据目录覆盖；省略时用 `config.storage.dataDir`。相对路径按当前工作目录解析。 */
  dataDir?: string
  /** 日志分片大小覆盖（字节）。 */
  segmentBytes?: number
  /** 是否每次写入 fsync；省略时用 `config.storage.fsyncOnWrite`。 */
  fsyncOnWrite?: boolean
  /** 打开时是否立即从日志重放状态；默认 `true`。 */
  replayOnOpen?: boolean
  /**
   * 打开模式（三态，见 {@link JournalMode}）；**默认 `'write'`**。
   *
   * ## 为什么这里是可选的，而 `JournalOptions.mode` 是必填的（刻意不对称）
   *
   * `Journal` 是底层原语，三态在那里真正生效，且它的调用点全部在 `src/store/`
   * 与 `tests/store/` 内，改成必填不波及范围外文件——所以必填，不留默认值。
   *
   * `Store` 是上层门面，调用点跨 `src/index.ts`（宿主）、`src/cli/`、
   * `tests/host/`、`tests/cli/`。把它改成必填，这些**不在本模块写范围内**的
   * 文件会立刻编译不过；按「提交点必须自洽」的规矩就得一起改，反而制造跨范围
   * 冲突——这正是 `cc68878` 那类事故的结构。
   *
   * ## 默认值选 `'write'` 的理由：看漏传的后果，而不是看「显不显式」
   *
   * 默认 `'readonly'`：宿主漏传就**静默失去写能力**，记忆不再入库且没有任何
   * 报错——灾难。默认 `'write'`：等于今天的行为，零回归。
   *
   * 更关键的是：真正防损坏的不是「mode 有没有传」，而是日志写入前的第二写者
   * 检查（D-08）。CLI 漏传 mode 最坏结果是「CLI 仍可能写」，而那道检查会在
   * 它真正写坏数据之前抛错。**防线不在默认值上。**
   */
  mode?: JournalMode
}

/** 一次写入的结果。 */
export interface WriteResult {
  /** 是否真正写入；`false` 表示幂等键重复被丢弃。 */
  written: boolean
  /** 落盘后的记录（丢弃时是入参原样）。 */
  record: JournalRecord
  /** 受影响卡片的新状态；`put` 等操作返回卡片，无卡片语义的操作返回 `undefined`。 */
  card?: MemoryCard
}

/**
 * 记忆库门面。
 *
 * 使用顺序固定为：构造 → {@link open} → 读写 → {@link close}。
 * 所有写方法内部先落日志再更新内存，保证「日志是唯一真相源」。
 */
export class MemoryStore {
  /** 生效配置。 */
  readonly config: MemoryConfig
  /** 数据目录绝对路径。 */
  readonly dir: string
  /** 打开模式（三态）；只读模式下所有写方法都会抛 `ReadOnlyModeError`。 */
  readonly mode: JournalMode

  private readonly journal: Journal
  private readonly replayOnOpen: boolean
  private state: MemoryState = createEmptyState()
  private index: InvertedIndex = buildIndexFromMap(new Map<string, MemoryCard>())
  private opened = false
  private readonly listeners: Array<(record: JournalRecord) => void> = []

  /**
   * @param options - 打开参数。
   */
  constructor(options: StoreOptions = {}) {
    this.config = options.config ?? DEFAULT_CONFIG
    const dataDir = options.dataDir ?? this.config.storage.dataDir
    this.dir = resolve(dataDir)
    this.replayOnOpen = options.replayOnOpen ?? true
    this.mode = options.mode ?? 'write'
    this.journal = new Journal({
      dir: this.dir,
      segmentBytes: options.segmentBytes ?? this.config.storage.journalSegmentBytes,
      fsyncOnWrite: options.fsyncOnWrite ?? this.config.storage.fsyncOnWrite,
      mode: this.mode,
    })
  }

  /**
   * 打开记忆库：打开日志、重放状态、重建索引。
   *
   * 重复调用是安全的。
   */
  open(): void {
    if (this.opened) return
    this.journal.open()
    if (this.replayOnOpen) this.reload()
    this.opened = true
  }

  /**
   * 从日志全量重放：状态与索引一起重建（ST-1 重启一致）。
   */
  reload(): void {
    this.journal.open()
    this.state = rebuildState(this.journal.readAll())
    this.index = buildIndexFromMap(this.state.cards)
  }

  /**
   * 追加一条操作。
   *
   * 幂等键省略时按「操作内容」自动派生，因此同样的操作重复提交不会产生两条记录。
   *
   * @param op - 操作本体。
   * @param idempotencyKey - 幂等键；省略时自动派生。
   * @param at - 记录时刻；省略时用当前时间。
   * @returns 写入结果。
   */
  append(op: JournalOp, idempotencyKey?: string, at = Date.now()): WriteResult {
    this.ensureOpen()
    const key = idempotencyKey ?? deriveIdempotencyKey(op)
    const record: JournalRecord = {
      v: 1,
      seq: this.journal.lastSeq() + 1,
      at,
      idempotencyKey: key,
      op,
    }
    const outcome = this.journal.append(record)
    if (!outcome.appended) {
      return { written: false, record: outcome.record }
    }
    applyRecord(this.state, outcome.record)
    this.syncIndex(outcome.record)
    for (const listener of this.listeners) listener(outcome.record)
    return { written: true, record: outcome.record, card: this.cardOfRecord(outcome.record) }
  }

  /**
   * 便捷写入：新增一张卡（`put`）。
   *
   * @param card - 卡片。
   * @param idempotencyKey - 幂等键；省略时自动派生。
   * @param at - 记录时刻；省略时用卡片自身的 `updatedAt`。
   * @returns 写入结果。
   */
  putCard(card: MemoryCard, idempotencyKey?: string, at = card.updatedAt): WriteResult {
    return this.append({ op: 'put', card }, idempotencyKey, at)
  }

  /**
   * 便捷写入：建立一条图谱边（`edge`）。
   *
   * @param edge - 边；省略 id 时按 `buildEdgeId` 自动派生，天然幂等。
   * @param idempotencyKey - 幂等键；省略时自动派生。
   * @param at - 记录时刻；省略时用当前时间。
   * @returns 写入结果。
   */
  putEdge(edge: MemoryEdge, idempotencyKey?: string, at = Date.now()): WriteResult {
    const id = edge.id.length > 0 ? edge.id : buildEdgeId(edge.from, edge.to, edge.relation)
    return this.append({ op: 'edge', edge: { ...edge, id } }, idempotencyKey, at)
  }

  /**
   * 取一张卡。
   *
   * @param id - 卡片 id。
   * @returns 卡片；不存在时返回 `undefined`。
   */
  getCard(id: string): MemoryCard | undefined {
    this.ensureOpen()
    return getCard(this.state, id)
  }

  /**
   * 按条件列出卡片。
   *
   * @param filter - 查询条件。
   * @returns 卡片数组（顺序确定）。
   */
  listCards(filter: MemoryFilter = {}): MemoryCard[] {
    this.ensureOpen()
    return filterCards(this.state, filter)
  }

  /**
   * 检索候选卡片。
   *
   * @param terms - 查询词项集合。
   * @param limit - 候选池上限；省略时用 `config.recall.candidateLimit`。
   * @returns 命中数组（命中数降序，id 升序）。
   */
  search(terms: Iterable<string>, limit?: number): IndexHit[] {
    this.ensureOpen()
    return searchIndex(this.index, terms, limit ?? this.config.recall.candidateLimit)
  }

  /**
   * 按原文检索候选卡片。
   *
   * @param text - 查询原文。
   * @param limit - 候选池上限；省略时用 `config.recall.candidateLimit`。
   * @returns 命中数组。
   */
  searchText(text: string, limit?: number): IndexHit[] {
    this.ensureOpen()
    return searchText(this.index, text, limit ?? this.config.recall.candidateLimit)
  }

  /**
   * 强制重建索引（FR-A7）。
   *
   * @returns 重建后的索引统计。
   */
  rebuildIndex(): { terms: number; cards: number } {
    this.ensureOpen()
    this.index = buildIndexFromMap(this.state.cards)
    return indexStats(this.index)
  }

  /**
   * 索引与卡片是否一致（FR-F5 健康检查）。
   *
   * @returns 是否一致。
   */
  isIndexHealthy(): boolean {
    this.ensureOpen()
    return isIndexConsistent(this.index, this.state.cards)
  }

  /**
   * 取一张卡的全部关联边。
   *
   * @param cardId - 卡片 id。
   * @returns 边数组。
   */
  edgesOf(cardId: string): MemoryEdge[] {
    this.ensureOpen()
    return edgesOf(this.state, cardId)
  }

  /**
   * 卡片计数。
   *
   * @param status - 只统计某个生命周期状态；省略表示全部。
   * @returns 条数。
   */
  count(status?: 'active' | 'archived'): number {
    this.ensureOpen()
    return countCards(this.state, status)
  }

  /**
   * 导出当前视图为 JSONL（FR-A6）。
   *
   * @param exportedAt - 导出时刻；省略时用当前时间。
   * @returns JSONL 文本。
   */
  exportJsonl(exportedAt = Date.now()): string {
    this.ensureOpen()
    return exportJsonl(this.state.cards.values(), this.state.edges.values(), exportedAt)
  }

  /**
   * 读取当前状态（只读快照，调用方不得修改）。
   *
   * @returns 状态对象。
   */
  snapshot(): MemoryState {
    this.ensureOpen()
    return this.state
  }

  /**
   * 读取当前倒排索引（只读快照）。
   *
   * @returns 倒排索引。
   */
  indexSnapshot(): InvertedIndex {
    this.ensureOpen()
    return this.index
  }

  /**
   * 注册记录监听器，供可观测层写结构化日志（FR-F1）。
   *
   * @param listener - 回调。
   * @returns 取消注册的函数。
   */
  onRecord(listener: (record: JournalRecord) => void): () => void {
    this.listeners.push(listener)
    return () => {
      const at = this.listeners.indexOf(listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  /**
   * 关闭记忆库。写入全部已 fsync，这里只释放标记。
   */
  close(): void {
    this.journal.close()
    this.opened = false
  }

  /** 懒打开。 */
  private ensureOpen(): void {
    if (!this.opened) this.open()
  }

  /**
   * 写入后同步索引，避免每次写都全量重建（NFR-1）。
   *
   * @param record - 刚应用的记录。
   */
  private syncIndex(record: JournalRecord): void {
    const op = record.op
    switch (op.op) {
      case 'put': {
        const card = this.state.cards.get(op.card.id)
        if (card !== undefined) this.index = addToIndex(this.index, card)
        break
      }
      case 'revise':
      case 'touch':
      case 'archive':
      case 'restore': {
        const card = this.state.cards.get(op.id)
        if (card !== undefined) this.index = addToIndex(this.index, card)
        break
      }
      case 'merge': {
        for (const id of op.ids) {
          const card = this.state.cards.get(id)
          if (card !== undefined) this.index = addToIndex(this.index, card)
        }
        const into = this.state.cards.get(op.into.id)
        if (into !== undefined) this.index = addToIndex(this.index, into)
        break
      }
      case 'purge': {
        this.index = removeFromIndex(this.index, op.id)
        break
      }
      default:
        // edge 不参与倒排（图谱检索走 edgesOf），无需同步。
        break
    }
  }

  /**
   * 取记录对应的卡片。
   *
   * @param record - 日志记录。
   * @returns 卡片；无卡片语义时返回 `undefined`。
   */
  private cardOfRecord(record: JournalRecord): MemoryCard | undefined {
    const op = record.op
    switch (op.op) {
      case 'put':
        return this.state.cards.get(op.card.id)
      case 'revise':
      case 'touch':
      case 'archive':
      case 'restore':
        return this.state.cards.get(op.id)
      case 'merge':
        return this.state.cards.get(op.into.id)
      default:
        return undefined
    }
  }
}

/**
 * 打开一个记忆库（工厂函数，等价于 `new MemoryStore(opts).open()`）。
 *
 * @param options - 打开参数。
 * @returns 已打开的记忆库。
 */
export function openStore(options: StoreOptions = {}): MemoryStore {
  const store = new MemoryStore(options)
  store.open()
  return store
}

/**
 * 按操作内容派生幂等键。
 *
 * 为什么自动派生：调用方（抽取面、巩固面）不一定愿意自己拼键，
 * 但「同样的操作重复提交」必须幂等。这里按操作的稳定要素拼键，
 * 既能自动去重，也允许调用方显式覆盖。
 *
 * **`put` 的键必须包含内容指纹**：只按 id 拼键会把「同一张卡的后续更新」
 * 误判为重复提交而静默丢弃——冲突标记回写、强度调整、状态变更全部失效。
 * 包含内容后语义才正确：内容完全相同 → 幂等跳过（ST-2）；内容变了 → 是新版本。
 *
 * @param op - 操作本体。
 * @returns 16 位十六进制幂等键。
 */
export function deriveIdempotencyKey(op: JournalOp): string {
  switch (op.op) {
    case 'put':
      // 指纹取「版本时刻 + 文本 + 冲突列表」：这三者是 put 后可能变化的语义字段。
      // 同一轮重复抽取会得到完全相同的卡（同 id、同 updatedAt、同内容），键相同 → 幂等。
      return buildIdempotencyKey(
        'put',
        op.card.id,
        String(op.card.updatedAt),
        op.card.text,
        op.card.conflictOf.join(','),
      )
    case 'revise':
      return buildIdempotencyKey('revise', op.id, op.text, String(op.at))
    case 'touch':
      return buildIdempotencyKey('touch', op.id, String(op.at))
    case 'archive':
      return buildIdempotencyKey('archive', op.id, String(op.at))
    case 'restore':
      return buildIdempotencyKey('restore', op.id, String(op.at))
    case 'merge':
      return buildIdempotencyKey('merge', op.into.id, op.ids.join(','), String(op.at))
    case 'edge':
      return buildIdempotencyKey('edge', op.edge.id)
    case 'purge':
      return buildIdempotencyKey('purge', op.id, String(op.at))
    default:
      return buildIdempotencyKey('unknown')
  }
}

/**
 * 派生一张卡的稳定 id（转发到 core，供调用方少 import 一个模块）。
 *
 * @param domain - 记忆域。
 * @param source - 来源指针。
 * @param kind - 卡片类型。
 * @param normalized - 归一化文本。
 * @returns 卡片 id。
 */
export function cardIdFor(
  domain: MemoryCard['domain'], source: SourcePointer, kind: MemoryKind, normalized: string,
): string {
  return buildCardId(domain, source, kind, normalized)
}
