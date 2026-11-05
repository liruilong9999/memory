import type { MemoryConfig } from '../core/config.ts'
import type { MemoryCard, MemoryEdge } from '../core/types.ts'

/* ------------------------------------------------------------------ *
 * 一、常量与类型
 * ------------------------------------------------------------------ */

/** 正常退出。 */
export const EXIT_OK = 0

/** 健康检查异常，或记忆库打不开。 */
export const EXIT_UNHEALTHY = 1

/** 用法错误：未知子命令、未知选项、选项缺值。 */
export const EXIT_USAGE = 2

/** 命令行名字，用于错误提示与用法文本。 */
export const CLI_NAME = 'memoryctl'

/**
 * 时区回退值：**只在前两步都拿不到时区时才用到**。
 *
 * 为什么 `--tz` 的默认值不是直接写死本常量（虽然需求规格的初稿就是这么写的）：
 * 宿主侧（`src/host/adapter.ts` 的 `resolveTimeZone`）解析的是**系统时区**。
 * CLI 与宿主读的是同一个库、同一批 `createdAt`/`dueAt`/`lastConsolidationAt`，
 * 一旦两边默认时区不同，「今天整理过没有」「距上次会话多久」就会算出两个答案——
 * 同一个库在终端里说「3 小时前」，在会话里说「昨天」。这种不一致极难排查，
 * 而且会在跨时区机器上稳定复现。
 *
 * 因此取值顺序固定为：
 * 1. 显式 `--tz <IANA>`（用户说了算，也便于复现 bug）；
 * 2. 系统时区（与宿主天然一致，这是绝大多数情况）；
 * 3. 本常量（仅在 `Intl` 拿不到系统时区时兜底，保证永远有一个可用值）。
 *
 * 想改回写死：只改 {@link resolveTimeZone} 的第一行，别删这三步。
 */
export const FALLBACK_TIME_ZONE = 'Asia/Shanghai'

/** 全部子命令，顺序即用法文本里的展示顺序。 */
export const COMMANDS = [
  'query', 'list', 'edges', 'export', 'import', 'rebuild', 'health', 'consolidate',
  'restore', 'revise', 'history', 'pin', 'unpin', 'logs', 'report', 'config', 'help',
] as const

/** 子命令名。 */
export type Command = (typeof COMMANDS)[number]

/**
 * 解析后的命令行参数。
 *
 * 所有字段都显式带上 `undefined` 而不是「可选属性」，这样调用方读
 * `options.dataDir` 时不必区分「没给」与「给空」两种状态。
 */
export interface CliOptions {
  /** 子命令。 */
  readonly command: Command
  /** 子命令之后的位置参数；`query` 用它拼关键词。 */
  readonly positionals: readonly string[]
  /** 数据目录；省略时取 `DEFAULT_CONFIG.storage.dataDir`。 */
  readonly dataDir: string | undefined
  /** 时区；省略时取系统时区。 */
  readonly timeZone: string | undefined
  /** 是否输出机器可读 JSON。 */
  readonly json: boolean
  /** 是否把结构化日志打到 stderr（FR-F1）。 */
  readonly verbose: boolean
  /** `export` 的输出文件；省略时写 stdout。 */
  readonly out: string | undefined
  /**
   * `import` 的输入文件（`--in`）。
   *
   * 与位置参数二选一，位置参数优先。两条路都留着是因为
   * `import backup.json` 是自然写法，而脚本里拼路径时 `--in` 更省心。
   */
  readonly input: string | undefined
  /** `export` 是否连归档卡一起导出。 */
  readonly includeArchived: boolean

  /**
   * `query` 的记忆域过滤（`work` / `study` / `life`）。
   *
   * 原样保留用户输入而不在这里校验取值：合法值由配置决定
   * （`extraction.domains` 可被 patch 扩展），CLI 侧硬编码白名单
   * 会在用户加了自定义域之后拒绝一个**实际有效**的值。
   */
  readonly domain: string | undefined
  /** `query` 的卡片类型过滤。 */
  readonly kind: string | undefined
  /** `query` 的标签过滤（必须包含该标签）。 */
  readonly tag: string | undefined
  /**
   * `query` 的起始时刻过滤，**保留用户原始写法**。
   *
   * 不在这里转成毫秒：`--since 2024-01-01` 的「那一天」由时区定义，
   * 而时区要到 `resolveTimeZone` 之后才知道，且 `--tz` 可能写在
   * `--since` 后面。在这里先按某个时区猜一次，等于给静默错误发通行证。
   */
  readonly since: string | undefined

  /** `revise` 的修正原因（FR-A5：要能回答「为什么改」）。 */
  readonly reason: string

  /** `logs` 读取条数上限；0 表示全部。 */
  readonly limit: number

  /** `report` 的统计窗口天数（FR-F3）。 */
  readonly days: number

  /** `config rollback --clear`：清除回滚覆盖层而不是建立它（FR-F4）。 */
  readonly clear: boolean
}

/** 参数解析结果。失败时只带一条人可读信息，不带异常。 */
export type ParseOutcome =
  | { readonly ok: true; readonly options: CliOptions }
  | { readonly ok: false; readonly message: string }

