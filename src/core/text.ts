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
 * 判断字符串里是否含汉字（CJK 统一表意文字）。
 *
 * 为什么需要它：文件路径与需求编号两条规则原先用 `\w` 与 `[A-Z][a-z]+`，
 * 两者都不含汉字，于是 `docs/1-需求规格.md` 被截成 `docs/1-`、
 * `FR-G1` 直接抽不出。这不是「少抽几个词」，是**锚点被截断成假锚点**：
 * `docs/1-` 会让所有 `docs/1-*` 文件错误地共享同一个实体键。
 *
 * @param value - 待检查字符串。
 * @returns 是否含至少一个汉字。
 */
function hasHan(value: string): boolean {
  return /\p{Script=Han}/u.test(value)
}

/**
 * 中文停用词表。
 *
 * 只收录高频虚词。它们对「相关度」没有区分度，留着只会抬高所有卡的分数。
 */
/**
 * 英文常用词排除表。
 *
 * 用于第 5 类实体抽取（裸专有名词）：中文句子里嵌入的拉丁词首字母大写，
 * 几乎必然是有意为之的专名；但**纯英文句首**的大写普通词（The / This / When）
 * 会被误抽。这张表就是挡它们的。
 *
 * 只收「会出现在句首且不构成专名」的高频词。宁可少收几个——漏收的后果是
 * 多抽一个噪声实体（可能连出一条假边），多收的后果是把真专名（如 `Make`、
 * `Go`、`Rust`）永久挡在门外，**后者更难发现**，因为没有任何报错。
 *
 * 因此刻意**不**收录编程语言名（Go / Rust / Swift / Make）——它们既是
 * 常用英文词又是真专名，两边都不该由一张静态表裁决。当前取舍是**保留为实体**：
 * 连出一条边最坏是噪声，永久抽不出实体则是能力缺失。
 */
const EN_COMMON_WORDS: ReadonlySet<string> = new Set([
  'the', 'this', 'that', 'these', 'those', 'there', 'then', 'than', 'they', 'them',
  'and', 'but', 'for', 'not', 'you', 'your', 'our', 'with', 'from', 'have', 'has',
  'was', 'were', 'are', 'is', 'be', 'been', 'will', 'would', 'should', 'could',
  'can', 'may', 'might', 'must', 'shall', 'when', 'where', 'what', 'which', 'who',
  'how', 'why', 'all', 'any', 'some', 'each', 'every', 'both', 'more', 'most',
  'other', 'such', 'only', 'also', 'just', 'now', 'here', 'about', 'after',
  'before', 'again', 'still', 'even', 'well', 'back', 'down', 'over', 'into',
  'let', 'get', 'got', 'make', 'made', 'use', 'used', 'using', 'see', 'look',
])

