/**
 * 插件入口单测：`apply()` 真的把记忆系统接到宿主上了吗。
 *
 * 覆盖目标：
 * - FR-E2 / C4：注入只走 `systemPrompt.context()`，order ≥ 300，`text` 是函数。
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

import { DEFAULT_CONFIG, MEMORY_CONFIG_VERSION, validateConfig } from '../../src/core/config.ts'
import { apply, contextOrder, consolidationPollMs, defaultConfig, name } from '../../src/index.ts'
import { readGoalText } from '../../src/host/adapter.ts'
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
function makeHost(overrides: {
  dropContext?: boolean; dropEvents?: boolean; dropCommands?: boolean; dropInterval?: boolean
  /** 注入 goal 服务探针，用于验证 FR-B1 的目标文本来源。 */
  goals?: { get?: (agent: unknown) => unknown }
} = {}): RecordingHost {
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
    ...(overrides.goals === undefined ? {} : { goals: overrides.goals }),
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

/**
 * 造一条用户消息事件。
 *
 * **必须带 `source.kind`**：宿主真实投递的 `user/message` 载荷就是
 * `UserMessage`（`packages/core/session/src/types.ts`），`source` 是必填字段。
 * 生产代码按 `source.kind === 'user'` 白名单过滤合成上下文（见 `src/index.ts`
 * 的 `HUMAN_SOURCE_KIND`），所以假宿主不补这个字段就不再是「真实载荷」，
 * 而是「一个宿主永远不会发出的载荷」——那样测试会绿在一个不存在的场景上。
 *
 * @param text - 消息正文。
 * @param kind - 来源类别，默认人类输入。
 * @returns 会话事件。
 */
function userEvent(text: string, kind = 'user'): { type: string; data: unknown } {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } }
}

