# AGENTS.md · 工作区协作规范

> 本文件是**本仓库**的协作契约，任何 agent 或人都必须先读它再动手。
> 上层通用规范见 `~/.dsh/AGENTS.md`；本文件只写本仓库特有的部分，冲突时以本文件为准。

## 一、项目是什么

`dsh-memory`：给 DSH（DeepSeek Harness）做的**稳定记忆系统**插件。

- 最终目标：`docs/0-起源.md`（起源设想，哲学层，不可违背）
- 当前范围：`docs/1-需求规格.md` v0.2（稳定记忆：写得进 / 存得住 / 取得回 / 忘得掉）
- 宿主边界：`docs/2-DSH宿主约束.md`（宿主能给什么、不能给什么）
- 架构设计：`docs/3-架构设计.md`（模块划分与数据流）

**判断标准**：任何实现细节，先问「它对应起源的哪一条」，再问「它满足需求规格的哪个编号」。
两者都答不上来的代码，不要写。

## 二、目录结构

```text
src/
  core/      纯函数内核：契约、配置、文本、打分、抽取。禁止 IO、禁止依赖宿主
  store/     数据面：事件日志、持久化、重放、查询索引。只依赖 core
  consolidate/ 巩固面：去重、合并、降权、归档。只依赖 core + store
  host/      适配面：DSH/Cordis 接线。唯一允许 import 宿主包的地方
  cli/       离线命令行：查询、导出、重建
tests/       与 src 同构的单元测试
docs/        设计文档（中文）
```

**依赖方向单向**：`core ← store ← consolidate ← host`。反向 import 一律视为错误。

## 三、硬性约定

1. **语言**：文档、注释、提交信息写中文；标识符用英文。
2. **术语**：英文术语首次出现必须带括号解释，如「焦点包（Focus Pack）」。
3. **引用起源必须双锚定**：写 `起源 L行号（第 N 条·关键词）`，不许只写「起源第 N 条」。
   `docs/0-起源.md` 只有 **8 个编号条目**（L21/23/25/27/29/31/33/35）加 **7 条无编号**
   （L3 激素、L5 连续人生、L11 细节会忘、L13 三模块、L15 图谱、L17 上下文污染、L19 感受经验）。
   只写编号时，编号一错审计者无从发现；带上行号就能直接翻原文核对。
   仓库曾出现引用「起源第 10 条」（起源根本没有第 10 条）与多处方冠李戴，详见 `docs/5-起源对照审查.md`。
4. **类型**：`strict` + `erasableSyntaxOnly`。禁止 `enum`、`namespace`、参数属性。
5. **导入**：相对导入必须带 `.ts` 后缀（`allowImportingTsExtensions`）。
6. **不写死参数**：所有阈值、权重、上限必须落在 `src/core/config.ts`，禁止散落字面量。
7. **纯函数优先**：`core/` 下全部函数必须无副作用、无 IO、可重复调用得到相同结果（ST-1 确定性验收）。
8. **不写自定义 session 事件**（C5）；记忆状态只进 storage domain / 本地日志。
9. **删除文件只能单个删除**，禁止 `rm -rf` 或通配批量删除。

## 四、常用命令

```bash
pnpm typecheck     # tsc --noEmit，提交前必须通过
pnpm test          # node --test 跑全部单测
pnpm build         # 生成 lib/（发布用）
pnpm cli --help    # 离线命令行
```

**提交前检查清单**：

1. `pnpm typecheck` 通过
2. `pnpm test` 全绿
3. 新增行为有对应单测
4. 仓库有 `.codegraph/` 时执行一次 `codegraph sync`

## 五、Git 规范

- 每完成**一个可独立验证的小功能点**提交一次，不要攒大提交。
- 提交信息格式：`<类型>: <中文摘要>`，类型取 `feat` / `fix` / `docs` / `test` / `refactor` / `chore`。
- 示例：`feat: 实现记忆卡打分公式与焦点包组装`
- 只提交源码、测试、文档；`node_modules/`、`lib/`、`.tmp/`、`data/` 已在 `.gitignore`。

## 六、需求编号速查

| 前缀 | 含义 | 出处 |
|---|---|---|
| FR-A* | 写入与数据稳定 | 需求规格 7.1 |
| FR-B* | 召回与内容稳定 | 需求规格 7.2 |
| FR-C* | 遗忘与巩固 | 需求规格 7.3 |
| FR-D* | 时间感 | 需求规格 7.4 |
| FR-E* | 上下文装配与注入 | 需求规格 7.5 |
| FR-F* | 可观测与运维 | 需求规格 7.6 |
| C1–C9 | 宿主硬约束 | 需求规格第 6 节 |
| P1–P8 | 设计原则 | 需求规格第 3 节 |
| ST-1..8 | 稳定性验收 | 需求规格 12.1 |
| SC-1..5 | 场景验收 | 需求规格 12.2 |

## 七、当前进度

