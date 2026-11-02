/**
 * 离线命令行单测。
 *
 * 覆盖 FR-F1（结构化日志）、FR-F2（查询）、FR-F3（指标）、FR-F4（重建）、
 * FR-F5（健康检查）与 NFR-8（可测试）：核心逻辑收敛在 `runCli` 里，
 * 它返回 `{ code, stdout, stderr }` 而不写标准流，因此退出码可以直接断言。
 *
 * 测试全部使用临时数据目录，跑完逐个文件清理（仓库规范禁止批量删除）。
 *
 * @module tests/cli/memoryctl.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLI_NAME, EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE, FALLBACK_TIME_ZONE,
  healthExitCode, helpText, isValidTimeZone, parseArgs, resolveTimeZone, runCli,
} from '../../src/cli/memoryctl.ts'
import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config.ts'
import type { DeepPartial, MemoryConfig } from '../../src/core/config.ts'
import { buildCardId } from '../../src/core/types.ts'
import type { MemoryCard, MemoryDomain, MemoryKind, SourcePointer } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { loadPatchConfig } from '../../src/host/patchConfig.ts'
import { openStore } from '../../src/store/store.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

const tempDirs: string[] = []

/** 建一个登记过的临时目录，`after` 里统一清理。 */
function tempDir(prefix = 'dsh-memory-cli-'): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/** 固定时钟，让召回打分与导出时刻可复现（ST-1）。 */
const fixedClock = (): number => T0

/** 造一张卡：字段齐全，id 与生产路径一致地由「域 + 来源 + 类型 + 归一化文本」派生。 */
function makeCard(
  kind: MemoryKind, text: string, overrides: Partial<MemoryCard> = {},
): MemoryCard {
  const source: SourcePointer = { sessionId: 'sess-cli', turn: 1, step: 1, seq: 1, eventType: 'user/message' }
  const domain: MemoryDomain = overrides.domain ?? 'work'
  return {
    id: buildCardId(domain, source, kind, text),
    domain,
    kind,
    text,
    normalized: text,
    createdAt: T0,
    updatedAt: T0,
    source,
    salience: 0.8,
    confidence: 0.9,
    emotional: 0.2,
    strength: 0.9,
    accessCount: 0,
    lastAccessAt: null,
    tags: ['部署'],
    entities: ['生产环境'],
    revisions: [],
    status: 'active',
    conflictOf: [],
    pinned: false,
    ...overrides,
  }
}

/** 往临时库里种三张卡：两张活跃（关键词「部署」）、一张归档。 */
function seedStore(dir: string): void {
  const store = openStore({ dataDir: dir })
  store.putCard(makeCard('fact', '生产环境部署必须先跑数据库迁移'))
  store.putCard(makeCard('event', '昨天部署失败了，原因是数据库迁移没跑'))
  store.putCard(makeCard('fact', '部署脚本已废弃', { status: 'archived' }))
  store.close()
}

/**
 * 种一个**有图谱边**的库，供扩散相关用例使用。
 *
 * 为什么不能用 {@link seedStore}：它直接 `putCard`，而图谱边只在夜整理里
 * 产出。库里一条边都没有时，扩散**在数学上无从发生**——于是
 * 「on 模式下必须看见扩散加分」这条断言会永远失败，而失败原因不是
 * 代码错了，是测试数据里没有可扩散的东西。
 * **把「机制没跑」和「输入为空的机制当然不跑」混为一谈，会让人去修一个
 * 不存在的问题。**
 *
 * @param dir - 数据目录。
 */