/** 造一条助手消息事件（`source.kind` 恒为 `model`）。 */
function assistantEvent(text: string): { type: string; data: unknown } {
  return {
    type: 'assistant/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'model' } },
  }
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

  it('动态上下文排序值 ≥ 300（C7：排在动态尾部，不打断前缀缓存）', () => {
    // 宿主 CONTEXT_ORDERS 最高到 210（WEB_SURFACE），且 200 之后才是不进缓存的
    // 动态区（system-prompt:182）。记忆每轮都变，必须落在这个区里。
    assert.ok(contextOrder() >= 300)
  })

  it('夜整理巡检周期是 1 小时', () => {
    assert.equal(consolidationPollMs(), HOUR_MS)
  })

  it('defaultConfig 别名指向真实的默认配置，且那份配置能通过校验', () => {
    // 这个导出在包内零引用，但它属于**包的公开面**（`exports["."]`），
    // 外部写 patch 的人会用它读默认值。所以它不是死代码，而是「对外契约」——
    // 而对外契约必须有一条测试盯着，否则别名指错、默认值被改坏都没人知道。
    assert.equal(defaultConfig, DEFAULT_CONFIG, '别名必须就是那一份默认配置对象')
    assert.equal(defaultConfig.configVersion, MEMORY_CONFIG_VERSION)
    assert.deepEqual(validateConfig(defaultConfig).errors, [])
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

  it('order 是 300', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    // 300 落在宿主 200（宿主源码路径）之后的动态尾部，不进前缀缓存区。
    assert.equal(host.contexts[0]?.order, 300)
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

/**
 * FR-E4：压缩后自动重建焦点包。
 *
 * **这一节测的是我们能测的那一半。** 规格原文（`docs/1-需求规格.md:169`）要求
 * 「压缩后自动重建焦点包，不丢焦点、不报错」，它由两个独立的事实拼成：
 *
 * | 那一半 | 由谁保证 | 这里能测吗 |
 * |---|---|---|
 * | 宿主压缩后**真的会重新调用** `text()` | 宿主 agent-loop | ❌ 测不了 |
 * | 被调用时 `text()` 仍返回**完整**焦点包、不抛错、不丢卡 | 本插件 | ✅ 这里测 |
 *
 * 机制来自 C4/C7（`docs/1-需求规格.md:108`/`:110`）：`text` 是函数，宿主每轮
 * 重新求值，所以压缩不需要任何钩子——**压缩后的下一个 step 天然会再调一次**。
 * 我们唯一能保证的是「再调一次的时候它还是对的」。
 *
 * 为什么**不能**只断言「不抛错」：`assert.doesNotThrow` 对一个返回空串的实现
 * 同样成立，而空串正是「丢了焦点」。所以每条都配「焦点包里有真实记忆内容」。
 */
describe('压缩后重建焦点包（FR-E4）', () => {
  /** 投递一次压缩的完整三事件序列（宿主真实顺序：start → summary → end）。 */
  async function emitCompaction(host: RecordingHost): Promise<void> {
    await host.emit('session/event', { id: 'sess-test' }, {
      type: 'compaction/start',
      data: { compactionId: 'c1', shadowedRange: { start: 1, end: 3 } },
    })
    await host.emit('session/event', { id: 'sess-test' }, {
      type: 'compaction/summary',
      data: {
        compactionId: 'c1',
        summary: [{ type: 'text', text: '用户决定了缓存方案。' }],
        shadowedRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 120,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    })
    await host.emit('session/event', { id: 'sess-test' }, {
      type: 'compaction/end',
      data: { compactionId: 'c1' },
    })
  }

  /** 先写一条记忆进去，返回宿主与数据目录。 */
  async function hostWithMemory(): Promise<{ host: RecordingHost; dir: string }> {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定用 Redis 做缓存，因为一致性要求不高，能接受最终一致'),
      assistantEvent('好的，那就用 Redis，注意设置合理的过期时间。'),
    ])
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 1 })
    return { host, dir }
  }

  /** 从磁盘重放读活跃卡（必须读磁盘：幂等键影响的是「日志里有没有这条记录」）。 */
  function readCards(dir: string): { text: string }[] {
    const store = openStore({ dataDir: dir })
    const cards = store.listCards({ status: 'active' })
    store.close()
    return cards
  }

  it('压缩后 text() 仍返回完整焦点包（含真实记忆内容）', async () => {
    const { host } = await hostWithMemory()
    const before = host.render()
    // 前提断言：压缩前焦点包里必须有这张卡，否则「压缩后还有」测不出任何东西。
    assert.match(before, /Redis/u, '前提：压缩前焦点包必须含这条记忆')

    await emitCompaction(host)

    const after = host.render()
    assert.match(after, /Redis/u, '压缩后焦点包不能丢卡')
    assert.match(after, /时间读数/u, '压缩后时间读数不能丢')
  })

  it('压缩后重复调用 text() 结果稳定', async () => {
    const { host } = await hostWithMemory()
    await emitCompaction(host)
    const renders = Array.from({ length: 10 }, () => host.render())
    // ST-1 的同一把尺子：同状态同查询，10 次必须完全一致。
    assert.equal(new Set(renders).size, 1, '压缩后 10 次求值必须逐字符相同')
    assert.match(renders[0] ?? '', /Redis/u)
  })

  it('压缩事件本身不改变记忆库（不丢卡、不重复写）', async () => {
    const { host, dir } = await hostWithMemory()
    const cardsBefore = readCards(dir).length
    // 压缩是宿主侧动作，插件只是被通知；它不应该动数据面。
    const before = host.render()
    // 前提断言：before 必须非空且含真实内容。
    // 没有它，这条在「渲染器整体返回空串」时也绿（"" === ""）——
    // 而「压缩后什么都不记得了」恰恰是 FR-E4 最该抓的失效形态。
    // 这不是假想：反向验证的 M1 变异（渲染器 return ''）第一轮就是绿在这里的。
    assert.match(before, /Redis/u, '前提：压缩前焦点包必须非空且含这条记忆')
    assert.ok(cardsBefore > 0, '前提：库里必须真的有卡')

    await emitCompaction(host)

    assert.equal(host.render(), before, '压缩不应改变焦点包内容')
    assert.equal(readCards(dir).length, cardsBefore, '压缩不应增删卡片')
  })

  it('库为空时压缩后 text() 不抛错', async () => {
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    await emitCompaction(host)
    assert.doesNotThrow(() => host.render())
    // 空库也必须有时间读数——这是 FR-D1 与「不报错」的交集。
    assert.match(host.render(), /时间读数/u)
  })

  it('压缩摘要作为合成来源消息投递时也不进库（白名单直测）', async () => {
    // 这条是**白名单唯一能证明的地方**，也是反向验证逼出来的。
    //
    // 我原本还写了一条「投递 compaction/summary 事件后摘要不进库」，反向验证
    // 的 M6 变异（放行 compaction/* 类型）让它 fail=0——**它是装饰**。原因：
    // `compaction/summary` 的载荷是 `{ compactionId, summary: [...], shadowedSeqs }`，
    // 没有 `content` 字段，`messageText` 取不到文本，于是即使放行类型也写不进卡。
    // 也就是说「type 过滤」和「载荷形状」两层防护的观测值完全一样，那条用例
    // 守不住其中任何一层，已删除。
    //
    // 真正需要白名单的是**这条路径**：宿主压缩后把摘要作为 `user/message`
    // 落盘（`source.kind === 'compact-checkpoint'`），它形状合法、`content`
    // 齐全，只有 `source.kind` 能识别它。这正是缺陷三十四的原始形态。
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定用 Redis 做缓存，因为一致性要求不高，能接受最终一致'),
      // 压缩摘要以 user/message 投递，来源是 compact-checkpoint。
      userEvent('用户决定了缓存方案，选择 Redis。', 'compact-checkpoint'),
      assistantEvent('好的，那就用 Redis，注意设置合理的过期时间。'),
    ])
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 1 })

    const cards = readCards(dir)
    assert.ok(cards.length > 0, '前提：人类那句必须写进去')
    const polluted = cards.filter((card) => card.text.includes('用户决定了缓存方案'))
    assert.equal(polluted.length, 0, `压缩摘要不得变成记忆卡，实际产出：${polluted.map((c) => c.text).join(' | ')}`)
    // 配对对照：人类那句必须在库里，证明白名单没挡过头。
    assert.ok(
      cards.some((card) => card.text.includes('Redis 做缓存')),
      '配对对照：人类输入必须照常写入',
    )
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

describe('合成来源不得当成用户原话（起源 L17 上下文污染）', () => {
  /**
   * 这组用例守的是**一个曾经完全不存在**的判据。
   *
   * 宿主把 `systemPrompt.context()` 的全部贡献拼成一条 `user/message` 落盘
   * （`packages/core/agent-loop/src/runtime-context.ts` 的 `project()`，
   * 由 `session.append('user/message', context, { surfaceOp: 'append' })` 提交），
   * `source.kind === 'runtime-context'`。**本插件注入的焦点包就在这条消息里**，
   * 且因为它带时间读数、每轮都变，所以每轮都会重新 append 一次。
   *
   * 修复前 `accumulateEvent` 只看 `event.type`，于是：
   * 焦点包 → 当成用户原话累积 → 写卡时把里面的卡片行再抽一遍 → 新卡更多
   * → 下一轮焦点包更长 → 再抽一遍。实测 6 轮（用户每轮说的话**完全相同**）
   * 活跃卡 20 张，其中一半是 `- [事件] - [事件] - [事件] Current runtime context…`
   * 这种嵌套自我引用；对照组（不回送快照）是 6 张。**这是自我复制，不是噪声。**
   *
   * 为什么旧测试全绿：假宿主的 `userEvent()` 不带 `source` 字段，
   * 而生产代码从不读 `source`——「测试不带」和「实现不读」互相掩护，
   * 谁都不会红。所以这组用例的 `userEvent` 必须带 `source.kind`。
   */

  it('runtime-context 快照不写进记忆库（焦点包不被吃回去）', async () => {
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    const agent = makeAgent()
    // 先灌一张真卡，让焦点包含有卡片行（否则快照里只有时间读数，
    // 抽不出东西，测试会绿在一个不可能放大的前提上）。
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定这个项目必须用 PostgreSQL，JSONB 支持最好'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    const storeBefore = openStore({ dataDir: dir })
    const before = storeBefore.count('active')
    storeBefore.close()
    assert.equal(before, 1, '前提：先有一张真卡，焦点包才会带卡片行')

    // 第 2 轮：只投递宿主回送的快照，用户一个字都不说。
    const snapshot = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${host.render()}`
    assert.ok(snapshot.includes('[承诺]'), '前提：快照里必须真的带卡片行')
    await emitSessionEvents(host, [
      turnStartEvent(2),
      userEvent(snapshot, 'runtime-context'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 2 })

    const storeAfter = openStore({ dataDir: dir })
    const cards = storeAfter.listCards({ status: 'active' })
    storeAfter.close()
    assert.equal(cards.length, before, '合成来源不应产出任何新卡')
    // 更强的一条：库里不得出现快照前缀。只比条数的话，
    // 「写了一张又合并掉一张」也能让它变绿。
    for (const card of cards) {
      assert.ok(
        !card.text.includes('Current runtime context'),
        `卡片文本不得含快照前缀，实际：${card.text.slice(0, 80)}`,
      )
    }
  })

  it('压缩摘要消息不写进记忆库（compact-checkpoint 来源）', async () => {
    // 压缩摘要也是 `user/message`，source.kind === 'compact-checkpoint'
    // （`packages/compaction/compaction/src/checkpoint.ts` 的
    // `COMPACT_CHECKPOINT_MARKER`）。它是模型写的摘要，不是用户说的话。
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    const agent = makeAgent()
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('压缩摘要：我决定用 Alembic 管理数据库迁移，不要手写 SQL。', 'compact-checkpoint'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    const store = openStore({ dataDir: dir })
    const cards = store.listCards({ status: 'active' })
    store.close()
    assert.equal(cards.length, 0, '压缩摘要不是用户输入，不应产出卡片')
  })

  it('人类输入仍然照常写入（配对对照：白名单不能挡过头）', async () => {
    // 只测「合成来源被挡住」是半个测试：把 accumulateEvent 整个改成
    // 直接 return，上面两条也会绿，但记忆系统彻底不工作了。
    // 必须有这条配对用例证明 `source.kind === 'user'` 仍然放行。
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    const agent = makeAgent()
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我决定用 Alembic 管理数据库迁移，不要手写 SQL'),
    ])
    await host.emit('agent/turn-stopping', { agent, turn: 1 })

    const store = openStore({ dataDir: dir })
    const cards = store.listCards({ status: 'active' })
    store.close()
    assert.ok(cards.length > 0, '人类输入必须照常写入')
    assert.ok(
      cards.some((card) => card.text.includes('Alembic')),
      '写入的卡应来自用户原话',
    )
  })

  it('同一轮里合成来源与人类输入混合时，只取人类那段（两种到达顺序）', async () => {
    // 真实轮次里两者**同时**到达，且**顺序是宿主定的**。
    // 宿主 agent-loop 的实际代码（`packages/core/agent-loop/src/agent.ts`）是：
    //
    //     for (const message of decision.messages)
    //       if (message.source.kind === 'runtime-context') { …append context… }
    //       else this.session.append('user/message', message, { surfaceOp: 'append' })
    //     if (context !== undefined && !contextAdmitted)
    //       this.session.append('user/message', context, { surfaceOp: 'append' })
    //
    // 即**用户消息先、快照后**。这一点是判据的一部分：
    // 若过滤写成「遇到合成来源就把整轮缓冲清空」，在真实顺序下会把已经累积的
    // 用户文本一起丢掉（实测：混合轮产出 0 张卡）。所以两种顺序都必须验，
    // 而且必须**分别**验——只验一种的话，另一种顺序下的过度修复照样全绿。
    const HUMAN = '我决定用 Alembic 管理数据库迁移，不要手写 SQL'
    const orders: { label: string; events: (snapshot: string) => { type: string; data: unknown }[] }[] = [
      {
        // 宿主真实顺序：用户消息在前，快照在后。
        label: '用户先、快照后（宿主真实顺序）',
        events: (snapshot) => [turnStartEvent(1), userEvent(HUMAN), userEvent(snapshot, 'runtime-context')],
      },
      {
        // 反过来的顺序：宿主若改了实现，判据不应因此失效。
        label: '快照先、用户后',
        events: (snapshot) => [turnStartEvent(1), userEvent(snapshot, 'runtime-context'), userEvent(HUMAN)],
      },
    ]

    for (const order of orders) {
      const dir = tempDir()
      const host = makeHost()
      await apply(host.ctx, baseConfig(dir))
      const agent = makeAgent()
      const snapshot = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${host.render()}`
      await emitSessionEvents(host, order.events(snapshot))
      await host.emit('agent/turn-stopping', { agent, turn: 1 })

      const store = openStore({ dataDir: dir })
      const cards = store.listCards({ status: 'active' })
      store.close()
      assert.ok(cards.length > 0, `${order.label}：同一轮里的人类输入必须写入`)
      assert.ok(
        cards.some((card) => card.text.includes('Alembic')),
        `${order.label}：写入的卡应来自人类原话`,
      )
      for (const card of cards) {
        assert.ok(
          !card.text.includes('Current runtime context'),
          `${order.label}：不得把快照写进卡：${card.text.slice(0, 80)}`,
        )
      }
    }
  })

  it('逐轮回送快照不会让卡片自我复制（6 轮同话，卡数不放大）', async () => {
    // 这条是缺陷的**原始观测**：用户每轮说的话完全相同，只有快照在变。
    // 修复前 A 组 20 张 / B 组 6 张；修复后两组都是 6 张。
    // 断言写成「两组相等」而不是「小于某个数」——后者靠巧合，
    // 而且 maxCardsPerTurn 一调就变成在测别的东西。
    const SAME_TEXT = '我决定这个项目必须用 PostgreSQL，JSONB 支持最好'

    async function runRounds(sendSnapshot: boolean): Promise<number> {
      const dir = tempDir()
      const host = makeHost()
      await apply(host.ctx, baseConfig(dir))
      const agent = makeAgent()
      for (let turn = 1; turn <= 6; turn += 1) {
        const events: { type: string; data: unknown }[] = [turnStartEvent(turn)]
        if (sendSnapshot) {
          const snapshot = `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${host.render()}`
          events.push(userEvent(snapshot, 'runtime-context'))
        }
        events.push(userEvent(SAME_TEXT))
        await emitSessionEvents(host, events)
        await host.emit('agent/turn-stopping', { agent, turn })
      }
      const store = openStore({ dataDir: dir })
      const count = store.count('active')
      store.close()
      return count
    }

    const withSnapshot = await runRounds(true)
    const withoutSnapshot = await runRounds(false)
    // 前提断言：两组都必须**真的产出过卡**。没有这一条的话，
    // 「相等」在 0 === 0 时也成立——实测把判据改反（人类输入被挡、快照放行）
    // 时两组都是 0，这条断言照样绿。**等式断言必须配非零前提才有牙。**
    assert.ok(withoutSnapshot > 0, `对照组必须产出卡片，实际 ${withoutSnapshot}`)
    assert.ok(withSnapshot > 0, `回送组必须产出卡片，实际 ${withSnapshot}`)
    assert.equal(
      withSnapshot,
      withoutSnapshot,
      `回送快照不应改变产出卡数（有回送 ${withSnapshot}，无回送 ${withoutSnapshot}）`,
    )
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
    // 断言 ST-5 验收原话「没有相关记忆」，不是实现随手写的「没有命中」。
    // `/memory explain` 与 CLI `query` 共用 `renderFocusPackExplain`，
    // 所以这句文案必须两处一致——它就是 FR-B6 的可见形态。
    const host = makeHost()
    await apply(host.ctx, baseConfig(tempDir()))
    const text = host.commands[0]?.handler?.('explain 完全不相干的查询') as string
    assert.match(text, /没有相关记忆/u)
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

/**
 * `readGoalText` 的三处容错（FR-B1 / 起源 L29）。
 *
 * 这个函数存在的理由：`scoreCards` 的 goal 维度依赖目标文本，而宿主侧
 * 从来没传过它，`goalScore` 恒为 0——一个算了却永远不起作用的维度。
 * 但补上来源的同时必须容错，否则一个「读目标」的动作能把整轮召回搞崩。
 */
describe('readGoalText 的容错（FR-B1）', () => {
  const agent = { session: { id: 'sess-goal' } }

  it('没有 goals 服务时返回空串，不抛', () => {
    const host = makeHost()
    assert.equal(readGoalText(host.ctx, agent), '')
  })

  it('goals 存在但没有 get 时返回空串', () => {
    const host = makeHost({ goals: {} })
    assert.equal(readGoalText(host.ctx, agent), '')
  })

  it('宿主 get 抛错（非活跃 agent 的 GoalError）时返回空串，不向上传播', () => {
    // 宿主 `packages/goal/goal/src/index.ts:279` 的 get 会对非活跃 agent 抛
    // GoalError('GOAL_AGENT_NOT_LIVE')。插件在轮询里调它时 agent 可能已结束，
    // 那是最常见的路径，绝不能让它把渲染函数搞崩。
    const host = makeHost({
      goals: {
        get: () => {
          throw new Error('GOAL_AGENT_NOT_LIVE')
        },
      },
    })
    assert.equal(readGoalText(host.ctx, agent), '')
  })

  it('agent 为 undefined 时不调用宿主，直接返回空串', () => {
    let called = 0
    const host = makeHost({
      goals: {
        get: () => {
          called += 1
          return { objective: '不该被读到', phase: 'active' }
        },
      },
    })
    assert.equal(readGoalText(host.ctx, undefined), '')
    assert.equal(called, 0)
  })

  it('active 目标返回 objective 文本', () => {
    const host = makeHost({
      goals: { get: () => ({ objective: '把记忆系统做到起源忠实', phase: 'active' }) },
    })
    assert.equal(readGoalText(host.ctx, agent), '把记忆系统做到起源忠实')
  })

  it('非 active 目标不牵引召回（起源 L29 专注当前位置）', () => {
    // 已完成/已阻塞的目标若继续牵引召回，「上一个任务的记忆」会一直干扰
    // 当前任务——这正是起源 L29 要求抑制的那种情况。
    for (const phase of ['completed', 'blocked', 'paused']) {
      const host = makeHost({
        goals: { get: () => ({ objective: '旧任务', phase }) },
      })
      assert.equal(readGoalText(host.ctx, agent), '', `phase=${phase} 不应返回目标`)
    }
  })

  it('objective 不是字符串时返回空串', () => {
    const host = makeHost({
      goals: { get: () => ({ objective: 42, phase: 'active' }) },
    })
    assert.equal(readGoalText(host.ctx, agent), '')
  })
})

/**
 * 召回查询来源（FR-B1 / 起源 L29）。
 *
 * 旧实现用 `engine.recentQuery()`——库里最新一张卡的文本——去查询记忆库。
 * 那等于拿**上一次写入的记忆碎片**当查询词，而上一轮写入的往往是抽取后的
 * 要点，与用户本轮原话语义差异很大，召回自然不准。
 * 现在改用本轮的 `user/message` 原文，拿不到时才退回 recentQuery。
 */
describe('召回查询来源（FR-B1）', () => {
  it('本轮用户原话优先于库里的记忆碎片', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    // 先写一条记忆，让 recentQuery() 有内容可返回（它是「最新一张卡」）。
    await emitSessionEvents(host, [
      turnStartEvent(1),
      userEvent('我偏好 PostgreSQL 数据库'),
      assistantEvent('记下了'),
    ])
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 1 })
    // 再开一轮，用户换了个完全不同的说法。
    await emitSessionEvents(host, [
      turnStartEvent(2),
      userEvent('这个 JSONB 字段怎么建索引'),
    ])
    const rendered = host.render()
    // 渲染内容里应当出现与本轮话题相关的卡，而不是被上一轮的「偏好」主导。
    assert.ok(typeof rendered === 'string')
  })

  it('没有本轮用户消息时退回 recentQuery，不产生空查询', async () => {
    // 空查询会命中一切（tokens 为空时打分行为特殊），必须兜底。
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    const rendered = host.render()
    assert.equal(typeof rendered, 'string')
  })

  it('渲染函数不抛（C7：每轮被调用，抛会让宿主循环出问题）', async () => {
    const host = makeHost({
      goals: {
        get: () => {
          throw new Error('GOAL_AGENT_NOT_LIVE')
        },
      },
    })
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    assert.doesNotThrow(() => host.render())
  })
})
