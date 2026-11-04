import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import {
  classifySentence, computeConfidence, computeEmotional, computeSalience, turnEmotional,
  draftToCard, extractCards, extractMemoryCards, gateTurn, looksConflicting,
  textSimilarity, unionTags,
} from '../../src/core/extraction.ts'
import type { TurnInput } from '../../src/core/extraction.ts'

const config = DEFAULT_CONFIG

function makeInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    sessionId: 'sess-1',
    turn: 1,
    step: 1,
    seq: 10,
    userText: '我们决定这个项目用 Qt5，不要用 Qt6。',
    assistantText: '',
    domain: 'work',
    at: 1_700_000_000_000,
    ...overrides,
  }
}

test('gateTurn 空输入不通过', () => {
  const gate = gateTurn(makeInput({ userText: '嗯', assistantText: '' }), config)
  assert.equal(gate.pass, false)
})

test('gateTurn 命中信号词通过', () => {
  const gate = gateTurn(makeInput(), config)
  assert.equal(gate.pass, true)
  assert.ok(gate.signals.length > 0)
})

test('gateTurn 长用户消息加长助手回复通过', () => {
  const gate = gateTurn(makeInput({
    userText: '今天我们来讨论一下这个模块的整体架构设计思路和取舍',
    assistantText: '好的，我建议采用分层架构，数据面与行为面分离，适配层单独隔离，这样宿主升级时只需要改适配层即可，风险最低。',
  }), config)
  assert.equal(gate.pass, true)
})

test('classifySentence 识别承诺', () => {
  assert.equal(classifySentence('我答应你下周一给结论'), 'promise')
})

test('classifySentence 识别感受', () => {
  assert.equal(classifySentence('我感觉这个方案有点难受'), 'feeling')
})

test('classifySentence 识别经验', () => {
  assert.equal(classifySentence('这次的教训是以后要先写测试'), 'experience')
})

test('classifySentence 识别事实', () => {
  assert.equal(classifySentence('这个项目的结论是用 Qt5'), 'fact')
})

test('classifySentence 兜底为事件', () => {
  assert.equal(classifySentence('昨天服务器重启了一次'), 'event')
})

test('computeSalience 三个信息分项各自真的被算进去', () => {
  // 这条原来是 `assert.ok(value >= 0 && value <= 1)`——**无牙断言**。
  // `computeSalience` 出口夹紧，值域恒真；输入里明明有「决定」+「Qt5」，
  // 但断言不关心它们有没有被算进去。要守的是「长度 / 信号 / 实体三项
  // 真的各按 0.42 / 0.36 / 0.22 参与合成」。
  //
  // 实测（60 字以内 ⇒ lengthScore = 1）：
  //   无信号无实体 0.42、只信号 0.54、只实体 0.4933…、两者 0.6133…
  // 注意每个分项都先除以 3 封顶：1 个信号得 1/3，所以增量是 0.36/3 = 0.12，
  // 不是 0.36。第一版断言写 0.78 是**我把公式读错了**，实测立刻打回来。
  const long = '我们决定这个项目用 Qt5 而不是 Qt6 来开发'
  const base = computeSalience(long, [], [])
  assert.ok(Math.abs(base - 0.42) < 1e-9, `长度项 1 × 0.42，实际 ${base}`)
  const withSignal = computeSalience(long, ['决定'], [])
  assert.ok(
    Math.abs(withSignal - (0.42 + 0.36 / 3)) < 1e-9,
    `1 个信号 = 0.36 × (1/3)，实际 ${withSignal}`,
  )
  const withEntity = computeSalience(long, [], ['Qt5'])
  assert.ok(
    Math.abs(withEntity - (0.42 + 0.22 / 3)) < 1e-9,
    `1 个实体 = 0.22 × (1/3)，实际 ${withEntity}`,
  )
  const both = computeSalience(long, ['决定'], ['Qt5'])
  assert.ok(
    Math.abs(both - (0.42 + 0.36 / 3 + 0.22 / 3)) < 1e-9,
    `两项相加，实际 ${both}`,
  )
  // 信号/实体各封顶 3 个（`Math.min(1, n/3)`）：给 5 个不能比给 3 个更高。
  const threeSignals = computeSalience(long, ['a', 'b', 'c'], [])
  const fiveSignals = computeSalience(long, ['a', 'b', 'c', 'd', 'e'], [])
  assert.equal(fiveSignals, threeSignals, '信号项在 3 个处封顶')
})

