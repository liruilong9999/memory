/**
 * 记忆引擎端到端单测。
 *
 * 引擎是「数据面 + 巩固面 + 打分面」的装配层，本身不依赖宿主（NFR-7），
 * 因此可以完整地用真实 MemoryStore + 临时目录跑端到端流程。
 *
 * 对应需求：FR-A1/A2、FR-B1..B6、FR-C1/C4、FR-D2、FR-E1/E3、FR-F1/F3、
 * ST-1（重启一致）、ST-2（幂等）、ST-5（不编造）、SC-3（时间感）。
 *
 * @module tests/host/engine.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'
import type { MemoryLogEntry } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeCard, makeTempDir, removeDirContents } from '../store/helpers.ts'
import { makeConfig } from '../consolidate/fixtures.ts'
import { pickDue } from '../../src/time/clock.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const tempDirs: string[] = []

/** 建临时目录并登记。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-engine-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/** 造一个假时钟，可手动推进。 */
function makeClock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

/**
 * 打开一个引擎 + store，并登记清理。
 *
 * `config` 用巩固面的 `makeConfig`（支持任意段覆盖），
 * 而不是 `tests/store/helpers.ts` 那个只覆盖 storage 段的版本。
 */
function openEngine(options: {
  config?: MemoryConfig
  clock?: () => number
  logs?: MemoryLogEntry[]
  dataDir?: string
} = {}): { store: MemoryStore; engine: MemoryEngine; dir: string } {
  const config = options.config ?? DEFAULT_CONFIG
  const dir = options.dataDir ?? tempDir()
  if (options.dataDir === undefined) tempDirs.push(dir)
  const store = openStore({ dataDir: dir, config })
  const engine = new MemoryEngine({
    store,
    config,
    timeZone: TZ,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logs === undefined ? {} : { onLog: (entry) => options.logs!.push(entry) }),
  })
  return { store, engine, dir }
}

/** 一轮对话的输入。 */
function turnInput(over: {
  userText?: string
  assistantText?: string
  turn?: number
  at?: number
} = {}) {
  return {
    sessionId: 's-1',
    turn: over.turn ?? 1,
    step: 1,
    seq: over.turn ?? 1,
    userText: over.userText ?? '决定这个项目用 Qt5 开发，沿用现有 cmake 配置',
    assistantText: over.assistantText ?? '',
    domain: 'work' as const,
    at: over.at ?? T0,
  }
}

describe('MemoryEngine 写入（FR-A1 / FR-A2）', () => {
  it('有信号的对话写入记忆卡', () => {
    const { store, engine } = openEngine()
    const result = engine.writeTurn(turnInput())
    assert.ok(result.written > 0)
    assert.equal(store.count('active'), result.written)
  })

  it('无信号的寒暄不写入', () => {
    const { engine } = openEngine()
    const result = engine.writeTurn(turnInput({ userText: '你好' }))
    assert.equal(result.written, 0)
  })

  it('同一轮重复写入幂等，卡数不变（ST-2）', () => {
    const { store, engine } = openEngine()
    const input = turnInput()
    const first = engine.writeTurn(input)
    const second = engine.writeTurn(input)
    // 第一次真写入，第二次被幂等键全挡掉：
    // WriteSummary.cards 只装「已写入」的卡，所以第二次为空、skipped 等于首轮写入数。
    assert.ok(first.written > 0)
    assert.equal(second.written, 0)
    assert.equal(second.cards.length, 0)
    assert.equal(second.skipped, first.written)
    assert.equal(store.count('active'), first.written)
  })

  it('写入的卡带完整来源指针（FR-A4）', () => {
    const { engine } = openEngine()
    const result = engine.writeTurn(turnInput({ turn: 7 }))
    for (const card of result.cards) {
      assert.equal(card.source.sessionId, 's-1')
      assert.equal(card.source.turn, 7)
      assert.equal(card.source.seq, 7)
    }
  })

  it('写入时记录结构化日志（FR-F1）', () => {
    const logs: MemoryLogEntry[] = []
    const { engine } = openEngine({ logs })
    engine.writeTurn(turnInput())
    assert.ok(logs.some((entry) => entry.kind === 'write'))
  })

  it('写入摘要带回命中的信号词', () => {
    const { engine } = openEngine()
    const result = engine.writeTurn(turnInput({ userText: '记住：部署必须走 CI，不要再手动上传' }))
    assert.ok(result.signals.length > 0)
  })
})

