/**
 * FR-C3（人工豁免）的两个**用户入口**：`memoryctl pin|unpin` 与 `/memory pin|unpin`。
 *
 * ## 为什么两个入口写在同一个文件里
 *
 * 和 `tests/cli/history.test.ts` 同一个理由：本仓库真的发生过「同一件事有两份
 * 实现、靠人肉同步」（`/memory explain` 与 `query` 各写一份渲染）。pin 的
 * 动作与文案如果也各写一遍，等着同一类漂移再来一次。所以核心断言不是
 * 「CLI 输出了什么」，而是**两边对同一个引用给出同一套结论**。
 *
 * ## 本文件特意要钉住的几件事
 *
 * 1. **状态没变不是失败，但也不是成功**：退出码 1 + 一句人能读懂的话，
 *    stdout 必须是空的（有 stdout 就等于「我把结果给你了」）。
 * 2. **`pinned` 与 `changed` 是两个字段**：重复 pin 的 JSON 里
 *    `pinned` 仍然是 `true`（现在的事实），`changed` 是 `false`（这次没做事）。
 *    只报一个 `pinned: false` 会被读成「现在没钉住」，与事实相反。
 * 3. **三个入口对同一个引用说法一致**：CLI 与 `/memory` 都走
 *    `resolveCardRef` / `resolveCardInSession`，前缀歧义都要报错而不是挑一张。
 * 4. **帮助与可用列表里要有 pin**：新增子命令却不出现在 `--help` 和
 *    未知子命令提示里，等于把它藏起来（`tests/cli/history.test.ts` 已有此教训）。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { EXIT_OK, EXIT_UNHEALTHY, EXIT_USAGE, helpText, runCli } from '../../src/cli/memoryctl.ts'
import { DEFAULT_CONFIG } from '../../src/core/config.ts'
import type { MemoryCard } from '../../src/core/types.ts'
import { MemoryEngine } from '../../src/host/engine.ts'
import { runMemoryCommand } from '../../src/host/plugin/commands.ts'
import { openStore } from '../../src/store/store.ts'
import type { MemoryStore } from '../../src/store/store.ts'
import { makeCard, makeTempDir, removeDirContents } from '../store/helpers.ts'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000

/** 两个入口共用的一张卡的 id（16 位，前 8 位是 `beefcafe`）。 */
const CARD_ID = 'beefcafe12345678'

const tempDirs: string[] = []

/**
 * 建一个登记过的临时目录，`after` 里统一清理。
 *
 * @param prefix - 目录名前缀。
 * @returns 目录绝对路径。
 */
