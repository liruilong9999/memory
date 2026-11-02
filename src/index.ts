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
  createLogger, probeCapabilities, registerCommand, registerDynamicContext,
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

/** 动态上下文在系统提示词里的排序值。 */
const CONTEXT_ORDER = 130

/** 夜整理巡检周期：每小时看一次「今天该不该整理」。 */
const CONSOLIDATION_POLL_MS = 60 * 60 * 1000

/** 注册名：动态上下文。 */
const CONTEXT_NAME = 'memory:focus-pack'

/** 插件名，宿主日志与 loader 诊断用。 */
export const name = 'memory'

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
 * 从会话事件里取本轮的用户与助手文本。
 *
 * 为什么从 session 反查而不是靠事件 payload：`agent/turn-stopping` 只给
 * `{ agent, turn, signal }`，没有消息文本。会话事件才是唯一真相源（P2 的精神），
 * 所以这里按 seq 从后往前扫，读到本轮为止。
 *
 * @param agent - 宿主 agent 对象（结构化访问，不 import 宿主类型）。
 * @param turn - 轮次号。
 * @returns 用户与助手文本；读不到时都为空串。
 */
function readTurnText(agent: unknown, turn: number): { userText: string; assistantText: string; seq: number } {
  if (typeof agent !== 'object' || agent === null) return { userText: '', assistantText: '', seq: 0 }
  const session = (agent as { session?: unknown }).session
  if (typeof session !== 'object' || session === null) return { userText: '', assistantText: '', seq: 0 }
  const cursor = session as {
    seq?: unknown
    eventAt?: (seq: number) => unknown
  }
  const last = typeof cursor.seq === 'number' ? cursor.seq : 0
  if (typeof cursor.eventAt !== 'function') return { userText: '', assistantText: '', seq: last }

  const userParts: string[] = []
  const assistantParts: string[] = []
  // 从最新事件往前扫，直到读到本轮起点（turn/start）为止。
  for (let index = last - 1; index >= 0; index -= 1) {
    const event = cursor.eventAt(index) as
      | { type?: string; data?: { turn?: number } & Record<string, unknown> }
      | undefined
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      if (event.data?.turn === turn) break
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const text = messageText(event.data)
    if (text.length === 0) continue
    if (event.type === 'user/message') userParts.unshift(text)
    else assistantParts.unshift(text)
  }
  return {
    userText: userParts.join('\n'),
    assistantText: assistantParts.join('\n'),
    seq: last,
  }
}

/**
 * 从消息对象里抽纯文本。
 *
 * 宿主消息是 `content: ContentBlock[]`，这里只认文本块，其它块（图片/文件）忽略：
 * 记忆卡只存文本摘要，二进制内容没有语义价值（且会撑爆日志）。
 *
 * @param data - 消息事件数据。
 * @returns 拼接后的文本；无法解析时为空串。
 */
function messageText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const content = (data as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
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

/**
 * 组装焦点包渲染函数。
 *
 * 这个函数每轮被宿主调用一次（C7：`text` 传函数，压缩后自动重新物化）。
 * 它必须**快且不抛**：慢会拖慢整个请求，抛会让宿主循环出问题。
 *
 * @param engine - 记忆引擎。
 * @returns 渲染函数。
 */
function makeFocusPackRenderer(engine: MemoryEngine): () => string {
  return (): string => {
    // 召回查询用「最近一条用户消息」是最稳的近似：
    // 此刻还没拿到本轮请求，但上一轮的意图通常就是当前话题。
    const result = engine.recall(engine.recentQuery())
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
  const engine = new MemoryEngine({
    store,
    config,
    timeZone: resolveTimeZone(),
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

  // ---- 注入通道（FR-E2 / C4 / C7）----
  const injected = registerDynamicContext(
    ctx, CONTEXT_NAME, CONTEXT_ORDER, makeFocusPackRenderer(engine),
  )
  if (!injected) logger.warn('无法注册动态上下文，记忆不会被注入到系统提示词')

  // ---- 写路径（FR-A1 / 起源第 4 条）----
  const turnStopping = subscribe(ctx, 'agent/turn-stopping', (...args: unknown[]) => {
    const payload = args[0] as { agent?: unknown; turn?: unknown } | undefined
    const turn = typeof payload?.turn === 'number' ? payload.turn : 0
    const { userText, assistantText, seq } = readTurnText(payload?.agent, turn)
    if (userText.length === 0) return
    const input: TurnInput = {
      sessionId: sessionIdOf(payload?.agent),
      turn,
      step: 0,
      seq,
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
  })
  if (!turnStopping) logger.warn('无法订阅 agent/turn-stopping，记忆不会被写入')

  // ---- 夜整理（FR-C1 / 起源第 4 条）----
  if (config.consolidation.enabled) {
    let lastRunAt: number | null = null
    const timeZone = resolveTimeZone()
    wiring.disposeTimer = setRepeating(ctx, () => {
      const now = engine.now()
      if (!shouldRunDaily(lastRunAt, now, timeZone, config.consolidation.dailyAt)) return
      try {
        const report = engine.consolidate(now)
        lastRunAt = now
        logger.info(`夜整理完成：合并 ${report.merged} 组，归档 ${report.archived} 张`)
      } catch (error) {
        logger.error(`夜整理失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }, CONSOLIDATION_POLL_MS)
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
  return `未知子命令「${command}」，可用：status / health / rebuild`
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
 * 动态上下文排序值的导出，便于测试断言（C7 要求 ≥ 130）。
 *
 * @returns 排序值。
 */
export function contextOrder(): number {
  return CONTEXT_ORDER
}
