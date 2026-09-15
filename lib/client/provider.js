/**
 * 模型来源 → 「该看哪一份余额 / 额度」的映射（纯逻辑，不含 React）。
 *
 * ## 为什么需要它
 *
 * 输入框下方那一行原本**同时**显示官方余额与「最紧的那个套餐窗口」。这两件事
 * 在语义上是互斥的：你这一次请求要么走官方按量计费（该关心账户余额），要么走
 * 某个 Coding Plan 的套餐额度（该关心那个套餐的窗口）。并排显示会让人以为
 * 「余额」和「套餐」是同一笔钱的两个数字，而它们其实来自完全不同的账户。
 *
 * 因此这里做一件事：把当前会话**正在用的模型来源**（provider 路由名）映射到
 * 唯一一个该显示的对象。
 *
 * ## 路由名从哪来
 *
 * 来源是 DSH 自己发布的 `modelSelection` 投影（`useProjection('modelSelection')`），
 * 它给出 `{ provider, model }`，且是**逐请求记录**的事实——用户换了模型，
 * 下一次渲染就是新的 route，不需要插件去猜。
 *
 * ## 与宿主凭据候选表必须一致
 *
 * 下面的路由名清单与 `lib/plans.js` 里的 `ZHIPU_ROUTES` / `COMMAND_CODE_ROUTES` /
 * `VOLC_ROUTES` 是**同一组事实的两份抄写**：宿主用它们去猜凭据引用名，这里用它们
 * 判断「该显示哪一家」。两边漂移的后果是「套餐卡片里有这一家、费用条旁边却始终
 * 不显示它」——没有任何报错，只是那一枚永远不出现。渲染闸门会读两个文件比对，
 * 因此漂移会在校验时直接失败。
 * @module dsh-pixel-dashboard/client/provider
 */

/**
 * 官方 provider 路由名。
 *
 * 与 `lib/balance.js` 的 `OFFICIAL_PROVIDER` 一致：DSH 内置的 `llm-deepseek`
 * 注册的就是这条路由（见 llm-deepseek/src/index.ts 的 `PROVIDER`）。
 */
export const OFFICIAL_PROVIDER = 'deepseek-official'

/** 余额那一侧的对象标识。 */
export const BALANCE_SOURCE = 'balance'

/**
 * 套餐厂商路由名 → 套餐厂商 id。
 *
 * id 必须与宿主 `lib/plans.js` 里各家 `base.id` 一致（`zhipu` / `commandcode` /
 * `volcengine`），否则界面上找不到对应的那一家。
 *
 * **这张表与宿主 lib/plans.js 的 `ZHIPU_ROUTES` / `COMMAND_CODE_ROUTES` /
 * `VOLC_ROUTES` 是同一组事实的两份抄写**，不能只改一边：宿主用它们去猜凭据
 * 引用名，这里用它们判断「该显示哪一家」。漂移的后果是「套餐卡片里有这一家、
 * 输入框旁边却始终不显示它」——没有任何报错，只是那一枚永远不出现。
 * `tools/render-check.mjs` 会**逐条**读宿主源码比对这张表，因此漂移会在校验时
 * 直接失败（而不是等用户发现「某个路由名没被认出来」）。
 */
export const PLAN_ROUTES = {
  zhipu: ['zhipu-coding', 'zai-coding-cn', 'zhipu', 'bigmodel', 'glm'],
  commandcode: ['command-code', 'commandcode', 'command_code', 'cmd'],
  volcengine: ['fangzhou', 'volcengine', 'ark', 'volces', 'doubao'],
}

/** 套餐厂商 id → 界面上的一句话名字。 */
export const PLAN_LABELS = {
  zhipu: '智谱 GLM Coding Plan',
  commandcode: 'Command Code',
  volcengine: '火山方舟 Coding Plan',
}

/**
 * 套餐厂商 id → 费用条那一行用得下的短名。
 *
 * 一行里还要放金额与 token 数，全名会把那一行撑成两行甚至换行。
 */
