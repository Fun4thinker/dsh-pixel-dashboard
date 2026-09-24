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
export async function fetchRates(options = {}) {
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
export async function saveRates(rates) {
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
export function composeRate(input) {
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
export function draftOf(rate) {
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