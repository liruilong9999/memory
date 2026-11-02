/**
 * 插件入口：把记忆系统接到 DSH 宿主上。
 *
 * 设计依据：
 * - C4 / FR-E2：注入通道只走 `systemPrompt.context()`，绝不用 `section()`。
 * - C5：不注册任何自定义 session 事件类型，记忆状态只进本地日志。
 * - C7：动态上下文用 `text: () => string`，每轮重新求值，压缩后自动重新物化。
 * - C8：宿主是预览版，本文件只通过 {@link HostContext} 的窄接口访问宿主，
 *   能力缺失时降级运行而不是崩溃。
 * - NFR-7：换宿主只改 `src/host/adapter.ts` 与本文件，数据面/巩固面原地不动。
 *
 * 对应起源：
 * - 第 4 条「今日渐进累积、夜晚休眠整理」→ `agent/turn-stopping` 写卡 + 定时夜整理。
 * - 第 7 条「上下文是瞬时大脑信号状态」→ 焦点包每轮现算，不做常驻记忆块。
 * - 第 8 条「有限上下文衍生智能」→ 只注入 3~7 张卡，不是把库倒进上下文。
 *
 * @module dsh-memory
 */

import type { MemoryConfig } from './core/config.ts'
import { DEFAULT_CONFIG } from './core/config.ts'
import type { TurnInput } from './core/extraction.ts'
import type { MemoryDomain } from './core/types.ts'
import {
  createLogger, probeCapabilities, readGoalText, registerCommand, registerDynamicContext,
  resolveConfig, resolveTimeZone, setRepeating, subscribe,
} from './host/adapter.ts'
import type { HostContext, Logger } from './host/adapter.ts'
import { MemoryEngine } from './host/engine.ts'
import { openStore } from './store/store.ts'
import type { MemoryStore } from './store/store.ts'
import { shouldRunDaily } from './time/clock.ts'

/**
 * 插件配置。
 *
 * 与 {@link MemoryConfig} 同构：宿主 patch 里写的字段会深合并到默认值之上，
 * 所以用户只写 `dataDir` 不会把其余默认值清空。
 */
export type Config = MemoryConfig

/**
 * 动态上下文在系统提示词里的排序值。
 *
 * 取 300 而不是 130：宿主 `CONTEXT_ORDERS`（`packages/core/system-prompt/src/index.ts:177`）
 * 实际是 100 工作目录 / 110 沙箱 / 115 审批 / 120 子代理 / 125 团队身份 /
 * 200 宿主源码路径 / 210 Web 表面。130 会**夹在团队身份与宿主源码之间**，
 * 既不靠前也不靠后；而宿主注释明确说 200 之后是「进程相关路径与端点，
 * 不进缓存系统提示词」（同文件 :182），所以排在 200 之后才落在动态尾部。
 * 记忆每轮都在变，放在缓存区里会不断打断前缀缓存。
 */
const CONTEXT_ORDER = 300

/** 夜整理巡检周期：每小时看一次「今天该不该整理」。 */
const CONSOLIDATION_POLL_MS = 60 * 60 * 1000

/** 注册名：动态上下文。 */
const CONTEXT_NAME = 'memory:focus-pack'

/** 换行符：消息片段之间用换行拼接。 */
const NL = String.fromCharCode(10)

/** 插件名，宿主日志与 loader 诊断用。 */
export const name = 'memory'

/**
 * 可唤醒的 agent：只声明我们真正用到的两个成员。
 *
 * 刻意不 import 宿主的 `Agent` 类型（见 `src/host/adapter.ts` 的说明）：
 * 结构探测让离线单测能传假 agent，宿主升级也不会让编译期崩掉（C8）。
 */
interface WakeableAgent {
  /** 队列一条后续消息并唤醒驱动器。 */
  followup: (message: unknown) => void
}

/**
 * 判断一个宿主对象是否可唤醒。
 *
 * @param agent - 候选对象。
 * @returns 具有 `followup` 函数时为 `true`。
 */
function isWakeable(agent: unknown): agent is WakeableAgent {
  if (typeof agent !== 'object' || agent === null) return false
  return typeof (agent as { followup?: unknown }).followup === 'function'
}

/**
 * 构造一条可投递给 `followup` 的用户消息。
 *
 * 宿主侧的 `UserMessage` 要求 `{ content: [{type:'text', text}], source:{kind:'user'} }`。
 * 我们在这里手工拼形状而不调 `createUserMessage`：那会把 `@deepseek-ai/*`
 * 变成运行时依赖，违背适配面「零宿主依赖」的设计。
 *
 * @param text - 消息正文。
 * @returns 宿主可接受的消息对象。
 */
