/**
 * 五字段 cron 的解析与「下一次」计算（FR-D3 的第四种重复方式）。
 *
 * 需求原文：「到期提醒：一次性/每日/每周/cron，到期投递并唤醒」。
 * cron 在这一条里是**明确列出**的，不是「将来扩展」。
 *
 * 这一层为什么必须单独测：cron 的错法全都**不报错**。
 * 一个被误解的表达式会在错误的时间叫醒用户，而用户没有任何办法
 * 从「响得不对」反推出是解析错了。所以判据必须是**具体时刻**，
 * 不能是「解析出来了」或「结果落在合理范围」。
 */
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { nextCronAfter, parseCron } from '../../src/time/cron.ts'
import { formatTime } from '../../src/core/scoring.ts'
import { nextDueAfter, parseDue } from '../../src/time/due.ts'

const TZ = 'Asia/Shanghai'
/**
 * 2023-11-15 **14:13** 上海，周三。
 *
 * 注意 `Date.UTC(2023,10,15,6,13)` 是 UTC 06:13，换算到上海是 14:13。
 * 我第一版把注释写成 06:13 并按「当天九点还没到」写期望值，
 * 于是三条用例红了——**红的是我的期望值，不是实现**。
 * 时刻一律用 `formatTime` 断言，就是为了让这种错立刻暴露。
 */
const T0 = Date.UTC(2023, 10, 15, 6, 13, 0)
const DAY = 24 * 60 * 60 * 1000

let root = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-memory-cron-'))
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('cron · 解析', () => {
  it('五字段基本形式', () => {
    const spec = parseCron('0 9 * * 1-5')
    assert.ok(spec !== null)
    assert.deepEqual(spec.minutes, [0])
    assert.deepEqual(spec.hours, [9])
    assert.deepEqual(spec.daysOfWeek, [1, 2, 3, 4, 5])
    assert.equal(spec.domRestricted, false)
    assert.equal(spec.dowRestricted, true)
  })

  it('步长展开为具体值（*/15 是 0,15,30,45）', () => {
    const spec = parseCron('*/15 * * * *')
    assert.ok(spec !== null)
    assert.deepEqual(spec.minutes, [0, 15, 30, 45])
  })

  it('区间加步长（0-30/10）', () => {
    const spec = parseCron('0-30/10 * * * *')
    assert.ok(spec !== null)
    assert.deepEqual(spec.minutes, [0, 10, 20, 30])
  })

  it('枚举与名称（MON-FRI / JAN）', () => {
    const spec = parseCron('0 9 * JAN MON-FRI')
    assert.ok(spec !== null)
    assert.deepEqual(spec.months, [1])
    assert.deepEqual(spec.daysOfWeek, [1, 2, 3, 4, 5])
  })

  it('星期 7 归一化为 0（周日不能出现两次）', () => {
    const spec = parseCron('0 9 * * 7')
    assert.ok(spec !== null)
    assert.deepEqual(spec.daysOfWeek, [0], '7 与 0 都是周日，必须归一化')
  })

  it('字段数不对返回 null（不猜）', () => {
    assert.equal(parseCron('0 9 * *'), null)
    assert.equal(parseCron('0 9 * * * *'), null, '六字段（含秒）不支持，不能静默忽略秒')
  })

  it('超范围返回 null', () => {
    assert.equal(parseCron('60 * * * *'), null, '分钟 60 不存在')
    assert.equal(parseCron('0 24 * * *'), null, '小时 24 不存在')
    assert.equal(parseCron('0 9 32 * *'), null, '日 32 不存在')
    assert.equal(parseCron('0 9 * 13 *'), null, '月 13 不存在')
  })

  it('Quartz 扩展语法返回 null（不支持就明说，不静默当别的意思）', () => {
    assert.equal(parseCron('0 9 L * *'), null)
    assert.equal(parseCron('0 9 * * 5#2'), null)
  })

  it('跨边界区间返回 null（没有公认语义）', () => {
    assert.equal(parseCron('0 9 * * FRI-MON'), null)
  })
})

