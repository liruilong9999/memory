import { lookupCard } from '../core/scoring.ts'
import type { MemoryCard } from '../core/types.ts'
import type { MemoryEngine } from '../host/engine.ts'
import { EXIT_UNHEALTHY, EXIT_USAGE } from './types.ts'
import type { CliResult } from './types.ts'

/**
 * 卡片引用的解析结果。
 *
 * `ok: false` 时 `result` 已经是可以直接返回的 {@link CliResult}：
 * 失败文案与退出码在这里定死一次，`restore` / `revise` / `history` 三个子命令
 * 不再各拼一份。**三个入口对同一个引用给出三种说法，用户会以为其中两个坏了。**
 */
export type ResolvedCardRef =
  | { ok: true; card: MemoryCard }
  | { ok: false; result: CliResult }

/**
 * 把用户给的卡片引用解析成一张卡（`restore` / `revise` / `history` 共用）。
 *
 * ## 为什么需要前缀解析
 *
 * 人读输出（`query` 与 `/memory explain`）里印的卡片 id 是**前 8 位**，
 * 而 `engine.inspect` 只认完整 id。不做这一步的话，用户从输出里抄来的字符串
 * 粘给命令必然得到「没有这张卡」——**输出与输入对不上，等于 id 白印了**。
 *
 * ## 两种失败两种退出码
 *
 * - **不存在** → `EXIT_UNHEALTHY`：沿用 `restore` / `revise` 既有的约定，
 *   库里确实没有这张卡，是「库里的东西不对」。
 * - **前缀有歧义** → `EXIT_USAGE`：库没有任何问题，是用户给的引用不够长，
 *   重敲一次更长的前缀就能过——这是用法错误，不是健康问题。
 *
 * 两种都**绝不挑一张**：悄悄改了另一张卡而输出一切正常，是查不出来的错。
 *
 * @param engine - 记忆引擎（只调用其只读入口）。
 * @param ref - 用户给的引用：完整 id 或前缀。
 * @returns 解析结果；失败时带上可直接返回的 `CliResult`。
 */
export function resolveCardRef(engine: MemoryEngine, ref: string): ResolvedCardRef {
  // 先走精确命中：完整 id 是绝大多数脚本与旧文档的写法，
  // 不该为它把全库列一遍。
  const exact = engine.inspect(ref)
  if (exact !== undefined) return { ok: true, card: exact }
  // 未命中才扫全库做前缀匹配。归档卡也要在候选里——`restore` 的主顾正是它们。
  const found = lookupCard(engine.query({}), ref)
  if (found.ok) return { ok: true, card: found.card }
  return {
    ok: false,
    result: {
      code: found.reason === 'ambiguous' ? EXIT_USAGE : EXIT_UNHEALTHY,
      stdout: '',
      stderr: `${found.message}\n`,
    },
  }
}
