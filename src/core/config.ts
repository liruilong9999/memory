/**
 * 配置契约：全部可调参数集中在这里，并有默认值、版本号与校验。
 *
 * 原则 P7「参数可版本化、可回滚」与 P8「成本有上界」在本文件落地：
 * 任何阈值、权重、预算都不是散落在代码里的字面量，而是 {@link MemoryConfig}
 * 的字段。宿主的插件 Config（schemastery）与离线 CLI 都从这份结构派生。
 *
 * ## 本文件现在是一个 barrel（桶文件）
 *
 * 实现已按单一职责拆到 `src/core/config/` 下的四个子模块：
 *
 * - `./config/types.ts`：全部 Policy 接口、{@link MemoryConfig}、
 *   {@link SpreadMode}、{@link ConfigValidation}
 * - `./config/defaults.ts`：{@link DEFAULT_CONFIG} 与 {@link MEMORY_CONFIG_VERSION}
 * - `./config/validate.ts`：{@link validateConfig}
 * - `./config/merge.ts`：{@link mergeConfig} 与 {@link DeepPartial}
 *
 * **为什么保留这个 barrel**：全仓有 34 个文件从 `core/config.ts` import，
 * 拆分若同时改掉所有 import 路径，会把一次纯搬移变成一次大范围改动，
 * 让「行为有没有变」无从判断。这里只搬实现、不动任何调用方，
 * 导出名字、签名与取值全部保持原样。
 *
 * @module dsh-memory/core/config
 */

export type {
  ConfigValidation,
  ConsolidationPolicy,
  DedupPolicy,
  ExtractionPolicy,
  ForgettingPolicy,
  GraphPolicy,
  MemoryConfig,
  OutputPolicy,
  RecallPolicy,
  ReminderPolicy,
  ScoringWeights,
  SpreadMode,
  SpreadPolicy,
  StoragePolicy,
} from './config/types.ts'

export { DEFAULT_CONFIG, MEMORY_CONFIG_VERSION } from './config/defaults.ts'
export { validateConfig } from './config/validate.ts'
export { mergeConfig } from './config/merge.ts'
export type { DeepPartial } from './config/merge.ts'
