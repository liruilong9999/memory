/**
 * 一轮对话的文本累积器：从 `session/event` 增量攒出本轮的原文。
 *
 * @module dsh-memory/host/plugin/turnBuffer
 */

import { isHumanSource, messageText, NL, unwrapMessage } from './messages.ts'

/**
 * 一轮对话的文本累积器。
 *
 * 为什么用「累积」而不是「回扫会话事件」：
 * 宿主把 `Session.eventAt()` / `snapshotEvents()` / `ownEvents()` 三个同步读历史
 * 的方法全部标了 `@deprecated`，迁移说明写得很明确——
 * 「Existing logic may remain unmigrated for now, but **new calls are prohibited**」。
 * 我们这是新代码，回扫历史属于明令禁止的用法。
 *
 * 正确姿势是订阅 `session/event`（post-commit、fire-and-forget、监听器异常被兜住），
 * 在事件到达时把消息文本增量记下来；`agent/turn-stopping` 时直接读累积结果。
 * 这样既不依赖「完整历史常驻内存」这个即将消失的前提，也天然满足 P2（会话日志是真相源）。
 */
export interface TurnBuffer {
  /** 本轮用户消息片段，按到达顺序。 */
  user: string[]
  /** 本轮助手消息片段，按到达顺序。 */
  assistant: string[]
  /** 本轮的轮次号；未知时为 `null`。 */
  turn: number | null
}

/** 每个会话的累积器：`sessionId → 当前轮缓冲`。 */
export type TurnBuffers = Map<string, TurnBuffer>

/**
 * 读本轮已累积的用户与助手文本。
 *
 * @param buffers - 各会话的累积器。
 * @param sessionId - 会话 id。
 * @returns 用户与助手文本；没有累积到内容时都为空串。
 */
export function readTurnText(buffers: TurnBuffers, sessionId: string): { userText: string; assistantText: string } {
  const buffer = buffers.get(sessionId)
  if (buffer === undefined) return { userText: '', assistantText: '' }
  return {
    userText: buffer.user.join(NL),
    assistantText: buffer.assistant.join(NL),
  }
}

/**
 * 读本轮已累积的用户文本、助手文本与轮次号。
 *
 * 与 {@link readTurnText} 只差一个 `turn`：压缩回填（P1-6）要把「这一轮」
 * 写进库，而写入用的 `TurnInput.turn` 就来自缓冲里 `turn/start` 记下的值。
 * 分成两个函数是因为渲染路径只关心文本，不该被逼着处理一个它用不到的字段。
 *
 * @param buffers - 各会话的累积器。
 * @param sessionId - 会话 id。
 * @returns 三项；没有缓冲时文本为空串、`turn` 为 `null`。
 */
export function readTurn(
  buffers: TurnBuffers, sessionId: string,
): { userText: string; assistantText: string; turn: number | null } {
  const buffer = buffers.get(sessionId)
  if (buffer === undefined) return { userText: '', assistantText: '', turn: null }
  return {
    userText: buffer.user.join(NL),
    assistantText: buffer.assistant.join(NL),
    turn: buffer.turn,
  }
}

/**
 * 把一条 `session/event` 归并进累积器。
 *
 * 只关心三类事件：
 * - `turn/start`：开新轮，清空缓冲（上一轮已经处理过）。
 * - `user/message`：追加用户文本（**仅 `source.kind === 'user'` 的人类输入**）。
 * - `assistant/message`：追加助手文本（仅 `source.kind === 'model'` 的模型回复）。
 *
 * 为什么必须按 `source.kind` 过滤，见 `HUMAN_SOURCE_KIND` 的文档块：
 * 宿主的 `user/message` 同时承载 `runtime-context` 快照（**本插件自己注入的
 * 焦点包**）和 `compact-checkpoint` 压缩摘要。不过滤的话，焦点包会被当成
 * 用户原话写回记忆库，并把里面的卡片行再抽取一遍，形成逐轮放大的自我复制。
 *
 * @param buffers - 各会话的累积器。
 * @param sessionId - 会话 id。
 * @param event - 会话事件。
 */
export function accumulateEvent(buffers: TurnBuffers, sessionId: string, event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const record = event as { type?: unknown; data?: unknown }
  const type = record.type
  if (type === 'turn/start') {
    const data = record.data as { turn?: unknown } | undefined
    const turn = typeof data?.turn === 'number' ? data.turn : null
    buffers.set(sessionId, { user: [], assistant: [], turn })
    return
  }
  if (type !== 'user/message' && type !== 'assistant/message') return
  // 只有 `user/message` 会混进合成来源（`runtime-context` / `compact-checkpoint`
  // 等）。`assistant/message` 的 source 恒为 `model`，不需要过滤。
  if (type === 'user/message' && !isHumanSource(unwrapMessage(record.data))) return
  const text = messageText(record.data)
  if (text.length === 0) return
  let buffer = buffers.get(sessionId)
  if (buffer === undefined) {
    buffer = { user: [], assistant: [], turn: null }
    buffers.set(sessionId, buffer)
  }
  if (type === 'user/message') buffer.user.push(text)
  else buffer.assistant.push(text)
}
