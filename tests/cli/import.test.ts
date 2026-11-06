/**
 * `import` 对**非法输入**的行为单测（缺陷 W8）。
 *
 * ## 为什么这个文件必须存在
 *
 * 缺陷 W8 是用户在命令行端到端验证时发现的，不是单测发现的。当时
 * 1311 条测试全绿，但它们全都在测「合法输入能不能正确往返」——
 * **没有一条测过「非法输入会怎样」**。于是下面两件事长期无人发现：
 *
 * 1. 卡片缺 `conflictOf` 时，`deriveIdempotencyKey` 里 `op.card.conflictOf.join(',')`
 *    抛 `TypeError: Cannot read properties of undefined (reading 'join')`，
 *    堆栈直接打到终端，退出码是 1 但用户看到的是程序崩了。
 * 2. 卡片缺 `strength` / `status` / `accessCount` 时**不崩**——`String(undefined)`
 *    把字面量 `"undefined"` 拼进幂等键，残卡照样落盘，CLI 报「写入 1 张」。
 *
 * 第二条比第一条更危险：崩溃至少会被看到，静默写入的残卡不会。
 *
 * ## 断言为什么必须从磁盘数行数
 *
 * `runCli` 每次调用都会 `openStore` → `close`，内存状态随进程消失。
 * 「库里有没有多东西」只能看事件日志（`journal-*.jsonl`）——那才是唯一真相源
 * （原则 P2）。只看 `store.count()` 不够：它在写失败的进程里可能是 0，
 * 而在另一个进程（重放后）才暴露出来。所以本文件的所有「没写进去」断言
 * 都是**数磁盘上的行**。
 *
 * @module tests/cli/import.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE, parseArgs, runCli } from '../../src/cli/memoryctl.ts'
import type { CliOptions } from '../../src/cli/types.ts'
import { runImport } from '../../src/cli/commands/import.ts'
import type { MemoryCard, SourcePointer } from '../../src/core/types.ts'
import { buildCardId, buildEdgeId } from '../../src/core/types.ts'
import { listShardFiles } from '../../src/store/journal.ts'
import { deriveIdempotencyKey, openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const T0 = 1_700_000_000_000

const tempDirs: string[] = []

/** 建一个登记过的临时目录，`after` 里统一清理（仓库规范：不得批量递归删除）。 */
function tempDir(prefix = 'dsh-memory-import-'): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/**
 * 数磁盘上事件日志的**行数**。
 *
 * 这是本文件「一条都没多」的唯一证据来源。刻意不用 `listShardFiles(dir).length`
 * （那是分片数不是记录数），也不读 `store.count()`（那要重放才准，而重放
 * 会把「落盘了但读不回」的残卡过滤掉——恰好掩盖缺陷）。
 *
 * @param dir - 数据目录。
 * @returns 所有分片里的非空行总数。
 */
function journalLines(dir: string): number {
  let total = 0
  for (const name of listShardFiles(dir)) {
    const text = readFileSync(join(dir, name), 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) total += 1
    }
  }
  return total
}

/** 造一张**合法**卡；每个序号用不同的 id 与文本，避免互相覆盖。 */
function legalCard(index: number, overrides: Partial<MemoryCard> = {}): MemoryCard {
  const source: SourcePointer = { sessionId: 'sess-import', turn: index + 1, step: 1, seq: 1, eventType: 'user/message' }
  const text = `第 ${index} 条部署记忆`
  return {
    id: buildCardId('work', source, 'fact', text),
    domain: 'work',
    kind: 'fact',
    text,
    normalized: text,
    createdAt: T0,
    updatedAt: T0,
    source,
    salience: 0.8,
    confidence: 0.9,
    emotional: 0.2,
    strength: 0.9,
    accessCount: 0,
    lastAccessAt: null,
    tags: ['部署'],
    entities: ['生产环境'],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
    ...overrides,
  }
}

/**
 * 把一张合法卡**挖掉一个字段**，得到解析层认得、形状层不认的卡片。
 *
 * 关键：`id` 必须留着。解析层（`importExportDocument`）只按「id 是非空字符串」
 * 收卡，没有 id 的会被算作坏行直接跳过——那样就走不到预检，测的就不是
 * 「形状判断拦住了它」而是「解析层没认出它」。
 *
 * @param card - 源卡片（不会被修改）。
 * @param field - 要挖掉的字段名。
 * @returns 缺了该字段的普通对象。
 */
