/**
 * 数据目录的元信息文件（`meta.json`）。
 *
 * 与事件日志**刻意分开**：日志是事实的唯一来源（P2），而这里存的是系统自身的
 * 调度痕迹。两者混在一起会同时破坏下面两条判据。
 *
 * ## 为什么这些值不进事件日志：两条正交判据
 *
 * 判定一个值该不该写进日志，不能只看「它是不是派生状态」——派生状态有很多种，
 * 有的丢了会让事实失真（比如卡片索引），有的不会。用下面两条判据：
 *
 * ### 判据一（可恢复性）：丢了能否从日志重建？
 *
 * 能 → **可以**放在日志外。
 *
 * `lastConsolidationAt` 丢失的后果是「今晚可能多整理一次」。而整理是**幂等**的
 * （`findDuplicateGroups` 对已合并的卡不会再合并一次），多跑一次只花 CPU，
 * 不改任何记忆内容。所以它可丢。
 *
 * ### 判据二（语义纯净性）：写进日志会不会让日志里出现「用户没做过的事」？
 *
 * 会 → **绝不**写进日志，即使它满足判据一。
 *
 * **判据二比判据一更硬。** 它有两个具体后果，都不会报错：
 *
 * 1. **污染事实源语义**：日志记录的是用户行为历史，重放等于「重放用户做过
 *    什么」。掺入系统调度痕迹后，重放不再等于那个东西——它变成「用户行为
 *    加上系统自己的心跳」。
 * 2. **挤占 seq**：整理一次占一个 `seq`，用户行为和系统调度混进同一条单调
 *    序列。将来任何「按 seq 分析用户行为」的逻辑都会算错，而且**错了不会
 *    报错**——它只是安静地把系统行为当成用户行为统计进去。
 *
 * `lastConsolidationAt` 两条都指向「不进日志」。判据一给它放行，判据二把它
 * 拦住。后人问「为什么不进日志」时，需要的不是结论，是这两条判据。
 *
 * **判据二比判据一更硬。** 一个值即使能从日志重建（满足判据一），只要写进
 * 日志会污染事实源语义（违反判据二），它也不该进。反过来不成立：满足判据二
 * 但丢了会让事实失真的值（比如卡片索引），仍然必须留在日志里。
 *
 * ## 与本模块相关的五个决定
 *
 * ### 1. 独立文件，且分片正则不会误吞它
 *
 * `listShardFiles` 只认 `journal-<数字>.jsonl`，`meta.json` 不匹配。
 * **这条不是巧合，是需要被测试钉住的约束**：若将来有人把分片正则放宽成
 * `*.json`，`meta.json` 会被当成日志分片读进去，`decodeRecord` 对每一行
 * 返回 `null`（它没有 `v` / `op` 字段），然后**重放静默丢数据**。
 * 这类失败没有任何报错，只会表现为「记忆莫名变少」。
 *
 * ### 2. 损坏即重置，不抛错
 *
 * 读不出来就当作空值，让调用方拿到 `EMPTY_META`。
 *
 * **判据**：它只影响「要不要现在整理」，而整理是幂等的（见判据一）。
 * 让它阻塞启动是本末倒置——一个「上次整理是什么时候」记不清，不该导致
 * 整个记忆库打不开。所以这里**不要**加严格校验、不要读不出来就报错。
 *
 * ### 3. 不 fsync
 *
 * 它可丢，丢了的代价是「多整理一次」。为可丢数据付 fsync 代价不合理：
 * 实测 `fsync` 占单次日志写入的 **82%**，是本仓库最贵的一个系统调用。
 * 看到「这里少了个 fsync」时，请先看这段——**那是刻意的，不是漏的**。
 *
 * ### 4. 原子写（先写临时文件再 rename）
 *
 * 与第 2 条**配套**，不是冗余：
 *
 * - 原子写让「半截文件」几乎不可能发生；
 * - 第 2 条让「万一还是坏了」不至于阻塞启动。
 *
 * 只有前者没有后者，一次异常的断电就能让记忆库打不开；只有后者没有前者，
 * 则会经常需要走重置路径，把一个本该罕见的兜底变成常态。
 *
 * ### 5. 刻意**不**走 `store.append` 路径
 *
 * 本模块直接读写 `meta.json`，一个字都不进事件日志。除了前面两条判据，
 * 还有一条**机制上**的理由：
 *
 * 幂等键（`buildIdempotencyKey`）是为**事实记录**设计的——同一件事实重复上报
 * 只该记一条。而 `lastConsolidationAt` 是**派生状态反复覆写**，它天然要求
 * 「后来的覆盖先前的」。
 *
 * 若走 `append`，同一个 id 同结构会被判为重复而**静默丢弃**，于是更新永远
 * 写不进去、读回的还是旧值，且没有任何报错。这不是假想：`putEdge` 就踩过
 * 同一类陷阱——`deriveIdempotencyKey` 的 `edge` 分支一度不含权重，导致用同一
 * id 改边权被静默丢弃（写 `0.33`、再写 `0.38`、读回仍是 `0.33`）。
 *
 * **绕过幂等层是这里的正确做法，不是偷懒**：把「反复覆写的派生状态」塞进
 * 「只记一次的事实日志」，两者语义本来就冲突，强行统一只会得到一个既不能
 * 可靠更新、又污染事实源的东西。
 *
 * @module dsh-memory/store/meta
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 元信息文件名。
 *
 * 刻意**不**以 `journal-` 开头、**不**以 `.jsonl` 结尾，见模块注释第 1 条。
 */
export const META_FILE_NAME = 'meta.json'

/** 元信息文件格式版本。 */
export const META_VERSION = 1

/**
 * 数据目录的元信息。
 *
 * 字段刻意少：每加一个字段都要重新过一遍模块注释里的两条判据。
 */
