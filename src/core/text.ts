/**
 * 文本内核：归一化、分词、相似度、实体抽取。
 *
 * 全部是纯函数，无 IO、无随机、无时间依赖。数据面去重、打分面相关度、
 * 抽取面信号识别都建立在这里，因此它必须先稳定。
 *
 * 为什么不用现成 NLP 库：需求 NFR-1 要求万级记忆单次预取 <50ms，
 * 且 ST-1 要求结果确定性。本地字符级 + 二元组（bigram）方案零依赖、
 * 确定性好、中文无需分词词典，够用且可测。
 *
 * @module dsh-memory/core/text
 */

/**
 * 中文停用词表。
 *
 * 只收录高频虚词。它们对「相关度」没有区分度，留着只会抬高所有卡的分数。
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '这个', '那个', '什么', '怎么', '为什么', '因为', '所以',
  '但是', '然后', '还是', '可以', '已经', '我们', '他们', '它', '把', '被', '让',
  '对', '从', '向', '与', '及', '或', '而', '则', '其', '之', '于', '为', '以',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or',
  'in', 'on', 'at', 'for', 'with', 'it', 'this', 'that', 'as', 'by', 'from',
])

/**
 * 归一化文本：用于去重与相似度比较，不进入上下文。
 *
 * 做四件事：全角转半角、统一小写、去掉标点与多余空白、压缩空白。
 * 不做同义词替换——那会引入不可解释的映射表，破坏「可解释」原则。
 *
 * @param raw - 原始文本。
 * @returns 归一化文本。
 */
export function normalizeText(raw: string): string {
  if (raw.length === 0) return ''
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    // 全角 ASCII（0xFF01..0xFF5E）转半角，全角空格单独处理。
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0)
      continue
    }
    if (code === 0x3000) {
      out += ' '
      continue
    }
    out += ch
  }
  out = out.toLowerCase()
  // 把标点与符号统一替换成空格，避免「好。」与「好」被当成不同词。
  out = out.replace(/[\p{P}\p{S}]+/gu, ' ')
  out = out.replace(/\s+/gu, ' ').trim()
  return out
}

/**
 * 分词：中文按二元组（bigram），英文/数字按连续字母数字串。
 *
 * 为什么不按单字：单字噪音太大（「的」到处都是）。
 * 为什么不按词：中文分词要词典，词典是外部依赖且不可解释。
 * 二元组在中文检索里是成熟做法，召回够用且完全确定。
 *
 * @param normalized - 已归一化的文本。
 * @returns 词项数组，可能含重复（由调用方决定是否去重）。
 */
export function tokenize(normalized: string): string[] {
  const tokens: string[] = []
  // 先按空格切段，段内再分中英文分别处理。
  for (const segment of normalized.split(' ')) {
    if (segment.length === 0) continue
    if (/^[a-z0-9_]+$/u.test(segment)) {
      // 纯英文/数字：整段保留，长词额外切出前缀，提升部分匹配率。
      if (!STOP_WORDS.has(segment)) tokens.push(segment)
      continue
    }
    // 混合段：把英文数字串与中文串分开。
    const parts = segment.match(/[a-z0-9_]+|[^a-z0-9_]+/gu) ?? []
    for (const part of parts) {
      if (part.length === 0) continue
      if (/^[a-z0-9_]+$/u.test(part)) {
        if (!STOP_WORDS.has(part)) tokens.push(part)
        continue
      }
      // 中文串：长度 1 直接保留，长度 ≥2 输出全部二元组。
      const chars = [...part]
      if (chars.length === 1) {
        if (!STOP_WORDS.has(chars[0]!)) tokens.push(chars[0]!)
        continue
      }
      for (let i = 0; i + 1 < chars.length; i += 1) {
        const bigram = chars[i]! + chars[i + 1]!
        if (!STOP_WORDS.has(bigram)) tokens.push(bigram)
      }
    }
  }
  return tokens
}

/**
 * 词项集合（去重），用于相似度与倒排索引。
 *
 * @param text - 原文。
 * @returns 去重后的词项集合。
 */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(normalizeText(text)))
}

/**
 * 词频表，用于 BM25 式的语义相关度。
 *
 * @param text - 原文。
 * @returns 词项到出现次数的映射。
 */
export function termFrequency(text: string): Map<string, number> {
  const tf = new Map<string, number>()
  for (const token of tokenize(normalizeText(text))) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }
  return tf
}