function without(card: MemoryCard, field: string): Record<string, unknown> {
  const raw = { ...card } as unknown as Record<string, unknown>
  delete raw[field]
  return raw
}

/** 把一份导出文档写到临时文件，返回路径。 */
function writeDocument(doc: unknown, name = 'export.json'): string {
  const target = join(tempDir(), name)
  writeFileSync(target, JSON.stringify(doc), 'utf8')
  return target
}

/** 拼一份最小的导出文档。 */
function document(cards: readonly unknown[], edges: readonly unknown[] = []): unknown {
  return { formatVersion: 1, exportedAt: T0, cards, edges }
}

describe('import 对非法卡片：预检拒绝、零写入（缺陷 W8）', () => {
  it('缺 conflictOf：可读错误 + 非 0 退出码 + 磁盘一条没多 + 不出 TypeError', () => {
    // 这条是缺陷现场的原始复现。修复前它抛：
    //   TypeError: Cannot read properties of undefined (reading 'join')
    //       at deriveIdempotencyKey (src/store/store.ts:476)
    const bad = without(legalCard(0), 'conflictOf')
    const target = writeDocument(document([bad]))

    // 用**已有数据的真实目录**，而不是空目录：空目录里「行数没变」可能只是
    // 「这个目录根本没打开过」。有一条既存记录时，行数不变才是有意义的证据。
    const dir = tempDir()
    const seed = openStore({ dataDir: dir })
    seed.putCard(legalCard(99))
    seed.close()
    const before = journalLines(dir)
    assert.equal(before, 1, '前提：种库里必须真的落了一条记录，否则后面的「没变」不算数')

    const result = runCli(['import', target, '--data-dir', dir])

    assert.equal(result.code, EXIT_UNHEALTHY, '非法卡片是数据问题，退出码必须是 1（不是崩溃的 1，也不是用法错误的 2）')
    assert.match(result.stderr, /未通过预检/u)
    assert.match(result.stderr, /结构非法/u)
    assert.match(result.stderr, /conflictOf/u, '错误信息必须点名是哪个字段，否则用户改不动文件')

    // 反向验证「不是靠崩溃凑出非 0 退出码」：崩溃会把堆栈打到 stderr 里，
    // 而堆栈里必然出现 TypeError 与函数名。这两条断言把「优雅拒绝」与
    // 「进程被打死」区分开——只断言 code !== 0 时两者都会绿。
    assert.doesNotMatch(result.stderr, /TypeError/u, '不得以崩溃收场')
    assert.doesNotMatch(result.stderr, /deriveIdempotencyKey/u, '不得泄露内部堆栈')

    assert.equal(journalLines(dir), before, '预检在写入之前：磁盘上一条记录都不许新增')
  })

  // 参数化：这几个字段缺失时**不会崩**（`String(undefined)` 兜住了），
  // 修复前它们会静默写入残卡，所以每一条都必须单独覆盖——
  // 只测 conflictOf 会给人「只有这一个字段有问题」的错觉。
  for (const field of ['strength', 'status', 'accessCount', 'source', 'salience', 'tags', 'entities', 'revisions', 'pinned']) {
    it(`缺 ${field}：同样被预检拒绝，且不留残卡`, () => {
      const bad = without(legalCard(0), field)
      const target = writeDocument(document([bad]))
      const dir = tempDir()

      const result = runCli(['import', target, '--data-dir', dir])
      assert.equal(result.code, EXIT_UNHEALTHY)
      assert.match(result.stderr, /结构非法/u)
      assert.match(result.stderr, new RegExp(field, 'u'))
      assert.equal(journalLines(dir), 0, `缺 ${field} 时不得写入任何记录（修复前这里会落一张残卡）`)
    })
  }

  it('第一张合法、第二张缺 conflictOf：一张都不许写（不是「写了一半」）', () => {
    // 这条守的是「全进或全不进」。修复前：第一张 `putCard` 成功落盘，
    // 第二张抛 TypeError，进程死掉——库停在「导入了一部分」而没有任何提示。
    const good = legalCard(0)
    const bad = without(legalCard(1), 'conflictOf')
    const target = writeDocument(document([good, bad]))

    const dir = tempDir()
    const result = runCli(['import', target, '--data-dir', dir])

    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.equal(
      journalLines(dir), 0,
      '预检必须挡在**整个写入循环之前**；只要磁盘上有 1 行，就说明退化成「写一半」了',
    )
    // 再确认一次：不是「写的正好是那张合法的」。
    const check = openStore({ dataDir: dir })
    try {
      assert.equal(check.getCard(good.id), undefined, '那张合法的卡也不许进库')
      assert.equal(check.count('active'), 0)
    } finally {
      check.close()
    }
  })

  it('对照组：全是合法卡时导入照常成功，行数等于卡片数（证明上面的红不是因为整条链路坏了）', () => {
    // 没有这条，「非法卡不写入」可能在「import 根本写不进任何东西」的实现上也会绿。
    const cards = [legalCard(0), legalCard(1), legalCard(2)]
    const target = writeDocument(document(cards))
    const dir = tempDir()

    const result = runCli(['import', target, '--data-dir', dir])
    assert.equal(result.code, EXIT_OK, `合法文件必须能导入：${result.stderr}`)
    assert.match(result.stdout, /卡片 3 张写入/u)
    assert.equal(journalLines(dir), 3, '三条记录，一条不多一条不少')

    const check = openStore({ dataDir: dir })
    try {
      assert.equal(check.count('active'), 3)
      for (const card of cards) assert.deepEqual(check.getCard(card.id), card)
    } finally {
      check.close()
    }
  })
})

