# DSH 宿主接线 API 实证

> 本文只做一件事：把 `src/index.ts` + `cordis.patch.yml` 需要用到的宿主接线 API，逐条钉到**源码文件 + 行号**上。
> 所有结论都来自实读源码，不来自二手文档。`docs/2-DSH宿主约束.md` 与 `docs/3-架构设计.md` 在本文中是**待校验的主张**，不是证据。

---

## 0. 调研方法

### 0.1 证据来源

| 来源 | 路径 | 用途 |
|---|---|---|
| 宿主源码仓库 | `D:\code\other_git\deepseek-harness` | 唯一事实来源 |
| Cordis 内核 | `vendor/cordis/src/` | 插件形态、`ctx.on`、`ctx.effect` |
| Loader（加载器） | `vendor/loader/src/` | 模块导入、`unwrapExports`、entry 选项 |
| Include（包含器） | `vendor/include/src/` | patch 方言的权威实现 |
| 启动装配 | `packages/boot/app-boot/src/` | profile / bundle 分层、路径锚定 |
| 官方 bundle | `packages/bundle/*/cordis.patch.yml` | 真实 patch 样例 |
| 第一方插件 | `packages/*/*/src/` | 真实接线样例 |

### 0.2 引用约定

- 行号格式：`路径:行号` 或 `路径:起始行-结束行`。
- 路径一律相对宿主仓库根目录。
- 逐字引用（verbatim）用 `> 源码` 块，行号写在块内每行开头，避免"引了但找不到"。
- 凡是**未实测**的推断，本文明确标注「未验证」。

### 0.3 一句话结论（先给答案）

1. 插件就是一个 ESM 模块，导出 `name` / `inject` / `Config` / `apply` 四个成员；`apply` 可以是 `async`。
2. 每轮注入走 `ctx.systemPrompt.context({ name, order, text })`，`text` **只能是同步函数**，返回 `string`。
3. 事件订阅走 `ctx.on(name, listener)`，签名来自 `Events` 接口的声明合并，编译期强类型。
4. 命令注册走 `ctx.commands.register(definition)`，**没有内建子命令机制**，子命令要自己解析 `rawInput`。
5. 存储走 `ctx.storageDomain.open(spec)`，记录 schema 用 **zod**（不是 schemastery）。
6. 定时器走 `ctx.interval` / `ctx.timeout`，绑定 `ctx.effect`，随插件卸载自动清理。
7. 唤醒 Agent 走 `agent.followup(message)` + `await ctx.sessions.flush(agent.session)`。
8. **不要用 `agent.steer()` 写记忆**——它会强制模型多跑一步。

---

## 1. 插件形态与入口

### 1.1 最小合法 Cordis 插件模块

Cordis 的 `Plugin` 类型是三种形态的联合：

```ts
// vendor/cordis/src/registry.ts:92-96
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>
```

三种形态的成员定义：

```ts
// vendor/cordis/src/registry.ts:98-111
export namespace Plugin {
  export interface Base<T = any> {
    /** Stable plugin name, used for diagnostics and reload identity. */
    name?: string
    /** Config validation schema. */
    Config?: StandardSchemaV1<any, T>
    /** Required services; loading waits until all are available. */
    inject?: Inject
    /** Services this plugin provides. */
    provide?: string | string[]
    /** Service interception declarations. */
    intercept?: Dict<boolean>
  }
```

```ts
// vendor/cordis/src/registry.ts:120-133
  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): void | Promise<void>
  }

  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }

  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): void | Promise<void>
  }
```

关键点：

- `apply` 的返回类型是 `void | Promise<void>` ⇒ **`apply` 可以是 `async`**。第一方实例见 `packages/context/harness-dev-context/src/index.ts:122`（`export async function apply(ctx: Context): Promise<void>`）、`packages/context/time-context/src/index.ts:133`、`packages/storage/storage-domain/src/index.ts:217`。
- 本仓库用的是「函数形态 + 具名导出」，即 `export function apply(ctx, config)`，与 `harness-dev-context` 同构。

### 1.2 四个导出的真实类型

| 导出 | 类型 | 源码位置 |
|---|---|---|
| `name` | `string`（可选） | `vendor/cordis/src/registry.ts:100` |
| `inject` | `Inject`（可选） | `vendor/cordis/src/registry.ts:104` |
| `Config` | `StandardSchemaV1<any, T>`（可选） | `vendor/cordis/src/registry.ts:102` |
| `apply` | `(ctx, config) => void \| Promise<void>` | `vendor/cordis/src/registry.ts:121` |

`inject` 的类型是：

```ts
// vendor/cordis/src/registry.ts:19
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
```

即：要么是**服务名字符串数组**，要么是**服务名 → 配置对象**的映射。`M` 默认是 `Dict`，但在 `Plugin.Base` 里经 `Context` 增广后，名字受编译期检查（`vendor/cordis/src/registry.ts:164-186` 对 `Context.inject` 的声明合并）。

### 1.3 Loader 如何消费这些导出

Loader 的 Entry 在初始化时做两件事：导入模块、归一化导出、交给 registry：

```ts
// vendor/loader/src/config/entry.ts:225-238
  private async _init() {
    ...
    this.moduleNamespace = await this.parent.tree.import(this.options.name, this.getOuterStack)
    ...
    const plugin = this.loader.unwrapExports(this.moduleNamespace)
    ...
    this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
  }
```

`unwrapExports` 负责吃掉 ESM / CJS / default 互操作的差异：

```ts
// vendor/loader/src/index.ts:197-205
  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
```

**对本系统的意义**：`export const name` / `export const inject` / `export const Config` / `export function apply` 这套具名导出，会被 `unwrapExports` 原样当作插件对象使用（模块命名空间对象本身就有 `apply` 方法 ⇒ 命中 `Plugin.Object` 形态）。**不需要**额外写 `export default`。

### 1.4 `inject` 里可以写哪些服务名

以下是本系统关心的服务，逐个核实到 `provide` / `super()` 那一行：

| 服务名 | 定义包 | 证据 |
|---|---|---|
| `systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `packages/core/system-prompt/src/index.ts:453`（`super(ctx, 'systemPrompt')`） |
| `storageDomain` | `@deepseek-ai/dsh-storage-domain` | `packages/storage/storage-domain/src/index.ts:234`（`domainCtx.provide('storageDomain', facility)`） |
| `commands` | `@deepseek-ai/dsh-commands` | `packages/interaction/commands/src/index.ts:277`（`super(ctx, 'commands')`） |
| `timer` | `@deepseek-ai/cordis-plugin-timer` | `vendor/timer/src/index.ts:14`（`super(ctx, 'timer')`） |
| `schedule` | `@deepseek-ai/dsh-schedule` | `packages/schedule/schedule/src/index.ts:248`（`super(ctx, 'schedule')`） |
| `storage` | `@deepseek-ai/dsh-storage` | `packages/storage/storage/src/index.ts:54`（`super(ctx, 'storage')`） |
| `agents` | `@deepseek-ai/dsh-agent` | `packages/core/agent/src/index.ts:266`（`super(ctx, 'agents')`） |
| `sessions` | `@deepseek-ai/dsh-session` | `packages/core/session/src/index.ts:1092`（`super(ctx, 'sessions')`） |
| `sessionPersistence` | `@deepseek-ai/dsh-session-persistence` | `packages/session/session-persistence/src/index.ts:149` |
| `workingDirectory` | `@deepseek-ai/dsh-working-directory` | `packages/session/working-directory/src/index.ts:73` |
| `sessionProjections` | `@deepseek-ai/dsh-session-projection` | `packages/session/session-projection/src/index.ts:272` |
| `tools` | `@deepseek-ai/dsh-tools` | `packages/core/tools/src/index.ts:112` |

**注意 `timer` 的特殊性**：`ctx.timeout` / `ctx.interval` 不是服务方法，而是 `ctx.mixin` 混入到 Context 上的：

```ts
// vendor/timer/src/index.ts:3-16
declare module '@deepseek-ai/cordis' {
  interface Context extends Pick<TimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
    timer: TimerService
  }
}

/** Disposable timer helpers mixed into Cordis contexts. */
export class TimerService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval'])
  }
```

因此 `inject` 里写 `'timer'`（服务名），调用时写 `ctx.interval(...)`（mixin 方法）。`timer` 行在 base bundle 里常驻挂载，见 `packages/bundle/base/cordis.patch.yml:24-26`：

```yaml
# packages/bundle/base/cordis.patch.yml:24-26
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
```

### 1.5 schemastery 的 `Config` 真实写法

`schemastery` 是 Cordis 的配置校验库，与存储层用的 `zod` 是两套东西（详见 §5.2）。真实样例：

```ts
// packages/context/time-context/src/index.ts:51-63
/** Request-preparation clock formatting and append scheduling. Invalid values fail plugin load. */
export interface Config {
  /** Fallback display zone when the open turn has no unique browser zone. Omit to use the process zone. */
  timeZone?: string
  /** Minimum milliseconds between durable injections in one session. Defaults to 600000 (10 minutes); 0 injects at every eligible step. */
  refreshIntervalMs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeZone: z.string(),
  refreshIntervalMs: z.number(),
})
```

导入方式：

```ts
// packages/context/time-context/src/index.ts:9
import z from '@deepseek-ai/schemastery'
```

`z<Config>` 这个泛型标注是必需的——它把 schemastery 的推断结果钉到接口上，接口与 schema 不同步会编译报错。

**带默认值与必填的写法**（来自 system-prompt 与 storage-json）：

```ts
// packages/core/system-prompt/src/index.ts:437-444
  static Config: z<Config> = z.object({
    includeHarnessIdentity: z.boolean().default(true),
    includeRuntimeContext: z.boolean().default(true),
    personaPrefix: z.string().default(''),
    personaSuffix: z.string().default(''),
    // Preserve omission because an explicit empty order lacks the rest marker.
    toolOrder: z.array(z.string()).default(undefined as unknown as string[]),
  })
```

```ts
// packages/storage/storage-json/src/index.ts:33-36
/** Config schema. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
})
```

即：`.default(x)` 给默认值，`.required()` 强制必填。本系统 `cordis.patch.yml` 里的 `config:` 只写与默认值不同的项，靠的就是这里的 `.default()`。

### 1.6 `package.json` 的 `dsh.bundle.patch` 如何被读取

一个包要能被当作 **bundle（装配单元）** 装进 profile，必须在 `package.json` 里声明 patch 文件路径：

```json
// packages/bundle/base/package.json:31-35
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
```

读取逻辑：

```ts
// packages/boot/app-boot/src/profile.ts:54-71
function bundlePatchFiles(bundle: DshBundleManifest): string[] {
  const patch = bundle.patch
  if (typeof patch === 'string') return [patch]
  if (Array.isArray(patch) && patch.every(file => typeof file === 'string')) return patch
  throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
}

function bundlePatchPaths(packageDir: string, bundle: DshBundleManifest): string[] {
  return bundlePatchFiles(bundle).map(file => join(packageDir, file))
}
```

⇒ `dsh.bundle.patch` 可以是**一个字符串**，也可以是**字符串数组**（按序应用），路径**相对该包的目录**解析。

profile 的装配顺序在文件头注释里写得很明确：

```ts
// packages/boot/app-boot/src/profile.ts:1-22（节选 L5-14）
 * A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
 * `package.json` (out-of-tree plugin dependencies plus the profile manifest
 * `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
 * (the user's own patch layer, applied after every bundle layer). Bundles are
 * npm packages whose manifest declares
 * `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (one file, or an
 * ordered list of files); the tree is composed by applying each bundle's patch
 * lists in `dsh.profile.bundles` order over an empty entry list, then the
 * profile's own patches, then any launcher layers (`--patch` files and
 * flag-derived patches).
```

即四层，从下往上：**bundles（按 `dsh.profile.bundles` 顺序）→ profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层**。

### 1.7 `cordis.patch.yml` 的合法结构

patch 方言的权威实现在 `vendor/include/src/index.ts`。顶层是一个数组，每个元素是一条 patch：

```ts
// vendor/include/src/index.ts:129-141
/** Runtime patch applied to entries loaded from an included config file. */
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any
}
```

`insert` 里的每一行必须是 `EntryOptions`：

```ts
// vendor/loader/src/config/entry.ts:9-23
/** Serialized plugin entry options stored in loader config files. */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
}
```

`applyEntryPatches` 的分支逻辑：

```ts
// vendor/include/src/index.ts:76-100
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch

    if (insert) {
      if (id) {
        const target = entryMap.get(id)
        if (!target) {
          warn('patch insert: entry %C not found', id)
          continue
        }
        if (!target.group) {
          warn('patch insert: entry %C is not a group', id)
          continue
        }
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...insert)
      } else {
        data.push(...insert)
      }
      // Index what this patch added so a LATER patch in the same list can
      // target it. ...
      buildMap(insert)
