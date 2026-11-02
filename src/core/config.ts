/**
 * 配置契约：全部可调参数集中在这里，并有默认值、版本号与校验。
 *
 * 原则 P7「参数可版本化、可回滚」与 P8「成本有上界」在本文件落地：
 * 任何阈值、权重、预算都不是散落在代码里的字面量，而是 {@link MemoryConfig}
 * 的字段。宿主的插件 Config（schemastery）与离线 CLI 都从这份结构派生。
 *
 * @module dsh-memory/core/config
 */

import type { MemoryDomain } from './types.ts'

/** 打分权重。四项相加不必为 1，最终会归一化，方便单独调参。 */
export interface ScoringWeights {
  /** 语义相关权重。 */
  semantic: number
  /** 重要性权重。 */
  importance: number
  /** 时间新鲜度权重。 */
  recency: number
  /** 目标匹配权重。 */
  goal: number
  /** 置信度权重。 */
  confidence: number
  /** 冲突惩罚权重（扣分项）。 */
  conflict: number
}

/** 阈值与焦点包参数。 */
export interface RecallPolicy {
  /** 绝对阈值：总分低于它一律不进焦点包（FR-B2）。 */
  absoluteThreshold: number
  /** 相对阈值：低于「最高分 × 该比例」的不进焦点包（FR-B2）。 */
  relativeThreshold: number
  /** 焦点包硬上限条数（FR-B2，默认 7）。 */
  maxCards: number
  /** 焦点包最少条数，低于此值不强行凑数。 */
  minCards: number
  /** 每轮记忆注入 token 硬上限（FR-E3）。 */
  tokenBudget: number
  /** 单条卡片摘要字符上限，超出截断（Q-09）。 */
  maxCardChars: number
  /**
   * 注入块的固定开销预留（token）：标题、当前时间、空行、免责尾注。
   *
   * 起源 L33（第 7 条·有限上下文）要求「利用有限的上下文」，
   * FR-E3 要求每轮记忆注入有硬上限。若只把卡片本身计入预算、
   * 不预留头尾固定文本，实际注入必然超出 `tokenBudget`——上限就是假的。
   */
  overheadTokens: number
  /** 候选池上限，限制打分规模以保 NFR-1（万级记忆 <50ms）。 */
  candidateLimit: number
}

/** 遗忘与强度参数。 */
export interface ForgettingPolicy {
  /** 记忆强度衰减半衰期（毫秒），默认 14 天。 */
  halfLifeMs: number
  /** 每次被召回带来的强度增益。 */
  accessBoost: number
  /** 强度低于该值才允许自动归档（FR-C4）。 */
  archiveThreshold: number
  /** 情绪强度对半衰期的放大系数上限：强烈的感受忘得更慢（起源 L3·激素是关键）。 */
  emotionalHalfLifeBoost: number
  /**
   * 永不归档的类型（FR-C3）。
   *
   * `feeling` 必须在列：起源 L11（无编号）说「我们大多数细节都会忘记，只会留下感受」，
   * 感受正是该系统**唯一该长期留下的东西**。把感受卡按强度归档，
   * 等于把起源最核心的那句话实现反了。
   */
  neverArchiveKinds: string[]
  /** 是否启用自动归档。 */
  autoArchive: boolean
}

/** 去重与合并参数。 */
export interface DedupPolicy {
  /** 归一化文本相似度达到该值视为重复，直接合并。 */
  duplicateSimilarity: number
  /** 相似度达到该值视为同一话题，建立图谱边而非合并。 */
  relatedSimilarity: number
  /** 合并时保留文本的长度上限。 */
  mergeTextChars: number
}

