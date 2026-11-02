/**
 * 数据面单测的公共夹具。
 *
 * 只放「构造数据」与「清理临时目录」这类与断言无关的辅助，
 * 让每个测试文件都聚焦在自己要验证的行为上。
 *
 * @module tests/store/helpers
 */

import { mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'
import { buildCardId } from '../../src/core/types.ts'
import type {
  JournalRecord, MemoryCard, MemoryKind, MemoryDomain, SourcePointer,
} from '../../src/core/types.ts'

/**
 * 建一个临时数据目录。
 *
 * @param prefix - 目录名前缀，便于出问题时一眼看出是哪个测试留下的。
 * @returns 绝对路径。
 */
export function makeTempDir(prefix = 'dsh-memory-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 逐个删除目录内容后再删目录。
 *
 * 刻意不用递归批量删除：仓库规范禁止批量删除，这里逐文件、逐层处理，
 * 出错也能定位到具体文件。
 *
 * @param dir - 待删除目录的绝对路径。
 */
export function removeDirContents(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      removeDirContents(path)
      rmdirSync(path)
      continue
    }
    unlinkSync(path)
  }
}

/** 构造一份测试用配置：数据目录指向临时目录，分片调小便于触发滚动。 */
export function makeConfig(overrides: Partial<MemoryConfig['storage']> = {}): MemoryConfig {
  return {
    ...DEFAULT_CONFIG,
    storage: {
      ...DEFAULT_CONFIG.storage,
      dataDir: '.dsh-memory',
      ...overrides,
    },
  }
}

/** 构造来源指针。 */
export function makeSource(overrides: Partial<SourcePointer> = {}): SourcePointer {
  return {
    sessionId: 'sess-1',
    turn: 1,
    step: 1,
    seq: 1,
    eventType: 'user/message',
    ...overrides,
  }
}

/**
 * 构造一张测试卡片。
 *
 * id 默认按「域 + 来源 + 类型 + 归一化文本」派生，与生产逻辑一致。
 *
 * @param overrides - 需要覆盖的字段。
 * @returns 字段齐全的卡片。
 */
export function makeCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  const domain: MemoryDomain = overrides.domain ?? 'work'
  const kind: MemoryKind = overrides.kind ?? 'fact'
  const source = overrides.source ?? makeSource()
  const normalized = overrides.normalized ?? '项目使用 qt5'
  const text = overrides.text ?? '这个项目使用 Qt5'
  return {
    id: overrides.id ?? buildCardId(domain, source, kind, normalized),
    domain,
    kind,
    text,
    normalized,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
    source,
    salience: overrides.salience ?? 0.6,
    confidence: overrides.confidence ?? 0.8,
    emotional: overrides.emotional ?? 0.2,
    strength: overrides.strength ?? 0.7,
    accessCount: overrides.accessCount ?? 0,
    lastAccessAt: overrides.lastAccessAt ?? null,
    tags: overrides.tags ?? ['qt'],
    entities: overrides.entities ?? ['Qt5'],
    revisions: overrides.revisions ?? [],
    status: overrides.status ?? 'active',
    conflictOf: overrides.conflictOf ?? [],
    pinned: overrides.pinned ?? false,
    ...(overrides.mergedInto === undefined ? {} : { mergedInto: overrides.mergedInto }),
    ...(overrides.mergeOf === undefined ? {} : { mergeOf: overrides.mergeOf }),
    ...(overrides.dueAt === undefined ? {} : { dueAt: overrides.dueAt }),
  }
}

/**
 * 构造一条日志记录。
 *
 * @param seq - 序号。
 * @param op - 操作本体。
 * @param key - 幂等键；省略时按序号派生。
 * @returns 日志记录。
 */
export function makeRecord(
  seq: number, op: JournalRecord['op'], key = `key-${seq}`,
): JournalRecord {
  return { v: 1, seq, at: 1_700_000_000_000 + seq, idempotencyKey: key, op }
}
