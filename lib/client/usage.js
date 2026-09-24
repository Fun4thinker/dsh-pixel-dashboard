/**
 * 看板数据获取与派生计算：取数、按时间窗口切片、按「高峰 / 空闲」分档计价。
 * 纯逻辑，不含 React。
 * @module dsh-pixel-dashboard/client/usage
 */

import { shiftKey } from './format.js'
// 计价口径只有一份（cost.js）。这里 import 进来是为了 `dailyCosts()`——
// 用别名是因为末尾还要把同一个名字原样再转出给看板与费用条，
// 同名 import + export 在打包后的 CJS 容器里会撞成「重复声明」。
import { priceByModel as priceByModelForCost } from './cost.js'

/** 数据路由，与宿主注册路径一致。 */
const DATA_URL = '/dsh-pixel/data'

/**
 * 客户端的实现版本，由构建脚本按宿主源码哈希注入。
 *
 * 只用于诊断展示，**不再作为取数的闸门**：哈希会随任何源码改动而变化，包括
 * 完全不影响数据形状的改动，用严格相等去拦截会把好数据一起挡掉
 * （曾如此：删掉一个不用的字段后，费用条永远停在「折算中」）。
 * 判断兼容性请用下面的 CAPABILITIES。
 */
const CLIENT_VERSION = '8afd2403'

/**
 * 本客户端需要宿主提供的能力。宿主在数据里声明它支持哪些，
 * 客户端只检查自己真正要用的项——缺少时逐项降级，而不是整页报错。
 */
const CAPABILITIES = ['period', 'periodClock', 'peakRule', 'sessionCost', 'calendarByDay', 'tieredRates']

/** 首次扫描长会话可能较慢，给足超时余量。 */
const REQUEST_TIMEOUT_MS = 60_000

/**
 * 配色轮换。
 *
 * 这里的 tone 同时驱动两套类名：`px-tone-*`（stroke / background 类）
 * 与 `px-tone-fill-*`（SVG fill 类）。之前环图误用了 `px-tone-bg-*`
 * ——那是给 HTML 元素用的 background 类，在 SVG 上不生效，环图因此是空白的。
 */
export const TONES = ['blue', 'pink', 'green', 'yellow', 'purple', 'red']

/** tone → SVG fill 类名。 */
export const toneFill = (tone) => `px-tone-fill-${tone}`

/** tone → HTML background 类名。 */
export const toneBg = (tone) => `px-tone-bg-${tone}`

/** tone → stroke 类名。 */
export const toneStroke = (tone) => `px-tone-${tone}`

/** 空用量（含分时段）。 */
export function emptyUsage() {
  return {
    cacheHit: 0,
    cacheMiss: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    local: 0,
    requests: 0,
    peak: { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0 },
    idle: { cacheHit: 0, cacheMiss: 0, output: 0, requests: 0 },
  }
}

/**
 * 取看板数据。
 *
 * 兼容性由**各自界面按实际数据**判断，而不是在这里统一拦截：
 *   - 早先按版本哈希严格相等来拦，任何不影响数据形状的改动都会把好数据一起挡掉
 *     （曾如此：删掉一个不用的字段后，费用条永远停在「折算中」）；
 *   - 改成只看 capabilities 声明同样会误报：旧宿主其实照常返回了那份数据，
 *     只是没声明能力名。
 * 所以这里只负责取数，并把宿主的版本与能力声明原样带回来供诊断。
 * @param {{refresh?:boolean, signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 看板数据，另附 `compat` 供诊断展示。
 */
