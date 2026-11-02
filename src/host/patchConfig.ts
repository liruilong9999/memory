/**
 * 读取 `cordis.patch.yml` 里的 `config:` 块，供**离线 CLI** 与宿主共用同一份配置。
 *
 * ## 为什么需要这个文件（真缺陷九）
 *
 * `src/cli/memoryctl.ts` 曾写死 `const CLI_CONFIG = DEFAULT_CONFIG`，而
 * `DEFAULT_CONFIG.spread.mode` 是 `'shadow'`；宿主走 `resolveConfig` 读 patch，
 * 拿到的是 `'on'`。于是**同一个库、同一个查询**，终端与会话报出不同的分数：
 *
 * ```text
 * Redis 缓存   宿主 0.5328,0.5313,0.5155,0.4155
 *              CLI  0.5313,0.5155,0.4128,0.2955
 * ```
 *
 * 实测 3 个查询**全部**不一致。而 CLI 的存在意义正是「让我看看记忆库现在
 * 是什么样」——它报的却不是模型实际看到的。这与真缺陷八同类：
 * **同一件事有两个真相源，且没有一个说明自己是哪一个。**
 *
 * ## 为什么放在 host 层
 *
 * 读宿主的配置文件属于「知道宿主长什么样」，归适配面（C8：宿主升级只改
 * 适配层）。`core/` 必须保持无 IO（硬性约定 7），所以解析器虽然纯，
 * 也只能放在这里；CLI 已经 import `host/engine.ts`，依赖方向不变。
 *
 * ## 为什么手写解析而不引 YAML 库
 *
 * 零依赖原则（CLI 的全部理由之一就是「不需要拉起任何东西」）。这里只需要
 * 「缩进层级 + 键值 + 标量」三件事，一个 60 行的循环比任何库都直白、都可测。
 *
 * ## 刻意**模拟** YAML 1.1 的标量语义
 *
 * 这不是多余的小心：无引号的 `on` / `off` / `yes` / `no` 在 YAML 1.1 里是
 * **布尔值**。用户在 patch 里写 `mode: on`（很自然的写法），宿主拿到 `true`，
 * `validateConfig` 拒绝，插件**加载期失败**。如果这个解析器把裸 `on` 当字符串
 * 放过去，CLI 会「正常工作」而宿主会崩——**CLI 替一个照抄就崩的写法背书**，
 * 这比两边都崩更糟。所以这里必须复现宿主的判定，让用户在终端就能看见问题。
 *
 * 同理，未加引号且含冒号的值（`dailyAt: 03:30`）在 YAML 1.1 里是**六十进制数**
 * （`03:30` → 210）。这里不模拟那个转换，而是直接判为非法并提示加引号：
 * 与其猜一个没人预期的数字，不如让人把引号补上。
 *
 * @module dsh-memory/host/patchConfig
 */

import { readFileSync } from 'node:fs'

/** 解析结果。失败时只带一条人可读原因，不带异常。 */
export type PatchConfigOutcome =
  | { readonly ok: true; readonly config: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string }

/**
 * 把 YAML 标量文本转成 JS 值，**模拟 YAML 1.1 的隐式类型**。
 *
 * @param raw - 已去掉行内注释的标量文本。
 * @returns 转换后的值；无法判定为布尔/数字时保留字符串。
 */
function parseScalar(raw: string): unknown {
  const text = raw.trim()
  if (text.length === 0) return ''
  const quoted = /^'(.*)'$/su.exec(text) ?? /^"(.*)"$/su.exec(text)
  if (quoted !== null) return quoted[1] ?? ''
  // YAML 1.1 的布尔字面量。`on`/`off`/`yes`/`no` 在这里是布尔，不是字符串——
  // 这就是 `spread.mode: on` 会崩的原因，必须原样复现。
  if (/^(?:true|yes|on)$/iu.test(text)) return true
  if (/^(?:false|no|off)$/iu.test(text)) return false
  if (/^(?:null|~)$/iu.test(text)) return null
  // 未加引号且含冒号：YAML 1.1 会当六十进制数处理（`03:30` → 210）。
  // 不猜那个数字，直接让调用方报错并提示加引号。
  if (text.includes(':')) return { __ambiguous: text }
  if (/^[-+]?\d+$/u.test(text)) return Number(text)
  if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/u.test(text)) return Number(text)
  return text
}

/**
 * 剥掉行内注释。
 *
 * 只处理「空白 + `#`」开头的注释；引号内的 `#` 必须保留，否则
 * `mode: 'o#n'` 会被截断成 `'o`，解析出一个不存在的值。
 *
 * @param line - 原始行。
 * @returns 去掉注释后的行。
 */
function stripComment(line: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/u.test(line[i - 1] ?? ''))) {
      return line.slice(0, i)
    }
  }
  return line
}

/** 一行有效内容：缩进 + 键 + 值（值可能为空，表示下面是嵌套块）。 */
interface PatchLine {
  readonly indent: number
  readonly key: string
  readonly value: string | undefined
  /** 原文件行号（1 起），用于报错定位。 */
  readonly lineNo: number
}

/**
 * 把一行拆成「缩进 / 键 / 值」，并处理 YAML 的列表项前缀 `- `。
 *
 * 为什么必须支持 `- `：本插件的 patch 里 `config:` 是普通键
 * （`      config:`），但同一份文件里 `insert:` 下面是列表项
 * （`    - id: memory`）。两种写法在 YAML 里都是合法的，而一个只认普通键的
 * 解析器会在用户把 `config:` 挪进列表项时**静默找不到配置**——
 * 那是本仓库反复吃亏的「静默降级」。这里统一处理：
 * `- ` 前缀视为「多缩进 2 格」，于是 `- config:` 与
 * `  config:` 在层级上等价。
 *
 * @param line - 原始行（已去注释）。
 * @param lineNo - 行号，1 起。
 * @returns 拆解结果；不是合法键值行时返回 `reason`。
 */