```

**两条合法写法**：

1. **无 `id` + `insert`** ⇒ 追加到根条目列表。这是 bundle 的标准写法。
2. **有 `id` + 其它字段** ⇒ 按 id 改写那一行（`config` / `disabled` / `name` / `inject`…）。

`include` 插件本身的 Config：

```ts
// vendor/include/src/index.ts:143-155
/** Config namespace for the file-backed include loader. */
export namespace Include {
  /** Config for a file-backed loader subtree. */
  export interface Config {
    /** YAML or JSON path resolved from `ctx.baseUrl`. */
    path: string
    /** Entry list written when the file does not already exist. */
    initial?: any[]
    /** Runtime patches applied after reading the file. */
    patches?: PatchOptions[]
    /** Enables loader apply/reload/unload logs for this subtree. */
    enableLogs?: boolean
  }
}
```

### 1.8 完整真实 bundle patch 示例

`packages/bundle/base/cordis.patch.yml` 是主样例（534 行），其头部注释解释了整个方言的语义：

```yaml
# packages/bundle/base/cordis.patch.yml:1-13
# The dsh-base bundle patch: the shared core of each base-backed profile, applied as
# ONE insert over the empty profile root. Later bundle patches and the user's
# profile cordis.patch.yml address these rows by id, with the last write
# winning per row.
#
# A patch replaces the targeted row's whole `config` rather than merging into
# it, so a row whose value differs by mode does NOT live here: it belongs to
# each mode bundle, keeping any single row down to one bundle layer plus the
# user's. Mode-specific rows appear below only with shared plugin identity and
# neutral defaults; each mode bundle restates its complete configuration.
#
# Row order carries no load semantics (activation is service-availability
# driven); the grouping is for readers.
```

**要点**：`config` 是**整块替换**，不是深合并。这一条与本仓库 `cordis.patch.yml` 注释里写的"深合并到 DEFAULT_CONFIG 之上"是**两回事**——深合并发生在插件自己的 `resolveConfig()` 里，不是 patch 层做的（详见 §8.6）。

一个**完整独立**的 patch 样例是 `packages/bundle/sdk-minimal/cordis.patch.yml`（179 行），它不叠在 base 之上，整个 Cordis 树由它自己给出：

```yaml
# packages/bundle/sdk-minimal/cordis.patch.yml:1-40（节选）
# Standalone minimal SDK application. Unlike the ordinary SDK profile, this
# bundle does not layer over dsh-base: this insert is the complete Cordis tree.
# User profile, home, and invocation patches still apply above it.

- insert:
    - id: sdk-app-startup
      name: '@deepseek-ai/dsh-sdk-app'
      config:
        profile: sdk-minimal

    - id: sdk-jsonrpc-server
      name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
      inject: [sdkAppStartup, loader]
      config:
        maxTokensAsSuccess: false

    - id: deepseek-llm-api-extensions
      name: '@deepseek-ai/dsh-deepseek-llm-api-extensions'

    - id: session-log-deepseek
      name: '@deepseek-ai/dsh-session-log-deepseek'

    - id: plugin-package-inventory-deepseek
      name: '@deepseek-ai/dsh-plugin-package-inventory-deepseek'

    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        defaultContextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)
        streamIdleTimeoutMs: 172800000

    - id: sandbox
      name: '@deepseek-ai/dsh-sandbox-local'
```

这份样例演示了三种行字段用法：`inject:`（行级服务依赖）、`config:`（插件配置）、`!!js` 表达式（延迟求值的 JS）。

**按 id 覆盖**的真实样例（web-app bundle 改 base 里的 system-prompt 行）：

```yaml
# packages/bundle/web-app/cordis.patch.yml:17-20
- id: system-prompt
  config:
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.
```

注意：这一层只写 `personaPrefix`，但因为是**整块替换**，该行的 `config` 最终就只剩这一个键——其余键靠 `static Config` 里的 `.default()` 兜底。

### 1.9 本地插件的路径锚定（为什么必须写绝对路径）

Loader 的 `tree.import` 分三种情况：

```ts
// vendor/loader/src/config/tree.ts:113-131（节选）
  import(name: string, getOuterStack?: ...): Promise<any> {
    if (name.startsWith('cordis:')) { ... }        // 内建
    if (this.ctx.loader.internal) { ... }           // 内部导入
    if (name.startsWith('.')) return import(new URL(name, this.ctx.baseUrl).href)
    ...
    const url = await this.resolve(name)            // createResolve(baseUrl)
    return import(url)
  }
```

宿主在装配 patch 时，会把**相对/绝对路径**的行 `name` 预先转成 `file://` URL：

```ts
// packages/boot/app-boot/src/index.ts:546-557
function anchorInsertedPluginNames(patches: PatchOptions[], file: string): void {
  const base = dirname(file)
  ...
      if (typeof entry.name === 'string'
        && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../'))) {
        entry.name = pathToFileURL(resolve(base, entry.name)).href
      }
```

并且在 patch 解析阶段安装了一个专门的 include 子类，把绝对路径转 URL 后再走内部导入：

```ts
// packages/boot/app-boot/src/index.ts:744-758（节选）
      const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
      ...
      return internal.import(specifier, bareModuleBaseUrl, {})
```

官方文档也把这条写成了硬要求：

```text
# docs/user/develop/basic/index.zh.md:56
插件路径必须是绝对路径。patch 文件只贡献配置，不会改变 loader 解析模块路径时使用的 profile 目录。
```

**对本系统的意义**：`cordis.patch.yml` 里 `name: dsh-memory` 这种**裸包名**只有在包已被安装进 profile 的 `node_modules` 时才能解析；开发期直接指向仓库里的 TS 源文件，必须写绝对路径（或用 `./` 相对路径，宿主会按 patch 文件所在目录解析）。

---

## 2. 每轮注入（主通道）

### 2.1 `PromptContext` 的逐字类型

```ts
// packages/core/system-prompt/src/index.ts:78-90
/** Dynamic model context materialized as a durable user-role snapshot. */
export interface PromptContext {
  /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
  readonly name: string
  /** Contexts are joined in ascending order. */
  readonly order: number
  /** Static text or a provider evaluated at assembly and admission refresh. Empty text contributes nothing. */
  readonly text: string | ((context: AssembleContext) => string)
  /** Whether to interpolate prompt variables. Defaults to true; false preserves literal text. */
  readonly interpolate?: boolean
  /** Keep this operational context when optional runtime context is disabled. */
  readonly required?: boolean
}
```

`AssembleContext` 的字段：

```ts
// packages/core/system-prompt/src/index.ts:41-50
/** Merge-extensible context for one prompt assembly. */
export interface AssembleContext {
  /**
   * Scope whose providers and waterfall listeners participate. When absent,
   * only global providers and subject-less listeners participate.
   */
  scope?: ScopeKey
  /** Explicit control signal for the turn that requested this assembly, when any. */
  signal?: AbortSignal
}
```

该接口是**可合并增广**的，agent 运行时往里加了两个字段：

```ts
// packages/core/agent/src/runtime-types.ts:19-24
declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    agent?: Agent
    modelSelection?: Readonly<ModelSelection>
  }
}
```

⇒ `text(context)` 里可以拿到 `context.agent`（当前 Agent）、`context.scope`、`context.signal`、`context.modelSelection`。

### 2.2 `text` 能不能是 async？

**不能。** 类型是 `string | ((context: AssembleContext) => string)`，函数返回 `string`，没有 `Promise<string>`。

求值处是同步的，没有任何 `await`：

```ts
// packages/core/system-prompt/src/index.ts:386-393
/** Resolve one registered runtime fact without assembling sections or tools. */
function resolveContext(entry: PromptContext, context: AssembleContext): AssembledContext {
  return {
    name: entry.name,
    text: typeof entry.text === 'function' ? entry.text(context) : entry.text,
    ...entry.interpolate !== undefined ? { interpolate: entry.interpolate } : {},
  }
}
```

**这是本系统最重要的一条硬约束**：记忆召回如果要做 IO（读盘、查索引），**不能放在 `text()` 里**。正确做法是：

- 在 `agent/pre-step` 或 `session/event` 里异步预热，把结果写进内存缓存；
- `text()` 只读内存，同步返回字符串。

### 2.3 `context()` 的签名与返回值

```ts
// packages/core/system-prompt/src/index.ts:513-529
  /**
   * Register ordered dynamic context in the calling context's scope. Scoped
   * entries shadow global entries with the same name.
   * @param context - the context contribution to register.
   * @returns the exact Cordis effect disposer.
   */
  context(context: PromptContext): () => void {
    if (!Number.isFinite(context.order)) {
      throw new TypeError(`prompt context "${context.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.contexts.insert(context.name, context),
      { label: 'systemPrompt.context()' },
    )
  }
```

- 返回 `() => void`，是**精确的 Cordis effect 清理器**。
- 因为走 `layers.effect(this.ctx, ...)`，它绑定在**调用方 ctx 的 fiber** 上，插件卸载时自动清理。
- 因此：**插件内不需要手动 dispose**；只有在「同一插件内需要提前撤销」时才用返回值。
- `order` 非有限数会 `throw TypeError`（L521-523）。同名重复注册也会抛（L80 注释）。

对照 `section()`（另一条通道，本系统不用）：

```ts
// packages/core/system-prompt/src/index.ts:477-494
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.sections.insert(section.name, section),
      { label: 'systemPrompt.section()' },
    )
  }
```

`ctx.effect` 的清理语义：

```ts
// vendor/cordis/src/fiber.ts:421-428
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
    this.assertActive()
    if (this.state === FiberState.UNLOADING) {
      throw new CordisError('INACTIVE_EFFECT')
    }
```

### 2.4 第一方 `order` 全表

**Section 顺序表**（`section()` 通道）：

| 常量 | 值 | 行号 |
|---|---|---|
| `HARNESS_IDENTITY` | -1000 | `packages/core/system-prompt/src/index.ts:137` |
| `DEPLOYMENT_PERSONA_PREFIX` | 0 | `:138` |
| `PLAN_POLICY` | 500 | `:139` |
| `TEAM_POLICY` | 600 | `:140` |
| `PTC_ONLY` | 800 | `:141` |
| `FILE_REFERENCE` | 900 | `:142` |
| `TOOL_BASH` | 1000 | `:143` |
| `TOOL_PWSH` | 1010 | `:144` |
| `TOOL_READ` | 1100 | `:145` |
| `TOOL_WRITE` | 1200 | `:146` |
| `TOOL_EDIT` | 1300 | `:147` |
| `TOOL_APPLY_PATCH` | 1350 | `:148` |
| `TOOL_GLOB` | 1400 | `:149` |
| `TOOL_GREP` | 1500 | `:150` |
| `TOOL_JOBS` | 1600 | `:151` |
| `TOOL_PTY` | 1700 | `:152` |
| `TOOL_WEB_SEARCH` | 2000 | `:153` |
| `TOOL_WEB_FETCH` | 2100 | `:154` |
| `TOOL_LSP` | 2200 | `:155` |
| `TOOL_SESSION_QUERY` | 2300 | `:156` |
| `TOOL_GOAL` | 2400 | `:157` |
| `TOOL_SCHEDULE` | 2500 | `:158` |
| `TOOL_WORKFLOW` | 2600 | `:159` |
| `TOOL_RALPH` | 2700 | `:160` |
| `TOOL_SUBAGENT` | 2800 | `:161` |
| `TOOL_REPORT` | 2900 | `:162` |
| `TOOL_COMPUTER_USE` | 3000 | `:163` |
| `MCP_SERVERS` | 3100 | `:164` |
| `TOOLS_SDK` | 5000 | `:165` |
| `DELIVERABLE_FILE_REFERENCES` | 9000 | `:166` |
| `STRUCTURED_OUTPUT` | 9900 | `:167` |
| `HARNESS_SOURCE` | 10000 | `:169` |
| `WEB_SURFACE` | 10100 | `:170` |
| `DEPLOYMENT_PERSONA_SUFFIX` | 10200 | `:171` |

**Context 顺序表**（`context()` 通道，本系统用的）：

```ts
// packages/core/system-prompt/src/index.ts:177-186
const CONTEXT_ORDERS = {
  WORKING_DIRECTORY: 100,
  SANDBOX_POLICY: 110,
  APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120,
  TEAM_IDENTITY: 125,
  // Process-specific paths and endpoints stay out of the cached system prompt.
  HARNESS_SOURCE: 200,
  WEB_SURFACE: 210,
} as const
```

| 常量 | 值 | 行号 | 使用方 |
|---|---|---|---|
| `WORKING_DIRECTORY` | 100 | `:178` | `packages/session/working-directory/src/index.ts:90-96` |
| `SANDBOX_POLICY` | 110 | `:179` | `packages/sandbox/sandbox-policy/src/index.ts:175-183` |
| `APPROVAL_POLICY` | 115 | `:180` | `packages/interaction/user-approval/src/index.ts:190-200` |
| `SUBAGENT_DELEGATION` | 120 | `:181` | `packages/subagent/subagent/src/child-agent.ts:205-209`、`packages/subagent/tool-subagent/src/index.ts:376-385` |
| `TEAM_IDENTITY` | 125 | `:182` | `packages/experimental/tool-agent-team/src/index.ts:175-186` |
| `HARNESS_SOURCE` | 200 | `:184` | `packages/context/harness-dev-context/src/index.ts:134-157` |
| `WEB_SURFACE` | 210 | `:185` | 同上 |

取顺序值的**正确姿势**是调 `getContextOrder()`，不写死数字：

```ts
// packages/core/system-prompt/src/index.ts:505-512
  getContextOrder(name: PromptContextOrderName): number {
    return CONTEXT_ORDERS[name]
  }