/** 抽取参数：决定写什么、写多少。 */
export interface ExtractionPolicy {
  /** 启用的记忆域（Q-02：第一版默认只开工作域）。 */
  domains: MemoryDomain[]
  /** 单轮最多写入的记忆卡数，防止刷屏。 */
  maxCardsPerTurn: number
  /** 用户消息至少多长才考虑写入。 */
  minTextChars: number
  /** 助手消息至少多长才考虑写入。 */
  minAssistantChars: number
  /** 触发写入的关键词（承诺、决策、偏好、踩坑）。 */
  signalKeywords: string[]
  /**
   * 触发写入的到期类关键词（FR-D3 / 起源 L21）。
   *
   * 单列一组而不并进 `signalKeywords`，是因为它们有**额外语义**：
   * 命中不仅要放行门控，还要去解析 `dueAt`。
   * 早期版本把「明天/下周/提醒」混进普通信号词，导致
   * 「明天下午三点提醒我交周报」这种句子反而因为一个词都没命中而不入库，
   * FR-D3 从根上不可能通过。
   */
  dueKeywords: string[]
  /** 是否把助手回复也纳入抽取。 */
  includeAssistant: boolean
}

/** 存储参数。 */
export interface StoragePolicy {
  /** 数据目录；相对路径按宿主工作区解析。 */
  dataDir: string
  /** 日志分片大小（字节），超过后滚动到新分片。 */
  journalSegmentBytes: number
  /** 是否每次写入都 fsync（FR-A3 原子性）。 */
  fsyncOnWrite: boolean
  /** 索引重建阈值：日志新增条数达到该值后自动重建倒排索引。 */
  reindexEveryRecords: number
}

/** 巩固（夜整理）参数。 */
export interface ConsolidationPolicy {
  /** 是否启用。 */
  enabled: boolean
  /** 触发时刻，本地时间 `HH:mm`。 */
  dailyAt: string
  /** 单次整理最多处理的卡片数，硬上限保证耗时可控（P8）。 */
  maxCardsPerRun: number
  /** 一次整理中归档比例上限，避免一次性清空。 */
  maxArchiveRatio: number
}

/** 到期提醒参数（FR-D3 / SC-5 / 起源 L21）。 */
export interface ReminderPolicy {
  /**
   * 是否启用主动唤醒。
   *
   * 关掉后仍会把到期事项渲染进时间读数，但不会在到点时主动接力——
   * 那就是 FR-D3 的一半，所以默认开启。
   */
  enabled: boolean
  /**
   * 轮询间隔（毫秒）。
   *
   * 轮询而不是精确定时：提醒不需要秒级精度，而逐个定时器会随卡片数量膨胀。
   * 默认 60 秒，代价是最大 1 分钟的提醒延迟，远好于「只在用户开口时才发现已过期」。
   */
  pollMs: number
}

/** 完整配置。 */
export interface MemoryConfig {
  /** 配置版本号，改动默认值时必须递增（FR-F4）。 */
  configVersion: number
  /** 打分权重。 */
  weights: ScoringWeights
  /** 召回策略。 */
  recall: RecallPolicy
  /** 遗忘策略。 */
  forgetting: ForgettingPolicy
  /** 去重策略。 */
  dedup: DedupPolicy
  /** 抽取策略。 */
  extraction: ExtractionPolicy
  /** 存储策略。 */
  storage: StoragePolicy
  /** 巩固策略。 */
  consolidation: ConsolidationPolicy
  /** 到期提醒策略（FR-D3）。 */
  reminder: ReminderPolicy
  /** 调试开关：记录每次召回的解释。 */
  debugExplain: boolean
}

