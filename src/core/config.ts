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
  /**
   * 诊断日志文件名（FR-F1）；相对 `dataDir`。设空串表示**不落盘**。
   *
   * ## 必须放在子目录里，不能与事件日志同层
   *
   * 事件日志分片形如 `journal-000001.jsonl`。诊断日志若也叫
   * `dataDir/*.jsonl`，两者在**目录层面就分不开**：任何按 `*.jsonl`
   * 扫描 `dataDir` 的东西（备份脚本、日志采集器、用户自己 `ls *.jsonl`）
   * 都会把旁路诊断记录当成事件日志。
   *
   * 这不是假设——加上落盘之后 `tests/cli/memoryctl.test.ts` 的
   * `journalSize` 辅助函数立刻红了（它按后缀扫顶层、断言恰好一个文件）。
   * 那条断言守的是真实不变量，**该改的是实现不是测试**。
   *
   * 生产代码本身没被污染（`listShardFiles` 用 `journal-` 前缀 + 数字校验），
   * 但这只说明「本仓库的读法安全」，管不了目录外面的人怎么读。
   */
  logFile: string
  /**
   * 诊断日志最多保留多少条（环形缓冲）。
   *
   * 设 0 表示不限制——**不建议**：FR-F1 要的是「最近 N 次」，
   * 无限增长会让一个长期运行的记忆库攒出几百 MB 的旁路文件。
   */
  logMaxEntries: number
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

  /**
   * 是否产出日 / 周 / 月摘要（FR-D4 / 起源 L27）。
   *
   * 起源 L27（第 4 条·渐进累积与夜间整理）：「今日记忆渐进累积，夜晚休眠整理，
   * 很长时间迭代」。摘要就是「迭代」的载体——一天压成一张，再往上压成周、月，
   * 层级本身就是长时间迭代的形态。
   */
  summaryEnabled: boolean
  /** 单次整理最多新建几张摘要卡，保证耗时可控（P8）。 */
  maxSummariesPerRun: number
  /**
   * 日摘要文本的字符上限。
   *
   * 这个上限是**压缩的强制手段**，不是排版偏好：日摘要如果只是把当天卡片的
   * 文本拼起来，信息量与原文相等，压缩比 1:1，那就不是压缩而是换了个地方存。
   * 字符上限让「摘要」在物理上不可能退化成「日志」。
   */
  dailySummaryMaxChars: number
  /** 周摘要文本的字符上限。 */
  weeklySummaryMaxChars: number
  /** 月摘要文本的字符上限。 */
  monthlySummaryMaxChars: number
  /**
   * 摘要相对来源的目标压缩比（0..1）。
   *
   * 这是压缩的**算术闸门**：摘要字符数不超过「来源总字符数 × 该比例」。
   * 有了它，「摘要比原文短」就是算出来的必然结果，而不是靠自觉。
   * 配置层拒绝 `>= 1` 的值——那等于允许摘要不比原文短，压缩就只是名字。
   */
  summaryTargetRatio: number
  /**
   * 产出摘要所需的最小来源字符数。
   *
   * 一天只有一张 20 字的卡时，「摘要」不可能比原文短。硬做出来的东西
   * 是**假压缩**：比原文长，还多占一条记录。宁可承认这一天不需要压缩。
   */
  summaryMinSourceChars: number
  /**
   * 上一级摘要所需的最少下级摘要数量。
   *
   * 一周只有一天有记录时，周摘要与那天的日摘要内容几乎相同——那不是压缩，
   * 是复制。层级的意义来自「多个下级被合成一个」，只有一个下级时它不成立。
   */
  summaryMinChildren: number
  /** 摘要卡最多保留的关键实体数。 */
  summaryMaxEntities: number
  /** 摘要卡最多保留的关键标签数。 */
  summaryMaxTags: number
  /** 摘要里「最值得记住的一件事」的引用字符数，超长截断。 */
  summaryBriefChars: number

  /**
   * 是否从事件卡蒸馏感受卡（起源 L11）。
   *
   * 起源 L11（无编号·细节会忘）：「其实我们大多数细节都会忘记，只会留下感受。」
   * 关掉它，系统就只剩「记住细节」这一半能力。
   */
  distillEnabled: boolean
  /**
   * 触发蒸馏的最低平均情绪强度。
   *
   * 低于它说明这一天只是「有事发生」，还谈不上「有感受」——宁可不出感受卡，
   * 也不要给每一天都硬造一条感受，那会让感受层变成噪声层。
   */
  distillMinEmotional: number
  /** 同一主题至少出现在几张带情绪的卡里，才算「反复经历」。 */
  distillMinRecurrence: number
  /**
   * 主题词项的最小字符数。
   *
   * 短词项（单字、高频二元组）在几乎每张卡里都出现，拿它当主题等于没有主题：
   * 所有卡被聚成同一个桶，蒸馏退化成「今天发生了很多事」。
   */
  distillThemeMinChars: number
  /** 一次整理最多蒸馏出几条感受，防止一天产出过多（P8）。 */
  distillMaxPerRun: number
  /** 感受卡文本的字符上限。 */
  distillMaxChars: number
  /** 感受卡里引用一个具体例子的字符数，超长截断。 */
  distillExampleChars: number
  /** 感受卡指向来源事件卡的 `distills` 边权重（0..1）。 */
  distillEdgeWeight: number
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
  /**
   * cron 表达式向后搜索的天数上限（FR-D3 的 cron 分支）。
   *
   * 必须有上界：`0 0 30 2 *`（2 月 30 日）永不存在，没有上界就是死循环。
   * 默认 366 天覆盖闰年周期——「每年 2 月 29 日」这类表达式最坏要
   * 找将近 4 年才命中一次，所以 366 只是**单次调用**的上界，
   * 跨年搜索由调用方按需要调大。
   *
   * 不写死字面量：它是可标定参数，用户可能想要「只看未来 30 天」。
   */
  cronSearchDays: number
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
  /** 图谱扩散与突触可塑性策略（FR-G1）。 */
  spread: SpreadPolicy
  /** 调试开关：记录每次召回的解释。 */
  debugExplain: boolean
}

