/**
 * FR-G1（图谱）的**查询出口**：`memoryctl edges <id>` 与 `/memory edges <id>`。
 *
 * ## 为什么这个文件存在
 *
 * `engine.edges(id)` 一直都在（`src/host/engine.ts` → `store.edgesOf`），
 * 扩散激活也已经拿它影响排序，但**生产代码零调用方**——唯一的调用者是
 * `tests/host/engine.test.ts` 里那条「无边返回空数组」的用例。
 * 于是出现了本仓库反复出现的形态：**能力在、路径缺**。
 * 算得出来、存得下来、影响打分，就是没人看得见。
 *
 * ## 本文件最重要的一条纪律：边必须由**真实链路**产出
 *
 * 直接往 store 里塞一条 `MemoryEdge` 是**跳过被测那一层**：
 * 被测的是「用户能不能查到夜整理产出的边」，而塞进去的边从没经过
 * 夜整理，所以「夜整理根本没产边」这条缺陷溜得过去。
 * 本仓库为此栽过——`tests/core/spread.test.ts` 那 40 条全直接调
 * `scoreCards` 自己造边，从未经过「写入 → 夜整理产边 → 召回」，
 * 这正是缺陷三十二（扩散恒为空集）能藏住整整一轮的原因。
 *
 * 所以这里全部走 `engine.writeTurn(...)` + `engine.consolidate(...)`，
 * 并且**给每一段配前提断言**：
 *
 * - 整理前：`store.allEdges().length === 0`，且命令输出「这张卡还没有连边」
 * - 整理后：`store.allEdges().length > 0`，且命令输出真读到了那些边
 *
 * 少了整理前那半，「整理后能读到边」在「边其实是别处塞进来的」实现下也绿。
 *
 * ## 语义提示
 *
 * 边只在夜整理里**新建**，从不修改、从不删除（`nightly.ts` 用
 * `knownEdgeIds` 过滤）。所以「无边」是**正常状态**——一个刚写入、
 * 还没跑过整理的库必然一条边都没有。空状态文案必须把这层说清，
 * 否则用户会以为图谱坏了。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE, helpText, runCli } from '../../src/cli/memoryctl.ts'
import { compareEdges } from '../../src/cli/commands/edges.ts'
import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config.ts'
import type { MemoryCard, MemoryEdge } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { runMemoryCommand } from '../../src/host/plugin/commands.ts'
import { openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeCard, makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

/**
 * 产边语料：两句话共享**引号专名** `「CordisPlugin」`，
 * 另各带一个自己的专名 ⇒ `same-entity` 边权 = 1/3（不是 1.0）。
 *
 * 为什么必须用引号专名：`extractEntities` 只认引号专名 / 路径 / URL / 标识符，
 * 普通中文名词抽不出来。用普通句子会建不出 `same-entity` 边，
 * 于是「能读到边」这条断言的数据前提就没了——而失败原因看起来会像
 * 「命令坏了」。（同源：`tests/host/engine.test.ts` 的 spreadLibrary 注释。）
 */
const SENTENCE_A = '决定「CordisPlugin」的版本用「ThreePointTwo」'
const SENTENCE_B = '决定「CordisPlugin」需要重新构建，因为「BuildScript」有问题'

const tempDirs: string[] = []

/**
 * 建一个登记过的临时目录，`after` 里统一清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function tempDir(prefix = 'dsh-memory-edges-cli-'): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

const fixedClock = (): number => T0

/**
 * 打开一个库并返回引擎与 store（调用方负责关闭）。
 *
 * @param dir - 数据目录。
 * @param config - 引擎配置。
 * @returns 引擎与 store。
 */
function openEngine(
  dir: string, config = DEFAULT_CONFIG,
): { engine: MemoryEngine; store: MemoryStore } {
  const store = openStore({ config, dataDir: dir })
  const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: fixedClock })
  return { engine, store }
}

/**
 * 通过**真实链路**往库里写入两张相关卡（`writeTurn`，与用户说话同一条路径）。
 *
 * @param engine - 记忆引擎。
 */
function writeTwoRelatedCards(engine: MemoryEngine): void {
  const sentences = [SENTENCE_A, SENTENCE_B]
  sentences.forEach((text, index) => {
    engine.writeTurn({
      sessionId: 'sess-edges', turn: index + 1, step: 1, seq: index + 1,
      userText: text, assistantText: '好的，我记下了。',
      domain: 'work', at: T0 + (index + 1) * 1000,
    })
  })
}