describe('cron · 下一次命中时刻', () => {
  it('工作日九点：周三 14:13 算出周四九点（当天九点已过）', () => {
    const spec = parseCron('0 9 * * 1-5')
    assert.ok(spec !== null)
    const next = nextCronAfter(spec, T0, TZ, 366)
    assert.ok(next !== null)
    assert.equal(formatTime(next, TZ), '2023-11-16 09:00')
  })

  it('工作日九点：周三 08:00 算出当天九点', () => {
    const spec = parseCron('0 9 * * 1-5')
    assert.ok(spec !== null)
    // 上海 08:00 = UTC 00:00
    const wednesday8 = Date.UTC(2023, 10, 15, 0, 0, 0)
    const next = nextCronAfter(spec, wednesday8, TZ, 366)
    assert.ok(next !== null)
    assert.equal(formatTime(next, TZ), '2023-11-15 09:00')
  })

  it('工作日九点：周五九点之后跳到下周一（cron 没有固定间隔）', () => {
    const spec = parseCron('0 9 * * 1-5')
    assert.ok(spec !== null)
    // 2023-11-17 是周五，10:00 已过当天九点。
    const friday10 = Date.UTC(2023, 10, 17, 2, 0, 0)
    const next = nextCronAfter(spec, friday10, TZ, 366)
    assert.ok(next !== null)
    assert.equal(formatTime(next, TZ), '2023-11-20 09:00', '周五之后是下周一，不是周六')
  })

  it('严格晚于 now：now 恰好命中时返回下一次而不是自己', () => {
    // 这条守的是 FR-D3 推进的根本性质。若允许返回自己，
    // 「推进」就是空操作，提醒会被反复投递同一次。
    const spec = parseCron('0 9 * * *')
    assert.ok(spec !== null)
    const exactly9 = Date.UTC(2023, 10, 15, 1, 0, 0)
    const next = nextCronAfter(spec, exactly9, TZ, 366)
    assert.ok(next !== null)
    assert.ok(next > exactly9, '必须严格大于 now')
    assert.equal(formatTime(next, TZ), '2023-11-16 09:00')
  })

  it('日与周都受限时取「或」（Vixie cron 语义）', () => {
    // `0 9 1 * 1` 的原意是「每月 1 号**或**每周一」。
    // 写成「且」的话一年只命中几次，用户会以为提醒坏了。
    const spec = parseCron('0 9 1 * 1')
    assert.ok(spec !== null)
    // 2023-11-15 是周三。下一个周一是 11-20。
    const next = nextCronAfter(spec, T0, TZ, 366)
    assert.ok(next !== null)
    assert.equal(formatTime(next, TZ), '2023-11-20 09:00', '周三之后最近的命中是下周一')
  })

  it('永不可能的表达式在搜索上界内返回 null（不死循环）', { timeout: 3000 }, () => {
    // 2 月 30 日不存在。没有上界就是**死循环**——而它不报错，只会挂住，
    // 表现为「提醒再也不响了」而不是「提醒报错了」。
    //
    // 所以这条必须带 `timeout`：断言 `=== null` 只能证明「没找到」，
    // 证明不了「有上界」。去掉上界时它会**超时变红**，那才是真的守住。
    // 反向验证第一版把 `Number.isFinite(x) && x >= 1` 改成 `Number.isFinite(x)`，
    // 结果 fail=0——那是**等价变异**（30 两个分支都走同一条路），
    // 不是测试没牙。换成真正去掉上界才命中。
    const spec = parseCron('0 0 30 2 *')
    assert.ok(spec !== null, '语法合法，只是永不命中')
    assert.equal(nextCronAfter(spec, T0, TZ, 30), null)
  })

  it('2023-11 起算能找到 2024-02-29（366 天窗口确实覆盖闰日）', () => {
    // 我第一版把这条写成「找不到」，理由是「366 天覆盖不了 4 年闰年周期」——
    // **结论对，用的例子错**：从 2023-11-15 起 366 天到 2024-11-15，
    // 2024-02-29 正好在窗口内。测试红了才发现例子选错。
    const spec = parseCron('0 0 29 2 *')
    assert.ok(spec !== null)
    const next = nextCronAfter(spec, T0, TZ, 366)
    assert.ok(next !== null)
    assert.equal(formatTime(next, TZ), '2024-02-29 00:00')
  })

  it('闰日之后的 366 天窗口找不到下一个 2 月 29 日（真实局限）', () => {
    // 这条**故意断言这个局限**：从 2024-03-01 起，下一个 2 月 29 日是 2028 年，
    // 366 天窗口覆盖不了 4 年闰年周期。将来若把默认上界改大，这条会变红，
    // 提醒同步改文档——而不是让人以为 cron 坏了。
    const spec = parseCron('0 0 29 2 *')
    assert.ok(spec !== null)
    const afterLeap = Date.UTC(2024, 2, 1, 0, 0, 0)
    assert.equal(nextCronAfter(spec, afterLeap, TZ, 366), null)
    // 把窗口放大就能找到——证明「找不到」是窗口限制，不是解析错。
    const wider = nextCronAfter(spec, afterLeap, TZ, 1500)
    assert.ok(wider !== null)
    assert.equal(formatTime(wider, TZ), '2028-02-29 00:00')
  })
})

