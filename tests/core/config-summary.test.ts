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

/** 默认配置的全部叶子（路径=值，已排序）。见上面那条绊线的说明。 */
const EXPECTED_CONFIG_LEAVES: readonly string[] = [
  'configVersion=13',
  'consolidation.dailyAt=03:30',
  'consolidation.dailySummaryMaxChars=180',
  'consolidation.distillEdgeWeight=0.6',
  'consolidation.distillEnabled=true',
  'consolidation.distillExampleChars=30',
  'consolidation.distillMaxChars=120',
  'consolidation.distillMaxPerRun=3',
  'consolidation.distillMinEmotional=0.28',
  'consolidation.distillMinRecurrence=2',
  'consolidation.distillThemeMinChars=2',
  'consolidation.enabled=true',
  'consolidation.maxArchiveRatio=0.05',
  'consolidation.maxCardsPerRun=5000',
  'consolidation.maxSummariesPerRun=8',
  'consolidation.monthlySummaryMaxChars=110',
  'consolidation.summaryBriefChars=40',
  'consolidation.summaryEnabled=true',
  'consolidation.summaryMaxEntities=6',
  'consolidation.summaryMaxTags=6',
  'consolidation.summaryMinChildren=2',
  'consolidation.summaryMinSourceChars=120',
  'consolidation.summaryTargetRatio=0.5',
  'consolidation.weeklySummaryMaxChars=140',
  'debugExplain=true',
  'dedup.duplicateSimilarity=0.86',
  'dedup.mergeTextChars=200',
  'dedup.relatedSimilarity=0.45',
  'extraction.domains[0]=work',
  'extraction.dueKeywords[0]=提醒',
  'extraction.dueKeywords[10]=通知我',
  'extraction.dueKeywords[11]=明天',
  'extraction.dueKeywords[12]=后天',
  'extraction.dueKeywords[13]=下周',
  'extraction.dueKeywords[14]=每天',
  'extraction.dueKeywords[15]=每周',
  'extraction.dueKeywords[1]=记得',
  'extraction.dueKeywords[2]=别忘',
  'extraction.dueKeywords[3]=不要忘',
  'extraction.dueKeywords[4]=到点',
  'extraction.dueKeywords[5]=到期',
  'extraction.dueKeywords[6]=截止',
  'extraction.dueKeywords[7]=deadline',
  'extraction.dueKeywords[8]=闹钟',
  'extraction.dueKeywords[9]=叫我',
  'extraction.emotionalGateThreshold=0.28',
  'extraction.emotionalMediumKeywords[0]=很',
  'extraction.emotionalMediumKeywords[10]=烦',
  'extraction.emotionalMediumKeywords[11]=累',
  'extraction.emotionalMediumKeywords[12]=失望',
  'extraction.emotionalMediumKeywords[13]=慌',
  'extraction.emotionalMediumKeywords[14]=焦虑',
  'extraction.emotionalMediumKeywords[15]=委屈',
  'extraction.emotionalMediumKeywords[16]=孤独',
  'extraction.emotionalMediumKeywords[17]=温暖',
  'extraction.emotionalMediumKeywords[18]=疲惫',
  'extraction.emotionalMediumKeywords[19]=无奈',
  'extraction.emotionalMediumKeywords[1]=挺',
  'extraction.emotionalMediumKeywords[20]=庆幸',
  'extraction.emotionalMediumKeywords[21]=松了一口气',
  'extraction.emotionalMediumKeywords[22]=满意',
  'extraction.emotionalMediumKeywords[23]=不安',
  'extraction.emotionalMediumKeywords[24]=兴奋',
  'extraction.emotionalMediumKeywords[2]=比较',
  'extraction.emotionalMediumKeywords[3]=有点',
  'extraction.emotionalMediumKeywords[4]=感觉',
  'extraction.emotionalMediumKeywords[5]=觉得',
  'extraction.emotionalMediumKeywords[6]=担心',
  'extraction.emotionalMediumKeywords[7]=害怕',
  'extraction.emotionalMediumKeywords[8]=开心',
  'extraction.emotionalMediumKeywords[9]=难受',
  'extraction.emotionalStrongKeywords[0]=非常',
  'extraction.emotionalStrongKeywords[10]=绝了',
  'extraction.emotionalStrongKeywords[11]=绝望',
  'extraction.emotionalStrongKeywords[12]=惊喜',
  'extraction.emotionalStrongKeywords[13]=震惊',
  'extraction.emotionalStrongKeywords[14]=激动',
  'extraction.emotionalStrongKeywords[15]=感激',
  'extraction.emotionalStrongKeywords[16]=感动',
  'extraction.emotionalStrongKeywords[1]=特别',
  'extraction.emotionalStrongKeywords[2]=超级',
  'extraction.emotionalStrongKeywords[3]=极其',
  'extraction.emotionalStrongKeywords[4]=太',
  'extraction.emotionalStrongKeywords[5]=巨',
  'extraction.emotionalStrongKeywords[6]=崩溃',
  'extraction.emotionalStrongKeywords[7]=爆炸',
  'extraction.emotionalStrongKeywords[8]=气死',
  'extraction.emotionalStrongKeywords[9]=爽',
  'extraction.includeAssistant=true',
  'extraction.maxCardsPerTurn=4',
  'extraction.minAssistantChars=40',
  'extraction.minTextChars=6',
  'extraction.signalKeywords[0]=决定',
  'extraction.signalKeywords[10]=务必',
  'extraction.signalKeywords[11]=注意',
  'extraction.signalKeywords[12]=踩坑',
  'extraction.signalKeywords[13]=坑',
  'extraction.signalKeywords[14]=报错',
  'extraction.signalKeywords[15]=失败',
  'extraction.signalKeywords[16]=原因',
  'extraction.signalKeywords[17]=方案',
  'extraction.signalKeywords[18]=选择',
  'extraction.signalKeywords[19]=替代',
  'extraction.signalKeywords[1]=结论',
  'extraction.signalKeywords[20]=部署',
  'extraction.signalKeywords[21]=架构',
  'extraction.signalKeywords[22]=约定',
  'extraction.signalKeywords[2]=记住',
  'extraction.signalKeywords[3]=以后',
  'extraction.signalKeywords[4]=下次',
  'extraction.signalKeywords[5]=不要再',
  'extraction.signalKeywords[6]=偏好',
  'extraction.signalKeywords[7]=习惯',
  'extraction.signalKeywords[8]=承诺',
  'extraction.signalKeywords[9]=答应',
  'forgetting.accessBoost=0.18',
  'forgetting.archiveThreshold=0.08',
  'forgetting.autoArchive=true',
  'forgetting.emotionalHalfLifeBoost=2',
  'forgetting.halfLifeMs=1209600000',
  'forgetting.neverArchiveKinds[0]=feeling',
  'forgetting.neverArchiveKinds[1]=promise',
  'forgetting.neverArchiveKinds[2]=concept',
  'forgetting.neverArchiveKinds[3]=experience',
  'graph.topicFloor=0.08',
  'graph.topicNeighbors=3',
  'recall.absoluteThreshold=0.06',
  'recall.candidateLimit=400',
  'recall.maxCardChars=160',
  'recall.maxCards=7',
  'recall.overheadTokens=100',
  'recall.relativeThreshold=0.55',
  'recall.tokenBudget=900',
  'reminder.cronSearchDays=366',
  'reminder.enabled=true',
  'reminder.pollMs=60000',
  'spread.decayFactor=0.98',
  'spread.distillBidirectional=true',
  'spread.explainSourceChars=24',
  'spread.hopDecay=0.5',
  'spread.maxAffected=5',
  'spread.maxBoost=0.12',
  'spread.maxEdgeWeight=1',
  'spread.maxHops=2',
  'spread.maxPrunePerRun=200',
  'spread.minSelfScoreRatio=1',
  'spread.mode=shadow',
  'spread.plasticityEnabled=false',
  'spread.pruneThreshold=0.1',
  'spread.reinforceDelta=0.05',
  'spread.seedRatio=0.85',
  'storage.configSnapshotMaxEntries=200',
  'storage.dataDir=.dsh-memory',
  'storage.fsyncOnWrite=true',
  'storage.journalSegmentBytes=4194304',
  'storage.logFile=logs/diagnostics.jsonl',
  'storage.logMaxEntries=500',
  'weights.confidence=0.1',
  'weights.conflict=0.25',
  'weights.goal=0.1',
  'weights.importance=0.18',
  'weights.recency=0.2',
  'weights.semantic=0.42',
]

