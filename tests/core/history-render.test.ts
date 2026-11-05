/**
 * 修正历史的人读渲染（FR-A5「修正后可查『改过什么、为什么』」）。
 *
 * 这个文件存在的理由是一个**已经真实存在过的缺口**：`revisions` 早就有人写
 * （engine.revise / CLI revise / `/memory revise`，15 条测试守着它写进去了），
 * 但渲染层 `grep -n revision` **只有注释命中、零渲染代码**。于是
 * 「reason 写进去了却没有任何出口读它」——需求要的「可查」根本没实现。
 *
 * 所以这里守的不是「有个函数」，而是三件容易各自悄悄失效的事：
 * 1. 没有历史时说「从未修正过」，而不是空串；
 * 2. `reason` 为空时写「未填写原因」，而不是一行空白；
 * 3. 每次修正的**时间**真的渲染出来了（少了它，`at` 就白存了）。
 *
 * 第 3 条刻意断言**精确时刻字符串**而不是 `includes('·')`：后者对
 * 「时间列永远显示 1970-01-01 08:00」同样成立——那正是「存了但没读对」的形态。
 *
 * @module tests/core/history-render.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { renderCardHistory } from '../../src/core/render.ts'
import { formatTime } from '../../src/core/scoring.ts'
import type { MemoryCard, MemoryRevision } from '../../src/core/types.ts'

const TZ = 'Asia/Shanghai'

/**
 * T0 在 Asia/Shanghai 是 2023-11-15 06:13（UTC 是前一天 22:13）。
 *
 * 用真实时间戳而不是 0：`formatTime(0, TZ)` 也能渲染出字符串，
 * 但那样断言无法区分「渲染了修正时刻」与「渲染了某个常量」。
 */
const T0 = 1_700_000_000_000

/**
 * 造一张带修正历史的卡。
 *
 * @param revisions - 修正记录（按发生先后）。
 * @returns 记忆卡。
 */
function makeCard(revisions: MemoryRevision[] = []): MemoryCard {
  return {
    id: '3f9a1c02d4e5f607',
    domain: 'work',
    kind: 'fact',
    text: '生产环境部署必须先跑数据库迁移',
    normalized: '生产环境部署必须先跑数据库迁移',
    createdAt: T0,
    updatedAt: T0,
    source: { sessionId: 'sess-1', turn: 1, step: 1, seq: 1, eventType: 'user/message' },
    salience: 0.6,
    confidence: 0.8,
    emotional: 0.2,
    strength: 0.7,
    accessCount: 0,
    lastAccessAt: null,
    tags: [],
    entities: [],
    revisions,
    status: 'active',
    conflictOf: [],
    pinned: false,
  }
}

/**
 * 造一条修正记录。
 *
 * @param at - 修正时刻。
 * @param reason - 原因，空串表示用户没填。
 * @param previousText - 被替换掉的旧正文。
 * @param actor - 发起方。
 * @returns 修正记录。
 */
function makeRevision(
  at: number,
  reason: string,
  previousText: string,
  actor: MemoryRevision['actor'] = 'manual',
): MemoryRevision {
  return { at, reason, previousText, actor }
}

