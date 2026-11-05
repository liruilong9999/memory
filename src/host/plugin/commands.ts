/**
 * `/memory` 会话内命令的实现。
 *
 * 只读为主：命令是给人看的，不应该顺带改变记忆状态。
 * 唯一例外是 `rebuild`（FR-F4 重建），它是显式请求的运维动作。
 *
 * @module dsh-memory/host/plugin/commands
 */

import { renderCardHistory, renderFocusPackExplain } from '../../core/render.ts'
import { fmt, formatCardRef, formatTime, kindLabel, lookupCard } from '../../core/scoring.ts'
import { truncate } from '../../core/text.ts'
import type { MemoryCard, MemoryEdge } from '../../core/types.ts'
import type { MemoryEngine } from '../engine.ts'

/**
 * 解析会话内命令给的卡片引用（完整 id 或人读输出里印的前缀）。
 *
 * 人读输出（`/memory explain` 与 `memoryctl query`）里印的是前 8 位，
 * 而 `engine.inspect` 只认完整 id。不做这一步，用户从屏幕上抄来的字符串
 * 必然得到「没有这张卡」——**输出与输入对不上，id 就白印了**。
 *
 * 返回字符串表示失败（已经是给人看的话），返回卡片表示成功。
 * **有歧义绝不挑一张**：悄悄改了另一张卡而一切看起来正常，是查不出来的错。
 *
 * @param engine - 记忆引擎（只调用只读入口）。
 * @param ref - 用户写的引用。
 * @returns 解析出的卡片，或一句失败说明。
 */
function resolveCardInSession(engine: MemoryEngine, ref: string): MemoryCard | string {
  const exact = engine.inspect(ref)
  if (exact !== undefined) return exact
  // 未命中才扫全库做前缀匹配。归档卡也要在候选里——`restore` 的主顾正是它们。
  const found = lookupCard(engine.query({}), ref)
  if (found.ok) return found.card
  return found.message
}

/**
 * 会话内渲染历史用的时区。
 *
 * 引擎不暴露 `timeZone`（它是私有的），`buildTime` 是唯一合法出口：
 * 用引擎自己的时钟取一个 `TimeState`，把里面的时区交给渲染层。
 * 这样 `/memory history` 与 `memoryctl history` 在同一台机器上显示同一时刻。
 *
 * @param engine - 记忆引擎。
 * @returns IANA 时区名。
 */
function sessionTimeZone(engine: MemoryEngine): string {
  return engine.buildTime(engine.now()).timeZone
}

/**
 * `/memory pin` 与 `/memory unpin` 的共同实现。
 *
 * ## 为什么这里自己拼字符串，而不复用 CLI 的 `runPin`
 *
 * 会话命令的返回类型是 `string`（要直接塞进对话里给人看），CLI 返回的是
 * `{ code, stdout, stderr }`（还有退出码要区分）。两者共用**动作**（都调
 * `engine.pin` / `engine.unpin`），但出口形状不同——强行共用会让会话里
 * 多出一层退出码概念，或者让 CLI 丢掉「状态没变」与「卡不存在」的分辨。
 * 与 `restore` / `revise` 在上面的写法保持一致。
 *
 * ## 「已经钉住了」为什么不算成功
 *
 * 与 CLI 同一套语义（那里有详细理由）：状态没变 ⇒ `false` ⇒ 明说没写记录。
 * 静默返回「已钉住」会让用户以为这次调用起了作用，而它什么都没做。
 *
 * @param engine - 记忆引擎。
 * @param trimmed - 去掉首尾空白后的整条命令（含子命令名）。
 * @param target - 目标 `pinned` 值。
 * @returns 给人看的结果文本。
 */
function runPinInSession(engine: MemoryEngine, trimmed: string, target: boolean): string {
  const word = target ? 'pin' : 'unpin'
  const ref = trimmed.slice(word.length).trim()
  if (ref.length === 0) return `用法：/memory ${word} <卡片 id>`
  const resolved = resolveCardInSession(engine, ref)
  if (typeof resolved === 'string') return resolved
  const changed = target ? engine.pin(resolved.id) : engine.unpin(resolved.id)
  if (!changed) {
    return target
      ? `这张卡已经钉住了（卡片 id：${resolved.id}），无需重复操作`
      : `这张卡本来就没有钉住（卡片 id：${resolved.id}），无需取消`
  }
  return `${target ? '已钉住' : '已取消钉住'}：${resolved.id}`
}

/**
 * `/memory list` 的实现。
 *
 * ## 为什么会话里也需要它
 *
 * 用户想知道「你还记得什么」，此前唯一的办法是 `/memory explain <关键词>`——
 * 而那是召回：它挑 7 张，挑不中就什么也不说，与「库是空的」同形。
 * 想知道库里有什么必须能**看全局**。
 *
 * ## 与 CLI `list` 的关系
 *
 * 同一套规则（排序键、截断、空状态说明），但**不共用渲染函数**：
 * CLI 的 `runList` 返回 `{code, stdout, stderr}`，会话命令返回 `string`。
 * 共用需要把渲染拆成一个纯函数，那是对的；但它现在住在 `src/cli/` 下，
 * 而 `host` 不能 import `cli`（依赖方向是 `core ← store ← consolidate ← host`；
 * `cli` 是旁支而不是上游）。所以两边各写一份**同规则**的渲染，
 * 靠测试（同一批卡、同一条规则）与注释守住一致性。
 *
 * @param engine - 记忆引擎。
 * @param timeZone - 渲染时间用的时区。
 * @returns 给人看的结果文本。
 */
