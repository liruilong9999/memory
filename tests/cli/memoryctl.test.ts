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
import { buildCardId, buildEdgeId } from '../../src/core/types.ts'
import type { MemoryCard, MemoryDomain, MemoryKind, SourcePointer } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { loadPatchConfig } from '../../src/host/patchConfig.ts'
import { resolveConfig } from '../../src/host/adapter.ts'
import { exportJsonl } from '../../src/store/export.ts'
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
/**
 * 扩散 fixture 的查询词。
 *
 * **必须是多词项。** 单个词项（如 `'Redis'`）会让 `relevance` 呈断崖分布：
 * 命中簇 0.69，其余全 0.00，中间没有卡 ⇒ 受益者集合为空 ⇒ 扩散在数学上
 * 无从发生。这不是代码问题，是**查询词把梯度抹平了**。
 *
 * 用四个词项后 `relevance` 有真实梯度（0.58 / 0.52 / 0.23 / 0.17），
 * 受益者区间 `[absoluteThreshold, max × seedRatio)` 才非空。
 */
const SYNAPSE_QUERY = 'Redis 缓存 一致性 方案'

function seedSynapseStore(dir: string): void {
  // 这个 fixture 必须让扩散**真的产生加分**，否则「on 模式下必须看见扩散加分」
  // 测的是空气。两个条件缺一不可，而且第二个是缺陷三十二之后才成立的：
  //
  //   ① 库里要有边（走 writeTurn + consolidate，边只在夜整理里产出）；
  //   ② 边两端必须**一强一弱**——强的是种子，弱的是受益者。
  //
  // 原语料是「Cordis / Redis / PostgreSQL」三个互不相干的簇，查询 'Redis' 时
  // `relevance` 呈断崖分布（命中簇 0.69，其余全是 0.00），中间没有一张卡，
  // 于是「受益者集合」是空的，扩散**在数学上无从发生**。
  //
  // 现在改用多词项查询 `Redis 缓存 一致性 方案`，让 `relevance` 有真实梯度：
  // 两张种子（0.58 / 0.52）+ 两张中等相关的受益者（0.23 / 0.17）。
  // 判据与护栏同尺之后（缺陷三十二），受益者才拿得到加分。
  const config = mergeConfig(DEFAULT_CONFIG, { spread: { mode: 'on' } })
  const store = openStore({ config, dataDir: dir })
  const engine = new MemoryEngine({
    store, config, timeZone: TZ, clock: fixedClock,
  })
  const sentences = [
    '约定 Redis 和 PostgreSQL 的数据一致性方案',
    '方案是用 Redis 做缓存，结论已定',
    '约定 Redis 的过期时间设成 300 秒',
    '缓存击穿要用互斥锁，不能只靠过期时间',
    '方案已经评审通过，下周开始实现',
    '一致性哈希的虚拟节点数设成 150 比较稳',
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

  it('索引不一致或配置不可用时退出码都为 1', () => {
    // 四种组合全写出来：只写「都正常」与「都异常」两条的话，
    // 一个 `&&` 写成 `||` 的实现也会全绿。
    assert.equal(healthExitCode({ indexOk: true, configOk: true }), EXIT_OK)
    assert.equal(healthExitCode({ indexOk: false, configOk: true }), EXIT_UNHEALTHY)
    assert.equal(healthExitCode({ indexOk: true, configOk: false }), EXIT_UNHEALTHY)
    assert.equal(healthExitCode({ indexOk: false, configOk: false }), EXIT_UNHEALTHY)
  })

  it('配置坏到宿主起不来时，health 报异常且退出码为 1（真缺陷十五）', () => {
    // 这是 FR-F5 验收口径「一条命令报健康/异常」最需要它生效的场景：
    // patch 写坏了，宿主根本加载不了插件，用户发现记忆不生效。
    // 原实现在这里报「健康：正常」、exit 0——一个报错的观测点比没有
    // 观测点更危险，因为人会信它。
    const dir = tempDir()
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, [
      'config:',
      '  recall:',
      '    absoluteThreshold: -5',
      '',
    ].join('\n'), 'utf8')

    // 前提防御：这份 patch 必须真的是坏的，
    // 否则下面两条断言可能绿在「根本没读到配置」上。
    const loaded = loadPatchConfig(patch)
    assert.equal(loaded.ok, true, '前提：patch 必须能被读到（否则测的是另一条路）')
    assert.throws(
      () => resolveConfig(loaded.ok ? loaded.config : {}),
      /absoluteThreshold/u,
      '前提：这份配置必须使宿主抛错',
    )

    const result = runCli(['health', '--data-dir', dir], { configPath: patch })
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stdout, /健康：异常/u)
    // 配置那一行也必须说异常：否则读人只看到一个孤零零的「异常」
    // 而不知道哪里坏了（索引那行会报「一致」）。
    assert.match(result.stdout, /配置：异常/u)

    // json 的 `healthy` 与退出码必须同一个结论。
    // 否则脚本读 json 得到 `healthy: true`、读 exit code 得到 1，
    // **同一条命令报两个相反的结果**——与真缺陷七
    //（同一张卡报两个总分）同形。
    const asJson = runCli(['health', '--data-dir', dir, '--json'], { configPath: patch })
    assert.equal(asJson.code, EXIT_UNHEALTHY)
    const payload = JSON.parse(asJson.stdout) as Record<string, unknown>
    assert.equal(payload['healthy'], false, 'json 的 healthy 不能与退出码相反')
    assert.equal(payload['configOk'], false)
  })

  it('配置坏掉时仍然看的是用户那个库，不是默认空库（真缺陷十六）', () => {
    // 探针实测过的一幕：用户库里有 3 张卡，patch 写成 `-5` 之后
    // 敲一句 `health`，报的是**另一个目录**、活跃 0 张。
    // 用户看到的不是「配置坏了」，而是「我那 3 条记忆丢了」——
    // 而它们好端端地在另一个目录里。**看错库比报错库更危险。**
    //
    // 这条与上一条必须分开：上一条只验「有没有报异常」，
    // 它在「报了异常但看错了库」的实现下依然全绿。
    const dir = tempDir()
    const userData = join(dir, 'user-library')
    seedStore(userData)
    const patch = join(dir, 'cordis.patch.yml')
    writeFileSync(patch, [
      'config:',
      '  storage:',
      `    dataDir: '${userData.replace(/\\/g, '/')}'`,
      '  recall:',
      '    absoluteThreshold: -5',
      '',
    ].join('\n'), 'utf8')

    // 不给 `--data-dir`：用户真实用法就是只敲 `health`。
    const result = runCli(['health'], { configPath: patch })
    assert.equal(result.code, EXIT_UNHEALTHY)
    // 前提防御：库里必须真的有卡，否则「报 0 张」与「看错库」分不出来。
    assert.match(result.stdout, /活跃：2 张/u, '前提：用户库里应有 2 张活跃卡')
    assert.ok(
      result.stdout.includes(userData),
      `数据目录必须是用户那个，实际输出：\n${result.stdout}`,
    )
  })

  it('patch 完全读不到时也报异常（库能打开不等于配置对）', () => {
    // 这条与上一条是**两条不同的路**：上一条是「读到了但不合法」，
    // 这一条是「根本没读到」。两条路都得报异常——
    // 因为用户配的那份没生效，他看到的行为与他的意图无关。
    const dir = tempDir()
    const missing = join(dir, '不存在的-patch.yml')
    const result = runCli(['health', '--data-dir', dir], { configPath: missing })
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stdout, /健康：异常/u)
    assert.match(result.stdout, /配置：异常/u)
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
    // ST-5 验收原话是「明确回答"没有相关记忆"」——断言这句，
    // 而不是实现随手写的另一种说法。**错误文案是承诺，不是装饰。**
    assert.match(result.stdout, /没有相关记忆/u)
    assert.equal(result.stderr, '')
  })

  it('库里有卡但话题完全无关时，也明确说「没有相关记忆」而不是硬凑', () => {
    // ST-5 有**两个**场景：「空库」和「无关话题」。只测空库的话，
    // 一条「有卡就随便返回一张」的实现也能全绿——而后者恰恰是 ST-5
    // 真正要防的「臆造」形态。库里有卡，更接近真实使用现场。
    const dir = tempDir()
    seedStore(dir)
    const result = runCli(['query', '烘焙面包的发酵温度', '--data-dir', dir])
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /没有相关记忆/u)
    assert.doesNotMatch(result.stdout, /部署/u, '无关话题下不得把不相干的卡凑进焦点包')
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

describe('import（FR-A6 的入口侧）', () => {
  /** 导出到文件，返回路径。 */
  function exportTo(dir: string, outDir: string, extra: string[] = []): string {
    const target = join(outDir, 'backup.json')
    const result = runCli(['export', '--data-dir', dir, '--include-archived', '--out', target, ...extra], { now: fixedClock })
    assert.equal(result.code, EXIT_OK, `导出失败：${result.stderr}`)
    return target
  }

  it('导出的文件能导回一个空库，卡片与边逐字段一致（P1-4 的闭环）', () => {
    // 这条是 P1-4 的核心：**导出 → 移走数据目录 → 导入 → 抽查一致**。
    // 只加子命令不够——探针已经证明 `export --out` 的产物喂给 `importJsonl`
    // 会得到 0 张卡，所以这条用例必须真的走「文件 → 新库」这条路。
    const source = tempDir()
    const store = openStore({ dataDir: source })
    const cards = Array.from({ length: 100 }, (_, index) => makeCard('fact', `第 ${index} 条部署记忆`, {
      // 每条卡的来源序号不同，id 才不撞（id 由域+来源+类型+文本派生）。
      source: { sessionId: 'sess-cli', turn: index + 1, step: 1, seq: 1, eventType: 'user/message' },
    }))
    for (const card of cards) store.putCard(card)
    const edge = {
      id: buildEdgeId(cards[0]?.id ?? '', cards[1]?.id ?? '', 'same-topic'),
      from: cards[0]?.id ?? '',
      to: cards[1]?.id ?? '',
      relation: 'same-topic' as const,
      weight: 0.75,
      createdAt: T0,
    }
    store.putEdge(edge)
    store.close()

    const target = exportTo(source, tempDir())

    // 「移走数据目录」用一个全新的空目录代替：这才是真实的换机器场景。
    const fresh = tempDir()
    const imported = runCli(['import', target, '--data-dir', fresh], { now: fixedClock })
    assert.equal(imported.code, EXIT_OK, `导入失败：${imported.stderr}`)
    assert.match(imported.stdout, /卡片 100 张写入/u)

    const check = openStore({ dataDir: fresh })
    try {
      assert.equal(check.count('active'), 100)
      for (const card of cards) {
        // 逐字段比对而不是只比数量：只比数量时，「100 张都进来了但字段被
        // 重放层改写」也会绿，而那正是 ST-1 要防的静默改写。
        assert.deepEqual(check.getCard(card.id), card)
      }
      const edges = check.allEdges()
      assert.equal(edges.length, 1)
      assert.equal(edges[0]?.weight, 0.75)
      assert.equal(edges[0]?.from, edge.from)
    } finally {
      check.close()
    }
  })

  it('JSONL 格式也能导入（对照组：证明不是只认一种格式）', () => {
    // 对照组存在的理由：上一条只证明「导出文档」能导入。若实现把格式判断
    // 写死成文档一种，JSONL 就再也导不进来，而仓库里 `exportJsonl` 是公开
    // API，旧备份文件很可能就是 JSONL。**两种格式各有一条用例，
    // 才能证明「自动识别」是真的在识别，而不是碰巧对了一种。**
    const source = tempDir()
    const store = openStore({ dataDir: source })
    const card = makeCard('fact', 'JSONL 往返也要能进')
    store.putCard(card)
    // 从**有卡的那个库**取卡再序列化：从空库取会得到一份只有头行的文件，
    // 于是「导入了 1 张」这条断言永远失败，而失败原因与格式识别无关。
    const jsonl = exportJsonl(store.listCards({}), [], T0)
    store.close()

    const target = join(tempDir(), 'backup.jsonl')
    writeFileSync(target, jsonl, 'utf8')

    const fresh = tempDir()
    const imported = runCli(['import', target, '--data-dir', fresh], { now: fixedClock })
    assert.equal(imported.code, EXIT_OK, `导入失败：${imported.stderr}`)
    assert.match(imported.stdout, /格式 JSONL/u)
    assert.match(imported.stdout, /卡片 1 张写入/u)

    const check = openStore({ dataDir: fresh })
    try {
      assert.deepEqual(check.getCard(card.id), card)
    } finally {
      check.close()
    }
  })

  it('--in 与位置参数等价；两处不一致时报错而不是静默选一个', () => {
    const source = tempDir()
    seedStore(source)
    // `--include-archived` 下导出 3 张（2 活跃 + 1 归档），所以是 3 张写入。
    const target = exportTo(source, tempDir())

    const viaFlag = runCli(['import', '--in', target, '--data-dir', tempDir()], { now: fixedClock })
    assert.equal(viaFlag.code, EXIT_OK, `--in 导入失败：${viaFlag.stderr}`)
    assert.match(viaFlag.stdout, /卡片 3 张写入/u)

    const conflict = runCli(['import', target, '--in', `${target}.other`, '--data-dir', tempDir()])
    assert.equal(conflict.code, EXIT_USAGE)
    assert.match(conflict.stderr, /给了两处且不一致/u)
  })

  it('同一个文件导两次：第二次按幂等跳过，不报错也不重复建卡', () => {
    const source = tempDir()
    seedStore(source)
    const target = exportTo(source, tempDir())
    const fresh = tempDir()

    assert.equal(runCli(['import', target, '--data-dir', fresh], { now: fixedClock }).code, EXIT_OK)
    const again = runCli(['import', target, '--data-dir', fresh], { now: fixedClock })
    assert.equal(again.code, EXIT_OK)
    assert.match(again.stdout, /卡片 0 张写入 \/ 3 张已存在/u)

    const check = openStore({ dataDir: fresh })
    try {
      // 数量断言是「不重复建卡」的证据；上面那行文案只是它的说法。
      assert.equal(check.count('active'), 2)
      assert.equal(check.count('archived'), 1)
    } finally {
      check.close()
    }
  })

  it('文件不存在时是用法错误（退出码 2），不是「库坏了」', () => {
    const result = runCli(['import', join(tempDir(), '没有这个文件.json'), '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /读不到导入文件/u)
  })

  it('空文件明确报错，不报「导入成功 0 条」', () => {
    const target = join(tempDir(), 'empty.json')
    writeFileSync(target, '   \n', 'utf8')
    const result = runCli(['import', target, '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /文件是空的/u)
  })

  it('一行都认不出来的文件必须报错，不能报成功（静默数据丢失防线）', () => {
    // 这条守的是一个非常容易走到的坑：`parseExportFile` 对任何不以 `{` 开头的
    // 文本都走 JSONL 容错分支，坏行只计数不报错 ⇒ 一份 CSV 会得到
    // `cards: []`、`skipped: 37`，若 CLI 照直说「已导入 0 张」并退出 0，
    // 用户会以为备份恢复了。**「什么都没导进去」和「导入成功」必须能区分。**
    const target = join(tempDir(), 'not-a-backup.csv')
    writeFileSync(target, 'id,text\n1,部署\n2,迁移\n', 'utf8')
    const result = runCli(['import', target, '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_USAGE, '认不出的文件不能报成功')
    assert.match(result.stderr, /一条都认不出来/u)
  })

  it('边指向不存在的卡时预检失败，且库里一张卡都没写（不留半截状态）', () => {
    const target = join(tempDir(), 'dangling.json')
    writeFileSync(target, JSON.stringify({
      formatVersion: 1,
      exportedAt: T0,
      cards: [makeCard('fact', '唯一一张卡')],
      edges: [{
        id: 'e1', from: 'ghost-a', to: 'ghost-b', relation: 'same-topic', weight: 0.5, createdAt: T0,
      }],
    }), 'utf8')

    const fresh = tempDir()
    const result = runCli(['import', target, '--data-dir', fresh])
    assert.equal(result.code, EXIT_UNHEALTHY, '文件不自洽是数据问题，不是用法问题')
    assert.match(result.stderr, /未通过预检/u)
    assert.match(result.stderr, /ghost-a/u)

    // 关键断言：预检在写入**之前**。先写卡再报错会留下「一半导入」的状态，
    // 而用户看到的只有一行错误，会以为什么都没发生。
    const check = openStore({ dataDir: fresh })
    try {
      assert.equal(check.count('active'), 0, '预检失败时不得写入任何卡片')
    } finally {
      check.close()
    }
  })

  it('版本比本程序新的导出文件拒绝导入', () => {
    const target = join(tempDir(), 'future.json')
    writeFileSync(target, JSON.stringify({
      formatVersion: 999, exportedAt: T0, cards: [], edges: [],
    }), 'utf8')
    const result = runCli(['import', target, '--data-dir', tempDir()])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /高于本程序支持/u)
  })

  it('只含边的文件能导入到已有卡的库（端点存在性必须连库一起看）', () => {
    // 这条守的是 `validateImport` 的 `knownCardIds` 参数。没有它时，
    // 「端点是否存在」只能查文件内——于是**只含边的文件永远导不进去**，
    // 因为文件里一张卡都没有，每个端点都被判成悬空。
    //
    // 反向验证里把这个参数去掉（`known = inFile`）后，原先那条
    // 「悬空边报错」的用例照样绿——它测的是「文件内也不存在」，
    // 两种情况都会报错，区分不出来。必须有一条「文件内没有、库里有」的用例。
    const fresh = tempDir()
    const seed = openStore({ dataDir: fresh })
    const a = makeCard('fact', '端点 A')
    const b = makeCard('concept', '端点 B')
    seed.putCard(a)
    seed.putCard(b)
    seed.close()

    const target = join(tempDir(), 'edges-only.json')
    writeFileSync(target, JSON.stringify({
      formatVersion: 1,
      exportedAt: T0,
      cards: [],
      edges: [{
        id: buildEdgeId(a.id, b.id, 'same-topic'),
        from: a.id,
        to: b.id,
        relation: 'same-topic',
        weight: 0.6,
        createdAt: T0,
      }],
    }), 'utf8')

    const result = runCli(['import', target, '--data-dir', fresh])
    assert.equal(result.code, EXIT_OK, `只含边的文件应能导入：${result.stderr}`)
    assert.match(result.stdout, /图谱边 1 条写入/u)

    const check = openStore({ dataDir: fresh })
    try {
      assert.equal(check.allEdges().length, 1)
    } finally {
      check.close()
    }
  })

  it('文件内出现重复卡片 id 时预检失败（后写会覆盖先写，属于静默数据丢失）', () => {
    // 重复 id 不是「多导入一次」，而是**一张卡吃掉另一张**：`putCard` 用 id
    // 定位，第二张把第一张覆盖掉，而 CLI 会报「2 张写入」——
    // 用户以为两条都在，实际库里只有一条，且没有任何提示。
    // 预检必须在写入前拦住它，因为写入后无从区分「本来就只有一条」。
    const target = join(tempDir(), 'dup.json')
    const a = makeCard('fact', '重复 id 的第一张')
    const b = makeCard('fact', '重复 id 的第二张', { id: a.id })
    writeFileSync(target, JSON.stringify({
      formatVersion: 1, exportedAt: T0, cards: [a, b], edges: [],
    }), 'utf8')

    const fresh = tempDir()
    const result = runCli(['import', target, '--data-dir', fresh])
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.match(result.stderr, /未通过预检/u)
    assert.match(result.stderr, /重复的卡片 id/u)

    const check = openStore({ dataDir: fresh })
    try {
      assert.equal(check.count('active'), 0, '预检失败时不得写入任何卡片')
    } finally {
      check.close()
    }
  })

  it('--json 输出机器可读计数，且把「坏行」与「幂等跳过」分开报', () => {
    const source = tempDir()
    seedStore(source)
    const target = exportTo(source, tempDir())
    const fresh = tempDir()
    runCli(['import', target, '--data-dir', fresh], { now: fixedClock })
    const result = runCli(['import', target, '--data-dir', fresh, '--json'], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    const payload = JSON.parse(result.stdout) as {
      format: string
      cards: { read: number; written: number; skipped: number }
      edges: { read: number; written: number; skipped: number }
      malformed: number
    }
    assert.equal(payload.format, 'document')
    assert.equal(payload.cards.read, 3)
    assert.equal(payload.cards.written, 0)
    assert.equal(payload.cards.skipped, 3)
    // 两个数字必须分开：合成一个会让「文件被手改坏了」看起来像
    // 「数据已经在库里了」，而这两件事的处置方式完全相反。
    assert.equal(payload.malformed, 0)
  })
})

describe('query 的过滤 flag（P1-5）', () => {
  const DAY = 86_400_000
  const OLD = T0 - 30 * DAY
  /**
   * 落在「上海 2023-11-01 00:00」与「UTC 2023-11-01 00:00」之间的时刻。
   *
   * 这两个时刻差 8 小时（1698768000000 vs 1698796800000），中间这段是
   * **唯一能区分「按 --tz 解释」和「按 UTC 硬算」的窗口**。没有卡落在这里时，
   * 两种实现给出相同的卡片集合，用例会绿在错误的原因上——
   * 反向验证里 `--since` 那条一开始就是这么假绿的。
   */
  const BETWEEN_ZONES = 1698780000000

  /**
   * 种一个五张卡的库：三个域、三种类型、三组标签、三个创建时刻。
   *
   * 五张卡的正文都含查询词「部署」，所以**过滤是唯一变量**——
   * 否则「筛出 2 张」可能只是「只有 2 张相关」，用例就绿在错误的原因上。
   */
  function seedFilterStore(dir: string): void {
    const store = openStore({ dataDir: dir })
    store.putCard(makeCard('fact', '生产环境部署必须先跑数据库迁移', {
      domain: 'work', tags: ['部署'], createdAt: T0, updatedAt: T0,
    }))
    store.putCard(makeCard('concept', '部署流程的学习笔记', {
      domain: 'study', tags: ['算法'], createdAt: T0, updatedAt: T0,
    }))
    store.putCard(makeCard('feeling', '部署出问题时我会很焦虑', {
      domain: 'life', tags: ['部署'], createdAt: T0, updatedAt: T0,
    }))
    store.putCard(makeCard('fact', '旧的部署脚本已废弃', {
      domain: 'work', tags: ['部署'], createdAt: OLD, updatedAt: OLD,
    }))
    // 时区边界卡：只用于让 `--since` 有判别力，别的作用没有。
    store.putCard(makeCard('concept', '部署边界时刻的笔记', {
      domain: 'study', tags: ['边界'], createdAt: BETWEEN_ZONES, updatedAt: BETWEEN_ZONES,
    }))
    store.close()
  }

  /** 直调 `engine.query` 拿基准结果，供「CLI === 引擎」比对。 */
  function engineIds(dir: string, filter: Parameters<MemoryEngine['query']>[0]): string[] {
    const store = openStore({ dataDir: dir })
    try {
      const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: fixedClock })
      return engine.query(filter).map((card) => card.id)
    } finally {
      store.close()
    }
  }

  /**
   * 每个 flag 都必须与「直调 `engine.query` 同参数」的结果**逐条相同**。
   *
   * 这是 P1-5 的完成判据原话。只断言「看起来筛对了」不够：那样一个把
   * `--domain` 实现成「在焦点包里再筛一遍」的版本也能绿，而它和引擎的
   * `MemoryFilter` 语义（筛候选池）是两件事——差别会在「筛出来的卡没进
   * 焦点包」时暴露，而那时用例早就绿了。
   */
  const cases: Array<{ name: string; args: string[]; filter: Parameters<MemoryEngine['query']>[0] }> = [
    { name: '--domain', args: ['--domain', 'work'], filter: { domain: 'work', status: 'active' } },
    { name: '--kind', args: ['--kind', 'feeling'], filter: { kind: 'feeling', status: 'active' } },
    { name: '--tag', args: ['--tag', '算法'], filter: { tag: '算法', status: 'active' } },
    {
      name: '--since',
      args: ['--since', '2023-11-01', '--tz', TZ],
      filter: { since: 1698768000000, status: 'active' },
    },
  ]

  for (const item of cases) {
    it(`${item.name} 的结果与直调 engine.query 同参数逐条一致`, () => {
      const dir = tempDir()
      seedFilterStore(dir)
      const result = runCli(['query', '部署', '--data-dir', dir, '--json', ...item.args], { now: fixedClock })
      assert.equal(result.code, EXIT_OK, `查询失败：${result.stderr}`)
      const payload = JSON.parse(result.stdout) as { matched: Array<{ id: string }> }
      assert.ok(Array.isArray(payload.matched), '带过滤条件时 --json 必须给出 matched 全集')
      const cliIds = payload.matched.map((card) => card.id)
      // 前提断言：过滤后不能是全集，否则「与引擎一致」可能只是两边都没筛。
      assert.ok(cliIds.length > 0 && cliIds.length < 5, `前提：${item.name} 必须真的筛掉了一些卡，实际 ${cliIds.length} 张`)
      assert.deepEqual(cliIds, engineIds(dir, item.filter))
    })
  }

  it('过滤作用在候选池上：候选数收缩，且焦点包里没有池外的卡', () => {
    // 这条是反向验证逼出来的，它守的东西和上面四条**不是同一层**。
    //
    // 上面四条比对的是 `matched`，而 `matched` 来自 `engine.query`、候选池来自
    // `engine.peek`——两条独立路径。把 `peek` 的 filter 参数整个丢掉（变异 M11），
    // `matched` 依然完全正确，四条用例**一条都不红**。于是「过滤生效」只在
    // 计数上成立，用户真正看到的焦点包里还是别的域的卡。
    //
    // 断言选在 `candidates`（候选池大小）而不是「包里恰好有哪些卡」，
    // 因为装包还要过打分阈值与 token 预算：fixture 稍变就会让包里只剩 1 张，
    // 那时「包里都是 work 卡」对「过滤没接线」同样成立——判据会被巧合决定。
    // 候选池大小没有阈值参与，它直接就是「筛完剩几张」。
    const dir = tempDir()
    seedFilterStore(dir)
    const peekOf = (args: string[]): { candidates: number; domains: string[] } => {
      const result = runCli(['query', '部署', '--data-dir', dir, '--json', ...args], { now: fixedClock })
      assert.equal(result.code, EXIT_OK, `查询失败：${result.stderr}`)
      const payload = JSON.parse(result.stdout) as {
        candidates: number
        cards: Array<{ domain: string }>
      }
      return { candidates: payload.candidates, domains: payload.cards.map((card) => card.domain) }
    }

    const all = peekOf([])
    const work = peekOf(['--domain', 'work'])
    // 前提：不带过滤时池里必须混有非 work 域的卡，否则「筛掉它」无从观测。
    assert.equal(all.candidates, 5, '前提：不带过滤时候选池应是全部 5 张活跃卡')
    assert.equal(work.candidates, 2, '带 --domain work 时候选池应只剩 2 张 work 卡')
    assert.ok(work.candidates < all.candidates, '过滤必须让候选池收缩，否则它没作用在候选池上')
    // 池外的卡不得进焦点包。这一半单独断言，因为「池小了」与「包里也干净」
    // 是两件事：只在装包后过滤会得到同样小的池，却仍可能装进池外的卡。
    for (const domain of work.domains) {
      assert.equal(domain, 'work', `焦点包里出现了非 work 域的卡（${domain}），说明过滤没作用到候选池`)
    }
  })

  it('--domain 之外的三个 flag 各自筛掉的是不同的卡（不是同一个条件的四种写法）', () => {
    const dir = tempDir()
    seedFilterStore(dir)
    const idsOf = (args: string[]): string[] => {
      const result = runCli(['query', '部署', '--data-dir', dir, '--json', ...args], { now: fixedClock })
      const payload = JSON.parse(result.stdout) as { matched: Array<{ id: string }> }
      return payload.matched.map((card) => card.id)
    }
    const work = idsOf(['--domain', 'work'])
    const feeling = idsOf(['--kind', 'feeling'])
    const algo = idsOf(['--tag', '算法'])
    assert.notDeepEqual(work, feeling)
    assert.notDeepEqual(work, algo)
    assert.notDeepEqual(feeling, algo)
  })

  it('--since 按 --tz 的时区解释日期（同一个日期串在两个时区结果不同）', () => {
    // 这是 P1-5 里最容易写错的一处，也是反向验证抓到「假绿」的地方。
    // `2023-11-01` 在东八区是 1698768000000（UTC 2023-10-31T16:00Z），
    // 在 UTC 是 1698796800000，差 8 小时；而 fixture 里那张「边界卡」的
    // 创建时刻 1698780000000 恰好落在这 8 小时中间。
    //
    // 于是同一个 `--since 2023-11-01`：东八区 4 张、UTC 3 张。
    // **两边都非空**很关键——若其中一边是 0，用「空包」也能通过，
    // 而空包可能只是别的原因（比如查询词没命中），判别力会弱一截。
    //
    // 我最初用的是 `--since 2023-11-15`，它给出 3 vs 0：方向对，
    // 但「UTC 下 0 张」这个结果对「时区算错」和「干脆不过滤」都成立不了，
    // 却能对「阈值算得太早」成立。换成 11-01 之后，两个数都指向具体实现。
    const dir = tempDir()
    seedFilterStore(dir)
    const count = (tz: string): number => {
      const result = runCli(
        ['query', '部署', '--data-dir', dir, '--json', '--since', '2023-11-01', '--tz', tz],
        { now: fixedClock },
      )
      assert.equal(result.code, EXIT_OK, `查询失败：${result.stderr}`)
      return (JSON.parse(result.stdout) as { matched: unknown[] }).matched.length
    }
    const shanghai = count('Asia/Shanghai')
    const utc = count('UTC')
    assert.equal(shanghai, 4, '东八区的 11-01 00:00 早于边界卡，边界卡应当保留')
    assert.equal(utc, 3, 'UTC 的 11-01 00:00 晚于边界卡，边界卡应当被筛掉')
    assert.notEqual(shanghai, utc, '日期必须按时区解释，否则 --tz 对 --since 毫无作用')
  })

  it('--since 支持带时刻的写法与毫秒时间戳', () => {
    const dir = tempDir()
    seedFilterStore(dir)
    const at = (value: string): number => {
      const result = runCli(['query', '部署', '--data-dir', dir, '--json', '--since', value, '--tz', TZ], { now: fixedClock })
      assert.equal(result.code, EXIT_OK, `--since ${value} 失败：${result.stderr}`)
      return (JSON.parse(result.stdout) as { matched: unknown[] }).matched.length
    }
    // 2023-11-15T06:13:20+08:00 恰好是 T0，`since` 是「含」所以同刻写入的三张都在。
    assert.equal(at('2023-11-15T06:13:20'), 3)
    // 带秒的写法必须和带分的一致（秒可写可不写，不该改变结果）。
    assert.equal(at('2023-11-15T06:13:20'), at('2023-11-15T06:13'))
    // 纯数字按毫秒时间戳直取。
    assert.equal(at(String(T0)), 3)
    assert.equal(at(String(T0 + 1000)), 0)
  })

  it('--since 写错时报用法错误并说清怎么改，而不是静默当成不过滤', () => {
    const dir = tempDir()
    seedFilterStore(dir)
    for (const bad of ['上周', '2024-02-31', '2024-13-01', '2024-03-01T25:00']) {
      const result = runCli(['query', '部署', '--data-dir', dir, '--since', bad, '--tz', TZ], { now: fixedClock })
      assert.equal(result.code, EXIT_USAGE, `--since ${bad} 应当报用法错误`)
      assert.match(result.stderr, /--since/u)
    }
  })

  it('过滤后一张都没有时，人读输出要指出可能拼错了域或类型', () => {
    // 空结果和「库里确实没有」长得一模一样。拼错 `--domain wrok` 会安静地
    // 返回空，运维于是去查记忆库，而问题在命令行上。这里要求输出自己暴露它。
    const dir = tempDir()
    seedFilterStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir, '--domain', 'wrok'], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /满足条件的活跃卡 0 张/u)
    assert.match(result.stdout, /不在内置域里/u)
    assert.match(result.stdout, /work \/ study \/ life/u)
  })

  it('人读输出里写明实际生效的过滤条件（运维要能确认 flag 真的被读到了）', () => {
    const dir = tempDir()
    seedFilterStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir, '--domain', 'work', '--tz', TZ], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.match(result.stdout, /过滤：domain=work/u)
    assert.match(result.stdout, /满足条件的活跃卡 2 张/u)
  })

  it('不加过滤 flag 时输出里不出现「过滤」行（不制造无关噪声）', () => {
    const dir = tempDir()
    seedFilterStore(dir)
    const result = runCli(['query', '部署', '--data-dir', dir, '--tz', TZ], { now: fixedClock })
    assert.equal(result.code, EXIT_OK)
    assert.doesNotMatch(result.stdout, /过滤：/u)
    // 配对断言：--json 下也不该凭空多出 matched 字段，
    // 否则「有 matched 就是过滤生效了」这个判据在调用方那边失效。
    const json = runCli(['query', '部署', '--data-dir', dir, '--json', '--tz', TZ], { now: fixedClock })
    assert.equal((JSON.parse(json.stdout) as Record<string, unknown>)['matched'], undefined)
  })

  it('过滤是只读的：带 flag 查询同样不改库（配对：不带 flag 也不改）', () => {
    const dir = tempDir()
    seedFilterStore(dir)
    const size = (): number => {
      const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
      assert.equal(files.length, 1, '本测试假设库里只有一个日志段文件')
      return statSync(join(dir, files[0] ?? '')).size
    }
    const before = size()
    assert.ok(before > 0, '前提：库里必须已经有日志字节，否则「没变」可能只是库根本没写成功过')
    runCli(['query', '部署', '--data-dir', dir, '--domain', 'work', '--tz', TZ], { now: fixedClock })
    assert.equal(size(), before, '带过滤的查询也不得写库')
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
      const peek = engine.peek(SYNAPSE_QUERY)
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
    const result = runCli(['query', SYNAPSE_QUERY, '--data-dir', dir, '--json'], { now: fixedClock })
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
    // 这条断言曾经写的是 `EXIT_OK`，理由是「配置读不到不该让
    // 健康检查失败」。**那把缺陷固化成了契约**：
    // 配置读不到时插件按默认值运行，用户配的那份一行都没生效，
    // 而他跑 health 得到的答案是「一切正常」。那正是 FR-F5 要报的异常。
    // 保留下来的那一半仍然成立：库本身没坏（索引一致、卡片读得出），
    // 所以输出里「索引」那行仍报一致——两件事分开报，但退出码要能被脚本判断。
    assert.equal(result.code, EXIT_UNHEALTHY, '配置降级不能报成健康')
    assert.match(result.stdout, /索引：一致/u, '库本身确实没坏，这一行不该跟着变异常')
    assert.match(result.stdout, /配置：异常/u)
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
