/**
 * 导出与重建：把整库落成可读的 JSONL，并能从 JSONL 无损还原。
 *
 * 设计依据：
 * - FR-A6 导出与重建：全量导出 JSONL，可从导出重建库；验收标准是「导出→重建→抽查一致」。
 * - FR-A7 索引可重建：导出的是**真相**（卡片 + 边），不是索引；重建时索引现算。
 * - ST-8 导出重建：导出再导入必须无损，因此这里逐字段写出，不做任何截断或压缩。
 *
 * 格式约定：一行一条，第一行是头（版本 + 导出时刻 + 条数），随后是卡片行与边行。
 * 用 `kind` 字段区分行类型，便于人读与 `grep`。
 *
 * @module dsh-memory/store/export
 */

import type { MemoryCard, MemoryEdge } from '../core/types.ts'

/** 导出格式版本。字段结构变化时必须递增。 */
export const EXPORT_FORMAT_VERSION = 1

/** 导出文件里的行类型。 */
export type ExportLineKind = 'header' | 'card' | 'edge'

/** 导出文件头。 */
export interface ExportHeader {
  /** 行类型。 */
  kind: 'header'
  /** 格式版本。 */
  v: number
  /** 导出时刻（毫秒时间戳）。 */
  exportedAt: number
  /** 卡片条数。 */
  cards: number
  /** 边条数。 */
  edges: number
}

/** 导出文件里的一行。 */
export type ExportLine =
  | ExportHeader
  | { kind: 'card'; card: MemoryCard }
  | { kind: 'edge'; edge: MemoryEdge }

/** 导入结果。 */
export interface ImportResult {
  /** 卡片数组。 */
  cards: MemoryCard[]
  /** 边数组。 */
  edges: MemoryEdge[]
  /** 文件头；缺失或损坏时为 `null`。 */
  header: ExportHeader | null
  /** 跳过的坏行数（空行不计）。 */
  skipped: number
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 导出为 JSONL 文本。
 *
 * 顺序固定：卡片按 id 升序，边按 id 升序。固定顺序让导出文件可 diff、
 * 可做哈希比对，也让 ST-8 的「抽查一致」可自动化。
 *
 * @param cards - 卡片集合。
 * @param edges - 边集合。
 * @param exportedAt - 导出时刻；省略时取 0（便于单测断言字面量）。
 * @returns JSONL 文本，每行一条。
 */
export function exportJsonl(
  cards: Iterable<MemoryCard>, edges: Iterable<MemoryEdge>, exportedAt = 0,
): string {
  const cardList = [...cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const edgeList = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const lines: string[] = []
  const header: ExportHeader = {
    kind: 'header',
    v: EXPORT_FORMAT_VERSION,
    exportedAt,
    cards: cardList.length,
    edges: edgeList.length,
  }
  lines.push(JSON.stringify(header))
  for (const card of cardList) lines.push(JSON.stringify({ kind: 'card', card }))
  for (const edge of edgeList) lines.push(JSON.stringify({ kind: 'edge', edge }))
  return lines.join('\n') + '\n'
}

/**
 * 从 JSONL 文本导入。
 *
 * 容错策略：坏行跳过并计数，不抛异常——导出文件可能被人手改过，
 * 一条坏行不该让整库无法重建（FR-A3 的精神：宁可少一条，也要能开库）。
 *
 * @param text - JSONL 文本。
 * @returns 导入结果。
 */
export function importJsonl(text: string): ImportResult {
  const cards: MemoryCard[] = []
  const edges: MemoryEdge[] = []
  let header: ExportHeader | null = null
  let skipped = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (!isPlainObject(parsed)) {
      skipped += 1
      continue
    }
    const kind = parsed['kind']
    if (kind === 'header') {
      const v = parsed['v']
      const exportedAt = parsed['exportedAt']
      if (typeof v !== 'number' || typeof exportedAt !== 'number') {
        skipped += 1
        continue
      }
      header = {
        kind: 'header',
        v,
        exportedAt,
        cards: typeof parsed['cards'] === 'number' ? parsed['cards'] : 0,
        edges: typeof parsed['edges'] === 'number' ? parsed['edges'] : 0,
      }
      continue
    }
    if (kind === 'card') {
      const card = parsed['card']
      if (isPlainObject(card) && typeof card['id'] === 'string' && card['id'].length > 0) {
        cards.push(card as unknown as MemoryCard)
        continue
      }
      skipped += 1
      continue
    }
    if (kind === 'edge') {
      const edge = parsed['edge']
      if (isPlainObject(edge) && typeof edge['id'] === 'string' && edge['id'].length > 0) {
        edges.push(edge as unknown as MemoryEdge)
        continue
      }
      skipped += 1
      continue
    }
    skipped += 1
  }
  return { cards, edges, header, skipped }
}

/**
 * 导出为可回放的日志记录文本（重建库的另一种口径）。
 *
 * 与 {@link exportJsonl} 的区别：那个导出的是**当前视图**，这个导出的是**历史**。
 * 需要「重建后连修正历史都一致」时用这个口径。
 *
 * @param records - 日志记录。
 * @param exportedAt - 导出时刻；省略时取 0。
 * @returns JSONL 文本。
 */
export function exportRecordsJsonl(records: Iterable<{ seq: number }>, exportedAt = 0): string {
  const list = [...records].sort((a, b) => a.seq - b.seq)
  const lines: string[] = [JSON.stringify({
    kind: 'header', v: EXPORT_FORMAT_VERSION, exportedAt, records: list.length,
  })]
  for (const record of list) lines.push(JSON.stringify(record))
  return lines.join('\n') + '\n'
}

/**
 * 校验导入结果是否自洽。
 *
 * 检查项：卡片 id 不重复、边两端都存在。用于 CLI 的「健康检查」与导入前的预检（FR-F5）。
 *
 * @param result - 导入结果。
 * @returns 错误列表；为空表示自洽。
 */
export function validateImport(result: ImportResult): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const card of result.cards) {
    if (seen.has(card.id)) errors.push(`重复的卡片 id：${card.id}`)
    else seen.add(card.id)
  }
  for (const edge of result.edges) {
    if (!seen.has(edge.from)) errors.push(`边 ${edge.id} 的起点 ${edge.from} 不存在`)
    if (!seen.has(edge.to)) errors.push(`边 ${edge.id} 的终点 ${edge.to} 不存在`)
  }
  return errors
}
