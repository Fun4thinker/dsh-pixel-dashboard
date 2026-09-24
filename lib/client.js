window.__ModuleLoader__.load({
	id: "dsh-pixel-dashboard",
	factory: (platformRequire) => {
		const MODULES = {
		"./format.js": (exports, require) => {
			/**
 * 展示层格式化助手：数字、金额、时间、日期。纯函数，无外部依赖。
 * @module dsh-pixel-dashboard/client/format
 */

/**
 * 人民币金额格式化：小额保留更多位，避免显示成 ¥0.00。
 * @param {number} value - 金额。
 * @returns {string} 形如 `¥12.34`。
 */
function formatCny(value) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount === 0) return '¥0'
  if (Math.abs(amount) >= 1) return `¥${amount.toFixed(2)}`
  if (Math.abs(amount) >= 0.01) return `¥${amount.toFixed(3)}`
  return `¥${amount.toFixed(4)}`
}

/**
 * 坐标轴用的紧凑金额：**按数量级选小数位**，而不是固定保留。
 *
 * 与 {@link formatCny} 的分工：那个用在读数与合计上，越精确越好；这个要塞进
 * Y 轴左边那 48px 里，而消费估计的刻度常常是 `¥0.0075` 这种——固定 4 位小数会
 * 让标签比刻度间距还宽，两个标签叠在一起就都读不出来了。
 * 按数量级降到 3 位左右有效数字，宽度就稳定在 6~7 个字符以内。
 * @param {number} value - 金额。
 * @returns {string} 形如 `¥12`、`¥1.5`、`¥0.038`。
 */
function formatCnyAxis(value) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount === 0) return '¥0'
  const abs = Math.abs(amount)
  if (abs >= 1000) return `¥${Math.round(amount)}`
  if (abs >= 10) return `¥${amount.toFixed(0)}`
  if (abs >= 1) return `¥${amount.toFixed(1)}`
  if (abs >= 0.1) return `¥${amount.toFixed(2)}`
  if (abs >= 0.01) return `¥${amount.toFixed(3)}`
  return `¥${amount.toFixed(4)}`
}

/**
 * token 数按**大模型通用单位**缩略：K / M / 亿。
 *
 * K 与 M 保留英文写法：这套界面里的数字几乎全是 token，而 token 的通用单位就是
 * K / M——模型文档写「128K 上下文」「1M tokens」，用同一套单位读者不必二次换算。
 *
 * 十亿档改成中文的「亿」：`B` 是 billion（10⁹），中文的「亿」是 10⁸，**两者不是
 * 同一个数**。只把后缀换成中文而沿用 `B` 的阈值，会让同一个数字平白差一个数量级
 * （`1_395_646_416` 会显示成「1.40亿」，而它其实是 13.96 亿）。因此这一档的阈值
 * 按「亿」本身取 10⁸。
 *
 * 于是相邻档位的比值不再统一是 1000——**K→M 是 1000，M→亿 是 100**——进位判断
 * 必须按各自的实际比值来（见下）。
 *
 * 三档阶梯（外加不足千的原值）：
 *
 * | 数量级 | 单位 | 小数位 | 例 |
 * |---|---|---|---|
 * | ≥ 1 亿 | `亿` | 2 | `6.17亿` |
 * | ≥ 100 万 | `M` | 2 | `6.17M` |
 * | ≥ 1 千 | `K` | 1 | `300.0K` |
 * | 其余 | — | 0 | `999` |
 *
 * **进位后跨过阈值时要升档**：`999_999` 按 K 算是 `999.999K`，四舍五入成
 * `1000.0K`——那既难看又会让同一个数在两处以两种单位出现。因此先取可用档位，
 * 再检查四舍五入后的尾数是否已达**上一档的起点**（K 是 1000，M 是 100），
 * 是就升到上一档（得到 `1.00M`；而 `99_999_999` 得到 `1.00亿` 而不是 `100.00M`）。
 * @param {number} value - token 数。
 * @returns {string} 形如 `6.17亿`、`617.28M`、`300.0K`、`999`。
 */
function formatTokens(value) {
  const amount = Number(value ?? 0)
  // 显式挡掉非有限数：下面所有比较对 NaN 都为 false，会一路走到
  // `String(Math.round(NaN))`，把字面的 `NaN` 渲染出来。这些数字直接来自宿主字段。
  if (!Number.isFinite(amount)) return '0'
  const abs = Math.abs(amount)
  /** 从小到大：先定位可用的最小档位，再按需向上进位。 */
  const LADDER = [
    { scale: 1e3, digits: 1, suffix: 'K' },
    { scale: 1e6, digits: 2, suffix: 'M' },
    { scale: 1e8, digits: 2, suffix: '亿' },
  ]
  let index = -1
  for (let i = 0; i < LADDER.length; i += 1) if (abs >= LADDER[i].scale) index = i
  if (index === -1) return String(Math.round(amount))
  // 四舍五入可能把尾数推到下一档的起点（见上面 `999_999` 与 `99_999_999` 两个
  // 例子），那就升一档。**上限不能写死 1000**：档位比值是 1000 / 100 两段，
  // 写死 1000 会让 `99_999_999` 停在 `100.00M`——正好是 1 亿，该用「亿」。
  // 最大档不再升：token 数到 `1000.00亿` 已不现实，而凭空造一个「万亿」更糟。
  while (index < LADDER.length - 1) {
    const step = LADDER[index]
    const start = LADDER[index + 1].scale / step.scale
    if (Number((amount / step.scale).toFixed(step.digits)) < start) break
    index += 1
  }
  const step = LADDER[index]
  return `${(amount / step.scale).toFixed(step.digits)}${step.suffix}`
}

/**
 * 毫秒差格式化为倒计时文本。
 *
 * 与 {@link compactCountdown} 一样必须显式挡掉非有限数：`Math.max(0, NaN)` 仍是
 * `NaN`，会渲染成 `NaN 秒`。看板里那条倒计时直接读宿主字段，脏数据是会见得到的。
 * @param {number} ms - 剩余毫秒。
 * @returns {string} 形如 `3 小时 12 分 05 秒`。
 */
function formatCountdown(ms) {
  const raw = Number(ms)
  if (!Number.isFinite(raw)) return '0 秒'
  const total = Math.max(0, Math.floor(raw / 1000))
  const pad = (value) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} 小时 ${pad(minutes)} 分 ${pad(seconds)} 秒`
  if (minutes > 0) return `${minutes} 分 ${pad(seconds)} 秒`
  return `${seconds} 秒`
}

/**
 * 毫秒差格式化为**紧凑**倒计时，供侧栏那一行使用。
 *
 * 与 {@link formatCountdown} 的分工：那个写在悬停提示里，读得越清楚越好；
 * 这个要塞进侧栏行图标旁边，每多一个字就少一个字给「用量看板」这个标题。
 * `3 小时 12 分 05 秒` 有十几个字符宽（约 90px），足以把标题挤没；
 * 紧凑版最长 5 个字符（如 `2天3时`），因此放得下。
 *
 * **必须显式挡掉非有限数**：`Math.max(0, NaN)` 仍然是 `NaN`，一路会渲染成
 * `NaN天NaN时` 这种串。脏数据在真实环境里是会见到的（宿主字段缺失、时钟异常），
 * 而这是每秒重画的一行，出问题会一直闪。读不懂就显示 `0秒`。
 * @param {number} ms - 剩余毫秒。
 * @returns {string} 形如 `45秒`、`45分`、`3时12分`、`2天3时`。
 */
function compactCountdown(ms) {
  const raw = Number(ms)
  if (!Number.isFinite(raw)) return '0秒'
  const total = Math.max(0, Math.floor(raw / 1000))
  if (total < 60) return `${total}秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}时${minutes % 60}分`
  return `${Math.floor(hours / 24)}天${hours % 24}时`
}

/**
 * “当天第几分钟”渲染为 `HH:MM`。
 * @param {number} minuteOfDay - 0..1439。
 * @returns {string} 形如 `08:30`。
 */
function formatMinuteOfDay(minuteOfDay) {
  const minute = (((Number(minuteOfDay) || 0) % 1440) + 1440) % 1440
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** 日期键 `YYYY-MM-DD` → `M/D`。 */
function shortDate(key) {
  const parts = String(key).split('-')
  if (parts.length !== 3) return String(key)
  return `${Number(parts[1])}/${Number(parts[2])}`
}

/** 时刻 → 站点时区下的 `MM-DD HH:MM`。 */
function formatDateTime(epochMs, timeZone) {
  if (!epochMs) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs))
}

/**
 * 站点时区下某时刻的“当天第几分钟”。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {number} 0..1439。
 */
function minuteOfDay(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(epochMs))
  const bag = {}
  for (const part of parts) if (part.type !== 'literal') bag[part.type] = part.value
  return (Number(bag.hour) % 24) * 60 + Number(bag.minute)
}

/** 日期键位移。 */
function shiftKey(key, deltaDays) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10)
}

			exports.formatCny = formatCny
			exports.formatCnyAxis = formatCnyAxis
			exports.formatTokens = formatTokens
			exports.formatCountdown = formatCountdown
			exports.compactCountdown = compactCountdown
			exports.formatMinuteOfDay = formatMinuteOfDay
			exports.shortDate = shortDate
			exports.formatDateTime = formatDateTime
			exports.minuteOfDay = minuteOfDay
			exports.shiftKey = shiftKey
		},
		"./cost.js": (exports, require) => {
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
function ratesFor(pricing, model) {
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
function priceUsage(usage, rates) {
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
function priceByModel(byModel, pricing) {
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

			exports.ratesFor = ratesFor
			exports.priceUsage = priceUsage
			exports.priceByModel = priceByModel
		},
		"./rates.js": (exports, require) => {
			/**
 * 自定义单价（浏览器半边）：取数、保存与表单草稿。
 *
 * 与宿主 lib/custom-rates.js 成对。这里刻意**不重复任何校验逻辑**：校验只有宿主
 * 那一份（它同时负责落盘），浏览器只负责把用户输入整理成候选对象，并如实展示宿主
 * 返回的错误。两处各写一份校验，迟早会出现「界面说没问题、宿主拒绝」这种最难解释的分歧。
 * @module dsh-pixel-dashboard/client/rates
 */

/** 自定义价目路由，与宿主注册路径一致。 */
const RATES_URL = '/dsh-pixel/rates'

/** 价目不是关键路径，超时给短一些，失败就明说。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 取自定义价目的当前状态。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主回报的状态（路径、条数、条目、错误）。
 */
async function fetchRates(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(RATES_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      // 404 有确定含义：宿主是还没有这条路由的旧版本。明说，而不是抛「HTTP 404」。
      if (response.status === 404) throw new Error('宿主没有自定义价目路由（插件版本可能过旧，重启 dsh 试试）')
      throw new Error('HTTP ' + response.status)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 保存整份自定义价目。
 *
 * 校验失败时宿主回 400 并带上逐条原因，这里把它抛成 Error（消息是拼接后的人话），
 * 让面板能直接把原因摆在用户面前——「保存失败」四个字帮不了他。
 * @param {object} rates - 模型键 → 价目条目。
 * @returns {Promise<object>} 宿主回报的新状态。
 * @throws {Error} 校验失败或网络失败。
 */
async function saveRates(rates) {
  const response = await fetch(RATES_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ rates }),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : []
    const detail = errors.length > 0
      ? errors.join('；')
      : (typeof payload?.error === 'string' ? payload.error : 'HTTP ' + response.status)
    throw new Error(detail)
  }
  return payload
}

/**
 * 把界面上的一行输入整理成价目条目。
 *
 * 与宿主的校验口径一致：
 *   - 每档各填**一个数** → 不分时；
 *   - 同一档填 idle 与 peak 两个数 → 分时；
 *   - 缓存命中留空 → 按 0 计（很多模型没有缓存优惠，逼用户填一个 0 反而增加出错机会）。
 *
 * 空字符串一律视为「没填」而不是 0：`Number('')` 是 0，会把「没填」变成「免费」——
 * 那正是本项目反复强调要避免的一类静默错误。
 * @param {object} input - 界面字段。
 * @returns {object|undefined} 价目条目；输入与输出都为空时 undefined。
 */
function composeRate(input) {
  const num = (value) => {
    if (value === undefined || value === null) return undefined
    const text = String(value).trim()
    if (text === '') return undefined
    const amount = Number(text)
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined
  }
  const pair = (idle, peak) => {
    const low = num(idle)
    const high = num(peak)
    if (low === undefined && high === undefined) return undefined
    // 只填了一个档：另一个档按同一个值算（用户多半是想写不分时）
    if (low === undefined) return { idle: high, peak: high }
    if (high === undefined) return { idle: low, peak: low }
    return { idle: low, peak: high }
  }
  const cacheMiss = pair(input?.cacheMissIdle, input?.cacheMissPeak)
  const output = pair(input?.outputIdle, input?.outputPeak)
  if (cacheMiss === undefined && output === undefined) return undefined
  const zero = { idle: 0, peak: 0 }
  const label = typeof input?.label === 'string' && input.label.trim() !== '' ? input.label.trim() : undefined
  const vendor = typeof input?.vendor === 'string' && input.vendor.trim() !== '' ? input.vendor.trim() : '自定义'
  const entry = {
    vendor,
    cacheHit: pair(input?.cacheHitIdle, input?.cacheHitPeak) ?? zero,
    cacheMiss,
    output,
  }
  if (label !== undefined) entry.label = label
  return entry
}

/**
 * 把一个条目摊平成界面上的输入框草稿。
 *
 * 条目里每个字段都可能是「一个数」或 `{ idle, peak }`；编辑器统一按分时的六格
 * 展示，不分时的条目两格填同一个值。这样只有一种编辑形态，用户不必先判断
 * 「这个模型是不是分时」——那个判断对他的任务没有任何帮助。
 * @param {object|undefined} rate - 价目条目。
 * @returns {object} 表单草稿。
 */
function draftOf(rate) {
  const text = (value) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? '' : String(Number(value)))
  const side = (field, key) => {
    const value = rate?.[field]
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') return text(value[key])
    return text(value)
  }
  return {
    label: typeof rate?.label === 'string' ? rate.label : '',
    vendor: typeof rate?.vendor === 'string' ? rate.vendor : '',
    cacheHitIdle: side('cacheHit', 'idle'),
    cacheHitPeak: side('cacheHit', 'peak'),
    cacheMissIdle: side('cacheMiss', 'idle'),
    cacheMissPeak: side('cacheMiss', 'peak'),
    outputIdle: side('output', 'idle'),
    outputPeak: side('output', 'peak'),
  }
}

			exports.fetchRates = fetchRates
			exports.saveRates = saveRates
			exports.composeRate = composeRate
			exports.draftOf = draftOf
		},
		"./balance.js": (exports, require) => {
			/**
 * 官方账户余额（浏览器半边）：取数、开关、金额格式化。
 *
 * 隐私约定（与宿主 lib/balance.js 成对，改动前请先读完）：
 *   - 浏览器**永远拿不到 API Key**。宿主只回报币种、金额、来源层名（如 `env`），
 *     以及是否真的是官方端点；这里不做任何拼装 Key 的尝试。
 *   - 余额查询可以由用户在看板上关掉；关掉后宿主不再向官方端点发任何请求。
 *   - 显示什么币种由接口决定（可能同时有 CNY 与 USD），这里不做汇率换算。
 *
 * 纯逻辑与格式化，不含 React，便于直接渲染校验。
 * @module dsh-pixel-dashboard/client/balance
 */

/** 余额取数路由，与宿主注册路径一致。 */
const BALANCE_URL = '/dsh-pixel/balance'

/** 开关路由：POST `{ target, enabled }`。后台所有开关共用这一条。 */
const TOGGLE_URL = '/dsh-pixel/toggle'

/** 余额不是关键路径，超时给短一些，失败就明说。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 币种符号。未列出的币种直接显示代码（如 `SGD 12.00`），
 * 而不是猜一个符号——猜错币种比不显示更糟。
 */
const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$' }

/**
 * 格式化一个可能缺失的金额。
 *
 * 金额缺失（字段读不懂或接口没给）时返回 `—` 而不是 `¥0`：
 * 把「不知道」显示成 0 会让人以为余额真的空了。
 * @param {number|undefined} value - 金额。
 * @param {string} currency - 币种代码。
 * @returns {string} 形如 `¥12.34`、`-¥0.79`、`—`。
 */
function formatMoney(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  const code = typeof currency === 'string' && currency !== '' ? currency : 'CNY'
  const symbol = CURRENCY_SYMBOLS[code]
  // 负数把符号放在最前：¥-0.79 读起来别扭，-¥0.79 才是中文习惯
  const sign = amount < 0 ? '-' : ''
  const text = Math.abs(amount).toFixed(2)
  return symbol === undefined ? `${sign}${code} ${text}` : `${sign}${symbol}${text}`
}

/**
 * 余额负载是否含有可显示的金额。
 * @param {object|undefined} payload - 宿主返回的余额段。
 * @returns {boolean} 是否有金额。
 */
function hasBalance(payload) {
  if (payload === null || typeof payload !== 'object') return false
  if (!Array.isArray(payload.balances)) return false
  return payload.balances.some((row) => Number.isFinite(Number(row?.total)))
}

/**
 * 把余额负载压成一句话，供费用条那种一行位置使用。
 *
 * 多币种时用 ` / ` 连接；一个都没有时返回 undefined（调用方据此不渲染）。
 * @param {object|undefined} payload - 宿主返回的余额段。
 * @returns {string|undefined} 形如 `¥12.34` 或 `¥12.34 / $3.00`。
 */
function balanceSummary(payload) {
  if (!hasBalance(payload)) return undefined
  return payload.balances
    .filter((row) => Number.isFinite(Number(row?.total)))
    .map((row) => formatMoney(row.total, row.currency))
    .join(' / ')
}

/**
 * 余额是否处于「可用」状态。接口未给该字段时返回 undefined（未知，不装作正常）。
 * @param {object|undefined} payload - 宿主返回的余额段。
 * @returns {boolean|undefined} 可用性。
 */
function balanceAvailable(payload) {
  const value = payload?.available
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 由余额负载算出一句人话的状态说明，供界面直接展示。
 *
 * 降级必须可见：拿不到余额时要说清是「没配 Key」「请求失败」还是「被关掉了」，
 * 而不是留白——留白会让人以为是插件坏了。
 * @param {object|undefined} payload - 宿主返回的余额段。
 * @returns {{level:'ok'|'warn'|'off'|'error', text:string}} 状态。
 */
function balanceStatus(payload) {
  if (payload === null || typeof payload !== 'object') {
    return { level: 'error', text: '宿主未提供余额数据（插件版本可能过旧）' }
  }
  if (payload.enabled === false) {
    return {
      level: 'off',
      text: payload.lockedByEnv === true
        ? '余额查询已被环境变量 DSH_PIXEL_BALANCE 关闭'
        : '余额查询已关闭，宿主不会向官方端点发起请求',
    }
  }
  if (payload.reason === 'no-key') {
    return { level: 'warn', text: `没有找到 ${payload.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}，无法查询余额` }
  }
  if (payload.reason === 'no-fetch') {
    return { level: 'warn', text: '当前运行环境没有可用的 fetch，无法查询余额' }
  }
  if (typeof payload.error === 'string' && payload.error !== '') {
    return { level: 'error', text: `余额查询失败：${payload.error}` }
  }
  if (!hasBalance(payload)) {
    return { level: 'warn', text: '官方接口没有返回余额条目' }
  }
  // 端点是从哪推出来的：**猜出来的要说出来**。DSH 0.1.7 换掉了 settings 的取数
  // API，若插件没能读到 `llm-deepseek` 段，就会退回官方默认端点——查到的数字
  // 与用户真的配了代理时长得一模一样，不说出来用户没有任何办法发现。
  if (payload.settingsVia === 'unreadable') {
    return {
      level: 'warn',
      text: `读不到 llm-deepseek 设置（${payload.settingsError ?? '原因未知'}），当前按官方端点查询；若你配过自建端点，这个数字可能不对`,
    }
  }
  return { level: 'ok', text: '余额来自官方接口' }
}

/**
 * 取余额。
 * @param {{refresh?:boolean, signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主返回的余额段。
 */
async function fetchBalance(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const url = options.refresh === true ? `${BALANCE_URL}?refresh=1` : BALANCE_URL
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      // 404 有确定含义：宿主是还没有余额路由的旧版本。明说这一点，
      // 而不是抛一个「HTTP 404」让用户去猜是不是插件坏了。
      if (response.status === 404) {
        throw new Error('宿主没有余额路由（插件版本可能过旧，重启 dsh 试试）')
      }
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 打开/关闭一个后台开关。
 *
 * 失败要抛错而不是静默：用户点了开关却没生效，必须让他知道，
 * 否则下次打开界面看到数据又回来了会莫名其妙。
 * @param {'balance'|'plans'} target - 目标功能。
 * @param {boolean} enabled - 目标状态。
 * @returns {Promise<{target:string,enabled:boolean,persisted:boolean,lockedByEnv:boolean,message?:string}>} 结果。
 */
async function setToggle(target, enabled) {
  const response = await fetch(TOGGLE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ target, enabled: enabled === true }),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = body.error
    } catch {
      // 响应不是 JSON 时保留状态码说明
    }
    throw new Error(`开关未生效：${detail}`)
  }
  return await response.json()
}

/**
 * 打开/关闭余额查询（{@link setToggle} 的便捷包装）。
 * @param {boolean} enabled - 目标状态。
 * @returns {Promise<object>} 结果。
 */
function setBalanceEnabled(enabled) {
  return setToggle('balance', enabled)
}

			exports.formatMoney = formatMoney
			exports.hasBalance = hasBalance
			exports.balanceSummary = balanceSummary
			exports.balanceAvailable = balanceAvailable
			exports.balanceStatus = balanceStatus
			exports.fetchBalance = fetchBalance
			exports.setToggle = setToggle
			exports.setBalanceEnabled = setBalanceEnabled
		},
		"./plans.js": (exports, require) => {
			/**
 * 第三方套餐额度（浏览器半边）：取数、开关、进度计算与格式化。
 *
 * 隐私约定（与宿主 lib/plans.js 成对）：浏览器**永远拿不到任何密钥**。宿主只回报
 * 币种化后的额度数字、来源标记（`credentials` / `env` / `cli-file`）与一个打码后的
 * 尾段（如 `…a1b2`），用于让用户确认「用的是哪一把 Key」。
 *
 * 纯逻辑与格式化，不含 React，便于直接渲染校验。
 * @module dsh-pixel-dashboard/client/plans
 */

/** 套餐额度取数路由。 */
const PLANS_URL = '/dsh-pixel/plans'

/** 超时：套餐额度不是关键路径，失败就明说。 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * 窗口显示顺序：由短到长。
 * 智谱没有 monthly，缺的窗口自然不渲染。
 */
const WINDOW_ORDER = ['fiveHour', 'weekly', 'monthly']

/**
 * 格式化一个额度数值。
 *
 * Command Code 的额度是**美元信用额**（`$70` 这种），智谱是**积分**。
 * 两者单位不同，所以数值前面要带单位前缀，不能只给一个裸数字。
 * @param {number|undefined} value - 数值。
 * @param {string} unit - 单位前缀（如 `$`）。
 * @returns {string} 形如 `$70` 或 `—`。
 */
function formatQuota(value, unit = '') {
  if (value === undefined || value === null) return '—'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  // 信用额通常带两位小数，积分多为整数；按是否有小数部分决定精度
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
  return `${unit}${text}`
}

/**
 * 把一个额度字段转成有限数字。
 *
 * `Number(null)` 与 `Number('')` 都是 `0`——接口字段缺失时直接 `Number()` 会把
 * 「没有这个数」变成「这个数是 0」，正是最该避免的那种谎报。所以显式挡掉。
 * @param {unknown} value - 原始值。
 * @returns {number|undefined} 有限数字，否则 undefined。
 */
function finiteNumber(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : undefined
}

/**
 * 把窗口归一成界面要用的进度。
 *
 * 四条规则，都是为了让界面不撒谎：
 *   - 有 `usedPercent` 就直接用（宿主已经优先按绝对值算过）；
 *   - 有绝对值（`used` + `total`）但没百分比时自己算，不让窗口掉成「未知」；
 *   - **只有「剩余」时百分比是未知，不是 0**：报 `percentKnown: false` 并带上
 *     `remainingText`，界面显示 `—` 而不是画一条 0% 的空条；
 *   - 什么都没有时返回 `usable: false`，界面显示 `—`。
 *
 * 最后一条是踩过的坑：早先这里写的是 `percent = hasPercent ? usedPercent : 0`，
 * 于是「官方只报了余额」的窗口（Command Code 的月度就是这样）在卡片上永远显示
 * 「0.0%」——一个看起来像事实的假数字。`percentKnown` 就是为了不再重犯。
 *
 * **百分比可以超过 100**（额度用超时官方会给出 >100 的值）。这里保留真实数值，
 * 只用 `barPercent` 给进度条夹一个 0–100 的宽度——否则 140% 会被显示成 100%，
 * 把「已严重超限」伪装成「刚好用满」。
 * @param {object} window - 宿主返回的窗口。
 * @returns {{usable:boolean,percentKnown:boolean,percent:number,barPercent:number,over:boolean,estimated:boolean,remainingText:string,totalText:string,note:string}} 进度。
 */
function windowProgress(window) {
  const usedPercent = finiteNumber(window?.usedPercent)
  const used = finiteNumber(window?.used)
  const total = finiteNumber(window?.total)
  const remaining = finiteNumber(window?.remaining)
  const unit = window?.unit ?? ''
  const note = typeof window?.note === 'string' ? window.note : ''
  const hasAbsolute = used !== undefined && total !== undefined && total > 0
  // 百分比只有两个来源：官方直接给的，或绝对值算出来的。其余一律是「未知」。
  const percentKnown = usedPercent !== undefined || hasAbsolute
  if (!percentKnown && remaining === undefined) {
    return {
      usable: false, percentKnown: false, percent: 0, barPercent: 0,
      over: false, estimated: false, remainingText: '—', totalText: '—', note,
    }
  }
  // 负百分比没有意义（官方在极端情况下会给），挡掉；上溢照实保留
  const percent = Math.max(0, percentKnown ? (usedPercent ?? (used / total) * 100) : 0)
  const remainingText = remaining !== undefined
    ? formatQuota(remaining, unit)
    : (hasAbsolute ? formatQuota(total - used, unit) : '—')
  const totalText = total !== undefined ? formatQuota(total, unit) : '—'
  return {
    usable: true,
    percentKnown,
    percent,
    // 进度条宽度单独夹取：条最多画满，但数字照实显示
    barPercent: Math.min(100, percent),
    over: percent > 100 || window?.exceeded === true,
    // 没有绝对值、只有百分比时，百分比本身可能被官方向下取整，标出来
    estimated: window?.percentOnly === true,
    remainingText,
    totalText,
    note,
  }
}

/**
 * 进度对应的色调：越接近用尽越警戒。
 *
 * 阈值刻意保守（75% 就开始变黄），因为额度用尽会直接打断编码，
 * 用户宁可早一点看到警告。
 * @param {number} percent - 已用百分比（可 >100）。
 * @param {boolean} exceeded - 是否已超限。
 * @returns {'green'|'yellow'|'red'} 色调。
 */
function quotaTone(percent, exceeded) {
  if (exceeded === true || percent >= 90) return 'red'
  if (percent >= 75) return 'yellow'
  return 'green'
}

/**
 * 把重置时刻渲染成「还剩多久」。
 * @param {number|undefined} resetAt - 毫秒时间戳。
 * @param {number} now - 当前时刻。
 * @returns {string|undefined} 形如 `3 小时 12 分后重置`；无时刻时 undefined。
 */
function formatReset(resetAt, now) {
  const target = Number(resetAt)
  if (!Number.isFinite(target) || target <= 0) return undefined
  const remain = target - now
  if (remain <= 0) return '即将重置'
  const totalMinutes = Math.floor(remain / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days} 天 ${hours} 小时后重置`
  if (hours > 0) return `${hours} 小时 ${minutes} 分后重置`
  return `${minutes} 分后重置`
}

/**
 * 把重置时刻渲染成**绝对日期**（站点时区下的 `MM-DD HH:MM`）。
 *
 * 「还有几天」与「到底是哪天」是两个不同的问题：月额度这种长周期，用户往往要的是
 * 后者（好安排这个月还剩多少活）。只给倒计时的话，他还得自己心算一遍日期。
 * @param {number|undefined} resetAt - 毫秒时间戳。
 * @param {string} [timeZone] - IANA 时区名；缺省用本机时区。
 * @returns {string|undefined} 形如 `10-14 20:26`；无时刻时 undefined。
 */
function formatResetAt(resetAt, timeZone) {
  const target = Number(resetAt)
  if (!Number.isFinite(target) || target <= 0) return undefined
  const options = { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone }).format(new Date(target))
  } catch {
    // 时区名非法（站点配置损坏）不该让整块面板崩掉：退回本机时区，照常给日期。
    return new Date(target).toLocaleString('zh-CN', options)
  }
}

/**
 * 重置说明：**绝对日期 + 剩余时间**一起给。
 *
 * 分开渲染会重复（一个「还剩多久」加一个「哪天」），合成一句更好读：
 * `10-14 20:26 重置（9 天 8 小时后）`。
 *
 * 日期拿不到时只回落到倒计时文案（`formatReset` 的原文），倒计时也拿不到时
 * 返回 undefined——界面据此整句不渲染，而不是显示一个空壳。
 * @param {number|undefined} resetAt - 毫秒时间戳。
 * @param {number} now - 当前时刻。
 * @param {string} [timeZone] - IANA 时区名。
 * @returns {string|undefined} 形如 `10-14 20:26 重置（9 天 8 小时后）`。
 */
function formatResetLine(resetAt, now, timeZone) {
  const countdown = formatReset(resetAt, now)
  if (countdown === undefined) return undefined
  const at = formatResetAt(resetAt, timeZone)
  if (at === undefined) return countdown
  if (countdown === '即将重置') return `${at} 重置（即将）`
  return `${at} 重置（${countdown.replace(/后重置$/, '后')}）`
}

/**
 * 由某家厂商的结果算出一句状态说明。
 *
 * 降级必须可见：拿不到额度时要说清是「没配 Key」「鉴权被拒」还是「接口失败」，
 * 而且**要指出该配哪个凭据名**——否则用户不知道从哪下手。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {{level:'ok'|'warn'|'error',text:string}} 状态。
 */
function providerStatus(provider) {
  if (provider === null || typeof provider !== 'object') {
    return { level: 'error', text: '数据缺失' }
  }
  if (provider.ok === true) {
    const windows = Array.isArray(provider.windows) ? provider.windows : []
    if (windows.length === 0) {
      return { level: 'warn', text: '接口没有返回任何额度窗口（套餐可能未生效或接口已变更）' }
    }
    return { level: 'ok', text: provider.note ?? '' }
  }
  if (provider.reason === 'no-key') {
    // 候选名可能有多个：用户用自定义 provider 添加时，DSH 派生的引用名取决于
    // 他当时怎么拼路由名（`commandcode` vs `command-code`）。全部列出来更可操作。
    const all = Array.isArray(provider.keyRefs) ? provider.keyRefs : []
    const names = all.length > 0 ? all.slice(0, 3).join(' / ') : (provider.keyRef ?? 'API_KEY')
    const more = all.length > 3 ? ' 等' : ''
    // 宿主给了 hint 时**以它为准**：火山那家的凭据不是 provider 的 Key，而是控制面的
    // AK/SK（在火山引擎控制台建，跟「设置 → 模型」无关）。再附上「去设置 → 模型填
    // API Key」会把人引到错误的排查方向——他会把自己唯一的推理 Key 填进去然后一直失败。
    if (typeof provider.hint === 'string' && provider.hint !== '') {
      return {
        level: 'warn',
        text: `没有找到凭据（试过 ${names}${more}）。${provider.hint}`,
      }
    }
    return {
      level: 'warn',
      text: `没有找到凭据（试过 ${names}${more}）。`
        + '在「设置 → 模型」里给对应 provider 填入 API Key 即可；'
        + '用自定义 provider 添加时，DSH 会按路由名自动派生引用名，无需手写环境变量。',
    }
  }
  if (provider.reason === 'rejected') {
    return {
      level: 'error',
      text: `凭据被拒绝：${provider.error ?? '鉴权失败'}${provider.hint === undefined ? '' : ` ${provider.hint}`}`,
    }
  }
  return { level: 'error', text: `取数失败：${provider.error ?? '未知原因'}` }
}

/**
 * 取第三方套餐额度。
 * @param {{refresh?:boolean, signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主返回的负载。
 */
async function fetchPlans(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const url = options.refresh === true ? `${PLANS_URL}?refresh=1` : PLANS_URL
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      // 404 有确定含义：宿主是还没有套餐路由的旧版本
      if (response.status === 404) {
        throw new Error('宿主没有套餐额度路由（插件版本可能过旧，重启 dsh 试试）')
      }
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 汇总：是否至少有一家拿到了额度。用于决定费用条那一枚要不要渲染。
 * @param {object|undefined} payload - 宿主负载。
 * @returns {boolean} 是否有可用额度。
 */
function hasAnyQuota(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  return providers.some((provider) => provider?.ok === true
    && Array.isArray(provider.windows) && provider.windows.length > 0)
}

/**
 * 取「最紧」的那个窗口，用于费用条这种一行位置显示。
 *
 * 选最紧的而不是第一个：用户真正关心的是「哪个快用完了」。
 *
 * 百分比未知的窗口（例如官方只报了余额的那一个）不参与比较——把未知当成 0% 会让
 * 它要么永远选不上、要么在全是未知时被选中并显示一个假的 0%。
 * @param {object|undefined} payload - 宿主负载。
 * @param {string} [planId] - 限定只看这一家；省略时在全部可用厂商里挑。
 * @returns {{provider:string,window:object,percent:number,planId:string}|undefined} 最紧窗口。
 */
function tightestWindow(payload, planId) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  let best
  for (const provider of providers) {
    if (provider?.ok !== true) continue
    // 限定了某一家时其余一律不看：这正是「我平时更关心那一个」的含义。
    if (planId !== undefined && planId !== '' && provider.id !== planId) continue
    for (const window of provider.windows ?? []) {
      const progress = windowProgress(window)
      // 百分比**未知**的窗口不参与「最紧」的比较：它的深度没法比，把它选出来
      // 只会让徽标显示一个编造的数字（早先就是拿 0% 当它的深度）。
      if (!progress.usable || !progress.percentKnown) continue
      if (best === undefined || progress.percent > best.percent) {
        best = { provider: provider.name, planId: provider.id, window, percent: progress.percent }
      }
    }
  }
  return best
}

/**
 * 取某一家厂商的完整结果（可能是取数失败的那一家）。
 *
 * 与 {@link tightestWindow} 的分工：那个回答「哪一枚徽标该显示什么数字」，
 * 这个回答「那一家现在到底怎么了」——失败原因、凭据提示都在里面，因此切换器
 * 与看板卡片能在同一份数据上给出可读的降级说明。
 * @param {object|undefined} payload - 宿主负载。
 * @param {string} planId - 厂商 id。
 * @returns {object|undefined} 该家的结果。
 */
function providerById(payload, planId) {
  if (planId === undefined || planId === '') return undefined
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  return providers.find((provider) => provider?.id === planId)
}

/**
 * 列出「当前可以监看的厂商」，供切换器渲染。
 *
 * **失败的厂商也要列出来**，而不是只列可用的：用户配错了凭据、或某家接口挂了，
 * 恰恰是他最想切过去看一眼原因的时候。把它们藏起来会让人以为插件不支持那一家。
 * @param {object|undefined} payload - 宿主负载。
 * @returns {Array<{id:string,name:string,ok:boolean}>} 厂商清单（按宿主给的顺序）。
 */
function providerChoices(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  return providers
    .filter((provider) => provider !== null && typeof provider === 'object' && typeof provider.id === 'string')
    .map((provider) => ({
      id: provider.id,
      // 失败时宁可少一个信息，也不要在切换器上编一个名字出来
      name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
      ok: provider.ok === true,
    }))
}

/**
 * 把厂商分成「该一直显示」与「可以收起来」两组。
 *
 * **判据是「有没有配过」，不是「成功还是失败」。** 这两件事容易被混成一件，
 * 混掉的后果正好相反：
 *
 *   - `no-key` —— 从没配过凭据。用户根本没打算用这一家，那就是一块**噪音**：
 *     随着适配的第三方变多，每加一家就往面板里塞一大块「没配凭据」。收起来。
 *   - `rejected` / `request-failed` —— **配过了但坏了**。这是用户自己接上的那一家
 *     出问题了，藏起来等于让他以为插件不支持它。必须一直显示。
 *
 * 因此这里只有 `reason === 'no-key'` 才归入「可以收起来」那一组。
 *
 * 两个例外一律留在显眼组，否则用户会找不到自己刚点的东西：
 *   1. 用户**显式选中**的那一家（切换器里点了它，下面却没有它，是自相矛盾的界面）；
 *   2. 当前监看的那一家（`current` 判据由调用方给，与切换器同源）。
 * @param {object[]} providers - 宿主给的全部厂商结果。
 * @param {{selected?:string, current?:string}} [options] - 选中 / 当前监看的 id。
 * @returns {{active:object[], idle:object[]}} 两组（各自保持宿主给的顺序）。
 */
function partitionProviders(providers, options = {}) {
  const list = Array.isArray(providers) ? providers : []
  const pinned = (provider) => provider?.id === options.selected || provider?.id === options.current
  const active = []
  const idle = []
  for (const provider of list) {
    if (provider === null || typeof provider !== 'object') continue
    // 只有「从没配过凭据」才收起来；配过但失败的一律留下
    const unconfigured = provider.ok !== true && provider.reason === 'no-key'
    if (unconfigured && !pinned(provider)) idle.push(provider)
    else active.push(provider)
  }
  return { active, idle }
}

			exports.WINDOW_ORDER = WINDOW_ORDER
			exports.formatQuota = formatQuota
			exports.windowProgress = windowProgress
			exports.quotaTone = quotaTone
			exports.formatReset = formatReset
			exports.formatResetAt = formatResetAt
			exports.formatResetLine = formatResetLine
			exports.providerStatus = providerStatus
			exports.fetchPlans = fetchPlans
			exports.hasAnyQuota = hasAnyQuota
			exports.tightestWindow = tightestWindow
			exports.providerById = providerById
			exports.providerChoices = providerChoices
			exports.partitionProviders = partitionProviders
		},
		"./provider.js": (exports, require) => {
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
const OFFICIAL_PROVIDER = 'deepseek-official'

/** 余额那一侧的对象标识。 */
const BALANCE_SOURCE = 'balance'

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
const PLAN_ROUTES = {
  zhipu: ['zhipu-coding', 'zai-coding-cn', 'zhipu', 'bigmodel', 'glm'],
  commandcode: ['command-code', 'commandcode', 'command_code', 'cmd'],
  volcengine: ['fangzhou', 'volcengine', 'ark', 'volces', 'doubao'],
}

/** 套餐厂商 id → 界面上的一句话名字。 */
const PLAN_LABELS = {
  zhipu: '智谱 GLM Coding Plan',
  commandcode: 'Command Code',
  volcengine: '火山方舟 Coding Plan',
}

/**
 * 套餐厂商 id → 费用条那一行用得下的短名。
 *
 * 一行里还要放金额与 token 数，全名会把那一行撑成两行甚至换行。
 */
const PLAN_SHORT = {
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
function normalizeProvider(provider) {
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
function planIdOfProvider(provider) {
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
function sourceOfProvider(provider) {
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
function currentRoute(selection) {
  if (selection === null || typeof selection !== 'object') return undefined
  const picked = selection.next ?? selection.lastUsed
  if (picked === null || typeof picked !== 'object') return undefined
  const provider = typeof picked.provider === 'string' ? picked.provider.trim() : ''
  const model = typeof picked.model === 'string' ? picked.model.trim() : ''
  if (provider === '' && model === '') return undefined
  return { provider, model }
}

			exports.OFFICIAL_PROVIDER = OFFICIAL_PROVIDER
			exports.BALANCE_SOURCE = BALANCE_SOURCE
			exports.PLAN_ROUTES = PLAN_ROUTES
			exports.PLAN_LABELS = PLAN_LABELS
			exports.PLAN_SHORT = PLAN_SHORT
			exports.normalizeProvider = normalizeProvider
			exports.planIdOfProvider = planIdOfProvider
			exports.sourceOfProvider = sourceOfProvider
			exports.currentRoute = currentRoute
		},
		"./planView.js": (exports, require) => {
			/**
 * 「当前监看的套餐」选择（纯存储 + 一个 React 订阅钩子）。
 *
 * ## 为什么是浏览器本地的偏好，而不是宿主配置
 *
 * 它只决定**界面上突出显示哪一家**——不影响取数、不影响预警、不影响宿主是否
 * 发请求。把它放进宿主配置会多出一条要落盘、要跨设备同步、要写进隐私说明的状态，
 * 而它的全部作用只是「我平时更关心哪一个」。因此放 `localStorage`：换台机器各挑
 * 各的，本来就是对的。
 *
 * ## 为什么要有订阅
 *
 * 这个选择有**两个**消费者：看板里的切换器，以及输入框下方费用条那一枚。它们
 * 在不同的 fiber 上、也可能只有其中一个挂在页面上（用户可能压根没打开看板）。
 * 用一个模块级的小存储做广播，两边都读同一份，就不会出现「看板里切了、费用条
 * 没跟着变」这种看起来像坏了的现象。
 *
 * ## localStorage 全程 fail-soft
 *
 * 隐私模式、被策略禁用的存储、跨站 iframe 都会让访问抛错。读不到就当没设过
 * （回落到自动挑最紧的那一家），写不进去也不影响本次运行内的选择——把存储
 * 失败升级成界面故障是不划算的。
 * @module dsh-pixel-dashboard/client/planView
 */

const React = require('react')
const { useSyncExternalStore } = React

/** 存储键。带插件前缀，避免与产品自己的键相撞。 */
const SELECTED_PLAN_KEY = 'dsh-pixel-dashboard.selected-plan'

/**
 * 读取已保存的套餐选择。
 *
 * 空串与缺失一律归一成 `undefined`（「自动」），因为把自动挑出来的那一家
 * 当成用户的显式选择会让他永远回不到自动模式。
 * @returns {string|undefined} 厂商 id；没设过或读不到时 undefined。
 */
function readSelectedPlan() {
  try {
    const value = globalThis.localStorage?.getItem(SELECTED_PLAN_KEY)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 保存套餐选择。传 `undefined` / 空串表示「回到自动」。
 * @param {string|undefined} planId - 厂商 id，或 undefined 清除。
 * @returns {boolean} 是否成功写入存储（写不进去也已在内存里生效）。
 */
function writeSelectedPlan(planId) {
  try {
    if (planId === undefined || planId === '') globalThis.localStorage?.removeItem(SELECTED_PLAN_KEY)
    else globalThis.localStorage?.setItem(SELECTED_PLAN_KEY, String(planId))
    return true
  } catch {
    return false
  }
}

/**
 * 套餐监看选择的模块级存储。
 *
 * 与通知那套同一个套路（见 Notifier.js 的 `NotifyStore`）：**状态只有一个家**，
 * 看板与费用条都订阅它。变化检测是必需的——`useSyncExternalStore` 在快照引用
 * 不变时跳过重渲染，而我们希望「点了同一项」不要引起任何重画。
 */
class PlanViewStore {
  constructor() {
    this.selected = readSelectedPlan()
    this.snapshot = this.selected
    /** @type {Set<() => void>} */
    this.listeners = new Set()
  }

  /** @returns {string|undefined} 当前选择（undefined = 自动）。 */
  getSnapshot() {
    return this.snapshot
  }

  /**
   * 订阅变化。
   * @param {() => void} listener - 回调。
   * @returns {() => void} 退订函数。
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 切换当前监看的套餐。
   * @param {string|undefined} planId - 目标厂商 id；undefined / 空串 = 自动。
   * @returns {boolean} 是否真的发生了变化。
   */
  select(planId) {
    const next = planId === undefined || planId === '' ? undefined : String(planId)
    if (next === this.snapshot) return false
    this.snapshot = next
    writeSelectedPlan(next)
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者抛错不该阻断其余订阅者，更不该让切换本身失败。
      }
    }
    return true
  }
}

/** @type {PlanViewStore|undefined} 惰性单例（不在导入时构造）。 */
let shared

/**
 * 取共享的套餐监看存储。
 * @returns {PlanViewStore} 单例。
 */
function planViewStore() {
  shared ??= new PlanViewStore()
  return shared
}

/**
 * 订阅「当前监看的套餐」。
 *
 * 用 `useSyncExternalStore` 而不是 `useState` + `useEffect`：后者在「订阅发生在
 * 首次渲染之后」的窗口里会丢掉一次变化，而本插件里两个消费者由不同的 fiber
 * 挂载、先后不定，那正是最容易踩到这个窗口的场景。
 * @returns {string|undefined} 厂商 id；undefined = 自动。
 */
function useSelectedPlan() {
  const store = planViewStore()
  return useSyncExternalStore(
    React.useCallback((listener) => store.subscribe(listener), [store]),
    React.useCallback(() => store.getSnapshot(), [store]),
    React.useCallback(() => store.getSnapshot(), [store]),
  )
}

			exports.SELECTED_PLAN_KEY = SELECTED_PLAN_KEY
			exports.readSelectedPlan = readSelectedPlan
			exports.writeSelectedPlan = writeSelectedPlan
			exports.planViewStore = planViewStore
			exports.useSelectedPlan = useSelectedPlan
		},
		"./account.js": (exports, require) => {
			const m1 = require("./balance.js")
			const m2 = require("./provider.js")
			const m3 = require("./plans.js")
			/**
 * 「这一行该显示哪一份账户事实」的纯解析（不含 React）。
 *
 * ## 要解决的是什么
 *
 * 输入框下方那一行原本把**官方余额**与**最紧的套餐窗口**并排显示。它们在语义上
 * 是互斥的两笔账：官方账户是按量计费的余额，套餐窗口是某个 Coding Plan 的订阅
 * 额度，两者来自完全不同的账户。并排摆着会让人以为它们是同一笔钱的两个数字。
 *
 * 因此这里按**当前会话正在用的模型来源**（provider 路由名）挑出唯一一个对象。
 *
 * ## 回落链（每一档都是刻意的）
 *
 *   1) 来源能认出来，且是某家套餐 → 那一家的额度窗口；
 *   2) 来源是官方 provider → 官方账户余额；
 *   3) 来源认不出（新会话还没有投影、或用户填了本插件不认识的自定义路由）：
 *      a. 用户显式指定过要监看哪一家 → 就用那一家；
 *      b. 否则退回官方余额（DSH 的默认路由就是官方，这是**最可能**的那一个）；
 *      c. 余额也拿不到（被关掉 / 没配 Key）→ 退回全部套餐里最紧的那个窗口。
 *
 * 认不出的来源下**不并排显示两个**：那等于把「我们不知道」伪装成一个并排的事实。
 * 附带 `source` 字段让界面能说清「这一枚是怎么挑出来的」。
 *
 * ## 「拿不到」要说出来（降级必须可见）
 *
 * 绑定到的那个对象取不到时**不静默不渲染**：用户会以为是插件坏了。这里返回一个
 * `unavailable` 结果，界面渲染成一枚告警徽标，悬停给出具体原因（没配 Key、
 * 请求失败、还是被关掉了）。
 * @module dsh-pixel-dashboard/client/account
 */

const balanceSummary = m1.balanceSummary
const balanceStatus = m1.balanceStatus
const hasBalance = m1.hasBalance
const PLAN_LABELS = m2.PLAN_LABELS
const PLAN_SHORT = m2.PLAN_SHORT
const currentRoute = m2.currentRoute
const sourceOfProvider = m2.sourceOfProvider
const providerById = m3.providerById
const providerStatus = m3.providerStatus
const tightestWindow = m3.tightestWindow
/** 结果种类。 */
const ACCOUNT_KINDS = ['plan', 'balance', 'unavailable', 'none']

/**
 * 把「哪一家、哪个窗口」压成给界面用的一枚描述。
 * @param {object|undefined} payload - `/dsh-pixel/plans` 负载。
 * @param {string} planId - 厂商 id。
 * @param {'route'|'selected'|'fallback'} source - 这一枚是怎么挑出来的。
 * @returns {object} 描述。
 */
function planResult(payload, planId, source) {
  const provider = providerById(payload, planId)
  const label = PLAN_LABELS[planId] ?? provider?.name ?? planId
  const short = PLAN_SHORT[planId] ?? provider?.name ?? planId
  if (provider === undefined) {
    // 宿主根本没给这一家：多半是插件版本对不上，或者用户在切换器里选了
    // 一个已经被移除的厂商（选择存在 localStorage 里，会跨版本留着）。
    return {
      kind: 'unavailable',
      planId,
      label: short,
      source,
      reason: `宿主没有返回「${label}」的额度数据（插件或宿主版本可能不一致）`,
    }
  }
  const status = providerStatus(provider)
  const tightest = tightestWindow(payload, planId)
  if (tightest === undefined) {
    return {
      kind: 'unavailable',
      planId,
      label: short,
      source,
      reason: status.text === '' ? `${label} 暂时没有可用的额度窗口` : status.text,
    }
  }
  return {
    kind: 'plan',
    planId,
    label: short,
    fullLabel: label,
    source,
    plan: tightest,
  }
}

/**
 * 把官方账户余额压成给界面用的一枚描述。
 * @param {object|undefined} payload - `/dsh-pixel/balance` 负载。
 * @param {'route'|'fallback'} source - 这一枚是怎么挑出来的。
 * @returns {object} 描述。
 */
function balanceResult(payload, source) {
  const status = balanceStatus(payload)
  if (!hasBalance(payload)) {
    return { kind: 'unavailable', label: '余额', source, reason: status.text }
  }
  return { kind: 'balance', label: '余额', source, text: balanceSummary(payload), payload }
}

/**
 * 按当前模型来源挑出这一行该显示的那一份账户事实。
 *
 * 纯函数：不取数、不读时钟、不看全局，因此可以直接用固定输入校验。
 * @param {object} input - 输入。
 * @param {object|undefined} input.selection - `useProjection('modelSelection')` 的值。
 * @param {object|undefined} input.balance - `/dsh-pixel/balance` 负载。
 * @param {object|undefined} input.plans - `/dsh-pixel/plans` 负载。
 * @param {string|undefined} input.selectedPlan - 用户手动指定的厂商 id。
 * @returns {object} 见 {@link ACCOUNT_KINDS}。
 */
function resolveAccount(input = {}) {
  const { selection, balance, plans, selectedPlan } = input
  const route = currentRoute(selection)
  const source = sourceOfProvider(route?.provider)
  const chosen = selectedPlan === undefined || selectedPlan === '' ? undefined : String(selectedPlan)

  // 1) 来源指向某家套餐：直接绑那一家（用户在界面上切过也不会盖掉它——
  //    「我正在用哪家」是事实，「我平时关心哪家」只是偏好）。
  if (source.kind === 'plan') {
    // 套餐总开关关掉时宿主回报 enabled:false 且 providers 为空，
    // 那时这一枚会走到 unavailable 并把「已关闭」说清楚，这是对的。
    return { ...planResult(plans, source.planId, 'route'), route }
  }

  // 2) 来源是官方：显示官方余额。
  if (source.kind === 'balance') return { ...balanceResult(balance, 'route'), route }

  // 3) 来源认不出。
  //    a. 用户显式挑过一家就用它——这正是「手动切换当前监看的套餐」的用处。
  if (chosen !== undefined) return { ...planResult(plans, chosen, 'selected'), route }
  //    b. 退回官方余额：DSH 的默认路由就是官方，这是最可能的那一个。
  const fallbackBalance = balanceResult(balance, 'fallback')
  if (fallbackBalance.kind === 'balance') return { ...fallbackBalance, route }
  //    c. 余额也拿不到：退回最紧的那个套餐窗口，至少还有东西可看。
  const tightest = tightestWindow(plans)
  if (tightest !== undefined) return { ...planResult(plans, tightest.planId, 'fallback'), route }
  //    三档都空：不渲染（而不是渲染一个空壳）。
  return { kind: 'none', route, source, reason: fallbackBalance.reason }
}

			exports.ACCOUNT_KINDS = ACCOUNT_KINDS
			exports.resolveAccount = resolveAccount
		},
		"./notify.js": (exports, require) => {
			/**
 * 通知与预警（浏览器半边）：判定、去重与文案。**纯逻辑，不含 React**，
 * 因此可以直接被渲染闸门渲染、被单元测试断言。
 *
 * ## 三条职责边界
 *
 *   1) **会话结束**（完成 / 失败 / 中断）的事实由宿主给（见宿主 lib/notify.js）。
 *      浏览器拿不到后台会话的 `turn/end`，所以这里只负责「要不要弹、弹什么」。
 *   2) **需要授权 / 回答**由浏览器自己发现：DSH 把待办发布在 `ctx.uiSession` 上，
 *      直接读它比让宿主再转发一趟更短、也不会与产品自己的状态脱节。
 *      **可观察量有两代**：0.1.6-alpha.2 起是 `uiSession.sessionStatus`
 *      （`Map<SessionId, SessionStatus>`，待办在每条的 `pendingInteraction` 上），
 *      更早是 `uiSession.pendingInteractions`（`Map<SessionId, interaction>`）。
 *      读数的兼容层在 `NotifierRuntime#pendingSource`——**不要在这里只认一代**。
 *   3) **余额 / 套餐阈值**在这里算：余额与额度本来就在这一侧取（同一份 60s / 30s
 *      缓存），把阈值判定放到宿主只会让同一份数字被解析两次。
 *
 * ## 为什么不落任何状态
 *
 * 「已经提醒过什么」全部只在内存里。提醒是**瞬时**的：刷新页面后重新从上一次
 * 已知的边界开始，正是用户期望的行为。落盘反而会带来「换了台机器还弹旧提醒」
 * 这类更难解释的现象。
 * @module dsh-pixel-dashboard/client/notify
 */

/** 通知配置取数与写回路由。 */
const NOTIFY_URL = '/dsh-pixel/notify'

/** 配置请求超时。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 通知配置的默认值，与宿主 lib/notify.js 的 `NOTIFY_DEFAULTS` 一致。
 *
 * 两侧各留一份是刻意的：宿主那份是**权威**（每次读取都会带上），这份只在
 * 「宿主还没答话」时兜底，好让面板第一帧就能渲染出正确的开关状态而不是空壳。
 * 两边改一处忘了另一处**不会**造成功能错误——宿主的回应总会覆盖它。
 */
const NOTIFY_DEFAULTS = {
  notifyEnabled: true,
  notifyDone: true,
  notifyError: true,
  notifyInteraction: true,
  notifyBalance: true,
  notifyQuota: true,
  notifyQuietFocused: true,
  warnBalance: {},
  warnQuotaPercent: 90,
}

/** 开关的展示元数据：面板按这个顺序渲染，文案只有这一份来源。 */
const NOTIFY_FLAGS = [
  { key: 'notifyEnabled', label: '总开关', hint: '关掉后不再弹任何通知（面板仍会记录最近发生的事）' },
  { key: 'notifyDone', label: '任务完成', hint: '一轮对话正常跑完时提醒' },
  { key: 'notifyError', label: '失败 / 中断', hint: '轮次报错、被取消、达到输出上限或异常结束时提醒' },
  { key: 'notifyInteraction', label: '等待授权 / 回答', hint: '需要你点授权，或 AI 提问等你回答时提醒' },
  { key: 'notifyBalance', label: '余额预警', hint: '账户余额低于下面设定的阈值时提醒' },
  { key: 'notifyQuota', label: '套餐额度预警', hint: '任一套餐窗口已用比例达到阈值时提醒' },
  { key: 'notifyQuietFocused', label: '当前会话不打扰', hint: '你正开着、正看着的那个会话跑完时不弹通知，避免自己吓自己；别的会话照常提醒' },
]

/** 浏览器通知权限的展示文案。 */
const PERMISSION_TEXT = {
  granted: '已允许，通知会出现在系统通知中心',
  denied: '已被浏览器拒绝，请在地址栏左侧的站点设置里重新允许',
  default: '尚未授权，点击右侧按钮申请',
  unsupported: '当前环境没有 Notification API（可能是非安全上下文），只能用页面内提示',
}

/**
 * 「最近通知」里给**被静默**那条加的尾注。
 *
 * 单独放这里而不是写死在面板里：运行时写入的 `quiet` 标记与面板展示的这句话是
 * 同一件事的两半，两边各写一份就会出现「标了 quiet 但界面不说明」这种半截状态。
 * 闸门也对它断言，因此改了文案就必须同步改测试——不会静默漂移。
 */
const QUIET_MARK = '（已静默，未弹窗）'

/**
 * 「最近通知」里某一行的正文。
 *
 * 抽成纯函数是为了让闸门能直接断言它——面板把「最近通知」默认收起，
 * 整页静态渲染根本到不了这一块（`Collapse` 收起时**不渲染**内容），
 * 写死在 JSX 里的文案就等于永远没被验过。
 * @param {object} item - `store.recent` 里的一项。
 * @returns {string} 行正文。
 */
function composeRecentLine(item) {
  const title = String(item?.title ?? '')
  const body = item?.body === undefined || item.body === '' ? '' : ` — ${String(item.body)}`
  // 被「当前会话不打扰」静默的那条照样列出来，并明说它没弹：否则用户看到的是
  // 「有个会话完成了却什么都没发生」，只会以为功能漏了提醒。
  return `${title}${body}${item?.quiet === true ? QUIET_MARK : ''}`
}

/**
 * 请求地址 → 系统通知权限。
 *
 * 三种「没有 Notification API」的情况都要归到 `unsupported`：
 * 服务端渲染（`window` 不存在）、非安全上下文（http 且非 localhost，浏览器
 * 会隐藏该 API）、以及老浏览器。把它们混进 `default` 会让面板显示一个点了
 * 没反应的按钮。
 * @param {object} [scope] - 全局对象，测试注入用。
 * @returns {'granted'|'denied'|'default'|'unsupported'} 权限状态。
 */
function permissionOf(scope = globalThis) {
  const Notification = scope?.Notification
  if (typeof Notification !== 'function') return 'unsupported'
  const value = Notification.permission
  return value === 'granted' || value === 'denied' ? value : 'default'
}

/**
 * 会话界面的 DOM 锚点：DSH 的 `ConversationRoot` 把这个属性打在滚动容器上。
 *
 * 用它而不是某个 CSS 类名（类名是压缩产物，一升级就变），也不用
 * `list.current`——**「选中了哪条会话」与「屏幕上是什么」是两件事**，
 * 见 {@link shouldStayQuiet}。
 */
const CONVERSATION_ANCHOR_SELECTOR = '[data-conversation-scroll]'

/** 主区被某个浮层占满时的标记：会话界面还在 DOM 里，但用户看不见它。 */
const FULLSCREEN_OVERLAY_SELECTOR = '[data-rightbar-fullscreen]'

/**
 * 「会话界面此刻真的在屏幕上吗」。
 *
 * ## 为什么要问这一句
 *
 * DSH 的主区是**一个 keyed 槽位**（`renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`）：
 * 选中「用量看板」这类全局面板时，会话界面**整个不挂载**——而
 * `sessions.list.current` 仍然停在上次选中的那条会话上。
 *
 * 于是只比较 `current` 就会得出「他正在看这条会话」的错误结论，把提醒静默吞掉。
 * 用户正在看**看板**时收到「别的会话完成了」本该弹的提醒，表现就是「漏提醒」。
 *
 * ## 判不出来时一律返回 false（= 不静默）
 *
 * 少静默一次最多是「你盯着它跑完，通知和界面同时响」这种轻微打扰；多静默一次
 * 则是**一条永远不会被看见的提醒**。两者不对称，所以任何读不出来的情况
 * （没有 `document`、选择器被上游改掉、查询抛错）都必须落到「不静默」那一侧。
 * @param {object} [doc] - `document` 之类能 querySelector 的对象。
 * @returns {boolean} 会话界面是否确实在屏幕上。
 */
function conversationOnScreen(doc) {
  if (typeof doc?.querySelector !== 'function') return false
  try {
    // 浮层占满主区时会话界面并没有被卸载，只是被盖住了——对用户而言同样是「没在看」。
    if (doc.querySelector(FULLSCREEN_OVERLAY_SELECTOR) !== null) return false
    return doc.querySelector(CONVERSATION_ANCHOR_SELECTOR) !== null
  } catch {
    return false
  }
}

/**
 * 这条会话结束提醒是否应当**不打扰**。
 *
 * 四个条件**同时**成立才跳过，缺一个就照常提醒：
 *
 *   1) 开关开着（默认开着）；
 *   2) 页面确实有焦点——否则用户切去了别的标签页 / 别的应用，正是最该提醒的时候；
 *   3) 这条提醒说的**就是**当前选中的那条会话；
 *   4) 那条会话的界面**真的在屏幕上**（见 {@link conversationOnScreen}）。
 *
 * 第 4 条是后补的，也正是原先漏掉的一条：只比 `current` 会把「主区停在看板上」
 * 误判成「正在看这条会话」，于是那条会话完成时提醒被静默吞掉。
 *
 * 纯函数：所有环境读数由调用方取好传进来，因此闸门可以逐条钉住这四件事。
 * @param {object} notice - 宿主通知记录。
 * @param {object} view - 当前视图事实。
 * @param {object|undefined} view.config - 通知配置。
 * @param {boolean} view.focused - 页面是否有焦点。
 * @param {unknown} view.current - 当前选中的会话 id。
 * @param {boolean} view.onScreen - 会话界面是否在屏幕上。
 * @returns {boolean} 是否跳过这条提醒。
 */
function shouldStayQuiet(notice, view) {
  // 配置还没到手时**不静默**：`undefined` 是「还没读到用户设置」，不是「用户开了它」。
  // 生产路径上此时 `#enabled` 已经先一步跳过（没配置就一律不派发），这一条只是把
  // 契约钉死，免得日后有人绕过 `#enabled` 直接调它。
  if (view?.config === undefined) return false
  if (view.config.notifyQuietFocused === false) return false
  if (view?.focused !== true) return false
  const sessionId = String(notice?.sessionId ?? '')
  // 没有会话 id 的提醒（余额 / 套餐阈值）不属于任何会话，谈不上「正在看它」。
  if (sessionId === '') return false
  const current = view?.current
  if (current === undefined || String(current) !== sessionId) return false
  return view?.onScreen === true
}

/**
 * 由一条宿主通知事实拼出通知标题与正文。
 *
 * 标题带工作目录名：同时跑几个会话时，「已完成」这三个字本身不提供任何信息，
 * 而「哪个目录完成了」才是你要判断「现在要不要回去看」的依据。
 * @param {object} notice - 宿主 lib/notify.js 产出的记录。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
function composeNotice(notice) {
  const workspace = typeof notice?.workspace === 'string' && notice.workspace !== ''
    ? notice.workspace
    : '(未知目录)'
  const label = typeof notice?.label === 'string' && notice.label !== '' ? notice.label : '已结束'
  const turn = Number(notice?.turn ?? 0)
  const parts = []
  if (notice?.detail !== undefined && notice.detail !== '') parts.push(String(notice.detail))
  if (notice?.code !== undefined && notice.code !== '') parts.push(`(${notice.code})`)
  parts.push(turn > 0 ? `第 ${turn} 轮` : '会话')
  return {
    title: `${workspace} · ${label}`,
    body: parts.join(' · '),
    // tag 让同一条会话的新通知替换旧的那条，而不是在通知中心堆成一列
    tag: `dsh-pixel-${String(notice?.sessionId ?? '')}-${turn}`,
    level: typeof notice?.level === 'string' ? notice.level : 'ok',
    // 会话 id 单独带一份（**不**去解析 tag）：点击通知要能切到那条会话。
    // 从 tag 反解析看似可行，但 tag 是人可读的拼接串，格式一变就静默失效。
    sessionId: typeof notice?.sessionId === 'string' ? notice.sessionId : '',
  }
}

/**
 * 由一条待办交互拼出通知文案。
 *
 * 三种待办给的是**不同的字段**（授权是 `toolName`，提问是 `questions`，计划评审
 * 是 `questions[0].question` + `detail`），因此按 `kind` 分开读，而不是猜一个
 * 共同字段——猜错的表现是通知里写着「undefined 需要你的许可」。
 *
 * `plan-review` 是 DSH 里 `question` 的一个特例（kind 由 `planReviewOf` 判定，
 * 见 ui-user-questions 的 contract/slots.ts）。它值得单独一句文案：那是**计划
 * 审批**，比普通提问更需要人回来看一眼。
 * @param {object} interaction - uiSession 待办快照里的一项（两代 API 见 NotifierRuntime#pendingSource）。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
function composeInteraction(interaction) {
  const kind = typeof interaction?.kind === 'string' ? interaction.kind : ''
  const key = String(interaction?.key ?? '')
  // 待办总是挂在某条会话上（两代 API 都是 Map<SessionId, …>）。
  // 点击「需要你的授权」那一类通知切过去，正是这个通知存在的意义。
  const sessionId = typeof interaction?.sessionId === 'string' ? interaction.sessionId : ''
  if (kind === 'approval') {
    const tool = typeof interaction.toolName === 'string' && interaction.toolName !== ''
      ? interaction.toolName
      : '某个工具'
    const reason = typeof interaction.reason === 'string' && interaction.reason !== ''
      ? ` · ${interaction.reason}`
      : ''
    return {
      title: '需要你的授权',
      body: `${tool} 请求执行授权${reason}`,
      tag: `dsh-pixel-approval-${key}`,
      level: 'warn',
      sessionId,
    }
  }
  if (kind === 'question' || kind === 'plan-review') {
    const questions = Array.isArray(interaction.questions) ? interaction.questions : []
    const first = questions[0]
    // 字段优先级：`question` 是正文，`header` 只是短标题（可能没有）
    const text = typeof first?.question === 'string' && first.question !== ''
      ? first.question
      : (typeof first?.header === 'string' && first.header !== '' ? first.header : '')
    const more = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
    return {
      title: kind === 'plan-review' ? '有一份计划等你确认' : 'AI 在等你回答',
      body: `${text === '' ? '有一个问题需要你回复' : text}${more}`,
      tag: `dsh-pixel-question-${key}`,
      level: 'warn',
      sessionId,
    }
  }
  return {
    title: '需要你处理',
    body: '有一个待办需要你的输入',
    tag: `dsh-pixel-interaction-${key}`,
    level: 'warn',
    sessionId,
  }
}

/**
 * 从余额负载里挑出「低于阈值」的币种。
 *
 * 只比较**有阈值**且**真的拿到了金额**的币种：
 *   - 没有阈值的币种跳过，否则每个币种都会在默认 0 阈值下立刻报警；
 *   - 金额缺失（`undefined`）时**绝不**当成 0——那会造出「余额为 0」的假警报，
 *     而真实原因可能只是接口没返回。这正是宿主余额模块反复强调的那条口径。
 * @param {object|undefined} payload - `/dsh-pixel/balance` 的负载。
 * @param {Record<string, number>} thresholds - 币种 → 阈值。
 * @returns {Array<{currency:string,total:number,threshold:number}>} 触发项（按币种升序）。
 */
function balanceAlerts(payload, thresholds) {
  if (payload?.enabled === false) return []
  const table = thresholds !== null && typeof thresholds === 'object' ? thresholds : {}
  const rows = Array.isArray(payload?.balances) ? payload.balances : []
  const out = []
  for (const row of rows) {
    const currency = String(row?.currency ?? '').toUpperCase()
    const threshold = Number(table[currency])
    if (!Number.isFinite(threshold)) continue
    const total = Number(row?.total)
    if (!Number.isFinite(total)) continue
    if (total < threshold) out.push({ currency, total, threshold })
  }
  return out.sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * 从套餐负载里挑出「已用比例达到阈值」的窗口。
 *
 * 只看 `ok === true` 的厂商，且只认**能算出百分比**的窗口（`usedPercent` 有限）。
 * 拿不到百分比时跳过而不是当成 0——「不知道用了多少」与「用了 0」是两件事。
 * @param {object|undefined} payload - `/dsh-pixel/plans` 的负载。
 * @param {number} threshold - 百分比阈值；<= 0 表示关闭。
 * @returns {Array<{provider:string,window:string,label:string,percent:number}>} 触发项。
 */
function quotaAlerts(payload, threshold) {
  const limit = Number(threshold)
  if (!Number.isFinite(limit) || limit <= 0) return []
  if (payload?.enabled === false) return []
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const out = []
  for (const provider of providers) {
    if (provider?.ok !== true) continue
    for (const window of provider.windows ?? []) {
      const percent = Number(window?.usedPercent)
      if (!Number.isFinite(percent)) continue
      if (percent < limit) continue
      out.push({
        provider: String(provider.name ?? provider.id ?? '套餐'),
        window: String(window.window ?? ''),
        label: String(window.label ?? window.window ?? '额度'),
        percent,
      })
    }
  }
  return out
}

/**
 * 由套餐触发项拼通知文案。
 * @param {Array<object>} alerts - {@link quotaAlerts} 的产出。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
function composeQuotaAlert(alerts) {
  const first = alerts[0] ?? {}
  const summary = alerts
    .slice(0, 3)
    .map((item) => `${item.provider} ${item.label} ${item.percent.toFixed(0)}%`)
    .join('、')
  const more = alerts.length > 3 ? ` 等 ${alerts.length} 项` : ''
  return {
    title: '套餐额度接近上限',
    body: `${summary}${more}`,
    tag: `dsh-pixel-quota-${String(first.provider ?? '')}-${String(first.window ?? '')}`,
    level: 'warn',
  }
}

/**
 * 由余额触发项拼通知文案。
 * @param {Array<object>} alerts - {@link balanceAlerts} 的产出。
 * @param {(value:number, currency:string)=>string} formatMoney - 金额格式化函数。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
function composeBalanceAlert(alerts, formatMoney) {
  const summary = alerts
    .slice(0, 3)
    .map((item) => `${item.currency} ${formatMoney(item.total, item.currency)}（阈值 ${formatMoney(item.threshold, item.currency)}）`)
    .join('、')
  const more = alerts.length > 3 ? ` 等 ${alerts.length} 个币种` : ''
  return {
    title: '账户余额低于预警阈值',
    body: `${summary}${more}`,
    tag: `dsh-pixel-balance-${alerts.map((item) => item.currency).join('-')}`,
    level: 'error',
  }
}

/**
 * 预警锁存器：同一条预警在**情况持续**期间只报一次，恢复后才重新武装。
 *
 * 没有它，每一轮轮询（余额 60 秒一次）都会重新触发同一条预警，一分钟一条
 * 通知会让人立刻把整个功能关掉。判据是「从正常跨到告警」这个**边沿**，
 * 而不是「当前是否处于告警」。
 *
 * 键的粒度按用途分开：余额按币种、套餐按「厂商 + 窗口」。这样某一家恢复
 * 不会把另一家的告警状态一起清掉。
 */
class AlertLatch {
  constructor() {
    /** @type {Set<string>} 当前处于告警态的键。 */
    this.active = new Set()
  }

  /**
   * 用一组当前处于告警的键更新锁存器。
   * @param {string[]} keys - 本轮处于告警态的键。
   * @returns {string[]} 本轮**新跨越**到告警态的键。
   */
  update(keys) {
    const next = new Set(keys)
    const fresh = []
    for (const key of next) {
      if (!this.active.has(key)) fresh.push(key)
    }
    this.active = next
    return fresh
  }

  /** 清空（关闭预警、或配置改变后重新开始）。 */
  reset() {
    this.active = new Set()
  }
}

/**
 * 去重游标：记住「已经提醒过」的宿主日志游标与待办键。
 *
 * 分三类各记一份，因为它们的分页方式不同：日志按单调游标，待办按 key 集合。
 * 混在一起会让「待办被回答后 key 消失」把游标也一起弄丢。
 */
class SeenTracker {
  /**
   * @param {object} [options] - 选项。
   * @param {number} [options.maxInteractions] - 待办键的保留上限。
   */
  constructor({ maxInteractions = 200 } = {}) {
    /** 宿主日志游标：只处理 id 大于它的记录。 */
    this.cursor = undefined
    /** @type {Set<string>} 已经提醒过的待办键。 */
    this.interactions = new Set()
    this.maxInteractions = maxInteractions
  }

  /**
   * 挑出本批需要提醒的日志记录并推进游标。
   * @param {object} payload - `/dsh-pixel/notify` 的负载。
   * @returns {{fresh:object[],dropped:boolean,first:boolean}} 结果。
   */
  takeNotices(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : []
    const cursor = Number(payload?.cursor)
    const first = this.cursor === undefined
    // 第一次取到游标：宿主在「没有 since」时返回空列表，因此这里天然不会重播历史。
    // 但若宿主是旧实现（不带 since 也返回全部），first 仍然挡住整批——
    // 刷新页面绝不该把上次会话的提醒再弹一遍。
    const fresh = first ? [] : events.filter((entry) => Number(entry?.id) > this.cursor)
    if (Number.isFinite(cursor)) this.cursor = cursor
    return { fresh, dropped: payload?.dropped === true, first }
  }

  /**
   * 挑出本批首次出现的待办键。
   *
   * 只记「见到过」而不主动清理已消失的键：`key` 由产品侧单调生成
   * （`approval:1`、`approval:2`…），不会复用；清理反而会让一个仍在等待的
   * 待办在两次轮询之间被重复提醒。为防长期运行下集合无限增长，超过上限时
   * **整体清空**——那时旧键早已不可能再出现，重建一次的成本可以忽略。
   * @param {Iterable<object>} interactions - 当前的待办集合。
   * @returns {object[]} 首次出现的待办。
   */
  takeInteractions(interactions) {
    const fresh = []
    for (const item of interactions) {
      const key = String(item?.key ?? '')
      if (key === '' || this.interactions.has(key)) continue
      this.interactions.add(key)
      fresh.push(item)
    }
    if (this.interactions.size > this.maxInteractions) this.interactions = new Set()
    return fresh
  }
}

/**
 * 取通知配置（宿主是权威）。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 形如 `{ cursor, events, config, dropped }`。
 */
async function fetchNotify(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(NOTIFY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      // 404 有确定含义：宿主是还没有通知路由的旧版本。明说，而不是抛 HTTP 404。
      if (response.status === 404) {
        throw new Error('宿主没有通知路由（插件版本可能过旧，重启 dsh 试试）')
      }
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 取增量日志。
 * @param {{since?:number, signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主负载。
 */
async function fetchNotices(options = {}) {
  const url = Number.isFinite(Number(options.since))
    ? `${NOTIFY_URL}?since=${encodeURIComponent(String(options.since))}`
    : NOTIFY_URL
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('宿主没有通知路由（插件版本可能过旧，重启 dsh 试试）')
      }
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 写回通知配置。
 *
 * 只提交**改动的那部分**（宿主会与现值合并），因此面板里的「保存阈值」不必
 * 先把整份配置读全；也会让「两个人同时改了不同项」不至于互相覆盖。
 *
 * 失败要抛错而不是静默：用户点了开关却没生效，必须让他知道——否则下次打开
 * 界面看到状态又变回去会莫名其妙。这与余额 / 套餐开关的口径一致。
 * @param {object} patch - 要改的键值。
 * @returns {Promise<object>} 形如 `{ config, persisted }`。
 */
async function saveNotify(patch) {
  const response = await fetch(NOTIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = body.error
    } catch {
      // 响应不是 JSON 时保留状态码说明
    }
    throw new Error(`通知设置未生效：${detail}`)
  }
  return await response.json()
}

/**
 * 申请系统通知权限。
 *
 * 必须在**用户手势**里调用（浏览器要求），因此只能由面板上的按钮触发，
 * 绝不能在插件加载时自动调用——那样即使浏览器不报错，也会被用户当成骚扰，
 * 而且一旦被拒就再也拿不回来。
 * @param {object} [scope] - 全局对象，测试注入用。
 * @returns {Promise<string>} 申请后的权限状态。
 */
async function requestPermission(scope = globalThis) {
  const Notification = scope?.Notification
  if (typeof Notification !== 'function') return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    return result === 'granted' || result === 'denied' ? result : 'default'
  } catch {
    return permissionOf(scope)
  }
}

			exports.NOTIFY_URL = NOTIFY_URL
			exports.NOTIFY_DEFAULTS = NOTIFY_DEFAULTS
			exports.NOTIFY_FLAGS = NOTIFY_FLAGS
			exports.PERMISSION_TEXT = PERMISSION_TEXT
			exports.QUIET_MARK = QUIET_MARK
			exports.composeRecentLine = composeRecentLine
			exports.permissionOf = permissionOf
			exports.CONVERSATION_ANCHOR_SELECTOR = CONVERSATION_ANCHOR_SELECTOR
			exports.FULLSCREEN_OVERLAY_SELECTOR = FULLSCREEN_OVERLAY_SELECTOR
			exports.conversationOnScreen = conversationOnScreen
			exports.shouldStayQuiet = shouldStayQuiet
			exports.composeNotice = composeNotice
			exports.composeInteraction = composeInteraction
			exports.balanceAlerts = balanceAlerts
			exports.quotaAlerts = quotaAlerts
			exports.composeQuotaAlert = composeQuotaAlert
			exports.composeBalanceAlert = composeBalanceAlert
			exports.AlertLatch = AlertLatch
			exports.SeenTracker = SeenTracker
			exports.fetchNotify = fetchNotify
			exports.fetchNotices = fetchNotices
			exports.saveNotify = saveNotify
			exports.requestPermission = requestPermission
		},
		"./period.js": (exports, require) => {
			const m1 = require("./format.js")
			/**
 * 侧栏时段倒计时：显示在「用量看板」那一行的右侧，以及它的取数与相位计算。
 *
 * ## 为什么单独一条取数路由，而不是复用 `/dsh-pixel/data`
 *
 * 这段倒计时要**每秒**重画，而 `/data` 会全量扫描会话日志与账本、带 20 秒 TTL、
 * 首次可能几十秒才回来。挂在它上面有两个直接后果：页面一打开要等一次全量扫描
 * 才看得到；账本读不出来时连「现在是高峰还是空闲」这种纯时钟信息也一起没了。
 *
 * 因此宿主另开了一条 `/dsh-pixel/period`：只跑一次纯函数 `periodState()`，
 * 不碰账本、不碰会话日志，因此**永远廉价、永远可用**。
 *
 * ## 为什么要自己算相位，而不是每秒问宿主
 *
 * 宿主给出「下一次切换还有多少毫秒」，浏览器拿到之后就本地递减
 * （与看板里的 `usePeriod` 同一套口径）。每秒发一个请求既没必要，也会在页面
 * 切到后台时白烧电。只有跨过切换点时才回去取新的一段（见 `usePeriodPhase`）。
 *
 * ## 显示什么
 *
 * **一行文字，用颜色区分时期**（红 = 高峰，绿 = 空闲）：
 *
 *   高峰中 → `2时15分后空闲期`（这段是贵的，说清什么时候变便宜）
 *   空闲中 → `空闲期剩2时15分`（这段是便宜的，说清还能便宜多久）
 *
 * 刻意**不画环形进度**：那枚环要「已走 ÷ 总长」，而各段长度差几十倍
 * （午休 2 小时、周末 63 小时），环在周末几乎不动，看起来像坏了。
 * 文字直说「还剩多久」既准确又省地方。
 * @module dsh-pixel-dashboard/client/period
 */

const React = require('react')
const compactCountdown = m1.compactCountdown
const formatCountdown = m1.formatCountdown
const { createElement: h, useEffect, useMemo, useRef, useState } = React

/** 时段取数路由，与宿主注册路径一致。 */
const PERIOD_URL = '/dsh-pixel/period'

/** 纯时钟数据，不是关键路径：超时给短一些，失败就不显示。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 本地递减的步长：一秒一格，倒计时里的秒数才会跳。 */
const TICK_MS = 1_000

/**
 * 拿不到快照时的重试间隔。
 *
 * 不按每秒重试：宿主是旧版本时这条路由**永远**是 404，每秒打一次等于给每个
 * 装过旧宿主的页面白白加一个长期请求。也不放弃重试：宿主可能只是还没起来，
 * 或者刚从「旧版本」升级完——那时用户不该还看不到倒计时。
 */
const RETRY_MS = 30_000

/**
 * 一行文字要占的宽度（px），供 {@link panelEntryLayout} 判断放不放得下。
 *
 * 按最长的那种文案估：`空闲期剩2天15时` ≈ 9 个字符（汉字约 11px、数字约 7px），
 * 加上与标题之间的间隙，约 100px。
 */
const CAPTION_WIDTH = 100

/**
 * 行宽门槛：决定这段倒计时显示成什么样子。
 *
 * ## 它放在哪
 *
 * 由容器 **portal 进产品的 row 元素**，因此它天然是一个 flex 兄弟节点、
 * 排在「用量看板」四个字的右边。（产品只把图标槽给了插件，所以在插槽内部
 * 无论怎么定位都到不了标题右边；详见 entry.js 的 `usePanelRow`。）
 *
 * ## 门限做什么
 *
 * 它是 flex 项，会把标题往左挤，因此窄行必须自己让路：
 *
 *   - `full`（行宽 ≥ {@link INLINE_MIN_ROW}）：完整的 `空闲期剩2时15分`；
 *   - `short`（≥ {@link SIDE_MIN_ROW}）：只留最关键的时长（`2时15分`），
 *     省掉时期字样——颜色已经在说时期了；
 *   - `none`：侧栏收起成图标条（整行只有几十像素），什么文字都放不下。
 *
 * 门槛怎么来的：标题「用量看板」4 个汉字约 56px + 图标 16 + 间隙，
 * 再加上 {@link CAPTION_WIDTH} 的文案宽度，两边之和即得。
 */
const INLINE_MIN_ROW = 210

/** 「只显示时长」的最低行宽。 */
const SIDE_MIN_ROW = 150

/**
 * 倒计时该显示成什么样子。
 *
 * 纯函数，不读时钟、不碰 DOM，因此可以直接用固定行宽校验。
 * @param {{rowWidth?:number}} [options] - 整行宽度（px）。
 * @returns {{placement:'full'|'short'|'none'}} 排版决定。
 */
function panelEntryLayout(options = {}) {
  const rowWidth = Number(options?.rowWidth)
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    // 量不到宽度（服务端渲染 / 无 ResizeObserver）：什么都不显示最保险——
    // 它不占横向空间，因此不会因为猜错宽度而把标题挤坏。
    return { placement: 'none' }
  }
  if (rowWidth >= INLINE_MIN_ROW) return { placement: 'full' }
  if (rowWidth >= SIDE_MIN_ROW) return { placement: 'short' }
  return { placement: 'none' }
}

/**
 * 取一个有限数，读不懂时回落到兜底值。
 *
 * 必须显式挡掉 NaN：`Number(undefined)` 与 `Number('x')` 都是 NaN，而
 * `Math.max(0, NaN)` 仍是 NaN——一路算下去会渲染出 `NaN时NaN分后空闲期`
 * 这种串。倒计时是每秒重画的，出问题会一直闪。
 * @param {unknown} value - 待转换的值。
 * @param {number} [fallback] - 读不懂时的取值。
 * @returns {number} 有限数。
 */
function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 取当前时段状态（宿主侧纯函数，不碰账本）。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 形如 `{ generatedAt, timezone, period }`。
 */
async function fetchPeriod(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(PERIOD_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`时段状态请求失败：HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 由宿主快照与当前时刻算出倒计时要显示的一切。
 *
 * 纯函数，不含 React、不读时钟（`now` 由调用方给），因此可以直接用固定时刻校验。
 * 拿不到可用快照时返回 `undefined`，调用方据此**什么都不显示**——旧宿主上它
 * 就是不存在，而不是写一句永远停在「空闲」的话（那是在陈述一个我们并不知道的事实）。
 * @param {object|undefined} snapshot - 宿主 `/dsh-pixel/period` 的响应。
 * @param {number} now - 当前时刻（毫秒）。
 * @returns {object|undefined} 相位信息；不可用时为 undefined。
 */
function periodPhase(snapshot, now) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const period = snapshot.period
  if (period === null || typeof period !== 'object') return undefined

  const peak = period.peak === true
  const at = finite(now, 0)
  const generated = finite(snapshot.generatedAt, at)
  // 本地递减：宿主快照可能已经放了一会儿，也可能因页面休眠而放了很久。
  const sinceSnapshot = Math.max(0, at - generated)
  const remainMs = Math.max(0, finite(period.nextChangeMs) - sinceSnapshot)
  const remain = compactCountdown(remainMs)

  return {
    peak,
    // 红 = 高峰（正贵着）、绿 = 空闲（正便宜）。侧栏那段文字的颜色由它决定。
    tone: peak ? 'red' : 'green',
    label: peak ? '高峰时段' : '空闲时段',
    nextLabel: peak ? '距转空闲' : '距转高峰',
    // 一行文案，两个时期各说各的话：
    //   高峰中 → 「2时15分后空闲期」——这段是贵的，重点是**什么时候变便宜**；
    //   空闲中 → 「空闲期剩2时15分」——这段是便宜的，重点是**还能便宜多久**。
    // 措辞与 peak 的对应关系只在这里拼，因为拼错的表现是「高峰」配了一句
    // 空闲期的文案——两句话都在说空闲，但主次正好相反。
    caption: peak ? `${remain}后空闲期` : `空闲期剩${remain}`,
    // 「只有时长」的短版本，供窄栏使用（颜色已经在说时期了）
    shortCaption: remain,
    remainMs,
    countdown: formatCountdown(remainMs),
    timezone: typeof snapshot.timezone === 'string' ? snapshot.timezone : '',
  }
}

/**
 * 按钮悬停说明：状态 + 倒计时。
 * @param {object|undefined} phase - periodPhase 的结果。
 * @returns {string} 提示文本。
 */
function periodTitle(phase) {
  if (phase === undefined) return '用量看板'
  const where = phase.timezone === '' ? '' : ` · ${phase.timezone}`
  return `用量看板 · ${phase.label} · ${phase.nextLabel} ${phase.countdown}${where}`
}

/**
 * 时段倒计时文字：侧栏「用量看板」那一行右侧的一行小字。
 *
 * ```
 * [▮] 用量看板        2时15分后空闲期     ← 高峰中（红）
 * [▮] 用量看板        空闲期剩2时15分     ← 空闲中（绿）
 * ```
 *
 * **只有文字，没有环形进度。** 两个时期各说各的话，并用颜色区分：
 *   高峰（红）→「N后空闲期」  —— 这段是贵的，重点是**什么时候变便宜**；
 *   空闲（绿）→「空闲期剩N」  —— 这段是便宜的，重点是**还能便宜多久**。
 *
 * 名字里的 `Dot` 是历史沿用（它原先是图标角上的一颗点、后来是一枚环）；
 * 现在它是一段文字，`PeriodDot` 这个名字保留是为了不改动 entry.js 的接线。
 *
 * ## 窄栏降级
 *
 * `placement` 由 {@link panelEntryLayout} 按行宽给出：
 *   - `full` —— 完整的 `空闲期剩2时15分`；
 *   - `short` —— 只有时长（`2时15分`）：颜色已经在说时期了，省下的字留给标题；
 *   - `none` —— 侧栏收起成图标条，整行只有几十像素，什么都不显示。
 *
 * 纯展示，无副作用——取数在 {@link usePeriodPhase} 里，因此这一层可以直接静态渲染校验。
 * @param {object} props - phase 与 placement。
 * @returns {object|null} React 元素；没有相位信息或放不下时为 null。
 */
function PeriodDot(props) {
  const phase = props?.phase
  if (phase === undefined || phase === null) return null
  const placement = props?.placement ?? 'full'
  if (placement === 'none') return null

  // 一行文案；窄栏只留时长。两处都必须有兜底：`caption` 缺失时（旧相位对象）
  // 退回时长，否则会渲染出「undefined后空闲期」这种串。
  const text = placement === 'short'
    ? (phase.shortCaption ?? '')
    : (typeof phase.caption === 'string' && phase.caption !== '' ? phase.caption : (phase.shortCaption ?? ''))
  if (text === '') return null

  return h('span', {
    // 颜色类区分时期：红 = 高峰、绿 = 空闲。
    className: `px-period-inline px-period-tone-${phase.tone === 'red' ? 'red' : 'green'}`,
    // 这一行是纯时钟信息，读屏软件从按钮的 aria-label 拿「用量看板」即可；
    // 但它同时是**可见**信息，因此不能像装饰那样 aria-hidden。
    title: periodTitle(phase),
  }, text)
}

/**
 * 时段相位的取数与每秒递减。
 *
 * 三条刷新时机，各自解决一个真实场景：
 *   1) **挂载时取一次** —— 页面打开就有指示灯；
 *   2) **跨过切换点再取** —— 倒计时归零说明那一段已经结束，回去取新的一段；不靠
 *      固定轮询，因为不同时段长度差得极远（午休 2 小时、周末 63 小时）；
 *   3) **页面重新可见时再取** —— 休眠 / 切到后台期间 `setInterval` 会被节流甚至暂停，
 *      光靠本地递减会算岔，回前台时以宿主为准重新对齐。
 *
 * 取数失败（旧宿主没有这条路由 / 宿主还没起来）一律清成 undefined：宁可不画，
 * 也不要停在上一次的状态上假装仍然准确。此后按 {@link RETRY_MS} 低频重试。
 * @returns {object|undefined} 相位信息，交给 {@link PeriodDot}。
 */
function usePeriodPhase() {
  const [snapshot, setSnapshot] = useState(undefined)
  const [now, setNow] = useState(() => Date.now())
  /** 快照的最新值：定时器回调不能依赖渲染闭包，否则每秒都要重建一次定时器。 */
  const latest = useRef(undefined)
  /** 上一次发起取数的时刻，用于给失败重试限流。 */
  const lastAttempt = useRef(0)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      lastAttempt.current = Date.now()
      fetchPeriod()
        .then((payload) => {
          if (cancelled) return
          latest.current = payload
          setSnapshot(payload)
          setNow(Date.now())
        })
        .catch(() => {
          if (cancelled) return
          latest.current = undefined
          setSnapshot(undefined)
        })
    }
    const step = () => {
      const at = Date.now()
      setNow(at)
      if (latest.current === undefined) {
        // 还没有可用快照：低频重试，既不放弃，也不至于每秒打一个请求。
        if (at - lastAttempt.current >= RETRY_MS) load()
        return
      }
      const phase = periodPhase(latest.current, at)
      // 倒计时归零 = 这一段已经走完，回去取新的一段。
      if (phase !== undefined && phase.remainMs <= 0) load()
    }
    load()
    const timer = setInterval(step, TICK_MS)
    // 回前台立刻对齐：休眠期间的本地递减不可信。
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
    }
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisible)
    }
  }, [])

  return useMemo(() => periodPhase(snapshot, now), [snapshot, now])
}

			exports.CAPTION_WIDTH = CAPTION_WIDTH
			exports.INLINE_MIN_ROW = INLINE_MIN_ROW
			exports.SIDE_MIN_ROW = SIDE_MIN_ROW
			exports.panelEntryLayout = panelEntryLayout
			exports.fetchPeriod = fetchPeriod
			exports.periodPhase = periodPhase
			exports.periodTitle = periodTitle
			exports.PeriodDot = PeriodDot
			exports.usePeriodPhase = usePeriodPhase
		},
		"./usage.js": (exports, require) => {
			const m1 = require("./format.js")
			const m2 = require("./cost.js")
			/**
 * 看板数据获取与派生计算：取数、按时间窗口切片、按「高峰 / 空闲」分档计价。
 * 纯逻辑，不含 React。
 * @module dsh-pixel-dashboard/client/usage
 */

const shiftKey = m1.shiftKey
// 计价口径只有一份（cost.js）。这里 import 进来是为了 `dailyCosts()`——
// 用别名是因为末尾还要把同一个名字原样再转出给看板与费用条，
// 同名 import + export 在打包后的 CJS 容器里会撞成「重复声明」。
const priceByModelForCost = m2.priceByModel
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
const TONES = ['blue', 'pink', 'green', 'yellow', 'purple', 'red']

/** tone → SVG fill 类名。 */
const toneFill = (tone) => `px-tone-fill-${tone}`

/** tone → HTML background 类名。 */
const toneBg = (tone) => `px-tone-bg-${tone}`

/** tone → stroke 类名。 */
const toneStroke = (tone) => `px-tone-${tone}`

/** 空用量（含分时段）。 */
function emptyUsage() {
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
async function fetchDashboard(options = {}) {
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
function sumRows(rows) {
  const acc = emptyUsage()
  for (const row of rows) accumulate(acc, row?.totals)
  return acc
}

/** 合计若干「模型 → 用量」表。 */
function sumByModel(entries) {
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
function dimensionSeries(points, models, dimension, options = {}) {
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
function dailyCosts(points, pricing) {
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
function recentDays(dayRows, days) {
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
const priceByModel = m2.priceByModel
const priceUsage = m2.priceUsage
const ratesFor = m2.ratesFor

			exports.priceByModel = priceByModel
			exports.priceUsage = priceUsage
			exports.ratesFor = ratesFor
			exports.TONES = TONES
			exports.toneFill = toneFill
			exports.toneBg = toneBg
			exports.toneStroke = toneStroke
			exports.emptyUsage = emptyUsage
			exports.fetchDashboard = fetchDashboard
			exports.sumRows = sumRows
			exports.sumByModel = sumByModel
			exports.dimensionSeries = dimensionSeries
			exports.dailyCosts = dailyCosts
			exports.recentDays = recentDays
		},
		"./graph.js": (exports, require) => {
			const m1 = require("./format.js")
			/**
 * 像素风图表的现代做法：平滑曲线 + 渐变面积 + 跟随光标的读数浮层。
 *
 * 尺寸策略：所有 SVG 都用「viewBox + 实测像素宽高」1:1 绘制，**不用**
 * preserveAspectRatio="none"。之前用 none 配固定像素高度会把几何非等比拉伸，
 * 折线的点和日历的格子被拉成长条，看起来就是“显示异常”。
 * @module dsh-pixel-dashboard/client/graph
 */

const React = require('react')
const formatCny = m1.formatCny
const formatTokens = m1.formatTokens
const shortDate = m1.shortDate
const { createElement: h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

/** 配色轮换，对应 CSS 的 --px-tone-* 变量。 */
const TONES = ['blue', 'pink', 'green', 'yellow', 'purple', 'red']

/** 渐变 id 序号：同页多图不能重名。 */
let gradientSeq = 0

/**
 * 观察容器宽度，用实测像素尺寸绘图，避免非等比拉伸。
 * @param {number} fallback - 尚未测到宽度时的兜底值。
 * @returns {[object, number]} ref 与当前宽度。
 */
function useMeasuredWidth(fallback) {
  const ref = useRef(null)
  const [width, setWidth] = useState(fallback)
  // 服务端渲染没有布局，用 useEffect 即可；浏览器里用 layout effect 避免首帧跳一下
  const useIsomorphic = typeof window === 'undefined' ? useEffect : useLayoutEffect
  useIsomorphic(() => {
    const node = ref.current
    if (node === null) return undefined
    const sync = () => {
      const next = Math.round(node.clientWidth)
      if (next > 0) setWidth((prev) => (prev === next ? prev : next))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])
  return [ref, width]
}

/**
 * 单调三次插值：曲线平滑且不过冲（Fritsch–Carlson 限制切线）。
 * @param {number[]} xs - 横坐标。
 * @param {number[]} ys - 纵坐标。
 * @returns {string} SVG path 的 d 属性。
 */
function smoothPath(xs, ys) {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M ${xs[0]} ${ys[0]}`
  if (n === 2) return `M ${xs[0]} ${ys[0]} L ${xs[1]} ${ys[1]}`

  const dx = []
  const slope = []
  for (let i = 0; i < n - 1; i += 1) {
    const step = xs[i + 1] - xs[i]
    dx.push(step)
    slope.push((ys[i + 1] - ys[i]) / (step === 0 ? 1 : step))
  }
  const m = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0
    } else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i])
    }
  }

  let d = `M ${xs[0]} ${ys[0]}`
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3
    d += ` C ${xs[i] + third} ${ys[i] + m[i] * third},`
      + ` ${xs[i + 1] - third} ${ys[i + 1] - m[i + 1] * third},`
      + ` ${xs[i + 1]} ${ys[i + 1]}`
  }
  return d
}

/**
 * 折线趋势图：平滑曲线 + 渐变面积 + 跟随光标的读数浮层。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function TrendChart(props) {
  const { points, series, formatAxis, formatValue, height = 240 } = props
  const [hover, setHover] = useState(null)
  const [wrapRef, width] = useMeasuredWidth(720)
  const uid = useMemo(() => `pxgrad${(gradientSeq += 1)}`, [])

  const pad = { top: 16, right: 14, bottom: 26, left: 58 }
  const innerW = Math.max(60, width - pad.left - pad.right)
  const innerH = Math.max(60, height - pad.top - pad.bottom)

  const max = useMemo(() => {
    let peak = 0
    for (const point of points) for (const line of series) peak = Math.max(peak, Number(point[line.key] ?? 0))
    return peak === 0 ? 1 : peak * 1.08
  }, [points, series])

  const stepX = points.length > 1 ? innerW / (points.length - 1) : innerW
  const xOf = useCallback((index) => pad.left + index * stepX, [pad.left, stepX])
  const yOf = useCallback(
    (value) => pad.top + innerH - (Number(value ?? 0) / max) * innerH,
    [pad.top, innerH, max],
  )

  const ticks = useMemo(
    () => Array.from({ length: 5 }, (_, index) => ({ value: (max / 4) * index, y: yOf((max / 4) * index) })),
    [max, yOf],
  )

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))))
    setHover(index)
  }

  // 轴标签数量随宽度自适应，窄屏不至于挤成一团
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 68))))
  const hoverLabel = hover === null ? '' : shortDate(points[hover].key)
  const baseline = pad.top + innerH

  return h(
    'div',
    { className: 'px-chart-wrap', ref: wrapRef, style: { position: 'relative' } },
    h(
      'svg',
      {
        className: 'px-chart',
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': 'token 用量趋势',
      },
      h('defs', null,
        series.map((line) =>
          h('linearGradient', { key: line.key, id: `${uid}-${line.key}`, x1: 0, y1: 0, x2: 0, y2: 1 },
            h('stop', { offset: '0%', stopColor: `var(--px-tone-${line.tone})`, stopOpacity: 0.28 }),
            h('stop', { offset: '100%', stopColor: `var(--px-tone-${line.tone})`, stopOpacity: 0 })))),
      ticks.map((tick, index) =>
        h('g', { key: `tick${index}` },
          h('rect', { x: pad.left, y: tick.y, width: innerW, height: 1, className: 'px-grid-line' }),
          h('text', { x: pad.left - 10, y: tick.y + 3.5, className: 'px-axis-text', textAnchor: 'end' },
            formatAxis ? formatAxis(tick.value) : Math.round(tick.value)))),
      series.map((line) => {
        const xs = points.map((_, index) => xOf(index))
        const ys = points.map((point) => yOf(point[line.key]))
        const d = smoothPath(xs, ys)
        if (d === '') return null
        // 面积先画、折线后画，保证线永远压在面积之上
        return h('g', { key: line.key },
          h('path', {
            className: 'px-area',
            d: `${d} L ${xs.at(-1)} ${baseline} L ${xs[0]} ${baseline} Z`,
            fill: `url(#${uid}-${line.key})`,
          }),
          h('path', { className: `px-line px-tone-${line.tone}`, d, fill: 'none' }))
      }),
      hover === null ? null : h('rect', {
        className: 'px-hover-line',
        x: xOf(hover),
        y: pad.top,
        width: 1,
        height: innerH,
      }),
      hover === null ? null : series.map((line) =>
        h('circle', {
          key: `dot-${line.key}`,
          className: `px-dot px-tone-${line.tone}`,
          cx: xOf(hover),
          cy: yOf(points[hover][line.key]),
          r: 3.4,
        })),
      points.map((point, index) =>
        index % labelEvery === 0 || index === points.length - 1
          ? h('text', {
            key: `x${index}`,
            x: xOf(index),
            y: height - 7,
            className: 'px-axis-text',
            textAnchor: 'middle',
          }, shortDate(point.key))
          : null),
      h('rect', {
        x: pad.left,
        y: pad.top,
        width: innerW,
        height: innerH,
        fill: 'transparent',
        onMouseMove: onMove,
        onMouseLeave: () => { setHover(null) },
      }),
    ),
    hover === null ? null : h(
      'div',
      { className: 'px-tip', style: { left: `${Math.min(78, Math.max(22, (xOf(hover) / width) * 100))}%` } },
      h('div', { className: 'px-tip-head' }, hoverLabel),
      series.map((line) =>
        h('div', { key: line.key, className: 'px-tip-row' },
          h('i', { className: `px-legend-swatch px-tone-${line.tone}` }),
          h('span', null, line.label),
          h('b', null, formatValue ? formatValue(points[hover][line.key]) : points[hover][line.key]))),
    ),
    h(
      'div',
      { className: 'px-legend' },
      series.map((line) =>
        h('span', { key: line.key, className: 'px-legend-item' },
          h('i', { className: `px-legend-swatch px-tone-${line.tone}` }),
          h('span', null, line.label),
          h('b', { className: `px-legend-value${hover === null ? '' : ' on'}` },
            hover === null ? '' : (formatValue ? formatValue(points[hover][line.key]) : '')))),
      h('span', { className: 'px-legend-tip' }, hover === null ? '悬停曲线查看当日明细' : hoverLabel),
    ),
  )
}

/**
 * 环图：按份额绘制扇形，中心显示主读数。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function DonutChart(props) {
  const { slices, centerTitle, centerValue, size = 190 } = props
  const cx = 100
  const cy = 100
  const radius = 74
  const thickness = 16
  const total = slices.reduce((sum, slice) => sum + Number(slice.value ?? 0), 0)

  /** 扇形路径：外弧 + 内弧闭合。 */
  const arcPath = (start, end) => {
    const outer = radius
    const inner = radius - thickness
    const large = end - start > Math.PI ? 1 : 0
    const at = (r, angle) => `${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)}`
    return [
      `M ${at(outer, start)}`,
      `A ${outer} ${outer} 0 ${large} 1 ${at(outer, end)}`,
      `L ${at(inner, end)}`,
      `A ${inner} ${inner} 0 ${large} 0 ${at(inner, start)}`,
      'Z',
    ].join(' ')
  }

  const arcs = []
  if (total > 0) {
    let cursor = -Math.PI / 2
    for (const slice of slices) {
      const value = Number(slice.value)
      const full = (value / total) * Math.PI * 2
      if (value > 0) {
        // 留 1.5° 间隙，视觉更透气
        arcs.push({ ...slice, start: cursor, end: cursor + Math.max(0.02, full - 0.015) })
      }
      cursor += full
    }
  }

  return h(
    'div',
    { className: 'px-donut' },
    h(
      'svg',
      {
        className: 'px-donut-svg',
        viewBox: '0 0 200 200',
        width: size,
        height: size,
        role: 'img',
        'aria-label': centerTitle,
      },
      h('circle', {
        cx,
        cy,
        r: radius - thickness / 2,
        fill: 'none',
        stroke: 'var(--px-surface-2)',
        strokeWidth: thickness,
      }),
      arcs.map((arc, index) =>
        h('path', {
          key: arc.key ?? index,
          className: `px-slice px-tone-fill-${arc.tone ?? 'blue'}`,
          d: arcPath(arc.start, arc.end),
        })),
      h('text', { x: cx, y: cy - 2, className: 'px-donut-value', textAnchor: 'middle' }, centerValue),
      h('text', { x: cx, y: cy + 17, className: 'px-donut-title', textAnchor: 'middle' }, centerTitle),
      total === 0
        ? h('text', { x: cx, y: cy + 36, className: 'px-axis-text', textAnchor: 'middle' }, '暂无数据')
        : null,
    ),
  )
}

/**
 * 活跃日历的「天序号 → 网格位置」映射：列为一周、行为星期几。
 *
 * 单独抽成纯函数，好让渲染闸门能直接断言它，而不是隔着 React 去量坐标
 * ——历史事故（`floor(day / 7)` 分列导致 9/10 下面显示 9/4）正是没人量过
 * 「下面一格是不是后一天」才漏出去的。
 *
 * **列号必须补上首列的空缺**：首日未必是周日，第一列是残缺的一周。
 * `Math.floor((leadWeekday + day) / 7)` 才是「从网格第一个周日数起的第几列」。
 * @param {number} dayIndex - 距首日的天数（0 起）。
 * @param {number} leadWeekday - 首日是周几（0 = 周日）。
 * @returns {{column:number,weekday:number}} 列号与行号。
 */
function calendarCellOf(dayIndex, leadWeekday) {
  const offset = Number(leadWeekday) || 0
  return {
    column: Math.floor((offset + Number(dayIndex)) / 7),
    weekday: (offset + Number(dayIndex)) % 7,
  }
}

/**
 * 活跃日历：一天一个方块，列为一周、行为星期几（GitHub 贡献图那种）。
 *
 * 这里刻意只画到「天」粒度。早先的版本想把 24 小时也塞进同一格，于是每格
 * 只有 0.4px 高、9px 宽，画出来自然是条形——一年 × 24 小时压不进一张图。
 *
 * 格子边长为整数且宽高相等：取整避免相邻格因浮点坐标产生 1px 细缝，
 * 等宽等高才保证是方块而不是条形。
 *
 * **列必须按「周」对齐，而不是按 `floor(day / 7)`。** 首日未必落在周日，
 * 因此第一列是**残缺的一周**：它前面几行（周日…首日的前一天）没有格子，
 * 首日只出现在自己那一行上。列号要按「距所属那一周的周日有多少天」算。
 *
 * 早先按 `floor(day / 7)` 分列，等于把首列当成完整一周：列内 7 天的星期几
 * 是首日星期几起的一个循环，一旦首日不是周日，循环就会在列内绕回去，
 * 于是「下面一格」不再是后一天。实测（首日 2025-09-12，周五）：
 * 9/10（周四）下面显示的是 9/4（上周五，比它早 6 天），9/17 下面是 9/11。
 * 用户顺着「往下就是往后」去读当天的用量，拿到的其实是另一天的数字。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function ActivityCalendar(props) {
  const { firstDay, days, requests, sessions, tokens, costs, maxRequests } = props
  const [tip, setTip] = useState(null)
  const [wrapRef, width] = useMeasuredWidth(900)

  const labelW = 26
  const gap = 3
  const first = Date.parse(`${firstDay}T00:00:00Z`)
  const parsedLead = new Date(first).getUTCDay()
  /**
   * 首日是周几（0 = 周日）。它同时是「第一列要空掉几行」和「列号偏移量」。
   *
   * 必须是有限数：首日缺失或非法时 `getUTCDay()` 给 NaN，坐标会一路算成 NaN，
   * 而 SVG 遇到 `x="NaN"` 会**静默丢掉整格**——界面只表现为「日历少了一块」。
   */
  const leadWeekday = Number.isFinite(parsedLead) ? parsedLead : 0
  // 脏 days（缺失 / 字符串 / NaN）同样要挡住：`Math.max(1, NaN)` 仍是 NaN。
  const totalDays = Math.max(0, Math.trunc(Number(days) || 0))
  const weekCols = Math.max(1, Math.ceil((totalDays + leadWeekday) / 7))
  const available = Math.max(100, width - labelW - 4)
  // 正方形边长：先按可用宽度定，再限制上限，避免宽屏上变成大色块
  const cell = Math.max(4, Math.min(Math.floor((available - gap * (weekCols - 1)) / weekCols), 15))
  const slot = cell + gap
  const gridW = weekCols * slot - gap
  const gridH = 7 * slot - gap
  const top = 16
  const height = Math.ceil(top + gridH + 26)

  const scaleMax = Math.max(1, Number(maxRequests ?? 1))
  const level = (value) => {
    if (!value) return 0
    const ratio = value / scaleMax
    if (ratio > 0.62) return 4
    if (ratio > 0.38) return 3
    if (ratio > 0.16) return 2
    return 1
  }

  const rects = []
  for (let day = 0; day < totalDays; day += 1) {
    // 位置与星期几都来自同一个映射：`weekday` 不再另算一次
    // （两处各算一次正是「列对了、行错了」这类错位的来源）。
    const { column, weekday } = calendarCellOf(day, leadWeekday)
    const value = Number(requests?.[day] ?? 0)
    rects.push(h('rect', {
      key: day,
      className: `px-heat px-heat-${level(value)}`,
      x: labelW + column * slot,
      y: top + weekday * slot,
      width: cell,
      height: cell,
      rx: 2,
      onMouseEnter: () => { setTip({ day, value }) },
      onMouseLeave: () => { setTip(null) },
    }))
  }

  const tipDate = tip === null ? '' : new Date(first + tip.day * 86_400_000).toISOString().slice(0, 10)
  const tipSessions = tip === null ? 0 : Number(sessions?.[tip.day] ?? 0)
  const tipTokens = tip === null ? 0 : Number(tokens?.[tip.day] ?? 0)
  // 消费估计：宿主按「每条请求发生的时段」逐日算好（见 host.js 的 dayRows[].cost）。
  // 缺失时显示 `—` 而不是 ¥0——「不知道」与「真的是 0」是两件事。
  const tipCostRaw = tip === null ? undefined : costs?.[tip.day]
  const tipCost = tipCostRaw === undefined || tipCostRaw === null || !Number.isFinite(Number(tipCostRaw))
    ? undefined
    : Number(tipCostRaw)

  return h(
    'div',
    { className: 'px-heat-wrap', ref: wrapRef },
    h(
      'svg',
      {
        className: 'px-heat-svg',
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': '全年活跃日历',
      },
      // 星期标签与格子垂直居中对齐
      [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
        h('text', {
          key: `w${weekday}`,
          x: labelW - 7,
          y: top + weekday * slot + cell / 2 + 3.5,
          className: 'px-axis-text',
          textAnchor: 'end',
        }, ['日', '一', '二', '三', '四', '五', '六'][weekday])),
      rects,
      ...monthTicks(first, totalDays, leadWeekday, labelW, slot, top),
      // 强度图例
      h('g', { transform: `translate(${labelW} ${top + gridH + 15})` },
        h('text', { x: -8, y: 0, className: 'px-axis-text', textAnchor: 'end' }, '少'),
        [0, 1, 2, 3, 4].map((index) =>
          h('rect', {
            key: index,
            className: `px-heat px-heat-${index}`,
            x: index * 11,
            y: -cell + 3,
            width: cell * 0.8,
            height: cell * 0.8,
            rx: 2,
          })),
        h('text', { x: 62, y: 0, className: 'px-axis-text' }, '多'),
        h('text', { x: gridW, y: 0, className: 'px-axis-text', textAnchor: 'end' },
          `最深一天 ${scaleMax} 次请求`)),
    ),
    h('div', { className: 'px-heat-tip' },
      tip === null
        ? '每格 = 一天 · 颜色越深请求越多 · 悬停看当天用量与消费估计'
        : [
          tipDate,
          `${tip.value} 次请求`,
          `${tipSessions} 个会话`,
          `${formatTokens(tipTokens)} tokens`,
          // 消费估计放在最后并标出来源：它是**本地估算**，不是账单
          tipCost === undefined ? '消费估计 —' : `消费估计 ${formatCny(tipCost)}`,
        ].join(' · ')),
  )
}

/**
 * 在每月一日所在列上方标出月份。
 *
 * 列号必须与格子用**同一个** `leadWeekday` 偏移量算，否则首列残缺时
 * 月份刻度会整体错开一列，看起来像格子跑到了隔壁月。
 * @param {number} first - 首日时间戳。
 * @param {number} days - 总天数。
 * @param {number} leadWeekday - 首日是周几（首列要空掉的格数）。
 * @param {number} labelW - 左侧标签宽度。
 * @param {number} slot - 列距。
 * @param {number} top - 网格顶部 y。
 * @returns {object[]} 文本元素数组。
 */
function monthTicks(first, days, leadWeekday, labelW, slot, top) {
  const labels = []
  let lastMonth = -1
  for (let day = 0; day < days; day += 1) {
    const date = new Date(first + day * 86_400_000)
    const month = date.getUTCMonth()
    if (month === lastMonth) continue
    lastMonth = month
    labels.push(h('text', {
      key: `m${month}-${day}`,
      x: labelW + Math.floor((leadWeekday + day) / 7) * slot,
      y: top - 5,
      className: 'px-axis-text',
    }, `${month + 1}月`))
  }
  return labels
}

/**
 * 水平条形列表：模型占比等紧凑对比。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function BarList(props) {
  const { rows } = props
  const max = rows.reduce((peak, row) => Math.max(peak, Number(row.value ?? 0)), 0) || 1
  return h(
    'div',
    { className: 'px-barlist' },
    rows.map((row) =>
      h('div', { key: row.key, className: 'px-barrow' },
        h('span', { className: 'px-barrow-label', title: row.label }, row.label),
        h('span', { className: 'px-barrow-track' },
          h('i', {
            className: `px-barrow-fill px-tone-${row.tone}`,
            style: { width: `${(Number(row.value ?? 0) / max) * 100}%` },
          })),
        h('span', { className: 'px-barrow-value' }, row.text))),
  )
}

/**
 * 数字滚动：指标出现时平滑爬到目标值，避免生硬跳变。
 * @param {number} target - 目标值。
 * @param {number} [duration] - 动画时长（毫秒）。
 * @returns {number} 当前显示值。
 */
function useCountUp(target, duration = 620) {
  const [value, setValue] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const to = Number(target ?? 0)
    if (from === to) {
      setValue(to)
      return undefined
    }
    // 尊重“减少动态效果”，也不假设宿主一定提供 rAF：两者缺一就直接落值。
    const reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined
    if (reduce || raf === undefined) {
      fromRef.current = to
      setValue(to)
      return undefined
    }
    let handle = 0
    const started = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - started) / duration)
      // easeOutCubic：起步快、收尾稳
      setValue(from + (to - from) * (1 - (1 - t) ** 3))
      if (t < 1) handle = raf(tick)
      else fromRef.current = to
    }
    handle = raf(tick)
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    }
  }, [target, duration])
  return value
}

			exports.TONES = TONES
			exports.useMeasuredWidth = useMeasuredWidth
			exports.TrendChart = TrendChart
			exports.DonutChart = DonutChart
			exports.calendarCellOf = calendarCellOf
			exports.ActivityCalendar = ActivityCalendar
			exports.BarList = BarList
			exports.useCountUp = useCountUp
		},
		"./theme.js": (exports, require) => {
			/**
 * 视觉系统：保留博客的像素基因（奶油底、马卡龙色、墨色文字），
 * 但把做工升级到现代水准——细腻圆角、柔和分层、克制的描边、
 * 150-320ms 缓动与微交互，取代 3px 硬描边加硬投影的粗糙做法。
 *
 * 颜色分两层下发：全局主题令牌（--dsw-alias-*）管产品区域配色，
 * 本文件的 --px-* 变量与样式管质感（层次、圆角、动效）与看板局部。
 * @module dsh-pixel-dashboard/client/theme
 */

/** 明暗两套主题，直接映射到 DSH 的语义令牌。 */
const PIXEL_THEMES = {
  day: {
    id: 'pixel-day',
    label: '奶油·昼',
    colorScheme: 'light',
    tokens: {
      '--dsw-alias-bg-base': '#fbf4e8',
      '--dsw-alias-bg-layer-1': '#fffdf9',
      '--dsw-alias-bg-layer-2': '#f7efe2',
      '--dsw-alias-bg-overlay': '#fffdf9',
      '--dsw-alias-border-l1': 'rgba(87, 68, 58, 0.10)',
      '--dsw-alias-border-l2': 'rgba(87, 68, 58, 0.18)',
      '--dsw-alias-brand-primary': '#e8749f',
      '--dsw-alias-label-primary': '#3f3129',
      '--dsw-alias-label-secondary': '#8a7969',
      '--dsw-alias-state-error-primary': '#d9584c',
      '--dsw-alias-state-success-primary': '#5f9e46',
      '--dsw-alias-state-warn-primary': '#c98a1c',
      '--dsw-specific-sidebar-fill': '#f6ecdd',
    },
  },
  night: {
    id: 'pixel-night',
    label: '暮色·夜',
    colorScheme: 'dark',
    tokens: {
      '--dsw-alias-bg-base': '#1c2030',
      '--dsw-alias-bg-layer-1': '#252a3d',
      '--dsw-alias-bg-layer-2': '#2e3448',
      '--dsw-alias-bg-overlay': '#2a3044',
      '--dsw-alias-border-l1': 'rgba(232, 234, 245, 0.10)',
      '--dsw-alias-border-l2': 'rgba(232, 234, 245, 0.18)',
      '--dsw-alias-brand-primary': '#c98aa4',
      '--dsw-alias-label-primary': '#e9ebf5',
      '--dsw-alias-label-secondary': '#9aa3bd',
      '--dsw-alias-state-error-primary': '#ff9a91',
      '--dsw-alias-state-success-primary': '#9ed986',
      '--dsw-alias-state-warn-primary': '#f2c96b',
      '--dsw-specific-sidebar-fill': '#181c2a',
    },
  },
}

/**
 * 令牌覆盖层：`overrideTokens` 要求每个令牌都给出 `{ light, dark }` 一对，
 * 它按当前生效方案挑其中一值。深浅两套本就在 PIXEL_THEMES 里齐备，
 * 这里合并成一层——于是「明暗切换」由主题服务自己完成，插件无需监听
 * theme/change 重下（那样会在同一次同步 emit 里递归，见 entry.js）。
 */
const PALETTE_OVERRIDES = (() => {
  const names = new Set([
    ...Object.keys(PIXEL_THEMES.day.tokens),
    ...Object.keys(PIXEL_THEMES.night.tokens),
  ])
  const layer = {}
  for (const name of names) {
    const light = PIXEL_THEMES.day.tokens[name] ?? PIXEL_THEMES.night.tokens[name]
    const dark = PIXEL_THEMES.night.tokens[name] ?? PIXEL_THEMES.day.tokens[name]
    if (light === undefined || dark === undefined) continue
    layer[name] = { light, dark }
  }
  return layer
})()

/**
 * 调色板与质感变量：深浅两套并存，靠 `body[data-ds-dark-theme]` 切换。
 *
 * **选择器必须写 `body[...]`，不能写 `html[...]`。** 产品把深色标记打在 `body` 上：
 *   - 启动期 boot-theme.ts：`document.body.toggleAttribute('data-ds-dark-theme', dark)`
 *   - 运行期 ThemePresenter.apply()：`body.setAttribute(DARK_ATTRIBUTE, '')`
 * 两处都只碰 `body`（`documentElement` 只用来设 `color-scheme`）。早先这里写成
 * `html[data-ds-dark-theme]`，那个选择器**永远不会命中**，于是深色模式下整套
 * `--px-*` 令牌仍取浅色值——白底白字、浅色卡片浮在暗色面板上。
 * 产品自己的暗色令牌也一律用 `body[data-ds-dark-theme]`（design-platform.css）。
 */
const TOKENS = `
:root {
  --px-ink: #3f3129;
  --px-ink-2: #6b5a4c;
  --px-muted: #8a7969;
  --px-bg: #fbf4e8;
  --px-surface: #fffdf9;
  --px-surface-2: #f7efe2;
  --px-line: rgba(87, 68, 58, 0.10);
  --px-line-2: rgba(87, 68, 58, 0.18);

  --px-pink: #f2a8c4;
  --px-pink-deep: #d9739b;
  --px-pink-soft: #fdeef4;
  --px-blue: #9ed3f5;
  --px-blue-deep: #5a9fd4;
  --px-green: #b3e59c;
  --px-green-deep: #6aa851;
  --px-yellow: #f7d98a;
  --px-yellow-deep: #c99a2e;
  --px-purple: #c9b3f0;
  --px-purple-deep: #8b6cc4;
  --px-red: #f5988e;

  --px-tone-blue: #5a9fd4;
  --px-tone-pink: #d9739b;
  --px-tone-green: #6aa851;
  --px-tone-yellow: #c99a2e;
  --px-tone-purple: #8b6cc4;
  --px-tone-red: #cf5a4c;
  /* 胶囊文字色：走自己的令牌，深浅两套各取合适值。
     刻意不直接读产品的 --dsw-* 令牌当文字色：产品把 --dsw-* 以**内联样式**写在
     body 上，而内联样式的优先级高于 <style> 里的规则，因此插件既覆盖不了、
     也无法按主题控制它；照抄一个固定浅色值会让深色模式下的胶囊文字发灰难读。 */
  --px-label-tertiary: #8a7969;

  --px-elev-1: 0 1px 2px rgba(87, 68, 58, 0.05), 0 2px 8px rgba(87, 68, 58, 0.05);
  --px-elev-2: 0 1px 2px rgba(87, 68, 58, 0.06), 0 6px 18px rgba(87, 68, 58, 0.08);
  --px-elev-3: 0 2px 4px rgba(87, 68, 58, 0.06), 0 12px 32px rgba(87, 68, 58, 0.12);
  --px-ring: 0 0 0 3px rgba(217, 115, 155, 0.18);

  --px-r-sm: 8px;
  --px-r-md: 12px;
  --px-r-lg: 16px;
  --px-r-pill: 999px;

  --px-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
  --px-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --px-dur-fast: 140ms;
  --px-dur: 200ms;
  --px-dur-slow: 320ms;

  --px-ui-font: 'Noto Sans SC', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', system-ui, sans-serif;
  /* 数字沿用同一套正常字体，只靠 tabular-nums 让并排数字等宽不跳动。
     刻意不用点阵/像素字体：中文像素字体并非人人装了，读起来也累。 */
  --px-num-font: var(--px-ui-font);
}
body[data-ds-dark-theme] {
  --px-ink: #e9ebf5;
  --px-ink-2: #c3c9db;
  --px-muted: #9aa3bd;
  --px-bg: #1c2030;
  --px-surface: #252a3d;
  --px-surface-2: #2e3448;
  --px-line: rgba(232, 234, 245, 0.10);
  --px-line-2: rgba(232, 234, 245, 0.18);
  --px-label-tertiary: #9aa3bd;

  --px-pink-soft: #3a2b34;
  /* 深色下这几个「深色强调色」要反向变亮：它们用在文字与描边上
     （如 .px-links a:hover），沿用浅色深号会在暗底上糊成一团。 */
  --px-pink-deep: #f0a8c4;
  --px-blue-deep: #9ecdf0;
  --px-green-deep: #a6dd8d;
  --px-yellow-deep: #e8c46a;
  --px-purple-deep: #c3aef0;
  --px-tone-blue: #7cbfe8;
  --px-tone-pink: #e79ab8;
  --px-tone-green: #8fd072;
  --px-tone-yellow: #e8c46a;
  --px-tone-purple: #b49ae8;
  --px-tone-red: #f28b80;

  --px-elev-1: 0 1px 2px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.20);
  --px-elev-2: 0 1px 2px rgba(0, 0, 0, 0.28), 0 6px 18px rgba(0, 0, 0, 0.28);
  --px-elev-3: 0 2px 4px rgba(0, 0, 0, 0.30), 0 12px 32px rgba(0, 0, 0, 0.36);
  --px-ring: 0 0 0 3px rgba(231, 154, 184, 0.22);
}
`

/**
 * 产品界面换肤：只贴近材质与节奏，不动任何布局尺寸，
 * 因此不会打乱产品排版，升级后也不会错版。
 */
const SKIN = `
body {
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  background-image:
    linear-gradient(var(--px-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--px-line) 1px, transparent 1px) !important;
  background-size: 28px 28px !important;
  background-attachment: fixed !important;
}
/* 字体：一律使用产品自带字体，不替换、不引入像素字体。
   只给数字加 tabular-nums，保证并排数字等宽不跳动。 */
[class*='badge'], [class*='Badge'], [class*='chip'], [class*='Chip'],
[class*='status'], [class*='Status'],
td[class*='number'], [class*='count'], [class*='Count'], [class*='metric'], [class*='Metric'] {
  font-variant-numeric: tabular-nums;
}
button, [role='button'], [role='tab'], [role='menuitem'], a, input, select, textarea {
  transition:
    background-color var(--px-dur) var(--px-ease),
    border-color var(--px-dur) var(--px-ease),
    color var(--px-dur-fast) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease),
    transform var(--px-dur-fast) var(--px-ease);
}
button, [role='button'], [role='tab'], input, select, textarea {
  border-radius: var(--px-r-md) !important;
}
button:not([disabled]):hover, [role='button']:hover {
  box-shadow: var(--px-elev-2);
}
button:not([disabled]):active {
  transform: translateY(1px) scale(0.985);
}
input:focus-visible, textarea:focus-visible, select:focus-visible,
button:focus-visible, [role='button']:focus-visible {
  outline: none !important;
  box-shadow: var(--px-ring) !important;
}
[role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'] {
  border-radius: var(--px-r-lg) !important;
  border: 1px solid var(--px-line-2) !important;
  box-shadow: var(--px-elev-3) !important;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--px-ink) 18%, transparent);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: var(--px-r-pill);
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--px-ink) 34%, transparent);
  background-clip: content-box;
}
::selection { background: color-mix(in srgb, var(--px-pink) 45%, transparent); color: var(--px-ink); }
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 1ms !important; animation-duration: 1ms !important; }
}
`

/**
 * 看板局部样式：全部使用 px- 前缀类名，不依赖产品内部类名，
 * 因此产品升级不会让看板错版。
 */
const DASHBOARD = `
.px-root {
  box-sizing: border-box;
  min-height: 100%;
  padding: 16px 20px 36px;
  color: var(--px-ink);
  font-family: var(--px-ui-font);
  font-variant-numeric: tabular-nums;
  overflow-y: auto;
}
.px-root *, .px-root *::before, .px-root *::after { box-sizing: border-box; }
.px-center { display: grid; place-items: center; }

@keyframes px-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes px-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes px-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }
@keyframes px-sweep { from { background-position: -180% 0; } to { background-position: 180% 0; } }
@keyframes px-rot { to { transform: rotate(360deg); } }
.px-rise { animation: px-rise var(--px-dur-slow) var(--px-ease-out) both; }

.px-loading {
  display: grid; gap: 14px; place-items: center;
  padding: 44px 28px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  color: var(--px-muted); font-size: 13px;
}
.px-skeleton {
  width: 190px; height: 8px; border-radius: var(--px-r-pill);
  background: linear-gradient(90deg, var(--px-surface-2) 25%, color-mix(in srgb, var(--px-pink) 35%, var(--px-surface-2)) 50%, var(--px-surface-2) 75%);
  background-size: 220% 100%;
  animation: px-sweep 1.4s var(--px-ease) infinite;
}
.px-muted { color: var(--px-muted); font-size: 12.5px; line-height: 1.75; margin: 8px 0 0; }
.px-note { margin-top: 12px; }
.px-mono { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; opacity: 0.72; }
.px-ok { color: var(--px-tone-green); font-weight: 650; }

.px-topbar {
  position: sticky; top: -20px; z-index: 5;
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; flex-wrap: wrap;
  margin: -20px -24px 20px; padding: 16px 24px 14px;
  background: color-mix(in srgb, var(--px-bg) 84%, transparent);
  backdrop-filter: saturate(1.4) blur(14px);
  border-bottom: 1px solid var(--px-line);
}
.px-topbar-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.px-mark {
  display: grid; place-items: center; width: 34px; height: 34px; flex: none;
  border-radius: 10px;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  box-shadow: var(--px-elev-2);
  color: #fff;
}
.px-title-text { display: grid; gap: 1px; min-width: 0; }
.px-title-main { font-family: var(--px-num-font); font-size: 16px; letter-spacing: 0.5px; line-height: 1.25; }
.px-title-sub { font-size: 11.5px; color: var(--px-muted); line-height: 1.3; }
.px-topbar-actions { display: flex; align-items: center; gap: 10px; }

.px-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 14px;
  font-family: inherit; font-size: 12.5px; font-weight: 550;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  box-shadow: var(--px-elev-1);
  cursor: pointer;
}
.px-btn:hover:not(:disabled) { background: var(--px-surface-2); box-shadow: var(--px-elev-2); transform: translateY(-1px); }
.px-btn:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: var(--px-elev-1); }
.px-btn:disabled { opacity: 0.55; cursor: default; }
.px-btn.primary {
  color: #fff; border-color: transparent;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  box-shadow: 0 2px 10px color-mix(in srgb, var(--px-pink-deep) 35%, transparent);
}
.px-btn.small { padding: 5px 11px; font-size: 12px; }
.px-spin { display: inline-block; animation: px-rot 0.9s linear infinite; }

.px-seg {
  position: relative; display: inline-flex; padding: 3px;
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
}
.px-seg-thumb {
  position: absolute; top: 3px; bottom: 3px; left: 3px;
  border-radius: 6px;
  background: var(--px-surface);
  box-shadow: var(--px-elev-1);
  transition: transform var(--px-dur) var(--px-ease), width var(--px-dur) var(--px-ease);
}
.px-seg-btn {
  position: relative; z-index: 1;
  padding: 5px 13px;
  font: inherit; font-size: 12px; font-weight: 550;
  color: var(--px-muted);
  background: none; border: none; cursor: pointer;
  transition: color var(--px-dur-fast) var(--px-ease);
}
.px-seg-btn:hover { color: var(--px-ink-2); }
.px-seg-btn[aria-selected='true'] { color: var(--px-ink); }

/* 卡片内的次级分段控件（趋势维度）：比顶部那个窗口切换器小一号。
   两者若长得一样重，用户会以为「模型 / 提供商」也是全局窗口设置。 */
.px-trend-dim { padding: 2px; }
.px-trend-dim .px-seg-thumb { top: 2px; bottom: 2px; left: 2px; border-radius: 5px; }
.px-trend-dim .px-seg-btn { padding: 3px 9px; font-size: 11px; }

.px-panel {
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  margin-bottom: 12px;
  overflow: hidden;
  transition: box-shadow var(--px-dur) var(--px-ease);
}
.px-panel:hover { box-shadow: var(--px-elev-2); }
.px-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 14px; border-bottom: 1px solid var(--px-line);
}
.px-panel-title { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 620; letter-spacing: 0.2px; }
.px-panel-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.px-tone-bg-blue { background: var(--px-tone-blue); }
.px-tone-bg-pink { background: var(--px-tone-pink); }
.px-tone-bg-green { background: var(--px-tone-green); }
.px-tone-bg-yellow { background: var(--px-tone-yellow); }
.px-tone-bg-purple { background: var(--px-tone-purple); }
.px-tone-bg-red { background: var(--px-tone-red); }
.px-panel-extra { font-size: 11.5px; color: var(--px-muted); }
.px-panel-body { padding: 12px 14px 13px; }

/* 可折叠面板：标题行整行变成一枚按钮。
   收起时**只留标题行**（body 根本不渲染），因此省下的是实打实的高度。
   按钮占满整行并自理内边距：header 本身已有 padding，这里要减掉，
   否则鼠标可点区域会比视觉上的标题行小一圈。 */
.px-panel-toggle {
  display: flex; align-items: center; gap: 8px;
  flex: 1 1 auto; min-width: 0;
  margin: -9px -14px; padding: 9px 14px;
  font: inherit; text-align: left; color: inherit;
  background: none; border: none; cursor: pointer;
  border-radius: 0;
}
.px-panel-toggle:hover { background: color-mix(in srgb, var(--px-ink) 5%, transparent); }
.px-panel-toggle-hint {
  margin-left: auto;
  font-size: 11px; color: var(--px-muted);
  padding: 2px 8px;
  border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
}
.px-panel-toggle:hover .px-panel-toggle-hint { color: var(--px-ink-2); }
/* 自绘三角（与 .px-details 同一套语言）：朝右 = 收起，朝下 = 展开。
   不依赖浏览器默认 marker，各家观感差别太大。 */
.px-caret {
  width: 0; height: 0; flex: none;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  color: var(--px-muted);
  transition: transform var(--px-dur-fast) var(--px-ease);
}
.px-caret.open { transform: rotate(90deg); }

/* 面板内部的轻量折叠区（最近通知这类明细） */
.px-collapse { margin-bottom: 12px; }
.px-collapse-head {
  display: flex; align-items: center; gap: 8px;
  width: 100%;
  padding: 6px 2px;
  font: inherit; text-align: left; color: inherit;
  background: none; border: none; cursor: pointer;
  border-bottom: 1px dashed var(--px-line-2);
  border-radius: 0;
}
.px-collapse.open .px-collapse-head { border-bottom-style: solid; }
.px-collapse-head > b { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-collapse-head .px-muted { margin: 0; }
.px-collapse-summary {
  margin-left: auto;
  font-size: 11px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
.px-collapse-body { padding-top: 8px; }

.px-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 10px; margin-bottom: 12px; }
.px-stat {
  position: relative; overflow: hidden;
  padding: 11px 13px 10px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: transform var(--px-dur) var(--px-ease), box-shadow var(--px-dur) var(--px-ease);
}
.px-stat::before {
  content: ''; position: absolute; inset: 0 0 auto 0; height: 3px;
  background: linear-gradient(90deg, var(--px-accent), color-mix(in srgb, var(--px-accent) 30%, transparent));
}
.px-stat::after {
  content: ''; position: absolute; right: -32px; top: -32px;
  width: 100px; height: 100px; border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--px-accent) 20%, transparent), transparent 70%);
  pointer-events: none;
}
.px-stat:hover { transform: translateY(-2px); box-shadow: var(--px-elev-2); }
.px-stat-blue { --px-accent: var(--px-tone-blue); }
.px-stat-purple { --px-accent: var(--px-tone-purple); }
.px-stat-pink { --px-accent: var(--px-tone-pink); }
.px-stat-green { --px-accent: var(--px-tone-green); }
.px-stat-label { font-size: 11.5px; font-weight: 550; color: var(--px-muted); letter-spacing: 0.3px; }
.px-stat-value {
  margin: 6px 0 5px;
  font-family: var(--px-num-font);
  font-size: 26px; line-height: 1.15; letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
}
.px-stat-foot { font-size: 11.5px; color: var(--px-muted); line-height: 1.65; }

.px-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px; font-weight: 570;
  border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  color: var(--px-ink-2);
  border: 1px solid var(--px-line);
}
.px-badge.ok {
  background: color-mix(in srgb, var(--px-green) 34%, transparent);
  color: var(--px-tone-green);
  border-color: color-mix(in srgb, var(--px-tone-green) 28%, transparent);
}
/* 高峰那一档：主题粉。与 .px-badge.ok 是同一套做法（淡色底 + 同色文字 +
   同色描边），只是换了色相——两态看起来才是同一种东西的两个状态。
   刻意**不**用 .ok 那种绿：绿在这里的语义是「便宜/正常」，
   而高峰是「正贵着」，用粉把它与空闲区分开，同时不落进红色的告警语义
   （红留给真正的故障：取数失败、余额为负）。 */
.px-badge.peak {
  background: color-mix(in srgb, var(--px-pink) 38%, transparent);
  color: var(--px-pink-deep);
  border-color: color-mix(in srgb, var(--px-pink-deep) 32%, transparent);
}
/* 强调徽标：「当前监看」这类「这是你选中的那个」标记。
   用粉色实底而不是描边，因为在三家并排的区块里，浅色描边几乎看不出来。 */
.px-badge.primary {
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  color: #fff;
  border-color: transparent;
}
.px-pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: px-pulse 1.8s var(--px-ease) infinite; }

/* 时段与计费（v2.1 起倒计时降级为一行次要信息，见下方 .px-period）。
   旧的 .px-offpeak / .px-clock 大卡片规则已随布局改版删除——
   留着只会让人以为还有一条渲染路径，实际没有任何元素用它们。 */
.px-rows { display: grid; gap: 2px; align-content: center; }
.px-row {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 9px 2px; border-bottom: 1px solid var(--px-line); font-size: 12.5px;
}
.px-row:last-child { border-bottom: none; }
.px-row > span { color: var(--px-muted); }
.px-row > b { font-family: var(--px-num-font); font-weight: 600; letter-spacing: 0.3px; }
/* 可点的「最近通知」行：点一下切到那条会话。
   button 自带居中与内边距，这里全部改回与 .px-row 一致的排版，
   只额外给出 hover 底色与手型光标——否则它会看起来不像能点。 */
.px-row-clickable {
  width: 100%;
  font: inherit;
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
  color: inherit;
  cursor: pointer;
}
.px-row-clickable:hover { background: color-mix(in srgb, var(--px-pink) 10%, transparent); }
.px-row-clickable:last-child { border-bottom: none; }

.px-chart-wrap { width: 100%; }
.px-chart { display: block; width: 100%; overflow: visible; }
.px-grid-line { fill: var(--px-line); }
.px-axis-text { fill: var(--px-muted); font-size: 10.5px; font-family: var(--px-ui-font); }
.px-line {
  stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; fill: none;
}
.px-line.px-tone-blue { stroke: var(--px-tone-blue); }
.px-line.px-tone-purple { stroke: var(--px-tone-purple); }
.px-line.px-tone-pink { stroke: var(--px-tone-pink); }
.px-line.px-tone-green { stroke: var(--px-tone-green); }
.px-line.px-tone-yellow { stroke: var(--px-tone-yellow); }
.px-line.px-tone-red { stroke: var(--px-tone-red); }
.px-area { stroke: none; }
.px-hover-line { fill: var(--px-ink); opacity: 0.16; }
.px-dot { stroke: var(--px-surface); stroke-width: 2; }
.px-dot.px-tone-blue { fill: var(--px-tone-blue); }
.px-dot.px-tone-purple { fill: var(--px-tone-purple); }
.px-dot.px-tone-pink { fill: var(--px-tone-pink); }
.px-dot.px-tone-green { fill: var(--px-tone-green); }
.px-dot.px-tone-yellow { fill: var(--px-tone-yellow); }
.px-dot.px-tone-red { fill: var(--px-tone-red); }

/* 跟随光标的读数浮层 */
.px-tip {
  position: absolute; top: 6px;
  transform: translateX(-50%);
  pointer-events: none;
  min-width: 150px;
  padding: 9px 11px;
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-md);
  box-shadow: var(--px-elev-3);
  font-size: 11.5px; line-height: 1.75;
  animation: px-fade 140ms var(--px-ease) both;
}
.px-tip-head { font-weight: 620; margin-bottom: 3px; font-variant-numeric: tabular-nums; }
.px-tip-row { display: flex; align-items: center; gap: 7px; color: var(--px-muted); }
.px-tip-row > b {
  margin-left: auto; color: var(--px-ink);
  font-family: var(--px-num-font); font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.px-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 10px; font-size: 12px; }
.px-legend-item { display: inline-flex; align-items: center; gap: 7px; color: var(--px-muted); }
.px-legend-swatch { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.px-legend-swatch.px-tone-blue { background: var(--px-tone-blue); }
.px-legend-swatch.px-tone-purple { background: var(--px-tone-purple); }
.px-legend-swatch.px-tone-pink { background: var(--px-tone-pink); }
/* 另外三色必须补齐：按模型 / 提供商分组时最多会有 6 条线（TONES 全用上），
   缺一组 swatch 就会画出一个没有底色的空方块——图例与曲线对不上号。 */
.px-legend-swatch.px-tone-green { background: var(--px-tone-green); }
.px-legend-swatch.px-tone-yellow { background: var(--px-tone-yellow); }
.px-legend-swatch.px-tone-red { background: var(--px-tone-red); }
.px-legend-value {
  font-family: var(--px-num-font); color: var(--px-ink); min-width: 58px;
  opacity: 0; transform: translateY(2px);
  transition: opacity var(--px-dur) var(--px-ease), transform var(--px-dur) var(--px-ease);
}
.px-legend-value.on { opacity: 1; transform: none; }
.px-legend-tip { margin-left: auto; font-size: 11.5px; color: var(--px-muted); }

.px-donut { display: grid; place-items: center; }
.px-donut-svg { display: block; }
.px-donut-back { fill: var(--px-surface-2); }
.px-donut-value { fill: var(--px-ink); font-family: var(--px-num-font); font-size: 22px; }
.px-donut-title { fill: var(--px-muted); font-size: 10.5px; }
.px-slice { stroke: var(--px-surface); stroke-width: 2; animation: px-fade var(--px-dur-slow) var(--px-ease-out) both; }
/* SVG 填充必须用 fill 类。粉/蓝那几个 px-tone-bg-* 是 background，
   套在 <path> 上不生效（环图会整圈空白），所以这两组类名刻意分开。 */
.px-tone-fill-blue { fill: var(--px-tone-blue); }
.px-tone-fill-pink { fill: var(--px-tone-pink); }
.px-tone-fill-green { fill: var(--px-tone-green); }
.px-tone-fill-yellow { fill: var(--px-tone-yellow); }
.px-tone-fill-purple { fill: var(--px-tone-purple); }
.px-tone-fill-red { fill: var(--px-tone-red); }

.px-heat-wrap { width: 100%; }
.px-heat-svg { display: block; }
.px-heat { rx: 1.5; }
.px-heat-0 { fill: var(--px-line); }
.px-heat-1 { fill: var(--px-tone-green); opacity: 0.26; }
.px-heat-2 { fill: var(--px-tone-green); opacity: 0.46; }
.px-heat-3 { fill: var(--px-tone-green); opacity: 0.72; }
.px-heat-4 { fill: var(--px-tone-green); opacity: 1; }
.px-heat-tip { margin-top: 8px; font-size: 11.5px; color: var(--px-muted); font-variant-numeric: tabular-nums; }

.px-barlist { display: grid; gap: 10px; }
.px-barrow { display: grid; grid-template-columns: minmax(88px, 0.85fr) 2fr minmax(104px, auto); align-items: center; gap: 12px; font-size: 12px; }
.px-barrow-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.px-barrow-track { height: 8px; border-radius: var(--px-r-pill); background: var(--px-surface-2); overflow: hidden; }
.px-barrow-fill { display: block; height: 100%; border-radius: var(--px-r-pill); transition: width var(--px-dur-slow) var(--px-ease-out); }
.px-barrow-fill.px-tone-blue { background: var(--px-tone-blue); }
.px-barrow-fill.px-tone-pink { background: var(--px-tone-pink); }
.px-barrow-fill.px-tone-green { background: var(--px-tone-green); }
.px-barrow-fill.px-tone-yellow { background: var(--px-tone-yellow); }
.px-barrow-fill.px-tone-purple { background: var(--px-tone-purple); }
.px-barrow-fill.px-tone-red { background: var(--px-tone-red); }
.px-barrow-value { font-family: var(--px-num-font); font-size: 11.5px; color: var(--px-muted); text-align: right; font-variant-numeric: tabular-nums; }
.px-model-grid { display: grid; grid-template-columns: 210px 1fr; gap: 22px; align-items: center; }
.px-model-side { display: grid; gap: 14px; min-width: 0; }

.px-table-wrap { overflow-x: auto; }
.px-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
.px-table th, .px-table td { padding: 9px 12px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--px-line); }
.px-table th { font-size: 11.5px; font-weight: 570; color: var(--px-muted); background: var(--px-surface-2); }
/* 数字列右对齐 + 等宽数字：金额与 token 并排时不跳动，位数也一眼可比 */
.px-table .px-num { text-align: right; font-variant-numeric: tabular-nums; }
/* 费用明细：模型那一格是「外显名 + 归一模型键 + 徽标」，其中键可能很长。
   给这一格一个宽度上限并允许换行，否则它会把「提供商」那一列挤到看不见。 */
.px-cost-table { table-layout: auto; }
.px-cost-table td:first-child { max-width: 320px; white-space: normal; }
.px-table th:first-child { border-top-left-radius: var(--px-r-sm); }
.px-table th:last-child { border-top-right-radius: var(--px-r-sm); }
.px-table tbody tr { transition: background-color var(--px-dur-fast) var(--px-ease); }
.px-table tbody tr:hover { background: color-mix(in srgb, var(--px-pink) 8%, transparent); }
.px-table tbody tr:last-child td { border-bottom: none; }
.px-row-total td { font-family: var(--px-num-font); font-weight: 600; background: color-mix(in srgb, var(--px-yellow) 18%, transparent); }

/* 会话清单：第一列是**预览标题**（与侧栏任务栏同源），会话 id 退成次要信息。
   标题可能很长（模型生成的标题是一句话），因此这一列要能被压缩并省略——
   表格用 min-width: 0 + text-overflow 才生效（默认的 table 布局会撑开）。 */
.px-session-table { table-layout: auto; }
.px-session-cell {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  max-width: 420px;
}
.px-session-title {
  font-weight: 550; color: var(--px-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 100%;
}
.px-session-workspace {
  font-size: 11px; color: var(--px-muted);
  padding: 1px 7px;
  border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
  white-space: nowrap;
}
.px-session-id {
  /* 会话 id 仍然可查（悬停 title 可复制），但排在标题之后、视觉上退到最末 */
  color: var(--px-muted);
  white-space: nowrap;
}

.px-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
.px-grid-2 .px-panel { margin-bottom: 12px; }

/* 两张趋势卡片（Token / 消费）并排一行。
   两条曲线共用同一段时间轴，分两行会让人来回滚动去对齐同一个日期，
   因此**等宽两列**并排（1fr 1fr 而不是 auto-fit）：等宽才能让两张图的横轴
   刻度落在同一列上，读数时不必横向换算。
   窄屏塌回单列——两张图各只有 300px 时曲线会挤成一团。 */
.px-trend-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.px-trend-row .px-panel { margin-bottom: 12px; }
/* 标题行右侧的维度切换器：卡片标题与它同排，不占额外高度。
   切换器自身在小屏会换行，这里允许它换行而不是硬挤。 */
.px-trend-row .px-panel-extra .px-seg { flex-wrap: wrap; }
@media (max-width: 1080px) {
  .px-trend-row { grid-template-columns: 1fr; }
}

/* 时段与计费 + 活跃日历 并排一行。
   日历是 53 列宽的图形，格子边长**直接随这栏宽度线性变化**（见 graph.js 里
   cell 的算法），所以比例不能随便给：左栏只留一份够放倒计时与三行键值对的最小
   宽度（"周一至周五 09:00–12:00、14:00–18:00" 这行本身就要 300px 左右），
   余下全部让给日历，格子才不至于缩到看不清。
   用 minmax(fr) 而不是固定 px：窄屏时两栏等比收缩，且左栏有 280px 下限兜底。 */
.px-pair {
  display: grid;
  grid-template-columns: minmax(280px, 0.6fr) minmax(0, 1.4fr);
  gap: 12px;
  align-items: start;
}
/* 左栏窄，时段卡片内部跟着竖排：横排会让那三行键值对在 300px 里反复折行 */
.px-pair .px-period { grid-template-columns: 1fr; }
.px-pair .px-panel { margin-bottom: 12px; }

/* 各模型官方单价：一张小表，不是一行塞满的标签云。
   早先把「色块×N + 模型名 + 提供商列表 + 三组价格 + 厂商」全塞进一个
   flex-wrap 容器，元素一多就折成好几行、右侧参差不齐。
   现在按两列排：左边是谁（色块 + 模型名 + 厂商），右边是三档价。
   价格区自己再分三列，于是每行的「缓存命中 / 未命中 / 输出」竖直对齐，
   纵向扫一眼就能比价——这正是这张表的用途。
   注意：这整段 CSS 是模板字符串，注释里**不能出现反引号**（会提前闭合字符串，
   症状是打包时报「Unexpected identifier」而源文件语法检查却是通过的）。 */
.px-rate-list {
  display: grid;
  /* 四列在**整张列表上定义一次**，每一行用 subgrid 继承同一组轨道。
     这样「缓存命中 / 未命中 / 输出」三列在所有行之间竖直对齐，眼睛能顺着列往下
     比价——这正是这张表存在的理由。

     早先每行各自 repeat(3, minmax(0, auto))，列宽按**本行内容**算：DeepSeek 那行
     有 ¥0.02 / ¥0.04 这种长数字，GLM 那行只有 ¥2 / ¥8 / ¥28，于是三列在行间错开
     （实测第一列起点 818 / 911 / 793），看起来就像「有的行缩进了、有的没有」。
     列宽必须由**全表最宽的那一格**决定，而不是各行自算。 */
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  column-gap: 14px;
  row-gap: 6px;
  margin-top: 12px;
}
.px-rate-caption {
  grid-column: 1 / -1;
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
  font-size: 11px; color: var(--px-muted);
}
.px-rate-unit { font-variant-numeric: tabular-nums; }
.px-rate {
  display: grid;
  /* 继承列表那四列：列宽因此是全表统一的，而不是每行各算一份 */
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: center;
  column-gap: 14px;
  row-gap: 6px;
  padding: 7px 10px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
  font-size: 11.5px; color: var(--px-muted);
}
/* 左列：色块 + 模型名 + 厂商。允许收缩，不把右列挤走 */
.px-rate-who {
  grid-column: 1; grid-row: 1;
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  min-width: 0;
}
.px-rate-who > b { color: var(--px-ink); font-size: 12px; }
.px-rate-prices {
  /* 直接落在列表的第 2–4 列上，并继续用 subgrid 往下继承，
     于是三个价格列与表头、与其它行共享同一组轨道宽度。 */
  grid-column: 2 / -1; grid-row: 1;
  display: grid; grid-template-columns: subgrid;
  column-gap: 14px;
  font-variant-numeric: tabular-nums;
}
.px-rate-prices > span { display: flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.px-rate-prices em { font-style: normal; color: var(--px-muted); font-size: 11px; }
.px-rate-prices code {
  font-family: var(--px-num-font); color: var(--px-ink); font-size: 11.5px;
}
.px-rate-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
/* 一个模型可能由多家提供商提供，这里并排它们的色块（与环图同一套配色）。
   收窄间距并让它们成组，读起来才像「同一个模型的几个来源」而不是几件不相干的东西。 */
.px-rate-tones { display: inline-flex; align-items: center; gap: 3px; flex: none; }
/* 窄屏：价格换到第二行，不要横向挤成参差 */
/* ── 自定义单价编辑器 ────────────────────────────────────────
   它是「补一个价目表里没有的模型」的入口，因此排版目标很直白：一行里能看到
   六个数字框而不需要横向滚动，且「空闲 / 高峰」成对相邻——填错档位是这里最
   可能的错法，成对摆放能让它一眼可见。 */
.px-price-editor { margin-top: 12px; }
.px-price-editor > summary { cursor: pointer; font-size: 12px; font-weight: 560; }
.px-price-editor > summary > .px-badge { margin-left: 6px; }
.px-price-form {
  display: grid; gap: 8px;
  margin-top: 10px; padding: 10px;
  border-radius: var(--px-r-sm); background: var(--px-surface-2);
}
/* 通用文本输入框：与上面通知阈值那几个输入框**同一套外观**。
   本来想直接复用 .px-notify-input input，但那个选择器绑在通知面板的类名上，
   借来用会让「单价编辑器」意外依赖通知面板的 DOM 结构。 */
.px-input {
  /* basis 必须写 0 而不是 auto：auto 会用输入框自身的固有宽度（浏览器默认约 20 字符），
     于是它撑在 flex 里不肯收缩，三个价格档在窄栏里就会横向溢出（实测溢出 66px）。 */
  flex: 1 1 0;
  min-width: 0;
  padding: 5px 8px;
  font-family: var(--px-num-font);
  font-size: 12px;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
}
.px-input:disabled { opacity: 0.55; }
/* min-width: 0 是**必须**的：flex 容器默认 min-width:auto，会被内部输入框的固有宽度
   撑住不收缩，于是整行溢出到面板外面（grid/flex 层叠里的经典坑）。 */
.px-rate-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
.px-rate-field-label { flex: none; width: 62px; font-size: 11.5px; color: var(--px-muted); }
.px-rate-pairs {
  display: grid; gap: 8px;
  /* 三档并排；窄屏由下面的媒体查询塌成单列，避免六个框挤成一团 */
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.px-rate-pair { display: grid; gap: 4px; min-width: 0; }
.px-rate-pair > b { font-size: 11.5px; color: var(--px-ink); }
.px-rate-pair .px-rate-field-label { width: 32px; }
.px-rate-pair .px-input { min-width: 0; }
.px-price-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.px-price-errors { margin: 6px 0 0; padding-left: 18px; font-size: 11.5px; color: var(--px-red); }
.px-price-remove { display: flex; gap: 8px; align-items: center; }
.px-balance-state.px-ok {
  background: color-mix(in srgb, var(--px-tone-green) 20%, var(--px-surface-2));
  color: var(--px-ink-2);
}

@media (max-width: 720px) {
  /* 窄屏：价格整行换到第二行。此时每一行都占满同一宽度，因此均分三列即可让
     列与列继续对齐——这里刻意**不用 subgrid**（上一层的轨道只剩 1 列了，
     继承下来会把三个价格竖着叠起来）。 */
  .px-rate { grid-template-columns: minmax(0, 1fr); }
  /* 六个数字框在窄屏塌成单列：并排会让每个框窄到看不清数字 */
  .px-rate-pairs { grid-template-columns: minmax(0, 1fr); }
  .px-rate-prices {
    grid-column: 1; grid-row: 2;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 14px;
  }
}

/* 数据来源脚注 */
.px-source {
  margin: 4px 0 0;
  font-size: 11.5px; line-height: 1.7;
  color: var(--px-muted);
}
.px-source a { color: var(--px-tone-pink); text-decoration: underline; text-underline-offset: 2px; }
.px-source a:hover { color: var(--px-pink-deep); }

/* 输入框下方的会话费用徽标（费用 + 余额 + 套餐额度）。
   默认这些徽标会 **portal 进产品统计行**（[data-composer-stats]），与「缓存命中」
   并排同一行；锚点不在时才退回自渲染 .px-cost-row。
   容器是纵向 flex + align-items: center 且**没有 gap**，所以兜底行必须自己撑满宽度
   并自带上边距，否则会收缩居中并贴住输入框。 */
.px-cost-row {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  max-width: var(--dsh-chat-content-width, 100%);
  margin: 0 auto;
  box-sizing: border-box;
  padding: 4px calc(var(--dsh-composer-side-clearance, 16px) + 16px) 0;
  font-size: var(--dsh-content-font-size-secondary, 13px);
}
/* 并入产品统计行时，这一层只是 inline-flex，间距交给产品那行 */
.px-pill-group { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; }

/* 一枚徽标：刻意对齐产品统计胶囊的观感（13px、tertiary 文字、24px 圆角、
   悬停微微加深），并排时不显得是外来的。 */
.px-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--px-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  transition: background-color var(--px-dur-fast) var(--px-ease);
}
.px-pill:hover { background: color-mix(in srgb, var(--px-ink) 7%, transparent); }
.px-pill-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--px-tone-pink); }
.px-pill-label { color: inherit; }
.px-pill-value { color: var(--px-ink); font-weight: 620; }
/* 角标：点明「这个数字是怎么来的」（如「估算」）。
   只写进 title 是不够的——不主动悬停的用户永远看不到那一层说明。 */
.px-pill-tag {
  padding: 0 5px;
  border-radius: var(--px-r-pill);
  background: color-mix(in srgb, var(--px-yellow) 45%, transparent);
  color: var(--px-tone-yellow);
  font-size: 10px; font-weight: 600;
  line-height: 1.6;
}
/* 拿不到费用时的告警态：不要在界面上装作一切正常 */
.px-pill-warn { background: color-mix(in srgb, var(--px-red) 14%, transparent); }
.px-pill-warn .px-pill-dot { background: var(--px-tone-red); }
.px-pill-warn .px-pill-value { color: var(--px-tone-red); }

/* ── 侧栏「用量看板」行上的时段倒计时 ────────────────────────────
   一行文字，用颜色区分时期：
     高峰中（红）→ 2时15分后空闲期
     空闲中（绿）→ 空闲期剩2时15分

   刻意**没有环形进度**：那枚环要「已走 ÷ 总长」，而各段长度差几十倍
   （午休 2 小时、周末 63 小时），环在周末几乎不动，看起来像坏了。
   文字直说「还剩多久」既准确又省地方。

   ## 它放在哪
   放在**「用量看板」四个字的右边**。由 entry.js portal 进产品的 row 元素，
   因此它是标题的 **flex 兄弟节点**，自然排在标题之后。

   这点很关键：产品只把**图标槽**给插件，而图标槽是内容宽度（十几像素）。
   早先在插槽内部用绝对定位 + right，那个 right 是相对**图标槽**解析的，
   文字因此怎么都离不开柱状图标。portal 到 row 之后这个问题从结构上消失。

   颜色一律走 --px-* 令牌（--px-tone-green / --px-tone-red 已在深浅两套里
   各自定义），因此深色模式下会自动换成更亮的那一支，不会糊在暗底上。 */

/* 图标槽里的内容容器：只放柱状图图标。 */
.px-panel-entry {
  display: inline-flex;
  align-items: center;
  pointer-events: none;
}

/* 倒计时文字：row 里的普通 flex 项；margin-left: auto 把它推到行尾，
   标题因此仍从左对齐、不会被挤到中间。 */
.px-period-inline {
  margin-left: auto;
  padding-left: 8px;
  white-space: nowrap;
  flex: none;
  pointer-events: none;
  font-family: var(--px-num-font);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
/* 两个时期各一色：红 = 高峰（正贵着）、绿 = 空闲（正便宜） */
.px-period-tone-red { color: var(--px-tone-red); }
.px-period-tone-green { color: var(--px-tone-green); }

/* 时段与计费：倒计时降级为一行次要信息，与计费口径同处一张紧凑卡片，
   不再单独占一张大面板（用户反馈「内容不多却占大量空间」）。 */
.px-period {
  display: grid;
  grid-template-columns: minmax(190px, max-content) 1fr;
  gap: 12px;
  align-items: center;
}
.px-period-clock {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
.px-period-clock-label { font-size: 11.5px; color: var(--px-muted); }
.px-period-clock-value {
  font-family: var(--px-num-font);
  font-size: 15px; font-weight: 640;
  color: var(--px-ink);
  font-variant-numeric: tabular-nums;
}
.px-period-clock-foot { font-size: 11px; color: var(--px-muted); }
.px-period-rows { display: grid; gap: 4px; min-width: 0; }

/* 账户与套餐：并排两栏，各自内部紧凑排列（原来两张独立大面板太占地方）。
   两栏高度不齐是常态（一边两个数字、一边三家的进度条），align-items: start
   让短的那一栏不被拉伸——拉出来的空白看起来像「没加载完」。 */
.px-account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
  align-items: start;
}
.px-account-col { min-width: 0; }
.px-account-grid .px-balance-privacy { margin-top: 8px; padding-top: 8px; }
.px-account-grid .px-plan-list { gap: 10px; }

/* 跳去官方平台充值 / 管理的入口 */
.px-links { margin: 8px 0 0; font-size: 11.5px; }
.px-links a { color: var(--px-tone-pink); text-decoration: underline; text-underline-offset: 2px; }
.px-links a:hover { color: var(--px-pink-deep); }
.px-links-sep { margin: 0 6px; color: var(--px-muted); }

/* 折叠区：把「数据来源与隐私」这类长说明收起来——信息仍可查，但不占版面。
   用原生 <details>，不需要任何 JS 或组件状态。 */
.px-details {
  margin-top: 8px;
  border-top: 1px dashed var(--px-line-2);
  padding-top: 6px;
}
.px-details > summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--px-muted);
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  user-select: none;
}
.px-details > summary::-webkit-details-marker { display: none; }
/* 自绘小三角：不依赖浏览器默认标记（各家观感差别很大） */
.px-details > summary::before {
  content: '';
  width: 0; height: 0;
  border-left: 5px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform var(--px-dur-fast) var(--px-ease);
}
.px-details[open] > summary::before { transform: rotate(90deg); }
.px-details > summary:hover { color: var(--px-ink-2); }
.px-details .px-balance-privacy { margin-top: 6px; padding-top: 0; border-top: none; }

/* 账户余额卡片：看板里的明细区 */
.px-balance-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  margin-bottom: 12px;
}
.px-balance-total { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.px-balance-amount {
  font-family: var(--px-num-font);
  font-size: 26px; font-weight: 660; letter-spacing: -0.4px;
  color: var(--px-ink);
}
.px-balance-amount.px-negative { color: var(--px-tone-red); }
.px-balance-currency { font-size: 12px; font-weight: 560; color: var(--px-muted); }
.px-balance-rows { display: grid; gap: 6px; margin-top: 4px; }
.px-balance-toggle {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--px-muted);
}
.px-balance-state {
  margin: 0 0 10px;
  padding: 7px 11px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
  font-size: 11.5px; line-height: 1.6; color: var(--px-muted);
}
.px-balance-state.px-warn { background: color-mix(in srgb, var(--px-yellow) 22%, var(--px-surface-2)); color: var(--px-ink-2); }
.px-balance-state.px-error { background: color-mix(in srgb, var(--px-red) 18%, var(--px-surface-2)); color: var(--px-ink-2); }
.px-balance-privacy {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; line-height: 1.7; color: var(--px-muted);
}
.px-balance-state.px-off { background: var(--px-surface-2); color: var(--px-muted); }

/* 订阅套餐额度：一家一块，每块里按窗口（5 小时 / 每周 / 每月）逐条画进度 */
.px-plan-list { display: grid; gap: 16px; }
/* 折叠区里那几家：间距收紧一点，并且整体压暗——
   它们此刻没有数据（就是「还没配」），不该与上面真正在用的那几家抢注意力，
   但仍然要能一眼看清「插件还支持哪些家、各自怎么配」。 */
.px-plan-list-idle { gap: 12px; margin-top: 10px; }
.px-plan-list-idle .px-plan { background: var(--px-surface); }
.px-plan-list-idle .px-plan-name { color: var(--px-ink-2); }
.px-plan {
  padding: 9px 11px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
/* 「当前监看」那一家：左侧一道粉色标记 + 略深底色。
   这道标记是切换器的**可见结果**——点完必须一眼看出点中了谁，
   否则切换器看起来就像没生效。 */
.px-plan-current {
  border-color: color-mix(in srgb, var(--px-tone-pink) 38%, var(--px-line));
  box-shadow: inset 3px 0 0 var(--px-tone-pink);
}
.px-plan-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.px-plan-name { font-size: 13px; font-weight: 620; color: var(--px-ink); }
/* 凭据尾段：只为让用户确认「用的是哪一把 Key」，不是密钥本身 */
.px-plan-key {
  margin-left: auto;
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-muted);
  padding: 2px 8px;
  border-radius: var(--px-r-pill);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
}
/* 一家的补充信息一行装完：入口链接 + 数据源端点。
   分两行会让三家堆出六行，而这两件事都属于「关于这一家」的次要信息。 */
.px-plan-foot {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 11px;
}
.px-plan-foot a { color: var(--px-tone-pink); text-decoration: underline; text-underline-offset: 2px; }
.px-plan-foot a:hover { color: var(--px-pink-deep); }
.px-plan-endpoint {
  margin-left: auto;
  color: var(--px-muted);
  font-family: var(--px-num-font);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 60%;
}

/* 「这家凭据怎么配」：去哪拿 + 拿到后放哪。
   缺凭据时默认展开（那正是用户需要它的时刻），所以这一块必须自己读得懂，
   不能只写「请配成 XXX」——DSH 设置里没有能填这个名字的输入框。 */
.px-plan-setup {
  margin: 10px 0 0;
  padding: 8px 11px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
}
.px-plan-setup > summary { font-size: 11.5px; }
.px-plan-steps {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 11.5px; line-height: 1.75; color: var(--px-ink-2);
}
.px-plan-steps li { margin-bottom: 4px; }
.px-plan-setup-link { margin: 8px 0 0; font-size: 11.5px; }
.px-plan-setup-link a {
  color: var(--px-tone-pink);
  text-decoration: underline; text-underline-offset: 2px;
}
.px-plan-setup-link a:hover { color: var(--px-pink-deep); }
.px-plan-setup-where {
  margin-top: 9px; padding-top: 8px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11.5px; line-height: 1.7; color: var(--px-muted);
}
.px-plan-setup-where > p { margin: 0; }
/* 路径要能整条读出来并复制：换行而不是省略号截断 */
.px-plan-setup-path {
  display: block;
  margin: 5px 0 0;
  padding: 5px 8px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
  word-break: break-all;
  user-select: all;
}
.px-plan-setup-refs {
  margin: 6px 0 0;
  padding-left: 16px;
  list-style: none;
}
.px-plan-setup-refs li { margin-bottom: 3px; }
.px-plan-setup-refs code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink);
}
.px-plan-setup-note {
  margin-left: 6px;
  font-size: 11px; color: var(--px-muted);
}
.px-plan-setup-hint { margin: 8px 0 0; font-size: 11px; line-height: 1.7; color: var(--px-muted); }
.px-plan-setup-hint code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
}

/* 「当前监看」切换器：一排小 chip。
   自动项永远存在（否则用户点过一次就再也回不到自动）。失败的厂商也列出来并
   带一个告警点——用户配错凭据时恰恰最想切过去看原因。 */
.px-plan-switch {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-bottom: 12px;
}
.px-plan-switch-label { font-size: 11.5px; font-weight: 570; color: var(--px-muted); }
.px-plan-switch-hint {
  flex-basis: 100%;
  font-size: 11px; color: var(--px-muted); line-height: 1.5;
}
.px-plan-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px;
  font: inherit; font-size: 11.5px; font-weight: 550;
  color: var(--px-ink-2);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  cursor: pointer;
}
.px-plan-chip:hover { background: var(--px-surface-2); }
.px-plan-chip.active {
  color: #fff; border-color: transparent;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
}
/* 取数失败的那一家：带一枚小红点，切过去就是它的失败原因 */
.px-plan-chip.bad::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--px-tone-red); flex: none;
}
.px-plan-chip.active.bad::before { background: #fff; }
.px-quota-list { display: grid; gap: 10px; margin-top: 12px; }
.px-quota-head { display: flex; align-items: baseline; gap: 10px; }
.px-quota-name { font-size: 12px; font-weight: 560; color: var(--px-ink-2); min-width: 58px; }
.px-quota-percent { font-size: 12.5px; font-weight: 620; }
.px-quota-percent.px-tone-green { color: var(--px-tone-green); }
.px-quota-percent.px-tone-yellow { color: var(--px-tone-yellow); }
.px-quota-percent.px-tone-red { color: var(--px-tone-red); }
.px-quota-track {
  margin-top: 6px;
  height: 7px;
  border-radius: var(--px-r-pill);
  background: color-mix(in srgb, var(--px-ink) 10%, transparent);
  overflow: hidden;
}
.px-quota-fill {
  display: block; height: 100%;
  border-radius: var(--px-r-pill);
  transition: width var(--px-dur-slow) var(--px-ease-out);
}
.px-quota-foot { margin-top: 6px; font-size: 11px; color: var(--px-muted); font-variant-numeric: tabular-nums; }

/* 费用条上「最紧额度」那一枚用紫色点，与余额（绿）和费用（粉）区分开 */

/* ── 通知与预警 ───────────────────────────────────────────────────
   面板里的这几块（授权行、开关、阈值输入、最近通知）与页面内提示条共用
   同一套 --px-* 令牌，因此明暗两套方案都自动成立，不必各写一遍。 */

.px-notify-permission {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 9px 11px;
  margin-bottom: 12px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
.px-notify-permission-text { margin: 0; flex: 1 1 240px; }

.px-notify-pending {
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid color-mix(in srgb, var(--px-yellow) 45%, var(--px-line));
  border-radius: var(--px-r-md);
  background: color-mix(in srgb, var(--px-yellow) 16%, var(--px-surface));
}
.px-notify-pending-title { display: block; margin-bottom: 8px; font-size: 13px; color: var(--px-ink); }

.px-notify-flags {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 6px 14px;
  margin-bottom: 14px;
}
.px-notify-flag {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 12.5px; color: var(--px-ink-2);
  cursor: pointer;
}
.px-notify-flag input { flex: none; }

.px-notify-threshold {
  padding: 10px 12px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
}
/* 两项阈值并排：各自正文只有「一个标签 + 一个数字框」，各占整行会白吃两倍高度。
   两栏等宽（1fr 1fr）而不是 auto-fit：它们的信息量相当，等宽读起来才整齐。
   窄屏塌回单列——余额那一项在小屏上要换行放「CNY 低于 [__]」。 */
.px-notify-thresholds {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
/* 并排时最后一项的下边距会与容器重叠，这里去掉（间距交给 grid 的 gap） */
.px-notify-thresholds .px-notify-threshold { margin-bottom: 0; }
.px-notify-threshold-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
  margin-bottom: 10px;
}
.px-notify-threshold-head b { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-notify-threshold-head .px-muted { margin: 0; }

.px-notify-inputs { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
.px-notify-input {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--px-ink-2);
}
.px-notify-input input {
  width: 84px;
  padding: 5px 8px;
  font-family: var(--px-num-font);
  font-size: 12.5px;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
}
.px-notify-recent { margin-bottom: 4px; }

/* 页面内提示条：系统通知不可用时的唯一可见通道。
   固定右下角、脱离文档流，因此不会挤动任何产品元素。 */
.px-toast-host {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483000;
  display: grid;
  gap: 8px;
  max-width: min(360px, calc(100vw - 36px));
  pointer-events: none;
}
.px-toast {
  display: grid;
  gap: 3px;
  padding: 11px 13px;
  border-radius: var(--px-r-md);
  border: 1px solid var(--px-line-2);
  background: var(--px-surface);
  box-shadow: var(--px-elev-3);
  font-size: 12.5px;
  color: var(--px-ink-2);
  animation: px-toast-in var(--px-dur-slow) var(--px-ease-out);
}
.px-toast-title { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-toast-body { line-height: 1.6; }
.px-toast-ok { border-left: 3px solid var(--px-tone-green); }
.px-toast-warn { border-left: 3px solid var(--px-tone-yellow); }
.px-toast-error { border-left: 3px solid var(--px-tone-red); }
/* 可点的提示条（带着会话 id 的那些）：点一下切到那条会话。
   容器是 pointer-events: none（让提示条不挡住它下面的产品界面），所以这里必须
   把它**单独**开回来，否则整条提示条都收不到点击——点了没反应，而没有任何报错。 */
.px-toast-clickable {
  pointer-events: auto;
  cursor: pointer;
  transition: background-color var(--px-dur-fast) var(--px-ease);
}
.px-toast-clickable:hover { background: var(--px-surface-2); }
/* 可点时补一句动作提示，让「能点」这件事自己说出来 */
.px-toast-clickable .px-toast-body::after {
  content: ' · 点击前往';
  color: var(--px-muted);
}
@keyframes px-toast-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 960px) {
  .px-period { grid-template-columns: 1fr; }
  /* 窄屏：并排的两块塌回单列，日历才不至于被压成一条 */
  .px-pair { grid-template-columns: 1fr; }
  /* 阈值并排也要塌回单列：两栏各 320px 以下时，「CNY 低于 [____]」会挤成三行 */
  .px-notify-thresholds { grid-template-columns: 1fr; }
  .px-notify-thresholds .px-notify-threshold { margin-bottom: 12px; }
  .px-model-grid { grid-template-columns: 1fr; justify-items: center; }
  .px-root { padding: 14px 14px 40px; }
  .px-topbar { margin: -14px -14px 16px; padding: 12px 14px; top: -14px; }
}
`

/** 样式表清单：装配与卸载共用同一份来源。 */
const STYLES = [
  ['tokens', TOKENS],
  ['skin', SKIN],
  ['dashboard', DASHBOARD],
]

			exports.PIXEL_THEMES = PIXEL_THEMES
			exports.PALETTE_OVERRIDES = PALETTE_OVERRIDES
			exports.STYLES = STYLES
		},
		"./Notifier.js": (exports, require) => {
			const m1 = require("./balance.js")
			const m2 = require("./notify.js")
			const m3 = require("./plans.js")
			/**
 * 通知运行时（浏览器半边）：常驻的取数与派发循环。
 *
 * ## 为什么用 `ctx.effect` 而不是 React 组件
 *
 * 提醒必须**始终**在工作，而组件只在它所在的槽位被渲染时才挂着——用户打开
 * 设置面板时提醒才生效，这显然不对。因此这里用插件 fiber 上的 effect 起一个
 * 自带定时器的循环，随插件加载而活、随插件卸载而停。
 *
 * 于是也**不需要 React**：待办交互从 `ctx.uiSession` 上直接读快照并订阅
 * （那是 DSH 自己发布的全局可观察量），不必借助 hook。
 *
 * **待办的可观察量有两代，必须都认。** DSH 在 `0.1.6-alpha.2` 把待办从
 * `uiSession.pendingInteractions` 搬进了 `uiSession.sessionStatus`
 * （`Map<SessionId, {running, pendingInteraction, completionUnread}>`），旧属性被删除。
 * 而旧代码写的是 `uiSession.pendingInteractions`——属性不存在时可选链会把
 * 「API 没了」静默吞成 undefined，表现是**授权/提问永远不提醒**，既不报错也无迹象。
 * 见 {@link NotifierRuntime#pendingSource}。
 *
 * ## 三条数据源与各自的节奏
 *
 *   - 宿主通知日志：4 秒一次，纯内存读取，很轻；
 *   - 待办交互：事件驱动（订阅），零轮询；
 *   - 余额 / 套餐阈值：30 秒一次，且复用宿主侧已有的 60s / 30s 缓存，
 *     实际外发请求远少于轮询次数。
 *
 * ## 降级不静默
 *
 * 系统通知发不出去（没授权、非安全上下文）时，回落成**页面内提示条**，
 * 而不是丢掉这条提醒。用户关掉了浏览器通知却什么也收不到，会以为功能坏了。
 * @module dsh-pixel-dashboard/client/Notifier
 */

const fetchBalance = m1.fetchBalance
const formatMoney = m1.formatMoney
const AlertLatch = m2.AlertLatch
const SeenTracker = m2.SeenTracker
const balanceAlerts = m2.balanceAlerts
const composeBalanceAlert = m2.composeBalanceAlert
const composeInteraction = m2.composeInteraction
const composeNotice = m2.composeNotice
const composeQuotaAlert = m2.composeQuotaAlert
const conversationOnScreen = m2.conversationOnScreen
const fetchNotices = m2.fetchNotices
const permissionOf = m2.permissionOf
const quotaAlerts = m2.quotaAlerts
const shouldStayQuiet = m2.shouldStayQuiet
const fetchPlans = m3.fetchPlans
/** 宿主日志轮询间隔。日志在宿主内存里，读一次很便宜。 */
const NOTICE_POLL_MS = 4_000

/** 余额 / 套餐阈值检查间隔。宿主侧另有 60s / 30s 缓存，实际外发请求更少。 */
const ALERT_POLL_MS = 30_000

/** 页面内提示条的驻留时长。 */
const TOAST_MS = 9_000

/** 面板里保留的「最近通知」条数。 */
const RECENT_LIMIT = 20

/**
 * 通知状态的**唯一所有者**：面板看到的、运行时据以决策的，都是这里的同一份值。
 *
 * ## 为什么必须「唯一」（这里踩过一次）
 *
 * 早先这里只存一份快照，而 `permission` / `config` 另有一份副本活在运行时里。
 * 后果是两个**看起来无关**的故障同时出现：
 *   1. 面板调 `store.setConfig(...)` → `TypeError: store.setConfig is not a function`
 *      （方法只在运行时上，面板拿不到运行时）；
 *   2. 即使用户在浏览器里点了「允许」，界面仍显示「未授权」——因为运行时在
 *      构造时把 `permission` 读了一次就再没刷新过，而面板显示的是另一份。
 *
 * 根因是同一种：**状态有两个家**。现在只有这一个家，运行时通过它读、也通过它写，
 * 面板订阅它。写入口是下面几个显式方法，谁也不持有副本，于是不可能再对不上。
 *
 * ## 变化检测
 *
 * {@link NotifyStore.prototype.patch} 会比较新旧快照，等价时不发布。日志轮询每
 * 4 秒跑一次，绝大多数轮次什么都没变；若每次都发布，`useSyncExternalStore`
 * 会因为快照引用变化让面板每 4 秒重渲染一次。
 */
class NotifyStore {
  constructor() {
    /** @type {object|undefined} 归一化后的通知配置；undefined = 还没读到。 */
    this.config = undefined
    /** @type {'granted'|'denied'|'default'|'unsupported'} 浏览器通知权限。 */
    this.permission = 'default'
    /** @type {object[]} 最近派发过的通知（新在前）。 */
    this.recent = []
    /** @type {object|undefined} 当前的页面内提示。 */
    this.toast = undefined
    /** @type {string} 最近一次取数失败的原因。 */
    this.error = ''
    /** @type {object[]} 当前待办。 */
    this.pending = []
    /** 是否已经有过一次真实状态（面板据此区分「加载中」与「真的没有」）。 */
    this.ready = false
    this.snapshot = this.#build()
    /** @type {Set<() => void>} */
    this.listeners = new Set()
  }

  /** 由当前字段拼出快照对象。 */
  #build() {
    return {
      ready: this.ready,
      config: this.config,
      permission: this.permission,
      recent: this.recent,
      toast: this.toast,
      error: this.error,
      pending: this.pending,
    }
  }

  /** @returns {object} 当前快照（引用稳定，未变化时是同一个对象）。 */
  getSnapshot() {
    return this.snapshot
  }

  /**
   * 订阅变化。
   * @param {() => void} listener - 回调。
   * @returns {() => void} 退订函数。
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 更新若干字段并（必要时）发布。
   *
   * 只认已知字段：写进来一个没见过的键会被忽略，而不是悄悄进快照——快照的
   * 形状是面板与运行时之间的契约，多一个字段就多一处可能对不上的地方。
   * @param {object} fields - 要更新的字段。
   * @returns {boolean} 是否真的发布了。
   */
  patch(fields) {
    if (fields === null || typeof fields !== 'object') return false
    if (Object.hasOwn(fields, 'config')) this.config = fields.config
    if (Object.hasOwn(fields, 'permission')) this.permission = fields.permission
    if (Object.hasOwn(fields, 'recent')) this.recent = fields.recent
    if (Object.hasOwn(fields, 'toast')) this.toast = fields.toast
    if (Object.hasOwn(fields, 'error')) this.error = fields.error
    if (Object.hasOwn(fields, 'pending')) this.pending = fields.pending
    this.ready = true
    const next = this.#build()
    if (sameSnapshot(this.snapshot, next)) return false
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者抛错不该阻断其余订阅者，更不该让运行时停摆。
      }
    }
    return true
  }

  /**
   * 写入通知配置。
   *
   * 面板保存成功后调它（显示立刻更新），运行时从宿主取到新配置时也调它——
   * 两条路都落在同一个字段上，因此不会出现「面板显示一套、实际按另一套判定」。
   * @param {object} config - 完整配置。
   */
  setConfig(config) {
    this.patch({ config })
  }

  /**
   * 写入浏览器通知权限。
   * @param {'granted'|'denied'|'default'|'unsupported'} permission - 新权限。
   */
  setPermission(permission) {
    this.patch({ permission })
  }

  /** 记一条最近通知（新在前，超限截断）。 */
  pushRecent(entry) {
    this.patch({ recent: [entry, ...this.recent].slice(0, RECENT_LIMIT) })
  }

  /**
   * 发一条测试通知。
   *
   * 这是一条**自证**通道：「通知到底能不能弹」不该靠用户去等一个真实任务跑完来
   * 推测。它走的是与真实提醒完全相同的路径——同一个派发方法、同一段判定逻辑，
   * 因此能弹就说明整条链路通；弹不出来，问题必定在浏览器授权或系统通知设置上。
   *
   * 落进「最近通知」是刻意的：即使系统通知弹不出来（被系统勿扰、被浏览器静默），
   * 面板里也会立刻多一条记录，用户至少能区分「没发出去」与「发出去了但没看见」。
   */
  publishTest() {
    this.onTest?.()
  }

  /**
   * 派发一条通知（内部与测试共用）。
   *
   * 通过 {@link NotifyStore.onFire} 交给运行时去弹——store 自己**不做**任何
   * 与浏览器 API 相关的事，它只是状态。这样「测试通知」与「真实通知」共用同一条
   * 派发路径，不会出现「测试能弹、真实不弹」这种最误导人的不一致。
   * @param {object} spec - 文案。
   */
  publish(spec) {
    this.onFire?.(spec, 'test')
  }

  /**
   * 切到某条会话。
   *
   * 与 {@link NotifyStore.publishTest} 同一个套路：store 只声明「要切过去」这个
   * 意图，真正碰产品的 sessions / layout 服务的动作住在运行时里（那里才有
   * 那两个服务的取值函数）。面板因此不必拿到运行时，也就不必再多一个跨模块单例
   * ——**状态与入口都只有这一个家**（这条约束在本文件顶部已经踩过一次）。
   * @param {string} sessionId - 目标会话 id。
   * @returns {boolean} 是否成功发起。
   */
  openSession(sessionId) {
    return this.onOpenSession?.(sessionId) === true
  }
}

/**
 * 两份快照是否等价（足以跳过重画）。
 *
 * 逐字段比而不是深比：`recent` / `pending` 都是**每次重建的新数组**，深比会
 * 让比较成本随条数增长，而这里只需要认出「内容没变」。数组按长度 + 逐项
 * 引用比较即可——运行时只会推入新对象，绝不会原地改旧对象。
 * @param {object} a - 旧快照。
 * @param {object} b - 新快照。
 * @returns {boolean} 是否等价。
 */
function sameSnapshot(a, b) {
  if (a.ready !== b.ready) return false
  if (a.permission !== b.permission) return false
  if (a.error !== b.error) return false
  if (a.toast !== b.toast) return false
  // 配置用 JSON 比：它是个小对象，且每次都是宿主给的新引用
  if (JSON.stringify(a.config ?? null) !== JSON.stringify(b.config ?? null)) return false
  if (!sameList(a.recent, b.recent)) return false
  if (!sameList(a.pending, b.pending)) return false
  return true
}

/** 两个数组是否逐项同引用。 */
function sameList(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * 模块级单例存储。
 *
 * 运行时与面板分属两个模块（`Notifier.js` / `dashboard.js`），实例不能在
 * 模块间直接传（打包器把它们放在各自的闭包里）。用一个**惰性创建**的单例
 * 让两边拿到同一个对象：谁先用到谁创建，后用到的人拿到同一份。
 *
 * 惰性而不是模块顶层 `new`：模块顶层构造会在**导入**时就执行，而导入发生在
 * 任何环境（包括无 DOM 的渲染闸门）——那时创建一个只有几个字段的对象虽然
 * 无害，但「导入即副作用」是个容易长歪的习惯，这里避开它。
 * @returns {NotifyStore} 单例。
 */
let sharedStore
function notifyStore() {
  sharedStore ??= new NotifyStore()
  return sharedStore
}

/**
 * 通知运行时：轮询、判定、派发。
 *
 * **它不持有任何状态。** 配置、权限、最近通知、待办全部住在 {@link NotifyStore}
 * 里，运行时只是读写那个唯一副本（早先各持一份，导致「点了允许仍显示未授权」
 * 与面板调不到方法这两件事——见 `NotifyStore` 的说明）。
 */
class NotifierRuntime {
  /**
   * @param {object} deps - 依赖。
   * @param {NotifyStore} deps.store - 唯一的状态所有者（面板订阅的同一个对象）。
   * @param {() => object|undefined} deps.uiSession - 客户端 uiSession 服务（可缺）。
   * @param {() => object|undefined} deps.sessions - 客户端 sessions 服务（可缺）。
   * @param {() => object|undefined} deps.layout - 客户端 layout 服务（可缺）；点通知切会话时要用。
   * @param {object} [deps.scope] - 全局对象，测试注入用。
   */
  constructor({ store, uiSession, sessions, layout, scope = globalThis }) {
    this.store = store
    this.uiSession = uiSession
    this.sessions = sessions
    this.layout = layout
    this.scope = scope
    this.seen = new SeenTracker()
    this.latch = new AlertLatch()
    this.timers = []
    this.unsubscribe = undefined
    this.disposed = false
    /** 上一次据以判定预警的配置引用，用于认出「配置变了」。 */
    this.lastConfig = undefined
    /**
     * 订阅 store 的配置变化。
     *
     * 为什么需要：面板保存设置后只改 store（它碰不到运行时的 latch）。若不跟着
     * 重置，用户把阈值从 90 改到 50 时，那些本来处于告警的窗口会被当成「早就
     * 提醒过」而**不再提醒**——改了设置却没反应，是最容易被当成坏了的现象。
     *
     * 回调里只做「比较 + 重置 + 补发待办」，不再写 config，因此不会递归。
     */
    this.storeUnsubscribe = store.subscribe(() => { this.#syncFromStore() })
    // 面板的「发一条测试通知」按钮经由 store 回到这里，于是测试与真实提醒
    // 走的是同一条派发路径（见 NotifyStore.publishTest 的说明）。
    store.onFire = (spec, category) => { this.#fire(spec, category) }
    // 面板里的「最近通知」行经由 store 回到这里：切会话要碰产品服务，
    // 而 store 刻意不持有任何服务取值函数（见 NotifyStore.openSession）。
    store.onOpenSession = (sessionId) => this.openSession(sessionId)
    // 测试通知也尊重总开关：关了总开关还在弹，比不弹更让人困惑。
    //
    // 例外是**配置还没到手**（宿主取数失败、或刚加载）：此时用户是主动点的按钮，
    // 拦下来只会让他以为按钮坏了。他点这一下本来就只是想确认浏览器这一侧通不通，
    // 而这个判断不依赖宿主的配置。
    store.onTest = () => {
      if (this.config !== undefined && this.config.notifyEnabled === false) return
      this.#fire({
        title: '测试通知',
        body: '看到这一条就说明通知链路是通的。',
        tag: 'dsh-pixel-test',
        level: 'ok',
      }, 'test')
    }
    // 权限的初值从浏览器读一次写进 store：面板首帧就该显示真实状态。
    this.store.setPermission(permissionOf(scope))
    this.#syncFromStore()
  }

  /** 认出配置变化并据此重置预警锁存、补发待办。 */
  #syncFromStore() {
    if (this.disposed) return
    const config = this.store.config
    if (config === this.lastConfig) return
    this.lastConfig = config
    this.latch.reset()
    this.#notifyPending()
  }

  /** 当前配置（永远来自 store 这一份）。 */
  get config() {
    return this.store.config
  }

  /**
   * 当前权限：**每次都重新读浏览器**，而不是用缓存值。
   *
   * 用户可以在不经过我们按钮的地方改权限（地址栏站点设置、浏览器设置页），
   * 只认自己写进去的那份会让界面永远停在旧状态——这正是「点了允许还说没授权」
   * 的直接原因之一。
   *
   * 读不到时保留 store 里的值：`unsupported` 是我们自己判定的结果（浏览器根本
   * 没有这个 API），而 `permissionOf` 在那种情况下也会返回 `unsupported`，
   * 两者一致；`denied` 同理。因此只有浏览器给出确定答案时才覆盖。
   */
  get permission() {
    const live = permissionOf(this.scope)
    if (live !== this.store.permission) this.store.setPermission(live)
    return live
  }

  /** 开始工作：装订阅、起定时器、立刻跑一轮。 */
  start() {
    this.#ensurePendingSubscription()
    this.readPending()
    this.pollNotices()
    this.pollAlerts()
    this.timers.push(setInterval(() => {
      this.#ensurePendingSubscription()
      this.pollNotices()
    }, NOTICE_POLL_MS))
    this.timers.push(setInterval(() => { this.pollAlerts() }, ALERT_POLL_MS))
  }

  /**
   * 把浏览器当前的权限写回 store。
   *
   * 每次都真的重新读浏览器，而不是信自己缓存的那份：用户可以**不经过我们的
   * 按钮**改权限（地址栏左侧的站点设置、浏览器设置页）。只认自己写进去的值，
   * 界面就会永远停在旧状态——这正是「点了允许还说没授权」的成因之一。
   * 读取 `permission` 这个 getter 本身就会顺带同步，这里只是给它一个固定的
   * 调用点（每轮轮询一次），让状态在没有任何通知发生时也能刷新。
   */
  syncPermission() {
    void this.permission
  }

  /**
   * 确保已订阅待办交互，必要时补订。
   *
   * 必须能**迟到的补上**：`uiSession` 由 DSH 的另一个插件提供，而我们的 effect
   * 可能在它发布之前就跑起来了（客户端插件之间没有 apply 顺序保证）。只在
   * `start()` 里试一次的做法会以「授权/提问永远不提醒」的形式静默失败——
   * 既没有报错，也没有任何可见迹象。因此每一轮轮询都复查一次，代价只是一次
   * 属性读取。
   */
  #ensurePendingSubscription() {
    if (this.disposed || this.unsubscribe !== undefined) return
    const found = this.#pendingSource()
    if (found === undefined || typeof found.observable.subscribe !== 'function') return
    this.unsubscribe = found.observable.subscribe(() => { this.readPending() })
    this.readPending()
  }

  /**
   * 待办可观察量：**新版走 `sessionStatus`，旧版走 `pendingInteractions`**。
   *
   * DSH 0.1.6-alpha.2 起把待办搬进了 `uiSession.sessionStatus`：那是一张
   * `Map<SessionId, SessionStatus>`，每条含 `running` / `pendingInteraction` /
   * `completionUnread`；原先直接发布待办的 `uiSession.pendingInteractions`
   * （`Map<SessionId, interaction>`）**已被删除**。
   *
   * 为什么两代都认而不是直接改新接口：读不到属性时可选链得到的是 undefined，
   * 那不是「暂时没有待办」，而是「我们与宿主对不上话」——两者在界面上完全一样
   * （都不提醒），只认一代就会在对方那一代上永久静默失效。**先新后旧**，因为新版
   * 是当前契约；旧的只作为还没升上来的宿主回落。
   * @returns {{observable:object,read:(snapshot:object)=>Array<object>}|undefined} 可观察量与读数方式。
   */
  #pendingSource() {
    const session = this.uiSession?.()
    if (session === null || session === undefined) return undefined
    // 新版：值是一层 SessionStatus，待办在它的 pendingInteraction 上
    const status = session.sessionStatus
    if (status !== undefined && status !== null && typeof status.getSnapshot === 'function') {
      return {
        observable: status,
        read: (snapshot) => {
          const out = []
          snapshot.forEach((value, key) => {
            const interaction = value?.pendingInteraction
            if (interaction === undefined || interaction === null) return
            // 会话 id 以状态表的键为准：它是这份数据的权威来源。待办自身若已带上
            // 同名字段就原样保留（正常情况两者相同），缺失时才补，避免出现
            // 「通知点了切不到会话」——那正是这条提醒存在的意义。
            out.push(typeof interaction.sessionId === 'string' && interaction.sessionId !== ''
              ? interaction
              : { ...interaction, sessionId: String(key) })
          })
          return out
        },
      }
    }
    // 旧版：值**就是**那条待办
    const legacy = session.pendingInteractions
    if (legacy !== undefined && legacy !== null && typeof legacy.getSnapshot === 'function') {
      return {
        observable: legacy,
        read: (snapshot) => {
          const out = []
          snapshot.forEach((interaction) => {
            if (interaction !== undefined && interaction !== null) out.push(interaction)
          })
          return out
        },
      }
    }
    return undefined
  }

  /** 停止工作。插件卸载时调用，必须能把所有定时器与订阅都撤掉。 */
  dispose() {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.storeUnsubscribe?.()
    this.storeUnsubscribe = undefined
  }

  /**
   * 当前的待办列表（写进 store，并派发尚未提醒过的那些）。
   */
  readPending() {
    const found = this.#pendingSource()
    const snapshot = found?.observable.getSnapshot?.()
    const list = snapshot !== undefined && typeof snapshot.forEach === 'function'
      ? found.read(snapshot)
      : []
    this.store.patch({ pending: list })
    this.#notifyPending()
  }

  /**
   * 把尚未提醒过的待办派发出去。
   *
   * 与 {@link readPending} 分开，是因为**配置可能后到**：首轮 `readPending()` 跑在
   * `pollNotices()` 拿到配置之前，此时 `#enabled` 一律为 false（「还没读到设置」
   * 不等于「用户全开着」），于是那批待办不会被派发。若就此不管，一个**在页面加载
   * 时就已存在**的授权请求会永远不提醒——直到用户回答别的东西把它顶掉。
   * 因此配置一到手就再试一次；{@link SeenTracker} 保证这里不会重复提醒。
   */
  #notifyPending() {
    if (!this.#enabled('notifyInteraction')) return
    for (const item of this.seen.takeInteractions(this.store.pending)) {
      this.#fire(composeInteraction(item), 'interaction')
    }
  }

  /**
   * 读宿主通知日志并派发新记录。
   * @returns {Promise<void>} 完成。
   */
  async pollNotices() {
    if (this.disposed) return
    // 每轮顺带同步一次权限：用户可能在浏览器站点设置里改过它。
    this.syncPermission()
    try {
      const payload = await fetchNotices({ since: this.seen.cursor })
      if (this.disposed) return
      // 配置随每次读取一起回来：面板在别的标签页改了设置，这边下一轮就同步。
      if (payload?.config !== undefined) this.store.setConfig(payload.config)
      this.store.patch({ error: '' })
      // 配置刚到（或刚被打开）时补发一次待办提醒：首轮 readPending 跑在配置之前，
      // 那时一律按「未启用」跳过（见 #notifyPending）。
      this.#notifyPending()
      const { fresh, dropped } = this.seen.takeNotices(payload)
      if (dropped) {
        this.#push({
          title: '有通知在断连期间丢失',
          body: '浏览器与宿主断开了一段时间，期间的提醒已被裁剪。',
          tag: 'dsh-pixel-dropped',
          level: 'warn',
        }, 'system')
      }
      for (const notice of fresh) {
        if (!this.#enabled(notice.category === 'done' ? 'notifyDone' : 'notifyError')) continue
        if (this.#quiet(notice)) {
          this.#noteQuiet(notice)
          continue
        }
        this.#fire(composeNotice(notice), notice.category)
      }
    } catch (error) {
      // 取数失败保留上一次的最近通知，只记错误——把已显示的提醒擦掉只会让人困惑
      this.store.patch({ error: String(error?.message ?? error) })
    }
  }

  /**
   * 检查余额与套餐阈值。
   * @returns {Promise<void>} 完成。
   */
  async pollAlerts() {
    if (this.disposed) return
    const config = this.config ?? {}
    const wantsBalance = this.#enabled('notifyBalance')
      && Object.keys(config.warnBalance ?? {}).length > 0
    const wantsQuota = this.#enabled('notifyQuota') && Number(config.warnQuotaPercent) > 0
    try {
      if (wantsBalance) {
        const payload = await fetchBalance({})
        if (this.disposed) return
        const alerts = balanceAlerts(payload, config.warnBalance)
        const fresh = this.latch.update(alerts.map((item) => `balance:${item.currency}`))
        const keys = new Set(fresh)
        const hit = alerts.filter((item) => keys.has(`balance:${item.currency}`))
        if (hit.length > 0) this.#fire(composeBalanceAlert(hit, formatMoney), 'balance')
      } else {
        this.latch.update([])
      }
      if (wantsQuota) {
        const payload = await fetchPlans({})
        if (this.disposed) return
        const alerts = quotaAlerts(payload, config.warnQuotaPercent)
        const fresh = this.latch.update(alerts.map((item) => `quota:${item.provider}:${item.window}`))
        const keys = new Set(fresh)
        const hit = alerts.filter((item) => keys.has(`quota:${item.provider}:${item.window}`))
        if (hit.length > 0) this.#fire(composeQuotaAlert(hit), 'quota')
      }
      if (!wantsBalance && !wantsQuota) this.latch.reset()
    } catch (error) {
      // 余额/额度取不到不是「预警」的失败，只是这一轮没有数据可判；
      // 但也不能静默——面板里会显示最近一次的错误。
      this.store.patch({ error: String(error?.message ?? error) })
    }
  }

  /** 某个开关是否打开（总开关优先）。 */
  #enabled(key) {
    const config = this.config
    if (config === undefined) return false
    if (config.notifyEnabled === false) return false
    return config[key] !== false
  }

  /**
   * 这条会话结束通知是否应当**不打扰**。
   *
   * 判据是「页面正被看着」且「就是当前选中的会话」且「那条会话的界面确实在屏幕上」。
   * 只判焦点会漏掉「浏览器开着、正在看别的会话」；只判会话会漏掉「切到别的标签页
   * 干别的事」。
   *
   * 第三条（界面在屏幕上）原先漏了，而那正是用户报的**漏提醒**：`list.current`
   * 是**持久化的选中项**，不是「屏幕上是什么」。主区停在「用量看板」这类全局面板
   * 上时会话界面整个不挂载，`current` 却仍停在上次那条会话上，于是那条会话完成
   * 时提醒被静默吞掉。判定细节与「判不出来就不静默」的理由见
   * {@link shouldStayQuiet} / {@link conversationOnScreen}。
   * @param {object} notice - 宿主通知记录。
   * @returns {boolean} 是否跳过。
   */
  #quiet(notice) {
    return shouldStayQuiet(notice, {
      config: this.config,
      focused: this.scope?.document?.hasFocus?.() === true,
      current: this.sessions?.()?.list?.getSnapshot?.()?.current,
      onScreen: conversationOnScreen(this.scope?.document),
    })
  }

  /**
   * 记下一条**被刻意静默**的提醒。
   *
   * 静默不等于「当它没发生」。用户报的正是「漏了很多通知」——而一条**悄悄消失**
   * 的提醒与一条**从未产生**的提醒在界面上完全一样，用户无从判断是功能坏了还是
   * 本来就没有。因此被静默的提醒照样落进「最近通知」，只是不带系统通知、也不弹
   * 页面内提示条（那两样正是「不打扰」要避免的）。
   *
   * 这条记录本身就是「降级不静默」那条口径的落点：任何时候少了一条弹窗，用户都能
   * 在面板里看到它、知道它为什么没弹。
   * @param {object} notice - 宿主通知记录。
   */
  #noteQuiet(notice) {
    const spec = composeNotice(notice)
    this.store.pushRecent({
      at: Date.now(),
      category: 'quiet',
      ...spec,
      // 面板据此把这行标成「静默」，而不是让用户以为它本该弹却没弹。
      quiet: true,
    })
  }

  /**
   * 切换界面到某条会话。
   *
   * ## 为什么要点通知就切过去
   *
   * 「你的任务失败了」「有授权在等你」这类提醒，价值全在**接下来那一眼**。
   * 点开通知却停在原处，用户还得自己去侧栏里找出是哪条会话——提醒等于只做了
   * 一半。所以点通知直接切到它说的那条会话。
   *
   * ## 两个动作，缺一不可
   *
   *   1) `sessions.open(id)` —— 选中那条会话；
   *   2) `layout.selectPanel(null)` —— **退出主区面板**。
   *
   * 第 2 步最容易漏，也最要命：用户很可能正停在「用量看板」这类主区面板上，
   * 那时只调 `open()` 只是把选中项改了，主区**仍然显示着面板**——看起来就是
   * 「点了没反应」。必须同时把面板关掉，会话界面才会真的露出来。
   *
   * ## 失败一律安静
   *
   * `open()` 对列表里不存在的 id 会抛错（会话可能已经被删了，或者它属于另一台
   * 机器——账本里那些记录就没有本机会话）。点通知是**附加**功能，绝不能因为
   * 一条陈旧的通知把运行时的轮询打断。
   * @param {string} sessionId - 目标会话 id。
   * @returns {boolean} 是否真的切过去了。
   */
  openSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return false
    let opened = false
    try {
      const sessions = this.sessions?.()
      if (sessions !== undefined && typeof sessions.open === 'function') {
        sessions.open(id)
        opened = true
      }
    } catch {
      // 会话不在列表里（已删除 / 属于别的机器）：保持安静，见方法说明。
    }
    // 即使 open 失败也把面板关掉：用户点的是「去看这条会话」，留在面板上更没意义。
    try {
      const layout = this.layout?.()
      if (layout !== undefined && typeof layout.selectPanel === 'function') {
        layout.selectPanel(null)
      }
    } catch {
      // 面板服务缺失 / 主区面板未注册：不阻断会话本身的切换。
    }
    return opened
  }

  /**
   * 派发一条通知：系统通知优先，不可用时回落页面内提示条。
   * @param {object} spec - 文案（可带 sessionId）。
   * @param {string} category - 类别（面板展示与统计用）。
   */
  #fire(spec, category) {
    this.#push(spec, category)
    if (this.permission !== 'granted') return
    const Notification = this.scope?.Notification
    if (typeof Notification !== 'function') return
    try {
      // tag 让同一条会话/同一条预警的新通知**替换**旧的那条，
      // 而不是在通知中心堆成一列——预警持续期间尤其明显。
      const notification = new Notification(spec.title, { body: spec.body, tag: spec.tag })
      // 点通知切到那条会话。只在**确实带着会话 id** 时挂这个回调：
      // 余额 / 套餐阈值那类预警不属于任何会话，点它切会话是无意义的动作。
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : ''
      if (sessionId !== '') {
        notification.onclick = () => {
          try {
            // 先把系统通知收掉，再切界面：否则通知中心里会留着一条已经处理过的提醒。
            notification.close?.()
            // 把窗口拉到前台——**这一步是尽力而为，不是保证**。
            //
            // 按规范 `window.focus()` 只是一次「请求」：MDN 明确写着它可能因用户
            // 设置而失败，返回前也不保证窗口已在最前。浏览器普遍拒绝脚本改窗口
            // z 序（防广告骚扰），Firefox 基本直接忽略，Chrome 也只在部分条件下认。
            //
            // 可靠把窗口拉到前台的是 **Service Worker 的 notificationclick**
            // （`clients.openWindow()` / `client.focus()`），但那是另一条通知通道，
            // 而 DSH 的 Web 端没有注册 Service Worker（见 AGENT.md）。
            // 因此这里照常调用（有环境会生效），但绝不假设它成功。
            this.scope?.focus?.()
            // 即使拉不到前台，**切会话这件事仍会完成**：用户手动切回窗口时，
            // 看到的已经是那条会话。这是当前技术条件下能做到的部分。
            this.openSession(sessionId)
          } catch {
            // 切界面失败不影响这条通知已经送达的事实。
          }
        }
      }
    } catch {
      // 某些环境（如未授权的 Worker、非安全上下文）构造会抛错：已经落进
      // 最近通知与页面内提示了，这里不再重复报错。
    }
  }

  /** 记一条派发记录，并刷新页面内提示。 */
  #push(spec, category) {
    const entry = { at: Date.now(), category, ...spec }
    this.store.pushRecent(entry)
    // 系统通知不可用时，页面内提示条是**唯一**的可见通道，必须亮出来。
    // 可用时不再叠加：系统通知已经弹过一次，页面里再来一条是重复打扰。
    if (this.permission !== 'granted') this.#showToast(entry)
  }

  /** 显示页面内提示条（自动消失）。 */
  #showToast(entry) {
    this.store.patch({ toast: entry })
    this.#renderToast()
    const timer = setTimeout(() => {
      if (this.store.toast === entry) {
        this.store.patch({ toast: undefined })
        this.#renderToast()
      }
    }, TOAST_MS)
    this.timers.push(timer)
  }

  /**
   * 把提示条画进 DOM。
   *
   * 直接建 DOM 而**不是**注册一个槽位组件：提示条必须在任何界面状态下都能出现
   * （包括用户正停在设置页、或主区根本没挂看板的时候），而槽位只在它所处的
   * 区域被渲染时才存在。用 DOM 也免掉了「组件没挂载 → 提醒静默消失」这种
   * 最难查的失败形态。样式复用全局挂上的 `.px-toast-*`（见 theme.js）。
   *
   * 全程可选链：渲染闸门与任何无 DOM 环境（SSR、测试）都必须在没有
   * `document` 时安静跳过，而不是抛错拖垮整个插件。
   */
  #renderToast() {
    const doc = this.scope?.document
    if (doc?.body === undefined || doc.body === null) return
    try {
      let host = doc.getElementById?.('px-toast-host')
      if (host === null || host === undefined) {
        host = doc.createElement('div')
        host.id = 'px-toast-host'
        host.className = 'px-toast-host'
        doc.body.appendChild(host)
      }
      host.textContent = ''
      const entry = this.store.toast
      if (entry === undefined) return
      const box = doc.createElement('div')
      box.className = `px-toast px-toast-${entry.level ?? 'ok'}`
      const title = doc.createElement('b')
      title.className = 'px-toast-title'
      title.textContent = String(entry.title ?? '')
      const body = doc.createElement('span')
      body.className = 'px-toast-body'
      body.textContent = String(entry.body ?? '')
      box.appendChild(title)
      box.appendChild(body)
      // 带会话 id 的提示条也**可点**：系统通知不可用时提示条是唯一通道，
      // 而「点一下就能跳过去」这件事不该只在系统通知那条路上有。
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : ''
      if (sessionId !== '') {
        box.classList.add('px-toast-clickable')
        box.addEventListener('click', () => {
          this.dismissToast()
          this.openSession(sessionId)
        })
      }
      host.appendChild(box)
    } catch {
      // 提示条是附加通道：画不出来不影响系统通知与「最近通知」列表。
    }
  }

  /** 由界面关闭提示条。 */
  dismissToast() {
    this.store.patch({ toast: undefined })
    this.#renderToast()
  }
}

/**
 * 装好通知运行时并挂到插件 fiber 上。
 *
 * 外层再套一个 try/catch：通知是**附加**功能，它坏掉不该让整个插件（包括
 * 看板与主题）一起失效。这与余额 / 套餐的 fail-soft 口径一致。
 * @param {object} ctx - 客户端 Cordis 上下文。
 * @param {NotifyStore} store - 状态所有者；**必须**与面板用的是同一个（见 notifyStore()）。
 * @returns {NotifierRuntime|undefined} 运行时；环境不支持时 undefined。
 */
function installNotifier(ctx, store) {
  try {
    const runtime = new NotifierRuntime({
      store,
      uiSession: () => ctx.get('uiSession'),
      sessions: () => ctx.get('sessions'),
      // layout 只在「点通知切会话」时用到；它可能缺失（旧宿主 / 服务未就绪），
      // 那时会话仍会切换，只是不再额外退出主区面板。
      layout: () => ctx.get('layout'),
    })
    // 先标记 ready：面板不该先渲染一屏空白再等第一轮轮询（最坏 4 秒）。
    // 配置仍是 undefined（运行时拿到宿主回应后才填），面板会用自带默认值兜底。
    store.patch({})
    ctx.effect(() => {
      runtime.start()
      return () => { runtime.dispose() }
    }, 'pixel-dashboard: 通知运行时')
    return runtime
  } catch (error) {
    console.warn('[dsh-pixel-dashboard] 通知运行时未能启动：', error)
    return undefined
  }
}

			exports.NotifyStore = NotifyStore
			exports.notifyStore = notifyStore
			exports.NotifierRuntime = NotifierRuntime
			exports.installNotifier = installNotifier
		},
		"./SessionCost.js": (exports, require) => {
			const m1 = require("./account.js")
			const m2 = require("./balance.js")
			const m3 = require("./format.js")
			const m4 = require("./plans.js")
			const m5 = require("./planView.js")
			const m6 = require("./usage.js")
			/**
 * 输入框下方的本次会话费用条（含账户余额与套餐额度）。
 *
 * ## 布局（v2.1 起改为并入产品统计行）
 *
 * 产品自己有一条统计行 `StatsPills`（显示「N 轮 · M 步 · 缓存命中 X%」），它注册在
 * `conversation.composer.dock`（order 0），并且会给根元素打上 `data-composer-stats`。
 *
 * 早先本插件另起一行渲染自己的胶囊，结果是**脱离输入框**漂在外面，与产品统计行
 * 各占一行、观感零散（用户截图反馈过）。现在默认把这些徽标 **portal 进产品那个
 * 容器**，于是与「缓存命中」并排在同一行、共用同一套对齐规则。
 *
 * 三条实现要点：
 *   1) **等锚点出现。** React 的挂载顺序不保证：产品统计行可能比我们晚渲染。
 *      因此用 MutationObserver 观察 `body`，锚点一出现就 portal 过去。
 *   2) **产品统计行会整体消失。** 没有 token 活动时 `StatsPills` 返回 null，
 *      `data-composer-stats` 随之不在。此时退回自渲染一行（`.px-cost-row`），
 *      而不是让信息凭空消失。
 *   3) **合并时不再重复 token 数。** 那一行本身已经在显示 token，我们只补费用、
 *      余额、套餐额度；退回自渲染时才把 token 数带上。
 *
 * 数据来源分三条路，各司其职、互不拖垮：
 *   - 会话投影 `tokenUsage` 给出即时可见的 token 总数（本地、零延迟）；
 *   - 宿主数据里该会话的 `cost` 给出**精确**金额（按每条请求发生时段分档计价）；
 *   - 余额与套餐各有自己的开关与缓存。
 * @module dsh-pixel-dashboard/client/SessionCost
 */

const React = require('react')
const createPortal = require('react-dom').createPortal
const resolveAccount = m1.resolveAccount
const fetchBalance = m2.fetchBalance
const formatCny = m3.formatCny
const formatTokens = m3.formatTokens
const fetchPlans = m4.fetchPlans
const useSelectedPlan = m5.useSelectedPlan
const fetchDashboard = m6.fetchDashboard
const { createElement: h, useEffect, useMemo, useState } = React

/** 费用条在下方常驻区的位置。 */
const COST_ENTRY_ID = 'pixel-cost'

/**
 * 在 `conversation.composer.dock` 里的排序值。
 *
 * 该槽位**升序**渲染，产品统计条在 `order: 0`。用负值把我们的兜底行压在
 * 输入框与产品统计条之间（合并成功后这一行通常不渲染）。
 */
const COST_ENTRY_ORDER = -10

/**
 * 产品统计行的锚点选择器。
 *
 * `StatsPills` 给根元素打 `data-composer-stats`（产品 CSS 也靠它收紧输入框底边距），
 * 这是**产品自己的公开标记**，不是内部类名，因此比按类名猜测稳。
 */
const STATS_ANCHOR_SELECTOR = '[data-composer-stats]'

/** 刷新间隔：宿主快照本身有缓存，这里只是保持数值不过时。 */
const REFRESH_MS = 30_000

/**
 * 从投影结果里安全取出总量，兼容取到投影值或整条快照两种形态。
 * @param {object} projection - useProjection 的返回值。
 * @returns {object|undefined} 用量总量。
 */
function totalsOf(projection) {
  if (projection === null || typeof projection !== 'object') return undefined
  const value = projection.val ?? projection
  const totals = value?.totals ?? value
  if (totals === null || typeof totals !== 'object') return undefined
  return totals
}

/**
 * 由投影总量算出计费 token 总数（缓存命中 + 未命中 + 写入 + 输出）。
 * @param {object|undefined} totals - 投影里的总量。
 * @returns {number|undefined} token 数；拿不到时为 undefined。
 */
function billedTokens(totals) {
  if (totals === undefined) return undefined
  return Number(totals.uncachedInputTokens ?? 0)
    + Number(totals.outputTokens ?? 0)
    + Number(totals.cacheReadTokens ?? 0)
    + Number(totals.cacheWriteTokens ?? 0)
}

/**
 * 挑出这个会话用到、但**不在价目表里**的模型。
 *
 * 为什么要它：金额永远是宿主按定价表算出来的，而价目表里没有的模型会走 Flash
 * 兜底单价。看板费用明细会把它们标成「估算价」，费用条那一枚却只给一个数字——
 * 同一笔钱在同一个页面上有两种说法。这里把同一个事实带过来，让两边口径一致。
 *
 * 判据取自宿主 `models[].priced`（它由 `pricingOf()` 的可信度字段派生），
 * 而不是在这里重新猜一遍单价表。
 * @param {object|undefined} row - 宿主返回的该会话行。
 * @param {object[]|undefined} models - 宿主的模型清单（含 `priced`）。
 * @returns {string[]} 不在价目表里的模型名；没有时是空数组。
 */
function unpricedModelsOf(row, models) {
  const used = Array.isArray(row?.models) ? row.models : []
  if (used.length === 0) return []
  const priced = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    // 条目身份是 `模型@提供商`（见宿主 CAPABILITIES 的 modelProvider）；
    // 旧宿主没有 key，只有 model，两种都认。
    const key = typeof model?.key === 'string' ? model.key : model?.model
    if (typeof key === 'string') priced.set(key, model.priced !== false)
  }
  // 宿主没给这个模型的条目时**不**标估算：那说明我们并不知道，而不是知道它没价。
  return used.filter((name) => priced.get(name) === false)
}

/**
 * 观察产品统计行是否存在。
 *
 * 必须观察 DOM 而不是只查一次：产品统计行与我们由不同的 fiber 挂载，先后不定；
 * 且它会在「没有 token 活动」时整体卸载，之后再回来。
 * @returns {Element|null} 锚点元素，未出现时为 null。
 */
function useStatsAnchor() {
  const [anchor, setAnchor] = useState(null)

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined
    const find = () => document.querySelector(STATS_ANCHOR_SELECTOR)
    setAnchor(find())

    if (typeof MutationObserver === 'undefined' || document.body === null || document.body === undefined) {
      return undefined
    }
    const observer = new MutationObserver(() => {
      const next = find()
      // 用函数式更新比较，避免每次 DOM 变动都触发一次重渲染
      setAnchor((prev) => (prev === next ? prev : next))
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  return anchor
}

/**
 * 一枚徽标：图标点 + 标签 + 数值 + 可选角标。视觉对齐产品的统计胶囊（13px、
 * tertiary 文字、24px 圆角、悬停微微加深），因此并排时不显得是「外来的」。
 * @param {object} props - tone / label / value / title / warn / tag。
 * @returns {object} React 元素。
 */
function Pill(props) {
  const { tone, label, value, title, warn, tag } = props
  return h(
    'span',
    {
      className: `px-pill${warn === true ? ' px-pill-warn' : ''}`,
      title: title,
    },
    h('i', { className: `px-pill-dot${tone === undefined ? '' : ` px-tone-bg-${tone}`}` }),
    label === undefined ? null : h('span', { className: 'px-pill-label' }, label),
    h('b', { className: 'px-pill-value' }, value),
    // 角标：用来点明「这个数字是怎么来的」（如「估算」），只写进 title 是不够的
    // ——悬停提示在用户不主动悬停时等于不存在。
    tag === undefined ? null : h('span', { className: 'px-pill-tag' }, tag),
  )
}

/**
 * 徽标组：本次会话费用（+ 可选 token）、以及**按当前模型来源绑定**的那一份
 * 账户事实（官方余额或某家套餐的最紧窗口）。
 *
 * 纯展示，无取数、无副作用；容器决定把它 portal 到产品统计行还是自渲染一行。
 *
 * ## 两件事刻意分开
 *
 *   - **本次会话消费**永远显示（这正是用户要求的：它是一条与「用谁的钱」无关的
 *     事实），金额按定价表分档折算。宿主给不出时才显示「费用不可用」。
 *   - **账户那一枚**由 {@link resolveAccount} 按 provider 来源挑，只有一个，
 *     不再是余额与套餐并排。挑不出来就不渲染，而不是硬塞一个无关的数字。
 * @param {object} props - cost / tokens / failed / account / showTokens / unpriced。
 * @returns {object|null} React 元素。
 */
function SessionCostPills(props) {
  const { cost, tokens, failed, account, showTokens = true, unpriced } = props

  // 什么都没拿到、也不是失败：不渲染空壳。
  // 必须返回 null 而不是空元素：容器没有 gap，空元素会污染产品的间距节奏。
  if (cost === undefined && failed !== true && account === undefined
    && (tokens === undefined || tokens === 0)) return null

  const detail = cost === undefined
    ? (failed === true ? '宿主未提供该会话的费用数据' : '正在按分档单价折算')
    : `高峰 ${formatCny(cost.peak ?? 0)} · 空闲 ${formatCny(cost.idle ?? 0)}`
  const accountDetail = accountDetailOf(account)
  // 「缺少计算公式」这件事必须说出来：那个模型不在价目表里，金额是**按 Flash
  // 单价估的**，跟看板费用明细里标的「估算价」是同一件事。
  const unpricedList = Array.isArray(unpriced) ? unpriced.filter((name) => name !== '') : []
  const unpricedDetail = unpricedList.length === 0
    ? ''
    : `｜注意：${unpricedList.join('、')} 不在价目表里，暂按 Flash 单价估算`

  return h(
    React.Fragment,
    null,
    h(Pill, {
      tone: failed === true ? 'red' : 'pink',
      label: '本次会话',
      value: cost === undefined
        ? (failed === true ? '费用不可用' : '折算中…')
        : formatCny(cost.standard),
      warn: failed === true,
      tag: unpricedList.length === 0 ? undefined : '估算',
      // 与看板「费用明细」同一口径：这是「全走官方 API 要多少钱」的假设，
      // 不是实际账单。不说死「DeepSeek 官方」——价目表里也有智谱 GLM 的行。
      title: `${detail}${accountDetail}${unpricedDetail}｜按各模型官方单价估算`
        + `（即“这些 token 若全部走官方 API 需要花多少钱”）；`
        + `第三方中转与 Coding Plan 是买断制、不按 token 计费，不在此列`,
    }),
    showTokens && tokens !== undefined && tokens > 0
      ? h(Pill, { tone: 'blue', value: `${formatTokens(tokens)} tokens` })
      : null,
    h(AccountPill, { account }),
  )
}

/**
 * 账户事实 → 徽标悬停说明里补充的那一句。
 * @param {object|undefined} account - {@link resolveAccount} 的结果。
 * @returns {string} 形如 `｜账户余额 ¥12.34`；没有时是空串。
 */
function accountDetailOf(account) {
  if (account === undefined) return ''
  if (account.kind === 'balance') return `｜账户余额 ${account.text}`
  if (account.kind === 'plan') return `｜${account.label} ${account.plan.window.label}已用 ${account.plan.percent.toFixed(1)}%`
  if (account.kind === 'unavailable') return `｜${account.label} 不可用`
  return ''
}

/**
 * 那一枚账户徽标：按来源不同渲染成余额或套餐窗口。
 * @param {object} props - account。
 * @returns {object|null} React 元素。
 */
function AccountPill(props) {
  const { account } = props
  if (account === undefined || account === null) return null

  if (account.kind === 'balance') {
    return h(Pill, {
      tone: 'green',
      label: '余额',
      value: account.text,
      title: '账户余额来自官方 /user/balance 接口，由本地宿主用 DSH 自己的 API Key 查询；'
        + `Key 不会离开本机${account.payload?.official === false ? '（当前端点不是官方公网地址）' : ''}`
        + '。当前会话走的是 DeepSeek 官方 API，因此显示它。',
    })
  }

  if (account.kind === 'plan') {
    const { plan } = account
    const percent = plan.percent
    return h(Pill, {
      // 超过 75% 转警戒色，与看板里的阈值保持一致
      tone: percent >= 75 || plan.window.exceeded === true ? 'red' : 'purple',
      label: account.label,
      value: `${percent.toFixed(0)}%`,
      title: `${account.fullLabel ?? account.label} · ${plan.window.label}额度已用 ${percent.toFixed(1)}%`
        + `｜来自厂商内部接口，仅供参照｜当前会话走的是这一家，因此显示它`
        + (account.source === 'selected' ? '（你在看板上手动指定了监看这一家）' : ''),
    })
  }

  if (account.kind === 'unavailable') {
    // 拿不到就说出来。静默不渲染会让人以为是插件坏了。
    return h(Pill, {
      tone: 'red',
      label: account.label,
      value: '不可用',
      warn: true,
      title: `${account.reason ?? '暂时取不到数据'}｜这一枚是按当前模型来源绑定的，切换模型或修好凭据后会自动恢复`,
    })
  }

  return null
}

/**
 * 兜底的一行（产品统计行不在时使用）。
 *
 * `conversation.composer.dock` 的容器是纵向 flex + `align-items: center` 且**没有 gap**，
 * 所以必须自己撑满宽度、并自带上边距，否则会收缩居中并贴住输入框。
 * @param {object} props - 同 {@link SessionCostPills}。
 * @returns {object|null} React 元素。
 */
function SessionCostView(props) {
  const { cost, failed, account, tokens } = props
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一行」
  if (cost === undefined && failed !== true && account === undefined
    && (tokens === undefined || tokens === 0)) return null

  return h('div', { className: 'px-cost-row' }, h(SessionCostPills, props))
}

/**
 * 容器：取该会话的费用、余额与套餐额度，按当前模型来源挑出该显示的那一枚，
 * 并决定渲染位置。
 *
 * 取数三条路各取各的（会话费用 / 余额 / 套餐），任一坏掉都不该拖垮另外两个。
 * 模型来源走的是 DSH 自己的 `modelSelection` 投影，**不额外发请求**。
 * @param {object} props - 插槽提供的标准属性（含 sessionId 与 useProjection）。
 * @returns {object|null} React 元素。
 */
function SessionCost(props) {
  const sessionId = props.sessionId
  const [state, setState] = useState({
    cost: undefined, failed: false, balance: undefined, plans: undefined, unpriced: [],
  })
  const anchor = useStatsAnchor()
  // 用户在看板上手动指定的「当前监看的套餐」（undefined = 自动）。
  const selectedPlan = useSelectedPlan()

  useEffect(() => {
    if (sessionId === undefined) return undefined
    let cancelled = false
    const load = (refresh) => {
      // 三条路各取各的：任一坏掉都不该拖垮另外两个。
      fetchDashboard({ refresh })
        .then((data) => {
          if (cancelled) return
          const row = (data.sessions ?? []).find((item) => item.id === sessionId)
          // 会话在、但没带 cost：宿主是旧实现。标成失败，不要继续转圈。
          setState((prev) => ({
            ...prev,
            cost: row?.cost,
            failed: row !== undefined && row.cost === undefined,
            // 这个会话用到的模型里，哪些不在价目表里？金额仍是宿主按 Flash 兜底
            // 单价算的，界面上要标成「估算」——与看板费用明细的口径一致。
            unpriced: unpricedModelsOf(row, data.models),
          }))
        })
        .catch(() => {
          // 取数失败（宿主没起来 / 请求出错）也要明说，不静默停在「折算中」
          if (!cancelled) setState((prev) => ({ ...prev, cost: undefined, failed: true, unpriced: [] }))
        })
      fetchBalance({ refresh })
        .then((payload) => {
          if (!cancelled) setState((prev) => ({ ...prev, balance: payload }))
        })
        .catch(() => {
          if (!cancelled) setState((prev) => ({ ...prev, balance: undefined }))
        })
      fetchPlans({ refresh })
        .then((payload) => {
          if (!cancelled) setState((prev) => ({ ...prev, plans: payload }))
        })
        .catch(() => {
          if (!cancelled) setState((prev) => ({ ...prev, plans: undefined }))
        })
    }
    load(false)
    const handle = setInterval(() => { load(true) }, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [sessionId])

  const usage = props.useProjection?.('tokenUsage')
  // 当前会话正在用的模型路由（DSH 逐请求记录的事实）。拿不到时 resolveAccount
  // 会走回落链，而不是随便挑一个账户显示。
  const selection = props.useProjection?.('modelSelection')
  const totals = useMemo(() => totalsOf(usage), [usage])

  const account = useMemo(
    () => resolveAccount({ selection, balance: state.balance, plans: state.plans, selectedPlan }),
    [selection, state.balance, state.plans, selectedPlan],
  )

  if (sessionId === undefined) return null

  const pills = h(SessionCostPills, {
    cost: state.cost,
    failed: state.failed,
    account,
    unpriced: state.unpriced,
    // 并入产品统计行时不再重复 token 数——那一行本身已经在显示它
    showTokens: anchor === null,
    tokens: billedTokens(totals),
  })

  // 锚点在：并入产品统计行（与「缓存命中」同一行、同一套对齐）
  if (anchor !== null && typeof createPortal === 'function') {
    return createPortal(h('span', { className: 'px-pill-group' }, pills), anchor)
  }
  // 锚点不在（产品统计行未挂载 / 无 token 活动 / 无 DOM）：退回自渲染一行
  return h('div', { className: 'px-cost-row' }, pills)
}

			exports.COST_ENTRY_ID = COST_ENTRY_ID
			exports.COST_ENTRY_ORDER = COST_ENTRY_ORDER
			exports.STATS_ANCHOR_SELECTOR = STATS_ANCHOR_SELECTOR
			exports.totalsOf = totalsOf
			exports.billedTokens = billedTokens
			exports.unpricedModelsOf = unpricedModelsOf
			exports.SessionCostPills = SessionCostPills
			exports.SessionCostView = SessionCostView
			exports.SessionCost = SessionCost
		},
		"./dashboard.js": (exports, require) => {
			const m1 = require("./balance.js")
			const m2 = require("./Notifier.js")
			const m3 = require("./notify.js")
			const m4 = require("./plans.js")
			const m5 = require("./planView.js")
			const m6 = require("./provider.js")
			const m7 = require("./format.js")
			const m8 = require("./graph.js")
			const m9 = require("./usage.js")
			const m10 = require("./rates.js")
			/**
 * 用量看板主体：总览指标、时段状态与倒计时、活跃日历、Token 趋势、
 * 模型分布、费用估算与会话清单。只读投影，不修改任何会话状态。
 *
 * 计费口径与官方一致：高峰（周一至周五 9:00–12:00、14:00–18:00）与空闲
 * 时段分别按各自单价计价，空闲价为高峰价的一半；历史用量按每条请求
 * 实际发生的时段归档，因此费用不是用一个折扣近似出来的。
 * @module dsh-pixel-dashboard/client/dashboard
 */

const React = require('react')
const balanceAvailable = m1.balanceAvailable
const balanceStatus = m1.balanceStatus
const fetchBalance = m1.fetchBalance
const formatMoney = m1.formatMoney
const setToggle = m1.setToggle
const notifyStore = m2.notifyStore
const NOTIFY_DEFAULTS = m3.NOTIFY_DEFAULTS
const NOTIFY_FLAGS = m3.NOTIFY_FLAGS
const PERMISSION_TEXT = m3.PERMISSION_TEXT
const balanceAlerts = m3.balanceAlerts
const composeRecentLine = m3.composeRecentLine
const permissionOf = m3.permissionOf
const quotaAlerts = m3.quotaAlerts
const requestPermission = m3.requestPermission
const saveNotify = m3.saveNotify
const fetchPlans = m4.fetchPlans
const formatResetLine = m4.formatResetLine
const partitionProviders = m4.partitionProviders
const providerChoices = m4.providerChoices
const providerStatus = m4.providerStatus
const quotaTone = m4.quotaTone
const tightestWindow = m4.tightestWindow
const windowProgress = m4.windowProgress
const WINDOW_ORDER = m4.WINDOW_ORDER
const planViewStore = m5.planViewStore
const useSelectedPlan = m5.useSelectedPlan
const PLAN_SHORT = m6.PLAN_SHORT
const formatCountdown = m7.formatCountdown
const formatCny = m7.formatCny
const formatCnyAxis = m7.formatCnyAxis
const formatDateTime = m7.formatDateTime
const formatMinuteOfDay = m7.formatMinuteOfDay
const formatTokens = m7.formatTokens
const minuteOfDay = m7.minuteOfDay
const ActivityCalendar = m8.ActivityCalendar
const BarList = m8.BarList
const DonutChart = m8.DonutChart
const TrendChart = m8.TrendChart
const useCountUp = m8.useCountUp
const dailyCosts = m9.dailyCosts
const dimensionSeries = m9.dimensionSeries
const fetchDashboard = m9.fetchDashboard
const priceByModel = m9.priceByModel
const ratesFor = m9.ratesFor
const recentDays = m9.recentDays
const sumByModel = m9.sumByModel
const sumRows = m9.sumRows
const TONES = m9.TONES
const toneFill = m9.toneFill
const composeRate = m10.composeRate
const draftOf = m10.draftOf
const fetchRates = m10.fetchRates
const saveRates = m10.saveRates
const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

/** 趋势窗口选项。 */
const RANGES = [
  { id: '7', label: '7 日', days: 7 },
  { id: '30', label: '30 日', days: 30 },
  { id: '90', label: '90 日', days: 90 },
]

/** 折线序列：缓存命中输入 / 未缓存输入 / 输出。 */
const SERIES = [
  { key: 'cacheHit', label: '缓存命中输入', tone: 'blue' },
  { key: 'cacheMiss', label: '未缓存输入', tone: 'purple' },
  { key: 'output', label: '输出', tone: 'pink' },
]

/**
 * Token 趋势的分组维度选项。
 *
 * `type` 是逐日行上已经算好的三段字段，另外两个维度要现场按 `byModel` 聚合
 * （见 `dimensionSeries`）。**只显示一个维度**而不是把三个叠加：三种维度会把
 * 同一个 token 数重复计入，叠在一起就得到一个假的总量。
 */
const TREND_DIMENSIONS = [
  { id: 'type', label: '构成' },
  { id: 'model', label: '模型' },
  { id: 'provider', label: '提供商' },
]

/**
 * 按模型 / 提供商分组时最多画几条线。
 *
 * 老账本里能出现十几个 `模型@提供商` 条目，全画上去就是一团互相压住的线，
 * 图例也会长到把面板撑开。超出的合成「其他」（见 `dimensionSeries`）。
 */
const TREND_SERIES_LIMIT = 5

/** 消费估计趋势的序列定义（单条：每日金额）。 */
const COST_SERIES = [{ key: 'cost', label: '每日消费估计', tone: 'pink' }]

/** 把高峰窗口数组渲染成 `9:00–12:00、14:00–18:00`。 */
function formatWindows(windows) {
  return (windows ?? [])
    .map((w) => `${formatMinuteOfDay(w.startMinute)}–${formatMinuteOfDay(w.endMinute)}`)
    .join('、')
}

/** 一份用量里落在高峰的 token 数。 */
function peakTokensOf(usage) {
  return Number(usage?.peak?.cacheMiss ?? 0) + Number(usage?.peak?.cacheHit ?? 0) + Number(usage?.peak?.output ?? 0)
}

/** 一份用量里落在空闲的 token 数。 */
function idleTokensOf(usage) {
  return Number(usage?.idle?.cacheMiss ?? 0) + Number(usage?.idle?.cacheHit ?? 0) + Number(usage?.idle?.output ?? 0)
}

/** 合计一组用量里的高峰 / 空闲 token。 */
function splitTokens(byModel) {
  let peak = 0
  let idle = 0
  for (const usage of Object.values(byModel ?? {})) {
    peak += peakTokensOf(usage)
    idle += idleTokensOf(usage)
  }
  return { peak, idle }
}

/**
 * 分段控件：滑块随选中项平移，而不是整块重绘。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function Segmented(props) {
  const { options, value, onChange, className } = props
  const listRef = useRef(null)
  const [thumb, setThumb] = useState({ left: 3, width: 0 })

  useEffect(() => {
    const host = listRef.current
    if (host === null) return undefined
    const sync = () => {
      const index = options.findIndex((item) => item.id === value)
      // children[0] 是滑块本身，所以按钮要往后偏一位
      const target = host.children[index + 1]
      if (target === undefined) return
      setThumb({ left: target.offsetLeft, width: target.offsetWidth })
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [value, options])

  return h(
    'div',
    { className: `px-seg${className === undefined ? '' : ` ${className}`}`, ref: listRef, role: 'tablist' },
    h('span', {
      className: 'px-seg-thumb',
      style: { transform: `translateX(${thumb.left - 3}px)`, width: thumb.width },
    }),
    options.map((item) =>
      h('button', {
        key: item.id,
        type: 'button',
        role: 'tab',
        className: 'px-seg-btn',
        'aria-selected': item.id === value,
        onClick: () => { onChange(item.id) },
      }, item.label)),
  )
}

/** 滚动计数的指标值。 */
function Metric(props) {
  const animated = useCountUp(props.value, props.duration ?? 620)
  return h(React.Fragment, null, props.format(animated))
}

/** 一张指标卡。 */
function StatCard(props) {
  const { tone, label, value, format, foot, delay } = props
  return h(
    'div',
    { className: `px-stat px-stat-${tone} px-rise`, style: { animationDelay: `${delay ?? 0}ms` } },
    h('div', { className: 'px-stat-label' }, label),
    h('div', { className: 'px-stat-value' }, h(Metric, { value, format })),
    h('div', { className: 'px-stat-foot' }, foot),
  )
}

/**
 * 带色点标题的卡片外壳。
 *
 * `collapsible` 为真时标题行变成一枚可点的展开/收起开关：看板上「会话清单」
 * 与「最近通知」这类**明细**信息量很大但不必常看，默认收起能让整页一屏看完
 * 主要指标。收起时标题行与右边的摘要**照常显示**——收起的是内容，不是信息本身。
 * @param {object} props - title / tone / extra / delay / collapsible / defaultOpen。
 * @returns {object} React 元素。
 */
function Panel(props) {
  const { collapsible = false, defaultOpen = true } = props
  const [open, setOpen] = useState(defaultOpen)
  const expanded = collapsible ? open : true

  const title = h('span', { className: 'px-panel-title' },
    // 折叠开关自带一枚小三角，与色点并排；展开方向随状态旋转。
    collapsible
      ? h('i', { className: `px-caret${expanded ? ' open' : ''}`, 'aria-hidden': 'true' })
      : h('i', { className: `px-panel-dot px-tone-bg-${props.tone ?? 'pink'}` }),
    props.title)

  return h(
    'section',
    { className: `px-panel px-rise${collapsible ? ' px-panel-collapsible' : ''}`, style: { animationDelay: `${props.delay ?? 0}ms` } },
    h('header', { className: 'px-panel-head' },
      collapsible
        ? h('button', {
          type: 'button',
          className: 'px-panel-toggle',
          'aria-expanded': expanded,
          onClick: () => { setOpen((prev) => !prev) },
        }, title, h('span', { className: 'px-panel-toggle-hint' }, expanded ? '收起' : '展开'))
        : title,
      props.extra === undefined ? null : h('span', { className: 'px-panel-extra' }, props.extra)),
    expanded ? h('div', { className: 'px-panel-body' }, props.children) : null,
  )
}

/** 键值行。 */
function Row(props) {
  return h('div', { className: 'px-row' }, h('span', null, props.label), h('b', null, props.value))
}

/**
 * 「最近通知」里的一行：带会话 id 时整行可点，点了切到那条会话。
 *
 * 无会话 id 的行退回普通 {@link Row}——**不**渲染成按钮。给一个点不动的
 * 行加上可点的外观（或反过来）都会让人以为坏了，而余额 / 套餐阈值那类预警
 * 本来就不属于任何会话。
 * @param {object} props - label / value / sessionId / onOpen。
 * @returns {object} React 元素。
 */
function RecentRow(props) {
  const { label, value, sessionId, onOpen } = props
  if (sessionId === undefined || sessionId === '') return h(Row, { label, value })
  return h('button', {
    type: 'button',
    className: 'px-row px-row-clickable',
    title: '点击切到这条会话',
    onClick: () => { onOpen?.(sessionId) },
  },
  h('span', null, label),
  h('b', null, value))
}

/**
 * 面板内部的**轻量折叠区**：一行标题 + 可点的三角，默认收起。
 *
 * 与 {@link Panel} 的 `collapsible` 是两件事：那个折叠的是整张卡片，这个折叠的是
 * 卡片里的一段明细（「最近通知」「会话清单」这类）。用同一个交互语言（三角朝右
 * 是收起、朝下是展开），因此用户不必学两套。
 *
 * 收起时标题行右侧仍显示 `summary`（例如「12 条」）：收起的是**内容**，不是
 * 「这里有多少东西」这个事实。
 *
 * 刻意用自绘 `button` 而不是原生 `<details>`：`/period` 与主题都靠 CSS 类名下发，
 * 原生 `<details>` 的展开态在静态渲染里不可控，而渲染闸门需要在**默认态**下断言
 * 「内容确实没渲染出来」。按钮 + state 是这一层唯一可被静态渲染断言的形式。
 * @param {object} props - title / hint / summary / defaultOpen / className / children。
 * @returns {object} React 元素。
 */
function Collapse(props) {
  const { title, hint, summary, defaultOpen = false, className } = props
  const [open, setOpen] = useState(defaultOpen)

  return h('div', { className: `px-collapse${open ? ' open' : ''}${className === undefined ? '' : ` ${className}`}` },
    h('button', {
      type: 'button',
      className: 'px-collapse-head',
      'aria-expanded': open,
      onClick: () => { setOpen((prev) => !prev) },
    },
    h('i', { className: `px-caret${open ? ' open' : ''}`, 'aria-hidden': 'true' }),
    h('b', null, title),
    hint === undefined ? null : h('span', { className: 'px-muted' }, hint),
    h('span', { className: 'px-collapse-summary' }, summary ?? (open ? '收起' : '展开'))),
    // 内容**不渲染**而不是 display:none：收起的意义正是省掉那一块的高度，
    // 而 display:none 仍会参与 React 树的构建与静态渲染输出。
    open ? h('div', { className: 'px-collapse-body' }, props.children) : null)
}

/**
 * 时段倒计时：展示层每秒重算。
 * 宿主给出下一次切换的毫秒数，这里只做本地递减，不必每秒问服务端。
 * @param {object} data - 看板数据。
 * @param {number} now - 当前时刻。
 * @returns {object|null} 状态。
 */
function usePeriod(data, now) {
  return useMemo(() => {
    if (data === null || data.period === undefined) return null
    const elapsed = Math.max(0, now - Number(data.generatedAt ?? now))
    return {
      peak: data.period.peak === true,
      remainMs: Math.max(0, Number(data.period.nextChangeMs ?? 0) - elapsed),
      minute: minuteOfDay(now, data.timezone),
    }
  }, [data, now])
}

/** 骨架屏：首次加载占位，避免白屏跳动。 */
function Loading() {
  return h('div', { className: 'px-root px-center' },
    h('div', { className: 'px-loading px-rise' },
      h('div', { style: { fontWeight: 600, color: 'var(--px-ink)' } }, '正在汇总会话用量…'),
      h('div', { className: 'px-skeleton' }),
      h('div', null, '首次扫描全部会话日志，稍等片刻')))
}

/** 顶栏标记：像素柱状图。 */
function MarkIcon() {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', 'aria-hidden': 'true' },
    [[3, 11], [8, 7], [13, 3]].map(([x, y], index) =>
      h('rect', {
        key: index,
        x,
        y,
        width: 4,
        height: 17 - y,
        rx: 1,
        fill: 'currentColor',
        opacity: 0.55 + index * 0.2,
      })))
}

/**
 * 看板容器：取数、刷新、每秒重算倒计时，把结果交给纯展示的 View。
 *
 * 余额与看板数据分开持有：余额有自己的开关与 60s 缓存，且**失败不该影响看板**，
 * 因此不塞进同一次取数的成败里。
 * @returns {object} React 元素。
 */
function Dashboard() {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' })
  const [now, setNow] = useState(() => Date.now())
  const [balance, setBalance] = useState({ payload: undefined, busy: false, error: '' })
  const [plans, setPlans] = useState({ payload: undefined, busy: false, error: '' })

  const load = useCallback((refresh) => {
    setState((prev) => ({ ...prev, status: prev.data === null ? 'loading' : 'refreshing' }))
    fetchDashboard({ refresh })
      .then((data) => { setState({ status: 'ready', data, error: '' }) })
      .catch((error) => { setState({ status: 'error', data: null, error: String(error?.message ?? error) }) })
  }, [])

  const loadBalance = useCallback((refresh) => {
    fetchBalance({ refresh })
      .then((payload) => { setBalance((prev) => ({ ...prev, payload, error: '' })) })
      .catch((error) => {
        // 余额取不到时保留上一次的数值，只在明细区给出提示——
        // 把已经拿到的余额擦掉只会让人以为余额没了。
        setBalance((prev) => ({ ...prev, error: String(error?.message ?? error) }))
      })
  }, [])

  const loadPlans = useCallback((refresh) => {
    fetchPlans({ refresh })
      .then((payload) => { setPlans((prev) => ({ ...prev, payload, error: '' })) })
      .catch((error) => {
        setPlans((prev) => ({ ...prev, error: String(error?.message ?? error) }))
      })
  }, [])

  const toggle = useCallback((target, enabled, setter, reload) => {
    setter((prev) => ({ ...prev, busy: true }))
    setToggle(target, enabled)
      .then((result) => {
        const message = result?.lockedByEnv === true ? (result.message ?? '已被环境变量关闭') : ''
        setter((prev) => ({ ...prev, busy: false, error: message }))
        // 重新取一次：宿主下次会回报新的 enabled 状态。
        reload(true)
      })
      .catch((error) => {
        setter((prev) => ({ ...prev, busy: false, error: String(error?.message ?? error) }))
      })
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchDashboard({})
      .then((data) => { if (!cancelled) setState({ status: 'ready', data, error: '' }) })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', data: null, error: String(error?.message ?? error) })
      })
    fetchBalance({})
      .then((payload) => { if (!cancelled) setBalance((prev) => ({ ...prev, payload })) })
      .catch((error) => { if (!cancelled) setBalance((prev) => ({ ...prev, error: String(error?.message ?? error) })) })
    fetchPlans({})
      .then((payload) => { if (!cancelled) setPlans((prev) => ({ ...prev, payload })) })
      .catch((error) => { if (!cancelled) setPlans((prev) => ({ ...prev, error: String(error?.message ?? error) })) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const handle = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(handle) }
  }, [])

  if (state.status === 'error') {
    return h('div', { className: 'px-root' },
      h(Panel, { title: '看板数据读取失败', tone: 'red' },
        h('p', { className: 'px-muted' }, state.error),
        h('button', { className: 'px-btn primary', onClick: () => { load(true) } }, '重试')))
  }
  if (state.data === null) return h(Loading)

  return h(View, {
    data: state.data,
    now,
    refreshing: state.status === 'refreshing',
    onRefresh: () => { load(true); loadBalance(true); loadPlans(true) },
    balance: balance.payload,
    balanceError: balance.error,
    balanceBusy: balance.busy,
    onToggleBalance: (enabled) => { toggle('balance', enabled, setBalance, loadBalance) },
    plans: plans.payload,
    plansError: plans.error,
    plansBusy: plans.busy,
    onTogglePlans: (enabled) => { toggle('plans', enabled, setPlans, loadPlans) },
    // 价目改完之后**重新取一次看板**：金额是按价目算出来的，不重取的话
    // 用户会看到「价改了但金额没变」——那正是最容易让人以为保存失败的现象。
    onRatesSaved: () => { load(true) },
  })
}

/**
 * 看板展示层：给定数据与当前时刻即渲染整页，无取数、无副作用。
 * @param {object} props - data / now / refreshing / onRefresh / balance* / plans*。
 * @returns {object} React 元素。
 */
function View(props) {
  const {
    data, now, refreshing, onRefresh,
    balance, balanceError, balanceBusy, onToggleBalance,
    plans, plansError, plansBusy, onTogglePlans,
    onRatesSaved,
  } = props
  const [rangeId, setRangeId] = useState('30')
  /**
   * Token 趋势的分组维度。
   *
   * 三种维度回答三个不同问题，**不互相替代**，因此做成切换而不是叠加：
   *   - 构成（缓存命中 / 未缓存 / 输出）：量花在哪一段；
   *   - 模型：哪个模型用得最多（同一个模型跨提供商合并，否则会重复计数）；
   *   - 提供商：量从哪条路由来。
   */
  const [trendBy, setTrendBy] = useState('type')
  const range = RANGES.find((item) => item.id === rangeId) ?? RANGES[1]
  const period = usePeriod(data, now)
  // 用户在看板上手动指定的「当前监看的套餐」（undefined = 自动挑最紧的那一家）。
  // 与输入框下方那一枚**共用同一个存储**：两边读同一份，切换立刻同步。
  const selectedPlan = useSelectedPlan()

  const points = useMemo(() => recentDays(data.days, range.days), [data.days, range.days])
  const rangeTotals = useMemo(() => sumRows(points), [points])
  const rangeByModel = useMemo(() => sumByModel(points.map((point) => point.byModel)), [points])
  const rangeCost = useMemo(() => priceByModel(rangeByModel, data.pricing), [rangeByModel, data.pricing])
  // 「今日」按宿主的 `overview.today`（站点时区的今天）去 days 里定位，
  // 找不到就是今天还没有任何请求——此时费用是 0，而不是「最后有数据那天」的费用。
  // 旧宿主没有这个字段时才退回 days.at(-1)（可能偏一天，但至少不空白）。
  const todayCost = useMemo(() => {
    const key = data.overview?.today
    const row = typeof key === 'string' && key !== ''
      ? data.days.find((day) => day.key === key)
      : data.days.at(-1)
    return priceByModel(row?.byModel ?? {}, data.pricing)
  }, [data.days, data.pricing, data.overview?.today])

  const overview = data.overview
  const activeInRange = points.filter((point) => Number(point.totals.requests) > 0).length
  const split = splitTokens(rangeByModel)
  const peakShare = split.peak + split.idle > 0 ? split.peak / (split.peak + split.idle) : 0

  // Token 趋势按维度摊开：`type` 直接用逐日行上的三段字段（recentDays 已经算好），
  // 模型 / 提供商则从每天的 byModel 现场聚合（见 dimensionSeries 的注释）。
  const trend = useMemo(() => {
    if (trendBy === 'type') return { series: SERIES, points }
    return dimensionSeries(points, data.models, trendBy, { limit: TREND_SERIES_LIMIT })
  }, [trendBy, points, data.models])

  // 消费估计趋势：与「费用估算」卡片同一口径（逐日 priceByModel 之和）。
  const costPoints = useMemo(() => dailyCosts(points, data.pricing), [points, data.pricing])

  // 切换监看的套餐：直接写共享存储，看板与输入框下方那一枚同时跟着变。
  const onSelectPlan = useCallback((planId) => { planViewStore().select(planId) }, [])

  // 余额面板的角标：只在真拿到金额、或明确是「已关闭」时才写字，
  // 其余情况留空，让面板内部那句状态说明去解释原因（降级必须可见但不喧宾夺主）。
  const balanceState = useMemo(() => {
    if (balanceError !== undefined && balanceError !== '') return { extra: '读取失败' }
    if (balance === undefined) return { extra: '读取中…' }
    const status = balanceStatus(balance)
    if (status.level === 'off') return { extra: '已关闭' }
    if (status.level !== 'ok') return { extra: '不可用' }
    const available = balanceAvailable(balance)
    return { extra: available === false ? '余额不足' : '官方接口' }
  }, [balance, balanceError])

  // 套餐面板的角标：只报「几家可用」，具体原因留给面板内部的说明行。
  const planState = useMemo(() => {
    if (plansError !== undefined && plansError !== '') return { extra: '读取失败' }
    if (plans === undefined) return { extra: '读取中…' }
    if (plans.enabled === false) return { extra: '已关闭' }
    const providers = Array.isArray(plans.providers) ? plans.providers : []
    const ok = providers.filter((provider) => provider?.ok === true).length
    if (providers.length === 0) return { extra: '无数据' }
    return { extra: ok === 0 ? '均不可用' : `${ok}/${providers.length} 家可用` }
  }, [plans, plansError])

  return h(
    'div',
    { className: 'px-root' },
    h('header', { className: 'px-topbar' },
      h('div', { className: 'px-topbar-title' },
        h('span', { className: 'px-mark' }, h(MarkIcon)),
        h('div', { className: 'px-title-text' },
          h('span', { className: 'px-title-main' }, '用量看板'),
          h('span', { className: 'px-title-sub' },
            `DSH · ${overview.sessions} 个会话 · 更新于 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`))),
      h('div', { className: 'px-topbar-actions' },
        h(Segmented, { options: RANGES, value: rangeId, onChange: setRangeId }),
        h('button', {
          type: 'button',
          className: 'px-btn small',
          disabled: refreshing,
          onClick: onRefresh,
        },
        h('span', { className: refreshing ? 'px-spin' : undefined }, '⟳'),
        refreshing ? '刷新中' : '刷新'))),

    h('div', { className: 'px-stats' },
      h(StatCard, {
        tone: 'blue',
        delay: 0,
        label: '累计 Token',
        value: overview.totals.local,
        format: formatTokens,
        foot: `缓存命中 ${formatTokens(overview.totals.cacheHit)} · 模型请求 ${overview.totals.requests} 次`,
      }),
      h(StatCard, {
        tone: 'purple',
        delay: 60,
        label: `${range.label} Token`,
        value: rangeTotals.local,
        format: formatTokens,
        foot: `输出 ${formatTokens(rangeTotals.output)} · ${activeInRange} 天有请求`,
      }),
      h(StatCard, {
        tone: 'pink',
        delay: 120,
        label: `${range.label}费用估算`,
        value: rangeCost.standard,
        format: formatCny,
        foot: `今日 ${formatCny(todayCost.standard)} · 高峰占比 ${(peakShare * 100).toFixed(0)}%`,
      }),
      h(StatCard, {
        tone: 'green',
        delay: 180,
        label: '连续活跃',
        value: overview.streaks.current,
        format: (value) => `${Math.round(value)} 天`,
        foot: `最长 ${overview.streaks.longest} 天 · 累计 ${overview.activeDays} 天`,
      })),

    // 时段与计费 + 活跃日历 并排一行：计费卡片的信息量就只有几行键值对，
    // 独占整行会让它显得空荡，而日历是横向铺开的图形，给它剩下的宽度正合适。
    // 窄屏由 .px-pair 的媒体查询塌回单列（见 theme.js）。
    h('div', { className: 'px-pair' },
      h(Panel, {
        // 时段信息是**背景条件**而不是主角：倒计时改成次要位置的一行字，
        // 与计费口径合并成一张紧凑卡片，不再单独占一张大面板。
        title: '时段与计费',
        // 高峰用主题粉、空闲用绿。两态各一色，且**同一张卡片里只出现一种**——
        // 卡片标题的点与右上角那枚徽标说的是同一件事，配色必须一致。
        tone: period.peak ? 'pink' : 'green',
        delay: 220,
        // 徽标与 .px-badge.ok 是**同一套做法**（淡色底 + 同色文字 + 同色描边），
        // 只是换了色相：两态看起来才是同一种东西的两个状态，而不是两种控件。
        extra: h('span', { className: `px-badge${period.peak ? ' peak' : ' ok'}` },
          h('i', { className: 'px-pulse' }),
          period.peak ? '高峰时段计费中' : '空闲时段计费中'),
      },
      h('div', { className: 'px-period' },
        h('div', { className: 'px-period-clock' },
          h('span', { className: 'px-period-clock-label' },
            period.peak ? '距转空闲' : '距转高峰'),
          h('b', { className: 'px-period-clock-value' }, formatCountdown(period.remainMs)),
          h('span', { className: 'px-period-clock-foot' },
            `${formatMinuteOfDay(period.minute)} · ${data.timezone}`)),
        h('div', { className: 'px-rows px-period-rows' },
          h(Row, { label: '高峰时段', value: `周一至周五 ${formatWindows(data.peakRule?.windows)}` }),
          h(Row, {
            label: `${range.label}高峰 / 空闲`,
            value: `${formatCny(rangeCost.peak)} / ${formatCny(rangeCost.idle)}`,
          }),
          h(Row, { label: '若全走空闲可省', value: formatCny(rangeCost.saved) })))),

      h(Panel, {
        title: '活跃日历',
        tone: 'green',
        delay: 260,
        extra: `${overview.firstDay ?? '—'} 起 · 一年 · 每格一天`,
      },
      h(ActivityCalendar, {
        firstDay: data.heatmap.firstDay,
        days: data.heatmap.days,
        requests: data.heatmap.requests ?? [],
        sessions: data.heatmap.sessions ?? [],
        tokens: data.heatmap.tokens ?? [],
        // 每格的消费估计，与 requests 同一套 day 索引。
        // 旧宿主没有这个字段 → 悬停显示「消费估计 —」，而不是假装是 ¥0。
        costs: data.heatmap.costs ?? [],
        maxRequests: data.heatmap.maxRequests ?? 1,
      }))),

    h(Panel, {
      title: '账户与套餐',
      tone: 'blue',
      delay: 240,
      extra: h('span', { className: 'px-panel-extra' },
        [balanceState?.extra, planState?.extra].filter((x) => x !== undefined && x !== '').join(' · ')),
    },
    h('div', { className: 'px-account-grid' },
      h(BalancePanel, {
        payload: balance,
        error: balanceError,
        busy: balanceBusy,
        onToggle: onToggleBalance,
        compact: true,
      }),
      h(PlansPanel, {
        payload: plans,
        error: plansError,
        busy: plansBusy,
        now,
        onToggle: onTogglePlans,
        selected: selectedPlan,
        onSelect: onSelectPlan,
        compact: true,
        // 与看板其余时间同一口径（宿主给的站点时区），否则重置日期会与别处差几小时
        timeZone: data.timezone,
      }))),

    // 两张趋势卡片**同行**（.px-trend-row）：它们回答同一段时间里的两个问题
    // （用了多少 / 花了多少），分两行会让读的人来回滚动对不上横轴。
    // 窄屏由 .px-trend-row 的媒体查询塌回单列（见 theme.js）。
    h('div', { className: 'px-trend-row' },
      h(Panel, {
        title: `${range.label} Token 趋势`,
        tone: 'blue',
        delay: 300,
        // 维度切换器放在标题行右侧：它改的正是这张卡片画什么
        extra: h(Segmented, {
          // 比顶部那个窗口切换器小一号：它是**卡片内**的次级选择，
          // 与「7 日 / 30 日 / 90 日」那种全局窗口不该看起来一样重。
          className: 'px-trend-dim',
          options: TREND_DIMENSIONS,
          value: trendBy,
          onChange: setTrendBy,
        }),
      },
      h(TrendChart, {
        points: trend.points,
        series: trend.series,
        formatAxis: formatTokens,
        formatValue: formatTokens,
      })),

      h(Panel, {
        title: `${range.label}消费估计趋势`,
        tone: 'pink',
        delay: 320,
        // 合计金额写在标题行：曲线的形状告诉「哪天贵」，这一行回答「一共多少」
        extra: formatCny(rangeCost.standard),
      },
      h(TrendChart, {
        points: costPoints,
        series: COST_SERIES,
        // 轴用紧凑金额（`¥0.038`），读数与合计仍用完整的 formatCny
        formatAxis: formatCnyAxis,
        formatValue: formatCny,
      }))),

    h(Panel, {
      title: '通知与预警',
      tone: 'green',
      delay: 320,
      extra: '任务完成 / 失败 / 等待授权 · 余额与套餐阈值',
    },
    h(NotifyPanel, { balance, plans })),

    h('div', { className: 'px-grid-2' },
      h(Panel, { title: '模型分布', tone: 'purple', delay: 340 },
        h(ModelBreakdown, { models: data.models, rangeByModel, rangeTotals })),
      h(Panel, { title: '费用明细', tone: 'pink', delay: 380 },
        h(CostTable, {
          models: data.models,
          rangeByModel,
          pricing: data.pricing,
          rangeCost,
          split,
          rangeLabel: range.label,
          // 自定义价目的状态（路径、条数、错误）交给编辑器展示
          ratesStatus: data.customRates,
          onRatesSaved: onRatesSaved,
        }))),

    h(Panel, {
      title: '会话清单',
      tone: 'blue',
      delay: 420,
      // 明细类面板：内容多、不必常看，默认收起，标题行仍写着总数。
      collapsible: true,
      defaultOpen: false,
      extra: `共 ${data.sessions.length} 个 · 显示最近 40 个`,
    },
    h(SessionTable, { sessions: data.sessions, timezone: data.timezone })),

    h('p', { className: 'px-source' },
      '单价与时段口径来自 ',
      h('a', {
        href: data.pricing?.source ?? 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
        target: '_blank',
        rel: 'noreferrer',
      }, 'DeepSeek 官方定价页'),
      // 「实际账单以服务商为准」在买断制下是误导：第三方中转 / Coding Plan
      // 不按 token 计费，所以这里的金额与它们毫无关系，而不是「略有出入」。
      '。所有金额都是按各模型官方单价做的估算——第三方中转与 Coding Plan 是买断制，'
      + '不按 token 计费，不在此估算范围内。'),
  )
}

/**
 * 账户余额面板：金额明细 + 开关 + 隐私说明。
 *
 * 三层信息各司其职：能显示的金额、不能显示时的**原因**、以及数据是怎么来的。
 * 只有第一层而没有后两层，用户就无从判断「余额为 —」是没配 Key 还是插件坏了。
 * @param {object} props - payload / error / busy / onToggle / compact。
 * @returns {object} React 元素。
 */
function BalancePanel(props) {
  const { payload, error, busy, onToggle, compact } = props
  const status = balanceStatus(payload)
  const enabled = payload?.enabled !== false
  const locked = payload?.lockedByEnv === true
  const rows = Array.isArray(payload?.balances) ? payload.balances : []

  return h('div', { className: compact === true ? 'px-account-col' : null },
    h('div', { className: 'px-balance-head' },
      h('div', { className: 'px-balance-total' },
        h('span', {
          className: `px-balance-amount${rows.some((row) => Number(row.total) < 0) ? ' px-negative' : ''}`,
        }, rows.length === 0
          ? '—'
          : formatMoney(rows[0].total, rows[0].currency)),
        rows.length > 1
          ? h('span', { className: 'px-balance-currency' },
            rows.slice(1).map((row) => formatMoney(row.total, row.currency)).join(' · '))
          : null),
      h('label', { className: 'px-balance-toggle' },
        h('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: busy === true || locked,
          onChange: (event) => { onToggle?.(event.target.checked) },
        }),
        h('span', null, locked ? '余额（环境变量已关）' : '余额'))),

    status.level === 'ok' && error === undefined
      ? null
      : h('p', { className: `px-balance-state px-${status.level === 'ok' ? 'warn' : status.level}` },
        // 明细区的提示优先用真实错误（它更具体），否则用归一状态文案
        error !== undefined && error !== '' ? `余额读取失败：${error}` : status.text),

    rows.length === 0
      ? null
      : h('div', { className: 'px-rows px-balance-rows' },
        rows.map((row) =>
          h(Row, {
            key: row.currency,
            label: `${row.currency} 明细`,
            value: [
              `可用 ${formatMoney(row.total, row.currency)}`,
              `充值 ${formatMoney(row.toppedUp, row.currency)}`,
              `赠送 ${formatMoney(row.granted, row.currency)}`,
            ].join(' · '),
          }))),

    // 充值 / 查看账单的入口：这是「看到余额不够」之后最自然的下一步动作
    h('p', { className: 'px-links' },
      h('a', {
        href: 'https://platform.deepseek.com/usage',
        target: '_blank',
        rel: 'noreferrer',
      }, 'DeepSeek 官方用量与充值 ↗')),

    // 隐私说明折进原生 <details>：信息仍然可查（点击展开），但默认不再占版面。
    // 用 <details> 而不是自建折叠，是为了不引入状态与 JS——它在任何环境下都能用。
    h('details', { className: 'px-details' },
      h('summary', null, '数据来源与隐私'),
      h('p', { className: 'px-balance-privacy' },
        '余额由本地宿主用 DSH 自己给官方 provider 用的那把 API Key 查询，',
        h('b', null, 'Key 不会离开本机'),
        '，浏览器端只收到金额。数据源：',
        payload?.baseURL === undefined ? '官方 /user/balance 接口' : `${payload.baseURL}/user/balance`,
        payload?.keySource === undefined ? '' : `（凭据来源：${payload.keySource}）`,
        payload?.official === false
          ? '。注意：当前 llm-deepseek 的 baseURL 不是官方公网地址，余额可能来自自建端点。'
          : '。')),
  )
}

/**
 * 一个额度窗口：进度条 + 剩余量 + 重置倒计时。
 *
 * 只有百分比而没有绝对值时（官方向下取整，可能失真）会标出来，
 * 而不是把取整后的数字当成精确值展示。
 *
 * **百分比未知时不许显示成 0%**：官方只报了余额的窗口（Command Code 的月度就是
 * 这样）没有已用、没有总额，百分比是未知而不是零。这时数字显示 `—`、进度条不画，
 * 脚注照实说明原因（`window.note`，没有 note 时给一句通用的）。
 *
 * 重置时刻给**绝对日期 + 剩余时间**两句（见 `formatResetLine`）：月额度这种长周期，
 * 用户常常要的是「到底哪天到期」，光有「还剩 9 天」还得自己算日子。
 * @param {object} props - win / now / timeZone。
 * @returns {object} React 元素。
 */
function QuotaWindow(props) {
  const { win, now, timeZone } = props
  const progress = windowProgress(win)
  const tone = quotaTone(progress.percent, progress.over)
  const reset = formatResetLine(win?.resetAt, now, timeZone)
  const parts = []
  if (progress.remainingText !== '—') parts.push(`剩余 ${progress.remainingText}`)
  if (progress.totalText !== '—') parts.push(`总额 ${progress.totalText}`)
  if (reset !== undefined) parts.push(reset)
  if (progress.estimated) parts.push('官方只给了百分比')
  if (progress.note !== '') parts.push(progress.note)
  else if (progress.usable && !progress.percentKnown) parts.push('官方只报了余额，没有已用额度')

  return h('div', { className: 'px-quota' },
    h('div', { className: 'px-quota-head' },
      h('span', { className: 'px-quota-name' }, win?.label ?? win?.window ?? '额度'),
      h('span', { className: `px-quota-percent px-tone-${tone}` },
        progress.percentKnown ? `${progress.percent.toFixed(1)}%` : '—'),
      // 超限要明说：百分比 >100 时数字本身已经说明，但加一个徽标更醒目
      progress.over ? h('span', { className: 'px-badge' }, '已超限') : null),
    h('div', { className: 'px-quota-track' },
      // 未知百分比不画条：一条 0% 的空条看起来就像「一点没用」，而事实是不知道
      progress.percentKnown
        ? h('span', {
          className: `px-quota-fill px-tone-bg-${tone}`,
          // 条宽用夹取值；数字用真值（见 windowProgress）
          style: { width: `${progress.barPercent}%` },
        })
        : null),
    parts.length === 0
      ? null
      : h('div', { className: 'px-quota-foot' }, parts.join(' · ')))
}

/**
 * 各家的管理 / 充值入口（**旧宿主的回落**）。
 *
 * 新宿主在每一家里交下 `setup.keyURL` / `keyURLName`（含「去哪拿凭据」的完整步骤），
 * 这里只服务没有 `setup` 的旧宿主。**注意火山的入口是 IAM 的「API 访问密钥」页，
 * 不是方舟控制台**——AK/SK 是账号级 IAM 凭据，方舟控制台给的是推理用的 `ark-` Key，
 * 那个恰好是本接口会拒掉的一把。早先这里指向方舟控制台，正是用户找不到 AK 的原因。
 */
const PLAN_LINKS = {
  zhipu: { href: 'https://www.bigmodel.cn/coding-plan/personal/usage', label: '智谱套餐用量 ↗' },
  commandcode: { href: 'https://commandcode.ai/studio', label: 'Command Code 工作室 ↗' },
  volcengine: { href: 'https://console.volcengine.com/iam/keymanage/', label: '火山引擎 API 访问密钥 ↗' },
}

/**
 * 「这家凭据怎么配」的可展开说明。
 *
 * 只有两件事要回答，**缺任何一件用户都会卡住**：
 *   1. **去哪拿**（`acquire` + `keyURL`）；
 *   2. **拿到后放哪**（`refs` + 凭据文件路径）。
 *
 * 第 2 点容易被漏掉，因为「设置 → 模型」里根本没有能填 `VOLC_ACCESS_KEY_ID` 的输入框
 * ——DSH 只会写它自己派生的 `<路由>_API_KEY`。所以这里必须把凭据文件**路径**写出来。
 * @param {object} props - setup / credentialFile / open。
 * @returns {object|null} React 元素；没有 setup 时 null。
 */
function SetupHelp(props) {
  const { setup, credentialFile, open = false } = props
  if (!hasSetupHelp(setup)) return null
  const acquire = Array.isArray(setup.acquire) ? setup.acquire : []
  const refs = Array.isArray(setup.refs) ? setup.refs : []
  const file = typeof credentialFile === 'string' && credentialFile !== '' ? credentialFile : ''

  return h('details', { className: 'px-details px-plan-setup', open },
    h('summary', null, '这家凭据怎么配'),
    acquire.length === 0
      ? null
      : h('ol', { className: 'px-plan-steps' },
        acquire.map((step, index) => h('li', { key: index }, step))),
    // 入口只在**展开时**画在这里：`<details>` 折叠时子节点仍在 DOM 里，
    // 无条件渲染会与页脚那一个入口重复，同一块里出现两个同样的链接
    // 会让「点哪个」变成多余的问题。
    !open || setup.keyURL === undefined || setup.keyURL === ''
      ? null
      : h('p', { className: 'px-plan-setup-link' },
        h('a', { href: setup.keyURL, target: '_blank', rel: 'noreferrer' },
          `${setup.keyURLName === '' ? '打开创建页' : setup.keyURLName} ↗`)),
    refs.length === 0
      ? null
      : h('div', { className: 'px-plan-setup-where' },
        h('p', null, '把下面这些项写进 DSH 凭据文件（或设成同名环境变量）：'),
        file === ''
          ? null
          : h('code', { className: 'px-plan-setup-path' }, file),
        h('ul', { className: 'px-plan-setup-refs' },
          refs.map((item) => h('li', { key: item.name },
            h('code', null, `${item.name}: ${item.example === '' ? '…' : item.example}`),
            item.note === '' ? null : h('span', { className: 'px-plan-setup-note' }, item.note))))),
    // 两条路的重载方式不同，必须分开说：凭据文件由 DSH **自动重载**（改完不必重启），
    // 环境变量在启动时就快照固定了（必须重启）。混成一句会让用户白重启一次，
    // 或者反过来一直等一个永远不会生效的值。
    h('p', { className: 'px-plan-setup-hint' },
      '凭据文件改完由 DSH 自动重载，不用重启；环境变量则要写进 ',
      h('code', null, '<DSH_HOME>/.env'),
      ' 或启动 dsh 前 export，然后重启 dsh 才生效。'),
  )
}

/**
 * 这一家有可显示的「怎么配」说明吗。
 *
 * 单独抽出来是为了让**页脚**与说明块用同一条判据：说明块为空时它自己返回 null，
 * 页脚若还按「有 setup 就不画链接」去抑制，这一家就一个入口都没有了。
 * @param {object} setup - 宿主的 setup 块。
 * @returns {boolean} 是否有内容可显示。
 */
function hasSetupHelp(setup) {
  if (setup === undefined || setup === null) return false
  const acquire = Array.isArray(setup.acquire) ? setup.acquire : []
  const refs = Array.isArray(setup.refs) ? setup.refs : []
  return acquire.length > 0 || refs.length > 0
}

/**
 * 一家厂商的额度区块。
 * @param {object} props - provider / now / current / credentialFile / timeZone。
 * @returns {object} React 元素。
 */
function ProviderQuota(props) {
  const { provider, now, current = false, credentialFile, timeZone } = props
  const status = providerStatus(provider)
  const windows = WINDOW_ORDER
    .map((key) => (provider?.windows ?? []).find((win) => win.window === key))
    .filter(Boolean)
  const link = PLAN_LINKS[provider?.id]
  // 新宿主的 setup 优先；旧宿主没有它时才用写死的表。
  const setup = provider?.setup
  // 缺凭据时把说明**默认展开**：那正是用户需要它的时刻。
  // 配好了就折叠起来，不占版面。
  const needsKey = provider?.ok !== true && provider?.reason === 'no-key'
  const setupURL = setup?.keyURL === undefined || setup.keyURL === '' ? undefined : setup.keyURL
  const setupLabel = setup?.keyURLName === undefined || setup.keyURLName === ''
    ? '创建页 ↗'
    : `${setup.keyURLName} ↗`
  // 入口在同一块里**只出现一次**。展开时它跟在步骤后面（就在眼前），
  // 此时页脚不再重复；折叠（或旧宿主没有 setup）时由页脚那个常驻入口承担。
  // 判据必须与 SetupHelp 自己的渲染条件一致（`hasSetupHelp`）：
  // 说明块为空时它渲染 null，页脚若还抑制链接，这一家就一个入口都没有了。
  const setupShowsLink = needsKey && hasSetupHelp(setup) && setupURL !== undefined
  const keyURL = setupShowsLink ? undefined : (setupURL ?? link?.href)
  const keyLabel = setupURL === undefined ? link?.label : setupLabel

  return h('div', { className: `px-plan${current ? ' px-plan-current' : ''}` },
    h('div', { className: 'px-plan-head' },
      h('b', { className: 'px-plan-name' }, provider?.name ?? '未知厂商'),
      provider?.plan === undefined || provider.plan === '' ? null : h('span', { className: 'px-badge ok' }, provider.plan),
      // 「当前监看」要显式标出来：切换器在它上面，用户点完得能立刻看出点中了谁。
      current ? h('span', { className: 'px-badge primary' }, '当前监看') : null,
      provider?.keyHint === undefined
        ? null
        : h('span', { className: 'px-plan-key', title: `凭据来源：${provider.keySource ?? '未知'}` },
          `${provider.keyRef ?? ''} ${provider.keyHint}`)),
    status.level === 'ok' && status.text === ''
      ? null
      : h('p', { className: `px-balance-state px-${status.level === 'ok' ? 'warn' : status.level}` }, status.text),
    provider?.warning === undefined
      ? null
      : h('p', { className: 'px-balance-state px-warn' }, provider.warning),
    h(SetupHelp, { setup, credentialFile, open: needsKey }),
    windows.length === 0
      ? null
      : h('div', { className: 'px-quota-list' },
        windows.map((win) => h(QuotaWindow, { key: win.window, win, now, timeZone }))),
    // 这一家的入口与这一家的数据源说明并排一行：两者都是「关于这一家」的补充信息，
    // 各占一行会让三家堆出六行来。
    h('p', { className: 'px-plan-foot' },
      keyURL === undefined
        ? null
        : h('a', { href: keyURL, target: '_blank', rel: 'noreferrer' }, keyLabel),
      provider?.endpoint === undefined
        ? null
        : h('span', { className: 'px-plan-endpoint', title: '未文档化的内部接口，可能随官方改动失效' },
          `数据源 ${provider.endpoint}`)),
  )
}

/**
 * 「当前监看哪一家」的切换器。
 *
 * 三件事刻意如此：
 *   1) **失败的厂商也列出来**。用户配错凭据时恰恰最想切过去看一眼原因；
 *      只在可用项之间切换会让人以为插件不支持那一家（见 `providerChoices`）。
 *   2) **总是给一个「自动」选项**。自动的含义是「在全部可用厂商里挑最紧的那个」，
 *      这是默认行为；没有这一项，用户点过一次之后就再也回不到自动。
 *   3) 它是**纯界面偏好**，只写浏览器本地存储，不影响宿主是否发请求
 *      （见 client/planView.js 的说明）。
 * @param {object} props - providers / selected / onSelect。
 * @returns {object|null} React 元素。
 */
function PlanSwitcher(props) {
  const { providers, selected, onSelect } = props
  if (providers.length === 0) return null

  /** 渲染一枚选项。 */
  const chip = (id, label, ok) => h('button', {
    key: id ?? 'auto',
    type: 'button',
    className: `px-plan-chip${(selected ?? undefined) === id ? ' active' : ''}${ok === false ? ' bad' : ''}`,
    'aria-pressed': (selected ?? undefined) === id,
    onClick: () => { onSelect?.(id) },
  }, label)

  return h('div', { className: 'px-plan-switch' },
    h('span', { className: 'px-plan-switch-label' }, '当前监看'),
    chip(undefined, '自动（最紧）', true),
    providers.map((provider) => chip(provider.id, PLAN_SHORT[provider.id] ?? provider.name, provider.ok)),
    h('span', { className: 'px-plan-switch-hint' },
      '只影响这里突出显示哪一家，不影响取数与预警。'),
  )
}

/**
 * 订阅套餐额度面板：每家的各窗口进度 + 切换器 + 开关 + 隐私说明。
 *
 * 这里刻意**不做**任何金额换算：智谱的积分、Command Code 的美元信用额与火山的
 * 积分是几套互不相通的单位，混在一起加总只会得到一个没有意义的数字。
 *
 * 导出是为了让渲染闸门能直接渲染它（面板在整页里是并排两栏之一，单独断言它的
 * 内部结构比从整页 HTML 里切片段更可靠）。
 * @param {object} props - payload / error / busy / now / onToggle / selected / onSelect。
 * @returns {object} React 元素。
 */
function PlansPanel(props) {
  const { payload, error, busy, now, onToggle, selected, onSelect, compact, timeZone } = props
  const enabled = payload?.enabled !== false
  const locked = payload?.lockedByEnv === true
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const choices = providerChoices(payload)
  // 当前监看的那一家（与切换器同一条判据）。它必须留在显眼组：
  // 切换器里标着「当前监看」而下面找不到它，是自相矛盾的界面。
  const currentId = (() => {
    if (selected !== undefined && selected !== '') return selected
    return tightestWindow({ providers })?.planId
  })()
  // 没配过凭据的那几家收进折叠区（见 partitionProviders 的注释：判据是
  // 「有没有配过」而不是「成功还是失败」——配过但坏了的一直显示）。
  const { active, idle } = partitionProviders(providers, { selected, current: currentId })
  /** 渲染一家。 */
  const renderProvider = (provider) => h(ProviderQuota, {
    key: provider.id,
    provider,
    now,
    current: isCurrentPlan(selected, providers, provider.id),
    // 「配到哪」的路径由宿主解析（浏览器拿不到 env），这里只往下传。
    credentialFile: payload?.credentialFile,
    // 重置时刻要显示成**站点时区**下的日期：与看板其余时间口径一致。
    timeZone,
  })

  return h('div', { className: compact === true ? 'px-account-col' : null },
    h('div', { className: 'px-balance-head' },
      h('div', { className: 'px-balance-total' },
        h('span', { className: 'px-balance-currency' },
          choices.length === 0 ? '智谱 · Command Code · 火山方舟' : `${choices.length} 家已配置`)),
      h('label', { className: 'px-balance-toggle' },
        h('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: busy === true || locked,
          onChange: (event) => { onToggle?.(event.target.checked) },
        }),
        h('span', null, locked ? '套餐（环境变量已关）' : '套餐'))),

    error !== undefined && error !== ''
      ? h('p', { className: 'px-balance-state px-error' }, `套餐额度读取失败：${error}`)
      : null,
    payload?.enabled === false
      ? h('p', { className: 'px-balance-state px-off' },
        locked
          ? '已被环境变量 DSH_PIXEL_PLANS 关闭'
          : '已关闭，宿主不会向任何第三方端点发起请求')
      : null,

    // 切换器放在额度块**之前**：它决定下面哪一块被标成「当前监看」，
    // 摆在后面会让人先读到数据再看到「其实可以换一个看」。
    payload?.enabled === false
      ? null
      : h(PlanSwitcher, { providers: choices, selected, onSelect }),

    providers.length === 0
      ? null
      : h('div', { className: 'px-plan-list' },
        active.map(renderProvider)),

    // 没配凭据的那几家折起来：它们此刻没有任何信息量（就是「还没配」），
    // 但**不能删掉**——随着适配的第三方变多，用户需要一处能看见
    // 「插件还支持哪些家、怎么配」。标题行写明有几家，收起的是内容不是事实。
    //
    // **一家都没配时默认展开**：那时上面是空的，折叠起来整张卡片就只剩一行字，
    // 新用户既看不到支持哪些家、也无从知道该怎么配。有在用的家时才收起。
    idle.length === 0
      ? null
      : h(Collapse, {
        // 用 key 让「该展开」这件事变化时重新挂载：Collapse 的 open 是内部 state，
        // 只读初始值，光改 defaultOpen 是改不动的。
        key: `idle-${active.length === 0}`,
        title: '未配置的厂商',
        hint: active.length === 0 ? '配好凭据即可查看额度' : '配好凭据后会自动移到上面',
        summary: `${idle.length} 家`,
        defaultOpen: active.length === 0,
      },
      h('div', { className: 'px-plan-list px-plan-list-idle' },
        idle.map(renderProvider))),

    // 同上：折进 <details>，默认不占版面
    h('details', { className: 'px-details' },
      h('summary', null, '接口来源与隐私'),
      h('p', { className: 'px-balance-privacy' },
        '三家都',
        h('b', null, '没有公开文档化的额度接口'),
        '，这里用的是它们前端自己在用的内部接口；凭据只在本地宿主进程内使用，',
        h('b', null, '不会离开本机'),
        '，浏览器端只收到额度数字与打码后的凭据尾段。',
        '智谱需要',
        h('b', null, '编程套餐专属 Key'),
        '（在「个人编程套餐」里新建，与平台普通 API Key 不通用）。',
        '火山方舟的用量接口在',
        h('b', null, '控制面 OpenAPI'),
        '上，要的是',
        h('b', null, '火山账号'),
        '的 AccessKey ID / Secret Access Key（',
        h('b', null, '不是'),
        '方舟推理用的 ark- 开头的 Key，那把在网关会被直接拒绝）。这两把在火山引擎的',
        h('b', null, 'IAM「API 访问密钥」'),
        '里创建——不在方舟控制台里。每一家的「这家凭据怎么配」里有完整步骤与凭据文件路径。')),
  )
}

/**
 * 判断某一家是不是「当前监看」的那一家。
 *
 * 用户显式选过就用他选的；没选过（自动模式）则跟着**最紧**的那一个走——
 * 与输入框下方那一枚徽标用同一条判据（`tightestWindow`），否则用户会看到
 * 「下面标的是 A 家、费用条旁边显示的是 B 家」这种自相矛盾的界面。
 * @param {string|undefined} selected - 用户显式选择。
 * @param {object[]} providers - 宿主给的全部厂商。
 * @param {string} id - 待判断的厂商 id。
 * @returns {boolean} 是否是当前监看的那一家。
 */
function isCurrentPlan(selected, providers, id) {
  if (selected !== undefined && selected !== '') return selected === id
  const tightest = tightestWindow({ providers })
  return tightest !== undefined && tightest.planId === id
}

/**
 * 订阅通知运行时的快照。
 *
 * 用 `useSyncExternalStore` 而不是自己 `useState` + `useEffect` 订阅：
 * 后者在「订阅发生在首次渲染之后」的窗口里会丢掉一次变化，而这正是本面板
 * 最常见的场景（面板打开时运行时已经在跑，且刚刚发布过状态）。
 * 运行时的存储做了变化检测，因此每 4 秒的轮询不会引起无谓重渲染。
 * @param {object} store - {@link notifyStore} 的返回值。
 * @returns {object} 快照。
 */
function useNotifySnapshot(store) {
  return React.useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    useCallback(() => store.getSnapshot(), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
}

/**
 * 一条通知的时间戳：只写时分秒。
 * @param {number} at - 毫秒时间戳。
 * @returns {string} 形如 `14:03:21`。
 */
function clockOf(at) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return '—'
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

/**
 * 通知与预警面板：系统通知授权、分类开关、余额 / 套餐阈值、待办与最近通知。
 *
 * 余额与套餐的**当前值**由外层传入（`View` 已经取过一份），这里只用来做
 * 「如果现在按这个阈值判，会不会触发」的即时预览——真正的判定在运行时里，
 * 按它自己的节奏跑。这样用户调阈值时能马上看到效果，而不必等 30 秒。
 * @param {object} props - balance / plans。
 * @returns {object} React 元素。
 */
function NotifyPanel(props) {
  const { balance, plans } = props
  const store = useMemo(() => notifyStore(), [])
  const snapshot = useNotifySnapshot(store)
  const config = { ...NOTIFY_DEFAULTS, ...(snapshot.config ?? {}) }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // 阈值输入框的草稿：输入过程中不能每敲一个字符就写盘，否则输入「10」会先
  // 提交「1」——而「1」是一个完全不同的阈值（余额低于 1 元就报警）。
  const [draft, setDraft] = useState(null)

  const save = useCallback((patch) => {
    setSaving(true)
    setError('')
    saveNotify(patch)
      .then((result) => {
        if (result?.config !== undefined) store.setConfig(result.config)
        // 落盘失败要说出来，但不能回滚界面上的选择——内存里已经生效，
        // 回滚只会让用户觉得自己没点到。
        if (result?.persisted === false) setError('设置已在本次运行内生效，但没能写进配置文件')
      })
      .catch((cause) => { setError(String(cause?.message ?? cause)) })
      .finally(() => { setSaving(false) })
  }, [store])

  const ask = useCallback(() => {
    // 申请完立刻**重新读一次**浏览器（而不是用 requestPermission 的返回值）：
    // 那个返回值在部分浏览器里与 `Notification.permission` 短暂不一致，
    // 而后者才是真正决定通知能否弹出的依据。
    requestPermission().then(() => { store.setPermission(permissionOf()) })
  }, [store])

  /**
   * 重新读一次浏览器的真实权限。
   *
   * `permissionOf()` 默认读 `globalThis`，因此这里**显式传入浏览器全局**：
   * 面板与运行时可能在不同的全局对象下被求值（打包后各自一个作用域），
   * 而权限这件事只有一个真值来源——`window`。
   */
  const recheck = useCallback(() => {
    store.setPermission(permissionOf(typeof window === 'undefined' ? globalThis : window))
  }, [store])

  /**
   * 发一条测试通知。
   *
   * 「功能到底通没通」不该靠用户去等一个真实任务跑完来推测。这一条走的是与真实
   * 提醒**完全相同**的那条路径（registry 里的同一个 notify 函数），因此它能弹
   * 就说明整条链路是好的；弹不出来，问题一定在浏览器授权或系统通知设置上。
   */
  const test = useCallback(() => {
    store.publishTest()
  }, [store])

  const permission = snapshot.permission ?? 'default'
  const rows = Array.isArray(balance?.balances) ? balance.balances : []
  const thresholds = config.warnBalance ?? {}
  const active = balanceAlerts(balance, thresholds)
  const quotaHit = quotaAlerts(plans, config.warnQuotaPercent)

  return h('div', null,
    // 浏览器授权是**前置条件**：没授权时系统通知一个都不会出现。
    // 因此这一行永远在最上面，并且状态写清楚，而不是等用户来问「为什么没提醒」。
    //
    // 三种「没授权」要分开说，因为**下一步动作完全不同**：
    //   default     → 可以申请，给按钮；
    //   denied      → 申请也没用了（浏览器不再弹框），只能去站点设置里改；
    //   unsupported → 环境根本没有这个 API，点了也没反应，别给按钮。
    // 混成一句「未授权」会让人反复点一个不会有任何反应的按钮。
    h('div', { className: 'px-notify-permission' },
      h('span', { className: `px-badge${permission === 'granted' ? ' ok' : ''}` },
        permission === 'granted'
          ? '系统通知已授权'
          : permission === 'denied'
            ? '系统通知被拒绝'
            : permission === 'unsupported' ? '本环境不支持系统通知' : '系统通知未授权'),
      h('span', { className: 'px-muted px-notify-permission-text' }, PERMISSION_TEXT[permission] ?? ''),
      permission === 'default'
        ? h('button', { type: 'button', className: 'px-btn small primary', onClick: ask }, '申请授权')
        : null,
      // 用户可以**不经过本插件**改权限（地址栏站点设置、浏览器设置页），
      // 而我们只在轮询时同步。给一个手动重检的入口，省得他改了权限还要猜
      // 「为什么这里没变」——那正是最容易让人觉得「没用明白」的地方。
      permission === 'granted'
        ? null
        : h('button', { type: 'button', className: 'px-btn small', onClick: recheck }, '重新检测'),
      // 「能不能弹」是一件必须能自证的事：不试一次，用户永远不确定是自己没配好
      // 还是功能坏了。这一枚只发一条本地通知，不依赖宿主、不依赖任何配置。
      permission === 'granted'
        ? h('button', { type: 'button', className: 'px-btn small', onClick: test }, '发一条测试通知')
        : null),

    error === '' ? null : h('p', { className: 'px-balance-state px-error' }, error),
    snapshot.error === '' || snapshot.error === undefined
      ? null
      : h('p', { className: 'px-balance-state px-warn' }, `通知取数失败：${snapshot.error}`),

    // 待办交互：这是**唯一**需要用户立刻行动的一类，因此单独拿出来放最前面，
    // 而不是混在「最近通知」里等着被翻到。
    snapshot.pending?.length > 0
      ? h('div', { className: 'px-notify-pending' },
        h('b', { className: 'px-notify-pending-title' }, `⏳ ${snapshot.pending.length} 项等待你的处理`),
        h('div', { className: 'px-rows' },
          snapshot.pending.map((item) => h(Row, {
            key: String(item.key),
            label: item.kind === 'approval'
              ? '授权'
              : item.kind === 'plan-review' ? '计划确认' : item.kind === 'question' ? '提问' : '待办',
            value: item.kind === 'approval'
              ? String(item.toolName ?? '工具调用')
              : String(item.questions?.[0]?.header ?? item.questions?.[0]?.question ?? '等待回答'),
          }))))
      : null,

    h('div', { className: 'px-notify-flags' },
      NOTIFY_FLAGS.map((flag) => h('label', {
        key: flag.key,
        className: 'px-notify-flag',
        title: flag.hint,
      },
      h('input', {
        type: 'checkbox',
        checked: config[flag.key] !== false,
        disabled: saving,
        onChange: (event) => { save({ [flag.key]: event.target.checked }) },
      }),
      h('span', null, flag.label)))),

    // ── 余额预警阈值 + 套餐额度预警 ────────────────────────────────
    // 两项阈值并排一行：它们各自的正文只有「一个标签 + 一个数字框」，
    // 各占一整行会白吃掉两倍高度。窄屏由 .px-notify-thresholds 的媒体查询塌回单列。
    h('div', { className: 'px-notify-thresholds' },
      h('div', { className: 'px-notify-threshold' },
        h('div', { className: 'px-notify-threshold-head' },
          h('b', null, '余额预警阈值'),
          h('span', { className: 'px-muted' }, '留空表示不预警该币种；低于阈值时提醒一次，恢复到阈值以上后重新武装')),
        rows.length === 0
          ? h('p', { className: 'px-muted px-note' }, '还没有拿到余额，无法设置阈值（先在上面的余额卡片里确认能取到金额）。')
          : h('div', { className: 'px-notify-inputs' },
            rows.map((row) => {
              const currency = String(row.currency ?? '')
              const current = draft?.currency === currency
                ? draft.value
                : (Number.isFinite(Number(thresholds[currency])) ? String(thresholds[currency]) : '')
              return h('label', { key: currency, className: 'px-notify-input' },
                h('span', null, `${currency} 低于`),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: '0.01',
                  value: current,
                  disabled: saving,
                  placeholder: '不预警',
                  onChange: (event) => { setDraft({ currency, value: event.target.value }) },
                  // 失焦才提交：输入中的每一个中间值都是合法但错误的阈值
                  // （输入「10」会先经过「1」——那是完全不同的一个阈值）。
                  onBlur: () => {
                    // 只有真的改过才提交。`draft === null` 说明用户只是点进来又点出去，
                    // 此时若照常提交，`raw` 会落到空串、进而**删掉**已有阈值——
                    // 一个纯粹的「看了一眼」动作不该改掉配置。
                    if (draft?.currency !== currency) return
                    const raw = draft.value
                    setDraft(null)
                    const next = { ...thresholds }
                    if (String(raw).trim() === '') delete next[currency]
                    else next[currency] = Number(raw)
                    save({ warnBalance: next })
                  },
                }))
            })),
        active.length === 0
          ? null
          : h('p', { className: 'px-balance-state px-warn' },
            `按当前设置：${active.map((item) => `${item.currency} ${formatMoney(item.total, item.currency)}`).join('、')} 已低于阈值`)),

      h('div', { className: 'px-notify-threshold' },
        h('div', { className: 'px-notify-threshold-head' },
          h('b', null, '套餐额度预警'),
          h('span', { className: 'px-muted' }, '任意窗口「已用」达到这个百分比时提醒；0 表示关闭')),
        h('div', { className: 'px-notify-inputs' },
          h('label', { className: 'px-notify-input' },
            h('span', null, '已用达到'),
            h('input', {
              type: 'number',
              min: 0,
              max: 1000,
              step: 1,
              value: draft?.currency === '__quota' ? draft.value : String(config.warnQuotaPercent),
              disabled: saving,
              onChange: (event) => { setDraft({ currency: '__quota', value: event.target.value }) },
              // 与余额阈值同理：只有真的改过才提交
              onBlur: () => {
                if (draft?.currency !== '__quota') return
                const raw = draft.value
                setDraft(null)
                save({ warnQuotaPercent: Number(raw) })
              },
            }),
            h('span', null, '%'))),
        quotaHit.length === 0
          ? null
          : h('p', { className: 'px-balance-state px-warn' },
            `按当前设置：${quotaHit.slice(0, 4).map((item) => `${item.provider} ${item.label} ${item.percent.toFixed(0)}%`).join('、')} 已达阈值`))),

    // ── 最近通知（默认收起）────────────────────────────────────────
    // 它是**事后明细**：绝大多数时候有价值的是上面那句「几项等待处理」，
    // 而不是一条条翻时间戳。收起后标题行仍写着条数，信息不丢，版面省掉一大块。
    h(Collapse, {
      title: '最近通知',
      hint: snapshot.ready === true ? '本次页面会话内' : '加载中…',
      summary: snapshot.recent?.length > 0 ? `${Math.min(snapshot.recent.length, 8)} 条` : '暂无',
      defaultOpen: false,
      className: 'px-notify-recent',
    },
    snapshot.recent?.length > 0
      ? h('div', { className: 'px-rows' },
        snapshot.recent.slice(0, 8).map((item, index) => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
          // 带会话 id 的才可点：余额 / 套餐阈值那类预警不属于任何会话，
          // 给它们一个点了没反应的点击区只会让人以为坏了。
          return h(RecentRow, {
            key: `${item.at}-${index}`,
            label: clockOf(item.at),
            // 被「当前会话不打扰」静默的那条照样列在这里，并明说它没弹——
            // 否则用户看到的是「别的会话完成了却什么都没发生」，只会以为功能漏了。
            value: composeRecentLine(item),
            sessionId,
            onOpen: (id) => { store.openSession(id) },
          })
        }))
      : h('p', { className: 'px-muted px-note' },
        '还没有发出过通知。让一个会话跑完（或去别的标签页等一会儿），这里就会出现记录。')),
    // 隐私与机制说明：折进 <details>，默认不占版面（与其余面板同一套做法）
    h('details', { className: 'px-details' },
      h('summary', null, '提醒是怎么触发的'),
      h('p', { className: 'px-balance-privacy' },
        '「任务完成 / 失败 / 中断」由宿主侧判定后写进一份',
        h('b', null, '仅存在于内存'),
        '的日志，浏览器每 4 秒取一次增量——因为浏览器看不到后台会话的轮次结束事件，'
        + '而那正是最需要提醒的时候。',
        '「等待授权 / 回答」直接读 DSH 自己发布的待办状态，不经过网络。',
        '「余额 / 套餐预警」在浏览器侧按 30 秒的节奏判定，且',
        h('b', null, '同一项预警持续期间只提醒一次'),
        '，恢复到阈值以上后才会重新武装。',
        '刷新页面会清空「最近通知」，一切都只在内存里，不写任何文件。')),
  )
}

/**
 * 模型分布：环图 + 条形占比（按当前时间窗口）。
 *
 * 一条 = **模型 × 提供商**，与费用明细同一口径：同一个 DeepSeek 模型经三条路由
 * 调用就是三份用量（单价与额度归属都不同），而 `模型路由名 + 模型外显名` 那种
 * 「名字里有两条信息」的展示让人分不清哪一条才是模型。
 * @param {object} props - models / rangeByModel / rangeTotals。
 * @returns {object} React 元素。
 */
function ModelBreakdown(props) {
  const { models, rangeByModel, rangeTotals } = props
  const rows = models.map((model, index) => {
    const usage = rangeByModel[entryKeyOf(model)] ?? { local: 0 }
    const share = rangeTotals.local > 0 ? (Number(usage.local ?? 0) / rangeTotals.local) * 100 : 0
    return {
      key: entryKeyOf(model),
      label: model.label,
      tone: TONES[index % TONES.length],
      value: Number(usage.local ?? 0),
      text: `${formatTokens(usage.local)} · ${share.toFixed(1)}%`,
    }
  })
  const visible = rows.filter((row) => row.value > 0)
  if (visible.length === 0) return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')
  return h('div', { className: 'px-model-grid' },
    h(DonutChart, {
      slices: visible.map((row) => ({ key: row.key, value: row.value, tone: row.tone })),
      centerTitle: '窗口内 token',
      centerValue: formatTokens(rangeTotals.local),
    }),
    h('div', { className: 'px-model-side' },
      h(BarList, { rows: visible }),
      h('p', { className: 'px-muted px-note' },
        `共 ${models.length} 个「模型 × 提供商」条目 · 用量最多：${models[0]?.label ?? '—'}`)))
}

/**
 * 模型条目的身份键。
 *
 * 新宿主给的是 `模型@提供商`（见宿主 CAPABILITIES 的 `modelProvider`），
 * 旧宿主只有 `model`——两种都要认，否则整块界面会显示成「没有模型调用」。
 * @param {object} model - 宿主 models[] 里的一条。
 * @returns {string} 用于查 `byModel` 的键。
 */
function entryKeyOf(model) {
  if (typeof model?.key === 'string' && model.key !== '') return model.key
  return String(model?.model ?? '')
}

/**
 * 自定义单价编辑器：让用户**不改源码**就能给任意模型补一个官方价。
 *
 * ## 为什么需要这个入口
 *
 * 新模型发布得很勤，而「我用的模型没有价」的表现是它被标成「估算价」并按 Flash
 * 兜底折算——数字有、也不报错，只是错的。早先想改对，唯一的路是改源码再重新构建，
 * 那对使用者不是一个可用的入口。
 *
 * ## 两种改法，各给各的
 *
 *   - **在界面上加一条**：给常用的一两个模型补价，改完立刻生效；
 *   - **直接编辑文件**：一次补一批、或想放进版本管理，文件路径就显示在这里。
 *
 * 界面只做「整理输入 + 展示宿主回报的错误」，校验与落盘全在宿主那一侧——两处各写
 * 一份校验，迟早会出现「界面说没问题、宿主却拒绝」这种最难解释的分歧。
 * @param {object} props - pricing / ratesStatus / onSaved。
 * @returns {object} React 元素。
 */
function PriceEditor(props) {
  const { pricing, ratesStatus, onSaved } = props
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [draft, setDraft] = useState(() => ({ model: '', ...draftOf(undefined) }))

  const status = ratesStatus ?? {}
  const count = Number(status.count ?? 0)
  const customKeys = Object.keys(status.rates ?? {})
  const known = Object.keys(pricing?.rates ?? {})

  const update = useCallback((patch) => {
    setDraft((prev) => ({ ...prev, ...patch }))
    setError('')
    setOk('')
  }, [])

  const save = useCallback(() => {
    const model = String(draft.model ?? '').trim()
    if (model === '') { setError('请填模型键（例如 gpt-6-alstra）'); return }
    const entry = composeRate(draft)
    if (entry === undefined) {
      setError('至少填「未命中」或「输出」其中一个价，不然这条价没有意义')
      return
    }
    setSaving(true)
    setError('')
    // 与前一份**合并**再整份提交：宿主按整份替换，直接提交一条会把别的价全删掉。
    const next = { ...(status.rates ?? {}), [model]: entry }
    saveRates(next)
      .then((result) => {
        setOk(`已保存 ${model}，金额会立刻按新价重算`)
        setDraft({ model: '', ...draftOf(undefined) })
        onSaved?.(result)
      })
      .catch((cause) => { setError(String(cause?.message ?? cause)) })
      .finally(() => { setSaving(false) })
  }, [draft, status.rates, onSaved])

  const remove = useCallback((model) => {
    const next = { ...(status.rates ?? {}) }
    delete next[model]
    setSaving(true)
    setError('')
    saveRates(next)
      .then((result) => { setOk(`已移除 ${model}`); onSaved?.(result) })
      .catch((cause) => { setError(String(cause?.message ?? cause)) })
      .finally(() => { setSaving(false) })
  }, [status.rates, onSaved])

  const field = (key, label, hint) => h('label', { className: 'px-rate-field', title: hint },
    h('span', { className: 'px-rate-field-label' }, label),
    h('input', {
      type: 'text',
      inputMode: 'decimal',
      className: 'px-input',
      value: draft[key] ?? '',
      disabled: saving,
      onChange: (event) => { update({ [key]: event.target.value }) },
    }))

  return h('details', {
    className: 'px-details px-price-editor',
    open,
    onToggle: (event) => { setOpen(event.target.open) },
  },
  h('summary', null, '自定义单价', count > 0 ? h('span', { className: 'px-badge' }, `已加 ${count} 条`) : null),

  h('p', { className: 'px-muted px-note' },
    '价目表里没有的模型会被标成「估算价」并暂按 Flash 折算。在这里补一个官方价，'
    + '金额就会按它重算，也不必再改源码。',
    status.path === null || status.path === undefined
      ? '（本机的价目文件路径取不到，界面改动只在本进程内生效）'
      : h('span', null, ' 价目文件：', h('code', { className: 'px-mono' }, status.path))),

  status.error === undefined ? null : h('p', { className: 'px-balance-state px-error' }, `价目文件读取失败：${status.error}`),
  Array.isArray(status.errors) && status.errors.length > 0
    ? h('ul', { className: 'px-price-errors' }, status.errors.map((line) => h('li', { key: line }, line)))
    : null,

  count === 0 ? null : h('div', { className: 'px-rows' },
    customKeys.map((key) => h(Row, {
      key,
      label: key,
      value: h('span', { className: 'px-price-remove' },
        typeof status.rates?.[key]?.label === 'string' ? `${status.rates[key].label} · ` : '',
        h('button', {
          type: 'button',
          className: 'px-btn small',
          disabled: saving,
          onClick: () => { remove(key) },
        }, '移除')),
    }))),

  // ── 新增一条：模型键 + 三个档位（每档可填空闲 / 高峰两个数）──────────
  h('div', { className: 'px-price-form' },
    h('label', { className: 'px-rate-field', title: '与 DSH 里显示的模型名一致即可，大小写与分隔符都能对上' },
      h('span', { className: 'px-rate-field-label' }, '模型键'),
      h('input', {
        type: 'text',
        className: 'px-input',
        placeholder: '例如 gpt-6-alstra',
        value: draft.model ?? '',
        disabled: saving,
        onChange: (event) => { update({ model: event.target.value }) },
      })),
    h('label', { className: 'px-rate-field', title: '给用户看的名字；留空就用模型键' },
      h('span', { className: 'px-rate-field-label' }, '显示名'),
      h('input', {
        type: 'text',
        className: 'px-input',
        placeholder: '例如 GPT-6 Alstra',
        value: draft.label ?? '',
        disabled: saving,
        onChange: (event) => { update({ label: event.target.value }) },
      })),
    h('label', { className: 'px-rate-field', title: '厂商名，只用于展示' },
      h('span', { className: 'px-rate-field-label' }, '厂商'),
      h('input', {
        type: 'text',
        className: 'px-input',
        placeholder: '例如 OpenAI',
        value: draft.vendor ?? '',
        disabled: saving,
        onChange: (event) => { update({ vendor: event.target.value }) },
      })),
    h('div', { className: 'px-rate-pairs' },
      h('div', { className: 'px-rate-pair' },
        h('b', null, '缓存命中'),
        field('cacheHitIdle', '空闲', '缓存命中输入的单价'),
        field('cacheHitPeak', '高峰', '缓存命中输入的单价；与空闲填一样的数就是不分时')),
      h('div', { className: 'px-rate-pair' },
        h('b', null, '未命中'),
        field('cacheMissIdle', '空闲', '缓存未命中输入的单价'),
        field('cacheMissPeak', '高峰', '缓存未命中输入的单价；与空闲填一样的数就是不分时')),
      h('div', { className: 'px-rate-pair' },
        h('b', null, '输出'),
        field('outputIdle', '空闲', '输出 token 的单价'),
        field('outputPeak', '高峰', '输出 token 的单价；与空闲填一样的数就是不分时'))),

    error === '' ? null : h('p', { className: 'px-balance-state px-error' }, error),
    ok === '' ? null : h('p', { className: 'px-balance-state px-ok' }, ok),

    h('div', { className: 'px-price-actions' },
      h('button', { type: 'button', className: 'px-btn small primary', disabled: saving, onClick: save },
        saving ? '保存中…' : '保存这一条'),
      h('button', {
        type: 'button',
        className: 'px-btn small',
        disabled: saving,
        onClick: () => { setDraft({ model: '', ...draftOf(undefined) }); setError(''); setOk('') },
      }, '清空'))))
}
/**
 * 费用明细表：逐条目列出用量与金额，并在表下给出单价来源。
 *
 * 两种口径要分开表达，否则会误导：
 *   - **分时**（DeepSeek）逐条列出高峰 / 空闲 token 与「空闲 / 高峰」双档单价；
 *   - **不分时**（智谱 GLM 等）高峰与空闲同价，因此**只显示一列 token**、
 *     单价也只写一个值——硬摆一对相同的「空闲 / 高峰」数字纯属噪音。
 *
 * ## 表头与单元格必须**逐行**对齐（踩过的坑）
 *
 * 分时与不分时是**逐条**判定的，因此表头只能有两种形态，且必须与每一行的
 * 单元格数一致。早先表头按「有没有不分时的条目」二选一，而行是按自己的
 * `flat` 标志决定要不要多画一格——于是只要有一行判错（GLM 因为查不到价目
 * 回落成 Flash 价，被误判成分时），整张表从那一行起就错位：金额落进了
 * 「空闲 token」那一列，表头少一个，用户看到的就是「金额列也是用量」。
 * 现在两侧都走同一份 `columns`，构造上不可能再错位。
 * @param {object} props - models / rangeByModel / pricing / rangeCost / split / rangeLabel。
 * @returns {object} React 元素。
 */
function CostTable(props) {
  const { models, rangeByModel, pricing, rangeCost, split, rangeLabel, ratesStatus, onRatesSaved } = props
  const rows = models
    .map((model, index) => {
      const key = entryKeyOf(model)
      const usage = rangeByModel[key]
      if (usage === undefined) return null
      // 价目优先用宿主**逐条**交下来的那一份（含 GLM 这类原生 id 查不到的情况），
      // 拿不到才退回整张价目表。
      const rates = model.rates ?? ratesFor(pricing, key)
      return {
        key,
        model: model.model ?? key,
        label: model.label,
        provider: typeof model.provider === 'string' ? model.provider : '',
        providerLabel: typeof model.providerLabel === 'string' ? model.providerLabel : '',
        rollup: typeof model.rollup === 'string' ? model.rollup : key,
        // 这一条合并了哪些路由 id，悬停可查（同一个模型在网关里有多个叫法是常态）
        routes: Array.isArray(model.routes) ? model.routes.filter((name) => typeof name === 'string') : [],
        rates,
        // 配色按**在 `models` 里的下标**取，与「模型分布」环图完全同源：
        // 两处若各按自己的过滤后下标取色，同一个条目会在两张图里显示成不同颜色。
        tone: TONES[index % TONES.length],
        // 不分时的模型 peak 与 idle 相同；按 peak 判定即可
        flat: Number(rates.cacheMiss?.peak ?? 0) === Number(rates.cacheMiss?.idle ?? 0)
          && Number(rates.output?.peak ?? 0) === Number(rates.output?.idle ?? 0),
        // 宿主标注的可信度：兜底价要显式说明，别让猜的数字看起来像官方价
        priced: model.priced !== false,
        tiered: model.tiered === true,
        vendor: model.vendor ?? '',
        cost: priceByModel({ [key]: usage }, pricing),
        peak: peakTokensOf(usage),
        idle: idleTokensOf(usage),
        total: Number(usage.local ?? 0),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')

  // 分时与不分时逐条判定，因此表格允许「逐行不同」：
  // 不分时的条目自己只出 1 列 token，分时的条目出 2 列，合计行按有没有分时条目决定。
  const anyTiered = rows.some((row) => row.tiered)
  const anyUnpriced = rows.some((row) => !row.priced)
  const anyUnknownProvider = rows.some((row) => row.provider === '')

  /**
   * 单价按**模型**归组，而不是逐条（逐提供商）重复列出。
   *
   * 依据是一个事实：**价目表本身就按模型索引**（`MODEL_RATES` 的键里没有提供商，
   * 见 lib/pricing.js）。同一个模型走四条路由，`rates` 是**同一份对象**——
   * 实测本机 4 条 `deepseek-flash` 的单价逐字相同，却把
   * 「缓存命中 ¥0.02 / ¥0.04 · 未命中 ¥1 / ¥2 · 输出 ¥4 / ¥8」整整重复了 4 遍。
   * 数字一样、单位一样、厂商一样，唯一的差别在**用量**上——而用量在上面的表里。
   *
   * 归组键取 `rollup`（价目表的键），不是「价格数字相同」：后者会把两个
   * 恰好同价的**不同模型**并成一条，抹掉模型名。
   *
   * 组内**保留每一个提供商的色块**：色块与「模型分布」环图同源（见 row.tone），
   * 每个提供商在环图里占一片，因此这里也必须一个不少，否则图例就对不上号了。
   */
  const rateGroups = []
  const rateGroupIndex = new Map()
  for (const row of rows) {
    const groupKey = row.rollup === '' ? row.key : row.rollup
    const found = rateGroupIndex.get(groupKey)
    if (found === undefined) {
      rateGroupIndex.set(groupKey, { key: groupKey, first: row, rows: [row] })
      rateGroups.push(rateGroupIndex.get(groupKey))
    } else {
      found.rows.push(row)
    }
  }

  return h('div', null,
    h('div', { className: 'px-table-wrap' },
      h('table', { className: 'px-table px-cost-table' },
        h('thead', null,
          h('tr', null,
            h('th', null, '模型'),
            h('th', null, '提供商'),
            h('th', { className: 'px-num' }, '高峰 token'),
            h('th', { className: 'px-num' }, '空闲 token'),
            h('th', { className: 'px-num' }, `${rangeLabel}金额`))),
        h('tbody', null,
          rows.map((row) => {
            // 不分时：高峰与空闲同价，两个分档 token 合成一列避免出现「0」
            const peak = row.flat ? row.total : row.peak
            const idle = row.flat ? null : row.idle
            return h('tr', { key: row.key },
              h('td', null,
                h('b', null, row.label),
                // 归一后的模型键；合并了多个路由 id 时悬停能看到它们本来的名字
                h('span', {
                  className: 'px-muted px-mono',
                  title: row.routes.length > 1 ? `合并的路由 id：${row.routes.join('、')}` : undefined,
                }, ` ${row.rollup}`),
                row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
                row.tiered ? h('span', { className: 'px-badge' }, '按最低档') : null),
              h('td', null, row.provider === ''
                ? h('span', { className: 'px-muted', title: '旧账本记录里没有提供商信息' }, '来源未知')
                : (row.providerLabel === '' ? row.provider : row.providerLabel)),
              h('td', { className: 'px-num' }, formatTokens(peak)),
              // 不分时的那一格写成「—」而不是留空：留空会让人以为数据丢了
              h('td', { className: 'px-num' }, idle === null ? h('span', { className: 'px-muted' }, '—') : formatTokens(idle)),
              h('td', { className: 'px-num' }, formatCny(row.cost.standard)))
          }),
          h('tr', { className: 'px-row-total' },
            h('td', null, '合计'),
            h('td', null, ''),
            h('td', { className: 'px-num' }, formatTokens(split.peak)),
            h('td', { className: 'px-num' }, formatTokens(split.idle)),
            h('td', { className: 'px-num' }, formatCny(rangeCost.standard)))))),
    h('div', { className: 'px-rate-list' },
      // 表头：把单位和「空闲 / 高峰」的顺序**说一次**，下面每一行就不必重复，
      // 也省掉「¥0.02 / ¥0.04 哪个是哪个」的歧义。
      h('div', { className: 'px-rate-caption' },
        h('span', null, '各模型官方单价'),
        h('span', { className: 'px-rate-unit' }, '元 / 百万 token · 空闲 / 高峰')),
      rateGroups.map((group) => {
        const row = group.first
        /**
         * 这一行用**价目表里的官方模型名**，而不是 `row.label`。
         *
         * `row.label` 是 **DSH 设置里那条路由的外显名**，逐提供商不同：同一个
         * `deepseek-flash` 在 WorkBuddy 下叫「DeepSeek Flash」、在 commandcode 下叫
         * 「COD-DeepSeek V4.1 Flash」。若直接取 `group.first.label`，显示的就是
         * 「按用量排序碰巧排第一的那个提供商给它的名字」——价格明明是模型的属性，
         * 却被贴上某一家的叫法，换个窗口就会变。
         *
         * 兜底价（不在价目表里）例外：那时 `rates` 是 Flash 的兜底条目，
         * `rates.label` 会把它误标成「DeepSeek Flash」，所以退回它自己的名字。
         */
        const officialLabel = row.priced && typeof row.rates?.label === 'string' && row.rates.label !== ''
          ? row.rates.label
          : row.label
        return h('div', { key: `rate-${group.key}`, className: 'px-rate' },
          // 左列：色块 + 模型名 + 归一后的键。价格本身与提供商无关，
          // 色块只是让读者能把这一行对回到上面的用量行。
          h('span', { className: 'px-rate-who' },
            h('span', { className: 'px-rate-tones' },
              group.rows.map((item) => h('i', {
                key: item.key,
                className: `px-rate-swatch ${toneFill(item.tone)}`,
                title: item.providerLabel === '' ? '来源未知' : item.providerLabel,
              }))),
            h('b', null, officialLabel),
            h('span', { className: 'px-muted px-mono' }, group.key),
            row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
            // 哪几家的用量落在这个模型上：只在多家时才点出来，一家时是废话
            group.rows.length > 1
              ? h('span', { className: 'px-muted' }, `${group.rows.length} 个来源`)
              : null),
          h('span', { className: 'px-rate-prices' },
            h('span', null,
              h('em', null, '缓存命中'),
              h('code', null, row.flat
                // 不分时：只写一个价，不要摆一对相同的数字
                ? `¥${row.rates.cacheHit.peak}`
                : `¥${row.rates.cacheHit.idle} / ¥${row.rates.cacheHit.peak}`)),
            h('span', null,
              h('em', null, '未命中'),
              h('code', null, row.flat
                ? `¥${row.rates.cacheMiss.peak}`
                : `¥${row.rates.cacheMiss.idle} / ¥${row.rates.cacheMiss.peak}`)),
            h('span', null,
              h('em', null, '输出'),
              h('code', null, row.flat
                ? `¥${row.rates.output.peak}`
                : `¥${row.rates.output.idle} / ¥${row.rates.output.peak}`))))
      })),
    h(PriceEditor, { pricing, ratesStatus, onSaved: onRatesSaved }),

    h('p', { className: 'px-muted px-note' },
      // 口径必须写清楚，否则用户会把「按官方价估算」误读成「我的实际账单」。
      // 说「各模型的官方价」而不是「DeepSeek 官方价」：表里既有 DeepSeek 也有
      // 智谱 GLM 的行，后者的官方价来自智谱，不是 DeepSeek。
      `金额口径：按各模型官方公布的单价估算，即“这些 token 若全部走官方 API 需要花多少钱”。`
      + `第三方中转与 Coding Plan 是事先一次性买断的订阅，不按 token 计费，因此不在此列。`,
      `单价单位元 / 百万 token；写成一个值的模型不分时（高峰与空闲同价），`
      + `写成两个值的按「空闲 / 高峰」分档。`,
      `${rangeLabel}内若全部落在空闲时段可省 ${formatCny(rangeCost.saved)}。`,
      anyTiered ? '标「按最低档」的模型官方按输入长度分档定价，这里只按最低档估算。' : '',
      anyUnpriced ? '标「估算价」的模型不在价目表里，暂按 Flash 单价估算，仅供参考。' : '',
      anyUnknownProvider
        ? '标「来源未知」的条目来自旧版账本——那时的记录没有提供商字段。'
          + '重新导入本机会话日志后，新旧记录会合并到同一个「模型 × 提供商」条目下。'
        : ''))
}

/**
 * 会话清单表。
 *
 * ## 为什么第一列是**标题**而不是会话 id
 *
 * 侧栏任务栏显示的是 DSH 的 `displayTitle`（持久标题 → 工作目录末段 → 会话 id）。
 * 早先这里显示 `session.id.slice(8, 16)`，用户看到的是一串十六进制，没有任何办法
 * 把它和侧栏里任何一个会话对上号——「会话清单」因此变成了一份读不懂的清单。
 * 宿主现在把同一条回落链算好的标题放进 `session.title`，这里直接用它。
 *
 * ## 工作区列并进了第一列
 *
 * 标题**本身就可能是工作目录末段**（新建会话还没生成标题时就是这样）。
 * 单开一列会让同一行左右各写一遍同样的字。这里改成：标题为主、工作区只在
 * **与标题不同**时以次要样式跟在后面，于是省掉一整列宽度。
 *
 * ## 旧宿主回落
 *
 * 旧宿主不返回 `session.title`。那时按 DSH 的同一条链退回**工作目录末段**，
 * 最后才是会话 id 片段——而不是显示空白，也不是一上来就退回十六进制。
 * 降级必须可见且**可用**。
 *
 * 导出是为了让渲染闸门能直接渲染它：会话清单**默认收起**，因此整页静态渲染
 * 里根本到不了这张表（见 `Collapse` 与 `Panel` 的说明），不导出就等于这一列
 * 永远没有被断言过。
 * @param {object} props - sessions / timezone。
 * @returns {object} React 元素。
 */
function SessionTable(props) {
  const { sessions, timezone } = props
  if (sessions.length === 0) return h('p', { className: 'px-muted' }, '还没有会话记录。')
  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table px-session-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, '会话'),
          h('th', null, '模型'),
          h('th', null, '轮次'),
          h('th', null, 'Token'),
          h('th', null, '开始时间'))),
      h('tbody', null,
        sessions.slice(0, 40).map((session) => {
          const shortId = `${String(session.id).slice(8, 16)}…`
          const workspace = typeof session.workspace === 'string' ? session.workspace : ''
          const raw = typeof session.title === 'string' ? session.title.trim() : ''
          // 与 DSH 侧栏的 `displayTitleOf` 同一条回落链：持久标题 → 工作目录末段
          // → 会话 id。宿主已经算好了同样的链，这里再走一遍是为了**旧宿主**——
          // 它不返回 `title`，只有 `workspace`；那时至少显示目录名（用户认得出），
          // 而不是退回一串十六进制。链的顺序必须一致，否则两处显示的名字对不上。
          const title = raw !== '' ? raw : (workspace !== '' ? workspace : shortId)
          // 标题等于工作区名时不重复写第二遍（见函数说明）。
          const showWorkspace = workspace !== '' && workspace !== title
          return h('tr', { key: session.id },
            h('td', { className: 'px-session-cell' },
              h('span', { className: 'px-session-title', title: `${title}\n${session.id}` }, title),
              session.live ? h('span', { className: 'px-badge ok' }, '进行中') : null,
              showWorkspace
                ? h('span', { className: 'px-session-workspace', title: session.cwd ?? '' }, workspace)
                : null,
              // 会话 id 仍然可查（悬停可见、复制得到）：它是对日志与账本的
              // 唯一稳定标识，排查问题时要用，只是不该占着最显眼的位置。
              h('span', { className: 'px-session-id px-mono', title: session.id }, shortId)),
            h('td', null, session.models.join(', ') || '—'),
            h('td', null, String(session.turns)),
            h('td', null, formatTokens(session.totals.local)),
            h('td', null, formatDateTime(session.createdAt, timezone)))
        }))))
}

			exports.Dashboard = Dashboard
			exports.View = View
			exports.PlansPanel = PlansPanel
			exports.SessionTable = SessionTable
		},
		"./entry.js": (exports, require) => {
			const m1 = require("./dashboard.js")
			const m2 = require("./Notifier.js")
			const m3 = require("./period.js")
			const m4 = require("./SessionCost.js")
			const m5 = require("./theme.js")
			/**
 * dsh-pixel-dashboard 的浏览器半边：
 * 1) 装载视觉系统样式表；
 * 2) 注册「奶油·昼 / 暮色·夜」两套主题到外观设置；
 * 3) 在侧栏面板列表与主区注册用量看板。
 *
 * 所有副作用都挂在插件 fiber 上（ctx.effect），停止插件即完整回滚。
 * @module dsh-pixel-dashboard/client/entry
 */

const React = require('react')
const createPortal = require('react-dom').createPortal
const Dashboard = m1.Dashboard
const installNotifier = m2.installNotifier
const notifyStore = m2.notifyStore
const PeriodDot = m3.PeriodDot
const panelEntryLayout = m3.panelEntryLayout
const periodTitle = m3.periodTitle
const usePeriodPhase = m3.usePeriodPhase
const COST_ENTRY_ID = m4.COST_ENTRY_ID
const COST_ENTRY_ORDER = m4.COST_ENTRY_ORDER
const SessionCost = m4.SessionCost
const PALETTE_OVERRIDES = m5.PALETTE_OVERRIDES
const PIXEL_THEMES = m5.PIXEL_THEMES
const STYLES = m5.STYLES
const { createElement: h, useEffect, useRef, useState } = React

/** 插件标识，同时用作样式标签与主题来源名。 */
const PACKAGE_ID = 'dsh-pixel-dashboard'

/** 侧栏面板与主区共用同一个 id：侧栏按钮靠它选中主区面板。 */
const PANEL_ID = 'pixel-usage'

/** 令牌覆盖层的来源标识，一个 source 只保留一层。 */
const PALETTE_SOURCE = `${PACKAGE_ID}/palette`

/**
 * 认「产品那一行」的宽度下限（px）。
 *
 * 只有 ≥ 这个宽度的祖先才可能是 panelRow。图标槽本身只有十几像素，
 * 因此这条判据能把「图标槽」与「整行」区分开——它是**兜底**判据，
 * 主判据是「不是我们自己渲染的按钮」（见 {@link usePanelRow}）。
 *
 * 取 120：侧栏展开时那一行有 200px 以上，收起成图标条时只有 36px 左右
 * （那时本来也不显示倒计时），中间没有别的可能值。
 */
const ROW_MIN_WIDTH = 120

/** 挂上全部样式表，返回卸载函数。 */
function installStyles() {
  const tags = []
  for (const [name, css] of STYLES) {
    const tag = document.createElement('style')
    tag.dataset.plugin = PACKAGE_ID
    tag.dataset.pluginCss = `${PACKAGE_ID}/${name}`
    tag.textContent = css
    document.head.appendChild(tag)
    tags.push(tag)
  }
  return () => {
    for (const tag of tags) tag.remove()
  }
}

/**
 * 侧栏面板图标：像素柱状图，与看板顶栏标记同一套形状语言。
 * @param {object} props - size 与 active 由侧栏面板行提供。
 * @returns {object} React 元素。
 */
function PanelIcon(props) {
  const size = Number(props.size ?? 18)
  const bars = [
    { x: 3.6, y: 11.4 },
    { x: 8.2, y: 7.4 },
    { x: 12.8, y: 3.4 },
  ]
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 20 20',
      'aria-hidden': 'true',
      style: { display: 'block' },
    },
    bars.map((bar, index) =>
      h('rect', {
        key: index,
        x: bar.x,
        y: bar.y,
        width: 3.6,
        height: 15.4 - bar.y,
        rx: 1.1,
        fill: 'currentColor',
        opacity: props.active ? 0.95 : 0.5 + index * 0.12,
      })),
  )
}

/**
 * 找到面板行里那个**产品的 row 元素**，把时段倒计时 portal 进去。
 *
 * ## 为什么必须这样做（而不是在插槽内部定位）
 *
 * 产品那一行是它自己渲染的 `[图标槽][标题]`，而我们的插槽**只占图标槽**。
 * 图标槽是内容宽度（十几像素），于是：
 *   - 我们那层 `width: 100%` 的按钮量到的只有图标那么宽；
 *   - 任何 `right: Npx` 都只在图标那一小块里生效，文字怎么也离不开图标。
 *
 * 所以改成：把倒计时 portal 进产品的 row 元素，让它成为**标题的兄弟节点**，
 * 自然落在「用量看板」右边；行宽也从这里量，档位判定才准。
 *
 * ## 认 row 的判据：**必须排除我们自己那个按钮**
 *
 * 这里踩过一次坑，值得写清楚。我们自己渲染了一个 `<button>`（那颗图标所在的
 * 可点区域），而它**套在产品的 row 按钮里面**。于是 `node.closest('button')`
 * 命中的是**我们自己**的按钮，而不是产品那一行：量到的宽度只有十几像素 →
 * 档位判定成 `none` → **倒计时什么都不显示**，且完全不报错。
 *
 * 因此判据是「往上走，取第一个 `<button>` 祖先，但跳过我们自己那个」。
 * 产品的面板行本身就是一个 `<button>`（ui-sidebar 的 `PanelRow`），
 * 所以这条判据是**结构事实**，与布局、动画、首帧宽度都无关。
 *
 * 产品换了实现（那一行不再是 button）时退回按宽度认行——那只是兜底，
 * 因为宽度在首帧 / 收起动画途中可能是 0。
 * @param {object} ref - 指向我们自己根节点的 ref。
 * @param {object} ownRef - 指向我们自己渲染的那个 `<button>` 的 ref。
 * @returns {{host:Element|null,rowWidth:number}} 落点与整行宽度。
 */
function usePanelRow(ref, ownRef) {
  const [host, setHost] = useState(null)
  const [rowWidth, setRowWidth] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (node === null || node === undefined) return undefined

    /**
     * 认 row：第一个不是我们自己的 `<button>` 祖先。
     * @returns {Element|null} row 元素。
     */
    const findRow = () => {
      const own = ownRef?.current ?? null
      let candidate = node.parentElement ?? null
      let wideEnough = null
      for (let depth = 0; candidate !== null && depth < 8; depth += 1) {
        // 主判据：跳过我们自己那个按钮，取产品那一行
        if (candidate !== own && String(candidate.tagName).toUpperCase() === 'BUTTON') {
          return candidate
        }
        // 兜底：产品那一行不再是 button 时，记下第一层够宽的祖先
        if (wideEnough === null) {
          const width = Number(candidate.getBoundingClientRect?.().width ?? 0)
          if (width >= ROW_MIN_WIDTH) wideEnough = candidate
        }
        candidate = candidate.parentElement ?? null
      }
      return wideEnough
    }

    const sync = () => {
      const row = findRow()
      setHost((prev) => (prev === row ? prev : row))
      const width = Number(row?.getBoundingClientRect?.().width ?? 0)
      setRowWidth((prev) => (Math.abs(prev - width) < 0.5 ? prev : width))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    // 观察我们自己的节点即可：侧栏收放时它的祖先宽度变化会带动它的尺寸变化。
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [ref, ownRef])

  return { host, rowWidth }
}

/**
 * 侧栏面板行的**纯展示层**：柱状图图标，以及独立的时段指示环。
 *
 * 拆出来是为了能被渲染闸门直接断言。两部分刻意分开渲染：
 *   - 图标留在插槽里（产品给我们的是图标槽）；
 *   - 环由容器 portal 到产品的 **row 元素**里，因此它是标题的**兄弟节点**，
 *     排在「用量看板」四个字的右边。
 *
 * 排版规则见 {@link panelEntryLayout}：宽行显示「环 + 倒计时」，中等宽度只显示环，
 * 窄行（侧栏收起）把环叠回图标角上。
 *
 * 闸门只渲染图标这一部分（`inline`/`corner` 的差异在 {@link PeriodDot} 里），
 * 因此这里保持无副作用，环的落点由容器决定。
 * @param {object} props - size / active。
 * @returns {object} React 元素。
 */
function PanelEntryView(props) {
  const { size, active } = props
  return h(PanelIcon, { size, active })
}

/**
 * 侧栏按钮：悬停微亮、按下微缩，点击切到看板面板，再点一次回到会话。
 *
 * 时段指示环通过 portal 挂到产品的 row 元素上，排在按钮**之后**，因此显示在
 * 「用量看板」四个字的右边。这样做是因为产品只把图标槽给了我们，靠插槽内部
 * 的定位永远到不了标题右边（详见 {@link usePanelRow}）。
 * @param {object} ctx - 插件上下文，用于取 layout 服务。
 * @returns {Function} 组件。
 */
function panelEntry(ctx) {
  return function PanelEntry(props) {
    const active = props.active === true
    const [hover, setHover] = useState(false)
    const [press, setPress] = useState(false)
    const rootRef = useRef(null)
    // 我们自己渲染的那个按钮：认 row 时必须把它排除掉（见 usePanelRow）
    const ownRef = useRef(null)
    // 相位在这里取：一个面板行只有一个，且按钮在应用生命周期内常驻，
    // 因此轮询不会随会话切换反复重建。
    const phase = usePeriodPhase()
    const { host, rowWidth } = usePanelRow(rootRef, ownRef)
    const layout = panelEntryLayout({ rowWidth })
    const onClick = () => {
      const layoutService = ctx.get('layout')
      if (layoutService === undefined) return
      try {
        layoutService.selectPanel(active ? null : PANEL_ID)
      } catch {
        // 主区面板尚未注册完成时忽略这一次点击，下次渲染即可用。
      }
    }

    // 倒计时文字：portal 进产品 row；拿不到 row（服务端渲染 / 结构变了）时退回
    // 渲染在插槽内——位置不如理想，但仍然看得见，不会凭空消失。
    const caption = h(PeriodDot, {
      phase,
      placement: layout.placement,
    })
    const portaled = host !== null && typeof createPortal === 'function'
      ? createPortal(caption, host)
      : caption

    return h(
      React.Fragment,
      null,
      h(
        'button',
        {
          // 我们自己那颗按钮的 ref：认产品 row 时必须跳过它（见 usePanelRow）
          ref: ownRef,
          type: 'button',
          // 时段与倒计时只走 title（悬停提示）：aria-label 每秒都变会让读屏软件
          // 反复播报同一颗按钮，而这里真正要表达的只是「用量看板」这一个可操作目标。
          title: periodTitle(phase),
          'aria-label': '用量看板',
          'aria-pressed': active,
          onClick,
          onMouseEnter: () => { setHover(true) },
          onMouseLeave: () => { setHover(false); setPress(false) },
          onMouseDown: () => { setPress(true) },
          onMouseUp: () => { setPress(false) },
          style: {
            display: 'grid',
            placeItems: 'center',
            position: 'relative',
            width: '100%',
            height: 30,
            padding: 0,
            color: 'inherit',
            cursor: 'pointer',
            background: active || hover ? 'var(--px-surface-2)' : 'transparent',
            border: `1px solid ${active ? 'var(--px-line-2)' : 'transparent'}`,
            borderRadius: '9px',
            boxShadow: active ? 'var(--px-elev-1)' : 'none',
            transform: press ? 'scale(0.94)' : 'none',
            transition: 'background-color var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease), box-shadow var(--px-dur) var(--px-ease), transform var(--px-dur-fast) var(--px-ease)',
          },
        },
        // portal 落点的锚点：图标槽里的内容。
        h('span', { ref: rootRef, className: 'px-panel-entry' },
          h(PanelEntryView, { size: props.size, active })),
        // 拿不到 row 时倒计时留在这里，否则由上面的 portal 渲染。
        portaled === caption ? caption : null,
      ),
      portaled === caption ? null : portaled,
    )
  }
}

/**
 * 浏览器半边插件体。
 * @param {object} ctx - 客户端 Cordis 上下文。
 * @returns {void}
 */
function apply(ctx) {
  ctx.effect(() => installStyles(), 'pixel-dashboard: 样式表')

  // 通知运行时**尽早**启动，且不依赖任何槽位：提醒必须在用户没打开看板时也在工作，
  // 而下面的 `slots` 缺失（旧宿主、或槽位服务尚未就绪）会让 apply 直接 return。
  // 这正是「装了却收不到提醒」最容易发生的形态，所以把它放在 return 之前。
  //
  // 面板与它之间通过 notifyStore() 这个模块级单例共享快照，不经过 Cordis 服务：
  // 多提供一个服务意味着多一个「服务没就绪」的失败面，而这里两者本就在同一个
  // 包内、同一个 fiber 上，没有解耦的必要。
  installNotifier(ctx, notifyStore())

  const theme = ctx.get('theme')

  // 默认就把配色换上：叠一层令牌覆盖在当前主题之上（不改注册表、不动用户偏好）。
  // 这是关键——注册成可选主题需要用户自己去“设置 → 外观”切换，绝大多数人不会去，
  // 结果就是插件装了但配色没生效。
  if (theme !== undefined) {
    applyPalette(ctx, theme)

    // 可选主题仍然注册：想要固定深/浅色的用户可以在外观设置里显式选它。
    ctx.effect(() => {
      const disposers = [
        theme.register({
          id: PIXEL_THEMES.day.id,
          colorScheme: PIXEL_THEMES.day.colorScheme,
          tokens: PIXEL_THEMES.day.tokens,
        }),
        theme.register({
          id: PIXEL_THEMES.night.id,
          colorScheme: PIXEL_THEMES.night.colorScheme,
          tokens: PIXEL_THEMES.night.tokens,
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'pixel-dashboard: 可选主题')
  }

  const slots = ctx.get('slots')
  if (slots === undefined) return

  slots.inject('main', () => slots.register(
    { name: 'main', key: PANEL_ID },
    () => h(Dashboard),
  ))

  slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: '用量看板' },
    panelEntry(ctx),
  ))

  // 输入框下方的本次会话费用条：session 作用域，跟随当前会话显示金额。
  slots.inject('conversation.composer.dock', () => slots.register(
    { name: 'conversation.composer.dock', id: COST_ENTRY_ID, order: COST_ENTRY_ORDER },
    SessionCost,
  ))
}

/**
 * 默认就把配色换上：叠一层令牌覆盖在当前主题之上（不改注册表、不动用户偏好）。
 *
 * 这一层同时带明暗两套取值，主题服务按当前生效方案挑选，因此明暗切换
 * 自身完成——不要再监听 theme/change 重下：overrideTokens 会同步 emit
 * 同一个事件，监听器里再调用它就变成无限递归（栈溢出）。
 * @param {object} ctx - 客户端 Cordis 上下文。
 * @param {object} theme - 客户端 theme 服务。
 * @returns {void}
 */
function applyPalette(ctx, theme) {
  ctx.effect(
    () => theme.overrideTokens(PALETTE_SOURCE, PALETTE_OVERRIDES),
    'pixel-dashboard: 默认配色',
  )
}

			exports.PanelEntryView = PanelEntryView
			exports.apply = apply
		},
		}
		const cache = {}
		// 本地注册表只认本插件拆分出的模块；其余裸包名（react 等）必须交回
		// factory 收到的平台 require，否则会在浏览器里抛 "unknown module react"。
		function load(id) {
			if (cache[id] !== undefined) return cache[id]
			const definition = MODULES[id]
			if (definition === undefined) return platformRequire(id)
			const exports = {}
			cache[id] = exports
			definition(exports, load)
			return exports
		}
		return load('./entry.js')
	},
})