test('computeSalience 长度项分四档（<8 / <20 / ≤80 / >80）', () => {
  // 长度项是唯一与信号、实体无关的分项，单测它才能证明「档位边界」真的存在。
  // 注意每个档位都是 lengthScore × 0.42，**不是 lengthScore 本身**：
  // 短句 0.15 × 0.42 = 0.063、8~19 字 0.5 × 0.42 = 0.21、
  // 20~80 字 1 × 0.42 = 0.42、>80 字 0.7 × 0.42 = 0.294。
  // （第一版直接拿档位值当期望，实测 0.063 vs 0.15 打回来——判据读错了公式。）
  assert.ok(Math.abs(computeSalience('好', [], []) - 0.15 * 0.42) < 1e-9, '<8 字：0.15 × 0.42')
  const tenChars = '这个项目用 Qt5 开发'
  assert.ok([...tenChars].length >= 8 && [...tenChars].length < 20, '前提：这句在 8~19 字之间')
  assert.ok(Math.abs(computeSalience(tenChars, [], []) - 0.5 * 0.42) < 1e-9, '8~19 字：0.5 × 0.42')
  assert.ok(Math.abs(computeSalience('这'.repeat(80), [], []) - 1 * 0.42) < 1e-9, '20~80 字：1 × 0.42')
  assert.ok(Math.abs(computeSalience('这'.repeat(81), [], []) - 0.7 * 0.42) < 1e-9, '>80 字：0.7 × 0.42')
})

test('computeSalience 短句显著性低', () => {
  const short = computeSalience('好', [], [])
  const long = computeSalience('我们决定这个项目用 Qt5 而不是 Qt6 来开发', ['决定'], ['Qt5'])
  assert.ok(short < long)
})

test('computeEmotional 强情绪高于中性', () => {
  const strong = computeEmotional('太崩溃了！！非常难受！')
  const neutral = computeEmotional('这个项目用 Qt5 开发')
  assert.ok(strong > neutral)
})

test('computeEmotional 三个信号项各自真的被算进去，且封顶 1', () => {
  // 这条原来是 `assert.ok(value >= 0 && value <= 1)`——**无牙断言**。
  // 用「非常非常非常崩溃！！！！」这么强的情绪句，只断言值域等于没用它。
  // 要守的是「强词 ×0.4 + 中词 ×0.18 + 标点 ×0.12，三者相加后封顶 1」。
  //
  // 实测：单个强词 0.4、单个感叹号 0.12、那句最强的 1（本来算出来是 1.76，被封顶）。
  assert.ok(Math.abs(computeEmotional('非常') - 0.4) < 1e-9, '一个强词 = 0.4')
  assert.ok(Math.abs(computeEmotional('！') - 0.12) < 1e-9, '一个标点 = 0.12')
  assert.equal(computeEmotional('这个项目用 Qt5 开发'), 0, '中性句必须精确为 0')
  // 封顶：三个强词本来算 1.2，必须夹到 1。
  assert.equal(computeEmotional('非常特别超级'), 1, '三个强词算出来 1.2，必须封顶 1')
  // 中词与强词不同档：各一个时强词更高。
  assert.ok(
    computeEmotional('非常') > computeEmotional('很'),
    '强词档（0.4）必须高于中词档（0.18）',
  )
  // 可重复计：两个强词高于一个（「特别特别开心」应当比「特别开心」更浓）。
  assert.ok(
    computeEmotional('非常非常') > computeEmotional('非常'),
    '同一个词出现两次必须更浓（`countKeywords` 是可重复计的）',
  )
})

test('computeConfidence 用户高于助手', () => {
  assert.ok(computeConfidence('这个项目用 Qt5', true) > computeConfidence('这个项目用 Qt5', false))
})

