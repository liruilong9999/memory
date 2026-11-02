/**
 * `cordis.patch.yml` 的配置契约。
 *
 * ## 为什么这个文件需要测试
 *
 * 它是**用户唯一会看到、也唯一会改**的东西：装好插件后行为由它决定。
 * 而它此前完全裸奔——没有任何测试读过它，改错了（拼错键名、写成
 * 不存在的模式、把 `spread` 段写到错误缩进下）不会有任何东西变红。
 *
 * 更糟的是，YAML 拼错**不报错**：写 `mode: on`（不加引号）在 YAML 1.1
 * 里是布尔 `true`，`validateConfig` 会拒绝，但插件是加载期失败；
 * 写 `spred:`（拼错）则整段被忽略、静默退回默认 `shadow`，
 * **用户以为打开了突触效果，实际什么都没发生**——正是本仓库反复吃亏的
 * 「静默降级」那一类。
 *
 * ## 这里守的是什么
 *
 * 1. `spread.mode` 在 patch 里**存在**，且是三种合法值之一；
 * 2. 它的值是 `'on'`——这是发布意图（用户明确要「类似神经的突触效果」）；
 * 3. 它与 `DEFAULT_CONFIG` 的默认值**不同**，且注释说明了为什么不同；
 *    两者相等时这条测试会红，提醒同步更新注释（否则注释会替实现撒谎）。
 *
 * 不守什么：不验宿主是否真的加载了这个文件（那要宿主实机，见 AGENTS.md §八）。
 * 本文件不假装验了它。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_CONFIG, type SpreadMode } from '../../src/core/config.ts'

const PATCH_PATH = new URL('../../cordis.patch.yml', import.meta.url)
const RAW = readFileSync(PATCH_PATH, 'utf8')

/**
 * 从 patch 文本里取出 `spread:` 段下的 `mode` 值。
 *
 * 为什么手写而不引 YAML 库：项目没有 YAML 依赖，为一个测试引入解析器
 * 会给运行时加依赖。这里只需要「缩进层级 + 键值」两件事，手写足够；
 * 取不到时返回 `undefined`，由调用方断言失败——**不猜**（信条 5）。
 *
 * @param text - patch 文件全文。
 * @returns 找到的 mode 字符串（已去引号），找不到为 undefined。
 */
function extractSpreadMode(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*spread:\s*$/.test(l))
  if (start === -1) return undefined
  const baseIndent = (lines[start] ?? '').length - (lines[start] ?? '').trimStart().length
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    // 缩进回到 spread 同级或更浅 ⇒ 该段结束
    if (indent <= baseIndent) break
    const m = /^mode:\s*(.+)$/.exec(trimmed)
    if (m !== null) {
      const raw = (m[1] ?? '').trim()
      // 无引号的 `on` / `off` / `yes` / `no` 在 YAML 1.1 里是**布尔值**，
      // 不是字符串。宿主用 YAML 解析器读这个文件，它拿到的会是 `true`，
      // 而 `validateConfig` 期望的是字符串 'on' ⇒ 加载期就失败。
      // 所以这里必须模拟 YAML 语义，不能把裸 on 当成字符串 'on' 放过去：
      // 否则测试会替一个「用户照抄文档就崩」的写法背书。
      // 无引号时返回带标记的值，交给调用方判定为非法。
      const quoted = /^['"].*['"]$/.test(raw)
      if (!quoted && /^(?:on|off|yes|no|true|false|null|~)$/i.test(raw)) {
        return `(未加引号的 YAML 布尔值: ${raw})`
      }
      return raw.replace(/^['"]|['"]$/g, '')
    }
  }
  return undefined
}

const VALID_MODES: readonly SpreadMode[] = ['off', 'shadow', 'on']

describe('cordis.patch.yml 的扩散配置', () => {
  test('spread.mode 必须存在——不写就等于没打开突触效果', () => {
    const mode = extractSpreadMode(RAW)
    assert.notEqual(
      mode, undefined,
      'patch 里没有 spread.mode：用户装好插件后拿不到「类似神经的突触效果」。'
      + '若是有意关掉，也必须显式写出来，不能靠缺省。',
    )
  })

  test('spread.mode 必须是三种合法值之一（拼错会静默退回默认）', () => {
    const mode = extractSpreadMode(RAW)
    assert.ok(
      VALID_MODES.includes(mode as SpreadMode),
      `spread.mode = ${String(mode)} 不是合法值。`
      + `合法值只有 ${VALID_MODES.join(' / ')}；`
      + '拼错时 validateConfig 会拒绝，或整段被忽略而静默退回 shadow。',
    )
  })

  test('出厂值必须是 on——这是用户明确要的效果，不能只算不用', () => {
    assert.equal(
      extractSpreadMode(RAW), 'on',
      'patch 是发布者的意图声明，用户明确要「类似神经的突触效果」。'
      + '写成 shadow 等于「照常计算但不生效」——算出来没人看得见，等于没算。',
    )
  })

  test('patch 的值与 DEFAULT_CONFIG 不同，且注释说明了原因', () => {
    // 两者相等时，patch 里这一段就是冗余，而它的注释会变成「解释一件不存在的事」。
    // 这条测试逼着后来者做选择：要么删掉 patch 段，要么保留差异并更新注释。
    const mode = extractSpreadMode(RAW)
    assert.notEqual(
      mode, DEFAULT_CONFIG.spread.mode,
      `patch 的 spread.mode（${String(mode)}）与 DEFAULT_CONFIG（${DEFAULT_CONFIG.spread.mode}）`
      + '相同了。请二选一：删掉 patch 里这段（避免误导），'
      + '或确认差异是有意的并同步注释。',
    )
    // 差异存在时，注释必须解释「为什么 patch 与默认不同」——否则读者会以为
    // 这个值是随手写的，下一个人就会把它「统一」成默认值。
    assert.ok(
      /为什么这里显式写/.test(RAW),
      'patch 里必须有一段注释解释「为什么这里与默认值不同」，'
      + '否则下一个人会把它统一成默认值，静默关掉突触效果。',
    )
  })

  test('DEFAULT_CONFIG 仍是 shadow——库的默认必须保守，发布意图才敢激进', () => {
    // 这两件事分工不同，都不撒谎：
    //   库默认 shadow = 没人配置时不擅自改变每次召回的排序
    //   patch 写 on   = 用户/发布者明确选择了这个效果
    // 若有人把库默认也改成 on，patch 那段注释就会变成假话，这条会红。
    assert.equal(
      DEFAULT_CONFIG.spread.mode, 'shadow',
      'DEFAULT_CONFIG.spread.mode 必须是 shadow：未经真实数据检验的机制'
      + '不该在「没人配置」时默认改变每一次召回的排序。',
    )
  })
})
