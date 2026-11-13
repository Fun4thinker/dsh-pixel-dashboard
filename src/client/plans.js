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
 *
 * 认不出的窗口（`hourly` / `budget` / `windowN` 之类）**排在已知窗口之后**，
 * 顺序保持宿主给的先后——早先这里用「按固定顺序 map 再 find」的写法，于是
 * 任何新窗口种类都会被静默丢掉。展示「还剩多少」这件事上，**少一格比多一格糟**。
 */
export const WINDOW_ORDER = ['fiveHour', 'weekly', 'monthly']

/**
 * 把宿主的窗口数组排成稳定顺序：已知窗口按 {@link WINDOW_ORDER}，其余按原顺序跟在后面。
 * @param {object[]} windows - 宿主返回的窗口。
 * @returns {object[]} 排序后的新数组（不改原数组）。
 */
export function orderWindows(windows) {
  const list = Array.isArray(windows) ? windows.filter((win) => win !== null && typeof win === 'object') : []
  const known = []
  for (const key of WINDOW_ORDER) {
    for (const win of list) if (win.window === key) known.push(win)
  }
  const rest = list.filter((win) => !WINDOW_ORDER.includes(win.window))
  return [...known, ...rest]
}

/**
 * 厂商 id → 这一家在费用条那种一行位置用得下的短名。
 *
 * 新接入的三家在 `client/provider.js` 的 `PLAN_SHORT` 里没有条目（那个文件属于
 * 路由映射的既有实现），因此这一份是**补充表**：查不到时退回宿主给的名字。
 */
export const VENDOR_SHORT = {
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'Opencode',
}

/**
 * 厂商 id → 这一家的数据形状（界面用来决定「百分比 / 绝对值 / 只有剩余额」怎么讲）。
 *
 * 与宿主 `lib/plans.js` 的 `SHAPE_LABELS` 同一组事实：宿主已经在每家结果上给了
 * `shape`，这里只是给**旧宿主**（没有 shape 字段）留一张回落表。
 */
export const VENDOR_SHAPE = {
  zhipu: 'percent',
  commandcode: 'absolute',
  volcengine: 'mixed',
  codex: 'percent',
  cursor: 'percent',
  opencode: 'mixed',
}

/**
 * 数据形状 → 一句话说明（旧宿主没有 `setup.shape` 时的回落）。
 */
export const SHAPE_TEXT = {
  percent: '官方只给百分比',
  absolute: '官方给绝对值（已用 + 上限）',
  remaining: '官方只给剩余额',
  mixed: '套餐给百分比，预算给金额',
}

/**
 * 各家的管理 / 充值入口（**旧宿主的回落**）。
 *
 * 新宿主在每一家里交下 `setup.keyURL` / `keyURLName`；这里只服务没有 `setup` 的
 * 旧宿主。**注意火山的入口是 IAM 的「API 访问密钥」页，不是方舟控制台**——AK/SK
 * 是账号级 IAM 凭据，方舟控制台给的是推理用的 `ark-` Key，那个恰好是会被拒的一把。
 */
export const VENDOR_LINKS = {
  zhipu: { href: 'https://www.bigmodel.cn/coding-plan/personal/usage', label: '智谱套餐用量 ↗' },
  commandcode: { href: 'https://commandcode.ai/studio', label: 'Command Code 工作室 ↗' },
  volcengine: { href: 'https://console.volcengine.com/iam/keymanage/', label: '火山引擎 API 访问密钥（AccessKey）↗' },
  codex: { href: 'https://developers.openai.com/codex/auth', label: 'Codex 登录说明 ↗' },
  cursor: { href: 'https://cursor.com/dashboard', label: 'Cursor 控制台 ↗' },
  opencode: { href: 'https://opencode.ai/console', label: 'OpenCode Console ↗' },
}

/**
 * 这一家的凭据要求（一句人话，**旧宿主的回落**）。
 *
 * 为什么要单独一张表：用户最容易在这一步上错得最离谱，而错法各不相同——
 * 智谱要「编程套餐专属」Key（平台 Key 不通用）；火山要 AK/SK 而不是推理 Key；
 * Codex / Cursor 要登录态 token 而不是平台 API Key。新宿主会把这些写在
 * `setup.acquire` 里；旧宿主没有，界面也不能留空。
 */
export const VENDOR_CREDENTIAL_HINT = {
  zhipu: '需要「编程套餐专属」Key：平台普通的 API Key 不通用（标准调用能过、额度查询会被拒）。',
  commandcode: '在工作台里创建 API Key；装过 CLI 并登录过的话插件会自动读本机的登录文件。',
  volcengine: '要的是火山账号的 AccessKey ID / Secret AccessKey，不是方舟推理用的 ark- Key（后者会被网关在格式层拒掉）。',
  codex: '要的是 Codex 的登录态 access token（不是 sk 开头的平台 API Key），另需 workspace / 账号 id。',
  cursor: '要的是 Cursor 的登录态 access token；过期需在 Cursor 里重新登录。',
  opencode: '要 OpenCode Console 的 Key，并且需要 workspace id（Console 地址里那一段）。',
}

