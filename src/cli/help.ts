import { DEFAULT_CONFIG } from '../core/config.ts'
import { CLI_NAME, FALLBACK_TIME_ZONE } from './types.ts'

/* ------------------------------------------------------------------ *
 * 四、用法文本
 * ------------------------------------------------------------------ */

/**
 * 生成中文用法说明。
 *
 * 默认数据目录从 {@link DEFAULT_CONFIG} 取，不在文本里另写一份字面量——
 * 否则改了默认值而忘了改帮助文本，用户会看到过期说明。
 *
 * @returns 用法文本（含结尾换行）。
 */
export function helpText(): string {
  const defaultDataDir = DEFAULT_CONFIG.storage.dataDir
  const lines = [
    'dsh-memory 离线命令行：不启动宿主也能查、导、重建记忆库',
    '',
    '用法：',
    `  ${CLI_NAME} <子命令> [参数] [选项]`,
    '',
    '子命令：',
    '  query <关键词>            召回并打印焦点包与分数构成（与 /memory explain 同格式）',
    '  export [--out <路径>]     导出全部记忆卡与图谱边为 JSON（默认写 stdout）',
    '  import <文件>             把导出文件读回记忆库（认导出文档与 JSONL 两种格式）',
    '  rebuild                   从事件日志重建索引，打印扫描记录数与活跃卡数',
    '  health                    健康检查；索引不一致时退出码为 1',
    '  consolidate               手动执行一次夜整理（去重、合并、降权、归档）',
    '  restore <id>              把一张归档卡恢复成活跃（FR-C2：归档必须可逆）',
    '  revise <id> <新正文>      修正卡片正文并保留旧版本（FR-A5：可查改过什么）',
    '  history <id>              查一张卡改过什么、为什么（FR-A5：每条的旧正文与原因）',
    '  logs                      读回落盘的诊断日志（FR-F1：最近 N 次操作可回溯）',
    '  report                    最小周报（FR-F3：召回次数/命中率/冲突数/库大小/注入 token）',
    '  config list               列出配置快照台账（FR-F4：哪些配置生效过）',
    '  config diff               报当前配置与上一条快照的叶子级差异（P7：改动可追溯）',
    '  config rollback <id>      把配置拉回某一份快照（FR-F4：改坏能一键回滚）',
    '  help                      显示本帮助（等同 -h / --help / 无参数）',
    '',
    '全局选项：',
    `  --data-dir <路径>         数据目录，默认 ${defaultDataDir}`,
    `  --tz <IANA>               时区，默认取系统时区（解析失败退回 ${FALLBACK_TIME_ZONE}）`,
    '  --json                    输出机器可读 JSON 而非人读文本',
    '  --verbose                 把结构化日志（FR-F1）打到 stderr',
    '  -h, --help                显示本帮助',
    '',
    'export 专用选项：',
    '  --out <路径>              写入文件而不是 stdout（父目录不存在时自动创建）',
    '  --include-archived        连归档卡一起导出',
    '',
    'import 专用选项：',
    '  --in <路径>               输入文件；也可以直接写位置参数（import backup.json）',
    '',
    'query 专用选项（过滤候选池，不影响打分公式）：',
    '  --domain <域>             只在该记忆域内召回（内置 work / study / life）',
    '  --kind <类型>             只召回该类型的卡（event / fact / promise / concept / feeling / experience / summary）',
    '  --tag <标签>              只召回带该标签的卡',
    '  --since <日期>            只召回该时刻之后创建的卡；写 2024-03-01 或 2024-03-01T09:30',
    '                            日期按 --tz 的时区解释，纯数字按毫秒时间戳直取',
    '',
    'revise 专用选项：',
    '  --reason <原因>           写进修正历史，供日后回答「为什么改」（默认空）',
    '',
    'logs 专用选项：',
    '  --limit <条数>            只读最后 N 条，默认 50，0 表示全部',
    '  --days <天数>             report 的统计窗口，默认 7',
    '',
    'config 专用选项：',
    '  --clear                   清除回滚覆盖层，让 patch 重新生效',
    '',
    '退出码：',
    '  0  正常',
    '  1  健康检查异常，或记忆库打不开，或卡片不存在',
    '  2  用法错误（未知子命令、未知选项、选项缺值、缺关键词、卡片前缀有歧义）',
    '',
    '说明：',
    '  query 与 export 都是只读的：不改访问计数、不改强度、不写事件日志，',
    '  反复查询不会让某几张卡越来越容易被召回。需要「使用并强化」时由宿主侧',
    '  显式确认（该能力在实现中）。',
    '  restore / revise / history 的 <id> 可以写完整 id，也可以写人读输出里',
    '  印的前缀（query、/memory explain 的「卡片 id」那一行）；前缀撞上多张卡时',
    '  会报「匹配到 N 张，请给更长前缀」并列出全部候选，不会随便挑一张。',
    '',
    '示例：',
    `  ${CLI_NAME} health`,
    `  ${CLI_NAME} query "部署" --data-dir ./data`,
    `  ${CLI_NAME} export --include-archived --out backup.json`,
    `  ${CLI_NAME} import backup.json`,
    `  ${CLI_NAME} query "部署" --domain work --since 2024-03-01`,
    `  ${CLI_NAME} restore 1a2b3c4d`,
    `  ${CLI_NAME} revise 1a2b3c4d "改用 PostgreSQL" --reason 决策变更`,
    `  ${CLI_NAME} history 1a2b3c4d`,
    `  ${CLI_NAME} consolidate --json --verbose`,
  ]
  return `${lines.join('\n')}\n`
}
