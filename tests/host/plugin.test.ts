/**
 * 插件入口单测：`apply()` 真的把记忆系统接到宿主上了吗。
 *
 * 覆盖目标：
 * - FR-E2 / C4：注入只走 `systemPrompt.context()`，order ≥ 130，`text` 是函数。
 * - FR-A1：`agent/turn-stopping` 事件真的写卡。
 * - FR-F2：`/memory` 命令能查状态。
 * - FR-C1：夜整理定时器真的注册。
 * - C8：宿主缺能力时降级而不崩。
 * - C5：绝不注册自定义 session 事件。
 *
 * 这里用一个「记录型假宿主」，不装任何 DSH 包——这正是适配层窄接口的价值。
 *
 * @module tests/host/plugin.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { apply, contextOrder, consolidationPollMs, name } from '../../src/index.ts'
import type { HostContext } from '../../src/host/adapter.ts'
import { openStore } from '../../src/store/store.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const HOUR_MS = 60 * 60 * 1000

const tempDirs: string[] = []

/** 建临时目录并登记。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-plugin-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/** 一次动态上下文注册记录。 */
interface ContextRegistration {
  name: string
  order?: number
  text: string | (() => string)
}

/** 一次命令注册记录。 */
interface CommandRegistration {
  name: string
  description: string
  run?: (args: string) => unknown
  handler?: (args: string) => unknown
}

/** 一次事件订阅记录。 */
interface Subscription {
  event: string
  listener: (...args: unknown[]) => unknown
}

/** 记录型假宿主。 */
interface RecordingHost {
  ctx: HostContext
  contexts: ContextRegistration[]
  sections: ContextRegistration[]
  commands: CommandRegistration[]
  subscriptions: Subscription[]
  intervals: { callback: () => void; ms: number }[]
  logs: string[]
  effects: (() => void)[]
  /**
   * 触发某个事件的所有监听器。
   *
   * 用可变参数是因为宿主事件不都是单参数：`session/event` 派发的是
   * `(session, event)` 两个参数，只传一个会让生产代码取不到事件。
   */
  emit: (event: string, ...payload: unknown[]) => Promise<void>
  /** 取某次动态上下文的渲染函数。 */
  render: (index?: number) => string
}

/**
 * 造一个能力齐全的记录型假宿主。
 *
 * @param overrides - 要削掉的宿主能力，用于测降级路径。
 * @returns 假宿主。
 */
function makeHost(overrides: { dropContext?: boolean; dropEvents?: boolean; dropCommands?: boolean; dropInterval?: boolean } = {}): RecordingHost {
  const contexts: ContextRegistration[] = []
  const sections: ContextRegistration[] = []
  const commands: CommandRegistration[] = []
  const subscriptions: Subscription[] = []
  const intervals: { callback: () => void; ms: number }[] = []
  const logs: string[] = []
  const effects: (() => void)[] = []

  const ctx: HostContext = {
    ...(overrides.dropContext === true
      ? {}
      : {
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
      }),
    ...(overrides.dropEvents === true
      ? {}
      : {
        on: (event, listener) => {
          subscriptions.push({ event, listener })
          return () => {}
        },
      }),
    ...(overrides.dropCommands === true
      ? {}
      : {
        commands: {
          register: (command) => {
            commands.push(command as CommandRegistration)
            return () => {}
          },
        },
      }),
    logger: {
      info: (message) => logs.push(`info:${message}`),
      warn: (message) => logs.push(`warn:${message}`),
      error: (message) => logs.push(`error:${message}`),
      debug: (message) => logs.push(`debug:${message}`),
    },
    ...(overrides.dropInterval === true
      ? {}
      : {
        interval: (callback, ms) => {
          intervals.push({ callback, ms })
          return () => {}
        },
      }),
    effect: (fn) => {
      effects.push(fn)
      return () => {}
    },
  }

  return {
    ctx,
    contexts,
    sections,
    commands,
    subscriptions,
    intervals,
    logs,
    effects,
    emit: async (event, ...payload) => {
      for (const subscription of subscriptions) {
        if (subscription.event !== event) continue
        await subscription.listener(...payload)
      }
    },
    render: (index = 0) => {
      const text = contexts[index]?.text
      if (typeof text === 'function') return text()
      return text ?? ''
    },
  }
}

