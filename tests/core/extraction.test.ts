import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import {
  classifySentence, computeConfidence, computeEmotional, computeSalience,
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

test('computeSalience 落在 0..1', () => {
  const value = computeSalience('我们决定这个项目用 Qt5 开发', ['决定'], ['Qt5'])
  assert.ok(value >= 0 && value <= 1)
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

test('computeEmotional 落在 0..1', () => {
  const value = computeEmotional('非常非常非常崩溃！！！！')
  assert.ok(value >= 0 && value <= 1)
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
