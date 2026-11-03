/**
 * `/memory` 会话内命令的实现。
 *
 * 只读为主：命令是给人看的，不应该顺带改变记忆状态。
 * 唯一例外是 `rebuild`（FR-F4 重建），它是显式请求的运维动作。
 *
 * @module dsh-memory/host/plugin/commands
 */

import { renderFocusPackExplain } from '../../core/render.ts'
import type { MemoryEngine } from '../engine.ts'

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
    const id = trimmed.slice('restore'.length).trim()
    if (id.length === 0) return '用法：/memory restore <卡片 id>'
    const card = engine.inspect(id)
    if (card === undefined) return `没有这张卡：${id}`
    if (!engine.restore(id)) return `这张卡没有被归档（当前状态：${card.status}），无需恢复`
    return `已恢复：${id}`
  }
  if (command === 'revise') {
    // FR-A5 的生产入口。此前 `revisions` 数组**恒为空**，
    // 「可查历史」能查到的历史永远是空的。
    const rest = trimmed.slice('revise'.length).trim()
    const space = rest.indexOf(' ')
    if (space < 0) return '用法：/memory revise <卡片 id> <新正文>'
    const id = rest.slice(0, space)
    const text = rest.slice(space + 1).trim()
    if (id.length === 0 || text.length === 0) return '用法：/memory revise <卡片 id> <新正文>'
    const card = engine.inspect(id)
    if (card === undefined) return `没有这张卡：${id}`
    if (!engine.revise(id, text, '会话内手动修正')) return '正文没有变化，未写入修正记录'
    return `已修正：${id}`
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
  return `未知子命令「${command}」，可用：status / health / rebuild / explain / restore / revise`
}
