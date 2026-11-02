/**
 * 记忆引擎（Memory Engine）：把数据面与行为面装配成「一个能干活的对象」。
 *
 * 这一层**完全不依赖宿主**：给定一个 `MemoryStore` 与配置，它就能
 * 写入、召回、整理、查询。宿主适配层只负责把事件喂进来、把结果注入出去。
 *
 * 这样拆分的好处：
 * - 离线 CLI 可以直接用引擎（不需要 DSH）
 * - 单测可以完整覆盖端到端流程（NFR-8）
 * - 宿主升级时引擎一行不用改（NFR-7）
 *
 * @module dsh-memory/host/engine
 */

import type { MemoryConfig } from '../core/config.ts'
import { extractMemoryCards } from '../core/extraction.ts'
import type { TurnInput } from '../core/extraction.ts'
import {
  buildFocusPack, formatDuration, makeQuery, renderFocusPack, scoreCards,
} from '../core/scoring.ts'
import type {
  ConsolidationReport, FocusPack, MemoryCard, MemoryEdge, MemoryLogEntry, TimeState,
} from '../core/types.ts'
import { runConsolidation } from '../consolidate/nightly.ts'
import type { MemoryStore } from '../store/store.ts'
import {
  buildTimeState, localDate as formatLocalDate, pickDue, renderTimeContext,
} from '../time/clock.ts'
import { parseDue } from '../time/due.ts'

/** 引擎参数。 */
export interface EngineOptions {
  /** 已打开的记忆库。 */
  store: MemoryStore
  /** 生效配置。 */
  config: MemoryConfig
  /** 时区；省略时由调用方提供。 */
  timeZone: string
  /** 可选的自定义时钟，便于确定性测试。 */
  clock?: () => number
  /** 结构化日志回调（FR-F1）；省略时不记录。 */
  onLog?: (entry: MemoryLogEntry) => void
}

/** 一次写入的结果摘要。 */
export interface WriteSummary {
  /** 实际写入的卡片数。 */
  written: number
  /** 因幂等被丢弃的条数。 */
  skipped: number
  /** 写入的卡片。 */
  cards: MemoryCard[]
  /** 命中的信号词。 */
  signals: string[]
}

/** 一次召回的完整结果，含可观测信息。 */
export interface RecallResult {
  /** 焦点包。 */
  pack: FocusPack
  /** 注入文本；空包时为空串。 */
  text: string
  /** 时间读数。 */
  time: TimeState
  /** 候选池大小，用于 FR-F3 指标。 */
  candidates: number
}

/**
 * 记忆引擎。
 *
 * 生命周期：构造 → 直接可用（store 由调用方打开与关闭）。
 */
export class MemoryEngine {
  private readonly store: MemoryStore
  private readonly config: MemoryConfig
  private readonly timeZone: string
  private readonly clock: () => number
  private readonly onLog: ((entry: MemoryLogEntry) => void) | undefined
  /** 上一轮的时刻，用于计算 `sinceLastTurn`。 */
  private lastTurnAt: number | null = null
  /** 上次会话结束时刻（本次启动时为上次写入的最后时刻）。 */
  private lastSessionEndAt: number | null = null
  /** 本次会话开始时刻。 */
  private readonly sessionStartedAt: number
  /** 上次夜整理时刻。 */
  private lastConsolidationAt: number | null = null
  /** 每轮召回次数计数，用于 FR-F3。 */
  private recallCount = 0

  /**
   * @param options - 引擎参数。
   */
  constructor(options: EngineOptions) {
    this.store = options.store
    this.config = options.config
    this.timeZone = options.timeZone
    this.clock = options.clock ?? ((): number => Date.now())
    this.onLog = options.onLog
    this.sessionStartedAt = this.clock()
    this.lastSessionEndAt = this.detectLastActivity()
  }

