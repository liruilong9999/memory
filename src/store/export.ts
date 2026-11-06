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

import { EDGE_RELATIONS } from '../core/types.ts'
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

/* ------------------------------------------------------------------ *
 * 导入预检：卡片与边的**形状**判据
 * ------------------------------------------------------------------ */

/**
 * `MemoryCard` 的全部必填字段。
 *
 * 与 `src/core/types.ts` 的 `MemoryCard` 一一对应；可选字段
 * （`mergedInto` / `mergeOf` / `dueAt` / `dueRepeat` / `cronExpression`）
 * 刻意不在其中——省略它们是**合法**的，程序自己导出的文件里也可能没有。
 */
const REQUIRED_CARD_FIELDS: readonly string[] = [
  'id', 'domain', 'kind', 'text', 'normalized', 'createdAt', 'updatedAt', 'source',
  'salience', 'confidence', 'emotional', 'strength', 'accessCount', 'lastAccessAt',
  'tags', 'entities', 'revisions', 'status', 'conflictOf', 'pinned',
]

/** `MemoryCard` 里取值必须落在 0..1 的字段。 */
const UNIT_CARD_FIELDS: readonly string[] = ['salience', 'confidence', 'emotional', 'strength']

/** 判断值是否为有限数字（`NaN` / `Infinity` 一律不算）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 判断值是否为字符串数组。 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 判断值是否为非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * 把一个非法值渲染成短的、可 grep 的说明。
 *
 * 不直接 `JSON.stringify` 整个值：一条错误信息里塞进整张卡会让
 * 「哪张卡坏了」这个结论被淹掉，而卡片正文最长可以是几 KB。
 *
 * @param value - 待描述的值。
 * @returns 一行说明。
 */
function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    return value.length > 40 ? `字符串「${value.slice(0, 40)}…」` : `字符串「${value}」`
  }
  if (typeof value === 'number') return `数字 ${String(value)}`
  if (typeof value === 'boolean') return `布尔 ${String(value)}`
  if (Array.isArray(value)) return `数组（${value.length} 项）`
  if (typeof value === 'object') return '对象'
  return String(value)
}

/**
 * 判断一张导入卡片的形状是否合法。
 *
 * ## 这个函数解决的是哪个问题（缺陷 · `import` 对非法卡片抛 TypeError）
 *
 * 「一张卡片是否合法」在本仓库里曾经**有三套互不一致的判据**，三层各说各话：
 *
 * | 层 | 位置 | 同一张缺 `conflictOf` 的卡 |
 * |---|---|---|
 * | 解析层 | `importJsonl` / `importExportDocument` | **只查 `id` 非空**，然后 `as unknown as MemoryCard` 放行 |
 * | 键派生层 | `deriveIdempotencyKey` 的 `put` 分支 | `op.card.conflictOf.join(',')` **裸解引用，直接抛 TypeError** |
 * | 重放层 | `coerceCard` | `asStringArray` 兜底成 `[]`，**不崩** |
 *
 * 三层判据不一致的后果不是「有一层多余」，而是**两层之间的缝隙里能塞进残卡**：
 * 解析层放行、键派生层崩溃 ⇒ 用户拿到一段堆栈；而缺 `strength` / `status`
 * 这类不崩的字段，则被 `String(undefined)` 拼成字面量 `"undefined"` 进幂等键、
 * 卡片**照写不误**，重放时再被 `coerceCard` 静默改写成 `strength: 0` /
 * `status: 'active'`。用户看到「导入成功 N 张」，库里是残卡——**导入成功
 * 但不等于文件里的内容落进了库**。
 *
 * ## 判据怎么来的：预检 ⊇ 重放层的「拒绝」与「静默改写」
 *
 * 判据不是逐字段凭直觉列的，而是从 `coerceCard`（`src/store/state.ts`）的
 * 行为反推出来的，取并集：
 *
 * 1. **重放层会拒绝的**（返回 `null`，记录落盘但状态里没有这张卡）：
 *    `id` 非空字符串、`source` 是对象。
 * 2. **重放层会静默改写的**（不报错，但读回来的卡与文件里的不是同一张）：
 *    缺 `strength` → 0、`salience: 1.5` → 截到 1、`status: 'bogus'` → `'active'`、
 *    缺 `domain` → `'work'`、缺 `conflictOf` → `[]`……**这一类才是多数**，
 *    也是这个缺陷真正的杀伤面：它不崩，所以没人报 bug。
 *
 * 换句话说：**重放层的宽容是历史数据的需要，不是新数据的许可证**。
 * 两者必须分开——`coerceCard` 继续宽容（老日志必须能打开，见 `src/store/meta.ts`
 * 的「判据一」），而**入口**必须严格，否则每宽容一次就等于默许写进一条残卡。
 *
 * ## 为什么判据只此一处
 *
 * 这项判据只写在预检层，**不在 `deriveIdempotencyKey` 里再抄一份**。抄一份就是
 * 两个真相源，改了一处另一处照样漂移——这正是本缺陷的成因（三套判据）。
 * 键派生层只负责「不崩、不拼出 `undefined` 字面量」，合法性的裁决留在这里。
 *
 * ## 为什么缺字段是**成组**报的
 *
 * 一张手写的卡可能一次缺七八个字段。逐条报会把「有 2 张坏卡」淹成「有 16 条错误」，
 * 而 CLI 只显示前 5 条 ⇒ 用户看到的全是第一张卡的问题，根本不知道还有第二张。
 * 所以缺字段合成一条、非法值合成一条，**一条错误 ≈ 一张坏卡**。
 *
 * @param raw - 从文件里读出的卡片对象（**未经类型系统保护**，可能是任何东西）。
 * @returns 问题描述；形状合法时返回 `null`。
 */