function tempDir(prefix = 'dsh-memory-pin-cli-'): string {
  const dir = makeTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

const fixedClock = (): number => T0

/**
 * 打开一个库并返回引擎与 store，供会话内命令直接调用。
 *
 * @param dir - 数据目录。
 * @returns 引擎与 store（调用方负责关闭 store）。
 */
function openEngine(dir: string): { engine: MemoryEngine; store: MemoryStore } {
  const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
  const engine = new MemoryEngine({ store, config: DEFAULT_CONFIG, timeZone: TZ, clock: fixedClock })
  return { engine, store }
}

/**
 * 种一张卡并返回它。
 *
 * 用 `putCard` 直接写：这条卡要充当「被钉住的对象」，它的来源不重要，
 * 重要的是四个入口看到的是同一张。
 *
 * @param dir - 数据目录。
 * @param overrides - 需要覆盖的字段。
 * @returns 种下去的那张卡。
 */
function seedCard(dir: string, overrides: Partial<MemoryCard> = {}): MemoryCard {
  const card = makeCard({
    id: CARD_ID,
    kind: 'event',
    text: '这条观察已经很久没有人用得上了',
    normalized: '这条观察已经很久没有人用得上了',
    strength: 0.02,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  })
  const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
  store.putCard(card)
  store.close()
  return card
}

/**
 * 读回一张卡的当前状态（新开一个库，确保读到的是落盘结果）。
 *
 * @param dir - 数据目录。
 * @returns 卡片，不存在时为 undefined。
 */
function readCard(dir: string): MemoryCard | undefined {
  const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
  const card = store.getCard(CARD_ID)
  store.close()
  return card
}

describe('pin / unpin：CLI 与 /memory 两个入口', () => {
  it('pin 成功时两边给出同一张卡、同一个结论', () => {
    const dirA = tempDir()
    seedCard(dirA)

    const cli = runCli(['pin', CARD_ID, '--data-dir', dirA, '--tz', TZ], { now: fixedClock })
    assert.equal(cli.code, EXIT_OK, cli.stderr)
    assert.equal(cli.stderr, '')
    assert.equal(cli.stdout, `已钉住：${CARD_ID}\n`)
    assert.equal(readCard(dirA)?.pinned, true, 'CLI 入口必须真的钉住（落盘）')

    // 会话入口用**另一个空库**跑同一段：两个入口必须各自独立地做成同一件事，
    // 拿一个已经被钉住的库去跑第二个入口，测到的就只是「它说了重复操作」。
    const dirB = tempDir()
    seedCard(dirB)
    const { engine, store } = openEngine(dirB)
    const session = runMemoryCommand(engine, `pin ${CARD_ID}`)
    store.close()

    assert.equal(session, `已钉住：${CARD_ID}`)
    assert.equal(readCard(dirB)?.pinned, true, '/memory 入口也必须真的钉住（落盘）')
  })

  it('unpin 成功时两边结论一致，且状态真的松开', () => {
    const dir = tempDir()
    seedCard(dir, { pinned: true })
    assert.equal(readCard(dir)?.pinned, true, '前提：这张卡是钉住的')

    const cli = runCli(['unpin', CARD_ID, '--data-dir', dir, '--tz', TZ], { now: fixedClock })
    assert.equal(cli.code, EXIT_OK, cli.stderr)
    assert.equal(cli.stdout, `已取消钉住：${CARD_ID}\n`)

    const { engine, store } = openEngine(dir)
    // 已经松开了，再走一次会话入口：两边对「本来就没钉住」也要一致。
    const session = runMemoryCommand(engine, `unpin ${CARD_ID}`)
    store.close()

    assert.equal(readCard(dir)?.pinned, false, '取消钉住必须真的落盘')
    assert.equal(session, `这张卡本来就没有钉住（卡片 id：${CARD_ID}），无需取消`)
  })

  it('重复 pin：退出码 1、stdout 为空，且不写新日志（该丢弃的丢弃）', () => {
    const dir = tempDir()
    seedCard(dir, { pinned: true })
    assert.equal(readCard(dir)?.pinned, true, '前提：这张卡已经钉住')

    const before = readCard(dir)
    const result = runCli(['pin', CARD_ID, '--data-dir', dir, '--tz', TZ], { now: fixedClock })

    assert.equal(result.code, EXIT_UNHEALTHY, '状态没变不是用法错误，但也算不上成功')
    assert.equal(result.stdout, '', '没做成事就不能往 stdout 写东西')
    assert.match(result.stderr, /这张卡已经钉住了，无需重复操作/u)
    assert.equal(Number(readCard(dir)?.updatedAt), Number(before?.updatedAt), '重复 pin 不该改动任何字段')
  })

  it('重复 pin 的 JSON：pinned 是 true（现状），changed 是 false（这次没做事）', () => {
    const dir = tempDir()
    seedCard(dir, { pinned: true })

    const result = runCli(['pin', CARD_ID, '--data-dir', dir, '--json'], { now: fixedClock })
    assert.equal(result.code, EXIT_UNHEALTHY)
    const payload = JSON.parse(result.stdout) as { id: string; pinned: boolean; changed: boolean }
    assert.equal(payload.id, CARD_ID)
    assert.equal(
      payload.pinned, true,
      'pinned 必须报现状：报 false 会被读成「现在没钉住」，与事实相反',
    )
    assert.equal(payload.changed, false, 'changed 才表示「这次有没有真写记录」')
  })

  it('pin 的 JSON：成功后 changed 是 true', () => {
    const dir = tempDir()
    seedCard(dir)

    const result = runCli(['pin', CARD_ID, '--data-dir', dir, '--json'], { now: fixedClock })
    assert.equal(result.code, EXIT_OK, result.stderr)
    const payload = JSON.parse(result.stdout) as { id: string; pinned: boolean; changed: boolean }
    assert.deepEqual(payload, { id: CARD_ID, pinned: true, changed: true })
  })

  it('unpin 的 JSON 同构：成功 true/true，重复 false/true', () => {
    const dir = tempDir()
    seedCard(dir, { pinned: true })

    const first = runCli(['unpin', CARD_ID, '--data-dir', dir, '--json'], { now: fixedClock })
    assert.equal(first.code, EXIT_OK, first.stderr)
    assert.deepEqual(JSON.parse(first.stdout), { id: CARD_ID, pinned: false, changed: true })

    const again = runCli(['unpin', CARD_ID, '--data-dir', dir, '--json'], { now: fixedClock })
    assert.equal(again.code, EXIT_UNHEALTHY)
    assert.deepEqual(
      JSON.parse(again.stdout),
      { id: CARD_ID, pinned: false, changed: false },
      '重复 unpin 之后它确实还是「没钉住」的，所以 pinned 是 false 而不是 true',
    )
  })

  it('/memory 侧的同三种结果文案与 CLI 语义一致', () => {
    const dir = tempDir()
    seedCard(dir)
    const { engine, store } = openEngine(dir)

    assert.equal(runMemoryCommand(engine, `pin ${CARD_ID}`), `已钉住：${CARD_ID}`)
    assert.equal(
      runMemoryCommand(engine, `pin ${CARD_ID}`),
      `这张卡已经钉住了（卡片 id：${CARD_ID}），无需重复操作`,
      '重复钉住要说明「已经钉住了」，而不是假装成功',
    )
    assert.equal(runMemoryCommand(engine, `unpin ${CARD_ID}`), `已取消钉住：${CARD_ID}`)
    assert.equal(
      runMemoryCommand(engine, `unpin ${CARD_ID}`),
      `这张卡本来就没有钉住（卡片 id：${CARD_ID}），无需取消`,
    )

    assert.equal(readCard(dir)?.pinned, false, '来回一轮之后落盘结果就是「没钉住」')
    store.close()
  })

  it('缺 id 时两个入口都返回用法提示', () => {
    const dir = tempDir()
    for (const command of ['pin', 'unpin']) {
      const cli = runCli([command, '--data-dir', dir], { now: fixedClock })
      assert.equal(cli.code, EXIT_USAGE, `${command} 缺 id 是用法问题`)
      assert.equal(cli.stdout, '')
      assert.match(cli.stderr, new RegExp(`${command} 需要一个卡片 id`, 'u'))
    }

    const { engine, store } = openEngine(dir)
    assert.equal(runMemoryCommand(engine, 'pin'), '用法：/memory pin <卡片 id>')
    assert.equal(runMemoryCommand(engine, 'unpin'), '用法：/memory unpin <卡片 id>')
    store.close()
  })

  it('卡片不存在时两个入口都说明情况，不静默成功', () => {
    const dir = tempDir()
    const result = runCli(['pin', 'ffffffffffffffff', '--data-dir', dir], { now: fixedClock })
    assert.equal(result.code, EXIT_UNHEALTHY)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /没有这张卡：ffffffffffffffff/u)

    const { engine, store } = openEngine(dir)
    const session = runMemoryCommand(engine, 'pin ffffffffffffffff')
    store.close()
    assert.match(session, /没有这张卡：ffffffffffffffff/u)
    assert.doesNotMatch(session, /已钉住/u, '没钉住就不能说已钉住')
  })

  it('前缀撞多张时两个入口都报歧义，绝不随便挑一张', () => {
    const dir = tempDir()
    const store = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
    store.putCard(makeCard({ id: 'abcd000000000001', kind: 'event', text: '第一张同前缀卡', normalized: '第一张同前缀卡' }))
    store.putCard(makeCard({ id: 'abcd000000000002', kind: 'event', text: '第二张同前缀卡', normalized: '第二张同前缀卡' }))
    store.close()

    const result = runCli(['pin', 'abcd', '--data-dir', dir], { now: fixedClock })
    assert.equal(result.code, EXIT_USAGE, '歧义是用法问题（前缀太短），不是库坏了')
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /匹配到 2 张，请给更长前缀：abcd/u)

    const { engine, store: opened } = openEngine(dir)
    const session = runMemoryCommand(engine, 'pin abcd')
    opened.close()
    assert.match(session, /匹配到 2 张，请给更长前缀：abcd/u)
    assert.doesNotMatch(session, /已钉住/u)

    // 两张都必须还是原样——「报错了但顺手改了一张」比挑一张更糟。
    const check = openStore({ config: DEFAULT_CONFIG, dataDir: dir })
    assert.equal(check.getCard('abcd000000000001')?.pinned, false)
    assert.equal(check.getCard('abcd000000000002')?.pinned, false)
    check.close()
  })

  it('人读输出里印的完整 id 能原样粘给 pin（闭环）', () => {
    const dir = tempDir()
    seedCard(dir)

    // 前缀能解析（resolveCardRef 的前缀能力），但印出来的必须是完整 id——
    // 前缀只是省打字，不是新的引用格式。
    const prefix = CARD_ID.slice(0, 8)
    const result = runCli(['pin', prefix, '--data-dir', dir, '--tz', TZ], { now: fixedClock })
    assert.equal(result.code, EXIT_OK, result.stderr)
    assert.equal(result.stdout, `已钉住：${CARD_ID}\n`, '印出来的必须是完整 id，不是刚输入的前缀')
    assert.equal(readCard(dir)?.pinned, true)
  })

  it('CLI pin 之后关库重开，仍然是钉住的（跨进程）', () => {
    const dir = tempDir()
    seedCard(dir)
    const result = runCli(['pin', CARD_ID, '--data-dir', dir], { now: fixedClock })
    assert.equal(result.code, EXIT_OK, result.stderr)

    // runCli 自己已经关过库了，这里再开一次就是在验证「磁盘上留下了什么」。
    assert.equal(readCard(dir)?.pinned, true, 'CLI 进程退出后，钉住必须还在')
  })
})

