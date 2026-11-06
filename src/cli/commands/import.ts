/**
 * `import` 子命令：把导出文件读回记忆库。
 *
 * ## 为什么这个子命令必须存在（真缺陷三十六）
 *
 * `export` 早就存在，`importJsonl` / `validateImport` 也早就实现并导出，
 * 但 `COMMANDS` 里没有 `import`，`src/` 里零调用方。于是「换机器、换 profile、
 * 误删之后」这条路径是断的：数据只能导出、不能导回，导出的备份**不是备份**，
 * 只是快照。
 *
 * ## 为什么不能「只加个子命令」
 *
 * 加之前先探针验了一次（`.tmp/probe-import-gap.ts`），结果否掉了最直觉的做法：
 *
 * | 输入 | 喂给 `importJsonl` 的结果 |
 * |---|---|
 * | `export --out` 的产物（1602 字节 / 71 行，首行 `{`） | **0 张卡，70 行跳过，header null** |
 * | `exportJsonl` 的产物（对照组） | 2 张卡，0 行跳过 |
 *
 * 两种格式：`--out` 写的是**一个缩进过的 JSON 文档**（`ExportDocument`），
 * `importJsonl` 认的是**逐行 JSONL**（每行 `kind: header|card|edge`）。
 * 只加子命令的话，用户导入自己刚导出的文件会看到「导入成功」，而库里
 * **一条都没进**——静默数据丢失，比没有这个子命令更坏。
 *
 * 对照组是这组数字有意义的前提：0 张卡只有在「同一函数、同样的调用方式、
 * 换一份输入就能进 2 张」时，才能说明问题出在格式上，而不是 `importJsonl`
 * 本身坏了。
 *
 * ## 修法：让**消费端**认两种格式，而不是改 `--out` 的输出格式
 *
 * 改 `--out` 是另一条路，但 `ExportDocument.counts` 里有三个 JSONL 头部
 * 装不下的真实计数（`active` / `archived` / `exported` 互不相等），
 * 且 CLI 的 `export` 输出形状已被测试与文档锁住。兼容旧文件本来就要求
 * 消费端宽容，所以把宽容放在读侧。
 *
 * @module dsh-memory/cli/commands/import
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseExportFile, validateImport } from '../../store/export.ts'
import type { MemoryStore } from '../../store/store.ts'
import { byId, describeError, jsonText, storeFailure, usageFailure } from '../output.ts'
import { EXIT_OK } from '../types.ts'
import type { CliOptions, CliResult } from '../types.ts'
import type { WriteResult } from '../../store/store.ts'

/**
 * 决定从哪个文件读。
 *
 * 位置参数优先、`--in` 兜底：`import backup.json` 是最自然的写法，
 * 而 `--in` 让「脚本里拼路径」不必操心位置参数的次序。
 * 两者都给且不同时报错而不是选一个——静默选一个等于让另一处白写。
 *
 * @param options - 解析后的参数。
 * @returns 目标路径；缺失或不一致时给出错误信息。
 */
function resolveInputPath(options: CliOptions): { ok: true; path: string } | { ok: false; message: string } {
  const positional = options.positionals[0]
  const fromFlag = options.input
  if (positional !== undefined && fromFlag !== undefined && positional !== fromFlag) {
    return {
      ok: false,
      message: `import 的文件给了两处且不一致：「${positional}」与 --in「${fromFlag}」，请只保留一处`,
    }
  }
  const path = positional ?? fromFlag
  if (path === undefined) {
    return { ok: false, message: 'import 需要一个文件，例如：memoryctl import backup.json' }
  }
  return { ok: true, path }
}

/**
 * 把「写到一半抛错」翻译成用户能据以行动的一段话。
 *
 * ## 为什么这里不能只报 `describeError(error)`
 *
 * 数据面没有事务：`putCard` 逐条 `append` 到事件日志，一条落盘就是一条，
 * **前面写进去的不会因为后面抛错而撤销**。所以异常冒泡时，库处于
 * 「导入了一部分」的状态，而用户从一段堆栈里读不出这件事——他会以为
 * 要么全进了、要么一条没进，两种猜测都是错的。
 *
 * 这一段的作用是**把不可回滚的半截状态说清楚**，而不是假装能回滚：
 * 告诉他写到第几条、已经进了多少、重跑是否安全。
 *
 * @param path - 导入文件路径。
 * @param position - 出错时正在写的那一条。
 * @param counts - 各计数（已写入 / 已跳过）。
 * @param error - 捕获到的异常。
 * @returns 人可读的错误说明。
 */