describe('MemoryEngine 召回（FR-B1..B6 / FR-E1 / FR-E3）', () => {
  it('相关查询能召回已写入的卡', () => {
    const { engine } = openEngine()
    engine.writeTurn(turnInput())
    const result = engine.recall('这个项目用什么开发？')
    assert.ok(result.pack.cards.length > 0)
    assert.ok(result.text.length > 0)
  })

  it('空库召回返回空包并给出明确措辞（ST-5 不编造）', () => {
    const { engine } = openEngine()
    const result = engine.recall('我们昨天聊了什么？')
    assert.equal(result.pack.cards.length, 0)
    assert.equal(result.pack.empty, true)
  })

  it('无关话题时不硬塞记忆（FR-B6）', () => {
    const { engine } = openEngine()
    engine.writeTurn(turnInput({ userText: '决定这个项目用 Qt5 开发，沿用现有 cmake 配置' }))
    const result = engine.recall('今天晚饭吃什么比较好')
    assert.equal(result.pack.empty, true)
  })

  it('焦点包不超过 maxCards（FR-B2）', () => {
    const config = makeConfig({ recall: { maxCards: 2 } })
    const { engine } = openEngine({ config })
    for (let index = 0; index < 8; index += 1) {
      engine.writeTurn(turnInput({
        userText: `决定部署方案 ${index}：走 CI 流水线，注意回滚策略`,
        turn: index + 1,
        at: T0 + index,
      }))
    }
    const result = engine.recall('部署方案')
    assert.ok(result.pack.cards.length <= 2)
  })

  it('token 预算不超限（FR-E3）', () => {
    const config = makeConfig({ recall: { tokenBudget: 60 } })
    const { engine } = openEngine({ config })
    for (let index = 0; index < 6; index += 1) {
      engine.writeTurn(turnInput({
        userText: `决定部署方案 ${index}：走 CI 流水线，注意回滚策略与灰度发布顺序`,
        turn: index + 1,
        at: T0 + index,
      }))
    }
    const result = engine.recall('部署方案')
    assert.ok(result.pack.tokens <= 60)
  })

  // 下面三条是一组，缺一不可（FR-B7「看到与使用分离」，起源 L29·第 5 条·专注当前位置）。
  //
  // 为什么必须是三条而不是一条：只证明「recall 不写」的话，把 recall 整个删掉
  // 也能变绿——那是「测试替实现打掩护」。只证明「confirmRecall 写」的话，
  // 无法发现有人又把 touch 塞回 recall 里。两条只读入口 + 一条写入口，
  // 才能同时钉住「正反馈被拆走了」和「正反馈还在」。
  it('recall 是只读的：访问计数、强度、最近访问时间都不变（看到 ≠ 使用）', () => {
    const { store, engine } = openEngine()
    const written = engine.writeTurn(turnInput())
    const targetId = written.cards[0]!.id
    const before = store.getCard(targetId)!
    const seqBefore = store.snapshot().lastSeq
    const result = engine.recall('项目用什么开发')
    assert.ok(result.pack.cards.length > 0, '前提：确实召回到了东西，否则本条测试无意义')
    const after = store.getCard(targetId)!
    assert.equal(after.accessCount, before.accessCount, '召回不得改变访问计数')
    assert.equal(after.strength, before.strength, '召回不得改变强度')
    assert.equal(after.lastAccessAt, before.lastAccessAt, '召回不得改变最近访问时间')
    assert.equal(store.snapshot().lastSeq, seqBefore, '召回不得写日志')
  })

  it('peek 是只读的：既不写库也不计数（CLI query 走的就是这条）', () => {
    const { store, engine } = openEngine()
    const written = engine.writeTurn(turnInput())
    const targetId = written.cards[0]!.id
    const before = store.getCard(targetId)!
    const seqBefore = store.snapshot().lastSeq
    const recallsBefore = engine.metrics().recalls
    const result = engine.peek('项目用什么开发')
    assert.ok(result.pack.cards.length > 0, '前提：peek 要真的能召回到东西')
    const after = store.getCard(targetId)!
    assert.equal(after.accessCount, before.accessCount)
    assert.equal(after.strength, before.strength)
    assert.equal(store.snapshot().lastSeq, seqBefore, 'peek 不得写日志')
    // peek 连「召回次数」都不该动：它不进可观测指标，否则运维查一眼就污染 F3。
    assert.equal(engine.metrics().recalls, recallsBefore, 'peek 不得增加召回计数')
  })

  it('confirmRecall 才加深记忆：访问计数 +1、强度上升、最近访问时间更新', () => {
    const { store, engine } = openEngine()
    const written = engine.writeTurn(turnInput())
    const targetId = written.cards[0]!.id
    const before = store.getCard(targetId)!
    const confirmedAt = T0 + 5000
    const count = engine.confirmRecall([targetId], confirmedAt)
    assert.equal(count, 1)
    const after = store.getCard(targetId)!
    assert.equal(after.accessCount, before.accessCount + 1, '确认后访问计数 +1')
    assert.ok(after.strength > before.strength, '确认后强度必须上升')
    assert.equal(after.lastAccessAt, confirmedAt, '确认后最近访问时间应更新')
  })

  it('confirmRecall 幂等去重、忽略未知与归档卡片、强度封顶 1', () => {
    const { store, engine } = openEngine()
    const written = engine.writeTurn(turnInput())
    const targetId = written.cards[0]!.id
    // 同一个 id 传三次只算一次：否则调用方重复上报就能刷强度。
    assert.equal(engine.confirmRecall([targetId, targetId, targetId], T0 + 1), 1)
    // 未知 id 静默跳过：调用方拿到的可能是过期焦点包，不该因此抛错。
    assert.equal(engine.confirmRecall(['no-such-card'], T0 + 2), 0)
    // 归档卡不确认：给归档卡加强度等于让遗忘失效（FR-C2）。
    const archived = store.getCard(targetId)!
    store.append({ op: 'archive', id: archived.id, at: T0 + 3, reason: '测试：归档后不得被确认' }, undefined, T0 + 3)
    assert.equal(engine.confirmRecall([targetId], T0 + 4), 0, '归档卡不得被确认')
    // 强度封顶 1：反复确认不能把强度刷过上限。
    const { store: store2, engine: engine2 } = openEngine()
    const w2 = engine2.writeTurn(turnInput())
    const id2 = w2.cards[0]!.id
    for (let index = 0; index < 50; index += 1) engine2.confirmRecall([id2], T0 + 100 + index)
    assert.ok(store2.getCard(id2)!.strength <= 1, '强度必须封顶 1')
  })

  it('召回记录结构化日志与指标（FR-F1 / FR-F3）', () => {
    const logs: MemoryLogEntry[] = []
    const { engine } = openEngine({ logs })
    engine.writeTurn(turnInput())
    engine.recall('项目用什么开发')
    assert.ok(logs.some((entry) => entry.kind === 'recall'))
    assert.equal(engine.metrics().recalls, 1)
  })

  it('钉住的承诺即使检索没命中也会进入候选（FR-C3 精神）', () => {
    const { store, engine } = openEngine()
    store.putCard(makeCard({
      id: 'pinned-card',
      text: '答应下周交付演示版本',
      kind: 'promise',
      pinned: true,
      createdAt: T0,
      updatedAt: T0,
    }))
    const result = engine.recall('今天天气怎么样')
    assert.ok(result.candidates >= 1)
  })

  it('已归档的卡不进入召回候选', () => {
    const { store, engine } = openEngine()
    store.putCard(makeCard({
      id: 'archived-card',
      text: '决定这个项目用 Qt5 开发',
      status: 'archived',
      createdAt: T0,
      updatedAt: T0,
    }))
    const result = engine.recall('这个项目用什么开发')
    assert.equal(result.pack.cards.length, 0)
  })

  it('同样查询两次结果一致（ST-1 确定性）', () => {
    const clock = makeClock()
    const { engine } = openEngine({ clock: clock.now })
    engine.writeTurn(turnInput())
    const first = engine.recall('项目用什么开发')
    const second = engine.recall('项目用什么开发')
    assert.deepEqual(
      first.pack.cards.map((item) => item.card.id),
      second.pack.cards.map((item) => item.card.id),
    )
  })

  it('候选数被 candidateLimit 约束（NFR-1）', () => {
    const config = makeConfig({ recall: { candidateLimit: 3 } })
    const { engine } = openEngine({ config })
    for (let index = 0; index < 10; index += 1) {
      engine.writeTurn(turnInput({
        userText: `决定部署方案 ${index}：走 CI 流水线`,
        turn: index + 1,
        at: T0 + index,
      }))
    }
    const result = engine.recall('部署方案')
    assert.ok(result.pack.cards.length <= 3)
  })
})

