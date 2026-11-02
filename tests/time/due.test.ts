/**
 * 到期时刻解析单测。
 *
 * 覆盖目标：FR-D3（一次性/每日/每周）、起源 L21（定闹钟）、
 * ST-1（确定性：同样输入同样输出，不依赖运行时时区）。
 *
 * 所有用例都用固定的 `now` 与显式时区，绝不读系统时间。
 *
 * @module tests/time/due.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { localDate } from '../../src/time/clock.ts'
import {
  isoWeekday, parseClockTime, parseDayOffset, parseDue, parseNumber, ymd,
  zonedTimeToMs,
} from '../../src/time/due.ts'

const TZ = 'Asia/Shanghai'
// 2024-01-15 是星期一，本地时间 10:00。
const MONDAY_10AM = Date.UTC(2024, 0, 15, 2, 0, 0)

describe('parseNumber', () => {
  it('阿拉伯数字', () => {
    assert.equal(parseNumber('3'), 3)
    assert.equal(parseNumber('15'), 15)
    assert.equal(parseNumber('0'), 0)
  })

  it('单个中文数字', () => {
    assert.equal(parseNumber('三'), 3)
    assert.equal(parseNumber('十'), 10)
    assert.equal(parseNumber('两'), 2)
  })

  it('十位组合', () => {
    assert.equal(parseNumber('十五'), 15)
    assert.equal(parseNumber('二十'), 20)
    assert.equal(parseNumber('二十三'), 23)
  })

  it('无法解析返回 null', () => {
    assert.equal(parseNumber(''), null)
    assert.equal(parseNumber('abc'), null)
  })
})

describe('isoWeekday / ymd', () => {
  it('2024-01-15 是周一', () => {
    assert.equal(isoWeekday(MONDAY_10AM, TZ), 1)
  })

  it('2024-01-21 是周日', () => {
    assert.equal(isoWeekday(Date.UTC(2024, 0, 21, 2, 0, 0), TZ), 7)
  })

  it('ymd 按指定时区取年月日', () => {
    assert.deepEqual(ymd(MONDAY_10AM, TZ), { year: 2024, month: 1, day: 15 })
  })

  it('跨时区日期不同（UTC 与上海）', () => {
    // UTC 2024-01-15 20:00 = 上海 2024-01-16 04:00
    const at = Date.UTC(2024, 0, 15, 20, 0, 0)
    assert.equal(ymd(at, 'UTC').day, 15)
    assert.equal(ymd(at, TZ).day, 16)
  })
})

describe('zonedTimeToMs', () => {
  it('构造上海时间 15:00 得到正确时间戳', () => {
    const ms = zonedTimeToMs(2024, 1, 15, 15, 0, TZ)
    assert.equal(localDate(ms, TZ), '2024-01-15')
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms))
    assert.equal(hour, '15:00')
  })

  it('构造 UTC 时间得到正确时间戳', () => {
    const ms = zonedTimeToMs(2024, 1, 15, 15, 0, 'UTC')
    assert.equal(ms, Date.UTC(2024, 0, 15, 15, 0, 0))
  })

  it('往返一致：构造后再解析回同样的年月日', () => {
    const ms = zonedTimeToMs(2024, 6, 30, 9, 30, TZ)
    assert.deepEqual(ymd(ms, TZ), { year: 2024, month: 6, day: 30 })
  })
})

describe('parseClockTime', () => {
  it('HH:MM 形式', () => {
    assert.deepEqual(parseClockTime('15:30 提醒我'), { hour: 15, minute: 30 })
    assert.deepEqual(parseClockTime('9:05'), { hour: 9, minute: 5 })
  })

  it('中文全角冒号', () => {
    assert.deepEqual(parseClockTime('15：30'), { hour: 15, minute: 30 })
  })

  it('下午三点', () => {
    assert.deepEqual(parseClockTime('下午三点提醒我'), { hour: 15, minute: 0 })
  })

  it('晚上八点', () => {
    assert.deepEqual(parseClockTime('晚上八点'), { hour: 20, minute: 0 })
  })

  it('上午十点', () => {
    assert.deepEqual(parseClockTime('上午十点'), { hour: 10, minute: 0 })
  })

  it('凌晨十二点归零', () => {
    assert.deepEqual(parseClockTime('凌晨十二点'), { hour: 0, minute: 0 })
  })

  it('半点', () => {
    assert.deepEqual(parseClockTime('下午三点半'), { hour: 15, minute: 30 })
  })

  it('一刻 / 三刻', () => {
    assert.deepEqual(parseClockTime('下午三点一刻'), { hour: 15, minute: 15 })
    assert.deepEqual(parseClockTime('下午三点三刻'), { hour: 15, minute: 45 })
  })

  it('N 点 M 分', () => {
    assert.deepEqual(parseClockTime('下午三点二十五分'), { hour: 15, minute: 25 })
  })

  it('只给时段给默认时刻', () => {
    assert.deepEqual(parseClockTime('中午提醒我'), { hour: 12, minute: 0 })
    assert.deepEqual(parseClockTime('半夜提醒我'), { hour: 0, minute: 0 })
  })

  it('没有钟点线索返回 null', () => {
    assert.equal(parseClockTime('提醒我交报告'), null)
  })

  it('中午十二点不重复加 12', () => {
    assert.deepEqual(parseClockTime('中午十二点'), { hour: 12, minute: 0 })
  })
})

describe('parseDayOffset', () => {
  it('今天 / 明天 / 后天 / 大后天', () => {
    assert.equal(parseDayOffset('今天', MONDAY_10AM, TZ)?.dayOffset, 0)
    assert.equal(parseDayOffset('明天', MONDAY_10AM, TZ)?.dayOffset, 1)
    assert.equal(parseDayOffset('后天', MONDAY_10AM, TZ)?.dayOffset, 2)
    assert.equal(parseDayOffset('大后天', MONDAY_10AM, TZ)?.dayOffset, 3)
  })

  it('N 天后', () => {
    assert.equal(parseDayOffset('3 天后', MONDAY_10AM, TZ)?.dayOffset, 3)
    assert.equal(parseDayOffset('三天后', MONDAY_10AM, TZ)?.dayOffset, 3)
  })

  it('本周内已过的星期顺延到下周', () => {
    // 今天是周一，「周五」= 4 天后。
    assert.equal(parseDayOffset('周五', MONDAY_10AM, TZ)?.dayOffset, 4)
    // 「周一」就是今天，顺延到下周 = 7 天后。
    assert.equal(parseDayOffset('周一', MONDAY_10AM, TZ)?.dayOffset, 7)
  })

  it('下周X 至少 7 天后', () => {
    // 今天周一，「下周一」= 7 天后。
    assert.equal(parseDayOffset('下周一', MONDAY_10AM, TZ)?.dayOffset, 7)
    // 「下周五」= 11 天后。
    assert.equal(parseDayOffset('下周五', MONDAY_10AM, TZ)?.dayOffset, 11)
  })

  it('没有日期线索返回 null', () => {
    assert.equal(parseDayOffset('提醒我交报告', MONDAY_10AM, TZ), null)
  })
})

describe('parseDue 一次性提醒', () => {
  it('明天下午三点提醒我', () => {
    const spec = parseDue('明天下午三点提醒我交周报', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'once')
    assert.equal(localDate(spec.dueAt, TZ), '2024-01-16')
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(spec.dueAt))
    assert.equal(hour, '15:00')
  })

  it('只说钟点且时刻已过则顺延到明天', () => {
    // 现在是 10:00，说「下午三点」指今天 15:00（还没到）。
    const today = parseDue('下午三点提醒我', MONDAY_10AM, TZ)
    assert.ok(today !== null)
    assert.equal(localDate(today.dueAt, TZ), '2024-01-15')

    // 现在是 16:00，说「下午三点」应指明天。
    const at4pm = Date.UTC(2024, 0, 15, 8, 0, 0)
    const tomorrow = parseDue('下午三点提醒我', at4pm, TZ)
    assert.ok(tomorrow !== null)
    assert.equal(localDate(tomorrow.dueAt, TZ), '2024-01-16')
  })

  it('没有到期线索的句子不产生到期', () => {
    assert.equal(parseDue('今天很累', MONDAY_10AM, TZ), null)
    assert.equal(parseDue('这个项目用 Qt5', MONDAY_10AM, TZ), null)
  })

  it('有日期没钟点用默认小时', () => {
    const spec = parseDue('明天提醒我交报告', MONDAY_10AM, TZ, 8)
    assert.ok(spec !== null)
    assert.equal(localDate(spec.dueAt, TZ), '2024-01-16')
    const hour = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, hour: '2-digit', hour12: false,
    }).format(new Date(spec.dueAt))
    assert.equal(hour, '08')
  })

  it('截止日期也能解析', () => {
    const spec = parseDue('截止日期是后天下午六点，别忘了', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.equal(localDate(spec.dueAt, TZ), '2024-01-17')
  })
})

describe('parseDue 重复提醒', () => {
  it('每天早上八点提醒我 → daily', () => {
    const spec = parseDue('每天早上八点提醒我喝水', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'daily')
    // 现在 10:00，今天 08:00 已过，下一次是明天 08:00。
    assert.equal(localDate(spec.dueAt, TZ), '2024-01-16')
  })

  it('每天提醒在未来时刻用今天', () => {
    const spec = parseDue('每天下午三点提醒我', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'daily')
    assert.equal(localDate(spec.dueAt, TZ), '2024-01-15')
  })

  it('每周一早上九点 → weekly', () => {
    const spec = parseDue('每周一早上九点提醒我开周会', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'weekly')
    // 今天周一 10:00，09:00 已过，下一次是下周一。
    assert.equal(localDate(spec.dueAt, TZ), '2024-01-22')
  })

  it('每周五 → weekly 落在周五', () => {
    const spec = parseDue('每周五下午五点提醒我写周报', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.equal(spec.repeat, 'weekly')
    assert.equal(isoWeekday(spec.dueAt, TZ), 5)
  })

  it('重复提醒的 dueAt 一定在未来', () => {
    for (const text of ['每天提醒我', '每周提醒我', '每周三提醒我', '每天早上提醒我']) {
      const spec = parseDue(text, MONDAY_10AM, TZ)
      assert.ok(spec !== null, text)
      assert.ok(spec.dueAt > MONDAY_10AM, `${text} 的 dueAt 应在未来`)
    }
  })
})

describe('parseDue 确定性与安全性', () => {
  it('同样输入永远同样输出（ST-1）', () => {
    const a = parseDue('明天下午三点提醒我', MONDAY_10AM, TZ)
    const b = parseDue('明天下午三点提醒我', MONDAY_10AM, TZ)
    assert.deepEqual(a, b)
  })

  it('matched 带回原文便于解释', () => {
    const spec = parseDue('明天下午三点提醒我交周报', MONDAY_10AM, TZ)
    assert.ok(spec !== null)
    assert.ok(spec.matched.includes('提醒'))
  })

  it('解析不出时不猜（宁可不提醒）', () => {
    assert.equal(parseDue('随便聊聊', MONDAY_10AM, TZ), null)
    assert.equal(parseDue('', MONDAY_10AM, TZ), null)
  })
})