describe('cron · 接进 FR-D3 的重复推进', () => {
  it('parseDue 识别 cron: 前缀并返回 cronExpression', () => {
    const spec = parseDue('提醒我开会 cron: 0 9 * * 1-5', T0, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'cron')
    assert.equal(spec.cronExpression, '0 9 * * 1-5')
    assert.equal(formatTime(spec.dueAt, TZ), '2023-11-16 09:00')
  })

  it('nextDueAfter 的 cron 分支按表达式重新求值，不按固定步长', () => {
    const spec = parseDue('提醒我开会 cron: 0 9 * * 1-5', T0, TZ)
    assert.ok(spec !== null)
    // 周五九点响过之后，下一次必须是下周一，不是「+24h 的周六」。
    const friday9 = Date.UTC(2023, 10, 17, 1, 0, 0)
    const next = nextDueAfter(friday9, 'cron', friday9 + 60_000, TZ, {
      cronExpression: '0 9 * * 1-5',
    })
    assert.ok(next !== null)
    assert.equal(formatTime(next, TZ), '2023-11-20 09:00')
  })

  it('表达式非法时返回 null，不猜下一次', () => {
    const next = nextDueAfter(T0, 'cron', T0, TZ, { cronExpression: '这不是 cron' })
    assert.equal(next, null)
  })
})

describe('cron · 端到端：cron 提醒必须每次到点都响', () => {
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

  it('cron 提醒落盘表达式，重放后仍在', () => {
    const dir = mkdtempSync(join(root, 'case-'))
    const first = openEngine(dir)
    first.engine.writeTurn({
      sessionId: 's1', turn: 1, step: 1, seq: 1,
      userText: '提醒我站会 cron: 0 9 * * 1-5', assistantText: '好的', domain: 'work', at: T0,
    })
    const card = first.engine.query({}).find((item) => item.dueRepeat === 'cron')
    assert.ok(card !== undefined, '前提：必须产出 cron 提醒卡')
    assert.equal(card.cronExpression, '0 9 * * 1-5')
    first.store.close()

    // 跨进程：重放后表达式还在，否则这张卡再也算不出下一次。
    const second = openEngine(dir)
    const reloaded = second.engine.query({}).find((item) => item.id === card.id)
    assert.equal(reloaded?.cronExpression, '0 9 * * 1-5', '表达式必须穿过重放层')
    assert.equal(reloaded?.dueRepeat, 'cron')
    second.store.close()
  })

  it('cron 提醒响过之后推进到下一次命中', () => {
    const dir = mkdtempSync(join(root, 'case-'))
    const { store, engine } = openEngine(dir)
    engine.writeTurn({
      sessionId: 's1', turn: 1, step: 1, seq: 1,
      userText: '提醒我站会 cron: 0 9 * * 1-5', assistantText: '好的', domain: 'work', at: T0,
    })
    const card = engine.query({}).find((item) => item.dueRepeat === 'cron')
    assert.ok(card !== undefined)

    const at = (card.dueAt as number) + 60_000
    const due = engine.dueNow(at)
    assert.equal(due.length, 1, '到期必须命中')
    engine.markReminded(due, at)

    // 第二天（周四）九点应该再响。
    const nextDay = at + DAY
    const again = engine.dueNow(nextDay)
    assert.equal(again.length, 1, 'cron 提醒第二天必须再响')
    store.close()
  })
})
