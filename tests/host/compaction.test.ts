/**
 * 压缩回填端到端单测（P1-6 / `docs/2-DSH宿主约束.md:100` 的第 ② 步）。
 *
 * ## 这是什么，以及为什么它重要
 *
 * 宿主在上下文快满时会压缩对话：被压的那段原文被一条摘要取代。
 * **如果插件不在这一刻把尚未落盘的轮次写进记忆，那些对话就永久丢失**——
 * 后续任何一轮都不会再提到它们。这是三条路径里唯一会「静默丢数据」的那个。
 *
 * ## 三个必须分开测的东西
 *
 * | 测什么 | 用什么证明 | 漏了会怎样 |
 * |---|---|---|
 * | 订阅接上了 | 投递事件后卡进了库 | 一条都不会触发，而代码看起来完全正常 |
 * | flush 的时机对 | 压缩前卡不在、压缩后在 | 压缩到达时什么都不做 |
 * | 幂等 | 同一 `compactionId` 两次只记一次，且**重启后**仍然只记一次 | 一个进程内 `Map` 也能让「两次」变绿 |
 *
 * 第三条是这里最重要的一条：一个只靠内存 `Map` 的实现能让「同一进程内两次
 * 只记一次」全绿，但它在跨进程时就是零——所以**必须有一条从磁盘重开的用例**。
 *
 * ## 反向验证过的判据（写在这里，免得后人以为它们多余）
 *
 * - 「压缩前卡不在」这个前提断言不是装饰：没有它，「压缩后在」可能绿在
 *   `turn-stopping` 已经写过卡上（那样 flush 删掉整段也测不出来）。
 * - 每条的 `readCards` 都走磁盘：幂等键影响的是「日志里有没有这条记录」，
 *   只看内存视图看不出区别。
 *
 * @module tests/host/compaction.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../../src/index.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { flushPendingTurn, parseCompactionSummary } from '../../src/host/engine/compaction.ts'
import type { HostContext } from '../../src/host/adapter.ts'
import { openStore } from '../../src/store/store.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

const tempDirs: string[] = []

/** 建临时目录并登记清理。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-compaction-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

// ---- 记录型假宿主（与 `plugin.test.ts` 同形，这里独立一份） ----------------

/** 一次动态上下文注册记录。 */
interface ContextRegistration {
  name: string
  order?: number
  text: string | (() => string)
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
  subscriptions: Subscription[]
  logs: string[]
  emit: (event: string, ...payload: unknown[]) => Promise<void>
  render: (index?: number) => string
}

/**
 * 造一个能力齐全的记录型假宿主。
 *
 * 不装任何 DSH 包：适配层的窄接口正是为此设计的（C8）。
 *
 * @param clock - 可选的幽灵时钟，用于让引擎时刻可控。
 * @returns 假宿主。
 */
function makeHost(): RecordingHost {
  const contexts: ContextRegistration[] = []
  const subscriptions: Subscription[] = []
  const logs: string[] = []

  const ctx: HostContext = {
    systemPrompt: {
      context: (options) => {
        contexts.push(options as ContextRegistration)
        return () => {}
      },
      section: (options) => {
        // 生产代码绝不该走 section（C4：会破坏 KV 前缀缓存）。这里刻意
        // 也接住它：真走到这一步时，下面的断言会看到多余的注册。
        contexts.push(options as ContextRegistration)
        return () => {}
      },
    },
    on: (event, listener) => {
      subscriptions.push({ event, listener })
      return () => {}
    },
    commands: { register: () => () => {} },
    logger: {
      info: (message) => logs.push(`info:${message}`),
      warn: (message) => logs.push(`warn:${message}`),
      error: (message) => logs.push(`error:${message}`),
      debug: (message) => logs.push(`debug:${message}`),
    },
    interval: () => () => {},
    effect: (fn) => {
      void fn
      return () => {}
    },
  }

  return {
    ctx,
    contexts,
    subscriptions,
    logs,
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

/** 造一个假 agent。 */
function makeAgent(): unknown {
  return { session: { id: 'sess-test' } }
}

/** 造一条用户消息事件。 */
function userEvent(text: string): { type: string; data: unknown } {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } }
}