/**
 * 写一份只改动 `output.listMaxEdges` 的 patch。
 *
 * @param dir - 放 patch 的目录。
 * @param value - 目标上限。
 * @returns patch 绝对路径。
 */
function writeCapPatch(dir: string, value: number): string {
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, ['config:', '  output:', `    listMaxEdges: ${value}`, ''].join('\n'), 'utf8')
  return path
}

describe('edges：端到端链路（写入 → 夜整理产边 → 读到边）', () => {
  it('整理前无边且明确说「还没有连边」，整理后能读到夜整理产出的边', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      writeTwoRelatedCards(engine)
      const cards = store.listCards({ status: 'active' })
      assert.equal(cards.length, 2, '前提：两句话必须各出一张卡')

      // 前提断言（关键）：此刻库里**一条边都没有**。
      // 少了这条，「整理后能读到边」在「边其实是别处塞进来的」实现下也绿。
      assert.equal(store.allEdges().length, 0, '前提：整理之前不该有任何边')

      const ref = cards[0]!.id.slice(0, 8)
      const before = runCli(['edges', ref, '--data-dir', dir])
      assert.equal(before.code, EXIT_OK, before.stderr)
      assert.match(before.stdout, /这张卡还没有连边/u, '无边时必须明说，不能空输出')
      assert.match(before.stdout, /夜整理/u, '无边时必须说明边是夜整理产出的')

      // 真实产边：夜整理（唯一的生产者）。
      engine.consolidate(T0 + 200_000)
      const produced = store.allEdges()
      assert.ok(produced.length > 0, '前提：夜整理必须真的产出边，否则下面测的是空气')
      for (const edge of produced) {
        assert.equal(edge.from === cards[0]!.id || edge.to === cards[0]!.id, true,
          '前提：这些边必须有一端是我们查的那张卡')
      }

      const after = runCli(['edges', ref, '--data-dir', dir])
      assert.equal(after.code, EXIT_OK, after.stderr)
      assert.doesNotMatch(after.stdout, /还没有连边/u)
      // 对端前缀要印出来，用户才能顺着走下去。
      const other = cards[1]!.id.slice(0, 8)
      assert.ok(after.stdout.includes(other), `对端前缀 ${other} 必须出现在输出里`)
      // 关系名是英文原值（仓库没有边关系的中文标签）。
      assert.match(after.stdout, /same-entity|same-topic/u)
      // 「共 N 条边」的 N 必须等于数据面实测，而不是一个好看的数字。
      assert.ok(after.stdout.includes(`共 ${produced.length} 条边。`),
        `行数说明必须是 ${produced.length} 条（实测），实际输出：\n${after.stdout}`)
    } finally {
      store.close()
    }
  })

  it('--json 的每条边都能与 store 里的边一一对上（不重不漏）', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      writeTwoRelatedCards(engine)
      engine.consolidate(T0 + 200_000)
      const expected = store.allEdges()
      assert.ok(expected.length > 0, '前提：夜整理必须产出边')
      const id = store.listCards({ status: 'active' })[0]!.id

      const cli = runCli(['edges', id, '--data-dir', dir, '--json'])
      assert.equal(cli.code, EXIT_OK, cli.stderr)
      const payload = JSON.parse(cli.stdout) as {
        id: string
        ref: string
        total: number
        shown: number
        limit: number
        truncated: boolean
        empty: boolean
        edges: { id: string; peer: string; peerRef: string; direction: string; relation: string; weight: number }[]
      }
      assert.equal(payload.id, id)
      assert.equal(payload.ref, id.slice(0, 8))
      assert.equal(payload.empty, false)
      assert.equal(payload.truncated, false)
      assert.equal(payload.total, expected.length)
      assert.equal(payload.limit, DEFAULT_CONFIG.output.listMaxEdges)

      // 一一对上：边 id 集合完全相等（多一条 = 凭空造边，少一条 = 静默丢边）。
      assert.deepEqual(
        payload.edges.map((e) => e.id).sort(),
        expected.map((e) => e.id).sort(),
      )
      for (const edge of payload.edges) {
        assert.equal(edge.direction === 'out' || edge.direction === 'in', true)
        // 对端必须是这条边的另一端，不是随手挑的一张卡。
        const source = expected.find((e) => e.id === edge.id)
        assert.ok(source !== undefined, '前提：输出的边必须存在于数据面')
        const other = source.from === id ? source.to : source.from
        assert.equal(edge.peer, other)
        assert.equal(edge.peerRef, other.slice(0, 8))
        assert.equal(edge.relation, source.relation)
        assert.equal(edge.weight, source.weight)
      }
    } finally {
      store.close()
    }
  })
})