function seedSynapseStore(dir: string): void {
  const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
  const engine = new MemoryEngine({
    store, config: DEFAULT_CONFIG, timeZone: TZ, clock: fixedClock,
  })
  const sentences = [
    '决定把 Cordis 版本升到 4，插件按新 API 改写',
    '结论是 Cordis 的 bundle patch 语法要重新适配',
    '方案是用 Redis 做缓存，结论已定',
    '约定 Redis 的过期时间设成 300 秒',
    '约定 Redis 和 PostgreSQL 的数据一致性方案',
    '决定数据库选 PostgreSQL，这条和框架无关',
    '架构上 Cordis 插件加载顺序会影响启动时间',
    '约定 Cordis 插件命名用中划线，注意统一',
  ]
  sentences.forEach((text, i) => {
    engine.writeTurn({
      sessionId: 'sess-synapse', turn: i + 1, step: 1, seq: i + 1,
      userText: text, assistantText: '好的，我记下了。',
      domain: 'work', at: T0 + (i + 1) * 1000,
    })
  })
  // 边只在夜整理里产出（FR-G1 / 起源 L15 图谱）。
  engine.consolidate(T0 + 200_000)
  store.close()
}

describe('命令行用法', () => {
  it('无参数时打印用法并退出 0', () => {
    const result = runCli([])
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /用法：/u)
    assert.match(result.stdout, /query <关键词>/u)
    assert.equal(result.stderr, '')
  })

  it('-h / --help / help 三个写法等价', () => {
    const expected = helpText()
    for (const argv of [['-h'], ['--help'], ['help']]) {
      const result = runCli(argv)
      assert.equal(result.code, EXIT_OK, `${argv.join(' ')} 应退出 0`)
      assert.equal(result.stdout, expected)
    }
  })

  it('帮助文本里的默认数据目录取自配置而不是写死', () => {
    assert.ok(helpText().includes(DEFAULT_CONFIG.storage.dataDir))
  })

  it('帮助文本列出了全部退出码约定', () => {
    const text = helpText()
    for (const code of [EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE]) {
      assert.match(text, new RegExp(`  ${code}  `, 'u'))
    }
  })
})

describe('参数解析', () => {
  it('未知子命令返回用法错误，并提示可用命令', () => {
    const result = runCli(['乱写'])
    assert.equal(result.code, EXIT_USAGE)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /未知子命令「乱写」/u)
    assert.match(result.stderr, new RegExp(`${CLI_NAME} --help`, 'u'))
  })

  it('未知选项返回用法错误', () => {
    const result = runCli(['health', '--nope'])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /未知选项「--nope」/u)
  })

  it('带值选项缺值时返回用法错误', () => {
    const result = runCli(['health', '--data-dir'])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /--data-dir 缺少取值/u)
  })

  it('带值选项把下一个选项当成缺值，而不是吞掉它', () => {
    const parsed = parseArgs(['health', '--data-dir', '--json'])
    assert.equal(parsed.ok, false)
    assert.match(parsed.ok ? '' : parsed.message, /--data-dir 缺少取值/u)
  })

  it('支持 --name=value 内联写法', () => {
    const parsed = parseArgs(['query', '部署', '--data-dir=/tmp/x', '--tz=UTC'])
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.options.command, 'query')
    assert.deepEqual(parsed.options.positionals, ['部署'])
    assert.equal(parsed.options.dataDir, '/tmp/x')
    assert.equal(parsed.options.timeZone, 'UTC')
  })

  it('-- 之后的内容一律当位置参数', () => {
    const parsed = parseArgs(['query', '--', '--json', '-h'])
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(parsed.options.positionals, ['--json', '-h'])
    assert.equal(parsed.options.json, false)
  })

  it('query 的多个位置参数按空格拼成一个关键词', () => {
    const parsed = parseArgs(['query', '数据库', '迁移'])
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.deepEqual(parsed.options.positionals, ['数据库', '迁移'])
  })

  it('布尔选项可以任意顺序出现', () => {
    const parsed = parseArgs(['export', '--json', '--include-archived', '--verbose'])
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.options.json, true)
    assert.equal(parsed.options.includeArchived, true)
    assert.equal(parsed.options.verbose, true)
  })
})