/** 造一条助手消息事件。 */
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

/** 基础配置：临时目录。 */
function baseConfig(dir: string): Record<string, unknown> {
  return {
    storage: { dataDir: dir },
    // 关掉夜整理，避免定时器污染这里要测的写入计数。
    consolidation: { enabled: false },
    reminder: { enabled: false },
  }
}

/**
 * 造一条压缩摘要事件（宿主真实载荷形状）。
 *
 * @param over - 覆盖 `compactionId` 与 `shadowedSeqs`。
 * @returns 会话事件。
 */
function summaryEvent(over: {
  compactionId?: string; shadowedSeqs?: number[]; shadowedRange?: { start: number; end: number }
} = {}): { type: string; data: unknown } {
  return {
    type: 'compaction/summary',
    data: {
      compactionId: over.compactionId ?? 'c1',
      sourceCommandId: 'cmd-1',
      summary: [{ type: 'text', text: '用户决定了缓存方案。' }],
      shadowedRange: over.shadowedRange ?? { start: 1, end: 3 },
      shadowedSeqs: over.shadowedSeqs ?? [1, 2, 3],
      shadowedTokenCount: 120,
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
  }
}

/** 从磁盘重放读活跃卡（**必须读磁盘**：幂等键影响的是日志里有没有这条记录）。 */
function readCards(dir: string): { text: string }[] {
  const store = openStore({ dataDir: dir })
  const cards = store.listCards({ status: 'active' })
  store.close()
  return cards
}

/** 直接在某个目录上开一个引擎（用于验证跨进程的台账恢复）。 */
function openEngineAt(dir: string): { engine: MemoryEngine; close: () => void } {
  const store = openStore({ dataDir: dir })
  const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ })
  return { engine, close: () => store.close() }
}

describe('压缩载荷解析（绝不抛错）', () => {
  it('解析出 compactionId、被吞 seq 与摘要文本', () => {
    const parsed = parseCompactionSummary(summaryEvent())
    assert.notEqual(parsed, null)
    assert.equal(parsed?.compactionId, 'c1')
    assert.deepEqual(parsed?.shadowedSeqs, [1, 2, 3])
    assert.deepEqual(parsed?.shadowedRange, { start: 1, end: 3 })
    assert.equal(parsed?.shadowedTokenCount, 120)
    // 摘要被取成文本：它是「被压掉内容的唯一残留」，取不到就等于什么都没救。
    assert.match(parsed?.summaryText ?? '', /缓存方案/u)
  })

  it('非压缩类型返回 null', () => {
    assert.equal(parseCompactionSummary({ type: 'user/message', data: {} }), null)
    assert.equal(parseCompactionSummary({ type: 'compaction/start', data: { compactionId: 'c1' } }), null)
  })

  it('载荷畸形一律返回 null 而不抛错', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      'not-an-object',
      42,
      {},
      { type: 'compaction/summary' },
      { type: 'compaction/summary', data: null },
      { type: 'compaction/summary', data: 'nope' },
      { type: 'compaction/summary', data: {} },
      { type: 'compaction/summary', data: { compactionId: '' } },
      { type: 'compaction/summary', data: { compactionId: 42 } },
      { type: 'compaction/summary', data: { compactionId: null } },
    ]
    for (const event of malformed) {
      // 逐条 doesNotThrow：**压缩路径是宿主的**，这里抛异常会让宿主的压缩
      // 失败，而压缩失败 = 用户直接丢掉上下文。
      assert.doesNotThrow(() => parseCompactionSummary(event))
      assert.equal(parseCompactionSummary(event), null, `畸形载荷必须返回 null：${JSON.stringify(event)}`)
    }
  })

  it('缺 compactionId 时拒绝回填（宁可这次不救，也不留无法去重的路径）', () => {
    // 没有 compactionId 就无法跨进程认出「同一次压缩投递了两次」，
    // 于是每次重投都会再 flush 一遍。宁可这一次不回填（下一轮
    // `turn-stopping` 还能写），也不要留下一个无法去重的处理路径。
    const parsed = parseCompactionSummary({
      type: 'compaction/summary',
      data: { summary: [{ type: 'text', text: 'x' }], shadowedSeqs: [1] },
    })
    assert.equal(parsed, null)
  })

  it('shadowedSeqs 里的非数字项被丢弃，不是让整条失败', () => {
    const parsed = parseCompactionSummary({
      type: 'compaction/summary',
      data: { compactionId: 'c1', shadowedSeqs: [1, 'x', 3, null, 5] },
    })
    // 「吞了哪些 seq」是观测信息：其中一项不合法不该让整次回填消失，
    // 那等于因为一个数字坏了就不救整轮对话。
    assert.deepEqual(parsed?.shadowedSeqs, [1, 3, 5])
  })

  it('start > end 的区间被接受（宿主的合法形态）', () => {
    const parsed = parseCompactionSummary(summaryEvent({ shadowedRange: { start: 9, end: 4 } }))
    // 宿主源码明确写：一次 replace 把新摘要节点放到旧区间位置后，
    // start 可以大于 end。这里若校验 start <= end，合法数据会被静默丢掉。
    assert.deepEqual(parsed?.shadowedRange, { start: 9, end: 4 })
  })
})

