/**
 * `meta.json` 的单测。
 *
 * 重点不是「读写能跑通」——那太容易绿。重点是钉住四条**设计决定**，
 * 每条都有一个「后人会顺手改坏」的具体改法，见各自用例的注释。
 *
 * @module tests/store/meta.test
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { Journal, listShardFiles } from '../../src/store/journal.ts'
import {
  EMPTY_META, META_FILE_NAME, metaFilePath, readLastConsolidationAt, readMeta, writeMeta,
  writeLastConsolidationAt,
} from '../../src/store/meta.ts'
import { openStore } from '../../src/store/store.ts'
import { makeCard, makeConfig, makeTempDir, removeDirContents } from './helpers.ts'

const tempDirs: string[] = []

/**
 * 建临时目录并登记清理。
 *
 * @returns 目录绝对路径。
 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-meta-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

describe('元信息读写', () => {
  it('文件不存在时应返回空元信息而不是抛错', () => {
    const dir = tempDir()
    // 正向证据：先确认目录里真的什么都没有，否则「没抛错」可能只是因为有文件。
    assert.deepEqual(readdirSync(dir), [], '前提：目录必须是空的')

    assert.equal(readLastConsolidationAt(dir), null)
    assert.deepEqual(readMeta(dir), EMPTY_META)
  })

  it('写入后应能读回同一个时刻', () => {
    const dir = tempDir()
    const at = 1_700_000_000_000
    writeLastConsolidationAt(dir, at)

    // 正向证据：文件真的落盘了。
    assert.ok(existsSync(metaFilePath(dir)), '前提：meta.json 必须真的被写出来')
    assert.equal(readLastConsolidationAt(dir), at)
  })

  it('第二次写入应覆盖而不是追加（文件里只有一份）', () => {
    const dir = tempDir()
    writeLastConsolidationAt(dir, 1_000)
    writeLastConsolidationAt(dir, 2_000)

    const text = readFileSync(metaFilePath(dir), 'utf8')
    // 整个文件是一行 JSON：若误用 append 会变成两行，JSON.parse 直接失败。
    assert.equal(text.trimEnd().split('\n').length, 1, 'meta.json 必须始终是单行 JSON')
    assert.equal(readLastConsolidationAt(dir), 2_000)
  })

  it('写入不应留下临时文件', () => {
    const dir = tempDir()
    writeLastConsolidationAt(dir, 1_000)
    // 原子写是「先写 .tmp 再 rename」，rename 之后 .tmp 必须消失。
    // 若这里多了 .tmp，说明 rename 没执行（比如被改成 copyFile）。
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
  })
})

describe('元信息损坏时重置而不是阻塞', () => {
  it('文件不是合法 JSON 时应重置为空而不是抛错', () => {
    const dir = tempDir()
    writeFileSync(metaFilePath(dir), '{ 这不是 JSON', 'utf8')

    // 这条守的是「不要给 meta.json 加严格校验、读不出来就报错」那个改动。
    // 判据：它只影响「要不要现在整理」，而整理是幂等的；让它阻塞启动是
    // 本末倒置——一个「上次整理是什么时候」记不清，不该导致记忆库打不开。
    assert.equal(readLastConsolidationAt(dir), null)
  })

  it('版本号不认识时应重置而不是猜着解析', () => {
    const dir = tempDir()
    writeFileSync(
      metaFilePath(dir),
      JSON.stringify({ v: 999, lastConsolidationAt: 123, 未来字段: '未知' }),
      'utf8',
    )

    // 降级读未知格式比没有数据更危险：v2 可能改了 lastConsolidationAt 的语义
    // （比如从「时刻」改成「日期字符串」），猜着解析会得到一个看起来合法、
    // 实际含义不同的数。宁可当作没有。
    assert.equal(readLastConsolidationAt(dir), null)
  })

  it('坏值必须被丢弃，绝不能当数字传出去', () => {
    const dir = tempDir()
    writeFileSync(
      metaFilePath(dir),
      JSON.stringify({ v: 1, lastConsolidationAt: '不是数字' }),
      'utf8',
    )

    // 这条守的是：**坏值绝不被采纳**。
    //
    // 若把校验整个删掉、把字符串原样当 `lastConsolidationAt` 返回，后果不是
    // 立刻报错——`shouldRunDaily` 里 `localDate(lastRunAt, timeZone)` 会拿到
    // 一个 `Invalid Date`，比较结果恒为 `false`，于是**夜整理永远不再运行**，
    // 而没有任何一处会报错。这类「坏值流下去，在很远的地方变成静默不工作」
    // 是本仓库反复踩的坑。
    assert.equal(readMeta(dir).lastConsolidationAt, null, '坏值必须被丢弃')

    // ## 这条用例的诚实边界（反向验证结论）
    //
    // `StoreMeta` 目前只有 `lastConsolidationAt` 一个数据字段。因此
    // 「整体重置」与「逐字段兜底」对同一个坏字段产出**完全相同**的结果
    // `{ v: 1, lastConsolidationAt: null }`，**本用例无法区分两者**。
    //
    // 已实测确认：把实现改成逐字段兜底，本用例**依然绿**。
    // 所以它守的不是「整体重置」这个设计决定，而是「坏值不被采纳」。
    //
    // 将来若 `StoreMeta` 加入第二个字段，「整体重置」与「逐字段兜底」就变得
    // 可区分了——**那时必须补一条能区分它们的用例**，否则那个决定始终没有
    // 任何保护，只写在注释里。
  })

  it('从未整理（null）与文件损坏必须走同一条安全路径', () => {
    // 这条刻意把两种来源放在一起断言，因为它们在**行为上必须等价**：
    // 都返回 null、都不抛错、都不阻塞启动。
    //
    // 反过来，「损坏重置不能顺手把『从未整理』也重置掉」这个说法在当前实现下
    // **不可验证**：两种情况的返回值本来就相同，任何实现都无法区分。与其写
    // 一条假装在区分它们的测试，不如直接断言「等价」，并把真实意图写在这里。
    const freshDir = tempDir()
    const brokenDir = tempDir()

    writeMeta(freshDir, { v: 1, lastConsolidationAt: null })
    writeFileSync(metaFilePath(brokenDir), '彻底不是 JSON', 'utf8')

    // 正向证据：先确认两个目录里真的各有一个文件，否则「都返回 null」
    // 可能只是因为两个目录都是空的。
    assert.ok(existsSync(metaFilePath(freshDir)), '前提：fresh 目录必须有 meta.json')
    assert.ok(existsSync(metaFilePath(brokenDir)), '前提：broken 目录必须有 meta.json')

    assert.equal(readLastConsolidationAt(freshDir), null)
    assert.equal(readLastConsolidationAt(brokenDir), null)
    assert.deepEqual(readMeta(freshDir), readMeta(brokenDir))
  })
})

describe('meta.json 不会被当成日志分片', () => {
  it('同一目录下 journal 与 meta 应互不干扰', () => {
    const dir = tempDir()
    const journal = new Journal({
      dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'write',
    })
    journal.open()
    journal.append({
      v: 1,
      seq: 0,
      at: 1_700_000_000_000,
      idempotencyKey: 'k1',
      op: { op: 'touch', id: 'c1', at: 1_700_000_000_000, strength: 0.5 },
    })
    journal.close()
    writeLastConsolidationAt(dir, 1_700_000_000_000)

    // 这条测试的价值不是「测正则」，是**防止将来有人放宽分片正则**。
    // 若把 `listShardFiles` 的匹配改成 `*.json`，meta.json 会被当成日志分片
    // 读进去，`decodeRecord` 对每一行返回 null，然后重放静默丢数据——
    // 没有任何报错，只表现为「记忆莫名变少」。
    const shards = listShardFiles(dir)
    assert.equal(shards.length, 1, '目录里应只有一个日志分片')
    assert.ok(!shards.includes(META_FILE_NAME), `分片列表不得包含 ${META_FILE_NAME}`)
    assert.equal(shards[0], 'journal-000001.jsonl')
  })

  it('meta.json 存在时重开日志不应被它干扰（端到端正向证据）', () => {
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    store.putCard(makeCard({ id: 'c1' }))
    store.putCard(makeCard({ id: 'c2' }))
    // 先确认库里有 2 条，否则下面「重开还是 2」可能绿在「一条都没写进去」上。
    assert.equal(store.count(), 2, '前提：必须真的写入了 2 张卡')
    store.close()

    writeLastConsolidationAt(dir, 1_700_000_000_000)

    // 重开：若 meta.json 被误当分片读进去，decodeRecord 全部返回 null，
    // 卡片会变少。所以这条同时守「不误吞」和「不丢数据」。
    const reopened = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(reopened.count(), 2, 'meta.json 不得影响日志重放')
    assert.equal(reopened.snapshot().lastSeq, 2)
    reopened.close()

    assert.equal(readLastConsolidationAt(dir), 1_700_000_000_000, 'meta 也必须还在')
  })

  it('数据目录里除分片外还应有 meta.json（证明两个文件真的共存）', () => {
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    store.putCard(makeCard({ id: 'c1' }))
    store.close()
    writeLastConsolidationAt(dir, 1_700_000_000_000)

    const names = readdirSync(dir)
    assert.ok(names.includes(META_FILE_NAME), 'meta.json 必须真的在目录里')
    assert.ok(names.some((n) => n.startsWith('journal-')), '日志分片也必须真的在目录里')
  })
})

describe('元信息与日志的隔离（判据验证）', () => {
  it('写 meta 不应改变日志的 seq 水位', () => {
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    store.putCard(makeCard({ id: 'c1' }))
    const before = store.snapshot().lastSeq
    assert.equal(before, 1, '前提：应已有 1 条日志记录')
    store.close()

    writeLastConsolidationAt(dir, 1_700_000_000_000)
    writeLastConsolidationAt(dir, 1_700_000_001_000)

    const reopened = openStore({ config: makeConfig(), dataDir: dir })
    // 这是「判据二（语义纯净性）」的代码化：若 lastConsolidationAt 写进日志，
    // 每整理一次就占一个 seq，用户行为和系统调度混进同一条单调序列，
    // 将来任何「按 seq 分析用户行为」的逻辑都会算错，而且**错了不会报错**。
    assert.equal(reopened.snapshot().lastSeq, 1, '写 meta 不得占用日志 seq')
    assert.equal(reopened.count(), 1)
    reopened.close()
  })

  it('删除 meta.json 不应影响任何记忆事实', () => {
    const dir = tempDir()
    const store = openStore({ config: makeConfig(), dataDir: dir })
    store.putCard(makeCard({ id: 'c1' }))
    store.putCard(makeCard({ id: 'c2' }))
    store.close()
    writeLastConsolidationAt(dir, 1_700_000_000_000)

    const path = metaFilePath(dir)
    assert.ok(existsSync(path), '前提：meta.json 必须存在')
    // 单个删除（仓库规范禁止批量删除）。
    unlinkSync(path)

    // 这是「判据一（可恢复性）」的代码化：meta 丢了，记忆事实一条不少。
    // 代价只是「今晚可能多整理一次」，而整理是幂等的。
    const reopened = openStore({ config: makeConfig(), dataDir: dir })
    assert.equal(reopened.count(), 2, 'meta 丢失不得影响记忆事实')
    assert.equal(readLastConsolidationAt(dir), null, '丢了就是丢了，不抛错')
    reopened.close()
  })
})