describe('import 对非法边：预检拒绝、零写入', () => {
  it('边缺 weight：预检拒绝（重放层对边完全不校验，放进去会参与打分算出 NaN）', () => {
    const card = legalCard(0)
    const edge = {
      id: buildEdgeId(card.id, card.id, 'same-topic'),
      from: card.id,
      to: card.id,
      relation: 'same-topic',
      createdAt: T0,
    }
    const target = writeDocument(document([card], [edge]))
    const dir = tempDir()

    const result = runCli(['import', target, '--data-dir', dir])
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stderr, /结构非法/u)
    assert.match(result.stderr, /weight/u)
    assert.equal(journalLines(dir), 0, '边非法时卡片也不许先落盘（预检在写入之前）')
  })

  it('边用了七种边类型之外的 relation：预检拒绝', () => {
    const card = legalCard(0)
    const edge = {
      id: buildEdgeId(card.id, card.id, 'same-topic'),
      from: card.id,
      to: card.id,
      relation: 'made-up-relation',
      weight: 0.5,
      createdAt: T0,
    }
    const target = writeDocument(document([card], [edge]))
    const dir = tempDir()

    const result = runCli(['import', target, '--data-dir', dir])
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stderr, /结构非法/u)
    assert.equal(journalLines(dir), 0)
  })
})

describe('import 对「没有 id」的卡片：解析层就认不出来（不进入预检）', () => {
  it('缺 id 的卡片算坏行，整个文件一条都认不出来时按用法错误报', () => {
    // 这条钉住的是**层次边界**：`id` 是解析层的门槛（`importExportDocument`
    // 只收 id 非空的卡），所以它走不到预检。区分这两层是为了让错误信息
    // 指向正确的修法：用户看到的是「这不像本程序导出的文件」，而不是
    // 「卡片结构非法」——后者会让他去补字段，而真正的问题是这份文件
    // 根本不是导出文件。
    const bad = without(legalCard(0), 'id')
    const target = writeDocument(document([bad]))
    const dir = tempDir()

    const result = runCli(['import', target, '--data-dir', dir])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /一条都认不出来/u)
    assert.equal(journalLines(dir), 0)
  })
})

