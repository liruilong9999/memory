import { formatCardRef, fmt, kindLabel } from '../../core/scoring.ts'
import { truncate } from '../../core/text.ts'
import type { MemoryEdge } from '../../core/types.ts'
import type { MemoryEngine } from '../../host/engine.ts'
import { jsonText, usageFailure } from '../output.ts'
import { resolveCardRef } from '../resolveCard.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult, ResolvedCliConfig } from '../types.ts'

/**
 * `edges` 子命令：查一张卡连了谁、什么关系、权重多少（FR-G1 的**查询出口**）。
 *
 * ## 为什么必须有这个出口
 *
 * 图谱不是装饰：扩散激活（FR-G1）靠「沿边加权」把邻居的分数带进焦点包，
 * 也就是说**边在暗中影响了用户看到的排序**。而在此之前，那张图对用户是
 * 不透明的——他能感觉到「这两条记忆一起被想起来」，但查不到它们之间有没有边、
 * 是 `same-entity` 还是 `same-topic`、权重是 1.0 还是 0.17。
 *
 * 更具体地说，`engine.edges(id)` 一直都在（`src/host/engine.ts:825` →
 * `store.edgesOf`），但**生产代码零调用方**，唯一的调用者是
 * `tests/host/engine.test.ts` 里那条「无边返回空数组」的用例。
 * 于是出现了本仓库反复出现的形态：**能力在、路径缺**——
 * 算得出来、存得下来、影响打分，就是没人看得见（同族：`history` 之前的
 * 修正记录、`pin` 之前的人工豁免、`confirmRecall` 至今零调用方）。
 *
 * ## 为什么复用 `resolveCardRef`
 *
 * 用户手上的 id 是**人读输出里印的前 8 位前缀**。`engine.inspect` 只认完整 id，
 * 不解析前缀的话，「从 list 抄 id 再查边」必然报没有这张卡——**出口与入口对不上，
 * 等于 id 白印**。`resolveCardRef` 已经把「精确优先 → 前缀匹配 → 歧义绝不挑一张」
 * 这套语义定死了一次（`restore` / `revise` / `history` 都走它），
 * 这里再写一份就是第二个真相源。
 *
 * ## 为什么打印英文关系名
 *
 * `same-entity` / `same-topic` / `supersedes` / `distills` 这些是
 * `EDGE_RELATIONS` 的原值，仓库里**没有**边关系的中文标签（只有 `kindLabel`
 * 管卡片类型）。在这里现造一套中文名会立刻变成两个真相源：
 * 配置文件、诊断日志、`export` 出来的 JSON 全是英文，只有终端是中文，
 * 用户搜不到自己看到过的那个词。**少一份实现少一处漂移。**
 *
 * ## 上限
 *
 * 一张卡的边数理论上受 `graph.entityNeighbors` / `topicNeighbors` 限制，
 * 但那是**建边时**的度数上限，历史累积的边（夜整理只补不删）可以超过它。
 * 所以这里仍然有硬上界 `output.listMaxEdges`（默认 100），
 * 并在截断时说清「还剩多少条没显示」。
 *
 * @param options - 解析后的参数（只用到 `positionals[0]` 与 `--json`）。
 * @param engine - 记忆引擎（只调用其只读入口）。
 * @param resolved - 已解析的配置，提供这次生效的边数上限。
 * @returns 命令结果。
 */
