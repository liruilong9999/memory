/**
 * 图谱边的构造内核（纯函数）。
 *
 * ## 为什么这些函数在这里，而不在 `src/consolidate/graph.ts`
 *
 * `src/consolidate/graph.ts` 负责的是**策略**：给定一批活跃卡，按相似度/实体/时间
 * 关系决定该连哪些边、权重怎么算。那是「巩固面」的判断，会随整理策略演进。
 *
 * 本文件负责的是**契约级的构造**：某一种语义关系被确定要建立时，那条边的形状
 * （id 怎么派生、权重初始值、时间戳取哪个）必须处处一致。这类规则一旦分叉就会
 * 出现「同一个语义有两种边」，图谱查询随之失真。
 *
 * 它放在 `core/` 还有一个硬理由：`src/store/state.ts`（数据面）在重放 `merge`
 * 操作时要自动建 `supersedes` 边。数据面只允许依赖 `core/`，如果构造逻辑留在
 * `consolidate/`，数据面要么反向 import（违反分层），要么自己再抄一份（两份真相）。
 *
 * 判断标准沿用 `AGENTS.md`：`types.ts` 定义「数据长什么样」，本文件定义
 * 「某条语义成立时，那条数据长什么样」。**不要**把这些函数塞回 `types.ts`——
 * 那里是纯类型契约，混入构造逻辑会让契约层变成第二个业务层。
 *
 * ## 全部函数必须无副作用（ST-1）
 *
 * 同样输入必须得到同样输出，不读时钟、不读配置、不读全局状态。时刻一律由调用方
 * 作为参数传入。
 */

import { buildEdgeId } from './types.ts'
import type { EdgeRelation, MemoryEdge } from './types.ts'

/**
 * 边权量化格：边权的最小可表示变化量（两位小数）。
 *
 * ## 为什么它必须是一个导出的常量（缺陷二十）
 *
 * 边权原本在 `makeEdge` 里就地写 `Math.round(w * 100) / 100`，这个「两位小数」
 * 的粒度只存在于那一行代码里，**没有任何名字**。于是可塑性层（`src/core/spread.ts`）
 * 各自又写了同样的一行，三处互不知道对方的存在。
 *
 * 后果不是「精度不一致」这种审美问题，而是**机制在数学上停摆**：
 * `decayFactor = 0.98` 时，权重 `w` 的每步衰减量是 `0.02 × w`；当 `w ≤ 0.25` 时
 * 这个量小于量化格的一半（0.005），四舍五入后**原地不动**。实测 `0.30 → 0.25`
 * 走 11 夜后冻结 500 夜不变，`prunableEdges` 一次都没触发过——整个「遗忘」机制
 * 一行都没真正执行过，而它不报错、不崩溃、日志正常、测试全绿。
 *
 * 把粒度提成常量，是为了让「每步至少变化一格」这条规则有地方可写。
 */
export const EDGE_WEIGHT_STEP = 0.01

/**
 * 把边权对齐到量化格。
 *
 * 实现刻意写成 `Math.round(w * 100) / 100` 而**不是** `Math.round(w / 0.01) * 0.01`：
 * 后者会算出 `0.30000000000000004` 这种尾数，让「边权是否等于 0.3」重新变成
 * 不可断言的事——那正是引入量化格要解决的问题。乘除同一个十进制数才能保证
 * 结果与源码里的字面量 `0.3` 逐位相同。
 *
 * @param weight - 任意权重（不做 0..1 夹取，夹取是 `makeEdge` 的事）。
 * @returns 对齐到格点的权重。
 */
export function quantizeWeight(weight: number): number {
  return Math.round(weight * 100) / 100
}

/**
 * 权重降一格。
 *
 * 用于「必须变弱」的场合：当按比例算出的衰减量不足一格时，直接减一格，
 * 保证衰减**永远**真的发生（缺陷二十）。
 *
 * @param weight - 当前权重。
 * @returns 比输入严格小一格的权重；已在下限时返回 0。
 */
export function stepDownWeight(weight: number): number {
  return quantizeWeight(Math.max(0, weight - EDGE_WEIGHT_STEP))
}

