/**
 * 感受蒸馏单测（起源 L11 / L19 / FR-C5）。
 *
 * 本文件要证明三件事，缺一条「感受蒸馏」就只是句口号：
 *
 * 1. 感受**真的从事件卡提炼出来**（不是被规则打上 `feeling` 标签）；
 * 2. 感受卡带 `distills` 边**指向来源事件卡**（起源 L15 跨层次关联）；
 * 3. 感受卡**不被归档流程吃掉**（FR-C3 / `neverArchiveKinds`）。
 *
 * 还要如实验证它的**局限**：它是规则版，靠情绪强度与主题共现，不做语义理解。
 * 所以有一条用例专门断言「它不会凭空产出感受」。
 *
 * @module tests/core/distill.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  bucketByTheme, DISTILL_EVENT_TYPE, DISTILL_SESSION_ID, distillFeelings,
  feelingToCard, hasFeelingSignal, isDistilledCard,
} from '../../src/core/distill.ts'
import { distillEdges } from '../../src/core/graph.ts'
import { runConsolidation } from '../../src/consolidate/nightly.ts'
import { shouldArchive } from '../../src/consolidate/archive.ts'
import type { MemoryCard } from '../../src/core/types.ts'
import { DAY_MS, makeCard, makeConfig } from '../consolidate/fixtures.ts'

/** 测试时区：东八区。 */
const TZ = 'Asia/Shanghai'

/** 基准时刻。 */
const T0 = 1_700_000_000_000

/**
 * 造一张带情绪的卡，主题词固定为「上线」，便于聚桶。
 *
 * @param id - 卡片 id。
 * @param at - 创建时刻。
 * @param emotional - 情绪强度。
 * @param over - 其余覆盖。
 * @returns 记忆卡。
 */
function emotionalCard(
  id: string, at: number, emotional: number, over: Partial<MemoryCard> = {},
): MemoryCard {
  return makeCard({
    id,
    kind: 'event',
    createdAt: at,
    updatedAt: at,
    emotional,
    text: `今天上线又出问题了，压力很大，第 ${id} 次`,
    entities: ['上线'],
    tags: ['发布'],
    ...over,
  })
}

describe('hasFeelingSignal：什么算「有感受」', () => {
  it('情绪达到阈值才算', () => {
    const config = makeConfig()
    const threshold = config.consolidation.distillMinEmotional
    assert.equal(hasFeelingSignal(emotionalCard('a', T0, threshold), config), true)
    assert.equal(hasFeelingSignal(emotionalCard('b', T0, threshold - 0.01), config), false)
  })

  it('归档卡与已合并卡不参与蒸馏', () => {
    const config = makeConfig()
    const archived = emotionalCard('a', T0, 0.9, { status: 'archived' })
    const merged = emotionalCard('b', T0, 0.9, { mergedInto: 'other' })
    assert.equal(hasFeelingSignal(archived, config), false)
    assert.equal(hasFeelingSignal(merged, config), false)
  })

  it('派生的感受卡不参与再蒸馏（防止自激循环）', () => {
    // 这条测试**改过断言**，原断言是 `{ kind: 'feeling' }` → false。
    // 那个断言把缺陷写成了契约：判据用的是 `kind` 标签，而 `kind` 是
    // 分类器给的、会被改动的东西；注释承诺的却是「感受卡本身」。
    // 修好情绪通道后真实情绪句几乎都被判成 `feeling`（缺陷二十八），
    // 于是**原话卡**被这条规则一并排除，蒸馏候选集又空了（缺陷三十）。
    //
    // 正确判据是「是不是蒸馏产物」，在数据层可见：`source.sessionId === 'distill'`。
    const config = makeConfig()
    const derived = makeCard({
      id: 'f', kind: 'feeling', emotional: 0.9,
      createdAt: T0, updatedAt: T0,
      source: { sessionId: DISTILL_SESSION_ID, turn: 0, step: 0, seq: 1, eventType: DISTILL_EVENT_TYPE },
    })
    assert.equal(hasFeelingSignal(derived, config), false)

    // 配对反向对照：**原话**的 feeling 卡必须仍然参与蒸馏。
    // 只测「派生卡被排除」是半个测试——把所有 feeling 都排除也能让它绿。
    const original = emotionalCard('o', T0, 0.9, { kind: 'feeling' })
    assert.equal(
      hasFeelingSignal(original, config), true,
      '原话的 feeling 卡必须参与蒸馏，否则修好情绪通道后蒸馏又变成空转',
    )
  })
})