```

第一方真实用法：

```ts
// packages/interaction/user-approval/src/index.ts:187-201
    // The complete current value travels after retained history, so switching
    // policy does not rewrite the stable system-prompt cache prefix.
    await this.ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'approval:policy',
        order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY'),
        text: (context) => {
          const agent = context.agent
          // A bare assemble() (tests, diagnostics) has no session to state.
          if (agent === undefined) return ''
          const policy = effective(agent)
          return policy === 'never' ? NEVER_SENTENCE : ASK_SENTENCE
        },
      })
    })
```

注意两点：`await ctx.inject(...)` 让插件加载等到 scope 就绪；`text` 里对 `context.agent === undefined` 做了兜底（裸 `assemble()` 的场景）。

### 2.5 压缩后会不会自动重新物化？

**会。** 完整证据链：

**第一步：每个 step 之前重新组装一次。**

```ts
// packages/core/agent-loop/src/agent.ts:283-312
  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    ...
    const claimed = this.inbox.claim(target, position.turn)
    ...
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal })
    try {
      const assembly = await this.loopCtx.systemPrompt.assemble({ ...assembleContextFor(this, signal), modelSelection: selection, toolSet })
      signal.throwIfAborted()
      const decision = await this.dispatch.waterfall(
        'agent/pre-step', { messages: claimed, ...position, signal, modelSelection: selection },
        (): Promise<PreStepDecision> => {
          const sections = renderContextSections(assembly)
          const context = this.runtimeContext.project(joinContextSections(sections), sections)
          return Promise.resolve<PreStepDecision>({
            kind: 'enter',
            messages: context === undefined ? claimed : [...claimed, context],
          })
        },
      )
```

⇒ `assemble()` 在每个 step 前跑一次，`text()` 函数因此**每个 step 求值一次**。

**第二步：每个请求尝试之前再刷新一次。**

```ts
// packages/core/agent-loop/src/agent.ts:440-450
    const { assembly } = decision
    const renderedPrompt = renderPrompt(assembly)
    let firstAttempt = true
    while (true) {
      const { config, preparedCall } = await this.prepareRequest(turn, step, decision.selection, signal)
      const currentContext = this.loopCtx.systemPrompt.refreshContext(assembly, {
        ...assembleContextFor(this, signal), modelSelection: decision.selection,
      })
      const sections = renderContextSections(currentContext)
      const context = this.runtimeContext.project(joinContextSections(sections), sections)
```

`refreshContext` 会**重新调用** `resolveContext`（即重新执行 `text()`）：

```ts
// packages/core/system-prompt/src/index.ts:589-600（节选）
  refreshContext(assembly: PromptAssembly, context: AssembleContext = {}): PromptAssembly {
    ...
    for (const accepted of assembly.contexts) {
      const provider = providers.get(accepted.name)
      required.delete(accepted.name)
      if (suppressed && provider?.required !== true) continue
      contexts.push(provider === undefined ? accepted : resolveContext(provider, context))
    }
```

**第三步：压缩把旧快照"作废"，下次 project 时重新发出。**

```ts
// packages/core/agent-loop/src/runtime-context.ts:119-149
export class RuntimeContextProjection {
  /** `undefined` means no snapshot ever existed; `null` means none is retained. */
  private retained: { seq: SessionSeq; text: string | undefined } | null | undefined
  ...
  constructor(ctx: Context, session: Session) {
    const surface = new Set(session.surface.nodes)
    for (const event of eventsNewestFirst(session)) {
      if (event.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (this.retained
        && isReplacementSurfaceEvent(event)
        && event.sourceEventSeqs?.includes(this.retained.seq) === true) {
        this.retained = null
      }
    })
  }
```

```ts
// packages/core/agent-loop/src/runtime-context.ts:151-168
  /**
   * Create an uncommitted snapshot only when the retained value differs.
   * @param current - fully rendered dynamic context.
   * @param sections - named contributions that formed the current snapshot.
   * @returns a candidate user message, or `undefined` when no update is needed.
   */
  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      // The cleared marker has no contributions left to attribute.
      source: sections.length === 0
        ? { kind: SOURCE }
        : { kind: SOURCE, form: 'snapshot', sections },
    })
  }
```

压缩的 surface 替换事件带 `sourceEventSeqs`，里面包含被遮蔽的旧快照 seq ⇒ `retained` 被置 `null` ⇒ 下一个 step 的 `project()` 发现 `retained === null` 且 `current` 非空 ⇒ 返回新快照 ⇒ `agent.ts:475-477` 把它 `append` 成新的 `user/message`。

压缩侧产生该事件的代码：

```ts
// packages/compaction/compaction-basic/src/region.ts:469-520（节选，实际 append 处）
    session.append('compaction/summary', { ... })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
    })
```

**结论**：`docs/3-架构设计.md:139` 的 FR-E4 假设成立，**待验证项 V-1 解除**。前提是 `text()` 里读的是**当前内存状态**（不是某个快照闭包），否则重新求值也拿不到新内容。

### 2.6 快照的最终文本形态

```ts
// packages/core/system-prompt/src/index.ts:313-325
/**
 * The model-facing snapshot text for an already-rendered section list.
 * ...
 */
export function joinContextSections(sections: readonly ContextSnapshotSection[]): string {
  const body = sections.map(section => section.text).join('\n\n')
  if (body.length === 0) return ''
  return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}
```

⇒ 所有 context 贡献被 `\n\n` 拼成**一条** user 消息，前缀固定为 `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`。本系统返回空串时该贡献不出现（`renderContextSections` 的 `.filter(section => section.text.length > 0)`，`packages/core/system-prompt/src/index.ts:343`）。

---

## 3. 事件订阅

### 3.1 `ctx.on` 的精确签名

```ts
// vendor/cordis/src/events.ts:88-96
    /**
     * @param name — the event name to listen for.
     * @param listener — called with the dispatch arguments.
     * @param options — listener options; a boolean is shorthand for `prepend`.
     * @returns a disposer removing the listener; `true` if it was still registered.
     */
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

```ts
// vendor/cordis/src/events.ts:110-116
/** Options accepted by `ctx.on()` and `ctx.once()`. */
export interface EventOptions {
  /** Add the listener before existing listeners for the same event. */
  prepend?: boolean
  /** Receive the event regardless of context filter checks. */
  global?: boolean
}
```

⇒ 监听器的参数列表**由 `Events[K]` 决定**，是编译期强类型的；`ctx.on` 返回 `() => boolean` 清理器。

### 3.2 本系统需要的全部事件（逐个逐字）

#### `agent/pre-step`（waterfall，本系统**不用**它做主通道，但要知道顺序）

```ts
// packages/core/agent/src/runtime-types.ts:343-350
     * @param payload.turn - the turn that will own the step.
     * @param payload.step - the step proposed by the loop.
     * @param payload.signal - the current turn's cancellation signal.
     * @param payload.modelSelection - captured step selection, retained across retries; omitted effort uses adapter defaults.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode waterfall
     */
    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal; modelSelection: Readonly<ModelSelection> }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

返回类型：

```ts
// packages/core/agent/src/runtime-types.ts:139-146
export type PreStepDecision =
  | { kind: 'reject' }
  | {
    kind: 'enter'
    messages: UserMessage[]
    startsRequestSeries?: true
  }
```

#### `agent/turn-stopping`（serial）

```ts
// packages/core/agent/src/runtime-types.ts:400-417
    /**
     * The turn is about to close: the model owes no response (no live tool
     * calls, no fresh steering). Awaited before the boundary commits — a
     * listener that objects steers (`agent.steer(...)`) and the machine
     * re-reads its inbox: fresh steering runs another step, none closes the
     * turn. Data decides, so listener order cannot change the outcome. The
     * inverse control (stop a tool loop early) is data too: a tool result
     * carrying `concludesTurn` ends the turn at its step. The conclusion
     * never short-circuits already-submitted next-step work: same-step
     * `additionalContexts` or racing steering still runs, and the turn
     * closes only when that inbox drains.
     * @param payload.agent - the agent whose turn is at its stop boundary.
     * @param payload.turn - the turn about to close.
     * @param payload.signal - the current turn's explicit abort signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @mode serial
     */
    'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
```

#### `agent/created` / `agent/disposed` / `agent/status`

```ts
// packages/core/agent/src/runtime-types.ts:290
    'agent/created'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource; signal?: AbortSignal }): undefined | Promise<undefined>
```

```ts
// packages/core/agent/src/runtime-types.ts:299
    'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void
```

```ts
// packages/core/agent/src/runtime-types.ts:309
    'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void
```

#### `session/event`（emit，post-commit，fire-and-forget）

```ts
// packages/core/session/src/index.ts:65-76
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only events from sessions entered through that agent's context.
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

**这是本系统读 `assistant/message` / `step/end` / `turn/end` / `compaction/summary` 的正确入口**：提交后触发、异常被兜住（不会否决提交）、不阻塞回复。

异常兜住的实现：

```ts
// packages/core/session/src/index.ts:393-403（函数签名与语义）
function collectSessionCallbacks(...) ...
function invokeContainedSessionObservers(ctx, name: 'session/event' | 'session/disposed', id, args, callbacks) {
  // 每个监听器单独 try/catch；rejected promise → ctx.logger.warn
}
```

#### `session/disposed`

```ts
// packages/core/session/src/index.ts:65
    'session/disposed'(this: Scoped<Session>, session: Session): void
```

### 3.3 持久事件（`SessionEventMap`）载荷类型

```ts
// packages/core/session/src/types.ts:294
  'turn/start': { turn: number }
```

```ts
// packages/core/session/src/types.ts:303
  'turn/end': { turn: number; reason: TurnEndReason }
```

```ts
// packages/core/session/src/types.ts:305
  'step/start': { turn: number; step: number }
```

```ts
// packages/core/session/src/types.ts:307
  'step/end': { turn: number; step: number }
```

```ts
// packages/core/session/src/types.ts:315
  'user/message': UserMessage
```

```ts
// packages/core/session/src/types.ts:338
  'system/message': { turn: number; step: number; message: SystemMessage }
```

```ts
// packages/core/session/src/types.ts:349-357
  'assistant/message': {
    turn: number
    step: number
    message: AssistantMessage
    /** Exact timed model stream, compacted without joining delta boundaries. */
    stream: AssistantStreamRecord[]
    usage?: TokenUsage
    interrupted?: true
  }
```

