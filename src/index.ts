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
import type { HostContext, Logger } from './host/adapter.ts'
import {
  createLogger, probeCapabilities, readGoalText, registerCommand, registerDynamicContext,
  resolveConfig, resolveTimeZone, setRepeating, subscribe,
} from './host/adapter.ts'
import { readRollbackState, resolveDataDirLoose } from './host/configRollback.ts'
import { MemoryEngine } from './host/engine.ts'
import { runMemoryCommand } from './host/plugin/commands.ts'
import {
  CONSOLIDATION_POLL_MS, CONTEXT_NAME, CONTEXT_ORDER,
} from './host/plugin/constants.ts'
import { makeFocusPackRenderer } from './host/plugin/render.ts'
import { accumulateEvent, readTurnText } from './host/plugin/turnBuffer.ts'
import type { TurnBuffers } from './host/plugin/turnBuffer.ts'
import { isWakeable, makeWakeMessage, pickDomain, sessionIdOf } from './host/plugin/wake.ts'
import type { WakeableAgent } from './host/plugin/wake.ts'
import { recordConfigSnapshot } from './store/configLedger.ts'
import { openStore } from './store/store.ts'
import type { MemoryStore } from './store/store.ts'
import { shouldRunDaily } from './time/clock.ts'

// 公开导出原地不变：`name` / `inject` / `Config` / `runMemoryCommand` 的定义
// 已迁到 `host/plugin/`，这里只做转出，保证 `src/index.ts` 仍是唯一入口。
export { inject, name } from './host/plugin/constants.ts'
export type { Config } from './host/plugin/constants.ts'
export { runMemoryCommand } from './host/plugin/commands.ts'

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
 * 把记忆系统挂到宿主上。
 *
 * @param ctx - 宿主上下文（Cordis Context 的结构化子集）。
 * @param rawConfig - 宿主传入的原始配置。
 */
export async function apply(ctx: HostContext, rawConfig: unknown): Promise<void> {
  const logger = createLogger(ctx)
  // FR-F4：回滚覆盖层必须在校验**之前**叠加。
  //
  // 为什么要在这里先算一次 `dataDir`：读覆盖层需要知道它在哪个库里，
  // 而那时配置**还没通过校验**（可能就是坏的）。
  // `resolveDataDirLoose` 只取 `storage.dataDir` 不校验，恰好能在这个时点算出路径。
  //
  // 不会自指：`storage` 段被 `ROLLBACK_EXCLUDED_TOP_KEYS` 排除在回滚之外，
  // 所以 `dataDir` 永远只由「默认值 + patch」决定，与覆盖层无关。
  const dataDir = resolveDataDirLoose(rawConfig ?? {})
  const rollback = readRollbackState(dataDir)
  const config = resolveConfig(rawConfig ?? {}, rollback === null ? undefined : rollback.override)
  if (rollback !== null) {
    // 回滚生效时必须报出来。不报的后果是“我改了 patch 为什么没生效”——
    // 而用户会去改 patch、发现怎么改都不变，最后得出「配置系统坏了」的错结论。
    logger.warn(
      `已生效配置回滚覆盖层（目标快照 ${rollback.targetId}）：`
      + `patch 里与快照不同的参数被回滚值覆盖，`
      + `想让 patch 重新生效请执行 memoryctl config rollback --clear`,
    )
  }
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
  // FR-F4：每次启动记一条配置快照（与上一条相同时不追加）。
  //
  // 为什么要在启动时记而不是在改配置时记：改配置的动作发生在本插件之外
  // （用户编辑 `cordis.patch.yml`），插件看不到那一幕。能看到的只有「下一次启动时配置长啥样」。
  // 启动时记账恰好把每一份**真正生效过**的配置都留下，而且不会记下从未生效的中间态。
  try {
    recordConfigSnapshot(store.dir, config, clock?.() ?? Date.now(), config.storage.configSnapshotMaxEntries)
  } catch (error) {
    // 快照失败不能阻断启动：它是旁路可观测能力，不是记忆库本身。
    // 但也不能静默——否则「没有回滚点」会在需要回滚的那一天才被发现。
    logger.warn(`记录配置快照失败（回滚点将不完整）：${error instanceof Error ? error.message : String(error)}`)
  }

  const engine = new MemoryEngine({
    store,
    config,
    timeZone: resolveTimeZone(),
    clock,
    onLog: (entry) => {
      // 按 kind 分级：`error` 在 `LogKind` 里是**严重度**而非分类（其余四个
      // write/recall/consolidate/command 才是分类），所以它必须走 error 级别。
      //
      // 曾经一律走 `logger.debug`，后果是**任何错误都进不了默认日志级别**：
      // 引擎里那些「刻意吞掉但必须留痕」的 catch 块发出的日志，在生产环境
      // 一条都看不见。那样「留痕」就只是调用过 log 函数，不是能被发现。
      // 典型受害者：夜整理时刻落盘失败（磁盘满、权限错）→ 每次重启都重新
      // 整理一遍，幂等、不报错、只是白烧 CPU，而日志里什么也没有。
      if (entry.kind === 'error') logger.error(`${entry.kind} ${entry.summary}`)
      else logger.debug(`${entry.kind} ${entry.summary}`)
    },
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
    // 初值来自引擎（引擎从 `dataDir/meta.json` 读盘），而不是进程内 `null`。
    //
    // 用进程内 `null` 的后果：每次进程重启都认为「从未整理过」，于是立刻
    // 整理一次。它幂等、不丢数据，所以没人会发现——只是白烧全库去重的 CPU。
    // 这正是「功能悄悄失效」那一类：不报错、不丢数据、只是做了无用功。
    //
    // 仍然用 `let`：整理后要刷新。刷新成 `now` 而不是重读磁盘，是因为同进程内
    // 两者必然一致（`consolidate` 里已经落盘），重读只是多一次 IO。
    //
    // 若 `meta.json` 丢了（判据一允许丢），初值退回 `null`，行为退回
    // 「启动就整理一次」——这是**正确的降级**，不是缺陷。
    let lastRunAt: number | null = engine.lastConsolidatedAt()
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
        // 传 now 而不是让它默认取 clock()：推进基准必须是**本次投递时刻**，
        // 否则时钟回拨或注入时钟时推进变空操作（且不报错）。
        engine.markReminded(cards, now)
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
 * 插件默认配置，供宿主 patch 引用。
 *
 * **本仓库内部零引用**（`grep -rn defaultConfig src/ tests/` 只有这一行），
 * 但它与另外三个死导出不同，**保留**：`index.ts` 是这个包的公开入口
 * （`package.json` 的 `main` / `exports["."]`），而 `DEFAULT_CONFIG` 在
 * `src/core/config/` 里——外部消费者（写 patch 的人、别的插件）不该为了读
 * 默认值去 import 内部路径。**「本仓库零引用」不等于「无用」**，
 * 判据是「包外有没有人会用到它」。
 *
 * 为了让它不是无牙的装饰，`tests/host/plugin.test.ts` 里有一条用例断言
 * 「这个别名仍然指向真实的默认配置，且那份配置能通过校验」——别名指错、
 * 默认值被改坏都会红。
 */
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