describe('bucketByTheme：按主题聚桶统计「反复经历」', () => {
  it('同一主题的两张卡聚成一个桶', () => {
    const config = makeConfig()
    const cards = [emotionalCard('a', T0, 0.8), emotionalCard('b', T0 + 3_600_000, 0.6)]
    const buckets = bucketByTheme(cards, config)
    assert.ok(buckets.length >= 1)
    const launch = buckets.find((bucket) => bucket.theme === '上线')
    assert.notEqual(launch, undefined, '应聚出「上线」这个主题桶')
    assert.equal(launch!.cards.length, 2)
    assert.ok(Math.abs(launch!.emotional - 0.7) < 1e-9, '情绪应取平均 0.7')
  })

  it('只出现一次的主题不成为桶（不到 distillMinRecurrence）', () => {
    const config = makeConfig()
    const one = emotionalCard('a', T0, 0.8)
    const buckets = bucketByTheme([one], config)
    assert.equal(buckets.length, 0, '只出现一次谈不上「反复」')
  })

  it('桶按情绪降序、次数降序、主题升序排列（ST-1 确定性）', () => {
    const config = makeConfig()
    const cards = [
      emotionalCard('a', T0, 0.5),
      emotionalCard('b', T0 + 1, 0.5),
      makeCard({
        id: 'c', kind: 'event', createdAt: T0, updatedAt: T0, emotional: 0.9,
        text: '评审会开得很糟', entities: ['评审'],
      }),
      makeCard({
        id: 'd', kind: 'event', createdAt: T0 + 1, updatedAt: T0 + 1, emotional: 0.9,
        text: '评审会又要开了', entities: ['评审'],
      }),
    ]
    const forward = bucketByTheme(cards, config)
    const backward = bucketByTheme([...cards].reverse(), config)
    assert.deepEqual(
      forward.map((bucket) => bucket.theme),
      backward.map((bucket) => bucket.theme),
      '桶顺序必须与输入顺序无关',
    )
    // 情绪更高的「评审」应排在「上线」前面。
    assert.equal(forward[0]!.theme, '评审')
  })
})

