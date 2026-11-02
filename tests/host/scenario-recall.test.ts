/**
 * 场景验收 SC-1 / SC-2：跨会话回忆与口语化任务召回。
 *
 * 需求原文（`docs/1-需求规格.md` §12.2）：
 * - **SC-1**：次日问「我们昨天聊了什么」，要点正确且不编造。
 * - **SC-2**：提到「上次部署」，能召回当时的原因与结论。
 *
 * ## 为什么这个文件难写
 *
 * 这两条最容易写成**装饰性测试**：
 *
 * ```ts
 * assert.ok(result.pack.cards.length > 0)   // ✗ 绿在任何非空结果上
 * ```
 *
 * 库里有四张卡，随便召回一张都满足它。真正要证明的是：
 * **「跨会话」那一条被召回**，以及**口语化查询命中的是「那次部署」，不是别的卡**。
 *
 * ## 探针实测（写测试前先跑的，不是猜的）
 *
 * | 查询 | 候选数 | 目标卡排名 |
 * |---|---|---|
 * | 「上次部署是怎么做的」 | 3 | **第 2** |
 * | 「上次部署的方案」 | 3 | **第 2** |
 * | 「部署方案结论」 | 3 | **第 1** |
 *
 * **关键发现：口语化短查询下目标卡排第 2，不是第 1。** 压过它的是时间更新的卡
 * （recency 项）。这不是缺陷——「上次部署」本身没说要「方案」，一张三天前的
 * 部署报错卡按规则确实可能更相关。
 *
 * 所以 SC-2 的断言**不能写「必须排第一」**——那会把一个巧合固化成契约，
 * 换个打分权重就翻红，而它红的理由和 SC-2 毫无关系。
 * 正确做法见下面 `SC-2 任务召回` 的断言选择说明。
 *
 * @module tests/host/scenario-recall.test
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { MemoryConfig } from '../../src/core/config.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { makeConfig } from '../consolidate/fixtures.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = Date.UTC(2024, 4, 20, 2, 0, 0)
const DAY_MS = 24 * 60 * 60 * 1000

const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/** 建临时目录并登记清理。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-scenario-')
  tempDirs.push(dir)
  return dir
}

/** 一个「会话」：真实打开的 store + 引擎，`close()` 即关库。 */
interface Session {
  engine: MemoryEngine
  close: () => void
}

/**
 * 在指定目录上开一个会话（模拟一次进程启动）。
 *
 * 每个会话都重新 `openStore`，这是「跨会话」的关键——同一进程内复用同一个
 * store 测不出任何持久化问题。
 *
 * @param dir - 数据目录。
 * @param config - 生效配置。
 * @returns 会话句柄。
 */
function openSession(dir: string, config: MemoryConfig): Session {
  const store = openStore({ dataDir: dir, config })
  const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: () => T0 })
  return { engine, close: () => store.close() }
}

/**
 * 写入一轮对话并断言**真的写进去了**。
 *
 * 抽取层有门控（信号词 + 显著性阈值），句子可能一张卡都抽不出来。
 * 若不校验 `written > 0`，后面「召回不到」会红在「根本没写入」上——
 * 那不是召回的问题。这是本文件所有用例的前提。
 *
 * @param session - 会话。
 * @param input - 一轮对话。
 * @returns 写入的卡片。
 */
function writeTurnStrict(
  session: Session,
  input: { turn: number; text: string; at: number },
): { id: string; text: string }[] {
  const summary = session.engine.writeTurn({
    sessionId: 'session-A',
    turn: input.turn,
    step: 1,
    seq: input.turn,
    userText: input.text,
    assistantText: '',
    domain: 'work',
    at: input.at,
  })
  assert.ok(
    summary.written > 0,
    `前提：这一轮必须抽出至少一张卡，否则后面的召回断言没有意义。实际 written=${summary.written}，文本=${input.text}`,
  )
  return summary.cards.map((c) => ({ id: c.id, text: c.text }))
}

// ---------------------------------------------------------------------------
// SC-1 跨会话回忆
// ---------------------------------------------------------------------------

