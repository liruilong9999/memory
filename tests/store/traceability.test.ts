/**
 * ST-4 来源可追溯（需求规格 12.1：随机抽 100 张卡，100% 能定位回原始事件）。
 *
 * ## 这条测试守什么，以及它守不到什么
 *
 * FR-A4 要求「每张卡记录 session/turn/step/原文序号」，验收是「任意卡能定位回原文」。
 * 但**原文本身不在本插件的存储里**——它属于宿主的会话事件流。所以本插件能做
 * 到的「定位」只有两步：
 *
 * 1. 指针完整：`sessionId` / `turn` / `step` / `seq` / `eventType` 全部有值，
 *    且类型正确（seq、turn 是有限数，不是 NaN / undefined）。
 * 2. 指针可信：日志里那条 `put` 记录存的指针，必须与读出来的卡**逐字段一致**。
 *    这一条比第 1 条重要得多——第 1 条只证明「字段有值」，第 2 条证明
 *    「这个值是从日志来的、不是投影层现编的」。
 *
 * **测不到的那一半必须说清楚**：宿主会话原文是否真的能按 `seq` 找回来，只有
 * 宿主能验证。本文件不假装验证了它。
 *
 * ## 为什么必须抽样 100 张，而不是写 3 张卡看看
 *
 * 100 张是需求给的口径。更要紧的是：**`source` 是逐卡构造的，缺陷往往只出现在
 * 某一条产出路径上**。实测同轮多句会产出多张卡（用户 2 张 + 助手 2 张），
 * 它们共享同一个 `seq`——只看一张卡发现不了「seq 不是逐句唯一」这件事。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { JournalRecord, MemoryCard } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { makeTempDir } from './helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

const tempDirs: string[] = []
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-st4-')
  tempDirs.push(dir)
  return dir
}
after(() => {
  // 目录由 makeTempDir 登记，helpers 统一处理清理
  assert.ok(tempDirs.length > 0, '前提：本次运行确实建过临时库')
})

/**
 * 造一个 100+ 张卡的真实库：真写入、真夜整理，不是手搓卡片。
 *
 * 必须用真实链路：手搓 `makeCard` 会绕过 `extraction.ts` 里 source 的构造，
 * 那样测的是「我给的对象里字段齐不齐」，不是「系统产出的卡字段齐不齐」。
 *
 * 同时用 `onRecord` 收集日志——`journal` 是私有的，`onRecord` 才是公开出口，
 * 而且顺带省掉「再建一次库去读日志」的开销（建 120 张卡约 5 秒）。
 */
function richLibrary(): {
  store: ReturnType<typeof openStore>
  engine: MemoryEngine
  records: JournalRecord[]
} {
  const store = openStore({ dataDir: tempDir(), config: DEFAULT_CONFIG })
  const records: JournalRecord[] = []
  store.onRecord((record) => records.push(record))
  const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: () => T0 })
  for (let i = 0; i < 120; i += 1) {
    engine.writeTurn({
      sessionId: 's-1',
      turn: i + 1,
      step: 1,
      seq: i + 1,
      userText: `第 ${i + 1} 件事：决定把模块 m${i + 1} 的配置改成值 v${i + 1}`,
      assistantText: '',
      domain: 'work',
      at: T0 + (i + 1) * 1000,
    } as never)
  }
  engine.consolidate(T0 + 300_000)
  return { store, engine, records }
}