export function runEdges(
  options: CliOptions,
  engine: MemoryEngine,
  resolved: ResolvedCliConfig,
): CliResult {
  const ref = (options.positionals[0] ?? '').trim()
  if (ref.length === 0) {
    return usageFailure('edges 需要一个卡片 id，例如：memoryctl edges 1a2b3c4d')
  }

  // 共用解析器：失败文案与退出码在 `resolveCard.ts` 定死一次，
  // 这里直接返回，不另拼一份。
  const target = resolveCardRef(engine, ref)
  if (!target.ok) return target.result
  const card = target.card

  const cap = resolved.config.output.listMaxEdges
  // 显式排序，不依赖数据面：`store.edgesOf` 现在是「边 id 升序」，
  // 而边 id 是哈希、对人没有意义。这里换成对人有意义的键（见 compareEdges）。
  // 显式的第二个理由：反向验证要能精确打中这一行——依赖下层兜底时打不中。
  const edges = [...engine.edges(card.id)].sort((a, b) => compareEdges(a, b, card.id))
  const shown = edges.slice(0, cap)
  const truncated = edges.length > shown.length

  // 对端 id 一律印**完整 id**（不是前缀）：这是脚本要拿去 `edges <id>` /
  // `restore <id>` 的机器可读字段。人读的卡片行才印前缀。
  const peers = shown.map((edge) => {
    const other = edge.from === card.id ? edge.to : edge.from
    return {
      id: edge.id,
      peer: other,
      peerRef: formatCardRef(other),
      direction: edge.from === card.id ? 'out' : 'in',
      relation: edge.relation,
      weight: edge.weight,
    }
  })

  if (options.json) {
    return {
      code: EXIT_OK,
      stdout: jsonText({
        id: card.id,
        ref: formatCardRef(card.id),
        kind: card.kind,
        domain: card.domain,
        text: card.text,
        status: card.status,
        total: edges.length,
        shown: shown.length,
        limit: cap,
        truncated,
        empty: edges.length === 0,
        edges: peers,
      }),
      stderr: '',
    }
  }

  const head =
    `${formatCardRef(card.id)}（${kindLabel(card.kind)}·${card.domain}）` +
    truncate(card.text, resolved.config.recall.maxCardChars)
  const lines: string[] = [head]

  if (edges.length === 0) {
    // 空状态必须显式说明。空输出会被读成「命令坏了」，
    // 而这里还有第二层含义要讲清：**无边是正常的**。
    // 只有夜整理才建边，一个刚写入、还没跑过整理的库必然一条边都没有。
    lines.push('这张卡还没有连边。')
    lines.push('（图谱边由夜整理产出：运行 memoryctl consolidate 之后再看。）')
  } else {
    for (const peer of peers) {
      const arrow = peer.direction === 'out' ? '→' : '←'
      lines.push(`- ${arrow} ${peer.peerRef}  ${peer.relation}  权重 ${fmt(peer.weight)}`)
    }
    if (truncated) {
      lines.push(
        `…只列出前 ${shown.length} 条（共 ${edges.length} 条）。` +
          `要更高的硬上界，改配置 output.listMaxEdges。`,
      )
    } else {
      lines.push(`共 ${edges.length} 条边。`)
    }
  }

  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/**
 * edges 的排序键：权重降序，同权重按**对端 id** 升序，再按关系名升序。
 *
 * 为什么不沿用数据面的「边 id 升序」：边 id 是 `fnv1a64(from,to,relation)` 的
 * 哈希，对人**没有任何意义**——它是随机噪声。用户看这张列表要回答的问题是
 * 「谁跟这张卡最相关」，所以第一键必须是权重。
 *
 * 破平必须一路破到确定性为止：
 *
 * 1. 同权重时用对端 id —— 它是主键，全序成立。
 * 2. 同一对端之间可能有**多条关系**（`same-entity` 与 `same-topic` 可以并存），
 *    它们权重、对端都相同，所以还要按关系名破一次。少了这一层，
 *    两行谁先谁后取决于 `Map` 的迭代顺序（插入顺序），
 *    **同样的库两次运行能看到不同顺序**——正是 ST-1 禁止的那类漂移。
 * 3. 最后仍用边 id 兜底：理论上 (对端, 关系) 已唯一决定边 id，
 *    但比较函数不能建立在「理论上」之上——返回 0 会让 `sort` 回退到输入顺序。
 *
 * ## 为什么导出它
 *
 * 与 `compareListCards` 同一个理由：**它必须能被单独测**。
 * 端到端用例里的边来自一次真实的夜整理，那批边的两个对端关系
 * （`same-entity@0.330` 与 `same-topic@0.150`）**权重不同、对端相同**，
 * 于是「同权重」「不同对端」「同一对端的两种关系」这三层破平
 * **一条都没被走到**。只断言端到端顺序，把第 2、3 层整个删掉也不会变红
 * ——那不是测试写得好，是断言选错了层次（AGENTS.md「断言选错层次时，
 * 反向验证不会变红」）。
 *
 * 导出后让 `tests/cli/edges.test.ts` 直接对比较器下断言：手造的边只用于
 * **排序**这一件事，边的**产出**仍由端到端用例守（两者分工，缺一不可）。
 *
 * @param a - 左边的边。
 * @param b - 右边的边。
 * @param selfId - 被查的那张卡，用于算对端。
 * @returns 比较结果。
 */
export function compareEdges(a: MemoryEdge, b: MemoryEdge, selfId: string): number {
  const peerA = a.from === selfId ? a.to : a.from
  const peerB = b.from === selfId ? b.to : b.from
  if (b.weight !== a.weight) return b.weight - a.weight
  if (peerA !== peerB) return peerA < peerB ? -1 : 1
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}