/**
 * 造一个假的 agent：带 session 事件日志。
 *
 * 形状对齐宿主的 `Session`：`seq` 是事件总数，`eventAt(i)` 取第 i 条。
 *
 * @param events - 事件数组。
 * @returns 假 agent。
 */
/**
 * 造一个假 agent。
 *
 * 刻意**不带** `eventAt`：宿主已把它标为 @deprecated 且禁止新调用，
 * 生产代码改成订阅 `session/event` 增量累积，假宿主也要跟着换模型，
 * 否则测试在验证一条已经不存在的调用路径。
 */
function makeAgent(): unknown {
  return { session: { id: 'sess-test' } }
}

/**
 * 把一组会话事件推给已订阅的 `session/event` 监听器。
 *
 * 生产代码靠这个事件累积本轮文本，所以测试必须按真实顺序投递：
 * 先 `turn/start`，再消息事件。
 *
 * @param host - 记录型假宿主。
 * @param events - 要投递的事件。
 */
async function emitSessionEvents(host: RecordingHost, events: { type: string; data: unknown }[]): Promise<void> {
  const session = { id: 'sess-test' }
  for (const event of events) {
    await host.emit('session/event', session, event)
  }
}

/** 造一条用户消息事件。 */
function userEvent(text: string): { type: string; data: unknown } {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
}

/** 造一条助手消息事件。 */
function assistantEvent(text: string): { type: string; data: unknown } {
  return { type: 'assistant/message', data: { content: [{ type: 'text', text }] } }
}

/** 造一条轮次起点事件。 */
function turnStartEvent(turn: number): { type: string; data: unknown } {
  return { type: 'turn/start', data: { turn } }
}

/** 基础配置：临时目录 + 上海时区友好。 */
function baseConfig(dir: string): Record<string, unknown> {
  return {
    storage: { dataDir: dir },
    // 关掉夜整理轮询以外的干扰：这里保留 enabled 以便测定时器注册。
    consolidation: { enabled: true, dailyAt: '03:30' },
  }
}

describe('插件元信息', () => {
  it('插件名是 memory', () => {
    assert.equal(name, 'memory')
  })

  it('动态上下文排序值 ≥ 130（C7：排在第一方 context 之后）', () => {
    assert.ok(contextOrder() >= 130)
  })

  it('夜整理巡检周期是 1 小时', () => {
    assert.equal(consolidationPollMs(), HOUR_MS)
  })
})

describe('apply 的注入接线（FR-E2 / C4 / C7）', () => {
  it('注册了动态上下文', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.equal(host.contexts.length, 1)
    assert.equal(host.contexts[0]?.name, 'memory:focus-pack')
  })

  it('绝不使用 section（C4：会破坏 KV 前缀缓存）', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.equal(host.sections.length, 0)
  })

  it('text 是函数而不是字符串（C7：每轮重新求值）', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.equal(typeof host.contexts[0]?.text, 'function')
  })

  it('order 是 130', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.equal(host.contexts[0]?.order, 130)
  })

  it('渲染函数可重复调用且不抛错（空库时返回时间读数）', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.doesNotThrow(() => host.render())
    assert.doesNotThrow(() => host.render())
  })

  it('空库渲染结果包含时间读数标题', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.match(host.render(), /时间读数/u)
  })
})

