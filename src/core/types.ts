/**
 * 稳定记忆系统的共享契约层。
 *
 * 本文件只定义类型与常量，不含任何逻辑，也不依赖任何宿主包（DSH / Cordis）。
 * 数据面、行为面、适配面三方都以本文件为准，因此它必须先于其余模块稳定下来。
 *
 * 设计依据：`docs/0-起源.md`（最终目标）、`docs/1-需求规格.md`（v0.2 需求）、
 * `docs/2-DSH宿主约束.md`（宿主边界）。
 *
 * @module dsh-memory/core/types
 */

/* ------------------------------------------------------------------ *
 * 一、记忆域：起源里的「生活 / 学习 / 工作 三个记忆模块，可插拔」
 * ------------------------------------------------------------------ */

/**
 * 记忆域（Memory Domain）。
 *
 * 对应起源 L13（无编号）：把生活、学习、工作拆成三个记忆模块，可插拔
 * （同时存在，或者只有一个）。域是**最外层的分区键**，跨域关联通过
 * {@link MemoryEdge} 表达，不做物理合并。
 */
export type MemoryDomain = 'work' | 'study' | 'life'

/** 全部内置记忆域，按起源给出的顺序排列。 */
export const MEMORY_DOMAINS: readonly MemoryDomain[] = ['work', 'study', 'life']

/* ------------------------------------------------------------------ *
 * 二、记忆卡：记忆的最小存储单元
 * ------------------------------------------------------------------ */

/**
 * 记忆卡类型（Memory Kind）。
 *
 * - `event`      事件：发生过什么（「昨天部署失败了」）
 * - `fact`       事实：稳定成立的结论（「这个项目用 Qt5」）
 * - `promise`    承诺：未到期的事项，永不自动归档（「下周一前给结论」）
 * - `concept`    概念：定义、术语、原理
 * - `feeling`    感受：起源「我们大多数细节都会忘记，只会留下感受」
 * - `experience` 经验：从事件里沉淀下来的可复用做法（起源「经验的写入和回忆」）
 * - `summary`    摘要：一天/一周/一月记忆的**压缩**结果（FR-D4 / 起源 L27（第 4 条·今日记忆渐进累积））
 *
 * `feeling` 与 `experience` 是对起源 L11（细节会忘只留感受）与 L19（感受与经验的
 * 写入和回忆）的直接落地：细节可以忘，
 * 感受与经验必须留下。
 *
 * `summary` 与其余六种的关系是**层次**而不是并列：其余六种描述「发生了什么」，
 * `summary` 描述「那段时间整体是什么样的」。它不是日志拼接——日志拼接的信息量
 * 与原文相等，压缩比是 1:1，那就没有压缩（见 `src/consolidate/summarize.ts`）。
 */
export type MemoryKind =
  | 'event' | 'fact' | 'promise' | 'concept' | 'feeling' | 'experience' | 'summary'

/** 全部记忆卡类型。 */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'event', 'fact', 'promise', 'concept', 'feeling', 'experience', 'summary',
]

/** 记忆卡生命周期状态。归档不等于删除，随时可恢复（FR-C2）。 */
export type MemoryStatus = 'active' | 'archived'

/**
 * 来源指针（Source Pointer）。
 *
 * 需求 FR-A4：每张卡必须能定位回原始会话事件。
 * `seq` 是会话日志里的全局事件序号，是唯一定位基准；其余字段便于人读。
 */
export interface SourcePointer {
  /** 会话 id（宿主 Session id）。 */
  sessionId: string
  /** 轮次号，从 1 开始。 */
  turn: number
  /** 步骤号，从 1 开始。 */
  step: number
  /** 会话事件全局序号，定位原文的权威依据。 */
  seq: number
  /** 原始事件类型，例如 `user/message`、`assistant/message`。 */
  eventType: string
}

/**
 * 修正记录（Revision）。
 *
 * 需求 FR-A5：同一事实被更新时保留旧版本，可查「改过什么、为什么」。
 */
export interface MemoryRevision {
  /** 修正发生的时刻（毫秒时间戳）。 */
  at: number
  /** 修正原因，人可读。 */
  reason: string
  /** 被替换掉的旧摘要文本。 */
  previousText: string
  /** 谁发起的修正。 */
  actor: 'system' | 'consolidation' | 'manual'
}