function makeWakeMessage(text: string): unknown {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 宿主侧接线状态。
 *
 * 单独抽成对象，是为了让 `apply` 保持线性可读，并让卸载路径能一次性清理。
 */
interface Wiring {
  /** 数据面。 */
  store: MemoryStore
  /** 记忆引擎。 */
  engine: MemoryEngine
  /** 日志器。 */
  logger: Logger
  /** 停止定时器。 */
  disposeTimer: () => void
}

/**
 * 一轮对话的文本累积器。
 *
 * 为什么用「累积」而不是「回扫会话事件」：
 * 宿主把 `Session.eventAt()` / `snapshotEvents()` / `ownEvents()` 三个同步读历史
 * 的方法全部标了 `@deprecated`，迁移说明写得很明确——
 * 「Existing logic may remain unmigrated for now, but **new calls are prohibited**」。
 * 我们这是新代码，回扫历史属于明令禁止的用法。
 *
 * 正确姿势是订阅 `session/event`（post-commit、fire-and-forget、监听器异常被兜住），
 * 在事件到达时把消息文本增量记下来；`agent/turn-stopping` 时直接读累积结果。
 * 这样既不依赖「完整历史常驻内存」这个即将消失的前提，也天然满足 P2（会话日志是真相源）。
 */
interface TurnBuffer {
  /** 本轮用户消息片段，按到达顺序。 */
  user: string[]
  /** 本轮助手消息片段，按到达顺序。 */
  assistant: string[]
  /** 本轮的轮次号；未知时为 `null`。 */
  turn: number | null
}

/** 每个会话的累积器：`sessionId → 当前轮缓冲`。 */
type TurnBuffers = Map<string, TurnBuffer>

/**
 * 读本轮已累积的用户与助手文本。
 *
 * @param buffers - 各会话的累积器。
 * @param sessionId - 会话 id。
 * @returns 用户与助手文本；没有累积到内容时都为空串。
 */
function readTurnText(buffers: TurnBuffers, sessionId: string): { userText: string; assistantText: string } {
  const buffer = buffers.get(sessionId)
  if (buffer === undefined) return { userText: '', assistantText: '' }
  return {
    userText: buffer.user.join(NL),
    assistantText: buffer.assistant.join(NL),
  }
}

/**
 * 把一条 `session/event` 归并进累积器。
 *
 * 只关心三类事件：
 * - `turn/start`：开新轮，清空缓冲（上一轮已经处理过）。
 * - `user/message`：追加用户文本。
 * - `assistant/message`：追加助手文本。
 *
 * @param buffers - 各会话的累积器。
 * @param sessionId - 会话 id。
 * @param event - 会话事件。
 */
function accumulateEvent(buffers: TurnBuffers, sessionId: string, event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const record = event as { type?: unknown; data?: unknown }
  const type = record.type
  if (type === 'turn/start') {
    const data = record.data as { turn?: unknown } | undefined
    const turn = typeof data?.turn === 'number' ? data.turn : null
    buffers.set(sessionId, { user: [], assistant: [], turn })
    return
  }
  if (type !== 'user/message' && type !== 'assistant/message') return
  const text = messageText(record.data)
  if (text.length === 0) return
  let buffer = buffers.get(sessionId)
  if (buffer === undefined) {
    buffer = { user: [], assistant: [], turn: null }
    buffers.set(sessionId, buffer)
  }
  if (type === 'user/message') buffer.user.push(text)
  else buffer.assistant.push(text)
}
/**
 * 从消息对象里抽纯文本。
 *
 * 宿主消息是 `content: ContentBlock[]`，这里只认文本块，其它块（图片/文件）忽略：
 * 记忆卡只存文本摘要，二进制内容没有语义价值（且会撑爆日志）。
 *
 * 两种载荷形状都要认（见 `packages/core/session/src/types.ts`）：
 * - `user/message` 的 data **就是** `UserMessage`，`content` 在顶层；
 * - `assistant/message` 的 data 是 `{ turn, step, message, stream, usage }`，
 *   `content` 在 `message.content` 里。
 *
 * @param data - 消息事件数据。
 * @returns 拼接后的文本；无法解析时为空串。
 */
function messageText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as { content?: unknown; message?: unknown }
  // assistant/message 把真正的消息包在 message 字段里，先剥一层。
  const inner =
    record.content === undefined && typeof record.message === 'object' && record.message !== null
      ? record.message
      : record
  const content = (inner as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join(NL)
}

/**
 * 从 agent 对象里取会话 id。
 *
 * @param agent - 宿主 agent。
 * @returns 会话 id；取不到时用固定占位，保证来源指针字段非空。
 */
function sessionIdOf(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return 'unknown-session'
  const session = (agent as { session?: { id?: unknown } }).session
  const id = session?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown-session'
}

/**
 * 判断当前记忆域。
 *
 * v0.2 只启用「工作」域（需求规格 v0.2 收敛范围）；
 * 生活/学习域是配置里预留的可插拔位，由 `config.extraction.domains` 决定。
 *
 * @param config - 记忆配置。
 * @returns 记忆域。
 */
function pickDomain(config: MemoryConfig): MemoryDomain {
  return config.extraction.domains[0] ?? 'work'
}

/** 渲染函数的两个取值依赖，抽成参数是为了让测试注入固定值。 */
interface FocusPackSources {
  /** 取本轮召回查询文本（用户此刻在说什么）。 */
  queryText: () => string
  /** 取当前目标文本（agent 此刻在做什么）；没有目标时返回空串。 */
  goalText: () => string
}

/**
 * 组装焦点包渲染函数。
 *
 * 这个函数每轮被宿主调用一次（C7：`text` 传函数，压缩后自动重新物化）。
 * 它必须**快且不抛**：慢会拖慢整个请求，抛会让宿主循环出问题。
 *
 * 查询文本的来源演进（这是一处实打实的正确性修复）：
 * 旧实现用 `engine.recentQuery()`，即「库里最新一张卡片的文本」。那等于
 * **拿上一次写入的记忆碎片去查询记忆库**，而不是拿用户此刻说的话——问题是
 * 上一轮写入的往往是抽取后的要点（「用户偏好 PostgreSQL」），与用户本轮
 * 的原话（「这个 JSONB 字段怎么建索引」）语义差异很大，召回自然不准。
 * 现在改用本轮的 `user/message` 原文（由 `session/event` 累积），
 * 拿不到时才退回 `recentQuery()`（例如新会话第一轮之前）。
 *
 * @param engine - 记忆引擎。
 * @param sources - 查询文本与目标文本的来源。
 * @returns 渲染函数。
 */
function makeFocusPackRenderer(engine: MemoryEngine, sources: FocusPackSources): () => string {
  return (): string => {
    const queryText = sources.queryText()
    const goalText = sources.goalText()
    // 查询文本为空（新会话、尚无用户消息）时用最近记忆兜底，避免空查询命中一切。
    const effectiveQuery = queryText.length > 0 ? queryText : engine.recentQuery()
    const result = engine.recall(effectiveQuery, goalText)
    const blocks: string[] = []
    const time = engine.renderTime()
    if (time.length > 0) blocks.push(time)
    if (result.text.length > 0) blocks.push(result.text)
    return blocks.join('\n\n')
  }
}

/**
 * 把记忆系统挂到宿主上。
 *
 * @param ctx - 宿主上下文（Cordis Context 的结构化子集）。
 * @param rawConfig - 宿主传入的原始配置。
 */
export async function apply(ctx: HostContext, rawConfig: unknown): Promise<void> {
  const config = resolveConfig(rawConfig ?? {})
  const logger = createLogger(ctx)
  const capabilities = probeCapabilities(ctx)
  if (capabilities.missing.length > 0) {
    // 缺能力不是错误：降级运行并明确告知（C8）。
    logger.warn(`宿主缺少能力：${capabilities.missing.join('、')}，相关功能降级`)
  }

  const store = openStore({ config })
  // 时钟注入：`_clock` 是内部测试通道（下划线前缀表示非公开配置）。
  // 生产环境不传，退回 `Date.now()`；测试靠它把时钟推到「明天下午三点」。
  const rawClock = (rawConfig as { _clock?: unknown } | undefined)?._clock
  const clock = typeof rawClock === 'function' ? (rawClock as () => number) : undefined
  const engine = new MemoryEngine({
    store,
    config,
    timeZone: resolveTimeZone(),
    clock,
    onLog: (entry) => logger.debug(`${entry.kind} ${entry.summary}`),
  })

  const wiring: Wiring = {
    store,
    engine,
    logger,
    disposeTimer: () => {
      /* 由下面的定时器注册覆盖 */
    },
  }

  // ---- 会话事件累积（P2：会话日志是唯一真相源）----
  // 不用 Session.eventAt() 回扫：宿主已把它标为 @deprecated 且禁止新调用。
  // 改成订阅 session/event（post-commit、fire-and-forget），增量累积本轮文本。
  //
  // 注意：这个订阅必须**早于**注入通道注册。因为渲染函数每轮被调用时需要
  // 读 turnBuffers 拿本轮用户原话，若订阅在注册之后建立，首轮渲染读不到内容。
  const turnBuffers: TurnBuffers = new Map()
  /**
   * 最近一个可唤醒的 agent。
   *
   * 两个用途：到期提醒靠它主动接力（FR-D3 / 起源 L21），召回靠它读当前目标
   * （FR-B1，`goalScore` 的唯一来源）。用 `undefined` 而不是 `null`：
   * `isWakeable` 是类型守卫，收窄后能直接调用，不必每次再判 null。
   */
  let lastAgent: WakeableAgent | undefined
  /** 最近一次活跃的会话 id；用于从 turnBuffers 取本轮文本。 */
  let lastSessionId = ''

  // ---- 注入通道（FR-E2 / C4 / C7）----
  const injected = registerDynamicContext(
    ctx, CONTEXT_NAME, CONTEXT_ORDER, makeFocusPackRenderer(engine, {
      // 本轮用户原话优先；拿不到（新会话、首轮之前）返回空串由渲染器兜底。
      queryText: () => readTurnText(turnBuffers, lastSessionId).userText,
      // 目标文本来自宿主的 goal 服务；没有目标时为空串，scoreCards 会跳过该维度。
      goalText: () => readGoalText(ctx, lastAgent),
    }),
  )
  if (!injected) logger.warn('无法注册动态上下文，记忆不会被注入到系统提示词')

  const sessionEvents = subscribe(ctx, 'session/event', (...args: unknown[]) => {
    const session = args[0] as { id?: unknown } | undefined
    const sessionId = typeof session?.id === 'string' ? session.id : ''
    if (sessionId.length === 0) return
    lastSessionId = sessionId
    accumulateEvent(turnBuffers, sessionId, args[1])
  })
  if (!sessionEvents) logger.warn('无法订阅 session/event，记忆不会被写入')

  // ---- 写路径（FR-A1 / 起源 L27 第 4 条「今日记忆渐进累积」）----
  const turnStopping = subscribe(ctx, 'agent/turn-stopping', (...args: unknown[]) => {
    const payload = args[0] as { agent?: unknown; turn?: unknown } | undefined
    const turn = typeof payload?.turn === 'number' ? payload.turn : 0
    // 记住这个 agent：到期提醒需要靠它主动唤醒（FR-D3「到点无需用户输入自行接力」）。
    if (isWakeable(payload?.agent)) lastAgent = payload.agent
    const sessionId = sessionIdOf(payload?.agent)
    const { userText, assistantText } = readTurnText(turnBuffers, sessionId)
    if (userText.length === 0) return
    const input: TurnInput = {
      sessionId,
      turn,
      step: 0,
      seq: 0,
      userText,
      assistantText,
      domain: pickDomain(config),
      at: engine.now(),
    }
    try {
      engine.writeTurn(input)
    } catch (error) {
      // 写记忆失败不能影响用户回复：记一条日志然后放行。
      logger.error(`写入记忆失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 本轮已处理完，清空缓冲避免下一轮重复写入（turn/start 也会清，双保险）。
    turnBuffers.delete(sessionId)
  })
  if (!turnStopping) logger.warn('无法订阅 agent/turn-stopping，记忆不会被写入')

  // ---- 夜整理（FR-C1 / 起源 L27 第 4 条「夜晚休眠整理」）----
  const timers: Array<() => void> = []
  wiring.disposeTimer = () => {
    for (const dispose of timers) {
      try {
        dispose()
      } catch {
        // 卸载时单个定时器清理失败不应阻断其余清理。
      }
    }
    timers.length = 0
  }
  if (config.consolidation.enabled) {
    let lastRunAt: number | null = null
    const timeZone = resolveTimeZone()
    timers.push(setRepeating(ctx, () => {
      const now = engine.now()
      if (!shouldRunDaily(lastRunAt, now, timeZone, config.consolidation.dailyAt)) return
      try {
        const report = engine.consolidate(now)
        lastRunAt = now
        logger.info(`夜整理完成：合并 ${report.merged} 组，归档 ${report.archived} 张`)
      } catch (error) {
        logger.error(`夜整理失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }, CONSOLIDATION_POLL_MS))
  }

  // ---- 到期提醒（FR-D3 / SC-5 / 起源 L21「定闹钟」）----
  // 「到点无需用户输入自行接力」的验收要求：必须有一个主动轮询者。
  // 只把到期事项渲染进时间读数是不够的——那只在用户恰好开口时才可见。
  if (config.reminder.enabled) {
    timers.push(setRepeating(ctx, () => {
      const now = engine.now()
      let cards
      try {
        cards = engine.dueNow(now)
      } catch (error) {
        logger.error(`检查到期事项失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (cards.length === 0) return
      if (lastAgent === undefined) {
        // 还没有可唤醒的 agent：保留提醒，等下一次轮询再试。
        // 不能在这里 markReminded，否则这次提醒就永远丢了。
        logger.debug(`有 ${cards.length} 项到期，但当前没有可唤醒的会话`)
        return
      }
      const text = engine.renderDueReminder(cards, now)
      if (text.length === 0) return
      try {
        lastAgent.followup(makeWakeMessage(text))
        // 投递成功后才标记，失败时下次轮询还能重试。
        engine.markReminded(cards)
        logger.info(`到期提醒已投递：${cards.length} 项`)
      } catch (error) {
        logger.error(`投递到期提醒失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }, config.reminder.pollMs))
  }

  // ---- 用户命令（FR-F2）----
  const commandRegistered = registerCommand(
    ctx, 'memory', '查看记忆系统状态（status / health / rebuild）',
    (args: string) => runMemoryCommand(engine, args),
  )
  if (!commandRegistered) logger.debug('宿主不支持命令注册，跳过 /memory')

  // ---- 卸载清理 ----
  const shutdown = (): void => {
    wiring.disposeTimer()
    try {
      store.close()
    } catch (error) {
      logger.error(`关闭数据面失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(shutdown)

  logger.info(`记忆系统就绪：活跃 ${store.count('active')} 张，数据目录 ${config.storage.dataDir}`)
}

/**
 * `/memory` 命令实现。
 *
 * 只读为主：命令是给人看的，不应该顺带改变记忆状态。
 * 唯一例外是 `rebuild`（FR-F4 重建），它是显式请求的运维动作。
 *
 * @param engine - 记忆引擎。
 * @param args - 命令参数。
 * @returns 命令结果文本。
 */
export function runMemoryCommand(engine: MemoryEngine, args: string): string {
  const trimmed = args.trim()
  const command = trimmed.length === 0 ? 'status' : (trimmed.split(/\s+/u)[0] ?? 'status')
  if (command === 'health') {
    const health = engine.health()
    const lines = [
      `健康：${health.healthy ? '正常' : '异常'}`,
      `活跃：${health.active} 张`,
      `归档：${health.archived} 张`,
      `图谱边：${health.edges} 条`,
      `索引：${health.indexOk ? '一致' : '不一致'}`,
    ]
    return lines.join('\n')
  }
  if (command === 'rebuild') {
    const report = engine.rebuild()
    return `索引已重建：扫描 ${report.records} 条日志记录，活跃 ${report.active} 张`
  }
  if (command === 'status') {
    const metrics = engine.metrics()
    const health = engine.health()
    return [
      `活跃 ${health.active} 张 / 归档 ${health.archived} 张`,
      `图谱边 ${health.edges} 条`,
      `本次会话召回 ${metrics.recalls} 次`,
      `上次整理：${metrics.lastConsolidationAt === null ? '从未' : new Date(metrics.lastConsolidationAt).toISOString()}`,
      engine.sinceLastSession(),
    ].join('\n')
  }
  if (command === 'explain') {
    // FR-B4「可解释」：`ScoredCard.explain` 一直算出来了却没有任何出口，
    // 等于「算了但没暴露」。这个子命令把每个候选的分数构成摆出来，
    // 让「为什么想起这张卡」可以被人核对。
    const result = engine.recall(trimmed.slice('explain'.length).trim())
    if (result.pack.cards.length === 0) {
      return `没有命中任何记忆（候选 ${result.candidates} 张）`
    }
    const lines: string[] = [`焦点包 ${result.pack.cards.length} 张，候选 ${result.candidates} 张`]
    for (const scored of result.pack.cards) {
      lines.push('')
      lines.push(`■ ${scored.card.text}`)
      lines.push(`  总分 ${scored.score.total.toFixed(3)}${scored.conflict ? '（有冲突）' : ''}`)
      for (const line of scored.explain) lines.push(`  ${line}`)
    }
    return lines.join('\n')
  }
  return `未知子命令「${command}」，可用：status / health / rebuild / explain`
}

/** 插件默认配置，供宿主 patch 引用。 */
export const defaultConfig = DEFAULT_CONFIG

/**
 * 夜整理周期的导出，便于测试断言。
 *
 * @returns 巡检周期毫秒数。
 */
export function consolidationPollMs(): number {
  return CONSOLIDATION_POLL_MS
}

/**
 * 动态上下文排序值的导出，便于测试断言（C7 要求排在动态尾部）。
 *
 * @returns 排序值。
 */
export function contextOrder(): number {
  return CONTEXT_ORDER
}
