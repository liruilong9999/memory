/**
 * 摘要与蒸馏配置的校验单测（FR-D4 / 起源 L27 / L11）。
 *
 * 本文件的核心不是「这些字段存在」，而是**配置层不允许配出假压缩**：
 *
 * - `summaryTargetRatio >= 1` → 报错（否则允许产出不比原文短的「摘要」）
 * - 周摘要上限 > 日摘要上限 → 报错（否则层级越高反而越长）
 * - `summaryMinChildren < 2` → 报错（只有一个下级时是复制不是压缩）
 *
 * 这些校验比在实现里写一遍判断更硬：它让「假压缩」在**配置层面不可能存在**，
 * 而不是靠代码自觉。测试断言「恰好一条错误且提到该字段」，
 * 因为只断言 `ok === false` 会被任何别的分支蒙混过关。
 *
 * @module tests/core/config-summary.test
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, MEMORY_CONFIG_VERSION, mergeConfig, validateConfig } from '../../src/core/config.ts'
import type { MemoryConfig } from '../../src/core/config.ts'

/**
 * 造一份合法配置。
 *
 * @returns 完整配置副本。
 */
function base(): MemoryConfig {
  return mergeConfig(DEFAULT_CONFIG)
}

/**
 * 破坏单个字段后校验，断言恰好产生一条提到该字段的错误。
 *
 * @param patch - 部分配置。
 * @param field - 期望错误里提到的字段名。
 */
function expectOneError(patch: Parameters<typeof mergeConfig>[1], field: string): void {
  const result = validateConfig(mergeConfig(DEFAULT_CONFIG, patch))
  assert.equal(result.ok, false, `应当校验失败（${field}）`)
  assert.equal(result.errors.length, 1, `应恰好 1 条错误，实际：${result.errors.join(' | ')}`)
  assert.ok(
    result.errors[0]!.includes(field),
    `错误信息应提到 ${field}，实际：${result.errors[0]}`,
  )
}

describe('摘要配置的默认值与版本', () => {
  it('默认配置通过校验', () => {
    const result = validateConfig(base())
    assert.deepEqual(result.errors, [])
    assert.equal(result.ok, true)
  })

  it('configVersion 与常量一致（改默认配置必须同时递增两者）', () => {
    assert.equal(DEFAULT_CONFIG.configVersion, MEMORY_CONFIG_VERSION)
    assert.equal(MEMORY_CONFIG_VERSION, 3, '新增摘要与蒸馏参数后版本应为 3')
  })

  it('层级上限默认递增：日 > 周 > 月', () => {
    const policy = DEFAULT_CONFIG.consolidation
    assert.ok(
      policy.dailySummaryMaxChars > policy.weeklySummaryMaxChars,
      '日摘要上限应大于周摘要',
    )
    assert.ok(
      policy.weeklySummaryMaxChars > policy.monthlySummaryMaxChars,
      '周摘要上限应大于月摘要',
    )
  })

  it('summaryTargetRatio 默认严格小于 1（压缩必须真的压缩）', () => {
    assert.ok(DEFAULT_CONFIG.consolidation.summaryTargetRatio < 1)
    assert.ok(DEFAULT_CONFIG.consolidation.summaryTargetRatio > 0)
  })
})