/**
 * 扩散激活的工作模式。
 *
 * 三种状态互斥，用一个字段表达而不是两个布尔（`enabled` + `shadow`）：
 * 后者能造出「关掉了但还在影子计算」这种自相矛盾的组合，
 * 而互斥的字符串联合从类型上就不允许它存在。
 *
 * - `off`：完全不计算扩散。链路退化成「只看单卡分数」，
 *   与引入本功能之前逐位相同（FR-F4 可回滚）。
 * - `shadow`：**照常计算，但不改变召回结果**。扩散会算出「哪些卡本该
 *   被提权、提了多少、因为谁」，这些信息写进 `ScoredCard.shadowSpread`，
 *   排序与注入内容一字不动。
 *   注意：**不进 `explain`**——`explain` 会被人读渲染打印，假设值出现在
 *   那里会让读者以为它已经生效了。
 * - `on`：扩散真实参与排序。
 *
 * 为什么需要 `shadow`：FR-G1 的触发条件是「积累了 2 周真实数据」，
 * 而现在一条真实数据都没有。`on` 等于让一个未经检验的机制悄悄改变
 * 每一次召回；`off` 又等于永远无法积累「它到底会怎么改」的证据——
 * 而那份证据正是判断该不该打开它的依据。`shadow` 让两者同时成立：
 * **可见，但不生效。**
 */
export type SpreadMode = 'off' | 'shadow' | 'on'

/**
 * 图谱扩散与突触可塑性（FR-G1）。
 *
 * 起源 L15（无编号·图谱）：「我需要一种建立记忆图谱的方法，且跨层次关联。」
 * 「跨层次关联」如果只是把边存下来、查询时能看见，那图谱就只是一张示意图——
 * 一张卡被想起时，与它相连的卡不会因此更容易被想起。本段参数让边**参与计算**。
 *
 * 需求归属：`docs/1-需求规格.md` FR-G1「突触学习与图谱扩散」。
 * 该条在 §7.7「后续扩展」里，触发条件是「稳定记忆跑通、积累了 2 周真实数据」。
 * 这里提前实现的是它的**规则部分**（扩散、可塑性、剪枝），不含任何语义判断
 * （`causes` / `part-of` / `contrasts` 三类语义边仍然无产出点，见 `types.ts`）。
 *
 * 字段分工见 {@link SpreadPolicy}；模式语义见 {@link SpreadMode}。
 */
