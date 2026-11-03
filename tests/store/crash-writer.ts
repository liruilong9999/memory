/**
 * ST-3 强杀用例的写入子进程。
 *
 * 这个文件**故意不叫 `*.test.ts`**：测试 glob 是 `tests/**\/*.test.ts`，
 * 所以它不会被当成用例收集，只作为 `crash.test.ts` 的子进程被执行。
 *
 * 为什么必须开子进程：ST-3 要验的是「写入过程中强杀进程，重启后已确认写入完整」。
 * 在同一个进程里模拟「写到一半」只能手工造残缺行——那验的是修复函数，不是崩溃场景。
 *
 * ## 为什么用 `writeSync(1, ...)` 而不是 `process.stdout.write`
 *
 * `process.stdout` 对管道是**异步**的：子进程在同步循环里从不让出事件循环，
 * 于是 `OK 1`、`OK 2`、`OK 3` 会一起被冲刷出去。父进程看到它们时，磁盘上
 * 早已多写了若干条——「已确认条数」就不再是一个准确的水位，断言会变成
 * 时红时绿的噪声。用 `writeSync` 保证每条 `OK` 打印时，对应记录**确实已落盘**。
 *
 * 输出协议（父进程按行解析）：
 * - `READY`：日志已打开。
 * - `OK <seq>`：第 `<seq>` 条已落盘并 fsync 完成（`append` 返回之后才打印）。
 *
 * @module tests/store/crash-writer
 */

import { writeSync } from 'node:fs'

import { Journal } from '../../src/store/journal.ts'

const dir = process.argv[2]
if (dir === undefined || dir.length === 0) {
  process.stderr.write('缺少数据目录参数\n')
  process.exit(2)
}
const segmentBytes = Number(process.argv[3] ?? String(1 << 20))
const padLength = Number(process.argv[4] ?? '8192')

const journal = new Journal({ dir, segmentBytes, fsyncOnWrite: true, mode: 'write' })
journal.open()

// 每条记录塞一段填充，把单次 `writeSync` 的时间拉长。
// 不填充的话一行只有 100 多字节，写入窗口窄到几乎杀不中。
const pad = 'x'.repeat(padLength)

writeSync(1, 'READY\n')

let i = 0
for (;;) {
  i += 1
  const now = Date.now()
  const outcome = journal.append({
    v: 1,
    // seq 由日志统一分配，这里的值只是占位（见 Journal.append 的说明）。
    seq: 0,
    at: now,
    idempotencyKey: `crash-key-${i}`,
    op: { op: 'archive', id: `crash-card-${i}`, at: now, reason: pad },
  })
  if (!outcome.appended) continue
  writeSync(1, `OK ${outcome.record.seq}\n`)
}