describe('压缩到达时 flush 未落盘的轮次（P1-6 第 ② 步）', () => {
  /**
   * 造一个「有一轮对话还没落盘」的场景。
   *
   * 关键：**不投 `agent/turn-stopping`**——那正是「还没落盘」的定义。
   *
   * @returns 宿主、目录与预期的用户原话。
   */
  async function hostWithPendingTurn(): Promise<{ host: RecordingHost; dir: string; userText: string }> {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    const userText = '我决定用 SQLite 存事件日志，因为单机能满足，不需要分布式'
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent(userText))
    await host.emit('session/event', { id: 'sess-test' }, assistantEvent('好，那就用 SQLite，注意 WAL 模式。'))
    return { host, dir, userText }
  }

  it('压缩把尚未落盘的那一轮写进库（删掉 flush 就红）', async () => {
    const { host, dir } = await hostWithPendingTurn()
    // 前提断言：压缩**之前**库里必须没有这张卡。没有这条，「压缩后有」
    // 可能绿在别的原因上（比如 turn-stopping 已经写过），flush 整段删掉
    // 也测不出来。
    assert.equal(readCards(dir).length, 0, '前提：压缩前这一轮还没落盘')

    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())

    const cards = readCards(dir)
    assert.ok(cards.length > 0, '压缩到达时必须把未落盘的轮次写进库')
    assert.ok(
      cards.some((card) => card.text.includes('SQLite')),
      `救回的卡里必须有那轮的用户原话，实际：${cards.map((card) => card.text).join(' | ')}`,
    )
  })

  it('flush 之后轮次缓冲被清空（不清会重复写入，也会与下一轮错配）', async () => {
    const { host, dir } = await hostWithPendingTurn()
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())
    const afterFlush = readCards(dir).length

    // 缓冲若没清，下一次 turn-stopping 会把同一段内容再写一遍。卡片的幂等键
    // 会挡住完全相同的重复，但「与下一轮拼起来」是挡不住的——那会把 A 轮的
    // 模型回复记成 B 轮的上下文，而错配在数据面上看不出来。
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 1 })
    assert.equal(readCards(dir).length, afterFlush, 'flush 后缓冲必须已清空，重复触发不该新增卡')
  })

  it('中断在压缩点上也不丢：先压缩、再 turn-stopping', async () => {
    const { host, dir } = await hostWithPendingTurn()
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())
    const atCompaction = readCards(dir).length
    assert.ok(atCompaction > 0, '前提：压缩时已经写进去了')

    // 宿主在压缩后仍可能投一次 turn-stopping（同一轮结束）。行为必须稳定：
    // 不重复写、不报错、不丢。这是「压缩落在 turn 中间」的真实时序。
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 1 })
    assert.equal(readCards(dir).length, atCompaction)
  })

  it('没有可写内容时压缩不抛错、也不写卡', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    // 一次都没有会话事件就来压缩：`turnBuffers` 里什么都没有。
    assert.doesNotThrow(() => host.render())
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())
    // 不抛错是硬要求（宿主的压缩路径）；不写卡也是对的——没东西可写。
    assert.equal(readCards(dir).length, 0)
    assert.equal(host.logs.filter((line) => line.startsWith('error:')).length, 0)
  })

  it('只有助手文本的残留缓冲：不写卡（凭空造卡等于编造事实）', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    // 这是真实的残留形态：`turn-stopping` 在 `userText.length === 0` 时提前
    // return（`src/index.ts` 在 `delete` 之前），**缓冲没被 delete**，于是只剩
    // 助手文本的缓冲会留到下一次压缩。
    await host.emit('session/event', { id: 'sess-test' }, assistantEvent('这是上一轮的模型回复，没有对应的用户提问。'))

    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())
    assert.equal(readCards(dir).length, 0, '没有用户原话时不该凭空造卡')
    // **诚实边界**：`clear` 这个标志在端到端层面观测不到——`turn/start` 本来
    // 就会重置缓冲，所以「清没清」不影响下一轮。它的真正判据在
    // `flushPendingTurn` 的纯函数用例里（见下面「flushPendingTurn 的规则」）。
    // 这条用例只守「不凭空造卡」这一半。
  })

  it('压缩与下一轮交错时，两轮内容不会串台', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())
    const afterCompaction = readCards(dir).length
    assert.ok(afterCompaction > 0, '前提：第一轮已经被压缩回填救回来了')

    // 第二轮：换成另一件事，且**带明确信号词**（否则会卡在抽取闸门上，
    // 让这条用例红在一个与缓冲无关的原因上）。
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(2))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 PostgreSQL 存业务数据，因为要支持多机写入'))
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 2 })

    const texts = readCards(dir).map((card) => card.text).join(' | ')
    assert.ok(texts.includes('PostgreSQL'), `第二轮必须独立写进去，实际：${texts}`)
    // 串台判据：第二轮写出来的卡里不该出现第一轮的内容。缓冲若没在压缩后
    // 清空，两轮的 userText 会被 join 成一段，写出一张同时含两件事的卡。
    const postgresCards = readCards(dir).filter((card) => card.text.includes('PostgreSQL'))
    for (const card of postgresCards) {
      assert.ok(!card.text.includes('Redis'), `第二轮不该混进第一轮内容，实际：${card.text}`)
    }
  })

  it('压缩前的事件累积不受影响（摘要不进缓冲）', async () => {
    const { host, dir } = await hostWithPendingTurn()
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent())
    // 摘要事件本身若被 accumulateEvent 当成消息内容，它会被写进卡里。
    // `accumulateEvent` 只认 user/message 与 assistant/message，未知 type 直接
    // return；这条断言守的就是那一行分派没被改坏。
    const texts = readCards(dir).map((card) => card.text).join(' | ')
    assert.ok(!texts.includes('用户决定了缓存方案'), `摘要正文不能进卡，实际：${texts}`)
  })
})

