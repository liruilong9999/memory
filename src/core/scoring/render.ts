/**
 * 人读渲染：解释行、卡片行、焦点包文本与时间/时长格式化（FR-B4 / FR-E2）。
 *
 * `fmt` 原本是 `scoring.ts` 里的非导出工具函数；拆分后为被同目录 `spread.ts`
 * 的 `patchExplainForSpread` 复用而带上 `export`，但**不从 barrel
 * （`src/core/scoring.ts`）导出**，对外仍不可见。
 *
 * @module dsh-memory/core/scoring/render
 */

import type { MemoryConfig } from '../config.ts'
import { truncate } from '../text.ts'
import type { FocusPack, MemoryCard, ScoreBreakdown, ScoredCard, TimeState } from '../types.ts'

/**
 * 构造人可读的解释行。
 *
 * 需求 FR-B4：能回答「为什么想起这条」。
 *
 * 这里必须**如实**反映实际参与计算的维度：目标维度没参与时要明说「未启用」，
 * 不能显示成「目标匹配 0.000」——那是在告诉人「算了，但匹配度为零」，
 * 而真相是「这个维度根本没参与归一化」。FR-B4 的可解释性要求的是后者。
 *
 * @param score - 分数构成。
 * @param config - 配置，用于展示权重。
 * @param options - 渲染选项。
 * @param options.goalApplied - 目标维度是否参与计算；`false` 时标为未启用。
 * @returns 解释行数组。
 */
export function buildExplain(
  score: ScoreBreakdown,
  config: MemoryConfig,
  options: { goalApplied?: boolean } = {},
): string[] {
  const w = config.weights
  const goalApplied = options.goalApplied ?? true
  const lines = [
    `语义相关 ${fmt(score.semantic)} × 权重 ${fmt(w.semantic)} = ${fmt(score.semantic * w.semantic)}`,
    `重要性   ${fmt(score.importance)} × 权重 ${fmt(w.importance)} = ${fmt(score.importance * w.importance)}`,
    `时间新鲜 ${fmt(score.recency)} × 权重 ${fmt(w.recency)} = ${fmt(score.recency * w.recency)}`,
    goalApplied
      ? `目标匹配 ${fmt(score.goal)} × 权重 ${fmt(w.goal)} = ${fmt(score.goal * w.goal)}`
      : `目标匹配 未启用（本次未提供目标，权重 ${fmt(w.goal)} 不计入分母）`,
    `置信度   ${fmt(score.confidence)} × 权重 ${fmt(w.confidence)} = ${fmt(score.confidence * w.confidence)}`,
  ]
  if (score.conflictPenalty > 0) {
    lines.push(`冲突惩罚 -${fmt(score.conflictPenalty)} × 权重 ${fmt(w.conflict)} = -${fmt(score.conflictPenalty * w.conflict)}`)
  }
  // 相关分量必须显式列出：它是**决定去留**的那个数，而总分只决定排序。
  // 不列出来，用户看到「总分 0.45 却没进焦点包」会觉得系统坏了——
  // 实际是 relevance 不够。FR-B4 要求分数可解释，这一行是解释的核心。
  lines.push(`相关分量 ${fmt(score.relevance)}（闸门判据，阈值 ${fmt(config.recall.absoluteThreshold)}）`)
  lines.push(`总分 ${fmt(score.total)}`)
  return lines
}

/**
 * 格式化一条卡片为注入行。
 *
 * 格式刻意简短：`- [类型] 摘要（时间）`。不带来源指针、不带分数——
 * 那些进上下文只会烧 token，不进焦点包（FR-E1）。
 *
 * @param card - 记忆卡。
 * @param text - 已截断的摘要文本。
 * @returns 一行文本。
 */
export function formatCardLine(card: MemoryCard, text: string): string {
  const tag = kindLabel(card.kind)
  return `- [${tag}] ${text}`
}

/**
 * 卡片类型的中文标签。
 *
 * 为什么必须处理「未知类型」而不是靠 `switch` 的隐式 `undefined`：
 * 投影层（`src/store/state.ts` 的 `coerceKind`）对未知 `kind` 采取**忠实透传**
 * 策略——日志里写的是 `summary`，重放出来就必须还是 `summary`，不许静默改成
 * `fact`（那样日志写 A、重放得 B，破坏 ST-1 且事后无从发现）。既然未知类型
 * 能走到渲染层，这里就不能让它变成 `undefined`——那会渲染出
 * `- [undefined] xxx`，比降级更难查。
 *
 * 因此兜底返回**类型名本身**：不发明中文、不假装认识，把真相摆出来。
 *
 * @param kind - 类型。
 * @returns 中文标签；未知类型返回其原始名称。
 */
export function kindLabel(kind: MemoryCard['kind']): string {
  switch (kind) {
    case 'event': return '事件'
    case 'fact': return '事实'
    case 'promise': return '承诺'
    case 'concept': return '概念'
    case 'feeling': return '感受'
    case 'experience': return '经验'
    case 'summary': return '摘要'
    default: return String(kind)
  }
}