describe('时区', () => {
  it('显式 --tz 优先于系统时区', () => {
    assert.equal(resolveTimeZone(TZ), TZ)
  })

  it('省略时回退到系统时区或固定回退值，且结果始终可用', () => {
    assert.equal(isValidTimeZone(resolveTimeZone(undefined)), true)
  })

  it('非法时区被识别出来，并在入口处报用法错误', () => {
    assert.equal(isValidTimeZone('Asia/Shanghai'), true)
    assert.equal(isValidTimeZone('不存在的时区'), false)
    assert.equal(isValidTimeZone(''), false)

    const result = runCli(['health', '--tz', '不存在的时区', '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /无效时区/u)
  })

  it('回退常量本身必须是合法时区', () => {
    assert.equal(isValidTimeZone(FALLBACK_TIME_ZONE), true)
  })
})

describe('health（FR-F5）', () => {
  it('空库健康检查退出 0，并报出数据目录', () => {
    const dir = tempDir()
    const result = runCli(['health', '--data-dir', dir])
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /健康：正常/u)
    assert.match(result.stdout, /活跃：0 张/u)
    assert.match(result.stdout, /归档：0 张/u)
    assert.match(result.stdout, /索引：一致/u)
    assert.match(result.stdout, /数据目录：/u)
  })

  it('--json 输出可解析且字段齐全', () => {
    const result = runCli(['health', '--data-dir', tempDir(), '--json'])
    assert.equal(result.code, EXIT_OK)
    const payload = JSON.parse(result.stdout) as Record<string, unknown>
    assert.equal(payload['healthy'], true)
    assert.equal(payload['indexOk'], true)
    assert.equal(payload['active'], 0)
    assert.equal(typeof payload['dataDir'], 'string')
  })

  it('索引不一致时退出码为 1', () => {
    assert.equal(healthExitCode({ indexOk: true }), EXIT_OK)
    assert.equal(healthExitCode({ indexOk: false }), EXIT_UNHEALTHY)
  })

  it('统计到已种下的卡片', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['health', '--data-dir', dir, '--json'])
    const payload = JSON.parse(result.stdout) as Record<string, unknown>
    assert.equal(payload['active'], 2)
    assert.equal(payload['archived'], 1)
  })
})

describe('query（FR-F2）', () => {
  it('空库给出明确「没有命中」而不是报错', () => {
    const result = runCli(['query', '数据库', '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /没有命中任何记忆/u)
    assert.equal(result.stderr, '')
  })

  it('缺关键词返回用法错误', () => {
    const result = runCli(['query', '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /需要一个关键词/u)
  })

  it('有数据时打印焦点包与分数构成', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir, '--tz', TZ], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /焦点包 \d+ 张，候选 \d+ 张/u)
    assert.match(result.stdout, /总分 \d\.\d{3}/u)
    assert.match(result.stdout, /语义相关/u)
  })

  it('--json 输出包含分数构成与 token 预算', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir, '--json'], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    const payload = JSON.parse(result.stdout) as {
      query: string
      candidates: number
      tokens: number
      budgetTokens: number
      cards: Array<{ id: string; score: { total: number }; explain: string[] }>
    }
    assert.equal(payload.query, '部署')
    assert.ok(payload.cards.length > 0)
    assert.ok(payload.candidates >= payload.cards.length)
    // 预算必须来自配置，而不是写死在 CLI 里（硬性约定 6）。
    assert.equal(payload.budgetTokens, DEFAULT_CONFIG.recall.tokenBudget)
    assert.equal(typeof payload.cards[0]?.score.total, 'number')
    assert.ok((payload.cards[0]?.explain.length ?? 0) > 0)
  })

  it('--verbose 下 query 不产生召回日志，因为只读查询不写事件（FR-F1 语义）', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir, '--verbose'], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    // 只读查询不写库 ⇒ 引擎不产生 recall 日志。这不是缺陷：
    // 本项目里「召回」指宿主真的把记忆注入上下文、即将被使用；
    // 运维敲一眼看看库里有什么，不算使用，也就不该记成一次召回。
    //
    // 断言**不能**写成 `stderr === ''`：那会把「没有 recall 日志」和
    // 「stderr 一个字都不许有」混成同一件事。`--verbose` 下本来就该报
    // 「配置来源」——运维要能确认自己改的 patch 真的生效了。
    // 之前写 `=== ''` 时，加一行配置来源就让它红了，而它本该守的东西
    // （不产生 recall 日志）其实一直没变。**断言宽过头，会替不相干的行为背书。**
    assert.doesNotMatch(result.stderr, /^\[recall\]/mu)
    // 配对断言：`--verbose` 必须真的说了点什么，否则上面那条可能只是因为
    // 整个 verbose 通道坏了而空过。
    assert.match(result.stderr, /配置来源/u, '--verbose 必须报出配置来源')
    assert.match(result.stderr, /spread\.mode = on/u, '配置来源里必须带上扩散模式')
  })

  it('不加 --verbose 时 stderr 保持干净', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir], { now: fixedClock })
    assert.equal(result.stderr, '')
  })
})

