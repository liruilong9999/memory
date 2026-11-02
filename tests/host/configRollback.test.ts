/**
 * FR-F4 配置快照与一键回滚的测试。
 *
 * 对应需求规格 `docs/1-需求规格.md:178`（FR-F4 参数版本化与回滚，
 * 验收口径「改坏能一键回滚」）与设计原则 P7
 * （`docs/1-需求规格.md:71`，参数可版本化、可回滚，阈值/权重/策略带版本，改动可追溯）。
 *
 * ## 这批测试里最重要的是哪几条
 *
 * 不是「快照能写能读」那些——那些只能证明文件操作没报错。
 * 真正守 FR-F4 的是**三条链路级断言**：
 *
 * 1. 「patch 已坏时回滚仍然能算出差异」——回滚基准必须是未校验的合并结果，
 *    而不是校验失败后退回的 `DEFAULT_CONFIG`。用后者的话差异恒为空，
 *    回滚什么都不写，而 patch 里的坏值原封不动。
 * 2. 「回滚后宿主 `resolveConfig` 不再抛错」——这是用户唯一能感知的结果。
 *    只断言覆盖层文件写出来了，等于只验了中间产物。
 * 3. 「降级配置不记快照」——否则坏配置会成为最新回滚点，
 *    而回滚到它等于回滚到一个错误。
 *
 * 前两条都是先跑出来的真缺陷（`.tmp/probe-f4-e2e.ts` 第 4、5 步），
 * 不是补上去的防御。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { runCli } from '../../src/cli/memoryctl.ts'
import {
  CONFIG_SNAPSHOT_VERSION, ROLLBACK_EXCLUDED_TOP_KEYS, buildRollbackPlan, canonicalConfig,
  coerceConfigSnapshot, configFingerprint, describeConfigChange, describeConfigChanges, diffConfig,
  flattenConfig, parseCanonicalConfig, snapshotToConfig,
} from '../../src/core/configSnapshot.ts'
import { DEFAULT_CONFIG, mergeConfig } from '../../src/core/config.ts'
import { resolveConfig } from '../../src/host/adapter.ts'
import { applyRollbackToDisk, clearRollback, readRollbackState } from '../../src/host/configRollback.ts'
import {
  clearRollbackOverride, readConfigSnapshots, readRollbackRecord, recordConfigSnapshot,
  writeRollbackOverride,
} from '../../src/store/configLedger.ts'

const NOW = 1_700_000_000_000
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-f4-'))
after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

let seq = 0
function freshDir(): string {
  seq += 1
  const dir = join(ROOT, `case-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 造一份「只改了某个叶子」的配置。 */
function withThreshold(threshold: number) {
  return mergeConfig(DEFAULT_CONFIG, { recall: { absoluteThreshold: threshold } })
}