function renderSessionList(engine: MemoryEngine, timeZone: string): string {
  const limits = engine.outputLimits()
  const cap = limits.listMaxCards
  // 排序键与 CLI 一致：updatedAt 降序，同刻 id 升序破平。
  // 破平不能省——同一轮写入的卡 updatedAt 完全相同，而输入顺序来自
  // `Map` 的插入顺序，那与用户无关却会改变他两次看到的顺序。
  const cards = [...engine.query({ status: 'active' })].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  if (cards.length === 0) return '记忆库里还没有活跃卡。'
  const shown = cards.slice(0, cap)
  const lines = shown.map((card) => {
    const head = `- ${kindLabel(card.kind)}·${card.domain} ${truncate(card.text, limits.maxCardChars)}`
    const traits = [
      formatCardRef(card.id),
      `强度 ${fmt(card.strength)}`,
      card.pinned ? '★已钉住' : '未钉住',
      `更新于 ${formatTime(card.updatedAt, timeZone)}`,
    ]
    return `${head}\n  ${traits.join('  ')}`
  })
  if (cards.length > shown.length) {
    lines.push(`…只列出前 ${shown.length} 张（共 ${cards.length} 张）。`)
  } else {
    lines.push(`共 ${shown.length} 张活跃卡。`)
  }
  return lines.join('\n')
}

/**
 * `/memory edges` 的实现。
 *
 * 关系名保持英文原值（`same-entity` / `same-topic` / …）：仓库里没有边关系的
 * 中文标签，在这里现造一套会让终端与配置文件、诊断日志、导出 JSON 说两家话。
 *
 * @param engine - 记忆引擎。
 * @param ref - 用户给的卡片引用（完整 id 或前缀）。
 * @returns 给人看的结果文本。
 */
function renderSessionEdges(engine: MemoryEngine, ref: string): string {
  const resolved = resolveCardInSession(engine, ref)
  if (typeof resolved === 'string') return resolved
  const cap = engine.outputLimits().listMaxEdges
  // 与 CLI 同一条排序规则：权重降序 → 对端 id 升序 → 关系名升序 → 边 id 兜底。
  const edges = [...engine.edges(resolved.id)].sort((a, b) => compareSessionEdges(a, b, resolved.id))
  if (edges.length === 0) {
    return `这张卡还没有连边。\n（图谱边由夜整理产出：等一次整理之后再看。）`
  }
  const shown = edges.slice(0, cap)
  const lines = shown.map((edge) => {
    const other = edge.from === resolved.id ? edge.to : edge.from
    const arrow = edge.from === resolved.id ? '→' : '←'
    return `- ${arrow} ${formatCardRef(other)}  ${edge.relation}  权重 ${fmt(edge.weight)}`
  })
  if (edges.length > shown.length) {
    lines.push(`…只列出前 ${shown.length} 条（共 ${edges.length} 条）。`)
  } else {
    lines.push(`共 ${edges.length} 条边。`)
  }
  return lines.join('\n')
}

/**
 * 会话 `edges` 的比较器。
 *
 * @param a - 左边的边。
 * @param b - 右边的边。
 * @param selfId - 被查的那张卡。
 * @returns 比较结果。
 */