  /**
   * 写入一轮对话产生的记忆（FR-A1 / FR-A2）。
   *
   * 这是写路径的唯一入口。全部同步完成（本地 IO，微秒级），
   * 因此调用方可以安全地在 `agent/turn-stopping` 里直接调，不会拖慢回复。
   *
   * @param input - 一轮对话。
   * @returns 写入摘要。
   */
  writeTurn(input: TurnInput): WriteSummary {
    const cards = extractMemoryCards(input, this.config)
    // FR-D3 / 起源 L21：把「明天下午三点提醒我」这类句子解析成确定的到期时刻。
    // 解析在时间层（src/time/due.ts），这里只负责把结果填进卡片。
    for (const card of cards) {
      if (card.kind !== 'promise' && card.kind !== 'event') continue
      const spec = parseDue(card.text, input.at, this.timeZone)
      if (spec !== null) card.dueAt = spec.dueAt
    }
    const written: MemoryCard[] = []
    let skipped = 0
    for (const card of cards) {
      const result = this.store.putCard(card)
      if (result.written) written.push(card)
      else skipped += 1
    }
    this.lastTurnAt = input.at
    if (written.length > 0) {
      this.log({
        kind: 'write',
        at: input.at,
        sessionId: input.sessionId,
        summary: `第 ${input.turn} 轮写入 ${written.length} 张记忆卡`,
        detail: {
          turn: input.turn,
          step: input.step,
          seq: input.seq,
          kinds: written.map((c) => c.kind),
          skipped,
        },
      })
    }
    return {
      written: written.length,
      skipped,
      cards: written,
      signals: [...new Set(written.flatMap((c) => c.tags))],
    }
  }

  /**
   * 召回并组装焦点包（FR-B1..B6 / FR-E1..E3）。
   *
   * 流程：取候选 → 打分 → 阈值 → 装包 → 渲染。
   * 候选池来自倒排索引（NFR-1：万级记忆 <50ms）。
   *
   * @param queryText - 查询文本，通常是用户最新一条消息。
   * @param goalText - 当前目标文本，可选。
   * @returns 召回结果。
   */
  recall(queryText: string, goalText = ''): RecallResult {
    const at = this.clock()
    const query = makeQuery(queryText, this.config, at, goalText)
    // 候选池：倒排命中 + 已到期事项 + 钉住的承诺，保证「该想起的不会因为检索没命中而漏掉」。
    const hitIds = new Set(this.store.search(query.tokens).map((hit) => hit.id))
    const cards: MemoryCard[] = []
    for (const id of hitIds) {
      const card = this.store.getCard(id)
      if (card !== undefined && card.status === 'active') cards.push(card)
    }
    const due = pickDue(this.store.listCards({ status: 'active' }), at)
    for (const card of due) {
      if (!hitIds.has(card.id)) cards.push(card)
    }
    // 再补上钉住的卡：承诺与核心事实不能因为检索没命中就消失（FR-C3 的精神）。
    for (const card of this.store.listCards({ status: 'active', pinned: true })) {
      if (!cards.some((c) => c.id === card.id)) cards.push(card)
    }

    const scored = scoreCards(cards.slice(0, this.config.recall.candidateLimit), query, this.config)
    const pack = buildFocusPack(scored, query, this.config)
    const time = this.buildTime(at)
    const text = renderFocusPack(pack, time)

    // 召回后刷新访问计数与强度（记忆因被使用而更牢固）。
    for (const item of pack.cards) {
      this.store.append({
        op: 'touch',
        id: item.card.id,
        at,
        strength: Math.min(1, item.card.strength + this.config.forgetting.accessBoost),
      })
    }

    this.recallCount += 1
    this.log({
      kind: 'recall',
      at,
      summary: `召回 ${pack.cards.length} 条（候选 ${cards.length}，token ${pack.tokens}）`,
      detail: {
        query: queryText,
        candidates: cards.length,
        picked: pack.cards.map((c) => ({ id: c.card.id, total: c.score.total })),
        tokens: pack.tokens,
        empty: pack.empty,
      },
    })
    return { pack, text, time, candidates: cards.length }
  }

  /**
   * 生成时间读数文本（FR-D1 / FR-D2）。
   *
   * @returns 时间读数文本；无相对信息时为空串。
   */
  renderTime(): string {
    return renderTimeContext(this.buildTime(this.clock()))
  }

  /**
   * 执行夜整理（FR-C1 / FR-C4）。
   *
   * @param now - 整理时刻；省略时取当前时钟。
   * @returns 整理报告。
   */
  consolidate(now = this.clock()): ConsolidationReport {
    const state = this.store.snapshot()
    const { report, ops } = runConsolidation(state, this.config, now)
    for (const op of ops) {
      this.store.append(op, undefined, now)
    }
    this.lastConsolidationAt = now
    this.log({
      kind: 'consolidate',
      at: now,
      summary: `整理完成：合并 ${report.merged} 组，归档 ${report.archived} 张`,
      detail: { ...report },
    })
    return report
  }

  /**
   * 取当前时刻（宿主无关，便于上层注入假时钟）。
   *
   * @returns 毫秒时间戳。
   */
  now(): number {
    return this.clock()
  }

