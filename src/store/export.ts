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
 * 从「导出文档」形状导入（即 `export --out` 实际写出的那个 JSON 对象）。
 *
 * ## 为什么必须有这个函数（真缺陷三十六：导出与导入格式不兼容）
 *
 * 本仓库此前有两个互不相通的格式：
 *
 * - {@link exportJsonl} 产出**逐行** JSONL（`kind: header|card|edge`）；
 * - `cli/commands/export.ts` 的 `--out` 写的是 `cli/types.ts` 的
 *   `ExportDocument`——**一个带缩进的单个 JSON 对象**。
 *
 * 而唯一的消费者 {@link importJsonl} 只认前者。于是「导出 → 导入」这条
 * FR-A6 的验收路径**在数据格式上就是断的**，不只是缺个 CLI 子命令。
 *
 * 探针实测（`.tmp/probe-import-gap.ts`，两组对照）：
 *
 * ```text
 * export --out 产物：1602 字节、71 行、首行 "{"
 *   直接喂 importJsonl → 解出卡片 0 张、跳过坏行 70 行、header null
 * 对照组（exportJsonl 产物喂同一个 importJsonl）
 *   → 解出卡片 2 张、跳过 0 行
 * ```
 *
 * 对照组是关键：它证明消费路径本身工作正常，所以上面那个 0 不是
 * 「文件没读到」而是**格式不匹配**。缺了这组对照，0 什么也证明不了。
 *
 * ## 为什么不直接把 `--out` 改成写 JSONL
 *
 * 那会破坏 `ExportDocument` 的既有契约（`counts` 里有活跃/归档/边数三个
 * 与导出范围无关的真实计数，JSONL 头里没有这些字段），而 CLI `export`
 * 的输出形状已被用例与文档锁住。让**消费者兼容两种格式**是改动更小、
 * 也不丢信息的一侧。
 *
 * @param parsed - 已 `JSON.parse` 过的值。
 * @returns 导入结果；不是导出文档形状时返回 `null`。
 */
export function importExportDocument(parsed: unknown): ImportResult | null {
  if (!isPlainObject(parsed)) return null
  const rawCards = parsed['cards']
  if (!Array.isArray(rawCards)) return null
  const cards: MemoryCard[] = []
  const edges: MemoryEdge[] = []
  let skipped = 0
  for (const card of rawCards) {
    if (isPlainObject(card) && typeof card['id'] === 'string' && card['id'].length > 0) {
      cards.push(card as unknown as MemoryCard)
    } else {
      skipped += 1
    }
  }
  const rawEdges = parsed['edges']
  if (rawEdges !== undefined) {
    if (!Array.isArray(rawEdges)) return null
    for (const edge of rawEdges) {
      // 边必须带两端与关系：缺任一项的边无法重建，也没有 id 可派生。
      const usable = isPlainObject(edge)
        && typeof edge['from'] === 'string' && edge['from'].length > 0
        && typeof edge['to'] === 'string' && edge['to'].length > 0
        && typeof edge['relation'] === 'string' && edge['relation'].length > 0
      if (usable) edges.push(edge as unknown as MemoryEdge)
      else skipped += 1
    }
  }
  const formatVersion = parsed['formatVersion']
  const exportedAt = parsed['exportedAt']
  return {
    cards,
    edges,
    header: {
      kind: 'header',
      v: typeof formatVersion === 'number' ? formatVersion : EXPORT_FORMAT_VERSION,
      exportedAt: typeof exportedAt === 'number' ? exportedAt : 0,
      cards: cards.length,
      edges: edges.length,
    },
    skipped,
  }
}

/** 导出文件的格式口径。 */
export type ExportFileFormat = 'document' | 'jsonl'

/** 导出文件解析结果：要么认出格式并给出内容，要么说清为什么不认。 */
export type ParsedExportFile =
  | { readonly ok: true; readonly format: ExportFileFormat; readonly result: ImportResult }
  | { readonly ok: false; readonly message: string }

