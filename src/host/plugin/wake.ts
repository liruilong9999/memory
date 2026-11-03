/**
 * 可唤醒 agent 的结构探测、唤醒消息构造、会话 id 与记忆域的取值。
 *
 * 刻意不 import 宿主的 `Agent` 类型：结构探测让离线单测能传假 agent，
 * 宿主升级也不会让编译期崩掉（C8）。
 *
 * @module dsh-memory/host/plugin/wake
 */

import type { MemoryConfig } from '../../core/config.ts'
import type { MemoryDomain } from '../../core/types.ts'

/**
 * 可唤醒的 agent：只声明我们真正用到的两个成员。
 *
 * 刻意不 import 宿主的 `Agent` 类型（见 `src/host/adapter.ts` 的说明）：
 * 结构探测让离线单测能传假 agent，宿主升级也不会让编译期崩掉（C8）。
 */
export interface WakeableAgent {
  /** 队列一条后续消息并唤醒驱动器。 */
  followup: (message: unknown) => void
}

/**
 * 判断一个宿主对象是否可唤醒。
 *
 * @param agent - 候选对象。
 * @returns 具有 `followup` 函数时为 `true`。
 */
export function isWakeable(agent: unknown): agent is WakeableAgent {
  if (typeof agent !== 'object' || agent === null) return false
  return typeof (agent as { followup?: unknown }).followup === 'function'
}

/**
 * 构造一条可投递给 `followup` 的用户消息。
 *
 * 宿主侧的 `UserMessage` 要求 `{ content: [{type:'text', text}], source:{kind:'user'} }`。
 * 我们在这里手工拼形状而不调 `createUserMessage`：那会把 `@deepseek-ai/*`
 * 变成运行时依赖，违背适配面「零宿主依赖」的设计。
 *
 * @param text - 消息正文。
 * @returns 宿主可接受的消息对象。
 */
export function makeWakeMessage(text: string): unknown {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 从 agent 对象里取会话 id。
 *
 * @param agent - 宿主 agent。
 * @returns 会话 id；取不到时用固定占位，保证来源指针字段非空。
 */
export function sessionIdOf(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return 'unknown-session'
  const session = (agent as { session?: { id?: unknown } }).session
  const id = session?.id
  return typeof id === 'string' && id.length > 0 ? id : 'unknown-session'
}

/**
 * 判断当前记忆域。
 *
 * v0.2 只启用「工作」域（需求规格 v0.2 收敛范围）；
 * 生活/学习域是配置里预留的可插拔位，由 `config.extraction.domains` 决定。
 *
 * @param config - 记忆配置。
 * @returns 记忆域。
 */
export function pickDomain(config: MemoryConfig): MemoryDomain {
  return config.extraction.domains[0] ?? 'work'
}