describe('MemoryEngine 时间感（FR-D2 / SC-3）', () => {
  it('首次会话给出「第一次会话」措辞', () => {
    const { engine } = openEngine()
    assert.equal(engine.sinceLastSession(), '这是第一次会话')
  })

  it('新会话启动时算出距上次会话的时长', () => {
    // 「上次会话」由引擎构造时一次性探测（detectLastActivity），
    // 所以验证方式必须是：先用一个引擎写入，再用新引擎重开同一个目录。
    const clock = makeClock()
    const first = openEngine({ clock: clock.now })
    first.engine.writeTurn(turnInput())
    first.store.close()

    clock.advance(3 * HOUR_MS)
    const second = openEngine({ clock: clock.now, dataDir: first.dir })
    assert.ok(second.engine.sinceLastSession().includes('距上次会话'))
    second.store.close()
  })

  it('时间读数由代码计算，不是模型推断', () => {
    const clock = makeClock()
    const first = openEngine({ clock: clock.now })
    first.engine.writeTurn(turnInput())
    first.store.close()

    clock.advance(HOUR_MS)
    const second = openEngine({ clock: clock.now, dataDir: first.dir })
    const text = second.engine.renderTime()
    assert.ok(text.includes('距上次会话'))
    assert.ok(text.includes('由代码计算'))
    second.store.close()
  })

  it('空库的时间读数不含相对时间行', () => {
    const { engine } = openEngine()
    const state = engine.buildTime(T0)
    assert.equal(state.sinceLastSession, null)
    assert.equal(state.sinceLastTurn, null)
  })

  it('到期事项进入时间读数（FR-D3）', () => {
    const clock = makeClock()
    const { store, engine } = openEngine({ clock: clock.now })
    store.putCard(makeCard({
      id: 'due-card',
      text: '提醒我交周报',
      kind: 'promise',
      dueAt: T0 + 1000,
      createdAt: T0,
      updatedAt: T0,
    }))
    clock.advance(2000)
    assert.ok(engine.renderTime().includes('提醒我交周报'))
  })
})