`SessionEvent` 的外壳：

```ts
// packages/core/session/src/types.ts:505-523（节选）
    seq: SessionSeq
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
    ...
    ignorable?: true
  } & (K extends SurfaceEventType ? SurfaceIntent<K> : {
    surfaceOp?: never
    sourceEventSeqs?: never
  })
```

⇒ 通用字段是 `type` / `seq` / `time` / `data`。

#### `compaction/summary`

```ts
// packages/compaction/compaction/src/types.ts:25-53（节选）
    /**
     * Completed summary, its inputs, and its model call facts — log-only, no surfaceOp.
     * The summary content is in `data.summary`; the actual surface replacement
     * is performed by the immediately following `user/message` event that
     * shadows the compacted range. That adjacency is contractual — ...
     */
    'compaction/summary': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      summary: ContentBlock[]
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      shadowedSeqs: SessionSeq[]
      shadowedTokenCount: number
      /** The provider route that wrote the summary. */
      provider: string
      /** The model that wrote the summary ... */
      model: string
      /** The generation cap the summarize call sent, when one applied. */
      maxTokens?: number
      /** Provider-reported token usage for the summarization request, when emitted. */
      usage?: TokenUsage
    } & (...
```

`compaction/start` 在 `packages/compaction/compaction/src/types.ts:24`。

**已知事件全集**（生成文件，90 行）：

```ts
// packages/core/session/src/known-event-types.ts:22-85（节选）
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  ...
  'step/end',
  'system/message',
  'turn/end',
  'turn/start',
  'user/message',
  ...
])
```

### 3.4 真实注册样例

**读持久事件（fire-and-forget）**：

```ts
// packages/deliverables/workspace-changes/src/index.ts:145-157
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = eligible(session)
      if (cwd !== undefined) recorderFor(session, cwd).start(event.data.turn)
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') recorders.get(session)?.end(event.data.turn)
  })
  ctx.on('session/disposed', (session) => { void forget(session) })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
```

⇒ `agent/turn-stopping` 里 `await` 是安全的，但**它会把 turn 关闭往后推**（`serial` + 在边界提交前 `await`）。

另一个：

```ts
// packages/compaction/compaction-basic/src/index.ts:205-211
    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })
```

**在 `agent/pre-step` 里改消息（`next()` 之前）**：

```ts
// packages/compaction/compaction-basic/src/index.ts:157-175（节选）
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!signal.aborted) {
      try {
        const result = await this.compactIfNeeded(agent, 'pressure', signal)
        ...
      }
    }
    return next()
  })
```

⇒ 压缩在 `next()` **之前**跑，所以默认 `next()` 里的 `assemble()` 已经是压缩后的状态。

**在 `agent/pre-step` 里改消息（`next()` 之后）**：

```ts
// packages/context/agent-instructions/src/index.ts:330-356
  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    await waitForProjections(agent)
    const pending = agent.inbox.nextStep.filter(isAgentInstructionsMessage)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))) {
      return decision
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { ...decision, messages: entered }
  })
```

**带 `prepend: true`**：

```ts
// packages/context/time-context/src/index.ts:199-242（节选，L242 是 options）
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const timeContextProjectionHandle = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    ...
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({ ... })],
    }
  }, { prepend: true })
```

⇒ **`agent/pre-step` 的监听器顺序确实会影响结果**（谁在 `next()` 前、谁在 `next()` 后、谁 `prepend`）。`docs/2-DSH宿主约束.md` 的 V-3 是真问题，但本系统的解法不是"只注册一个监听器"就够了——还要保证自己的监听器**不与压缩抢位置**。

### 3.5 从事件里取"最新用户消息文本"的可运行片段

**推荐做法（`session/event` 订阅，post-commit，不阻塞）**：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** 把一条消息的全部文本块拼起来；非文本块（图片、文件）跳过。 */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 只认人类直接输入：`source.kind === 'user'`，排除合成上下文。 */
function isHumanPrompt(message: Message): boolean {
  return message.role === 'user' && message.source.kind === 'user'
}

export function apply(ctx: Context): void {
  // 每个 session 最近一条人类输入
  const latest = new Map<Session, string>()

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'user/message') {
      if (!isHumanPrompt(event.data)) return
      const text = messageText(event.data)
      if (text.length > 0) latest.set(session, text)
      return
    }
    if (event.type === 'assistant/message') {
      const prompt = latest.get(session)
      if (prompt === undefined) return
      // 这里拿到的是「本轮用户说了什么 + 模型回了什么」的完整一对
      const reply = messageText(event.data.message)
      void recordTurn(prompt, reply)
      return
    }
    if (event.type === 'turn/end') {
      latest.delete(session)
    }
  })

  ctx.on('session/disposed', (session) => { latest.delete(session) })
}

declare function recordTurn(prompt: string, reply: string): Promise<void>
```

`source.kind === 'user'` 的判据来自消息来源表：

```ts
// packages/llm/llm/src/message.ts:110-115
export interface MessageSourceMap {
  user: { kind: 'user' }
  model: ModelMessageSource
  tool: ToolMessageSource
  'system-prompt': SystemPromptMessageSource
}
```

```ts
// packages/llm/llm/src/message.ts:161-164
/** A user-role specialization of the shared message representation. */
export interface UserMessage extends MessageBase {
  readonly role: 'user'
}
```

`user/message` 事件里三种来源混在一起，必须靠 `source` 区分：

```ts
// packages/core/session/src/types.ts:308-315
  /**
   * A user-role message on the model-visible surface: a direct human prompt
   * (the queued message claimed for this turn), a synthetic `agent.inject()`
   * context (file-change notices, subdir AGENTS.md, skill content, cron
   * notifications, …), or an entered goal continuation round. All three
   * project their `content` verbatim; `source` tells them apart.
   */
  'user/message': UserMessage
```

**备选做法（`agent/pre-step` 的 `messages` 载荷）**：

```ts
ctx.on('agent/pre-step', async ({ messages, turn, step, signal }, next) => {
  const human = messages.filter(m => m.role === 'user' && m.source.kind === 'user')
  const text = human.map(messageText).filter(t => t.length > 0).join('\n')
  // 注意：这里 messages 只是「本次 step 拟进入的消息」，不含历史
  return next()
})
```

**不要用的做法**：`session.eventAt(seq)` / `session.snapshotEvents()` —— 已标记 `@deprecated`：

```ts
// packages/core/session/src/index.ts:714-716
  /** @deprecated New calls are prohibited; use the surface or the append feed. */
  eventAt(seq: SessionSeq): SessionEvent | undefined {
```

```ts
// packages/core/session/src/index.ts:728-741
  /** @deprecated New calls are prohibited; ... */
  snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq): SessionEvent[] {
```

宿主自己在用的地方都加了豁免注释：

```ts
// packages/core/agent-loop/src/runtime-context.ts:75-76
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = this.session.eventAt(seq)
```

### 3.6 `agent/turn-stopping` 里做异步写安全吗？

**安全，但有代价。**

- 安全：`@mode serial`，宿主 `await` 每个监听器，异常不会静默吞掉；写在 `await` 完成前不会丢。
- 代价：turn 的关闭被**推迟**到你的 `await` 完成。写盘慢就拖慢整个 turn 收尾。

调用点：

```ts
// packages/core/agent-loop/src/agent.ts:394-399
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
```

⇒ 只有「本轮确实要结束且没有待办的下一步」时才派发；`serial` 是**串行等待**。

**建议**：`agent/turn-stopping` 里只做**入队**（把要写的东西推进内存队列），真正的落盘交给 `session/event` 或定时器。这样既不阻塞 turn，也不丢数据。

### 3.7 "不要 steer" 的精确含义与代码位置

**`steer()` 的定义**：

```ts
// packages/core/agent/src/runtime-types.ts:253-260
    /**
   * Submit steering for the nearest step. An idle driver starts a turn;
   * a running driver consumes it at its next step boundary.
   * A rejected step leaves steering parked in the inbox until the next
   * wake; cancellation or disposal may discard pending steering.
   * @param message - identified steering content and the source that supplied it.
   */
    steer(message: UserMessage): void
```

**`agent/turn-stopping` 里的语义**：

```ts
// packages/core/agent/src/runtime-types.ts:401-405（节选）
     * The turn is about to close: the model owes no response (no live tool
     * calls, no fresh steering). Awaited before the boundary commits — a
     * listener that objects steers (`agent.steer(...)`) and the machine
     * re-reads its inbox: fresh steering runs another step, none closes the
     * turn.
```

**精确含义**：在 `agent/turn-stopping` 里调 `agent.steer(...)`，宿主会把 inbox 重读一遍，发现有新的 steering ⇒ **再跑一个 step**（多一次 LLM 调用、多一轮 token 消耗），turn 才关闭。

**对记忆系统的后果**：写记忆是**旁路副作用**，不是"模型还需要再说一句"。如果在 turn 收尾时 steer，每轮对话都会多跑一步——这是纯粹的浪费，而且会让用户看到"AI 又说了句废话"。

**三个投递方法的对比**：

| 方法 | 语义 | 唤醒 Agent | 位置 |
|---|---|---|---|
| `followup(message)` | 排队一个独立的后续 turn | ✅ 会唤醒 | `runtime-types.ts:246-251` |
| `steer(message)` | 投递给最近的 step，强制再跑一步 | ✅ 会唤醒 | `runtime-types.ts:253-260` |
| `inject(message)` | 排队给下一个 pre-step 的模型可见上下文 | ❌ 不唤醒 | `runtime-types.ts:262-270` |

```ts
// packages/core/agent/src/runtime-types.ts:246-251
    /**
   * Queue an ordinary follow-up turn and wake the driver. The item becomes the
   * sole ordinary message of its own turn.
   * @param message - identified prompt content and the source that supplied it.
   */
    followup(message: UserMessage): void
```

```ts
// packages/core/agent/src/runtime-types.ts:262-270
    /**
   * Queue model-facing context for the next pre-step without waking the
   * driver. A running driver claims it at the nearest later step boundary;
   * idle drivers leave it pending until follow-up or steering
   * wakes them. It may miss a request whose pre-step already claimed its
   * batch. Cancellation or disposal may discard pending context.
   * @param message - identified injected context and the source that supplied it.
   */
    inject(message: UserMessage): void
```

⇒ 记忆写入**只用 `session/event` 或 `agent/turn-stopping` 里的纯写入**，`followup` 只留给"夜间巩固完成后主动汇报"这类真正需要模型说话的场合。

---

## 4. 命令注册

### 4.1 注册 API

```ts
// packages/interaction/commands/src/index.ts:280-292
   * @returns the exact effect disposer that unregisters this definition.
   */
  register(definition: CommandDefinition): () => void {
    const registered = normalizeDefinition(definition)
    return this.layers.effect(
      this.ctx,
      layer => layer.commands.insert(registered.definition.name, registered),
      { label: 'commands.register()' },
    )
  }
```

- 返回 `() => void`，`ctx.effect` 绑定，插件卸载自动注销。
- 服务名 `commands`，定义在 `packages/interaction/commands/src/index.ts:277`（`super(ctx, 'commands')`）。

### 4.2 `CommandDefinition` 逐字类型

```ts
// packages/interaction/commands/src/index.ts:41-58
/** One parsed command submission ... */
export interface CommandInvocation {
  commandId: CommandId
  agent: Agent
  rawInput: string
  attachments: readonly (ImageBlock | FileBlock)[]
  signal: AbortSignal
}
```

```ts
// packages/interaction/commands/src/index.ts:60-78
export interface CommandDefinition {
  definitionId?: CommandDefinitionId
  name: string
  description: string
  input?: CommandInputDescriptor
  recordInput?: boolean
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}
```

```ts
// packages/interaction/commands/src/types.ts:20-31
export interface CommandInputDescriptor {
  /** Placeholder text shown after the command name; must be non-empty. */
  hint: string
  /** Whether the composer accepts image/file attachments for this command. */
  attachments?: boolean
}
```

```ts
// packages/interaction/commands/src/types.ts:34-41
export type CommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: SessionSeq }
  | { kind: 'error'; text: string }
