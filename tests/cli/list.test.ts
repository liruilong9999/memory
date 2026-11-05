/**
 * FR-F1（可观测）的**库总览出口**：`memoryctl list` 与 `/memory list`。
 *
 * ## 为什么这个文件存在
 *
 * 在此之前，想知道「库里有什么」只有一个办法：猜关键词去 `query`。
 * 但 `query` 是**召回**命令——它按分数挑 7 张，挑不中时什么也不说，
 * 而「挑不中」与「库里没有」在输出上完全一样。运维要回答的问题
 *（这张卡还在吗、归档了几张、id 是多少好拿去 `restore`）需要的是全库视角。
 *
 * ## 本文件特意要钉住的几件事
 *
 * 1. **没上限就等于没做**：NFR-3 的目标规模是 10 万级卡。
 *    「上限生效」这条断言**必须真的有超过上限的卡数**——库里 3 张卡、
 *    上限 200 的时候，`shown <= 200` 恒真，删掉上限照样绿。
 *    所以这里用一份 **patch 把 `output.listMaxCards` 压到 2**，
 *    库里造 3 张卡，再配一条**配对的正向断言**（不传 patch 时 3 张全列出）。
 * 2. **上限不是 `--limit` 的别名**：`--limit 100` 配上限 2 仍然只列 2 张。
 *    少了这条，`Math.min(requested, cap)` 退化成 `requested` 也不会红。
 * 3. **空库要说人话**：空输出会被读成「命令坏了」。
 * 4. **排序必须确定**：同一轮写入的卡 `updatedAt` 完全相同，
 *    而输入顺序来自 `Map` 的插入顺序。这里直接断言比较器本身，
 *    因为端到端顺序被数据面兜住了——只删 CLI 的破平项，端到端那条**不会红**
 *    （详见 `compareListCards` 的注释与反向验证记录）。
 * 5. **id 要能直接粘给别的命令**：印的是 `formatCardRef` 的 8 位前缀，
 *    这里把它原样喂给 `pin` 验证「抄下来能用」。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT_OK, EXIT_USAGE, helpText, runCli } from '../../src/cli/memoryctl.ts'
import { compareListCards } from '../../src/cli/commands/list.ts'
import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config.ts'
import type { MemoryCard } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { runMemoryCommand } from '../../src/host/plugin/commands.ts'
import { openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeCard, makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

/**
 * 三张卡的 id：**前 8 位互不相同**（前缀能唯一定位），
 * 且**字典序与声明顺序一致**（`ID_A` < `ID_B` < `ID_C`），
 * 而各个用例里的**插入顺序特意与之不同**——否则「排序生效」与
 * 「按插入顺序」在输出上完全一样，断言就分不出两者。
 *
 * 踩过一次：第一版把 `ID_B` 写成 `e5f6a7b8…`、`ID_C` 写成 `c9d0e1f2…`，
 * 于是「id 升序」实际是 A→C→B，与期望的 A→B→C 不符。
 * **字面量的字典序不能靠眼睛排。**
 */
const ID_A = 'a1b2c3d400000001'
const ID_B = 'c9d0e1f200000002'
const ID_C = 'e5f6a7b800000003'

const tempDirs: string[] = []

/**
 * 建一个登记过的临时目录，`after` 里统一清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function tempDir(prefix = 'dsh-memory-list-cli-'): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

const fixedClock = (): number => T0

/**
 * 往库里种卡。
 *
 * @param dir - 数据目录。
 * @param cards - 卡片。
 */
function seed(dir: string, cards: readonly MemoryCard[]): void {
  const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
  for (const card of cards) store.putCard(card)
  store.close()
}

/**
 * 打开一个库并返回引擎与 store（会话命令用例直接打引擎）。
 *
 * @param dir - 数据目录。
 * @param config - 引擎使用的配置。
 * @returns 引擎与 store（调用方负责关闭）。
 */
function openEngine(
  dir: string, config = DEFAULT_CONFIG,
): { engine: MemoryEngine; store: MemoryStore } {
  const store = openStore({ config, dataDir: dir })
  const engine = new MemoryEngine({ store, config, timeZone: TZ, clock: fixedClock })
  return { engine, store }
}

/**
 * 写一份只改动 `output.listMaxCards` 的 patch。
 *
 * @param dir - 放 patch 的目录。
 * @param value - 目标上限。
 * @returns patch 绝对路径。
 */