function describePartialWrite(
  path: string,
  position: { kind: string; id: string },
  counts: { cardsWritten: number; cardsSkipped: number; edgesWritten: number; edgesSkipped: number },
  error: unknown,
): string {
  return `导入 ${path} 时写入失败：${position.kind} ${position.id}\n`
    + `  原因：${describeError(error)}\n`
    + `  已写入：卡片 ${counts.cardsWritten} 张 / 图谱边 ${counts.edgesWritten} 条`
    + `（另有卡片 ${counts.cardsSkipped} 张、图谱边 ${counts.edgesSkipped} 条按幂等跳过）\n`
    // 说「重跑安全」是因为幂等键：同样的内容再导一次会被判为重复而跳过，
    // 不会产生第二份。这句必须写，否则用户不知道下一步该做什么。
    + '注意：库现在是「导入了一部分」的状态。修好文件后重跑本命令即可补齐，'
    + '重复写入会按幂等跳过，不会写重。'
}

/**
 * `import` 子命令（FR-A6 的入口侧，补齐导出闭环）。
 *
 * 流程固定：读文件 → 识别格式 → 预检 → 逐条写入 → 报计数。
 * 预检在写入**之前**：一条边指向不存在的卡时，先写卡再报错会留下半截状态，
 * 而用户看到的是一行错误、以为什么都没发生。
 *
 * @param options - 解析后的参数。
 * @param store - 记忆库。
 * @returns 命令结果。
 */
