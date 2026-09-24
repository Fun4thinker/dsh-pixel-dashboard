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
export function formatMoney(value, currency) {
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
export function hasBalance(payload) {
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
export function balanceSummary(payload) {
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
export function balanceAvailable(payload) {
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
export function balanceStatus(payload) {
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
export async function fetchBalance(options = {}) {
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
export async function setToggle(target, enabled) {
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
export function setBalanceEnabled(enabled) {
  return setToggle('balance', enabled)
}
