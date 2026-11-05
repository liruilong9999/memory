import { formatCardRef, formatTime, fmt, kindLabel } from '../../core/scoring.ts'
import { truncate } from '../../core/text.ts'
import { MEMORY_KINDS } from '../../core/types.ts'
import type { MemoryCard, MemoryKind } from '../../core/types.ts'
import type { MemoryEngine } from '../../host/engine.ts'
import type { MemoryFilter } from '../../store/state.ts'
import { jsonText, usageFailure } from '../output.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult, ResolvedCliConfig } from '../types.ts'

/**
 * `list` 子命令：不带关键词，把记忆库里**有什么**列出来（FR-F1）。
 *
 * ## 为什么必须有这个出口
 *
 * 在此之前，想看库里有什么只有一个办法：猜关键词去 `query`。
 * `query` 是**召回**命令——它按打分挑 7 张，挑不中就什么也不告诉你，
 * 而「挑不中」与「库里没有」在输出上完全一样。运维要做的事（这张卡还在吗、
 * 归档了几张、id 是多少好拿去 `restore`）恰恰需要**全库视角**，
 * 那是 `query` 在设计上不给的东西。
 *
 * `engine.query({})` 一直都在，缺的只是这条出口。**能力在、路径缺**——
 * 与 `history`（FR-A5）和 `edges`（FR-G1）是同一族缺陷。
 *
 * ## 输出为什么长这样
 *
 * 一张卡占两行：主行是类型·域 + 正文，属性行是 id / 强度 / 钉住 / 状态 / 更新时间。
 *
 * - **id 用 `formatCardRef` 印前 8 位**，不自己 `slice`：它是「id 渲染成
 *   人读形式」的唯一来源，`query` / `explain` / `history` 印的都是它。
 *   自己截会让用户抄出来的前缀跟别的命令印的对不上——而前缀恰恰是要
 *   粘回 `restore` / `revise` / `pin` 的。
 * - **正文截断到 `recall.maxCardChars`**（`truncate` 按码点切、省略号占 1 位），
 *   复用焦点包那条预算。理由：用户在这一屏看到的长度，就是他注入上下文时
 *   看到的长度，两个数字同源才不会出现「列出来很长、注入时被砍一半」的意外。
 *   不新增 `output.*Chars`：那会让同一件事有两个旋钮。
 * - **强度用 `fmt`（三位小数）**，与分数渲染同一个格式化器。
 *
 * ## 排序为什么必须确定
 *
 * 键是 **`updatedAt` 降序，同刻用 `id` 升序破平**。
 *
 * 只用 `updatedAt` 是不够的：同一轮里写入的多张卡 `updatedAt` 完全相同
 * （引擎按 `now` 一次性盖章），而 `Array.prototype.sort` 的稳定性只保证
 * 「输入顺序被保留」，**不保证输入顺序本身是确定的**。输入来自
 * `store.listCards()`，下层从 `Map<string, MemoryCard>` 摊平而来——
 * **Map 的迭代顺序是插入顺序，不是排序**。于是「两张同刻更新的卡谁先出现」
 * 取决于谁先进库，那是一个与用户无关的实现细节，却会让他两次运行 `list`
 * 看到不同的顺序，并以为库变了。
 *
 * 用 `id` 破平而不是 `text` 或 `kind`：id 是主键，全序性质成立；
 * 而且它**内容无关**——改正文不会改变一张卡在列表里的相对位置，
 * 只有「更新过」才会。
 *
 * ## 上限
 *
 * 实际生效条数 = `min(--limit 请求值, output.listMaxCards)`。
 * NFR-3 的目标规模是 10 万级卡，没有上限会把终端打爆——这不是假设。
 * 在配置里是 `output.listMaxCards`（默认 200），不是命令行字面量，
 * 因为它是可版本化、可回滚的参数（P7）。
 *
 * `--limit 0` 在 `logs` 里表示「全部」，这里**不能沿用**：让 0 绕过上限
 * 等于「上限进配置」只是句口号。所以 list 把 0 读成「没指定」，取配置上限。
 *
 * @param options - 解析后的参数（`--limit` / `--include-archived` /
 *   `--domain` / `--kind` / `--tag`）。
 * @param engine - 记忆引擎（只调用其只读入口）。
 * @param resolved - 已解析的配置，提供这次生效的输出上限。
 * @param timeZone - 已确定的时区，用于渲染 `updatedAt`。
 * @returns 命令结果。
 */
