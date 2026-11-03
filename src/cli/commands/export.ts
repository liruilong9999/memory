import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { MemoryEngine } from '../../host/engine.ts'
import { EXPORT_FORMAT_VERSION } from '../../store/export.ts'
import type { MemoryStore } from '../../store/store.ts'
import { byId, describeError, jsonText, storeFailure } from '../output.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult, ExportDocument } from '../types.ts'

/**
 * `export` 子命令（FR-A6 的离线出口）。
 *
 * 顺序固定（id 升序），导出文件可 diff、可做哈希比对（ST-8）。
 *
 * @param options - 解析后的参数。
 * @param store - 记忆库。
 * @param engine - 记忆引擎。
 * @param now - 导出时刻。
 * @returns 命令结果。
 */
export function runExport(
  options: CliOptions, store: MemoryStore, engine: MemoryEngine, now: number,
): CliResult {
  const cards = engine.query(options.includeArchived ? {} : { status: 'active' })
  const edges = [...store.snapshot().edges.values()]
  const document: ExportDocument = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now,
    dataDir: store.dir,
    counts: {
      active: store.count('active'),
      archived: store.count('archived'),
      edges: edges.length,
      exported: cards.length,
    },
    cards: [...cards].sort(byId),
    edges: [...edges].sort(byId),
  }

  if (options.out === undefined) {
    return { code: EXIT_OK, stdout: jsonText(document), stderr: '' }
  }

  const target = resolve(options.out)
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, jsonText(document), 'utf8')
  } catch (error) {
    return storeFailure(`写入导出文件失败：${describeError(error)}`)
  }

  const summary = {
    out: target,
    exported: document.counts.exported,
    active: document.counts.active,
    archived: document.counts.archived,
    edges: document.counts.edges,
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText(summary), stderr: '' }
  const text = `已导出 ${summary.exported} 张卡片（活跃 ${summary.active} / 归档 ${summary.archived}）、`
    + `${summary.edges} 条图谱边 → ${target}`
  return { code: EXIT_OK, stdout: `${text}\n`, stderr: '' }
}