/**
 * 记忆卡（Memory Card）——记忆的最小存储单元。
 *
 * 字段分四组：
 * 1. **身份**：`id` / `domain` / `kind`
 * 2. **内容**：`text` / `normalized` / `tags` / `entities`
 * 3. **溯源**：`source` / `revisions` / `conflictOf` / `mergeOf` / `mergedInto`
 * 4. **强度**：`salience` / `confidence` / `emotional` / `strength` / `accessCount` / `lastAccessAt`
 */
export interface MemoryCard {
  /** 稳定 id。由 {@link buildCardId} 由「域 + 来源 + 类型 + 归一化文本」派生，天然幂等。 */
  id: string
  /** 所属记忆域。 */
  domain: MemoryDomain
  /** 卡片类型。 */
  kind: MemoryKind
  /** 摘要文本（中文为主），进入上下文的就是这段。 */
  text: string
  /** 归一化文本，仅用于去重与相似度，不进入上下文。 */
  normalized: string
  /** 事件发生时刻（毫秒时间戳）。 */
  createdAt: number
  /** 最后一次内容变更时刻（毫秒时间戳）。 */
  updatedAt: number
  /** 来源指针。 */
  source: SourcePointer
  /** 显著性 0..1：写入时评估的「这件事值不值得记」。 */
  salience: number
  /** 置信度 0..1：这条记忆有多可信。 */
  confidence: number
  /**
   * 情绪强度 0..1。
   *
   * 起源 L3（无编号）：「激素是关键，大脑皮层只是记忆」。本阶段不做情绪系统，
   * 只把情绪强度作为**记忆强度的调制量**——强烈的感受更容易被记住、更难被归档。
   */
  emotional: number
  /** 当前激活强度 0..1，随时间和访问变化，是遗忘曲线的主体。 */
  strength: number
  /** 被召回次数。 */
  accessCount: number
  /** 最后一次被召回的时刻；从未召回为 `null`。 */
  lastAccessAt: number | null
  /** 标签，供规则检索与图谱连边使用。 */
  tags: string[]
  /** 实体锚点（人名、项目、文件、术语），是「跨层次关联」的连接点。 */
  entities: string[]
  /** 修正历史，最新的在末尾。 */
  revisions: MemoryRevision[]
  /** 生命周期状态。 */
  status: MemoryStatus
  /** 与之冲突的卡片 id 列表（FR-B5：冲突必须显式暴露）。 */
  conflictOf: string[]
  /** 是否钉住：钉住的卡永不自动归档（FR-C3：承诺、核心事实、长期偏好）。 */
  pinned: boolean
  /** 被合并进哪张卡（本卡作废但保留溯源）。 */
  mergedInto?: string
  /** 本卡合并了哪些卡。 */
  mergeOf?: string[]
  /** 到期时刻，承诺/提醒类使用（FR-D3）。 */
  dueAt?: number | null
  /**
   * 重复方式（FR-D3）。`'once'` / 缺省表示一次性。
   *
   * 为什么必须落在这张卡上而不是每次重新解析文本：提醒响过之后
   * 要能算出**下一次**到期时刻，而那一刻手上只有卡片、没有原始语境。
   * 只存 `dueAt` 的话，「每日提醒」在响过一次之后就与「一次性提醒」
   * 无法区分了——这正是 FR-D3 曾经永久静默的根因。
   */
  dueRepeat?: DueRepeat
}

/**
 * 到期提醒的重复方式（FR-D3）。
 *
 * 定义在契约层而不是 `src/time/due.ts`，因为 {@link MemoryCard} 要引用它，
 * 而依赖方向是 `time/ → core/`（`src/time/clock.ts` 就 import 了本文件）。
 * 反过来定义会让 core 依赖 time，破坏分层。
 */
export type DueRepeat = 'once' | 'daily' | 'weekly'

/* ------------------------------------------------------------------ *
 * 三、记忆图谱：起源「建立记忆图谱的方法，且跨层次关联」
 * ------------------------------------------------------------------ */

