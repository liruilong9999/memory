/**
 * 配置层单元测试。
 *
 * 覆盖三件事：
 * 1. `mergeConfig` 的深合并与数组整体替换语义（宿主 patch 是整块替换，这一层必须补齐）；
 * 2. 合并结果与 `DEFAULT_CONFIG` **不共享数组引用**（否则一句 push 就污染全局默认值）；
 * 3. `validateConfig` 的每条校验规则。
 *
 * 对应需求：P8（参数可配、不写死）、C8（宿主变化只改适配层）。
 *
 * @module tests/core/config
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, MEMORY_CONFIG_VERSION, mergeConfig, validateConfig } from '../../src/core/config.ts'

describe('DEFAULT_CONFIG', () => {
  it('configVersion 与常量一致', () => {
    // 两者不一致时，落盘配置的版本号会与实际 schema 脱节，迁移逻辑必然出错。
    assert.equal(DEFAULT_CONFIG.configVersion, MEMORY_CONFIG_VERSION)
  })

  it('所有阈值都是有限数', () => {
    const numbers: Array<[string, number]> = [
      ['recall.absoluteThreshold', DEFAULT_CONFIG.recall.absoluteThreshold],
      ['recall.relativeThreshold', DEFAULT_CONFIG.recall.relativeThreshold],
      ['recall.maxCards', DEFAULT_CONFIG.recall.maxCards],
      ['recall.minCards', DEFAULT_CONFIG.recall.minCards],
      ['recall.tokenBudget', DEFAULT_CONFIG.recall.tokenBudget],
      ['recall.maxCardChars', DEFAULT_CONFIG.recall.maxCardChars],
      ['recall.overheadTokens', DEFAULT_CONFIG.recall.overheadTokens],
      ['recall.candidateLimit', DEFAULT_CONFIG.recall.candidateLimit],
      ['reminder.pollMs', DEFAULT_CONFIG.reminder.pollMs],
    ]
    for (const [name, value] of numbers) {
      assert.ok(Number.isFinite(value), `${name} 必须是有限数，实际 ${value}`)
    }
  })

  it('默认配置本身通过校验', () => {
    const result = validateConfig(DEFAULT_CONFIG)
    assert.equal(result.ok, true, `默认配置应合法，实际错误：${result.errors.join('；')}`)
  })
})

describe('mergeConfig 的深合并', () => {
  it('只覆盖指定字段，其余保持默认', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { recall: { maxCards: 3 } })
    assert.equal(merged.recall.maxCards, 3)
    // 同层其它字段必须保留：宿主 patch 是整块替换，这里若不补齐就会丢默认值。
    assert.equal(merged.recall.tokenBudget, DEFAULT_CONFIG.recall.tokenBudget)
    assert.equal(merged.recall.absoluteThreshold, DEFAULT_CONFIG.recall.absoluteThreshold)
  })

  it('跨层字段互不影响', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { storage: { dataDir: '/tmp/x' } })
    assert.equal(merged.storage.dataDir, '/tmp/x')
    assert.equal(merged.recall.maxCards, DEFAULT_CONFIG.recall.maxCards)
    assert.equal(merged.reminder.pollMs, DEFAULT_CONFIG.reminder.pollMs)
  })

  it('空覆盖等价于默认值', () => {
    const merged = mergeConfig(DEFAULT_CONFIG)
    assert.deepEqual(merged, DEFAULT_CONFIG)
  })

  it('不修改入参', () => {
    const base = mergeConfig(DEFAULT_CONFIG)
    const before = JSON.stringify(base)
    mergeConfig(base, { recall: { maxCards: 1 } })
    assert.equal(JSON.stringify(base), before, 'mergeConfig 不应修改 base')
  })
})

describe('mergeConfig 的数组语义', () => {
  it('覆盖数组时整体替换而非追加', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      extraction: { signalKeywords: ['自定义'] },
    })
    assert.deepEqual(merged.extraction.signalKeywords, ['自定义'])
  })

  it('未覆盖的数组不与 DEFAULT_CONFIG 共享引用', () => {
    // 这是真实缺陷的回归测试：共享引用时，任意调用方 push 一下就会污染
    // 全局 DEFAULT_CONFIG，后续所有实例（含其它测试）都会看到被改过的默认值。
    const merged = mergeConfig(DEFAULT_CONFIG)
    const pairs: Array<[string, unknown[], unknown[]]> = [
      ['forgetting.neverArchiveKinds', merged.forgetting.neverArchiveKinds, DEFAULT_CONFIG.forgetting.neverArchiveKinds],
      ['extraction.domains', merged.extraction.domains, DEFAULT_CONFIG.extraction.domains],
      ['extraction.signalKeywords', merged.extraction.signalKeywords, DEFAULT_CONFIG.extraction.signalKeywords],
      ['extraction.dueKeywords', merged.extraction.dueKeywords, DEFAULT_CONFIG.extraction.dueKeywords],
    ]
    for (const [name, actual, original] of pairs) {
      assert.notEqual(actual, original, `${name} 不应与 DEFAULT_CONFIG 共享引用`)
      assert.deepEqual(actual, original, `${name} 内容应与默认值相同`)
    }
  })

  it('污染合并结果不影响默认配置', () => {
    const merged = mergeConfig(DEFAULT_CONFIG)
    const originalLength = DEFAULT_CONFIG.extraction.signalKeywords.length
    merged.extraction.signalKeywords.push('被污染的词')
    assert.equal(
      DEFAULT_CONFIG.extraction.signalKeywords.length,
      originalLength,
      'push 合并结果不应改变 DEFAULT_CONFIG',
    )
  })
})

describe('validateConfig', () => {
  /** 造一份合法配置，供各用例按需破坏单个字段。 */
  function base(): typeof DEFAULT_CONFIG {
    return mergeConfig(DEFAULT_CONFIG)
  }

  it('合法配置返回 ok', () => {
    assert.equal(validateConfig(base()).ok, true)
  })

  it('阈值超出 [0,1] 时报错', () => {
    const config = base()
    config.recall.absoluteThreshold = 1.5
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('absoluteThreshold')))
  })

  it('负阈值报错', () => {
    const config = base()
    config.recall.relativeThreshold = -0.1
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('relativeThreshold')))
  })

  it('maxCards 为 0 时报错', () => {
    const config = base()
    config.recall.maxCards = 0
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('maxCards')))
  })

  it('minCards 大于 maxCards 时报错', () => {
    const config = base()
    config.recall.minCards = config.recall.maxCards + 1
    const result = validateConfig(config)
    assert.equal(result.ok, false)
  })

  it('tokenBudget 为 0 时报错', () => {
    const config = base()
    config.recall.tokenBudget = 0
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('tokenBudget')))
  })

  it('maxArchiveRatio 大于 1 时报错', () => {
    const config = base()
    config.consolidation.maxArchiveRatio = 1.2
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('maxArchiveRatio')))
  })

  it('dailyAt 格式错误时报错', () => {
    const config = base()
    config.consolidation.dailyAt = '3:30'
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('dailyAt')))
  })

  it('reminder.pollMs 过小时报错', () => {
    const config = base()
    config.reminder.pollMs = 100
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('pollMs')))
  })

  it('多个错误会全部收集，不是遇错即返回', () => {
    const config = base()
    config.recall.absoluteThreshold = 2
    config.consolidation.dailyAt = 'bad'
    config.reminder.pollMs = 0
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.length >= 3, `应收集全部错误，实际 ${result.errors.length} 条`)
  })
})
/**
 * 此前零测试的校验分支（补齐 docs/6 P0-3 缺口）。
 *
 * 这些分支在 `validateConfig` 里真实存在，但没有任何测试触发过。零测试的
 * 校验等于**装饰**：它写在代码里让人以为有防线，实际拦不拦得住没人知道。
 * 更糟的是它给了错误的安全感——看到 `validateConfig` 就以为配置一定被查过。
 *
 * ## 为什么断言「恰好一条错误」而不是「有错误」
 *
 * 只断言 `ok === false` 的话，**任何一个别的校验分支报错也能让它变绿**——
 * 这条测试就绿在错误的原因上，等于没测。这是本仓库反复出现的「靠运气绿」。
 * 断言「恰好 1 条且提到该字段」能证明：**是我要测的那条分支在报错**。
 */