export function runList(
  options: CliOptions,
  engine: MemoryEngine,
  resolved: ResolvedCliConfig,
  timeZone: string,
): CliResult {
  const filter = buildListFilter(options)
  if (!filter.ok) return filter.result

  const cap = resolved.config.output.listMaxCards
  const requested = options.limit > 0 ? options.limit : cap
  const effective = Math.min(requested, cap)

  const cards = engine.query(filter.value)
  // 显式再排一次，不依赖数据面的顺序：
  // ① 数据面的排序键将来可能改（那是它的自由），人读输出的顺序不该跟着漂；
  // ② 反向验证要能精确打中「排序确定性」这一行——依赖下层时会打不中
  //    （`filterCards` 恰好也按 updatedAt 降序 + id 升序，删掉这里照样绿）。
  const sorted = [...cards].sort(compareListCards)
  const shown = sorted.slice(0, effective)
  const truncated = sorted.length > shown.length
  const maxCardChars = resolved.config.recall.maxCardChars

  if (options.json) {
    return {
      code: EXIT_OK,
      stdout: jsonText({
        total: sorted.length,
        shown: shown.length,
        /** 这次实际采用的条数（`--limit` 与硬上界取小）。 */
        limit: effective,
        /** 硬上界本身（配置 `output.listMaxCards`）。 */
        cap,
        truncated,
        maxCardChars,
        empty: sorted.length === 0,
        cards: shown.map((card) => ({
          id: card.id,
          ref: formatCardRef(card.id),
          kind: card.kind,
          domain: card.domain,
          text: card.text,
          strength: card.strength,
          pinned: card.pinned,
          status: card.status,
          updatedAt: card.updatedAt,
        })),
      }),
      stderr: '',
    }
  }

  const lines: string[] = []
  if (sorted.length === 0) {
    // 空状态必须显式说明（FR-B6 的同一原则：空输出会被当成命令坏了）。
    // 文案里带上 `scope`，于是「库本来就空」与「过滤把它筛空了」
    // 说出来的不是同一句话——前者要用户去写点什么，后者要用户松一松过滤。
    lines.push(`记忆库里还没有${filter.scope}。`)
  } else {
    for (const card of shown) {
      lines.push(renderListCard(card, maxCardChars, timeZone))
    }
    if (truncated) {
      // 截断必须说出来，否则用户会以为「库里就这么多」。
      // 与「空包要说清为什么空」同源：**数量也要有解释**。
      lines.push(
        `…只列出前 ${shown.length} 张（共 ${sorted.length} 张）。` +
          `--limit 最多到 ${cap}；要更高的硬上界，改配置 output.listMaxCards。`,
      )
    } else {
      lines.push(`共 ${shown.length} 张${filter.scope}。`)
    }
  }
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * list 的排序键：`updatedAt` 降序，同刻用 `id` 升序破平。
 *
 * 破平项不能省，理由见 {@link runList} 的「排序为什么必须确定」。
 *
 * ## 为什么导出它
 *
 * 因为它**必须能被单独测**。今天的调用链是
 * `runList` → `engine.query` → `store.listCards` → `filterCards`，
 * 而 `filterCards`（`src/store/state.ts:554`）已经按**同一把尺子**
 * 排过序。于是端到端断言「同刻按 id 升序」在「删掉本函数的破平项」时
 * **依然绿**——下层的顺序兜住了它。这不是测试写得好，是断言选错了层次：
 * 它测的是数据面的排序，不是 CLI 的。
 *
 * 导出它，让 `tests/cli/list.test.ts` 直接对比较器下断言，
 * 才能让「删破平」这个变异精确变红。（同源教训见 AGENTS.md
 * 「断言选错层次时，反向验证不会变红」。）
 *
 * @param a - 左卡。
 * @param b - 右卡。
 * @returns 比较结果。
 */
export function compareListCards(a: MemoryCard, b: MemoryCard): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * 把一张卡渲染成「主行 + 属性行」两行。
 *
 * @param card - 记忆卡。
 * @param maxChars - 正文截断上限（`recall.maxCardChars`）。
 * @param timeZone - 时区。
 * @returns 两行文本（内含换行）。
 */
function renderListCard(card: MemoryCard, maxChars: number, timeZone: string): string {
  const head = `- ${kindLabel(card.kind)}·${card.domain} ${truncate(card.text, maxChars)}`
  const traits = [
    formatCardRef(card.id),
    `强度 ${fmt(card.strength)}`,
    card.pinned ? '★已钉住' : '未钉住',
    card.status === 'archived' ? '已归档' : '活跃',
    `更新于 ${formatTime(card.updatedAt, timeZone)}`,
  ]
  return `${head}\n  ${traits.join('  ')}`
}

/**
 * 由命令行参数构造 list 的过滤条件。
 *
 * 与 `query` 的 `buildFilter` 逻辑相近，但**不跨文件 import**：那个函数是
 * `query.ts` 的文件内私有实现，把它提升成公开 API 会让「query 的过滤语义」
 * 变成两条命令共享的契约，而它们将来可能分道扬镳（query 的过滤影响候选池，
 * list 的过滤影响列表）。复制三行比造一个假共享更便宜。
 *
 * `--since` **故意不支持**：list 已经按 `updatedAt` 排好序，想看最近的用
 * `--limit` 就够了；再造一个时间过滤会让人猜「它比的是 createdAt 还是
 * updatedAt」（query 的 `--since` 比的是 `createdAt`），两条命令的参数语义
 * 不一致比少一个参数更糟。
 *
 * @param options - 解析后的参数。
 * @returns 过滤条件与用于渲染的说明，或一条用法错误。
 */
function buildListFilter(
  options: CliOptions,
):
  | { ok: true; value: MemoryFilter; scope: string }
  | { ok: false; result: CliResult } {
  const value: MemoryFilter = {}
  const parts: string[] = []
  if (options.domain !== undefined) {
    value.domain = options.domain
    parts.push(`domain=${options.domain}`)
  }
  if (options.kind !== undefined) {
    // 类型写错要当场报，不能静默列出 0 张：后者与「库里确实没有」同形，
    // 用户会以为库空了（`query` 用「注意」提示同一个坑，这里直接拒）。
    if (!(MEMORY_KINDS as readonly string[]).includes(options.kind)) {
      return {
        ok: false,
        result: usageFailure(
          `类型「${options.kind}」不是内置类型（可用：${MEMORY_KINDS.join(' / ')}）`,
        ),
      }
    }
    value.kind = options.kind as MemoryKind
    parts.push(`kind=${options.kind}`)
  }
  if (options.tag !== undefined) {
    value.tag = options.tag
    parts.push(`tag=${options.tag}`)
  }

  const filterLine = parts.length > 0 ? `（过滤条件：${parts.join(' ')}）` : ''
  if (!options.includeArchived) {
    // 归档卡默认不列：`list` 回答的是「我现在有什么」。
    // 想看已归档的去 `--include-archived`，那时用户知道自己在找什么。
    value.status = 'active'
    return {
      ok: true,
      value,
      scope: `活跃卡${filterLine}`,
    }
  }
  // 加了 `--include-archived` 就**不加 status 过滤**，归档卡与已合并卡都进来。
  // 这里不再单独设 `includeMerged`：`matchesFilter` 的默认值就是 `true`，
  // 写一行同值的赋值只是给人「这里有个开关」的错觉。
  return {
    ok: true,
    value,
    scope: `卡（含归档）${filterLine}`,
  }
}