/**
 * 图谱边的语义类型。
 *
 * 「跨层次关联」在本系统里有两个正交的层次轴：**域**（生活/学习/工作）
 * 与**类型**（事件/事实/感受/经验…）。边允许跨越任一轴，这就是图谱
 * 区别于「一堆孤立卡片」的地方。
 *
 * **已产出**（有实现 + 需求承接）：
 * - `same-entity` / `same-topic`：起源 L15（无编号·图谱），`src/consolidate/graph.ts`
 * - `supersedes`：FR-A5 修正版本，`src/store/state.ts` merge 分支 + `src/core/graph.ts`
 * - `distills`：起源 L11（无编号·细节会忘）+ FR-C5，`src/core/graph.ts` `distillEdges`
 *
 * **预留，当前无任何产出点**：`causes` / `part-of` / `contrasts`。
 * 实现归属 FR-G1（突触学习与图谱扩散），触发条件是「稳定记忆跑通、
 * 积累了 2 周真实数据」。
 *
 * **为什么保留而不删除**：事件日志是唯一真相源（P2）且**只追加**，删掉枚举值
 * 不等于删掉死代码，而是让**已经写在日志里的边**在重放时无处安放。两种后果
 * 都很糟，且都不明显：
 *
 * 1. **反序列化层拒绝** → 整个日志打不开。一条边读不出来，全部记忆陪葬。
 * 2. **反序列化层透传** → 内存里出现一个不在 `EdgeRelation` 里的值，
 *    **类型系统开始撒谎**：`switch` 静默走 `default`、穷尽性检查失效。
 *    这正是 `coerceKind` 那个坑的同源问题（见 `docs/3-架构设计.md` §4.2）——
 *    当时是投影层把未知 `kind` 降级成 `fact`，日志写 A、重放得 B。
 *
 * 注意第 2 种的**陷阱**：将来有人看到「透传导致类型撒谎」，很自然会去把
 * 反序列化层改成「拒绝」——那是把后果 2 换成后果 1，**更糟**。两难的正解
 * 是保留枚举值：**「合法的未知值」必须在类型里有位置**，这才叫前向兼容。
 *
 * **不要以为它们现在能用。** 一个读者看到 `'causes'` 在类型里，会以为系统
 * 能建因果边，然后写一个查询去取它、取到空、再花半天查为什么。
 *
 * 为什么不做：这三个都是**语义判断**（因果 / 组成 / 结论相反），规则做不出来。
 * 用关键词硬凑会产出**假边**——而图谱是用来溯源的，**假边比没有边更糟**：
 * 没有边时你知道「这里没有信息」，假边会让你把溯源指向错的地方，且无从发现。
 *
 * `contrasts` 尤其要说明：它**不是「没做」，是用别的方式做了**。
 * 冲突检测走 `src/core/scoring.ts` 的 `conflictPenalty`（FR-B5）+
 * `src/core/extraction.ts` 的 `looksConflicting`，结论落在卡片分数上而不是
 * 边上。**不要再去实现一个已经存在的东西。**
 *
 * 之所以要在这里写这么长：本条遗留项真正的问题不是「七种只实现四种」，
 * 而是**没有一处说明哪些已实现、哪些是预留**——读者会以为全都能用。
 * 「预留」和「没做」在代码里长得一模一样，区别只在文档里。
 */
export type EdgeRelation =
  /** 同一话题：文本高度相似但非重复。 */
  | 'same-topic'
  /** 同一实体：共享实体锚点（同一个人、同一个项目）。 */
  | 'same-entity'
  /** 因果：A 导致 B。**预留，无产出点**（见上方类型注释）。 */
  | 'causes'
  /** 取代：B 是 A 的新版本（修正后的关联）。 */
  | 'supersedes'
  /** 部分：A 是 B 的组成部分。**预留，无产出点**（见上方类型注释）。 */
  | 'part-of'
  /** 对照：A 与 B 结论相反。**预留，无产出点**；冲突检测走 `conflictPenalty`。 */
  | 'contrasts'
  /**
   * 经验沉淀：从事件里提炼出感受/经验，**方向是「提炼物 → 来源」**。
   *
   * 起源 L11（无编号·细节会忘）：「其实我们大多数细节都会忘记，只会留下感受。」
   * 起源 L19（无编号·感受经验）：「那么如何出现感受和经验的写入和回忆呢？」
   *
   * 注意方向：`distills` 是「感受卡 → 来源事件卡」，与 `supersedes` 的
   * 「旧 → 新」相反。两者若同向，图谱上就无法区分「被取代」与「被提炼」，
   * 溯源时会读反。产出点：`src/core/graph.ts` `distillEdges`。
   */
  | 'distills'