describe('摘要配置的默认值与版本', () => {
  it('默认配置通过校验', () => {
    const result = validateConfig(base())
    assert.deepEqual(result.errors, [])
    assert.equal(result.ok, true)
  })

  it('configVersion 与常量一致（改默认配置必须同时递增两者）', () => {
    assert.equal(DEFAULT_CONFIG.configVersion, MEMORY_CONFIG_VERSION)
    // 这条是**绊线**，不是回归测试：它写死版本号，故意让「改了默认配置却忘了
    // 递增版本」变红。递增时改这里的数字是预期动作，不是修测试。
    //
    // 版本历史（每次递增都在这里留一行，让后来者知道该不该再递增）：
    //   1 → 初始契约层
    //   2 → 时间感与到期提醒参数
    //   3 → 摘要与蒸馏参数
    //   4 → 图谱扩散与突触可塑性参数（FR-G1）
    //   5 → 扩散从布尔开关改成三态 mode（off / shadow / on），默认 shadow
    //   6 → spread.explainSourceChars（「因为想起了谁」的来源文本长度）
    //   7 → storage.logFile / storage.logMaxEntries（FR-F1 诊断日志落盘）
    //   8 → reminder.cronSearchDays（FR-D3 cron 分支的搜索上界）
    //   9 → storage.configSnapshotMaxEntries（FR-F4 配置快照台账上限）
    //  10 → **删除**两个零读取的死配置：recall.minCards 与 storage.reindexEveryRecords
    //       删字段同样要递增版本：旧配置文件里可能写着它们，回滚快照里也可能有，
    //       版本号是「schema 变过」的唯一凭据。
    //  11 → **新增** graph 分区（topicFloor / topicNeighbors）。图谱连边原先借用
    //       dedup.relatedSimilarity，而那个数值是为去重标定的、且被冲突判定
    //       反向共用；拆出独立分区是修缺陷二十四的前提。详见 docs/7。
    //  12 → `recall.absoluteThreshold` **改了语义**（缺陷二十六）：它比对的
    //       不再是 `total`，而是新增的相关分量 `relevance`；数值从 0.18 改为 0.06
    //       （两把尺子的刻度不同，不能沿用旧值）。同时删除 `capConflictPenalty`。
    //       语义变更比新增字段更需要递增版本：旧快照里写着 `absoluteThreshold: 0.18`
    //       的人以为那是「总分阈值」，回滚回来会得到一个清空焦点包的值。
    assert.equal(MEMORY_CONFIG_VERSION, 13, '情绪通道加入抽取后版本应为 13')
  })

  it('默认配置的每个叶子都必须被版本号覆盖（新增字段会在这里变红）', () => {
    // 与上一条的区别：上一条只比「两个数字相不相等」，抓不到
    // 「数字都没动、但默认配置改了」。846865c 加 spread.explainSourceChars
    // 时就是这样漏掉的——原绊线全绿，P7（参数可版本化可回滚）被静默破坏。
    //
    // 这里把默认配置摊平成「路径=值」的排序列表。任何叶子新增、删除、
    // 改值都会让这条变红。**红了不要直接改期望值**：先问「这个改动
    // 该不该递增 MEMORY_CONFIG_VERSION」，该递增就递增并同步上面的
    // 版本历史，不该递增（纯注释、纯内部重构）就不该动这里。
    //
    // 用稳定序列化而不是哈希：哈希红了只说「变了」，看不出是哪一项。
    const flat = (value: unknown, prefix: string): string[] => {
      if (value === null || typeof value !== 'object') return [`${prefix}=${String(value)}`]
      if (Array.isArray(value)) {
        return value.length === 0
          ? [`${prefix}=[]`]
          : value.flatMap((item, index) => flat(item, `${prefix}[${index}]`))
      }
      const entries = Object.entries(value as Record<string, unknown>)
      return entries.length === 0
        ? [`${prefix}={}`]
        : entries.flatMap(([key, item]) => flat(item, prefix === '' ? key : `${prefix}.${key}`))
    }
    const leaves = flat(DEFAULT_CONFIG, '').sort()
    // 前提：叶子数必须与配置的真实规模相当，否则摊平函数写坏了
    // （比如只摊平了一层）这条也会绿——那就是装饰。
    assert.ok(leaves.length >= 100, `前提：默认配置应有上百个叶子，实际 ${leaves.length}`)
    assert.deepEqual(leaves, EXPECTED_CONFIG_LEAVES)
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
