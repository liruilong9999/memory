/**
 * 状态投影：把不可变的事件日志重放成内存中的卡片视图。
 *
 * 设计依据：
 * - 原则 P2「事件日志是唯一真相源，卡片是派生视图」：这里只做投影，不产生新事实。
 * - ST-1 确定性：重放必须只依赖记录序列本身，同样的记录永远得到同样的状态；
 *   因此不引入随机数、不读系统时钟、不依赖遍历顺序以外的任何东西。
 * - FR-A5 修正历史：`revise` 把旧文本压进 `revisions`，可回答「改过什么、为什么」。
 * - FR-A4 来源指针：`put` 原样保留 `source`，任何卡都能定位回原文。
 *
 * @module dsh-memory/store/state
 */

import { buildEdgeId, MEMORY_DOMAINS, MEMORY_KINDS } from '../core/types.ts'
import type {
  MemoryCard, MemoryDomain, MemoryEdge, MemoryKind, MemoryRevision, JournalRecord,
} from '../core/types.ts'

/**
 * 重放得到的记忆状态。
 *
 * 三个容器各司其职：
 * - `cards`：id → 卡片，是召回与查询的唯一数据源；
 * - `edges`：id → 图谱边，随卡片生命周期增删；
 * - `seenKeys`：已应用的幂等键，重放时用于去重（FR-A2）。
 */
export interface MemoryState {
  /** 卡片表。 */
  cards: Map<string, MemoryCard>
  /** 图谱边表。 */
  edges: Map<string, MemoryEdge>
  /** 已见幂等键。 */
  seenKeys: Set<string>
  /** 最后应用的日志序号，0 表示尚未应用任何记录。 */
  lastSeq: number
  /**
   * 只读标记：共享的 {@link EMPTY_STATE} 会置为 `true`，
   * 直接对它应用记录会抛错，避免「空状态被意外污染」这类难查的 bug。
   */
  sealed: boolean
}

/**
 * 全库共享的只读空状态。
 *
 * 为什么共享：绝大多数会话在第一次写入前都是空库，每次都新建 Map 纯属浪费。
 * 共享就必须只读，所以配上 `sealed` 保护。
 */
export const EMPTY_STATE: MemoryState = Object.freeze({
  cards: new Map<string, MemoryCard>(),
  edges: new Map<string, MemoryEdge>(),
  seenKeys: new Set<string>(),
  lastSeq: 0,
  sealed: true,
}) as MemoryState

/**
 * 新建一个可变的空状态。
 *
 * @returns 全新的空状态，可安全地交给 {@link applyRecord}。
 */
export function createEmptyState(): MemoryState {
  return {
    cards: new Map<string, MemoryCard>(),
    edges: new Map<string, MemoryEdge>(),
    seenKeys: new Set<string>(),
    lastSeq: 0,
    sealed: false,
  }
}

/**
 * 深拷贝状态，得到可安全修改的副本。
 *
 * 卡片与边本身按「不可变」使用，因此只复制容器与卡片顶层字段，
 * 数组字段做浅拷贝避免共享引用被就地 push。
 *
 * @param state - 原状态。
 * @returns 新的可变状态。
 */
export function cloneState(state: MemoryState): MemoryState {
  const cards = new Map<string, MemoryCard>()
  for (const [id, card] of state.cards) {
    cards.set(id, {
      ...card,
      tags: [...card.tags],
      entities: [...card.entities],
      revisions: card.revisions.map((item) => ({ ...item })),
      conflictOf: [...card.conflictOf],
      ...(card.mergeOf === undefined ? {} : { mergeOf: [...card.mergeOf] }),
    })
  }
  const edges = new Map<string, MemoryEdge>()
  for (const [id, edge] of state.edges) edges.set(id, { ...edge })
  return {
    cards,
    edges,
    seenKeys: new Set(state.seenKeys),
    lastSeq: state.lastSeq,
    sealed: false,
  }
}

/** 把数值夹到 0..1；非有限数按 0 处理。 */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** 取两个时刻中较晚的一个，用于维护 `updatedAt`。 */
function laterOf(a: number, b: number): number {
  return b > a ? b : a
}

/** 判断值是否为普通对象（排除 null 与数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 判断字符串是否属于某个只读常量数组。
 *
 * 为什么用常量数组而不是手抄枚举：`MemoryKind` / `MemoryDomain` 是联合类型，
 * 手抄一份枚举等于多一处必须同步的真相源，漏同步时是**静默降级**（数据损坏），
 * 而 TypeScript 抓不到（`raw['kind']` 是 `unknown`，加不加分支都能编译）。
 *
 * @param candidate - 待判断的值。
 * @param allowed - 允许值常量数组。
 * @returns 是已知成员时返回 `true`。
 */
