/**
 * 夜整理时刻跨进程持久化（FR-C / 起源 L27）。
 *
 * 起源 L27（第 6 条·今日渐进累积+夜晚休眠整理）：夜整理是「每天一次」的
 * 节律。若这个「上次整理时刻」只活在进程内存里，那么每次重启都等于
 * 「从未整理过」，节律就退化成「每次启动整理一次」——它幂等、不丢数据、
 * 不报错，所以几乎不可能被发现，只是白烧全库去重的 CPU。
 *
 * 本文件验证三件事，缺一条功能就是假的：
 * 1. 整理后真的落盘（`engine.lastConsolidatedAt()` 返回该时刻）
 * 2. 重启后真的读回来（新引擎从同一个 `dataDir` 构造）
 * 3. `shouldRunDaily` 真的据此跳过/触发（光有值、没被用上，等于没做）
 *
 * @module tests/host/engine-meta.test
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryEngine } from '../../src/host/engine.ts'
import { openStore } from '../../src/store/store.ts'
import { shouldRunDaily } from '../../src/time/clock.ts'
import { META_FILE_NAME } from '../../src/store/meta.ts'
import { makeTempDir, removeDirContents } from '../store/helpers.ts'
import { makeConfig } from '../consolidate/fixtures.ts'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const TZ = 'Asia/Shanghai'
const T0 = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000

const tempDirs: string[] = []
after(() => {
  for (const dir of tempDirs) removeDirContents(dir)
})

/** 建临时目录并登记清理。 */
function tempDir(): string {
  const dir = makeTempDir('dsh-memory-meta-')
  tempDirs.push(dir)
  return dir
}

/** 在指定目录上开一个引擎（模拟一次进程启动）。 */
function openEngineAt(dir: string, clock: () => number): { engine: MemoryEngine; close: () => void } {
  const config = makeConfig()
  const store = openStore({ dataDir: dir, config })
  const engine = new MemoryEngine({ store, config, timeZone: TZ, clock })
  return { engine, close: () => store.close() }
}

describe('夜整理时刻跨进程持久化（起源 L27）', () => {
  it('整理后 lastConsolidatedAt() 返回该时刻', () => {
    const dir = tempDir()
    const { engine, close } = openEngineAt(dir, () => T0)
    // 前提：必须是「从未整理过」的初始状态，否则下面可能绿在初值上。
    assert.equal(engine.lastConsolidatedAt(), null, '前提：新库必须从未整理过')

    engine.consolidate(T0)
    assert.equal(engine.lastConsolidatedAt(), T0, '整理后必须记住该时刻')
    close()
  })

  it('重启后仍记得上次整理时刻（不落盘这条会红）', () => {
    const dir = tempDir()

    const first = openEngineAt(dir, () => T0)
    first.engine.consolidate(T0)
    // 前提：先证明第一次真的记住了。没有这条，下面「重启后也是 T0」可能
    // 绿在「两个都是 null」上——那正是这条用例要防的失败模式。
    assert.equal(first.engine.lastConsolidatedAt(), T0, '前提：第一次必须真的整理过')
    first.close()

    // 模拟进程重启：新 store、新引擎，同一个 dataDir。
    const second = openEngineAt(dir, () => T0 + 1000)
    assert.equal(second.engine.lastConsolidatedAt(), T0, '重启后必须记得上次整理时刻')
    second.close()
  })

  it('重启后同一天不重复整理、第二天才整理（证明值真的被用上了）', () => {
    const dir = tempDir()
    const config = makeConfig()
    const dailyAt = config.consolidation.dailyAt

    const first = openEngineAt(dir, () => T0)
    first.engine.consolidate(T0)
    first.close()

    const second = openEngineAt(dir, () => T0 + 1000)
    const restored = second.engine.lastConsolidatedAt()
    // 前提：restored 必须非空，否则 shouldRunDaily(null) 恒 true，下面
    // 「同一天不整理」必然红，红得没有信息量。
    assert.notEqual(restored, null, '前提：重启后必须有值')

    assert.equal(
      shouldRunDaily(restored, T0 + 1000, TZ, dailyAt), false,
      '同一天内重启不应再整理',
    )
    assert.equal(
      shouldRunDaily(restored, T0 + DAY_MS, TZ, dailyAt), true,
      '第二天应当整理',
    )
    second.close()
  })

  it('meta.json 丢失后退回「启动就整理一次」（判据一允许丢，这是正确降级）', () => {
    const dir = tempDir()
    const config = makeConfig()

    const first = openEngineAt(dir, () => T0)
    first.engine.consolidate(T0)
    assert.equal(first.engine.lastConsolidatedAt(), T0, '前提：必须先落盘成功')
    first.close()

    // 删掉 meta.json：模拟「判据一允许丢的派生状态」真的丢了。
    const metaPath = join(dir, META_FILE_NAME)
    assert.equal(existsSync(metaPath), true, '前提：meta.json 必须真的存在过')
    unlinkSync(metaPath)

    const second = openEngineAt(dir, () => T0 + 1000)
    // 丢了就退回 null，于是「启动就整理一次」。**这是正确降级**：
    // 代价是多跑一次幂等整理，换来的是「不需要在 meta 损坏时阻塞启动」。
    assert.equal(second.engine.lastConsolidatedAt(), null, '丢失后退回 null')
    assert.equal(
      shouldRunDaily(second.engine.lastConsolidatedAt(), T0 + 1000, TZ, config.consolidation.dailyAt),
      true,
      '丢失后应当重新整理（幂等，代价可接受）',
    )
    second.close()
  })
})