describe('压缩比的配置层守门（不允许配出假压缩）', () => {
  it('summaryTargetRatio = 1 被拒绝（允许摘要与原文一样长）', () => {
    expectOneError({ consolidation: { summaryTargetRatio: 1 } }, 'summaryTargetRatio')
  })

  it('summaryTargetRatio > 1 被拒绝（允许摘要比原文更长）', () => {
    // 这里不断言「恰好一条」：`inUnit` 与「必须 < 1」两条校验都会命中，
    // 报两条是合理的。真正要证明的是「1.5 这个值一定被拒绝，且原因提到该字段」。
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { summaryTargetRatio: 1.5 } }))
    assert.equal(result.ok, false, '1.5 必须被拒绝')
    assert.ok(
      result.errors.some((error) => error.includes('summaryTargetRatio')),
      `错误信息应提到 summaryTargetRatio，实际：${result.errors.join(' | ')}`,
    )
  })

  it('summaryTargetRatio < 0 被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { summaryTargetRatio: -0.1 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('summaryTargetRatio')))
  })

  it('周摘要上限大于日摘要上限被拒绝（层级越高反而越长）', () => {
    expectOneError(
      { consolidation: { weeklySummaryMaxChars: 200, dailySummaryMaxChars: 180 } },
      'weeklySummaryMaxChars',
    )
  })

  it('月摘要上限大于周摘要上限被拒绝', () => {
    expectOneError(
      { consolidation: { monthlySummaryMaxChars: 150, weeklySummaryMaxChars: 140 } },
      'monthlySummaryMaxChars',
    )
  })

  it('summaryMinChildren = 1 被拒绝（只有一个下级时是复制不是压缩）', () => {
    expectOneError({ consolidation: { summaryMinChildren: 1 } }, 'summaryMinChildren')
  })

  it('summaryMinChildren = 0 被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { summaryMinChildren: 0 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('summaryMinChildren')))
  })

  it('摘要字符上限为 0 被拒绝（等于悄悄关掉摘要）', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { dailySummaryMaxChars: 0 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('dailySummaryMaxChars')))
  })

  it('summaryMinSourceChars 为 0 被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { summaryMinSourceChars: 0 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('summaryMinSourceChars')))
  })

  it('maxSummariesPerRun 为负被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { maxSummariesPerRun: -1 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('maxSummariesPerRun')))
  })
})

describe('蒸馏配置的守门', () => {
  it('distillMinEmotional 必须在 0..1', () => {
    const high = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { distillMinEmotional: 1.5 } }))
    assert.equal(high.ok, false)
    assert.ok(high.errors.some((error) => error.includes('distillMinEmotional')))
  })

  it('distillEdgeWeight 必须在 0..1', () => {
    const bad = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { distillEdgeWeight: -0.5 } }))
    assert.equal(bad.ok, false)
    assert.ok(bad.errors.some((error) => error.includes('distillEdgeWeight')))
  })

  it('distillMinRecurrence 小于 1 被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { distillMinRecurrence: 0 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('distillMinRecurrence')))
  })

  it('distillThemeMinChars 小于 1 被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { distillThemeMinChars: 0 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('distillThemeMinChars')))
  })

  it('distillMaxChars 小于 1 被拒绝', () => {
    const result = validateConfig(mergeConfig(DEFAULT_CONFIG, { consolidation: { distillMaxChars: 0 } }))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.includes('distillMaxChars')))
  })
})

describe('mergeConfig 对新增字段的深合并', () => {
  it('未覆盖时保留默认值', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {})
    assert.equal(merged.consolidation.summaryEnabled, DEFAULT_CONFIG.consolidation.summaryEnabled)
    assert.equal(merged.consolidation.distillMinEmotional, DEFAULT_CONFIG.consolidation.distillMinEmotional)
  })

  it('覆盖单个字段不影响同节其它字段', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { consolidation: { summaryEnabled: false } })
    assert.equal(merged.consolidation.summaryEnabled, false)
    assert.equal(
      merged.consolidation.dailySummaryMaxChars,
      DEFAULT_CONFIG.consolidation.dailySummaryMaxChars,
      '同节其它字段应保持默认值',
    )
  })

  it('合并结果不与 DEFAULT_CONFIG 共享引用（避免改一处污染全局）', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {})
    assert.notEqual(merged.consolidation, DEFAULT_CONFIG.consolidation)
    // 改合并结果不该影响默认配置。
    const before = DEFAULT_CONFIG.consolidation.summaryEnabled
    merged.consolidation.summaryEnabled = !before
    assert.equal(DEFAULT_CONFIG.consolidation.summaryEnabled, before, '默认配置必须未被污染')
  })
})