describe('query 是纯只读的（不污染记忆库）', () => {
  /** 取库里唯一日志文件的字节数——库的任何写入都会追加到这里。 */
  function journalSize(dir: string): number {
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    assert.equal(files.length, 1, '本测试假设库里只有一个日志段文件')
    return statSync(join(dir, files[0] ?? '')).size
  }

  it('query 前后库文件字节数不变', () => {
    const dir = tempDir()
    seedStore(dir)
    const before = journalSize(dir)
    const result = runCli(['query', '部署', '--data-dir', dir], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /焦点包/u, '这条测试得先真的召回到东西，否则「没写库」可能只是没干活')
    const after = journalSize(dir)
    assert.equal(after, before, 'query 竟然写了库：它应当只读')
  })

  it('反复查询不会累积写入', () => {
    const dir = tempDir()
    seedStore(dir)
    const before = journalSize(dir)
    for (const keyword of ['部署', '数据库', '迁移', '部署']) {
      assert.equal(runCli(['query', keyword, '--data-dir', dir], { now: fixedClock }).code, EXIT_OK)
    }
    assert.equal(journalSize(dir), before)
  })

  it('query 前后 accessCount / strength / lastAccessAt 都不变', () => {
    const dir = tempDir()
    seedStore(dir)
    const pick = (): Array<Record<string, unknown>> => {
      const payload = JSON.parse(
        runCli(['export', '--data-dir', dir, '--include-archived', '--json'], { now: fixedClock }).stdout,
      ) as { cards: Array<Record<string, unknown>> }
      return payload.cards.map((card) => ({
        id: card['id'],
        accessCount: card['accessCount'],
        strength: card['strength'],
        lastAccessAt: card['lastAccessAt'],
      }))
    }
    const before = pick()
    assert.equal(runCli(['query', '部署', '--data-dir', dir], { now: fixedClock }).code, EXIT_OK)
    assert.deepEqual(pick(), before, 'query 改了访问计数或强度')
  })

  it('对照：宿主的 confirmRecall 会写库（证明上一条测试有牙）', () => {
    // 若把 query 改回「会写库」的实现，上面三条必然失败。这里显式证明
    // 「写入是能被观测到的」，避免测试因为库根本不落盘而假绿。
    //
    // 注意钉的是 `confirmRecall` 而不是 `recall`：引擎已经把「看到」与「使用」
    // 拆开了，`recall` 现在也是只读的（见下一条测试）。真正会加深记忆强度的
    // 入口只剩 `confirmRecall` 这一个，拿它当正对照才是当前事实。
    const dir = tempDir()
    seedStore(dir)
    const before = journalSize(dir)
    const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
    try {
      const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: fixedClock })
      const pack = engine.peek('部署')
      assert.ok(pack.pack.cards.length > 0, '得先召回到卡，否则 confirmRecall 无事可确认')
      const written = engine.confirmRecall(pack.pack.cards.map((scored) => scored.card.id))
      assert.ok(written > 0, 'confirmRecall 一条都没确认，说明它没写库')
    } finally {
      store.close()
    }
    assert.ok(journalSize(dir) > before, '宿主 confirmRecall 都没写库，那上面「字节数不变」的测试就是假绿')
  })

  it('对照：宿主的 recall 现在也是只读的（不写库）', () => {
    // 这条与上一条配对，两头堵死：
    //   confirmRecall 必须写（否则「只读测试」可能因库不落盘而假绿）；
    //   recall 必须不写（否则「看到」与「使用」的分离又漏回去了）。
    // 起源 L29（第 5 条·专注当前位置）：被召回只是「看见」，不该加深记忆。
    const dir = tempDir()
    seedStore(dir)
    const before = journalSize(dir)
    const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
    try {
      const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: fixedClock })
      const result = engine.recall('部署')
      assert.ok(result.pack.cards.length > 0, '得先真的召回到东西，否则「没写库」可能只是没干活')
    } finally {
      store.close()
    }
    assert.equal(journalSize(dir), before, 'engine.recall 竟然写了库：召回只是「看见」，不是「使用」')
  })
})