describe('压缩回填的跨进程幂等（P1-6）', () => {
  it('同一个 compactionId 投递两次只记一次账', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))

    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-dup' }))
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-dup' }))

    const { engine, close } = openEngineAt(dir)
    const stats = engine.compactionStats()
    // 「该丢弃的丢弃」方向：两次投递，一条记录。
    assert.equal(stats.count, 1, '同一个 compactionId 两次投递只能记一条')
    // deliveries 仍要加：宿主重投这件事本身必须可见，否则「重投了多少次」
    // 在数据面上完全不可查。
    assert.equal(stats.duplicateDeliveries, 1, '重复投递必须被记下来')
    close()
  })

  it('该更新的更新：同 id 不同内容重投，台账里是最新内容', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))

    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({
      compactionId: 'c-upd', shadowedSeqs: [1, 2, 3],
    }))
    // 同一个 compactionId，但被吞的 seq 变了（宿主重投时可能带上更新的集合）。
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({
      compactionId: 'c-upd', shadowedSeqs: [4, 5],
    }))

    const { engine, close } = openEngineAt(dir)
    const stats = engine.compactionStats()
    // 这一半最容易被漏：「该丢弃的丢弃」测绿了，更新被静默丢弃照样绿——
    // 而真实数据面判重复时就会静默丢弃（`deriveIdempotencyKey` 的
    // `edge` / `put` 分支都在这上面踩过）。
    assert.equal(stats.count, 1)
    assert.deepEqual(stats.lastShadowedSeqs, [4, 5], '台账必须反映最新一次投递的内容')
    close()
  })

  it('跨进程：重启后同一 compactionId 仍然认得出来（内存 Map 过不了这条）', async () => {
    const dir = tempDir()

    // ---- 第一个进程：写一次压缩 ----
    const first = makeHost()
    await apply(first.ctx, baseConfig(dir))
    await first.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await first.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))
    await first.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-restart' }))
    const cardsAfterFirst = readCards(dir).length

    const firstEngine = openEngineAt(dir)
    // 前提：第一个进程真的记下了这次压缩。没有这条，「重启后认出」可能
    // 绿在「两个进程都从零开始」上。
    assert.equal(firstEngine.engine.compactionStats().count, 1, '前提：第一次必须真的记过')
    firstEngine.close()

    // ---- 第二个进程：全新宿主、全新引擎，同一个 dataDir ----
    const second = makeHost()
    await apply(second.ctx, baseConfig(dir))
    // 投递同样的 compactionId：必须认出来，不再 flush。
    await second.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-restart' }))

    const secondEngine = openEngineAt(dir)
    const stats = secondEngine.engine.compactionStats()
    // 只靠内存 Map 的实现：第二个进程从零开始，这里会是 2（两条记录），
    // 或者 count=1 但 deliveries=1（说明它压根没看到第一次）。
    assert.equal(stats.count, 1, '跨进程必须只留一条记录')
    assert.equal(stats.duplicateDeliveries, 1, '第二个进程必须认得出这是重复投递')
    assert.equal(readCards(dir).length, cardsAfterFirst, '重复投递不该再写卡')
    secondEngine.close()
  })

  it('不同 sessionId 的同名 compactionId 是两次不同的压缩', async () => {
    const dir = tempDir()
    const host = makeHost()
    await apply(host.ctx, baseConfig(dir))

    await host.emit('session/event', { id: 'sess-a' }, summaryEvent({ compactionId: 'c-same' }))
    await host.emit('session/event', { id: 'sess-b' }, summaryEvent({ compactionId: 'c-same' }))

    const { engine, close } = openEngineAt(dir)
    // 幂等键含 sessionId：`compactionId` 由宿主生成，我们不能假设它全局唯一。
    assert.equal(engine.compactionStats().count, 2, '不同会话的同名 compactionId 是两次压缩')
    close()
  })

  it('重复投递不再 flush：缓冲原样保留（不能把下一轮内容提前写掉）', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-keep' }))
    const afterFirst = readCards(dir).length
    assert.ok(afterFirst > 0, '前提：第一次投递真的回填了')

    // 宿主重投同一个 compactionId —— 在这两次投递之间，**下一轮已经开始累积**。
    // 这正是这个分支存在的理由：重复投递的正确语义是「什么都不做」。
    // 若这里也走 flush 分支，下一轮的用户原话会被提前写掉，而缓冲随之被清空，
    // 于是那一轮真正的 `turn-stopping` 什么都写不出来。
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(2))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 PostgreSQL 存业务数据，因为要支持多机写入'))
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-keep' }))

    // 判据一：重复投递不写卡。
    assert.equal(readCards(dir).length, afterFirst, '重复投递不该写卡')
    // 判据二（这一条才是分支的真正守门）：缓冲还在，下一轮的 turn-stopping
    // 必须能把第二轮写进去。少了它，「重复投递不写卡」可以绿在
    // 「它把缓冲也一起清了」上，而那是更严重的缺陷。
    await host.emit('agent/turn-stopping', { agent: makeAgent(), turn: 2 })
    const texts = readCards(dir).map((card) => card.text).join(' | ')
    assert.ok(texts.includes('PostgreSQL'), `重复投递后第二轮仍必须能在 turn-stopping 落盘，实际：${texts}`)
  })
})

