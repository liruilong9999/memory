/**
 * 压缩回填（P1-6）：宿主压缩上下文时，把**还没落盘**的轮次救进记忆库。
 *
 * ## 为什么需要这一步
 *
 * 宿主在上下文快满时会压缩对话：被压缩的那段原文会被一条摘要取代
 * （`docs/2-DSH宿主约束.md:100` 把这个配合写成三步）。**如果插件不在这一刻
 * 把尚未落盘的轮次写进记忆，那些对话就永久丢失了**——后续任何一轮都不会
 * 再提到它们，`agent/turn-stopping` 也不会为已经结束的轮次补发一次。
 *
 * 第 ① 步（每轮累积）在第 ③ 步（`agent/turn-stopping` 落盘）之间有一段
 * 时间窗，压缩恰好可能落在窗口里。本模块补的就是第 ② 步。
 *
 * ## 事件从哪来（一个容易搞错的地方）
 *
 * `compaction/summary` **不是 ctx 级事件名**，它是**会话事件类型**：
 *
 * - 宿主的 `packages/core/session/src/known-event-types.ts` 把它列进已知
 *   session 事件类型；
 * - `packages/compaction/compaction-basic/src/region.ts` 用
 *   `session.append('compaction/summary', {...})` **追加**它；
 * - ctx 上真正能订阅的事件名是 `session/event`，`compaction/summary` 出现在
 *   `event.type` 里（宿主自己的 compaction 插件也是这么读的）。
 *
 * 所以调用方应当在**已有的 `session/event` 订阅里按 `event.type` 分派**，
 * 而不是另起一条 `subscribe(ctx, 'compaction/summary', ...)`——后者永远不会
 * 被触发，而且它「看起来接上了」，比没接更危险。
 *
 * ## 载荷形状
 *
 * 来自宿主 `packages/compaction/compaction/src/types.ts`：
 * `{ compactionId, summary: ContentBlock[], shadowedRange: {start,end},
 * shadowedSeqs: number[], shadowedTokenCount, provider, model, ... }`。
 *
 * 其中 `shadowedRange` 是**surface 位置跨度**，宿主源码明确写了「一次
 * replace 把新摘要节点放到旧区间的位置上之后，`start` 可以大于 `end`」；
 * 「到底吞了哪些 seq」的权威集合是 `shadowedSeqs`（稀疏、不连续）。
 * 两者都不做任何大小假设。
 *
 * ## 这个模块不做什么
 *
 * - **不处理 `compaction/prune`**：那是无模型的剪枝替换，同样会吞掉区间，
 *   但它的语义是「按预算丢弃旧节点」而不是「换成一摘要」。本次只做
 *   `compaction/summary`，这是任务范围。
 * - **不抛错**：解析失败返回 `null`，flush 失败把原因放在返回值里。压缩
 *   路径是宿主的，记忆插件在这里抛异常等于把宿主的压缩弄崩——**压缩失败
 *   会让用户直接失去上下文**，比丢几条记忆严重得多。
 *
 * @module dsh-memory/host/engine/compaction
 */

import type { TurnInput } from '../../core/extraction.ts'
import type { MemoryDomain } from '../../core/types.ts'
import { messageText } from '../plugin/messages.ts'
import type { ShadowedRange } from './compactionLedger.ts'

/** 会话事件类型：压缩产出摘要。 */
export const COMPACTION_SUMMARY_TYPE = 'compaction/summary'

/**
 * 从会话事件里解析出的压缩摘要。
 *
 * 字段全部显式可缺席：宿主的载荷比本模块用到的多（`provider` / `model` /
 * `usage` …），而我们只取「幂等键 + 被吞区间 + 摘要文本」。
 */
export interface CompactionSummary {
  /**
   * 宿主给的压缩标识。
   *
   * **解析失败即返回 `null`**：没有它就无法跨进程认出「同一次压缩被投递
   * 了两次」，而没有幂等的回填会在每次重投时都跑一遍。宁可这次不回填
   * （下一次 `turn/stopping` 还能写），也不要留下一个无法去重的处理路径。
   */
  compactionId: string
  /** 摘要正文（宿主把摘要作为 `ContentBlock[]` 交付，这里取其中的文本块）。 */
  summaryText: string
  /** 被吞掉的 surface 位置跨度；载荷不合法时为 `null`（**不是** `{0,0}`，那是在撒谎）。 */
  shadowedRange: ShadowedRange | null
  /** 被吞掉的节点 `seq`（权威集合，稀疏）。 */
  shadowedSeqs: number[]
  /** 被吞掉的 token 数；载荷不合法时为 0。 */
  shadowedTokenCount: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseRange(raw: unknown): ShadowedRange | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!isFiniteNumber(record.start) || !isFiniteNumber(record.end)) return null
  // 刻意不校验 start <= end：见模块注释，那会拒掉合法数据。
  return { start: record.start, end: record.end }
}

function parseSeqs(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  const seqs: number[] = []
  for (const item of raw) {
    // 非数字项直接丢弃而不是整条失败：「吞了哪些 seq」是观测信息，
    // 其中一项不合法不该让整次回填消失。
    if (isFiniteNumber(item)) seqs.push(item)
  }
  return seqs
}