describe('validateConfig 未覆盖分支', () => {
  /** 造一份合法配置，供各用例按需破坏单个字段。 */
  function base(): typeof DEFAULT_CONFIG {
    return mergeConfig(DEFAULT_CONFIG)
  }

  /**
   * 破坏单个字段后校验，断言**恰好**产生一条提到该字段的错误。
   *
   * @param patch - 破坏配置的写操作。
   * @param field - 期望错误信息里出现的字段名。
   */
  function expectSingleError(patch: (config: typeof DEFAULT_CONFIG) => void, field: string): void {
    const config = base()
    patch(config)
    const result = validateConfig(config)
    assert.equal(result.ok, false, `期望校验失败，实际通过（字段 ${field}）`)
    assert.equal(
      result.errors.length, 1,
      `期望恰好 1 条错误（证明是 ${field} 这条分支报的），实际 ${result.errors.length} 条：${result.errors.join(' / ')}`,
    )
    assert.ok(
      result.errors[0]!.includes(field),
      `错误信息应提到 ${field}，实际：${result.errors[0]}`,
    )
  }

  /**
   * 破坏单个字段后校验，断言**通过**（边界值合法的反向验证）。
   *
   * @param patch - 修改配置的写操作。
   */
  function expectOk(patch: (config: typeof DEFAULT_CONFIG) => void): void {
    const config = base()
    patch(config)
    const result = validateConfig(config)
    assert.equal(result.ok, true, `期望通过，实际错误：${result.errors.join(' / ')}`)
  }

  it('candidateLimit 小于 maxCards 时报错', () => {
    // 候选池比卡片上限还小，等于「想选 7 张但只看得到 3 张」，
    // 阈值再宽松也选不满——这是配置自相矛盾，不是性能问题。
    expectSingleError((c) => { c.recall.candidateLimit = c.recall.maxCards - 1 }, 'candidateLimit')
  })

  it('candidateLimit 等于 maxCards 时通过（边界合法）', () => {
    expectOk((c) => { c.recall.candidateLimit = c.recall.maxCards })
  })

  it('halfLifeMs 为 0 时报错', () => {
    // 半衰期为 0 意味着「一写入就死」，任何卡都召不回来。
    expectSingleError((c) => { c.forgetting.halfLifeMs = 0 }, 'halfLifeMs')
  })

  it('halfLifeMs 为负数时报错', () => {
    expectSingleError((c) => { c.forgetting.halfLifeMs = -1 }, 'halfLifeMs')
  })

  it('relatedSimilarity 大于 duplicateSimilarity 时报错', () => {
    // 两个阈值方向必须一致：重复判定比相关判定更严格。
    // 反过来写会让「相关但不算重复」这个区间消失，去重直接失效。
    expectSingleError((c) => {
      c.dedup.relatedSimilarity = 0.9
      c.dedup.duplicateSimilarity = 0.5
    }, 'relatedSimilarity')
  })

  it('relatedSimilarity 等于 duplicateSimilarity 时通过', () => {
    expectOk((c) => {
      c.dedup.relatedSimilarity = 0.8
      c.dedup.duplicateSimilarity = 0.8
    })
  })

  it('extraction.domains 为空时报错', () => {
    // 空域列表会让写入路径没有任何域可归属（起源 L13·三模块按域划分）。
    expectSingleError((c) => { c.extraction.domains = [] }, 'domains')
  })

  it('journalSegmentBytes 小于 4096 时报错', () => {
    expectSingleError((c) => { c.storage.journalSegmentBytes = 4096 - 1 }, 'journalSegmentBytes')
  })

  it('journalSegmentBytes 为小数时报错（必须整数）', () => {
    expectSingleError((c) => { c.storage.journalSegmentBytes = 8192.5 }, 'journalSegmentBytes')
  })

  it('journalSegmentBytes 等于 4096 时通过（边界合法）', () => {
    expectOk((c) => { c.storage.journalSegmentBytes = 4096 })
  })

  it('正向权重之和为 0 时报错', () => {
    // 归一化分母为 0 会让所有分数变成 NaN 或 Infinity。
    // 注意 conflict 不在求和里：它是惩罚项，不参与正向归一化。
    expectSingleError((c) => {
      c.weights.semantic = 0
      c.weights.importance = 0
      c.weights.recency = 0
      c.weights.goal = 0
      c.weights.confidence = 0
    }, '正向权重')
  })

  it('conflict 权重为 0 不触发「正向权重之和」报错', () => {
    // 反向验证：证明求和确实排除了 conflict。
    // 若实现里误把 conflict 计入，这条会红。
    expectOk((c) => { c.weights.conflict = 0 })
  })

  it('权重为 NaN 时报错（有限数检查）', () => {
    expectSingleError((c) => { c.weights.semantic = Number.NaN }, 'weights.semantic')
  })

  it('权重为 Infinity 时报错', () => {
    expectSingleError((c) => { c.weights.recency = Number.POSITIVE_INFINITY }, 'weights.recency')
  })
})

