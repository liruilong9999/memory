/**
 * 图谱边构造函数单测：`mergeSupersedesEdges` 与 `distillEdges` 的形状约定。
 *
 * 为什么单独一个文件：这两个函数的**去重承诺**与**方向约定**只在这里可观测。
 * 数据面（`src/store/state.ts`）用它们建边，但 `state.edges` 是以 `buildEdgeId`
 * 为键的 Map——重复项后写覆盖前写、值又完全相同，所以在数据面**测不出去重**。
 * 把断言放在数据面会得到一条永远绿的假断言（实测过：把手抄版恢复回去，
 * 数据面那条断言照样绿）。**断言必须放在能观测到差异的那一层。**
 *
 * 对应需求：FR-A5（修正历史）、FR-A4（来源指针）、起源 L11（无编号·细节会忘）。
 *
 * @module tests/core/graph.test
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergeSupersedesEdges } from '../../src/core/graph.ts'
import { buildEdgeId } from '../../src/core/types.ts'

const AT = 1_700_000_000_000

describe('mergeSupersedesEdges（合并建边）', () => {
  it('每张被并入的卡各建一条边，方向是「被并入 → 合并结果」', () => {
    const edges = mergeSupersedesEdges(['a', 'b'], 'into', AT)
    // 方向单独断言：`supersedes` 的起点是**被取代的旧版本**，
    // 反了会让扩散把废弃内容推上台面（与 FR-A5 相反）。
    assert.deepEqual(edges.map((e) => `${e.from}→${e.to}`).sort(), ['a→into', 'b→into'])
    // id 由 `buildEdgeId` 派生（FNV-1a 哈希），不写字面量，只断言
    // 「同一对端点 + 同一关系得到同一个 id」，这是它的契约。
    assert.deepEqual(
      edges.map((e) => e.id).sort(),
      [buildEdgeId('a', 'into', 'supersedes'), buildEdgeId('b', 'into', 'supersedes')].sort(),
    )
  })

  it('同一次合并里重复的 id 只产生一条边', () => {
    // 这条守的是函数注释里那句「去重：同一次合并里重复的 id 只会产生一条边」。
    // 注释声称的行为必须有一条测试真的去验它，否则注释会持续替实现撒谎。
    //
    // `op.ids` 来自日志、没人保证它不重复；如果这里返回两条同 id 的边，
    // 调用方按 id 建 Map 时静默吞掉一条看不出问题，但返回数组的长度、
    // 以及将来任何「按条数计费」的调用方都会出错。
    const edges = mergeSupersedesEdges(['a', 'a', 'b', 'a'], 'into', AT)
    assert.equal(edges.length, 2, `去重后应为 2 条，实际：${edges.length}`)
    assert.equal(new Set(edges.map((e) => e.id)).size, 2, 'id 不得重复')
  })

  it('权重固定为 1，时刻取传入的合并时刻', () => {
    // 权重固定为 1 的理由写在函数注释里：合并是确定的取代关系，
    // 不存在「有多像」；给中间权重会让扩散以为它不如别的边可信。
    const edges = mergeSupersedesEdges(['a'], 'into', AT)
    assert.equal(edges.length, 1)
    assert.equal(edges[0]?.weight, 1)
    assert.equal(edges[0]?.createdAt, AT)
    assert.equal(edges[0]?.relation, 'supersedes')
  })

  it('被并入列表里含合并目标自己时跳过（不能自己取代自己）', () => {
    const edges = mergeSupersedesEdges(['into', 'a'], 'into', AT)
    assert.deepEqual(edges.map((e) => e.from), ['a'])
  })

  it('空列表返回空数组（无来源的边不该存在）', () => {
    assert.deepEqual(mergeSupersedesEdges([], 'into', AT), [])
  })
})
