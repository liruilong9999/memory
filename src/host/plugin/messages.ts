/**
 * 宿主消息的**形状解析**：取文本、剥包装、判来源。
 *
 * 这三件事必须住在同一个文件里。曾经「取文本」和「判来源」各写一遍剥离规则，
 * 漂移的表现是「文本取到了、来源判成空」，正好会静默把合成消息当人类输入放过去
 * （见 `docs/7-缺陷复盘.md` 缺陷三十四）。
 *
 * @module dsh-memory/host/plugin/messages
 */

/** 换行符：消息片段之间用换行拼接。 */
export const NL = String.fromCharCode(10)

/**
 * 宿主 `user/message` 事件里「真的是人说的」那一个 `source.kind`。
 *
 * 宿主的 `user/message` **不只有人类输入**。同一个事件类型还承载：
 * - `runtime-context`：所有 `systemPrompt.context()` 贡献拼成的快照
 *   （`packages/core/agent-loop/src/runtime-context.ts` 的 `project()`，
 *   由 `session.append('user/message', context, { surfaceOp: 'append' })` 落盘）。
 *   **本插件注入的焦点包就在这一类里**，且因为它带时间读数、每轮都变，
 *   所以每轮都会被重新 append 一次。
 * - `compact-checkpoint`：压缩摘要消息
 *   （`packages/compaction/compaction/src/checkpoint.ts` 的
 *   `COMPACT_CHECKPOINT_MARKER = { kind: 'compact-checkpoint' }`）。
 * - `schedule` / `agent-instructions` / `goal` / `user-approval` /
 *   `user-question-reply` 等合成来源。
 *
 * 判据必须是**白名单**而不是黑名单：合成来源在宿主里是开放集合（各插件自带
 * `source.kind`），挡得完一个挡不完下一个。只有 `user` 是人类直接输入。
 *
 * 起源 L17（无编号·上下文污染）：「模型搜索记忆等也可能有问题？污染上下文？」
 * ——把注入出去的焦点包再吃回来，正是它说的那件事。
 */
const HUMAN_SOURCE_KIND = 'user'

/**
 * 判断一条宿主消息是不是人类直接输入。
 *
 * 缺 `source` 时按**非人类输入**处理：宁可少记一条，也不要把合成上下文
 * 当用户原话写进记忆——写进去会被当成事实长期留存，而且会自我复制。
 *
 * @param message - 宿主消息对象。
 * @returns 是 `source.kind === 'user'` 时为 `true`。
 */
export function isHumanSource(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === HUMAN_SOURCE_KIND
}

/**
 * 从消息对象里抽纯文本。
 *
 * 宿主消息是 `content: ContentBlock[]`，这里只认文本块，其它块（图片/文件）忽略：
 * 记忆卡只存文本摘要，二进制内容没有语义价值（且会撑爆日志）。
 *
 * 两种载荷形状都要认（见 `packages/core/session/src/types.ts`）：
 * - `user/message` 的 data **就是** `UserMessage`，`content` 在顶层；
 * - `assistant/message` 的 data 是 `{ turn, step, message, stream, usage }`，
 *   `content` 在 `message.content` 里。
 *
 * @param data - 消息事件数据。
 * @returns 拼接后的文本；无法解析时为空串。
 */
export function messageText(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const content = (unwrapMessage(data) as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join(NL)
}

/**
 * 剥掉 `assistant/message` 外面那层事件包装，取出真正的消息对象。
 *
 * 两种载荷形状都要认（见 `packages/core/session/src/types.ts`）：
 * - `user/message` 的 data **就是** `UserMessage`，`content` 与 `source` 在顶层；
 * - `assistant/message` 的 data 是 `{ turn, step, message, stream, usage }`，
 *   `content` 与 `source` 在 `message` 里。
 *
 * 抽成函数是为了让「取文本」和「判来源」用**同一个**剥离规则：
 * 两处各写一遍剥法，迟早在其中一个上漂移，而漂移的表现是「文本取到了、
 * 来源判成空」，正好会静默把合成消息当人类输入放过去。
 *
 * @param data - 消息事件数据。
 * @returns 消息对象；无法识别时原样返回。
 */
export function unwrapMessage(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data
  const record = data as { content?: unknown; message?: unknown }
  if (record.content === undefined && typeof record.message === 'object' && record.message !== null) {
    return record.message
  }
  return record
}
