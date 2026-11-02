/**
 * 宿主适配层单测。
 *
 * 覆盖目标：
 * - FR-E2：动态上下文只走 `context()`，绝不走 `section()`（C4 / C7）。
 * - FR-F2：命令注册在两种宿主字段名下都能工作。
 * - C8：能力缺失时降级而不是崩溃。
 * - ST-1：配置解析与渲染必须确定性。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import {
  createLogger, now, probeCapabilities, registerCommand, registerDynamicContext,
  resolveConfig, resolveTimeZone, setRepeating, subscribe,
} from '../../src/host/adapter.ts'
import type { HostContext, LogLevel } from '../../src/host/adapter.ts'

/** 记录一次动态上下文注册。 */
interface ContextRegistration {
  name: string
  order?: number
  text: string | (() => string)
}

/** 记录一次命令注册。 */
interface CommandRegistration {
  name: string
  description: string
  run?: (args: string) => unknown
  handler?: (args: string) => unknown
}

/** 记录一次事件订阅。 */
interface Subscription {
  event: string
  listener: (...args: unknown[]) => unknown
}

/** 假宿主：记录所有接线调用，便于断言。 */
interface FakeHost {
  ctx: HostContext
  contexts: ContextRegistration[]
  sections: ContextRegistration[]
  commands: CommandRegistration[]
  subscriptions: Subscription[]
  effects: (() => void)[]
  logs: { level: LogLevel; message: string }[]
  intervals: { callback: () => void; ms: number }[]
}

/**
 * 造一个「能力齐全」的假宿主。
 *
 * @returns 假宿主。
 */
function makeFullHost(): FakeHost {
  const contexts: ContextRegistration[] = []
  const sections: ContextRegistration[] = []
  const commands: CommandRegistration[] = []
  const subscriptions: Subscription[] = []
  const effects: (() => void)[] = []
  const logs: { level: LogLevel; message: string }[] = []
  const intervals: { callback: () => void; ms: number }[] = []

  const ctx: HostContext = {
    systemPrompt: {
      context: (options) => {
        contexts.push(options as ContextRegistration)
        return () => {}
      },
      section: (options) => {
        sections.push(options as ContextRegistration)
        return () => {}
      },
    },
    on: (event, listener) => {
      subscriptions.push({ event, listener })
      return () => {}
    },
    commands: {
      register: (command) => {
        commands.push(command as CommandRegistration)
        return () => {}
      },
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
      error: (message) => logs.push({ level: 'error', message }),
      debug: (message) => logs.push({ level: 'debug', message }),
    },
    interval: (callback, ms) => {
      intervals.push({ callback, ms })
      return () => {}
    },
    effect: (fn) => {
      effects.push(fn)
      return () => {}
    },
  }
  return { ctx, contexts, sections, commands, subscriptions, effects, logs, intervals }
}

describe('resolveConfig', () => {
  it('空配置返回默认值', () => {
    const config = resolveConfig({})
    assert.deepEqual(config, DEFAULT_CONFIG)
  })

  it('undefined 也返回默认值', () => {
    assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  })

  it('非对象配置退回默认值', () => {
    assert.deepEqual(resolveConfig('乱七八糟'), DEFAULT_CONFIG)
    assert.deepEqual(resolveConfig(42), DEFAULT_CONFIG)
    assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
  })

  it('只写一个字段不会清空其余默认值（宿主 patch 是整块替换 config）', () => {
    const config = resolveConfig({ storage: { dataDir: '/tmp/mem' } })
    assert.equal(config.storage.dataDir, '/tmp/mem')
    // 同一段里的其它字段必须保留。
    assert.equal(config.storage.fsyncOnWrite, DEFAULT_CONFIG.storage.fsyncOnWrite)
    assert.equal(config.storage.journalSegmentBytes, DEFAULT_CONFIG.storage.journalSegmentBytes)
    // 其它段整体保留。
    assert.equal(config.recall.candidateLimit, DEFAULT_CONFIG.recall.candidateLimit)
    assert.equal(config.forgetting.halfLifeMs, DEFAULT_CONFIG.forgetting.halfLifeMs)
  })

  it('深层嵌套字段能单独覆盖', () => {
    const config = resolveConfig({ consolidation: { dailyAt: '04:15' } })
    assert.equal(config.consolidation.dailyAt, '04:15')
    assert.equal(config.consolidation.enabled, DEFAULT_CONFIG.consolidation.enabled)
    assert.equal(config.consolidation.maxArchiveRatio, DEFAULT_CONFIG.consolidation.maxArchiveRatio)
  })

  it('非法配置抛错（启动期失败优于运行期出错）', () => {
    assert.throws(
      () => resolveConfig({ forgetting: { halfLifeMs: -1 } }),
      /配置非法/u,
    )
  })

  it('返回的配置是深拷贝，改动它不影响 DEFAULT_CONFIG', () => {
    const config = resolveConfig({ storage: { dataDir: '/tmp/a' } })
    config.storage.dataDir = '/tmp/b'
    assert.notEqual(DEFAULT_CONFIG.storage.dataDir, '/tmp/b')
  })
})

