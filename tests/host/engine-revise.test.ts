/**
 * FR-C2（归档可逆）与 FR-A5（修正留痕）的**生产入口**测试。
 *
 * 这两条此前的问题不是「实现错了」，而是「实现好了但没人够得着」：
 * `state.ts` 的 `restore` / `revise` 分支完整、`tests/store/state.test.ts`
 * 也验了，但 `src/` 里零生产者，`MemoryEngine` 没有对应方法。
 *
 * 所以本文件的断言重点与 `state.test.ts` **不同**：
 * - `state.test.ts` 验「操作作用到状态上对不对」；
 * - 本文件验「用户能不能通过引擎/命令真的触发它」。
 *
 * 后者必须走**真实重放**：`restore` 之后关库重开，卡必须还是活跃的。
 * 只看内存视图的话，「写进日志」与「只改了内存」分辨不出来。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { runMemoryCommand } from '../../src/index.ts'

/** 测试用固定时刻，避免时钟漂移让断言时红时绿。 */
const T0 = Date.UTC(2023, 10, 15, 6, 13, 0)

/** 测试时区。 */
const TZ = 'Asia/Shanghai'

/** 打开一个引擎 + store。 */
function openEngine(options: { dataDir: string; clock?: () => number; config?: MemoryConfig }): {
  store: ReturnType<typeof openStore>
  engine: MemoryEngine
} {
  const config = options.config ?? DEFAULT_CONFIG
  const store = openStore({ dataDir: options.dataDir, config })
  const engine = new MemoryEngine({
    store,
    config,
    timeZone: TZ,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
  return { store, engine }
}

let dir = ''

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-revise-'))
})