```

### 4.3 校验规则（`normalizeDefinition`）

```ts
// packages/interaction/commands/src/index.ts:178-209（节选）
function normalizeDefinition(definition: CommandDefinition): RegisteredCommand {
  if (!COMMAND_NAME.test(definition.name)) {
    throw new TypeError(`command name "${definition.name}" must match ${COMMAND_NAME}`)
  }
  if (typeof definition.description !== 'string') { throw new TypeError(...) }
  ...
  if (typeof definition.handler !== 'function') { throw new TypeError(...) }
  ...
```

```ts
// packages/interaction/commands/src/index.ts:38
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u
```

⇒ 命令名必须**小写字母开头**，只含 `a-z0-9_-`。`/memory` 合法。

### 4.4 有没有子命令机制？

**没有。** `parseCommand` 只把一行拆成「命令名 + 剩余原文」：

```ts
// packages/interaction/commands/src/index.ts:125-132
export function parseCommand(line: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  /* v8 ignore next -- the first capture is required whenever the regular expression matches */
  if (name === undefined) return undefined
  return Object.freeze({ name, rawInput: line.slice(match[0].length) })
}
```

⇒ 子命令（`/memory health`、`/memory rebuild`）必须由 `handler` 自己解析 `invocation.rawInput`。

### 4.5 完整真实示例

```ts
// packages/goal/command-goal/src/index.ts:16-17
export const name = 'command-goal'
export const inject = ['commands', 'goals']
```

```ts
// packages/goal/command-goal/src/index.ts:190-198
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'),
    name: 'goal',
    description: 'Set or view the goal for a long-running task',
    input: { hint: '[<objective>|clear|edit <objective>|pause|resume]', attachments: true },
    handler: invocation => executeGoalCommand(ctx, invocation),
  })
}
```

⇒ 注意 `input.hint` 里用 `|` 列出子命令，但**解析是 handler 自己的事**。

另一个（关掉输入记录）：

```ts
// packages/feedback/command-feedback/src/index.ts:116-128（节选）
  ctx.commands.register({
    ...
    recordInput: false,
    handler: executeFeedbackCommand,
  })
```

---

## 5. 存储

### 5.1 `defineDomain` 的精确签名

```ts
// packages/storage/storage-domain/src/spec.ts:34-72
/** Static declaration of one domain: identity, version, and record layout. */
export interface DomainSpec {
  /** Domain name; must match `UNIT_NAME_RE` (doubles as the backend unit name). */
  readonly name: string
  /** Current domain format version; reads enforce it according to the selected layout. */
  readonly version: number
  /**
   * Document layout for the backend unit: `single` (the default) stores the
   * whole unit as one document; `per-record` stores each record as its own
   * document, ...
   */
  readonly layout?: 'single' | 'per-record'
  /**
   * Older domain versions whose stored records the current record schemas
   * also accept ...
   */
  readonly compatibleVersions?: readonly number[]
  ...
  readonly invalidRecords?: 'backup-and-skip'
  /** Optional global singleton slot. */
  readonly global?: DomainGlobalSpec<unknown>
  /** Table declarations keyed by table name; each name must match `UNIT_NAME_RE`. */
  readonly tables: Record<string, DomainTableSpec>
}
```

```ts
// packages/storage/storage-domain/src/spec.ts:12-17
export interface DomainGlobalSpec<G> {
  /** Schema validating the stored global. */
  schema: ZodType<G>
  /** Value returned before the first durable write. */
  initial: G
}
```

```ts
// packages/storage/storage-domain/src/spec.ts:23-32（节选）
export interface DomainTableSpec<K extends string = string, V = unknown> {
  /** Schema validating every stored record of this table. */
  valueSchema: ZodType<V>
  /** Phantom key carrier; never read at runtime. */
  __key?: K
}
```

```ts
// packages/storage/storage-domain/src/spec.ts:86-93
/**
 * Declare one table.
 * @param schema - zod schema validating every stored record of this table.
 * @returns the table declaration, key-typed by `K`.
 */
export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}
```

```ts
// packages/storage/storage-domain/src/spec.ts:96-107
/**
 * Identity helper that pins a spec's literal types and validates its fields.
 * Misconfiguration fails loud at the owning package's module load, before any
 * medium is touched: a domain or table name outside `UNIT_NAME_RE`, a version
 * that is not a non-negative integer, or a global schema that accepts `null`
 * all throw. ...
 * @param spec - The domain declaration.
 * @returns the same spec, narrowed to its literal type.
 */
export function defineDomain<S extends DomainSpec>(spec: S): S {
```

**关键点**：`defineDomain` 是**恒等函数**（返回同一个 spec），作用是**在模块加载期做校验并钉住字面量类型**。校验失败直接抛错，不会等到打开时才失败。

### 5.2 记录 schema 用 zod，插件 Config 用 schemastery

这是**两套不同的库**，绝不能混：

| 用途 | 库 | 导入 | 证据 |
|---|---|---|---|
| 存储记录 schema | **zod** | `import { z } from 'zod'` | `packages/schedule/schedule/src/storage.ts:4` |
| 插件 `Config` | **schemastery** | `import z from '@deepseek-ai/schemastery'` | `packages/schedule/schedule/src/index.ts:4` |

```ts
// packages/schedule/schedule/src/storage.ts:1-9
/** Durable Host-wide Schedule tasks, independently of Session activation. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeScheduleRecord } from './domain.ts'
import type { ScheduleDeliveryRecord, ScheduleId, ScheduleRecord, ScheduleTarget } from './types.ts'
```

### 5.3 真实 domain 定义

```ts
// packages/schedule/schedule/src/storage.ts:133-137
/** Authoritative Host tasks retain their domain, backend routing, and envelope; v2 also reads v1 without startup writes. */
export const scheduleDomain = defineDomain({
  name: 'schedule', version: 2, compatibleVersions: [1],
  tables: { tasks: domainTable<ScheduleId, ScheduleTask>(scheduleTaskSchema) },
})
```

带 `global` 的例子：

```ts
// packages/workspace/workspace/src/spec.ts:76-84（节选）
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 2,
  global: {
    schema: workspaceDomainState,
    initial: { ... },
  },
  tables: {
    workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord),
  },
})
```

带 `layout` + `invalidRecords` 的例子：

```ts
// packages/session/session-projection-cache/src/spec.ts:100-107（节选）
export const projectionCacheDomain = defineDomain({
  name: 'session_projcache',
  version: 7,
  compatibleVersions: [3, 4, 5, 6],
  invalidRecords: 'backup-and-skip',
  layout: 'per-record',
  tables: { sessions: domainTable<SessionId, ProjectionCacheRecord>(projectionCacheRecord) },
})
```

### 5.4 `ctx.storageDomain.open(spec)` 返回什么

```ts
// packages/storage/storage-domain/src/index.ts:86-105（节选）
   * name that is already open (`already-open`); resolve the backend route
  ...
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.domains.has(spec.name) || this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
```

`reserved` 的语义：

```ts
// packages/storage/storage-domain/src/index.ts:69-72
class DomainFacility {
  ...
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()
```

⇒ **同名 domain 全进程只能开一次**。多 persona / 多 agent 隔离必须在**表内按 key 分区**，不能靠"每个 agent 开一个 domain"。

`Domain` 接口：

```ts
// packages/storage/storage-domain/src/domain.ts:114-137
/** One open domain, typed by its spec. */
export interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}
```

### 5.5 `table(name)` 提供什么（精确方法签名）

```ts
// packages/storage/storage-domain/src/domain.ts:43-108
export interface KvTable<K extends string, V> {
  /**
   * Read one record, synchronously from memory.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: K): V | undefined

  /**
   * Snapshot iterator over `[key, record]` pairs. A snapshot, not a live
   * view: iteration stays stable while queued writes land.
   * @returns the pair iterator.
   */
  entries(): IterableIterator<[K, V]>

  /**
   * Snapshot iterator over keys.
   * @returns the key iterator.
   */
  keys(): IterableIterator<K>

  /** Current record count. */
  readonly size: number

  /**
   * Insert or overwrite one record durably.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * ...
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case).
   */
  delete(key: K): Promise<boolean>

  /**
   * Delete several records durably in one write slot.
   * ...
   */
  deleteMany(keys: readonly K[]): Promise<number>

  /**
   * Atomic read-modify-write on the domain's write chain: `fn` sees the
   * value current at its queue slot, so concurrent updates never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}
```

**读写不对称**：`get` / `entries` / `keys` / `size` **同步读内存**；`put` / `delete` / `deleteMany` / `update` **异步写盘**。

写入顺序契约：

```ts
// packages/storage/storage-domain/src/domain.ts:1-11（节选）
 * FIRST, then mutates memory, then emits `domain/changed` — a rejected
```

⇒ **先落盘 → 再改内存 → 再发 `domain/changed` 事件**。所以 `put()` 的 Promise resolve 时，数据已经在盘上了。

`domain/changed` 的发出点：

```ts
// packages/storage/storage-domain/src/domain.ts:273
      this.ctx.emit('domain/changed', change)
```

全局槽：

```ts
// packages/storage/storage-domain/src/domain.ts:20-36
export interface DomainGlobal<G> {
  /**
   * Current value, synchronously from the authoritative in-memory state.
   * Before the first `set` this is the spec's `initial`.
   * @returns the current global value.
   */
  get(): G

  /**
   * Replace the value durably. Queued on the domain's write chain; the first
   * `set` is what materializes the global on the medium.
   * @param value - New value; must satisfy the spec's schema (not re-checked
   * here — validation happens at the durable read boundary).
   * @returns resolution after durability and event emission.
   */
  set(value: G): Promise<void>
}
```

### 5.6 生命周期接线范式

```ts
// packages/workspace/workspace/src/index.ts:194-204
  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  /** Open the domain, finish bootstrap when required, and rebuild the ordered cache. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(workspaceDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'workspace.domainClose')
    this.table = domain.table('workspaces')
    this.global = domain.global
    this.state = domain.global.get()
```

⇒ **`open()` → 立刻挂 `ctx.effect(() => () => domain.close())` → 取句柄缓存到字段**。`domain.close()` 的所有权在使用方（L131-133 注释明确说了）。

### 5.7 落盘路径

base bundle 的存储三行：

```yaml
# packages/bundle/base/cordis.patch.yml:175-190
    # Durable KV storage: the storage hub, the json backend, and the
    # schema-validated domain form over them. Session-layer persistence (the
    # projection cache below; workspace in web layers)
    # routes through this stack, so it belongs to the shared base.
    - id: storage
      name: '@deepseek-ai/dsh-storage'

    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')

    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

`dshHomePath` 的定义：

```ts
// packages/util/home-paths/src/index.ts:160-162
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}
```

⇒ 默认根目录是 **`$DSH_HOME/storages`**（本机实测 `~/.dsh/storages`）。

文件布局由 backend 的 `openUnit` 决定：

```ts
// packages/storage/storage-json/src/index.ts:64-80（节选）
  async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    ...
    return descriptor.layout === 'per-record'
      ? openPerRecordUnit(descriptor, this.root, onClose)
      : openSingleUnit(descriptor, this.root, onClose)
  }
```

per-record 的具体路径：

```ts
// packages/storage/storage-json/src/per-record-unit.ts:57
    return new PerRecordJsonUnit(descriptor, join(root, descriptor.name), onClose)
```

```ts
// packages/storage/storage-json/src/per-record-unit.ts:153
    return join(dir, table, `${key}.json`)
```

```ts
// packages/storage/storage-json/src/per-record-unit.ts:320
      const file = join(this.dir, 'global.json')
```

⇒ **`layout: 'per-record'`** → `storages/<domainName>/<tableName>/<key>.json` + `storages/<domainName>/global.json`
⇒ **`layout: 'single'`（默认）** → `storages/<domainName>.json`

本机实测目录印证了这一点（`~/.dsh/storages/session_projcache/sessions/<uuid>.json`、`~/.dsh/storages/workspace.json`）。

**怎么改路径**：不要改插件代码，改 patch 里 `storage-json` 行的 `root`。本系统 `cordis.patch.yml` 里写的 `storage.dataDir` 只影响**插件自己的**目录，与 storage domain 的 `root` 是两套路径——这一点需要在实现时统一（见 §8.7）。

---

## 6. 定时器

### 6.1 `ctx.timeout` / `ctx.interval` 的精确签名

```ts
// vendor/timer/src/index.ts:28-30
  /** Run a callback once, or return a promise that resolves after `delay`. */
  timeout(callback: () => void, delay: number): () => void
  timeout(delay: number): Promise<void>