export const PLAN_SHORT = {
  zhipu: '智谱',
  commandcode: 'Command Code',
  volcengine: '火山方舟',
}

/**
 * 由一张 `厂商 id → 路由名[]` 表反向建索引。
 *
 * 全部键在模块加载时归一成小写：用户手填的 provider 路由名大小写任意
 * （`ARK` / `Ark` 都可能），而这里的匹配必须是大小写不敏感的。
 * @param {Record<string, string[]>} table - 正向表。
 * @returns {Map<string, string>} 小写路由名 → 厂商 id。
 */
function invert(table) {
  const out = new Map()
  for (const [id, routes] of Object.entries(table)) {
    for (const route of routes) out.set(String(route).toLowerCase(), id)
  }
  return out
}

/** 小写路由名 → 套餐厂商 id。 */
const ROUTE_INDEX = invert(PLAN_ROUTES)

/**
 * 归一一个 provider 路由名：小写、去空白。
 * @param {unknown} provider - 原始路由名。
 * @returns {string} 归一结果；读不出时是空串。
 */
export function normalizeProvider(provider) {
  return String(provider ?? '').trim().toLowerCase()
}

/**
 * 由 provider 路由名判断这一家在**本插件**里对应哪个套餐。
 *
 * 认不出时返回 undefined——那说明这一次用的是我们监控不到的一家（自建代理、
 * 别家 API）。此时费用条**只显示本次会话消费**，不显示余额也不显示额度：
 * 显示一个与当前请求无关的账户数字，比什么都不显示更容易误导。
 * @param {unknown} provider - provider 路由名。
 * @returns {string|undefined} 套餐厂商 id。
 */
export function planIdOfProvider(provider) {
  const key = normalizeProvider(provider)
  if (key === '') return undefined
  return ROUTE_INDEX.get(key)
}

/**
 * 由 provider 路由名算出「该显示哪一份账户事实」。
 *
 * 三种结果，界面据此决定渲染哪一枚：
 *   - `{ kind: 'balance' }` —— 官方按量计费，显示官方账户余额；
 *   - `{ kind: 'plan', planId }` —— 走某家 Coding Plan，显示那一家的额度窗口；
 *   - `{ kind: 'unknown' }` —— 认不出的来源，两样都不显示。
 * @param {unknown} provider - provider 路由名。
 * @returns {{kind:'balance'|'plan'|'unknown',planId?:string,label:string}} 来源描述。
 */
export function sourceOfProvider(provider) {
  const key = normalizeProvider(provider)
  if (key === OFFICIAL_PROVIDER) {
    return { kind: BALANCE_SOURCE, label: 'DeepSeek 官方 API' }
  }
  const planId = planIdOfProvider(key)
  if (planId !== undefined) {
    return { kind: 'plan', planId, label: PLAN_LABELS[planId] ?? planId }
  }
  return { kind: 'unknown', label: key === '' ? '未知来源' : key }
}

/**
 * 取当前会话正在用的 provider 路由名。
 *
 * 两个来源，按**可信度**排序：
 *   1) `modelSelection` 投影的 `next ?? lastUsed`——DSH 逐请求记录的事实，
 *      用户切了模型立刻反映出来；
 *   2) 宿主观测到的该会话模型列表（只有模型名、没有 provider），仅用于
 *      「投影不可用」时给出一个可读的兜底说明。
 *
 * 拿不到 provider 时返回 `undefined`：那时界面退回旧行为（两样都显示），
 * 而不是随便挑一个账户来显示。
 * @param {object|undefined} selection - `useProjection('modelSelection')` 的值。
 * @returns {{provider:string,model:string}|undefined} 当前路由；读不出时 undefined。
 */
export function currentRoute(selection) {
  if (selection === null || typeof selection !== 'object') return undefined
  const picked = selection.next ?? selection.lastUsed
  if (picked === null || typeof picked !== 'object') return undefined
  const provider = typeof picked.provider === 'string' ? picked.provider.trim() : ''
  const model = typeof picked.model === 'string' ? picked.model.trim() : ''
  if (provider === '' && model === '') return undefined
  return { provider, model }
}
