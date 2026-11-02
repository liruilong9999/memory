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
- [ ] 离线 CLI `src/cli/`
- [ ] 宿主实机验证
- [ ] 起源对照审查遗留项（见 `docs/5-起源对照审查.md` 第二部分）：
  - [ ] `feeling` 加入 `neverArchiveKinds`（起源 L11 直接冲突）
  - [ ] `RecallQuery.domains` 是死字段，召回不按域过滤（起源 L13）
  - [ ] `dueAt` 永远为 null，`pickDue` 恒空，FR-D3 / SC-5 不可能通过（起源 L21）
  - [ ] 召回反馈是正反馈，与「专注当前位置」的抑制语义相反（起源 L29）
  - [ ] `renderFocusPack` 头尾固定开销未计入 token 预算（起源 L33）
  - [ ] 无日摘要、无跨周期层级压缩（起源 L27）
