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
import { indexStats } from '../../src/store/inverted.ts'
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

  it('报告的 reindexed 是索引里真实登记的张数（FR-C1 重建索引）', () => {
    // 这条守的是「报告不许报一个没发生的动作」。
    //
    // 曾经的实现是 `reindexed: afterActive`——把活跃卡数换个名字打印一遍。
    // 它看起来完全合理：数字不为 0、量纲也对。只有去读实现才知道索引一次都
    // 没重建。所以这里的判据不能是「> 0」，必须是**与索引实际内容相等**。
    const { store, engine } = openEngine()
    engine.writeTurn(turnInput({ userText: '决定用 Qt5 开发，沿用现有 cmake 配置' }))
    engine.writeTurn(turnInput({
      userText: '决定用 Cordis 插件承载记忆模块，避免污染宿主',
      turn: 2, at: T0 + 1000,
    }))
    assert.ok(store.count('active') >= 2, '前提：至少两张活跃卡，否则条数没有区分度')

    const report = engine.consolidate(T0 + 30 * 24 * 60 * 60 * 1000)

    // 判据一：报告的条数 == 索引里真实登记的张数。
    // 索引是派生视图（FR-A7），`indexStats().cards` 就是「登记了几张」。
    assert.equal(
      report.reindexed, indexStats(store.indexSnapshot()).cards,
      'reindexed 必须等于索引里真实登记的张数',
    )
    // 判据二：重建后索引与卡片集合一致。只对上数字还不够——两边可以一起错。
    assert.equal(store.isIndexHealthy(), true, '重建后索引必须与卡片集合一致')
    // 注意：这里**故意不断言** `reindexed !== afterActive`。
    // 没有归档卡时两者天然相等，那样断言会绿在巧合上而不是规则上。
    // 「不许是活跃卡数的别名」由下一条用例用归档卡把它变成**必然不等**来守。
  })

  it('归档卡也登记进索引，所以 reindexed 大于活跃卡数（前提：两者量纲不同）', () => {
    // 上一条靠「多一张归档卡」让 reindexed != afterActive。这条**单独证明**
    // 那个前提成立：如果归档卡不进索引，上一条的 notEqual 就只是巧合，
    // 而不是规则。**让测试由规则决定，不由巧合决定。**
    const { store, engine } = openEngine()
    engine.writeTurn(turnInput({ userText: '决定用 Qt5 开发，沿用现有 cmake 配置' }))
    engine.writeTurn(turnInput({
      userText: '决定用 Cordis 插件承载记忆模块，避免污染宿主',
      turn: 2, at: T0 + 1000,
    }))
    // 手工归档一张，制造「索引张数 > 活跃张数」。
    const victim = engine.query({ status: 'active' })[0]
    assert.ok(victim !== undefined, '前提：必须有一张活跃卡')
    store.append({ op: 'archive', id: victim.id, at: T0 + 2000, reason: '测试制造归档' })
    assert.equal(store.count('archived'), 1, '前提：确实有一张归档卡')

    const report = engine.consolidate(T0 + 30 * 24 * 60 * 60 * 1000)
    assert.equal(report.reindexed, indexStats(store.indexSnapshot()).cards)
    // 这条才是「reindexed 不许是活跃卡数的别名」的真正判据：
    // 归档卡也在索引里（`buildIndex` 不过滤 status），所以两者**必然不等**。
    // 若实现退回 `reindexed: afterActive`，这里立刻变红。
    assert.ok(
      report.reindexed > report.afterActive,
      `归档卡必须也在索引里：reindexed=${report.reindexed}，afterActive=${report.afterActive}`,
    )
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

describe('图谱扩散不写库（FR-G1 / 起源 L29）', () => {
  it('recall 不得改动图谱边权，也不得新增边记录', () => {
    // 这条守的是**可塑性没有接线**这个事实在行为上成立，而不是只在配置里成立。
    // 起源 L29（第 5 条·专注当前位置）：「看见」不等于「使用」。若召回会强化
    // 边权，那么一次偶然召回就让那对卡连得更紧，下次更容易一起出现——马太效应，
    // 与 L29 要求的「不代入其它记忆」正好相反。
    //
    // 为什么必须在 engine 层测：`reinforceEdges` 是纯函数、返回新对象，
    // 所以在 `core/` 层断言「入参数组没变」**即使接了线也依然绿**。
    // 真正能发现问题的是「库里的边权/边数有没有变」，那需要真实 store + 日志。
    const dir = tempDir()
    const config = makeConfig({
      spread: { mode: 'on', plasticityEnabled: true },
    })
    const store = openStore({ dataDir: dir, config })
    const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: () => T0 })

    // 写两条共享实体的卡。`same-entity` 边的产出条件是「实体集有交集」，
    // 而 `extractEntities` 只认四类：文件路径、URL、驼峰/下划线标识符、
    // 引号内专名。所以这里必须用**引号专名**才能真的抽出实体——
    // 写「DSH」「Cordis」这类普通单词是抽不出来的，entities 会是空数组，
    // 边一条都不会产出，而「边权没变」的断言会**空绿**。
    // 这个坑是写这条测试时踩到的：第一版没加前提断言，看起来是绿的。
    // 两个实体只部分重叠（共享 CordisPlugin，各自另有专名），这样边权 = 1/3 < 1，
    // 可塑性一旦接线就**必然**改变它。若两卡实体完全相同，边权就是 1（已在上限），
    // 强化成了 no-op，这条测试又会空绿——这是第二层坑。
    const first = engine.writeTurn(turnInput({
      userText: '决定「CordisPlugin」的版本用「ThreePointTwo」', at: T0,
    }))
    const second = engine.writeTurn(turnInput({
      userText: '决定「CordisPlugin」需要重新构建，因为「BuildScript」有问题',
      turn: 2, at: T0 + 1000,
    }))
    // 前提一：两张卡都真的写进去了（写入过滤会丢掉「不重要」的句子）。
    assert.ok(first.written > 0 && second.written > 0, '前提：两句话都必须入库')
    engine.consolidate(T0 + 2000)

    // 前提断言：必须真的有边，否则后面「边权没变」是空绿。
    const edgesBefore = store.allEdges()
    assert.ok(edgesBefore.length > 0, '前提：夜整理必须产出边，否则本用例无效')

    // 前提二：边权必须 < 1。等于上限时强化是 no-op，「边权没变」会空绿。
    assert.ok(
      edgesBefore.every((e) => e.weight < 1),
      `前提：边权必须小于上限，否则强化天然是 no-op（实际 ${edgesBefore.map((e) => e.weight).join(',')}）`,
    )
    const weightsBefore = edgesBefore.map((e) => [e.id, e.weight] as const)

    // 反复召回：若可塑性被接进召回链路，这里就会改边权。
    for (let index = 0; index < 5; index += 1) engine.recall('项目 alpha 构建配置')

    const edgesAfter = store.allEdges()
    assert.equal(edgesAfter.length, edgesBefore.length, '召回不得新增或删除边')
    const weightsAfter = edgesAfter.map((e) => [e.id, e.weight] as const)
    assert.deepEqual(weightsAfter, weightsBefore, '召回不得改动任何边权')
    store.close()
  })
})