export interface SpreadPolicy {
  /**
   * 扩散激活的工作模式，见 {@link SpreadMode}。
   *
   * 默认 `'shadow'`：能看见扩散想做什么，但不让它改变召回结果。
   * 这是「可回滚开关」（FR-F4）与「未验证不上生产」两条约束的交点。
   */
  mode: SpreadMode
  /**
   * 每跳衰减系数（0..1）。
   *
   * 命中卡的激活量传给邻居时乘以它。小于 1 是**级联的必要条件**：
   * 若等于 1，一跳就能传满，任意连通分量会被整个点亮，扩散变成「全库提权」。
   */
  hopDecay: number
  /** 最大扩散跳数。1 表示只看直接邻居，2 表示邻居的邻居。 */
  maxHops: number
  /**
   * 单张卡从扩散中获得的**最大加分**（0..1，加在归一化总分上）。
   *
   * 必须有上限，否则「连接多的卡」会系统性压过「内容匹配的卡」——
   * 那是把图谱变成人气的排行榜，而不是记忆。上限让扩散只能微调排序。
   */
  maxBoost: number
  /**
   * 扩散进来的卡自身必须达到的分数下限（相对 `absoluteThreshold` 的倍数）。
   *
   * 这是**护栏**：只靠邻居混进焦点包的卡，会把 `absoluteThreshold`
   * 的语义稀释掉（阈值本来是「这条记忆本身够不够格」）。取 1.0 表示
   * 「扩散可以帮忙排序，但不能让一张本来不合格的卡合格」。
   */
  minSelfScoreRatio: number
  /**
   * 成为**种子**所需的分数下限，**相对本次候选池的最高分**（0 < seedRatio < 1）。
   *
   * ## 为什么这个参数必须存在（这是一个被实测抓出来的设计缺陷）
   *
   * 最初的实现里种子判据是 `total >= absoluteThreshold`，而加分护栏是
   * `selfScore >= absoluteThreshold * minSelfScoreRatio`，且
   * `minSelfScoreRatio` 被校验强制 ≥ 1。于是：
   *
   * ```text
   * 加分门槛 (0.18 × 1 = 0.18)  ≥  种子门槛 (0.18)
   * ⇒ 能加分的卡一定已经是种子
   * ⇒ 而种子自己不因扩散加分
   * ⇒ boost 恒为空集
   * ```
   *
   * **整个扩散机制在数学上恒为空。** 31 条单测全绿，因为它们各自构造了
   * 现实链路里不可能出现的状态（把「谁是种子」和「谁被加分」分开造）。
   * 反向验证时把种子判据改成恒 false，只有 2 条断言变红——原本那条
   * 「扩散能把卡推进焦点包」写的是 `after >= before`，等式成立也算通过。
   *
   * ## 为什么不能用「绝对阈值 × 倍数」来标定种子
   *
   * 第一次修复时我改成 `seedRatio = 1.5`（门槛 0.18 × 1.5 = 0.27），
   * 实测**仍然是空集**。原因是打分有基础分下限：即使完全不相关的两句话，
   * 分数也在 0.33 左右（importance / recency / confidence 三项各贡献一份），
   * 而 `absoluteThreshold = 0.18` **永远拦不住任何卡**。实测 12 个样本
   * 最低 0.3295，无一低于 0.18。
   *
   * 所以任何「阈值 × 倍数」形式的门槛都会落在所有卡之下，全部卡都成种子，
   * 扩散依然恒空。**绝对量标定在这个打分公式下没有意义。**
   *
   * ## 正解：相对本次最高分
   *
   * 种子门槛 = `max(候选池总分) × seedRatio`。这是无量纲量，自动跟着
   * 本轮查询的分数分布走：查询精确时最高分高，门槛也高；查询模糊时
   * 最高分低，门槛也低。它衡量的不是「这张卡够不够格」，而是
   * **「这张卡在本轮里够不够强」**——这正是「值得把自己的激活撒出去」的判据。
   *
   * ## 为什么两端都必须开区间（0 < seedRatio < 1）
   *
   * 两端各自会让扩散退化，且退化后**看不出异常**：
   * - `>= 1`：门槛不低于最高分，可能没有卡够格 ⇒ 没有种子 ⇒ 无激活源。
   * - `<= 0`：所有卡都是种子 ⇒ 没有「非种子」可被推动 ⇒ 无受益者。
   *
   * 由配置校验强制。默认 0.85：只有分数接近本轮最高分的那几张才算强命中。
   */
  seedRatio: number
  /**
   * 同一次召回中，扩散最多影响多少张卡。
   *
   * 与 `maxBoost` 是两道独立的闸：`maxBoost` 限制单卡收益，
   * 这里限制受影响面。没有它，一次强命中可能改写整个候选池的排序，
   * 让「专注当前位置」（起源 L29）失效。
   */
  maxAffected: number
  /**
   * 是否让 `distills` 边反向传播。
   *
   * 起源 L11（无编号·细节会忘）：「其实我们大多数细节都会忘记，只会留下感受。」
   * `distills` 边的方向是「感受卡 → 来源事件卡」。严格按有向边传播时，
   * 命中一条**细节**不会唤起它的**感受**——恰恰与 L11 的意图相反：
   * 细节该忘、感受该留，所以想起细节时感受应当更容易浮现。
   * 开启后 `distills` 边双向传播，其余边仍严格单向。
   */
  distillBidirectional: boolean