describe('配置快照的纯函数（FR-F4 / P7）', () => {
  it('flattenConfig 把嵌套配置摊平成按路径排序的叶子，且数组整体算一个叶子', () => {
    const leaves = flattenConfig(DEFAULT_CONFIG)
    const paths = leaves.map((leaf) => leaf.path)
    // 排序必须稳定：canonical 文本要靠它做去重判据，顺序一变就会「假变化」。
    assert.deepEqual(paths, [...paths].sort(), '叶子必须按路径升序')
    // 数组整体替换（与 mergeConfig 语义一致）：拆成下标会让「数组变短」变成
    // 一堆「叶子消失」，而它其实是一次整段替换。
    const arrayLeaf = leaves.find((leaf) => leaf.path === 'forgetting.neverArchiveKinds')
    assert.ok(arrayLeaf !== undefined, '前提：配置里必须存在一个数组字段')
    // `ConfigLeaf.value` 是**序列化后**的字符串（见 `flattenInto`），
    // 所以数组叶子的值形如 `["feeling","promise"]`。
    assert.equal(arrayLeaf.value, JSON.stringify(DEFAULT_CONFIG.forgetting.neverArchiveKinds))
    // 数组拆成下标的话，「数组变短」会变成一堆「叶子消失」，
    // 而它实际上是一次整段替换（与 `mergeConfig` 语义一致）。
    assert.equal(
      leaves.filter((leaf) => leaf.path.startsWith('forgetting.neverArchiveKinds.')).length, 0,
    )
  })

  it('canonicalConfig 相同当且仅当配置相同；fingerprint 只当人读标签', () => {
    const a = withThreshold(0.18)
    const b = withThreshold(0.18)
    const c = withThreshold(0.19)
    assert.equal(canonicalConfig(a), canonicalConfig(b), '同配置必须同 canonical')
    assert.notEqual(canonicalConfig(a), canonicalConfig(c), '不同配置必须不同 canonical')
    // fingerprint 是 32 位哈希，会撞；它不能当判据。
    assert.match(configFingerprint(a), /^[0-9a-f]{8}$/)
    assert.equal(configFingerprint(a), configFingerprint(b))
  })

  it('diffConfig 按路径对齐而不是按位置，且只报真正变化的叶子', () => {
    const before = withThreshold(0.18)
    const after = withThreshold(0.3)
    const changes = diffConfig(before, after)
    assert.equal(changes.length, 1, `应只有一项变化，实际 ${JSON.stringify(changes)}`)
    assert.equal(changes[0]!.path, 'recall.absoluteThreshold')
    // `diffConfig` 返回的是**序列化后**的字符串，不是原始值——
    // 它们要直接拼进人读文案（见 `describeConfigChange`）。
    assert.equal(changes[0]!.before, '0.18')
    assert.equal(changes[0]!.after, '0.3')
    assert.deepEqual(diffConfig(before, before), [], '同一份配置不应有任何变化')
  })

  it('buildRollbackPlan 产出最小覆盖而不是整份配置', () => {
    const current = withThreshold(-5 as unknown as number)
    const target = withThreshold(0.18)
    const plan = buildRollbackPlan(current, target)
    assert.equal(plan.changes.length, 1)
    // 最小覆盖的意义：将来 patch 里改别的字段仍然生效。
    // 整份写回会把未触碰的字段冻结在回滚时刻，用户之后改 patch 会「改了不生效」。
    assert.deepEqual(plan.override, { recall: { absoluteThreshold: 0.18 } })
  })

  it('storage 与 configVersion 被排除在回滚之外，且出现在 excluded 里', () => {
    const current = mergeConfig(DEFAULT_CONFIG, { storage: { dataDir: 'D:/a' } })
    const target = mergeConfig(DEFAULT_CONFIG, { storage: { dataDir: 'D:/b' } })
    const plan = buildRollbackPlan(current, target)
    assert.deepEqual(plan.override, {}, 'storage 段不得进入覆盖层')
    // 排除了还必须报出来：静默忽略会让人以为回滚完整执行了。
    assert.ok(plan.excluded.length > 0, '被排除的差异必须被报告')
    assert.ok(ROLLBACK_EXCLUDED_TOP_KEYS.includes('storage'))
    assert.ok(ROLLBACK_EXCLUDED_TOP_KEYS.includes('configVersion'))
  })

  it('describeConfigChange 两侧都写出来，缺失侧写「无」而不是空', () => {
    assert.equal(
      describeConfigChange({ path: 'recall.absoluteThreshold', before: '0.18', after: '0.3' }),
      'recall.absoluteThreshold：0.18 → 0.3',
    )
    assert.match(describeConfigChange({ path: 'x', before: undefined, after: '1' }), /（无）/)
    // 超过上限时必须说明还有多少项，不能默默截断。
    const lines = describeConfigChanges(
      Array.from({ length: 25 }, (_, i) => ({ path: `p${i}`, before: '0', after: '1' })), 20,
    )
    assert.equal(lines.length, 21)
    assert.match(lines[20]!, /还有 5 项/)
  })

  it('coerceConfigSnapshot / parseCanonicalConfig 对坏数据返回 null 而不是空配置', () => {
    assert.equal(coerceConfigSnapshot(null), null)
    assert.equal(coerceConfigSnapshot({ v: 999 }), null)
    assert.equal(parseCanonicalConfig(''), null)
    assert.equal(parseCanonicalConfig('not-a-pair'), null)
    // 只有换行符也必须返回 null。
    assert.equal(parseCanonicalConfig(String.fromCharCode(10)), null)
    // 这一条守的是一个真缺陷：空 canonical 曾经返回 `{}`，
    // 而 `snapshotToConfig({})` 会得到**完整的默认配置**并校验通过 ⇒
    // 一条被截断的快照会静默把整库配置重置为默认值。
    assert.equal(snapshotToConfig(''), null, '空快照绝不能还原成默认配置')
    // 关键：坏数据绝不能退回空配置，否则回滚会把整库配置清空。
    const snap = coerceConfigSnapshot({
      v: CONFIG_SNAPSHOT_VERSION, id: 'abc', at: NOW, configVersion: 9,
      canonical: canonicalConfig(DEFAULT_CONFIG),
    })
    assert.ok(snap !== null)
    const restored = snapshotToConfig(snap.canonical)
    assert.ok(restored !== null)
    assert.equal(canonicalConfig(restored), canonicalConfig(DEFAULT_CONFIG))
  })
})