describe('export', () => {
  it('默认只导出活跃卡，计数里仍报出归档数', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['export', '--data-dir', dir], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    const payload = JSON.parse(result.stdout) as {
      exportedAt: number
      dataDir: string
      counts: { active: number; archived: number; edges: number; exported: number }
      cards: Array<{ id: string; status: string }>
    }
    assert.equal(payload.exportedAt, T0)
    assert.equal(payload.counts.active, 2)
    assert.equal(payload.counts.archived, 1)
    assert.equal(payload.counts.exported, 2)
    assert.equal(payload.cards.length, 2)
    for (const card of payload.cards) assert.equal(card.status, 'active')
  })

  it('--include-archived 连归档卡一起导出', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['export', '--data-dir', dir, '--include-archived'], { now: fixedClock })
    const payload = JSON.parse(result.stdout) as { counts: { exported: number }; cards: Array<{ status: string }> }
    assert.equal(payload.counts.exported, 3)
    assert.ok(payload.cards.some((card) => card.status === 'archived'))
  })

  it('卡片按 id 升序，同一状态导出结果可复现（ST-8）', () => {
    const dir = tempDir()
    seedStore(dir)
    const first = runCli(['export', '--data-dir', dir, '--include-archived'], { now: fixedClock })
    const second = runCli(['export', '--data-dir', dir, '--include-archived'], { now: fixedClock })
    assert.equal(first.stdout, second.stdout)
    const payload = JSON.parse(first.stdout) as { cards: Array<{ id: string }> }
    const ids = payload.cards.map((card) => card.id)
    assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })

  it('--out 写文件，父目录不存在时自动创建', () => {
    const dir = tempDir()
    seedStore(dir)
    const target = join(tempDir(), 'nested', 'deeper', 'backup.json')
    const result = runCli(['export', '--data-dir', dir, '--out', target], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.equal(result.stdout.includes('"cards"'), false)
    assert.match(result.stdout, /已导出 2 张卡片/u)
    assert.equal(existsSync(target), true)
    const written = JSON.parse(readFileSync(target, 'utf8')) as { counts: { exported: number } }
    assert.equal(written.counts.exported, 2)
  })

  it('--out 与 --json 同时给出时打印机器可读摘要', () => {
    const dir = tempDir()
    seedStore(dir)
    const target = join(tempDir(), 'backup.json')
    const result = runCli(['export', '--data-dir', dir, '--out', target, '--json'], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    const summary = JSON.parse(result.stdout) as { out: string; exported: number }
    assert.equal(summary.out, target)
    assert.equal(summary.exported, 2)
  })
})

describe('rebuild（FR-F4）', () => {
  it('空库重建退出 0', () => {
    const result = runCli(['rebuild', '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /索引已重建：扫描 0 条日志记录，活跃 0 张/u)
  })

  it('重建后活跃卡数正确，且输出与宿主命令同风格', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['rebuild', '--data-dir', dir])
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /索引已重建：扫描 \d+ 条日志记录，活跃 2 张/u)
  })

  it('--json 输出扫描记录数', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['rebuild', '--data-dir', dir, '--json'])
    const payload = JSON.parse(result.stdout) as { records: number; active: number; archived: number }
    assert.ok(payload.records > 0)
    assert.equal(payload.active, 2)
    assert.equal(payload.archived, 1)
  })
})

