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
  /** 插件卸载钩子。 */
  effect?: (fn: () => void) => unknown
}

/** 日志级别。 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

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
  const host = ctx.logger
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
 * @param raw - 宿主传入的原始配置。
 * @returns 合并并校验后的配置；校验失败时抛错（启动期就该失败，而不是运行期出错）。
 */
export function resolveConfig(raw: unknown): MemoryConfig {
  const partial = (typeof raw === 'object' && raw !== null ? raw : {}) as DeepPartial<MemoryConfig>
  const merged = mergeConfig(DEFAULT_CONFIG, partial)
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
  const canInjectContext = typeof ctx.systemPrompt?.context === 'function'
  if (!canInjectContext) missing.push('systemPrompt.context')
  const canRegisterCommand = typeof ctx.commands?.register === 'function'
  if (!canRegisterCommand) missing.push('commands.register')
  const canSubscribeEvents = typeof ctx.on === 'function'
  if (!canSubscribeEvents) missing.push('on')
  const canSchedule = typeof ctx.interval === 'function'
  if (!canSchedule) missing.push('interval')
  return { canInjectContext, canRegisterCommand, canSubscribeEvents, canSchedule, missing }
}

/**
 * 注册动态上下文（FR-E2 主通道）。
 *
 * 三条硬约束：
 * 1. **只走 `context()`，不走 `section()`** —— 后者改写系统提示词头部，
 *    会让 KV 前缀缓存从第一个变化 token 起全部失效（C7）。
 * 2. **order 取 130 之后** —— 第一方 context 占用 110/115/120，
 *    本系统排在它们之后，不抢位置（宿主文档第 2 节）。
 * 3. **`text` 传函数** —— 每轮重新求值，压缩后自动重新物化（FR-E4 / V-1）。
 *
 * @param ctx - 宿主上下文。
 * @param name - 注册名，必须唯一。
 * @param order - 排序值，建议 ≥ 130。
 * @param render - 每轮求值的渲染函数；返回空串表示本轮不注入。
 * @returns 是否注册成功。
 */
export function registerDynamicContext(
  ctx: HostContext, name: string, order: number, render: () => string,
): boolean {
  const register = ctx.systemPrompt?.context
  if (typeof register !== 'function') return false
  register.call(ctx.systemPrompt, {
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
  const on = ctx.on
  if (typeof on !== 'function') return false
  on.call(ctx, event, listener)
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
  const register = ctx.commands?.register
  if (typeof register !== 'function') return false
  register.call(ctx.commands, { name, description, run: handler, handler })
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
  if (typeof ctx.interval === 'function') {
    ctx.interval(callback, ms)
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
  if (typeof ctx.effect === 'function') ctx.effect(dispose)
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