describe('edges：入参错误', () => {
  it('缺 id 返回用法错误，且给得出例子', () => {
    const dir = tempDir()
    const cli = runCli(['edges', '--data-dir', dir])
    assert.equal(cli.code, EXIT_USAGE)
    assert.equal(cli.stdout, '')
    assert.match(cli.stderr, /edges 需要一个卡片 id/u)
    assert.match(cli.stderr, /memoryctl --help/u)
  })

  it('卡片不存在返回 1，并说清是哪张', () => {
    const dir = tempDir()
    const cli = runCli(['edges', 'deadbeef', '--data-dir', dir])
    assert.equal(cli.code, EXIT_UNHEALTHY)
    assert.equal(cli.stdout, '')
    assert.match(cli.stderr, /没有这张卡：deadbeef/u)
  })

  it('完整 id 与 4 位前缀都能解析（复用 resolveCardRef）', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      writeTwoRelatedCards(engine)
      engine.consolidate(T0 + 200_000)
      const id = store.listCards({ status: 'active' })[0]!.id

      const exact = runCli(['edges', id, '--data-dir', dir, '--json'])
      const prefix = runCli(['edges', id.slice(0, 4), '--data-dir', dir, '--json'])
      assert.equal(exact.code, EXIT_OK, exact.stderr)
      assert.equal(prefix.code, EXIT_OK, prefix.stderr)
      // 同一个解析器 ⇒ 两个写法必须给出同一份结果。
      assert.equal(prefix.stdout, exact.stdout)
    } finally {
      store.close()
    }
  })

  it('前缀撞上两张卡时报用法错误并列出候选，不随便挑一张', () => {
    const dir = tempDir()
    const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
    // 两张卡的前 2 位相同（`aa`），其余不同。
    store.putCard(makeCard({ id: 'aa11111100000001', text: '甲', normalized: '甲' }))
    store.putCard(makeCard({ id: 'aa22222200000002', text: '乙', normalized: '乙' }))
    store.close()

    const cli = runCli(['edges', 'aa', '--data-dir', dir])
    assert.equal(cli.code, EXIT_USAGE, '歧义是用法错误，不是健康问题')
    assert.equal(cli.stdout, '')
    assert.match(cli.stderr, /匹配到 2 张/u)
    assert.match(cli.stderr, /aa111111/u)
    assert.match(cli.stderr, /aa222222/u)
  })
})

describe('edges：上限', () => {
  it('上限压到 1 时只列 1 条并说清还有多少（配对：默认全列）', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      writeTwoRelatedCards(engine)
      engine.consolidate(T0 + 200_000)
      // 这两句话会同时产出 same-entity 与 same-topic 两条边（实测 2 条），
      // 所以「上限 1」时一定有被截掉的。
      const total = store.allEdges().length
      assert.ok(total >= 2, `前提：这里至少要产出 2 条边才测得出截断，实际 ${total} 条`)
      const id = store.listCards({ status: 'active' })[0]!.id
      const patch = writeCapPatch(dir, 1)

      const capped = runCli(['edges', id, '--data-dir', dir], { configPath: patch })
      assert.equal(capped.code, EXIT_OK, capped.stderr)
      const payload = JSON.parse(
        runCli(['edges', id, '--data-dir', dir, '--json'], { configPath: patch }).stdout,
      ) as { total: number; shown: number; limit: number; truncated: boolean }
      // edges 没有 `--limit`：生效条数只由硬上界决定，所以 `limit` 就是配置值。
      assert.equal(payload.limit, 1)
      assert.equal(payload.total, total)
      assert.equal(payload.shown, 1)
      assert.equal(payload.truncated, true)
      assert.match(capped.stdout, /只列出前 1 条/u)

      // 配对正向断言：同一份库、不传 patch 时全部列出。
      const full = JSON.parse(runCli(['edges', id, '--data-dir', dir, '--json']).stdout) as {
        shown: number
        limit: number
        truncated: boolean
      }
      assert.equal(full.limit, DEFAULT_CONFIG.output.listMaxEdges)
      assert.equal(full.shown, total)
      assert.equal(full.truncated, false)
    } finally {
      store.close()
    }
  })
})