after(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * 打开一个已写入三张卡并归档其中一张的引擎。
 *
 * @returns 引擎、库路径，以及被归档那张卡的 id。
 */
function archivedFixture(): { engine: MemoryEngine; store: ReturnType<typeof openStore>; dir: string; archivedId: string } {
  const sub = mkdtempSync(join(dir, 'case-'))
  const opened = openEngine({ dataDir: sub, clock: () => T0 })
  const engine = opened.engine
  engine.writeTurn({
    sessionId: 's1',
    turn: 1,
    step: 1,
    seq: 1,
    userText: '这个项目用 Redis 做缓存，部署在 Kubernetes 上',
    assistantText: '好的，记下了',
    domain: 'work',
    at: T0,
  })
  // 第二轮：必须留下**另一张活跃卡**，否则归档掉第一张后库里没有 active，
  // 后面那些「对本来就活跃的卡调用」的用例会绿在「前提不成立」上。
  engine.writeTurn({
    sessionId: 's1',
    turn: 2,
    step: 1,
    seq: 2,
    userText: '数据库用 PostgreSQL，备份策略每周一次全量',
    assistantText: '明白了',
    domain: 'work',
    at: T0 + 500,
  })
  const active = engine.query({})
  assert.ok(active.length >= 2, `前提：至少要有两张活跃卡，实际 ${active.length}`)
  // 必须按**内容**挑那张 Redis 卡，不能按下标：`query({})` 的顺序由排序规则
  // 决定，按下标会挑到 PostgreSQL 那张，而下面的召回用「Redis 缓存」作查询词
  // ——那时「恢复后召不回来」不是 restore 坏了，是查询词根本没指向它。
  const redisCard = active.find((card) => card.text.includes('Redis'))
  assert.ok(redisCard !== undefined, '前提：得有一张 Redis 卡')
  const archivedId = redisCard.id
  // 直接用 store 归档：`archive` 在生产里由夜整理自动触发，
  // 这里模拟「它已经被自动归档了」这个前提状态。
  opened.store.append({ op: 'archive', id: archivedId, at: T0 + 1000, reason: '夜整理自动归档' })
  assert.equal(engine.inspect(archivedId)?.status, 'archived', '前提：卡必须真的已归档')
  return { engine, store: opened.store, dir: sub, archivedId }
}

describe('FR-C2 · 归档必须可逆（restore 生产入口）', () => {
  it('restore 之后卡片状态变回 active', () => {
    const { engine, store, archivedId } = archivedFixture()
    assert.equal(engine.restore(archivedId), true, 'restore 必须报告真的写了一条记录')
    assert.equal(engine.inspect(archivedId)?.status, 'active')
    store.close()
  })

  it('restore 必须落进事件日志：关库重开后卡片仍是 active', () => {
    // 这一条是**真正的那条**：只看内存视图的话，
    // 「写进日志」与「只改了内存」分辨不出来（P2 事件日志唯一真相源）。
    const { engine, store, dir: sub, archivedId } = archivedFixture()
    engine.restore(archivedId)
    store.close()

    const reopened = openEngine({ dataDir: sub, clock: () => T0 + 5000 })
    assert.equal(
      reopened.engine.inspect(archivedId)?.status,
      'active',
      '重开后必须还是 active——否则 restore 只改了内存没进日志',
    )
    reopened.store.close()
  })

  it('恢复后的卡能重新被召回（FR-C2 验收原文「恢复后能正常召回」）', () => {
    const { engine, store, archivedId } = archivedFixture()
    // 前提：归档期间召不回来。这一条防止下面的断言绿在别的原因上。
    const before = engine.recall('Redis 缓存')
    assert.ok(
      before.pack.cards.every((scored: { card: { id: string } }) => scored.card.id !== archivedId),
      '前提：归档的卡不该出现在召回结果里',
    )
    engine.restore(archivedId)
    const after = engine.recall('Redis 缓存')
    assert.ok(
      after.pack.cards.some((scored: { card: { id: string } }) => scored.card.id === archivedId),
      '恢复后必须能重新召回',
    )
    store.close()
  })

  it('对不存在的卡 restore 返回 false，且不写日志', () => {
    const { engine, store } = archivedFixture()
    const before = engine.health()
    assert.equal(engine.restore('card_does_not_exist'), false)
    const after = engine.health()
    assert.equal(after.active, before.active, '不存在的卡不该改变活跃数')
    assert.equal(after.archived, before.archived, '不存在的卡不该改变归档数')
    store.close()
  })

  it('对本来就活跃的卡 restore 返回 false（不写无意义的记录）', () => {
    const { engine, store } = archivedFixture()
    const active = engine.query({ status: 'active' })
    const id = active[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    assert.equal(engine.restore(id), false, '本来就没归档，不该写 restore 记录')
    store.close()
  })

  it('/memory restore 命令真的能恢复', () => {
    // 引擎方法存在 ≠ 用户够得着。这条测的是**入口**。
    const { engine, store, archivedId } = archivedFixture()
    const out = runMemoryCommand(engine, `restore ${archivedId}`)
    assert.match(out, /已恢复/u)
    assert.equal(engine.inspect(archivedId)?.status, 'active')
    store.close()
  })

  it('/memory restore 对未归档的卡给出可读说明，而不是静默成功', () => {
    const { engine, store } = archivedFixture()
    const active = engine.query({ status: 'active' })
    const id = active[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    const out = runMemoryCommand(engine, `restore ${id}`)
    assert.match(out, /没有被归档/u)
    assert.doesNotMatch(out, /已恢复/u, '没做事就不能说「已恢复」')
    store.close()
  })
})

describe('FR-A5 · 修正必须留痕（revise 生产入口）', () => {
  it('revise 之后正文变了，且 revisions 记下了旧文本', () => {
    const { engine, store } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    const before = engine.inspect(id)
    assert.ok(before !== undefined)
    assert.equal(before.revisions.length, 0, '前提：初始没有修正历史')

    assert.equal(engine.revise(id, '这个项目改用 PostgreSQL', '决策变更'), true)
    const after = engine.inspect(id)
    assert.ok(after !== undefined)
    assert.equal(after.text, '这个项目改用 PostgreSQL')
    assert.equal(after.revisions.length, 1, '必须留下一条修正记录')
    assert.equal(after.revisions[0]?.previousText, before.text, '旧文本必须原样留档')
    assert.equal(after.revisions[0]?.reason, '决策变更')
    assert.equal(after.revisions[0]?.actor, 'manual')
    store.close()
  })

  it('revise 必须重算 normalized，否则改完搜不到新词', () => {
    // 重放层只按 op.normalized 覆盖，它不会自己调 normalizeText。
    // 抄旧值的话，用户改了正文却发现检索仍按旧文本匹配，且无任何报错。
    const { engine, store } = archivedFixture()
    const target = engine.query({ status: 'active' })[0]
    assert.ok(target !== undefined, '前提：得有一张活跃卡')
    const id = target.id
    const before = engine.inspect(id)
    assert.ok(before !== undefined)
    // 新词必须**不在旧正文里**，否则「重算了」和「抄了旧值」都能绿。
    assert.ok(!before.normalized.includes('sqlite'), '前提：旧 normalized 不含新词')
    const oldWords = before.normalized.split(/\s+/u).filter((word) => word.length > 1)
    assert.ok(oldWords.length > 0, '前提：旧 normalized 得真有词，否则「旧词消失」无从验证')

    engine.revise(id, '这个项目改用 SQLite 存储', '决策变更')
    const after = engine.inspect(id)
    assert.ok(after !== undefined)
    assert.ok(after.normalized.includes('sqlite'), 'normalized 必须按新正文重算')
    for (const word of oldWords) {
      assert.ok(!after.normalized.includes(word), `旧词「${word}」必须从 normalized 里消失`)
    }
    store.close()
  })

  it('revise 必须落进事件日志：关库重开后正文与历史都还在', () => {
    const { engine, store, dir: sub } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    engine.revise(id, '这个项目改用 PostgreSQL', '决策变更')
    store.close()

    const reopened = openEngine({ dataDir: sub, clock: () => T0 + 5000 })
    const card = reopened.engine.inspect(id)
    assert.ok(card !== undefined)
    assert.equal(card.text, '这个项目改用 PostgreSQL', '重开后正文必须是新的')
    assert.equal(card.revisions.length, 1, '重开后修正历史必须还在')
    reopened.store.close()
  })

  it('多次 revise 必须累积历史，不是覆盖', () => {
    const { engine, store } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    const originalText = engine.inspect(id)?.text
    assert.ok(originalText !== undefined, '前提：得拿到原正文')
    engine.revise(id, '第一次修正', '原因一')
    engine.revise(id, '第二次修正', '原因二')
    const card = engine.inspect(id)
    assert.ok(card !== undefined)
    assert.equal(card.revisions.length, 2, '两条修正必须都留着')
    // revisions[0].previousText 是**被替换掉的旧文本**，也就是原始正文；
    // 第二次修正的旧文本才是「第一次修正」。
    assert.equal(card.revisions[0]?.previousText, originalText)
    assert.equal(card.revisions[1]?.previousText, '第一次修正')
    assert.equal(card.revisions[1]?.reason, '原因二')
    store.close()
  })

  it('正文没变时不写记录（「改过什么」不是「按过几次保存」）', () => {
    const { engine, store } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    const before = engine.inspect(id)
    assert.ok(before !== undefined)
    assert.equal(engine.revise(id, before.text, '无意义'), false)
    assert.equal(engine.inspect(id)?.revisions.length, 0)
    store.close()
  })

  it('空正文被拒绝（存在但不可读的卡比删掉更糟）', () => {
    const { engine, store } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    assert.equal(engine.revise(id, '   ', '清空试试'), false, '空白正文必须被拒')
    const card = engine.inspect(id)
    assert.ok(card !== undefined)
    assert.ok(card.text.trim().length > 0, '正文不能被清空')
    assert.equal(card.revisions.length, 0)
    store.close()
  })

  it('/memory revise 命令真的能修正', () => {
    const { engine, store } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    const out = runMemoryCommand(engine, `revise ${id} 改成用 SQLite`)
    assert.match(out, /已修正/u)
    assert.equal(engine.inspect(id)?.text, '改成用 SQLite')
    store.close()
  })

  it('/memory revise 缺正文时给用法提示，而不是写一条空修正', () => {
    const { engine, store } = archivedFixture()
    const id = engine.query({ status: 'active' })[0]?.id
    assert.ok(id !== undefined, '前提：得有一张活跃卡')
    const out = runMemoryCommand(engine, `revise ${id}`)
    assert.match(out, /用法/u)
    assert.equal(engine.inspect(id)?.revisions.length, 0, '用法错误不能留下修正记录')
    store.close()
  })
})
