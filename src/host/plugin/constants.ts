/**
 * 插件接线层的常量与插件元信息。
 *
 * 单独成文件，是因为这些值被 `apply` 的多个分支、`render`、`wake` 同时读到；
 * 留在一个大文件里时，任何人改一处排序值都要滚过整份 `apply`。
 *
 * @module dsh-memory/host/plugin/constants
 */

import type { MemoryConfig } from '../../core/config.ts'

/**
 * 插件配置。
 *
 * 与 {@link MemoryConfig} 同构：宿主 patch 里写的字段会深合并到默认值之上，
 * 所以用户只写 `dataDir` 不会把其余默认值清空。
 */
export type Config = MemoryConfig

/**
 * 动态上下文在系统提示词里的排序值。
 *
 * 取 300 而不是 130：宿主 `CONTEXT_ORDERS`（`packages/core/system-prompt/src/index.ts:177`）
 * 实际是 100 工作目录 / 110 沙箱 / 115 审批 / 120 子代理 / 125 团队身份 /
 * 200 宿主源码路径 / 210 Web 表面。130 会**夹在团队身份与宿主源码之间**，
 * 既不靠前也不靠后；而宿主注释明确说 200 之后是「进程相关路径与端点，
 * 不进缓存系统提示词」（同文件 :182），所以排在 200 之后才落在动态尾部。
 * 记忆每轮都在变，放在缓存区里会不断打断前缀缓存。
 */
export const CONTEXT_ORDER = 300

/** 夜整理巡检周期：每小时看一次「今天该不该整理」。 */
export const CONSOLIDATION_POLL_MS = 60 * 60 * 1000

/** 注册名：动态上下文。 */
export const CONTEXT_NAME = 'memory:focus-pack'

/** 插件名，宿主日志与 loader 诊断用。 */
export const name = 'memory'

/**
 * 插件依赖的宿主服务。
 *
 * **这不是可选的装饰**。真实 Cordis 的 `ctx` 是 Proxy，其 `get` 陷阱对任何
 * 未在本数组里声明的服务名**直接抛** `cannot get property "x" without inject`
 * ——`?.` 只能防 `undefined`，防不住抛错。本仓库长期用假宿主（普通对象）测试，
 * 普通对象永远不抛，于是这条缺陷一直绿着，直到宿主实机验证才暴露。
 *
 * 声明在这里还有第二个作用：**让 `apply` 等到服务就绪再执行**。实测
 * （`.tmp/probe-order.mjs`）不声明依赖时 `apply` 会在服务挂载前就运行，
 * 读到 `undefined` 并就此定局，形成**静默永久降级**——比加载期崩溃更难发现。
 *
 * 三项都是 base bundle 常驻服务（见 `docs/4-宿主接线API实证.md` §8.9），
 * 且在 compose 后的树里都排在 `memory` 之前，所以不会让插件永远不激活。
 *
 * 为什么只有这三项：
 * - `systemPrompt` —— FR-E2 的唯一注入通道，缺了记忆永远进不了上下文；
 * - `commands` —— FR-F2 的用户命令入口，缺了 `/memory` 不存在；
 * - `timer` —— 夜整理巡检的定时器来源（`ctx.interval` 是它的 mixin 方法），
 *   缺了 FR-C1 永不运行。
 *
 * **刻意不列的两项**：
 * - `goals` —— 只影响 `goalScore` 一维，且由 `readGoalText` 每轮**懒读**，
 *   服务晚到时下一轮自然取到，不存在静默降级；而它来自独立的 goal 插件，
 *   不在 base bundle 里，硬列会让未装 goal 的 profile 直接不激活。
 * - `storageDomain` —— **生产代码零读取**（数据面走 `config.storage.dataDir`
 *   的本地日志）。声明一个没有消费者的依赖，只会凭空拉高激活门槛：
 *   凡是没挂 storage-domain 的 profile，本插件都会无故失效。
 */
export const inject = ['systemPrompt', 'commands', 'timer']