describe('createLogger', () => {
  it('日志带上前缀并转发到宿主对应级别', () => {
    const host = makeFullHost()
    const logger = createLogger(host.ctx, '[mem]')
    logger.info('上线')
    logger.warn('小心')
    logger.error('炸了')
    logger.debug('细节')
    assert.deepEqual(host.logs, [
      { level: 'info', message: '[mem] 上线' },
      { level: 'warn', message: '[mem] 小心' },
      { level: 'error', message: '[mem] 炸了' },
      { level: 'debug', message: '[mem] 细节' },
    ])
  })

  it('默认前缀是 [memory]', () => {
    const host = makeFullHost()
    createLogger(host.ctx).info('x')
    assert.equal(host.logs[0]?.message, '[memory] x')
  })

  it('宿主没有日志服务时退回 console 而不抛错', () => {
    const original = { log: console.log, warn: console.warn, error: console.error }
    const captured: string[] = []
    console.log = (message: string) => { captured.push(`log:${message}`) }
    console.warn = (message: string) => { captured.push(`warn:${message}`) }
    console.error = (message: string) => { captured.push(`error:${message}`) }
    try {
      const logger = createLogger({})
      logger.info('a')
      logger.warn('b')
      logger.error('c')
      logger.debug('d')
    } finally {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    }
    assert.deepEqual(captured, [
      'log:[memory] a',
      'warn:[memory] b',
      'error:[memory] c',
      'log:[memory] d',
    ])
  })

  it('宿主只提供部分级别时，缺失的那一级退回 console', () => {
    const captured: string[] = []
    const originalWarn = console.warn
    console.warn = (message: string) => { captured.push(message) }
    try {
      const logger = createLogger({ logger: { info: () => {} } })
      logger.warn('缺级别')
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(captured, ['[memory] 缺级别'])
  })
})

describe('probeCapabilities', () => {
  it('能力齐全时全部为真且缺失列表为空', () => {
    const host = makeFullHost()
    const capabilities = probeCapabilities(host.ctx)
    assert.equal(capabilities.canInjectContext, true)
    assert.equal(capabilities.canRegisterCommand, true)
    assert.equal(capabilities.canSubscribeEvents, true)
    assert.equal(capabilities.canSchedule, true)
    assert.deepEqual(capabilities.missing, [])
  })

  it('空上下文时全部为假并逐项列出缺失', () => {
    const capabilities = probeCapabilities({})
    assert.equal(capabilities.canInjectContext, false)
    assert.equal(capabilities.canRegisterCommand, false)
    assert.equal(capabilities.canSubscribeEvents, false)
    assert.equal(capabilities.canSchedule, false)
    assert.deepEqual(capabilities.missing, [
      'systemPrompt.context', 'commands.register', 'on', 'interval',
    ])
  })

  it('只有部分能力时精确报告缺失项', () => {
    const capabilities = probeCapabilities({ on: () => {} })
    assert.equal(capabilities.canSubscribeEvents, true)
    assert.equal(capabilities.canInjectContext, false)
    assert.deepEqual(capabilities.missing, [
      'systemPrompt.context', 'commands.register', 'interval',
    ])
  })

  it('字段存在但不是函数时视为缺失', () => {
    const capabilities = probeCapabilities({
      systemPrompt: { context: '不是函数' as unknown as () => void },
      on: null as unknown as () => void,
    })
    assert.equal(capabilities.canInjectContext, false)
    assert.equal(capabilities.canSubscribeEvents, false)
  })
})

describe('registerDynamicContext', () => {
  it('注册成功并传回 name / order / text', () => {
    const host = makeFullHost()
    const ok = registerDynamicContext(host.ctx, 'memory:focus', 130, () => '内容')
    assert.equal(ok, true)
    assert.equal(host.contexts.length, 1)
    assert.equal(host.contexts[0]?.name, 'memory:focus')
    assert.equal(host.contexts[0]?.order, 130)
  })

  it('绝不调用 section（C4：section 会破坏 KV 缓存）', () => {
    const host = makeFullHost()
    registerDynamicContext(host.ctx, 'memory:focus', 130, () => '内容')
    assert.equal(host.sections.length, 0)
  })

  it('text 传的是函数而不是字符串（C7：每轮重新求值）', () => {
    const host = makeFullHost()
    registerDynamicContext(host.ctx, 'memory:focus', 130, () => '内容')
    assert.equal(typeof host.contexts[0]?.text, 'function')
  })

  it('text 函数每次调用都重新求值（压缩后能重新物化）', () => {
    const host = makeFullHost()
    let counter = 0
    registerDynamicContext(host.ctx, 'memory:focus', 130, () => {
      counter += 1
      return `第 ${counter} 次`
    })
    const text = host.contexts[0]?.text
    assert.equal(typeof text, 'function')
    const render = text as () => string
    assert.equal(render(), '第 1 次')
    assert.equal(render(), '第 2 次')
    assert.equal(counter, 2)
  })

  it('渲染函数抛错时返回空串而不是把异常抛给宿主循环', () => {
    const host = makeFullHost()
    const originalError = console.error
    console.error = () => {}
    try {
      registerDynamicContext(host.ctx, 'memory:focus', 130, () => {
        throw new Error('渲染炸了')
      })
      const render = host.contexts[0]?.text as () => string
      assert.equal(render(), '')
    } finally {
      console.error = originalError
    }
  })

  it('宿主没有 systemPrompt.context 时返回 false', () => {
    assert.equal(registerDynamicContext({}, 'memory:focus', 130, () => 'x'), false)
  })

  it('order 原样传给宿主，不做任何钳制', () => {
    const host = makeFullHost()
    registerDynamicContext(host.ctx, 'a', 200, () => 'x')
    assert.equal(host.contexts[0]?.order, 200)
  })
})

describe('subscribe', () => {
  it('订阅成功并透传事件名与监听器', () => {
    const host = makeFullHost()
    const listener = (): void => {}
    const ok = subscribe(host.ctx, 'agent/turn-stopping', listener)
    assert.equal(ok, true)
    assert.equal(host.subscriptions.length, 1)
    assert.equal(host.subscriptions[0]?.event, 'agent/turn-stopping')
    assert.equal(host.subscriptions[0]?.listener, listener)
  })

  it('宿主没有 on 时返回 false', () => {
    assert.equal(subscribe({}, 'agent/turn-stopping', () => {}), false)
  })

  it('只传两个参数（向前兼容不同宿主版本）', () => {
    let received = 0
    const ctx: HostContext = {
      on: (...args: unknown[]) => {
        received = args.length
        return () => {}
      },
    }
    subscribe(ctx, 'x', () => {})
    assert.equal(received, 2)
  })
})

describe('registerCommand', () => {
  it('同时提供 run 与 handler 两种字段名', () => {
    const host = makeFullHost()
    const handler = (args: string): string => `收到 ${args}`
    const ok = registerCommand(host.ctx, 'memory', '查看记忆', handler)
    assert.equal(ok, true)
    assert.equal(host.commands.length, 1)
    assert.equal(host.commands[0]?.name, 'memory')
    assert.equal(host.commands[0]?.description, '查看记忆')
    assert.equal(host.commands[0]?.run, handler)
    assert.equal(host.commands[0]?.handler, handler)
  })

  it('宿主没有 commands.register 时返回 false', () => {
    assert.equal(registerCommand({}, 'memory', '说明', () => ''), false)
  })
})

describe('setRepeating', () => {
  it('优先用宿主的 interval，并把回调与周期原样传入', () => {
    const host = makeFullHost()
    const callback = (): void => {}
    setRepeating(host.ctx, callback, 60_000)
    assert.equal(host.intervals.length, 1)
    assert.equal(host.intervals[0]?.callback, callback)
    assert.equal(host.intervals[0]?.ms, 60_000)
  })

  it('宿主没有 interval 时退回全局定时器，并挂到 effect 上清理', () => {
    const effects: (() => void)[] = []
    const ctx: HostContext = {
      effect: (fn) => {
        effects.push(fn)
        return () => {}
      },
    }
    const dispose = setRepeating(ctx, () => {}, 60_000)
    assert.equal(effects.length, 1)
    assert.equal(typeof dispose, 'function')
    // 清理不抛错，且可以重复调用。
    effects[0]?.()
    dispose()
  })

  it('返回的清理函数不抛错（宿主 interval 分支）', () => {
    const host = makeFullHost()
    const dispose = setRepeating(host.ctx, () => {}, 1000)
    assert.doesNotThrow(() => dispose())
  })
})

describe('now', () => {
  it('无自定义时钟时返回当前时间', () => {
    const before = Date.now()
    const value = now()
    const after = Date.now()
    assert.ok(value >= before && value <= after)
  })

  it('有自定义时钟时用注入值（ST-1 确定性）', () => {
    assert.equal(now(() => 12345), 12345)
  })

  it('同一个注入时钟多次调用结果一致', () => {
    const clock = (): number => 999
    assert.equal(now(clock), now(clock))
  })
})

describe('resolveTimeZone', () => {
  it('返回非空字符串', () => {
    const zone = resolveTimeZone()
    assert.equal(typeof zone, 'string')
    assert.ok(zone.length > 0)
  })

  it('返回能被 Intl 识别的时区名', () => {
    const zone = resolveTimeZone()
    assert.doesNotThrow(() => new Intl.DateTimeFormat('en-US', { timeZone: zone }))
  })
})