- [x] 需求收敛（v0.2）
- [x] 宿主约束调研
- [x] 工程脚手架（package.json / tsconfig / .gitignore）
- [x] 契约层 `src/core/types.ts`、`src/core/config.ts`
- [x] 文本内核 `src/core/text.ts`
- [x] 数据面 `src/store/`
- [x] 打分与抽取 `src/core/scoring.ts`、`src/core/extraction.ts`
- [x] 时间状态 `src/time/`
- [x] 巩固面 `src/consolidate/`
- [x] 适配面 `src/host/` + `src/index.ts` + `cordis.patch.yml`
- [x] 离线 CLI `src/cli/`（query / export / rebuild / health / consolidate）
- [ ] 宿主实机验证
- [x] bundle 展示资源（`icon.svg` / `locale/zh.json` / `locale/en.json`）
- [ ] 起源对照审查遗留项（见 `docs/5-起源对照审查.md` 第二部分）：
  - [x] `feeling` 加入 `neverArchiveKinds`（起源 L11 直接冲突）
  - [x] `RecallQuery.domains` 是死字段，召回不按域过滤（起源 L13）
  - [x] `dueAt` 永远为 null，`pickDue` 恒空，FR-D3 / SC-5 不可能通过（起源 L21）
  - [x] 召回反馈是正反馈，与「专注当前位置」的抑制语义相反（起源 L29）→ 已拆分 recall/peek/confirmRecall，见 FR-B7
  - [x] `renderFocusPack` 头尾固定开销未计入 token 预算（起源 L33）
  - [ ] 无日摘要、无跨周期层级压缩（起源 L27）
  - [ ] 无「从事件蒸馏感受」路径，`distills` 边从未产出（起源 L11）
  - [ ] `src/consolidate/graph.ts` 七种边无需求承接（AGENTS.md 判断标准）
  - [ ] `src/store/store.ts` 并发 `append` 无保护，多 agent 会损坏 `maxSeq`（D-08）

### 已修复但值得记住的坑

- [x] **召回查询曾用「库里最新一张卡」当查询词**：那等于拿上一次写入的记忆
  碎片去查询记忆库，与用户本轮原话语义差异很大。现改用本轮 `user/message`
  原文（`session/event` 累积），拿不到时才退回 `recentQuery()`。
- [x] **`goalText` 从未被传入**：`goalScore` 恒为 0，目标匹配维度算了却不起作用。
  现由 `src/host/adapter.ts` 的 `readGoalText` 从宿主 goal 服务取；三处必须容错
  （`ctx.goals` 不存在 / `get` 不存在 / 宿主对非活跃 agent 抛 `GoalError`）。
- [x] **投影层曾静默改写事实**：`coerceCard` 的 kind 白名单把未知值降级成
  `fact`，导致日志写 A、重放得 B，破坏 ST-1 且事后无从发现。现改为「已知保留 /
  未知字符串透传 / 缺失才兜底」，见 `docs/3-架构设计.md` §4.2。
- [x] **CLI `query` 曾污染访问计数**：走 `engine.recall()` 会写 `touch` 日志，
  运维查一眼等于「使用」。现直接走 `engine.peek`（只读入口）。
  更早还有一份手写的 `readOnlyRecall`，与 `engine.peek` 并存——已删除，因为
  它返回的是**截断后**的候选数而 `peek` 返回完整候选池，同一个库在终端与
  会话里会报出两个不同的数字；且它的 `timeZone` 参数是死参数。**少一份
  实现就少一处漂移点**，手写实现已经开始腐烂了。
  配套有**配对**的对照测试：`peek`/`recall` 前后日志字节数不变（只读），
  `confirmRecall` 后必须变大（证明写库确实会发生，防止只读测试假绿）。
  两条都做过**反向验证**：把断言改坏后确实变红。
- [x] **人读渲染曾有两份实现**：`/memory explain` 与 CLI `query` 各写一遍，
  靠人肉同步。现收敛到 `src/core/render.ts` 的 `renderFocusPackExplain`。
- [x] **`confirmRecall` 已实现但零调用方**：`src/` 下无人调用它，实际行为是
  「只衰减、不强化」——`accessCount` 恒不涨，`importanceScore` 的访问频次项
  恒为 0。这是**有意的暂缓**而非遗漏：确认信号必须来自「这条记忆真的影响了
  输出」的可审计证据，而非「被展示过」。已否决的两个接法：让模型自报
  （它无法区分「看到」与「被影响」）、宿主文本匹配（判据无法稳定定义，误判
  会让错误的正反馈重新出现且事后无从审计）。**接入前不要以为正反馈已生效。**
- [x] **宿主漏传 `goalText` 曾让召回看起来更好**：`goalTokens` 为空时若把
  `w.goal` 从归一化分母摘掉，每张卡分数涨约 11%、更容易进焦点包——**缺陷
  伪装成改进，没人会去修它**。现改为分母恒含全部维度权重，缺目标时 goal 项
  贡献 0。理由比结论重要：看到「分母恒含 w.goal」会觉得多算一项，只有看到
  这个后果才不敢改。
- [x] **靠运气绿的测试**：原 `applyThresholds` 用例的分数余量只有 0.012，
  归一化分母一动就翻红——绿的时候说明不了任何事，红的时候也分不清是回归
  还是噪声。现改为构造真正死透的卡（各分项全 0），结果由规则决定；并加
  前提断言防止将来又变假绿。**让测试由规则决定而不是由巧合决定。**
- [ ] **`state.ts` 的时间来源不一致**：`revise`/`archive`/`restore` 用
  `record.at`，`touch` 用 `op.at`。生产路径 `store.append(op, undefined, now)`
  给两者同一个值所以看不出问题，但测试里只给 `op.at` 会测出非真实行为。
  暂不改（会动数据面语义），但写重放测试时必须从 `op.at` 推导 `record.at`。