/**
 * 这一家的凭据要求一句话（供界面直接渲染）。
 * @param {object|undefined} provider - 宿主返回的一家结果。
 * @returns {string} 说明；认不出时是空串。
 */
export function vendorCredentialHint(provider) {
  const id = provider?.id
  if (typeof id !== 'string') return ''
  return VENDOR_CREDENTIAL_HINT[id] ?? ''
}

/**
 * 这一家的入口链接：宿主 `setup.keyURL` 优先，其次旧宿主的回落表。
 * @param {object|undefined} provider - 宿主返回的一家结果。
 * @returns {{href:string,label:string}|undefined} 入口；都没有时 undefined。
 */
export function vendorLinkOf(provider) {
  const setup = provider?.setup
  const href = typeof setup?.keyURL === 'string' && setup.keyURL !== '' ? setup.keyURL : ''
  if (href !== '') {
    return {
      href,
      label: `${typeof setup?.keyURLName === 'string' && setup.keyURLName !== '' ? setup.keyURLName : '打开创建页'} ↗`,
    }
  }
  const id = provider?.id
  return typeof id === 'string' ? VENDOR_LINKS[id] : undefined
}

/**
 * 新接入三家的 provider 路由名 → 厂商 id。
 *
 * **与宿主 `lib/plans.js` 的 `CODEX_ROUTES` / `CURSOR_ROUTES` / `OPENCODE_ROUTES`
 * 是同一组事实的两份抄写。** 宿主用它们派生凭据引用名，这里用来判断「当前会话用的是
 * 哪一家」。漂移的表现是「套餐卡片里有这一家、费用条旁边却始终不显示它」——
 * 没有报错，只是那一枚永远不出现，因此两边必须一起改。
 */
export const EXTRA_PLAN_ROUTES = {
  codex: ['codex', 'codex-cli', 'openai-codex', 'chatgpt-codex'],
  cursor: ['cursor', 'cursor-agent'],
  opencode: ['opencode', 'opencode-zen', 'zen'],
}

/** 小写路由名 → 新三家厂商 id。 */
const EXTRA_ROUTE_INDEX = (() => {
  const map = new Map()
  for (const [id, routes] of Object.entries(EXTRA_PLAN_ROUTES)) {
    for (const route of routes) map.set(String(route).toLowerCase(), id)
  }
  return map
})()

/**
 * 由 provider 路由名认出**新接入的三家**之一。
 *
 * 为什么不直接改 `client/provider.js`：那个文件里的 `PLAN_ROUTES` 与宿主的
 * 三家候选表成对维护，渲染闸门会逐条比对；把新三家塞进去要同时改两边与闸门。
 * 这里独立一张表，只在 `client/account.js` 里**优先**查它，查不到再退回那张旧表，
 * 于是新旧两批互不干扰。
 * @param {unknown} provider - provider 路由名。
 * @returns {string|undefined} 厂商 id（codex / cursor / opencode）。
 */
export function extraPlanIdOfRoute(provider) {
  const key = String(provider ?? '').trim().toLowerCase()
  if (key === '') return undefined
  return EXTRA_ROUTE_INDEX.get(key)
}

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

/** 「移除凭据」路由，与宿主注册路径一致。 */
const CREDENTIALS_URL = '/dsh-pixel/plan-credentials'

/**
 * 取「移除凭据」清单（**只读**：只查现状，不动任何东西）。
 *
 * 404 有确定含义：宿主是还没有这条路由的旧版本。这时界面**不画移除入口**，
 * 而不是画一个点了必然失败的按钮。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 清单负载。
 */
export async function fetchPlanCredentials(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(CREDENTIALS_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('宿主没有「移除凭据」路由（插件版本可能过旧，重启 dsh 试试）')
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
 * 移除用户勾选的凭据引用。
 *
 * **不抛错**（除了网络层）：宿主的正常返回里逐条带着成功 / 失败与原因，
 * 界面要的正是那份逐条结果。把「三条里失败了一条」整体抛成异常，
 * 会让用户看不到另外两条到底成没成。
 * @param {string[]} refs - 用户勾选的引用名。
 * @returns {Promise<object>} `{ results, credentials }`。
 * @throws {Error} 仅当请求本身失败（网络 / 非 2xx）。
 */
export async function removePlanCredentials(refs) {
  const response = await fetch(CREDENTIALS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ refs: Array.isArray(refs) ? refs : [] }),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = body.error
    } catch {
      // 响应不是 JSON 时保留状态码说明
    }
    throw new Error(`移除失败：${detail}`)
  }
  return await response.json()
}