/** 全部图谱边类型。 */
export const EDGE_RELATIONS: readonly EdgeRelation[] = [
  'same-topic', 'same-entity', 'causes', 'supersedes', 'part-of', 'contrasts', 'distills',
]

/** 记忆图谱的一条有向边。 */
export interface MemoryEdge {
  /** 边 id，由 {@link buildEdgeId} 派生，保证同一对节点同一关系只有一条边。 */
  id: string
  /** 起点卡 id。 */
  from: string
  /** 终点卡 id。 */
  to: string
  /** 边语义。 */
  relation: EdgeRelation
  /** 边权 0..1，参与扩散打分。 */
  weight: number
  /** 建立时刻。 */
  createdAt: number
}

/* ------------------------------------------------------------------ *
 * 四、打分与焦点包：召回的可解释性与确定性
 * ------------------------------------------------------------------ */

/**
 * 一条记忆的分数构成。
 *
 * 需求 FR-B1 / FR-B4：分数必须可分解、可解释，能回答「为什么想起这条」。
 * 全部为纯确定性计算，不含随机项（ST-1：同状态同查询 10 次结果一致）。
 */
export interface ScoreBreakdown {
  /** 语义相关 0..1：词项重叠 + 标签 + 实体命中。 */
  semantic: number
  /** 重要性 0..1：显著性、情绪强度、访问频次的合成。 */
  importance: number
  /** 时间新鲜度 0..1：由 Δt 与衰减常数算出，非模型推断（FR-D2）。 */
  recency: number
  /** 目标匹配 0..1：与当前焦点/域的契合度（起源「专注机制」）。 */
  goal: number
  /** 置信度 0..1。 */
  confidence: number
  /** 冲突惩罚 0..1（正值表示扣分）。 */
  conflictPenalty: number
  /** 总分（已含权重），范围约定为 0..1。 */
  total: number
}

/** 一条被打分后的记忆卡。 */
export interface ScoredCard {
  /** 原始卡片。 */
  card: MemoryCard
  /** 分数构成。 */
  score: ScoreBreakdown
  /** 人可读的解释行，例如「语义 0.62 × 权重 0.45」。 */
  explain: string[]
  /** 是否命中冲突（命中时焦点包必须同时暴露冲突双方）。 */
  conflict: boolean
  /**
   * 影子模式下「如果打开扩散，这张卡会被提多少分」。
   *
   * 只在 `spread.mode === 'shadow'` 时有值，`off` 与 `on` 下都是 `undefined`：
   * - `off`：压根没算，没有数可说；
   * - `on`：加分**已经进了** `score.total`，再记一份就成了两个真相源。
   *
   * 为什么单独放一个字段而不是塞进 `explain`：`explain` 会被人读渲染打印，
   * 而「影子模式的假设值」出现在人读输出里，读者会以为它真的生效了。
   * 分开存，让「实际生效」和「假设生效」在类型层面就是两件事。
   */
  shadowSpread?: ShadowSpread
  /**
   * `on` 模式下这张卡从扩散中实际获得的加分（0..1）。
   *
   * 与 `shadowSpread` **互斥**：`shadowSpread` 是「假如生效会怎样」，
   * 这里的是「真的加了多少」。`off` / `shadow` 下为 `undefined`。
   *
   * 为什么必须在这里声明：`applySpread` 早就在运行时挂上这个字段了，
   * 但类型里没有 ⇒ **任何消费方想读它，TS 都会说没有这个属性**。
   * 于是「扩散加分算出来了」和「有人能看见它」之间断了一环，人读渲染
   * 里也就没有「因为想起了谁」那一行。这正是真缺陷七的一半成因：
   * 光有运行时字段不算接线，**类型层没声明就等于没有出口**。
   */
  spreadBoost?: number
  /**
   * `on` 模式下激活这张卡的来源卡 id（按 id 升序，保证可复现）。
   *
   * 用来回答「因为想起 A，所以想起 B」——这是突触效果**可感知**的形态。
   * 只报一个加分数字，读者只知道「莫名高了 0.12」，那是噪声不是突触。
   *
   * 这些 id 一定是**本轮候选池里**的卡（种子从候选池里挑），所以渲染时
   * 能换回可读文本；换成文本这一步在人读渲染里做，不进注入上下文
   * （起源 L17·上下文污染）。
   */
  spreadSources?: readonly string[]
}