/**
 * 把焦点包渲染成注入文本。
 *
 * 需求 FR-E2：追加式、KV 安全——所以这里只产出**一段独立的文本块**，
 * 由适配面整体作为 context 内容追加，绝不改写系统提示词头部。
 *
 * @param pack - 焦点包。
 * @param time - 时间状态，用于渲染时间读数。
 * @returns 注入文本。空包时返回空串——**这是刻意的**：
 *   空包应当什么都不注入，让模型自己去问，而不是塞一句「没有相关记忆」诱导它
 *   说「我查过了，没有」。要拿提示语请用 `renderEmptyNote`。
 */
export function renderFocusPack(pack: FocusPack, time: TimeState): string {
  if (pack.empty) return ''
  const lines: string[] = []
  lines.push('## 相关记忆（由记忆系统自动召回，非用户输入）')
  lines.push(`当前时间：${formatTime(time.now, time.timeZone)}`)
  lines.push('')
  for (const item of pack.cards) {
    // 截断长度必须来自配置，不能硬编码：硬编码会让实际注入长度与 pack.tokens 的估算脱钩。
    const text = truncate(item.card.text, pack.maxCardChars)
    lines.push(formatCardLine(item.card, text))
    if (item.conflict) {
      // FR-B5 / SC-4：冲突必须**同时暴露双方**，只说「有冲突」等于让模型知道
      // 有矛盾却看不到矛盾的另一半，它要么忽略要么编造。
      // 标记词用 CONFLICT：FR-B5 原文就要求「标 CONFLICT」，规格与实现用同一个词，
      // 才能被 grep 验证，也方便模型把这个词当成确定信号。
      lines.push(`  ⚠ CONFLICT 与其他记忆冲突，冲突对象：${describeConflictPeers(item, pack)}`)
    }
  }
  lines.push('')
  lines.push('以上是系统召回的旧记忆，可能过时或不完整；与当前对话冲突时以当前对话为准。')
  return lines.join('\n')
}

/**
 * 把毫秒时间戳格式化为本地可读时间。
 *
 * 用 `Intl` 而不是手算时区偏移：夏令时、历史时区变更都能正确处理。
 *
 * @param at - 毫秒时间戳。
 * @param timeZone - IANA 时区名。
 * @returns `YYYY-MM-DD HH:mm` 形式。
 */
export function formatTime(at: number, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(at))
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/**
 * 把毫秒时长格式化为中文人话。
 *
 * 需求 FR-D2 / SC-3：「距上次聊这个多久了」的回答必须与代码计算一致，
 * 所以这里输出的是确定性的中文表述，而不是让模型自己算。
 *
 * @param ms - 毫秒数。
 * @returns 如「3 天 2 小时前」。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (ms < minute) return '刚刚'
  if (ms < hour) return `${Math.floor(ms / minute)} 分钟前`
  if (ms < day) return `${Math.floor(ms / hour)} 小时前`
  const days = Math.floor(ms / day)
  if (days < 30) {
    const restHours = Math.floor((ms - days * day) / hour)
    return restHours > 0 ? `${days} 天 ${restHours} 小时前` : `${days} 天前`
  }
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}

/**
 * 保留三位小数的格式化，用于解释行。
 *
 * @param value - 数值。
 * @returns 三位小数字符串。
 */
export function fmt(value: number): string {
  return value.toFixed(3)
}

/**
 * 渲染空焦点包的说明文本（FR-B6 / ST-5）。
 *
 * 为什么要单独一个函数：\`pack.note\` 此前是**纯死字段**——写进去了、测了、
 * 然后没有任何地方读它（\`grep -rn "\.note" src/\` 零命中）。FR-B6「不编造」
 * 这条 P0 验收靠的正是这句提示，结果模型永远收不到。
 *
 * 语义上仍要区分两件事：
 * - \`renderFocusPack\` 空包时返回空串：**不注入**记忆块，不污染上下文；
 * - \`renderEmptyNote\` 供需要明确告知的场合（如命令输出、诊断）使用。
 *
 * @param pack - 焦点包。
 * @returns 空包时的说明；非空包返回空串。
 */
export function renderEmptyNote(pack: FocusPack): string {
  return pack.empty ? pack.note : ''
}

/**
 * 描述一张冲突卡的「对方是谁」。
 *
 * FR-B5 要求冲突**双方同时暴露**。只写「有冲突」等于让模型知道有矛盾却
 * 看不到另一半，它只能忽略或编造——两种都违反 FR-B6。
 *
 * @param item - 当前被打分的卡片。
 * @param pack - 焦点包，用于查找对方是否也在包内。
 * @returns 形如 `「另一张卡的文本」` 的描述；找不到时退回 id。
 */
export function describeConflictPeers(item: ScoredCard, pack: FocusPack): string {
  const ids = item.card.conflictOf
  if (ids.length === 0) return '（对方已不在活跃记忆中）'
  const described: string[] = []
  for (const id of ids) {
    const peer = pack.cards.find((other) => other.card.id === id)
    if (peer === undefined) {
      described.push(`（另一条记忆 ${formatCardRef(id)}，不在本次焦点包内）`)
      continue
    }
    described.push(`「${truncate(peer.card.text, pack.maxCardChars)}」`)
  }
  return described.join('；')
}

