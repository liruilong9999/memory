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
  buildFocusPack, formatDuration, formatTime, makeQuery, renderFocusPack, scoreCards,
} from '../core/scoring.ts'
import type { RecallQuery } from '../core/scoring.ts'
import type {
  ConsolidationReport, FocusPack, MemoryCard, MemoryEdge, MemoryLogEntry, TimeState,
} from '../core/types.ts'
import { aggregateMetrics } from '../core/metrics.ts'
import { normalizeText } from '../core/text.ts'
import { join } from 'node:path'
import { runConsolidation } from '../consolidate/nightly.ts'
import { readLastConsolidationAt, writeLastConsolidationAt } from '../store/meta.ts'
import type { MemoryStore } from '../store/store.ts'
import {
  buildTimeState, localDate as formatLocalDate, pickDue, renderTimeContext,
} from '../time/clock.ts'
import { DiagnosticLog } from './engine/diagnostics.ts'
import { applyDueSpecs, nextDueAt, renderDueReminderText } from './engine/reminders.ts'
import { markConflicts } from './engine/conflicts.ts'

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

  /** 诊断日志（FR-F1）。落盘路径为 `null` 时只在内存回调里出现。 */
  private readonly diagnostics: DiagnosticLog
  /** 上一轮的时刻，用于计算 `sinceLastTurn`。 */
  private lastTurnAt: number | null = null
  /** 上次会话结束时刻（本次启动时为上次写入的最后时刻）。 */
  private lastSessionEndAt: number | null = null
  /** 本次会话开始时刻。 */
  private readonly sessionStartedAt: number
  /**
   * 上次夜整理时刻。
   *
   * 跨进程持久化在 `dataDir/meta.json`（见 `src/store/meta.ts`）。**不进事件
   * 日志**：它属于系统调度痕迹而非用户行为，写进日志会让重放不再等于
   * 「重放用户历史」，并挤占 `seq`。判据见 `meta.ts` 模块注释。
   *
   * 这里**刻意不写 `= null` 初始化器**：初值必须来自磁盘。保留初始化器会让
   * TS 认为属性已被初始化，从而放过「某条构造路径忘了读盘」这种错误——
   * 那种错误的表现是「重启后立刻重新整理一遍」，幂等、不报错、只是白烧 CPU。
   */
  private lastConsolidationAt: number | null
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
    // FR-F1：诊断日志落盘路径。设空串表示不落盘（用户显式关闭）。
    // 为什么放在 dataDir 下而不是日志目录：记忆库是自包含的，
    // 搬走 dataDir 就等于搬走全部状态，运维不用记两个位置。
    // 必须用 store.dir（已 resolve 成绝对路径）而不是 config.storage.dataDir：
    // 后者可能是相对路径，而相对谁取决于进程 cwd——同一个库在宿主与 CLI 里
    // 会写到两个不同位置，且两边都「成功」，事后无从判断该看哪个。
    this.diagnostics = new DiagnosticLog({
      path:
        options.config.storage.logFile.length === 0
          ? null
          : join(options.store.dir, options.config.storage.logFile),
      maxEntries: options.config.storage.logMaxEntries,
      onLog: options.onLog,
    })
    this.sessionStartedAt = this.clock()
    this.lastSessionEndAt = this.detectLastActivity()
    // 从磁盘恢复：进程重启后不应把「上次整理」忘成 null，否则夜整理每次
    // 重启都重跑一遍（幂等，但白烧全库去重的 CPU）。
    this.lastConsolidationAt = readLastConsolidationAt(this.store.dir)
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
    // 解析细节在 `engine/reminders.ts`，这里只负责触发。
    applyDueSpecs(cards, input.at, this.timeZone, this.config)
    // FR-B5 / SC-4：写入时就标出冲突，而不是等到召回的渲染阶段。
    // 只算不写等于没做——`looksConflicting` 此前零调用点，`conflictOf` 恒为空，
    // 于是真实数据里永远不会出现冲突警告。冲突必须在写入时落到卡上。
    const conflicts = markConflicts(
      cards, this.store.listCards({ status: 'active' }), this.config.dedup.relatedSimilarity, input.at,
    )
    for (const patched of conflicts) this.store.putCard(patched)
    const written: MemoryCard[] = []
    let skipped = 0
    for (const card of cards) {
      const result = this.store.putCard(card)
      if (result.written) written.push(card)
      else skipped += 1
    }
    this.lastTurnAt = input.at
    if (written.length > 0) {
      this.diagnostics.record({
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
    const result = this.buildRecall(at, query)
    this.recallCount += 1
    // 影子模式的观察值必须有人看得到，否则「算完了但不显示」等于没算。
    // 这里只记**真实存在的观察值**：`off` 模式没算、`on` 模式已折进总分，
    // 两种情况下 `shadowSpread` 都是 undefined，日志里就不该出现影子字段
    // ——否则读者会以为当前跑的是 shadow。
    const shadow = result.pack.cards
      .filter((item) => item.shadowSpread !== undefined)
      .map((item) => ({
        id: item.card.id,
        boost: item.shadowSpread!.boost,
        actualRank: item.shadowSpread!.actualRank,
        hypotheticalRank: item.shadowSpread!.hypotheticalRank,
      }))
    this.diagnostics.record({
      kind: 'recall',
      at,
      summary: `召回 ${result.pack.cards.length} 条（候选 ${result.candidates}，token ${result.pack.tokens}）`
        + (shadow.length > 0 ? `，影子模式下 ${shadow.length} 条会被扩散提权（未生效）` : ''),
      detail: {
        query: queryText,
        candidates: result.candidates,
        picked: result.pack.cards.map((c) => ({ id: c.card.id, total: c.score.total })),
        tokens: result.pack.tokens,
        empty: result.pack.empty,
        // FR-F3 的「冲突数」从这里聚合。**必须真的写进日志**：
        // 指标从日志算（重启不清零），日志里没有这个字段就永远算不出 0 以外的值。
        conflicts: result.pack.cards.filter((c) => c.conflict).length,
        // 键名用 `shadow` 而不是 `boost`：这个值没有参与排序，命名必须让它
        // 不可能被误读成已生效。为空时省略，让日志形状反映真实模式。
        ...(shadow.length > 0 ? { shadow } : {}),
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
      this.diagnostics.record({
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

    // 传入全部边：扩散激活（FR-G1）需要看到整个图谱才能沿边传播。
    // `spread.enabled` 为 false 时 `scoreCards` 内部直接返回，行为与不传边完全一致。
    const scored = scoreCards(
      cards.slice(0, this.config.recall.candidateLimit), query, this.config, this.store.allEdges(),
    )
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
    // FR-C1 把「重建索引」列为夜整理最小集的一项，所以这里**真的重建**，
    // 报告里的条数取重建返回的真实统计，而不是把活跃卡数换个名字打印一遍。
    //
    // 为什么由 engine 做而不是 nightly：`runConsolidation` 是纯函数（ST-1），
    // 输入只有 `(state, config, now, timeZone)`，索引不在其中——索引是数据面的
    // 派生视图（FR-A7），nightly 碰不到。纯函数层报 0、调用方回填，
    // 是唯一能同时保住「纯函数无 IO」和「报告不说谎」的写法。
    report.reindexed = this.store.rebuildIndex().cards
    this.lastConsolidationAt = now
    // 落盘失败不应让整理本身失败：整理的操作已经写进日志了（上面那个循环），
    // 这里只是记「什么时候整理的」。让它抛错会把「整理成功」报成失败。
    try {
      writeLastConsolidationAt(this.store.dir, now)
    } catch (error) {
      // 刻意吞掉，但**必须留痕**，且留痕必须是**可见的**。
      //
      // 为什么吞：整理已经写进日志，落盘只影响「下次要不要整理」。抛错会让
      // 上层记一条「整理失败」，运维去查「整理为什么失败」——而真相是整理
      // 成功了，只是没记时间。**报错指向错误的方向，比不报错更费人。**
      //
      // 为什么留痕：吞掉后的表现是「每次重启都重新整理一遍」。它幂等、不丢数据，
      // 所以不值得中断流程；但它**永远不会自己好**（磁盘满、权限错会一直错下去），
      // 唯一症状是白烧 CPU，没人会注意到。
      //
      // 为什么用 kind: 'error'：`LogKind` 里 `error` 是**严重度**而非分类
      // （其余四个是分类），所以持续失败用它不算污染分类；分类信息放
      // `detail.phase`。宿主侧 `src/index.ts` 按 kind 分级，`error` 走
      // `logger.error`，所以这条**真的会出现在日志里**。
      //
      // 不要因为「反正幂等」就把这条删掉——幂等说的是结果正确，
      // 不是说不值得知道。
      this.diagnostics.record({
        kind: 'error',
        at: now,
        summary: `夜整理已完成，但整理时刻落盘失败：${error instanceof Error ? error.message : String(error)}`,
        detail: { phase: 'writeMeta', dir: this.store.dir, error: String(error) },
      })
    }
    this.diagnostics.record({
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
  markReminded(cards: readonly MemoryCard[], now = this.clock()): void {
    for (const card of cards) {
      // dueAt 是可选属性，undefined 与 null 都表示「没有到期时刻」。
      if (typeof card.dueAt !== 'number') continue
      this.remindedDueAt.set(card.id, card.dueAt)
      this.advanceDue(card, now)
    }
  }

  /**
   * 提醒投递成功后，把重复提醒的 `dueAt` 推进到下一次（FR-D3）。
   *
   * ## 为什么必须在**投递之后**推进
   *
   * 推进是一次真实写入。若在投递前推进、投递又失败了，这条提醒就
   * 永远丢了——下次轮询 `dueNow` 看到的是新时刻，还没到。
   * 所以顺序是「先投递成功，再推进」，与 {@link markReminded} 的
   * 调用约定一致。
   *
   * ## 为什么不只依赖内存里的 remindedDueAt
   *
   * `remindedDueAt` 是**内存 Map**，进程重启即清空。只靠它的话：
   * 重启后同一个 `dueAt` 会被当成「没提醒过」再提醒一次（重复打扰）；
   * 而 `dueAt` 永远不推进，跨天之后仍然只有那一个时刻。
   * 把新时刻**落盘**才让「每日提醒」在重启后依然正确。
   *
   * @param card - 刚投递过提醒的卡片。
   * @param now - 投递时刻。
   */
  private advanceDue(card: MemoryCard, now: number): void {
    const next = nextDueAt(card, now, this.timeZone, this.config)
    if (next === null) return
    // 只改 dueAt / updatedAt 之外的到期字段。
    // updatedAt 必须一并更新：它是「这张卡最近变过」的唯一依据，
    // 不改会让 ST-1 之外的地方（最近活动、排序）看到过期信息。
    this.store.putCard({ ...card, dueAt: next, updatedAt: now })
  }

  /**
   * 把到期事项渲染成一段可直接投递给模型的提醒文本（FR-D3）。
   *
   * 措辞细节在 `engine/reminders.ts`——它决定模型会不会把这条消息
   * 误当作用户原话，所以必须能被单独测。
   *
   * @param cards - 已到期的卡片。
   * @param at - 提醒时刻。
   * @returns 提醒文本；`cards` 为空时返回空串。
   */
  renderDueReminder(cards: readonly MemoryCard[], at = this.clock()): string {
    return renderDueReminderText(cards, at, this.timeZone)
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
   * 从归档恢复一张卡（FR-C2 的生产入口）。
   *
   * ## 为什么必须有这个方法
   *
   * 归档是**自动**发生的（`forgetting.autoArchive` 默认 `true`，夜整理每天跑），
   * 而 `state.ts` 的 `restore` 分支早就实现了、测试也绿——但 `src/` 里
   * **没有任何一处构造 `restore` 操作**。也就是说：数据面能力完备，
   * 用户却永远拿不到。FR-C2 整条需求就是为了保证归档**可逆**，
   * 而「自动归档 + 无恢复入口」= 不可逆的数据可见性损失。
   *
   * 这类缺口比「完全没实现」更危险：审计表上它显示「已实现且有测试」，
   * 没人会去看生产路径。判据不是「代码里有」，而是「用户够得到」。
   *
   * @param id - 卡片 id。
   * @param now - 恢复时刻；省略时取当前时钟。
   * @returns 是否真的写了一条恢复记录（卡不存在或本来就是 active 时返回 `false`）。
   */
  restore(id: string, now = this.clock()): boolean {
    const card = this.store.getCard(id)
    // 卡不存在 ⇒ 无事可做。这里**不报错**：id 可能来自旧日志或用户手抄，
    // 抛异常会让一条 CLI 命令因一个字符错就整体失败，而「什么都没恢复」
    // 已经是足够明确的信号。
    if (card === undefined) return false
    // 本来就是 active：不写记录。否则每次调用都会追加一条无意义的
    // `restore`，日志会被「恢复一张没归档的卡」灌满（FR-A3 的日志整洁性）。
    if (card.status === 'active') return false
    const outcome = this.store.append({ op: 'restore', id, at: now }, undefined, now)
    return outcome.written
  }

  /**
   * 修正一张卡的正文，保留旧版本（FR-A5 的生产入口）。
   *
   * 与 {@link restore} 同一类缺口：`state.ts` 的 `revise` 分支把
   * `previousText` / `reason` / `actor` 都存好了，`tests/store/state.test.ts`
   * 也验了累积顺序——但没有任何生产者，于是 `revisions` 数组**恒为空**，
   * 「查看历史」这个功能实际能查到的历史永远是空的。
   *
   * ## `normalized` 必须在这里重算
   *
   * 重放层只按 `op.normalized` 覆盖，它**不会**自己调 `normalizeText`。
   * 若这里直接抄旧值，修正后的卡在检索时仍按旧文本匹配——
   * 用户改了正文却发现搜不到新词，且没有任何报错。
   *
   * @param id - 卡片 id。
   * @param text - 新正文（非空）。
   * @param reason - 修正原因，写进 `revisions` 供日后审计。
   * @param now - 修正时刻；省略时取当前时钟。
   * @returns 是否真的写了一条修正记录。
   */
  revise(id: string, text: string, reason: string, now = this.clock()): boolean {
    const card = this.store.getCard(id)
    if (card === undefined) return false
    const next = text.trim()
    // 空正文会把卡变成「存在但不可读」——那种状态比删掉更糟：它仍占着
    // 焦点包名额、仍能被召回，却什么都不说。宁可拒绝也不写。
    if (next.length === 0) return false
    // 正文没变：不写记录。否则「保存」按钮每按一次就多一条 revisions，
    // 而 FR-A5 要回答的是「改过什么」，不是「按过几次保存」。
    if (next === card.text) return false
    const outcome = this.store.append(
      {
        op: 'revise',
        id,
        text: next,
        normalized: normalizeText(next),
        reason,
        at: now,
        // actor 固定 `manual`：能调用到这个方法的只有用户主动操作
        // （CLI 子命令 / 会话命令）。若将来出现「系统自动改写」的调用方，
        // 必须给它另一条入口，而不是复用这里——否则 revisions 里的
        // 「谁改的」会变成一句假话。
        actor: 'manual',
      },
      undefined,
      now,
    )
    return outcome.written
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
   * 汇总指标（FR-F3）。
   *
   * ## 为什么分成两半
   *
   * FR-F3 要的五个指标里，`库大小` 能当场从 store 数出来，但
   * `召回次数 / 命中率 / 冲突数 / 注入 token` 都是**累计量**——
   * 用 `this.recallCount` 这类进程内计数器只能给出「本次运行以来」，
   * 重启就归零，而 FR-F3 还要求「有最小周报」，周报天然跨进程、跨天。
   *
   * 所以：累计量从**已落盘的诊断日志**聚合（`aggregateMetrics`），
   * 库大小当场数，并用 `source` 标出这次读的是哪个来源——
   * 两个来源口径不同，混成一个字段会让周报在重启后莫名变 0。
   *
   * @returns 五个指标 + 归档数 + 上次整理时刻 + 数据来源。
   */
  metrics(): {
    recalls: number
    hitRate: number
    conflicts: number
    active: number
    injectTokens: number
    archived: number
    lastConsolidationAt: number | null
    source: 'log' | 'memory'
  } {
    // 读**自己刚写的那个文件**，而不是另起一个计数器。
    // 两个来源（内存计数器 + 磁盘日志）必然漂移，而指标恰恰是用来
    // 判断「系统在做什么」的——一个会漂移的观测点比没有观测点更危险。
    const entries = this.diagnostics.read()
    if (entries !== null) {
      const aggregated = aggregateMetrics(entries, this.store.count('active'))
      return {
        ...aggregated,
        archived: this.store.count('archived'),
        lastConsolidationAt: this.lastConsolidationAt,
        source: 'log',
      }
    }
    // 落盘关闭时只能退回进程内计数，但**必须标出来**：
    // 这种情况下 `recalls` 是「本次运行以来」，重启归零，
    // 与 `source: 'log'` 的「累计」不是同一个量。
    return {
      recalls: this.recallCount,
      hitRate: 0,
      conflicts: 0,
      active: this.store.count('active'),
      injectTokens: 0,
      archived: this.store.count('archived'),
      lastConsolidationAt: this.lastConsolidationAt,
      source: 'memory',
    }
  }

  /**
   * 取上次整理时刻（供 `src/index.ts` 的定时器判断「今天是否已整理」）。
   *
   * 与 `metrics().lastConsolidationAt` 的区别：`metrics()` 是给人看的汇总，
   * 这个是给调度逻辑用的单一值。分成两个入口是因为**用途不同**——将来
   * `metrics()` 加字段时，不该让调度逻辑跟着改。
   *
   * @returns 毫秒时间戳；从未整理过为 `null`。
   */
  lastConsolidatedAt(): number | null {
    return this.lastConsolidationAt
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

}