/**
 * 解析一条会话事件；不是压缩摘要或载荷不合法时返回 `null`。
 *
 * **绝不抛错**（模块注释里说了原因）。调用方仍应把整段处理包在 try/catch 里，
 * 因为 `messageText` 之类下游代码将来可能变化，而压缩路径不能因此崩掉。
 *
 * @param event - `session/event` 的第二个参数。
 * @returns 解析结果；不是压缩摘要、或缺 `compactionId` 时为 `null`。
 */
export function parseCompactionSummary(event: unknown): CompactionSummary | null {
  if (typeof event !== 'object' || event === null) return null
  const record = event as { type?: unknown; data?: unknown }
  if (record.type !== COMPACTION_SUMMARY_TYPE) return null
  const data = record.data
  if (typeof data !== 'object' || data === null) return null
  const payload = data as Record<string, unknown>
  const compactionId = payload.compactionId
  if (typeof compactionId !== 'string' || compactionId.length === 0) return null
  return {
    compactionId,
    // 复用 `plugin/messages.ts` 的取文本实现，而不是在这里再写一份。
    // 那个文件的模块注释记着一条教训：文本取值与来源判定必须同源，
    // 两份实现漂移时不会有任何报错，只会静默地取错内容。
    summaryText: messageText({ content: payload.summary }),
    shadowedRange: parseRange(payload.shadowedRange),
    shadowedSeqs: parseSeqs(payload.shadowedSeqs),
    shadowedTokenCount: isFiniteNumber(payload.shadowedTokenCount) && payload.shadowedTokenCount >= 0
      ? payload.shadowedTokenCount
      : 0,
  }
}

/** 待落盘的一轮文本（从 `TurnBuffers` 里读出来的形态）。 */
export interface PendingTurnText {
  /** 本轮已累积的用户原话。 */
  userText: string
  /** 本轮已累积的助手回复。 */
  assistantText: string
  /** 本轮轮次号；未知时为 `null`。 */
  turn: number | null
}

/** flush 的结果。 */
export interface FlushResult {
  /** 是否真的调用了写入函数。 */
  wrote: boolean
  /** 写入的卡片数。 */
  written: number
  /** 因幂等被丢弃的条数。 */
  skipped: number
  /**
   * 调用方**是否应当丢弃**这段缓冲。
   *
   * `true` 有两种含义，都对：
   * - 写成功了，留着会在下一轮重复写入；
   * - 根本没有可归因的用户原话，留着会把助手回复错记到下一轮。
   *
   * `false` 只发生在写入抛错时：**缓冲必须留着**，让后续的
   * `agent/turn-stopping` 再试一次。
   */
  clear: boolean
  /** 失败原因；成功或没东西可写时为 `null`。 */
  error: string | null
}

/**
 * 把「待落盘的一轮」写进记忆库（**纯逻辑**，副作用只在传入的回调里）。
 *
 * 这段判断单独抽出来，是因为它有两条**看起来一样、后果相反**的分支，
 * 端到端测试很难把它们区分开：
 *
 * 1. **有用户原话** → 走一次 `writeTurn`，成功才允许丢缓冲。
 * 2. **没有用户原话** → **不写**，但**要丢缓冲**。
 *
 * 第 2 条是这次改动里最容易写错的地方。`src/index.ts` 的 `turn-stopping`
 * 路径在 `delete` 之前有一句 `if (userText.length === 0) return`，所以
 * 「只剩助手文本」的残留缓冲是**常态**而不是异常。留到压缩之后，
 * 它会和下一轮的用户原话拼在一起被当成同一轮——把 A 轮的模型回复记成
 * B 轮的上下文。**错配比丢失更坏**：丢失只是少记，错配会让召回给出
 * 一个张冠李戴的答案，而这种错误在数据面上看不出来。
 *
 * 那为什么不干脆用空 `userText` 写一次？因为 `agent/turn-stopping` 不会
 * 那么做——同样的内容会因为「期间有没有发生压缩」得到两种不同的入库结果，
 * 这种不一致比不写更糟糕。
 *
 * @param pending - 待落盘的一轮文本。
 * @param options - 会话 id、归属域、时刻与写入函数。
 * @returns 结果；**永不抛错**（写入异常被收进 `error`）。
 */
export function flushPendingTurn(
  pending: PendingTurnText,
  options: {
    sessionId: string
    domain: MemoryDomain
    at: number
    write: (input: TurnInput) => { written: number; skipped: number }
  },
): FlushResult {
  if (pending.userText.length === 0) {
    return { wrote: false, written: 0, skipped: 0, clear: true, error: null }
  }
  const input: TurnInput = {
    sessionId: options.sessionId,
    turn: pending.turn === null ? 0 : pending.turn,
    step: 0,
    seq: 0,
    userText: pending.userText,
    assistantText: pending.assistantText,
    domain: options.domain,
    at: options.at,
  }
  try {
    const result = options.write(input)
    return { wrote: true, written: result.written, skipped: result.skipped, clear: true, error: null }
  } catch (error) {
    // 写失败**不能**丢缓冲：下一次 turn-stopping 还有机会。也不能抛出去——
    // 这里是宿主的压缩路径，抛异常会让压缩本身失败。
    return {
      wrote: true,
      written: 0,
      skipped: 0,
      clear: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
