/**
 * 纯计价函数：把用量按「高峰 / 空闲」两档折算成金额。
 *
 * 独立成模块是为了让看板与输入框下方的费用条共用同一套口径——
 * 两处各写一份很容易漂移，而对不上的数字比没有数字更糟。
 * @module dsh-pixel-dashboard/client/cost
 */

/** 兜底价目：与宿主 pricing.js 的 deepseek-flash 保持一致。 */
const FALLBACK_RATES = {
  label: 'unknown',
  cacheHit: { peak: 0.04, idle: 0.02 },
  cacheMiss: { peak: 2, idle: 1 },
  output: { peak: 8, idle: 4 },
}

/**
 * 取某个模型的价目条目。
 *
 * 两个来源，按**可信度**排序：
 *   1) 宿主逐模型交下来的 `pricing.models`（键是归一后的模型名）。条目身份
 *      `deepseek-flash@commandcode` 与它只差一个 `@提供商` 后缀，因此先剥离再查；
 *   2) 宿主整张价目表 `pricing.rates`——**旧宿主**没有 `models` 时走这条。
 *
 * 为什么不能只靠 `pricing.rates` 按模型路由 id 查：表里只有归一后的模型名
 * （`deepseek-flash`），而路由 id 是 `deepseek/deepseek-v4.1-flash`。查不到就会
 * 静默回落到 Flash 价——**GLM 那一行因此被当成「分时定价」，多画了一列 token、
 * 少画了一个金额表头，整张表从那一行起列就错位了。**
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} model - 条目身份（`模型@提供商`）或模型名。
 * @returns {object} 价目条目。
 */
export function ratesFor(pricing, model) {
  return ratesKeyOf(pricing, model)
    ?? pricing?.rates?.['deepseek-flash']
    ?? FALLBACK_RATES
}

/**
 * 按条目身份查价目，查不到返回 undefined（**不回落**）。
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} model - 条目身份或模型名。
 * @returns {object|undefined} 价目条目。
 */
function ratesKeyOf(pricing, model) {
  const key = String(model ?? '')
  const at = key.indexOf('@')
  const rollup = at <= 0 ? key : key.slice(0, at)
  return pricing?.models?.[rollup]
    ?? pricing?.models?.[key]
    ?? pricing?.rates?.[rollup]
    ?? pricing?.rates?.[key]
}

/**
 * 按分档计价一份用量。
 *
 * 口径与官方一致：高峰与空闲分别乘各自单价，而不是给整段用量套一个折扣。
 * @param {object} usage - 含 peak / idle 分档的用量。
 * @param {object} rates - 价目条目。
 * @returns {{standard:number,peak:number,idle:number,ifAllIdle:number,saved:number}}
 */
export function priceUsage(usage, rates) {
  const million = 1_000_000
  const part = (bucket, period) =>
    (Number(bucket?.cacheHit ?? 0) / million) * rates.cacheHit[period]
    + (Number(bucket?.cacheMiss ?? 0) / million) * rates.cacheMiss[period]
    + (Number(bucket?.output ?? 0) / million) * rates.output[period]

  const peak = part(usage?.peak, 'peak')
  const idle = part(usage?.idle, 'idle')
  const allIdle = part({
    cacheHit: Number(usage?.peak?.cacheHit ?? 0) + Number(usage?.idle?.cacheHit ?? 0),
    cacheMiss: Number(usage?.peak?.cacheMiss ?? 0) + Number(usage?.idle?.cacheMiss ?? 0),
    output: Number(usage?.peak?.output ?? 0) + Number(usage?.idle?.output ?? 0),
  }, 'idle')
  return { standard: peak + idle, peak, idle, ifAllIdle: allIdle, saved: peak + idle - allIdle }
}

/**
 * 按模型汇总计价。
 * @param {Record<string, object>} byModel - 模型 → 用量。
 * @param {object} pricing - 宿主的 pricing 段。
 * @returns {{standard:number,peak:number,idle:number,ifAllIdle:number,saved:number}}
 */
export function priceByModel(byModel, pricing) {
  let standard = 0
  let peak = 0
  let idle = 0
  let ifAllIdle = 0
  for (const [model, usage] of Object.entries(byModel ?? {})) {
    const cost = priceUsage(usage, ratesFor(pricing, model))
    standard += cost.standard
    peak += cost.peak
    idle += cost.idle
    ifAllIdle += cost.ifAllIdle
  }
  return { standard, peak, idle, ifAllIdle, saved: standard - ifAllIdle }
}