describe('apply 的写路径（FR-A1）', () => {
  it('订阅了 agent/turn-stopping', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const events = host.subscriptions.map((subscription) => subscription.event)
    assert.ok(events.includes('agent/turn-stopping'))
  })

  it('绝不注册自定义 session 事件（C5）', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    // 订阅是「监听宿主事件」，不是「注册新事件类型」。
    // C5 禁止的是往 session 日志里写自定义类型，这里只检查订阅的都是宿主已知事件。
    // session/event 是宿主内建事件（Session.commit 里派发），不是我们新造的类型；
    // 订阅它正是 C5 推荐的姿势——读会话日志，而不往日志里写自定义事件。
    const allowed = new Set(['agent/turn-stopping', 'session/event'])
    for (const subscription of host.subscriptions) {
      assert.ok(allowed.has(subscription.event), `不应订阅未知事件 ${subscription.event}`)
    }
  })

  it('收到 turn-stopping 后把记忆写进库', async () => {
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    const agent = makeAgent()
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定用 Alembic 管理数据库迁移，不要手写 SQL'),
      assistantEvent('好的，我记下了。Alembic 会自动生成迁移脚本。'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    // 用同一个数据目录重开一个库，确认真的落盘了（不是只改内存）。
    const store = openStore({ dataDir: dir })
    const cards = store.listCards({ status: 'active' })
    store.close()
    assert.ok(cards.length > 0, '应至少写入一张卡')
  })

  it('同一轮重复触发不会写重复卡（ST-2 幂等）', async () => {
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    const agent = makeAgent()
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定用 Alembic 管理数据库迁移，不要手写 SQL'),
      assistantEvent('好的。'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    const store = openStore({ dataDir: dir })
    const cards = store.listCards({ status: 'active' })
    store.close()
    // 幂等键由 (sessionId, turn, seq, op) 派生，第二轮应被判定为重复。
    assert.ok(cards.length <= 2, `不应写重复卡，实际 ${cards.length} 张`)
  })

  it('payload 缺 agent 时不抛错（降级）', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    await assert.doesNotReject(() => host.emit('agent/turn-stopping', {}))
  })

  it('payload 是 undefined 时不抛错', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    await assert.doesNotReject(() => host.emit('agent/turn-stopping', undefined))
  })

  it('用户消息为空时不写卡', async () => {
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))
    const agent = makeAgent()
    await emitSessionEvents(host, [turnStartEvent(1), userEvent('')])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })
    const store = openStore({ dataDir: dir })
    const cards = store.listCards({ status: 'active' })
    store.close()
    assert.equal(cards.length, 0)
  })
})