describe('pin / unpin 的用法与退出码约定', () => {
  it('--help 的用法表里列出了 pin 与 unpin', () => {
    const text = helpText()
    assert.match(text, /pin <id>/u)
    assert.match(text, /unpin <id>/u)
  })

  it('未知子命令提示里含 pin（新增了子命令就必须列进去，否则等于藏起来）', () => {
    const result = runCli(['乱写'])
    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.stderr, /未知子命令「乱写」/u)
    assert.match(result.stderr, /pin/u)
  })

  it('/memory 的未知子命令可用列表里也含 pin 与 unpin', () => {
    const dir = tempDir()
    const { engine, store } = openEngine(dir)
    const out = runMemoryCommand(engine, '乱写')
    store.close()

    assert.match(out, /未知子命令「乱写」/u)
    assert.match(out, /pin/u)
    assert.match(out, /unpin/u)
  })

  it('卡片不存在时退出 1，缺 id 时退出 2（两种失败不混用退出码）', () => {
    const dir = tempDir()
    const missing = runCli(['pin', 'ffffffffffffffff', '--data-dir', dir], { now: fixedClock })
    const noId = runCli(['pin', '--data-dir', dir], { now: fixedClock })
    assert.notEqual(
      missing.code, noId.code,
      '「库里有问题」和「你命令打错了」是两件事，退出码不能混',
    )
    assert.equal(missing.code, EXIT_UNHEALTHY)
    assert.equal(noId.code, EXIT_USAGE)
  })
})
