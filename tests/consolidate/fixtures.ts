/**
 * 巩固面单测的公共夹具。
 *
 * 只做「构造合法 MemoryCard」，不含断言，因此不命名为 *.test.ts，
 * 不会被 `pnpm test` 的 glob 收集。
 *
 * @module tests/consolidate/fixtures
 */

import type { MemoryCard, MemoryKind, SourcePointer } from '../../src/core/types.ts'
import { DEFAULT_CONFIG, mergeConfig, type DeepPartial, type MemoryConfig } from '../../src/core/config.ts'
import { normalizeText } from '../../src/core/text.ts'

/** 默认来源指针。 */
const SOURCE: SourcePointer = { sessionId: 's-1', turn: 1, step: 1, seq: 1, eventType: 'user/message' }

/** 造一张卡时允许覆盖的字段。 */
export type CardOverrides = Partial<Omit<MemoryCard, 'id'>> & { id: string }

/**
 * 构造一张合法的记忆卡。
 *
 * `normalized` 默认由 `text` 归一化得到，与真实写入路径一致。
 *
 * @param over - 覆盖字段，必须给出 id。
 * @returns 新的记忆卡。
 */
export function makeCard(over: CardOverrides): MemoryCard {
  const text = over.text ?? ''
  return {
    domain: 'work',
    kind: 'event' as MemoryKind,
    text,
    normalized: normalizeText(text),
    createdAt: 0,
    updatedAt: 0,
    source: SOURCE,
    salience: 0.5,
    confidence: 0.8,
    emotional: 0,
    strength: 1,
    accessCount: 0,
    lastAccessAt: null,
    tags: [],
    entities: [],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
    ...over,
  }
}

/**
 * 在默认配置上做深合并，得到测试专用配置。
 *
 * @param patch - 部分配置。
 * @returns 完整配置。
 */
export function makeConfig(patch: DeepPartial<MemoryConfig> = {}): MemoryConfig {
  return mergeConfig(DEFAULT_CONFIG, patch)
}

/** 一天的毫秒数，测试里频繁用到。 */
export const DAY_MS = 24 * 60 * 60 * 1000
