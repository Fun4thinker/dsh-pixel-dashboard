/**
 * 纯计价函数：把用量按「高峰 / 空闲」两档折算成金额。
 *
 * 独立成模块是为了让看板与输入框下方的费用条共用同一套口径——
 * 两处各写一份很容易漂移，而对不上的数字比没有数字更糟。
 *
 * v3 起这一层多了两件事，都必须做在这里（而不是各界面各做一次）：
 *   1) **提供商倍率（markup）**：中转站在官方价上加的倍数；
 *   2) **外币折算**：官方价是美元的条目按汇率折成人民币。
 * 两者若散落在渲染代码里，「合计」与「明细」迟早会按不同的系数算出来。
 * @module dsh-pixel-dashboard/client/cost
 */

/**
 * 兜底价目：与宿主 `pricing.js` 的 `FALLBACK_RATES`（即 `deepseek-flash`）**必须一致**。
 *
 * 这里是**抄的一份**，不是共享的常量：客户端产物是独立打包的（`lib/client.js` 是
 * 一个 `__ModuleLoader__` 容器，没有从宿主模块 import 的通道），而宿主已经通过
 * `pricing.models` / `pricing.rates` 把真正该用的那份交下来了——走到这个兜底，
 * 只可能是**旧宿主**或数据缺口。
 *
 * 抄一份的代价是「改了宿主忘了改这里」，而症状很隐蔽：只有旧宿主上的金额会偏，
 * 新宿主上永远走不到这条路。因此宿主侧的闸门（`tools/preflight.mjs`）会把这两个
 * 数字与 `MODEL_RATES['deepseek-flash']` 逐项对比，不一致就直接失败。
 * @type {{label:string, cacheHit:object, cacheMiss:object, output:object}}
 */
const FALLBACK_RATES = {
  label: 'unknown',
  cacheHit: { peak: 0.04, idle: 0.02 },
  cacheMiss: { peak: 2, idle: 1 },
  output: { peak: 8, idle: 4 },
}

/** 与宿主 `DEFAULT_USD_TO_CNY` 一致：旧宿主没有 `pricing.usdToCny` 时用它。 */
const DEFAULT_USD_TO_CNY = 7.3

/** 金额保留 6 位小数：换汇会产生尾巴，累加后会与明细差一分钱。 */
function money(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 1e6) / 1e6 : 0
}

/** 兑换率：宿主交下来就用它，否则用内置默认值。 */
function fxOf(pricing) {
  const amount = Number(pricing?.usdToCny)
  return Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_USD_TO_CNY
}

/**
 * 把一条**可能是外币**的价目折成人民币。
 *
 * 正常路径上宿主已经折好（`currency: 'CNY'` 且带 `native`），这里原样返回；
 * 只有「旧宿主 / 数据缺口 / 用户直接塞了美元条目」时才真的换算。
 * @param {object|undefined} rates - 价目条目。
 * @param {object} pricing - 宿主的 pricing 段。
 * @returns {object} 人民币价目条目（或兜底）。
 */
function toCny(rates, pricing) {
  if (rates === null || rates === undefined) return rates
  const currency = typeof rates.currency === 'string' ? rates.currency : 'CNY'
  if (currency === 'CNY') return rates
  const fx = fxOf(pricing)
  const pair = (value) => (value === undefined || value === null
    ? value
    : { peak: money(Number(value.peak ?? 0) * fx), idle: money(Number(value.idle ?? 0) * fx) })
  return {
    ...rates,
    currency: 'CNY',
    sourceCurrency: currency,
    fx,
    cacheHit: pair(rates.cacheHit),
    cacheMiss: pair(rates.cacheMiss),
    output: pair(rates.output),
    ...(rates.cacheWrite === undefined ? {} : { cacheWrite: pair(rates.cacheWrite) }),
  }
}

/**
 * 取某个模型的价目条目与其倍率。
 *
 * 三个来源，按**可信度**排序：
 *   1) 宿主逐模型交下来的 `pricing.models`（键是归一后的模型名）。条目身份
 *      `deepseek-flash@commandcode` 与它只差一个 `@提供商` 后缀，因此先剥离再查；
 *   2) 宿主整张价目表 `pricing.rates`——**旧宿主**没有 `models` 时走这条；
 *   3) 兜底（Flash 价）。
 *
 * 为什么要容忍两种形状：新宿主在 `models` 里交的是 `{ rates, markup, currency }`
 * 这种**带倍率的包装**，而看板的「我的单价」会把用户补的价**直接**盖进同两个入口
 * （那里是裸 RATE）。同一个键可能先是包装、后是裸条目，`ratesFor()` 必须两种都认，
 * 否则「勾上我的单价」会让整张表的金额突然全变成兜底价。
 *
 * 为什么不能只靠 `pricing.rates` 按模型路由 id 查：表里只有归一后的模型名
 * （`deepseek-flash`），而路由 id 是 `deepseek/deepseek-v4.1-flash`。查不到就会
 * 静默回落到 Flash 价——**GLM 那一行因此被当成「分时定价」，多画了一列 token、
 * 少画了一个金额表头，整张表从那一行起列就错位了。**
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} model - 条目身份（`模型@提供商`）或模型名。
 * @returns {{rates:object,markup:number}} 价目与倍率。
 */