function writeCapPatch(dir: string, value: number): string {
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, ['config:', '  output:', `    listMaxCards: ${value}`, ''].join('\n'), 'utf8')
  return path
}

describe('list：全库总览', () => {
  it('空库输出可读说明，而不是空输出也不是报错', () => {
    // 空输出会让人以为命令坏了（FR-B6 的同一原则）。所以判据不是
    // 「没报错」——`stdout === ''` 也能让「没报错」成立。
    const dir = tempDir()
    const cli = runCli(['list', '--data-dir', dir])
    assert.equal(cli.code, EXIT_OK, cli.stderr)
    assert.equal(cli.stderr, '')
    assert.ok(cli.stdout.trim().length > 0, '空库也必须说话，不能是空输出')
    assert.match(cli.stdout, /记忆库里还没有活跃卡/u)
  })

  it('三张卡都在，且印出的 id 前缀能直接拿去 pin（抄下来就能用）', () => {
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_C, text: '丙：缓存用 Redis', normalized: '丙：缓存用 redis', updatedAt: T0 }),
      makeCard({ id: ID_A, text: '甲：部署用 PostgreSQL', normalized: '甲：部署用 postgresql', updatedAt: T0 }),
      makeCard({ id: ID_B, text: '乙：日志保留三十天', normalized: '乙：日志保留三十天', updatedAt: T0 }),
    ])

    // JSON 先确认「取数」这一层：三张卡都在，一个不少。
    const asJson = runCli(['list', '--data-dir', dir, '--json'])
    assert.equal(asJson.code, EXIT_OK, asJson.stderr)
    const payload = JSON.parse(asJson.stdout) as {
      total: number
      shown: number
      truncated: boolean
      empty: boolean
      cards: { id: string; ref: string; kind: string; strength: number; pinned: boolean; status: string }[]
    }
    assert.equal(payload.total, 3, '前提：三张卡都必须被列出来')
    assert.equal(payload.shown, 3)
    assert.equal(payload.truncated, false)
    assert.equal(payload.empty, false)
    assert.deepEqual(payload.cards.map((c) => c.id).sort(), [ID_A, ID_B, ID_C].sort())

    // 人读输出里，三张卡的 8 位前缀都要出现。
    const human = runCli(['list', '--data-dir', dir])
    assert.equal(human.code, EXIT_OK, human.stderr)
    for (const id of [ID_A, ID_B, ID_C]) {
      assert.match(human.stdout, new RegExp(`^  ${id.slice(0, 8)}  `, 'mu'), `前缀 ${id.slice(0, 8)} 必须在人读输出里`)
    }

    // 「能直接粘给别的命令」不能只靠肉眼看格式：真的把抄下来的前缀喂给 pin。
    const pinned = runCli(['pin', ID_B.slice(0, 8), '--data-dir', dir])
    assert.equal(pinned.code, EXIT_OK, pinned.stderr)
    const after = runCli(['list', '--data-dir', dir, '--json'])
    const afterPayload = JSON.parse(after.stdout) as { cards: { id: string; pinned: boolean }[] }
    const target = afterPayload.cards.find((card) => card.id === ID_B)
    assert.ok(target !== undefined, '前提：pin 之后那张卡还在列表里')
    assert.equal(target.pinned, true, '从 list 抄下来的前缀必须能被 pin 认出来')
  })

  it('归档卡默认不列，--include-archived 才列（两个方向都断言）', () => {
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_A, text: '活跃一', normalized: '活跃一' }),
      makeCard({ id: ID_B, text: '活跃二', normalized: '活跃二' }),
      makeCard({ id: ID_C, text: '已归档', normalized: '已归档', status: 'archived' }),
    ])

    const active = runCli(['list', '--data-dir', dir, '--json'])
    const activePayload = JSON.parse(active.stdout) as { total: number; cards: { id: string }[] }
    // 方向一：默认看不见归档卡。
    assert.equal(activePayload.total, 2)
    assert.ok(!activePayload.cards.some((c) => c.id === ID_C), '默认不该列出归档卡')

    // 方向二（配对正向断言）：加了开关就看得见。
    // 少了这条，「默认不列」在「这个命令根本不会列任何卡」的实现下也是绿的。
    const all = runCli(['list', '--data-dir', dir, '--include-archived', '--json'])
    const allPayload = JSON.parse(all.stdout) as { total: number; cards: { id: string; status: string }[] }
    assert.equal(allPayload.total, 3, '前提：--include-archived 必须把归档卡也列出来')
    const archived = allPayload.cards.find((c) => c.id === ID_C)
    assert.ok(archived !== undefined, '--include-archived 之后归档卡必须出现')
    assert.equal(archived.status, 'archived')

    // 人读输出说出来的那句话也不能一样。
    assert.match(runCli(['list', '--data-dir', dir]).stdout, /共 2 张活跃卡/u)
    assert.match(runCli(['list', '--data-dir', dir, '--include-archived']).stdout, /共 3 张卡（含归档）/u)
  })

  it('--kind 写错当场报错，不静默列 0 张', () => {
    const dir = tempDir()
    seed(dir, [makeCard({ id: ID_A, text: '甲', normalized: '甲' })])
    const cli = runCli(['list', '--data-dir', dir, '--kind', '乱写'])
    assert.equal(cli.code, EXIT_USAGE)
    assert.equal(cli.stdout, '')
    assert.match(cli.stderr, /不是内置类型/u)
    // 前提：合法类型是能过的——否则上面那条可能只是「kind 参数整个不工作」。
    const ok = runCli(['list', '--data-dir', dir, '--kind', 'fact'])
    assert.equal(ok.code, EXIT_OK, ok.stderr)
    assert.match(ok.stdout, /共 1 张活跃卡（过滤条件：kind=fact）/u)
  })
})