  /**
   * 取指定时刻在本引擎时区下的本地日期（`YYYY-MM-DD`）。
   *
   * 夜整理用它判断「今天是否已经整理过」（FR-C1 / 起源 L27 第 4 条）。
   *
   * @param at - 毫秒时间戳。
   * @returns 本地日期字符串。
   */
  localDate(at: number): string {
    return formatLocalDate(at, this.timeZone)
  }

  /**
   * 取「最近一条用户消息」作为召回查询。
   *
   * 为什么需要它：动态上下文的渲染函数在请求装配阶段被调用，此时拿不到
   * 本轮请求文本，只能退回上一次交互的意图——这是最稳的近似（C7 下每轮重算）。
   *
   * @returns 查询文本；库里没有卡时为空串。
   */
  recentQuery(): string {
    let latest: MemoryCard | null = null
    for (const card of this.store.listCards({ status: 'active' })) {
      if (latest === null || card.updatedAt > latest.updatedAt) latest = card
    }
    return latest?.text ?? ''
  }

  /**
   * 从日志重建索引与状态（FR-F4）。
   *
   * 记忆卡是派生视图，日志才是唯一真相源（P2）。索引怀疑不一致时调它。
   *
   * @returns 重建摘要。
   */
  rebuild(): { records: number; active: number; archived: number } {
    this.store.reload()
    return {
      records: this.store.count(),
      active: this.store.count('active'),
      archived: this.store.count('archived'),
    }
  }

  /**
   * 查询卡片（FR-F2）。
   *
   * @param filter - 查询条件。
   * @returns 卡片数组。
   */
  query(filter: Parameters<MemoryStore['listCards']>[0] = {}): MemoryCard[] {
    return this.store.listCards(filter)
  }

  /**
   * 取一张卡的来源与修正历史（FR-A4 / FR-A5）。
   *
   * @param id - 卡片 id。
   * @returns 卡片；不存在时 `undefined`。
   */
  inspect(id: string): MemoryCard | undefined {
    return this.store.getCard(id)
  }

  /**
   * 取一张卡的全部关联边（图谱）。
   *
   * @param id - 卡片 id。
   * @returns 边数组。
   */
  edges(id: string): MemoryEdge[] {
    return this.store.edgesOf(id)
  }

  /**
   * 健康检查（FR-F5）。
   *
   * @returns 健康状态与统计。
   */
  health(): { healthy: boolean; active: number; archived: number; edges: number; indexOk: boolean } {
    const state = this.store.snapshot()
    return {
      healthy: this.store.isIndexHealthy(),
      active: this.store.count('active'),
      archived: this.store.count('archived'),
      edges: state.edges.size,
      indexOk: this.store.isIndexHealthy(),
    }
  }

  /**
   * 构造时间状态。
   *
   * @param at - 当前时刻。
   * @returns 时间状态。
   */
  buildTime(at: number): TimeState {
    return buildTimeState({
      now: at,
      timeZone: this.timeZone,
      lastSessionEndAt: this.lastSessionEndAt,
      lastTurnAt: this.lastTurnAt,
      sessionStartedAt: this.sessionStartedAt,
      due: pickDue(this.store.listCards({ status: 'active' }), at),
    })
  }

  /**
   * 渲染「距上次会话多久」这类相对时间（SC-3）。
   *
   * @returns 人可读文本。
   */
  sinceLastSession(): string {
    const at = this.clock()
    if (this.lastSessionEndAt === null) return '这是第一次会话'
    return `距上次会话 ${formatDuration(Math.max(0, at - this.lastSessionEndAt))}`
  }

  /**
   * 取内部统计（FR-F3）。
   *
   * @returns 指标对象。
   */
  metrics(): { recalls: number; active: number; archived: number; lastConsolidationAt: number | null } {
    return {
      recalls: this.recallCount,
      active: this.store.count('active'),
      archived: this.store.count('archived'),
      lastConsolidationAt: this.lastConsolidationAt,
    }
  }

  /**
   * 探测「上次活动时刻」，用于 `sinceLastSession`。
   *
   * 取库里最新一张卡的 `updatedAt`：这是「上一次跟这个系统打过交道」的最好近似。
   *
   * @returns 毫秒时间戳；空库返回 `null`。
   */
  private detectLastActivity(): number | null {
    let latest: number | null = null
    for (const card of this.store.listCards()) {
      if (latest === null || card.updatedAt > latest) latest = card.updatedAt
    }
    return latest
  }

  /**
   * 记录一条结构化日志（FR-F1）。
   *
   * @param entry - 日志条目。
   */
  private log(entry: MemoryLogEntry): void {
    this.onLog?.(entry)
  }
}