/**
 * `spread.seedRatio` 的校验。
 *
 * 这个参数是修一个真实缺陷时引入的：种子判据原本用 `absoluteThreshold`，
 * 与加分护栏的门槛恰好相等，导致**扩散在数学上恒为空**，而 31 条单测全绿。
 * 所以这条校验不是形式化的范围检查，它守的是「扩散不会静默失效」。
 *
 * 两端都会退化，且退化后**看不出异常**：
 * - `>= 1`：没有卡够格当种子 → 无激活源。
 * - `<= 0`：所有卡都是种子 → 无受益者。
 */
describe('validateConfig 的 spread.seedRatio', () => {
  function base(): typeof DEFAULT_CONFIG {
    return mergeConfig(DEFAULT_CONFIG)
  }

  it('默认配置的 seedRatio 在开区间 (0,1) 内', () => {
    const r = validateConfig(base())
    assert.equal(r.ok, true, `默认配置必须合法：${r.errors.join(' / ')}`)
    assert.ok(
      DEFAULT_CONFIG.spread.seedRatio > 0 && DEFAULT_CONFIG.spread.seedRatio < 1,
      `默认 seedRatio 必须在 (0,1) 内，实际 ${DEFAULT_CONFIG.spread.seedRatio}`,
    )
  })

  it('seedRatio = 1 时报错（没有卡够格当种子）', () => {
    const config = base()
    config.spread.seedRatio = 1
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(
      result.errors.some((e) => e.includes('seedRatio')),
      `错误必须提到 seedRatio，实际：${result.errors.join(' / ')}`,
    )
  })

  it('seedRatio > 1 时报错', () => {
    const config = base()
    config.spread.seedRatio = 1.5
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('seedRatio')))
  })

  it('seedRatio = 0 时报错（所有卡都是种子）', () => {
    const config = base()
    config.spread.seedRatio = 0
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('seedRatio')))
  })

  it('seedRatio 为负数时报错', () => {
    const config = base()
    config.spread.seedRatio = -0.5
    const result = validateConfig(config)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => e.includes('seedRatio')))
  })
})
