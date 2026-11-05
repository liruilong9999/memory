/**
 * 数据面统一出口。
 *
 * 上层（巩固面、适配面、CLI）只从这里取数据面能力，避免直接依赖内部文件名，
 * 将来换实现（比如把日志换成别的存储）时只需改这一处。
 *
 * @module dsh-memory/store
 */

export {
  ConcurrentWriterError, Journal, ReadOnlyModeError, buildIdempotencyKey, decodeRecord,
  encodeRecord, listShardFiles, shardFileName,
} from './journal.ts'
export type { AppendOutcome, JournalMode, JournalOptions } from './journal.ts'

export {
  EMPTY_STATE, applyRecord, applyRecordPure, cloneState, countCards, createEmptyState,
  edgesOf, filterCards, getCard, matchesFilter, pruneEdges, rebuildState,
} from './state.ts'
export type { MemoryFilter, MemoryState } from './state.ts'

export {
  addToIndex, buildIndex, buildIndexFromMap, collectTerms, indexStats, isIndexConsistent,
  removeFromIndex, searchIndex, searchText,
} from './inverted.ts'
export type { IndexHit, InvertedIndex } from './inverted.ts'

export {
  EXPORT_FORMAT_VERSION, exportJsonl, importExportDocument, importJsonl,
  parseExportFile, validateImport,
} from './export.ts'
export type {
  ExportFileFormat, ExportHeader, ImportResult, ParsedExportFile,
} from './export.ts'

export { MemoryStore, deriveIdempotencyKey, openStore } from './store.ts'
export type { StoreOptions, WriteResult } from './store.ts'

// 元信息（`meta.json`）刻意只导出**最小必要接口**：读写「上次巩固时刻」的两个
// 函数，以及文件名常量（供测试证明分片正则不会误吞它）。
//
// 不导出 `readMeta` / `writeMeta` / `StoreMeta`：现在没有任何第二个模块有真实
// 需求。接口越窄，越不可能被顺手用错；将来真有第二处要用，那时再放宽，
// 成本远低于现在就猜一个宽接口。
export { META_FILE_NAME, metaFilePath, readLastConsolidationAt, writeLastConsolidationAt } from './meta.ts'
