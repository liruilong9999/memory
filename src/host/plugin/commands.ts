/**
 * `/memory` 会话内命令的实现。
 *
 * 只读为主：命令是给人看的，不应该顺带改变记忆状态。
 * 唯一例外是 `rebuild`（FR-F4 重建），它是显式请求的运维动作。
 *
 * @module dsh-memory/host/plugin/commands
 */

import { renderCardHistory, renderFocusPackExplain } from '../../core/render.ts'
import { lookupCard } from '../../core/scoring.ts'
import type { MemoryCard } from '../../core/types.ts'
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
  return `未知子命令「${command}」，可用：status / health / rebuild / explain / restore / revise / history`
}
