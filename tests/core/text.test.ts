import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  coverage, estimateTokens, extractEntities, jaccard, matchSignals,
  normalizeText, splitSentences, tokenize, tokenSet, truncate,
} from '../../src/core/text.ts'

test('normalizeText 全角转半角并小写', () => {
  assert.equal(normalizeText('ＡＢＣ１２３'), 'abc123')
})

test('normalizeText 去标点并压缩空白', () => {
  assert.equal(normalizeText('你好，世界！  这是  测试。'), '你好 世界 这是 测试')
})

test('normalizeText 空串返回空串', () => {
  assert.equal(normalizeText(''), '')
})

test('tokenize 中文按二元组切分', () => {
  const tokens = tokenize(normalizeText('记忆系统'))
  assert.deepEqual(tokens, ['记忆', '忆系', '系统'])
})

test('tokenize 英文整词保留', () => {
  const tokens = tokenize(normalizeText('deploy the service'))
  assert.deepEqual(tokens, ['deploy', 'service'])
})

test('tokenize 单字中文保留', () => {
  assert.deepEqual(tokenize('猫'), ['猫'])
})

test('tokenSet 去重', () => {
  const set = tokenSet('记忆 记忆 系统')
  assert.equal(set.has('记忆'), true)
  assert.equal(set.size > 0, true)
})

test('jaccard 完全相同为 1', () => {
  const a = tokenSet('部署失败')
  assert.equal(jaccard(a, a), 1)
})

test('jaccard 无交集为 0', () => {
  assert.equal(jaccard(tokenSet('苹果'), tokenSet('汽车')), 0)
})

test('jaccard 空集合为 0', () => {
  assert.equal(jaccard(new Set(), new Set(['a'])), 0)
})

test('coverage 查询被完全覆盖为 1', () => {
  assert.equal(coverage(tokenSet('部署'), tokenSet('部署 失败 原因')), 1)
})

test('coverage 查询为空为 0', () => {
  assert.equal(coverage(new Set(), tokenSet('abc')), 0)
})

test('extractEntities 抽取文件路径', () => {
  const entities = extractEntities('修改 src/core/text.ts 这个文件')
  assert.ok(entities.some((e) => e.includes('src/core/text.ts')))
})

test('extractEntities 抽取 URL', () => {
  const entities = extractEntities('参考 https://example.com/doc 这里的说明')
  assert.ok(entities.some((e) => e.startsWith('https://example.com')))
})

test('extractEntities 抽取驼峰标识符', () => {
  const entities = extractEntities('调用 buildCardId 函数')
  assert.ok(entities.includes('buildCardId'))
})

test('extractEntities 抽取引号内专名', () => {
  const entities = extractEntities('我们把这个叫「焦点包」')
  assert.ok(entities.includes('焦点包'))
})

test('extractEntities 去重', () => {
  const entities = extractEntities('buildCardId 和 buildCardId 是同一个')
  assert.equal(entities.filter((e) => e === 'buildCardId').length, 1)
})

test('truncate 短文本原样返回', () => {
  assert.equal(truncate('abc', 10), 'abc')
})

test('truncate 超长补省略号', () => {
  assert.equal(truncate('abcdef', 4), 'abc…')
})

test('truncate 上限为 0 返回空串', () => {
  assert.equal(truncate('abc', 0), '')
})

test('estimateTokens 中文按字计', () => {
  assert.equal(estimateTokens('记忆系统'), 4)
})

test('estimateTokens 英文按四字符计', () => {
  assert.equal(estimateTokens('abcdefgh'), 2)
})

test('matchSignals 命中关键词', () => {
  const hits = matchSignals('我们决定用 Qt5', ['决定', '结论'])
  assert.deepEqual(hits, ['决定'])
})

test('matchSignals 未命中返回空数组', () => {
  assert.deepEqual(matchSignals('今天天气不错', ['决定']), [])
})

test('splitSentences 按中文句号切分', () => {
  const sentences = splitSentences('第一句。第二句！第三句？')
  assert.equal(sentences.length, 3)
})

test('splitSentences 过滤空白句', () => {
  assert.deepEqual(splitSentences('  。  '), ['。'])
})