describe('写入过程中抛错时，如实报告「导入了一部分」（而不是打一段堆栈）', () => {
  /**
   * 造一个在第 `failAt` 次 `putCard` 时抛错的假库。
   *
   * 为什么需要它：预检修好之后，CLI 这条路径上已经**触发不到**写循环里的
   * `catch` 了。一条永远走不到的分支如果也不测，它与「删掉」没有区别——
   * 而它守的是真实存在的情形（磁盘错误、并发写者、日志损坏）。
   * 所以这里绕开 `runCli` 直接调 `runImport`，把数据面换成会抛的桩。
   */
  function failingStore(failAt: number): MemoryStore {
    const written: string[] = []
    const stub = {
      listCards: (): MemoryCard[] => [],
      putCard: (card: MemoryCard): { written: boolean } => {
        if (written.length === failAt) throw new Error('模拟磁盘写入失败')
        written.push(card.id)
        return { written: true }
      },
      getCard: (id: string): MemoryCard | undefined => (written.includes(id) ? legalCard(0) : undefined),
      putEdge: (): { written: boolean } => ({ written: true }),
    }
    return stub as unknown as MemoryStore
  }

  /** 把位置参数拼成 `CliOptions`；用真实的 `parseArgs` 而不是手写对象。 */
  function optionsFor(target: string): CliOptions {
    const parsed = parseArgs(['import', target, '--data-dir', 'unused'])
    assert.equal(parsed.ok, true, '前提：参数必须能被解析')
    if (!parsed.ok) throw new Error('unreachable')
    return parsed.options
  }

  it('第 2 张抛错时，报出「已写入 1 张」而不是把异常扔出去', () => {
    const target = writeDocument(document([legalCard(0), legalCard(1), legalCard(2)]))
    const result = runImport(optionsFor(target), failingStore(1))

    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stderr, /导入 .* 时写入失败/u)
    assert.match(result.stderr, /模拟磁盘写入失败/u)
    // 计数必须是真的：抛错前确实写进去 1 张。报 0 会让用户以为重跑就够，
    // 报 3 会让用户以为全部进了——两个都是误导。
    assert.match(result.stderr, /已写入：卡片 1 张/u, '必须如实报出已写入的条数')
    assert.match(result.stderr, /导入了一部分/u, '必须明确告知库处于半截状态')
    assert.match(result.stderr, /幂等跳过/u, '必须告诉用户重跑是安全的')
  })

  it('第 1 张就抛错时，报「已写入 0 张」', () => {
    const target = writeDocument(document([legalCard(0), legalCard(1)]))
    const result = runImport(optionsFor(target), failingStore(0))

    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stderr, /已写入：卡片 0 张/u)
  })
})

describe('deriveIdempotencyKey 的纵深防御（第二道闸，不是唯一一道）', () => {
  // 这一组**不是**本缺陷的主修。主修在导入入口的预检：合法性的裁决必须只有
  // 一份（两套判据正是 W8 的成因）。这里守的是「即便判据被绕过，也不能把
  // 进程打死」——`deriveIdempotencyKey` 是所有写路径共用的指纹入口，
  // 它在 `journal.append` **之前**执行，抛错意味着整次写入连日志都进不去。
  it('卡片缺 conflictOf 不抛 TypeError，且键是确定的', () => {
    const card = legalCard(0)
    const broken = without(card, 'conflictOf')
    const opA = { op: 'put' as const, card: broken as unknown as MemoryCard }
    const opB = { op: 'put' as const, card: broken as unknown as MemoryCard }

    // 抛不抛单独断言（而不是靠后面取值时顺带崩掉）：「拿到一个键」与
    // 「没有抛异常」是两件事，前者在抛错的实现上根本执行不到。
    assert.doesNotThrow(() => { deriveIdempotencyKey(opA) })
    const keyA = deriveIdempotencyKey(opA)
    assert.equal(deriveIdempotencyKey(opB), keyA, '同一份非法输入必须得到同一个键，否则重放不幂等')
    assert.equal(typeof keyA, 'string')
    assert.ok(keyA.length > 0)
  })

  it('不把「缺 conflictOf」与「conflictOf 为空数组」压成同一个键', () => {
    // 这条守的是「不要用 `?? []` 兜底」这个看似更干净的写法：那样两张语义
    // 不同的卡会撞成同一个幂等键，于是第二张被静默判为重复提交而丢弃。
    // 把崩溃换成静默丢弃不是修复。
    const card = legalCard(0)
    const missing = deriveIdempotencyKey({ op: 'put', card: without(card, 'conflictOf') as unknown as MemoryCard })
    const empty = deriveIdempotencyKey({ op: 'put', card: { ...card, conflictOf: [] } })
    assert.notEqual(missing, empty, '缺字段与空数组是两种不同的输入，键必须能区分')
  })

  it('merge 操作的 ids 不是数组时也不抛（与 conflictOf 同一类裸解引用）', () => {
    const op = { op: 'merge' as const, ids: undefined as unknown as string[], into: legalCard(0), at: T0 }
    assert.doesNotThrow(() => deriveIdempotencyKey(op))
  })

  it('合法卡片与它自己的浅拷贝得到同一个键（ST-2：键只取决于内容）', () => {
    // 防止上面的防御性改写把合法路径的键改掉：`fingerprintPart` 对真数组
    // 必须与 `.join(',')` 逐位相同。
    const card = legalCard(0)
    assert.equal(
      deriveIdempotencyKey({ op: 'put', card }),
      deriveIdempotencyKey({ op: 'put', card: { ...card } }),
    )
  })
})
