/**
 * 宿主适配层「真实 Cordis 语义」测试。
 *
 * 覆盖目标：
 * - C8：宿主能力缺失时降级，**而不是抛错**。
 * - FR-E2 / FR-F2 / FR-C1：服务未声明时不得让插件加载失败。
 *
 * 为什么单独一个文件：本仓库长期用普通对象做假宿主，而**普通对象永远不抛错**。
 * 真实 Cordis 的 `ctx` 是 Proxy，其 `get` 陷阱对未在 `inject` 里声明的服务名
 * **直接抛** `cannot get property "x" without inject`。`?.` 只能防 `undefined`，
 * 防不住抛错。于是 1026 条测试全绿，插件在真实宿主上却一条都没激活——
 * 「宿主实机验证」这一项存在的全部理由。
 *
 * 这里用 Proxy 复刻那条陷阱，让同类缺陷以后在单测阶段就红。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createLogger, probeCapabilities, readService, registerCommand,
  registerDynamicContext, setRepeating, subscribe,
} from '../../src/host/adapter.ts'
import type { HostContext } from '../../src/host/adapter.ts'

/**
 * 造一个复刻真实 Cordis 语义的宿主上下文。
 *
 * 行为对齐 `@deepseek-ai/cordis` 的 `get` 陷阱（实测见 `.tmp/probe-members.mjs`）：
 * - `inject` 里声明过的服务：正常返回；
 * - 未声明的服务：**抛** `cannot get property "x" without inject`；
 * - 核心方法（`on` / `effect` / `logger` / `reflect`）：正常返回，
 *   且 `reflect.get(name, false)` 对**非服务**成员返回 `undefined`。
 *
 * @param services - 已挂载的服务表。
 * @param core - 核心方法表（默认为空）。
 * @returns 带 Proxy 陷阱的宿主上下文。
 */
function makeStrictHost(
  services: Record<string, unknown>,
  core: Record<string, unknown> = {},
): HostContext {
  // 真实 Cordis 里「核心方法」不是服务，reflect.get 对它们恒返回 undefined。
  const reflect = {
    get: (key: string): unknown => (key in services ? services[key] : undefined),
  }
  const target: Record<string, unknown> = { ...core, reflect }
  return new Proxy(target, {
    get(obj, prop: string | symbol): unknown {
      if (typeof prop === 'symbol') return Reflect.get(obj, prop)
      // 核心方法（含 reflect）直接放行。
      if (prop in obj) return Reflect.get(obj, prop)
      // 已挂载的服务放行。
      if (prop in services) return services[prop]
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  }) as unknown as HostContext
}

/** 能力齐全的服务表。 */
function fullServices(): Record<string, unknown> {
  return {
    systemPrompt: {
      context: (): unknown => () => {},
      section: (): unknown => () => {},
    },
    commands: { register: (): unknown => () => {} },
    interval: (): unknown => () => {},
  }
}

describe('readService：真实 Cordis 的 Proxy 语义', () => {
  it('未声明且未挂载的服务返回 undefined，不抛错', () => {
    const ctx = makeStrictHost({})
    // 这一条是缺陷复现点：改动前 adapter 直接读 ctx.systemPrompt 会抛错。
    assert.equal(readService(ctx, 'systemPrompt'), undefined)
    assert.equal(readService(ctx, 'goals'), undefined)
    assert.equal(readService(ctx, 'storageDomain'), undefined)
  })

  it('已挂载的服务能真的取到（对照组，防止「全返回 undefined」也算通过）', () => {
    const ctx = makeStrictHost(fullServices())
    const prompt = readService(ctx, 'systemPrompt') as { context?: unknown }
    assert.equal(typeof prompt, 'object')
    assert.equal(typeof prompt.context, 'function')
  })

  it('核心方法即使不在服务表里也能取到', () => {
    // on / effect / logger 是 Context 核心方法，不是服务：
    // 只靠 reflect.get 会把它们全判成缺失，所以必须有直接读的回落。
    const on = (): void => {}
    const ctx = makeStrictHost({}, { on, effect: (): void => {}, logger: { info: (): void => {} } })
    assert.equal(readService(ctx, 'on'), on)
    assert.equal(typeof readService(ctx, 'effect'), 'function')
    assert.equal(typeof readService(ctx, 'logger'), 'object')
  })
})

describe('probeCapabilities：真实 Proxy 下不抛错且报告准确', () => {
  it('服务全缺时逐项报告缺失，而不是抛错', () => {
    const ctx = makeStrictHost({}, { on: (): void => {} })
    const capabilities = probeCapabilities(ctx)
    assert.equal(capabilities.canInjectContext, false)
    assert.equal(capabilities.canRegisterCommand, false)
    assert.equal(capabilities.canSchedule, false)
    // on 是核心方法，取得到 ⇒ 为真。
    assert.equal(capabilities.canSubscribeEvents, true)
    assert.deepEqual(capabilities.missing, [
      'systemPrompt.context', 'commands.register', 'interval',
    ])
  })

  it('服务齐全时四项全真', () => {
    const ctx = makeStrictHost(fullServices(), { on: (): void => {} })
    const capabilities = probeCapabilities(ctx)
    assert.equal(capabilities.canInjectContext, true)
    assert.equal(capabilities.canRegisterCommand, true)
    assert.equal(capabilities.canSchedule, true)
    assert.deepEqual(capabilities.missing, [])
  })
})

describe('接线函数：真实 Proxy 下缺失服务时返回 false 而不是抛错', () => {
  it('registerDynamicContext 缺 systemPrompt 时返回 false', () => {
    const ctx = makeStrictHost({})
    assert.equal(registerDynamicContext(ctx, 'memory:focus', 300, () => 'x'), false)
  })

  it('registerCommand 缺 commands 时返回 false', () => {
    const ctx = makeStrictHost({})
    assert.equal(registerCommand(ctx, 'memory', '说明', () => 'ok'), false)
  })

  it('setRepeating 缺 interval 时退回全局定时器且不抛错', () => {
    const ctx = makeStrictHost({})
    const dispose = setRepeating(ctx, () => {}, 60_000)
    assert.equal(typeof dispose, 'function')
    dispose()
  })

  it('subscribe 在只有核心方法时仍能订阅', () => {
    const events: string[] = []
    const ctx = makeStrictHost({}, { on: (event: string): void => void events.push(event) })
    assert.equal(subscribe(ctx, 'session/event', () => {}), true)
    assert.deepEqual(events, ['session/event'])
  })

  it('createLogger 缺 logger 服务时退回 console 且不抛错', () => {
    const ctx = makeStrictHost({})
    const original = console.log
    const lines: string[] = []
    console.log = (message: string): void => void lines.push(message)
    try {
      const logger = createLogger(ctx, '[probe]')
      logger.info('一条日志')
    } finally {
      console.log = original
    }
    assert.deepEqual(lines, ['[probe] 一条日志'])
  })
})