```

```ts
// vendor/timer/src/index.ts:56-58
  /** Run a callback repeatedly, or return an async iterator of ticks. */
  interval(callback: () => void, delay: number): () => void
  interval<R = any>(delay: number): AsyncIterableIterator<void, R, void>
```

两种调用形态：

| 形态 | 返回 | 用途 |
|---|---|---|
| `ctx.interval(cb, delay)` | `() => void` 清理器 | 周期性任务（本系统的巩固轮询） |
| `ctx.interval(delay)` | `AsyncIterableIterator<void>` | `for await` 循环 |

### 6.2 是否随插件生命周期自动清理？

**是。** 两个方法的实现都包在 `ctx.effect` 里：

```ts
// vendor/timer/src/index.ts:31-42
  timeout(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() : undefined
    const delay = args[0] as number
    if (callback) {
      const dispose = this.ctx.effect(() => {
        const timer = setTimeout(() => {
          dispose()
          callback()
        }, delay)
        return () => clearTimeout(timer)
      }, 'ctx.timeout()')
      return dispose
```

```ts
// vendor/timer/src/index.ts:59-62（节选）
  interval(...args: any[]): any {
    const callback = typeof args[0] === 'function' ? args.shift() : undefined
    const delay = args[0] as number
    if (callback) {
      const dispose = this.ctx.effect(() => {
        ...
      }, 'ctx.interval()')
```

⇒ 插件 fiber 卸载时，定时器自动 `clearTimeout` / `clearInterval`。**不需要**手动清理，但保留返回值可以在插件内提前停止。

`ctx.effect` 的 LIFO 清理顺序见 `vendor/cordis/src/fiber.ts:430-448`。

### 6.3 `ctx.schedule` 的 API

服务名 `schedule`（`packages/schedule/schedule/src/index.ts:248`），依赖声明：

```ts
// packages/schedule/schedule/src/index.ts:224
  static inject = ['agents', 'sessions', 'storageDomain', 'sessionPersistence']
```

创建任务：

```ts
// packages/schedule/schedule/src/index.ts:381-407（节选）
  async create(
    request: ScheduleCreateRequest,
    actorSessionId?: SessionId,
    signal?: AbortSignal,
  ): Promise<ScheduleCatalogEntry> {
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    const record = createScheduleRecord(id, request.title, request.prompt, request.timing, now)
    const target = await this.resolveTarget(request.target ?? { kind: 'new_once' }, signal)
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      await this.validateTarget(target, signal)
      signal?.throwIfAborted()
      const createdAt = new Date(now).toISOString()
      const task = scheduleTaskSchema.parse({ ... })
      await domain.table('tasks').put(id, task)
      this.emitChanged()
      this.runtime?.requestDrive()
      this.queueNotification(task, actorSessionId, 'created')
      return this.entry(task)
    })
  }
```

⇒ 定时任务的持久化直接落在 `schedule` domain 的 `tasks` 表（见 §5.3 的 `scheduleDomain`）。**本系统不需要自建定时器表**——但要判断：用宿主 `schedule` 还是用 `ctx.interval`。

| 方案 | 适合 | 代价 |
|---|---|---|
| `ctx.interval` | 进程内周期任务（巩固轮询） | 进程退出即失效；不跨 session |
| `ctx.schedule` | 需要跨进程存活、按 cron 触发、能唤醒 Agent | 必须走 `ScheduleService` 的完整目标/投递语义 |

### 6.4 如何用 `followup()` 在到期时唤醒 Agent

权威配方在 schedule 的投递实现里：

```ts
// packages/schedule/schedule/src/runtime.ts:348-360
  /**
   * Enqueue one reminder and wait for Session persistence to acknowledge it.
   * The held tasks hold their slots from the enqueue; a failure releases them.
   */
  private async send(agent: Agent, text: string, held: readonly ScheduleId[]): Promise<SentReminder> {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'schedule' } })
    for (const id of held) this.executing.add(id)
    try {
      agent.followup(message)
      // Capture the activity immediately after wakeup. Waiting for durable flush
      // can miss the whole lifecycle of a fast target Agent.
      const execution = held.length > 0 ? agent.whenIdle() : undefined
      const flushed = await this.ctx.sessions.flush(agent.session)
```

**四步配方**：

1. `createUserMessage({ content: [{ type: 'text', text }], source: { kind: '<你的来源>' } })` —— 必须带自定义 `source.kind`，并在自己的模块里做声明合并（`packages/schedule/schedule/src/runtime.ts:7`）。
2. `agent.followup(message)` —— 唤醒驱动。
3. `agent.whenIdle()` —— 在唤醒后**立即**捕获活动（不要等 flush，会漏掉快速 Agent 的整个生命周期）。
4. `await ctx.sessions.flush(agent.session)` —— 等持久化确认。

`flush` 的签名：

```ts
// packages/core/session/src/index.ts:1337-1342
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  async flush(session: Session): Promise<boolean> {
```

`createUserMessage` 的定义：

```ts
// packages/llm/llm/src/message.ts:246-253
export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}
```

### 6.5 用 `inject()` 在到期时"不唤醒"地补上下文

如果巩固完成但**不需要模型说话**（只是让下一次对话知道"昨晚整理过了"），用 `agent.inject(message)`：排队到下一个 pre-step，不唤醒驱动（`runtime-types.ts:262-270`）。

---

## 7. 参考插件骨架

### 7.1 为什么选这几个

本系统需要四个能力同时成立：**每轮注入 + 事件订阅 + 存储 + 定时**。宿主里没有一个插件四个全占，但每个能力都有最贴近的第一方实现：

| 能力 | 参考插件 | 关键文件 |
|---|---|---|
| 每轮注入 + `Config` + `prepend` | `packages/context/time-context/` | `src/index.ts`（244 行） |
| Agent 级作用域注册 + 生命周期 | `packages/context/file-reference-local/` | `src/index.ts`（144 行） |
| `next()` 之后改消息 | `packages/context/agent-instructions/` | `src/index.ts`（375 行） |
| 存储 domain + `Service.init` | `packages/workspace/workspace/` | `src/index.ts`、`src/spec.ts` |
| 存储 + 定时唤醒 + 命令 | `packages/schedule/schedule/` | `src/index.ts`（803 行）、`src/runtime.ts`、`src/storage.ts` |

### 7.2 `time-context` 的完整接线模式（最贴近本系统）

**完整源文件清单**：

- `packages/context/time-context/src/index.ts`（244 行，插件入口）
- `packages/context/time-context/src/request-zone.ts`（96 行）
- `packages/context/time-context/src/timestamp.ts`（37 行）
- `packages/context/time-context/package.json`
- `packages/context/time-context/README.md`

**插件头**：

```ts
// packages/context/time-context/src/index.ts:33
export const name = 'time-context'
```

```ts
// packages/context/time-context/src/index.ts:49
export const inject = ['agents', 'sessionProjections']
```

```ts
// packages/context/time-context/src/index.ts:133
export async function apply(ctx: Context, config: Config): Promise<void> {
```

**它没用 `context()`，用的是 `agent/pre-step` 追加消息**——因为时间戳需要按 step 计算，且要能"每 N 分钟才注入一次"。

**它注册了一个 projection（投影）来记住状态**：

```ts
// packages/context/time-context/src/index.ts:157-193（节选）
    ctx.sessionProjections.register({
      key: 'timeContext',
      stateVersion: 3,
      stateSchema,
      init,
      apply: (state, event) => { ... },   // 折叠 turn/start, turn/end, user/message, assistant/message, tool/result
    })
```

**它的 pre-step 监听器**：

```ts
// packages/context/time-context/src/index.ts:199-242（节选）
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const timeContextProjectionHandle = await projectionReady
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    ...
    return { ...decision, messages: [...decision.messages, createUserMessage({ ... })] }
  }, { prepend: true })
```

**它自己声明了消息来源**：

```ts
// packages/context/time-context/src/index.ts（模块级 declare module）
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'time-context': { kind: 'time-context' } & ContextFormed
  }
}
```

### 7.3 `file-reference-local` 的 Agent 级作用域模式

```ts
// packages/context/file-reference-local/src/index.ts:67-79
    const installPrompt = (agent: Agent): ReturnType<Context['inject']> => {
      const existing = this.promptFibers.get(agent)
      if (existing !== undefined) return existing
      const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
        scope.systemPrompt.section({
          name: 'context:file-reference',
          order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
          text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
        })
      })
      this.promptFibers.set(agent, fiber)
      return fiber
    }
```

```ts
// packages/context/file-reference-local/src/index.ts:95-106（节选）
  ctx.on('agent/created', async ({ agent }) => { await installPrompt(agent) })
  ...
  ctx.on('agent/disposed', ...)
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result') return
    ...
  })
```

⇒ **`agent.ctx.inject(...)` 让注册落在该 Agent 的 scope 层**，天然按 agent 隔离；配合 `agent/created` / `agent/disposed` 做安装/卸载。

### 7.4 综合骨架（本系统的目标形态）

```ts
// 目标形态：综合 time-context（pre-step + Config）、file-reference-local（agent 作用域）、
// workspace（storage domain + Service.init）、schedule（followup 唤醒）四处证据的接线骨架。
// 每行注释标出证据位置。

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

export const name = 'memory'                       // registry.ts:100
export const inject = ['systemPrompt', 'storageDomain', 'commands', 'timer']  // registry.ts:104

export interface Config {
  dataDir: string
  consolidation: { enabled: boolean; dailyAt: string }
}

export const Config: z<Config> = z.object({         // time-context:60-63 同构
  dataDir: z.string().default('.dsh-memory'),
  consolidation: z.object({
    enabled: z.boolean().default(true),
    dailyAt: z.string().default('03:30'),
  }),
})

export async function apply(ctx: Context, config: Config): Promise<void> {  // harness-dev-context:122
  // 1) 打开存储 domain；立刻挂 close 清理器（workspace:199-204）
  const domain = await ctx.storageDomain.open(memoryDomainSpec)
  ctx.effect(() => () => domain.close(), 'memory.domainClose')
  const cards = domain.table('cards')
  const state = domain.global

  // 2) 每轮注入：同步读内存，绝不在这里做 IO（system-prompt:78-90 / 386-393）
  const disposeContext = ctx.systemPrompt.context({
    name: 'memory:focus-pack',
    order: 300,                                    // 高于 CONTEXT_ORDERS 最高值 210
    interpolate: false,
    text: (context) => {
      const agent = context.agent
      if (agent === undefined) return ''           // user-approval:196 同构兜底
      return renderFocusPack(cards, agent.session.id)
    },
  })
  // 返回值是 ctx.effect 清理器；插件卸载时自动执行，无需手动 dispose（system-prompt:520-529）

  // 3) 事件订阅：post-commit、fire-and-forget，读历史与助手回复（session:65-76）
  ctx.on('session/event', (session: Session, event) => {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') return   // 排除合成上下文（session/types:308-315）
      enqueueWrite(session, event.data)
      return
    }
    if (event.type === 'assistant/message') {
      enqueueWrite(session, event.data.message)
      return
    }
    if (event.type === 'compaction/summary') {
      // 用 shadowedSeqs 回填被压缩掉的范围（compaction/types:25-53）
      enqueueCompaction(event.data.shadowedSeqs)
    }
  })

  // 4) turn 收尾：只入队，不 steer（runtime-types:400-417）
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    await flushQueue(agent.session.id)               // 落盘但不 steer
  })

  // 5) 命令：子命令自己解析 rawInput（commands:125-132 / 285-292）
  ctx.commands.register({
    name: 'memory',
    description: 'Inspect and maintain the memory store',
    input: { hint: '[status|health|rebuild]' },
    handler: (invocation) => runMemoryCommand(ctx, invocation),
  })

  // 6) 巩固轮询：ctx.effect 绑定，随插件卸载自动清理（timer:56-62）
  if (config.consolidation.enabled) {
    ctx.interval(() => { void consolidateOnce(ctx) }, CONSOLIDATION_POLL_MS)
  }

  // 7) 定时唤醒（仅在确实需要模型说话时）：followup + whenIdle + flush
  //    agent.followup(createUserMessage({ ... }))
  //    const execution = agent.whenIdle()
  //    await ctx.sessions.flush(agent.session)     // schedule/runtime.ts:352-360
}