describe('distillFeelings：真的从事件里提炼感受', () => {
  it('反复出现的强情绪主题产出感受草稿', () => {
    const config = makeConfig()
    const cards = [
      emotionalCard('a', T0, 0.8),
      emotionalCard('b', T0 + 3_600_000, 0.7),
      emotionalCard('c', T0 + 7_200_000, 0.6),
    ]
    const drafts = distillFeelings(cards, config)
    assert.equal(drafts.length, 1, '应产出 1 条感受')
    const draft = drafts[0]!
    assert.equal(draft.theme, '上线')
    assert.equal(draft.recurrence, 3)
    assert.equal(draft.sourceIds.length, 3)
    // 感受文本必须可读且提到主题。
    assert.ok(draft.text.includes('上线'), `感受文本应提到主题，实际：${draft.text}`)
    assert.ok(draft.text.includes('3 次'), `感受文本应提到次数，实际：${draft.text}`)
  })

  it('来源顺序按 createdAt 升序，结果确定（ST-1）', () => {
    const config = makeConfig()
    const early = emotionalCard('early', T0, 0.8)
    const late = emotionalCard('late', T0 + 3_600_000, 0.8)
    const forward = distillFeelings([early, late], config)[0]!
    const backward = distillFeelings([late, early], config)[0]!
    assert.deepEqual(forward.sourceIds, backward.sourceIds)
    assert.deepEqual(forward.sourceIds, ['early', 'late'])
    assert.equal(forward.text, backward.text)
  })

  it('没有情绪的日子不产出感受（宁可没有，也不要噪声）', () => {
    const config = makeConfig()
    const calm = [
      makeCard({ id: 'a', createdAt: T0, text: '今天写了点代码', entities: ['代码'] }),
      makeCard({ id: 'b', createdAt: T0 + 1, text: '又写了点代码', entities: ['代码'] }),
    ]
    assert.equal(distillFeelings(calm, config).length, 0)
  })

  it('distillEnabled 关闭时什么都不产出', () => {
    const config = makeConfig({ consolidation: { distillEnabled: false } })
    const cards = [emotionalCard('a', T0, 0.9), emotionalCard('b', T0 + 1, 0.9)]
    assert.equal(distillFeelings(cards, config).length, 0)
  })

  it('受 distillMaxPerRun 限制', () => {
    const config = makeConfig({ consolidation: { distillMaxPerRun: 1 } })
    const cards = [
      emotionalCard('a', T0, 0.9), emotionalCard('b', T0 + 1, 0.9),
      makeCard({
        id: 'c', kind: 'event', createdAt: T0, updatedAt: T0, emotional: 0.9,
        text: '评审很糟', entities: ['评审'],
      }),
      makeCard({
        id: 'd', kind: 'event', createdAt: T0 + 1, updatedAt: T0 + 1, emotional: 0.9,
        text: '评审又来', entities: ['评审'],
      }),
    ]
    assert.equal(distillFeelings(cards, config).length, 1, '应受上限约束只产出 1 条')
  })
})

describe('feelingToCard：落成真实的感受卡', () => {
  it('kind 是 feeling，文本与主题进标签/实体，可被检索', () => {
    const config = makeConfig()
    const cards = [emotionalCard('a', T0, 0.8), emotionalCard('b', T0 + 1, 0.7)]
    const draft = distillFeelings(cards, config)[0]!
    const feeling = feelingToCard(draft, cards, T0 + DAY_MS, config)
    assert.equal(feeling.kind, 'feeling')
    assert.equal(feeling.status, 'active')
    assert.deepEqual(feeling.tags, ['上线'])
    assert.deepEqual(feeling.entities, ['上线'])
    // 感受卡不该被钉住：它已在 neverArchiveKinds 里受保护，再钉住是过度保护。
    assert.equal(feeling.pinned, false)
  })

  it('id 由内容派生，重复构造得到同一个 id（幂等）', () => {
    const config = makeConfig()
    const cards = [emotionalCard('a', T0, 0.8), emotionalCard('b', T0 + 1, 0.7)]
    const draft = distillFeelings(cards, config)[0]!
    const first = feelingToCard(draft, cards, T0 + DAY_MS, config)
    const second = feelingToCard(draft, cards, T0 + 2 * DAY_MS, config)
    assert.equal(first.id, second.id)
  })

  it('来源指针标明是派生数据，不伪装成某轮对话', () => {
    const config = makeConfig()
    const cards = [emotionalCard('a', T0, 0.8), emotionalCard('b', T0 + 1, 0.7)]
    const draft = distillFeelings(cards, config)[0]!
    const feeling = feelingToCard(draft, cards, T0, config)
    assert.equal(feeling.source.sessionId, 'distill')
    assert.equal(feeling.source.eventType, 'consolidate/feeling')
    assert.equal(feeling.source.turn, 0)
  })
})

