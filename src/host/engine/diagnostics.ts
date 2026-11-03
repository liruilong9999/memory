/**
 * 诊断日志落盘（FR-F1）：结构化记录追加 + 环形截断 + 读回。
 *
 * ## 为什么必须落盘
 *
 * 在此之前 `onLog` 是**唯一**出口，而它只在 CLI 里被接成「攒进数组、
 * `--verbose` 时打印」。也就是说：宿主跑一整天，`write` / `recall` /
 * `consolidate` 这些记录**一条都没留下**，重启即清零。
 * FR-F1 要的是「最近 N 次操作可回溯」，一个只在当次进程内存在的数组
 * 满足不了它——出问题时恰恰是「上一次运行发生了什么」查不到。
 *
 * ## 为什么不进事件日志
 *
 * journal 是唯一真相源（P2），诊断日志是**可丢弃**的旁路数据。
 * 混进去会让重放依赖一堆只用于观测的记录，也让日志体积失控。
 *
 * 从 `engine.ts` 抽出来，是因为这三件事（追加 / 截断 / 读回）对文件格式
 * 是同一份约定：**谁写、谁截、谁读必须住在一起**。拆开住时曾经出现过
 * 「写的时候带换行、读的时候按空行切」这类漂移，而它不报错，只是少读几条。
 *
 * @module dsh-memory/host/engine/diagnostics
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import type { MemoryLogEntry } from '../../core/types.ts'

/** 诊断日志参数。 */
export interface DiagnosticLogOptions {
  /** 落盘路径；`null` 表示不落盘（用户显式关闭）。 */
  path: string | null
  /** 环形截断上限；`<= 0` 表示不限制。 */
  maxEntries: number
  /** 结构化日志回调；省略时只落盘。 */
  onLog?: ((entry: MemoryLogEntry) => void) | undefined
}

/**
 * 诊断日志。
 *
 * 每次调用都直接读写文件，不缓存：旁路数据不值得为它维护内存副本，
 * 而且缓存会让「进程被杀时最后几条丢了」变成看不见的事实。
 */
export class DiagnosticLog {
  private readonly path: string | null
  private readonly maxEntries: number
  private readonly onLog: ((entry: MemoryLogEntry) => void) | undefined

  /**
   * @param options - 参数。
   */
  constructor(options: DiagnosticLogOptions) {
    this.path = options.path
    this.maxEntries = options.maxEntries
    this.onLog = options.onLog
  }

  /**
   * 记录一条结构化日志（FR-F1）：先给内存回调，再落盘。
   *
   * 顺序不能反：落盘失败时只有内存回调还活着，它是唯一能报出
   * 「这次记录没留住」的通道。
   *
   * @param entry - 日志条目。
   */
  record(entry: MemoryLogEntry): void {
    this.onLog?.(entry)
    this.persist(entry)
  }

  /**
   * 读回本对象落盘的诊断日志。
   *
   * @returns 日志条目；落盘关闭或文件不存在时 `null`。
   */
  read(): MemoryLogEntry[] | null {
    const path = this.path
    if (path === null || !existsSync(path)) return null
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      // 读不回来不是「零召回」，是「读不到」——退回内存计数并标 source。
      return null
    }
    const entries: MemoryLogEntry[] = []
    for (const line of raw.split(String.fromCharCode(10))) {
      if (line.length === 0) continue
      try {
        entries.push(JSON.parse(line) as MemoryLogEntry)
      } catch {
        // 单行损坏跳过（进程被杀时最后一行常是半条）。
        continue
      }
    }
    return entries
  }

  /**
   * 把一条诊断日志追加到磁盘（FR-F1），并按 `maxEntries` 做环形截断。
   *
   * ## 写失败不能影响主流程
   *
   * 观测能力坏掉（磁盘满、权限不足）不该让召回失败。但**也不能静默**：
   * 通过 `onLog` 发一条 `error` 记录说明落盘失败。
   * 这里不抛异常，因为日志是旁路。
   *
   * @param entry - 日志条目。
   */
  private persist(entry: MemoryLogEntry): void {
    const path = this.path
    if (path === null) return
    try {
      const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
      if (dir.length > 0 && !existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8')
      this.trim(path)
    } catch {
      // 落盘失败：只在**内存回调**里报，不再尝试落盘（否则递归）。
      this.onLog?.({
        kind: 'error',
        at: entry.at,
        summary: '诊断日志落盘失败，本次记录只存在于内存',
        detail: { path },
      })
    }
  }

  /**
   * 环形截断：只保留最后 `maxEntries` 条。
   *
   * `maxEntries <= 0` 表示不限制。**不建议**：长期运行的记忆库会攒出
   * 几百 MB 的旁路文件，而 FR-F1 要的是「最近 N 次」。
   *
   * 实现上「先读全部再写回」在这个规模下是可接受的（默认 500 条），
   * 不值得为它引入游标或分片——那是 journal 才需要的复杂度。
   *
   * @param path - 日志文件路径。
   */
  private trim(path: string): void {
    const limit = this.maxEntries
    if (limit <= 0) return
    const text = readFileSync(path, 'utf8')
    const lines = text.split('\n').filter((line) => line.length > 0)
    if (lines.length <= limit) return
    // 保留最后 limit 条：最早的那些是「已经没人会看」的记录。
    writeFileSync(path, `${lines.slice(-limit).join('\n')}\n`, 'utf8')
  }
}