describe('配置快照台账（FR-F4）', () => {
  it('重复记录同一份配置不追加，改了再改回来算两次真变化', () => {
    const dir = freshDir()
    const a = withThreshold(0.18)
    const b = withThreshold(0.3)
    assert.equal(recordConfigSnapshot(dir, a, NOW, 100).recorded, true)
    assert.equal(recordConfigSnapshot(dir, a, NOW + 1, 100).recorded, false, '同配置不应追加')
    assert.equal(recordConfigSnapshot(dir, b, NOW + 2, 100).recorded, true)
    // A→B→A 是真实变化（用户改回去了），不能因为「与历史某条相同」而丢弃。
    assert.equal(recordConfigSnapshot(dir, a, NOW + 3, 100).recorded, true)
    assert.equal(readConfigSnapshots(dir).length, 3)
  })

  it('超过上限时保留最新的 N 条而不是最旧的', () => {
    const dir = freshDir()
    // 用显式数组而不用 `0.1 + i * 0.05`：后者在 i=4 时得到
    // 0.30000000000000004，与期望的 0.3 不等——**红的是我的期望值，
    // 不是实现**。与提交 `6498a46` 那次把上海时刻算错是同一类错误。
    const thresholds = [0.1, 0.15, 0.2, 0.25, 0.3]
    for (let i = 0; i < thresholds.length; i += 1) {
      recordConfigSnapshot(dir, withThreshold(thresholds[i]!), NOW + i, 3)
    }
    const kept = readConfigSnapshots(dir)
    assert.equal(kept.length, 3)
    // 保留最新：末尾那条必须是最后写进去的那份。
    assert.equal(
      canonicalConfig(snapshotToConfig(kept[2]!.canonical)!),
      canonicalConfig(withThreshold(0.3)),
    )
  })

  it('单行损坏被跳过，不拖垮整份台账', () => {
    const dir = freshDir()
    recordConfigSnapshot(dir, withThreshold(0.18), NOW, 100)
    const file = join(dir, 'config', 'snapshots.jsonl')
    writeFileSync(file, `${readFileSync(file, 'utf8')}{坏行\n`, 'utf8')
    const kept = readConfigSnapshots(dir)
    assert.equal(kept.length, 1, '坏行必须跳过，好行必须留下')
  })

  it('回滚覆盖层写入、读回、清除三态分明', () => {
    const dir = freshDir()
    assert.equal(readRollbackRecord(dir), null, '未写入时必须是 null 而不是空对象')
    writeRollbackOverride(dir, { recall: { absoluteThreshold: 0.18 } }, 'snap-1', NOW)
    const record = readRollbackRecord(dir)
    assert.ok(record !== null)
    assert.equal(record.targetId, 'snap-1')
    assert.equal(record.at, NOW)
    assert.deepEqual(record.override, { recall: { absoluteThreshold: 0.18 } })
    // 清除必须真的删掉，并且返回「之前存在」。
    assert.equal(clearRollbackOverride(dir), true)
    assert.equal(readRollbackRecord(dir), null)
    assert.equal(clearRollbackOverride(dir), false, '本来没有时必须报 false')
    assert.equal(existsSync(join(dir, 'config', 'rollback.json')), false)
  })
})