/**
 * 扩散激活的**端到端**验证（FR-G1 / 起源 L15·无编号·图谱）。
 *
 * 为什么必须有这一组：`tests/core/spread.test.ts` 那 40 条全部直接调
 * `scoreCards` 并**自己造边**，从来没有经过「真实写入 → 夜整理产边 → 召回」
 * 这条路。这正是那个「扩散恒为空集」的真缺陷能藏住的原因——31 条单测全绿，
 * 因为没有任何一条走完整链路。同一个病 consolidate-dev 也撞过一次：
 * `distillFeelings` 单测全绿，端到端才暴露 `distilled = 0`。
 *
 * 这里用的是真实 store + 真实夜整理。`same-entity` 边的产出条件是「实体集有
 * 交集」，而 `extractEntities` 只认引号专名/路径/URL/标识符，所以卡里必须写
 * 引号专名，否则一条边都产不出来，所有断言都会**空绿**。
 */
describe('扩散激活的端到端链路（FR-G1 / 起源 L15）', () => {
  /** 造一个「有真实边」的库，返回引擎与 store。 */
  function spreadLibrary(mode: MemoryConfig['spread']['mode'], maxBoost = 0.2): {
    store: MemoryStore
    engine: MemoryEngine
  } {
    const config = makeConfig({ spread: { mode, maxBoost } })
    const store = openStore({ dataDir: tempDir(), config })
    const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: () => T0 })
    engine.writeTurn(turnInput({
      userText: '决定「CordisPlugin」的版本用「ThreePointTwo」', at: T0,
    }))
    engine.writeTurn(turnInput({
      userText: '决定「CordisPlugin」需要重新构建，因为「BuildScript」有问题',
      turn: 2, at: T0 + 1000,
    }))
    engine.consolidate(T0 + 2000)
    return { store, engine }
  }

  it('真实链路里影子模式算得出加分，且总分与 off 逐位相同', () => {
    const shadow = spreadLibrary('shadow')
    const off = spreadLibrary('off')

    // 前提：必须真的产出了边，否则后面全是空绿。
    assert.ok(shadow.store.allEdges().length > 0, '前提：夜整理必须产出边')
    assert.equal(
      shadow.store.allEdges().length, off.store.allEdges().length,
      '前提：两种模式下的边集必须一致（扩散不写库）',
    )

    const shadowCards = shadow.engine.recall('CordisPlugin 版本').pack.cards
    const offCards = off.engine.recall('CordisPlugin 版本').pack.cards

    // 前提：两张卡都要在焦点包里，否则下面比较的是空集。
    assert.equal(shadowCards.length, 2, '前提：两张卡都必须进焦点包')
    assert.equal(offCards.length, 2, '前提：两张卡都必须进焦点包')

    // 影子模式：总分与 off 逐位相同。
    const shadowTotals = shadowCards.map((c) => c.score.total)
    const offTotals = offCards.map((c) => c.score.total)
    assert.deepEqual(shadowTotals, offTotals, '影子模式不得改变任何一张卡的总分')

    // 但观察值必须非空——这才是影子模式存在的意义。
    const observed = shadowCards.filter((c) => c.shadowSpread !== undefined)
    assert.ok(
      observed.length > 0,
      '影子模式必须产出观察值；若为空，说明扩散在真实链路上又退化成空集了',
    )
    for (const card of observed) {
      assert.ok(card.shadowSpread!.boost > 0, '观察到的加分必须为正')
      assert.ok(
        card.shadowSpread!.hypotheticalTotal > card.score.total,
        '假设总分必须真的高于实际总分，否则观察值没有信息量',
      )
    }

    // off 模式下一张都不许有观察值（没算就没有数可说）。
    assert.equal(
      offCards.filter((c) => c.shadowSpread !== undefined).length, 0,
      'off 模式不得产出任何观察值',
    )
    shadow.store.close()
    off.store.close()
  })

  it('on 模式在真实链路里真的把卡的分数提上去了', () => {
    const on = spreadLibrary('on')
    const off = spreadLibrary('off')

    const onCards = on.engine.recall('CordisPlugin 版本').pack.cards
    const offCards = off.engine.recall('CordisPlugin 版本').pack.cards
    assert.equal(onCards.length, 2, '前提：两张卡都必须进焦点包')

    // 按 id 对齐，不能按顺序对齐——排序本身可能变。
    const offById = new Map(offCards.map((c) => [c.card.id, c.score.total]))
    const changed = onCards.filter((c) => c.score.total > (offById.get(c.card.id) ?? 0))
    assert.ok(
      changed.length > 0,
      'on 模式必须在真实链路上真的提分；若一条都没变，说明扩散是空转',
    )
    // 影子模式的预测值必须与 on 的实测值一致——否则攒下的证据是假的。
    on.store.close()
    off.store.close()
  })
})