describe('list：上限（NFR-3 十万级卡不能让终端爆炸）', () => {
  it('上限压到 2 时只列 2 张并说清「还有多少没显示」', () => {
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_A, text: '甲', normalized: '甲', updatedAt: T0 }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙', updatedAt: T0 + 1000 }),
      makeCard({ id: ID_C, text: '丙', normalized: '丙', updatedAt: T0 + 2000 }),
    ])
    const patch = writeCapPatch(dir, 2)

    const capped = runCli(['list', '--data-dir', dir], { configPath: patch })
    assert.equal(capped.code, EXIT_OK, capped.stderr)
    const payload = JSON.parse(runCli(['list', '--data-dir', dir, '--json'], { configPath: patch }).stdout) as {
      total: number
      shown: number
      limit: number
      cap: number
      truncated: boolean
    }
    assert.equal(payload.cap, 2, '上限必须来自配置，不是命令里的字面量')
    assert.equal(payload.total, 3, '前提：库里有 3 张卡，比上限多')
    assert.equal(payload.shown, 2)
    assert.equal(payload.limit, 2)
    assert.equal(payload.truncated, true)
    // 截断必须说出来，否则用户以为「库里就这么点」。
    assert.match(capped.stdout, /只列出前 2 张（共 3 张）/u)

    // 配对正向断言：同一份库、不传 patch 时三张全列出来。
    // 少了这条，「只列 2 张」在「命令本身就只列 2 张」的实现下也绿。
    const full = runCli(['list', '--data-dir', dir, '--json'])
    const fullPayload = JSON.parse(full.stdout) as { total: number; shown: number; cap: number }
    assert.equal(fullPayload.cap, DEFAULT_CONFIG.output.listMaxCards, '默认上限必须来自 DEFAULT_CONFIG')
    assert.equal(fullPayload.total, 3)
    assert.equal(fullPayload.shown, 3)
  })

  it('--limit 写得比上限大也越不过上限（上限不是 --limit 的别名）', () => {
    // 这条是「删掉 Math.min」的专用观测点：
    // 不显式给 `--limit` 时，`requested` 恰好就等于 `cap`，
    // 此时 `min(requested, cap)` 与 `requested` **同值**，
    // 删掉那层 min 也不会有任何一条用例变红。
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_A, text: '甲', normalized: '甲' }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙' }),
      makeCard({ id: ID_C, text: '丙', normalized: '丙' }),
    ])
    const patch = writeCapPatch(dir, 2)

    const cli = runCli(['list', '--data-dir', dir, '--limit', '100'], { configPath: patch })
    assert.equal(cli.code, EXIT_OK, cli.stderr)
    const payload = JSON.parse(
      runCli(['list', '--data-dir', dir, '--limit', '100', '--json'], { configPath: patch }).stdout,
    ) as { shown: number; limit: number; cap: number; truncated: boolean }
    assert.equal(payload.cap, 2)
    assert.equal(payload.limit, 2, '--limit 100 也必须被硬上界压到 2')
    assert.equal(payload.shown, 2)
    assert.equal(payload.truncated, true)

    // 前提：--limit 本身是好的，只是被上界压住。
    // 不压住的话「--limit 100 只出 2 张」可能只是「--limit 整个不生效」。
    const noCap = runCli(['list', '--data-dir', dir, '--limit', '100', '--json'])
    const noCapPayload = JSON.parse(noCap.stdout) as { shown: number; limit: number }
    assert.equal(noCapPayload.shown, 3)
    assert.equal(noCapPayload.limit, 100, '--limit 100 在没有更小的上界时必须真的被采用')
  })

  it('--limit 0 当成「没指定」，取配置上限而不是绕过它', () => {
    // `logs` 里 0 表示「全部」。list 不能沿用：让 0 绕过上限，
    // 「上限进配置」就只是一句口号。
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_A, text: '甲', normalized: '甲' }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙' }),
      makeCard({ id: ID_C, text: '丙', normalized: '丙' }),
    ])
    const patch = writeCapPatch(dir, 2)
    const payload = JSON.parse(
      runCli(['list', '--data-dir', dir, '--limit', '0', '--json'], { configPath: patch }).stdout,
    ) as { shown: number; limit: number; cap: number }
    assert.equal(payload.cap, 2)
    assert.equal(payload.limit, 2)
    assert.equal(payload.shown, 2)
  })
})