/**
 * Jaccard 相似度：交集除以并集。
 *
 * 用于去重判定（FR-C1）。选 Jaccard 而不是余弦：结果天然落在 0..1，
 * 阈值直观，且与词项数量无关，便于配置化。
 *
 * @param a - 词项集合 A。
 * @param b - 词项集合 B。
 * @returns 0..1 的相似度；两集合都空时返回 0。
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const item of small) {
    if (large.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 覆盖率相似度：查询词项被记忆卡覆盖的比例。
 *
 * 与 Jaccard 的区别：不惩罚卡片更长。检索场景里「长卡包含全部查询词」
 * 应当算高相关，而 Jaccard 会把它压低。两个指标各司其职：
 * 去重用 Jaccard（对称），打分用覆盖率（非对称）。
 *
 * @param query - 查询词项集合。
 * @param doc - 文档词项集合。
 * @returns 0..1 的覆盖率；查询为空时返回 0。
 */
export function coverage(query: ReadonlySet<string>, doc: ReadonlySet<string>): number {
  if (query.size === 0) return 0
  let hit = 0
  for (const token of query) {
    if (doc.has(token)) hit += 1
  }
  return hit / query.size
}

/**
 * 实体抽取：从原文里识别可作为「连接点」的锚点。
 *
 * 起源第 4 条要求「记忆图谱跨层次关联」。关联靠什么连？靠实体：
 * 同一个人、同一个项目、同一个文件。这里用规则抽取，不做 NER 模型——
 * 规则可解释、可测、零依赖，符合 NFR-1 与 ST-1。
 *
 * 抽取四类：文件路径、URL、代码标识符（含下划线或驼峰）、引号内专名。
 *
 * @param raw - 原文。
 * @returns 去重后的实体数组，保持出现顺序。
 */
export function extractEntities(raw: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(trimmed)
  }

  // 1) 文件路径：至少含一个分隔符且有扩展名，或明显的目录形式。
  for (const m of raw.matchAll(/[\w.\-]+(?:[/\\][\w.\-]+)+/gu)) {
    push(m[0])
  }
  // 2) URL。
  for (const m of raw.matchAll(/https?:\/\/[^\s)"'，。；]+/gu)) {
    push(m[0])
  }
  // 3) 代码标识符：驼峰或下划线，长度 ≥ 4，排除纯数字。
  for (const m of raw.matchAll(/\b[A-Za-z][A-Za-z0-9_]{3,}\b/gu)) {
    const word = m[0]
    const isCamel = /[a-z][A-Z]/u.test(word)
    const isSnake = word.includes('_')
    if (isCamel || isSnake) push(word)
  }
  // 4) 引号内的专名：《》「」“”''。
  for (const m of raw.matchAll(/[《「“'']([^》」”'']{2,20})[》」”'']/gu)) {
    push(m[1] ?? '')
  }
  return found
}

/**
 * 截断文本到指定字符数，超出补省略号。
 *
 * 需求 FR-E3 / Q-09：单条记忆卡注入有字符上限，保证每轮 token 成本可控。
 * 按码点截断，避免把代理对（emoji）切成半个字符。
 *
 * @param text - 原文。
 * @param maxChars - 字符上限（码点数）。
 * @returns 截断后的文本。
 */
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return chars.slice(0, Math.max(0, maxChars - 1)).join('') + '…'
}

/**
 * 估算 token 数。
 *
 * 需求 FR-E3 需要 token 硬上限，但精确计数要依赖模型分词器（宿主版本会漂）。
 * 这里用经验估算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token。
 * 偏保守（宁可少注入），保证绝不超预算。
 *
 * @param text - 文本。
 * @returns 估算 token 数。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意文字 + 中文标点区段。
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 判断文本是否包含任一信号关键词。
 *
 * 抽取面用它决定「这条消息值不值得写卡」（FR-A1 的写入门控）。
 * 起源第 10 条讲「专注机制」：不是所有输入都该进记忆，
 * 先门控再检索，是控制噪声与成本的第一道闸。
 *
 * @param text - 原文。
 * @param keywords - 关键词列表。
 * @returns 命中的关键词；未命中返回空数组。
 */
export function matchSignals(text: string, keywords: readonly string[]): string[] {
  const normalized = normalizeText(text)
  const hits: string[] = []
  for (const keyword of keywords) {
    const k = normalizeText(keyword)
    if (k.length === 0) continue
    if (normalized.includes(k)) hits.push(keyword)
  }
  return hits
}

/**
 * 句子切分：按中文/英文句末标点与换行切。
 *
 * 记忆卡的粒度是「一条消息 / 一个话题段」（Q-03 取话题段），
 * 所以要先能切句，再在句级挑出值得记的那几句。
 *
 * @param raw - 原文。
 * @returns 句子数组，已去除空白句。
 */
export function splitSentences(raw: string): string[] {
  const parts = raw.split(/(?<=[。！？!?；;\n])/u)
  const out: string[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}