describe('ST-4 来源可追溯（需求规格 12.1）', () => {
  // 这个库建一次要 5 秒（120 张卡 + 夜整理）。每个用例各建一次会让这个文件
  // 跑 15 秒，而三个用例读的是**同一份**库——没有理由建三次。
  // 用例只读不写，所以共享是安全的；写在 `after` 里统一关。
  let store: ReturnType<typeof openStore>
  let cards: MemoryCard[]
  let records: JournalRecord[]

  before(() => {
    const built = richLibrary()
    store = built.store
    cards = store.listCards()
    records = built.records
  })

  after(() => {
    store.close()
    // 目录由 makeTempDir 登记，helpers 统一处理清理
    assert.ok(tempDirs.length > 0, '前提：本次运行确实建过临时库')
  })

  it('100 张卡的来源指针全部完整（session/turn/step/seq/eventType 都有值）', () => {
    // 前提：数量必须够，否则「抽 100 张」是空话。
    assert.ok(cards.length >= 100, `前提：至少要 100 张卡，实际 ${cards.length}`)

    // 固定抽样而不是随机：ST-1 要求可重复，随机抽样会让失败无法复现。
    // 这里取前 100 张（listCards 的顺序由 store 决定，稳定）。
    const sample = cards.slice(0, 100)
    assert.equal(sample.length, 100, '前提：抽样必须正好 100 张')

    for (const card of sample) {
      const source = card.source
      assert.ok(source, `卡 ${card.id} 没有 source`)
      assert.equal(typeof source.sessionId, 'string', `卡 ${card.id} 的 sessionId 不是字符串`)
      assert.ok(source.sessionId.length > 0, `卡 ${card.id} 的 sessionId 为空`)
      assert.ok(Number.isFinite(source.seq), `卡 ${card.id} 的 seq 不是有限数：${String(source.seq)}`)
      assert.ok(Number.isFinite(source.turn), `卡 ${card.id} 的 turn 不是有限数`)
      assert.ok(Number.isFinite(source.step), `卡 ${card.id} 的 step 不是有限数`)
      assert.equal(typeof source.eventType, 'string', `卡 ${card.id} 的 eventType 不是字符串`)
      assert.ok(source.eventType.length > 0, `卡 ${card.id} 的 eventType 为空`)
    }
  })

  it('指针可信：每张卡的 source 与日志里那条 put 记录逐字段一致', () => {
    // 这是本文件最要紧的一条。字段有值不等于值是对的——投影层完全可能
    // 在重放时把 source 补成默认值，那样「完整」和「可信」会分家。
    // 从日志里收集「id → 最后一条 put 记录里的 source」
    const logged = new Map<string, MemoryCard['source']>()
    for (const record of records) {
      if (record.op.op === 'put') logged.set(record.op.card.id, record.op.card.source)
    }

    // 前提：日志里必须真有 put 记录，否则下面的循环体一次都不执行、测试假绿。
    assert.ok(logged.size >= 100, `前提：日志里至少要有 100 条 put，实际 ${logged.size}`)

    const sample = cards.slice(0, 100)
    assert.equal(sample.length, 100, '前提：抽样必须正好 100 张')

    for (const card of sample) {
      const fromLog = logged.get(card.id)
      assert.ok(fromLog, `卡 ${card.id} 在日志里找不到对应的 put 记录（ST-4 断裂）`)
      assert.deepEqual(card.source, fromLog, `卡 ${card.id} 的 source 与日志记录不一致`)
    }
  })

  it('派生卡（摘要/感受）如实标注来源，不伪装成某轮对话的原话', () => {
    // 派生卡没有「原文」可言——它是由别的卡算出来的。若它把 sessionId 填成
    // 真实会话 id、seq 填成某个事件序号，读者会以为它是原话。
    // 实测：日摘要的 sessionId 是日期键、turn/step 为 0、eventType 是
    // `consolidate/daily-summary`，三者共同说明「这不是对话原文」。
    const derived = cards.filter((card) => card.source.eventType.startsWith('consolidate/'))

    // 前提：必须真的有派生卡，否则这条测试什么都没测。
    assert.ok(derived.length > 0, '前提：这次夜整理必须产出派生卡')

    for (const card of derived) {
      assert.equal(card.source.turn, 0, `派生卡 ${card.id} 的 turn 应为 0（不是某轮对话）`)
      assert.equal(card.source.step, 0, `派生卡 ${card.id} 的 step 应为 0`)
      assert.ok(
        card.source.sessionId !== 's-1',
        `派生卡 ${card.id} 不得把自己的来源伪装成真实会话 s-1`,
      )
    }
  })

  it('同轮多句会产出多张卡且共享同一 seq——seq 是「事件级」不是「句子级」', () => {
    // 这条**故意断言当前的局限**：FR-A4 写的是「原文序号」，而实现里 seq
    // 是宿主事件（一轮）的序号，不是句子的序号。一轮里用户说了三句、助手说了
    // 两句，产出的 4 张卡 seq 完全相同。
    //
    // 这不违反 FR-A4（它要求的是能定位回**事件**），但必须写明：**光凭 seq
    // 无法区分同轮内的哪一句**。将来若引入句子级序号，这条会变红，提醒同步
    // 更新文档——这正是「故意断言局限」的用法。
    const localStore = openStore({ dataDir: tempDir(), config: DEFAULT_CONFIG })
    const engine = new MemoryEngine({
      store: localStore,
      config: DEFAULT_CONFIG,
      timeZone: TZ,
      clock: () => T0,
    })
    engine.writeTurn({
      sessionId: 's-1',
      turn: 1,
      step: 1,
      seq: 100,
      userText: '决定项目用 Qt5 开发。数据库选 PostgreSQL。缓存用 Redis。',
      assistantText: '好的，我记下了 Qt5 这个决定。数据库用 PostgreSQL 也记下了。',
      domain: 'work',
      at: T0,
    } as never)

    const localCards = localStore.listCards()
    assert.ok(localCards.length >= 2, `前提：一轮多句应产出多张卡，实际 ${localCards.length}`)
    const distinctSeqs = new Set(localCards.map((card) => card.source.seq))
    assert.equal(distinctSeqs.size, 1, '当前实现：同轮多卡共享同一 seq（事件级序号）')
    assert.equal([...distinctSeqs][0], 100, 'seq 应等于宿主传入的事件序号')
    localStore.close()
  })
})