/**
 * 解析一个导出文件的文本，自动识别两种格式。
 *
 * 判据只有一条：**顶层是不是一个带 `cards` 数组的 JSON 对象**。
 * 是则为 `document`（`export --out` 的产物），否则按 `jsonl` 解析
 * （{@link exportJsonl} 的产物，也是 {@link importJsonl} 的原生输入）。
 *
 * 返回判别式而不是「尽力而为」的结果：**「格式不认识」和「格式认识但内容全坏」
 * 必须能被调用方区分**。混成一个空结果，CLI 就只能报「导入了 0 条」，
 * 而用户无从知道是文件选错了还是文件坏了。
 *
 * @param text - 文件全文。
 * @returns 解析结果；格式无法识别时 `ok: false`。
 */
export function parseExportFile(text: string): ParsedExportFile {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false, message: '文件是空的' }
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // 首字符是 `{` 却解析不了：可能是被截断的 JSON，也可能是恰好以 `{`
      // 开头的坏行。交给下面按 JSONL 逐行处理，坏行会被计入 `skipped`，
      // 于是 CLI 仍然会报错而不是静默成功。
      return { ok: true, format: 'jsonl', result: importJsonl(text) }
    }
    const asDocument = importExportDocument(parsed)
    if (asDocument !== null) {
      const v = asDocument.header === null ? EXPORT_FORMAT_VERSION : asDocument.header.v
      // 版本比本代码新就拒绝：格式版本一旦递增，字段结构就可能变，
      // 用旧代码去读新文件只会得到「缺字段但看起来正常」的卡片。
      if (v > EXPORT_FORMAT_VERSION) {
        return {
          ok: false,
          message: `导出格式版本 ${v} 高于本程序支持的 ${EXPORT_FORMAT_VERSION}，请升级后再导入`,
        }
      }
      return { ok: true, format: 'document', result: asDocument }
    }
    // 是合法 JSON 对象，但不是导出文档形状：明确报错，不要退回 JSONL。
    // 退回的话，一个 `{"foo":1}` 会被当成「1 行坏行」，错误信息指向
    // 完全错误的方向。
    return { ok: false, message: '既不是导出文档（缺少 cards 数组），也不是逐行 JSONL' }
  }
  return { ok: true, format: 'jsonl', result: importJsonl(text) }
}

/**
 * 校验导入结果是否自洽。
 *
 * 检查项：卡片 id 在文件内不重复、边两端都存在。用于 CLI 的导入前预检（FR-F5）。
 *
 * ## 为什么多一个 `knownCardIds`
 *
 * 只按「文件里的卡」判边，会在**增量导入**时误报。库里已有 A、B，现在导入
 * 一份只含 C 与边 B→C 的片段——B 不在文件里，但它真实存在于库中，边是合法的。
 * 只查文件就会把这条合法边报成「起点不存在」，用户于是被迫要么全量导入、
 * 要么无视报错。而**一旦养成无视报错的习惯，真报错也就没用了**。
 *
 * 注意「与库内已有卡撞 id」**不是错误**：那是更新，幂等键会判断内容是否
 * 真的变了（见 `deriveIdempotencyKey` 的 `put` 分支）。所以重复判定只看
 * 文件内部，端点存在性才看并集——两件事用两个集合，不能混成一个。
 *
 * @param result - 导入结果。
 * @param knownCardIds - 库里已存在的卡片 id；省略表示只按文件判。
 * @returns 错误列表；为空表示自洽。
 */
export function validateImport(result: ImportResult, knownCardIds?: Iterable<string>): string[] {
  const errors: string[] = []
  const inFile = new Set<string>()
  for (const card of result.cards) {
    if (inFile.has(card.id)) errors.push(`重复的卡片 id：${card.id}`)
    inFile.add(card.id)
  }
  const known = knownCardIds === undefined ? inFile : new Set<string>([...knownCardIds, ...inFile])
  for (const edge of result.edges) {
    if (!known.has(edge.from)) errors.push(`边 ${edge.id} 的起点 ${edge.from} 不存在`)
    if (!known.has(edge.to)) errors.push(`边 ${edge.id} 的终点 ${edge.to} 不存在`)
  }
  return errors
}