describe('edges：排序确定性（ST-1）', () => {
  it('比较器：权重降序 → 对端 id 升序 → 关系名升序（三层都要测到）', () => {
    // 为什么直接断言比较器，而不只依赖端到端顺序：
    // 端到端那批边来自一次真实的夜整理，它产出的两条边
    // `same-entity@0.330` 与 `same-topic@0.150` **权重不同、对端相同**，
    // 于是「同权重按对端 id」与「同一对端按关系名」这两层破平
    // **一条都没被走到**。只留端到端断言的话，把后两层整个删掉也不会变红。
    //
    // ⚠️ 边 id **必须显式给、且故意与前两层相反**，不能用 `${from}-${to}-${relation}` 这类
    // 由字段拼出来的 id：真实边 id 是 `fnv1a64(from,to,relation)` 的**哈希**，
    // 与关系名毫不相关；而拼出来的 id 把关系名编码进去了，于是最后一层
    // `a.id < b.id` 兜底会**恰好替关系层给出同一个答案**——删掉关系层，断言照样绿。
    // 这不是测试写得稳，是 fixture 替被测代码兜了底。
    // （同源：AGENTS.md「反向验证也能暴露装饰性测试」。）
    const self = 'aaaaaaaaaaaaaaaa'
    const mk = (
      id: string, from: string, to: string, relation: MemoryEdge['relation'], weight: number,
    ): MemoryEdge => ({ id, from, to, relation, weight, createdAt: T0 })

    // 权重层：0.9 > 0.7 > 0.5。删掉权重层会退到对端比较，
    // 而对端是 ffffffff > cccccccc，与期望相反 ⇒ 会红。
    const heavy = mk('a900000000000001', self, 'ffffffff00000001', 'same-topic', 0.9)
    const incoming = mk('b100000000000001', 'dddddddd00000001', self, 'supersedes', 0.7)
    // 对端层：`bbbb…` 必须排在 `cccc…` 前面，但**边 id 故意反过来**
    // （peerB 的 id 大、peerC 的 id 小）⇒ 删掉对端层、退到 id 兜底就会红。
    const peerB = mk('a200000000000001', self, 'bbbbbbbb00000001', 'same-topic', 0.5)
    const peerC = mk('a100000000000001', self, 'cccccccc00000001', 'same-topic', 0.5)
    // 关系层：同一对端、同一权重，`same-entity` < `same-topic`。
    // 边 id 同样故意反过来（z… > a…）⇒ 删掉关系层、退到 id 兜底就会红。
    const peerBEntity = mk('z100000000000001', self, 'bbbbbbbb00000001', 'same-entity', 0.5)

    assert.ok(compareEdges(heavy, incoming, self) < 0, '权重高的必须排在前面')
    assert.ok(compareEdges(incoming, peerC, self) < 0, '权重 0.7 必须排在 0.5 之前')
    assert.ok(compareEdges(peerC, heavy, self) > 0, '反向也必须成立')
    assert.ok(compareEdges(peerB, peerC, self) < 0, '同权重时对端 id 小的必须在前')
    assert.ok(compareEdges(peerC, peerB, self) > 0, '反向也必须成立')
    assert.ok(compareEdges(peerBEntity, peerB, self) < 0, '同一对端时关系名升序')
    assert.ok(compareEdges(peerB, peerBEntity, self) > 0, '反向也必须成立')
    // 自比较必须是 0，否则 sort 的行为依赖实现。
    assert.equal(compareEdges(peerB, peerB, self), 0)
  })

  it('端到端：真实产出的边按权重降序，跑两次逐字节相同', () => {
    // 为什么要直接看顺序而不是只看「有几条」：
    // 数据面的 `edgesOf` 是**按边 id 升序**（哈希序，对人无意义）。
    // 如果 CLI 不显式重排，用户看到的就是一串随机顺序——
    // 而「条数对」在两种顺序下都一样，所以条数断言抓不到它。
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      writeTwoRelatedCards(engine)
      engine.consolidate(T0 + 200_000)
      const id = store.listCards({ status: 'active' })[0]!.id
      const payload = JSON.parse(
        runCli(['edges', id, '--data-dir', dir, '--json']).stdout,
      ) as { edges: { peer: string; relation: string; weight: number }[] }
      assert.ok(payload.edges.length >= 2, '前提：至少两条边才排得出先后')

      for (let i = 1; i < payload.edges.length; i += 1) {
        const prev = payload.edges[i - 1]!
        const next = payload.edges[i]!
        if (prev.weight !== next.weight) {
          assert.ok(prev.weight > next.weight, `权重必须降序（第 ${i} 位违反了）`)
          continue
        }
        if (prev.peer !== next.peer) {
          assert.ok(prev.peer < next.peer, `同权重时对端 id 必须升序（第 ${i} 位违反了）`)
          continue
        }
        assert.ok(prev.relation <= next.relation, `同一对端时关系名必须升序（第 ${i} 位违反了）`)
      }

      // 跑两次必须逐字节相同（ST-1）。
      const again = runCli(['edges', id, '--data-dir', dir, '--json'])
      assert.equal(
        again.stdout,
        runCli(['edges', id, '--data-dir', dir, '--json']).stdout,
      )
    } finally {
      store.close()
    }
  })
})

