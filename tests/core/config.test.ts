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
import { EDGE_WEIGHT_STEP } from '../../src/core/graph.ts'
import { decayEdges, reinforceEdges } from '../../src/core/spread.ts'
import { makeEdge } from '../../src/core/graph.ts'

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

/**
 * 旧版 `spread.enabled`（布尔）到 `spread.mode`（三态）的迁移。
 *
 * 为什么这组测试必须有：配置版本 5 把布尔开关换成三态，若只是加新字段，
 * 旧配置 `{ spread: { enabled: true } }` 会**静默降级**成默认的 `'shadow'`——
 * 用户明确要求「打开扩散」，系统回答「好的，我不改排序」。
 * 不报错、不告警、行为与意图相反，事后无从发现。
 *
 * 这组测试守的是「旧配置的意图被如实执行」，不是「旧字段还能被读到」。
 */
describe('mergeConfig 的 spread.enabled 迁移', () => {
  it('enabled: true 迁移成 on（旧版行为是真实参与排序）', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { enabled: true } } as never)
    assert.equal(merged.spread.mode, 'on', 'enabled=true 必须迁移成 on，不能降级成 shadow')
  })

  it('enabled: false 迁移成 off（旧版行为是完全不计算）', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { enabled: false } } as never)
    assert.equal(merged.spread.mode, 'off', 'enabled=false 必须迁移成 off')
  })

  it('迁移后不留 enabled 字段（已无读者，留着会误导）', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { enabled: true } } as never)
    assert.equal(
      (merged.spread as unknown as Record<string, unknown>).enabled,
      undefined,
      'enabled 已无任何读者，不能留在合并结果里',
    )
    // 反向确认：正常的 spread 字段必须都在，不能因为删 enabled 把别的删掉。
    for (const key of ['mode', 'hopDecay', 'maxHops', 'maxBoost', 'seedRatio', 'maxAffected'] as const) {
      assert.ok(key in merged.spread, `${key} 必须保留`)
    }
  })

  it('显式写 mode 时以 mode 为准，旧字段不覆盖它', () => {
    // 两个都写是用户自己矛盾。不替他猜，但也不能让旧字段赢——
    // 新字段是更具体的那个，且旧字段只用来补空缺。
    const merged = mergeConfig(DEFAULT_CONFIG, {
      spread: { enabled: true, mode: 'off' },
    } as never)
    assert.equal(merged.spread.mode, 'off', '显式 mode 必须优先于旧 enabled')
  })

  it('既没写 mode 也没写 enabled 时保持默认 shadow', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { maxBoost: 0.2 } })
    assert.equal(merged.spread.mode, 'shadow', '只改其它字段时 mode 必须保持默认值')
  })

  it('enabled 不是布尔值时忽略它（不猜用户意图）', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { enabled: 'yes' } } as never)
    assert.equal(merged.spread.mode, 'shadow', '非布尔的 enabled 无法解释，必须退回默认值')
  })

  it('迁移后的配置能通过校验（不能产出一个非法配置）', () => {
    for (const enabled of [true, false]) {
      const merged = mergeConfig(DEFAULT_CONFIG, { spread: { enabled } } as never)
      const validation = validateConfig(merged)
      assert.equal(validation.ok, true, `enabled=${enabled} 迁移后必须仍是合法配置：${validation.errors.join('; ')}`)
    }
  })

  it('写了非法 mode 时必须原样透传，绝不静默退回默认值', () => {
    // 真实来路：YAML 1.1 把无引号的 `mode: on` 解析成布尔 `true`。
    // 用户写的是「打开扩散」，意图明确。
    //
    // 曾经这里退回 fallback ⇒ mode 变成 'shadow'：**不报错、不崩溃、
    // 测试全绿**，用户以为开了扩散，实际跑的是影子模式。
    // 实测确认过这条路径：mergeConfig 后 mode === 'shadow'，validateConfig.ok === true。
    // 静默降级比加载期崩溃更坏——崩溃会让人立刻改，降级会让人一直以为自己开了。
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { mode: true } } as never)
    assert.notEqual(
      merged.spread.mode, 'shadow',
      '非法 mode 退回默认值 = 静默降级，用户以为开了扩散而实际没有',
    )
    assert.equal(merged.spread.mode as unknown, true, '非法值必须原样透传，交给校验层拒绝')
  })

  it('透传的非法 mode 会被 validateConfig 抓住（透传必须配一条能报错的闸）', () => {
    // 上一条只保证「不静默降级」。若校验层也放过它，那就成了「不降级但也不报错」，
    // 等于把非法值带进打分逻辑。这条与上一条配对，两头堵死。
    const merged = mergeConfig(DEFAULT_CONFIG, { spread: { mode: true } } as never)
    const validation = validateConfig(merged)
    assert.equal(validation.ok, false, '非法 mode 必须让校验失败')
    assert.ok(
      validation.errors.some((line) => line.includes('spread.mode')),
      `报错必须指向 spread.mode，实际：${validation.errors.join('; ')}`,
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

/**
 * 可塑性未接线：打开它必须**加载期失败**，而不是静默空转（缺陷三十三）。
 *
 * 为什么这组测试存在：`plasticityEnabled` 的字段注释写着「关掉时边权停在
 * 建立时的初始值」，这句话暗示「打开就会变化」。实测打开与关闭各跑 10 夜
 * 整理，边权与边数**逐位相同**——它是个空操作。
 *
 * 配置项的名字就是承诺。静默接受一个打开了也没用的开关，比拒绝它更坏：
 * 它会让人以为突触学习已经生效，从而永远不去查它从未生效。
 */
describe('可塑性未接线：打开必须报错（缺陷三十三）', () => {
  /** 造一份合法配置，供各用例按需破坏单个字段。 */
  function base(): typeof DEFAULT_CONFIG {
    return mergeConfig(DEFAULT_CONFIG)
  }

  it('plasticityEnabled=true 必须让校验失败，且报错指向这个字段', () => {
    const config = base()
    config.spread.plasticityEnabled = true
    const result = validateConfig(config)
    assert.equal(result.ok, false, '打开未接线的能力必须失败，不能静默通过')
    assert.ok(
      result.errors.some((e) => e.includes('spread.plasticityEnabled')),
      `报错必须指向 spread.plasticityEnabled，实际：${result.errors.join('; ')}`,
    )
  })

  it('报错必须说清「没有效果」而不是只说「非法」（否则用户会以为是取值范围问题）', () => {
    const config = base()
    config.spread.plasticityEnabled = true
    const result = validateConfig(config)
    const line = result.errors.find((e) => e.includes('plasticityEnabled')) ?? ''
    assert.ok(
      line.includes('未接线') || line.includes('不会产生任何效果'),
      `报错必须说明「打开也没效果」，否则用户会去调参数。实际：${line}`,
    )
  })

  it('默认配置必须能通过校验（不能把出厂配置判成非法）', () => {
    const result = validateConfig(DEFAULT_CONFIG)
    assert.equal(result.ok, true, `出厂配置必须合法：${result.errors.join('; ')}`)
    assert.equal(DEFAULT_CONFIG.spread.plasticityEnabled, false, '可塑性默认必须关闭')
  })

  it('可塑性参数**无条件**校验，不再挂在开关下面', () => {
    // 这条守的是一个具体的坑：这段校验以前包在 `if (sp.plasticityEnabled)` 里，
    // 理由是「关着的时候配错值不该拦住整个配置」。那个理由本身没错，但开关
    // 一旦必须为 false，整块校验就变成了**不可达代码**——
    // 「校验写了」和「校验会执行」成了两件事。
    const bad = [
      { field: 'reinforceDelta', value: 0 },
      { field: 'maxEdgeWeight', value: 1.5 },
      { field: 'decayFactor', value: 1.5 },
      { field: 'pruneThreshold', value: 2 },
      { field: 'maxPrunePerRun', value: -1 },
    ] as const
    for (const { field, value } of bad) {
      const config = base()
      assert.equal(config.spread.plasticityEnabled, false, '前提：开关必须是关的')
      ;(config.spread as unknown as Record<string, number>)[field] = value
      const result = validateConfig(config)
      assert.equal(result.ok, false, `${field}=${value} 在开关关闭时也必须被拦住`)
      assert.ok(
        result.errors.some((e) => e.includes(field)),
        `报错必须指向 ${field}，实际：${result.errors.join('; ')}`,
      )
    }
  })
})

describe('可塑性的参数必须有分辨率（缺陷三十三第二层）', () => {
  function base(): typeof DEFAULT_CONFIG {
    return mergeConfig(DEFAULT_CONFIG)
  }

  /**
   * 用**真实实现**跑夜迭代，而不是套用解析式，也不是在测试里重写一遍强化。
   *
   * 这条用例原来算的是教科书均衡点 `w*(n) = n × delta × factor / (1 − factor)`。
   * 那个式子**与实测严重不符**：`delta=0.01, f=0.98, n=2` 时它给 0.98，
   * 而真实动力学跑到 0.74（差 24 个百分点）。原因见 `reinforceDelta` 的
   * 字段注释：`nextDecayedWeight` 带一条线性地板（修缺陷二十时加的），
   * 且系统有多个吸引子，`w*(n)` 根本不是良定义函数。
   *
   * **第一版改法也是错的**：我在测试里手写了 `Math.min(cap, w + delta)` 和
   * `nextDecayedWeight` 两步，等于替实现写了一份——实现改了，测试还在验自己
   * 那份抄本。现在改成真的调 `reinforceEdges` / `decayEdges`。
   *
   * `reinforceEdges` 内部检查 `plasticityEnabled`，而 `validateConfig` 拒绝
   * 打开它。这里**绕过校验直接调纯函数**是有意的：被测的是数学性质，
   * 不是「配置能不能通过校验」（那由另一组用例守）。
   *
   * @param times - 每夜强化几次。
   * @param from - 初值。
   * @returns 迭代到不动点后的边权。
   */
  function settle(times: number, from: number): number {
    const c = base()
    // 打开开关才能让两个纯函数真的干活；不经过 validateConfig。
    c.spread.plasticityEnabled = true
    // 边必须跨夜携带权重：写在循环里会每晚从初值重来，永远到不了不动点。
    let edges = [makeEdge('a', 'b', 'same-topic', from, 0)]
    let w = from
    for (let night = 0; night < 500; night += 1) {
      for (let i = 0; i < times; i += 1) {
        const next = reinforceEdges(edges, new Set(['a', 'b']), c)
        if (next.length > 0) edges = next
      }
      const decayed = decayEdges(edges, c)
      if (decayed.length > 0) edges = decayed
      const nextW = edges[0]?.weight ?? w
      if (nextW === w) return w
      w = nextW
    }
    return w
  }

  it('默认参数下「用得多」必须比「用得少」停在更高档（用真实实现跑夜迭代）', () => {
    const sp = base().spread
    const once = settle(1, 0.10)
    const twice = settle(2, 0.10)
    // 前提断言：两个终值都必须真的在合法区间里，否则下面的比较可能是在比两个 0
    assert.ok(once > 0 && once <= sp.maxEdgeWeight, `前提：n=1 的终值必须在 (0, ${sp.maxEdgeWeight}]，实际 ${once}`)
    assert.ok(twice > 0 && twice <= sp.maxEdgeWeight, `前提：n=2 的终值必须在 (0, ${sp.maxEdgeWeight}]，实际 ${twice}`)
    // 这条断言必须用 > 而不是 >=：>= 等于没断言（缺陷三十二的教训）
    assert.ok(
      twice > once,
      `「每夜用两次」必须停在比「每夜用一次」更高的档：${once} vs ${twice}。`
      + '若相等，说明默认参数下边权分不出使用频率',
    )
  })

  it('默认参数的档数上界受 N < (1−f)/0.01 限制（实测，不是解析式）', () => {
    const sp = base().spread
    // 从 0 起，每夜强化 n 次，收集 n=1..12 各自的终值，数有几个不同档
    const terminals = new Set<number>()
    for (let times = 1; times <= 12; times += 1) {
      terminals.add(settle(times, 0))
    }
    const bound = Math.floor((1 - sp.decayFactor) / 0.01)
    assert.ok(
      terminals.size <= bound + 1,
      `实测档数 ${terminals.size} 不应超过解析界 ${bound}+1（N < (1−f)/0.01）。`
      + `终值集合：${[...terminals].sort((a, b) => a - b).join(', ')}`,
    )
    // 这条是**已知局限的显式记录**，不是期望行为：f=0.98 只够 3 档。
    // 将来若换了强化模型让档数变多，这条会红，提醒重读 docs/8。
    assert.ok(
      terminals.size <= 4,
      `默认 f=${sp.decayFactor} 下档数应 ≤ 4（实测 ${terminals.size} 档：`
      + `${[...terminals].sort((a, b) => a - b).join(', ')}）。`
      + '若这条红了说明强化模型变了，请重读 docs/8-可塑性数学不可行性题面.md',
    )
  })

  it('delta 大到一次共激活就撞顶时必须被拒绝，且报错说清「分不出使用频率」', () => {
    const c = base()
    // 0.05 是修复前的默认值：w*(1) = 2.45，远超上限 1
    c.spread.reinforceDelta = 0.05
    const r = validateConfig(c)
    assert.equal(r.ok, false, 'w*(1) 超过上限的参数必须被拒绝')
    const hit = r.errors.filter((e) => e.includes('reinforceDelta'))
    assert.equal(hit.length, 1, '必须恰好一条指向 reinforceDelta，而不是被别的错误顶上')
    assert.ok(
      hit[0]?.includes('无法区分使用频率') || hit[0]?.includes('分不出'),
      `报错必须说清后果，而不只是说「太大了」：${hit[0]}`,
    )
    // 报错里要给出可用的上界，否则用户只能猜
    assert.ok(
      hit[0]?.includes('0.0204'),
      `报错必须给出具体上界（(1−factor)/factor = 0.0204）：${hit[0]}`,
    )
  })

  it('配对反向对照：把 decayFactor 调小之后，同样的 delta 就合法了', () => {
    // 只测「该拒绝的拒绝」是半个测试。同一个 delta，在更快的衰减下必须通过——
    // 证明拒绝的依据真的是「分辨率」而不是「delta 有个固定上限」。
    const c = base()
    c.spread.reinforceDelta = 0.05
    assert.equal(validateConfig(c).ok, false, '前提：factor=0.98 时 0.05 非法')
    c.spread.decayFactor = 0.90
    const r = validateConfig(c)
    assert.equal(r.ok, true, `factor=0.90 时 w*(1)=${(0.05*0.9/0.1).toFixed(2)} 应合法，实际错误：${r.errors.join('; ')}`)
  })

  it('默认 delta 与衰减地板步长相等 ⇒ 每夜用一次是精确的零变化（新发现）', () => {
    // 这条记录的是一个**比「档数不够」更根本**的结构事实，不是期望行为。
    //
    // 强化是 `w + delta`，衰减是 `nextDecayedWeight`，后者带一条线性地板：
    // 比例衰减不足一格时强制 `-0.01`。而 `delta` 的默认值恰好也是 `0.01`。
    // 于是在「比例衰减不足一格」的那段权重区间里，一步净变化**精确为零**：
    //
    //   w=0.10 → 强化 0.11 → 比例衰减 quantize(0.1078)=0.11 不小于 0.11
    //          → 走地板 0.11-0.01 = 0.10  ← 回到原值
    //
    // 实测（默认 delta=0.01, f=0.98）：101 个格点里 **75 个净变化为零、
    // 0 个上升**，只有 w ≥ 0.75 的 26 个格点会下降。
    // 也就是说「每夜用一次」与「完全不用」在前 75 个格点上无法区分。
    //
    // 后果：一条新建的边（`makeEdge` 权重来自相似度，通常 0.1~0.3）若每夜
    // 只被共激活一次，权重**永不增长**。要增长必须每夜 ≥ 2 次。
    //
    // 这不是标定失误，是「分辨率」与「响应性」的硬冲突：
    // delta 取 0.01 才有最多档数，而 0.01 恰好等于地板步长 ⇒ 一次强化被
    // 完全吃掉。delta 取 0.02 抵消消失，但档数界 (1−f)/delta 立刻减半。
    // 详见 docs/8-可塑性数学不可行性题面.md 第四节事实六。
    const c = base()
    c.spread.plasticityEnabled = true
    const edge0 = makeEdge('a', 'b', 'same-topic', 0.10, 0)
    let edges = [edge0]
    const reinforced = reinforceEdges(edges, new Set(['a', 'b']), c)
    assert.equal(reinforced[0]?.weight, 0.11, '前提：强化确实 +0.01，否则下面的抵消无从谈起')
    edges = reinforced
    const decayed = decayEdges(edges, c)
    assert.equal(
      decayed[0]?.weight, 0.10,
      `默认参数下「强化一次 + 衰减一次」必须精确回到原值 0.10，`
      + `实际 ${decayed[0]?.weight}。若这条红了说明 delta 与地板步长不再相等，`
      + '请重读 docs/8 第四节事实六再决定是好事还是坏事',
    )
  })

  it('「用一次」与「不用」在前 75 个格点上无法区分（实测，记录已知局限）', () => {
    const c = base()
    c.spread.plasticityEnabled = true
    let noop = 0
    let up = 0
    for (let i = 0; i <= 100; i += 1) {
      const w0 = i / 100
      let edges = [makeEdge('a', 'b', 'same-topic', w0, 0)]
      const nx = reinforceEdges(edges, new Set(['a', 'b']), c)
      if (nx.length > 0) edges = nx
      const d = decayEdges(edges, c)
      if (d.length > 0) edges = d
      const w1 = edges[0]?.weight ?? w0
      if (w1 === w0) noop += 1
      if (w1 > w0) up += 1
    }
    assert.equal(up, 0, '默认参数下「每夜用一次」不应该让任何格点上升——这是已知局限，不是期望')
    assert.ok(
      noop >= 70,
      `实测零变化格点数应 ≥ 70（实测 ${noop}）。若这条红了说明参数变了，`
      + '请重读 docs/8 第四节事实六',
    )
  })

  it('delta 必须是量化格的整数倍，否则强化会被圆整掉（缺陷二十同类）', () => {
    const c = base()
    const step = EDGE_WEIGHT_STEP
    const ratio = c.spread.reinforceDelta / step
    assert.ok(
      Math.abs(ratio - Math.round(ratio)) < 1e-9,
      `reinforceDelta=${c.spread.reinforceDelta} 必须是 EDGE_WEIGHT_STEP=${step} 的整数倍，`
      + '否则每次强化的增量小于半格、被圆整回原值，机制在数学上停摆',
    )
  })
})