  /* ---- 突触可塑性（边权随时间与共激活变化） ---- */

  /**
   * 是否启用边权可塑性。
   *
   * 关掉时边权停在建立时的初始值，只有扩散生效。
   */
  plasticityEnabled: boolean
  /** 共激活时边权增量（赫布学习：一起被用到的连接变强）。 */
  reinforceDelta: number
  /** 边权上限，防止无限增长到「一条边压过一切」。 */
  maxEdgeWeight: number
  /** 每次巩固时边权的衰减乘数（0..1），模拟久不用的连接变弱。 */
  decayFactor: number
  /** 边权低于该值即视为失效并删除（突触剪枝）。 */
  pruneThreshold: number
  /** 单次巩固最多删除多少条失效边，保证耗时可控（P8）。 */
  maxPrunePerRun: number
  /**
   * 人读解释里，每张来源卡最多显示多少个字符（0 表示只报数量不显示文本）。
   *
   * ## 为什么需要这个参数
   *
   * 用户要的是「类似神经的突触效果」。突触效果的可感知形态不是「分数高了
   * 一点」，而是**能说出「因为想起 A，所以想起 B」**。只显示「来自 2 张关联卡」
   * 时，读者知道有来源却不知道是哪两张，扩散在观感上仍是「莫名加分」。
   *
   * ## 为什么必须可配置且默认很小
   *
   * 这一行**只进人读渲染**（`/memory explain` 与 CLI `query`），不进注入上下文
   * ——起源 L17（无编号·上下文污染）要求注入文本里不能有这类解释。
   * 但它仍然要短：终端里一行塞两张 40 字的卡会把解释淹掉。
   * 默认 24 字，够看清是哪条记忆，又不至于喧宾夺主。
   *
   * 设为 0 时退回「只报数量」的行为，用于终端极窄或不想看文本的场景。
   */
  explainSourceChars: number
}

/** 默认配置。改这里必须同时递增 {@link MEMORY_CONFIG_VERSION}。 */
export const DEFAULT_CONFIG: MemoryConfig = {
  configVersion: 8,
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
    logFile: 'logs/diagnostics.jsonl',
    logMaxEntries: 500,
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
    reinforceDelta: 0.05,
    maxEdgeWeight: 1,
    decayFactor: 0.98,
    pruneThreshold: 0.1,
    maxPrunePerRun: 200,
    explainSourceChars: 24,
  },
  debugExplain: true,
}

