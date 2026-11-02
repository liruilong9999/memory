/**
 * 事件日志单测：序列化、幂等、分片滚动、崩溃尾行修复。
 *
 * 对应需求：FR-A2（幂等）、FR-A3（原子性 / 崩溃恢复）、ST-2、ST-3。
 *
 * @module tests/store/journal.test
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  Journal, buildIdempotencyKey, decodeRecord, encodeRecord, listShardFiles, shardFileName,
} from '../../src/store/journal.ts'
import { makeCard, makeRecord, makeTempDir, removeDirContents } from './helpers.ts'

const tempDirs: string[] = []

/** 建临时目录并登记，测试结束统一清理。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-journal-')
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

describe('日志序列化', () => {
  it('编码后再解码应还原同一条记录', () => {
    const card = makeCard()
    const record = makeRecord(1, { op: 'put', card })
    const decoded = decodeRecord(encodeRecord(record))
    assert.deepEqual(decoded, record)
  })

  it('空行与非法 JSON 应解码为 null', () => {
    assert.equal(decodeRecord(''), null)
    assert.equal(decodeRecord('   '), null)
    assert.equal(decodeRecord('{'), null)
    assert.equal(decodeRecord('123'), null)
    assert.equal(decodeRecord('{"v":1}'), null)
  })

  it('版本号不是 1 的记录应被拒绝', () => {
    const line = JSON.stringify({ v: 2, seq: 1, at: 0, idempotencyKey: 'k', op: { op: 'purge', id: 'a', at: 0 } })
    assert.equal(decodeRecord(line), null)
  })

  it('未知操作标签应被拒绝', () => {
    const line = JSON.stringify({ v: 1, seq: 1, at: 0, idempotencyKey: 'k', op: { op: 'boom' } })
    assert.equal(decodeRecord(line), null)
  })
})

describe('分片文件名', () => {
  it('序号应补零到 6 位', () => {
    assert.equal(shardFileName(1), 'journal-000001.jsonl')
    assert.equal(shardFileName(42), 'journal-000042.jsonl')
  })

  it('非日志文件不参与分片列表', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, 'journal-000001.jsonl'), '')
    assert.deepEqual(listShardFiles(dir), ['journal-000001.jsonl'])
  })

  it('分片列表按序号升序而非字典序', () => {
    const dir = tempDir()
    for (const name of ['journal-000002.jsonl', 'journal-000010.jsonl', 'journal-000001.jsonl']) {
      writeFileSync(join(dir, name), '')
    }
    assert.deepEqual(listShardFiles(dir), [
      'journal-000001.jsonl', 'journal-000002.jsonl', 'journal-000010.jsonl',
    ])
  })
})

describe('追加与读取', () => {
  it('按追加顺序读回全部记录', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    for (let seq = 1; seq <= 5; seq += 1) {
      journal.append(makeRecord(seq, { op: 'put', card: makeCard({ text: `第 ${seq} 条` }) }))
    }
    const records = journal.readAll()
    assert.equal(records.length, 5)
    assert.deepEqual(records.map((item) => item.seq), [1, 2, 3, 4, 5])
    journal.close()
  })

  it('序号由日志统一分配，入参序号更小时也要递增', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    const first = journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 0 }))
    const second = journal.append(makeRecord(1, { op: 'purge', id: 'b', at: 0 }))
    assert.equal(first.record.seq, 1)
    assert.equal(second.record.seq, 2)
    assert.equal(journal.lastSeq(), 2)
    journal.close()
  })

  it('重复幂等键应被丢弃且不落盘', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    const card = makeCard()
    const record = makeRecord(1, { op: 'put', card }, 'same-key')
    const first = journal.append(record)
    const second = journal.append(makeRecord(2, { op: 'put', card }, 'same-key'))
    assert.equal(first.appended, true)
    assert.equal(second.appended, false)
    assert.equal(second.duplicateOfSeq, 1)
    assert.equal(journal.readAll().length, 1)
    assert.equal(journal.count(), 1)
    journal.close()
  })

  it('重复幂等键应能被 hasKey 查到', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 0 }, 'k1'))
    assert.equal(journal.hasKey('k1'), true)
    assert.equal(journal.hasKey('k2'), false)
    journal.close()
  })

  it('重新打开后幂等键集合与序号水位应恢复', () => {
    const dir = tempDir()
    const first = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    first.open()
    first.append(makeRecord(1, { op: 'purge', id: 'a', at: 0 }, 'k1'))
    first.append(makeRecord(2, { op: 'purge', id: 'b', at: 0 }, 'k2'))
    first.close()

    const second = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    second.open()
    assert.equal(second.lastSeq(), 2)
    assert.equal(second.hasKey('k1'), true)
    const again = second.append(makeRecord(9, { op: 'purge', id: 'c', at: 0 }, 'k1'))
    assert.equal(again.appended, false)
    const fresh = second.append(makeRecord(9, { op: 'purge', id: 'd', at: 0 }, 'k3'))
    assert.equal(fresh.record.seq, 3)
    second.close()
  })
})

describe('分片滚动', () => {
  it('超过单片大小后应滚动到新分片', () => {
    const dir = tempDir()
    // 单片上限压到很小，保证几条记录就会触发滚动。
    const journal = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false })
    journal.open()
    for (let seq = 1; seq <= 8; seq += 1) {
      journal.append(makeRecord(seq, { op: 'purge', id: `card-${seq}`, at: seq }))
    }
    const files = listShardFiles(dir)
    assert.ok(files.length > 1, `应产生多个分片，实际只有 ${files.length} 个`)
    assert.equal(files[0], 'journal-000001.jsonl')
    journal.close()
  })

  it('滚动后按分片顺序读回全部记录', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false })
    journal.open()
    for (let seq = 1; seq <= 10; seq += 1) {
      journal.append(makeRecord(seq, { op: 'purge', id: `card-${seq}`, at: seq }))
    }
    const records = journal.readAll()
    assert.equal(records.length, 10)
    assert.deepEqual(records.map((item) => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    journal.close()
  })

  it('单条记录超过单片上限时不应产生空分片', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 8, fsyncOnWrite: false })
    journal.open()
    journal.append(makeRecord(1, { op: 'put', card: makeCard() }))
    journal.append(makeRecord(2, { op: 'put', card: makeCard({ text: '另一张很长的卡片内容' }) }))
    const files = listShardFiles(dir)
    // 每条都超过 8 字节，因此每片一条，不会出现「空片 + 数据片」的畸形布局。
    assert.equal(files.length, 2)
    assert.equal(journal.readAll().length, 2)
    journal.close()
  })

  it('重新打开后应接着最后一个分片继续写', () => {
    const dir = tempDir()
    const first = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false })
    first.open()
    for (let seq = 1; seq <= 6; seq += 1) {
      first.append(makeRecord(seq, { op: 'purge', id: `c${seq}`, at: seq }))
    }
    const shardCount = listShardFiles(dir).length
    first.close()

    const second = new Journal({ dir, segmentBytes: 64, fsyncOnWrite: false })
    second.open()
    second.append(makeRecord(7, { op: 'purge', id: 'c7', at: 7 }))
    assert.ok(listShardFiles(dir).length >= shardCount)
    assert.equal(second.readAll().length, 7)
    second.close()
  })
})

describe('崩溃恢复', () => {
  it('尾部残缺行应在打开时被截断', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 1 }, 'k1'))
    journal.close()

    // 模拟强杀：写入半条 JSON，没有换行结尾。
    appendFileSync(join(dir, shardFileName(1)), '{"v":1,"seq":2,"at":2,"idempo')

    const reopened = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    reopened.open()
    const records = reopened.readAll()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.seq, 1)
    // 修复后继续追加，新记录必须完整可读。
    reopened.append(makeRecord(2, { op: 'purge', id: 'b', at: 2 }, 'k2'))
    assert.equal(reopened.readAll().length, 2)
    reopened.close()
  })

  it('残缺行被截断后文件以换行结尾', () => {
    const dir = tempDir()
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    journal.append(makeRecord(1, { op: 'purge', id: 'a', at: 1 }, 'k1'))
    journal.close()
    const path = join(dir, shardFileName(1))
    appendFileSync(path, '{"broken":true')
    const reopened = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    reopened.open()
    assert.ok(readFileSync(path, 'utf8').endsWith('\n'))
    reopened.close()
  })

  it('数据目录不存在时读取应返回空而不是抛错', () => {
    const dir = join(tempDir(), 'not-created-yet')
    assert.equal(existsSync(dir), false)
    assert.deepEqual(listShardFiles(dir), [])
  })

  it('打开的日志应自动创建数据目录', () => {
    const dir = join(tempDir(), 'nested', 'data')
    const journal = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false })
    journal.open()
    assert.equal(existsSync(dir), true)
    journal.close()
  })
})

describe('幂等键派生', () => {
  it('同样的要素应得到同样的键', () => {
    assert.equal(buildIdempotencyKey('put', 'card-1'), buildIdempotencyKey('put', 'card-1'))
  })

  it('不同要素应得到不同的键', () => {
    assert.notEqual(buildIdempotencyKey('put', 'card-1'), buildIdempotencyKey('put', 'card-2'))
  })

  it('要素分隔应避免拼接歧义', () => {
    assert.notEqual(buildIdempotencyKey('ab', 'c'), buildIdempotencyKey('a', 'bc'))
  })
})
