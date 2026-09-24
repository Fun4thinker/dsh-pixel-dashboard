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
export const WINDOW_ORDER = ['fiveHour', 'weekly', 'monthly']

/**
 * 格式化一个额度数值。
 *
 * Command Code 的额度是**美元信用额**（`$70` 这种），智谱是**积分**。
 * 两者单位不同，所以数值前面要带单位前缀，不能只给一个裸数字。
 * @param {number|undefined} value - 数值。
 * @param {string} unit - 单位前缀（如 `$`）。
 * @returns {string} 形如 `$70` 或 `—`。
 */
export function formatQuota(value, unit = '') {
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
export function windowProgress(window) {
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
export function quotaTone(percent, exceeded) {
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
export function formatReset(resetAt, now) {
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
export function formatResetAt(resetAt, timeZone) {
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
export function formatResetLine(resetAt, now, timeZone) {
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
export function providerStatus(provider) {
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
export async function fetchPlans(options = {}) {
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
export function hasAnyQuota(payload) {
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
export function tightestWindow(payload, planId) {
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
export function providerById(payload, planId) {
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
export function providerChoices(payload) {
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
export function partitionProviders(providers, options = {}) {
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