describe('list：排序确定性（ST-1）', () => {
  it('比较器：updatedAt 降序，同刻按 id 升序破平', () => {
    // 为什么直接断言比较器，而不是只看端到端输出：
    // `store.listCards` → `filterCards` **已经**按同一把尺子排过序
    // （`updatedAt` 降序 + id 升序），所以 CLI 这层的 sort 在今天的
    // 调用链里是**冗余的**——把 `compareListCards` 的破平项整个删掉，
    // 端到端那条用例依然绿。反向验证在这里必须打中比较器本身。
    const older = makeCard({ id: 'ffffffff00000001', updatedAt: T0 })
    const newer = makeCard({ id: '0000000000000002', updatedAt: T0 + 1 })
    // 主键：新的在前，哪怕它的 id 更大。
    assert.ok(compareListCards(older, newer) > 0, '更新的卡必须排在前面')
    assert.ok(compareListCards(newer, older) < 0)

    // 破平项：同刻时 id 小的在前，**两个方向都要断言**。
    // 只断言一个方向的话，把 `return -1` 改成 `return 0` 也能过。
    const low = makeCard({ id: '1111111100000001', updatedAt: T0 })
    const high = makeCard({ id: '9999999900000002', updatedAt: T0 })
    assert.ok(compareListCards(low, high) < 0, '同刻时 id 小的必须排前面')
    assert.ok(compareListCards(high, low) > 0, '同刻时 id 大的必须排后面')

    // 同一张卡与自己比较必须是 0，否则 sort 的行为依赖实现。
    assert.equal(compareListCards(low, low), 0)
  })

  it('端到端：同刻写入的多张卡按 id 升序输出，跑两次逐字节相同', () => {
    // 同一轮写入的卡 `updatedAt` 完全相同（引擎按 `now` 一次性盖章），
    // 而输入顺序来自 `Map` 的插入顺序——这里插入顺序特意与 id 升序相反。
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_C, text: '丙', normalized: '丙', updatedAt: T0 }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙', updatedAt: T0 }),
      makeCard({ id: ID_A, text: '甲', normalized: '甲', updatedAt: T0 }),
    ])
    const first = runCli(['list', '--data-dir', dir])
    const second = runCli(['list', '--data-dir', dir])
    assert.equal(first.code, EXIT_OK, first.stderr)
    assert.equal(first.stdout, second.stdout, '同一条命令两次运行必须逐字节相同（ST-1）')

    const refs = [...first.stdout.matchAll(/^ {2}([0-9a-f]{8}) {2}/gmu)].map((m) => m[1] ?? '')
    assert.deepEqual(refs, [ID_A.slice(0, 8), ID_B.slice(0, 8), ID_C.slice(0, 8)])
  })

  it('端到端：更新的卡排在前面', () => {
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_A, text: '甲', normalized: '甲', updatedAt: T0 }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙', updatedAt: T0 + 2000 }),
      makeCard({ id: ID_C, text: '丙', normalized: '丙', updatedAt: T0 + 1000 }),
    ])
    const cli = runCli(['list', '--data-dir', dir])
    assert.equal(cli.code, EXIT_OK, cli.stderr)
    const refs = [...cli.stdout.matchAll(/^ {2}([0-9a-f]{8}) {2}/gmu)].map((m) => m[1] ?? '')
    assert.deepEqual(refs, [ID_B.slice(0, 8), ID_C.slice(0, 8), ID_A.slice(0, 8)])
  })
})

