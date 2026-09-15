/**
 * 时段窗口与费用口径。
 *
 * 官方口径（北京时间，见 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ）：
 *   高峰时段 = 周一至周五 9:00–12:00、14:00–18:00；
 *   其余时间（含全部周末）都是空闲时段，空闲价 = 高峰价的一半。
 *
 * 因此这里不是「一个折扣窗口」，而是「若干高峰窗口 + 空闲兜底」，
 * 费用也必须按每条请求发生时刻所属的时段分别计价，不能整段套一个折扣。
 * @module dsh-pixel-dashboard/lib/pricing
 */

/** 默认站点时区：北京时间。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 高峰时段窗口（站点时区当天时刻，单位分钟；endMinute 不含）。
 * 周一至周五 9:00–12:00 与 14:00–18:00。
 */
export const PEAK_WINDOWS = [
  { startMinute: 9 * 60, endMinute: 12 * 60 },
  { startMinute: 14 * 60, endMinute: 18 * 60 },
]

/** 高峰只落在工作日：0=周日 … 6=周六。 */
export const PEAK_WEEKDAYS = [1, 2, 3, 4, 5]

/**
 * 官方价目表（**人民币 / 百万 token**）。
 *
 * 两类口径，别混：
 *
 *   1) **DeepSeek 分时定价**：高峰（周一至周五 9:00–12:00、14:00–18:00）与空闲
 *      两档，空闲价恰为高峰价的一半，因此写成 `{ peak, idle }`。
 *   2) **其他厂商不分时**：只有一个价。为复用同一套聚合与计价逻辑，peak 与 idle
 *      写成同一个值，并用 `flat: true` 标明「这是无分时，不是打折」。
 *
 * 币种统一为人民币：智谱官方定价页本身就是「元 / 百万 token」，与 DeepSeek 一致，
 * 因此看板可以把两者相加而不会混币。**不要**搬别的目录里的美元数字——混币会静默算错。
 *
 * `tiered: true` 表示官方按**输入长度分档**定价（如 GLM-5.1 在 32K 前后不同价）。
 * 账本里没有可靠的逐请求输入长度，因此这里只填最低档，并由 `pricingOf()` 把
 * `tiered` 透出去让界面注明「按最低档估算」，而不是假装精确。
 */
export const MODEL_RATES = {
  'deepseek-flash': {
    label: 'DeepSeek Flash',
    vendor: 'DeepSeek',
    version: 'DeepSeek-V4.1-Flash',
    flat: false,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    cacheHit: { peak: 0.04, idle: 0.02 },
    cacheMiss: { peak: 2, idle: 1 },
    output: { peak: 8, idle: 4 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    version: 'DeepSeek-V4-Pro-0813',
    flat: false,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    cacheHit: { peak: 0.3, idle: 0.15 },
    cacheMiss: { peak: 9, idle: 4.5 },
    output: { peak: 27, idle: 13.5 },
  },
  // ── 智谱 GLM（元 / 百万 token，官方标准 API 定价，无分时）──────────────
  // 来源：https://docs.bigmodel.cn/cn/guide/start/pricing
  // 注意：Coding Plan 的**积分**抵扣另有「非高峰 50%」规则，那是订阅额度口径
  // （见 plans.js），与这里的按量金额不是一回事。
  'glm-5.3': {
    label: 'GLM-5.3',
    vendor: '智谱',
    version: 'GLM-5.3',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 2, idle: 2 },
    cacheMiss: { peak: 8, idle: 8 },
    output: { peak: 28, idle: 28 },
  },
  'glm-5.3-flash': {
    label: 'GLM-5.3-Flash',
    vendor: '智谱',
    version: 'GLM-5.3-Flash',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 0.23, idle: 0.23 },
    cacheMiss: { peak: 0.8, idle: 0.8 },
    output: { peak: 2.8, idle: 2.8 },
  },
  'glm-5.2': {
    label: 'GLM-5.2',
    vendor: '智谱',
    version: 'GLM-5.2',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 2, idle: 2 },
    cacheMiss: { peak: 8, idle: 8 },
    output: { peak: 28, idle: 28 },
  },
  'glm-4.6v': {
    label: 'GLM-4.6V',
    vendor: '智谱',
    version: 'GLM-4.6V',
    flat: true,
    tiered: true,
    contextWindow: 128_000,
    maxOutput: 32_768,
    // 官方分两档（<32K / 32K–128K），这里取最低档
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 1, idle: 1 },
    output: { peak: 3, idle: 3 },
  },
}

