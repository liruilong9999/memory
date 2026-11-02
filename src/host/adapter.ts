/**
 * 宿主适配层（Host Adapter）：唯一允许 import DSH / Cordis 的地方。
 *
 * 设计依据：
 * - NFR-7：宿主升级只改适配层，数据面与行为面原地不动。
 * - C8：宿主预览版会有破坏性变更，因此把「宿主长什么样」收敛成一个窄接口，
 *   而不是让上层到处 import `@deepseek-ai/*`。
 * - V-1..V-5：宿主待验证项全部在这一层做兼容与降级。
 *
 * 本文件**不直接依赖** Cordis 类型：`apply(ctx, config)` 收到的 ctx 是任意对象，
 * 我们只按需要的形状去探测。这样离线单测可以传假 ctx，不需要装宿主包。
 *
 * @module dsh-memory/host/adapter
 */

import type { MemoryConfig } from '../core/config.ts'
import { DEFAULT_CONFIG, mergeConfig, validateConfig } from '../core/config.ts'
import type { DeepPartial } from '../core/config.ts'

/**
 * 宿主提供的最小上下文。
 *
 * 刻意写成「全部可选」：宿主版本变化时，缺哪个能力就降级哪个能力，
 * 而不是整个插件崩掉（C8）。
 */
export interface HostContext {
  /** 系统提示词服务（C4 / FR-E2 的注入通道）。 */
  systemPrompt?: {
    /** 注册动态上下文；`text` 可以是函数，每轮重新求值。 */
    context?: (options: {
      name: string
      order?: number
      text: string | (() => string)
    }) => unknown
    /** 注册静态段落到系统提示词头部（本系统**不使用**，会破坏 KV 缓存）。 */
    section?: (options: { name: string; order?: number; text: string }) => unknown
  }
  /** 事件总线：`on(event, listener)`。 */
  on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
  /** 用户命令注册服务（FR-F2）。 */
  commands?: {
    /** 注册一条用户命令。 */
    register?: (command: {
      name: string
      description: string
      /** 命令处理函数。 */
      run?: (args: string) => unknown
      handler?: (args: string) => unknown
    }) => unknown
  }
  /** 日志服务；缺失时退回 `console`。 */
  logger?: {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
    debug?: (message: string) => void
  }
  /** 定时器服务；缺失时退回全局 `setInterval`（并受插件生命周期管理）。 */
  interval?: (callback: () => void, ms: number) => unknown
  /** 存储 domain 服务；缺失时退回本地文件日志（数据面已实现）。 */
  storageDomain?: unknown
  /**
   * 目标（goal）服务探针；缺失时按「没有目标」处理。
   *
   * 用途：FR-B1 的召回查询需要「当前在做什么」作为目标文本，否则
   * `goalScore` 恒为 0，目标匹配维度形同虚设。
   *
   * 宿主实现在 `packages/goal/goal/src/index.ts:279` 的 `get(agent)`，
   * 它会对非活跃 agent **抛** `GoalError`（`GOAL_AGENT_NOT_LIVE`），
   * 所以调用方必须 try/catch——见 `readGoalText`。
   */
  goals?: {
    /** 取某个 agent 当前目标；无目标时返回 `undefined`。 */
    get?: (agent: unknown) => unknown
  }
  /** 插件卸载钩子。 */
  effect?: (fn: () => void) => unknown
}

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 安全读取宿主上下文成员（服务或核心方法）。
 *
 * 真实 Cordis 的 `ctx` 是 Proxy：读取**未在 `inject` 里声明**的服务名会抛
 * `cannot get property "x" without inject`。`?.` 只能防 `undefined`，防不住抛错
 * ——这是本仓库宿主实机验证才暴露的缺陷（假宿主是普通对象，永远不抛）。
 *
 * 三级回落，缺一不可：
 * 1. `ctx.reflect.get(name, false)` —— Cordis 文档指定的安全读入口，
 *    服务不存在时返回 `undefined` 而不抛错；
 * 2. 直接属性读 —— **核心方法走这条**（`on`/`effect`/`logger` 不是服务，
 *    `reflect.get` 对它们恒返回 `undefined`，只靠第 1 步会把它们全判成缺失）；
 * 3. 直接读抛错时返回 `undefined` —— 未 inject 的服务走这条。
 *
 * **它防的是「抛错」，不是「服务晚到」**：`apply` 执行时服务若尚未就绪，
 * 这里读到 `undefined` 并就此定局。需要「等就绪」的依赖必须写进 `inject`
 * （Cordis 会在服务齐备后才跑 `apply`），见 `src/index.ts`。
 *
 * @param ctx - 宿主上下文。
 * @param name - 成员名（服务名或核心方法名）。
 * @returns 成员值；不可用时为 `undefined`。
 */
