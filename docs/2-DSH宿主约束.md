# DSH 宿主约束与扩展点（调研结论）

> 用途：固化"宿主能提供什么、不能提供什么"，作为需求与架构的边界。
> 依据：本机 DSH 预览版源码（`D:\code\other_git\deepseek-harness`）与官方文档；标注证据路径。
> 结论分两级：**确定**（源码/文档明确）与**待验证**（第 10 节）。

---

## 1. 插件模型（确定）

- 插件就是 ESM 模块，导出 `apply(ctx, config)`；可选 `name`、`inject`（服务依赖）、`Config`（schema 校验）。
- 三种形态：函数式、`export default { name, inject, apply }`、`class extends Service`（需要对外提供服务时）。
- 装配方式是 patch 行：`- insert: [{ id, name, config, disabled, inject }]`；本地 TS 源文件必须用绝对路径。
- 层序：bundles 顺序 → profile 的 `cordis.patch.yml` → home 级 patch → `--patch`；后层按行 `id` 胜出，且**整块替换 config**（不深合并）。
- 所有注册都挂在 `ctx.effect` 上，插件卸载自动清理。
- 证据：`docs/user/develop/basic/index.zh.md`、`docs/user/develop/basic/publish.zh.md`、`packages/bundle/base/cordis.patch.yml`。

最小形态：

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'memory-example'
export const inject = ['systemPrompt']
export function apply(ctx: Context) {
  // 注册能力
}
```

## 2. 每轮注入（确定）

两条注册通道，语义完全不同：

| API | 落到模型的方式 | 变化对 KV 前缀的影响 |
|---|---|---|
| `ctx.systemPrompt.section({ name, order, text })` | 渲染成 `system/message`（表面节点 0） | 变了通常会重写头部，从首个变化 token 起失效 |
| `ctx.systemPrompt.context({ name, order, text })` | 渲染成带来源的 user 快照，追加在历史之后 | 仅追加，cache-safe |

- `text` 可以是函数，每个模型步骤都重新求值。
- 排序：sections 按 order 升序 + name 次序；contexts 只按 order 升序。第一方 context 占用 110/115/120，本系统取 130 之后。
- 作用域：注册落在调用方 ctx 的 scope 层；scoped 遮蔽 global；scope 的 key 就是 Agent 对象，因此 agent-scoped 注册天然按 agent 隔离。
- 另一条正交路径：`agent/pre-step` 里往本次 step 的 messages 追加 `UserMessage`（时间上下文插件就是这么做的）。
- 证据：`packages/core/system-prompt/src/index.ts`、`docs/subsystems/system-prompt.zh.md`、`packages/core/agent-loop/src/runtime-context.ts`。

## 3. 事件面（确定）

轮次权威顺序：

```text
turn/start
  claim input → assemble prompt/tools → project runtime context
  → agent/pre-step          (waterfall：可 reject / 改写 messages)
     step/start
     agent/request → prepared call
     system/message、user/message 落日志
     llm 流 → assistant/message | assistant/attempt
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
  → agent/turn-stopping     (serial：turn 关闭前 await)