/** 默认配置。改这里必须同时递增 {@link MEMORY_CONFIG_VERSION}。 */
export const DEFAULT_CONFIG: MemoryConfig = {
  configVersion: 2,
  weights: {
    semantic: 0.42,
    importance: 0.18,
    recency: 0.20,
    goal: 0.10,
    confidence: 0.10,
    conflict: 0.25,
  },
  recall: {
    absoluteThreshold: 0.18,
    relativeThreshold: 0.55,
    maxCards: 7,
    minCards: 1,
    tokenBudget: 900,
    maxCardChars: 160,
    // 两行标题 + 当前时间行 + 两处空行 + 一行免责尾注，中文约 90 字。
    overheadTokens: 100,
    candidateLimit: 400,
  },
  forgetting: {
    halfLifeMs: 14 * 24 * 60 * 60 * 1000,
    accessBoost: 0.18,
    archiveThreshold: 0.08,
    emotionalHalfLifeBoost: 2.0,
    // `feeling` 在列的依据见 ForgettingPolicy.neverArchiveKinds 注释：
    // 起源 L11 要求「只留下感受」，感受不该被自动归档。
    neverArchiveKinds: ['feeling', 'promise', 'concept', 'experience'],
    autoArchive: true,
  },
  dedup: {
    duplicateSimilarity: 0.86,
    relatedSimilarity: 0.45,
    mergeTextChars: 200,
  },
  extraction: {
    domains: ['work'],
    maxCardsPerTurn: 4,
    minTextChars: 6,
    minAssistantChars: 40,
    signalKeywords: [
      '决定', '结论', '记住', '以后', '下次', '不要再', '偏好', '习惯',
      '承诺', '答应', '务必', '注意', '踩坑', '坑', '报错', '失败', '原因',
      '方案', '选择', '替代', '部署', '架构', '约定',
    ],
    // 到期类：命中即放行门控，并由 time/due.ts 解析具体时刻（FR-D3）。
    dueKeywords: [
      '提醒', '记得', '别忘', '不要忘', '到点', '到期', '截止', 'deadline',
      '闹钟', '叫我', '通知我', '明天', '后天', '下周', '每天', '每周',
    ],
    includeAssistant: true,
  },
  storage: {
    dataDir: '.dsh-memory',
    journalSegmentBytes: 4 * 1024 * 1024,
    fsyncOnWrite: true,
    reindexEveryRecords: 2000,
  },
  consolidation: {
    enabled: true,
    dailyAt: '03:30',
    maxCardsPerRun: 5000,
    maxArchiveRatio: 0.05,
  },
  reminder: {
    enabled: true,
    pollMs: 60 * 1000,
  },
  debugExplain: true,
}

/** 当前配置版本号，与 {@link DEFAULT_CONFIG}.configVersion 保持一致。 */
export const MEMORY_CONFIG_VERSION = 2

/** 配置校验结果。 */
export interface ConfigValidation {
  /** 是否通过。 */
  ok: boolean
  /** 错误信息，逐条人可读。 */
  errors: string[]
}

/**
 * 校验配置。宿主 schema 之外的第二道防线：离线 CLI 与单测直接调用它。
 *
 * @param config - 待校验配置。
 * @returns 校验结果，不抛异常（调用方决定如何处置）。
 */