describe('consolidate（FR-C1）', () => {
  it('空库也能跑，报告全零', () => {
    const result = runCli(['consolidate', '--data-dir', tempDir()], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /整理完成：合并 0 组，归档 0 张/u)
    assert.match(result.stdout, /活跃 0 → 0 张/u)
  })

  it('--json 输出完整整理报告', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['consolidate', '--data-dir', dir, '--json'], { now: fixedClock })
    const payload = JSON.parse(result.stdout) as {
      startedAt: number
      beforeActive: number
      merged: number
      archived: number
      notes: string[]
    }
    assert.equal(typeof payload.startedAt, 'number')
    assert.equal(payload.beforeActive, 2)
    assert.ok(Array.isArray(payload.notes))
  })

  it('--verbose 输出整理日志（FR-F1）', () => {
    const result = runCli(['consolidate', '--data-dir', tempDir(), '--verbose'], { now: fixedClock })
    assert.match(result.stderr, /\[consolidate\]/u)
  })
})

describe('库打不开时', () => {
  it('数据目录是个文件时退出码为 1 并说明原因', () => {
    const dir = tempDir()
    const blocker = join(dir, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    const result = runCli(['health', '--data-dir', blocker])
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /打开记忆库失败/u)
  })
})

describe('输出不串味', () => {
  it('同一次调用只写一个出口：成功时不写 stderr，失败时不写 stdout', () => {
    const ok = runCli(['health', '--data-dir', tempDir()])
    assert.equal(ok.stderr, '')
    const bad = runCli(['不存在'])
    assert.equal(bad.stdout, '')
    assert.notEqual(bad.stderr, '')
  })

  it('所有输出都以换行结尾，便于直接拼到终端', () => {
    const outputs = [
      runCli([]).stdout,
      runCli(['health', '--data-dir', tempDir()]).stdout,
      runCli(['export', '--data-dir', tempDir()]).stdout,
      runCli(['不存在']).stderr,
    ]
    for (const text of outputs) assert.ok(text.endsWith('\n'), `输出未以换行结尾：${text.slice(-20)}`)
  })
})