describe('edges：会话内入口 /memory edges', () => {
  it('与 CLI 同一套语义：整理前说无边，整理后列出对端', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      writeTwoRelatedCards(engine)
      assert.equal(store.allEdges().length, 0, '前提：整理之前不该有任何边')
      const id = store.listCards({ status: 'active' })[0]!.id

      const before = runMemoryCommand(engine, `edges ${id.slice(0, 8)}`)
      assert.match(before, /这张卡还没有连边/u)

      engine.consolidate(T0 + 200_000)
      assert.ok(store.allEdges().length > 0, '前提：夜整理必须产出边')
      const after = runMemoryCommand(engine, `edges ${id.slice(0, 8)}`)
      assert.doesNotMatch(after, /还没有连边/u)
      assert.match(after, /same-entity|same-topic/u)
      assert.match(after, new RegExp(`共 ${store.allEdges().length} 条边`, 'u'))
    } finally {
      store.close()
    }
  })

  it('缺 id 时给用法说明', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      assert.equal(runMemoryCommand(engine, 'edges'), '用法：/memory edges <卡片 id>')
    } finally {
      store.close()
    }
  })

  it('会话入口也吃配置上限', () => {
    // 会话命令拿不到 config，只能走 `engine.outputLimits()`。
    // 三个引擎要依次打开（同一个目录上同时开三个 store 会争同一份日志水位），
    // 所以先播种、关掉，再用两份不同的配置各开一次。
    const dir = tempDir()
    let total = 0
    let id = ''
    const seeded = openEngine(dir)
    try {
      writeTwoRelatedCards(seeded.engine)
      seeded.engine.consolidate(T0 + 200_000)
      total = seeded.store.allEdges().length
      assert.ok(total >= 2, `前提：至少 2 条边，实际 ${total} 条`)
      id = seeded.store.listCards({ status: 'active' })[0]!.id
    } finally {
      seeded.store.close()
    }

    const tight = openEngine(dir, mergeConfig(DEFAULT_CONFIG, { output: { listMaxEdges: 1 } }))
    try {
      assert.equal(tight.engine.outputLimits().listMaxEdges, 1, '前提：配置真的被覆盖了')
      const text = runMemoryCommand(tight.engine, `edges ${id}`)
      assert.match(text, /只列出前 1 条/u)
      assert.equal([...text.matchAll(/^- [→←] /gmu)].length, 1)
    } finally {
      tight.store.close()
    }

    // 配对：上限 3 时同一个库按上限列，证明「只列 1 条」不是恒为 1。
    const loose = openEngine(dir, mergeConfig(DEFAULT_CONFIG, { output: { listMaxEdges: 3 } }))
    try {
      const looseText = runMemoryCommand(loose.engine, `edges ${id}`)
      assert.equal([...looseText.matchAll(/^- [→←] /gmu)].length, Math.min(total, 3))
      assert.match(looseText, new RegExp(`共 ${total} 条边`, 'u'))
    } finally {
      loose.store.close()
    }
  })
})

describe('edges：新子命令不能藏起来', () => {
  it('--help 的用法表里列出了 edges <id>', () => {
    assert.match(helpText(), /^ {2}edges <id> {2,}/mu)
  })
})