function describeCardProblem(raw: unknown): string | null {
  if (!isPlainObject(raw)) return `不是对象（实际是 ${describeValue(raw)}）`

  const missing = REQUIRED_CARD_FIELDS.filter((field) => raw[field] === undefined)
  if (missing.length > 0) return `缺少 ${missing.length} 个必填字段：${missing.join('、')}`

  const invalid: string[] = []
  const bad = (field: string, expected: string): void => {
    invalid.push(`${field} 应为${expected}，实际是 ${describeValue(raw[field])}`)
  }

  if (!isNonEmptyString(raw['id'])) bad('id', '非空字符串')
  // `kind` / `domain` 刻意**只查非空字符串、不查是否属于已知集合**：
  // 重放层的 `coerceKind` / `coerceDomain` 会原样透传未知字符串（前向兼容，
  // 见 `src/store/state.ts` 的长注释）。若这里按 `MEMORY_KINDS` 收窄，
  // 就把「重放层愿意保留的值」判成非法——预检比重放层更严同样是两套判据。
  if (!isNonEmptyString(raw['domain'])) bad('domain', '非空字符串')
  if (!isNonEmptyString(raw['kind'])) bad('kind', '非空字符串')
  if (typeof raw['text'] !== 'string') bad('text', '字符串')
  if (typeof raw['normalized'] !== 'string') bad('normalized', '字符串')
  if (!isFiniteNumber(raw['createdAt'])) bad('createdAt', '有限数字')
  if (!isFiniteNumber(raw['updatedAt'])) bad('updatedAt', '有限数字')

  const source = raw['source']
  if (!isPlainObject(source)) {
    bad('source', '对象')
  } else {
    if (typeof source['sessionId'] !== 'string') bad('source.sessionId', '字符串')
    if (!isFiniteNumber(source['turn'])) bad('source.turn', '有限数字')
    if (!isFiniteNumber(source['step'])) bad('source.step', '有限数字')
    if (!isFiniteNumber(source['seq'])) bad('source.seq', '有限数字')
    if (typeof source['eventType'] !== 'string') bad('source.eventType', '字符串')
  }

  for (const field of UNIT_CARD_FIELDS) {
    const value = raw[field]
    if (!isFiniteNumber(value) || value < 0 || value > 1) bad(field, ' 0..1 之间的数字')
  }
  const accessCount = raw['accessCount']
  if (!isFiniteNumber(accessCount) || accessCount < 0 || !Number.isInteger(accessCount)) {
    bad('accessCount', '非负整数')
  }
  const lastAccessAt = raw['lastAccessAt']
  if (lastAccessAt !== null && !isFiniteNumber(lastAccessAt)) bad('lastAccessAt', 'null 或有限数字')
  if (!isStringArray(raw['tags'])) bad('tags', '字符串数组')
  if (!isStringArray(raw['entities'])) bad('entities', '字符串数组')
  if (
    !Array.isArray(raw['revisions'])
    || !raw['revisions'].every((item) => isPlainObject(item)
      && isFiniteNumber(item['at'])
      && typeof item['reason'] === 'string'
      && typeof item['previousText'] === 'string'
      && (item['actor'] === 'system' || item['actor'] === 'consolidation' || item['actor'] === 'manual'))
  ) {
    bad('revisions', '由 {at:数字, reason:字符串, previousText:字符串, actor:“system”/“consolidation”/“manual”} 组成的数组')
  }
  // `status` 必须精确落在两值上：`coerceCard` 只有 `'archived'` 例外，其余一律
  // 归到 `'active'`。放过 `'bogus'` 就等于静默把一张归档卡改成活跃卡。
  if (raw['status'] !== 'active' && raw['status'] !== 'archived') bad('status', '“active” 或 “archived”')
  if (!isStringArray(raw['conflictOf'])) bad('conflictOf', '字符串数组')
  if (typeof raw['pinned'] !== 'boolean') bad('pinned', '布尔')

  // 可选字段：可以不出现，但**出现了就必须合法**——`coerceCard` 对
  // `mergeOf: []` / 未知 `dueRepeat` / 空 `cronExpression` 都是静默丢弃。
  const mergedInto = raw['mergedInto']
  if (mergedInto !== undefined && !isNonEmptyString(mergedInto)) bad('mergedInto', '非空字符串')
  const mergeOf = raw['mergeOf']
  if (mergeOf !== undefined && (!isStringArray(mergeOf) || mergeOf.length === 0)) {
    bad('mergeOf', '非空字符串数组')
  }
  const dueAt = raw['dueAt']
  if (dueAt !== undefined && dueAt !== null && !isFiniteNumber(dueAt)) bad('dueAt', 'null 或有限数字')
  const dueRepeat = raw['dueRepeat']
  if (
    dueRepeat !== undefined && dueRepeat !== 'once' && dueRepeat !== 'daily'
    && dueRepeat !== 'weekly' && dueRepeat !== 'cron'
  ) {
    bad('dueRepeat', '“once” / “daily” / “weekly” / “cron”')
  }
  const cronExpression = raw['cronExpression']
  if (cronExpression !== undefined && !isNonEmptyString(cronExpression)) bad('cronExpression', '非空字符串')

  return invalid.length === 0 ? null : invalid.join('；')
}