describe('SC-1 跨会话回忆', () => {
  it('上个会话写的记忆，新会话能召回**同一条**（不是「有结果」）', () => {
    const dir = tempDir()
    const config = makeConfig()

    // ---- 会话 A：写入一条带唯一专名的记忆 ----
    const a = openSession(dir, config)
    const written = writeTurnStrict(a, {
      turn: 1,
      text: '记住「跨会话哨兵」这个代号：我们的部署流程改成了蓝绿发布，先起绿环境验证再切流量。',
      at: T0,
    })
    // 前提：确认写进去的确实是我们要找的那条。
    assert.equal(written.length, 1, '前提：这一轮应恰好写一张卡')
    const targetId = written[0]!.id
    assert.ok(written[0]!.text.includes('跨会话哨兵'), '前提：卡片文本必须保留专名')

    // 前提：**同一会话内**就能召回。没有这条，「新会话能召回」可能绿在
    // 「本来就能召回」上——那测的是召回，不是跨会话。
    const inSession = a.engine.recall('跨会话哨兵')
    assert.deepEqual(
      inSession.pack.cards.map((s) => s.card.id),
      [targetId],
      '前提：同一会话内必须能召回，否则问题不在跨会话',
    )
    a.close()

    // ---- 会话 B：关库后重开，用同一个专名召回 ----
    const b = openSession(dir, config)
    const recalled = b.engine.recall('跨会话哨兵')

    // 核心断言：**按 id 精确比对**，不是 `length > 0`。
    assert.deepEqual(
      recalled.pack.cards.map((s) => s.card.id),
      [targetId],
      '新会话必须召回上个会话写的那一条（按 id 比对，不是「有结果」）',
    )
    b.close()
  })

  it('跨会话召回结果不依赖会话 id（换 sessionId 不影响命中）', () => {
    const dir = tempDir()
    const config = makeConfig()

    // 会话 A 用 session-A 写入。
    const a = openSession(dir, config)
    const written = writeTurnStrict(a, {
      turn: 1,
      text: '记住「哨兵二号」：数据库连接池上限调到了五十，原因是高峰期出现过连接等待超时的报错。',
      at: T0,
    })
    const targetId = written[0]!.id
    a.close()

    // 会话 B 换一个**完全不同的** sessionId 写入并召回。
    const b = openSession(dir, config)
    const other = b.engine.writeTurn({
      sessionId: 'session-COMPLETELY-DIFFERENT',
      turn: 1,
      step: 1,
      seq: 1,
      userText: '我们决定把前端构建从全量改成增量编译，原因是全量构建要等十二分钟太慢。',
      assistantText: '',
      domain: 'work',
      at: T0 + DAY_MS,
    })
    assert.ok(other.written > 0, '前提：新会话也要真的写进去一张卡')

    const recalled = b.engine.recall('哨兵二号')
    // 召回不按 sessionId 过滤——记忆是跨会话共享的（SC-1 的前提）。
    assert.deepEqual(
      recalled.pack.cards.map((s) => s.card.id),
      [targetId],
      '召回不得按 sessionId 过滤：上个会话写的卡必须能被任意会话召回',
    )
    b.close()
  })

  it('关库重开后记忆条数不翻倍（重放是幂等的）', () => {
    const dir = tempDir()
    const config = makeConfig()

    const a = openSession(dir, config)
    writeTurnStrict(a, {
      turn: 1,
      text: '我们决定把周会挪到周四下午，因为周三所有人都很忙，这个约定以后不再改。',
      at: T0,
    })
    const before = a.engine.health().active
    // 前提：必须有卡，否则「不翻倍」绿在 0 上。
    assert.ok(before > 0, '前提：必须真的写进去了卡')
    a.close()

    // 连续重开两次：每次重放都会读一遍日志，累积错误会翻倍。
    const b = openSession(dir, config)
    assert.equal(b.engine.health().active, before, '重开一次后条数不应变化')
    b.close()

    const c = openSession(dir, config)
    assert.equal(c.engine.health().active, before, '再重开一次后条数仍不应变化')
    c.close()
  })

  it('重放得到的卡片内容与写入时逐字段相同（不只是条数对）', () => {
    const dir = tempDir()
    const config = makeConfig()

    const a = openSession(dir, config)
    const written = writeTurnStrict(a, {
      turn: 1,
      text: '我们决定把数据库连接池上限调到五十，原因是高峰期出现过连接等待超时的报错。',
      at: T0,
    })
    const originalId = written[0]!.id
    const original = a.engine.inspect(originalId)
    // 前提：写入后立刻能查到，否则「重放后相同」可能绿在「两边都是 undefined」。
    assert.ok(original !== undefined, '前提：写入后必须能按 id 查到卡片')
    a.close()

    const b = openSession(dir, config)
    const replayed = b.engine.inspect(originalId)
    assert.ok(replayed !== undefined, '重放后必须能按 id 查到同一张卡')

    // ## 为什么这条断言与「条数不翻倍」并存
    //
    // 「条数不翻倍」有个诚实的边界：`store.reload()` 每次都调
    // `rebuildState(journal.readAll())`——**从零建一个全新状态**，
    // 不是往旧状态上叠加。所以「条数翻倍」在当前实现下**结构上不可能发生**，
    // 那条断言实际上永远绿（反向验证已证实：把 recall 整个打空它仍绿）。
    //
    // 我不能假装它守住了什么，所以补这一条：重放后的**内容**必须逐字段相同。
    // 这守的是「投影层不得改写事实」这一类问题——它真的发生过：
    // `coerceCard` 曾把未知 `kind` 降级成 `fact`，日志写 A、重放得 B，
    // 破坏 ST-1 且事后无从发现。
    //
    // ## 这条断言的诚实边界（反向验证结论）
    //
    // 已实测：把 `coerceKind` 改回「未知值降级成 fact」，**这条仍然绿**。
    // 原因是我写入的句子分类结果都是已知 kind，库里根本没有未知值可降级。
    //
    // 那不是漏测——`coerceKind` 的透传语义已由 `tests/store/state.test.ts`
    // 的 `未知枚举值不静默降级（前向兼容）` 三条用例直接覆盖（那里手工构造
    // `kind: 'summary'` 的日志记录，走真实 `applyRecord` 路径）。
    // **本文件不重复那件事，只在端到端层面确认「普通卡片往返不失真」。**
    assert.deepEqual(replayed, original, '重放后的卡片必须与写入时逐字段相同（端到端往返不失真）')
    b.close()
  })
})