export function readService(ctx: HostContext, name: string): unknown {
  const reflect = (ctx as { reflect?: { get?: (key: string, strict?: boolean) => unknown } }).reflect
  if (typeof reflect?.get === 'function') {
    try {
      const viaReflect = reflect.get(name, false)
      if (viaReflect !== undefined) return viaReflect
    } catch {
      // 上下文已销毁等情形；继续尝试直接读。
    }
  }
  try {
    return (ctx as unknown as Record<string, unknown>)[name]
  } catch {
    // 未 inject 的服务：Proxy 的 get 陷阱抛错，按「取不到」处理（C8 降级）。
    return undefined
  }
}

/**
 * 读一个服务上的方法，取不到时返回 `undefined`。
 *
 * @param ctx - 宿主上下文。
 * @param service - 服务名。
 * @param method - 方法名。
 * @returns 绑定好的方法；不可用时为 `undefined`。
 */
function serviceMethod(
  ctx: HostContext, service: string, method: string,
): ((...args: unknown[]) => unknown) | undefined {
  const impl = readService(ctx, service)
  if (impl === null || typeof impl !== 'object') return undefined
  const fn = (impl as Record<string, unknown>)[method]
  if (typeof fn !== 'function') return undefined
  return (...args: unknown[]): unknown => (fn as (...a: unknown[]) => unknown).apply(impl, args)
}

/**
 * 宿主无关的日志器。
 *
 * 上层只认这个接口，不认 `ctx.logger`，这样换宿主只需改本文件。
 */
export interface Logger {
  /** 调试信息。 */
  debug: (message: string) => void
  /** 常规信息。 */
  info: (message: string) => void
  /** 警告。 */
  warn: (message: string) => void
  /** 错误。 */
  error: (message: string) => void
}

/**
 * 从宿主 ctx 构造日志器，缺失时退回 `console`。
 *
 * @param ctx - 宿主上下文。
 * @param prefix - 日志前缀，便于在宿主日志里过滤。
 * @returns 日志器。
 */
export function createLogger(ctx: HostContext, prefix = '[memory]'): Logger {
  const host = readService(ctx, 'logger') as HostContext['logger']
  const wrap = (level: LogLevel): ((message: string) => void) => (message: string) => {
    const line = `${prefix} ${message}`
    const fn = host?.[level]
    if (typeof fn === 'function') {
      fn.call(host, line)
      return
    }
    // 宿主没有日志服务时退回 console；error/warn 走对应级别，其余走 log。
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  }
}

/**
 * 解析并合并插件配置。
 *
 * 宿主的 patch 行是**整块替换 config**，所以这里必须做深合并，
 * 否则用户只写一个字段就会把其余默认值清空。
 *
 * ## `override` 为什么在**校验之前**叠加（FR-F4）
 *
 * 回滚覆盖层（`config/rollback.json`）的唯一用途，就是把「被改坏的 patch」
 * 修回可用状态。若先校验再叠加，patch 一坏这里就抛错了，覆盖层永远没机会
 * 生效——用户执行了回滚命令、命令报告成功，宿主下次启动仍然崩溃。
 * 那比没有回滚更糟，因为它消耗掉用户唯一一次信任。
 *
 * 所以顺序固定为：合并默认值与 patch → 叠加覆盖层 → 校验。
 *
 * @param raw - 宿主传入的原始配置。
 * @param override - 回滚覆盖层（最小覆盖）；没有回滚时省略。
 * @returns 合并并校验后的配置；校验失败时抛错（启动期就该失败，而不是运行期出错）。
 */
export function resolveConfig(raw: unknown, override?: DeepPartial<MemoryConfig>): MemoryConfig {
  const partial = (typeof raw === 'object' && raw !== null ? raw : {}) as DeepPartial<MemoryConfig>
  // 两次 `mergeConfig` 而不是 `{...merged, ...override}`：覆盖层可能只写了
  // `recall.absoluteThreshold`，浅合并会把整个 `recall` 段替换成一个只剩
  // 一个字段的对象，其余字段变成 `undefined`，然后在校验处炸出一堆
  // 「必须 ≥ 0」的假错误。深合并才是覆盖层的正确语义。
  const withPatch = mergeConfig(DEFAULT_CONFIG, partial)
  const merged = override === undefined ? withPatch : mergeConfig(withPatch, override)
  const validation = validateConfig(merged)
  if (!validation.ok) {
    throw new Error(`dsh-memory 配置非法：\n${validation.errors.join('\n')}`)
  }
  return merged
}

