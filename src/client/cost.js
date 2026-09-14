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
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} model - 模型名（应为归一后的键）。
 * @returns {object} 价目条目。
 */
export function ratesFor(pricing, model) {
  return pricing?.rates?.[model]
    ?? pricing?.rates?.['deepseek-flash']
    ?? FALLBACK_RATES
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
