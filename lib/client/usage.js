/**
 * 看板数据获取与派生计算：取数、按时间窗口切片、按「高峰 / 空闲」分档计价。
 * 纯逻辑，不含 React。
 * @module dsh-pixel-dashboard/client/usage
 */

import { shiftKey } from './format.js'

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
const CLIENT_VERSION = 'd7be421a'

/**
 * 本客户端需要宿主提供的能力。宿主在数据里声明它支持哪些，
 * 客户端只检查自己真正要用的项——缺少时逐项降级，而不是整页报错。
 */
const CAPABILITIES = ['period', 'peakRule', 'sessionCost', 'calendarByDay', 'tieredRates']

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
