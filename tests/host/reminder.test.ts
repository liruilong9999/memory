/**
 * FR-D3 到期提醒的测试：一次性 / 每日 / 每周，到期投递并唤醒。
 *
 * 验收原文是「到点无需用户输入自行接力」。这句话在**重复**场景下的
 * 真实形态是：今天响过之后，明天还得响。
 *
 * 修之前的行为（`.tmp/probe-fr-d3.ts` 实测）：
 *
 *   parseDue = { dueAt: 1700096400000, repeat: 'daily' }
 *   第1天 dueNow = 1 张
 *   第1天再问   = 0 张
 *   第2天 dueNow = 0 张   ← 每日提醒永久静默
 *   第2天之后 dueAt = 1700096400000（没动过）
 *
 * 两个根因，缺一不可：
 * 1. `writeTurn` 只取了 `spec.dueAt`，把 `spec.repeat` 丢掉 ⇒ 库里
 *    「每日提醒」与「一次性提醒」无法区分；
 * 2. `markReminded` 只往**内存 Map** 记 `(id, dueAt)`，从不推进 `dueAt`
 *    ⇒ 第二天 `dueNow` 返回同一个 `dueAt`，被 Map 过滤掉。
 *
 * 所以本文件必须同时守这两半：只测「repeat 落盘了」证明不了会重复响，
 * 只测「dueAt 推进了」证明不了重启后还对。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { deriveIdempotencyKey } from '../../src/store/store.ts'
import { nextDueAfter, parseDue } from '../../src/time/due.ts'

const TZ = 'Asia/Shanghai'
const T0 = Date.UTC(2023, 10, 15, 6, 13, 0)
const DAY = 24 * 60 * 60 * 1000

let root = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-d3-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

function tempDir(): string {
  return mkdtempSync(join(root, 'case-'))
}

function openEngine(dataDir: string): {
  store: ReturnType<typeof openStore>
  engine: MemoryEngine
} {
  const store = openStore({ dataDir, config: DEFAULT_CONFIG })
  const engine = new MemoryEngine({
    store, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0,
  })
  return { store, engine }
}

/** 写一句带提醒的话，返回唯一那张带 dueAt 的卡。 */
function writeReminder(engine: MemoryEngine, text: string, at = T0): {
  id: string
  dueAt: number
  dueRepeat: string | undefined
} {
  engine.writeTurn({
    sessionId: 's1', turn: 1, step: 1, seq: 1,
    userText: text, assistantText: '好的', domain: 'work', at,
  })
  const card = engine.query({}).find((item) => typeof item.dueAt === 'number')
  assert.ok(card !== undefined, `前提：「${text}」必须产出带 dueAt 的卡`)
  return { id: card.id, dueAt: card.dueAt as number, dueRepeat: card.dueRepeat }
}

describe('FR-D3 · nextDueAfter 纯函数', () => {
  it('一次性返回 null（不再有下一次）', () => {
    assert.equal(nextDueAfter(T0, 'once', T0 + DAY, TZ), null)
  })

  it('每日按本地自然日推进，钟点不变', () => {
    const spec = parseDue('每天早上九点提醒我喝水', T0, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'daily')
    const next = nextDueAfter(spec.dueAt, 'daily', spec.dueAt + 1000, TZ)
    assert.ok(next !== null)
    assert.equal(next - spec.dueAt, DAY, '跨一天应恰好 +24h（该日无夏令时切换）')
  })

  it('每周推进 7 天', () => {
    const spec = parseDue('每周三下午三点提醒我开周会', T0, TZ)
    assert.ok(spec !== null, '前提：必须能解析出每周提醒')
    assert.equal(spec.repeat, 'weekly')
    const next = nextDueAfter(spec.dueAt, 'weekly', spec.dueAt + 1000, TZ)
    assert.ok(next !== null)
    assert.equal(next - spec.dueAt, 7 * DAY)
  })

  it('宿主停摆多天时一次跳到未来，不连续补发', () => {
    // 用 if 只推一天的话，接下来几天会每天补发同一批提醒。
    const spec = parseDue('每天早上九点提醒我喝水', T0, TZ)
    assert.ok(spec !== null)
    const now = spec.dueAt + 5 * DAY + 3600 * 1000
    const next = nextDueAfter(spec.dueAt, 'daily', now, TZ)
    assert.ok(next !== null)
    assert.ok(next > now, '下一次必须严格晚于当前时刻')
    assert.ok(next - now <= DAY, '不能跳过头太多')
  })

  it('推进结果严格晚于 now（不能原样返回）', () => {
    const spec = parseDue('每天早上九点提醒我喝水', T0, TZ)
    assert.ok(spec !== null)
    const next = nextDueAfter(spec.dueAt, 'daily', spec.dueAt, TZ)
    assert.ok(next !== null)
    assert.ok(next > spec.dueAt, '必须严格推进；相等就是空操作')
  })
})

