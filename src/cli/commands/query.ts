import { renderFocusPackExplain } from '../../core/render.ts'
import type { MemoryEngine } from '../../host/engine.ts'
import { jsonText, usageFailure } from '../output.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult } from '../types.ts'

/* ------------------------------------------------------------------ *
 * 五、子命令实现
 * ------------------------------------------------------------------ */

// 只读召回直接用 `engine.peek()`，本文件不再自己拼候选池。
//
// 这里原先有一份手写的 `readOnlyRecall`：自己走倒排命中 → 已到期 → 钉住三路
// 组装候选池，再 `scoreCards` + `buildFocusPack`。当时 `engine.recall` 还会写
// `touch`，CLI 想只读只能绕开引擎。后来引擎把「看到」与「使用」拆开了——
// `peek` 纯只读、`confirmRecall` 才写——那份手写实现就变成了纯粹的重复，
// 而且是会漂移的重复：它的 `candidates` 返回的是 `candidateLimit` 截断后的
// 数量，`peek` 返回的是完整候选池大小，同一个库在终端与会话里会报出两个
// 不同的候选数。少一份实现就少一处需要人肉同步的漂移点。
//
// 判断依据：`peek` 已在 `src/host/engine.ts` 里提供等价语义，且 CLI 本来就
// 会构造一个 `MemoryEngine`（export/rebuild/health/consolidate 都要用），
// 不存在「为了用 peek 额外拉起引擎」的代价。

// 人读渲染统一走 `src/core/render.ts` 的 `renderFocusPackExplain`。
// 这里原先有一份本地实现，与 `src/index.ts` 的 `/memory explain` 逐行重复，
// 靠人肉同步维持一致——改一处忘一处，同一个库在终端与会话里就会显示两种
// 格式，而且没人会立刻发现。现在一致性由共享实现保证。

/**
 * `query` 子命令（FR-F2）。
 *
 * 纯只读：走 `engine.peek()`，不改 `accessCount`、不改 `strength`、
 * 不写事件日志，因此「查一下看看」不会污染记忆库。
 * 「使用并强化」需要宿主侧显式确认（`engine.confirmRecall`），CLI 不提供、
 * 也不该提供——运维敲一眼不等于记忆被用过。
 *
 * @param options - 解析后的参数。
 * @param engine - 记忆引擎（只调用其只读入口）。
 * @returns 命令结果。
 */
export function runQuery(options: CliOptions, engine: MemoryEngine): CliResult {
  const queryText = options.positionals.join(' ').trim()
  if (queryText.length === 0) return usageFailure('query 需要一个关键词，例如：memoryctl query "部署"')

  const result = engine.peek(queryText)
  if (!options.json) {
    return { code: EXIT_OK, stdout: `${renderFocusPackExplain(result.pack, result.candidates)}\n`, stderr: '' }
  }
  const payload = {
    query: queryText,
    candidates: result.candidates,
    tokens: result.pack.tokens,
    budgetTokens: result.pack.budgetTokens,
    maxCardChars: result.pack.maxCardChars,
    empty: result.pack.empty,
    note: result.pack.note,
    cards: result.pack.cards.map((scored) => ({
      id: scored.card.id,
      kind: scored.card.kind,
      domain: scored.card.domain,
      text: scored.card.text,
      conflict: scored.conflict,
      score: scored.score,
      explain: scored.explain,
    })),
  }
  return { code: EXIT_OK, stdout: jsonText(payload), stderr: '' }
}