describe('回滚覆盖层的生效点（FR-F4 验收：改坏能一键回滚）', () => {
  it('覆盖层在校验之前叠加：被改坏的 patch 也能被救回来', () => {
    // 这是整个 FR-F4 的核心断言。若覆盖层在校验之后叠加，
    // 这一行会抛错——而那正是「用户执行了回滚、宿主仍然崩溃」的形态。
    const broken = { recall: { absoluteThreshold: -5 } }
    assert.throws(() => resolveConfig(broken), /配置非法/, '前提：这份 patch 本身必须是非法的')
    const rescued = resolveConfig(broken, { recall: { absoluteThreshold: 0.18 } })
    assert.equal(rescued.recall.absoluteThreshold, 0.18)
  })

  it('覆盖层是深合并：只写一个叶子不会把同段其余字段清空', () => {
    const rescued = resolveConfig(
      { recall: { absoluteThreshold: -5 } },
      { recall: { absoluteThreshold: 0.2 } },
    )
    // 浅合并会让 recall 段只剩 absoluteThreshold 一个字段，
    // 其余字段变成 undefined，然后在校验处炸出一堆假错误。
    assert.equal(rescued.recall.minCards, DEFAULT_CONFIG.recall.minCards)
    assert.equal(rescued.recall.tokenBudget, DEFAULT_CONFIG.recall.tokenBudget)
    assert.equal(rescued.recall.maxCards, DEFAULT_CONFIG.recall.maxCards)
  })

  it('applyRollbackToDisk：相同配置报 noop，只有被排除段不同报 excludedOnly', () => {
    const dir = freshDir()
    const a = withThreshold(0.18)
    assert.equal(applyRollbackToDisk(dir, a, a, 'x', NOW).outcome, 'noop')
    // 只差 storage：回滚一项也做不成，必须报出来而不是写一个空覆盖层。
    // 写空覆盖层会让 `config list` 显示「已回滚」而实际什么都没变。
    const b = mergeConfig(a, { storage: { dataDir: 'D:/other' } })
    const result = applyRollbackToDisk(dir, a, b, 'x', NOW)
    assert.equal(result.outcome, 'excludedOnly')
    assert.ok(result.excluded > 0)
    assert.equal(readRollbackRecord(dir), null, 'excludedOnly 时不应留下覆盖层')
  })

  it('readRollbackState 在 targetId 缺失时仍返回覆盖层（不能因标签丢了就失效）', () => {
    const dir = freshDir()
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(
      join(dir, 'config', 'rollback.json'),
      JSON.stringify({ override: { recall: { absoluteThreshold: 0.18 } } }),
      'utf8',
    )
    const state = readRollbackState(dir)
    assert.ok(state !== null, '缺少 targetId 不能让整份覆盖层失效')
    assert.deepEqual(state.override, { recall: { absoluteThreshold: 0.18 } })
  })

  it('clearRollback 返回是否真的清掉了', () => {
    const dir = freshDir()
    assert.equal(clearRollback(dir), false)
    writeRollbackOverride(dir, { recall: { absoluteThreshold: 0.18 } }, 's', NOW)
    assert.equal(clearRollback(dir), true)
    assert.equal(readRollbackState(dir), null)
  })
})