export function runImport(options: CliOptions, store: MemoryStore): CliResult {
  const target = resolveInputPath(options)
  if (!target.ok) return usageFailure(target.message)
  const path = resolve(target.path)

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // 读不到文件是用法问题（路径写错），不是「库坏了」，所以退出码 2 而非 1。
    return usageFailure(`读不到导入文件 ${path}：${describeError(error)}`)
  }

  const parsed = parseExportFile(text)
  if (!parsed.ok) {
    // 这里**必须**报错而不是「导入了 0 条，成功」：用户会以为备份回来了。
    return usageFailure(`无法导入 ${path}：${parsed.message}`)
  }
  const result = parsed.result

  // 「一行都没认出来」必须当错误报，不能当「导入成功 0 条」。
  //
  // 这是这个子命令最容易走到的坑：`parseExportFile` 对**任何**不以 `{` 开头的
  // 文本都会走 JSONL 分支，而 JSONL 分支的容错语义是「坏行计数、好行照收」。
  // 于是 `memoryctl import 一份 CSV` 会得到 `cards: []`、`skipped: 37`，
  // 而 `validateImport([])` 无错可报 ⇒ 一路走到「已导入 0 张卡片」并退出 0。
  // 用户看到的是一句成功。**这比报错坏得多**：他会以为备份已经恢复。
  //
  // 判据刻意选「零条可用且确有坏行」，而不是「零条可用」：一份正常的空库
  // 导出（`{"cards":[],"edges":[]}`）本来就该导入成功，报错会让「清空后
  // 恢复成空库」这个合法动作无法完成。
  if (result.cards.length === 0 && result.edges.length === 0 && result.skipped > 0) {
    return usageFailure(
      `无法导入 ${path}：文件里 ${result.skipped} 行一条都认不出来，这不像本程序导出的文件`,
    )
  }

  const knownIds = new Set(store.listCards({}).map((card) => card.id))
  const problems = validateImport(result, knownIds)
  if (problems.length > 0) {
    // 只报前 5 条：坏文件可能有上千条错误，全打印会淹掉真正的结论，
    // 但条数必须如实给出——「还有 995 条」和「只有这 5 条」是两回事。
    const head = problems.slice(0, 5).map((line) => `- ${line}`).join('\n')
    const rest = problems.length > 5 ? `\n……另有 ${problems.length - 5} 条同类问题` : ''
    return storeFailure(`导入文件未通过预检（共 ${problems.length} 条）：\n${head}${rest}`)
  }

  // 卡片按 id 升序写入：写入顺序影响事件日志的序号，固定顺序让「同样的导入
  // 得到同样的日志」成立（ST-1），否则同一个文件导两次会得到可 diff 的日志。
  let cardsWritten = 0
  let cardsSkipped = 0
  const unreadable: string[] = []
  for (const card of [...result.cards].sort(byId)) {
    // 写入这一步也要包住：预检已经把「结构非法」挡在外面，但预检是**判据**，
    // 不是**隔离**——数据面在写入路径上还可能因为别的原因抛（并发写者、
    // 磁盘错误、日志损坏）。此时前面的卡已经落盘且不可回滚，异常若直接冒泡，
    // 用户拿到的是堆栈而不是「已经写进去多少」（缺陷 W8 的形态）。
    let written: WriteResult
    try {
      written = store.putCard(card)
    } catch (error) {
      return storeFailure(describePartialWrite(
        path,
        { kind: '卡片', id: card.id },
        { cardsWritten, cardsSkipped, edgesWritten: 0, edgesSkipped: 0 },
        error,
      ))
    }
    if (written.written) cardsWritten += 1
    else cardsSkipped += 1
    // 写完之后**回读**一次，确认它真的在库里。
    //
    // `putCard` 的 `written: true` 只表示「日志追加成功」，不表示「卡片进了状态」：
    // 重放层 `coerceCard` 会对结构非法的卡返回 `null`（缺 `source`、缺 `id` 等），
    // 于是记录落了盘、状态里却没有这张卡。只按 `written` 计数的话，
    // 这种情况会被报成「写入 N 张」，而库里一张都没多——
    // 正是这个子命令存在的意义（把备份导回来）被静默破坏的形态。
    if (store.getCard(card.id) === undefined) unreadable.push(card.id)
  }
  // 边必须**在卡之后**写：边的两端要先存在，否则 `edgesOf` 会短暂返回悬空边。
  let edgesWritten = 0
  let edgesSkipped = 0
  for (const edge of [...result.edges].sort(byId)) {
    let written: WriteResult
    try {
      written = store.putEdge(edge)
    } catch (error) {
      return storeFailure(describePartialWrite(
        path,
        { kind: '图谱边', id: edge.id },
        { cardsWritten, cardsSkipped, edgesWritten, edgesSkipped },
        error,
      ))
    }
    if (written.written) edgesWritten += 1
    else edgesSkipped += 1
  }
  if (unreadable.length > 0) {
    // 报错而不是只报计数：这是**数据面拒收**，不是幂等跳过。
    // 若只打印一行「N 张写入」，用户会以为备份回来了，而实际缺了这些卡。
    //
    // 必须同时说明「已经写进去的那部分」：检测只能在写之后做（判据是
    // `coerceCard` 的返回值，而它在数据面内部，CLI 复制一份就是第二个真相源）。
    // 既然拦不住半截状态，就把半截状态如实说清楚，让用户知道下一步该重跑还是该修文件。
    const head = unreadable.slice(0, 5).join('、')
    const rest = unreadable.length > 5 ? ` 等 ${unreadable.length} 张` : ''
    return storeFailure(
      `有 ${unreadable.length} 张卡写入后读不回来（结构非法，数据面拒收）：${head}${rest}\n`
      + `注意：另有 ${cardsWritten} 张已成功写入，库现在是「导入了一部分」的状态；`
      + '修好文件后重跑本命令即可补齐（重复写入按幂等跳过）',
    )
  }

  const summary = {
    in: path,
    format: parsed.format,
    cards: { read: result.cards.length, written: cardsWritten, skipped: cardsSkipped },
    edges: { read: result.edges.length, written: edgesWritten, skipped: edgesSkipped },
    // 坏行数单独报：它是**文件本身**的问题，与「幂等跳过」完全不同。
    // 合成一个数字会让「文件被手改坏了」看起来像「数据已经在库里了」。
    malformed: result.skipped,
  }
  if (options.json) return { code: EXIT_OK, stdout: jsonText(summary), stderr: '' }

  const lines = [
    `已从 ${path} 导入（格式 ${parsed.format === 'document' ? '导出文档' : 'JSONL'}）：`,
    `  卡片 ${cardsWritten} 张写入 / ${cardsSkipped} 张已存在（幂等跳过）/ 文件内共 ${result.cards.length} 张`,
    `  图谱边 ${edgesWritten} 条写入 / ${edgesSkipped} 条已存在 / 文件内共 ${result.edges.length} 条`,
  ]
  if (result.skipped > 0) {
    lines.push(`  另有 ${result.skipped} 行无法识别（既不是卡片也不是边），已跳过`)
  }
  return { code: EXIT_OK, stdout: `${lines.join('\n')}\n`, stderr: '' }
}