export async function fetchDashboard(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const url = options.refresh === true ? `${DATA_URL}?refresh=1` : DATA_URL
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`看板数据请求失败：HTTP ${response.status}`)
    const data = await response.json()
    return {
      ...data,
      compat: {
        hostVersion: data.version,
        clientVersion: CLIENT_VERSION,
        provided: Array.isArray(data.capabilities) ? data.capabilities : [],
        missing: CAPABILITIES.filter((name) => !(data.capabilities ?? []).includes(name)),
      },
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** 把一份用量并入累加器（含分时段）。 */
function accumulate(target, source) {
  for (const key of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local', 'requests']) {
    target[key] += Number(source?.[key] ?? 0)
  }
  for (const part of ['peak', 'idle']) {
    for (const key of ['cacheHit', 'cacheMiss', 'output', 'requests']) {
      target[part][key] += Number(source?.[part]?.[key] ?? 0)
    }
  }
  return target
}

/** 合计若干天的用量。 */
export function sumRows(rows) {
  const acc = emptyUsage()
  for (const row of rows) accumulate(acc, row?.totals)
  return acc
}

/** 合计若干「模型 → 用量」表。 */
export function sumByModel(entries) {
  const acc = {}
  for (const entry of entries) {
    for (const [model, usage] of Object.entries(entry ?? {})) {
      accumulate((acc[model] ??= emptyUsage()), usage)
    }
  }
  return acc
}

/**
 * 把逐日用量摊成「按某个维度」的多条序列。
 *
 * 维度的定义（三者互不替代）：
 *   - `type`     —— 缓存命中 / 未缓存 / 输出，回答「量花在哪一段」；
 *   - `model`    —— 归一到具体模型（**跨提供商合并**），回答「哪个模型用得最多」；
 *   - `provider` —— 按提供商，回答「量从哪条路由来」。
 *
 * 两个刻意的取舍：
 *   1. **按总量取前 N，其余合成「其他」。** 一个老账本里能出现十几个条目，
 *      全画上去就是一团互相压住的线，图例也会长到把面板撑开。取前 N 保证
 *      主要矛盾看得见，剩下的量仍有去处（不丢数字）。
 *   2. **归模型时跨提供商合并。** 同一个模型走三条路由是同一件事的三份用量；
 *      按提供商分组时才需要拆开。两者的键不同，因此必须分别聚合。
 * @param {object[]} points - `recentDays()` 产出的逐日行（含 `byModel`）。
 * @param {object[]} models - 宿主 `models[]`（含 key / rollup / label / provider / providerLabel）。
 * @param {'type'|'model'|'provider'} dimension - 维度。
 * @param {{limit?:number}} [options] - limit：前 N 条（默认 5）。
 * @returns {{series:object[], points:object[]}} 序列定义与摊平后的点。
 */
export function dimensionSeries(points, models, dimension, options = {}) {
  const rows = Array.isArray(points) ? points : []
  const limit = Math.max(1, Number(options.limit ?? 5))
  // 条目身份 → 展示名与分组键。旧宿主没有 key 时退回 model 字段（见 entryKeyOf）。
  const meta = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    const key = typeof model?.key === 'string' && model.key !== '' ? model.key : String(model?.model ?? '')
    if (key === '') continue
    meta.set(key, model)
  }

  /** 某个 byModel 条目在这个维度下属于哪一组。 */
  const groupOf = (key) => {
    const model = meta.get(key)
    if (dimension === 'provider') {
      const provider = String(model?.provider ?? '')
      return {
        group: provider === '' ? '\u0000unknown' : provider,
        label: provider === '' ? '来源未知' : (model?.providerLabel || provider),
      }
    }
    // model（默认）：归一到模型本身，跨提供商合并。
    // 没有价目表键时退回条目身份——否则所有认不出的条目会挤成一条。
    const rollup = String(model?.rollup ?? '')
    const group = rollup === '' ? key : rollup
    return { group, label: model?.label || rollup || key }
  }

  // 第一遍：算每个分组的全窗口总量，用于挑前 N
  const totals = new Map()
  for (const point of rows) {
    for (const [key, usage] of Object.entries(point?.byModel ?? {})) {
      const { group } = groupOf(key)
      totals.set(group, (totals.get(group) ?? 0) + Number(usage?.local ?? 0))
    }
  }
  const ranked = [...totals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
  const top = ranked.slice(0, limit).map(([group]) => group)
  const hasOther = ranked.length > top.length

  /** 组 → 颜色槽位。用排名定色，颜色才不会随窗口切换而乱跳。 */
  const labelOf = new Map()
  for (const point of rows) {
    for (const key of Object.keys(point?.byModel ?? {})) {
      const { group, label } = groupOf(key)
      if (!labelOf.has(group)) labelOf.set(group, label)
    }
  }
  const series = top.map((group, index) => ({
    key: group,
    label: labelOf.get(group) ?? group,
    tone: TONES[index % TONES.length],
  }))
  if (hasOther) series.push({ key: '\u0000other', label: '其他', tone: TONES[top.length % TONES.length] })

  const allowed = new Set(top)
  const shaped = rows.map((point) => {
    const out = { key: point?.key }
    for (const line of series) out[line.key] = 0
    for (const [key, usage] of Object.entries(point?.byModel ?? {})) {
      const { group } = groupOf(key)
      const bucket = allowed.has(group) ? group : '\u0000other'
      // 被折进「其他」的组也必须有槽位，否则 hasOther 为假时键不存在
      if (out[bucket] === undefined) out[bucket] = 0
      out[bucket] += Number(usage?.local ?? 0)
    }
    return out
  })
  return { series, points: shaped }
}

/**
 * 逐日消费估计：与 `priceByModel` 同一口径，因此**逐日相加等于窗口总额**
 * （金额是按 token 线性折算的，不存在四舍五入漂移）。
 * @param {object[]} points - 逐日行。
 * @param {object} pricing - 宿主的 pricing 段。
 * @returns {object[]} 形如 `[{key, cost}]`。
 */
export function dailyCosts(points, pricing) {
  return (Array.isArray(points) ? points : []).map((point) => ({
    key: point?.key,
    cost: priceByModelForCost(point?.byModel ?? {}, pricing).standard,
  }))
}

/**
 * 取最近 `days` 天的行并补齐缺口，保证折线连续。
 * @param {object[]} dayRows - 宿主返回的升序按日汇总。
 * @param {number} days - 天数。
 * @returns {object[]} 补齐后的行（含折线字段）。
 */
export function recentDays(dayRows, days) {
  const rows = Array.isArray(dayRows) ? dayRows : []
  if (rows.length === 0) return []
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const last = rows.at(-1).key
  const out = []
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = shiftKey(last, -i)
    const row = byKey.get(key)
    const totals = row?.totals ?? emptyUsage()
    out.push({
      key,
      byModel: row?.byModel ?? {},
      totals,
      cacheHit: Number(totals.cacheHit ?? 0),
      cacheMiss: Number(totals.cacheMiss ?? 0),
      output: Number(totals.output ?? 0),
    })
  }
  return out
}

/**
 * 计价函数统一由 cost.js 提供，这里只做转出。
 * 不在这里重复实现：看板与输入框下方的费用条必须共用同一套口径，
 * 两份实现漂移后对不上的数字比没有数字更糟。
 */
export { priceByModel, priceUsage, ratesFor } from './cost.js'
