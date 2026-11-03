/**
 * ST-3 崩溃恢复：真实强杀进程后重开。
 *
 * 需求原文（`docs/1-需求规格.md:258`）：
 * 「崩溃恢复 | 写入过程中强杀进程，重启后已确认写入完整、无半条记录」
 *
 * ## 为什么必须真开子进程
 *
 * 已有两条用例是**手工造残缺行**（`tests/store/journal.test.ts` 的
 * 「尾部残缺行应在打开时被截断」「残缺行被截断后文件以换行结尾」），
 * 它们验的是 `repairTail` 这个修复函数，**不是崩溃场景**。
 * 而 ST-3 的原话是「写入过程中强杀进程」——所以这条必须真杀。
 *
 * ## 重要发现：本平台强杀**产不出**半条记录
 *
 * 写这个文件之前，我用五组探测测了一件事：
 * **SIGKILL 到底能不能撕裂一次 `writeSync`？**
 *
 * 答案是不能。证据分两层。
 *
 * **第一层（区分「没在写」和「写不可撕裂」）**：绕开 `Journal`，直接
 * `openSync` + 单次 `writeSync`（每条 50 MB），在 `writeSync` 的紧邻上一行
 * 打同步标记，父进程看到标记后**延迟 N 毫秒**再 SIGKILL：
 *
 * | 延迟 | 延迟期间子进程写完了 | 撕裂次数 | 被杀时文件长度余数 |
 * |---|---|---|---|
 * | 0 / 1 / 2 / 5 / 10 / 20 / 40 / 80 ms | 0 ~ 4 条 | **0 / 48** | 恒为 0 |
 * | 20 ms | 1 条 | 0 / 3 | 0 |
 * | 60 ms | 2 ~ 3 条 | 0 / 3 | 0 |
 * | 120 ms | 4 条 | 0 / 3 | 0 |
 *
 * 「延迟期间写完了 4 条」是**正向证据**：证明杀的时候子进程确实在写，
 * 而不是空转。而文件长度（`statSync` 大小对「记录长度 + 1」取模）**永远是 0**
 * ——没有一次落在记录中间。
 *
 * 这一步不可省。上一版探测在收到标记后**立刻**杀，于是「标记写完」和
 * 「信号送达」之间存在天然同步点，信号几乎必然落在两次写入之间；
 * 那种情况下 0 命中只能说明「没进去写」，说明不了「写不可撕裂」。
 * **两种假设的观测值一模一样，必须靠延迟把窗口覆盖开才能区分。**
 *
 * **第二层（尺寸扫描）**：记录大小 8 KB / 1 MB / 10 MB / 50 MB 各跑多次，
 * 撕裂恒为 0（`.tmp/probe-sweep.mjs`、`.tmp/probe-tear.mjs`）。
 *
 * 机制上的解释是：`writeSync` 对常规文件走单次内核写，文件长度在写操作完成时
 * 才提交，所以 SIGKILL 要么在写之前生效（整条没写），要么在之后（整条写完）。
 * 需要说明的是，**文件大小在写入过程中本来就不是逐字节可见的**，所以严格说
 * 我们观测到的是「SIGKILL 之后文件总落在记录边界上」——而这恰好就是 ST-3
 * 关心的那件事（重启后能读到什么）。
 *
 * ## 所以这个文件测什么
 *
 * 「无半条记录」这一半**在本平台无法由强杀产出**，只能由构造残缺行来测
 * （`journal.test.ts` 已经测了）。这里诚实地把它当**观测值**记录，
 * 并断言「凡是落盘的行都必须完整可解码」——这一条强杀真的能测：
 * 已确认写入的记录一条不少、序号连续、无重复、水位与磁盘一致。
 *
 * 换句话说：**这个文件不假装测了「撕裂修复」，它测的是「强杀之后库还能
 * 正确重开」**，而那正是 ST-3 里用户真正关心的部分（重启后可用）。
 * 最后一条用例把「产不出残片」这个局限本身钉成断言，防止将来有人误以为
 * `crash.test.ts` 覆盖了撕裂修复而去删掉 `journal.test.ts` 那两条手工用例。
 *
 * ## 第二个重要发现：`okSeqs` 是**管道水位**，不是磁盘真相
 *
 * 最初这里断言的是 `readRecords(dir).length === okSeqs.length`——「重开解出的
 * 条数必须等于强杀前已确认的条数」。这条断言**断言了测试装置无法保证的时序**，
 * 会时红时绿（实测在 40 次基线里没撞上，但在变异后连跑里撞上过 1/5 次，
 * 而那个变异与崩溃路径毫无关系——**绿得可疑、红得也无关**，正是判据选错的形态）。
 *
 * 机制：父进程收到 `OK N` 后调 `child.kill('SIGKILL')`，而 **kill 是异步的**。
 * 子进程的执行顺序是「`append()` 落盘 → `writeSync(1, 'OK N')`」，所以
 * 在「第 N+1 条已落盘」与「父进程读到 `OK N+1`」之间存在一个窗口：
 * 信号若落在窗口里，磁盘上有 N+1 条，而 `okSeqs` 只有 N 条。
 *
 * 直接验证（`.tmp/probe-kill-window.mjs`，把 kill 主动延后以撑开窗口）：
 *
 * | kill 延迟 | 观测到的（确认数, 磁盘数） |
 * |---|---|
 * | 0 ms × 18 | 恒为 (3,3) / (5,5) / (6,6)——窗口太窄，撞不上 |
 * | **10 ms × 6** | **(15,15) (15,15) (16,16) (16,17) (17,17) (17,17)** |
 *
 * 那条 `(16,17)` 就是确凿证据：**磁盘上比已确认多一条**。
 * 这不是实现缺陷（没有丢记录、没有缺口、没有重复），而是**测试装置在断言
 * 一个它无法保证的性质**。
 *
 * 所以判据改成三件事，每一件都是 ST-3 真正要的，且都不依赖那个窗口：
 *
 * 1. `磁盘条数 >= 已确认条数`——**已确认的一条不少**（这是 ST-3 的原话）。
 * 2. 磁盘序号**从 1 起严格连续**——有缺口就是丢记录，有重复就是重写。
 * 3. `journal.count()` / `lastSeq()` 与**磁盘实测**一致，而不是与管道水位一致。
 *
 * 少的那一半（「不多」）在这里**明确放弃断言**：在异步 kill 下它不可能被
 * 可靠观测。硬要断言它，得到的不是安全性，而是随负载飘的假红。
 *
 * @module tests/store/crash
 */