function compareSessionEdges(a: MemoryEdge, b: MemoryEdge, selfId: string): number {
  const peerA = a.from === selfId ? a.to : a.from
  const peerB = b.from === selfId ? b.to : b.from
  if (b.weight !== a.weight) return b.weight - a.weight
  if (peerA !== peerB) return peerA < peerB ? -1 : 1
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/**
 * `/memory` 命令实现。
 *
 * 只读为主：命令是给人看的，不应该顺带改变记忆状态。
 * 唯一例外是 `rebuild`（FR-F4 重建），它是显式请求的运维动作。
 *
 * @param engine - 记忆引擎。
 * @param args - 命令参数。
 * @returns 命令结果文本。
 */
export function runMemoryCommand(engine: MemoryEngine, args: string): string {
  const trimmed = args.trim()
  const command = trimmed.length === 0 ? 'status' : (trimmed.split(/\s+/u)[0] ?? 'status')
  if (command === 'health') {
    const health = engine.health()
    const lines = [
      `健康：${health.healthy ? '正常' : '异常'}`,
      `活跃：${health.active} 张`,
      `归档：${health.archived} 张`,
      `图谱边：${health.edges} 条`,
      `索引：${health.indexOk ? '一致' : '不一致'}`,
    ]
    return lines.join('\n')
  }
  if (command === 'rebuild') {
    const report = engine.rebuild()
    return `索引已重建：扫描 ${report.records} 条日志记录，活跃 ${report.active} 张`
  }
  if (command === 'restore') {
    // FR-C2 的生产入口。归档是**自动**发生的（autoArchive 默认开），
    // 在此之前用户没有任何办法撤销一次误归档——数据面有 `restore` 分支、
    // 有测试，但没有生产者。能力在、路径缺，比没实现更危险。
    const ref = trimmed.slice('restore'.length).trim()
    if (ref.length === 0) return '用法：/memory restore <卡片 id>'
    const resolved = resolveCardInSession(engine, ref)
    if (typeof resolved === 'string') return resolved
    if (!engine.restore(resolved.id)) {
      return `这张卡没有被归档（当前状态：${resolved.status}），无需恢复`
    }
    return `已恢复：${resolved.id}`
  }
  if (command === 'revise') {
    // FR-A5 的生产入口。此前 `revisions` 数组**恒为空**，
    // 「可查历史」能查到的历史永远是空的。
    const rest = trimmed.slice('revise'.length).trim()
    const space = rest.indexOf(' ')
    if (space < 0) return '用法：/memory revise <卡片 id> <新正文>'
    const ref = rest.slice(0, space)
    const text = rest.slice(space + 1).trim()
    if (ref.length === 0 || text.length === 0) return '用法：/memory revise <卡片 id> <新正文>'
    const resolved = resolveCardInSession(engine, ref)
    if (typeof resolved === 'string') return resolved
    if (!engine.revise(resolved.id, text, '会话内手动修正')) return '正文没有变化，未写入修正记录'
    return `已修正：${resolved.id}`
  }
  if (command === 'history') {
    // FR-A5 的读取出口。`revisions` 早有生产者（engine.revise / CLI revise /
    // 本命令的 revise），但此前**没有任何渲染代码读它**——`reason` 写进去了，
    // 却查不到。需求原文要的是「修正后可查『改过什么、为什么』」，
    // 而「写」与「可查」是两件事。
    const ref = trimmed.slice('history'.length).trim()
    if (ref.length === 0) return '用法：/memory history <卡片 id>'
    const resolved = resolveCardInSession(engine, ref)
    if (typeof resolved === 'string') return resolved
    return renderCardHistory(resolved, sessionTimeZone(engine))
  }
  if (command === 'list') {
    // FR-F1 的会话出口。此前想看库里有什么只能 `/memory explain <关键词>`，
    // 那会挑 7 张、挑不中就说不出话——与「库是空的」同形。
    return renderSessionList(engine, sessionTimeZone(engine))
  }
  if (command === 'edges') {
    // FR-G1 的会话出口。`engine.edges` 早在，生产零调用方——
    // 图算得出、存得下、影响打分，就是没人看得见（缺陷十七的同族形态）。
    const ref = trimmed.slice('edges'.length).trim()
    if (ref.length === 0) return '用法：/memory edges <卡片 id>'
    return renderSessionEdges(engine, ref)
  }
  if (command === 'pin') {
    // FR-C3 的人工豁免。`shouldArchive` 里 `if (card.pinned) return false` 早就在，
    // 但在本命令之前**没有任何入口能把 pinned 置成 true**：字段认了、判定写了、
    // 测试绿了，用户却够不到。这是 restore 那条「能力在、路径缺」的同一个形态。
    return runPinInSession(engine, trimmed, true)
  }
  if (command === 'unpin') {
    // 豁免必须能撤销：否则一次误操作就把「忘得掉」（起源 L11「细节会忘」）
    // 永久关掉了，而用户没有任何办法改回来。
    return runPinInSession(engine, trimmed, false)
  }
  if (command === 'status') {
    const metrics = engine.metrics()
    const health = engine.health()
    return [
      `活跃 ${health.active} 张 / 归档 ${health.archived} 张`,
      `图谱边 ${health.edges} 条`,
      `本次会话召回 ${metrics.recalls} 次`,
      `上次整理：${metrics.lastConsolidationAt === null ? '从未' : new Date(metrics.lastConsolidationAt).toISOString()}`,
      engine.sinceLastSession(),
    ].join('\n')
  }
  if (command === 'explain') {
    // FR-B4「可解释」：`ScoredCard.explain` 一直算出来了却没有任何出口，
    // 等于「算了但没暴露」。这个子命令把每个候选的分数构成摆出来，
    // 让「为什么想起这张卡」可以被人核对。
    //
    // 渲染走 `src/core/render.ts` 的共享实现，与 CLI 的 `query` 同一份代码。
    // 两处取数不同（本命令走 engine.recall 会刷新访问计数，CLI 走只读召回），
    // 但输出格式必须一致——原先两处各写一遍靠人肉同步，现已收敛。
    const result = engine.recall(trimmed.slice('explain'.length).trim())
    return renderFocusPackExplain(result.pack, result.candidates)
  }
  return `未知子命令「${command}」，可用：status / health / rebuild / explain / list / edges / restore / revise / history / pin / unpin`
}
