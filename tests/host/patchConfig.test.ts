/**
 * `cordis.patch.yml` 配置解析器（真缺陷九的修复件）。
 *
 * ## 这个解析器为什么必须存在
 *
 * 它唯一的职责是**让 CLI 和宿主读同一份配置**。此前 CLI 写死
 * `DEFAULT_CONFIG`（`spread.mode = 'shadow'`），宿主读 patch（`'on'`）⇒
 * 同一个库、同一个查询，终端与会话报出不同分数（实测 3/3 查询不一致）。
 *
 * 所以这里的测试守两件事：
 * 1. **解析正确**：能把本仓库真实的 patch 解析成 `{ spread: { mode: 'on' } }`；
 * 2. **解析严格**：写错时不猜、不静默降级，而是给出带行号的原因。
 *    这条比第 1 条更重要——静默降级正是本仓库反复吃亏的那一类。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { loadPatchConfig, parsePatchConfig } from '../../src/host/patchConfig.ts'

const PATCH_PATH = new URL('../../cordis.patch.yml', import.meta.url)
const RAW = readFileSync(PATCH_PATH, 'utf8')

describe('parsePatchConfig：能解析本仓库真实的 patch', () => {
  it('解析出 spread.mode = on，与宿主读到的一致', () => {
    const result = parsePatchConfig(RAW)
    assert.equal(result.ok, true, `真实 patch 必须能被解析：${result.ok ? '' : result.reason}`)
    if (!result.ok) return
    const spread = result.config.spread as Record<string, unknown> | undefined
    assert.notEqual(spread, undefined, 'patch 里必须有 spread 段，否则 CLI 拿不到扩散模式')
    assert.equal(spread?.mode, 'on', 'spread.mode 必须解析成字符串 on')
  })

  it('解析出 storage.dataDir / consolidation 段（不是只认 spread 一个键）', () => {
    // 只解析一个键的实现也能通过上面那条。这条逼着它做通用解析。
    const result = parsePatchConfig(RAW)
    assert.equal(result.ok, true)
    if (!result.ok) return
    const storage = result.config.storage as Record<string, unknown> | undefined
    assert.equal(storage?.dataDir, '.dsh-memory', 'dataDir 必须解析出来')
    const consolidation = result.config.consolidation as Record<string, unknown> | undefined
    assert.equal(consolidation?.enabled, true, 'enabled: true 必须解析成布尔 true')
    // 加了引号的 '03:30' 必须原样保留字符串。未加引号时它是 YAML 1.1 的
    // 六十进制数 210，见下一条用例。
    assert.equal(consolidation?.dailyAt, '03:30', "加了引号的 '03:30' 必须解析成字符串")
  })

  it('loadPatchConfig 读真实文件与 parsePatchConfig 结果一致', () => {
    const fromFile = loadPatchConfig(new URL(PATCH_PATH).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
    const fromText = parsePatchConfig(RAW)
    assert.equal(fromFile.ok, fromText.ok)
    if (fromFile.ok && fromText.ok) {
      assert.deepEqual(fromFile.config, fromText.config)
    }
  })

  it('文件不存在时 ok=false 且原因里带路径（不抛异常）', () => {
    const result = loadPatchConfig('D:/不存在的目录/cordis.patch.yml')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /读不到 patch 文件/u)
  })
})

describe('parsePatchConfig：写错时必须报错，不能静默降级', () => {
  it('未加引号的 on 必须被识别为 YAML 布尔值，而不是字符串', () => {
    // 这是最要命的一种写法：`mode: on` 看起来完全正常，但 YAML 1.1 里
    // 它是布尔 `true`，宿主拿到 true 会 validateConfig 拒绝、**加载期崩溃**。
    // 如果解析器把它当字符串 'on' 放过去，CLI 会「正常工作」而宿主崩，
    // 那 CLI 就是在替一个「照抄就崩」的写法背书。
    const result = parsePatchConfig([
      '- insert:',
      '    - config:',
      '        spread:',
      '          mode: on',
    ].join('\n'))
    assert.equal(result.ok, true, '解析本身应当成功')
    if (!result.ok) return
    const spread = result.config.spread as Record<string, unknown> | undefined
    assert.equal(spread?.mode, true, '未加引号的 on 必须解析成布尔 true（模拟 YAML 1.1）')
    // 关键：它**不等于**字符串 'on'。下游 validateConfig 会因此报错，
    // 用户就能在终端看见问题，而不是以为配置生效了。
    assert.notEqual(spread?.mode, 'on')
  })

  it('未加引号且含冒号的值必须报错并提示加引号（不猜六十进制数）', () => {
    const result = parsePatchConfig([
      '- insert:',
      '    - config:',
      '        consolidation:',
      '          dailyAt: 03:30',
    ].join('\n'))
    assert.equal(result.ok, false, '未加引号的 03:30 是 YAML 六十进制数，必须拒绝而不是猜')
    if (result.ok) return
    assert.match(result.reason, /加引号/u)
    assert.match(result.reason, /第 4 行/u, '报错必须带行号，否则用户不知道改哪一行')
  })

  it('缩进不一致必须报错（同级键没对齐会让层级错乱）', () => {
    const result = parsePatchConfig([
      '- insert:',
      '    - config:',
      '        spread:',
      '          mode: \'on\'',
      '           maxBoost: 0.12',
    ].join('\n'))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /缩进不一致/u)
  })

  it('重复的键必须报错（后者静默覆盖前者会让人以为改生效了）', () => {
    const result = parsePatchConfig([
      '- insert:',
      '    - config:',
      '        spread:',
      '          mode: \'shadow\'',
      '          mode: \'on\'',
    ].join('\n'))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /重复的键/u)
  })

  it('没有 config: 段时报错（而不是返回空对象让调用方以为配置是空的）', () => {
    const result = parsePatchConfig('- insert:\n    - id: memory\n')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /没有 config: 段/u)
  })

  it('config: 段为空时报错（空配置与没配置是两件事）', () => {
    const result = parsePatchConfig('- insert:\n    - config:\n        \n- override:\n')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /空/u)
  })

  it('行内注释被剥掉，但引号内的 # 必须保留', () => {
    const result = parsePatchConfig([
      '- insert:',
      '    - config:',
      '        storage:',
      '          dataDir: .dsh-memory   # 数据目录',
      '          note: \'a#b\'',
    ].join('\n'))
    assert.equal(result.ok, true, `应当解析成功：${result.ok ? '' : result.reason}`)
    if (!result.ok) return
    const storage = result.config.storage as Record<string, unknown> | undefined
    assert.equal(storage?.dataDir, '.dsh-memory', '行内注释必须被剥掉')
    assert.equal(storage?.note, 'a#b', '引号内的 # 不是注释，必须保留')
  })

  it('config 写成行内映射时明确报错（不猜）', () => {
    const result = parsePatchConfig('- insert:\n    - config: { spread: { mode: on } }\n')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.reason, /单独成行/u)
  })
})