describe('压缩回填的可观测（FR-F1）', () => {
  it('health() 能查到被吞的 seq 区间（新字段在返回类型里）', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({
      compactionId: 'c-obs', shadowedSeqs: [11, 12, 13], shadowedRange: { start: 11, end: 13 },
    }))

    const { engine, close } = openEngineAt(dir)
    const health = engine.health()
    // 新字段必须挂在这里：`health()` 是「这个库现在什么状态」的唯一入口。
    assert.equal(health.compaction.count, 1)
    assert.deepEqual(health.compaction.lastShadowedSeqs, [11, 12, 13])
    assert.deepEqual(health.compaction.lastShadowedRange, { start: 11, end: 13 })
    assert.equal(health.compaction.shadowedSeqsTotal, 3)
    // 其他字段不能被新字段挤坏。
    assert.equal(typeof health.healthy, 'boolean')
    assert.equal(typeof health.active, 'number')
    close()
  })

  it('从未压缩过时观测值是零值形状而不是崩溃', async () => {
    const dir = tempDir()
    const { engine, close } = openEngineAt(dir)
    const health = engine.health()
    assert.equal(health.compaction.count, 0)
    assert.equal(health.compaction.lastAt, null)
    assert.deepEqual(health.compaction.lastShadowedSeqs, [])
    close()
  })

  it('flushedCards 记的是真的写了几张（0 与「没跑过」不同）', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))
    await host.emit('session/event', { id: 'sess-test' }, summaryEvent({ compactionId: 'c-count' }))

    const { engine, close } = openEngineAt(dir)
    const stats = engine.compactionStats()
    const actual = readCards(dir).length
    // 台账里的数字必须与磁盘上的实际卡数一致：一个永远写 0 的实现会让
    // 「回填跑过了」与「回填救回了东西」再也分不开。
    assert.equal(stats.lastFlushedCards, actual, '台账的回填数必须等于磁盘上真实的卡数')
    assert.ok(actual > 0, '前提：这一轮确实写进去了')
    close()
  })
})