/**
 * 判断一条导入边的形状是否合法。
 *
 * ## 边这一半比卡片更糟，只是没人报过
 *
 * 重放层对边**完全不校验**：`applyRecord` 的 `edge` 分支只判 `edge.id` 非空，
 * 然后 `state.edges.set(edge.id, { ...edge })` **原样**放进状态。所以 `weight`
 * 缺失时不是像卡片那样被兜底成 0，而是变成 `undefined` 参与打分——
 * `a.weight * b.weight` 得到 `NaN`，扩散加分整段污染，且**不报错**。
 *
 * 判据同样来自「重放层不管 ⇒ 入口必须管」，与卡片一一对应。
 *
 * @param raw - 从文件里读出的边对象。
 * @returns 问题描述；形状合法时返回 `null`。
 */
function describeEdgeProblem(raw: unknown): string | null {
  if (!isPlainObject(raw)) return `不是对象（实际是 ${describeValue(raw)}）`

  const missing = ['id', 'from', 'to', 'relation', 'weight', 'createdAt']
    .filter((field) => raw[field] === undefined)
  if (missing.length > 0) return `缺少 ${missing.length} 个必填字段：${missing.join('、')}`

  const invalid: string[] = []
  const bad = (field: string, expected: string): void => {
    invalid.push(`${field} 应为${expected}，实际是 ${describeValue(raw[field])}`)
  }
  if (!isNonEmptyString(raw['id'])) bad('id', '非空字符串')
  if (!isNonEmptyString(raw['from'])) bad('from', '非空字符串')
  if (!isNonEmptyString(raw['to'])) bad('to', '非空字符串')
  // `relation` 必须是已知七值之一：它决定渲染与图谱语义，重放层不判，
  // 未知值会原样进状态，然后所有 `switch (relation)` 静默走 `default`。
  if (!isNonEmptyString(raw['relation']) || !(EDGE_RELATIONS as readonly string[]).includes(raw['relation'])) {
    bad('relation', `七种边类型之一（${EDGE_RELATIONS.join(' / ')}）`)
  }
  const weight = raw['weight']
  if (!isFiniteNumber(weight) || weight < 0 || weight > 1) bad('weight', ' 0..1 之间的数字')
  if (!isFiniteNumber(raw['createdAt'])) bad('createdAt', '有限数字')

  return invalid.length === 0 ? null : invalid.join('；')
}