/**
 * 未知模型的兜底价：按 Flash 计，避免看板出现空洞。
 *
 * **兜底是「猜」而不是「知道」。** 落在兜底上的模型会在数据里被标成
 * `priced: false`，界面据此显示「按 Flash 估算」，而不是让一个猜出来的数字
 * 看起来像官方价。静默兜底正是最容易骗到自己的一种错。
 */
export const FALLBACK_RATES = MODEL_RATES['deepseek-flash']

/**
 * 旧名 / 别名 → 价目表键。
 *
 * DeepSeek：官方说明旧名仍可调用但按 Flash 计费。
 * `deepseek-v4.1-flash` 是 **DSH 侧实际在用的模型名**（本机账本里就有近 2000 条），
 * 不折叠的话它会走兜底：金额虽然一样，但会被标成「估算不准」并多出一行以原始名
 * 展示的模型，看起来像另一个模型。
 * 智谱：官方说明调用历史模型会自动切换（GLM-5.2 → GLM-5.3，GLM-4.7 → GLM-5.3-Flash 等）。
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  // WorkBuddy 给同一个 DeepSeek Flash 起的别名（本机账本里有实测记录）。
  // 不折叠就会多出一行「DeepSeek Flash / hy4-preview-f」并标成「估算价」——
  // 明明是按 Flash 计费的同一个模型，看起来却像另一个来路不明的模型。
  'hy4-preview-f': 'deepseek-flash',
  'glm-5.3-highspeed': 'glm-5.3',
  'glm-5.2-highspeed': 'glm-5.2',
  'glm-5.1': 'glm-5.3',
  'glm-5-turbo': 'glm-5.3-flash',
  'glm-4.7': 'glm-5.3-flash',
  'glm-5v-turbo': 'glm-5.3-flash',
}

/**
 * 把模型名归一：旧名与带日期的版本名折叠到价目表里的键。
 *
 * **必须容忍带发售日 / 变体标记的名字。** DSH 的模型 id 有时是
 * `deepseek-v4-flash-ga-260731` 这种「名字 + 变体 + 发售日」的形态，
 * 早先只剥一个四位日期后缀（`-0813`），`-ga-260731` 就漏了：它会走兜底价，
 * 在费用明细里多出一行看起来像另一个模型的条目（实测本机账本里就有）。
 * @param {string} model - 原始模型名。
 * @returns {string} 价目表键。
 */
export function normalizeModel(model) {
  const name = String(model ?? '').trim()
  if (name === '') return 'unknown'
  if (MODEL_RATES[name] !== undefined) return name
  const aliased = MODEL_ALIASES[name]
  if (aliased !== undefined) return aliased
  // 逐层剥后缀：每剥掉一段都回头查一次价目表与别名表。变体标记（`-ga` /
  // `-preview` / …）与发售日（可能是 4 位年份+月，也可能只有 4 位）可以交替
  // 出现，因此这里循环而不是一次正则。
  let candidate = name
  for (let i = 0; i < 4; i += 1) {
    const next = candidate.replace(/-(?:\d{4,6}|ga|preview|exp|beta|stable|release)$/, '')
    if (next === candidate) break
    candidate = next
    if (MODEL_RATES[candidate] !== undefined) return candidate
    const alias = MODEL_ALIASES[candidate]
    if (alias !== undefined) return alias
  }
  return name
}