describe('压缩回填绝不影响宿主（C8 / NFR-1）', () => {
  it('载荷畸形的压缩事件不抛错，焦点包照常渲染', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    await host.emit('session/event', { id: 'sess-test' }, turnStartEvent(1))
    await host.emit('session/event', { id: 'sess-test' }, userEvent('我决定用 Redis 做缓存，一致性要求不高'))
    const before = host.render()

    const malformed: unknown[] = [
      { type: 'compaction/summary' },
      { type: 'compaction/summary', data: null },
      { type: 'compaction/summary', data: { compactionId: 12345 } },
      { type: 'compaction/summary', data: { compactionId: 'c1', shadowedRange: 'nope', shadowedSeqs: {} } },
    ]
    for (const event of malformed) {
      // 这是宿主的压缩路径。插件在这里抛异常 = 宿主的压缩失败 =
      // 用户直接失去上下文，比丢几条记忆严重得多。
      await assert.doesNotReject(async () => {
        await host.emit('session/event', { id: 'sess-test' }, event)
      })
    }

    // 焦点包必须还能渲染，且内容没被畸形事件搞坏。
    assert.match(host.render(), /Redis/u, '畸形压缩事件之后焦点包不能坏')
    assert.ok(host.logs.filter((line) => line.startsWith('error:')).length === 0, '畸形载荷不该报 error')
    void before
  })

  it('sessionId 缺失时直接跳过（不崩、不误记到别的会话）', async () => {
    const host = makeHost()
    const dir = tempDir()
    await apply(host.ctx, baseConfig(dir))
    // 宿主理论上总会给 session.id；这里测的是「拿不到就跳过」而非崩掉。
    await assert.doesNotReject(async () => {
      await host.emit('session/event', {}, summaryEvent())
      await host.emit('session/event', undefined, summaryEvent())
      await host.emit('session/event', { id: 42 }, summaryEvent())
    })
    const { engine, close } = openEngineAt(dir)
    assert.equal(engine.compactionStats().count, 0, '会话不明时不该记账')
    close()
  })
})

/**
 * 这一组是上面对应用例的**规则层**判据。
 *
 * 为什么必须单独有：端到端层面 `clear` 这个标志观测不到——`turn/start` 本来
 * 就会重置缓冲，所以「压缩后有没有清」不影响下一轮的结果。也就是说
 * 「缓冲被清空了」这个结论在 e2e 里**可能是绿在别的原因上**。三条 `clear`
 * 分支只有在纯函数层才能被精确区分：`false` 分支（写失败保留缓冲）在 e2e 里
 * 更是完全不可达——要让它可达就得先让 `writeTurn` 抛错。
 */