describe('list：会话内入口 /memory list', () => {
  it('与 CLI 同一套规则：三张卡、id 前缀、同刻按 id 升序', () => {
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_C, text: '丙', normalized: '丙', updatedAt: T0 }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙', updatedAt: T0 }),
      makeCard({ id: ID_A, text: '甲', normalized: '甲', updatedAt: T0 }),
    ])
    const { engine, store } = openEngine(dir)
    try {
      const text = runMemoryCommand(engine, 'list')
      assert.match(text, /共 3 张活跃卡/u)
      for (const id of [ID_A, ID_B, ID_C]) {
        assert.ok(text.includes(id.slice(0, 8)), `会话输出里必须有 ${id.slice(0, 8)}`)
      }
      const refs = [...text.matchAll(/^ {2}([0-9a-f]{8}) {2}/gmu)].map((m) => m[1] ?? '')
      assert.deepEqual(refs, [ID_A.slice(0, 8), ID_B.slice(0, 8), ID_C.slice(0, 8)])
    } finally {
      store.close()
    }
  })

  it('空库在会话里也说人话', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      assert.equal(runMemoryCommand(engine, 'list'), '记忆库里还没有活跃卡。')
    } finally {
      store.close()
    }
  })

  it('会话入口也吃配置上限（压到 1 时只列 1 张并说明）', () => {
    // 会话命令拿不到 config，只能走 `engine.outputLimits()`。
    // 这条用例证明那个方法真的把配置读了出来，而不是一个写死的数。
    const dir = tempDir()
    seed(dir, [
      makeCard({ id: ID_A, text: '甲', normalized: '甲', updatedAt: T0 }),
      makeCard({ id: ID_B, text: '乙', normalized: '乙', updatedAt: T0 }),
      makeCard({ id: ID_C, text: '丙', normalized: '丙', updatedAt: T0 }),
    ])
    const config = mergeConfig(DEFAULT_CONFIG, { output: { listMaxCards: 1 } })
    assert.equal(config.output.listMaxCards, 1, '前提：配置真的被覆盖了')
    const { engine, store } = openEngine(dir, config)
    try {
      const text = runMemoryCommand(engine, 'list')
      assert.match(text, /只列出前 1 张（共 3 张）/u)
      assert.equal([...text.matchAll(/^ {2}[0-9a-f]{8} {2}/gmu)].length, 1)
      // 前提：上限是 1 而不是「会话命令恒只列 1 张」——
      // 同一个引擎换成上限 3 时必须列出 3 张。
      const loose = openEngine(dir, mergeConfig(DEFAULT_CONFIG, { output: { listMaxCards: 3 } }))
      try {
        assert.match(runMemoryCommand(loose.engine, 'list'), /共 3 张活跃卡/u)
      } finally {
        loose.store.close()
      }
    } finally {
      store.close()
    }
  })
})

describe('list：新子命令不能藏起来', () => {
  it('--help 的用法表里列出了 list 与 edges', () => {
    const text = helpText()
    assert.match(text, /^ {2}list {2,}/mu)
    assert.match(text, /^ {2}edges <id> {2,}/mu)
    // 上限的默认值从 DEFAULT_CONFIG 插值，不在帮助文本里另写一份字面量。
    assert.ok(
      text.includes(`默认 ${DEFAULT_CONFIG.output.listMaxCards}`),
      '帮助文本里的上限必须取自配置',
    )
  })

  it('未知子命令的可用列表里含 list 与 edges', () => {
    const cli = runCli(['乱写'])
    assert.equal(cli.code, EXIT_USAGE)
    assert.match(cli.stderr, /list/u)
    assert.match(cli.stderr, /edges/u)
  })

  it('/memory 的未知子命令提示里含 list 与 edges', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    try {
      const text = runMemoryCommand(engine, '乱写')
      assert.match(text, /未知子命令「乱写」/u)
      assert.match(text, /list/u)
      assert.match(text, /edges/u)
    } finally {
      store.close()
    }
  })
})