describe('CLI config 子命令（FR-F4）', () => {
  function setup(threshold: number): { dataDir: string; patch: string } {
    const dir = freshDir()
    const dataDir = join(dir, 'data')
    const patch = join(dir, 'cordis.patch.yml')
    mkdirSync(dataDir, { recursive: true })
    writePatch(patch, dataDir, threshold)
    return { dataDir, patch }
  }

  function writePatch(path: string, dataDir: string, threshold: number): void {
    writeFileSync(path, [
      'config:',
      '  storage:',
      `    dataDir: '${dataDir.replace(/\\/g, '/')}'`,
      '  recall:',
      `    absoluteThreshold: ${threshold}`,
      '',
    ].join('\n'), 'utf8')
  }

  it('config list 在还没有快照时说「还没有」而不是输出空表', () => {
    const { dataDir, patch } = setup(0.18)
    const result = runCli(['--data-dir', dataDir, 'config', 'list'], { configPath: patch, now: () => NOW })
    assert.equal(result.code, 0)
    // 「没有数据」和「数据都一样」是两件事，不能都输出空表。
    assert.match(result.stdout, /还没有配置快照/)
  })

  it('执行任意子命令后 config list 能看到一条快照（文案不是假的）', () => {
    const { dataDir, patch } = setup(0.18)
    const health = runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    assert.equal(health.code, 0)
    const list = runCli(['--data-dir', dataDir, 'config', 'list'], { configPath: patch, now: () => NOW })
    assert.match(list.stdout, /共 1 条/)
    // 台账里必须真的有配置内容，不能只有一行时间戳。
    const snaps = readConfigSnapshots(dataDir)
    assert.equal(snaps.length, 1)
    assert.match(snaps[0]!.canonical, /recall\.absoluteThreshold=0\.18/)
  })

  it('patch 非法时退回默认配置，且不把降级态记成快照', () => {
    const { dataDir, patch } = setup(-5)
    const health = runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    // 降级必须报出来（stderr），不能静默。
    assert.match(health.stderr, /不合法/)
    // 降级态不是用户意图，记下来会在需要回滚时成为最新回滚点。
    assert.equal(readConfigSnapshots(dataDir).length, 0, '降级态不得记入快照台账')
  })

  it('patch 已坏时 config rollback 仍能执行，并把差异算出来', () => {
    const { dataDir, patch } = setup(0.18)
    // 先启动一次，留下合法快照。
    runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    const targetId = readConfigSnapshots(dataDir)[0]!.id
    // 再把 patch 改坏。
    writePatch(patch, dataDir, -5)
    const rollback = runCli(
      ['--data-dir', dataDir, 'config', 'rollback', targetId],
      { configPath: patch, now: () => NOW + 1 },
    )
    assert.equal(rollback.code, 0, `回滚失败：${rollback.stderr}`)
    // 核心：必须报出「-5 → 0.18」。若回滚基准取的是退回默认值后的配置，
    // 这里差异恒为空，回滚什么都不写而 patch 里的坏值原封不动。
    assert.match(rollback.stdout, /recall\.absoluteThreshold：-5 → 0\.18/)
    const record = readRollbackRecord(dataDir)
    assert.ok(record !== null)
    assert.deepEqual(record.override, { recall: { absoluteThreshold: 0.18 } })
  })

  it('回滚之后宿主 resolveConfig 不再抛错（用户能感知的结果）', () => {
    const { dataDir, patch } = setup(0.18)
    runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    const targetId = readConfigSnapshots(dataDir)[0]!.id
    writePatch(patch, dataDir, -5)
    runCli(['--data-dir', dataDir, 'config', 'rollback', targetId], { configPath: patch, now: () => NOW })

    const broken = { recall: { absoluteThreshold: -5 } }
    assert.throws(() => resolveConfig(broken), /配置非法/)
    // 只断言「覆盖层文件写出来了」等于只验了中间产物；
    // 用户唯一能感知的是「宿主不再崩」。
    const rescued = resolveConfig(broken, readRollbackRecord(dataDir)!.override)
    assert.equal(rescued.recall.absoluteThreshold, 0.18)
  })

  it('config rollback --clear 之后 patch 里的坏值重新暴露（清除是真的）', () => {
    const { dataDir, patch } = setup(0.18)
    runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    const targetId = readConfigSnapshots(dataDir)[0]!.id
    writePatch(patch, dataDir, -5)
    runCli(['--data-dir', dataDir, 'config', 'rollback', targetId], { configPath: patch, now: () => NOW })
    const cleared = runCli(
      ['--data-dir', dataDir, 'config', 'rollback', '--clear'],
      { configPath: patch, now: () => NOW },
    )
    assert.equal(cleared.code, 0)
    assert.match(cleared.stdout, /已清除回滚覆盖层/)
    assert.equal(readRollbackRecord(dataDir), null)
    // 清除后 patch 又坏了，必须重新报错——证明覆盖层真的在起作用，
    // 而不是「不管有没有它配置都恰好合法」。
    const after = runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    assert.match(after.stderr, /不合法/)
  })

  it('config rollback 不给 id 报用法错误；id 不存在时报出已知 id', () => {
    const { dataDir, patch } = setup(0.18)
    runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    const missing = runCli(['--data-dir', dataDir, 'config', 'rollback'], { configPath: patch, now: () => NOW })
    assert.equal(missing.code, 2, '缺 id 是用法错误，退出码必须是 2')
    const unknown = runCli(
      ['--data-dir', dataDir, 'config', 'rollback', 'deadbeef'],
      { configPath: patch, now: () => NOW },
    )
    assert.equal(unknown.code, 2)
    // 报错必须给出已知 id，否则用户只能自己去翻文件。
    assert.match(unknown.stderr, new RegExp(readConfigSnapshots(dataDir)[0]!.id))
  })

  it('config diff 报叶子级变化；无变化时说「没有变化」', () => {
    const { dataDir, patch } = setup(0.18)
    runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    const same = runCli(['--data-dir', dataDir, 'config', 'diff'], { configPath: patch, now: () => NOW })
    assert.match(same.stdout, /没有变化/)
    // 改一个叶子后必须报出具体路径与前后值。
    writePatch(patch, dataDir, 0.3)
    const changed = runCli(['--data-dir', dataDir, 'config', 'diff'], { configPath: patch, now: () => NOW })
    assert.match(changed.stdout, /recall\.absoluteThreshold：0\.18 → 0\.3/)
  })

  it('config list 的 --json 输出带上 rollbackActive，便于脚本判断', () => {
    const { dataDir, patch } = setup(0.18)
    runCli(['--data-dir', dataDir, 'health'], { configPath: patch, now: () => NOW })
    const targetId = readConfigSnapshots(dataDir)[0]!.id
    writeRollbackOverride(dataDir, { recall: { absoluteThreshold: 0.18 } }, targetId, NOW)
    const list = runCli(
      ['--data-dir', dataDir, 'config', 'list', '--json'],
      { configPath: patch, now: () => NOW },
    )
    const parsed = JSON.parse(list.stdout) as { rollbackActive: boolean; total: number }
    assert.equal(parsed.rollbackActive, true)
    assert.equal(parsed.total, 1)
  })
})