describe('CLI 与宿主必须用同一份配置（真缺陷九）', () => {
  /**
   * 这个 describe 守的是一类**沉默**的错误：同一个库、同一个查询，
   * 终端报一个总分、会话报另一个总分，而两边都不报错。
   *
   * 曾经 `src/cli/memoryctl.ts` 写死 `CLI_CONFIG = DEFAULT_CONFIG`
   * （`spread.mode = 'shadow'`），宿主走 `resolveConfig` 读 patch（`'on'`）。
   * 实测 3/3 查询分数不一致，且 CLI 输出里从来没有「扩散加分」——
   * 运维在终端看到的内存库，不是模型实际看到的那个。
   */

  /** 按宿主的方式（读 patch → mergeConfig）算出配置，与 adapter.ts 同路。 */
  function hostConfigFromPatch(): MemoryConfig {
    const patch = loadPatchConfig(fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)))
    assert.equal(patch.ok, true, '出厂 patch 必须能解析')
    if (!patch.ok) return DEFAULT_CONFIG
    return mergeConfig(DEFAULT_CONFIG, patch.config as DeepPartial<MemoryConfig>)
  }

  it('health 报出的扩散模式与宿主读 patch 得到的模式一致', () => {
    const hostConfig = hostConfigFromPatch()
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['health', '--data-dir', dir, '--json'], { now: fixedClock })
    const payload = JSON.parse(result.stdout) as { spreadMode: string }

    assert.equal(
      payload.spreadMode, hostConfig.spread.mode,
      'CLI 报出的扩散模式必须等于宿主读 patch 得到的模式——否则同一个库有两套分数',
    )
    // 前提断言：出厂 patch 必须是 'on'。否则上面那条在「两边都是 shadow」时也绿，
    // 而「CLI 根本没用 patch、只是恰好和默认值一样」正是缺陷本身。
    assert.equal(hostConfig.spread.mode, 'on', '出厂 patch 必须显式开扩散，见 tests/host/patch.test.ts')
  })

  it('on 模式下 CLI 的分数与宿主引擎逐位相同，且含「扩散加分」', () => {
    const hostConfig = hostConfigFromPatch()
    // 这个库必须**有图谱边**，否则扩散无从发生——「没有扩散加分」会变成
    // 「输入为空的机制当然不跑」，而那条断言就成了在测空气。
    // `seedStore` 直接 `putCard`，不产边；这里必须走 writeTurn + consolidate
    // 这条真实链路（边只在夜整理里产出）。
    const dir = tempDir()
    seedSynapseStore(dir)

    // 宿主：真实引擎
    const store = openStore({ config: hostConfig, dataDir: dir })
    let hostTotals: number[]
    let hostHasBoost = false
    try {
      const engine = new MemoryEngine({ store, config: hostConfig, timeZone: TZ, clock: fixedClock })
      const peek = engine.peek('Redis')
      hostTotals = peek.pack.cards.map((scored) => scored.score.total)
      hostHasBoost = peek.pack.cards.some((c) => c.explain.some((l) => l.includes('扩散加分')))
    } finally {
      store.close()
    }
    assert.ok(hostTotals.length > 0, '前提：得先召回到卡，否则「分数相同」可能只是两边都空')
    // 前提断言：宿主自己都没加分的话，下面「CLI 必须看得见」就无从谈起，
    // 而那条会变成一个永远测不到东西的断言。
    assert.equal(hostHasBoost, true, '前提：这个库里扩散必须真的发生过，否则本条测试没测到东西')

    // CLI：真实入口
    const result = runCli(['query', 'Redis', '--data-dir', dir, '--json'], { now: fixedClock })
    const payload = JSON.parse(result.stdout) as {
      cards: { score: { total: number }; explain: string[] }[]
    }
    assert.deepEqual(
      payload.cards.map((c) => c.score.total), hostTotals,
      'CLI 与宿主的分数必须逐位相同（ST-1：同一状态同一查询结果一致）',
    )
    assert.ok(
      payload.cards.some((c) => c.explain.some((line) => line.includes('扩散加分'))),
      'on 模式下 CLI 必须看得见扩散加分，否则运维不知道突触效果到底生效没有',
    )
  })

  it('patch 缺失时退回默认值，但必须在 stderr 里说出来（不静默降级）', () => {
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(
      ['health', '--data-dir', dir],
      { now: fixedClock, configPath: 'D:/不存在的目录/cordis.patch.yml' },
    )
    assert.equal(result.code, EXIT_OK, '配置读不到不该让健康检查失败')
    assert.match(result.stderr, /配置提醒/u, '退回默认值必须报出来')
    assert.match(result.stderr, /默认配置/u)
  })

  it('patch 里写成裸 on 时，CLI 报配置非法而不是当字符串放过去', () => {
    // 裸 `on` 在 YAML 1.1 里是布尔 true，宿主 validateConfig 会拒绝并加载期失败。
    // 若 CLI 把它当字符串 'on' 接受，CLI 就替一个「照抄就崩」的写法背书。
    const dir = tempDir()
    seedStore(dir)
    const patchDir = tempDir('dsh-memory-patch-')
    const patchPath = join(patchDir, 'cordis.patch.yml')
    writeFileSync(patchPath, [
      '- insert:',
      '    - id: memory',
      '      config:',
      '        spread:',
      '          mode: on',
      '',
    ].join('\n'), 'utf8')

    const result = runCli(['health', '--data-dir', dir], { now: fixedClock, configPath: patchPath })
    assert.match(result.stderr, /配置提醒/u)
    assert.match(result.stderr, /不合法/u, '必须说清是配置不合法，而不是含糊地退回默认值')
  })
})