/** 当前配置版本号，与 {@link DEFAULT_CONFIG}.configVersion 保持一致。 */
export const MEMORY_CONFIG_VERSION = 8

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
  if (config.consolidation.summaryMaxEntities < 0) {
    errors.push('consolidation.summaryMaxEntities 不能为负')
  }
  if (config.consolidation.distillMinRecurrence < 1) {
    errors.push('consolidation.distillMinRecurrence 必须 ≥ 1')
  }
  if (config.consolidation.distillThemeMinChars < 1) {
    errors.push('consolidation.distillThemeMinChars 必须 ≥ 1')
  }
  if (config.consolidation.distillMaxPerRun < 0) errors.push('consolidation.distillMaxPerRun 不能为负')
  if (config.consolidation.distillMaxChars < 1) errors.push('consolidation.distillMaxChars 必须 ≥ 1')
  if (config.consolidation.distillExampleChars < 1) errors.push('consolidation.distillExampleChars 必须 ≥ 1')
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
  // 可塑性参数只在启用时才要求合法：关着的时候配错值不该拦住整个配置。
  if (sp.plasticityEnabled) {
    if (sp.reinforceDelta <= 0) errors.push('spread.reinforceDelta 必须 > 0（否则强化永不发生）')
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
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 把旧版 `spread.enabled`（布尔）迁移成 `spread.mode`（三态）。
 *
 * 为什么需要迁移而不是直接忽略：`enabled` 在配置版本 4 及以前是扩散的开关，
 * 版本 5 换成了三态 `mode`。若只是把新字段加进去，`{ spread: { enabled: true } }`
 * 这种旧配置会**静默降级**成默认的 `'shadow'`——用户明确要求「打开扩散」，
 * 系统却回答「好的，我不改排序」。不报错、不告警、行为与用户意图相反，
 * 而且事后无从发现。这正是本仓库反复吃亏的那一类缺陷。
 *
 * 映射关系（`enabled` 原本的语义就是这个）：
 * - `true`  → `'on'`：扩散真实参与排序，与旧版行为逐位一致。
 * - `false` → `'off'`：完全不计算，与旧版行为逐位一致。
 *
 * **显式写了 `mode` 时以 `mode` 为准**：新字段是新事实，旧字段只用来补空缺。
 * 两个都写是用户自己矛盾，不替他猜，`mode` 是更具体的那个。
 *
 * **写了 `mode` 但不合法时必须原样透传，不能退回 fallback。**
 * 这条是被实测逼出来的：YAML 1.1 里无引号的 `on` 是**布尔值**，用户在 patch
 * 里写 `mode: on`（极自然的写法）时，宿主拿到的是 `true`。若这里退回
 * fallback，结果是 `mode` 变成 `'shadow'`——**不报错、不崩溃、测试全绿**，
 * 用户以为打开了扩散，实际跑的是影子模式。静默降级比加载期崩溃更坏：
 * 崩溃会让人立刻改，降级会让人一直以为自己开了。
 *
 * 所以非法值一律透传成 `mode` 的值本身，交给 `validateConfig` 报错。
 * 类型上要 `as SpreadMode`——这是**故意的**：这一层的职责是把用户的输入
 * 原样送到校验层，而不是替校验层做决定。`validateConfig` 会因此给出
 * 「spread.mode 必须是 'off' / 'shadow' / 'on' 之一，实际为 true」。
 *
 * 迁移后**不把 `enabled` 带进结果**：留着一个已无读者的字段，下一个人会以为
 * 它还在起作用。配置对象的形状必须与代码实际读的字段一致。
 *
 * @param override - 用户提供的 spread 段（可能含旧字段）。
 * @param fallback - 合并前的 `mode`（默认值或 base 里的值）。
 * @returns 迁移后的 `mode`；用户写了非法值时原样返回该值，交给校验层拒绝。
 */
function migrateSpreadMode(override: unknown, fallback: SpreadMode): SpreadMode {
  if (typeof override !== 'object' || override === null) return fallback
  const partial = override as { mode?: unknown; enabled?: unknown }
  // 显式写了合法 mode 时，新字段优先。
  if (partial.mode === 'off' || partial.mode === 'shadow' || partial.mode === 'on') return partial.mode
  // 写了 mode 但不合法：原样透传给校验层，绝不静默退回 fallback。
  // 典型来源是 YAML 1.1 把裸 `on` 解析成布尔 `true`。
  if (partial.mode !== undefined) return partial.mode as SpreadMode
  // 没写 mode 时才退回旧布尔字段。
  if (partial.enabled === true) return 'on'
  if (partial.enabled === false) return 'off'
  return fallback
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
  // `spread` 段要单独处理：它可能含旧版布尔字段 `enabled`，见 `migrateSpreadMode`。
  const { spread: spreadOverride, ...restOverride } = override
  const spreadFields = { ...base.spread, ...spreadOverride } as Record<string, unknown>
  // 旧字段不许留在结果里——它已经没有任何读者，留着只会误导。
  delete spreadFields.enabled
  spreadFields.mode = migrateSpreadMode(spreadOverride, base.spread.mode)

  const merged: MemoryConfig = {
    configVersion: override.configVersion ?? base.configVersion,
    weights: { ...base.weights, ...restOverride.weights },
    recall: { ...base.recall, ...restOverride.recall },
    forgetting: { ...base.forgetting, ...restOverride.forgetting },
    dedup: { ...base.dedup, ...restOverride.dedup },
    extraction: { ...base.extraction, ...restOverride.extraction },
    storage: { ...base.storage, ...restOverride.storage },
    consolidation: { ...base.consolidation, ...restOverride.consolidation },
    reminder: { ...base.reminder, ...restOverride.reminder },
    spread: spreadFields as unknown as SpreadPolicy,
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