function splitLine(line: string, lineNo: number): PatchLine | { reason: string } {
  const indent = line.length - line.trimStart().length
  let body = line.trim()
  let extraIndent = 0
  if (body === '-' || body.startsWith('- ')) {
    extraIndent = 2
    body = body === '-' ? '' : body.slice(2).trim()
    if (body.length === 0) return { reason: `第 ${lineNo} 行：列表项后面没有内容` }
  }
  const colon = body.indexOf(':')
  if (colon < 0) return { reason: `第 ${lineNo} 行：不是合法的「键: 值」` }
  const key = body.slice(0, colon).trim()
  if (key.length === 0) return { reason: `第 ${lineNo} 行：缺少键名` }
  const rest = body.slice(colon + 1).trim()
  return {
    indent: indent + extraIndent,
    key,
    value: rest.length === 0 ? undefined : rest,
    lineNo,
  }
}

/**
 * 从 patch 全文里取出 `config:` 块的原始行。
 *
 * 只认「`config:` 单独成行」这一种形态——本插件的 patch 就是这么写的，
 * 而 `config: {...}` 行内映射会让缩进层级失去意义，宁可明确报错。
 *
 * @param text - patch 全文。
 * @returns `config:` 的直接子行（缩进已归一化）+ 其缩进值。
 */
function sliceConfigBlock(text: string): { lines: PatchLine[]; indent: number } | { reason: string } {
  const rawLines = text.split(/\r?\n/u)
  let configIndent = -1
  let configLineNo = -1
  for (let i = 0; i < rawLines.length; i += 1) {
    const stripped = stripComment(rawLines[i] ?? '')
    if (stripped.trim().length === 0) continue
    const split = splitLine(stripped, i + 1)
    if ('reason' in split) continue
    if (split.key !== 'config') continue
    if (split.value !== undefined) {
      return { reason: `第 ${i + 1} 行：config 必须单独成行，不支持行内映射` }
    }
    configIndent = split.indent
    configLineNo = i + 1
    break
  }
  if (configIndent < 0) return { reason: 'patch 里没有 config: 段' }

  const lines: PatchLine[] = []
  for (let i = configLineNo; i < rawLines.length; i += 1) {
    const stripped = stripComment(rawLines[i] ?? '')
    if (stripped.trim().length === 0) continue
    const split = splitLine(stripped, i + 1)
    if ('reason' in split) return { reason: split.reason }
    // 缩进回到 config 同级或更浅 ⇒ 该段结束（兄弟键，如 `name:` / `id:`）
    if (split.indent <= configIndent) break
    lines.push(split)
  }
  if (lines.length === 0) return { reason: 'config: 段是空的' }
  return { lines, indent: configIndent }
}

/**
 * 把归一化后的行还原成嵌套对象。
 *
 * 递归下降：每层只吃「缩进 > 父层」的行，遇到缩进回落就交还给上层。
 *
 * @param lines - 全部行。
 * @param start - 起始下标。
 * @param parentIndent - 父层缩进；本层所有行的缩进必须大于它。
 * @returns 解析出的对象与下一个未消费的下标。
 */
function parseBlock(
  lines: readonly PatchLine[], start: number, parentIndent: number,
): { value: Record<string, unknown>; next: number } | { reason: string } {
  const out: Record<string, unknown> = {}
  let i = start
  let childIndent = -1
  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined) break
    if (line.indent <= parentIndent) break
    if (childIndent < 0) childIndent = line.indent
    if (line.indent !== childIndent) {
      return { reason: `第 ${line.lineNo} 行：缩进不一致（同级键必须对齐）` }
    }
    if (Object.hasOwn(out, line.key)) {
      return { reason: `第 ${line.lineNo} 行：重复的键「${line.key}」` }
    }
    if (line.value === undefined) {
      const nested = parseBlock(lines, i + 1, line.indent)
      if ('reason' in nested) return nested
      if (Object.keys(nested.value).length === 0) {
        return { reason: `第 ${line.lineNo} 行：「${line.key}」下面没有任何键` }
      }
      out[line.key] = nested.value
      i = nested.next
      continue
    }
    const scalar = parseScalar(line.value)
    if (typeof scalar === 'object' && scalar !== null && '__ambiguous' in scalar) {
      return {
        reason: `第 ${line.lineNo} 行：「${line.key}」的值含冒号且未加引号，`
          + 'YAML 会把它当六十进制数解析，请加引号（如 \'03:30\'）',
      }
    }
    out[line.key] = scalar
    i += 1
  }
  return { value: out, next: i }
}

/**
 * 解析 patch 文本，取出 `config:` 段。
 *
 * @param text - patch 文件全文。
 * @returns 解析结果；失败时给出带行号的中文原因。
 */
export function parsePatchConfig(text: string): PatchConfigOutcome {
  const block = sliceConfigBlock(text)
  if ('reason' in block) return { ok: false, reason: block.reason }
  const parsed = parseBlock(block.lines, 0, block.indent)
  if ('reason' in parsed) return { ok: false, reason: parsed.reason }
  return { ok: true, config: parsed.value }
}

/**
 * 读取并解析一个 patch 文件。
 *
 * @param path - patch 文件路径。
 * @returns 解析结果；读不到文件时也走 `ok: false`，由调用方决定怎么报。
 */
export function loadPatchConfig(path: string): PatchConfigOutcome {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, reason: `读不到 patch 文件：${path}` }
  }
  return parsePatchConfig(text)
}