describe('apply 的到期提醒（FR-D3 / SC-5 / 起源 L21）', () => {
  it('到点后主动唤醒，无需用户输入（FR-D3 验收原文）', async () => {
    const dir = tempDir()
    const host = makeHost()
    // 用一个可控时钟：先写卡，再把时钟推到到期之后。
    const clock = { now: Date.UTC(2024, 0, 15, 2, 0, 0) } // 2024-01-15 10:00 上海
    await apply(host.ctx, {
      ...baseConfig(dir),
      reminder: { enabled: true, pollMs: 1000 },
      _clock: () => clock.now,
    })

    // 1. 投递一轮对话，让系统记住「明天下午三点提醒我交周报」。
    const agent = makeAgent()
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('明天下午三点提醒我交周报，别忘了'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    // 2. 还没到点：轮询不应该唤醒。
    const wakes: unknown[] = []
    const followup = (message: unknown): void => {
      wakes.push(message)
    }
    ;(agent as { followup: unknown }).followup = followup
    // 重新投递一次 turn-stopping，让插件记住这个可唤醒的 agent。
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    const poll = host.intervals.find((timer) => timer.ms === 1000)
    assert.ok(poll !== undefined, '应有到期轮询定时器')
    poll.callback()
    assert.equal(wakes.length, 0, '未到点不应唤醒')

    // 3. 把时钟推到到期时刻之后，轮询应该主动唤醒。
    clock.now = Date.UTC(2024, 0, 16, 7, 1, 0) // 2024-01-16 15:01 上海
    poll.callback()
    assert.equal(wakes.length, 1, '到点应主动唤醒一次')

    // 4. 再轮询一次不应重复唤醒（同一到期只提醒一次）。
    poll.callback()
    assert.equal(wakes.length, 1, '同一到期不应重复唤醒')
  })

  it('提醒文本包含到期事项且说明来自系统', async () => {
    const dir = tempDir()
    const host = makeHost()
    const clock = { now: Date.UTC(2024, 0, 15, 2, 0, 0) }
    await apply(host.ctx, {
      ...baseConfig(dir),
      reminder: { enabled: true, pollMs: 1000 },
      _clock: () => clock.now,
    })

    const agent = makeAgent()
    const wakes: unknown[] = []
    ;(agent as { followup: unknown }).followup = (message: unknown): void => {
      wakes.push(message)
    }
    await emitSessionEvents(host, [turnStartEvent(1), userEvent('明天下午三点提醒我交周报')])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    clock.now = Date.UTC(2024, 0, 16, 7, 1, 0)
    host.intervals.find((timer) => timer.ms === 1000)?.callback()

    assert.equal(wakes.length, 1)
    const message = wakes[0] as { content?: { text?: string }[] }
    const text = message.content?.[0]?.text ?? ''
    assert.ok(text.includes('到期提醒'), '应标注这是到期提醒')
    assert.ok(text.includes('不是用户输入'), '应说明消息来自系统')
    assert.ok(text.includes('周报'), '应包含到期事项原文')
  })

  it('没有可唤醒 agent 时不丢提醒，下次轮询再投递', async () => {
    const dir = tempDir()
    const host = makeHost()
    const clock = { now: Date.UTC(2024, 0, 15, 2, 0, 0) }
    await apply(host.ctx, {
      ...baseConfig(dir),
      reminder: { enabled: true, pollMs: 1000 },
      _clock: () => clock.now,
    })

    // 写卡时 agent 不可唤醒（没有 followup）。
    const plainAgent = makeAgent()
    await emitSessionEvents(host, [turnStartEvent(1), userEvent('明天下午三点提醒我交周报')])
    await host.emit('agent/turn-stopping', { agent: plainAgent, turn: 1 })

    const poll = host.intervals.find((timer) => timer.ms === 1000)
    clock.now = Date.UTC(2024, 0, 16, 7, 1, 0)
    assert.doesNotThrow(() => poll?.callback(), '没有可唤醒 agent 时不应抛错')

    // 换成可唤醒的 agent 后，同一次到期仍应投递（说明没被提前标记为已提醒）。
    const wakes: unknown[] = []
    const agent = makeAgent()
    ;(agent as { followup: unknown }).followup = (message: unknown): void => {
      wakes.push(message)
    }
    await host.emit('agent/turn-stopping', { agent, turn: 1 })
    poll?.callback()
    assert.equal(wakes.length, 1, '提醒不应因为一次没投出去就永久丢失')
  })
})

describe('apply 的夜整理接线（FR-C1）', () => {
  it('注册了夜整理定时器', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const consolidation = host.intervals.find((timer) => timer.ms === consolidationPollMs())
    assert.ok(consolidation !== undefined, '应有夜整理定时器')
  })

  it('consolidation.enabled = false 时不注册夜整理定时器', async () => {
    const host = makeHost()
    await apply(host.ctx, {
      storage: { dataDir: tempDir() },
      consolidation: { enabled: false },
      // 到期轮询是另一个独立能力，这里必须一起关掉才能断言「零定时器」。
      reminder: { enabled: false },
    })
    assert.equal(host.intervals.length, 0)
  })

  it('注册了到期轮询定时器（FR-D3 主动接力）', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const reminder = host.intervals.find((timer) => timer.ms === DEFAULT_CONFIG.reminder.pollMs)
    assert.ok(reminder !== undefined, '应有到期轮询定时器')
  })

  it('reminder.enabled = false 时不注册到期轮询', async () => {
    const host = makeHost()
    await apply(host.ctx, {
      storage: { dataDir: tempDir() },
      reminder: { enabled: false },
    })
    const reminder = host.intervals.find((timer) => timer.ms === DEFAULT_CONFIG.reminder.pollMs)
    assert.equal(reminder, undefined)
  })

  it('定时器回调可执行且不抛错', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const callback = host.intervals[0]?.callback
    assert.equal(typeof callback, 'function')
    assert.doesNotThrow(() => callback?.())
  })
})