function isKnownValue<T extends string>(
  candidate: unknown, allowed: readonly T[],
): candidate is T {
  return typeof candidate === 'string' && (allowed as readonly string[]).includes(candidate)
}

/**
 * 把日志里的 `kind` 投影成卡片类型。
 *
 * 三种情况必须区分对待，这是 ST-1「同样输入得到同样输出」的底线：
 * 1. 已知成员 → 原样保留；
 * 2. **未知但合法的字符串** → 原样保留。这是**前向兼容**：日志是唯一真相源（P2），
 *    旧版本读到新版本写入的 `kind`（例如后续新增的 `summary`）时，投影必须忠实，
 *    不能把 `kind:'summary'` 悄悄改成 `'fact'` —— 那样日志写的是 A、重放出来是 B，
 *    同一条日志两种结果，直接破坏重放确定性，而且事后无从发现。
 * 3. 缺失或非字符串 → 退回 `'fact'`。这种情况**没有信息可保留**，才允许兜底。
 *
 * ## 关于下面那个 `as MemoryKind` 断言（已知的类型谎言，不是漏校验）
 *
 * 此处 `as` 断言是**有意为之**。`MemoryKind` 是闭合联合，而日志里可能装着
 * 比当前代码更新的值（如 `summary`），两者之间存在**鸿沟**——类型系统无法
 * 表达「这个字符串当前不认识但必须原样保留」。
 *
 * 所以这行代码在类型层面是在说谎：`MemoryKind` 声称 `kind` 必是六个值之一，
 * 运行时却可能是别的。这不是 bug，是刻意换取前向兼容的代价。
 *
 * **若未来 `MemoryKind` 需要开放**（例如允许插件注册自定义类型），应当把
 * `MemoryKind` 从闭合联合改为 `string`（或 `string & {}` 保留字面量提示），
 * 让类型与运行时语义重新对齐，而不是继续靠断言掩盖。在那之前，所有消费
 * `kind` 的地方都必须容忍未知值——例如 `kindLabel` 的 `default` 分支。
 *
 * @param raw - 日志里的原始值。
 * @returns 卡片类型。
 */
function coerceKind(raw: unknown): MemoryKind {
  if (isKnownValue(raw, MEMORY_KINDS)) return raw
  // 未知字符串原样透传（前向兼容，见上）。断言是刻意的：`MemoryKind` 是闭合联合，
  // 但**日志里可能装着比当前代码更新的值**，投影层的职责是搬运而非裁决。
  if (typeof raw === 'string' && raw.length > 0) return raw as MemoryKind
  return 'fact'
}

/**
 * 把日志里的 `domain` 投影成记忆域。
 *
 * 语义与 {@link coerceKind} 完全一致：已知保留、未知字符串透传、缺失才兜底。
 *
 * @param raw - 日志里的原始值。
 * @returns 记忆域。
 */
function coerceDomain(raw: unknown): MemoryDomain {
  if (isKnownValue(raw, MEMORY_DOMAINS)) return raw
  if (typeof raw === 'string' && raw.length > 0) return raw as MemoryDomain
  return 'work'
}

/**
 * 补齐卡片缺省字段，避免历史日志（老版本格式）缺字段导致下游崩溃。
 *
 * @param raw - 日志里的卡片对象。
 * @returns 字段齐全的卡片副本；结构非法时返回 `null`。
 */