/**
 * 影子模式下的扩散观察值（FR-G1）。
 *
 * **这不是召回结果的一部分。** 它描述的是「假如 `spread.mode` 是 `'on'`，
 * 本次召回会变成什么样」，用于积累「该不该打开扩散」的证据。
 */
export interface ShadowSpread {
  /** 假设打开扩散后，这张卡会被提多少分（0..1）。 */
  boost: number
  /** 假设打开扩散后，加分来自哪些卡（按 id 升序，保证可复现）。 */
  sources: readonly string[]
  /** 假设打开扩散后的总分（`score.total + boost`，已 clamp 到 0..1）。 */
  hypotheticalTotal: number
  /** 按假设总分重排后，这张卡会排第几（1 起）。 */
  hypotheticalRank: number
  /** 实际排名（1 起）。与 `hypotheticalRank` 不同即「扩散会改变排序」。 */
  actualRank: number
}

/**
 * 焦点包（Focus Pack）：一次预取后真正注入上下文的记忆卡集合。
 *
 * 需求 FR-B2 / FR-E1 / FR-E3：条数 3~7，有绝对阈值与相对阈值，
 * 有 token 硬上限，只装摘要不装候选池。
 */
export interface FocusPack {
  /** 选中的卡片，按总分降序。 */
  cards: ScoredCard[]
  /** 估算的注入 token 数（含头尾固定开销）。 */
  tokens: number
  /** 本轮 token 预算上限。 */
  budgetTokens: number
  /**
   * 单条卡片的截断字符上限，随包一起带上。
   *
   * 渲染时必须用这个值而不是硬编码字面量，否则「预算按 160 算、渲染按 200 截」
   * 会让 `tokens` 与实际注入长度脱钩（FR-E3 上限失真）。
   */
  maxCardChars: number
  /** 触发本次预取的查询文本（通常是用户最新一条消息）。 */
  query: string
  /** 构建时刻。 */
  builtAt: number
  /** 是否为空包。 */
  empty: boolean
  /** 空包时给模型的明确措辞（FR-B6：召回为空必须说「没有相关记忆」）。 */
  note: string
}

/* ------------------------------------------------------------------ *
 * 五、时间状态：起源「解决 AI 没有时间观念问题」
 * ------------------------------------------------------------------ */

/**
 * 由代码计算出的时间读数。
 *
 * 需求 FR-D1 / FR-D2：所有相对时间都由代码算出，绝不交给模型推断。
 */
export interface TimeState {
  /** 当前时刻（毫秒时间戳）。 */
  now: number
  /** 当前时区的 IANA 名称。 */
  timeZone: string
  /** 本地自然日，`YYYY-MM-DD`，用于日摘要分桶。 */
  localDate: string
  /** 距离上一次会话结束的毫秒数；无历史时为 `null`。 */
  sinceLastSession: number | null
  /** 距离上一轮对话的毫秒数；无历史时为 `null`。 */
  sinceLastTurn: number | null
  /** 本次会话的开始时刻。 */
  sessionStartedAt: number | null
  /** 已到期事项（承诺/提醒）。 */
  due: MemoryCard[]
}

/* ------------------------------------------------------------------ *
 * 六、事件日志：唯一真相源（原则 P2）
 * ------------------------------------------------------------------ */

/**
 * 日志操作类型。
 *
 * 记忆库不是「一张会变的表」，而是「一串不可变的操作」。任何时刻的卡片
 * 状态都由重放日志得到（原则 P2：事件日志是唯一真相源，卡片是派生视图）。
 */
export type JournalOp =
  /** 新增或整卡覆盖（同 id 视为同一次写入，幂等）。 */
  | { op: 'put'; card: MemoryCard }
  /** 修正卡片摘要，保留旧版本。 */
  | { op: 'revise'; id: string; text: string; normalized: string; reason: string; at: number; actor: MemoryRevision['actor'] }
  /** 记录一次召回，刷新访问计数与强度。 */
  | { op: 'touch'; id: string; at: number; strength: number }
  /** 归档（可逆）。 */
  | { op: 'archive'; id: string; at: number; reason: string }
  /** 从归档恢复。 */
  | { op: 'restore'; id: string; at: number }
  /** 合并：多张卡并入一张。 */
  | { op: 'merge'; ids: string[]; into: MemoryCard; at: number }
  /** 建立图谱边。 */
  | { op: 'edge'; edge: MemoryEdge }
  /** 硬删除（隐私用，Q-06），不可逆。 */
  | { op: 'purge'; id: string; at: number }