/* ------------------------------------------------------------------ *
 * 卡片引用（人读输出里怎么写、用户抄回来怎么解析）
 * ------------------------------------------------------------------ */

/**
 * 人读输出里卡片 id 的展示长度（取前 N 位）。
 *
 * ## 8 这个数从哪来
 *
 * 卡片 id 是 `buildCardId` 产出的 **16 位十六进制**（64 位 FNV-1a 取前 64 位
 * 的完整十六进制文本）。人读输出里没必要占 16 个字符，取前 8 位 = **32 位熵**。
 * 按生日悖论估算，一个库里 `n` 张卡撞前缀的概率约 `n² / (2 × 2³²)`：
 * `n = 1000` 约 0.012%，`n = 5000` 约 0.29%。
 *
 * 也就是说 **8 位不是「永远够用」，而是「大多数时候够用、且撞了能被发现」**。
 * 它成立的前提是配对的解析函数 {@link lookupCard}：撞前缀时它报
 * 「匹配到多张，请给更长前缀」，而不是随便挑一张。**没有这一步，缩短就是错的**
 * ——用户拿着 `a1b2c3d4` 敲 `restore`，系统悄悄恢复了另一张卡，事后无从发现。
 *
 * 改这个数只改一处：渲染（{@link formatCardRef}）与解析（{@link lookupCard}，
 * 它接受任意长度的前缀）都读它或与它相容，不会各自漂移。
 */
export const CARD_REF_PREFIX_LENGTH = 8

/**
 * 把卡片 id 渲染成人读输出里的引用写法。
 *
 * 规则：**长于 {@link CARD_REF_PREFIX_LENGTH} 时截断，否则原样返回**。
 * 不足 8 位原样返回是为了让测试与手工构造的 id（如 `card-7`）也能被渲染，
 * 渲染函数不该假定 id 一定是 16 位。
 *
 * @param id - 完整卡片 id。
 * @returns 可粘回 `restore` / `revise` / `history` 的引用写法。
 */
export function formatCardRef(id: string): string {
  return id.length <= CARD_REF_PREFIX_LENGTH ? id : id.slice(0, CARD_REF_PREFIX_LENGTH)
}

/**
 * 卡片引用的解析结果。
 *
 * `ok: false` 时 `message` 已经是**给人看的一句话**：调用方（CLI / 会话命令）
 * 直接打印即可，不需要各自再拼一遍文案——两处各写一遍就是两个真相源。
 */
export type CardRefLookup =
  | { ok: true; card: MemoryCard }
  | { ok: false; reason: 'not-found' | 'ambiguous'; message: string }

/**
 * 把用户抄回来的卡片引用解析成一张卡。
 *
 * ## 判据顺序（顺序本身就是判据）
 *
 * 1. **全 id 精确命中优先**：用户给的是完整 16 位时，前缀歧义与他无关。
 * 2. 否则按**前缀**匹配。大小写不敏感——id 是十六进制，`AB` 与 `ab` 是同一个数；
 *    人从终端复制时大小写不该成为失败原因。
 * 3. 命中 0 张 → `not-found`；命中 1 张 → 返回它。
 * 4. 命中 ≥2 张 → `ambiguous`，**绝不挑一张**。挑一张的后果是「命令成功了、
 *    改的是另一张卡」，而输出里看不出任何异常——这是缺陷三十四那种
 *    「每步都成功、结果全错」的形状。
 *
 * @param cards - 候选卡片集合（通常是一次 `engine.query({})` 的全库结果）。
 * @param ref - 用户给的引用；可以是全 id，也可以是前缀。
 * @returns 解析结果。
 */
export function lookupCard(cards: readonly MemoryCard[], ref: string): CardRefLookup {
  const wanted = ref.trim().toLowerCase()
  if (wanted.length === 0) return { ok: false, reason: 'not-found', message: `没有这张卡：${ref}` }
  // 精确命中优先：全 id 不需要参与前缀歧义判定。
  const exact = cards.find((card) => card.id.toLowerCase() === wanted)
  if (exact !== undefined) return { ok: true, card: exact }
  const matches = cards.filter((card) => card.id.toLowerCase().startsWith(wanted))
  const only = matches[0]
  if (matches.length === 1 && only !== undefined) return { ok: true, card: only }
  if (matches.length === 0) return { ok: false, reason: 'not-found', message: `没有这张卡：${ref}` }
  // 候选按 id 升序，保证同一库同一引用每次报出来的名单完全一致（ST-1）。
  const sorted = [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const lines = [`匹配到 ${sorted.length} 张，请给更长前缀：${ref}`]
  for (const card of sorted) lines.push(`  ${card.id}「${card.text}」`)
  return { ok: false, reason: 'ambiguous', message: lines.join('\n') }
}