declare function renderFocusPack(cards: unknown, sessionId: unknown): string
declare function enqueueWrite(session: Session, message: unknown): void
declare function enqueueCompaction(seqs: readonly unknown[]): void
declare function flushQueue(sessionId: unknown): Promise<void>
declare function consolidateOnce(ctx: Context): Promise<void>
declare function runMemoryCommand(ctx: Context, invocation: unknown): Promise<unknown>
declare const memoryDomainSpec: never
declare const CONSOLIDATION_POLL_MS: number
```

---

## 8. 与本系统设计的差异（哪些设计假设被推翻 / 需要修正）

> 本节逐条比对 `docs/2-DSH宿主约束.md`、`docs/3-架构设计.md`、以及已写好的 `src/index.ts` / `src/host/adapter.ts`。

### 8.1 【必须修正】`order` 取值：130 不是"之后"，而是"中间"

**文档主张**（`docs/2-DSH宿主约束.md:40`）：

> 排序：sections 按 order 升序 + name 次序；contexts 只按 order 升序。第一方 context 占用 110/115/120，本系统取 130 之后。

**源码事实**（`packages/core/system-prompt/src/index.ts:177-186`）：第一方 context 实际占用 **100 / 110 / 115 / 120 / 125 / 200 / 210** 七个值。

**问题**：

1. 文档的清单**漏了 100（WORKING_DIRECTORY）、125（TEAM_IDENTITY）、200（HARNESS_SOURCE）、210（WEB_SURFACE）**。
2. `130` 确实大于 125，但**小于 200 和 210** ⇒ 记忆快照会插在 `TEAM_IDENTITY` 之后、`HARNESS_SOURCE` / `WEB_SURFACE` 之前。功能上不算错（顺序无对错），但文档"取 130 之后"的说法暗示 130 已经是末位，这是**错的**。

**代码现状**：

- `src/index.ts:43`：`const CONTEXT_ORDER = 130`
- `src/host/adapter.ts:179-180`：注释写「order 取 130 之后 —— 第一方 context 占用 110/115/120」
- `src/host/adapter.ts:185`：`@param order - 排序值，建议 ≥ 130`

**建议改法**（三选一）：

1. 取 **300**（> 210），让记忆快照排在所有第一方 context 之后；
2. 取 **负数或 0 以下**，让记忆快照排在最前面（如果希望模型先看到记忆）；
3. 在 `CONTEXT_ORDERS` 里加一个具名常量（需要改宿主，**不可行**）。

**推荐方案 1**，并把 `src/host/adapter.ts:179-185` 的注释与 `src/index.ts:43` 一起改。

### 8.2 【必须修正】`text()` 只能是同步函数，不能做 IO

**文档主张**（`docs/3-架构设计.md:139`）：

> **压缩后自愈**（FR-E4）：`context()` 的 `text` 是每轮重新求值的函数，压缩清空历史后它会自动重新物化，不需要手动重放（待验证项 V-1）。

"每轮重新求值"是**对的**，"自动重新物化"也是**对的**。但文档**没有说 `text` 必须同步**。

**源码事实**：

- `PromptContext.text` 类型是 `string | ((context: AssembleContext) => string)`（`packages/core/system-prompt/src/index.ts:85`）——**没有 `Promise`**。
- 求值处 `resolveContext` 是同步函数，没有 `await`（`packages/core/system-prompt/src/index.ts:386-393`）。

**对本系统的后果**：

- 记忆召回如果要在 `text()` 里查索引 / 读盘 ⇒ **不可行**。
- 必须改成「预热 + 同步读缓存」两段式：
  - `agent/pre-step`（或 `session/event`）里异步算好焦点包，写进 `Map<SessionId, string>`；
  - `text()` 只做 `map.get(sessionId) ?? ''`。
- 这也意味着**焦点包的计算时机是 step 边界，不是 `text()` 调用时**。需要在 `docs/3` 的数据流图里改正。

**代码现状**：`src/index.ts:222` 的 `registerDynamicContext(ctx, CONTEXT_NAME, CONTEXT_ORDER, makeFocusPackRenderer(engine), ...)` 需要确认 `makeFocusPackRenderer` 返回的是**纯同步函数**。若它内部 `await` 了，会编译不过（这是好事，类型会挡住）。

### 8.3 【已解除】V-1：压缩后确实会自动重新物化

**文档主张**（`docs/2-DSH宿主约束.md:100`、`docs/3-架构设计.md:207`）：

> ③ 压缩后 `context()` 快照会自动重新物化，不需要手动重放。
> V-1 | `context()` 压缩后是否自动重新追加 | 若不然，在压缩事件里显式重建焦点包

**源码事实**：证据链完整，见本文 §2.5。三个环节：

1. `agent.ts:294` 每个 step 前 `assemble()` → 重新执行 `text()`。
2. `agent.ts:446-450` 每个请求尝试前 `refreshContext()` → 再次执行 `text()`。
3. `runtime-context.ts:139-147` 压缩的 surface 替换事件把 `retained` 置 `null` → `runtime-context.ts:157-168` 下次 `project()` 必然返回新快照。

**结论**：**V-1 关闭，不需要"在压缩事件里显式重建焦点包"**。

**但有一个前提**：`text()` 必须读**当前内存状态**。如果实现里把焦点包缓存在一个不随压缩失效的闭包里，重新求值也拿不到新内容。`src/index.ts` 里 `makeFocusPackRenderer(engine)` 传的是 `engine` 对象本身（而非快照），只要 `engine.recall()` 每次都读最新状态就满足。

### 8.4 【必须修正】`session.eventAt` / `snapshotEvents` 已废弃

**文档未提及**。源码事实：

```ts
// packages/core/session/src/index.ts:714-716
  /** @deprecated New calls are prohibited; use the surface or the append feed. */
  eventAt(seq: SessionSeq): SessionEvent | undefined {
```

```ts
// packages/core/session/src/index.ts:728-741
  /** @deprecated New calls are prohibited; ... */
  snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq): SessionEvent[] {
```

**代码现状**：`src/index.ts` 的 `readTurnText(agent, turn)` 就是「从 `session.seq - 1` 往回扫 `session.eventAt(seq)`」——这**直接违反** `@deprecated` 约束。

**建议改法**：

- 改用 `session/event` 订阅，在事件到达时累积「本轮用户说了什么」（见本文 §3.5 的可运行片段）；
- 或在 `agent/pre-step` 的 `messages` 载荷里拿（只有本次 step 拟进入的消息，不含历史，适合"最新一条用户输入"）；
- 若确实需要历史，用 `session.surface.nodes` + 事件缓存，而不是 `eventAt` 回溯。

### 8.5 【需重新表述】V-3：`agent/pre-step` 多监听器顺序

**文档主张**（`docs/2-DSH宿主约束.md`，V-3 行）：

> V-3 | `agent/pre-step` 多监听器顺序 | 本系统只注册一个 pre-step 监听器

**源码事实**：光"只注册一个"不够，因为**别的插件也在注册**，而且它们的位置不同：

| 插件 | 相对 `next()` 的位置 | 证据 |
|---|---|---|
| `compaction-basic` | **之前** | `packages/compaction/compaction-basic/src/index.ts:157-175` |
| `time-context` | **之后** + `prepend: true` | `packages/context/time-context/src/index.ts:199-242` |
| `agent-instructions` | **之后** | `packages/context/agent-instructions/src/index.ts:330-356` |

**对本系统的后果**：

- 如果本系统在 `next()` **之前**跑并改 `messages`，压缩还没发生 ⇒ 拿到的是压缩前的消息。
- 如果本系统在 `next()` **之后**跑，压缩已经发生 ⇒ 拿到的是压缩后的消息。
- `prepend: true` 会把自己的监听器排到最前。

**建议**：本系统**不注册 `agent/pre-step`**，只用 `context()` + `session/event`。这样完全绕开顺序问题，V-3 从"待验证"变成"不适用"。

### 8.6 【需澄清】patch 的 `config` 是整块替换，不是深合并

**代码现状**：`cordis.patch.yml` 的注释写：

> config 里的字段会深合并到 `src/core/config.ts` 的 DEFAULT_CONFIG 之上

**源码事实**（`packages/bundle/base/cordis.patch.yml:6-7`）：

> A patch replaces the targeted row's whole `config` rather than merging into it

**准确的表述应该是**：

- **patch 层**：`config` 整块替换那一行的配置。
- **插件内**：`apply(ctx, config)` 收到的 `config` 已经过 `Config`（schemastery）校验，`.default()` 会把缺省字段补齐。
- **再往下**：`resolveConfig()` 把 schemastery 补齐后的 config 深合并到 `DEFAULT_CONFIG` 之上——这一层是**本仓库自己实现的**，不是宿主行为。

所以注释没错，但容易让人误以为是宿主做的合并。建议改成「schemastery 补齐缺省字段，`resolveConfig()` 再深合并到 `DEFAULT_CONFIG`」。

### 8.7 【需统一】存储路径有两套，需要对齐

**现状**：

- `cordis.patch.yml` 里写 `storage.dataDir: .dsh-memory`（插件自己的配置）。
- 宿主的 storage domain 根目录由 `storage-json` 行的 `root: !!js dshHomePath('storages')` 决定（`packages/bundle/base/cordis.patch.yml:182-185`），默认 `$DSH_HOME/storages`。

**问题**：如果本系统用 `ctx.storageDomain`，数据实际落在 `$DSH_HOME/storages/memory/...`，**不是** `.dsh-memory`。`config.storage.dataDir` 就变成了死字段。

**两种解法**（需要选一个并写进 `docs/3`）：

1. **走 storage domain**：删掉 `dataDir`，接受 `$DSH_HOME/storages/memory/`；或在 `cordis.patch.yml` 里覆盖 `storage-json` 的 `root`（会影响所有 domain，**不推荐**）。
2. **不走 storage domain**：用 `node:fs` 自己写 `.dsh-memory`，放弃宿主的事务/版本/`domain/changed` 能力。

`docs/2-DSH宿主约束.md:103-118` 的"可复用插件表"暗示应该走 storage domain；`docs/3-架构设计.md` 的 `dataDir` 设计暗示走 fs。**这个矛盾必须先解决**。

### 8.8 【补充】`apply` 可以是 `async`，文档的最小形态没说

**文档主张**（`docs/2-DSH宿主约束.md:21-28` 的最小形态）用了同步 `apply`。

**源码事实**：`apply` 返回类型是 `void | Promise<void>`（`vendor/cordis/src/registry.ts:121`），第一方大量使用 `async apply`（`harness-dev-context:122`、`time-context:133`、`storage-domain:217`）。

**影响**：本系统必须 `await ctx.storageDomain.open(...)`，所以**必须是 async `apply`**。文档的最小形态需要更新。

### 8.9 【补充】`inject` 的服务名必须在当前 profile 里真的被 provide

**源码事实**：`inject` 的语义是「等这些服务可用后再加载」（`vendor/cordis/src/registry.ts:104`、`vendor/cordis/src/fiber.ts:236-260`）。

**对本系统的后果**：

- 写 `inject = ['systemPrompt', 'storageDomain', 'commands', 'timer']`，意味着这四行必须都在当前 profile 的 Cordis 树里。
- base bundle 提供 `systemPrompt`（`base/cordis.patch.yml:509-512`）、`storageDomain`（`:187-190`）、`commands`（`:320-321`）、`timer`（`:24-26`）⇒ **四个都在 base 里，安全**。
- 但 `schedule` 只在 web-app bundle 里（`packages/bundle/web-app/cordis.patch.yml:135-136`），**headless / sdk profile 没有**。若 `inject` 里写 `'schedule'`，在那些 profile 下插件**永远不会加载**。

**建议**：`inject` 只列 base 保证有的四个；`schedule` 用 `ctx.inject(['schedule'], cb)` 做可选降级。

### 8.10 【确认】"不要 steer" 与 C5 都与宿主一致

**`docs/2-DSH宿主约束.md:64`**：

> 用 `agent/turn-stopping`（串行，可 steer；写记忆时不要 steer，否则会强制多跑一步）

**源码确认**：`runtime-types.ts:401-405` 明确写了 listener steer 会导致「fresh steering runs another step」；`runtime-types.ts:253-260` 定义了 `steer` 的语义。**这条文档是对的**，本文 §3.7 给出了完整引用。

**`AGENTS.md` 的 C5（不写自定义 session 事件）**：

**源码确认**：宿主确实有 `commitPluginRecord` / `appendPluginRecord`（`packages/core/session/src/index.ts:474-499`），但注释明确限制调用方：

```ts
// packages/core/session/src/index.ts:480（doc 节选）
 * Only production source under `packages/experimental/` may call this function; the `verify-plugin-record-callers` gate rejects any other production caller
```

⇒ **本仓库的 C5 与宿主约束一致**，而且宿主的门禁会强制检查。

---

## 9. 最小可运行接线代码

### 9.1 `src/index.ts`

> **阅读提示**：下面的 `apply` 是**目标形态**，逐行标注的是「宿主 API 长什么样、为什么要这样调」。
> 其中 `engine.open()` / `engine.focusPackSync()` / `engine.observeUser()` / `engine.observeAssistant()` /
> `engine.observeTurnEnd()` / `engine.observeCompaction()` / `engine.flushTurn()` / `engine.runCommand()` /
> `engine.consolidateOnce()` 是**本骨架建议新增的引擎方法名**，当前的 `src/host/engine.ts` 只有
> `writeTurn()` / `recall()` / `renderTime()` / `consolidate()` / `health()` / `metrics()` 等
> （`src/host/engine.ts:120/170/225/235/398/442`），存储打开由 `openStore()` 完成
> （`src/store/store.ts:383-387`）。把这些方法补齐是**落地工作**，不是宿主 API 的结论；
> 宿主侧事实（`ctx.on` / `ctx.systemPrompt.context` / `ctx.commands.register` / `ctx.interval` 的
> 签名、事件 payload、同步约束）才是本文的实证内容。

```ts
/**
 * dsh-memory 插件入口。
 *
 * 接线事实全部来自宿主源码，逐条标注在注释里（路径相对 DSH 源码仓库根目录）。
 * 本文件只做「接线」，不含业务逻辑；业务在 core / store / consolidate。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { DEFAULT_CONFIG } from './core/config.ts'
import type { MemoryConfig } from './core/types.ts'
import { createMemoryEngine } from './host/engine.ts'

// ── 插件形态 ────────────────────────────────────────────────────────────────
// name/inject/Config/apply 四个导出由 loader 的 unwrapExports 归一化后消费：
//   vendor/loader/src/index.ts:198-205
//   vendor/cordis/src/registry.ts:98-111（Plugin.Base）
//   vendor/cordis/src/registry.ts:120-123（Plugin.Function）

export const name = 'memory'

/**
 * 只列 base bundle 保证存在的服务：
 *   systemPrompt   packages/core/system-prompt/src/index.ts:453
 *   storageDomain  packages/storage/storage-domain/src/index.ts:234
 *   commands       packages/interaction/commands/src/index.ts:277
 *   timer          vendor/timer/src/index.ts:14
 * 对应的 base 行：packages/bundle/base/cordis.patch.yml:24-26 / 187-190 / 320-321 / 509-512
 *
 * `schedule` 不在 base（只在 web-app bundle），因此不写进 inject，
 * 否则 headless / sdk profile 下本插件永不加载。
 */
export const inject = ['systemPrompt', 'storageDomain', 'commands', 'timer'] as const

export interface Config extends MemoryConfig {}

/** schemastery 校验；`.default()` 让 cordis.patch.yml 只需写与默认值不同的项。 */
export const Config: z<Config> = z.object({
  storage: z.object({
    dataDir: z.string().default(DEFAULT_CONFIG.storage.dataDir),
  }).default(DEFAULT_CONFIG.storage),
  consolidation: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.consolidation.enabled),
    dailyAt: z.string().default(DEFAULT_CONFIG.consolidation.dailyAt),
  }).default(DEFAULT_CONFIG.consolidation),
  context: z.object({
    // 必须 > 210（CONTEXT_ORDERS 的最高值 WEB_SURFACE）：
    //   packages/core/system-prompt/src/index.ts:177-186
    order: z.number().default(DEFAULT_CONFIG.context.order),
    maxCards: z.number().default(DEFAULT_CONFIG.context.maxCards),
    maxTokens: z.number().default(DEFAULT_CONFIG.context.maxTokens),
  }).default(DEFAULT_CONFIG.context),
})