/**
 * FR-B2「全低分时不硬塞」的端到端验收（缺陷二十六的最终守门）。
 *
 * ## 为什么要单独一组端到端用例
 *
 * 缺陷二十六的本质是：`absoluteThreshold` 比对 `total`，而 `total` 里有
 * 0.48 权重与查询无关，于是一张**完全无关但新鲜**的卡也能拿 0.32 以上，
 * 阈值无论调多少都拦不住它。单测层面已经证明了这个数学性质
 * （`tests/core/scoring.test.ts` 的 `无关但新鲜的卡` 那条），但单测
 * **自己构造打分结果**，跳过了「候选池是怎么来的」「闸门在链路里有没有被调用」
 * 这两步——而缺陷经常恰好在那一层。
 *
 * 这组用例走真实链路：写入 → 夜整理产边 → `engine.recall` → 焦点包。
 * 它守的是用户能直接观察到的那个事实：**问一件库里完全没提过的事，
 * 焦点包必须是空的**，而不是被塞满无关卡。
 */
describe('无关查询不得硬塞焦点包（FR-B2 / 缺陷二十六端到端）', () => {
  /** 造一个只谈部署、与「量子色动力学」毫无关系的库。 */
  function deployLibrary(mode: MemoryConfig['spread']['mode']): {
    store: MemoryStore
    engine: MemoryEngine
  } {
    const config = makeConfig({ spread: { mode } })
    const store = openStore({ dataDir: tempDir(), config })
    const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: () => T0 })
    const rounds = [
      '部署脚本一直报错，原因是环境变量没有配置，我们决定以后部署前先跑一次自检。',
      '部署方案最终选了蓝绿发布，原因是要能一键回滚，结论是先起绿环境验证再切流量。',
      '我们决定把回滚流程写进运维手册，约定每次部署之后都要演练一次。',
    ]
    for (let i = 0; i < rounds.length; i += 1) {
      engine.writeTurn(turnInput({ userText: rounds[i]!, turn: i + 1, at: T0 - (3 - i) * 86_400_000 }))
    }
    engine.consolidate(T0 + 2000)
    return { store, engine }
  }

  it('问库里完全没提过的事，焦点包必须为空（不许靠新鲜度混进来）', () => {
    // 三种扩散模式都要过：`on` 模式下「有个强邻居」也不能把无关卡推进来，
    // 因为绝对闸看 `relevance`，而扩散加分只进 `total`。
    for (const mode of ['off', 'shadow', 'on'] as const) {
      const { store, engine } = deployLibrary(mode)
      // 前提：库里确实有卡，否则「空包」可能只是因为库是空的。
      assert.ok(store.listCards({ status: 'active' }).length > 0, '前提：库里必须有卡')
      // 前提：候选池必须非空，否则「空包」可能只是因为倒排一张都没召回。
      // 这一条很关键：它把「闸门挡住了」和「根本没有候选」区分开。
      const probe = engine.recall('部署')
      assert.ok(
        probe.candidates > 0,
        `前提（mode=${mode}）：查询「部署」必须召回候选，实际 ${probe.candidates}`,
      )

      const result = engine.recall('量子色动力学的渐近自由')
      assert.equal(
        result.pack.cards.length,
        0,
        `mode=${mode}：问库里完全没提过的事，焦点包必须为空。`
        + `实际硬塞了：${result.pack.cards.map((c) => `「${c.card.text.slice(0, 20)}」(rel=${c.score.relevance.toFixed(3)}, total=${c.score.total.toFixed(3)})`).join(' | ')}`,
      )
      // 注入文本也不能编造内容（ST-5 不编造）。
      assert.equal(result.text, '', `mode=${mode}：空包时注入文本必须为空串`)
      store.close()
    }
  })

  it('反向对照：问库里确实谈过的事，焦点包必须非空', () => {
    // 只测「该空的空」是半个测试——把 `applyThresholds` 改成恒返回 `[]`
    // 也能让上一条全绿。这条守另一半：闸门不是无条件清空。
    const { store, engine } = deployLibrary('on')
    const result = engine.recall('上次部署是怎么做的')
    assert.ok(
      result.pack.cards.length > 0,
      '库里确实谈过部署，问它时必须召回；若为空说明阈值把真相关卡也挡住了',
    )
    // 更要紧的：召回的内容必须真的和部署有关，不是随便塞一张。
    const texts = result.pack.cards.map((c) => c.card.text).join(' ')
    assert.match(texts, /部署|回滚|蓝绿/u, `召回内容必须与部署相关，实际：${texts.slice(0, 80)}`)
    store.close()
  })
})

