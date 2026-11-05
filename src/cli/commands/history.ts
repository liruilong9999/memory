import { renderCardHistory } from '../../core/render.ts'
import type { MemoryEngine } from '../../host/engine.ts'
import { jsonText, usageFailure } from '../output.ts'
import { resolveCardRef } from '../resolveCard.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult } from '../types.ts'

/**
 * `history` 子命令：查一张卡「改过什么、为什么」（FR-A5）。
 *
 * ## 为什么必须有这个出口
 *
 * `revisions` 的生产者早就齐了（`engine.revise`、CLI `revise`、`/memory revise`），
 * 15 条单测也在守着它真的写进去了。但在此之前，`grep -n revision` 在
 * `src/core/render.ts`、`src/cli/output.ts`、`src/cli/commands/query.ts`、
 * `src/host/plugin/commands.ts` 里**只有注释命中、零渲染代码**——
 * 需求原文要的是「修正后可查『改过什么、为什么』」，而 `reason` 写进去之后
 * 没有任何出口能读它。**只写不读，等于没记。**
 *
 * 数据来源只有一处：`engine.inspect(id)` 返回的 `MemoryCard.revisions`。
 * 这里不碰数据面、不新增查询通道——修正历史是卡片状态的一部分，
 * 有第二条读法就会有两套语义。
 *
 * @param options - 解析后的参数，`positionals[0]` 为卡片 id 或其前缀。
 * @param engine - 记忆引擎（只调用其只读入口）。
 * @param timeZone - 已确定的时区，用于渲染每次修正的时间。
 * @returns 命令结果。
 */
export function runHistory(options: CliOptions, engine: MemoryEngine, timeZone: string): CliResult {
  const ref = options.positionals[0]
  if (ref === undefined || ref.length === 0) {
    return usageFailure('history 需要一个卡片 id，例如：memoryctl history 1a2b3c4d')
  }
  const resolved = resolveCardRef(engine, ref)
  if (!resolved.ok) return resolved.result
  const card = resolved.card
  if (options.json) {
    return {
      code: EXIT_OK,
      stdout: jsonText({
        id: card.id,
        kind: card.kind,
        domain: card.domain,
        text: card.text,
        status: card.status,
        revisions: card.revisions,
      }),
      stderr: '',
    }
  }
  return { code: EXIT_OK, stdout: `${renderCardHistory(card, timeZone)}\n`, stderr: '' }
}
