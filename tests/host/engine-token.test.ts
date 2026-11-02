/**
 * 连续多轮的注入预算稳定性单测（ST-6 / FR-E3）。
 *
 * ## 为什么要单独一个文件
 *
 * ST-6 是 `docs/1-需求规格.md` §12.1 里**唯一完全没有测试**的验收项，而且
 * 照字面实现会得到一个**永远红**的测试。`docs/6-测试覆盖与验收缺口.md`
 * 第三部分 P0-1 记录了这个陷阱，这里按它给的结论落地。
 *
 * ## 核心陷阱：预热期与饱和期必须分开断言
 *
 * 焦点包从「空」到「装满 7 张」有一个必然的爬坡过程，实测 token 从 27 涨到
 * 189（**7 倍**）。如果照 §12.1 字面「连续 50 轮波动 ≤ ±10%」从第 1 轮开始量，
 * 这个测试永远不可能通过，然后它会被当成「写错的测试」删掉——**删掉之后
 * ST-6 就再也没人守了，而且没人记得曾经有过**。
 *
 * 所以这里拆成两组：
 * - 预热期：断言 token 随卡数**单调上升**，并断言跨度**必然**远超 ±10%
 *   （后一条是前提校验：万一将来跨度变小了，说明爬坡行为变了，要重新审视）。
 * - 饱和期：断言波动 ≤ ±10%、不单调增长、卡数恒定。
 *
 * ## 为什么必须用真实 store
 *
 * `MemoryEngine` 的构造要求 `store`，而 `openStore` 会真的写盘。用内存假
 * store 就测不到「库变大之后 token 会不会膨胀」——那正是 ST-6 要守的东西
 * （FR-C4「库增长有界」的注入侧对应）。所以用临时目录，`MemoryEngine`
 * 接受注入 `clock`，全程确定性。
 *
 * @module tests/host/engine-token.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'
import type { TurnInput } from '../../src/core/extraction.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeConfig } from '../consolidate/fixtures.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

/** 时区固定，避免测试结果随运行环境漂移。 */
const TZ = 'Asia/Shanghai'

/** 基准时刻，固定值保证可重复。 */
const T0 = 1_700_000_000_000

/** 一分钟毫秒数；每轮推进一分钟。 */
const MINUTE_MS = 60 * 1000

/** ST-6 要求连续观察的轮数。 */
const ROUNDS = 50

/**
 * 焦点包装满所需轮数。
 *
 * 从 `DEFAULT_CONFIG.recall.maxCards` 推导而不是写死 7：将来 `maxCards` 改成
 * 别的值时，这个测试自动跟着走，不需要有人记得改。
 */
const WARMUP_ROUNDS = DEFAULT_CONFIG.recall.maxCards

/** 已创建的临时目录，`after` 里统一清理。 */
const tempDirs: string[] = []

/**
 * 建临时目录并登记清理。
 *
 * @returns 目录绝对路径。
 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-token-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/**
 * 构造一轮对话输入。
 *
 * 每轮换一个可区分的话题词（「集群 N」），保证卡不会被去重合并掉——
 * 否则「每轮多一张卡」这个前提不成立，预热期断言会失去意义。
 *
 * @param round - 轮次（从 1 开始）。
 * @param at - 该轮时刻。
 * @returns 写入输入。
 */
function turnInput(round: number, at: number): TurnInput {
  return {
    sessionId: 's-token',
    turn: round,
    step: 1,
    seq: round,
    userText: `第 ${round} 轮：我们决定把服务部署到集群 ${round}，方案已经确定`,
    assistantText: '',
    domain: 'work',
    at,
  }
}

/** 一次多轮跑批的结果。 */
interface RoundRun {
  /** 每轮的注入 token 数。 */
  tokens: number[]
  /** 每轮的焦点包卡片数。 */
  cards: number[]
  /** 生效配置。 */
  config: MemoryConfig
  /** 记忆库（调用方负责 close）。 */
  store: MemoryStore
  /** 最后一轮的时刻。 */
  lastAt: number
}

/**
 * 逐轮写入并召回，收集每轮的注入规模。
 *
 * @param rounds - 轮数。
 * @returns 每轮 token、卡数、配置与库。
 */
function runRounds(rounds: number): RoundRun {
  const dir = tempDir()
  const config = makeConfig({ storage: { dataDir: dir } })
  const store = openStore({ config, dataDir: dir })
  let now = T0
  const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: () => now })

  const tokens: number[] = []
  const cards: number[] = []
  for (let round = 1; round <= rounds; round += 1) {
    now = T0 + round * MINUTE_MS
    engine.writeTurn(turnInput(round, now))
    const result = engine.recall(`第 ${round} 轮部署方案`)
    tokens.push(result.pack.tokens)
    cards.push(result.pack.cards.length)
  }
  return { tokens, cards, config, store, lastAt: now }
}

/**
 * 求算术均值。
 *
 * @param values - 数值序列。
 * @returns 均值。
 */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

