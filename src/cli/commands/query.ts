import { MEMORY_DOMAINS, MEMORY_KINDS } from '../../core/types.ts'
import { renderFocusPackExplain } from '../../core/render.ts'
import type { MemoryEngine } from '../../host/engine.ts'
import { parseDateArg } from '../dateArg.ts'
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
//
// 过滤条件（P1-5）走的是同一条路：`peek` 把它交给 `buildRecall`，由数据面的
// `matchesFilter` 判定。**CLI 这里不自己写 `card.domain === options.domain`**——
// 那会是第二个真相源，而两个真相源的分歧不报错，只表现为「同一个过滤条件，
// 命令与召回链路给出不同结果」。

// 人读渲染统一走 `src/core/render.ts` 的 `renderFocusPackExplain`。
// 这里原先有一份本地实现，与 `src/index.ts` 的 `/memory explain` 逐行重复，
// 靠人肉同步维持一致——改一处忘一处，同一个库在终端与会话里就会显示两种
// 格式，而且没人会立刻发现。现在一致性由共享实现保证。

/**
 * 从命令行参数拼出数据面的过滤条件。
 *
 * `--since` 在这里才被解释：它需要时区，而时区在 `args.ts` 里还不知道
 * （`--tz` 可能写在 `--since` 后面）。详见 `src/cli/dateArg.ts` 的模块注释。
 *
 * @param options - 解析后的参数。
 * @param timeZone - 已确定的时区。
 * @returns 过滤条件；无过滤 flag 时为空对象。
 */
function buildFilter(
  options: CliOptions, timeZone: string,
): { ok: true; filter: { domain?: string; kind?: string; tag?: string; since?: number } } | { ok: false; message: string } {
  const filter: { domain?: string; kind?: string; tag?: string; since?: number } = {}
  if (options.domain !== undefined) filter.domain = options.domain
  if (options.kind !== undefined) filter.kind = options.kind
  if (options.tag !== undefined) filter.tag = options.tag
  if (options.since !== undefined) {
    const parsed = parseDateArg(options.since, timeZone)
    if (!parsed.ok) return { ok: false, message: `--since ${parsed.message}` }
    filter.since = parsed.at
  }
  return { ok: true, filter }
}

/**
 * 渲染「过滤条件生效了」这句话。
 *
 * 为什么要专门说一句：`--domain wrok` 这种拼错会**安静地**返回空结果，
 * 而空结果看起来和「库里确实没有」一模一样。运维于是会去查记忆库，
 * 而问题在命令行上。这里把「筛了什么、筛出几条、库里有哪些合法取值」
 * 一次说清，让错字在输出里自己暴露。
 *
 * @param filter - 实际生效的过滤条件。
 * @param matched - 满足条件的活跃卡数。
 * @returns 一行中文说明。
 */
function renderFilterLine(
  filter: { domain?: string; kind?: string; tag?: string; since?: number }, matched: number,
): string {
  const parts: string[] = []
  if (filter.domain !== undefined) parts.push(`domain=${filter.domain}`)
  if (filter.kind !== undefined) parts.push(`kind=${filter.kind}`)
  if (filter.tag !== undefined) parts.push(`tag=${filter.tag}`)
  if (filter.since !== undefined) parts.push(`since=${new Date(filter.since).toISOString()}`)
  const head = `过滤：${parts.join(' ')} → 库里满足条件的活跃卡 ${matched} 张`
  if (matched > 0) return head
  const hints: string[] = []
  if (filter.domain !== undefined && !(MEMORY_DOMAINS as readonly string[]).includes(filter.domain)) {
    hints.push(`域「${filter.domain}」不在内置域里（${MEMORY_DOMAINS.join(' / ')}）`)
  }
  if (filter.kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(filter.kind)) {
    hints.push(`类型「${filter.kind}」不是内置类型（${MEMORY_KINDS.join(' / ')}）`)
  }
  return hints.length === 0 ? head : `${head}\n注意：${hints.join('；')}`
}

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
 * @param timeZone - 已确定的时区，用于解释 `--since`。
 * @returns 命令结果。
 */
export function runQuery(options: CliOptions, engine: MemoryEngine, timeZone: string): CliResult {
  const queryText = options.positionals.join(' ').trim()
  if (queryText.length === 0) return usageFailure('query 需要一个关键词，例如：memoryctl query "部署"')

  const built = buildFilter(options, timeZone)
  if (!built.ok) return usageFailure(built.message)
  const filter = built.filter
  const hasFilter = Object.keys(filter).length > 0

  // `status: 'active'` 是**必须**加上的：召回只可能从活跃卡里挑，
  // 而 `engine.query` 不加这条会把归档卡也算进「满足条件」，
  // 于是 CLI 报「库里满足条件的活跃卡 12 张」而其中 3 张是归档的——
  // 一个自己就说不通的数字。
  const matched = hasFilter ? engine.query({ ...filter, status: 'active' }) : []
  const result = engine.peek(queryText, '', undefined, hasFilter ? { ...filter, status: 'active' } : {})

  if (!options.json) {
    const explain = renderFocusPackExplain(result.pack, result.candidates)
    if (!hasFilter) return { code: EXIT_OK, stdout: `${explain}\n`, stderr: '' }
    return {
      code: EXIT_OK,
      stdout: `${renderFilterLine(filter, matched.length)}\n${explain}`,
      stderr: '',
    }
  }
  const payload = {
    query: queryText,
    candidates: result.candidates,
    tokens: result.pack.tokens,
    budgetTokens: result.pack.budgetTokens,
    maxCardChars: result.pack.maxCardChars,
    empty: result.pack.empty,
    note: result.pack.note,
    // 过滤生效时把「满足条件的全部活跃卡」原样给出来。
    //
    // 它和下面的 `cards` 不是同一件事：`cards` 是过了打分阈值、装进焦点包、
    // 又按 token 预算裁过的**结果**；`matched` 是过滤条件的**全集**。
    // 只给 `cards` 的话，调用方无法区分「过滤没生效」与「过滤生效但都没进包」——
    // 这两种情况下 `cards` 可能都是空的。
    ...(hasFilter ? { filter, matched } : {}),
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