export function resolveRate(pricing, model) {
  const key = String(model ?? '')
  const at = key.indexOf('@')
  const rollup = at <= 0 ? key : key.slice(0, at)
  const provider = at <= 0 ? '' : key.slice(at + 1)
  // **先精确键、后裸键**：宿主会同时下发 `models['deepseek-flash@commandcode']`
  // （带那个提供商的倍率）与 `models['deepseek-flash']`（官方价，倍率 1）。
  // 顺序反过来的话，按条目身份查价会取到裸键那条，倍率被静默吃掉。
  const modelEntry = pricing?.models?.[key] ?? pricing?.models?.[rollup]
  const entry = modelEntry ?? pricing?.rates?.[key] ?? pricing?.rates?.[rollup]
  if (entry === undefined || entry === null) {
    return { rates: pricing?.rates?.['deepseek-flash'] ?? FALLBACK_RATES, markup: markupOf(pricing, provider) }
  }
  // 包装形状：`{ rates, markup, currency }`。裸 RATE 形状没有 `rates` 这个键。
  const wrapped = entry.rates !== null && typeof entry.rates === 'object'
  const rates = toCny(wrapped ? entry.rates : entry, pricing)
  // 倍率优先取条目自带的（宿主为「模型 × 提供商」这一条算好的），否则查提供商整表。
  // 注意这里用的是 `modelEntry` 而不是 `entry`：当价目是从 `pricing.rates` 取到的
  // （旧宿主 / 看板把「我的单价」盖进 rates），倍率仍应来自 models 里那条身份条目。
  const declared = Number((modelEntry ?? entry).markup)
  const direct = Number.isFinite(declared) && declared > 0 ? declared : undefined
  return { rates, markup: direct ?? markupOf(pricing, provider) }
}

/**
 * 取某个模型的价目条目（**不含倍率**）。
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} model - 条目身份（`模型@提供商`）或模型名。
 * @returns {object} 价目条目。
 */
export function ratesFor(pricing, model) {
  return resolveRate(pricing, model).rates
}

/**
 * 取某个提供商的倍率。
 *
 * 两份来源：`pricing.markup`（宿主交下的「提供商 → 倍数」整表）与条目上的
 * `markup`。都没配过时返回 **1**——缺省就该是「不加价」，而不是猜一个。
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} provider - 提供商路由名。
 * @returns {number} 倍数。
 */
export function markupOf(pricing, provider) {
  const name = String(provider ?? '').trim()
  if (name === '') return 1
  const value = Number(pricing?.markup?.[name])
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * 按分档计价一份用量。
 *
 * 口径与宿主一致：高峰与空闲分别乘各自单价，而不是给整段用量套一个折扣；
 * 缓存写入若有官方那一档（`cacheWrite`）就用它，否则退回 DeepSeek 的 12.5 倍口径。
 * @param {object} usage - 含 peak / idle 分档的用量。
 * @param {object} rates - 价目条目（人民币）。
 * @param {number} [markup] - 提供商倍率（默认 1）。
 * @returns {{standard:number,peak:number,idle:number,ifAllIdle:number,saved:number}}
 */
export function priceUsage(usage, rates, markup = 1) {
  const million = 1_000_000
  const factor = Number.isFinite(Number(markup)) && Number(markup) > 0 ? Number(markup) : 1
  const writeRate = (period) => (rates?.cacheWrite === undefined
    ? Number(rates?.cacheHit?.[period] ?? 0) * 12.5
    : Number(rates.cacheWrite[period] ?? 0))
  const part = (bucket, period) =>
    (Number(bucket?.cacheHit ?? 0) / million) * Number(rates?.cacheHit?.[period] ?? 0)
    + (Number(bucket?.cacheMiss ?? 0) / million) * Number(rates?.cacheMiss?.[period] ?? 0)
    + (Number(bucket?.cacheWrite ?? 0) / million) * writeRate(period)
    + (Number(bucket?.output ?? 0) / million) * Number(rates?.output?.[period] ?? 0)

  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const peak = part(usage?.peak, 'peak')
  const idle = part(usage?.idle, 'idle')
  const allIdle = part({
    cacheHit: num(usage?.peak?.cacheHit) + num(usage?.idle?.cacheHit),
    cacheMiss: num(usage?.peak?.cacheMiss) + num(usage?.idle?.cacheMiss),
    cacheWrite: num(usage?.peak?.cacheWrite) + num(usage?.idle?.cacheWrite),
    output: num(usage?.peak?.output) + num(usage?.idle?.output),
  }, 'idle')
  return {
    standard: (peak + idle) * factor,
    peak: peak * factor,
    idle: idle * factor,
    ifAllIdle: allIdle * factor,
    saved: (peak + idle - allIdle) * factor,
  }
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
    const { rates, markup } = resolveRate(pricing, model)
    const cost = priceUsage(usage, rates, markup)
    standard += cost.standard
    peak += cost.peak
    idle += cost.idle
    ifAllIdle += cost.ifAllIdle
  }
  return { standard, peak, idle, ifAllIdle, saved: standard - ifAllIdle }
}
