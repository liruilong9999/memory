import { describe, test } from 'node:test'
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

describe('extractEntities 抽取裸专有名词（补齐图谱连边的输入）', () => {
  // 这一组守的是一个真实缺陷：原先只认文件路径 / URL / 驼峰标识符 / 引号专名
  // 四类，中文对话里最常出现的项目名与技术名（Cordis / Redis / Vue3 / Qt5）
  // 全部抽不出来。实测 20 轮语料里 Cordis 出现 8 句、抽出 0 句。
  //
  // 后果不是「少抽几个词」，而是 same-entity 边几乎产不出来 ⇒ 图谱稀疏
  // ⇒ 扩散激活没有边可走 ⇒ 「突触效果」在真实中文数据上近乎不可见。
  test('抽出中文句子里嵌入的拉丁专名（Cordis / Redis / Vue3 / Qt5 / Vite）', () => {
    const cases: [string, string][] = [
      ['决定把 Cordis 版本升到 4', 'Cordis'],
      ['方案是用 Redis 做缓存，结论已定', 'Redis'],
      ['决定前端用 Vue3，Vite 构建', 'Vue3'],
      ['决定用 Qt5 写客户端，方案已定', 'Qt5'],
    ]
    for (const [text, expected] of cases) {
      assert.ok(
        extractEntities(text).includes(expected),
        `${expected} 必须被抽出，否则它所在的卡连不上任何同类卡：${text}`,
      )
    }
  })

  test('英文句首的常用词不得被当成专名（误抽会连出假边）', () => {
    // 反向风险：首字母大写的判据会把 The / This / When 全抽出来。
    // 假边比没有边更糟——图谱是用来溯源的，假边会让溯源指向错的地方。
    const sentences = [
      'The build failed because the cache was stale',
      'This approach works but that one does not',
      'When you deploy, remember to bump the version',
    ]
    for (const text of sentences) {
      const entities = extractEntities(text)
      for (const word of ['The', 'This', 'When', 'But', 'After']) {
        assert.ok(!entities.includes(word), `${word} 是常用词，不该被当专名抽出：${text}`)
      }
    }
    // 正对照：同一句里真正的专名必须仍然被抽出——否则上面的断言可以靠
    // 「一个都不抽」通过，那就变成了空绿。
    assert.ok(
      extractEntities('After the migration, Redis should be restarted').includes('Redis'),
      '排除常用词不能连真专名一起排除',
    )
  })

  test('全大写通用缩写不抽（实测加进去精确率下降、召回率不涨）', () => {
    // API / HTTP 在任何话题里都出现，没有区分力，抽出来只会乱连边。
    // 定标实测：加入全大写规则后，连边精确率 92% → 89%，召回率不变。
    const entities = extractEntities('架构上 Cordis 和 Vue3 之间走 HTTP 约定，用 API 暴露')
    assert.ok(!entities.includes('HTTP'), 'HTTP 是通用缩写，不该当实体')
    assert.ok(!entities.includes('API'), 'API 是通用缩写，不该当实体')
    assert.ok(entities.includes('Cordis'), '同一句里的真专名必须仍然抽出')
  })

  test('裸专名让「共享项目名」的两张卡真的连得上（端到端）', () => {
    // 只断言「抽出了 Cordis」不够——要断言它**真的连出了边**。
    // 抽出来了但没连边，图谱一样是空的，而单看抽取结果会以为已经修好。
    const a = extractEntities('决定把 Cordis 版本升到 4')
    const b = extractEntities('结论是 Cordis 的 bundle patch 要重写')
    const shared = a.filter((x) => b.includes(x))
    assert.deepEqual(shared, ['Cordis'], '两张卡必须共享同一个实体锚点')
  })
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

describe('extractEntities 中文语料下的锚点（图谱连边的输入）', () => {
  // 这一组守的是「中文场景下图谱能不能连起来」。
  //
  // 原实现五条规则全部抽不出下列任何一种形态，而它们恰恰是本仓库
  // 中文文档里最高频的锚点。后果不是「少抽几个词」，而是
  // same-entity 边恒为空 ⇒ 图谱恒为空 ⇒ 扩散激活没有边可走
  // ⇒ 需求规格 §7.7 的 FR-G1「突触效果」在真实数据上永远不可见。
  //
  // 最危险的一条是中文路径被**截断**：截断会产生假锚点，
  // 让不同文件错误地共享同一个实体键，比抽不出更容易被误信。

  test('中文文件名路径不被截断（截断会造出假锚点）', () => {
    const entities = extractEntities('见 docs/1-需求规格.md 的第 7 节')
    assert.ok(
      entities.includes('docs/1-需求规格.md'),
      `必须抽出完整路径，实际得到 ${JSON.stringify(entities)}`,
    )
    // 反向断言：绝不能留下被截断的残片。只断言 includes 完整路径不够——
    // 截断残片可以同时存在，那样假锚点照样会进图谱。
    assert.ok(
      !entities.some((e) => e === 'docs/1-'),
      `不能出现截断残片，实际得到 ${JSON.stringify(entities)}`,
    )
  })

  test('不同中文文件名不共享实体键（截断会让它们撞在一起）', () => {
    const a = extractEntities('见 docs/1-需求规格.md')
    const b = extractEntities('见 docs/1-架构设计.md')
    assert.notDeepEqual(a, b, '两个不同文件必须抽出不同的实体')
  })

  test('小写连字符项目名能被抽出', () => {
    assert.ok(extractEntities('项目 dsh-memory 是插件').includes('dsh-memory'))
  })

  test('需求编号能被抽出', () => {
    const entities = extractEntities('FR-G1 要求扩散激活，对应 ST-1 确定性')
    assert.ok(entities.includes('FR-G1'), `实际 ${JSON.stringify(entities)}`)
    assert.ok(entities.includes('ST-1'), `实际 ${JSON.stringify(entities)}`)
  })

  test('无引号纯中文专名仍然抽不出（已知能力边界，不是缺陷）', () => {
    // 这条测试的作用是**把边界写成契约**，而不是假装它已解决。
    // 零依赖做中文专名抽取需要名词边界知识（分词词典），
    // 引入词典会破坏 ST-1 确定性与 NFR-1 零依赖。
    // 详见 docs/7 缺陷二十三。
    assert.deepEqual(extractEntities('夜整理会在凌晨三点自动跑一次'), [])
  })
})