describe('apply 的命令接线（FR-F2）', () => {
  it('注册了 /memory 命令', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.equal(host.commands.length, 1)
    assert.equal(host.commands[0]?.name, 'memory')
  })

  it('命令 handler 能返回状态文本', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const handler = host.commands[0]?.handler
    assert.equal(typeof handler, 'function')
    const text = handler?.('status')
    assert.equal(typeof text, 'string')
    assert.ok((text as string).length > 0)
  })
})

describe('apply 的降级路径（C8）', () => {
  it('宿主没有 systemPrompt 时不抛错，只打警告', async () => {
    const host = makeHost({ dropContext: true })
    await assert.doesNotReject(() => apply(host.ctx, baseConfig(tempDir())))
    assert.ok(host.logs.some((line) => line.includes('systemPrompt.context')))
  })

  it('宿主没有事件总线时不抛错', async () => {
    const host = makeHost({ dropEvents: true })
    await assert.doesNotReject(() => apply(host.ctx, baseConfig(tempDir())))
  })

  it('宿主没有命令服务时不抛错', async () => {
    const host = makeHost({ dropCommands: true })
    await assert.doesNotReject(() => apply(host.ctx, baseConfig(tempDir())))
  })

  it('宿主没有定时器时不抛错', async () => {
    const host = makeHost({ dropInterval: true })
    await assert.doesNotReject(() => apply(host.ctx, baseConfig(tempDir())))
  })

  it('宿主什么都没有时也不抛错', async () => {
    await assert.doesNotReject(() => apply({}, baseConfig(tempDir())))
  })

  it('能力齐全时不打「缺少能力」警告', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.equal(host.logs.some((line) => line.includes('缺少能力')), false)
  })

  it('注册了卸载清理钩子', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    assert.ok(host.effects.length >= 1)
  })

  it('卸载清理可执行且不抛错', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    for (const effect of host.effects) assert.doesNotThrow(() => effect())
  })
})

describe('runMemoryCommand', () => {
  it('status 返回活跃/归档与召回次数', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    const handler = host.commands[0]?.handler
    const text = handler?.('status') as string
    assert.match(text, /活跃/u)
    assert.match(text, /归档/u)
    assert.match(text, /召回/u)
  })

  it('health 返回健康与索引状态', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const text = host.commands[0]?.handler?.('health') as string
    assert.match(text, /健康/u)
    assert.match(text, /索引/u)
  })

  it('rebuild 返回重建摘要', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const text = host.commands[0]?.handler?.('rebuild') as string
    assert.match(text, /索引已重建/u)
  })

  it('explain 暴露分数构成（FR-B4 可解释）', async () => {
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    // 先写一条记忆，再问「为什么想起它」。
    const agent = makeAgent()
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定用 Alembic 管理数据库迁移，不要手写 SQL'),
      assistantEvent('好的，Alembic 会自动生成迁移脚本。'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    const text = host.commands[0]?.handler?.('explain 数据库迁移') as string
    assert.match(text, /焦点包/u, '应报告焦点包规模')
    // explain 的价值就在于把每个分项摆出来，而不是只给一个总分。
    assert.match(text, /语义相关/u)
    assert.match(text, /权重/u)
    assert.match(text, /总分/u)
  })

  it('explain 在没有命中时给出明确说明', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const text = host.commands[0]?.handler?.('explain 完全不相干的查询') as string
    assert.match(text, /没有命中/u)
  })

  it('未知子命令返回可用列表', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const text = host.commands[0]?.handler?.('乱写') as string
    assert.match(text, /未知子命令/u)
    assert.match(text, /status/u)
  })

  it('空参数等价于 status', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const text = host.commands[0]?.handler?.('') as string
    assert.match(text, /活跃/u)
  })
})
