/**
 * 配置校验：宿主 schema 之外的第二道防线。
 *
 * 从 `core/config.ts` 拆出，**纯搬移**：全部校验条件、错误文案与注释一字未改。
 * 尤其注意 `spread.plasticityEnabled` 的加载期拒绝、`reinforceDelta <= 0`
 * 的无条件校验、以及 `equilibriumAtOne` 那段（见 docs/7-缺陷复盘.md 缺陷三十三）。
 *
 * @module dsh-memory/core/config/validate
 */

import type { ConfigValidation, MemoryConfig } from './types.ts'

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

  inUnit('graph.topicFloor', config.graph.topicFloor)
  if (config.graph.topicFloor >= config.dedup.duplicateSimilarity) {
    // 连边下限不能达到「判为重复」的门槛：那样 every 边都连的是近似重复，
    // 而近似重复本该被合并掉，不是连起来。两条机制会互相拆台。
    errors.push('graph.topicFloor 必须小于 dedup.duplicateSimilarity')
  }
  if (!Number.isInteger(config.graph.topicNeighbors) || config.graph.topicNeighbors < 0) {
    errors.push('graph.topicNeighbors 必须是 ≥ 0 的整数')
  }
  // `same-entity` 的度数上限（P2-9）。与 `topicNeighbors` 同一口径：
  // 0 是合法的（表示不建 entity 边），负数与非整数不是——
  // 负数会让度数检查 `degree >= k` 恒真（一条边都产不出来，看起来像「关掉了」
  // 但其实是一个错值），非整数会让上界不是一个可解释的度数。
  if (!Number.isInteger(config.graph.entityNeighbors) || config.graph.entityNeighbors < 0) {
    errors.push('graph.entityNeighbors 必须是 ≥ 0 的整数')
  }

  if (config.extraction.domains.length === 0) errors.push('extraction.domains 不能为空')
  if (config.extraction.maxCardsPerTurn < 0) errors.push('extraction.maxCardsPerTurn 不能为负')
  // 情绪通道阈值（缺陷二十八）：必须是 `[0, 1]` 内的有限数。
  // 允许 1 表示「只有情绪拉满才放行」，等价于关闭该通道；但**不允许** > 1，
  // 那会让通道恒假，而它看起来只是「调高了一点」——恒假的判据和调参长得一样。
  inUnit('extraction.emotionalGateThreshold', config.extraction.emotionalGateThreshold)
  // 两张情绪词表都不能为空：空表会让 `computeEmotional` 恒返回 0（只剩标点项），
  // 于是整条情绪路径静默失效，而配置校验一句话都不会说。
  if (config.extraction.emotionalStrongKeywords.length === 0) {
    errors.push('extraction.emotionalStrongKeywords 不能为空（否则情绪强度恒为标点项）')
  }
  if (config.extraction.emotionalMediumKeywords.length === 0) {
    errors.push('extraction.emotionalMediumKeywords 不能为空（否则情绪强度被系统性低估）')
  }

  if (!Number.isInteger(config.storage.journalSegmentBytes) || config.storage.journalSegmentBytes < 4096) {
    errors.push('storage.journalSegmentBytes 必须是不小于 4096 的整数')
  }
  // 配置快照上限：负数会让「保留最后 N 条」变成「保留倒数 -N 条」，
  // `slice(-(-5))` 等于 `slice(5)`，于是台账被**截掉最新几条只留更早的**——
  // 与「改动可追溯」正好相反，而且不报错。
  if (!Number.isInteger(config.storage.configSnapshotMaxEntries) || config.storage.configSnapshotMaxEntries < 0) {
    errors.push('storage.configSnapshotMaxEntries 必须是非负整数')
  }
  // 压缩台账上限（P1-6）**不接受 0**，与上面两个「0 表示不限制」的上限不同：
  // 它们留 0 是「全留」，坏了只是文件变大；这里的 0 会被读成「一条都不留」，
  // 于是同一个 `compactionId` 每次都认不出来，**幂等在数学上恒为假**——
  // 一个不报错、不崩溃、只是每压缩一次就重复 flush 一遍的配置。
  // 上界 10000 是防手滑（比如误写 128000 想图省事），不是真实用量：
  // 默认 128 已经覆盖几十个会话。
  if (!Number.isInteger(config.storage.compactionLedgerMaxEntries) || config.storage.compactionLedgerMaxEntries < 1) {
    errors.push('storage.compactionLedgerMaxEntries 必须是 ≥ 1 的整数')
  }
  if (config.storage.compactionLedgerMaxEntries > 10000) {
    errors.push('storage.compactionLedgerMaxEntries 不应大于 10000（上限本身不该成为内存与落盘负担）')
  }

  if (config.consolidation.maxArchiveRatio > 1) errors.push('consolidation.maxArchiveRatio 必须 ≤ 1')
  if (config.consolidation.maxSummariesPerRun < 0) {
    errors.push('consolidation.maxSummariesPerRun 不能为负')
  }
  // 摘要字符上限必须 ≥ 1，否则摘要永远为空——那是悄悄关掉摘要功能，不是配置。
  for (const key of ['dailySummaryMaxChars', 'weeklySummaryMaxChars', 'monthlySummaryMaxChars'] as const) {
    if (config.consolidation[key] < 1) errors.push(`consolidation.${key} 必须 ≥ 1`)
  }
  // 层级越往上，摘要必须越短。这条校验是「层级压缩」的守门人：
  // 若周摘要比日摘要还长，「压缩」就只是名字，信息量并没有减少。
  if (config.consolidation.weeklySummaryMaxChars > config.consolidation.dailySummaryMaxChars) {
    errors.push('consolidation.weeklySummaryMaxChars 不应大于 dailySummaryMaxChars（层级越高应越短）')
  }
  if (config.consolidation.monthlySummaryMaxChars > config.consolidation.weeklySummaryMaxChars) {
    errors.push('consolidation.monthlySummaryMaxChars 不应大于 weeklySummaryMaxChars（层级越高应越短）')
  }
  inUnit('consolidation.distillMinEmotional', config.consolidation.distillMinEmotional)
  inUnit('consolidation.distillEdgeWeight', config.consolidation.distillEdgeWeight)
  inUnit('consolidation.summaryTargetRatio', config.consolidation.summaryTargetRatio)
  // 压缩比必须严格小于 1：等于 1 允许「摘要与原文一样长」，大于 1 允许更长，
  // 两者都让「压缩」变成纯命名。这条校验是假压缩的最后一道门。
  if (config.consolidation.summaryTargetRatio >= 1) {
    errors.push('consolidation.summaryTargetRatio 必须 < 1（否则允许产出不比原文短的「摘要」）')
  }
  if (config.consolidation.summaryMinSourceChars < 1) {
    errors.push('consolidation.summaryMinSourceChars 必须 ≥ 1')
  }
  if (config.consolidation.summaryMinChildren < 2) {
    errors.push('consolidation.summaryMinChildren 必须 ≥ 2（只有一个下级时是复制不是压缩）')
  }
  // `summaryMaxTags` 可以为 0：那表示摘要不列关键词（只留计数与领域）。
  // 不允许负数——「保留 −1 个」没有意义，而它会让 `slice(0, -1)` 静默截掉最后一个。
  if (config.consolidation.summaryMaxTags < 0) {
    errors.push('consolidation.summaryMaxTags 不能为负')
  }
  if (config.consolidation.distillMinRecurrence < 1) {
    errors.push('consolidation.distillMinRecurrence 必须 ≥ 1')
  }
  if (config.consolidation.distillThemeMinChars < 1) {
    errors.push('consolidation.distillThemeMinChars 必须 ≥ 1')
  }
  if (config.consolidation.distillMaxPerRun < 0) errors.push('consolidation.distillMaxPerRun 不能为负')
  if (config.consolidation.distillMaxChars < 1) errors.push('consolidation.distillMaxChars 必须 ≥ 1')
  if (!/^\d{2}:\d{2}$/u.test(config.consolidation.dailyAt)) {
    errors.push('consolidation.dailyAt 必须是 HH:mm 形式')
  }
  // 轮询间隔太短会空转烧 CPU，太长则提醒延迟不可接受（FR-D3）。
  if (config.reminder.pollMs < 1000) errors.push('reminder.pollMs 必须 ≥ 1000（1 秒）')

  // 图谱扩散（FR-G1）。这里的每条约束都对应一种「扩散会把召回带坏」的具体方式，
  // 不是形式化的范围检查——写校验时逐条想清楚了它拦住的是哪种坏结果。
  const sp = config.spread
  // mode 是字符串联合，TS 已经挡住非法值；但配置可能来自 JSON / 宿主 schema，
  // 运行时是 `unknown`。校验层是最后一道闸，所以这里仍要检查一次。
  if (sp.mode !== 'off' && sp.mode !== 'shadow' && sp.mode !== 'on') {
    errors.push(`spread.mode 必须是 'off' / 'shadow' / 'on' 之一，实际为 ${String(sp.mode)}`)
  }
  inUnit('spread.hopDecay', sp.hopDecay)
  inUnit('spread.maxBoost', sp.maxBoost)
  // hopDecay 必须严格小于 1：等于 1 时一跳传满，连通分量会被整体点亮，
  // 扩散退化成「全库提权」，与起源 L29「专注当前位置」直接冲突。
  if (sp.hopDecay >= 1) errors.push('spread.hopDecay 必须 < 1（等于 1 会让扩散退化成全库提权）')
  if (sp.hopDecay <= 0) errors.push('spread.hopDecay 必须 > 0（为 0 时扩散完全无效）')
  if (!Number.isInteger(sp.maxHops) || sp.maxHops < 1) {
    errors.push('spread.maxHops 必须是 ≥ 1 的整数')
  }
  // maxHops 上限 3：跳数越多，一次命中影响的面积越大。超过 3 跳时
  // hopDecay^3 已小于常见边权，收益趋近于噪声，却仍要付出遍历成本。
  if (sp.maxHops > 3) errors.push('spread.maxHops 不得大于 3（更远的跳数收益已是噪声）')
  // 护栏不能小于 1：小于 1 等于允许「自身不合格的卡靠邻居混进焦点包」，
  // 那会把 absoluteThreshold 的语义稀释掉（阈值本来是「这条记忆本身够不够格」）。
  if (sp.minSelfScoreRatio < 1) {
    errors.push('spread.minSelfScoreRatio 必须 ≥ 1（小于 1 会让不合格的卡靠邻居混进焦点包）')
  }
  // seedRatio 必须在开区间 (0, 1) 内，两端都会让扩散静默退化。
  //
  // 这条不是形式化的范围检查，它拦住的是一个已经发生过的真实缺陷：
  // 种子门槛曾与加分护栏相等，能加分的卡一定已经是种子，而种子不加分，
  // 于是 boost ⊆ ∅。当时 31 条单测全绿，因为没有任何一条走真实链路。
  if (!(sp.seedRatio > 0) || !(sp.seedRatio < 1)) {
    errors.push(
      `spread.seedRatio 必须在开区间 (0, 1) 内（实际 ${sp.seedRatio}）；`
      + '≥ 1 会没有卡够格当种子（无激活源），≤ 0 会让所有卡都是种子（无受益者），'
      + '两种情况扩散都恒为空集且看不出异常',
    )
  }
  if (!Number.isInteger(sp.maxAffected) || sp.maxAffected < 0) {
    errors.push('spread.maxAffected 必须是 ≥ 0 的整数')
  }
  // 来源文本长度必须是 ≥ 0 的整数：负数会让 `truncate` 产出空串，
  // 于是「显示了来源」和「没显示」在输出上无法区分。
  if (!Number.isInteger(sp.explainSourceChars) || sp.explainSourceChars < 0) {
    errors.push('spread.explainSourceChars 必须是 ≥ 0 的整数（0 表示只报数量不显示文本）')
  }
  if (sp.maxAffected > config.recall.maxCards) {
    errors.push('spread.maxAffected 不得大于 recall.maxCards（受影响面不该超过焦点包容量）')
  }
  // ## 可塑性尚未接线，打开它必须响亮失败（缺陷三十三）
  //
  // `reinforceEdges` / `decayEdges` / `prunableEdges` 三个纯函数已实现且通过测试，
  // 但 `src/` 下**没有任何生产代码调用它们**。实测：`plasticityEnabled` 打开与
  // 关闭各跑 10 夜整理，边权逐位相同、边数相同——这个开关是空操作。
  //
  // 为什么不能静默接受：**配置项的名字就是承诺**。用户写 `true` 是想要「一起被
  // 用到的连接变强」，实际行为却是「什么都没发生」。这比报错更坏，因为它会让
  // 人以为突触学习已经生效，从而永远不去查它从未生效。
  //
  // 为什么现在不接线：可塑性的驱动信号是「共激活」（这两张卡被一起用上了）。
  // 唯一能提供该信号的入口 `Engine.confirmRecall` 零调用方，而四个看起来可用的
  // 替代信号全部违反起源 L29（第 5 条·专注当前位置）——「被一起召回」是「看见」
  // 不是「使用」，用它驱动强化会让焦点包自我固化。详见 `src/core/spread.ts`
  // 头部注释与 `docs/3-架构设计.md` §7.2。
  if (sp.plasticityEnabled) {
    errors.push(
      'spread.plasticityEnabled 必须为 false：可塑性（边权随共激活变化）尚未接线，'
      + '打开它不会产生任何效果。已实现的只有扩散激活（spread.mode）。'
      + '接线前提是确认信号有可审计来源，见 docs/3-架构设计.md §7.2',
    )
  }
  // 下面四个参数当前**不参与任何生产逻辑**（可塑性未接线），但仍然是配置里的值，
  // 必须**无条件**校验：一个将来会炸的值，现在就报出来比留到接线那天好。
  //
  // 这段以前挂在 `if (sp.plasticityEnabled)` 里，注释写的是「关着的时候配错值
  // 不该拦住整个配置」。那个理由本身没错，但它让「校验写了」和「校验会执行」
  // 变成了两件事——开关一旦必须为 false，整块校验就成了不可达代码。
  if (sp.reinforceDelta <= 0) errors.push('spread.reinforceDelta 必须 > 0（否则强化永不发生）')
  // 分辨率判据（缺陷三十三）：一次共激活就撞顶的参数，等于让边权变成常数。
  //
  // 用的判据是不动点带的**中心** `w*(1) = delta × f / (1 − f) < maxEdgeWeight`。
  // **这个判据只是必要条件，不是充分条件**，必须说清它的三处局限：
  //
  // 1. 它只保证「n=1 不撞顶」，不保证能分辨 n=1..10。**带数**满足夹逼
  //    `ceil((1 − f) / 0.01) ≤ N_带 ≤ ceil((1 − f) / 0.01) + 1`（量化到 0.01 格点后），
  //    实测 `f=0.98` 取上端 3、`f=0.985` 取下端 2。
  //    **注意这是夹逼不是等式**：`N_带 === ceil(...) + 1` 只在 154/499 个 `f` 上成立。
  //    **但「档数」不是这个夹逼**（可达终值个数）：`N_档` 的界要宽一档，
  //    `ceil(...) − 1 ≤ N_档 ≤ ceil(...) + 1`（499/499，上端 104、居中 250、
  //    低于下端 145），`N_档 === ceil+1` 只有 104/499；且 `N_档 ≤ N_带` 恒成立。
  //    **「夹逼」必须带主语**，否则 154/499 这个真数字会被安到另一个量上。
  //    真正崩坏在 `f ≤ 0.5`（半衰期不足 1 夜，量化把权重抹平）。
  //    要 10 档需 `f ≤ 0.914`（半衰期 7.7 夜）——这条是直接实测的，不依赖公式。
  // 2. 中心不等于实测值：`delta=0.01, f=0.98, n=2` 时中心给 0.98，
  //    实测 0.74（差 24 个百分点），因为 `nextDecayedWeight` 有线性地板。
  // 3. 系统有多个吸引子，同一个 n 在不同初值下终值不同（25 个不同终值），
  //    所以「均衡点」本身不是一个良定义的函数。
  //
  // 那为什么还留着它：它是**唯一没有可调自由参数**的硬判据（n=1 是恒真下界），
  // 能挡住修复前那种 `delta=0.05 ⇒ w*(1)=2.45` 的配置——那种参数下
  // n=1..100 全部落在上限上，机制「实现齐全、测试全绿、配置齐备」，
  // 一旦接线就只会产出「全部等强」的图谱。**宁可挡住一个坏参数，
  // 也不要因为判据不完美就什么都不挡。**
  else if (sp.decayFactor > 0 && sp.decayFactor < 1) {
    const equilibriumAtOne = (sp.reinforceDelta * sp.decayFactor) / (1 - sp.decayFactor)
    if (equilibriumAtOne >= sp.maxEdgeWeight) {
      errors.push(
        'spread.reinforceDelta 过大：单次共激活的均衡边权'
        + ` ${equilibriumAtOne.toFixed(3)} 已达到或超过上限 ${sp.maxEdgeWeight}，`
        + '边权将无法区分使用频率（用一次和用一百次同一个值）。'
        + ` 需满足 reinforceDelta < maxEdgeWeight × (1 − decayFactor) / decayFactor`
        + ` = ${(sp.maxEdgeWeight * (1 - sp.decayFactor) / sp.decayFactor).toFixed(4)}，`
        + '见 docs/7-缺陷复盘.md 缺陷三十三',
      )
    }
  }
  if (sp.maxEdgeWeight <= 0 || sp.maxEdgeWeight > 1) {
    errors.push('spread.maxEdgeWeight 必须落在 (0, 1]')
  }
  // 衰减乘数必须落在 (0,1)：等于 1 永不衰减（剪枝永远不会触发），
  // 等于 0 一次巩固就清零（所有边瞬间失效）。
  if (sp.decayFactor <= 0 || sp.decayFactor >= 1) {
    errors.push('spread.decayFactor 必须落在 (0, 1)（等于 1 永不衰减，等于 0 一次清空）')
  }
  // 剪枝阈值必须小于边权上限，否则「上限本身就在剪枝区间里」，
  // 新建立的边会立刻被判失效。
  if (sp.pruneThreshold >= sp.maxEdgeWeight) {
    errors.push('spread.pruneThreshold 必须小于 spread.maxEdgeWeight')
  }
  if (!Number.isInteger(sp.maxPrunePerRun) || sp.maxPrunePerRun < 0) {
    errors.push('spread.maxPrunePerRun 必须是 ≥ 0 的整数')
  }
  return { ok: errors.length === 0, errors }
}