/**
 * 影子观察值必须有人看得到（FR-G1 / FR-F1 可观测）。
 *
 * 影子模式的全部价值在于「先看它想做什么，再决定要不要开」。算完不暴露，
 * 就等于算了个寂寞——而这正是这个模块差点犯的错：`shadowSpread` 算出来了，
 * 但没有任何出口，`explain` 里不许放（那是「分数怎么算出来的」），
 * 注入文本里更不能放（起源 L17·无编号·上下文污染）。
 *
 * 两个出口，各测一条：
 * 1. 人读渲染 `renderFocusPackExplain`（`/memory explain` 与 CLI `query` 共用）
 *    ——已在 `tests/core/render.test.ts` 覆盖。
 * 2. 结构化日志 `engine.recall` 的 `detail.shadow`——本组覆盖。
 *
 * 日志这条尤其要测**不该出现时不出现**：若 `off` / `on` 也带 `shadow` 字段，
 * 运维看日志会以为当前跑的是 shadow 模式。
 */
describe('影子观察值的可观测出口（FR-G1 / FR-F1）', () => {
  /** 造一个「有真实边」的库，并把日志收集起来。 */
  function libraryWithLogs(mode: MemoryConfig['spread']['mode']): {
    store: MemoryStore
    engine: MemoryEngine
    logs: MemoryLogEntry[]
  } {
    const logs: MemoryLogEntry[] = []
    const config = makeConfig({ spread: { mode, maxBoost: 0.2 } })
    const store = openStore({ dataDir: tempDir(), config })
    const engine = new MemoryEngine({
      store, config, timeZone: TZ, clock: () => T0,
      onLog: (entry) => logs.push(entry),
    })
    engine.writeTurn(turnInput({
      userText: '决定「CordisPlugin」的版本用「ThreePointTwo」', at: T0,
    }))
    engine.writeTurn(turnInput({
      userText: '决定「CordisPlugin」需要重新构建，因为「BuildScript」有问题',
      turn: 2, at: T0 + 1000,
    }))
    engine.consolidate(T0 + 2000)
    return { store, engine, logs }
  }

  it('shadow 模式的召回日志带上影子观察值', () => {
    const lib = libraryWithLogs('shadow')
    // 前提：必须真的有边，否则扩散恒空，这条测试会空绿。
    assert.ok(lib.store.allEdges().length > 0, '前提：夜整理必须产出边')

    lib.engine.recall('CordisPlugin 版本')
    const entry = lib.logs.filter((e) => e.kind === 'recall').at(-1)
    assert.ok(entry !== undefined, '前提：recall 必须写日志')

    const shadow = entry.detail.shadow as Array<Record<string, unknown>> | undefined
    assert.ok(shadow !== undefined, 'shadow 模式的召回日志必须带 shadow 字段')
    assert.ok(shadow.length > 0, '必须至少观察到一条会被提权的卡')
    for (const item of shadow) {
      assert.ok(typeof item.id === 'string', '观察值必须能定位到具体卡')
      assert.ok((item.boost as number) > 0, '观察到的加分必须为正')
      assert.ok(typeof item.actualRank === 'number', '必须记下实际排名')
      assert.ok(typeof item.hypotheticalRank === 'number', '必须记下假设排名')
    }
  })

  it('shadow 模式的日志摘要里明说「未生效」', () => {
    // 摘要行是运维最先看到的东西。若只说「2 条会被扩散提权」而不说未生效，
    // 读者会以为召回结果已经变了。
    const lib = libraryWithLogs('shadow')
    lib.engine.recall('CordisPlugin 版本')
    const entry = lib.logs.filter((e) => e.kind === 'recall').at(-1)
    assert.ok(entry!.summary.includes('影子模式'), '摘要必须点明这是影子模式')
    assert.ok(entry!.summary.includes('未生效'), '摘要必须点明未生效')
  })

  it('off 模式的召回日志不带 shadow 字段', () => {
    // off 模式根本没算扩散。若日志里带 shadow 字段（哪怕是空数组），
    // 运维会以为当前跑的是 shadow。
    const lib = libraryWithLogs('off')
    lib.engine.recall('CordisPlugin 版本')
    const entry = lib.logs.filter((e) => e.kind === 'recall').at(-1)
    assert.ok(entry !== undefined, '前提：recall 必须写日志')
    assert.equal('shadow' in entry.detail, false, 'off 模式的日志不得出现 shadow 字段')
    assert.ok(!entry.summary.includes('影子'), 'off 模式的摘要不得提影子模式')
  })

  it('on 模式的召回日志不带 shadow 字段（观察值已折进总分）', () => {
    // on 模式里加分已经进了 total。此时再记一份 shadow 就是两个真相来源，
    // 而且读者会分不清那 0.1 是「已生效」还是「只是假设」。
    const lib = libraryWithLogs('on')
    lib.engine.recall('CordisPlugin 版本')
    const entry = lib.logs.filter((e) => e.kind === 'recall').at(-1)
    assert.ok(entry !== undefined, '前提：recall 必须写日志')
    assert.equal('shadow' in entry.detail, false, 'on 模式的日志不得出现 shadow 字段')
  })

  it('peek 不写日志，因此影子观察值也不会从 peek 泄进日志', () => {
    // peek 是只读入口（起源 L29·第 5 条·专注当前位置）。它若写日志，
    // 「看一眼」就等于「用过」，还会让日志里出现大量重复的影子记录。
    const lib = libraryWithLogs('shadow')
    const before = lib.logs.length
    lib.engine.peek('CordisPlugin 版本')
    assert.equal(lib.logs.length, before, 'peek 不得写日志')
  })
})