describe('distills 边（起源 L15 跨层次关联，七种边的第一个真实产出）', () => {
  it('感受卡指向每一张来源事件卡', () => {
    const config = makeConfig()
    const cards = [emotionalCard('a', T0, 0.8), emotionalCard('b', T0 + 1, 0.7)]
    const draft = distillFeelings(cards, config)[0]!
    const feeling = feelingToCard(draft, cards, T0, config)
    const edges = distillEdges(
      feeling.id, draft.sourceIds, config.consolidation.distillEdgeWeight, T0,
    )
    assert.equal(edges.length, 2, '每张来源卡一条边')
    for (const edge of edges) {
      assert.equal(edge.from, feeling.id, '方向：感受 → 来源')
      assert.equal(edge.relation, 'distills')
      assert.equal(edge.weight, config.consolidation.distillEdgeWeight)
      assert.ok(draft.sourceIds.includes(edge.to))
    }
  })

  it('没有来源时不产边（凭空产生的感受不该存在）', () => {
    assert.deepEqual(distillEdges('f', [], 0.6, T0), [])
  })

  it('跳过自环', () => {
    const edges = distillEdges('f', ['f', 'a'], 0.6, T0)
    assert.equal(edges.length, 1)
    assert.equal(edges[0]!.to, 'a')
  })

  it('重复来源只产一条边（幂等）', () => {
    const edges = distillEdges('f', ['a', 'a', 'b'], 0.6, T0)
    assert.equal(edges.length, 2)
  })
})

describe('夜整理里的感受蒸馏（端到端）', () => {
  it('整理一轮后库里出现 feeling 卡与 distills 边', () => {
    const config = makeConfig()
    const cards = [
      emotionalCard('a', T0, 0.8),
      emotionalCard('b', T0 + 3_600_000, 0.7),
      emotionalCard('c', T0 + 7_200_000, 0.6),
    ]
    const result = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const feelings = result.cards.filter((card) => card.kind === 'feeling')
    assert.equal(feelings.length, 1, '应产出 1 张感受卡')
    assert.equal(result.report.distilled, 1)

    const feeling = feelings[0]!
    // 这是关键断言：distills 边真的出现在返回结果里，不是只存在于设想中。
    const distillEdgesOfFeeling = result.edges.filter((edge) => edge.relation === 'distills')
    assert.ok(distillEdgesOfFeeling.length > 0, 'distills 边必须被真实产出')
    for (const edge of distillEdgesOfFeeling) {
      assert.equal(edge.from, feeling.id)
    }
  })

  it('感受卡不会被归档流程吃掉（FR-C3 / neverArchiveKinds）', () => {
    const config = makeConfig({ forgetting: { archiveThreshold: 0.99 } })
    const cards = [
      emotionalCard('a', T0, 0.9),
      emotionalCard('b', T0 + 1, 0.9),
    ]
    const result = runConsolidation({ cards }, config, T0 + 400 * DAY_MS, TZ)
    const feeling = result.cards.find((card) => card.kind === 'feeling')
    assert.notEqual(feeling, undefined, '应产出感受卡')
    // 即便强度被衰减到很低、阈值高到 0.99，感受卡也不该被归档。
    assert.equal(feeling!.status, 'active', '感受卡必须存活')
    assert.equal(shouldArchive(feeling!, config), false, 'shouldArchive 必须拒绝归档感受卡')
  })

  it('重复整理不重复产出感受卡（幂等）', () => {
    const config = makeConfig()
    const cards = [emotionalCard('a', T0, 0.8), emotionalCard('b', T0 + 1, 0.7)]
    const first = runConsolidation({ cards }, config, T0 + DAY_MS, TZ)
    const feelingsFirst = first.cards.filter((card) => card.kind === 'feeling')
    assert.equal(feelingsFirst.length, 1)

    // 用第一轮的结果再整理一次：不该多出第二张感受卡。
    const second = runConsolidation(
      { cards: first.cards, edges: first.edges }, config, T0 + 2 * DAY_MS, TZ,
    )
    const feelingsSecond = second.cards.filter((card) => card.kind === 'feeling')
    assert.equal(feelingsSecond.length, 1, '重复整理不应堆出重复感受卡')
    assert.equal(second.report.distilled, 0, '第二轮不该再蒸馏出新的感受')
  })
})