/** 一次 CLI 调用的结果。 */
export interface CliResult {
  /** 进程退出码。 */
  readonly code: number
  /** 标准输出文本（含结尾换行；空串表示不输出）。 */
  readonly stdout: string
  /** 标准错误文本（含结尾换行；空串表示不输出）。 */
  readonly stderr: string
}

/** 注入点：让单测可以固定时钟，跑出确定性结果。 */
export interface CliIo {
  /** 当前时刻（毫秒）；省略时取 `Date.now`。 */
  now?: () => number
  /**
   * patch 文件路径；省略时取本包自带的 `cordis.patch.yml`。
   *
   * 之所以要能注入：单测必须能验证「配置来源不同 ⇒ 结果不同」这个事实，
   * 而不是依赖仓库里那个文件的当前内容（那会把测试绑在别人的编辑上）。
   */
  configPath?: string
}

/** 导出文档：`export` 子命令的 JSON 结构。 */
export interface ExportDocument {
  /** 导出格式版本，复用数据面的 {@link EXPORT_FORMAT_VERSION}。 */
  formatVersion: number
  /** 导出时刻（毫秒时间戳）。 */
  exportedAt: number
  /** 数据目录绝对路径，便于人确认「导的是哪个库」。 */
  dataDir: string
  /** 计数。 */
  counts: {
    /** 活跃卡数（与导出范围无关，始终是全库真实计数）。 */
    active: number
    /** 归档卡数。 */
    archived: number
    /** 图谱边数。 */
    edges: number
    /** 本次实际导出的卡数。 */
    exported: number
  }
  /** 导出的卡片，按 id 升序（保证同一状态导出结果可 diff，ST-8）。 */
  cards: MemoryCard[]
  /** 导出的图谱边，按 id 升序。 */
  edges: MemoryEdge[]
}

/**
 * CLI 实际使用的配置**解析结果**。
 *
 * 关键点：这个类型存在的理由是「让配置来源成为可报告的事实」。
 * 曾经 CLI 写死 `DEFAULT_CONFIG`，而宿主读 patch，两者在 `spread.mode` 上
 * 分别是 `shadow` / `on`——同一个库、同一个查询，终端与会话报出不同分数
 * （实测 3/3 查询不一致）。CLI 的存在意义就是「让我看看记忆库现在是什么样」，
 * 它报的却不是模型看到的，那它比没有更糟：**一个说错的观测点比没有观测点
 * 更危险，因为人会信它。**
 */
export interface ResolvedCliConfig {
  /** 实际生效的配置（已校验；校验失败时退回 `DEFAULT_CONFIG`）。 */
  readonly config: MemoryConfig
  /**
   * 回滚基准：「默认值 + patch」的合并结果，**未校验、不含回滚层**。
   *
   * 为什么不能用 `config` 当基准（这是一个真实缺陷的根因）：
   * patch 被改坏时 `config` 退回了 `DEFAULT_CONFIG`，于是「当前值」
   * 看起来是合法的 0.18，与目标快照无差异 ⇒ 回滚什么也不写，
   * 而 patch 里的 `-5` 原封不动 ⇒ 下次启动**仍然崩溃**。
   * 用户看到「已回滚」，实际上什么都没被修。
   *
   * 正确的基准是「假如没有覆盖层，宿主会拿到什么」——
   * 回滚就是把它修成目标快照，差异里自然包含那个坏掉的叶子。
   */
  readonly baseline: MemoryConfig
  /**
   * 本次要操作的数据目录（已考虑 `--data-dir`）。
   *
   * ## 为什么不能直接用 `config.storage.dataDir`（真缺陷十六）
   *
   * 配置坏掉时 `config` 已经退回 `DEFAULT_CONFIG`，而 `DEFAULT_CONFIG` 里的
   * `storage.dataDir` 是**库默认路径**。于是探针实测到这一幕：
   *
   * ```text
   * 用户库（patch 指定）里有 3 张卡
   * patch 写成 absoluteThreshold: -5
   * memoryctl health
   *   → 数据目录报成了另一个目录（默认 .dsh-memory）
   *   → 活跃：0 张
   * ```
   *
   * 用户看到的不是「配置坏了」，而是「我那 3 条记忆丢了」——
   * 而它们好端端地在另一个目录里。**看错库比报错库更危险。**
   *
   * 正解是从 `baseline`（默认值 + patch、**未校验**）取目录：那才是
   * 「假如没有校验失败，宿主会用哪个目录」。与 `baseline` 同源，
   * 不另开一条推导链。
   */
  readonly dataDir: string
  /** 配置来自哪里，供 `health` 与人读输出显示。 */
  readonly source: string
  /**
   * 本次配置是否**降级**过（读不到 patch 或校验失败退回默认值）。
   *
   * 降级的配置不能记进快照台账：它不是用户意图，
   * 记下去会在需要回滚的那一刻成为最新的「回滚点」。
   */
  readonly degraded: boolean
  /** 解析过程中的提醒（例如 patch 缺失后退回默认值）。 */
  readonly notes: readonly string[]
}