/**
 * 宿主能力探测结果。
 *
 * 需求 C8 要求「宿主升级只改适配层」，而适配的前提是**先知道宿主有什么**。
 */
export interface HostCapabilities {
  /** 能否通过 `systemPrompt.context()` 注入（FR-E2 主通道）。 */
  canInjectContext: boolean
  /** 能否注册用户命令（FR-F2）。 */
  canRegisterCommand: boolean
  /** 能否订阅宿主事件（写路径依赖）。 */
  canSubscribeEvents: boolean
  /** 能否设置定时器（夜整理依赖）。 */
  canSchedule: boolean
  /** 缺失的能力列表，便于启动时打一条警告。 */
  missing: string[]
}

/**
 * 探测宿主能力。
 *
 * 不做「探测失败就抛错」：宿主预览版能力可能随时增删，
 * 缺能力时降级运行并明确告知，比直接崩溃更符合 C8 的精神。
 *
 * @param ctx - 宿主上下文。
 * @returns 能力探测结果。
 */
export function probeCapabilities(ctx: HostContext): HostCapabilities {
  const missing: string[] = []
  // 四项都走安全读取：真实宿主的 ctx 是 Proxy，未 inject 的服务名会抛错。
  const canInjectContext = serviceMethod(ctx, 'systemPrompt', 'context') !== undefined
  if (!canInjectContext) missing.push('systemPrompt.context')
  const canRegisterCommand = serviceMethod(ctx, 'commands', 'register') !== undefined
  if (!canRegisterCommand) missing.push('commands.register')
  const canSubscribeEvents = typeof readService(ctx, 'on') === 'function'
  if (!canSubscribeEvents) missing.push('on')
  // `ctx.interval` 是 `timer` 服务 mixin 到 Context 上的**方法**，
  // 所以读的是 ctx 的 `interval` 成员，不是 `timer` 服务对象本身。
  const canSchedule = typeof readService(ctx, 'interval') === 'function'
  if (!canSchedule) missing.push('interval')
  return { canInjectContext, canRegisterCommand, canSubscribeEvents, canSchedule, missing }
}

/**
 * 注册动态上下文（FR-E2 主通道）。
 *
 * 三条硬约束：
 * 1. **只走 `context()`，不走 `section()`** —— 后者改写系统提示词头部，
 *    会让 KV 前缀缓存从第一个变化 token 起全部失效（C7）。
 * 2. **order 取 300** —— 第一方 context 占用 100/110/115/120/125 与 200/210，
 *    本系统排在它们之后，不抢位置（宿主文档第 2 节）。
 * 3. **`text` 传函数** —— 每轮重新求值，压缩后自动重新物化（FR-E4 / V-1）。
 *
 * @param ctx - 宿主上下文。
 * @param name - 注册名，必须唯一。
 * @param order - 排序值，建议 ≥ 300（排在宿主源码路径之后，落在动态尾部）。
 * @param render - 每轮求值的渲染函数；返回空串表示本轮不注入。
 * @returns 是否注册成功。
 */