describe('flushPendingTurn 的规则（clear 的两义）', () => {
  /** 一个记录型的写入替身。 */
  function makeWriter(outcome: { written: number; skipped: number } | Error): {
    calls: { input: unknown }[]
    write: (input: unknown) => { written: number; skipped: number }
  } {
    const calls: { input: unknown }[] = []
    return {
      calls,
      write: (input) => {
        calls.push({ input })
        if (outcome instanceof Error) throw outcome
        return outcome
      },
    }
  }

  it('没有用户原话：不调用写入，但要求清缓冲（错配比丢失更坏）', () => {
    const writer = makeWriter({ written: 0, skipped: 0 })
    const result = flushPendingTurn(
      { userText: '', assistantText: '上一轮的模型回复没被清掉', turn: 7 },
      { sessionId: 's-1', domain: 'work', at: T0, write: writer.write },
    )
    // 前提：写入函数一次都不能被调用。没有这条，「clear=true」可能绿在
    // 「写了个空轮」上，而空轮会凭空造卡。
    assert.equal(writer.calls.length, 0, '没有用户原话时不该调用写入')
    assert.equal(result.wrote, false)
    assert.equal(result.written, 0)
    // 这一半是本次改动最易写错的地方：不写 ≠ 不清。
    assert.equal(result.clear, true, '没有用户原话时必须要求清缓冲')
    assert.equal(result.error, null)
  })

  it('有用户原话：写一次，并把写到的张数带回去', () => {
    const writer = makeWriter({ written: 2, skipped: 1 })
    const result = flushPendingTurn(
      { userText: '我决定用 Redis 做缓存', assistantText: '好', turn: 3 },
      { sessionId: 's-1', domain: 'work', at: T0, write: writer.write },
    )
    assert.equal(writer.calls.length, 1)
    assert.equal(result.wrote, true)
    assert.equal(result.written, 2)
    assert.equal(result.skipped, 1)
    assert.equal(result.clear, true, '写成功了才允许丢缓冲')
    assert.equal(result.error, null)
  })

  it('写入抛错：不丢缓冲、不抛出去、把原因带回来', () => {
    const writer = makeWriter(new Error('磁盘满了'))
    let result: ReturnType<typeof flushPendingTurn> | undefined
    // 这里是宿主的压缩路径：抛异常会让宿主的压缩失败，用户直接丢上下文。
    assert.doesNotThrow(() => {
      result = flushPendingTurn(
        { userText: '我决定用 Redis 做缓存', assistantText: '好', turn: 1 },
        { sessionId: 's-1', domain: 'work', at: T0, write: writer.write },
      )
    })
    assert.equal(result?.wrote, true)
    assert.equal(result?.written, 0)
    // 关键：clear 必须是 false。若这里返回 true，缓冲会被丢掉，
    // 而那次写入已经失败了 —— 这段对话就永久消失了（正是本任务要防的事）。
    assert.equal(result?.clear, false, '写入失败时缓冲必须保留')
    assert.match(result?.error ?? '', /磁盘满了/u)
  })

  it('TurnInput 的字段按约定成形（turn 未知时退化为 0）', () => {
    const writer = makeWriter({ written: 1, skipped: 0 })
    flushPendingTurn(
      { userText: '我决定用 Redis 做缓存', assistantText: '好', turn: null },
      { sessionId: 's-9', domain: 'life', at: T0 + 1, write: writer.write },
    )
    const input = writer.calls[0]?.input as Record<string, unknown> | undefined
    assert.notEqual(input, undefined)
    // 压缩路径没有真实的 step/seq（那属于宿主的事件流），统一填 0。
    // 断言这两个值是为了防止将来有人「顺手」把宿主 seq 塞进来——
    // 那会让记忆卡看起来能追溯到宿主事件，其实追不到。
    assert.equal(input?.step, 0)
    assert.equal(input?.seq, 0)
    assert.equal(input?.turn, 0)
    assert.equal(input?.sessionId, 's-9')
    assert.equal(input?.domain, 'life')
    assert.equal(input?.at, T0 + 1)
  })
})