/**
 * 取价目表条目。
 * @param {string} model - 模型名（可为旧名）。
 * @returns {object} 价目表条目。
 */
export function ratesOf(model) {
  return MODEL_RATES[normalizeModel(model)] ?? FALLBACK_RATES
}

/**
 * 取价目表条目，并说明这价格**是不是真的知道**。
 *
 * 与 {@link ratesOf} 的区别：后者永远返回一个可用价（兜底 Flash），调用方无法分辨
 * 「这是该模型的官方价」还是「猜的」。费用估算里这两者差别很大——把兜底价当真价展示，
 * 就是让用户相信一个错误的数字。
 * @param {string} model - 模型名（可为旧名）。
 * @returns {{rates:object,known:boolean,tiered:boolean,key:string,label:string,vendor:string}} 价目与可信度。
 */
export function pricingOf(model) {
  const key = normalizeModel(model)
  const rates = MODEL_RATES[key]
  if (rates === undefined) {
    return {
      rates: FALLBACK_RATES,
      known: false,
      tiered: false,
      key,
      label: FALLBACK_RATES.label,
      vendor: FALLBACK_RATES.vendor ?? '未知',
    }
  }
  return {
    rates,
    known: true,
    tiered: rates.tiered === true,
    key,
    label: rates.label,
    vendor: rates.vendor ?? '',
  }
}

/**
 * 站点时区 → 已构造好的 formatter。
 *
 * **必须复用，不能每次现造。** `zonedParts()` 落在两条热路径上：导入账本时每条
 * 记录都要判一次高峰/空闲（本机 2400 条记录 ≈ 7000 次调用），而 `periodState()`
 * 找翻转点还要逐分钟扫几千次。实测每次新建 `Intl.DateTimeFormat` 约 51µs、
 * 复用约 2µs（11520 次调用 592ms → 23ms，差 26 倍）。formatter 自身无状态，
 * 按 IANA 名缓存即可，也不改变任何判定结果。
 * @type {Map<string, Intl.DateTimeFormat>}
 */
const ZONED_FORMATTERS = new Map()

/**
 * 取（并缓存）某个时区的 formatter。
 * @param {string} timeZone - IANA 时区名。
 * @returns {Intl.DateTimeFormat} formatter。
 */
function zonedFormatter(timeZone) {
  const cached = ZONED_FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  // 非法时区名在这里抛 RangeError，与「每次现造」时的行为一致：不缓存坏结果，
  // 因此下一次调用仍会抛出同一个错，不会把错误吞成静默降级。
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  ZONED_FORMATTERS.set(timeZone, created)
  return created
}

/**
 * 取站点时区下的“墙钟”字段。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,weekday:number,minuteOfDay:number}}
 */
export function zonedParts(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const bag = {}
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') bag[part.type] = part.value
  }
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(bag.weekday)
  // Intl 在 hour12:false 下可能给出 24 点，归一到 0 点
  const hour = Number(bag.hour) % 24
  const minute = Number(bag.minute)
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute,
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
    minuteOfDay: hour * 60 + minute,
  }
}