describe('MemoryEngine 整理（FR-C1 / FR-C4）', () => {
  it('整理后返回可读报告', () => {
    const { engine } = openEngine()
    engine.writeTurn(turnInput())
    const report = engine.consolidate(T0 + 30 * 24 * 60 * 60 * 1000)
    assert.ok(report.notes.length > 0)
    assert.ok(report.beforeActive >= report.afterActive)
  })

  it('整理结果落库，重开 store 后仍在（P2 日志是唯一真相源）', () => {
    const dir = tempDir()
    const store = openStore({ dataDir: dir })
    const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    engine.writeTurn(turnInput())
    const report = engine.consolidate(T0 + 30 * 24 * 60 * 60 * 1000)
    store.close()

    const reopened = openStore({ dataDir: dir })
    assert.equal(reopened.count(), store.count())
    assert.equal(report.finishedAt, T0 + 30 * 24 * 60 * 60 * 1000)
    reopened.close()
  })

  it('整理记录结构化日志', () => {
    const logs: MemoryLogEntry[] = []
    const { engine } = openEngine({ logs })
    engine.writeTurn(turnInput())
    engine.consolidate(T0 + 1000)
    assert.ok(logs.some((entry) => entry.kind === 'consolidate'))
  })

  it('整理后 metrics 记录整理时刻', () => {
    const { engine } = openEngine()
    const at = T0 + 5000
    engine.consolidate(at)
    assert.equal(engine.metrics().lastConsolidationAt, at)
  })

  it('两次整理不会重复产生同样的操作（幂等）', () => {
    const clock = makeClock()
    const { engine } = openEngine({ clock: clock.now })
    engine.writeTurn(turnInput())
    const at = T0 + 30 * 24 * 60 * 60 * 1000
    engine.consolidate(at)
    const before = engine.health()
    engine.consolidate(at)
    const after = engine.health()
    assert.equal(before.active, after.active)
    assert.equal(before.archived, after.archived)
  })
})