import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Journal, decodeRecord, listShardFiles } from '../../src/store/journal.ts'
import type { JournalRecord } from '../../src/core/types.ts'
import { makeTempDir, removeDirContents } from './helpers.ts'

/** 子进程脚本路径。`new URL(...).pathname` 在 Windows 上带前导 `/D:`，要削掉。 */
const WRITER = new URL('./crash-writer.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** 强杀观测结果。 */
interface KillOutcome {
  /**
   * 强杀前父进程**从管道读到**的 `OK` 序号。
   *
   * **这是管道水位，不是磁盘真相。** `kill` 是异步的，信号送达前子进程
   * 完全可能又落盘一条（它已经 `append` 完成、只是 `OK` 还没被父进程读到）。
   * 所以只能断言「磁盘条数 >= 这个长度」，不能断言相等。
   * 详见文件头部「`okSeqs` 是管道水位」一节。
   */
  okSeqs: number[]
  /** 子进程收到的信号。 */
  signal: NodeJS.Signals | null
  /** 强杀后磁盘上是否存在不以换行结尾的分片。 */
  partialTail: boolean
}

/**
 * 起一个写入子进程，等它写若干条之后强杀。
 *
 * @param dir - 数据目录。
 * @param killAfter - 收到多少条 `OK` 之后强杀。
 * @param segmentBytes - 单片大小上限，压小可触发滚动。
 * @param padLength - 单条记录的填充长度。
 * @returns 观测结果。
 */
async function killDuringWrite(
  dir: string,
  killAfter: number,
  segmentBytes = 1 << 20,
  padLength = 8192,
): Promise<KillOutcome> {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', WRITER, dir, String(segmentBytes), String(padLength)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const okSeqs: number[] = []
  let buffered = ''
  let killed = false
  let stderrText = ''

  const result = await new Promise<{ signal: NodeJS.Signals | null; code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!killed) { child.kill('SIGKILL'); killed = true }
    }, 30_000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^OK (\d+)$/.exec(line.trim())
        if (match === null) continue
        okSeqs.push(Number(match[1]))
        if (!killed && okSeqs.length >= killAfter) {
          // 此刻子进程正在写第 killAfter+1 条（或即将开始），不给它收尾机会。
          child.kill('SIGKILL')
          killed = true
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderrText += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!killed) {
        reject(new Error(`子进程在强杀前就退出了：code=${String(code)} stderr=${stderrText}`))
        return
      }
      resolve({ signal, code })
    })
  })

  return { okSeqs, signal: result.signal, partialTail: hasPartialTail(dir) }
}

