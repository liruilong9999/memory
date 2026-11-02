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