const STOP_WORDS: ReadonlySet<string> = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '这个', '那个', '什么', '怎么', '为什么', '因为', '所以',
  '但是', '然后', '还是', '可以', '已经', '我们', '他们', '它', '把', '被', '让',
  '对', '从', '向', '与', '及', '或', '而', '则', '其', '之', '于', '为', '以',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'or',
  'in', 'on', 'at', 'for', 'with', 'it', 'this', 'that', 'as', 'by', 'from',
  // ── 程度副词与语气碎片（缺陷三十一）──────────────────────────────────
  // 二元组分词没有词典，会产出「有点」「非常」这类**程度副词碎片**。
  // 它们在检索里几乎没有区分度（几乎每句都能有），更要紧的是它们会被
  // `distill` 当成「主题词」——实测产出了
  // 「『有点』这件事反复牵动我的情绪，前后经历了 2 次」。
  //
  // 这不是难看的问题：**主题词是判据**。两张卡因为都带「有点」而聚成桶，
  // 于是「有点烦」和「有点慌」被当成同一件事反复经历，感受卡的内容是假的。
  //
  // 为什么加在停用词表而不是在 `themeTerms` 里再过滤一遍：停用词表已经是
  // 「什么不算词项」的唯一真相源，**另开一份就是两个真相源**，
  // 将来加词必然漏掉一处。而且检索侧同样不该把「有点」当查询词。
  '有点', '有些', '一点', '一下', '一些', '非常', '特别', '真的', '比较',
  '感觉', '觉得', '应该', '可能', '需要', '开始', '现在', '时候', '如果',
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
 * 起源 L15（无编号）要求「记忆图谱跨层次关联」。关联靠什么连？靠实体：
 * 同一个人、同一个项目、同一个文件。这里用规则抽取，不做 NER 模型——
 * 规则可解释、可测、零依赖，符合 NFR-1 与 ST-1。
 *
 * 抽取五类：文件路径、URL、代码标识符（含下划线或驼峰）、引号内专名、
 * **裸专有名词**（首字母大写的拉丁词，如 `Cordis` / `Redis` / `Vue3` / `Qt5`）。
 *
 * ## 第五类是怎么补上的（真实缺陷）
 *
 * 原先只认前四类。后果不是「少抽几个词」，而是**图谱几乎连不起来**：
 * 中文对话里最常出现的项目名、技术名恰恰是裸词——`Cordis`、`Redis`、
 * `Vue3`、`Qt5`、`Vite`。实测 20 轮语料里 `Cordis` 出现 8 句、抽出 **0** 句，
 * `Redis` 3→0、`Vue3` 4→0、`Qt5` 3→0、`Vite` 1→0。只有 `PostgreSQL` 因为
 * 含大小写混合、被驼峰规则误打误撞抽了出来。
 *
 * 而 `same-entity` 边**完全依赖**实体抽取。于是中文场景下图谱边本就稀疏，
 * 扩散激活没有边可走，「突触效果」在真实数据上近乎不可见。
 *
 * ## 为什么用「首字母大写」当判据
 *
 * 中文句子里嵌入的拉丁词，首字母大写几乎必然是有意为之的专名；而纯英文句首
 * 的大写普通词（The / This / When）会误抽，所以配一份英文常用词排除表。
 * 定标实测（19 句带簇标签语料，按「共享实体 ⇒ 判同主题」连边）：
 *
 * | 判据 | 连对 | 误连 | 漏连 | 精确率 | 召回率 |
 * |---|---|---|---|---|---|
 * | 原四类 | 3 | 0 | 35 | 100% | 8% |
 * | + 首字母大写（≥2 小写） | 32 | 3 | 6 | 91% | 84% |
 * | **+ 首字母大写（≥1 小写）** | **35** | **3** | **3** | **92%** | **92%** |
 *
 * 精确率从 100% 降到 92% 是**有意的交易**：100% 精确但只召回 8% 的判据，
 * 在真实数据上等于不存在。图谱宁可多几条边，也不要一条边都没有——
 * 后者会让「突触」这个能力永远不生效，而且看不出是缺陷。
 *
 * 不抽全大写缩写（`API` / `HTTP`）：实测加进去精确率反而从 92% 降到 89%，
 * 召回率不涨。通用缩写在任何话题里都出现，没有区分力，抽出来只会乱连边。
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

  // 1) 文件路径：至少含一个分隔符。**路径段必须允许汉字**——
  //    原先用 `[\w.\-]`，`\w` 不含汉字，于是 `docs/1-需求规格.md` 被截成
  //    `docs/1-`。截断比抽不出更坏：`docs/1-` 会成为**假锚点**，让
  //    `docs/1-需求规格.md` 与 `docs/1-架构设计.md` 错误地共享同一个实体键，
  //    从而连出一条本该不存在的 same-entity 边。
  for (const m of raw.matchAll(/[\w.\-\p{Script=Han}]+(?:[/\\][\w.\-\p{Script=Han}]+)+/gu)) {
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
  // 4.5) 编号形态的标识符：`FR-G1` / `ST-1` / `Q-06` / `D-08`。
  //
  // 这类串是**本仓库文档里最高频的锚点**，而原五条规则一条都抽不出来：
  // 规则 3 要求驼峰或下划线（`FR-G1` 两者都不是），规则 5 要求
  // `[A-Z][a-z]+`（`FR` 没有小写）。实测 `FR-G1` / `ST-1` 均返回 `[]`。
  //
  // 形态判据刻意收得很窄（2+ 个大写字母 + 连字符 + 数字），因为这类
  // 形态在自然语言里几乎不会偶然出现，误抽风险接近 0。
  for (const m of raw.matchAll(/\b[A-Z]{2,}-[A-Z]?\d+\b/gu)) {
    push(m[0])
  }
  // 4.6) 小写连字符术语：`dsh-memory` / `same-topic` / `event-log`。
  //
  // 同样一条原规则都抽不出：规则 3 要求驼峰或下划线，规则 5 要求首字母大写。
  // 而项目名恰恰是中文对话里最该被当成锚点的东西——实测 `dsh-memory` 返回 `[]`。
  //
  // 门槛：整串 ≥ 5 字符且至少两段，避开 `e-mail` / `up-to` 这类两段短词。
  for (const m of raw.matchAll(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gu)) {
    if (m[0].length < 5) continue
    push(m[0])
  }
  // 5) 裸专有名词：首字母大写 + 至少一个小写字母（或直接跟数字）。
  //    英文常用词排除表挡住英文句首的 The / This / When 之类。
  for (const m of raw.matchAll(/\b[A-Z][a-z]+[0-9]*\b/gu)) {
    const word = m[0]
    if (EN_COMMON_WORDS.has(word.toLowerCase())) continue
    push(word)
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
 * 起源 L29（第 5 条）讲「专注机制」：不是所有输入都该进记忆，
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
  // 连续标点必须**归入前一句**，而不是各自成句（缺陷二十八）。
  //
  // 原实现用 `(?<=[。！？!?；;\n])` 零宽后视切分，「超级爽！！！」会被切成
  // `"…超级爽！"` + `"！"` + `"！"` 三句。那两个孤立的 `"！"` 是纯噪声：
  // 它们各自拿到 0.12 的情绪分，还会**稀释按句平均的情绪强度**，
  // 把「这一轮到底有没有情绪」算低——情绪越激烈，平均分反而越低。
  //
  // 改用逐字符累积：遇到标点就结算，但只有「去掉标点后还有字」的片段
  // 才算一句，纯标点片段直接丢弃（不留进 buffer，否则会和下一句粘连）。
  const hasContent = (text: string): boolean =>
    text.replace(/[\p{P}\p{S}\s]+/gu, '').length > 0
  const out: string[] = []
  let buffer = ''
  for (const ch of raw) {
    buffer += ch
    if (!/[。！？!?；;\n]/u.test(ch)) continue
    if (hasContent(buffer)) {
      out.push(buffer.trim())
    } else {
      // 纯标点片段：**附加到前一句**而不是丢弃或独立成句。
      // 「真的吗？！」里的 `！` 属于前一句的语气，丢了会让情绪强度偏低，
      // 独立成句则会产生一个 0.12 分的噪声句。两种都错。
      // 没有前一句时（文本以标点开头）只能丢弃，因为没有可归属的对象。
      const last = out.length > 0 ? out[out.length - 1] : undefined
      if (last !== undefined) out[out.length - 1] = `${last}${buffer.trim()}`
    }
    buffer = ''
  }
  if (hasContent(buffer)) out.push(buffer.trim())
  return out
}