/** 读出目录里全部可解码记录，按分片顺序、行顺序。 */
function readRecords(dir: string): JournalRecord[] {
  const out: JournalRecord[] = []
  for (const file of listShardFiles(dir)) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const line of text.split('\n')) {
      const record = decodeRecord(line)
      if (record !== null) out.push(record)
    }
  }
  return out
}

/** 目录里是否真的存在「不以换行结尾」的分片文件。 */
function hasPartialTail(dir: string): boolean {
  for (const file of listShardFiles(dir)) {
    const text = readFileSync(join(dir, file), 'utf8')
    if (text.length > 0 && !text.endsWith('\n')) return true
  }
  return false
}

/**
 * 强杀后校验磁盘自洽，并返回磁盘实测记录。
 *
 * 判据只有两条，但**必须成对**：
 *
 * 1. `磁盘条数 >= 管道水位`——ST-3 原话「已确认写入完整」。
 *    单看这一条是无牙的：`>=` 在实现把记录写丢时仍然成立（条数少了也满足
 *    「不少于 0」这种退化情形），所以它不能单独用。
 * 2. **磁盘序号必须从 1 起严格连续**——这才是真正有牙的那条：
 *    丢任何一条已确认记录都会在序列里留下缺口，重写任何一条都会产生重复，
 *    两种情况都会让 `deepEqual(seqs, [1..M])` 变红。
 *
 * 合起来：`>=` 守住「不少」，连续性守住「不丢不重」，两条互不替代。
 *
 * **为什么不断言「不多」**：`okSeqs` 是管道水位，`kill` 异步，磁盘上可能比
 * 水位多一条（见文件头部实测表）。断言相等会得到随负载飘的假红。
 */
function assertDiskConsistent(
  dir: string,
  okSeqs: number[],
  label: string,
): JournalRecord[] {
  const records = readRecords(dir)

  assert.ok(
    records.length >= okSeqs.length,
    `${label}：已确认落盘 ${okSeqs.length} 条，重开只解出 ${records.length} 条——`
    + '丢了已确认的写入（这是 ST-3 的直接违例）',
  )

  const seqs = records.map((record) => record.seq)
  assert.deepEqual(
    seqs, Array.from({ length: seqs.length }, (_, i) => i + 1),
    `${label}：磁盘序号必须从 1 起严格连续（无缺口 = 没丢，无重复 = 没重写）。`
    + `实际解出 ${records.length} 条，序号 ${JSON.stringify(seqs.slice(0, 12))}`,
  )

  // 幂等键与序号一一对应（子进程每条用 `crash-key-${seq}`），
  // 于是「条数对得上」这件事由序号连续性直接守住，不必再数一遍。
  const keys = records.map((record) => record.idempotencyKey)
  assert.equal(
    new Set(keys).size, keys.length,
    `${label}：幂等键必须两两不同，实际 ${keys.length} 条里有 ${keys.length - new Set(keys).size} 条重复`,
  )

  return records
}