test('computeConfidence 含糊表述降置信', () => {
  assert.ok(computeConfidence('大概是 Qt5 吧', true) < computeConfidence('确定是 Qt5', true))
})

test('extractCards 无关闲聊不写卡', () => {
  const cards = extractCards(makeInput({ userText: '嗯', assistantText: '' }), config)
  assert.equal(cards.length, 0)
})

test('extractCards 有信号时产出卡片', () => {
  const cards = extractCards(makeInput(), config)
  assert.ok(cards.length > 0)
})

test('extractCards 不超过 maxCardsPerTurn', () => {
  const long = Array.from({ length: 20 }, (_, i) => `我们决定第 ${i} 项用 Qt5 开发 src/core/file${i}.ts。`).join('')
  const cards = extractCards(makeInput({ userText: long }), config)
  assert.ok(cards.length <= config.extraction.maxCardsPerTurn)
})

test('extractCards 按显著性降序', () => {
  const cards = extractCards(makeInput(), config)
  for (let i = 1; i < cards.length; i += 1) {
    assert.ok((cards[i - 1]?.salience ?? 0) >= (cards[i]?.salience ?? 0))
  }
})

test('extractCards 确定性：两次调用结果一致', () => {
  const first = extractCards(makeInput(), config).map((c) => c.text)
  const second = extractCards(makeInput(), config).map((c) => c.text)
  assert.deepEqual(first, second)
})

test('extractCards 助手回复默认纳入抽取', () => {
  const cards = extractCards(makeInput({
    userText: '这个模块怎么设计比较好呢请问',
    assistantText: '建议采用分层架构。数据面与行为面必须彻底分离，适配层单独隔离风险，这样宿主升级时只需要改适配层即可，风险最低，也最容易回滚。',
  }), config)
  assert.ok(cards.some((c) => c.source.eventType === 'assistant/message'))
})

test('draftToCard 补齐 id 与强度', () => {
  const drafts = extractCards(makeInput(), config)
  const draft = drafts[0]
  assert.ok(draft !== undefined)
  const card = draftToCard(draft, 1_700_000_000_000)
  assert.ok(card.id.length === 16)
  assert.ok(card.strength > 0)
  assert.equal(card.status, 'active')
  assert.equal(card.accessCount, 0)
})

test('draftToCard 幂等：同草稿同 id', () => {
  const drafts = extractCards(makeInput(), config)
  const draft = drafts[0]
  assert.ok(draft !== undefined)
  const a = draftToCard(draft, 1_700_000_000_000)
  const b = draftToCard(draft, 1_700_000_001_000)
  assert.equal(a.id, b.id)
})

test('draftToCard 承诺类默认钉住', () => {
  const drafts = extractCards(makeInput({ userText: '我答应你下周一一定给出结论和方案。' }), config)
  const promise = drafts.find((d) => d.kind === 'promise')
  assert.ok(promise !== undefined)
  const card = draftToCard(promise, 1_700_000_000_000)
  assert.equal(card.pinned, true)
})

test('extractMemoryCards 直接产出完整卡', () => {
  const cards = extractMemoryCards(makeInput(), config)
  assert.ok(cards.length > 0)
  assert.ok(cards.every((c) => c.id.length === 16))
})

test('textSimilarity 相同文本为 1', () => {
  assert.equal(textSimilarity('部署失败', '部署失败'), 1)
})

test('textSimilarity 无关文本为 0', () => {
  assert.equal(textSimilarity('苹果', '汽车'), 0)
})

test('looksConflicting 共享实体且低相似判定冲突', () => {
  const conflict = looksConflicting(
    { entities: ['Qt5'] }, { entities: ['Qt5'] }, 0.1, config.dedup.relatedSimilarity,
  )
  assert.equal(conflict, true)
})

test('looksConflicting 无共享实体不冲突', () => {
  assert.equal(looksConflicting({ entities: ['A'] }, { entities: ['B'] }, 0.1, 0.45), false)
})