export interface StoreMeta {
  /** 格式版本，用于将来迁移。 */
  v: number
  /**
   * 上次巩固（夜整理）时刻；从未整理过为 `null`。
   *
   * 它是**跨进程**的：插件进程重启、CLI 与插件交替运行，都应该看到同一个值。
   * 这正是它必须落盘的原因——进程内的 `let lastRunAt = null` 会让每次重启
   * 都重新整理一次（见 `src/index.ts` 的定时器）。
   *
   * ## 取值约定：只有「合法毫秒时间戳」或 `null`，**永远不会是 `0`**
   *
   * 目前没有任何写入路径会产出 `0`。`null` 表示「从未整理」，而 `0` 在技术上
   * 是一个合法时刻（1970-01-01），两者语义不同。
   *
   * **这句话是给将来加「距上次整理多久」展示的人看的**：看到
   * `number | null` 很自然会写 `now - at`，若某天 `0` 从某条新路径冒出来，
   * 会显示成「20000 天前整理过」——而它其实只是「从未」。
   *
   * ## 为什么**不**把 `0` 当非法值拒掉
   *
   * 因为那会**用业务假设污染格式校验**。`0` 是合法的 Unix 时间戳；把它判为
   * 非法，等于在「格式层」写死「本系统的时刻不可能早于某个值」这条业务假设。
   * 将来真有人写 `0`（比如测试注入、或某种 epoch 语义），会被莫名其妙重置，
   * 而且**不会报错**。
   *
   * 格式层只该回答「这是不是一个合法的时间戳」，不该回答「这个时间戳
   * 有没有业务意义」。后者属于调用方的判断。
   */
  lastConsolidationAt: number | null
}

/** 空元信息：文件不存在或已损坏时返回它。 */
export const EMPTY_META: StoreMeta = Object.freeze({ v: META_VERSION, lastConsolidationAt: null })

/**
 * 元信息文件路径。
 *
 * @param dir - 数据目录。
 * @returns 绝对或相对路径，取决于传入的 `dir`。
 */
export function metaFilePath(dir: string): string {
  return join(dir, META_FILE_NAME)
}

/**
 * 把任意读到的值收敛成合法 `StoreMeta`。
 *
 * 任何不合法都**整体重置**而不是逐字段兜底：逐字段兜底会产出「一半是上次的、
 * 一半是默认的」这种没人能解释的状态，而这个值本身并不值得那样抢救。
 *
 * @param raw - 已 `JSON.parse` 的值，类型未知。
 * @returns 合法的元信息；无法识别时返回 {@link EMPTY_META}。
 */
function coerceMeta(raw: unknown): StoreMeta {
  if (typeof raw !== 'object' || raw === null) return EMPTY_META
  const record = raw as Record<string, unknown>
  // 版本不认识就重置：将来加了 v2 而这段代码还是 v1，读 v2 文件应当当作没有，
  // 而不是猜着解析。降级读未知格式，比没有数据更危险。
  if (record.v !== META_VERSION) return EMPTY_META
  const at = record.lastConsolidationAt
  if (at !== null && (typeof at !== 'number' || !Number.isFinite(at))) return EMPTY_META
  return { v: META_VERSION, lastConsolidationAt: at }
}

/**
 * 读取元信息。
 *
 * **不抛错**：文件不存在、不是合法 JSON、结构不认识，一律返回
 * {@link EMPTY_META}。理由见模块注释第 2 条。
 *
 * @param dir - 数据目录。
 * @returns 元信息；任何异常情况都返回空元信息。
 */
export function readMeta(dir: string): StoreMeta {
  let text: string
  try {
    text = readFileSync(metaFilePath(dir), 'utf8')
  } catch {
    // 文件不存在是最常见的情况（首次运行），不是错误。
    return EMPTY_META
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return EMPTY_META
  }
  return coerceMeta(parsed)
}

/**
 * 写入元信息（原子写，不 fsync）。
 *
 * 先写 `<file>.tmp` 再 `rename` 覆盖：`rename` 在同一文件系统内是原子的，
 * 所以读者要么看到旧内容，要么看到新内容，不会看到半截 JSON。
 *
 * 不 fsync 的理由见模块注释第 3 条。
 *
 * @param dir - 数据目录；不存在时自动创建。
 * @param meta - 要写入的元信息。
 */
export function writeMeta(dir: string, meta: StoreMeta): void {
  mkdirSync(dir, { recursive: true })
  const path = metaFilePath(dir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(meta)}\n`, 'utf8')
  // Windows 上 `renameSync` 覆盖已存在文件是允许的（底层 MoveFileEx 带
  // REPLACE_EXISTING），所以这里不需要先删目标文件——先删反而会制造一个
  // 「目标不存在」的窗口，把原子性毁掉。
  renameSync(tmp, path)
}

/**
 * 读上次巩固时刻。
 *
 * 比 {@link readMeta} 更窄的入口，供只需要这一个值的调用方使用。
 *
 * @param dir - 数据目录。
 * @returns 毫秒时间戳；从未整理或无法读取时为 `null`。
 */
export function readLastConsolidationAt(dir: string): number | null {
  return readMeta(dir).lastConsolidationAt
}

/**
 * 记下次巩固时刻。
 *
 * 内部是「读—改—写」：只覆盖 `lastConsolidationAt`，保留文件中其它字段
 * （当前只有 `v`，将来可能还有别的）。这样调用方不必先读一遍。
 *
 * @param dir - 数据目录。
 * @param at - 巩固时刻（毫秒时间戳）。
 */
export function writeLastConsolidationAt(dir: string, at: number): void {
  const current = readMeta(dir)
  writeMeta(dir, { ...current, lastConsolidationAt: at })
}