/**
 * 造一条边。
 *
 * 权重会被夹到 0..1 并保留两位小数（见 `quantizeWeight`）。
 *
 * @param from - 起点卡 id。
 * @param to - 终点卡 id。
 * @param relation - 边语义。
 * @param weight - 期望权重，超出 0..1 会被夹取。
 * @param at - 建立时刻。
 * @returns 新的图谱边。
 */
export function makeEdge(
  from: string, to: string, relation: EdgeRelation, weight: number, at: number,
): MemoryEdge {
  const bounded = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0
  return {
    id: buildEdgeId(from, to, relation),
    from,
    to,
    relation,
    weight: quantizeWeight(bounded),
    createdAt: at,
  }
}

/**
 * 为「合并」自动建立 `supersedes` 边：被并入的每一张卡都指向合并后的卡。
 *
 * 需求依据：合并意味着「这些记录说的是同一件事，保留一条权威版本」。这条边不是
 * 装饰——没有它，被合并掉的卡就只剩一个 `mergedInto` 字段，图谱层查不到任何线索，
 * 「A 被 B 取代」这个事实无法从边查询、无法参与扩散、也无法解释给用户看（FR-B4）。
 *
 * 语义方向固定为 `被并入 → 合并结果`（旧指向新），与 `docs/3-架构设计.md` §7 的
 * 定义一致：`supersedes` 的起点是**被取代的旧版本**。
 *
 * 权重固定为 1：合并是确定的、无歧义的取代关系，不存在「有多像」的问题。
 * 给这类边一个中间权重反而会让扩散打分以为它不如别的边可信。
 *
 * @param absorbedIds - 被并入（作废）的卡 id 列表，顺序无关。
 * @param intoId - 合并后保留的卡 id。
 * @param at - 合并时刻。
 * @returns 每条被并入卡对应一条边；`absorbedIds` 为空时返回空数组。
 */
export function mergeSupersedesEdges(
  absorbedIds: readonly string[], intoId: string, at: number,
): MemoryEdge[] {
  const edges: MemoryEdge[] = []
  // 去重：同一次合并里重复的 id 只会产生一条边（`buildEdgeId` 本身也是稳定的，
  // 但重复项会让返回数组出现同一个 id 两次，调用方按 id 建 Map 时会静默吞掉一条）。
  const seen = new Set<string>()
  for (const id of absorbedIds) {
    if (id === intoId) continue
    if (seen.has(id)) continue
    seen.add(id)
    edges.push(makeEdge(id, intoId, 'supersedes', 1, at))
  }
  return edges
}

/**
 * 为「感受蒸馏」建立 `distills` 边：感受卡指向它由之提炼出来的事件卡。
 *
 * 需求依据：起源 L11（无编号·细节会忘）与起源 L19（无编号·感受经验）。
 * 「细节会忘，只留感受」如果只做到「留下感受卡」，那感受就成了一句无根的断言——
 * 用户问「我为什么会有这个感受」，系统答不出来。`distills` 边就是那根根：
 * 感受卡 → 若干个来源卡，说明这份感受是从哪些事里提炼的。
 *
 * 方向固定为 `感受 → 来源`（提炼物指向原料），与 `supersedes` 的「旧 → 新」相反，
 * 这是有意的：`distills` 表达的是**抽象层次**（低层事件 → 高层感受），
 * 而不是时间上的取代。
 *
 * 权重表达「这份感受有多依赖这一条来源」：传入 `weight` 由调用方按来源的
 * 情绪强度/显著性算出，本函数只负责夹取与稳定化。
 *
 * @param feelingId - 蒸馏出的感受卡 id。
 * @param sourceIds - 来源卡 id 列表。
 * @param weight - 单条来源的依赖权重（0..1）；所有来源共用一个值。
 * @param at - 蒸馏时刻。
 * @returns 每条来源对应一条边；来源为空时返回空数组（无来源的感受不建边，
 *          因为「凭空产生的感受」在本系统里不该存在）。
 */
export function distillEdges(
  feelingId: string, sourceIds: readonly string[], weight: number, at: number,
): MemoryEdge[] {
  const edges: MemoryEdge[] = []
  const seen = new Set<string>()
  for (const id of sourceIds) {
    if (id === feelingId) continue
    if (seen.has(id)) continue
    seen.add(id)
    edges.push(makeEdge(feelingId, id, 'distills', weight, at))
  }
  return edges
}