/** 日志中的一条记录。 */
export interface JournalRecord {
  /** 记录格式版本，便于后续迁移。 */
  v: 1
  /** 单调递增序号，重放顺序的唯一依据。 */
  seq: number
  /** 记录写入时刻（毫秒时间戳）。 */
  at: number
  /** 幂等键：同一事件重复处理时键相同，落库时直接丢弃（FR-A2）。 */
  idempotencyKey: string
  /** 操作本体。 */
  op: JournalOp
}

/* ------------------------------------------------------------------ *
 * 七、可观测：写入 / 召回 / 整理都要留痕（FR-F1）
 * ------------------------------------------------------------------ */

/** 结构化日志条目的种类。 */
export type LogKind = 'write' | 'recall' | 'consolidate' | 'command' | 'error'

/** 一条结构化日志。 */
export interface MemoryLogEntry {
  /** 日志种类。 */
  kind: LogKind
  /** 发生时刻。 */
  at: number
  /** 会话 id（若有）。 */
  sessionId?: string
  /** 摘要信息，人可读。 */
  summary: string
  /** 结构化细节。 */
  detail: Record<string, unknown>
}

/* ------------------------------------------------------------------ *
 * 八、巩固报告：夜整理的产出（FR-C1）
 * ------------------------------------------------------------------ */

/** 一次夜间整理的结果。 */
export interface ConsolidationReport {
  /** 整理开始时刻。 */
  startedAt: number
  /** 整理结束时刻。 */
  finishedAt: number
  /** 整理前的活跃卡数。 */
  beforeActive: number
  /** 整理后的活跃卡数。 */
  afterActive: number
  /** 去重合并的组数。 */
  merged: number
  /** 降权的卡数。 */
  decayed: number
  /** 归档的卡数。 */
  archived: number
  /** 新产出的摘要卡数（日 + 周 + 月，FR-D4 / 起源 L27）。 */
  summarized: number
  /** 新蒸馏出的感受卡数（起源 L11）。 */
  distilled: number
  /** 重建的索引条数。 */
  reindexed: number
  /** 人可读的变更摘要行。 */
  notes: string[]
}

/* ------------------------------------------------------------------ *
 * 九、纯函数工具：id 派生（契约的一部分，供各模块共用）
 * ------------------------------------------------------------------ */

/**
 * 稳定 id 派生：域 + 来源 + 类型 + 归一化文本。
 *
 * 为什么不用随机 id：需求 FR-A2 要求幂等——同一事件重复处理必须落到
 * 同一个 id，靠内容派生是最省事且可验证的做法。
 *
 * @param domain - 记忆域。
 * @param source - 来源指针。
 * @param kind - 卡片类型。
 * @param normalized - 归一化后的文本。
 * @returns 32 位十六进制 id。
 */
export function buildCardId(
  domain: MemoryDomain, source: SourcePointer, kind: MemoryKind, normalized: string,
): string {
  const key = [domain, source.sessionId, String(source.turn), String(source.step), String(source.seq), kind, normalized].join('\u0001')
  return fnv1a64(key)
}

/**
 * 稳定边 id：同一起点、终点、关系只有一条边。
 *
 * @param from - 起点卡 id。
 * @param to - 终点卡 id。
 * @param relation - 边语义。
 * @returns 32 位十六进制 id。
 */
export function buildEdgeId(from: string, to: string, relation: EdgeRelation): string {
  return fnv1a64([from, to, relation].join('\u0002'))
}

/**
 * FNV-1a 64 位哈希，输出 16 位十六进制。
 *
 * 选它而不是 crypto：纯函数、无 IO、跨平台一致，单测里可直接断言字面量。
 *
 * @param input - 待哈希字符串。
 * @returns 16 位十六进制字符串。
 */
export function fnv1a64(input: string): string {
  // 用 BigInt 保证 64 位精度，避免 32 位溢出导致的碰撞。
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}
