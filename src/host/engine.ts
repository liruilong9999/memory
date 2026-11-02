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
import { extractMemoryCards, looksConflicting } from '../core/extraction.ts'
import type { TurnInput } from '../core/extraction.ts'
import {
  buildFocusPack, formatDuration, formatTime, makeQuery, renderFocusPack, scoreCards,
} from '../core/scoring.ts'
import type { RecallQuery } from '../core/scoring.ts'
import type {
  ConsolidationReport, FocusPack, MemoryCard, MemoryEdge, MemoryLogEntry, TimeState,
} from '../core/types.ts'
import { cardSimilarity } from '../consolidate/dedupe.ts'
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
   * 已提醒过的到期时刻：`cardId → dueAt`。
   *
   * 记住「到期时刻」而不是「提醒过」这个布尔值，是因为每日/每周提醒的
   * `dueAt` 会推进；只有推进到新时刻才应该再唤醒一次（FR-D3）。
   */
  private readonly remindedDueAt = new Map<string, number>()

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
    // FR-B5 / SC-4：写入时就标出冲突，而不是等到召回的渲染阶段。
    // 只算不写等于没做——`looksConflicting` 此前零调用点，`conflictOf` 恒为空，
    // 于是真实数据里永远不会出现冲突警告。冲突必须在写入时落到卡上。
    const conflicts = this.markConflicts(cards, input.at)
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
   * 给新写入的卡片标出与既有记忆的冲突（FR-B5 / SC-4 / 起源 L19「感受经验」）。
   *
   * 冲突判定：共享实体（在谈同一个对象）+ 文本相似度低（说法明显不同）
   * 就说明两句话对同一件事给出了不同说法，需要并列展示而不是悄悄合并。
   *
   * 两个方向都要标：既有卡是已落盘的不可变对象，所以这里返回需要**回写**的
   * 既有卡（带新 `conflictOf`），由调用方落库；新卡则原地标。
   *
   * @param cards - 本轮新抽取的卡片（会被原地修改）。
   * @param at - 写入时刻。
   * @returns 需要回写的既有卡片（`conflictOf` 已更新）。
   */
  private markConflicts(cards: MemoryCard[], at: number): MemoryCard[] {
    const updated: MemoryCard[] = []
    if (cards.length === 0) return updated
    const related = this.config.dedup.relatedSimilarity
    const existing = this.store.listCards({ status: 'active' })
    for (const card of cards) {
      for (const other of existing) {
        if (other.id === card.id) continue
        const similarity = cardSimilarity(card, other)
        if (!looksConflicting(card, other, similarity, related)) continue
        if (!card.conflictOf.includes(other.id)) card.conflictOf.push(other.id)
        if (!other.conflictOf.includes(card.id)) {
          // 既有卡是不可变对象，复制一份再改，避免就地修改已落盘状态。
          const patched: MemoryCard = {
            ...other,
            conflictOf: [...other.conflictOf, card.id],
            updatedAt: at,
          }
          updated.push(patched)
        }
      }
    }
    for (const patched of updated) this.store.putCard(patched)
    return updated
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
    const result = this.buildRecall(at, query)
    this.recallCount += 1
    this.log({
      kind: 'recall',
      at,
      summary: `召回 ${result.pack.cards.length} 条（候选 ${result.candidates}，token ${result.pack.tokens}）`,
      detail: {
        query: queryText,
        candidates: result.candidates,
        picked: result.pack.cards.map((c) => ({ id: c.card.id, total: c.score.total })),
        tokens: result.pack.tokens,
        empty: result.pack.empty,
      },
    })
    return result
  }

  /**
   * 纯查询式召回：只读，不改任何记忆状态。
   *
   * 与 `recall` 的区别只有一处——**不写库、不计指标、不写日志**。
   * 存在的理由是 CLI 的 `query` 与宿主的 `/memory explain` 都需要「看一眼」，
   * 而「看一眼」不能算「用过」（起源 L29·第 5 条·专注当前位置）。
   *
   * @param queryText - 查询文本。
   * @param goalText - 当前目标文本，可选。
   * @param at - 查询时刻；省略时取当前时钟。
   * @returns 召回结果。
   */
  peek(queryText: string, goalText = '', at = this.clock()): RecallResult {
    return this.buildRecall(at, makeQuery(queryText, this.config, at, goalText))
  }

  /**
   * 确认「这些记忆被真正用上了」，这是**唯一**会加深记忆强度的入口。
   *
   * 为什么必须与召回分开（起源 L29·第 5 条·专注当前位置）：
   * 「被召回」只是**看见**——系统觉得这条可能与当前话题相关，于是摆到台面上；
   * 「被使用」才是**参与**——模型真的拿它做了判断或回答。二者混为一谈会造成
   * 马太效应：一次偶然召回让这张卡强度上升，下次更容易被召回，再上升……
   * 结果是强者恒强、库里绝大多数卡永远沉底，与起源 L29 要求的
   * 「不代入其它记忆、专注当前位置」正好相反——它把历史噪音越推越前。
   *
   * 现在的语义：
   * - `recall` / `peek`：**只读**，强度、访问计数一律不动（可重复调用，ST-1）。
   * - `confirmRecall`：显式确认，写 `touch` 日志，强度与访问计数上升。
   *
   * 只有确认才加分，且加成来自配置（`forgetting.accessBoost`），不写死。
   *
   * ## 当前无调用方：这是**机制预留**，不是已完成的功能
   *
   * 截至本次改动，`src/` 下没有任何地方调用 `confirmRecall`。实际运行行为是：
   * 召回永不加深记忆，`accessCount` 恒不增长，`importanceScore` 里的访问频次项
   * 恒为 0。也就是说正反馈**已被堵死，但新入口尚未接上**。
   *
   * 为什么先不接（三种候选路径及否决理由）：
   * 1. **给模型一个 tool 让它自报**（如 `memory_confirm`）：模型可能乱调，
   *    而且「我用了这条」的自我报告本身不可靠——它会倾向于把所有注入内容
   *    都报成用过，等于把马太效应从系统侧搬到了模型侧。
   * 2. **宿主侧文本匹配**：注入后看模型输出是否引用了某张卡。这是启发式，
   *    命中判据无法稳定定义（改写、同义、间接引用算不算？），
   *    误判会让错误的正反馈重新出现，且事后无从审计。
   * 3. **暂时不接**（当前选择）：承认调用时机取决于宿主的注入语义，
   *    而那个语义现在还没定。宁可不动，也不要错误地动。
   *
   * 接入前必须清楚：**「正反馈已生效」目前是假的**。这与 `restore` / `revise`
   * 无生产者是同一类问题——机制在、路径缺，不能让它悄悄躺着。
   * 未来接入时，唯一硬约束是：确认信号必须来自「这条记忆真的影响了输出」
   * 的**可审计证据**，而不是「这条记忆被展示过」。
   *
   * @param cardIds - 被确认使用的卡片 id 列表；空列表为无操作。
   * @param now - 确认时刻；省略时取当前时钟。
   * @returns 实际写下的确认条数（重复 id 会去重）。
   */
  confirmRecall(cardIds: readonly string[], now = this.clock()): number {
    const boost = this.config.forgetting.accessBoost
    let written = 0
    const seen = new Set<string>()
    for (const id of cardIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const card = this.store.getCard(id)
      // 不存在或已归档的卡不确认：给归档卡加强度等于让遗忘失效（FR-C2）。
      if (card === undefined || card.status !== 'active') continue
      this.store.append({
        op: 'touch',
        id: card.id,
        at: now,
        strength: Math.min(1, card.strength + boost),
      }, undefined, now)
      written += 1
    }
    if (written > 0) {
      this.log({
        kind: 'recall',
        at: now,
        summary: `确认使用 ${written} 条记忆（强度 +${boost}）`,
        detail: { confirmed: written, ids: [...seen] },
      })
    }
    return written
  }

  /**
   * 召回流水线的纯计算部分：候选池 → 打分 → 阈值 → 装包 → 渲染。
   *
   * 抽出来是为了让「看见」与「使用」共享同一套候选与打分规则——
   * 两边规则一旦分叉，`peek` 看到的就不是 `recall` 会给出的东西。
   * 本方法**不写库、不写日志、不改计数器**，因此天然满足 ST-1。
   *
   * @param queryText - 查询文本（仅用于回填焦点包）。
   * @param at - 查询时刻。
   * @param query - 已构造的查询上下文。
   * @returns 召回结果。
   */
  private buildRecall(at: number, query: RecallQuery): RecallResult {
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

    // 这里**刻意不写 touch**：召回只是「看见」，不是「使用」（起源 L29·第 5 条·专注当前位置）。
    // 加深强度只发生在 confirmRecall 里，且必须由调用方显式确认。
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
    // `timeZone` 必须显式传入：自然日边界由时区定义（FR-D4），东八区的「今天」
    // 与 UTC 的「今天」差 8 小时。给个 `'UTC'` 默认值就是给静默错误发通行证。
    const { report, ops } = runConsolidation(state, this.config, now, this.timeZone)
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
   * 取此刻已到期、但尚未提醒过的记忆卡（FR-D3 / SC-5 / 起源 L21）。
   *
   * 「到点无需用户输入自行接力」是 FR-D3 的验收原文：
   * 光把到期时刻渲染进时间读数不够——那只在用户恰好开口时才可见。
   * 必须有一个主动轮询者（宿主定时器）在到点时来问「有什么到期了」，
   * 再据此唤醒模型。
   *
   * 为什么要「尚未提醒过」：同一个提醒不能每次轮询都唤醒一次，
   * 否则会变成刷屏。已提醒的卡记在 {@link remindedDueAt} 里，
   * 只在到期时刻发生变化（例如每日/每周重复推进）时才会再次触发。
   *
   * @param at - 检查时刻；省略时取当前时钟。
   * @returns 需要提醒的卡片，按到期时刻升序。
   */
  dueNow(at = this.clock()): MemoryCard[] {
    const due = pickDue(this.store.listCards({ status: 'active' }), at)
    return due.filter((card) => this.remindedDueAt.get(card.id) !== card.dueAt)
  }

  /**
   * 标记这些卡「已经提醒过」，避免同一到期被重复唤醒。
   *
   * 与 {@link dueNow} 配对使用：调用方拿到要提醒的卡、成功投递之后再调本方法。
   * 先投递后标记的顺序很重要——投递失败时不应吞掉提醒。
   *
   * @param cards - 已提醒的卡片。
   */
  markReminded(cards: readonly MemoryCard[]): void {
    for (const card of cards) {
      // dueAt 是可选属性，undefined 与 null 都表示「没有到期时刻」。
      if (typeof card.dueAt === 'number') this.remindedDueAt.set(card.id, card.dueAt)
    }
  }

  /**
   * 把到期事项渲染成一段可直接投递给模型的提醒文本（FR-D3）。
   *
   * 措辞刻意包含「无需用户输入」的说明，因为这句话会作为一条新的用户消息
   * 进入对话，模型需要知道它来自系统而不是人。
   *
   * @param cards - 已到期的卡片。
   * @param at - 提醒时刻。
   * @returns 提醒文本；`cards` 为空时返回空串。
   */
  renderDueReminder(cards: readonly MemoryCard[], at = this.clock()): string {
    if (cards.length === 0) return ''
    const lines: string[] = []
    lines.push('## 到期提醒（由记忆系统定时投递，不是用户输入）')
    lines.push(`当前时间：${formatTime(at, this.timeZone)}`)
    lines.push('')
    for (const card of cards) {
      lines.push(`- ${card.text}`)
    }
    lines.push('')
    lines.push('这些事项的约定时间已到，请主动提醒用户或继续推进；不需要等待用户再次开口。')
    return lines.join('\n')
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