/**
 * 校验导入结果是否自洽。
 *
 * 检查项：**卡片与边的形状合法**、卡片 id 在文件内不重复、边两端都存在。
 * 用于 CLI 的导入前预检（FR-F5）。
 *
 * ## 为什么形状校验必须放在预检层（而不是修 `deriveIdempotencyKey`）
 *
 * 这是本缺陷选层的**决定性理由**，与「哪一层崩的」无关：
 *
 * - 预检是**唯一一处能在写第一条之前看到整个批次**的地方。缺陷的观测形态是
 *   「第一张合法、第二张缺字段 ⇒ 第一张已落盘、然后抛 TypeError」，用户面对
 *   一个半导入的库加一段堆栈。把校验放在 `deriveIdempotencyKey`（逐卡、写时）
 *   或 `coerceCard`（逐记录、重放时）**在结构上都不可能**给出「要么全进、
 *   要么一条不进」：它们看到的是已经轮到自己那张卡，前面的卡早就写进日志了。
 * - 预检同时覆盖两个面：崩（缺 `conflictOf`）与静默写残卡（缺 `strength` 等）。
 *   只修 `deriveIdempotencyKey` 只能让前者变成「不崩」，残卡照样进库。
 *
 * 剩下两个位置各留一道**不同职责**的防线，不是重复校验：
 * - `deriveIdempotencyKey` 的兜底：保证它**不抛 TypeError、不拼出 `"undefined"`
 *   字面量**（那里是写前最后一站，抛错会留下半截状态）；
 * - `coerceCard` 的宽容：保证**老日志仍然能打开**（判据一）。
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
  // 用下标而不是 `for...of`：非法卡片的 `id` 可能根本不是字符串，
  // 拿它拼提示会得到 `[object Object]`，「哪一张坏了」就无从定位。
  // 序号是**文件内位置**，用户能直接对着文件数到那一行。
  for (const [index, card] of result.cards.entries()) {
    const id = (card as { id?: unknown }).id
    const usableId = isNonEmptyString(id) ? id : null
    // 即使形状非法也要把可用的 id 记进 `inFile`：否则同一批里的边会被报成
    // 「端点不存在」——而端点其实是存在的，只是那张卡自己坏了。
    // **错误信息指错地方比少报一条更糟**：用户会去修一条没问题的边。
    if (usableId !== null && inFile.has(usableId)) {
      errors.push(`重复的卡片 id：${usableId}`)
    }
    if (usableId !== null) inFile.add(usableId)

    const problem = describeCardProblem(card)
    if (problem === null) continue
    const which = usableId === null ? `第 ${index + 1} 张卡片` : `卡片 ${usableId}`
    errors.push(`${which} 结构非法：${problem}`)
  }
  const known = knownCardIds === undefined ? inFile : new Set<string>([...knownCardIds, ...inFile])
  for (const [index, edge] of result.edges.entries()) {
    const id = (edge as { id?: unknown }).id
    const usableId = isNonEmptyString(id) ? id : null
    const problem = describeEdgeProblem(edge)
    if (problem !== null) {
      const which = usableId === null ? `第 ${index + 1} 条边` : `边 ${usableId}`
      errors.push(`${which} 结构非法：${problem}`)
      // 形状非法时**不再**逐端点判存在性：这条边的 `from`/`to` 可能压根不是
      // 字符串，再报两句「起点 undefined 不存在」只会把真正的结论埋掉。
      continue
    }
    if (!known.has(edge.from)) errors.push(`边 ${edge.id} 的起点 ${edge.from} 不存在`)
    if (!known.has(edge.to)) errors.push(`边 ${edge.id} 的终点 ${edge.to} 不存在`)
  }
  return errors
}