describe('诚实性：这是规则版，不是语义理解', () => {
  it('极性不同但强度相同的两件事，会被蒸馏成同一条感受', () => {
    // 「被夸」与「被骂」在情绪上相反，但 computeEmotional 只算强度不算极性。
    // 这条用例**故意断言这个局限存在**：将来若引入极性，它会变红，
    // 提醒修改者同步更新模块文档里的局限说明。
    const config = makeConfig()
    const praise = makeCard({
      id: 'p', kind: 'event', createdAt: T0, updatedAt: T0, emotional: 0.8,
      text: '领导夸我做得好，特别开心', entities: ['领导'],
    })
    const blame = makeCard({
      id: 'b', kind: 'event', createdAt: T0 + 1, updatedAt: T0 + 1, emotional: 0.8,
      text: '领导骂我做错了，特别崩溃', entities: ['领导'],
    })
    const drafts = distillFeelings([praise, blame], config)
    assert.equal(drafts.length, 1)
    // 产出的感受只说「反复牵动情绪」，不说「开心」或「难过」——
    // 因为规则版判断不出极性，写出来就是让文本撒谎。
    assert.ok(!drafts[0]!.text.includes('开心'), '不应声称知道是正面情绪')
    assert.ok(!drafts[0]!.text.includes('难过'), '不应声称知道是负面情绪')
    assert.ok(drafts[0]!.text.includes('反复'), '只能声称「反复牵动情绪」')
  })

  it('没有共现主题时宁可不出感受，也不硬造', () => {
    const config = makeConfig()
    // 两张高情绪卡，但主题完全不同，不构成「反复经历」。
    const one = makeCard({
      id: 'a', kind: 'event', createdAt: T0, updatedAt: T0, emotional: 0.9,
      text: '上线出事故了', entities: ['上线'],
    })
    const two = makeCard({
      id: 'b', kind: 'event', createdAt: T0 + 1, updatedAt: T0 + 1, emotional: 0.9,
      text: '考试没过', entities: ['考试'],
    })
    assert.equal(distillFeelings([one, two], config).length, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷二十九 / 三十：蒸馏在真实语料上恒为空
//
// 这两个缺陷和缺陷二十八**互相独立**，而且方向相反地掩盖了对方：
//   缺陷二十八：情绪句写不进来  ⇒ 蒸馏没有原料
//   缺陷二十九：主题词取错了粒度 ⇒ 桶数恒为 0
//   缺陷三十：判据用 kind 标签 ⇒ 修好二十八之后原料又被排除
//
// 三者叠加的观测结果完全一样：`distilled = 0`。
// 所以「修好一处就以为蒸馏会动」是错的——**三个零长得一模一样**。
// ─────────────────────────────────────────────────────────────────────────────

describe('themeTerms：主题词必须是词项，不是整句（缺陷二十九）', () => {
  it('无实体的卡按分词取主题，不按空格切整句', () => {
    // normalizeText 把标点全换成空格，于是 `normalized.split(' ')` 切出来的
    // 是整段长句。两张不同的情绪卡之间几乎不可能共享整段长句，
    // 桶数因此恒为 0，蒸馏恒为空——而它只是一个安静的 0。
    const config = makeConfig()
    const a = makeCard({
      id: 'a', kind: 'feeling', emotional: 0.8, createdAt: T0, updatedAt: T0,
      text: '这个报错又出现了，压力很大',
      normalized: '这个报错又出现了 压力很大',
      entities: [],
    })
    const b = makeCard({
      id: 'b', kind: 'feeling', emotional: 0.7, createdAt: T0 + 1000, updatedAt: T0 + 1000,
      text: '还是那个报错，真的很烦',
      normalized: '还是那个报错 真的很烦',
      entities: [],
    })
    const buckets = bucketByTheme([a, b], config)
    assert.ok(buckets.length > 0, '两张共享「报错」的卡必须能聚成桶')
    // 前提：主题词必须是**词项**而不是整句。整句长 10 字以上，
    // 词项是二元组级别——用长度区分，防止退化成按空格切。
    const longest = Math.max(...buckets.map((bucket) => bucket.theme.length))
    assert.ok(
      longest <= 4,
      `主题词必须是词项（长度 <= 4），实际最长 ${longest}：`
      + `${JSON.stringify(buckets.map((b) => b.theme))}`,
    )
  })

  it('主题词不得含标点（缺陷二十九的直接判据）', () => {
    // 曾经产出 `"，这"`、`"了，"` 这种主题，感受卡写成
    // 「『，这』这件事反复牵动我的情绪」。主题词是判据，假主题会让
    // 两张本来无关的卡聚成桶。
    const config = makeConfig()
    const cards = [
      makeCard({
        id: 'a', kind: 'feeling', emotional: 0.8, createdAt: T0, updatedAt: T0,
        text: '太难了，快崩溃了', normalized: '太难了 快崩溃了', entities: [],
      }),
      makeCard({
        id: 'b', kind: 'feeling', emotional: 0.9, createdAt: T0 + 1000, updatedAt: T0 + 1000,
        text: '太难了，真的受不了', normalized: '太难了 真的受不了', entities: [],
      }),
    ]
    const buckets = bucketByTheme(cards, config)
    assert.ok(buckets.length > 0, '前提：必须能聚出桶')
    for (const bucket of buckets) {
      assert.doesNotMatch(
        bucket.theme, /[\p{P}\p{S}]/u,
        `主题词不得含标点符号，实际 ${JSON.stringify(bucket.theme)}`,
      )
    }
  })
})

describe('蒸馏在真实语料上必须真的产出感受（缺陷二十八/二十九/三十串联）', () => {
  /** 造一批「情绪反复出现」的真实语料——不含任何人工实体。 */
  function feelingCorpus(): MemoryCard[] {
    const texts = [
      ['这个报错又出现了，压力很大', '这个报错又出现了 压力很大'],
      ['还是那个报错，真的很烦', '还是那个报错 真的很烦'],
      ['报错又来了，我快崩溃了', '报错又来了 我快崩溃了'],
    ]
    return texts.map(([text, normalized], index) => makeCard({
      id: `card-${index}`, kind: 'feeling', emotional: 0.8,
      createdAt: T0 + index * 1000, updatedAt: T0 + index * 1000,
      text: text!, normalized: normalized!, entities: [],
    }))
  }

  it('反复出现的情绪必须蒸馏出感受卡（不是恒为空）', () => {
    const config = makeConfig()
    const drafts = distillFeelings(feelingCorpus(), config)
    assert.ok(
      drafts.length > 0,
      '3 张同主题、情绪全达标的卡必须蒸馏出至少一条感受（起源 L11）',
    )
    // 前提：来源必须是那批卡，否则「产出了感受」可能来自别处。
    assert.ok(
      drafts[0]!.sourceIds.length >= config.consolidation.distillMinRecurrence,
      `感受必须由至少 ${config.consolidation.distillMinRecurrence} 张来源卡支撑`,
    )
  })

  it('原话 feeling 卡参与蒸馏，派生 feeling 卡不参与（配对判据）', () => {
    // 这是缺陷三十的核心：判据必须是「是不是派生卡」，不是 `kind` 标签。
    const config = makeConfig()
    const originals = feelingCorpus()
    const derived = makeCard({
      id: 'derived', kind: 'feeling', emotional: 0.9,
      createdAt: T0, updatedAt: T0,
      text: '感受的总结', normalized: '感受的总结',
      source: {
        sessionId: DISTILL_SESSION_ID, turn: 0, step: 0, seq: 1,
        eventType: DISTILL_EVENT_TYPE,
      },
    })
    assert.equal(hasFeelingSignal(originals[0]!, config), true, '原话 feeling 卡必须参与蒸馏')
    assert.equal(hasFeelingSignal(derived, config), false, '派生 feeling 卡必须被排除（防自激循环）')
    assert.equal(isDistilledCard(derived), true)
    assert.equal(isDistilledCard(originals[0]!), false)
  })
})