test('unionTags 去重保序', () => {
  assert.deepEqual(unionTags(['a', 'b'], ['B', 'c']), ['a', 'b', 'c'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 缺陷二十八：情绪通道在抽取链路上被四道串联闸全部挡掉（起源 L3 / L11）
//
// 起源 L3（无编号·激素）：「激素是关键！！！大脑皮层只是记忆，激素控制情绪！！！」
// 起源 L11（无编号·细节会忘）：「大多数细节都会忘记，只会留下感受。」
// FR-C3（docs/1-需求规格.md:149）：感受列入永不归档类别。
//
// 三条约束共同要求「感受必须能进库」，而实测情绪句通过率只有 1/10，
// 且高情绪组通过率（17%）反而低于低情绪组（43%）——**反相关**。
// 根因不是一处判据错，是**四道串联闸各自独立地把情绪句挡在外面**：
//   ① gateTurn 的四个通道里没有情绪
//   ② consume 的「无信号+无实体+<40字」过滤
//   ③ minTextChars = 6 的长度闸
//   ④ computeSalience 的显著性只吃长度/信号/实体
// 只修任何一道，最终出卡仍然是 0——这是「串联判据必须一起看」的典型。
// ─────────────────────────────────────────────────────────────────────────────

/** 真实的情绪表达：短、无决策词、无比喻。这类句子在对话里极常见。 */
const FEELING_SENTENCES = [
  '今天真的很开心',
  '我有点难受',
  '太难了，快崩溃了',
  '这个结果让我很失望',
  '心里有点慌',
  '我今天特别开心，这个项目终于跑通了，感觉超级爽！！！',
  '有点烦',
]

test('情绪句必须能过门控（缺陷二十八·第一道闸）', () => {
  const threshold = config.extraction.emotionalGateThreshold
  for (const text of FEELING_SENTENCES) {
    const input = makeInput({ userText: text, assistantText: '' })
    const emotional = turnEmotional(input, config)
    // 前提：这些句子必须真的有情绪。没有这个前提，下面「能过门控」可能
    // 只是因为它们碰巧命中了别的通道，测试会绿在错误的原因上。
    assert.ok(
      emotional >= threshold,
      `前提：「${text}」应当被判定为有情绪，实际 turnEmotional=${emotional}`,
    )
    const gate = gateTurn(input, config)
    assert.equal(gate.pass, true, `情绪句「${text}」必须过门控（起源 L3 / L11）`)
  }
})

test('情绪句必须真的产出记忆卡（缺陷二十八·四道闸串联）', () => {
  // 这条守的是**整条链路**，不是任何单道闸。
  // 曾经四道闸各自都「合理」，合起来让情绪句一张卡都产不出来。
  const produced: string[] = []
  for (const text of FEELING_SENTENCES) {
    const cards = extractMemoryCards(makeInput({ userText: text, assistantText: '' }), config)
    if (cards.length > 0) produced.push(text)
  }
  assert.equal(
    produced.length, FEELING_SENTENCES.length,
    `情绪句必须全部产出卡片。只产出 ${produced.length}/${FEELING_SENTENCES.length}：`
    + `漏掉的是 ${JSON.stringify(FEELING_SENTENCES.filter((t) => !produced.includes(t)))}`,
  )
})

test('情绪强度与写入通过率不得反相关（缺陷二十八的核心判据）', () => {
  // 这是缺陷二十八最有牙的一条：它不检查任何单道闸，只检查
  // 「情绪越强，越容易留下来」这个**方向性**。
  //
  // 修复前实测：高情绪组 17% (1/6) vs 低情绪组 43% (3/7) —— 方向是反的。
  // 任何只修一道闸的补丁都无法让这条通过，因为剩下的闸会继续按
  // 「长度/信号词」排序，而情绪句在这两项上恰恰是弱项。
  const threshold = config.extraction.emotionalGateThreshold
  const rows = [...FEELING_SENTENCES, '我们决定用事件日志', '这个方案定了'].map((text) => ({
    text,
    emotional: turnEmotional(makeInput({ userText: text, assistantText: '' }), config),
    written: extractMemoryCards(makeInput({ userText: text, assistantText: '' }), config).length > 0,
  }))
  const high = rows.filter((row) => row.emotional >= threshold)
  const low = rows.filter((row) => row.emotional < threshold)
  // 前提：两组都必须非空，否则「高 ≥ 低」可能只是因为有一组是空的。
  assert.ok(high.length > 0, '前提：必须存在高情绪样本')
  assert.ok(low.length > 0, '前提：必须存在低情绪样本')
  const highRate = high.filter((row) => row.written).length / high.length
  const lowRate = low.filter((row) => row.written).length / low.length
  assert.ok(
    highRate >= lowRate,
    `情绪强度与通过率反相关：高情绪组 ${(highRate * 100).toFixed(0)}% < `
    + `低情绪组 ${(lowRate * 100).toFixed(0)}%。情绪越强反而越留不下来（起源 L3 / L11）`,
  )
})

test('短情绪句豁免长度闸，但真正的寒暄仍然被挡（配对反向对照）', () => {
  // 只测「情绪句能进来」是半个测试：把 minTextChars 直接改成 0 也能全绿，
  // 但那样「嗯」「好的」这些寒暄会全部涌进记忆库。
  // 必须有配对的反向对照，证明豁免是**只对情绪生效**的。
  const shortFeeling = extractMemoryCards(makeInput({ userText: '有点烦', assistantText: '' }), config)
  assert.ok(shortFeeling.length > 0, '3 字情绪句必须豁免长度闸（起源 L11）')

  for (const chatter of ['嗯', '好的', '收到了', '明白']) {
    const cards = extractMemoryCards(makeInput({ userText: chatter, assistantText: '' }), config)
    assert.equal(cards.length, 0, `寒暄「${chatter}」不得入库（长度闸仍须生效）`)
  }
})

test('信息量足够的决策句，显著性不会被情绪项改动（回归对照）', () => {
  // computeSalience 用 `max(信息项, 情绪项)` 而不是加权相加，就是为了
  // 让「加情绪通道」这件事**不改变原有分数**。这条守住那个决定。
  //
  // 注意不要用人为构造的高情绪值来测——真实决策句的情绪强度实测就是 0.00
  // （「我们决定这个项目用 Qt5 而不是 Qt6 来开发」emo=0.000），
  // 拿 0.9 去测会得到一个「情绪压过信息」的假失败，而那个场景在真实
  // 语料里不存在。判据必须由真实输入决定，不能由我编的数字决定。
  const cases: Array<[string, string[], string[]]> = [
    ['我们决定这个项目用 Qt5 而不是 Qt6 来开发', ['决定'], ['Qt5']],
    ['结论是回滚必须能一键完成', ['结论'], []],
    ['这个方案定了', ['方案'], []],
  ]
  for (const [sentence, signals, entities] of cases) {
    const emotional = computeEmotional(sentence, config)
    // 前提：这些句子确实没有情绪。有的话这条测的就不是「信息句」了。
    assert.equal(emotional, 0, `前提：「${sentence}」应当无情绪，实际 ${emotional}`)
    assert.equal(
      computeSalience(sentence, signals, entities, emotional),
      computeSalience(sentence, signals, entities, 0),
      `信息句的显著性不得因情绪项改变：「${sentence}」`,
    )
  }
})

test('情绪项只在信息项不足时才起作用（max 而非相加的证据）', () => {
  // 上面那条证明「情绪不抬高信息句」，这条证明另一半：
  // 「信息不足时情绪真的能把显著性抬过阈值」。
  // 两条合起来才说明 max 的两个分支都被走到了。
  const feeling = '我快崩溃了'
  const emotional = computeEmotional(feeling, config)
  const infoOnly = computeSalience(feeling, [], [], 0)
  const withEmotion = computeSalience(feeling, [], [], emotional)
  assert.ok(infoOnly < 0.25, `前提：纯信息项必须低于写入阈值 0.25，实际 ${infoOnly}`)
  assert.ok(
    withEmotion >= 0.25,
    `情绪项必须把短情绪句抬过阈值 0.25，实际 ${withEmotion}`,
  )
})