describe('renderCardHistory（FR-A5 可查历史）', () => {
  it('表头带出完整 id，可以直接粘给 restore / revise', () => {
    // 人读输出里的 id 必须是**完整 id**：这是「粘过去就能用」这个承诺的实现方式。
    // 若将来改成截断，这里会红，改的人必须同时给它配一个前缀解析的断言。
    const card = makeCard()
    const text = renderCardHistory(card, TZ)
    assert.ok(text.startsWith(`卡片 id ${card.id}`), text)
    assert.ok(text.includes('当前正文：生产环境部署必须先跑数据库迁移'), text)
  })

  it('没有历史时明确写「从未修正过」，而不是空输出', () => {
    // FR-B6 的同一原则：宁可显式说明，也不要让人猜。
    // 空输出会被读成「命令坏了」——这是**修这个缺口之前**的真实体验。
    const text = renderCardHistory(makeCard(), TZ)
    assert.ok(text.includes('从未修正过'), text)
    assert.doesNotMatch(text, /修正过 \d+ 次/u, '没有历史就不能说「修正过 N 次」')
  })

  it('有历史时逐条给出时间、旧正文、原因', () => {
    const at = T0 + 3_600_000 // 07:13（Asia/Shanghai）
    const card = makeCard([makeRevision(at, '决策变更', '旧说法：用 MySQL')])
    const text = renderCardHistory(card, TZ)
    assert.ok(text.includes('修正过 1 次'), text)
    // 精确时刻：少了这条，「at 存了但没读对」不会红。
    assert.equal(formatTime(at, TZ), '2023-11-15 07:13', '前提：这个时刻的渲染值是固定的')
    assert.ok(text.includes('第 1 次 · 2023-11-15 07:13（手动修正）'), text)
    assert.ok(text.includes('  旧正文：旧说法：用 MySQL'), text)
    assert.ok(text.includes('  原因：决策变更'), text)
    assert.doesNotMatch(text, /从未修正过/u, '有历史就不能说「从未修正过」')
  })

  it('reason 为空时写「未填写原因」，不能留一行空白', () => {
    const card = makeCard([makeRevision(T0, '', '旧正文 A')])
    const text = renderCardHistory(card, TZ)
    assert.ok(text.includes('  原因：未填写原因'), text)
    // 反向：不能出现「原因：」后面什么都没有的行。留空与「渲染漏了一行」
    // 在终端里长得一模一样，所以必须显式写出来。
    const reasonLines = text.split('\n').filter((line) => line.includes('原因：'))
    assert.equal(reasonLines.length, 1)
    assert.equal(reasonLines[0], '  原因：未填写原因')
  })

  it('reason 只有空格时同样按「未填写」处理', () => {
    // 用户敲 `--reason "   "` 时写进库里的是空格。直接 `length === 0` 判空会
    // 把这种「看起来填了、实际没有」的原因原样印成一行空白。
    const card = makeCard([makeRevision(T0, '   ', '旧正文 A')])
    const text = renderCardHistory(card, TZ)
    assert.ok(text.includes('  原因：未填写原因'), text)
  })

  it('多次修正按发生先后排列，编号连续', () => {
    // 顺序是刻意的：这条历史是「这张卡怎么变成现在这样」的叙事。
    const card = makeCard([
      makeRevision(T0, '第一次', '旧 A'),
      makeRevision(T0 + 1_000, '', '旧 B'),
      makeRevision(T0 + 2_000, '第三次', '旧 C', 'consolidation'),
    ])
    const text = renderCardHistory(card, TZ)
    assert.ok(text.includes('修正过 3 次'), text)
    const order = ['第 1 次', '第 2 次', '第 3 次'].map((label) => text.indexOf(label))
    assert.deepEqual([...order].sort((a, b) => a - b), order, '编号必须按出现顺序递增')
    for (const oldText of ['旧 A', '旧 B', '旧 C']) assert.ok(text.includes(oldText), `缺少 ${oldText}`)
    // 发起方要能区分：夜整理改的和人手改的，追查时是两个方向。
    assert.ok(text.includes('（夜整理）'), text)
  })

  it('时区参数真的被用上（同一时刻两个时区渲染不同）', () => {
    // 如果哪一天有人把 `timeZone` 参数丢掉、改成写死 +08:00，
    // 上面那些用例仍然全绿（因为测试都用 Asia/Shanghai）。
    const at = T0
    const card = makeCard([makeRevision(at, '原因', '旧')])
    const shanghai = renderCardHistory(card, 'Asia/Shanghai')
    const utc = renderCardHistory(card, 'UTC')
    assert.equal(formatTime(at, 'Asia/Shanghai'), '2023-11-15 06:13', '前提：上海时刻固定')
    assert.equal(formatTime(at, 'UTC'), '2023-11-14 22:13', '前提：UTC 时刻固定')
    assert.ok(shanghai.includes('第 1 次 · 2023-11-15 06:13'), shanghai)
    assert.ok(utc.includes('第 1 次 · 2023-11-14 22:13'), utc)
    assert.notEqual(shanghai, utc, '两个时区的输出必须不同，否则 timeZone 参数没被用上')
  })

  it('同一输入渲染两次结果完全一致（ST-1 确定性）', () => {
    const card = makeCard([makeRevision(T0, '决策变更', '旧说法')])
    assert.equal(renderCardHistory(card, TZ), renderCardHistory(card, TZ))
  })
})