describe('FR-D3 · 每日提醒必须真的每天响', () => {
  it('repeat 必须落盘：每日提醒的卡带 dueRepeat=daily', () => {
    // 这一半修的是「库里无法区分每日与一次性」。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')
    assert.equal(card.dueRepeat, 'daily', 'repeat 不能丢——丢了之后永远无法推进')
    store.close()
  })

  it('一次性提醒的卡带 dueRepeat=once', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '明天下午三点提醒我交报告')
    assert.equal(card.dueRepeat, 'once')
    store.close()
  })

  it('第 1 天到期会提醒，同日再问不重复', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')

    const day1 = card.dueAt + 1000
    const first = engine.dueNow(day1)
    assert.equal(first.length, 1, '到期必须能被 pickDue 命中')
    engine.markReminded(first, day1)

    const again = engine.dueNow(day1 + 60_000)
    assert.equal(again.length, 0, '同一次到期不能反复唤醒（会变成刷屏）')
    store.close()
  })

  it('第 2 天必须再次提醒（这是本条缺陷的核心）', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')

    const day1 = card.dueAt + 1000
    engine.markReminded(engine.dueNow(day1), day1)

    const day2 = day1 + DAY
    const second = engine.dueNow(day2)
    assert.equal(second.length, 1, '每日提醒第二天必须再响——这是 FR-D3 的验收原文')
    assert.equal(second[0]?.dueAt, card.dueAt + DAY, 'dueAt 必须推进到第二天')
    store.close()
  })

  it('第 3 天仍然会响（不是只多响一次）', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')

    let cursor = card.dueAt + 1000
    for (let day = 1; day <= 3; day += 1) {
      const due = engine.dueNow(cursor)
      assert.equal(due.length, 1, `第 ${day} 天必须响`)
      engine.markReminded(due, cursor)
      cursor += DAY
    }
    store.close()
  })

  it('跨进程：重启后 dueAt 已推进，不会重复提醒同一到期', () => {
    // remindedDueAt 是内存 Map，重启即清空。只靠它的话重启后
    // 同一个 dueAt 会被当成「没提醒过」再提醒一次。
    const dir = tempDir()
    const first = openEngine(dir)
    const card = writeReminder(first.engine, '每天早上九点提醒我喝水')
    const day1 = card.dueAt + 1000
    first.engine.markReminded(first.engine.dueNow(day1), day1)
    first.store.close()

    // 新进程：只从磁盘重放。
    const second = openEngine(dir)
    const reloaded = second.engine.query({}).find((item) => item.id === card.id)
    assert.ok(reloaded !== undefined)
    assert.equal(reloaded.dueAt, card.dueAt + DAY, '推进必须落盘，不能只在内存里')
    assert.equal(reloaded.dueRepeat, 'daily', 'repeat 也必须穿过重放层')
    assert.equal(
      second.engine.dueNow(day1 + 60_000).length, 0,
      '重启后不能把已经提醒过的到期再提醒一次',
    )
    second.store.close()
  })

  it('一次性提醒响过之后不再响，dueAt 也不被推进', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '明天下午三点提醒我交报告')

    const at = card.dueAt + 1000
    engine.markReminded(engine.dueNow(at), at)
    assert.equal(engine.dueNow(at + DAY).length, 0, '一次性提醒不该重复')

    const reloaded = engine.query({}).find((item) => item.id === card.id)
    assert.equal(reloaded?.dueAt, card.dueAt, '一次性提醒不该推进 dueAt')
    store.close()
  })

  it('推进 dueAt 必须真的写进日志（幂等键要含 dueAt）', () => {
    // 幂等键不含 dueAt 时，推进只改 dueAt、其它字段不变 ⇒ 键相同 ⇒
    // 数据面判重复 ⇒ 静默丢弃。这是幂等键缺陷第三次重演。
    const dir = tempDir()
    const first = openEngine(dir)
    const card = writeReminder(first.engine, '每天早上九点提醒我喝水')
    const day1 = card.dueAt + 1000
    first.engine.markReminded(first.engine.dueNow(day1), day1)
    first.store.close()

    // 从磁盘重放——幂等键影响的是「日志里有没有这条记录」，
    // 只看内存视图可能看不出。
    const second = openEngine(dir)
    const reloaded = second.engine.query({}).find((item) => item.id === card.id)
    assert.notEqual(reloaded?.dueAt, card.dueAt, '日志里必须有一条推进记录，否则重放还是旧值')
    second.store.close()
  })

  it('宿主停摆 5 天后只提醒一次，不连续补发', () => {
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')

    const day1 = card.dueAt + 1000
    engine.markReminded(engine.dueNow(day1), day1)

    // 停摆 5 天：这次投递应该把 dueAt 一次推到未来。
    const wake = day1 + 5 * DAY
    const due = engine.dueNow(wake)
    assert.equal(due.length, 1, '唤醒时必须提醒一次')
    engine.markReminded(due, wake)

    // 紧接着再问：不该继续补发。
    const right = engine.dueNow(wake + 60_000)
    assert.equal(right.length, 0, '不能把落下的 5 次一次性补发出来')
    store.close()
  })

  it('只改 dueAt 时幂等键必须变（否则推进被静默丢弃）', () => {
    // 规则级断言，不经过端到端路径。
    //
    // 端到端那条（下面「推进 dueAt 必须真的写进日志」）**分辨不出**
    // dueAt 在不在键里：advanceDue 顺手改了 updatedAt，键碰巧变了。
    // 反向验证 M3 把 dueAt 从键里摘掉时它依然绿——**绿在巧合上**。
    // 所以这里直接把「只有 dueAt 不同」的两张卡拿来比键。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const written = writeReminder(engine, '每天早上九点提醒我喝水')
    const full = engine.query({}).find((item) => item.id === written.id)
    assert.ok(full !== undefined, '前提：必须能取回刚写的卡')

    const keyA = deriveIdempotencyKey({ op: 'put', card: full })
    // 只动 dueAt，updatedAt / strength / status / accessCount 全部不动。
    const keyB = deriveIdempotencyKey({ op: 'put', card: { ...full, dueAt: written.dueAt + DAY } })
    assert.notEqual(keyA, keyB, '只改 dueAt 时幂等键必须变——不变则推进会被静默丢弃')
    store.close()
  })

  it('时钟回拨（now 早于 dueAt）时仍然推进', () => {
    // 守 Math.max(now, card.dueAt)：只用 now 的话 nextDueAfter 会原样
    // 返回 dueAt，推进变成空操作**且不报错**，看起来像成功了。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')

    const day1 = card.dueAt + 1000
    const due = engine.dueNow(day1)
    assert.equal(due.length, 1)
    // 故意传一个**早于 dueAt** 的时刻，模拟时钟回拨 / 调用方传错。
    engine.markReminded(due, card.dueAt - 3600 * 1000)

    const reloaded = engine.query({}).find((item) => item.id === card.id)
    assert.notEqual(reloaded?.dueAt, card.dueAt, '即使 now 早于 dueAt，也必须推进')
    assert.ok((reloaded?.dueAt ?? 0) > card.dueAt, '推进后的时刻必须严格更大')
    store.close()
  })

  it('投递失败（未调 markReminded）时下次轮询还能重试', () => {
    // markReminded 是「投递成功后」才调的。这条守的是顺序：
    // 先投递后推进，投递失败不推进。
    const dir = tempDir()
    const { store, engine } = openEngine(dir)
    const card = writeReminder(engine, '每天早上九点提醒我喝水')

    const day1 = card.dueAt + 1000
    assert.equal(engine.dueNow(day1).length, 1)
    // 故意不调 markReminded（模拟投递抛异常）。
    assert.equal(engine.dueNow(day1 + 60_000).length, 1, '没投递成功就该能重试')

    const reloaded = engine.query({}).find((item) => item.id === card.id)
    assert.equal(reloaded?.dueAt, card.dueAt, '没投递成功不该推进 dueAt')
    store.close()
  })
})