turn/end
```

- **"用户消息进来后、LLM 调用前"的唯一稳定钩子 = `agent/pre-step`**。
- **"LLM 回复后"没有专门的 agent 事件**：用 `agent/turn-stopping`（串行，可 steer；写记忆时不要 steer，否则会强制多跑一步）或订阅持久事件 `assistant/message` / `step/end` / `turn/end`。
- 持久事件走 `session/event` 广播（监听器异常被兜住，不可否决）。工具事件是三条 waterfall。
- 证据：`docs/architecture.zh.md`、`packages/core/session/src/known-event-types.ts`、`packages/core/agent/src/runtime-types.ts`。

## 4. 定时与唤醒（确定）

- `ctx.schedule`：宿主级、绑定 Session 的持久提醒；支持一次性、间隔（最小 60 秒）、每日、每周、五字段 cron（显式 IANA 时区，最小 1 分钟）。
- **到期能唤醒 agent**：宿主取回原 Session，用插件来源的 `followup()` 把消息排进收件箱——这是"无用户输入也能跑一轮"的官方通路。
- 插件自己定时可直接用 `ctx.timeout / ctx.interval`（timer 行在 base 常驻，effect 绑定生命周期）。
- 另一条无人值守机制：`dsh-goal-round-driver`，agent 空闲 + 主动 goal 时排入 goal round。
- 证据：`docs/subsystems/schedule.zh.md`、`vendor/timer/src/index.ts`、`packages/goal/goal-round-driver/README.zh.md`。

## 5. 存储（确定）

- 正规做法是 storage domain：`defineDomain({ name, version, layout, tables })` 声明（zod schema），`ctx.storageDomain.open(spec)` 打开，`table(name)` 提供同步读 + 串行写。
- 写入顺序：后端确认 → 更新内存 → 发 `domain/changed`。
- 后端可路由到 JSON 或 SQLite（宿主统一用 Node 内置 `node:sqlite`）。
- **同名 domain 全进程只允许打开一次**（重复 open 报 `already-open`）→ 双人格不能"一人一个 domain"，必须在表内按 `agentId/sessionId` 分区。
- `session` 日志是模型历史的唯一真相源；`session-query-sqlite` 是可丢弃的派生 FTS 索引，不能当真相源、也不该加表。
- 证据：`docs/subsystems/storage.zh.md`、`packages/storage/storage-domain/src/`、`packages/bundle/base/cordis.patch.yml`。

## 6. 多 agent 与隔离（确定）

四层关系：**preset**（一套插件行的声明式组合，生成独立 Loader 树与 scope）→ **Agent scope**（以 preset scope 为父，决定可见性）→ **subagent**（带谱系的子 Session，可带 persona 与 toolFilter）→ **agent-team**（实验性协作域：roster / mailbox / task DAG）。

- 同进程跑两个"人格独立"的 agent 可行：两个 Session + 各自 preset + 各自 persona 行。
- **记忆不会天然隔离**：存储按名唯一 open，必须自己在数据层分区；会话日志本身天然隔离（每 Session 一份）。
- 人格注入的官方答案是 `dsh-persona`（preset 内挂载，注册 scoped 人设前缀/后缀，可 `complete: true`）。
- 证据：`docs/subsystems/scope.zh.md`、`docs/subsystems/subagent.zh.md`、`docs/subsystems/agent-team.zh.md`、`packages/preset/persona/README.zh.md`。

## 7. 压缩（确定）

- 触发：正常压力在 `agent/pre-step` 里先压缩再 next；溢出恢复在 `agent/request-error`（`CONTEXT_WINDOW_EXCEEDED` → 压缩后 retry）。
- 默认：阈值比 0.8、尾部保留比 0.16、headroom 65536 tokens，可按模型覆盖。
- 策略：可选剪工具结果 → 重新计量 → 选区间 → 模型摘要 → 落 `compaction/start|summary|end`，summary 是一条 surface replace 的 user 消息。
- **没有任何"压缩前"可阻断钩子**；hooks 桥也不支持 PreCompact/PostCompact。
- 记忆插件的正确配合：① 平时增量写；② 听 `compaction/summary` 的 `shadowedSeqs` 回填；③ 压缩后 `context()` 快照会自动重新物化，不需要手动重放。
- 证据：`docs/subsystems/compaction.zh.md`、`packages/compaction/compaction-basic/src/`、`packages/core/agent-loop/src/runtime-context.ts`。

## 8. 可直接复用的现成插件（确定）

| 插件 | 作用 | 本系统怎么用 |
|---|---|---|
| `dsh-persona` | preset 内的人设行（前缀/后缀/完整模式） | 承载 L1 人核，记忆系统不改身份 |
| `dsh-time-context` | 每步注入时间读数（时刻/时区/距上条消息时长），默认 10 分钟节流 | 时间感 V0，直接复用 |
| `dsh-schedule` | 定时/间隔/每日/每周/cron，到期投递并唤醒 | 闹钟、夜间整理、到期提醒 |
| `dsh-goal` + `goal-round-driver` | 目标与自动续跑 | 自我驱动的骨架 |
| `dsh-session` / `session-projection` / `session-query-sqlite` | 追加式事件日志、状态投影、派生查询索引 | 写入源与审计，不当真相源外的存储 |
| `dsh-compaction*` | 上下文压缩 | 记忆系统的搭档，靠事件回填 |
| `dsh-agent-presets` / `dsh-scope` | 按 agent 配工具与隔离作用域 | 双人格 |
| `dsh-mcp-client` | 接外部 MCP 记忆服务 | 只到工具层，不做本能注入 |
| `dsh-experimental-speech-to-text` | 语音转写（本机已装，中文） | 后续多模态第一步（仅文字，无语气） |
| `dsh-experimental-agent-team-profile` | 团队 seam（成员/任务板/信箱） | 交流卡与对账的底座（本机已装） |

注：网上流传的 `dsh-memory`、`dsh-mnemon`、`sage-mem`、`dsh-tool-fold`、`dsh-loadout` 等名字，在本机仓库与 profile 中均不存在，不要按那些名字做选型。

## 9. 硬约束清单（设计时不可违反）

1. 不写自定义 session 事件类型：读取端对未知且非 ignorable 的类型会拒绝整份日志。
2. 不假设"压缩前"有钩子：只能增量写 + 事件回填。
3. 不把记忆卡塞进稳定前缀：会破坏 KV 缓存并稀释焦点。
4. 不用原生数据库扩展：宿主只用 `node:sqlite`，第三方原生模块在打包运行时未验证。
5. 不同 domain 不能按 agent 复制：同一 domain 只能 open 一次，必须表内分区。
6. 写记忆时不 steer：`agent/turn-stopping` 里 steer 会强制多跑一步。
7. 注入顺序要显式：context 给不同 order，不依赖同 order 的稳定排序。
8. 大工具 schema 不进人格层：人格层工具预算 4~6 个。

## 10. 待验证项（写代码时顺手确认）

| 编号 | 待验证 | 备用方案 |
|---|---|---|
| V-1 | `context()` 快照在压缩后是否真的自动重新追加（代码级确认，未跑 e2e） | 压缩事件里显式重算 |
| V-2 | 桌面打包运行时能否加载原生模块 | 用 storage domain + 自建倒排 |
| V-3 | `agent/pre-step` 两个监听器的相对顺序（行序 ≠ 加载序） | 只用一个监听器，或显式 prepend |
| V-4 | 预设内插件与 host 平面共享同一 storage domain 的正确组合方式 | 数据面固定 host 平面，preset 只放消费方 |
| V-5 | `assistant/message` 的 usage 是否总可用（用于 token 预算） | 用宿主 token 计量服务 |