// ---------------------------------------------------------------------------
// SC-2 任务召回
// ---------------------------------------------------------------------------

/**
 * SC-2 的标准场景：三张卡都含「部署」词项，只有一张是「方案与结论」。
 *
 * 为什么要三张都含「部署」：倒排索引按词项召回，若只有一张含该词，
 * 候选池恒为 1，「排序」断言就退化成「存在性」断言（探针实测过这个坑）。
 *
 * @param dir - 数据目录。
 * @param config - 生效配置。
 * @returns 目标卡的 id（「蓝绿发布」那张）。
 */
function seedDeployScenario(dir: string, config: MemoryConfig): string {
  const s = openSession(dir, config)
  const rounds = [
    {
      turn: 1,
      text: '部署脚本一直报错，原因是环境变量没有配置，我们决定以后部署前先跑一次自检。',
      at: T0 - 6 * DAY_MS,
    },
    {
      turn: 2,
      text: '部署方案最终选了蓝绿发布，原因是要能一键回滚，结论是先起绿环境验证再切流量。',
      at: T0 - 3 * DAY_MS,
    },
    {
      turn: 3,
      text: '我们决定把回滚流程写进运维手册，约定每次部署之后都要演练一次。',
      at: T0 - 1 * DAY_MS,
    },
  ]
  let targetId = ''
  for (const round of rounds) {
    const cards = writeTurnStrict(s, round)
    // 目标卡是第 2 轮写的那张。
    if (round.turn === 2) targetId = cards[0]!.id
  }
  s.close()
  return targetId
}