function coerceCard(raw: unknown): MemoryCard | null {
  if (!isPlainObject(raw)) return null
  const id = raw['id']
  if (typeof id !== 'string' || id.length === 0) return null
  const source = raw['source']
  if (!isPlainObject(source)) return null
  const asString = (value: unknown, fallback: string): string =>
    (typeof value === 'string' ? value : fallback)
  const asNumber = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const asStringArray = (value: unknown): string[] =>
    (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
  const revisions = Array.isArray(raw['revisions'])
    ? raw['revisions'].filter(isPlainObject).map((item): MemoryRevision => ({
      at: asNumber(item['at'], 0),
      reason: asString(item['reason'], ''),
      previousText: asString(item['previousText'], ''),
      actor: item['actor'] === 'consolidation' || item['actor'] === 'manual' ? item['actor'] : 'system',
    }))
    : []
  const domain = raw['domain']
  const kind = raw['kind']
  const status = raw['status']
  const card: MemoryCard = {
    id,
    domain: coerceDomain(domain),
    kind: coerceKind(kind),
    text: asString(raw['text'], ''),
    normalized: asString(raw['normalized'], ''),
    createdAt: asNumber(raw['createdAt'], 0),
    updatedAt: asNumber(raw['updatedAt'], 0),
    source: {
      sessionId: asString(source['sessionId'], ''),
      turn: asNumber(source['turn'], 0),
      step: asNumber(source['step'], 0),
      seq: asNumber(source['seq'], 0),
      eventType: asString(source['eventType'], ''),
    },
    salience: clampUnit(asNumber(raw['salience'], 0)),
    confidence: clampUnit(asNumber(raw['confidence'], 0)),
    emotional: clampUnit(asNumber(raw['emotional'], 0)),
    strength: clampUnit(asNumber(raw['strength'], 0)),
    accessCount: Math.max(0, Math.trunc(asNumber(raw['accessCount'], 0))),
    lastAccessAt: typeof raw['lastAccessAt'] === 'number' && Number.isFinite(raw['lastAccessAt'])
      ? raw['lastAccessAt'] : null,
    tags: asStringArray(raw['tags']),
    entities: asStringArray(raw['entities']),
    revisions,
    status: status === 'archived' ? 'archived' : 'active',
    conflictOf: asStringArray(raw['conflictOf']),
    pinned: raw['pinned'] === true,
  }
  if (typeof raw['mergedInto'] === 'string') card.mergedInto = raw['mergedInto']
  const mergeOf = asStringArray(raw['mergeOf'])
  if (mergeOf.length > 0) card.mergeOf = mergeOf
  if (raw['dueAt'] === null) card.dueAt = null
  else if (typeof raw['dueAt'] === 'number' && Number.isFinite(raw['dueAt'])) card.dueAt = raw['dueAt']
  // FR-D3：重复方式必须穿过重放层，否则「每日提醒」重放后变成一次性。
  // 与 coerceKind 同理：**已知保留 / 未知丢弃**——未知值丢弃而不是透传，
  // 因为它会直接决定 nextDueAfter 的推进步长，错值比缺值更危险。
  if (
    raw['dueRepeat'] === 'once' || raw['dueRepeat'] === 'daily'
    || raw['dueRepeat'] === 'weekly' || raw['dueRepeat'] === 'cron'
  ) {
    card.dueRepeat = raw['dueRepeat']
  }
  // cron 表达式必须与 dueRepeat 一起穿过重放层：'cron' 这个值本身不含
  // 「什么时候再响」的信息，丢了表达式，重放后这张卡就再也算不出下一次。
  if (typeof raw['cronExpression'] === 'string' && raw['cronExpression'].length > 0) {
    card.cronExpression = raw['cronExpression']
  }
  return card
}

/**
 * 把一条日志记录应用到状态上（原地修改并返回同一对象）。
 *
 * 调用约定：**会修改传入的状态**。需要保留旧快照时请先 {@link cloneState}，
 * 或直接用 {@link applyRecordPure}。
 *
 * 幂等：记录的幂等键已在 `seenKeys` 中时直接返回，不重复应用（FR-A2）。
 *
 * @param state - 目标状态（必须是可变状态）。
 * @param record - 日志记录。
 * @returns 应用后的状态（与入参是同一对象）。
 */
export function applyRecord(state: MemoryState, record: JournalRecord): MemoryState {
  if (state.sealed) {
    throw new Error('不能对只读状态应用日志记录，请先 cloneState 或 createEmptyState')
  }
  if (state.seenKeys.has(record.idempotencyKey)) return state
  const at = record.at
  const op = record.op
  switch (op.op) {
    case 'put': {
      const card = coerceCard(op.card)
      if (card !== null) state.cards.set(card.id, card)
      break
    }
    case 'revise': {
      const card = state.cards.get(op.id)
      if (card !== undefined) {
        // FR-A5：旧文本必须留档，否则无法回答「改过什么」。
        const revision: MemoryRevision = {
          at,
          reason: op.reason,
          previousText: card.text,
          actor: op.actor,
        }
        state.cards.set(card.id, {
          ...card,
          text: op.text,
          normalized: op.normalized,
          updatedAt: laterOf(card.updatedAt, at),
          revisions: [...card.revisions, revision],
        })
      }
      break
    }
    case 'touch': {
      const card = state.cards.get(op.id)
      if (card !== undefined) {
        state.cards.set(card.id, {
          ...card,
          accessCount: card.accessCount + 1,
          lastAccessAt: op.at,
          strength: clampUnit(op.strength),
        })
      }
      break
    }
    case 'archive': {
      const card = state.cards.get(op.id)
      if (card !== undefined) {
        state.cards.set(card.id, {
          ...card,
          status: 'archived',
          updatedAt: laterOf(card.updatedAt, at),
        })
      }
      break
    }
    case 'restore': {
      const card = state.cards.get(op.id)
      if (card !== undefined) {
        state.cards.set(card.id, {
          ...card,
          status: 'active',
          updatedAt: laterOf(card.updatedAt, at),
        })
      }
      break
    }
    case 'merge': {
      const into = coerceCard(op.into)
      if (into !== null) {
        const mergedFrom: string[] = []
        for (const id of op.ids) {
          if (id === into.id) continue
          const victim = state.cards.get(id)
          if (victim === undefined) continue
          mergedFrom.push(id)
          // 被合并的卡不删除：保留溯源，标记作废与去向（FR-A4）。
          state.cards.set(id, {
            ...victim,
            status: 'archived',
            mergedInto: into.id,
            updatedAt: laterOf(victim.updatedAt, at),
          })
        }
        const mergeOf = [...(into.mergeOf ?? [])]
        for (const id of mergedFrom) {
          if (!mergeOf.includes(id)) mergeOf.push(id)
        }
        const merged: MemoryCard = {
          ...into,
          ...(mergeOf.length > 0 ? { mergeOf } : {}),
        }
        state.cards.set(merged.id, merged)
        for (const id of mergedFrom) {
          const edge: MemoryEdge = {
            id: buildEdgeId(id, merged.id, 'supersedes'),
            from: id,
            to: merged.id,
            relation: 'supersedes',
            weight: 1,
            createdAt: at,
          }
          state.edges.set(edge.id, edge)
        }
      }
      break
    }
    case 'edge': {
      const edge = op.edge
      if (edge !== undefined && typeof edge.id === 'string' && edge.id.length > 0) {
        state.edges.set(edge.id, { ...edge })
      }
      break
    }
    case 'purge': {
      // 硬删除不可逆（Q-06）：卡片消失，指向它的边与引用一并清理，不留悬空指针。
      state.cards.delete(op.id)
      pruneEdges(state)
      for (const [id, card] of state.cards) {
        const conflictOf = card.conflictOf.filter((item) => item !== op.id)
        const mergeOf = card.mergeOf?.filter((item) => item !== op.id)
        const mergedInto = card.mergedInto === op.id ? undefined : card.mergedInto
        const changed = conflictOf.length !== card.conflictOf.length
          || (mergeOf !== undefined && mergeOf.length !== (card.mergeOf?.length ?? 0))
          || mergedInto !== card.mergedInto
        if (!changed) continue
        const next: MemoryCard = { ...card, conflictOf }
        if (mergeOf !== undefined) next.mergeOf = mergeOf
        if (mergedInto === undefined) delete next.mergedInto
        else next.mergedInto = mergedInto
        state.cards.set(id, next)
      }
      break
    }
    default: {
      // 未知操作不改变状态，但也不阻断重放：老版本日志由新代码读到时必须能开库。
      break
    }
  }
  state.seenKeys.add(record.idempotencyKey)
  if (record.seq > state.lastSeq) state.lastSeq = record.seq
  return state
}

/**
 * 纯函数版应用：先克隆再应用，入参状态不受影响。
 *
 * @param state - 原状态（不会被修改）。
 * @param record - 日志记录。
 * @returns 应用后的新状态。
 */
export function applyRecordPure(state: MemoryState, record: JournalRecord): MemoryState {
  const next = cloneState(state)
  return applyRecord(next, record)
}

/**
 * 从日志全量重放出状态。
 *
 * 这是 ST-1「重启一致」的核心：进程重启后不读任何快照，直接从日志重放，
 * 得到的状态必然与写入时一致。
 *
 * @param records - 按 `seq` 升序排列的记录。
 * @returns 重放得到的状态。
 */
export function rebuildState(records: readonly JournalRecord[]): MemoryState {
  const state = createEmptyState()
  for (const record of records) applyRecord(state, record)
  pruneEdges(state)
  return state
}

/**
 * 删除端点已不存在的边。
 *
 * 边是派生数据（FR-A7：索引可重建），悬空边只会污染图谱，因此就地清理。
 *
 * @param state - 目标状态（原地修改）。
 */
export function pruneEdges(state: MemoryState): void {
  const dead: string[] = []
  for (const [id, edge] of state.edges) {
    if (!state.cards.has(edge.from) || !state.cards.has(edge.to)) dead.push(id)
  }
  for (const id of dead) state.edges.delete(id)
}

/**
 * 取一张卡。
 *
 * @param state - 状态。
 * @param id - 卡片 id。
 * @returns 卡片；不存在时返回 `undefined`。
 */
export function getCard(state: MemoryState, id: string): MemoryCard | undefined {
  return state.cards.get(id)
}

/** 卡片查询条件。全部字段可选，同时给出时按「与」组合。 */
export interface MemoryFilter {
  /** 记忆域。 */
  domain?: string
  /** 卡片类型。 */
  kind?: string
  /** 生命周期状态。 */
  status?: 'active' | 'archived'
  /** 必须包含的标签。 */
  tag?: string
  /** 必须包含的实体。 */
  entity?: string
  /** 文本包含的子串（按原文比较，大小写敏感）。 */
  contains?: string
  /**
   * 是否钉住（FR-C3）。
   *
   * 给 `true` 时只返回钉住的卡；给 `false` 时只返回未钉住的卡；
   * 省略则不按钉住状态过滤。召回路径用它兜底「承诺与核心事实不能因检索没命中而消失」。
   */
  pinned?: boolean
  /** 起始时刻（含）。 */
  since?: number
  /** 结束时刻（含）。 */
  until?: number
  /** 是否包含已被合并作废的卡；默认包含（溯源需要）。 */
  includeMerged?: boolean
}

/**
 * 单张卡片是否满足查询条件。
 *
 * 抽出来的理由不是「复用方便」，而是**判据只能有一份**：
 * {@link filterCards} 对整张状态表筛，召回链路对「已经拿到手的一张卡」筛，
 * 两处若各写一遍 `filter.domain !== card.domain` 这样的比较，就是两个真相源。
 * 而两个真相源的分歧不会报错——它表现为「同一条过滤条件，`query` 命令和
 * 召回链路给出的结果不一样」，查起来极费人（缺陷二十五的形状：判据写了两处，
 * 两处各自都对，合起来互相矛盾）。
 *
 * @param card - 待判定的卡片。
 * @param filter - 查询条件；全部字段可选，同时给出时按「与」组合。
 * @returns 满足条件时 `true`。
 */
export function matchesFilter(card: MemoryCard, filter: MemoryFilter = {}): boolean {
  if (!(filter.includeMerged ?? true) && card.mergedInto !== undefined) return false
  if (filter.domain !== undefined && card.domain !== filter.domain) return false
  if (filter.kind !== undefined && card.kind !== filter.kind) return false
  if (filter.status !== undefined && card.status !== filter.status) return false
  if (filter.tag !== undefined && !card.tags.includes(filter.tag)) return false
  if (filter.entity !== undefined && !card.entities.includes(filter.entity)) return false
  if (filter.contains !== undefined && !card.text.includes(filter.contains)) return false
  if (filter.pinned !== undefined && card.pinned !== filter.pinned) return false
  if (filter.since !== undefined && card.createdAt < filter.since) return false
  if (filter.until !== undefined && card.createdAt > filter.until) return false
  return true
}

/**
 * 按条件筛选卡片。
 *
 * 返回顺序固定为「`updatedAt` 降序，同刻按 id 升序」，保证同一状态同一查询
 * 结果完全一致（ST-1）。
 *
 * @param state - 状态。
 * @param filter - 查询条件。
 * @returns 卡片数组。
 */
export function filterCards(state: MemoryState, filter: MemoryFilter = {}): MemoryCard[] {
  const result: MemoryCard[] = []
  for (const card of state.cards.values()) {
    if (matchesFilter(card, filter)) result.push(card)
  }
  result.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result
}

/**
 * 取一张卡的全部关联边。
 *
 * @param state - 状态。
 * @param cardId - 卡片 id。
 * @returns 边数组，按边 id 升序。
 */
export function edgesOf(state: MemoryState, cardId: string): MemoryEdge[] {
  const result: MemoryEdge[] = []
  for (const edge of state.edges.values()) {
    if (edge.from === cardId || edge.to === cardId) result.push(edge)
  }
  result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return result
}

/**
 * 统计卡片数。
 *
 * @param state - 状态。
 * @param status - 只统计某个生命周期状态；省略表示全部。
 * @returns 条数。
 */
export function countCards(state: MemoryState, status?: 'active' | 'archived'): number {
  if (status === undefined) return state.cards.size
  let count = 0
  for (const card of state.cards.values()) if (card.status === status) count += 1
  return count
}
