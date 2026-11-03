/**
 * 打分内核：决定「此刻该想起哪几条记忆」。
 *
 * 需求 FR-B1：总分 = 语义相关 + 重要性 + 时间衰减 + 目标匹配 + 置信度 − 冲突惩罚。
 * 需求 FR-B3 / ST-1：同样状态、同样查询，必须得到完全相同的排序——
 * 因此本文件**没有随机数、没有 Date.now()、没有浮点累积误差陷阱**，
 * 时间一律由参数 `now` 传入。
 *
 * 起源 L29（第 5 条·专注当前位置）讲「人的注意力会自动屏蔽无关记忆，只保留和当前相关的」，
 * 这就是打分与阈值截断在做的事：不是「把库塞进上下文」，而是「把焦点放进上下文」。
 *
 * @module dsh-memory/core/scoring
 */

export type { RecallQuery } from './scoring/score.ts'
export {
  clamp01, conflictPenalty, effectiveHalfLife, goalScore, importanceScore, makeQuery,
  recencyScore, scoreCard, semanticScore,
} from './scoring/score.ts'
export { filterByDomain, scoreCards } from './scoring/spread.ts'
export { EMPTY_PACK_NOTE, applyThresholds, buildFocusPack } from './scoring/pack.ts'
export {
  buildExplain, describeConflictPeers, formatCardLine, formatDuration, formatTime, kindLabel,
  renderEmptyNote, renderFocusPack,
} from './scoring/render.ts'