describe('SC-2 任务召回', () => {
  it('问「上次部署」时，那次部署的方案卡必须**进候选池**（不是进包）', () => {
    const dir = tempDir()
    const config = makeConfig()
    const targetId = seedDeployScenario(dir, config)

    const s = openSession(dir, config)
    const result = s.engine.recall('上次部署是怎么做的')

    // 前提：候选池必须多于一张。若只有一张，「命中」可能只是「唯一」。
    // 探针实测：三张都含「部署」词项时 candidates = 3。
    assert.ok(
      result.candidates > 1,
      `前提：候选池必须多于一张，否则「命中」等于「唯一」。实际 candidates=${result.candidates}`,
    )

    // 核心断言：目标卡在**打过分的结果**里，且分数过绝对阈值。
    // 用 `pack.cards` 而不是「候选池」，因为候选池只是倒排索引粗筛，
    // 进候选不等于召回——SC-2 要的是「能召回」。
    const hit = result.pack.cards.find((s) => s.card.id === targetId)
    assert.ok(
      hit !== undefined,
      `「上次部署」必须召回那次部署的方案卡。实际召回：${result.pack.cards.map((s) => s.card.text.slice(0, 18)).join(' | ')}`,
    )
    assert.ok(
      hit.score.total >= config.recall.absoluteThreshold,
      `召回结果必须过绝对阈值（由规则决定，不是巧合）。实际 total=${hit.score.total}`,
    )
    s.close()
  })

  it('口语化短查询下目标卡排在前列，但不要求排第一（排序由规则决定）', () => {
    const dir = tempDir()
    const config = makeConfig()
    const targetId = seedDeployScenario(dir, config)

    const s = openSession(dir, config)
    const result = s.engine.recall('上次部署是怎么做的')

    const rank = result.pack.cards.findIndex((sc) => sc.card.id === targetId)
    assert.notEqual(rank, -1, '前提：目标卡必须进包，否则排名无从谈起')

    // ## 为什么断言「前 2」而不是「第 1」
    //
    // 探针实测：这个查询下目标卡排第 2，压过它的是「部署脚本报错」那张——
    // 它时间更新（recency 项更高）。查询本身只说「上次部署」，没说要「方案」，
    // 所以按规则那张卡确实可能更相关。
    //
    // 断言「必须第 1」会把一个巧合固化成契约：换个 recency 衰减常数就翻红，
    // 而它红的理由和 SC-2 毫无关系。这正是 AGENTS.md §五「让测试由规则决定，
    // 而不是由巧合决定」要防的。
    //
    // 断言「前 2」仍然有意义：它排除「目标卡被埋在后面」这种真实退化。
    assert.ok(
      rank < 2,
      `「上次部署」时方案卡必须排在前列（实测第 2，recency 更高的报错卡在其前）。实际排名=${rank + 1}，包内 ${result.pack.cards.length} 张`,
    )
    s.close()
  })

  it('查询越具体，目标卡排名越靠前（证明排序响应查询，不是恒定顺序）', () => {
    const dir = tempDir()
    const config = makeConfig()
    const targetId = seedDeployScenario(dir, config)

    const s = openSession(dir, config)
    const vague = s.engine.recall('上次部署是怎么做的')
    const precise = s.engine.recall('部署方案结论')

    const vagueRank = vague.pack.cards.findIndex((sc) => sc.card.id === targetId)
    const preciseRank = precise.pack.cards.findIndex((sc) => sc.card.id === targetId)
    assert.notEqual(vagueRank, -1, '前提：口语化查询下目标卡必须进包')
    assert.notEqual(preciseRank, -1, '前提：具体查询下目标卡必须进包')

    // 这条守的是「排序真的看查询文本」——若打分把 semantic 项弄丢，
    // 两次查询会得到同一个顺序，这条就红。
    // 探针实测：口语化第 2、具体第 1。
    assert.ok(
      preciseRank <= vagueRank,
      `越具体的查询，目标卡排名不应更差。口语化=${vagueRank + 1}，具体=${preciseRank + 1}`,
    )
    // 具体查询下语义分必须明显更高，这才能解释「为什么排名更好」。
    const vagueSem = vague.pack.cards[vagueRank]!.score.semantic
    const preciseSem = precise.pack.cards[preciseRank]!.score.semantic
    assert.ok(
      preciseSem > vagueSem,
      `具体查询的语义分必须更高。口语化=${vagueSem.toFixed(4)}，具体=${preciseSem.toFixed(4)}`,
    )
    s.close()
  })

  it('库里没有部署记忆时，问「上次部署」不应编造（返回空包）', () => {
    const dir = tempDir()
    const config = makeConfig()

    // 只写一条与部署**完全无关**的记忆。
    const a = openSession(dir, config)
    writeTurnStrict(a, {
      turn: 1,
      text: '我们决定把周会挪到周四下午，因为周三所有人都很忙，这个约定以后不再改。',
      at: T0,
    })
    a.close()

    const b = openSession(dir, config)
    const result = b.engine.recall('上次部署是怎么做的')

    // SC-1 的验收原文是「要点正确且**不编造**」。这条守的就是「不编造」：
    // 库里没有部署记忆时，不能硬塞一张不相关的卡进焦点包。
    //
    // 注意这里不断言 `candidates === 0`：倒排索引可能因共享虚词而粗筛出候选，
    // 那是索引行为，不是召回行为。真正要守的是「焦点包是空的」。
    assert.deepEqual(
      result.pack.cards.map((s) => s.card.id),
      [],
      `库里没有部署记忆时焦点包必须为空（不编造）。实际召回：${result.pack.cards.map((s) => s.card.text.slice(0, 20)).join(' | ')}`,
    )
    b.close()
  })
})
