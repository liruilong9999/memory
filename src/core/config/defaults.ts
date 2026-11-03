/**
 * 配置默认值：{@link DEFAULT_CONFIG} 与 {@link MEMORY_CONFIG_VERSION}。
 *
 * 从 `core/config.ts` 拆出，**纯搬移**：全部默认值字面量与注释一字未改。
 * 结构定义在 `./types.ts`，校验在 `./validate.ts`。
 *
 * @module dsh-memory/core/config/defaults
 */

import type { MemoryConfig } from './types.ts'

/** 默认配置。改这里必须同时递增 {@link MEMORY_CONFIG_VERSION}。 */
export const DEFAULT_CONFIG: MemoryConfig = {
  configVersion: 14,
  weights: {
    semantic: 0.42,
    importance: 0.18,
    recency: 0.20,
    goal: 0.10,
    confidence: 0.10,
    conflict: 0.25,
  },
  recall: {
    // 0.06 是**相关分量（relevance）**尺度上的值，不是总分尺度上的。
    //
    // 这个参数以前比对 `total`，而 `total` 上有 0.48 权重与查询无关，
    // 无关卡也能拿约 0.32，导致阈值恒真、「全低分时不硬塞」不可失败。
    // 详见 `RecallPolicy.absoluteThreshold` 与 `ScoreBreakdown.relevance`。
    //
    // 定标依据（161 张真实卡 × 19 个查询，含 5 个完全无关的）：
    // - 0.06：无关组进包 0 张，真相关卡（semantic ≥ 0.18）零损失；
    // - 0.10：无关组仍 0 张，但空包查询从 5 个升到 7 个（开始误伤）；
    // - 0.15：开始丢真相关卡（3 张）。
    // 取 0.06 = 既能挡住全部噪声，又不在边界上误伤。
    absoluteThreshold: 0.06,
    relativeThreshold: 0.55,
    maxCards: 7,
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
    // 情绪通道阈值：整轮平均情绪达到 0.28 就放行写入（起源 L3 / L11）。
    // 与 `consolidation.distillMinEmotional` 取同一个数不是巧合——它们回答的是
    // 同一个问题「这一轮够不够算有感受」，两处用不同数会让「能进来」和
    // 「能被蒸馏」之间出现一个谁都不负责的缝隙。
    emotionalGateThreshold: 0.28,
    // 强情绪词：单独出现就足够说明情绪很强（语气副词 + 极端状态）。
    emotionalStrongKeywords: [
      '非常', '特别', '超级', '极其', '太', '巨', '崩溃', '爆炸', '气死',
      '爽', '绝了', '绝望', '惊喜', '震惊', '激动', '感激', '感动',
    ],
    // 中情绪词：需要叠加或配合标点才算强情绪。
    emotionalMediumKeywords: [
      '很', '挺', '比较', '有点', '感觉', '觉得', '担心', '害怕', '开心',
      '难受', '烦', '累', '失望', '慌', '焦虑', '委屈', '孤独', '温暖',
      '疲惫', '无奈', '庆幸', '松了一口气', '满意', '不安', '兴奋',
    ],
  },
  storage: {
    dataDir: '.dsh-memory',
    journalSegmentBytes: 4 * 1024 * 1024,
    fsyncOnWrite: true,
    logFile: 'logs/diagnostics.jsonl',
    logMaxEntries: 500,
    // 配置快照（FR-F4）：每次启动时配置若与上一条不同就追加一条。
    // 200 条足够回溯一年多的改动，同时把旁路文件压在一百多 KB。
    configSnapshotMaxEntries: 200,
  },
  consolidation: {
    enabled: true,
    dailyAt: '03:30',
    maxCardsPerRun: 5000,
    maxArchiveRatio: 0.05,
    summaryEnabled: true,
    maxSummariesPerRun: 8,
    // 一天按 12 张卡算，日摘要 180 字 ≈ 原文的 1/6；上限是压缩的强制手段，
    // 不是排版偏好（见 ConsolidationPolicy.dailySummaryMaxChars 注释）。
    dailySummaryMaxChars: 180,
    weeklySummaryMaxChars: 140,
    monthlySummaryMaxChars: 110,
    summaryTargetRatio: 0.5,
    summaryMinSourceChars: 120,
    summaryMinChildren: 2,
    summaryMaxEntities: 6,
    summaryMaxTags: 6,
    summaryBriefChars: 40,
    distillEnabled: true,
    // 0.28 的含义：至少命中一个中等情绪词、或两个弱信号，才算「有感受」。
    // 定得再低，日常事务性记录也会被算成感受。
    distillMinEmotional: 0.28,
    distillMinRecurrence: 2,
    distillThemeMinChars: 2,
    distillMaxPerRun: 3,
    distillMaxChars: 120,
    distillExampleChars: 30,
    distillEdgeWeight: 0.6,
  },
  reminder: {
    enabled: true,
    pollMs: 60 * 1000,
    cronSearchDays: 366,
  },
  graph: {
    // 下限 0.08 的来历：实测真实中文语料上，0.08 对应「平均度数 3.75」，
    // 而 0.05 对应 10.09——后者已经是全连接图，等于没有图。
    // 抽样读原文确认 0.08 附近连出的边语义大多成立（如「影子模式必须算真账」
    // 对「shadow 模式必须没有这一行」）。
    topicFloor: 0.08,
    // K=3：实测 300 卡时边数 320、最大度数 8、孤立 62 张。
    // 取 3 而不是 5：K=5 让孤立卡降到 11 张，但边数翻到 745、
    // 精确率反而从 57.5% 降到 55.7%——多出来的边主要是噪声。
    topicNeighbors: 3,
  },
  spread: {
    // 默认 `'shadow'`：**计算但不生效**。
    //
    // 为什么不默认 `'on'`：FR-G1 的触发条件是「稳定记忆跑通、积累了 2 周
    // 真实数据」，现在一条真实数据都没有。默认开启等于让一个未经检验的
    // 机制悄悄改变每一次召回的排序——而且改得不多，正是最难发现的那一类。
    //
    // 为什么不默认 `'off'`：关掉就永远拿不到「它到底会怎么改」的证据，
    // 而那份证据恰恰是判断该不该打开它的唯一依据。关闭状态下的「没出问题」
    // 不能证明任何事——它压根没跑。
    //
    // `'shadow'` 同时解决这两件事：算出来、记下来、**但排序不动**。
    // 攒够数据后把它改成 `'on'` 是一次显式决定，不是继承来的默认。
    mode: 'shadow',
    hopDecay: 0.5,
    maxHops: 2,
    maxBoost: 0.12,
    minSelfScoreRatio: 1,
    // 种子门槛 = 本轮最高分 × 0.85。为什么是相对量：打分有基础分下限
    // （无关文本也有 0.33 左右），任何绝对门槛都会落在所有卡之下，扩散恒空
    // ——详见 SpreadPolicy.seedRatio 的推导与实测数据。
    //
    // 为什么不是 0.5：门槛太低会把半匹配的卡也算成种子，它们本就该被扩散
    // 推动，却被当成激活源，扩散就失去推动对象了。0.85 只让接近本轮最高分
    // 的那几张当种子。
    seedRatio: 0.85,
    maxAffected: 5,
    distillBidirectional: true,
    plasticityEnabled: false,
    reinforceDelta: 0.01,
    maxEdgeWeight: 1,
    decayFactor: 0.98,
    pruneThreshold: 0.1,
    maxPrunePerRun: 200,
    explainSourceChars: 24,
  },
  debugExplain: true,
}

/** 当前配置版本号，与 {@link DEFAULT_CONFIG}.configVersion 保持一致。 */
export const MEMORY_CONFIG_VERSION = 14