/** `YYYY-MM-DD` 日期键（站点时区）。 */
export function dateKey(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(epochMs, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * 判断某个时刻是否处于高峰时段。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {boolean} 高峰为真。
 */
export function isPeak(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(epochMs, timeZone)
  if (!PEAK_WEEKDAYS.includes(p.weekday)) return false
  return PEAK_WINDOWS.some((w) => p.minuteOfDay >= w.startMinute && p.minuteOfDay < w.endMinute)
}

/** 分钟步长，用于扫描下一次时段翻转。 */
const STEP_MS = 60_000

/** 扫描上限：8 天足够越过一整个周末。 */
const STEP_LIMIT = 8 * 24 * 60

/**
 * 当前时段状态、下一次切换时间，以及**本段已走了多久**。
 *
 * 多返回 `prevChangeMs` / `periodMs` 是为了让界面能画出「本段还剩多少」的环形进度条
 * （侧栏按钮上那枚时段指示灯）：只有 `nextChangeMs` 时，界面知道还剩多久、却不知道
 * 这一段总长，画不出比例。
 *
 * 两次扫描都按**整分钟**推进，因为翻转点一定落在整分钟上（9:00 / 12:00 / 14:00 / 18:00）。
 * 站点时区的偏移都是整分钟的倍数，所以绝对时刻的分钟边界与墙钟分钟边界一致。
 * 返回的 `nextChangeMs + prevChangeMs` 恰好等于本段总长：
 *   例 11:00:30（高峰 9:00–12:00）→ next = 59.5 分、prev = 120.5 分，合计 180 分。
 * 正好站在边界上时 `prevChangeMs` 为 0，于是 `periodMs === nextChangeMs`，仍然正确。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {{peak:boolean,minuteOfDay:number,weekday:number,nextChangeMs:number,prevChangeMs:number,periodMs:number,nextPeak:boolean,label:string}}
 */
export function periodState(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(epochMs, timeZone)
  const peak = isPeak(epochMs, timeZone)
  // 当前时刻在本分钟里已走的毫秒数：扫描按整分钟对齐，把这段零头补上才是真实剩余。
  const intoMinute = epochMs % STEP_MS

  // 向前找第一次翻转
  let nextChangeMs = 0
  for (let i = 1; i <= STEP_LIMIT; i += 1) {
    if (isPeak(epochMs + i * STEP_MS, timeZone) !== peak) {
      nextChangeMs = i * STEP_MS - intoMinute
      break
    }
  }

  // 向后找最近一次翻转。扫描只告诉我们「翻转发生在上一个整分钟里」，
  // 而翻转点本身在那一分钟的**上端**，因此是 (i - 1) 而不是 i：
  // 从 11:00:30 往回扫到 8:59:30 才变，翻转点其实是 9:00:00，已走 2 小时 0 分 30 秒。
  let prevChangeMs = 0
  for (let i = 1; i <= STEP_LIMIT; i += 1) {
    if (isPeak(epochMs - i * STEP_MS, timeZone) !== peak) {
      prevChangeMs = (i - 1) * STEP_MS + intoMinute
      break
    }
  }

  return {
    peak,
    minuteOfDay: p.minuteOfDay,
    weekday: p.weekday,
    nextChangeMs,
    prevChangeMs,
    periodMs: prevChangeMs + nextChangeMs,
    nextPeak: !peak,
    label: peak ? '高峰时段' : '空闲时段',
  }
}

/**
 * 按用量所属时段计费。
 *
 * 口径正确性的关键：历史用量必须按它当时处于高峰还是空闲来计价，
 * 不能把整段用量套同一个折扣。
 * @param {{cacheHit:number,cacheMiss:number,output:number}} usage - token 数。
 * @param {object} rates - 价目表条目。
 * @param {'peak'|'idle'} period - 该笔用量所属时段。
 * @returns {number} 金额（元）。
 */
export function costOf(usage, rates, period) {
  const million = 1_000_000
  return (
    (Number(usage.cacheHit ?? 0) / million) * rates.cacheHit[period]
    + (Number(usage.cacheMiss ?? 0) / million) * rates.cacheMiss[period]
    + (Number(usage.output ?? 0) / million) * rates.output[period]
  )
}

/**
 * 人民币金额格式化：小额保留更多位，避免整天显示 ¥0.00。
 * @param {number} value - 金额。
 * @returns {string} 形如 `¥12.34`。
 */
export function formatCny(value) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount === 0) return '¥0'
  if (Math.abs(amount) >= 1) return `¥${amount.toFixed(2)}`
  if (Math.abs(amount) >= 0.01) return `¥${amount.toFixed(3)}`
  return `¥${amount.toFixed(4)}`
}