describe('MemoryEngine 查询与健康（FR-F2 / FR-F5）', () => {
  it('按类型查询', () => {
    const { engine } = openEngine()
    engine.writeTurn(turnInput())
    const facts = engine.query({ kind: 'fact' })
    assert.ok(Array.isArray(facts))
  })

  it('inspect 能取回指定卡（FR-A4）', () => {
    const { engine } = openEngine()
    const written = engine.writeTurn(turnInput())
    const id = written.cards[0]!.id
    assert.equal(engine.inspect(id)?.id, id)
  })

  it('inspect 不存在的 id 返回 undefined', () => {
    const { engine } = openEngine()
    assert.equal(engine.inspect('no-such-card'), undefined)
  })

  it('健康检查报告索引一致性（FR-F5）', () => {
    const { engine } = openEngine()
    engine.writeTurn(turnInput())
    const health = engine.health()
    assert.equal(health.healthy, true)
    assert.equal(health.indexOk, true)
    assert.ok(health.active > 0)
  })

  it('edges 返回空数组表示无关联（不抛错）', () => {
    const { engine } = openEngine()
    const written = engine.writeTurn(turnInput())
    assert.deepEqual(engine.edges(written.cards[0]!.id), [])
  })
})

describe('MemoryEngine 重启一致（ST-1）', () => {
  it('重开后召回结果与重开前一致', () => {
    const dir = tempDir()
    const first = openStore({ dataDir: dir })
    const engineA = new MemoryEngine({ store: first, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    engineA.writeTurn(turnInput())
    const before = engineA.recall('项目用什么开发')
    first.close()

    const second = openStore({ dataDir: dir })
    const engineB = new MemoryEngine({ store: second, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    const after = engineB.recall('项目用什么开发')

    assert.deepEqual(
      before.pack.cards.map((item) => item.card.id),
      after.pack.cards.map((item) => item.card.id),
    )
    second.close()
  })

  it('重开后卡片内容逐字段一致（ST-8 抽查口径）', () => {
    const dir = tempDir()
    const first = openStore({ dataDir: dir })
    const engineA = new MemoryEngine({ store: first, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    const written = engineA.writeTurn(turnInput())
    const beforeCards = written.cards.map((card) => ({ ...first.getCard(card.id)! }))
    first.close()

    const second = openStore({ dataDir: dir })
    for (const card of beforeCards) assert.deepEqual(second.getCard(card.id), card)
    second.close()
  })
})

/**
 * FR-D3 / SC-5 / 起源 L21：到期提醒必须真的能到期。
 *
 * 这组用例锁住一条曾经彻底断裂的链路：早期 `draftToCard` 硬编码
 * `dueAt: null`，`pickDue` 永远返回空数组，FR-D3 在实现层不可能通过。
 * 光测 `parseDue` 不够——必须端到端断言「写入的卡带 dueAt、到点能被捡起」。
 */
describe('冲突标记（FR-B5 / SC-4）', () => {
  it('对同一对象给出不同说法时，双方都标出冲突', () => {
    const dir = makeTempDir()
    const store = openStore({ dataDir: dir })
    const engine = new MemoryEngine({
      store,
      config: makeConfig({ extraction: { domains: [] } }),
      timeZone: TZ,
      clock: () => T0,
    })

    engine.writeTurn({
      sessionId: 's1', turn: 1, step: 0, seq: 0,
      userText: '我决定数据库用 PostgreSQL，它的 JSONB 支持最好',
      assistantText: '好的，PostgreSQL 的 JSONB 确实很适合这个场景。',
      domain: 'work', at: T0,
    })
    engine.writeTurn({
      sessionId: 's1', turn: 2, step: 0, seq: 0,
      userText: 'PostgreSQL 太慢了，我决定改用 MySQL',
      assistantText: '明白，MySQL 在读写性能上确实有优势。',
      domain: 'work', at: T0 + 3600_000,
    })

    const cards = store.listCards({ status: 'active' })
    const conflicting = cards.filter((card) => card.conflictOf.length > 0)
    assert.ok(conflicting.length >= 2, `应有至少两张卡带冲突标记，实际 ${conflicting.length} 张`)

    // 双向性：新卡标记了旧卡，旧卡也必须标记新卡，否则渲染时只有一侧有警告。
    for (const card of conflicting) {
      for (const otherId of card.conflictOf) {
        const other = cards.find((item) => item.id === otherId)
        assert.ok(other !== undefined, `冲突指向的卡 ${otherId} 应存在`)
        assert.ok(
          other.conflictOf.includes(card.id),
          `冲突必须双向：${card.id} 标了 ${otherId}，但对方没标回来`,
        )
      }
    }
    store.close()
  })

  it('不相关的两句话不产生冲突标记', () => {
    const dir = makeTempDir()
    const store = openStore({ dataDir: dir })
    const engine = new MemoryEngine({
      store,
      config: makeConfig({ extraction: { domains: [] } }),
      timeZone: TZ,
      clock: () => T0,
    })

    engine.writeTurn({
      sessionId: 's1', turn: 1, step: 0, seq: 0,
      userText: '我决定数据库用 PostgreSQL，它的 JSONB 支持最好',
      assistantText: '好的。',
      domain: 'work', at: T0,
    })
    engine.writeTurn({
      sessionId: 's1', turn: 2, step: 0, seq: 0,
      userText: '今天下午的会议改到三点，记得带上笔记本',
      assistantText: '好的。',
      domain: 'work', at: T0 + 3600_000,
    })

    const cards = store.listCards({ status: 'active' })
    assert.equal(
      cards.filter((card) => card.conflictOf.length > 0).length,
      0,
      '没有共享实体的话题不应被标成冲突',
    )
    store.close()
  })
})

describe('到期提醒（FR-D3 / SC-5 / 起源 L21）', () => {
  // 2024-01-15 10:00 上海（周一）。
  const MON = Date.UTC(2024, 0, 15, 2, 0, 0)

  function engineAt(dir: string, clock: () => number): { engine: MemoryEngine; store: MemoryStore } {
    const store = openStore({ dataDir: dir })
    return { engine: new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock }), store }
  }

  it('承诺句写入后 dueAt 非空', () => {
    const dir = tempDir()
    const { engine, store } = engineAt(dir, () => MON)
    const summary = engine.writeTurn(turnInput({
      userText: '明天下午三点提醒我交周报，别忘了', at: MON,
    }))
    assert.ok(summary.written > 0, '到期句必须入库，否则 FR-D3 从根上失效')
    const withDue = summary.cards.filter((card) => card.dueAt !== null)
    assert.equal(withDue.length, 1, '应有一张卡带到期时刻')
    store.close()
  })

  it('dueAt 解析到明天 15:00（不是随便一个未来时刻）', () => {
    const dir = tempDir()
    const { engine, store } = engineAt(dir, () => MON)
    const summary = engine.writeTurn(turnInput({
      userText: '明天下午三点提醒我交周报，别忘了', at: MON,
    }))
    const card = summary.cards.find((item) => item.dueAt !== null)!
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, dateStyle: 'short', timeStyle: 'short', hour12: false,
    }).format(new Date(card.dueAt!))
    assert.equal(local, '16/01/2024, 15:00')
    store.close()
  })

  it('到期前不提醒、到点后提醒（pickDue 边界）', () => {
    const dir = tempDir()
    let now = MON
    const { engine, store } = engineAt(dir, () => now)
    engine.writeTurn(turnInput({ userText: '明天下午三点提醒我交周报，别忘了', at: MON }))
    const dueAt = store.listCards({ status: 'active' }).find((card) => card.dueAt !== null)!.dueAt!

    assert.equal(pickDue(store.listCards({ status: 'active' }), dueAt - 1000).length, 0)
    assert.equal(pickDue(store.listCards({ status: 'active' }), dueAt).length, 1)
    assert.equal(pickDue(store.listCards({ status: 'active' }), dueAt + 3600_000).length, 1)
    store.close()
  })

  it('时间读数渲染出「到期事项」块', () => {
    const dir = tempDir()
    let now = MON
    const { engine, store } = engineAt(dir, () => now)
    engine.writeTurn(turnInput({ userText: '明天下午三点提醒我交周报，别忘了', at: MON }))
    const dueAt = store.listCards({ status: 'active' }).find((card) => card.dueAt !== null)!.dueAt!

    // 到期前：不该有到期块。
    assert.ok(!engine.renderTime().includes('到期事项'), '未到期时不应出现到期块')
    // 拨到到期之后：必须出现。
    now = dueAt + 60_000
    const rendered = engine.renderTime()
    assert.ok(rendered.includes('到期事项'), '到期后必须渲染到期块')
    assert.ok(rendered.includes('交周报'), '到期块里要带上原事项')
    store.close()
  })

  it('没有到期线索的句子不产生 dueAt（不编造）', () => {
    const dir = tempDir()
    const { engine, store } = engineAt(dir, () => MON)
    const summary = engine.writeTurn(turnInput({
      userText: '决定这个项目用 Qt5 开发，沿用现有 cmake 配置', at: MON,
    }))
    assert.ok(summary.written > 0)
    assert.equal(summary.cards.filter((card) => card.dueAt !== null).length, 0)
    store.close()
  })

  it('每天提醒的 dueAt 在未来且可重复命中', () => {
    const dir = tempDir()
    const { engine, store } = engineAt(dir, () => MON)
    const summary = engine.writeTurn(turnInput({
      userText: '每天早上八点提醒我喝水，记得', at: MON,
    }))
    const card = summary.cards.find((item) => item.dueAt !== null)
    assert.ok(card !== undefined, '每日提醒必须入库')
    assert.ok(card.dueAt! > MON, '每日提醒的下一次应在未来')
    store.close()
  })
})