export function registerDynamicContext(
  ctx: HostContext, name: string, order: number, render: () => string,
): boolean {
  const register = serviceMethod(ctx, 'systemPrompt', 'context')
  if (register === undefined) return false
  register({
    name,
    order,
    // 包一层：宿主可能同步求值也可能异步求值，这里保证异常不会冒到宿主循环里。
    text: (): string => {
      try {
        return render()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[memory] 渲染动态上下文失败：${message}`)
        return ''
      }
    },
  })
  return true
}

/**
 * 订阅宿主事件，兼容两种签名。
 *
 * 宿主事件总线在不同版本里可能是 `ctx.on(event, fn)` 或 `ctx.on(event, fn, options)`，
 * 这里只传前两个参数，保证向前兼容。
 *
 * @param ctx - 宿主上下文。
 * @param event - 事件名。
 * @param listener - 监听器。
 * @returns 是否订阅成功。
 */
export function subscribe(
  ctx: HostContext, event: string, listener: (...args: unknown[]) => unknown,
): boolean {
  const on = readService(ctx, 'on')
  if (typeof on !== 'function') return false
  ;(on as (...a: unknown[]) => unknown).call(ctx, event, listener)
  return true
}

/**
 * 注册用户命令（FR-F2）。
 *
 * 宿主命令服务有两种可能的字段名（`run` / `handler`），
 * 这里同时提供，宿主取哪个都能工作。
 *
 * @param ctx - 宿主上下文。
 * @param name - 命令名，不含前缀。
 * @param description - 命令说明。
 * @param handler - 处理函数。
 * @returns 是否注册成功。
 */
export function registerCommand(
  ctx: HostContext, name: string, description: string, handler: (args: string) => string,
): boolean {
  const register = serviceMethod(ctx, 'commands', 'register')
  if (register === undefined) return false
  register({ name, description, run: handler, handler })
  return true
}

/**
 * 设置周期定时器，并挂到插件生命周期上。
 *
 * 优先用宿主的 `ctx.interval`（生命周期自动清理）；宿主没有时退回全局
 * `setInterval`，并通过 `ctx.effect` 注册清理函数，避免插件卸载后定时器泄漏。
 *
 * @param ctx - 宿主上下文。
 * @param callback - 回调。
 * @param ms - 周期毫秒数。
 * @returns 清理函数。
 */
export function setRepeating(ctx: HostContext, callback: () => void, ms: number): () => void {
  // `ctx.interval` 是 `timer` 服务 mixin 到 Context 上的**方法**。
  // 读 `timer` 服务对象拿不到可调用函数，会静默退回全局 setInterval，
  // 于是插件卸载后定时器仍活着——所以要读 `interval` 这个成员。
  const interval = readService(ctx, 'interval')
  if (typeof interval === 'function') {
    ;(interval as (cb: () => void, delay: number) => unknown).call(ctx, callback, ms)
    return () => {
      /* 宿主负责清理 */
    }
  }
  const handle = setInterval(callback, ms)
  // 定时器不应阻止进程退出。
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref: () => void }).unref()
  }
  const dispose = (): void => clearInterval(handle)
  const effect = readService(ctx, 'effect')
  if (typeof effect === 'function') (effect as (fn: () => void) => unknown).call(ctx, dispose)
  return dispose
}

/**
 * 取当前时刻。
 *
 * 单独抽成函数是为了让上层能注入假时钟做确定性测试（ST-1）。
 *
 * @param clock - 可选的自定义时钟。
 * @returns 毫秒时间戳。
 */
export function now(clock?: () => number): number {
  return clock ? clock() : Date.now()
}

/**
 * 取当前时区。
 *
 * 用 `Intl` 解析而不是读环境变量：跨平台一致，且能正确处理 `Asia/Shanghai` 这类名称。
 *
 * @returns IANA 时区名；解析失败退回 `UTC`。
 */
export function resolveTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 读取某个 agent 当前的目标文本（FR-B1 的召回目标来源）。
 *
 * 为什么需要这个：`scoreCards` 的 `goalScore` 依赖 `RecallQuery.goalText`，
 * 而宿主侧从来没传过它，导致该维度恒为 0——一个算了但永远不起作用的维度。
 * 起源 L29（第 5 条·专注当前位置）要求「专注当前位置」，而「当前位置」在
 * 有目标时就是那个目标；没有目标时也不该给所有卡记 0 分（那是变相惩罚）。
 *
 * 三处必须容错，缺一不可：
 * 1. `ctx.goals` 可能不存在（测试假上下文、精简 profile）；
 * 2. `get` 可能不存在；
 * 3. 宿主 `get` 对非活跃 agent **抛** `GoalError`（`GOAL_AGENT_NOT_LIVE`），
 *    这在实际运行中很常见（agent 已经结束但插件还在轮询）。
 * 任何一处出错都返回空串，由 `scoreCards` 跳过 goal 维度。
 *
 * @param ctx - 宿主上下文。
 * @param agent - 目标 agent；未知时传 `undefined`。
 * @returns 目标文本；取不到时为空串。
 */
export function readGoalText(ctx: HostContext, agent: unknown): string {
  if (agent === undefined || agent === null) return ''
  const get = serviceMethod(ctx, 'goals', 'get')
  if (get === undefined) return ''
  try {
    const goal = get(agent)
    if (typeof goal !== 'object' || goal === null) return ''
    // 只取 active 目标：已完成/已阻塞的目标不该再牵引召回，
    // 否则「上一个任务的记忆」会一直干扰当前任务（起源 L29）。
    const record = goal as { objective?: unknown; phase?: unknown }
    if (record.phase !== 'active') return ''
    return typeof record.objective === 'string' ? record.objective : ''
  } catch {
    // 非活跃 agent 会抛 GoalError；没有目标不是错误，静默按「无目标」处理。
    return ''
  }
}