describe('ST-3 真实强杀', () => {
  test('写入过程中被 SIGKILL 后重开：已确认写入一条不少、无半条记录', async () => {
    const dir = makeTempDir('dsh-crash-')
    try {
      const killed = await killDuringWrite(dir, 3)

      // ---- 前提断言：崩溃确实发生在写入过程中 ----
      assert.equal(killed.signal, 'SIGKILL', '前提：子进程必须是被 SIGKILL 杀掉的')
      assert.ok(
        killed.okSeqs.length >= 3,
        `前提：强杀前必须至少有 3 条已确认落盘，实际 ${killed.okSeqs.length} 条。`
        + '若为 0，说明测的是「空库重开」，和崩溃恢复无关',
      )

      // ---- 真正的断言：磁盘自洽（见 assertDiskConsistent 的注释） ----
      const records = assertDiskConsistent(dir, killed.okSeqs, '强杀重开')

      // ---- 「无半条记录」：凡是落盘的行都必须完整 ----
      // 注意这里**不断言「一定有残片被修掉」**：本平台强杀产不出残片
      // （见文件头部的实测表格）。断言的落点是「落盘的每一行都完整」，
      // 它在两种情况下都成立且都有意义：
      //   · 有残片 ⇒ 必须已被 open() 截掉（下面 open 之后复查）
      //   · 无残片 ⇒ 说明本次强杀没撕开记录，条数断言仍守住了「不丢不多」
      const journal = new Journal({
        dir, segmentBytes: 1 << 20, fsyncOnWrite: true, mode: 'repair',
      })
      journal.open()
      assert.equal(
        hasPartialTail(dir), false,
        'open() 之后所有分片都必须以换行结尾：残片要么本来就没有，要么已被 repairTail 截掉',
      )
      assert.equal(
        journal.count(), records.length,
        'open() 报告的条数必须等于磁盘实测条数（不是管道水位）',
      )
      assert.equal(
        journal.lastSeq(), records.length,
        'maxSeq 水位必须等于磁盘最大序号，不能因为残片而虚高或回退',
      )
      journal.close()
    } finally {
      removeDirContents(dir)
    }
  })

  test('强杀重启后 seq 连续无缺口，且续写接在旧水位之后', async () => {
    const dir = makeTempDir('dsh-crash-')
    try {
      const killed = await killDuringWrite(dir, 5)
      assert.ok(killed.okSeqs.length >= 5, `前提：至少要 5 条，实际 ${killed.okSeqs.length}`)

      const journal = new Journal({
        dir, segmentBytes: 1 << 20, fsyncOnWrite: true, mode: 'write',
      })
      journal.open()
      // 序号由日志统一分配（`maxSeq + 1`），崩溃后重开若水位恢复错了，
      // 缺口会直接暴露。
      const seqs = journal.readAll().map((record) => record.seq)
      assert.deepEqual(
        seqs, Array.from({ length: seqs.length }, (_, i) => i + 1),
        '序号必须从 1 起严格连续，无缺口、无重复',
      )

      // 重开之后继续写，新序号必须接在旧水位之后 —— 证明水位真的从磁盘恢复了，
      // 而不是从 0 重新开始（那会产出重复序号并让重放顺序失效）。
      const before = journal.lastSeq()
      const outcome = journal.append({
        v: 1,
        seq: 0,
        at: Date.now(),
        idempotencyKey: 'after-crash-1',
        op: { op: 'archive', id: 'after-crash-card', at: Date.now(), reason: '续写' },
      })
      assert.equal(outcome.appended, true)
      assert.equal(
        outcome.record.seq, before + 1,
        `崩溃后首条新记录的序号必须是 ${before + 1}，实际 ${outcome.record.seq}`,
      )
      journal.close()
    } finally {
      removeDirContents(dir)
    }
  })

  test('强杀重启后未出现重复记录，且幂等键集合已从磁盘恢复', async () => {
    const dir = makeTempDir('dsh-crash-')
    try {
      const killed = await killDuringWrite(dir, 4)
      assert.ok(killed.okSeqs.length >= 4, `前提：至少要 4 条，实际 ${killed.okSeqs.length}`)

      const records = assertDiskConsistent(dir, killed.okSeqs, '强杀重开（幂等键）')

      // 重开后幂等键集合必须从磁盘恢复：拿一个已存在的 key 再写，
      // 必须被判为重复丢弃，而不是当成新记录追加。
      const journal = new Journal({
        dir, segmentBytes: 1 << 20, fsyncOnWrite: true, mode: 'write',
      })
      journal.open()
      const first = records[0]
      assert.ok(first !== undefined, '前提：必须至少有一条记录')
      const countBefore = journal.count()
      const dup = journal.append({
        v: 1,
        seq: 0,
        at: Date.now(),
        idempotencyKey: first.idempotencyKey,
        op: { op: 'archive', id: 'dup-probe', at: Date.now(), reason: '重复探针' },
      })
      assert.equal(dup.appended, false, '重开后拿已存在的幂等键写入必须被丢弃')
      assert.equal(dup.duplicateOfSeq, first.seq, '必须报出首次落盘的序号，供调用方对齐')
      assert.equal(journal.count(), countBefore, '被丢弃的写入不能改变条数')
      journal.close()
    } finally {
      removeDirContents(dir)
    }
  })

  test('强杀后只读模式不修残片，修复模式才修（三态边界）', async () => {
    // 这条守的是 `JournalMode` 的三态语义：`readonly` 跳过 `repairTail`，
    // `repair` / `write` 才截断。它和 ST-3 直接相关——崩溃之后「谁来修」
    // 决定了「什么时候修」，如果只读命令也修，一个查一眼的动作就在改盘，
    // 事后无从解释。
    //
    // 残片由**手工追加**产生，不是强杀产生的（本平台强杀产不出残片，
    // 见文件头部）。这条测的是「修不修」的策略，不是「能不能撕开」。
    const dir = makeTempDir('dsh-crash-')
    try {
      const killed = await killDuringWrite(dir, 2)
      assert.ok(killed.okSeqs.length >= 2, `前提：至少要 2 条，实际 ${killed.okSeqs.length}`)

      const files = listShardFiles(dir)
      const last = files[files.length - 1]
      assert.ok(last !== undefined, '前提：必须存在至少一个分片文件')
      const path = join(dir, last)
      const original = readFileSync(path, 'utf8')
      appendFileSync(path, '{"v":1,"seq":999,"at":1,"idempotencyKey":"half')
      assert.equal(hasPartialTail(dir), true, '前提：残片必须真的存在，否则这条测不到修复')

      // 只读模式：不修
      const ro = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'readonly' })
      ro.open()
      ro.close()
      assert.equal(hasPartialTail(dir), true, '只读模式绝不能截断磁盘（那是改盘，不是读）')

      // 修复模式：修
      const rp = new Journal({ dir, segmentBytes: 1 << 20, fsyncOnWrite: false, mode: 'repair' })
      rp.open()
      rp.close()
      assert.equal(hasPartialTail(dir), false, '修复模式必须截掉残片')
      assert.ok(
        readFileSync(path, 'utf8').startsWith(original),
        '截断后文件必须以原内容开头（只删尾部残片，不能改前面的字节）',
      )
      const beforeRepair = readRecords(dir).length
      assert.ok(
        beforeRepair >= killed.okSeqs.length,
        `前提：手工追加残片前，完整记录数 ${beforeRepair} 必须不少于已确认数 ${killed.okSeqs.length}`,
      )
      assert.equal(readRecords(dir).length, beforeRepair, '完整记录条数不能变')
    } finally {
      removeDirContents(dir)
    }
  })

  test('强杀重启后 maxSeq 水位与磁盘一致（不虚高、不靠内存残留）', async () => {
    const dir = makeTempDir('dsh-crash-')
    try {
      const killed = await killDuringWrite(dir, 3)
      assert.ok(killed.okSeqs.length >= 3, `前提：至少要 3 条，实际 ${killed.okSeqs.length}`)

      const journal = new Journal({
        dir, segmentBytes: 1 << 20, fsyncOnWrite: true, mode: 'repair',
      })
      journal.open()
      const diskMax = Math.max(...readRecords(dir).map((record) => record.seq))
      assert.equal(
        journal.lastSeq(), diskMax,
        `内存水位 ${journal.lastSeq()} 必须等于磁盘最大序号 ${diskMax}`,
      )
      const countFirst = journal.count()
      journal.close()

      // 关闭后换一个新实例重开：水位必须仍从磁盘重新扫出来
      const again = new Journal({
        dir, segmentBytes: 1 << 20, fsyncOnWrite: true, mode: 'repair',
      })
      again.open()
      assert.equal(again.lastSeq(), diskMax, '新实例重开后水位必须仍等于磁盘最大序号（证明不是靠内存残留）')
      assert.equal(again.count(), countFirst, '新实例重开后条数必须一致')
      again.close()
    } finally {
      removeDirContents(dir)
    }
  })

  test('分片滚动中强杀：多分片重开后序号整体连续', async () => {
    // 单片压到 16KB 让填充记录频繁滚动，验证「多分片」这个更难的形态：
    // `repairTail` 只处理最后一片（那是唯一可能残缺的），但 `open()` 要扫
    // 全部分片，任何一片有坏行都不该让整库打不开；而序号是**全局**分配的，
    // 不能每个分片各自从 1 开始。
    const dir = makeTempDir('dsh-crash-')
    try {
      const killed = await killDuringWrite(dir, 8, 16384, 4096)
      assert.ok(killed.okSeqs.length >= 8, `前提：至少要 8 条，实际 ${killed.okSeqs.length}`)

      const files = listShardFiles(dir)
      assert.ok(
        files.length > 1,
        `前提：必须真的滚动了多个分片（实际 ${files.length} 个），否则这条和单片用例重复`,
      )

      const records = assertDiskConsistent(dir, killed.okSeqs, '多分片强杀重开')
      assert.equal(hasPartialTail(dir), false, '所有分片都必须以换行结尾')
      assert.deepEqual(
        records.map((record) => record.seq),
        Array.from({ length: records.length }, (_, i) => i + 1),
        '跨分片的序号必须整体连续，不能每个分片各自从 1 开始',
      )
    } finally {
      removeDirContents(dir)
    }
  })

  test('本平台强杀产不出残片（记录已知局限，不是期望行为）', async () => {
    // 这条不是「验证功能」，是**把实测结论钉在测试里**，防止将来有人
    // 以为 `crash.test.ts` 覆盖了「撕裂修复」而去删掉 `journal.test.ts`
    // 里那两条手工构造残片的用例。
    //
    // 若这条红了，说明平台行为变了（例如 `writeSync` 不再原子），
    // 那时应该做的是**把上面各条用例的断言加强成「必须有残片被修掉」**，
    // 而不是删掉这条。
    //
    // 实测方法见 `.tmp/probe-tear.mjs`：绕开 Journal 直接 writeSync，
    // 1MB 与 50MB 记录各 8 次，文件长度恒为完整记录的整数倍。
    let observedPartial = 0
    const rounds = 6
    for (let i = 0; i < rounds; i += 1) {
      const roundDir = makeTempDir('dsh-crash-round-')
      try {
        const killed = await killDuringWrite(roundDir, 2, 1 << 20, 1_000_000)
        assert.ok(killed.okSeqs.length >= 2, '前提：每轮都必须真的写入并强杀')
        if (killed.partialTail) observedPartial += 1
      } finally {
        removeDirContents(roundDir)
      }
    }
    assert.equal(
      observedPartial, 0,
      `本轮 ${rounds} 次强杀中出现了 ${observedPartial} 次残片。`
      + '若真的出现了，说明撕裂可以被复现——那是好消息，'
      + '应把「无半条记录」用例加强成「必须有残片被 repairTail 修掉」，并删掉这条局限记录',
    )
  })
})