/**
 * 把清单摊平成「可勾选的行」，供界面渲染。
 *
 * 两类行**不可勾选**，而且理由完全不同，必须分开表达：
 *   - `removable === false`：来自启动环境变量或 `.env` 回落层，`unset` 动不了它
 *     （前者抛错，后者是**静默空操作**）。画上勾选框就是骗人。
 *   - 未配置：本来就没有，没什么可移除的。
 * @param {object|undefined} payload - {@link fetchPlanCredentials} 的负载。
 * @param {string} [vendorId] - 只取这一家的行（标签页一次只显示一家）。
 * @returns {Array<{vendor:string,vendorName:string,ref:object,selectable:boolean}>} 行。
 */
export function credentialRows(payload, vendorId) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const rows = []
  for (const provider of providers) {
    if (vendorId !== undefined && provider?.id !== vendorId) continue
    for (const ref of Array.isArray(provider?.refs) ? provider.refs : []) {
      rows.push({
        vendor: provider.id,
        vendorName: provider.name ?? provider.id,
        ref,
        selectable: ref?.removable === true,
      })
    }
  }
  return rows
}

/**
 * 某一家**自动发现**会读的本机凭据文件（只读、不可删）。
 *
 * 这些文件属于别的 App，插件只读。但必须列出来并标明「不会删除它」：
 * 否则用户清完凭据文件里那把之后，插件照样能从这些文件读到，界面上却显示「未配」。
 * @param {object|undefined} payload - {@link fetchPlanCredentials} 的负载。
 * @param {string} vendorId - 厂商 id。
 * @returns {Array<{path:string,present:boolean,note:string}>} 文件清单。
 */
export function credentialFiles(payload, vendorId) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const provider = providers.find((item) => item?.id === vendorId)
  const files = Array.isArray(provider?.files) ? provider.files : []
  return files
    .filter((file) => file !== null && typeof file === 'object' && typeof file.path === 'string')
    .map((file) => ({
      path: file.path,
      present: file.present === true,
      note: typeof file.note === 'string' ? file.note : '',
    }))
}

/**
 * 这一家的端点核验级别。
 *
 * `community` 表示**只有社区逆向实现**、没有一方来源（开源代码或官方文档），
 * 界面必须显式说出来——用户据此决定「这个数字能不能当准」。缺字段时按
 * `first-party` 处理（旧宿主没有这个概念，那时也没有新接入的三家）。
 * @param {object|undefined} provider - 宿主返回的一家结果。
 * @returns {'first-party'|'community'} 核验级别。
 */
export function vendorVerification(provider) {
  return provider?.verification === 'community' ? 'community' : 'first-party'
}

/**
 * 这一家给的是哪种形状（百分比 / 绝对值 / 只有剩余额 / 混合）。
 * @param {object|undefined} provider - 宿主返回的一家结果。
 * @returns {string} 形状 id；认不出时空串。
 */
export function vendorShape(provider) {
  const shape = provider?.shape
  if (typeof shape === 'string' && shape !== '') return shape
  return VENDOR_SHAPE[provider?.id] ?? ''
}

/**
 * 形状 id → 一句话说明。
 * @param {string} shape - 形状 id。
 * @returns {string} 说明；认不出时空串。
 */
export function shapeText(shape) {
  return SHAPE_TEXT[shape] ?? ''
}

/**
 * 宿主的套餐负载里，真正「在监控列表里」的厂商。
 *
 * 与 {@link providerChoices} 的差别：这个只回答「这一轮有几家能显示」，
 * 标签页用它决定要不要画「添加厂商」入口。
 * @param {object|undefined} payload - 宿主负载。
 * @returns {object[]} 厂商结果数组（保持宿主顺序）。
 */
export function allProviders(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  return providers.filter((provider) => provider !== null && typeof provider === 'object'
    && typeof provider.id === 'string')
}

/**
 * 统计清单：有几家配了、有几条可移除。
 *
 * 界面用「可移除条数」决定移除入口要不要出现在第一屏——一家都没配时
 * 整块应当收起，而不是把几十行「未配置」摊在用户眼前。
 * @param {object|undefined} payload - 清单负载。
 * @returns {{configured:number,removable:number,vendors:number}} 统计。
 */
export function credentialSummary(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  let configured = 0
  let removable = 0
  let vendors = 0
  for (const provider of providers) {
    let touched = false
    for (const ref of Array.isArray(provider?.refs) ? provider.refs : []) {
      if (ref?.configured === true) { configured += 1; touched = true }
      if (ref?.removable === true) removable += 1
    }
    if (provider?.cliFile?.hasKey === true) { configured += 1; touched = true }
    if (touched) vendors += 1
  }
  return { configured, removable, vendors }
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