/** 焦点包在快照里的名字；必须唯一，重复注册会抛（system-prompt:80）。 */
const CONTEXT_NAME = 'memory:focus-pack'

/** 巩固轮询周期。 */
const CONSOLIDATION_POLL_MS = 60 * 60 * 1000

// ── 入口 ────────────────────────────────────────────────────────────────────

/**
 * `apply` 返回 `void | Promise<void>`（vendor/cordis/src/registry.ts:121），
 * 本插件必须 async，因为 `storageDomain.open()` 是异步的（storage-domain:103）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const engine = createMemoryEngine(ctx, config)

  // 1) 打开存储 domain 并立即挂 close 清理器。
  //    范式来源：packages/workspace/workspace/src/index.ts:199-204
  await engine.open()
  ctx.effect(() => () => engine.close(), 'memory.domainClose')

  // 2) 主通道：每轮注入。
  //    签名与返回值：packages/core/system-prompt/src/index.ts:514-529
  //    text 必须同步：packages/core/system-prompt/src/index.ts:85 / 386-393
  //    压缩后自动重新物化：packages/core/agent-loop/src/agent.ts:294 / 446-450
  //                        + runtime-context.ts:139-147 / 157-168
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: config.context.order,
    // 焦点包是纯文本，不做变量插值，避免 {{x}} 被误替换（system-prompt:86-87）。
    interpolate: false,
    text: (context) => {
      const agent = context.agent
      // 裸 assemble()（测试、诊断）没有 agent，返回空串不贡献内容。
      // 同构兜底：packages/interaction/user-approval/src/index.ts:196
      if (agent === undefined) return ''
      // 只读内存缓存——绝不能在这里 await。
      return engine.focusPackSync(agent.session.id)
    },
  })

  // 3) 读历史：post-commit、fire-and-forget、异常被兜住。
  //    packages/core/session/src/index.ts:65-76
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'user/message') {
      // 三种来源混在 user/message 里，必须靠 source 区分。
      // packages/core/session/src/types.ts:308-315
      // packages/llm/llm/src/message.ts:110-115
      if (event.data.source.kind !== 'user') return
      engine.observeUser(session.id, event.data, event.seq)
      return
    }
    if (event.type === 'assistant/message') {
      engine.observeAssistant(session.id, event.data.message, event.data.usage, event.seq)
      return
    }
    if (event.type === 'turn/end') {
      engine.observeTurnEnd(session.id, event.data.turn, event.data.reason)
      return
    }
    if (event.type === 'compaction/summary') {
      // 用 shadowedSeqs 回填被压缩掉的范围。
      // packages/compaction/compaction/src/types.ts:25-53
      engine.observeCompaction(session.id, event.data.shadowedSeqs)
    }
  })

  // 4) turn 收尾：只落盘，绝不 steer。
  //    steer 会强制多跑一步：packages/core/agent/src/runtime-types.ts:401-405
  //    steer 语义：packages/core/agent/src/runtime-types.ts:253-260
  ctx.on('agent/turn-stopping', async ({ agent }: { agent: Agent }) => {
    await engine.flushTurn(agent.session.id)
  })

  // 5) 命令：没有内建子命令机制，自己解析 rawInput。
  //    注册：packages/interaction/commands/src/index.ts:285-292
  //    解析：packages/interaction/commands/src/index.ts:125-132
  //    定义：packages/interaction/commands/src/index.ts:60-78
  ctx.commands.register({
    name: 'memory',
    description: 'Inspect and maintain the memory store',
    input: { hint: '[status|health|rebuild]' },
    handler: invocation => engine.runCommand(invocation),
  })

  // 6) 巩固轮询：ctx.effect 绑定，随插件卸载自动清理。
  //    vendor/timer/src/index.ts:56-62
  if (config.consolidation.enabled) {
    ctx.interval(() => { void engine.consolidateOnce() }, CONSOLIDATION_POLL_MS)
  }
}
```

### 9.2 `cordis.patch.yml`

```yaml
# dsh-memory 的 Cordis bundle patch。
#
# 方言依据：
#   vendor/include/src/index.ts:129-141（PatchOptions）
#   vendor/loader/src/config/entry.ts:9-23（EntryOptions）
#   packages/bundle/base/cordis.patch.yml:1-13（分层与覆盖语义）
#
# 本插件只插入一行：一个 Host 插件，把记忆系统挂到宿主上。
# 它不替换、不禁用任何已有行，所以与其它 bundle 叠加是安全的。
#
# config 由 schemastery 补齐缺省字段（见 src/index.ts 的 `export const Config`），
# 因此这里只写「与默认值不同」的项。patch 层是整块替换，不做深合并
# （packages/bundle/base/cordis.patch.yml:6-7）。

- insert:
    - id: memory
      # 发布形态：包名（要求本包已安装进 profile 的 node_modules）。
      # 开发期直接指向仓库源文件时，必须改成绝对路径：
      #   packages/boot/app-boot/src/index.ts:547-556（anchorInsertedPluginNames）
      #   docs/user/develop/basic/index.zh.md:56
      name: dsh-memory
      config:
        storage:
          # 记忆库放在工作区的隐藏目录，随项目走，不污染用户主目录。
          dataDir: .dsh-memory
        consolidation:
          # 起源 L21（第 1 条·夜晚休眠整理）。03:30 是本地时间，由宿主机时区解释。
          enabled: true
          dailyAt: '03:30'
        context:
          # 必须大于 210（CONTEXT_ORDERS 的最高值 WEB_SURFACE）：
          #   packages/core/system-prompt/src/index.ts:177-186
          order: 300
```

### 9.3 三条最小验证

```bash
# 1) 类型检查（接线用到的宿主 API 签名是否都对）
pnpm typecheck

# 2) 单元测试
pnpm test

# 3) 宿主实机：装进 profile 后看插件是否加载
#    - 若 patch 里是包名：先 pnpm build，再把包安装进 profile
#    - 若 patch 里是绝对路径：确认路径是 file:// 可解析的绝对路径
```

**实机验证要点**（对应 §10 的待验证清单）：

| 检查 | 怎么看 |
|---|---|
| 插件真的加载了 | 启动日志里有 `memory` 行；`ctx.systemPrompt` 上能看到 `memory:focus-pack` |
| 快照真的注入了 | 会话历史里出现一条 `source.kind === 'runtime-context'` 的 `user/message`，文本以 `Current runtime context.` 开头（`packages/core/system-prompt/src/index.ts:324`） |
| 压缩后真的重新物化 | 压缩后下一轮，历史里出现**新**的 `runtime-context` user 消息 |
| 命令真的可用 | 输入 `/memory status` 有返回 |
| 定时器真的清理 | 插件卸载后不再有轮询日志 |

---

## 10. 待验证清单（交付给实机验证）

| 编号 | 待验证 | 本文结论 | 实机怎么验 |
|---|---|---|---|
| V-1 | `context()` 压缩后自动重新追加 | **已解除**（§2.5、§8.3） | 触发一次压缩，看下一轮是否出现新快照 |
| V-2 | 桌面运行时能否加载原生模块 | 未涉及（本系统只用 `node:fs`） | 不需要验 |
| V-3 | `agent/pre-step` 多监听器顺序 | **建议绕开**（§8.5） | 本系统不注册 pre-step，故不适用 |
| V-4 | preset 与 host 平面共享 storage domain | 未验证 | 若未来要做 preset，需实测 `already-open` |
| V-5 | `assistant/message` 的 `usage` 是否可用 | 类型上可选（`packages/core/session/src/types.ts:355`） | 打印一条 `assistant/message` 事件看 `usage` 是否有值 |
| **新增** V-6 | 同步 `text()` 的耗时预算 | 未验证 | 在 `text()` 里打点，确认单次 < 1ms（否则拖慢每个 step） |
| **新增** V-7 | `ctx.interval` 在长会话中的漂移 | 未验证 | 连续跑 24h 看轮询间隔是否稳定 |
| **新增** V-8 | 同名 domain 与 preset 共存 | 未验证 | 装 preset 后看是否抛 `already-open` |
