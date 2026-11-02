import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTimeState, elapsed, humanize, localDate, pickDue, renderTimeContext,
  shouldRunDaily, zonedParts,
} from '../../src/time/clock.ts'
import type { MemoryCard } from '../../src/core/types.ts'

const TZ = 'Asia/Shanghai'
const NOW = Date.UTC(2024, 5, 15, 4, 0) // 2024-06-15 12:00 上海

function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  const base: MemoryCard = {
    id: 'c1', domain: 'work', kind: 'promise', text: '给出结论', normalized: '给出结论',
    createdAt: NOW, updatedAt: NOW,
    source: { sessionId: 's1', turn: 1, step: 1, seq: 1, eventType: 'user/message' },
    salience: 0.8, confidence: 0.9, emotional: 0.1, strength: 0.9,
    accessCount: 0, lastAccessAt: null, tags: [], entities: [], revisions: [],
    status: 'active', conflictOf: [], pinned: true, dueAt: null,
  }
  return { ...base, ...overrides }
}

test('localDate 按指定时区渲染自然日', () => {
  assert.equal(localDate(NOW, TZ), '2024-06-15')
})

test('localDate 跨时区会换日', () => {
  // UTC 2024-06-15 20:00 = 上海 2024-06-16 04:00
  assert.equal(localDate(Date.UTC(2024, 5, 15, 20, 0), TZ), '2024-06-16')
  assert.equal(localDate(Date.UTC(2024, 5, 15, 20, 0), 'UTC'), '2024-06-15')
})

test('elapsed 计算毫秒差', () => {
  assert.equal(elapsed(NOW, NOW - 1000), 1000)
})

test('elapsed 无历史返回 null', () => {
  assert.equal(elapsed(NOW, null), null)
})

test('elapsed 负数夹到 0', () => {
  assert.equal(elapsed(NOW, NOW + 1000), 0)
})

test('buildTimeState 组装完整字段', () => {
  const state = buildTimeState({
    now: NOW,
    timeZone: TZ,
    lastSessionEndAt: NOW - 86_400_000,
    lastTurnAt: NOW - 60_000,
    sessionStartedAt: NOW - 300_000,
    due: [],
  })
  assert.equal(state.localDate, '2024-06-15')
  assert.equal(state.sinceLastSession, 86_400_000)
  assert.equal(state.sinceLastTurn, 60_000)
  assert.equal(state.sessionStartedAt, NOW - 300_000)
})

test('buildTimeState 无历史时为 null', () => {
  const state = buildTimeState({
    now: NOW, timeZone: TZ, lastSessionEndAt: null, lastTurnAt: null, sessionStartedAt: null, due: [],
  })
  assert.equal(state.sinceLastSession, null)
  assert.equal(state.sinceLastTurn, null)
})

test('renderTimeContext 无任何信息时返回空串', () => {
  const state = buildTimeState({
    now: NOW, timeZone: TZ, lastSessionEndAt: null, lastTurnAt: null, sessionStartedAt: null, due: [],
  })
  assert.equal(renderTimeContext(state), '')
})

test('renderTimeContext 含相对时间', () => {
  const state = buildTimeState({
    now: NOW, timeZone: TZ, lastSessionEndAt: NOW - 86_400_000, lastTurnAt: null, sessionStartedAt: null, due: [],
  })
  const text = renderTimeContext(state)
  assert.ok(text.includes('距上次会话'))
  assert.ok(text.includes('1 天'))
})

test('renderTimeContext 列出到期事项', () => {
  const state = buildTimeState({
    now: NOW, timeZone: TZ, lastSessionEndAt: null, lastTurnAt: null, sessionStartedAt: null,
    due: [makeCard({ text: '交周报' })],
  })
  assert.ok(renderTimeContext(state).includes('交周报'))
})

test('humanize 各量级', () => {
  assert.equal(humanize(30_000), '30 秒')
  assert.equal(humanize(5 * 60_000), '5 分钟')
  assert.equal(humanize(3 * 3_600_000), '3 小时')
  assert.equal(humanize(2 * 86_400_000), '2 天')
  assert.equal(humanize(90 * 86_400_000), '3 个月')
  assert.equal(humanize(500 * 86_400_000), '1 年')
  assert.equal(humanize(-1), '未知')
})

test('pickDue 挑出已到期且活跃的卡', () => {
  const cards = [
    makeCard({ id: 'a', dueAt: NOW - 1000 }),
    makeCard({ id: 'b', dueAt: NOW + 1000 }),
    makeCard({ id: 'c', dueAt: null }),
    makeCard({ id: 'd', dueAt: NOW - 500, status: 'archived' }),
  ]
  const due = pickDue(cards, NOW)
  assert.equal(due.length, 1)
  assert.equal(due[0]?.id, 'a')
})

test('pickDue 按到期时间升序', () => {
  const cards = [
    makeCard({ id: 'late', dueAt: NOW - 100 }),
    makeCard({ id: 'early', dueAt: NOW - 5000 }),
  ]
  assert.deepEqual(pickDue(cards, NOW).map((c) => c.id), ['early', 'late'])
})

test('zonedParts 取本地时分', () => {
  const parts = zonedParts(NOW, TZ)
  assert.equal(parts.hour, 12)
  assert.equal(parts.minute, 0)
})

test('shouldRunDaily 未到点不触发', () => {
  // 上海 12:00，目标是 03:30，已过点
  assert.equal(shouldRunDaily(null, NOW, TZ, '23:00'), false)
})

test('shouldRunDaily 过点且从未运行则触发', () => {
  assert.equal(shouldRunDaily(null, NOW, TZ, '03:30'), true)
})

test('shouldRunDaily 今天已运行过则不重复', () => {
  const lastRun = Date.UTC(2024, 5, 15, 0, 0) // 上海 08:00，同一自然日
  assert.equal(shouldRunDaily(lastRun, NOW, TZ, '03:30'), false)
})

test('shouldRunDaily 昨天运行过则今天触发', () => {
  const lastRun = Date.UTC(2024, 5, 14, 0, 0)
  assert.equal(shouldRunDaily(lastRun, NOW, TZ, '03:30'), true)
})

test('shouldRunDaily 非法时刻不触发', () => {
  assert.equal(shouldRunDaily(null, NOW, TZ, 'oops'), false)
})