describe('FR-E3 每轮注入不超硬预算', () => {
  it('连续 50 轮每轮 token 都不超过 tokenBudget', () => {
    const { tokens, config, store } = runRounds(ROUNDS)
    for (const [index, value] of tokens.entries()) {
      assert.ok(
        value <= config.recall.tokenBudget,
        `第 ${index + 1} 轮 token ${value} 超出预算 ${config.recall.tokenBudget}`,
      )
    }
    store.close()
  })

  it('每轮 token 都不小于头尾固定开销（固定开销真的被算进去了）', () => {
    // 这条守的是「头尾固定开销被计入预算」——如果没计入，空包时会报 0，
    // 而实际注入的固定文字仍要占 token，预算上限就失真了（FR-E3）。
    const { tokens, config, store } = runRounds(WARMUP_ROUNDS)
    for (const [index, value] of tokens.entries()) {
      assert.ok(
        value >= config.recall.overheadTokens,
        `第 ${index + 1} 轮 token ${value} 小于固定开销 ${config.recall.overheadTokens}`,
      )
    }
    store.close()
  })

  it('卡数不超过 maxCards（硬上限，不因库变大而膨胀）', () => {
    const { cards, config, store } = runRounds(ROUNDS)
    for (const [index, value] of cards.entries()) {
      assert.ok(
        value <= config.recall.maxCards,
        `第 ${index + 1} 轮 ${value} 张卡，超过 maxCards ${config.recall.maxCards}`,
      )
    }
    store.close()
  })
})

describe('ST-6 预热期行为（焦点包未装满）', () => {
  it('前若干轮 token 随卡数单调上升——这是正常爬坡，不是抖动', () => {
    const { tokens, store } = runRounds(WARMUP_ROUNDS)
    for (let i = 1; i < tokens.length; i += 1) {
      assert.ok(
        tokens[i]! > tokens[i - 1]!,
        `第 ${i + 1} 轮 ${tokens[i]} 应大于第 ${i} 轮 ${tokens[i - 1]}`,
      )
    }
    store.close()
  })

  it('预热期 token 跨度必然远超 ±10%（所以 ST-6 不能从第 1 轮开始量）', () => {
    // 这是**前提校验**而不是验收断言：它证明「从第 1 轮量 ±10% 必然失败」
    // 这个判断成立。若将来爬坡行为变了导致跨度变小，这条会红，提醒重新
    // 审视 ST-6 的测量窗口——而不是让 ST-6 悄悄变成一条永远绿的假测试。
    const { tokens, store } = runRounds(WARMUP_ROUNDS)
    const span = Math.max(...tokens) - Math.min(...tokens)
    const average = mean(tokens)
    assert.ok(
      span > average * 0.1,
      `预热期跨度 ${span} 若不大于均值 10%（${(average * 0.1).toFixed(1)}），说明前提变了`,
    )
    store.close()
  })
})

describe('ST-6 饱和期波动 ≤ ±10%', () => {
  it('焦点包装满后，连续 50 轮 token 波动不超过均值的 ±10%', () => {
    const { tokens, store } = runRounds(ROUNDS)
    const steady = tokens.slice(WARMUP_ROUNDS - 1)
    assert.ok(steady.length >= 40, `饱和期样本应 ≥ 40，实际 ${steady.length}`)

    const average = mean(steady)
    const low = Math.min(...steady)
    const high = Math.max(...steady)
    assert.ok(
      high - low <= average * 0.1,
      `波动 ${high - low} 超过均值 ${average.toFixed(1)} 的 10%（low=${low} high=${high}）`,
    )
    store.close()
  })

  it('第 50 轮 token 不高于第 7 轮的 110%（不单调增长）', () => {
    const { tokens, store } = runRounds(ROUNDS)
    const baseline = tokens[WARMUP_ROUNDS - 1]!
    const last = tokens[ROUNDS - 1]!
    assert.ok(
      last <= baseline * 1.1,
      `第 50 轮 ${last} 相对第 7 轮 ${baseline} 增长超过 10%`,
    )
    store.close()
  })

  it('饱和期卡数恒等于 maxCards（不再随轮数变化）', () => {
    const { cards, config, store } = runRounds(ROUNDS)
    const steady = cards.slice(WARMUP_ROUNDS - 1)
    for (const [index, value] of steady.entries()) {
      assert.equal(
        value, config.recall.maxCards,
        `饱和期第 ${index + 1} 个样本 ${value} 张卡，不等于 maxCards ${config.recall.maxCards}`,
      )
    }
    store.close()
  })
})

describe('ST-1 相同查询在库增长后仍确定', () => {
  it('同一轮内重复召回同一查询结果完全一致', () => {
    // ST-1 确定性：同状态同查询，10 次结果一致。这里在同一时刻连做两次，
    // 因为 `recall` 已改为只读（FR-B7），第二次看到的状态与第一次完全相同。
    const { store, config, lastAt } = runRounds(WARMUP_ROUNDS)
    const engine = new MemoryEngine({
      store, config, timeZone: TZ, clock: () => lastAt,
    })
    const first = engine.recall('部署方案')
    const second = engine.recall('部署方案')
    assert.deepEqual(
      first.pack.cards.map((item) => item.card.id),
      second.pack.cards.map((item) => item.card.id),
    )
    assert.equal(first.pack.tokens, second.pack.tokens)
    assert.equal(first.text, second.text)
    store.close()
  })
})
