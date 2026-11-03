/**
 * 焦点包渲染函数的组装。
 *
 * 这个函数每轮被宿主调用一次（C7：`text` 传函数，压缩后自动重新物化）。
 * 它必须**快且不抛**：慢会拖慢整个请求，抛会让宿主循环出问题。
 *
 * @module dsh-memory/host/plugin/render
 */

import type { MemoryEngine } from '../engine.ts'

/** 渲染函数的两个取值依赖，抽成参数是为了让测试注入固定值。 */
export interface FocusPackSources {
  /** 取本轮召回查询文本（用户此刻在说什么）。 */
  queryText: () => string
  /** 取当前目标文本（agent 此刻在做什么）；没有目标时返回空串。 */
  goalText: () => string
}

/**
 * 组装焦点包渲染函数。
 *
 * 这个函数每轮被宿主调用一次（C7：`text` 传函数，压缩后自动重新物化）。
 * 它必须**快且不抛**：慢会拖慢整个请求，抛会让宿主循环出问题。
 *
 * 查询文本的来源演进（这是一处实打实的正确性修复）：
 * 旧实现用 `engine.recentQuery()`，即「库里最新一张卡片的文本」。那等于
 * **拿上一次写入的记忆碎片去查询记忆库**，而不是拿用户此刻说的话——问题是
 * 上一轮写入的往往是抽取后的要点（「用户偏好 PostgreSQL」），与用户本轮
 * 的原话（「这个 JSONB 字段怎么建索引」）语义差异很大，召回自然不准。
 * 现在改用本轮的 `user/message` 原文（由 `session/event` 累积），
 * 拿不到时才退回 `recentQuery()`（例如新会话第一轮之前）。
 *
 * @param engine - 记忆引擎。
 * @param sources - 查询文本与目标文本的来源。
 * @returns 渲染函数。
 */
export function makeFocusPackRenderer(engine: MemoryEngine, sources: FocusPackSources): () => string {
  return (): string => {
    const queryText = sources.queryText()
    const goalText = sources.goalText()
    // 查询文本为空（新会话、尚无用户消息）时用最近记忆兜底，避免空查询命中一切。
    const effectiveQuery = queryText.length > 0 ? queryText : engine.recentQuery()
    const result = engine.recall(effectiveQuery, goalText)
    const blocks: string[] = []
    const time = engine.renderTime()
    if (time.length > 0) blocks.push(time)
    if (result.text.length > 0) blocks.push(result.text)
    return blocks.join('\n\n')
  }
}
