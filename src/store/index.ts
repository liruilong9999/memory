/**
 * 数据面统一出口。
 *
 * 上层（巩固面、适配面、CLI）只从这里取数据面能力，避免直接依赖内部文件名，
 * 将来换实现（比如把日志换成别的存储）时只需改这一处。
 *
 * @module dsh-memory/store
 */

export {
  Journal, buildIdempotencyKey, decodeRecord, encodeRecord, listShardFiles, shardFileName,
} from './journal.ts'
export type { AppendOutcome, JournalOptions } from './journal.ts'

export {
  EMPTY_STATE, applyRecord, applyRecordPure, cloneState, countCards, createEmptyState,
  edgesOf, filterCards, getCard, pruneEdges, rebuildState,
} from './state.ts'
export type { MemoryFilter, MemoryState } from './state.ts'

export {
  addToIndex, buildIndex, buildIndexFromMap, collectTerms, indexStats, isIndexConsistent,
  removeFromIndex, searchIndex, searchText,
} from './inverted.ts'
export type { IndexHit, InvertedIndex } from './inverted.ts'

export {
  EXPORT_FORMAT_VERSION, exportJsonl, exportRecordsJsonl, importJsonl, validateImport,
} from './export.ts'
export type { ExportHeader, ExportLine, ExportLineKind, ImportResult } from './export.ts'

export { MemoryStore, cardIdFor, deriveIdempotencyKey, openStore } from './store.ts'
export type { StoreOptions, WriteResult } from './store.ts'