/**
 * ST-1 验收口径：「连续 10 次召回结果完全一致」。
 *
 * 原有那条「同样查询两次结果一致」只做 2 次，而需求写的是 10 次。差的不只是
 * 数量——**2 次只能发现「第 2 次就变了」的错误**，发现不了「前几次稳定、
 * 后面逐渐漂移」的错误，而那恰恰是最容易发生的形态：
 *
 * - 召回若累积任何状态（访问计数、最近访问时间、边权），结果会**单调漂移**，
 *   第 2 次和第 1 次差异极小（可能还没跨过排序临界点），第 10 次才看得出来；
 * - 浮点累积误差同理，它是**累加**的，样本太少时低于可见分辨率。
 *
 * 所以这里不是把 2 改成 10 就算完，还要断言**每一次都与第 1 次逐字段相同**
 * （不只是卡片 id 顺序），以及**库状态在 10 次召回前后完全没变**。
 */
describe('ST-1 连续 10 次召回完全一致（需求规格 12.1）', () => {
  /** 造一个有足够多卡、能产生真实排序的库。 */
  function richLibrary(): { store: MemoryStore; engine: MemoryEngine; dir: string } {
    const dir = tempDir()
    const store = openStore({ dataDir: dir })
    const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    // 十几张卡、部分共享实体（能产出边），确保排序不是平凡的单元素列表。
    const texts = [
      '决定「CordisPlugin」的版本用「ThreePointTwo」',
      '决定「CordisPlugin」需要重新构建，因为「BuildScript」有问题',
      '项目用什么开发',
      '项目用什么开发语言，决定用 TypeScript',
      '部署走 CI 流水线',
      '部署方案改成分阶段发布',
      '数据库选型定 PostgreSQL',
      '数据库备份每天凌晨跑',
      '日志格式统一成 JSON',
      '日志保留三十天',
      '接口超时设为三秒',
      '接口重试两次',
    ]
    for (let index = 0; index < texts.length; index += 1) {
      engine.writeTurn(turnInput({ userText: texts[index]!, turn: index + 1, at: T0 + index * 1000 }))
    }
    engine.consolidate(T0 + 20_000)
    return { store, engine, dir }
  }

  it('连续 10 次召回，每次结果与第 1 次逐字段相同', () => {
    const lib = richLibrary()
    const query = '项目用什么开发'

    const first = lib.engine.recall(query)
    // 前提：必须真的召回了一些卡，否则「10 次都是空」也能通过——那是空绿。
    assert.ok(first.pack.cards.length > 0, '前提：这个查询必须命中至少一张卡')

    // 比较的必须是**完整可观察输出**，不只是 id 顺序：
    // 分数若漂移，排序可能暂时不变，但 injected 文本/总分已经变了。
    const baseline = JSON.stringify(first.pack.cards.map((item) => ({
      id: item.card.id,
      total: item.score.total,
      text: item.card.text,
      explain: item.explain,
      shadow: item.shadowSpread ?? null,
    })))

    for (let round = 2; round <= 10; round += 1) {
      const next = lib.engine.recall(query)
      const actual = JSON.stringify(next.pack.cards.map((item) => ({
        id: item.card.id,
        total: item.score.total,
        text: item.card.text,
        explain: item.explain,
        shadow: item.shadowSpread ?? null,
      })))
      assert.equal(actual, baseline, `第 ${round} 次召回与第 1 次不一致（ST-1 要求 10 次完全一致）`)
      assert.equal(next.pack.tokens, first.pack.tokens, `第 ${round} 次的 token 占用变了`)
      assert.equal(next.candidates, first.candidates, `第 ${round} 次的候选数变了`)
    }
    lib.store.close()
  })

  it('10 次召回前后库状态完全没变（recall 不得写库）', () => {
    // ST-1 的「一致」如果靠「每次都重新算一遍、顺便把状态也改了」来实现，
    // 那 10 次看起来一致只是巧合。必须同时断言**副作用为零**。
    const lib = richLibrary()
    const snapshot = (): string => JSON.stringify({
      cards: lib.store.listCards().map((card) => ({
        id: card.id, strength: card.strength, accessCount: card.accessCount,
        lastAccessAt: card.lastAccessAt, updatedAt: card.updatedAt,
      })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      edges: lib.store.allEdges().map((edge) => ({ id: edge.id, weight: edge.weight }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    })

    const before = snapshot()
    for (let round = 1; round <= 10; round += 1) lib.engine.recall('项目用什么开发')
    assert.equal(snapshot(), before, 'recall 不得改动卡片状态或边权')
    lib.store.close()
  })

  it('重开后连续 10 次仍一致，且与重开前一致（跨进程口径）', () => {
    // 真正的 ST-1 是「重启一致」：同一份日志，重开进程后重算，结果必须相同。
    // 只在同一个实例上跑 10 次，测不到「重放顺序是否影响结果」。
    const lib = richLibrary()
    const query = '项目用什么开发'
    const beforeRestart = lib.engine.recall(query).pack.cards.map((item) => ({
      id: item.card.id, total: item.score.total,
    }))
    assert.ok(beforeRestart.length > 0, '前提：重开前必须召回出卡')
    lib.store.close()

    const reopened = openStore({ dataDir: lib.dir })
    const engineB = new MemoryEngine({ store: reopened, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
    for (let round = 1; round <= 10; round += 1) {
      const after = engineB.recall(query).pack.cards.map((item) => ({
        id: item.card.id, total: item.score.total,
      }))
      assert.deepEqual(after, beforeRestart, `重开后第 ${round} 次召回与重开前不一致`)
    }
    reopened.close()
  })
})
