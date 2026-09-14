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
 * token 数按中文习惯缩略。
 * @param {number} value - token 数。
 * @returns {string} 形如 `1.23 亿`。
 */
function formatTokens(value) {
  const amount = Number(value ?? 0)
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)} 亿`
  if (amount >= 100_000) return `${(amount / 10_000).toFixed(1)} 万`
  if (amount >= 10_000) return `${(amount / 10_000).toFixed(2)} 万`
  return String(Math.round(amount))
}

/**
 * 毫秒差格式化为倒计时文本。
 * @param {number} ms - 剩余毫秒。
 * @returns {string} 形如 `3 小时 12 分 05 秒`。
 */
function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms ?? 0) / 1000))
  const pad = (value) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} 小时 ${pad(minutes)} 分 ${pad(seconds)} 秒`
  if (minutes > 0) return `${minutes} 分 ${pad(seconds)} 秒`
  return `${seconds} 秒`
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
			exports.formatTokens = formatTokens
			exports.formatCountdown = formatCountdown
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
 * @param {object} pricing - 宿主的 pricing 段。
 * @param {string} model - 模型名（应为归一后的键）。
 * @returns {object} 价目条目。
 */
function ratesFor(pricing, model) {
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
 * 把窗口归一成界面要用的进度。
 *
 * 三条规则，都是为了让界面不撒谎：
 *   - 有 `usedPercent` 就直接用（宿主已经优先按绝对值算过）；
 *   - 只有百分比时也能画进度条，但标记 `estimated`，界面会说明「官方只给了百分比」；
 *   - 什么都没有时返回进度 0 且 `usable: false`，界面显示 `—` 而不是画一条空条。
 *
 * **百分比可以超过 100**（额度用超时官方会给出 >100 的值）。这里保留真实数值，
 * 只用 `barPercent` 给进度条夹一个 0–100 的宽度——否则 140% 会被显示成 100%，
 * 把「已严重超限」伪装成「刚好用满」。
 * @param {object} window - 宿主返回的窗口。
 * @returns {{usable:boolean,percent:number,barPercent:number,over:boolean,estimated:boolean,remainingText:string,totalText:string}} 进度。
 */
function windowProgress(window) {
  const usedPercent = Number(window?.usedPercent)
  const hasPercent = Number.isFinite(usedPercent)
  const hasAbsolute = Number.isFinite(Number(window?.used))
    && Number.isFinite(Number(window?.total))
  const hasRemaining = Number.isFinite(Number(window?.remaining))

  const unit = window?.unit ?? ''
  if (!hasPercent && !hasAbsolute && !hasRemaining) {
    return { usable: false, percent: 0, barPercent: 0, over: false, estimated: false, remainingText: '—', totalText: '—' }
  }
  const percent = hasPercent ? Math.max(0, usedPercent) : 0
  const remainingText = hasRemaining
    ? formatQuota(window.remaining, unit)
    : (hasAbsolute ? formatQuota(Number(window.total) - Number(window.used), unit) : '—')
  const totalText = Number.isFinite(Number(window?.total)) ? formatQuota(window.total, unit) : '—'
  return {
    usable: true,
    percent,
    // 进度条宽度单独夹取：条最多画满，但数字照实显示
    barPercent: Math.min(100, percent),
    over: percent > 100 || window?.exceeded === true,
    // 没有绝对值、只有百分比时，百分比本身可能被官方向下取整，标出来
    estimated: window?.percentOnly === true,
    remainingText,
    totalText,
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
 * @param {object|undefined} payload - 宿主负载。
 * @returns {{provider:string,window:object,percent:number}|undefined} 最紧窗口。
 */
function tightestWindow(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  let best
  for (const provider of providers) {
    if (provider?.ok !== true) continue
    for (const window of provider.windows ?? []) {
      const progress = windowProgress(window)
      if (!progress.usable) continue
      if (best === undefined || progress.percent > best.percent) {
        best = { provider: provider.name, window, percent: progress.percent }
      }
    }
  }
  return best
}

			exports.WINDOW_ORDER = WINDOW_ORDER
			exports.formatQuota = formatQuota
			exports.windowProgress = windowProgress
			exports.quotaTone = quotaTone
			exports.formatReset = formatReset
			exports.providerStatus = providerStatus
			exports.fetchPlans = fetchPlans
			exports.hasAnyQuota = hasAnyQuota
			exports.tightestWindow = tightestWindow
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
const CLIENT_VERSION = 'f8ab29f1'

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
 * 活跃日历：一天一个方块，列为一周、行为星期几（GitHub 贡献图那种）。
 *
 * 这里刻意只画到「天」粒度。早先的版本想把 24 小时也塞进同一格，于是每格
 * 只有 0.4px 高、9px 宽，画出来自然是条形——一年 × 24 小时压不进一张图。
 *
 * 格子边长为整数且宽高相等：取整避免相邻格因浮点坐标产生 1px 细缝，
 * 等宽等高才保证是方块而不是条形。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
function ActivityCalendar(props) {
  const { firstDay, days, requests, sessions, tokens, maxRequests } = props
  const [tip, setTip] = useState(null)
  const [wrapRef, width] = useMeasuredWidth(900)

  const labelW = 26
  const gap = 3
  const weekCols = Math.max(1, Math.ceil(days / 7))
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

  const first = Date.parse(`${firstDay}T00:00:00Z`)
  const rects = []
  for (let day = 0; day < days; day += 1) {
    const weekday = new Date(first + day * 86_400_000).getUTCDay()
    const column = Math.floor(day / 7)
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
      ...monthTicks(first, days, labelW, slot, top),
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
        ? '每格 = 一天 · 颜色越深请求越多'
        : `${tipDate} · ${tip.value} 次请求 · ${tipSessions} 个会话 · ${tipTokens} tokens`),
  )
}

/**
 * 在每月一日所在列上方标出月份。
 * @param {number} first - 首日时间戳。
 * @param {number} days - 总天数。
 * @param {number} labelW - 左侧标签宽度。
 * @param {number} slot - 列距。
 * @param {number} top - 网格顶部 y。
 * @returns {object[]} 文本元素数组。
 */
function monthTicks(first, days, labelW, slot, top) {
  const labels = []
  let lastMonth = -1
  for (let day = 0; day < days; day += 1) {
    const date = new Date(first + day * 86_400_000)
    const month = date.getUTCMonth()
    if (month === lastMonth) continue
    lastMonth = month
    labels.push(h('text', {
      key: `m${month}-${day}`,
      x: labelW + Math.floor(day / 7) * slot,
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
.px-area { stroke: none; }
.px-hover-line { fill: var(--px-ink); opacity: 0.16; }
.px-dot { stroke: var(--px-surface); stroke-width: 2; }
.px-dot.px-tone-blue { fill: var(--px-tone-blue); }
.px-dot.px-tone-purple { fill: var(--px-tone-purple); }
.px-dot.px-tone-pink { fill: var(--px-tone-pink); }

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
.px-table th:first-child { border-top-left-radius: var(--px-r-sm); }
.px-table th:last-child { border-top-right-radius: var(--px-r-sm); }
.px-table tbody tr { transition: background-color var(--px-dur-fast) var(--px-ease); }
.px-table tbody tr:hover { background: color-mix(in srgb, var(--px-pink) 8%, transparent); }
.px-table tbody tr:last-child td { border-bottom: none; }
.px-row-total td { font-family: var(--px-num-font); font-weight: 600; background: color-mix(in srgb, var(--px-yellow) 18%, transparent); }

.px-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 12px; }
.px-grid-2 .px-panel { margin-bottom: 12px; }

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

/* 单价说明：竖排，避免挤在表格单元格里换行 */
.px-rate-list { display: grid; gap: 6px; margin-top: 12px; }
.px-rate {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: var(--px-r-sm);
  background: var(--px-surface-2);
  font-size: 11.5px; color: var(--px-muted);
}
.px-rate > b { color: var(--px-ink); font-size: 12px; }
.px-rate > span { font-variant-numeric: tabular-nums; }
.px-rate-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }

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
/* 拿不到费用时的告警态：不要在界面上装作一切正常 */
.px-pill-warn { background: color-mix(in srgb, var(--px-red) 14%, transparent); }
.px-pill-warn .px-pill-dot { background: var(--px-tone-red); }
.px-pill-warn .px-pill-value { color: var(--px-tone-red); }

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

/* 账户与套餐：并排两栏，各自内部紧凑排列（原来两张独立大面板太占地方） */
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
.px-plan {
  padding: 9px 11px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-md);
  background: var(--px-surface-2);
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

@media (max-width: 960px) {
  .px-period { grid-template-columns: 1fr; }
  /* 窄屏：并排的两块塌回单列，日历才不至于被压成一条 */
  .px-pair { grid-template-columns: 1fr; }
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
		"./SessionCost.js": (exports, require) => {
			const m1 = require("./balance.js")
			const m2 = require("./format.js")
			const m3 = require("./plans.js")
			const m4 = require("./usage.js")
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
const balanceSummary = m1.balanceSummary
const fetchBalance = m1.fetchBalance
const formatCny = m2.formatCny
const formatTokens = m2.formatTokens
const fetchPlans = m3.fetchPlans
const tightestWindow = m3.tightestWindow
const windowProgress = m3.windowProgress
const fetchDashboard = m4.fetchDashboard
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
 * 一枚徽标：图标点 + 标签 + 数值。视觉对齐产品的统计胶囊（13px、tertiary 文字、
 * 24px 圆角、悬停微微加深），因此并排时不显得是「外来的」。
 * @param {object} props - tone / label / value / title / warn。
 * @returns {object} React 元素。
 */
function Pill(props) {
  const { tone, label, value, title, warn } = props
  return h(
    'span',
    {
      className: `px-pill${warn === true ? ' px-pill-warn' : ''}`,
      title: title,
    },
    h('i', { className: `px-pill-dot${tone === undefined ? '' : ` px-tone-bg-${tone}`}` }),
    label === undefined ? null : h('span', { className: 'px-pill-label' }, label),
    h('b', { className: 'px-pill-value' }, value),
  )
}

/**
 * 徽标组：本次会话费用（+ 可选 token）、账户余额、最紧的套餐额度。
 *
 * 纯展示，无取数、无副作用；容器决定把它 portal 到产品统计行还是自渲染一行。
 * @param {object} props - cost / tokens / failed / balance / plans / showTokens。
 * @returns {object|null} React 元素。
 */
function SessionCostPills(props) {
  const { cost, tokens, failed, balance, plans, showTokens = true } = props

  const balanceText = balanceSummary(balance)
  // 套餐只显示**最紧**的那个窗口：用户真正关心「哪个快用完了」，
  // 把 5 小时 / 每周 / 每月都塞进这一行会挤成一团。
  const tightest = tightestWindow(plans)
  const tightPercent = tightest === undefined ? undefined : windowProgress(tightest.window).percent

  // 什么都没拿到、也不是失败：不渲染空壳。
  // 必须返回 null 而不是空元素：容器没有 gap，空元素会污染产品的间距节奏。
  if (cost === undefined && failed !== true && balanceText === undefined && tightest === undefined
    && (tokens === undefined || tokens === 0)) return null

  const detail = cost === undefined
    ? (failed === true ? '宿主未提供该会话的费用数据' : '正在按分档单价折算')
    : `高峰 ${formatCny(cost.peak ?? 0)} · 空闲 ${formatCny(cost.idle ?? 0)}`
  const balanceDetail = balanceText === undefined ? '' : `｜账户余额 ${balanceText}`
  const quotaDetail = tightest === undefined
    ? ''
    : `｜${tightest.provider} ${tightest.window.label}已用 ${tightest.percent.toFixed(1)}%`

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
      title: `${detail}${balanceDetail}${quotaDetail}｜空闲价 = 高峰价的一半，金额为本地估算`,
    }),
    showTokens && tokens !== undefined && tokens > 0
      ? h(Pill, { tone: 'blue', value: `${formatTokens(tokens)} tokens` })
      : null,
    balanceText === undefined
      ? null
      : h(Pill, {
        tone: 'green',
        label: '余额',
        value: balanceText,
        title: `账户余额来自官方 /user/balance 接口，由本地宿主用 DSH 自己的 API Key 查询；`
          + `Key 不会离开本机${balance?.official === false ? '（当前端点不是官方公网地址）' : ''}`,
      }),
    tightest === undefined
      ? null
      : h(Pill, {
        // 超过 75% 转警戒色，与看板里的阈值保持一致
        tone: tightPercent >= 75 || tightest.window.exceeded === true ? 'red' : 'purple',
        label: tightest.window.label,
        value: `${tightest.percent.toFixed(0)}%`,
        title: `${tightest.provider} · ${tightest.window.label}额度已用 ${tightest.percent.toFixed(1)}%｜来自厂商内部接口，仅供参照`,
      }),
  )
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
  const pills = h(SessionCostPills, props)
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一行」
  const { cost, failed, balance, plans, tokens } = props
  if (cost === undefined && failed !== true && balanceSummary(balance) === undefined
    && tightestWindow(plans) === undefined && (tokens === undefined || tokens === 0)) return null

  return h('div', { className: 'px-cost-row' }, pills)
}

/**
 * 容器：取该会话的费用、余额与套餐额度，并决定渲染位置。
 * @param {object} props - 插槽提供的标准属性（含 sessionId 与 useProjection）。
 * @returns {object|null} React 元素。
 */
function SessionCost(props) {
  const sessionId = props.sessionId
  const [state, setState] = useState({ cost: undefined, failed: false, balance: undefined, plans: undefined })
  const anchor = useStatsAnchor()

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
          setState((prev) => ({ ...prev, cost: row?.cost, failed: row !== undefined && row.cost === undefined }))
        })
        .catch(() => {
          // 取数失败（宿主没起来 / 请求出错）也要明说，不静默停在「折算中」
          if (!cancelled) setState((prev) => ({ ...prev, cost: undefined, failed: true }))
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
  const totals = useMemo(() => totalsOf(usage), [usage])

  if (sessionId === undefined) return null

  const pills = h(SessionCostPills, {
    cost: state.cost,
    failed: state.failed,
    balance: state.balance,
    plans: state.plans,
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
			exports.SessionCostPills = SessionCostPills
			exports.SessionCostView = SessionCostView
			exports.SessionCost = SessionCost
		},
		"./dashboard.js": (exports, require) => {
			const m1 = require("./balance.js")
			const m2 = require("./plans.js")
			const m3 = require("./format.js")
			const m4 = require("./graph.js")
			const m5 = require("./usage.js")
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
const fetchPlans = m2.fetchPlans
const formatReset = m2.formatReset
const providerStatus = m2.providerStatus
const quotaTone = m2.quotaTone
const windowProgress = m2.windowProgress
const WINDOW_ORDER = m2.WINDOW_ORDER
const formatCountdown = m3.formatCountdown
const formatCny = m3.formatCny
const formatDateTime = m3.formatDateTime
const formatMinuteOfDay = m3.formatMinuteOfDay
const formatTokens = m3.formatTokens
const minuteOfDay = m3.minuteOfDay
const ActivityCalendar = m4.ActivityCalendar
const BarList = m4.BarList
const DonutChart = m4.DonutChart
const TrendChart = m4.TrendChart
const useCountUp = m4.useCountUp
const fetchDashboard = m5.fetchDashboard
const priceByModel = m5.priceByModel
const ratesFor = m5.ratesFor
const recentDays = m5.recentDays
const sumByModel = m5.sumByModel
const sumRows = m5.sumRows
const TONES = m5.TONES
const toneFill = m5.toneFill
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
  const { options, value, onChange } = props
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
    { className: 'px-seg', ref: listRef, role: 'tablist' },
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

/** 带色点标题的卡片外壳。 */
function Panel(props) {
  return h(
    'section',
    { className: 'px-panel px-rise', style: { animationDelay: `${props.delay ?? 0}ms` } },
    h('header', { className: 'px-panel-head' },
      h('span', { className: 'px-panel-title' },
        h('i', { className: `px-panel-dot px-tone-bg-${props.tone ?? 'pink'}` }),
        props.title),
      props.extra === undefined ? null : h('span', { className: 'px-panel-extra' }, props.extra)),
    h('div', { className: 'px-panel-body' }, props.children),
  )
}

/** 键值行。 */
function Row(props) {
  return h('div', { className: 'px-row' }, h('span', null, props.label), h('b', null, props.value))
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
  } = props
  const [rangeId, setRangeId] = useState('30')
  const range = RANGES.find((item) => item.id === rangeId) ?? RANGES[1]
  const period = usePeriod(data, now)

  const points = useMemo(() => recentDays(data.days, range.days), [data.days, range.days])
  const rangeTotals = useMemo(() => sumRows(points), [points])
  const rangeByModel = useMemo(() => sumByModel(points.map((point) => point.byModel)), [points])
  const rangeCost = useMemo(() => priceByModel(rangeByModel, data.pricing), [rangeByModel, data.pricing])
  const todayCost = useMemo(
    () => priceByModel(data.days.at(-1)?.byModel ?? {}, data.pricing),
    [data.days, data.pricing],
  )

  const overview = data.overview
  const activeInRange = points.filter((point) => Number(point.totals.requests) > 0).length
  const split = splitTokens(rangeByModel)
  const peakShare = split.peak + split.idle > 0 ? split.peak / (split.peak + split.idle) : 0

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
        tone: period.peak ? 'red' : 'green',
        delay: 220,
        extra: h('span', { className: `px-badge${period.peak ? '' : ' ok'}` },
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
        compact: true,
      }))),

    h(Panel, { title: `${range.label} Token 趋势`, tone: 'blue', delay: 300 },
      h(TrendChart, { points, series: SERIES, formatAxis: formatTokens, formatValue: formatTokens })),

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
        }))),

    h(Panel, {
      title: '会话清单',
      tone: 'blue',
      delay: 420,
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
      '，费用为本地估算，实际账单以服务商为准。'),
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
 * @param {object} props - win / now。
 * @returns {object} React 元素。
 */
function QuotaWindow(props) {
  const { win, now } = props
  const progress = windowProgress(win)
  const tone = quotaTone(progress.percent, progress.over)
  const reset = formatReset(win?.resetAt, now)
  const parts = []
  if (progress.remainingText !== '—') parts.push(`剩余 ${progress.remainingText}`)
  if (progress.totalText !== '—') parts.push(`总额 ${progress.totalText}`)
  if (reset !== undefined) parts.push(reset)
  if (progress.estimated) parts.push('官方只给了百分比')

  return h('div', { className: 'px-quota' },
    h('div', { className: 'px-quota-head' },
      h('span', { className: 'px-quota-name' }, win?.label ?? win?.window ?? '额度'),
      h('span', { className: `px-quota-percent px-tone-${tone}` },
        progress.usable ? `${progress.percent.toFixed(1)}%` : '—'),
      // 超限要明说：百分比 >100 时数字本身已经说明，但加一个徽标更醒目
      progress.over ? h('span', { className: 'px-badge' }, '已超限') : null),
    h('div', { className: 'px-quota-track' },
      h('span', {
        className: `px-quota-fill px-tone-bg-${tone}`,
        // 条宽用夹取值；数字用真值（见 windowProgress）
        style: { width: `${progress.barPercent}%` },
      })),
    parts.length === 0
      ? null
      : h('div', { className: 'px-quota-foot' }, parts.join(' · ')))
}

/**
 * 一家厂商的额度区块。
 * @param {object} props - provider / now。
 * @returns {object} React 元素。
 */
function ProviderQuota(props) {
  const { provider, now } = props
  const status = providerStatus(provider)
  const windows = WINDOW_ORDER
    .map((key) => (provider?.windows ?? []).find((win) => win.window === key))
    .filter(Boolean)

  return h('div', { className: 'px-plan' },
    h('div', { className: 'px-plan-head' },
      h('b', { className: 'px-plan-name' }, provider?.name ?? '未知厂商'),
      provider?.plan === undefined || provider.plan === '' ? null : h('span', { className: 'px-badge ok' }, provider.plan),
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
    windows.length === 0
      ? null
      : h('div', { className: 'px-quota-list' }, windows.map((win) => h(QuotaWindow, { key: win.window, win, now }))),
    provider?.endpoint === undefined
      ? null
      : h('p', { className: 'px-muted px-note' }, `数据源：${provider.endpoint}（未文档化的内部接口，可能随官方改动失效）`),
  )
}

/**
 * 订阅套餐额度面板：每家的各窗口进度 + 开关 + 隐私说明。
 *
 * 这里刻意**不做**任何金额换算：智谱的积分与 Command Code 的美元信用额是两套
 * 互不相通的单位，混在一起加总只会得到一个没有意义的数字。
 * @param {object} props - payload / error / busy / now / onToggle。
 * @returns {object} React 元素。
 */
function PlansPanel(props) {
  const { payload, error, busy, now, onToggle, compact } = props
  const enabled = payload?.enabled !== false
  const locked = payload?.lockedByEnv === true
  const providers = Array.isArray(payload?.providers) ? payload.providers : []

  return h('div', { className: compact === true ? 'px-account-col' : null },
    h('div', { className: 'px-balance-head' },
      h('div', { className: 'px-balance-total' },
        h('span', { className: 'px-balance-currency' }, '智谱（5 小时 / 每周）· Command Code（+ 每月）')),
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

    providers.length === 0
      ? null
      : h('div', { className: 'px-plan-list' }, providers.map((provider) => h(ProviderQuota, { key: provider.id, provider, now }))),

    // 充值 / 管理入口：看到额度快满时最自然的下一步
    h('p', { className: 'px-links' },
      h('a', { href: 'https://commandcode.ai/studio', target: '_blank', rel: 'noreferrer' }, 'Command Code 工作室 ↗'),
      h('span', { className: 'px-links-sep' }, '·'),
      h('a', { href: 'https://www.bigmodel.cn/coding-plan/personal/usage', target: '_blank', rel: 'noreferrer' }, '智谱套餐用量 ↗'),
      h('span', { className: 'px-links-sep' }, '·'),
      h('a', { href: 'https://console.volcengine.com/ark', target: '_blank', rel: 'noreferrer' }, '火山方舟控制台 ↗')),

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
        '上，要的是账号的 AccessKey ID / Secret Access Key（',
        h('b', null, '不是'),
        '方舟推理用的 ark- 开头的 Key，那把在网关会被直接拒绝），'
        + '请到火山引擎控制台「访问控制 → 访问密钥」创建，并配成 VOLC_ACCESS_KEY_ID 与 VOLC_SECRET_ACCESS_KEY。')),
  )
}

/** 模型分布：环图 + 条形占比（按当前时间窗口）。 */
function ModelBreakdown(props) {
  const { models, rangeByModel, rangeTotals } = props
  const rows = models.map((model, index) => {
    const usage = rangeByModel[model.model] ?? { local: 0 }
    const share = rangeTotals.local > 0 ? (Number(usage.local ?? 0) / rangeTotals.local) * 100 : 0
    return {
      key: model.model,
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
        `共 ${models.length} 个模型 · 用量最多：${models[0]?.label ?? '—'}`)))
}

/**
 * 费用明细表：逐模型列出用量与金额，并在表下给出单价来源。
 *
 * 两种口径要分开表达，否则会误导：
 *   - **分时**（DeepSeek）逐模型列出高峰 / 空闲 token 与「空闲 / 高峰」双档单价；
 *   - **不分时**（智谱 GLM 等）高峰与空闲同价，因此**只显示一列 token**、
 *     单价也只写一个值——硬摆一对相同的「空闲 / 高峰」数字纯属噪音。
 */
function CostTable(props) {
  const { models, rangeByModel, pricing, rangeCost, split, rangeLabel } = props
  const rows = models
    .map((model) => {
      const usage = rangeByModel[model.model]
      if (usage === undefined) return null
      const rates = ratesFor(pricing, model.model)
      return {
        model: model.model,
        label: model.label,
        rates,
        // 不分时的模型 peak 与 idle 相同；按 peak 判定即可
        flat: Number(rates.cacheMiss?.peak ?? 0) === Number(rates.cacheMiss?.idle ?? 0)
          && Number(rates.output?.peak ?? 0) === Number(rates.output?.idle ?? 0),
        // 宿主标注的可信度：兜底价要显式说明，别让猜的数字看起来像官方价
        priced: model.priced !== false,
        tiered: model.tiered === true,
        vendor: model.vendor ?? '',
        cost: priceByModel({ [model.model]: usage }, pricing),
        peak: peakTokensOf(usage),
        idle: idleTokensOf(usage),
        total: Number(usage.local ?? 0),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')

  const anyFlat = rows.some((row) => row.flat)
  const anyTiered = rows.some((row) => row.tiered)
  const anyUnpriced = rows.some((row) => !row.priced)

  return h('div', null,
    h('div', { className: 'px-table-wrap' },
      h('table', { className: 'px-table' },
        h('thead', null,
          h('tr', null,
            h('th', null, '模型'),
            h('th', null, anyFlat ? 'Token' : '高峰 token'),
            anyFlat ? null : h('th', null, '空闲 token'),
            h('th', null, `${rangeLabel}金额`))),
        h('tbody', null,
          rows.map((row) =>
            h('tr', { key: row.model },
              h('td', null,
                h('b', null, row.label),
                h('span', { className: 'px-muted px-mono' }, ` ${row.model}`),
                row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
                row.tiered ? h('span', { className: 'px-badge' }, '按最低档') : null),
              h('td', null, formatTokens(row.flat ? row.total : row.peak)),
              row.flat ? null : h('td', null, formatTokens(row.idle)),
              h('td', null, formatCny(row.cost.standard)))),
          h('tr', { className: 'px-row-total' },
            h('td', null, '合计'),
            h('td', null, formatTokens(anyFlat ? split.peak + split.idle : split.peak)),
            anyFlat ? null : h('td', null, formatTokens(split.idle)),
            h('td', null, formatCny(rangeCost.standard)))))),
    h('div', { className: 'px-rate-list' },
      rows.map((row, index) =>
        h('div', { key: `rate-${row.model}`, className: 'px-rate' },
          h('i', { className: `px-rate-swatch ${toneFill(TONES[index % TONES.length])}` }),
          h('b', null, row.label),
          h('span', null, row.flat
            // 不分时：只写一个价，不要摆一对相同的数字
            ? `缓存命中 ¥${row.rates.cacheHit.peak} · 未命中 ¥${row.rates.cacheMiss.peak} · 输出 ¥${row.rates.output.peak}`
            : `缓存命中 ¥${row.rates.cacheHit.idle} / ¥${row.rates.cacheHit.peak}`),
          row.flat ? null : h('span', null, `未命中 ¥${row.rates.cacheMiss.idle} / ¥${row.rates.cacheMiss.peak}`),
          row.flat ? null : h('span', null, `输出 ¥${row.rates.output.idle} / ¥${row.rates.output.peak}`),
          row.vendor === '' ? null : h('span', { className: 'px-muted' }, row.vendor)))),
    h('p', { className: 'px-muted px-note' },
      anyFlat
        ? `单价单位元 / 百万 token；标「不分时」的模型高峰与空闲同价，故只列一个价与一列 token。`
        : `单价写作「空闲 / 高峰」，单位元 / 百万 token。`,
      `${rangeLabel}内若全部落在空闲时段可省 ${formatCny(rangeCost.saved)}。`,
      anyTiered ? '标「按最低档」的模型官方按输入长度分档定价，这里只按最低档估算。' : '',
      anyUnpriced ? '标「估算价」的模型不在价目表里，暂按 Flash 单价估算，仅供参考。' : ''))
}

/** 会话清单表。 */
function SessionTable(props) {
  const { sessions, timezone } = props
  if (sessions.length === 0) return h('p', { className: 'px-muted' }, '还没有会话记录。')
  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, '会话'),
          h('th', null, '工作区'),
          h('th', null, '模型'),
          h('th', null, '轮次'),
          h('th', null, 'Token'),
          h('th', null, '开始时间'))),
      h('tbody', null,
        sessions.slice(0, 40).map((session) =>
          h('tr', { key: session.id },
            h('td', { className: 'px-mono', title: session.id }, `${session.id.slice(8, 16)}…`),
            h('td', null,
              session.workspace,
              session.live ? h('span', { className: 'px-badge ok' }, '进行中') : null),
            h('td', null, session.models.join(', ') || '—'),
            h('td', null, String(session.turns)),
            h('td', null, formatTokens(session.totals.local)),
            h('td', null, formatDateTime(session.createdAt, timezone)))))))
}

			exports.Dashboard = Dashboard
			exports.View = View
		},
		"./entry.js": (exports, require) => {
			const m1 = require("./dashboard.js")
			const m2 = require("./SessionCost.js")
			const m3 = require("./theme.js")
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
const Dashboard = m1.Dashboard
const COST_ENTRY_ID = m2.COST_ENTRY_ID
const COST_ENTRY_ORDER = m2.COST_ENTRY_ORDER
const SessionCost = m2.SessionCost
const PALETTE_OVERRIDES = m3.PALETTE_OVERRIDES
const PIXEL_THEMES = m3.PIXEL_THEMES
const STYLES = m3.STYLES
const { createElement: h, useState } = React

/** 插件标识，同时用作样式标签与主题来源名。 */
const PACKAGE_ID = 'dsh-pixel-dashboard'

/** 侧栏面板与主区共用同一个 id：侧栏按钮靠它选中主区面板。 */
const PANEL_ID = 'pixel-usage'

/** 令牌覆盖层的来源标识，一个 source 只保留一层。 */
const PALETTE_SOURCE = `${PACKAGE_ID}/palette`

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
 * 侧栏按钮：悬停微亮、按下微缩，点击切到看板面板，再点一次回到会话。
 * @param {object} ctx - 插件上下文，用于取 layout 服务。
 * @returns {Function} 组件。
 */
function panelEntry(ctx) {
  return function PanelEntry(props) {
    const active = props.active === true
    const [hover, setHover] = useState(false)
    const [press, setPress] = useState(false)
    const onClick = () => {
      const layout = ctx.get('layout')
      if (layout === undefined) return
      try {
        layout.selectPanel(active ? null : PANEL_ID)
      } catch {
        // 主区面板尚未注册完成时忽略这一次点击，下次渲染即可用。
      }
    }
    return h(
      'button',
      {
        type: 'button',
        title: '用量看板',
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
          width: 30,
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
      h(PanelIcon, { size: props.size, active }),
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