export function validateConfig(config: MemoryConfig): ConfigValidation {
  const errors: string[] = []
  const inUnit = (label: string, value: number): void => {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${label} 必须是 0..1 之间的有限数，实际为 ${value}`)
    }
  }
  for (const key of ['semantic', 'importance', 'recency', 'goal', 'confidence', 'conflict'] as const) {
    inUnit(`weights.${key}`, config.weights[key])
  }
  const weightSum = config.weights.semantic + config.weights.importance + config.weights.recency
    + config.weights.goal + config.weights.confidence
  if (weightSum <= 0) errors.push('weights 中正向权重之和必须大于 0')

  inUnit('recall.absoluteThreshold', config.recall.absoluteThreshold)
  inUnit('recall.relativeThreshold', config.recall.relativeThreshold)
  if (config.recall.maxCards < 1) errors.push('recall.maxCards 必须 ≥ 1')
  if (config.recall.minCards < 0 || config.recall.minCards > config.recall.maxCards) {
    errors.push('recall.minCards 必须落在 0..maxCards 之间')
  }
  if (config.recall.tokenBudget < 64) errors.push('recall.tokenBudget 必须 ≥ 64')
  if (config.recall.candidateLimit < config.recall.maxCards) {
    errors.push('recall.candidateLimit 必须 ≥ recall.maxCards')
  }

  if (config.forgetting.halfLifeMs <= 0) errors.push('forgetting.halfLifeMs 必须 > 0')
  inUnit('forgetting.accessBoost', config.forgetting.accessBoost)
  inUnit('forgetting.archiveThreshold', config.forgetting.archiveThreshold)

  inUnit('dedup.duplicateSimilarity', config.dedup.duplicateSimilarity)
  inUnit('dedup.relatedSimilarity', config.dedup.relatedSimilarity)
  if (config.dedup.relatedSimilarity > config.dedup.duplicateSimilarity) {
    errors.push('dedup.relatedSimilarity 不应大于 dedup.duplicateSimilarity')
  }

  if (config.extraction.domains.length === 0) errors.push('extraction.domains 不能为空')
  if (config.extraction.maxCardsPerTurn < 0) errors.push('extraction.maxCardsPerTurn 不能为负')

  if (!Number.isInteger(config.storage.journalSegmentBytes) || config.storage.journalSegmentBytes < 4096) {
    errors.push('storage.journalSegmentBytes 必须是不小于 4096 的整数')
  }

  if (config.consolidation.maxArchiveRatio > 1) errors.push('consolidation.maxArchiveRatio 必须 ≤ 1')
  if (!/^\d{2}:\d{2}$/u.test(config.consolidation.dailyAt)) {
    errors.push('consolidation.dailyAt 必须是 HH:mm 形式')
  }
  // 轮询间隔太短会空转烧 CPU，太长则提醒延迟不可接受（FR-D3）。
  if (config.reminder.pollMs < 1000) errors.push('reminder.pollMs 必须 ≥ 1000（1 秒）')
  return { ok: errors.length === 0, errors }
}

/**
 * 深合并用户配置与默认配置。
 *
 * 宿主的 patch 行是**整块替换 config**（不深合并），所以插件入口必须自己做
 * 这一层合并，否则用户只写一个字段就会把其余默认值清空。
 *
 * @param base - 默认配置。
 * @param override - 用户提供的部分配置。
 * @returns 合并后的新对象，不修改入参。
 */
export function mergeConfig(base: MemoryConfig, override: DeepPartial<MemoryConfig> = {}): MemoryConfig {
  const merged: MemoryConfig = {
    configVersion: override.configVersion ?? base.configVersion,
    weights: { ...base.weights, ...override.weights },
    recall: { ...base.recall, ...override.recall },
    forgetting: { ...base.forgetting, ...override.forgetting },
    dedup: { ...base.dedup, ...override.dedup },
    extraction: { ...base.extraction, ...override.extraction },
    storage: { ...base.storage, ...override.storage },
    consolidation: { ...base.consolidation, ...override.consolidation },
    reminder: { ...base.reminder, ...override.reminder },
    debugExplain: override.debugExplain ?? base.debugExplain,
  }
  // 数组字段必须整体替换，浅合并会让用户的自定义关键词被默认值覆盖。
  // 而且**无论覆盖与否都要复制**：直接沿用 base 的数组会让结果与 DEFAULT_CONFIG
  // 共享引用，调用方一句 `push` 就能污染全局默认值（跨测试、跨插件实例串味）。
  merged.forgetting.neverArchiveKinds = [...(override.forgetting?.neverArchiveKinds ?? base.forgetting.neverArchiveKinds)]
  merged.extraction.domains = [...(override.extraction?.domains ?? base.extraction.domains)]
  merged.extraction.signalKeywords = [...(override.extraction?.signalKeywords ?? base.extraction.signalKeywords)]
  merged.extraction.dueKeywords = [...(override.extraction?.dueKeywords ?? base.extraction.dueKeywords)]
  return merged
}

/** 任意深度的部分类型。 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}
