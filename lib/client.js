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

/**
 * 毫秒 → 人类可读时长（与 {@link formatSpan} 同一套单位，但入参是**时长**而非两端）。
 *
 * 分开写而不是复用 `formatSpan`：那边收的是「首末时刻」，语义是跨度；这里收的是
 * 一堆累计毫秒（总等待、平均每轮），混用会让「0 表示没有数据」这条约定失真——
 * 累计 0 毫秒是**合法值**（真的没等），而 `formatSpan(0,0)` 表示没有数据。
 * @param {number} ms - 时长（毫秒）。
 * @returns {string} 时长文本；负数或非数字返回 `—`。
 */
function formatDurationMs(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '—'
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
}

/**
 * 峰时 / 闲时的占比（按**请求数**，不是按 token）。
 *
 * ## 为什么按请求数
 *
 * 用户要看的是「我的使用有多少落在贵时段」。按 token 会把一个超长请求的权重放大到
 * 掩盖其它所有请求；按请求数才对应「我有多少次调用是在峰时」这个原始问题。
 * 金额另有单独的字段呈现，两者互补。
 *
 * 无数据时返回 `undefined`——调用方显示 `—`，而不是画一条 0% 的空条。
 * @param {object|undefined} totals - 会话的 totals（含 peak / idle 分档）。
 * @returns {{peak:number,idle:number,peakRatio:number}|undefined} 峰值与占比。
 */
function peakShare(totals) {
  const peak = Number(totals?.peak?.requests ?? 0)
  const idle = Number(totals?.idle?.requests ?? 0)
  const total = peak + idle
  if (!Number.isFinite(total) || total <= 0) return undefined
  return { peak, idle, peakRatio: peak / total }
}

/**
 * 一段跨度 → 人类可读的时长（`12s` / `3m27s` / `1h26m`）。
 *
 * 这是「用量视角」里最容易读歪的一个数，因此规则写死在这里：
 *   - 两端任一为 0（没有数据）就返回 `—`，**不返回 `0s`**——「不知道」与「零秒」
 *     是两件事，把前者显示成后者会让整列数字失去意义；
 *   - 负值（时钟回拨 / 日志乱序）同样按无数据处理；
 *   - 只保留两级单位：`1h26m` 够用，`1h26m13s` 在表格里反而难扫读。
 * @param {number} firstAt - 起始时刻（毫秒）。
 * @param {number} lastAt - 结束时刻（毫秒）。
 * @returns {string} 时长文本；无数据时为 `—`。
 */
function formatSpan(firstAt, lastAt) {
  const from = Number(firstAt)
  const to = Number(lastAt)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return '—'
  const ms = to - from
  if (ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`
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
			exports.formatDurationMs = formatDurationMs
			exports.peakShare = peakShare
			exports.formatSpan = formatSpan
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
function resolveRate(pricing, model) {
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
function ratesFor(pricing, model) {
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
function markupOf(pricing, provider) {
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
function priceUsage(usage, rates, markup = 1) {
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
function priceByModel(byModel, pricing) {
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

			exports.resolveRate = resolveRate
			exports.ratesFor = ratesFor
			exports.markupOf = markupOf
			exports.priceUsage = priceUsage
			exports.priceByModel = priceByModel
		},
		"./costDetail.js": (exports, require) => {
			const m1 = require("./format.js")
			/**
 * 输入框下方费用条的**详情面板数据**（纯函数，不含 React）。
 *
 * ## 为什么要单独一层
 *
 * 详情以前全塞在 `title` 属性里——那是一个**裸的系统浮窗**：字号跟着操作系统走、
 * 换行由浏览器决定、深浅色不听产品、鼠标一移开就消失，而且**没法点击**。
 * 用户的原话是「现在直接是一个裸文本浮窗，不好看」。
 *
 * 于是详情改成一个真正的面板。但面板要显示的东西（分档金额、用量构成、
 * 账户、成员、注释）**不该在 JSX 里现算**，否则每次改文案都要动渲染代码，
 * 而且服务端渲染闸门（`renderToStaticMarkup` 不执行 effect）看不到内容，
 * 只能断言 `title` 字符串——那正是「数字对了、界面还是丑的」这类问题的来源。
 *
 * 因此这里把「面板显示什么」折成一份**纯数据**：
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `title` / `tone` / `badge` | 抬头：这是本次会话还是团队合计、有没有「估算」角标 |
 * | `headline` | 抬头下面那个大号金额 |
 * | `sections[]` | 分节：分时计价 / 用量构成 / 成员 / 账户 |
 * | `notes[]` | 脚注：钱是按什么口径算出来的 |
 *
 * 渲染层（`CostDetailPanel`）只负责把这些字符串摆漂亮，一个数字都不算；
 * 闸门则可以直接断言这些字符串，不必去猜 JSX 的结构。
 *
 * ## 三处口径必须与看板一致
 *
 *   1. **金额全部取宿主算好的那份**，不在这里重新累加——重算会引入第二种取整方式，
 *      而屏幕上会同时出现「合计」与「各分项」，用户一定会加起来对一遍（见
 *      AGENT.md「团队合计 = 成员金额之和，逐位相等」）。
 *   2. **缓存命中率的分母是「计费输入」**（未命中 + 命中读 + 写入），与官方
 *      统计胶囊同一口径；分母为 0 时**不显示这一行**，而不是显示 0%。
 *   3. **「不知道」与「真的是 0」是两件事**：拿不到的字段整行省略，不写 0。
 * @module dsh-pixel-dashboard/client/costDetail
 */

const formatCny = m1.formatCny
const formatTokens = m1.formatTokens
/** 分时计价里两档的色调：高峰粉、空闲绿，与看板「高峰占比」同一套语义。 */
const PERIOD_TONE = { peak: 'pink', idle: 'green' }

/** 成员配色轮换：与看板的 tone 轮换同源，深色下自动换亮号。 */
const MEMBER_TONES = ['purple', 'blue', 'green', 'yellow', 'red', 'pink']

/**
 * 把用量对象里的一桶数字读成有限数（缺失按 0，脏数据按 0）。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @param {string} field - 字段名。
 * @returns {number} 非负有限数。
 */
function num(usage, field) {
  const value = Number(usage?.[field] ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 缓存命中率：命中读 ÷ 计费输入。
 *
 * 分母为 0（这个会话还没产生任何输入）时返回 undefined——**不是 0%**：
 * 0% 会把「还没有输入」显示成「缓存完全没命中」，那是两种完全不同的处境。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @returns {number|undefined} 0..1 之间的比例。
 */
function cacheHitRate(usage) {
  const read = num(usage, 'cacheReadTokens')
  const billed = read + num(usage, 'uncachedInputTokens') + num(usage, 'cacheWriteTokens')
  if (billed === 0) return undefined
  return Math.min(1, read / billed)
}

/**
 * 计费 token 总数（缓存命中读 + 未命中 + 写入 + 输出）。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @returns {number} token 数。
 */
function billedTotal(usage) {
  return num(usage, 'cacheReadTokens') + num(usage, 'uncachedInputTokens')
    + num(usage, 'cacheWriteTokens') + num(usage, 'outputTokens')
}

/**
 * 分时计价那一节：两档各自的金额与占比。
 *
 * 占比用于画进度条，分母是 `standard`。某一档为 0 时占比也是 0——进度条空白，
 * 但**行仍然显示**：用户看到「空闲 ¥0」才知道这段会话全在高峰时段跑的，
 * 这比整行消失有用得多。
 * @param {object|undefined} cost - 宿主给的 `{standard, peak, idle}`。
 * @returns {{label:string,total:string,rows:object[]}} 分节。
 */
function splitSection(cost) {
  const standard = Number(cost?.standard ?? 0)
  const peak = Number(cost?.peak ?? 0)
  const idle = Number(cost?.idle ?? 0)
  const shareOf = (value) => (standard > 0 ? Math.min(1, Math.max(0, value / standard)) : 0)
  return {
    label: '分时计价',
    total: formatCny(standard),
    rows: [
      {
        label: '高峰时段',
        value: formatCny(peak),
        share: shareOf(peak),
        tone: PERIOD_TONE.peak,
        hint: '工作日 09:00–12:00、14:00–18:00',
      },
      {
        label: '空闲时段',
        value: formatCny(idle),
        share: shareOf(idle),
        tone: PERIOD_TONE.idle,
        hint: '其余时段与全部法定节假日',
      },
    ],
  }
}

/**
 * 用量构成那一节：四个计费桶 + 缓存命中率 + 总量。
 *
 * 全部为 0 时整节省略（返回 undefined）：新会话刚开就弹出一排 `0` 没有信息量，
 * 而它会让「还没开始算」看起来像「算完了，都是 0」。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @returns {{label:string,rows:object[]}|undefined} 分节。
 */
function usageSection(usage) {
  const read = num(usage, 'cacheReadTokens')
  const miss = num(usage, 'uncachedInputTokens')
  const write = num(usage, 'cacheWriteTokens')
  const output = num(usage, 'outputTokens')
  const total = read + miss + write + output
  if (total === 0) return undefined
  const rows = [
    { label: '缓存命中读', value: formatTokens(read) },
    { label: '未缓存输入', value: formatTokens(miss) },
  ]
  // 缓存写入多数会话是 0：照实给一行「0」会让读者去找「为什么我没写入」，
  // 而它只是这次没触发阈值。为 0 时省掉这一行。
  if (write > 0) rows.push({ label: '缓存写入', value: formatTokens(write) })
  rows.push({ label: '输出', value: formatTokens(output) })
  const rate = cacheHitRate(usage)
  if (rate !== undefined) rows.push({ label: '缓存命中率', value: `${(rate * 100).toFixed(1)}%` })
  rows.push({ label: '计费 token', value: formatTokens(total) })
  return { label: '用量构成', rows }
}

/**
 * 账户那一节：按 `account.kind` 只出一个对象（余额**或**套餐，不并排）。
 *
 * 不并排不是排版偏好：两者来自完全不同的账户（按量计费的余额 vs 买断的套餐额度），
 * 摆在一起会让人以为是同一笔钱的两个数字（见 account.js 的模块说明）。
 * @param {object|undefined} account - {@link resolveAccount} 的结果。
 * @returns {{label:string,rows:object[]}|undefined} 分节。
 */
function accountSection(account) {
  if (account === undefined || account === null || account.kind === 'none') return undefined

  if (account.kind === 'balance') {
    const rows = [{ label: '账户余额', value: account.text }]
    // 端点是不是官方，只有**不是**的时候值得说。是的话这句话纯属噪音。
    if (account.payload?.official === false) {
      rows.push({ label: '查询端点', value: '非官方公网地址' })
    }
    return { label: '账户', rows }
  }

  if (account.kind === 'plan') {
    const percent = Number(account.plan?.percent ?? 0)
    return {
      label: '账户',
      rows: [{
        label: `${account.fullLabel ?? account.label} · ${account.plan.window.label}`,
        value: `${percent.toFixed(1)}%`,
        // 百分比可以超过 100（额度用超时官方就是给 >100 的值）：
        // 条夹到满，数字照实显示，否则「已严重超限」会被伪装成「刚好用满」。
        share: Math.min(1, Math.max(0, percent / 100)),
        tone: percent >= 75 || account.plan.window.exceeded === true ? 'red' : 'purple',
        hint: account.source === 'selected' ? '你在看板上手动指定了监看这一家' : '当前会话走的是这一家',
      }],
    }
  }

  // 不可用：**必须**说出来并给出原因。静默不渲染会被当成插件坏了。
  return {
    label: '账户',
    rows: [{
      label: account.label,
      value: '不可用',
      tone: 'red',
      hint: account.reason ?? '暂时取不到数据',
    }],
  }
}

/**
 * 团队那一节：按成员分列，每人一行带金额与 token。
 *
 * 金额取宿主算好的那份（`member.cost.standard`），**不在这里从合计反推**：
 * 「团队合计 = 成员之和」是宿主保证到小数点后 6 位的等式，客户端重算一次就会
 * 出现第二种取整方式，屏幕上两个数加起来对不上（AGENT.md 里那条教训）。
 * @param {object|undefined} team - {@link teamSummaryOf} 的结果。
 * @returns {{label:string,rows:object[]}|undefined} 分节。
 */
function membersSection(team) {
  if (team === undefined || team === null) return undefined
  const lines = Array.isArray(team.lines) ? team.lines : []
  if (lines.length === 0) return undefined
  const total = Number(team.cost ?? 0)
  return {
    label: `成员（${lines.length} 位）`,
    rows: lines.map((line, index) => ({
      label: line.role === 'lead' ? `${line.name} · lead` : line.name,
      value: formatCny(Number(line.cost ?? 0)),
      share: total > 0 ? Math.min(1, Math.max(0, Number(line.cost ?? 0) / total)) : 0,
      tone: MEMBER_TONES[index % MEMBER_TONES.length],
      // token 数缺失时整段省略——「不知道」不写成 0 tokens。
      hint: Number(line.tokens ?? 0) > 0 ? `${formatTokens(line.tokens)} tokens` : undefined,
    })),
  }
}

/**
 * 脚注：**只在数字需要打折扣时才写一行**，其余情况一个字都不留。
 *
 * 早先这里固定写两段口径说明（「团队合计 = 各成员金额之和」「按官方单价估算，
 * 不是实际账单」）。用户看了实际界面后的反馈是「底下的描述性文字我觉得可以去掉」
 * ——面板是**读数**的地方，常驻的解释等于每次都让人先跨过一段说明才能看数字。
 *
 * 因此现在的判据是「这句话会不会改变你对上面那些数字的理解」：
 *   - 有模型不在价目表里 → **会**（金额是兜底价估的，不是官方价），留一行；
 *   - 取不到费用 → **会**（金额是缺失，不是 0），留一行；
 *   - 「团队合计 = 成员之和」「第三方中转不按 token 计费」这类恒定成立的常识
 *     → **不会**，删掉。它们已经在 README 的「计费口径」里写清楚了。
 *
 * 判据写在这里而不是散在渲染层：面板里出现任何一段文字都必须先回答一次
 * 「它是否改变读法」，否则下一次改动又会把说明加回来。
 * @param {object} input - 见 {@link costDetailModel}。
 * @returns {string[]} 注释行；常规情况下是空数组。
 */
function notesOf(input) {
  const notes = []
  const unpriced = Array.isArray(input.unpriced)
    ? input.unpriced.filter((name) => typeof name === 'string' && name !== '')
    : []
  if (input.failed === true) {
    // 只留「为什么没有数字」这一句。原来还跟着一句「刷新页面或重启 dsh」的
    // 排查指引——那是文档该说的话，不是读数的地方该说的话。
    notes.push('宿主未提供该会话的费用数据。')
    return notes
  }
  if (unpriced.length > 0) {
    notes.push(`其中 ${unpriced.join('、')} 未在价目表中，按 Flash 单价估算。`)
  }
  return notes
}

/**
 * 折出详情面板要显示的全部内容。
 *
 * 两种口径**互斥**，与费用条上那一枚一致：属于多成员团队时是团队口径，
 * 否则是单会话口径。判据只看 `team` 在不在，不在这里重新判断团队归属
 * （那由 team.js 的 `findTeamOf` 负责，两者判据分叉会让费用条与面板说的不是同一件事）。
 * @param {object} [input] - 见 {@link SessionCostPills} 的属性。
 * @returns {{tone:string,title:string,headline:string,badge:string|undefined,sections:object[],notes:string[],empty:boolean}} 面板数据。
 */
function costDetailModel(input = {}) {
  const { cost, failed, team, account, usage, unpriced } = input
  const teamMode = team !== undefined && team !== null

  // 什么都没有：既不渲染徽标也不渲染面板（调用方据此不画空壳）。
  const nothing = cost === undefined && failed !== true && account === undefined
    && !teamMode && usage === undefined
  if (nothing) {
    return { tone: 'pink', title: '', headline: '', badge: undefined, sections: [], notes: [], empty: true }
  }

  const sections = []
  if (failed !== true && cost !== undefined) sections.push(splitSection(cost))
  if (teamMode) {
    const members = membersSection(team)
    if (members !== undefined) sections.push(members)
    // 团队口径下「本次会话」不丢：它就在这一节里，回答「我这一支花了多少」。
    if (cost !== undefined && Number(team.cost ?? 0) > 0) {
      const share = Math.min(1, Math.max(0, Number(cost.standard ?? 0) / Number(team.cost)))
      sections.push({
        label: '本次会话',
        rows: [{
          label: '本会话花费',
          value: formatCny(Number(cost.standard ?? 0)),
          share,
          tone: 'pink',
          hint: `占团队 ${(share * 100).toFixed(1)}%`,
        }],
      })
    }
  } else {
    // 单会话口径才显示用量构成：团队口径下这里的用量是**本会话**的，
    // 摆在大号团队金额下面会被读成团队用量——两笔账混在一起比不显示更糟。
    const usageBlock = usageSection(usage)
    if (usageBlock !== undefined) sections.push(usageBlock)
  }
  const accountBlock = accountSection(account)
  if (accountBlock !== undefined) sections.push(accountBlock)

  const headline = failed === true
    ? '费用不可用'
    : (cost === undefined ? '折算中…' : formatCny(Number(cost.standard ?? 0)))

  return {
    tone: failed === true ? 'red' : (teamMode ? 'purple' : 'pink'),
    title: teamMode ? '团队合计' : '本次会话',
    headline,
    badge: Array.isArray(unpriced) && unpriced.length > 0 ? '估算' : undefined,
    sections,
    notes: notesOf({ ...input, unpriced }),
    empty: sections.length === 0 && headline === '',
  }
}

			exports.cacheHitRate = cacheHitRate
			exports.billedTotal = billedTotal
			exports.costDetailModel = costDetailModel
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
 * 参数**两种形状都接受**，由宿主那边的 `parseRatesDocument()` 判别：
 *   - 文档式 `{ rates, markup, usdToCny }`（v3，设置弹层用这一种）；
 *   - v2 的扁平式「模型键 → 价目」（老界面、以及用户手写的脚本仍在用）。
 *
 * 校验失败时宿主回 400 并带上逐条原因，这里把它抛成 Error（消息是拼接后的人话），
 * 让面板能直接把原因摆在用户面前——「保存失败」四个字帮不了他。
 * @param {object} documentOrRates - 文档式或扁平式自定义价目。
 * @returns {Promise<object>} 宿主回报的新状态。
 * @throws {Error} 校验失败或网络失败。
 */
async function saveRates(documentOrRates) {
  const response = await fetch(RATES_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ rates: documentOrRates }),
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
    const failure = new Error(detail)
    // 把**逐条**原因也挂上去：界面要能把「哪一条的哪一项」一条条列出来，
    // 而不是让用户从一段用分号连起来的长句里自己拆。
    if (errors.length > 0) failure.errors = errors
    throw failure
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
  // 币种：只认 CNY / USD，其余按 CNY（界面上是下拉框，走到这里说明是脏数据）。
  const currency = String(input?.currency ?? '').trim().toUpperCase() === 'USD' ? 'USD' : 'CNY'
  const cacheWrite = pair(input?.cacheWriteIdle, input?.cacheWritePeak)
  const entry = {
    vendor,
    currency,
    cacheHit: pair(input?.cacheHitIdle, input?.cacheHitPeak) ?? zero,
    cacheMiss,
    output,
  }
  if (label !== undefined) entry.label = label
  if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite
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
    currency: String(rate?.currency ?? 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
    cacheHitIdle: side('cacheHit', 'idle'),
    cacheHitPeak: side('cacheHit', 'peak'),
    cacheMissIdle: side('cacheMiss', 'idle'),
    cacheMissPeak: side('cacheMiss', 'peak'),
    outputIdle: side('output', 'idle'),
    outputPeak: side('output', 'peak'),
    cacheWriteIdle: side('cacheWrite', 'idle'),
    cacheWritePeak: side('cacheWrite', 'peak'),
  }
}

/**
 * 把草稿写回成价目条目（保存前用）。
 *
 * 与 {@link composeRate} 的区别：这里**保留模型键之外的原字段**（`tiered` / `asOf` /
 * `source` 等），只覆盖用户改过的那几个价。设置页是按整条价目编辑的，若把
 * 「分档定价」「官方出处」这些字段丢掉，保存一次就等于把一个官方条目的属性抹平了。
 * @param {object} draft - 表单草稿。
 * @param {object} [base] - 原始条目（可为空）。
 * @returns {object|undefined} 价目条目；价格全空时 undefined。
 */
function entryOfDraft(draft, base) {
  const composed = composeRate(draft)
  if (composed === undefined) return undefined
  const carried = {}
  for (const key of ['tiered', 'asOf', 'source', 'contextWindow', 'maxOutput', 'version']) {
    if (base?.[key] !== undefined) carried[key] = base[key]
  }
  return { ...carried, ...composed }
}

/**
 * 把价目表按厂商分组（设置页要「厂商分组 + 搜索」）。
 *
 * 分组键取 `vendor`；缺失一律归到「未标注厂商」而不是丢掉——丢掉的条目在界面上
 * 就等于不存在，用户会以为插件没读到它。
 * @param {Record<string, object>} rates - 模型键 → 价目条目。
 * @returns {{vendor:string,items:{key:string,rate:object}[]}[]} 分组（按厂商名排序）。
 */
function groupByVendor(rates) {
  const groups = new Map()
  for (const [key, rate] of Object.entries(rates ?? {})) {
    if (rate === null || typeof rate !== 'object') continue
    const vendor = typeof rate.vendor === 'string' && rate.vendor.trim() !== '' ? rate.vendor.trim() : '未标注厂商'
    const bucket = groups.get(vendor) ?? []
    bucket.push({ key, rate })
    groups.set(vendor, bucket)
  }
  return [...groups.entries()]
    .map(([vendor, items]) => ({
      vendor,
      items: items.sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor))
}

/**
 * 按关键词过滤分组（模型键 / 显示名 / 厂商任一命中即可）。
 *
 * 大小写不敏感，且**忽略分隔符**：用户搜 `glm53` 也该搜到 `glm-5.3`
 * （与宿主 `normalizeModel` 的宽容度对齐，否则同一个名字在两处行为不一致）。
 * @param {{vendor:string,items:{key:string,rate:object}[]}[]} groups - 分组。
 * @param {string} query - 关键词。
 * @returns {{vendor:string,items:{key:string,rate:object}[]}[]} 过滤后的分组。
 */
function filterGroups(groups, query) {
  const text = String(query ?? '').trim().toLowerCase()
  if (text === '') return groups
  const loose = text.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  const hit = (value) => {
    const raw = String(value ?? '').toLowerCase()
    return raw.includes(text) || loose === '' || raw.replace(/[^a-z0-9\u4e00-\u9fff]/g, '').includes(loose)
  }
  return groups
    .map((group) => ({
      vendor: group.vendor,
      items: group.items.filter((item) => hit(item.key) || hit(item.rate?.label) || hit(group.vendor)),
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * 把宿主回报的状态整理成「编辑页需要的整份文档」。
 *
 * `data.customRates`（宿主 `describe()` 的输出）与 `/dsh-pixel/rates` 的形状一致，
 * 因此两处都能喂进来；缺项一律取安全默认值，**绝不把 undefined 传回保存**——
 * 那会让校验报「顶层需要是一个对象」这种看不出所以然的错。
 * @param {object|undefined} status - 宿主状态。
 * @param {object} [pricing] - 看板数据的 pricing 段（只用它的 usdToCny 兜底）。
 * @returns {{rates:object,markup:Record<string,number>,usdToCny:number}} 文档。
 */
function documentOf(status, pricing) {
  const fallbackFx = Number(pricing?.usdToCny)
  const fx = Number(status?.usdToCny)
  return {
    rates: status?.rates !== null && typeof status?.rates === 'object' ? status.rates : {},
    markup: status?.markup !== null && typeof status?.markup === 'object' ? status.markup : {},
    usdToCny: Number.isFinite(fx) && fx > 0
      ? fx
      : (Number.isFinite(fallbackFx) && fallbackFx > 0 ? fallbackFx : 7.3),
  }
}

/**
 * 解析一份导入的 JSON 文本。
 *
 * 只做「是不是合法 JSON / 是不是对象」这两件事：**内容校验交给宿主**。
 * 两处各写一份校验，迟早出现「界面说没问题、宿主拒绝」这种最难解释的分歧。
 * @param {string} text - 粘贴或读进来的文本。
 * @returns {{document:object}|{error:string}} 解析结果。
 */
function parseImported(text) {
  const source = String(text ?? '').trim()
  if (source === '') return { error: '没有内容：先粘贴一份 JSON，或从文件里导出后再导入' }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return { error: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '顶层需要是一个对象：{ rates, markup, usdToCny }' }
  }
  // 旧格式（扁平「模型键 → 价目」）也接住：整份当成 rates，否则升级插件会让导入失败。
  if (parsed.rates !== null && typeof parsed.rates === 'object' && !Array.isArray(parsed.rates)) {
    return { document: parsed }
  }
  return { document: { rates: parsed, markup: {}, usdToCny: undefined } }
}

/**
 * 导出成一段可读 JSON（写文件 / 粘贴给别的机器用）。
 * @param {object} document - 文档。
 * @returns {string} JSON 文本。
 */
function exportDocument(document) {
  const payload = {
    ...(Number.isFinite(Number(document?.usdToCny)) ? { usdToCny: Number(document.usdToCny) } : {}),
    markup: document?.markup ?? {},
    rates: document?.rates ?? {},
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

			exports.fetchRates = fetchRates
			exports.saveRates = saveRates
			exports.composeRate = composeRate
			exports.draftOf = draftOf
			exports.entryOfDraft = entryOfDraft
			exports.groupByVendor = groupByVendor
			exports.filterGroups = filterGroups
			exports.documentOf = documentOf
			exports.parseImported = parseImported
			exports.exportDocument = exportDocument
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
 *
 * 认不出的窗口（`hourly` / `budget` / `windowN` 之类）**排在已知窗口之后**，
 * 顺序保持宿主给的先后——早先这里用「按固定顺序 map 再 find」的写法，于是
 * 任何新窗口种类都会被静默丢掉。展示「还剩多少」这件事上，**少一格比多一格糟**。
 */
const WINDOW_ORDER = ['fiveHour', 'weekly', 'monthly']

/**
 * 把宿主的窗口数组排成稳定顺序：已知窗口按 {@link WINDOW_ORDER}，其余按原顺序跟在后面。
 * @param {object[]} windows - 宿主返回的窗口。
 * @returns {object[]} 排序后的新数组（不改原数组）。
 */
function orderWindows(windows) {
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
const VENDOR_SHORT = {
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
const VENDOR_SHAPE = {
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
const SHAPE_TEXT = {
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
const VENDOR_LINKS = {
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
const VENDOR_CREDENTIAL_HINT = {
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
function vendorCredentialHint(provider) {
  const id = provider?.id
  if (typeof id !== 'string') return ''
  return VENDOR_CREDENTIAL_HINT[id] ?? ''
}

/**
 * 这一家的入口链接：宿主 `setup.keyURL` 优先，其次旧宿主的回落表。
 * @param {object|undefined} provider - 宿主返回的一家结果。
 * @returns {{href:string,label:string}|undefined} 入口；都没有时 undefined。
 */
function vendorLinkOf(provider) {
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
const EXTRA_PLAN_ROUTES = {
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
function extraPlanIdOfRoute(provider) {
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
async function fetchPlanCredentials(options = {}) {
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
async function removePlanCredentials(refs) {
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
function credentialRows(payload, vendorId) {
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
function credentialFiles(payload, vendorId) {
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
function vendorVerification(provider) {
  return provider?.verification === 'community' ? 'community' : 'first-party'
}

/**
 * 这一家给的是哪种形状（百分比 / 绝对值 / 只有剩余额 / 混合）。
 * @param {object|undefined} provider - 宿主返回的一家结果。
 * @returns {string} 形状 id；认不出时空串。
 */
function vendorShape(provider) {
  const shape = provider?.shape
  if (typeof shape === 'string' && shape !== '') return shape
  return VENDOR_SHAPE[provider?.id] ?? ''
}

/**
 * 形状 id → 一句话说明。
 * @param {string} shape - 形状 id。
 * @returns {string} 说明；认不出时空串。
 */
function shapeText(shape) {
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
function allProviders(payload) {
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
function credentialSummary(payload) {
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
			exports.orderWindows = orderWindows
			exports.VENDOR_SHORT = VENDOR_SHORT
			exports.VENDOR_SHAPE = VENDOR_SHAPE
			exports.SHAPE_TEXT = SHAPE_TEXT
			exports.VENDOR_LINKS = VENDOR_LINKS
			exports.VENDOR_CREDENTIAL_HINT = VENDOR_CREDENTIAL_HINT
			exports.vendorCredentialHint = vendorCredentialHint
			exports.vendorLinkOf = vendorLinkOf
			exports.EXTRA_PLAN_ROUTES = EXTRA_PLAN_ROUTES
			exports.extraPlanIdOfRoute = extraPlanIdOfRoute
			exports.formatQuota = formatQuota
			exports.windowProgress = windowProgress
			exports.quotaTone = quotaTone
			exports.formatReset = formatReset
			exports.formatResetAt = formatResetAt
			exports.formatResetLine = formatResetLine
			exports.providerStatus = providerStatus
			exports.fetchPlans = fetchPlans
			exports.hasAnyQuota = hasAnyQuota
			exports.fetchPlanCredentials = fetchPlanCredentials
			exports.removePlanCredentials = removePlanCredentials
			exports.credentialRows = credentialRows
			exports.credentialFiles = credentialFiles
			exports.vendorVerification = vendorVerification
			exports.vendorShape = vendorShape
			exports.shapeText = shapeText
			exports.allProviders = allProviders
			exports.credentialSummary = credentialSummary
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
const extraPlanIdOfRoute = m3.extraPlanIdOfRoute
const providerById = m3.providerById
const providerStatus = m3.providerStatus
const tightestWindow = m3.tightestWindow
const VENDOR_SHORT = m3.VENDOR_SHORT
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
  const label = PLAN_LABELS[planId] ?? VENDOR_SHORT[planId] ?? provider?.name ?? planId
  const short = PLAN_SHORT[planId] ?? VENDOR_SHORT[planId] ?? provider?.name ?? planId
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
  // 先认新接入的三家（Codex / Cursor / Opencode），再退回 provider.js 那张
  // 与宿主的智谱 / Command Code / 火山候选表成对维护的旧表。两张表互不干扰：
  // 旧表有闸门逐条比对，新表独立成一张，加一家不需要动那个闸门。
  const extraPlanId = extraPlanIdOfRoute(route?.provider)
  const source = extraPlanId === undefined
    ? sourceOfProvider(route?.provider)
    : {
      kind: 'plan',
      planId: extraPlanId,
      label: VENDOR_SHORT[extraPlanId] ?? extraPlanId,
    }
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
		"./team.js": (exports, require) => {
			/**
 * 智能体团队在客户端的派生逻辑：从宿主 `teams[]` 里挑出「当前会话所属的那个团队」，
 * 并把它渲染成费用条要用的两样东西——**一个合计**与**一段按成员分列的说明**。
 *
 * ## 为什么默认显示团队合计
 *
 * 用户在团队模式下关心的不是「我这个 lead 会话花了多少」，而是**这一队一共花了多少**
 * ——teammate 是 lead 派生出去的同一件事的一部分，把它们的钱分开看没有意义。
 * 因此：当前会话属于某个多成员团队时，费用条那一枚显示**团队合计**；
 * 悬停时按成员逐行列出，看得到「谁花的」。
 *
 * ## 三条不能省的退化路径
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 旧宿主（没有 `teams[]`） | 完全退回单会话口径，与改动前逐字节一致 |
 * | 当前会话不属于任何多成员团队 | 同上——单人团队不必单列，那只是普通的会话 |
 * | 宿主给了团队但成员列表为空 | 不显示团队口径（宁可显示单会话，也不显示一个 0） |
 *
 * **第三种是最容易写错的一条**：`teams[]` 里理论上不该出现空成员，但数据来自
 * 磁盘与会话头，宿主的 fail-soft 会让它有机会为空。那时若照直渲染 `¥0.0000`，
 * 用户看到的是「这个团队一分钱没花」——而真实情况是「我们不知道」。
 * @module dsh-pixel-dashboard/client/team
 */

/**
 * 团队归属的稳定键：宿主给的 `teamId`，取不到时退回会话自己。
 *
 * 与宿主 `teamPlacementOf()` 的回落同一条规则：没有父会话的会话**自己就是根**。
 * 两边各写一次是为了让「旧宿主没有 teamId」时仍能算出同一个键——而它们的判据
 * 必须一致，否则宽屏下费用条会显示 A 团队、看板却把它算进 B。
 * @param {object|undefined} session - 会话行。
 * @returns {string} 团队键；连会话都没有时是空串。
 */
function teamKeyOf(session) {
  const teamId = typeof session?.teamId === 'string' ? session.teamId : ''
  if (teamId !== '') return teamId
  return typeof session?.id === 'string' ? session.id : ''
}

/**
 * 找出当前会话所属的团队。
 *
 * 两条判据，缺一不可：
 *   1. 团队里有**不止一个**成员——单人团队就是普通会话，给它换一套口径只会让人困惑；
 *   2. 团队确实包含当前会话——`leadId` 或某个成员 id 命中都算，因为用户可能正停在
 *      某个 teammate 的会话界面里（DSH 允许打开 teammate 的会话）。
 *
 * 命中多个时取**成员最多的那个**：会话头理论上只有一个父会话，因此不该出现多个，
 * 而万一出现（跨设备账本里同一 id 被两条链认领），大团队是信息更全的那一个。
 * @param {object|undefined} data - 宿主响应。
 * @param {string|undefined} sessionId - 当前会话 id。
 * @returns {object|undefined} 命中的团队行；不属于任何团队时为 undefined。
 */
function findTeamOf(data, sessionId) {
  const teams = Array.isArray(data?.teams) ? data.teams : []
  const id = typeof sessionId === 'string' ? sessionId : ''
  if (id === '') return undefined
  let best
  for (const team of teams) {
    if (team === null || typeof team !== 'object') continue
    const members = Array.isArray(team.members) ? team.members : []
    if (members.length < 2) continue
    const inside = team.leadId === id || members.some((member) => member?.id === id)
    if (!inside) continue
    if (best === undefined || members.length > (best.members?.length ?? 0)) best = team
  }
  return best
}

/**
 * 团队里某个成员该显示成什么名字。
 *
 * 三层回落，**每一层都是事实**，不做猜测：
 *   - `name`：宿主从 `team/member` 名册里取到的团队名（`researcher`、`writer` 这种）；
 *   - 会话标题：名册里没有它时（普通子代理、或名册还没落盘）用侧栏那一句话；
 *   - id 片段：两个都没有时的最后保底，让这一行至少不是空白。
 * @param {object|undefined} member - 团队成员。
 * @returns {string} 可显示的名字。
 */
function memberNameOf(member) {
  const name = typeof member?.name === 'string' ? member.name.trim() : ''
  if (name !== '') return name
  const title = typeof member?.title === 'string' ? member.title.trim() : ''
  if (title !== '') return title
  const id = typeof member?.id === 'string' ? member.id : ''
  return id === '' ? '(未知成员)' : `${id.slice(0, 8)}…`
}

/**
 * 把一份团队汇总折成费用条要用的描述。
 *
 * **金额一律取宿主算好的那份**（`team.cost`），不在这里重新累加成员：
 * 宿主已经把「合计 = 成员之和」保证到小数点后 6 位（见 `summarizeTeam`），
 * 客户端再算一遍只会引入第二种取整方式。
 * @param {object|undefined} team - 宿主 `teams[]` 的一行。
 * @param {{formatCny:Function, formatTokens:Function}} format - 格式化函数。
 * @returns {object|undefined} `{cost, tokens, memberCount, lines}`；没有团队时 undefined。
 */
function teamSummaryOf(team, format) {
  const members = Array.isArray(team?.members) ? team.members : []
  if (team === undefined || team === null || members.length < 2) return undefined
  const cost = Number(team?.cost?.standard)
  if (!Number.isFinite(cost)) return undefined
  /**
   * 逐成员一行：金额 + token。刻意**不做排序**——宿主的顺序是「lead 第一、其余按
   * 花费降序」，那是唯一一次排序，在这里重排会让悬停列表与看板里的成员顺序不一致。
   */
  const lines = members.map((member) => {
    // 金额读不出时保留 undefined 而不是折成 0：详情面板要据此整行省略，
    // 而 0 会把「不知道」画成「这个人一分钱没花」。
    const rawCost = Number(member?.cost?.standard)
    const memberCost = Number.isFinite(rawCost) ? rawCost : undefined
    const tokens = Number(member?.tokens ?? 0)
    const role = member?.role === 'lead' ? 'lead' : '成员'
    const name = memberNameOf(member)
    return {
      id: typeof member?.id === 'string' ? member.id : '',
      name,
      role,
      // 面板要的是**结构化数值**，不是拼好的字符串：它要按金额画占比条、
      // 自己决定标签怎么排。字符串只留给悬停说明（`text` / `detail`）。
      cost: memberCost,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
      // token 数缺失时整段省略，而不是写 0——「不知道」与「真的是 0」是两件事。
      text: `${name}（${role}） ${format.formatCny(memberCost ?? 0)}`
        + (Number.isFinite(tokens) && tokens > 0 ? ` · ${format.formatTokens(tokens)} tokens` : ''),
      detail: `${name}（${role}） · `
        + `${format.formatCny(memberCost ?? 0)}`
        + (Number.isFinite(tokens) && tokens > 0 ? ` · ${format.formatTokens(tokens)} tokens` : ''),
    }
  })
  return {
    cost,
    tokens: Number(team?.totals?.local ?? 0),
    memberCount: members.length,
    // 团队标题用于悬停说明的抬头（「团队合计」那一行下面接成员列表）。
    title: typeof team.title === 'string' ? team.title : '',
    lines,
  }
}

/**
 * 团队汇总 → 一句「按成员分列」的纯文本。
 *
 * **不再是界面的一部分。** 它早先喂给费用徽标的 `title` 属性（那是用户说的
 * 「裸文本浮窗」），现在详情由 `costDetail.js` 折成结构化面板。
 * 保留它是因为它仍是一个方便的、可断言的**整体快照**：`tools/render-check.mjs`
 * 用它一眼确认「成员名 + 金额都在」，比逐节翻 sections 更直接，而且它不参与渲染，
 * 将来漂移了也只会让闸门红、不会让界面错。
 * @param {object|undefined} summary - {@link teamSummaryOf} 的结果。
 * @returns {string} 多行文本；没有团队时是空串。
 */
function teamDetailText(summary) {
  if (summary === undefined || summary === null) return ''
  const count = summary.memberCount
  const head = `团队合计（${count} 位成员）`
  return [head, ...summary.lines.map((line) => `· ${line.detail}`)].join('\n')
}

			exports.teamKeyOf = teamKeyOf
			exports.findTeamOf = findTeamOf
			exports.memberNameOf = memberNameOf
			exports.teamSummaryOf = teamSummaryOf
			exports.teamDetailText = teamDetailText
		},
		"./notify.js": (exports, require) => {
			/**
 * 通知（浏览器半边）：判定、去重与文案。**纯逻辑，不含 React**，
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
 *
 * ## 余额与套餐额度预警已整体取消（2.14.0）
 *
 * 用户明确要求这两件事**不要实时通知**：它们的答案应当「想看的时候看一眼」，
 * 而不是把人从别的事里打断。于是：
 *
 *   - `NOTIFY_DEFAULTS` 与 `NOTIFY_FLAGS` 里的 `notifyBalance` / `notifyQuota`
 *     以及两个阈值（`warnBalance` / `warnQuotaPercent`）整项删除；
 *   - 运行时不再有「30 秒查一次余额与额度、按边沿触发」的那条轮询；
 *   - 余额与额度改在**会话标签页**与**输入框费用条**里直接看。
 *
 * 剩下的判定只有两类：**会话结束**（宿主给事实、这里决定措辞与是否打扰）与
 * **待办**（授权 / 提问，浏览器侧直接读）。这两类的口径一字未改——AGENT.md 第 5 节
 * 记着它们踩过的每一个坑（子智能体措辞、失败归属、当前会话不打扰、tag 长度），
 * 本轮改动**不得**触碰那些判据。
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
 * 系统通知 `tag` 的长度上限。
 *
 * ## 为什么不是「随便拼一个可读字符串」（实测踩过，代价极高）
 *
 * 原来 tag 拼成 `dsh-pixel-<sessionId>-<turn>`，实测 56–57 个字符。在浏览器里
 * 一切正常；而在 **DSH 桌面端**（Electron，页面 origin 是自定义协议
 * `dsh-app://app`）里，通知**一条都弹不出来**——而且完全没有报错：
 * `new Notification()` 不抛异常、「最近通知」里也照常留下记录。
 *
 * 根因在 tag 长度：Chromium 交给 Windows 平台的最终 tag 是
 * `n#<origin>#<tag>`，`dsh-app://app` 这段 origin 先占掉十几个字符，剩下的预算
 * 只够 tag 本身约 34 个字符（Electron 的 issue #40433 记的正是「Windows 11 下
 * tag 超过 34 个字符，web 通知就不工作」，他们用 37 字符的 UUID 当 tag 时全丢）。
 * `ToastNotification.Tag` 本身的上限是 16（Creators Update 后 64），但账是连着
 * origin 一起算的。超长不会报错，只会被静默丢弃——这正是最难查的那一类。
 *
 * 所以 tag 一律由 {@link noticeTag} 生成：短前缀 + 哈希，总长压在 24 以内，
 * 留足 origin 的预算。可读性由面板里的「最近通知」负责，tag 只需要**能区分、
 * 能替换**。
 */
const TAG_MAX = 24

/**
 * 32 位 FNV-1a → base36。
 *
 * 只为了把「会话 id + 轮次」这类长种子压成稳定短串：同一个种子永远得到同一个
 * tag（替换语义成立），不同种子几乎必然不同（36^7 的空间）。
 * @param {string} text - 种子。
 * @returns {string} 6–7 个字符的 base36 串。
 */
function hash36(text) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).padStart(6, '0')
}

/**
 * 生成一条系统通知的 tag。
 *
 * 前缀只是**短码**（一个字符），用于让不同类别的通知互不顶掉：`n` 会话结束、
 * `p` 子智能体进展、`i` 待办。余额 / 额度预警那两个前缀（`b` / `q`）随该功能
 * 一起删掉了——现在只剩这三类会真的派发通知。
 * @param {string} kind - 类别短码。
 * @param {string} seed - 决定「是否同一条」的种子；同种子 → 同 tag（替换旧通知）。
 * @returns {string} 不超过 {@link TAG_MAX} 的 tag。
 */
function noticeTag(kind, seed) {
  const prefix = `dsh-px-${String(kind ?? 'x').slice(0, 1)}-`
  return `${prefix}${hash36(String(seed ?? ''))}`
}

/**
 * 通知配置的默认值，与宿主 lib/notify.js 的 `NOTIFY_DEFAULTS` 一致。
 *
 * 两侧各留一份是刻意的：宿主那份是**权威**（每次读取都会带上），这份只在
 * 「宿主还没答话」时兜底，好让面板第一帧就能渲染出正确的开关状态而不是空壳。
 * 两边改一处忘了另一处**不会**造成功能错误——宿主的回应总会覆盖它。
 *
 * 余额 / 额度阈值那几项已随预警功能一起删除（见模块说明）。
 */
const NOTIFY_DEFAULTS = {
  notifyEnabled: true,
  notifyDone: true,
  notifySubagent: true,
  notifyError: true,
  notifyInteraction: true,
  notifyQuietFocused: true,
  notifySound: 'system',
  notifySoundUrl: '',
}

/**
 * 提示音选项：面板按这个顺序渲染，客户端按 `value` 决定发不发、发哪一声。
 *
 * `system` 与 `off` 的差别只在「我们动不动手」：前者不碰系统通知的音效
 * （也就是现在的行为），后者把系统通知设成 `silent`。
 * 其余三个内置音效 + 自定义地址都是**由插件自己发声**，同时把系统通知设成
 * `silent`——否则会变成「系统一声 + 插件一声」的双响。
 */
const NOTIFY_SOUND_OPTIONS = [
  { value: 'system', label: '跟随系统（默认）', hint: '不改动系统通知的音效' },
  { value: 'off', label: '关闭提示音', hint: '只静音 DSH 的通知气泡，不动 Windows 全局声音设置' },
  { value: 'chime', label: '清脆', hint: '两下短促的高音' },
  { value: 'soft', label: '柔和', hint: '一声低缓的正弦音' },
  { value: 'deep', label: '深沉', hint: '一声沉闷的低音' },
  { value: 'custom', label: '自定义音频地址', hint: '填一个 http(s) 音频链接或 data:audio/…；留空则不出声' },
]

/** 内置音效：频率与时长都写在这里，避免散落在播放逻辑里。 */
const SOUND_TONES = Object.freeze({
  chime: Object.freeze([{ hz: 880, ms: 90 }, { hz: 1320, ms: 130 }]),
  soft: Object.freeze([{ hz: 523, ms: 220 }]),
  deep: Object.freeze([{ hz: 196, ms: 260 }]),
})

/** 开关的展示元数据：面板按这个顺序渲染，文案只有这一份来源。 */
const NOTIFY_FLAGS = [
  { key: 'notifyEnabled', label: '总开关', hint: '关掉后不再弹任何通知（面板仍会记录最近发生的事）' },
  { key: 'notifyDone', label: '任务完成', hint: '一轮对话正常跑完时提醒' },
  { key: 'notifySubagent', label: '子智能体进展', hint: '子智能体（含团队里的成员）跑完一轮时提醒。它的结论写作「有新进展」而不是「完成」——那只是进展同步，不是「该你了」；关掉后连进展也不再弹。失败不受这个开关影响' },
  { key: 'notifyError', label: '失败 / 中断', hint: '轮次报错、被取消、达到输出上限或异常结束时提醒' },
  { key: 'notifyInteraction', label: '等待授权 / 回答', hint: '需要你点授权，或 AI 提问等你回答时提醒' },
  { key: 'notifyQuietFocused', label: '当前会话不打扰', hint: '只有你确实正在看这条会话（窗口在前台、页面可见、刚才在页面里动过）时，它跑完才不弹通知；一但你切到别的应用就照常提醒' },
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
 * 「最近通知」里给**弹窗失败**那条加的尾注。
 *
 * 与 {@link QUIET_MARK} 同一套理由：一条记进了列表却没有任何气泡的提醒，和
 * 「功能漏了」在界面上完全一样。区别是它**不是设计行为**，所以这里直接写出
 * 失败原因，用户才能区分「环境不支持系统通知」与「这一条弹不出来」。
 *
 * 这条尾注的由来是实测：桌面端同一个进程里，控制台 `new Notification()` 能弹，
 * 插件里同样的调用却弹不出，而 `catch` 当时把原因吞了——只剩「有记录、没气泡」
 * 这个无从解释的现象。失败必须可归因。
 * @param {string} reason - 失败原因。
 * @returns {string} 尾注文本。
 */
function failedMark(reason) {
  return `〔未弹出：${String(reason ?? '原因未知')}〕`
}

/**
 * 「最近通知」里给**点击跳转失败**加的尾注。
 *
 * 用户报过：「点通知只把窗口带到前台、会话没切」。这条尾注让失败当场可见，
 * 而不是靠用户描述现象 + 开发者反查宿主 API（那一次查了很久：插件调的
 * `sessions.open` 在 0.2.1 上根本不存在）。
 * @param {string} reason - 失败原因。
 * @returns {string} 尾注文本。
 */
function clickFailedMark(reason) {
  return `〔跳转失败：${String(reason ?? '原因未知')}〕`
}

/**
 * 由提示音配置决定要不要自己发声、系统通知要不要静音。
 *
 * 两者必须**成对**决定：自己发声时系统通知必须 `silent`，否则双响；
 * 跟随系统时自己绝不发声，否则同样双响。
 * @param {object|undefined} config - 通知配置。
 * @returns {{silent:boolean, play:'chime'|'soft'|'deep'|'custom'|undefined, url:string}} 播放口径。
 */
function soundPlan(config) {
  const mode = typeof config?.notifySound === 'string' ? config.notifySound : 'system'
  const url = typeof config?.notifySoundUrl === 'string' ? config.notifySoundUrl : ''
  if (mode === 'system') return { silent: false, play: undefined, url: '' }
  if (mode === 'off') return { silent: true, play: undefined, url: '' }
  if (mode === 'custom') {
    // 选了自定义却没填可用地址：静音系统那声是**错的**（那样就彻底没声音了），
    // 因此退回「跟随系统」——用户至少还能听到默认提示音。
    if (url === '') return { silent: false, play: undefined, url: '' }
    return { silent: true, play: 'custom', url }
  }
  return { silent: true, play: mode, url: '' }
}

/**
 * 播放一次提示音。
 *
 * **面板的「试听」和真实通知走的是同一个函数**——否则会出现「试听是这个声、
 * 真实通知是另一个声」这种最难解释的不一致。运行时与面板都调它。
 *
 * 全程 try/catch 且不抛：`AudioContext` 可能需要用户手势才能 resume、也可能被
 * 策略禁用，而声音只是附加体验，放不出来绝不该影响通知本身。
 * @param {{play:string|undefined,url:string}} plan - {@link soundPlan} 的产出。
 * @param {object} [scope] - 全局对象（取 AudioContext / Audio），测试可注入。
 * @param {object} [cache] - 复用的 AudioContext 缓存对象，避免每次新建。
 */
function playSound(plan, scope = globalThis, cache = {}) {
  const mode = plan?.play
  if (mode === undefined) return
  try {
    if (mode === 'custom') {
      const AudioCtor = scope?.Audio
      if (typeof AudioCtor !== 'function' || plan.url === '') return
      const audio = new AudioCtor(plan.url)
      const played = audio.play?.()
      if (played !== undefined && typeof played.catch === 'function') played.catch(() => {})
      return
    }
    const tones = SOUND_TONES[mode]
    if (tones === undefined) return
    const Ctx = scope?.AudioContext ?? scope?.webkitAudioContext
    if (typeof Ctx !== 'function') return
    cache.ctx ??= new Ctx()
    const ctx = cache.ctx
    if (ctx?.state === 'suspended') void ctx.resume?.()
    let cursor = 0
    for (const tone of tones) {
      const start = ctx.currentTime + cursor
      const end = start + tone.ms / 1000
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = tone.hz
      // 简单包络：直接开关会有爆音，两头各留一小段淡入淡出。
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.18, start + 0.012)
      gain.gain.linearRampToValueAtTime(0, end)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(end)
      cursor += tone.ms / 1000 + 0.02
    }
  } catch {
    // 声音是附加体验：放不出来不影响任何别的事。
  }
}

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
  // 弹窗失败的那条同理，但尾注不同——那是 bug，不是设计。
  const quiet = item?.quiet === true ? QUIET_MARK : ''
  const failed = typeof item?.failed === 'string' && item.failed !== '' ? failedMark(item.failed) : ''
  const clickFailed = typeof item?.clickFailed === 'string' && item.clickFailed !== '' ? clickFailedMark(item.clickFailed) : ''
  return `${title}${body}${quiet}${failed}${clickFailed}`
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
 * 「你真的在看这条会话」的空闲窗口：页面里最近一次真实输入距今超过这个时长，
 * 就不再认为用户在看着它。
 *
 * ## 为什么单靠 `document.hasFocus()` 不够（用户报的漏提醒）
 *
 * 原先这里只问焦点。而在 Electron 里焦点读数是**已知不可靠**的：窗口若在
 * 「未被聚焦」的状态下加载（托盘唤起、启动时另一个窗口在前台、从后台恢复），
 * `document.hasFocus()` 会**一直返回 true**，且无法从那个状态被 blur 掉
 * （electron/electron#7125、#28897）。
 *
 * 一旦它卡在 true，判据就恒定成立：主会话每跑完一次都被当成「你正看着它」而
 * 静默——而子智能体是**另一条会话 id**，根本不参与这条比较，照常弹。用户看到
 * 的正是「只有子智能体完成才提醒，自己的会话跑完一声不响」。
 *
 * 因此「在场」必须由**只有真实用户才会产生的信号**兜底：页面里到底有没有过输入
 * 事件。人在别的应用里时，指针、按键、滚轮一个都不会到达本页面。
 *
 * 5 分钟是刻意的**宽松**值：这一条只是兜底，主判据仍是焦点与可见性；窗口取太
 * 小会把「盯着长任务跑、手没动」也判成不在场（多弹一次），取太大则兜底失效。
 */
const QUIET_IDLE_MS = 5 * 60_000

/**
 * 算作「用户在场」的输入事件。
 *
 * 全部用 capture + passive 监听：只需要一个时间戳，绝不能因此影响页面滚动，
 * 也不该让这些高频事件进入调用栈。
 */
const PRESENCE_INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']

/**
 * 在场跟踪：把「用户此刻是不是真的在这个页面上」从几个都不可靠的信号拼出来。
 *
 * ## 三个信号，各补各的漏洞
 *
 *   - **焦点**：自己维护一个标记，由窗口级 `focus` / `blur` 事件驱动。比起直接
 *     读 `document.hasFocus()`，它至少能在「窗口真的失焦过」之后立刻变假——
 *     而这正是用户切去别的应用时发生的事。初值仍取自 `hasFocus()`：读不到焦点
 *     的浏览器几乎不存在，把它当初值只是为了避免「刚加载就当成不在场」。
 *   - **可见性**：`visibilitychange` 驱动。最小化 / 被遮挡时页面是 `hidden`，
 *     而焦点标记在部分平台上未必跟着变。
 *   - **最近输入**：页面里最近一次指针 / 按键 / 滚轮 / 触摸 / 滚动的时间。
 *     这是唯一**只有真实用户才能产生**的信号，也是 `hasFocus()` 卡死时的兜底。
 *
 * ## 判不出来时一律「不在场」（= 照常提醒）
 *
 * 少静默一次最多是「你盯着它跑完，通知和界面同时响」这种轻微打扰；多静默一次
 * 则是一条**永远不会被看见**的提醒。两者不对称，所以只要有一项读数缺失
 * （没有 `document`、没装事件、还没产生过任何输入），就必须落到「不在场」。
 *
 * 纯逻辑、不碰 React：闸门可以注入假 `scope` 与假时钟，逐条钉住这些行为。
 */
class PresenceTracker {
  /**
   * @param {object} [scope] - 全局对象（浏览器里是 `window`），测试注入用。
   * @param {object} [options] - 选项。
   * @param {number} [options.idleMs] - 空闲窗口上限。
   * @param {() => number} [options.now] - 时钟，测试注入用。
   */
  constructor(scope = globalThis, { idleMs = QUIET_IDLE_MS, now = () => Date.now() } = {}) {
    this.scope = scope
    this.document = scope?.document
    this.idleMs = idleMs
    this.now = now
    /**
     * 最近一次真实输入的时间戳。
     *
     * **初值刻意是 `undefined` 而不是「现在」**：页面刚加载时用户还没动过任何东西，
     * 说「他刚刚在看」是无中生有。`undefined` 会让 {@link PresenceTracker#read}
     * 如实回报「判不出来」，从而照常提醒。
     */
    this.lastInputAt = undefined
    this.focused = this.document?.hasFocus?.() === true
    this.visible = this.document?.visibilityState !== 'hidden'
    /** @type {Array<{target:object,type:string,handler:Function,options:object|boolean}>} */
    this.listeners = []
    this.started = false
  }

  /**
   * 记一次「用户动过了」。
   *
   * 公开是给闸门与测试用的：注入假 `scope` 时没有真实事件源，只能直接喂时间戳。
   */
  noteInput() {
    this.lastInputAt = this.now()
  }

  /**
   * 读当前在场的三项事实。
   * @returns {{focused:boolean,visible:boolean,idleMs:number|undefined}} 读数；
   *   `idleMs` 为 undefined 表示「还没见到任何输入」。
   */
  read() {
    const idleMs = this.lastInputAt === undefined
      ? undefined
      : Math.max(0, this.now() - this.lastInputAt)
    return { focused: this.focused, visible: this.visible, idleMs }
  }

  /** 装上事件监听。重复调用无副作用。 */
  start() {
    if (this.started) return
    this.started = true
    const on = (target, type, handler, options) => {
      if (typeof target?.addEventListener !== 'function') return
      target.addEventListener(type, handler, options)
      this.listeners.push({ target, type, handler, options })
    }
    // 焦点用窗口级事件，`capture` 保证即使有更早的 stopPropagation 也能收到。
    on(this.scope, 'focus', () => { this.focused = true }, true)
    on(this.scope, 'blur', () => { this.focused = false }, true)
    for (const type of PRESENCE_INPUT_EVENTS) {
      on(this.document, type, () => { this.noteInput() }, { capture: true, passive: true })
    }
    on(this.document, 'visibilitychange', () => {
      this.visible = this.document?.visibilityState !== 'hidden'
    }, false)
  }

  /** 卸掉全部监听。插件卸载时调用。 */
  stop() {
    for (const { target, type, handler, options } of this.listeners) {
      try {
        target.removeEventListener(type, handler, options)
      } catch {
        // 目标已销毁（页面正在卸载）时移除会抛错：监听随页面一起消失，不必处理。
      }
    }
    this.listeners = []
    this.started = false
  }
}

/**
 * 这条会话结束提醒是否应当**不打扰**。
 *
 * 六条**同时**成立才跳过，缺一条就照常提醒：
 *
 *   1) 开关开着（默认开着）；
 *   2) 页面有焦点——否则用户切去了别的标签页 / 别的应用，正是最该提醒的时候；
 *   3) 页面**可见**——最小化或被遮挡时的焦点读数不可信；
 *   4) 这条提醒说的**就是**当前选中的那条会话；
 *   5) 那条会话的界面**真的在屏幕上**（见 {@link conversationOnScreen}）；
 *   6) 用户确实刚在页面里动过（`idleMs` 在 {@link QUIET_IDLE_MS} 以内）。
 *
 * 第 5 条是 2.8.0 补的：只比 `current` 会把「主区停在看板上」误判成「正在看这条
 * 会话」，于是那条会话完成时提醒被静默吞掉。
 *
 * 第 3、6 条是后补的，起因同样是用户报的漏提醒，但根子在 Electron：窗口在未聚焦
 * 状态下加载时 `document.hasFocus()` 会永远为 true（electron/electron#7125），
 * 于是判据恒定成立、主会话的提醒被无声吞掉。可见性与「最近有没有真实输入」是
 * 不依赖那个读数的独立证据——人在别的应用里时，页面收不到任何输入事件。
 *
 * 纯函数：所有环境读数由调用方取好传进来，因此闸门可以逐条钉住这六件事。
 * @param {object} notice - 宿主通知记录。
 * @param {object} view - 当前视图事实。
 * @param {object|undefined} view.config - 通知配置。
 * @param {boolean} view.focused - 窗口是否持有焦点。
 * @param {boolean} [view.visible] - 页面是否可见（缺省按可见处理）。
 * @param {number} [view.idleMs] - 距最近一次真实输入的毫秒数；undefined 表示判不出来。
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
  // 只有**确证不可见**才据此不静默；读不到可见性（测试里的假 document、被裁掉的
  // API）时不拿它当理由，交给下面两条更硬的判据。
  if (view?.visible === false) return false
  // 判不出「用户最近有没有动过」时同样**不静默**：这条正是 Electron 焦点卡死时的
  // 兜底，读不到就绝不替用户回答「他正在看」。
  if (!Number.isFinite(view?.idleMs)) return false
  if (view.idleMs > QUIET_IDLE_MS) return false
  const sessionId = String(notice?.sessionId ?? '')
  // 没有会话 id 的提醒（余额 / 套餐阈值）不属于任何会话，谈不上「正在看它」。
  if (sessionId === '') return false
  const current = view?.current
  if (current === undefined || String(current) !== sessionId) return false
  return view?.onScreen === true
}

/**
 * 子智能体「跑完一轮」的结论词。
 *
 * **不能复用宿主给的「已完成」。** 同一条「已完成」放在主会话身上意思是
 * 「模型输出完了，可以继续推进」，放在子智能体身上却只是「某个成员收工了」——
 * 主会话往往还在等它。用户报过这个错误：桌面通知在子智能体完成时弹出，而内容
 * 里没有任何一个字说明这是子智能体，读起来就像是自己的会话跑完了。
 *
 * 因此子智能体的完成一律写成「有新进展」：它描述的是**进展**，不是结论。
 */
const SUBAGENT_PROGRESS_LABEL = '有新进展'

/**
 * 子智能体「没跑完」的结论词。
 *
 * 同理，「失败」这两个字在两类会话上的分量完全不同：主会话失败 = **你的事没成**，
 * 而某个成员失败往往只是这一段没成——lead 可能重试、可能换人、也可能带着这个空洞
 * 继续往下走。两者共用一个词，就会把「一个成员出错」读成「我的任务失败了」，
 * 而那种误读会直接改变用户下一步做什么（回去重开 vs. 继续等）。
 *
 * 用「未完成」而不是「失败」：它同时覆盖 `error` 之外那几种没跑完的原因（被取消、
 * 达到输出上限……），且**不淡化严重程度**——等级仍由宿主给（`error` 是红框带声音，
 * `warn` 是黄框），只是结论词不再冒充「你的任务失败了」。
 *
 * 其余几种没跑完的原因（已中断 / 被阻断 / 达到输出上限 / 异常结束）保留宿主给的
 * 原词：它们本来就与「失败」不是同一个词，加上「子智能体 xx」前缀已经足够区分，
 * 换成笼统的「未完成」反而丢掉了具体原因。
 */
const SUBAGENT_INCOMPLETE_LABEL = '未完成'

/** 子智能体进展通知的正文前缀（「进展同步」而不是「已完成」）。 */
const SUBAGENT_PROGRESS_PREFIX = '进展同步'

/** 子智能体进展通知的等级：沿用提示条的等级类名 `px-toast-*`（见 theme.js）。 */
const SUBAGENT_PROGRESS_LEVEL = 'progress'

/**
 * 子智能体通知的标题写成什么样。
 *
 * 三层信息，按「谁会看这一行」排序：
 *   - **是子智能体**（这决定了该怎么读这条通知）；
 *   - **是哪一个**（团队里常有好几个成员，只说「子智能体」等于没说）；
 *   - **发生了什么**（完成 / 失败 / 中断…）。
 *
 * 名字缺失时**不编名字**，退回「子智能体」三个字：编一个「子智能体 1」会让人
 * 以为那是真名，去侧栏里永远找不到它。
 * @param {string} workspace - 工作目录名。
 * @param {string} name - 子智能体名字（可为空）。
 * @param {string} mark - 结论词。
 * @returns {string} 标题。
 */
function subagentTitle(workspace, name, mark) {
  return name === ''
    ? `${workspace} · 子智能体${mark}`
    : `${workspace} · 子智能体 ${name} ${mark}`
}

/**
 * 由一条宿主通知事实拼出通知标题与正文。
 *
 * 标题带工作目录名：同时跑几个会话时，「已完成」这三个字本身不提供任何信息，
 * 而「哪个目录完成了」才是你要判断「现在要不要回去看」的依据。
 *
 * ## 两条不同的通知，语义不同（用户明确要求）
 *
 * | 谁的 `turn/end` | 说的是什么 | 结论词 |
 * |---|---|---|
 * | 主会话 | 完成 = **模型输出完毕，可以继续推进**；失败 = **你的事没成** | 宿主给的「已完成 / 失败」原样用 |
 * | 子智能体 / teammate | 只是**某个成员**收工了 / 没跑完，主会话通常还在继续 | 「有新进展」/「未完成」 |
 *
 * **失败也要区分开**（用户追加要求）：同一条「失败」放在子智能体身上会被读成
 * 「我的任务失败了」——而实际上 lead 可能重试、换人或带着这个空洞继续。
 * 因此子智能体的 `error` 写作「未完成」，其余没跑完的原因（已中断 / 被阻断 /
 * 达到输出上限 / 异常结束）保留原词：它们本就不是「失败」这个词。
 *
 * **严重程度不降级。** 只有**结论词**换了，等级仍由宿主给：`error` 是红框带声音，
 * `warn` 是黄框。把子智能体的失败降成「进展」那种弱一档，等于把需要你看一眼的
 * 事藏起来——那违背本项目「认不出的原因必须落到失败一侧，绝不假装完成」的口径。
 * @param {object} notice - 宿主 lib/notify.js 产出的记录。
 * @returns {{title:string,body:string,tag:string,level:string,sessionId:string,subagent:boolean,agentName?:string}} 文案。
 */
function composeNotice(notice) {
  const workspace = typeof notice?.workspace === 'string' && notice.workspace !== ''
    ? notice.workspace
    : '(未知目录)'
  const label = typeof notice?.label === 'string' && notice.label !== '' ? notice.label : '已结束'
  const turn = Number(notice?.turn ?? 0)
  // 子智能体身份与名字：宿主给（`subagent` 字段只在**是**的时候出现）。
  // 旧宿主没有这两个字段 → 这里全部落空 → 与改动前完全一致的文案。
  const isSubagent = notice?.subagent === true
  const agentName = typeof notice?.agentName === 'string' ? notice.agentName.trim() : ''
  const agentLabel = typeof notice?.agentLabel === 'string' ? notice.agentLabel.trim() : ''
  const isProgress = isSubagent && notice?.category === 'done'
  /**
   * 子智能体的结论词。
   *
   * - 跑完一轮 → 「有新进展」（这是进展，不是「该你了」）；
   * - `error`（宿主的「失败」）→ 「未完成」（别冒充「你的任务失败了」）；
   * - 其余原因（已中断 / 达到输出上限……）→ **保留宿主原词**：它们本来就与
   *   「失败」不同，换成笼统的「未完成」只会丢掉具体原因。宿主的口径表见
   *   lib/notify.js 的 `TURN_OUTCOMES`。
   */
  const subagentMark = isProgress
    ? SUBAGENT_PROGRESS_LABEL
    : (notice?.outcome === 'error' ? SUBAGENT_INCOMPLETE_LABEL : label)
  const mark = isSubagent ? subagentMark : label

  const parts = []
  // 进展类通知先说明它是什么性质的提醒，再说细节：**先定性，再报量**。
  // 反过来（「第 2 轮 · 10:42 · 进展同步」）会让用户先读到一组数字才明白
  // 这不是在叫他回去。
  if (isProgress) {
    parts.push(agentLabel === '' ? SUBAGENT_PROGRESS_PREFIX : `${SUBAGENT_PROGRESS_PREFIX}：${agentLabel}`)
  }
  if (notice?.detail !== undefined && notice.detail !== '') parts.push(String(notice.detail))
  if (notice?.code !== undefined && notice.code !== '') parts.push(`(${notice.code})`)
  parts.push(turn > 0 ? `第 ${turn} 轮` : '会话')
  // 带上发生时刻：通知中心里会同时躺着新旧好几条，用户判断「哪条是刚才的、
  // 该点哪条」全靠这个。顺带也让「点了没反应」能被区分成「点了旧通知」。
  const at = Number(notice?.at)
  if (Number.isFinite(at) && at > 0) {
    parts.push(new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
  }
  return {
    title: isSubagent ? subagentTitle(workspace, agentName, mark) : `${workspace} · ${label}`,
    body: parts.join(' · '),
    // tag 让同一条会话的新通知替换旧的那条，而不是在通知中心堆成一列。
    // 子智能体用**另一个前缀**：它的通知与主会话的通知是两条不同的事，
    // 不该互相顶掉（`p` 只是短码，长度预算见 TAG_MAX 的说明）。
    tag: noticeTag(isProgress ? 'p' : 'n', `${String(notice?.sessionId ?? '')}:${turn}`),
    level: isProgress ? SUBAGENT_PROGRESS_LEVEL : (typeof notice?.level === 'string' ? notice.level : 'ok'),
    // 会话 id 单独带一份（**不**去解析 tag）：点击通知要能切到那条会话。
    // 从 tag 反解析看似可行，但 tag 是人可读的拼接串，格式一变就静默失效。
    sessionId: typeof notice?.sessionId === 'string' ? notice.sessionId : '',
    // 面板据此能把「进展」与「结论」分开看；旧宿主没有这个字段时为 false。
    subagent: isSubagent,
    ...(agentName === '' ? {} : { agentName }),
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
      tag: noticeTag('i', `approval:${key}`),
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
      tag: noticeTag('i', `${kind}:${key}`),
      level: 'warn',
      sessionId,
    }
  }
  return {
    title: '需要你处理',
    body: '有一个待办需要你的输入',
    tag: noticeTag('i', `interaction:${key}`),
    level: 'warn',
    sessionId,
  }
}

/* 余额预警 / 套餐额度预警：**整段代码已删除**（2.14.0 / v3）─────────────
 *
 * 这两项预警是用户明确点名要去掉的：余额与额度不是「必须当下处理」的事，
 * 一条会自己响的通知只会训练人把它关掉；它们真正的去处是**读数**——
 * 会话标签页里的「当前模型来源的账户」与输入框上方那枚费用条。
 *
 * 因此 `balanceAlerts` / `quotaAlerts` / `composeBalanceAlert` / `composeQuotaAlert`
 * / `AlertLatch` 全部移除，**不要加回来**：加回来就等于把「30 秒轮询 + 边沿触发 +
 * 要维护阈值」那套链重新塞进插件。闸门（`tools/render-check.mjs` 第 695–722 行）
 * 现在用反向断言守着这件事。
 */
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
 * 请宿主把 DSH 桌面端窗口拉到前台。
 *
 * ## 为什么不在渲染进程里做
 *
 * 渲染进程没有这个能力：实测 `window.focus()` 返回 undefined、窗口不动，
 * 而 preload 暴露的桥（`PLATFORM_IPC` / `DESKTOP_IPC`）里没有 focus / activate /
 * raise 任何一个。桌面壳的主进程里倒是有现成实现 `focusPrimaryWindow()`
 * （restore → show → focus），它被托盘点击、`app.on('activate')` 和
 * **`dsh://open` 协议**三处触发。
 *
 * 渲染进程触发不了协议（主窗口的 `setWindowOpenHandler` 只放行 http/https），
 * 但**宿主是 Node 进程**，可以用系统命令唤起 `dsh://open`——`/dsh-pixel/focus`
 * 就是做这件事的。
 *
 * ## 失败不影响调用方
 *
 * 纯浏览器（`dsh web`）没有这个协议处理器，窗口本来也不需要「拉起来」。
 * 因此这里**永不抛错**，只回报结果：点击通知的主职责是「切到那条会话」，
 * 拉窗口是加分项，绝不能因为它失败而中断。
 * @returns {Promise<{attempted:boolean,ok:boolean}>} 结果；网络失败也算 `ok:false`。
 */
async function requestFocus() {
  try {
    const response = await fetch(`${NOTIFY_URL.replace(/\/notify$/, '')}/focus`, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { attempted: true, ok: false }
    const body = await response.json()
    return { attempted: body?.attempted !== false, ok: body?.ok === true }
  } catch {
    return { attempted: true, ok: false }
  }
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
			exports.TAG_MAX = TAG_MAX
			exports.hash36 = hash36
			exports.noticeTag = noticeTag
			exports.NOTIFY_DEFAULTS = NOTIFY_DEFAULTS
			exports.NOTIFY_SOUND_OPTIONS = NOTIFY_SOUND_OPTIONS
			exports.SOUND_TONES = SOUND_TONES
			exports.NOTIFY_FLAGS = NOTIFY_FLAGS
			exports.PERMISSION_TEXT = PERMISSION_TEXT
			exports.QUIET_MARK = QUIET_MARK
			exports.failedMark = failedMark
			exports.clickFailedMark = clickFailedMark
			exports.soundPlan = soundPlan
			exports.playSound = playSound
			exports.composeRecentLine = composeRecentLine
			exports.permissionOf = permissionOf
			exports.CONVERSATION_ANCHOR_SELECTOR = CONVERSATION_ANCHOR_SELECTOR
			exports.FULLSCREEN_OVERLAY_SELECTOR = FULLSCREEN_OVERLAY_SELECTOR
			exports.conversationOnScreen = conversationOnScreen
			exports.QUIET_IDLE_MS = QUIET_IDLE_MS
			exports.PRESENCE_INPUT_EVENTS = PRESENCE_INPUT_EVENTS
			exports.PresenceTracker = PresenceTracker
			exports.shouldStayQuiet = shouldStayQuiet
			exports.SUBAGENT_PROGRESS_LABEL = SUBAGENT_PROGRESS_LABEL
			exports.SUBAGENT_INCOMPLETE_LABEL = SUBAGENT_INCOMPLETE_LABEL
			exports.SUBAGENT_PROGRESS_PREFIX = SUBAGENT_PROGRESS_PREFIX
			exports.SUBAGENT_PROGRESS_LEVEL = SUBAGENT_PROGRESS_LEVEL
			exports.composeNotice = composeNotice
			exports.composeInteraction = composeInteraction
			exports.SeenTracker = SeenTracker
			exports.fetchNotify = fetchNotify
			exports.fetchNotices = fetchNotices
			exports.saveNotify = saveNotify
			exports.requestFocus = requestFocus
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
 * （午休 2 小时、周末 63 小时，春节那种连休更长），环在长段里几乎不动，看起来像坏了。
 * 文字直说「还剩多久」既准确又省地方。

 * ## 空闲不一定是因为周末

 * 官方口径里，**法定节假日全天也按空闲计费**（见宿主 ./pricing.js 与 ./holidays.js）。
 * 于是国庆期间的周四、周五白天同样是空闲——此时宿主会在快照里带上节日名，
 * 悬停说明因此写成「国庆节 · 空闲时段」而不是干巴巴的「空闲时段」：
 * 「星期几本来是工作日，怎么便宜了」正是这一刻最需要解释的事。
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
  // 为什么现在是空闲：落在法定节假日里时宿主会给出节日名（国庆节 / 春节…）。
  // 它**只影响措辞**——颜色与倒计时仍然只由 peak 决定，因此旧宿主（没有这个字段）
  // 除少了一句解释外，行为完全不变。
  const holiday = typeof period.holiday === 'string' ? period.holiday : ''

  return {
    peak,
    holiday,
    // 红 = 高峰（正贵着）、绿 = 空闲（正便宜）。侧栏那段文字的颜色由它决定。
    tone: peak ? 'red' : 'green',
    // 空闲落在节假日里时说清是哪个节。国庆那种「星期几本来是工作日」的假期，
    // 光写「空闲时段」解释不了它为什么便宜，而用户看到的正是「周四白天却便宜了」。
    label: peak ? '高峰时段' : (holiday === '' ? '空闲时段' : `${holiday} · 空闲时段`),
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
 *      固定轮询，因为不同时段长度差得极远（午休 2 小时、周末 63 小时、春节连休 255 小时）；
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
const CLIENT_VERSION = 'a3dffd0e'

/**
 * 本客户端需要宿主提供的能力。宿主在数据里声明它支持哪些，
 * 客户端只检查自己真正要用的项——缺少时逐项降级，而不是整页报错。
 */
const CAPABILITIES = [
  'period',
  'periodClock',
  'peakRule',
  // 时段口径从「周末 + 工作日高峰」改成「周末 + 法定节假日全天都空闲」。
  // 缺这一项说明宿主还是旧口径：国庆那类日子的白天会被算成高峰，金额偏高两倍。
  'holidayCalendar',
  'sessionCost',
  'calendarByDay',
  'tieredRates',
  // 智能体团队：响应里多了 `teams[]`，`sessions[]` 上多了 `teamId` / `role`。
  // 缺这一项说明宿主是旧版本 —— 那时费用条只显示单会话金额（团队口径不可用），
  // 看板照常，不整块降级。
  'agentTeam',
]

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
      // 说明小字已删除（用户要求）：悬停读数本来就在浮层里。
    ),
  )
}

/**
 * 柱状图：逐日金额 / 逐日构成。
 *
 * 两种模式，对应两类**完全不同**的问题：
 *   - `stacked`（堆叠）：一根柱子由几段构成，回答「这一天里各段各占多少」。
 *     段与段之和就是那一天的合计，因此柱高与卡片上的合计数必须相等。
 *     用于「Token 趋势 · 构成」（缓存命中 / 未命中 / 写入 / 输出）。
 *   - 默认（分组）：每天并列几根独立的柱子，回答「同一天的几个口径各是多少」。
 *     用于「消费趋势」——官方价与我的价是同一个问题的两个答案，**不能叠加**
 *     （叠起来的高度没有任何含义）。
 *
 * 与 {@link TrendChart} 共用同一套度量方式与视觉语言（渐变不参与、坐标轴 5 档、
 * 悬停读数浮层），这样两张卡片并排时横轴刻度能落在同一列上。
 * @param {object} props - points / series / stacked / formatAxis / formatValue / height。
 * @returns {object} React 元素。
 */
function BarChart(props) {
  const {
    points, series, stacked = false, formatAxis, formatValue, height = 240, ariaLabel,
  } = props
  const [hover, setHover] = useState(null)
  const [wrapRef, width] = useMeasuredWidth(720)

  const pad = { top: 16, right: 14, bottom: 26, left: 58 }
  const innerW = Math.max(60, width - pad.left - pad.right)
  const innerH = Math.max(60, height - pad.top - pad.bottom)
  const list = Array.isArray(points) ? points : []
  const lines = Array.isArray(series) ? series : []

  /** 一根柱（或一组柱）要用到的数值：脏值一律当 0，绝不让 NaN 进坐标。 */
  const valueOf = (point, key) => {
    const value = Number(point?.[key] ?? 0)
    return Number.isFinite(value) && value > 0 ? value : 0
  }

  const max = useMemo(() => {
    let peak = 0
    for (const point of list) {
      if (stacked) {
        let sum = 0
        for (const line of lines) sum += Number(point?.[line.key] ?? 0) > 0 ? Number(point[line.key]) : 0
        peak = Math.max(peak, sum)
      } else {
        for (const line of lines) peak = Math.max(peak, Math.max(0, Number(point?.[line.key] ?? 0)))
      }
    }
    return peak === 0 ? 1 : peak * 1.08
  }, [list, lines, stacked])

  const slot = list.length > 0 ? innerW / list.length : innerW
  /**
   * 柱宽：堆叠时一根占住大半格（要能看出段与段的比例），
   * 分组时按根数均分同一格（两根柱并列时各自留一点间隙）。
   */
  const barW = stacked
    ? Math.max(3, Math.min(30, slot * 0.62))
    : Math.max(2, Math.min(18, (slot * 0.72) / Math.max(1, lines.length)))
  const gap = stacked ? 0 : Math.max(1, Math.min(4, barW * 0.18))
  const yOf = (value) => pad.top + innerH - (Math.max(0, Number(value) || 0) / max) * innerH
  const centerOf = (index) => pad.left + index * slot + slot / 2

  const ticks = useMemo(
    () => Array.from({ length: 5 }, (_, index) => ({ value: (max / 4) * index, y: yOf((max / 4) * index) })),
    [max, yOf],
  )

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    const index = Math.min(list.length - 1, Math.max(0, Math.floor(ratio * list.length)))
    setHover(index)
  }

  const labelEvery = Math.max(1, Math.ceil(list.length / Math.max(2, Math.floor(innerW / 68))))
  const baseline = pad.top + innerH
  const hoverLabel = hover === null ? '' : shortDate(list[hover]?.key)
  /** 悬停那一格的合计（堆叠时就是柱高对应的数）。 */
  const hoverTotal = hover === null
    ? 0
    : lines.reduce((sum, line) => sum + valueOf(list[hover], line.key), 0)

  const bars = []
  list.forEach((point, index) => {
    const center = centerOf(index)
    if (stacked) {
      let acc = 0
      for (const line of lines) {
        const value = valueOf(point, line.key)
        if (value <= 0) continue
        const top = yOf(acc + value)
        const bottom = yOf(acc)
        acc += value
        bars.push(h('rect', {
          key: `${point?.key}-${line.key}`,
          className: `px-bar px-tone-fill-${line.tone}`,
          x: center - barW / 2,
          y: top,
          width: barW,
          height: Math.max(0, bottom - top),
          rx: 2,
        }))
      }
      return
    }
    // 分组：以格子中心为中线，几根柱依次向两边排开
    const groupW = barW * lines.length + gap * (lines.length - 1)
    const left = center - groupW / 2
    lines.forEach((line, lineIndex) => {
      const value = valueOf(point, line.key)
      const top = yOf(value)
      bars.push(h('rect', {
        key: `${point?.key}-${line.key}`,
        className: `px-bar px-tone-fill-${line.tone}`,
        x: left + lineIndex * (barW + gap),
        y: top,
        width: barW,
        height: Math.max(0, baseline - top),
        rx: 2,
      }))
    })
  })

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
        'aria-label': ariaLabel ?? '用量柱状图',
      },
      ticks.map((tick, index) =>
        h('g', { key: `tick${index}` },
          h('rect', { x: pad.left, y: tick.y, width: innerW, height: 1, className: 'px-grid-line' }),
          h('text', { x: pad.left - 10, y: tick.y + 3.5, className: 'px-axis-text', textAnchor: 'end' },
            formatAxis ? formatAxis(tick.value) : Math.round(tick.value)))),
      // 悬停时把那一格整列压暗一点：柱子上直接加高亮会改掉柱高，
      // 读到的数字就会与静止时不一致。
      hover === null
        ? null
        : h('rect', {
          className: 'px-hover-band',
          x: pad.left + hover * slot,
          y: pad.top,
          width: slot,
          height: innerH,
        }),
      bars,
      list.map((point, index) =>
        index % labelEvery === 0 || index === list.length - 1
          ? h('text', {
            key: `x${index}`,
            x: centerOf(index),
            y: height - 7,
            className: 'px-axis-text',
            textAnchor: 'middle',
          }, shortDate(point?.key))
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
      { className: 'px-tip', style: { left: `${Math.min(78, Math.max(22, (centerOf(hover) / width) * 100))}%` } },
      h('div', { className: 'px-tip-head' }, hoverLabel),
      lines.map((line) =>
        h('div', { key: line.key, className: 'px-tip-row' },
          h('i', { className: `px-legend-swatch px-tone-${line.tone}` }),
          h('span', null, line.label),
          h('b', null, formatValue ? formatValue(valueOf(list[hover], line.key)) : valueOf(list[hover], line.key)))),
      // 堆叠柱的柱高对应「合计」，悬停时把这条数也说出来——否则读者得自己加。
      stacked && lines.length > 1
        ? h('div', { className: 'px-tip-row px-tip-total' },
          h('span', null, '合计'),
          h('b', null, formatValue ? formatValue(hoverTotal) : hoverTotal))
        : null,
    ),
    h(
      'div',
      { className: 'px-legend' },
      lines.map((line) =>
        h('span', { key: line.key, className: 'px-legend-item' },
          h('i', { className: `px-legend-swatch px-tone-${line.tone}` }),
          h('span', null, line.label),
          h('b', { className: `px-legend-value${hover === null ? '' : ' on'}` },
            hover === null ? '' : (formatValue ? formatValue(valueOf(list[hover], line.key)) : '')))),
      // 说明小字已删除（用户要求），理由同 TrendChart。
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
			exports.BarChart = BarChart
			exports.DonutChart = DonutChart
			exports.calendarCellOf = calendarCellOf
			exports.ActivityCalendar = ActivityCalendar
			exports.BarList = BarList
			exports.useCountUp = useCountUp
		},
		"./styles/pricing.js": (exports, require) => {
			/**
 * 定价与「单价设置」界面的样式（.px-price-*）。
 *
 * 单独成文件是为了让样式能**按功能并行改动**：提供商分栏、模型单价行、编辑浮层、
 * 导入导出区都在这里，与看板其余部分（dashboard）、账户与套餐（accounts）、
 * 会话标签页（session）各占一张表。单价以外的选择器必须以 `.px-price-*` 开头——
 * 交付约束如此，也免得与产品自己的界面撞名。
 *
 * ## 为什么不写深色分支
 *
 * 这里只用 `--px-*` 令牌（颜色、圆角、时长），深浅两支由 `tokens` 那张表在
 * `body[data-ds-dark-theme]` 下换掉同一个变量名，因此本表不需要第二套规则。
 * 写死颜色的选择器必须自己补深色分支，那是本项目最容易漏的一处。
 *
 * ## 两条排版约束（都会真的溢出）
 *
 *   1) 两栏用 `minmax(0, ...)` 而不是 auto：输入框的固有宽度（浏览器默认约 20 字符
 *      ≈ 179px）会把栅格撑破，实测溢出 66px；
 *   2) 型号名与归一键都要 `overflow: hidden` + 省略号，否则一个长路由名会把
 *      「未命中 / 输出」两列挤出面板。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 `pricing`。
 */
const PRICING_CSS = `
/* ── 共享控件基础样式（原在 theme.js 的 DASHBOARD 里，随样式分文件迁到这里）──
   .px-input / .px-rate-field 不只是单价编辑器在用：看板的通知面板
   （.px-input px-notify-sound-select 等）也用它，因此写成裸选择器（不带
   .px-price-* 前缀）。

   两条声明是硬约束，缺一个就会横向溢出到面板外面（实测溢出 66px）：
   1) 容器 min-width: 0 —— flex 项默认 auto，会被输入框的固有宽度（浏览器默认
      约 20 字符 ≈ 179px）撑住不收缩；
   2) 输入框 flex: 1 1 0 —— 写成 auto 同样用固有宽度。 */
.px-input {
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
/* 焦点环要自己给（全局那条随皮肤一起删了）：产品默认的 outline 在暗色下几乎看不见。 */
.px-input:focus-visible { outline: none; border-color: var(--px-pink-deep); box-shadow: var(--px-ring); }
.px-rate-field { display: flex; align-items: center; gap: 8px; min-width: 0; }
.px-rate-field-label { flex: none; width: 62px; font-size: 11.5px; color: var(--px-muted); }
/* 三档并排；窄屏由文件末尾的媒体查询塌成单列，避免六个框挤成一团。 */
.px-rate-pairs { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.px-rate-pair { display: grid; gap: 4px; min-width: 0; }
.px-rate-pair > b { font-size: 11.5px; font-weight: 600; color: var(--px-ink); }
.px-rate-pair .px-rate-field-label { width: 32px; }
.px-rate-pair .px-input { min-width: 0; }

/* ── 单价设置：整页 ───────────────────────────────────────────── */
.px-price-settings { display: grid; gap: 12px; font-size: 12px; min-width: 0; }
.px-price-head { margin: 0; line-height: 1.6; color: var(--px-ink); }
.px-price-head > b { font-weight: 620; }
.px-price-settings .px-note { margin: 0; font-size: 11.5px; line-height: 1.55; }

/* 汇率那一行：输入框跟一段说明并排，窄屏自然换行（不折行会把说明挤出面板）。 */
.px-price-fx { display: grid; gap: 6px; }
.px-price-fx .px-rate-field > .px-input { max-width: 96px; }

/* ── 提供商分栏：左栏是「我有的那些家」，右栏只画选中那一家 ───────── */
.px-price-console {
  display: grid;
  grid-template-columns: minmax(132px, 176px) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  min-width: 0;
}
.px-price-nav { display: grid; gap: 3px; align-content: start; min-width: 0; }
.px-price-nav-title { padding: 0 2px 2px; font-size: 11px; color: var(--px-muted); }
/* 每一家一行：标签 + 「几个模型 / 几条已改」。默认无底色无边，只在悬停时给一层
   极薄的墨色底；选中态用描边 + 文字色，不填实色块（与设置弹层的页签同一口径）。 */
.px-price-provider {
  display: grid;
  gap: 1px;
  min-width: 0;
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--px-ink);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--px-r-sm);
  cursor: pointer;
  transition: background var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-price-provider:hover { background: color-mix(in srgb, var(--px-ink) 4%, transparent); }
.px-price-provider.on {
  border-color: var(--px-pink-deep);
  background: color-mix(in srgb, var(--px-pink-deep) 8%, transparent);
}
.px-price-provider:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-price-provider-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.px-price-provider-meta {
  font-size: 11px;
  color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}

/* 右栏 */
.px-price-pane { display: grid; gap: 8px; min-width: 0; }
.px-price-pane-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 3px 10px;
  min-width: 0;
}
.px-price-pane-title { grid-column: 1; grid-row: 1; font-size: 12.5px; font-weight: 620; color: var(--px-ink); }
.px-price-pane-head > .px-note { grid-column: 1; grid-row: 2; }
/* 搜索只在当前提供商里生效，因此紧贴着这一家的标题，而不是摆在页面顶端
   （摆在顶端会让人以为能跨厂商跳转）。 */
.px-price-filters { grid-column: 2; grid-row: 1 / span 2; min-width: 0; }
.px-price-filters .px-rate-field { gap: 5px; }
.px-price-filters .px-rate-field-label { width: auto; }
.px-price-search { width: 148px; }

/* ── 模型清单 ───────────────────────────────────────────────── */
.px-price-list { display: grid; gap: 2px; min-width: 0; }
/* 表头与每一行共用同一条轨道，四列：模型 / 未命中 / 输出 / 操作。
   整列定义轨道（而不是行内各算各的）才能让「未命中」这一列跨行对齐。 */
.px-price-list-head,
.px-price-item-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 64px 64px minmax(88px, auto);
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.px-price-list-head {
  padding: 0 8px 3px;
  font-size: 11px;
  color: var(--px-muted);
  border-bottom: 1px solid var(--px-line);
}
.px-price-list-head > span:nth-child(2),
.px-price-list-head > span:nth-child(3) { text-align: right; }
.px-price-item {
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--px-r-sm);
}
.px-price-item:hover { background: color-mix(in srgb, var(--px-ink) 3%, transparent); }
/* 我改过的那一条要有可辨识的标记：描边用强调色，但不填底色——
   填底色会让它与「估算价」那种警示色混在一起。 */
.px-price-item.mine { border-color: var(--px-pink-deep); }
.px-price-item-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.px-price-item-name > b {
  font-weight: 600;
  color: var(--px-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.px-price-item-name > code {
  font-family: var(--px-num-font);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 「自定义 / 估算」这类说明是**文字**而不是徽标：用户看懂了才有用，
   所以用点线下划线暗示可悬停，而不是画一个色块。 */
.px-price-item-tag {
  flex: none;
  font-size: 10.5px;
  color: var(--px-muted);
  border-bottom: 1px dotted var(--px-line-2);
  cursor: help;
}
/* 两档价靠右、等宽、不换行：小数位对齐才扫得出哪一行贵。 */
.px-price-cell {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 4px;
  min-width: 0;
  font-family: var(--px-num-font);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
  white-space: nowrap;
}
/* 桌面端两列的标签由表头给，行内不重复；窄屏表头隐藏，才在行内补上。 */
.px-price-cell-label { display: none; font-style: normal; font-size: 10.5px; color: var(--px-muted); }
.px-price-item-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; }
.px-price-item-actions .px-fix-link { margin-left: 0; white-space: nowrap; }
.px-price-reset { white-space: nowrap; }

/* ── 新增一条（就地展开的一行表单）───────────────────────────── */
.px-price-add { display: grid; gap: 6px; min-width: 0; }
.px-price-add-open {
  padding: 10px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-ink) 4%, transparent);
}
.px-price-add-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.px-price-add-head > b { font-size: 12px; font-weight: 600; color: var(--px-ink); }
.px-price-add-fields {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 6px;
  min-width: 0;
}
.px-price-add-fields .px-rate-field { min-width: 0; }
.px-price-add-fields .px-rate-field-label { width: auto; }
.px-price-add-fields .px-input { min-width: 0; }

/* ── 表单（编辑浮层里的六格）─────────────────────────────────── */
.px-price-form {
  display: grid; gap: 8px;
  margin-top: 6px; padding: 10px;
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-ink) 4%, transparent);
  border: 1px solid var(--px-line);
}
.px-price-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.px-price-errors { margin: 0; padding-left: 18px; font-size: 11.5px; line-height: 1.55; color: var(--px-red); }
/* 校验失败必须能一眼看到：它不是普通说明文字，因此在左边加一道提示色竖线。 */
.px-price-inline-error {
  margin: 0; padding: 4px 8px;
  font-size: 11.5px; line-height: 1.55;
  color: var(--px-red);
  background: color-mix(in srgb, var(--px-tone-red) 12%, transparent);
  border-left: 2px solid var(--px-red);
  border-radius: var(--px-r-sm);
}
.px-price-notice { color: var(--px-ink); }

/* ── 导入 / 导出 ─────────────────────────────────────────────── */
.px-price-io { display: grid; gap: 6px; }
.px-price-io-body { display: grid; gap: 6px; }
/* JSON 文本框要能竖着长：一行行挤在 input 里没法核对。 */
.px-price-json {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  font-family: var(--px-num-font);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre;
  overflow: auto;
}

.px-price-save { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

/* ── 「改单价」入口（浮层）────────────────────────────────────── */
.px-price-fix { position: relative; display: inline-flex; }
/* 每行一枚「改单价」，所以它不能有边框、底色和阴影（那会让整列看起来全是按钮）。
   默认只比次要文字深一档，悬停才出现下划线；焦点环单独给，键盘用户看得见。 */
.px-fix-link {
  appearance: none;
  padding: 0;
  margin-left: 6px;
  border: none;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: var(--px-muted);
  cursor: pointer;
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: color var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-fix-link:hover { color: var(--px-ink); border-bottom-color: var(--px-line-2); }
.px-fix-link:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }
.px-fix-link[aria-expanded="true"] { color: var(--px-ink); border-bottom-color: var(--px-pink-deep); }
/* 表格里那一枚「补价」的浮层：**portal 到 body + fixed 定位**。
   表格外层有横向滚动容器，留在文档流里会被裁剪、向右越界还会盖住模型名。
   这里用两个类名（.px-price-pop.px-price-pop-fixed）把原有 top/right 覆盖掉，
   特异性高于窄屏媒体查询里的 position: static，因此窄屏也不会退回行内。 */
.px-price-pop.px-price-pop-fixed {
  position: fixed;
  top: auto;
  right: auto;
  bottom: auto;
  z-index: 60;
}
/* 浮层必须脱离文档流：它出现在表格行里，撑开行高会把整张表的行距打乱。
   宽度用 min() 兜住窄栏，max-height + 滚动保证在矮屏上也够用。 */
.px-price-pop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  right: 0;
  width: min(340px, 92vw);
  max-height: 60vh;
  overflow: auto;
  display: grid; gap: 8px;
  padding: 10px;
  border-radius: var(--px-r-md);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--px-ink) 18%, transparent);
}
.px-price-pop-title { display: flex; align-items: baseline; gap: 6px; margin: 0; font-size: 12px; }
.px-price-pop-title > code { font-family: var(--px-num-font); font-size: 11px; }

/* ── 窄屏：两栏塌成上下，清单压成两行 ───────────────────────── */
@media (max-width: 720px) {
  .px-price-settings .px-rate-pairs,
  .px-price-pop .px-rate-pairs { grid-template-columns: minmax(0, 1fr); }
  .px-price-pop { position: static; width: auto; max-height: none; }
  /* 提供商从「左栏」变成上方的一排芯片：一两个一行，标签仍可读。 */
  .px-price-console { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .px-price-nav { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .px-price-nav-title { grid-column: 1 / -1; }
  .px-price-pane-head { grid-template-columns: minmax(0, 1fr); }
  .px-price-pane-title { grid-column: 1; grid-row: 1; }
  .px-price-pane-head > .px-note { grid-column: 1; grid-row: 2; }
  .px-price-filters { grid-column: 1; grid-row: 3; }
  .px-price-filters .px-rate-field { width: 100%; }
  .px-price-search { width: 100%; }
  /* 清单：第一行「模型名 + 改单价」，第二行「未命中 · 输出」。
     表头隐藏，因此两列各自带一个小标签。 */
  .px-price-list-head { display: none; }
  .px-price-item-head {
    grid-template-columns: minmax(0, 1fr) auto auto;
    grid-template-areas:
      "name name act"
      "miss out act";
    row-gap: 2px;
  }
  .px-price-item-name { grid-area: name; }
  .px-price-cell-miss { grid-area: miss; justify-content: flex-start; }
  .px-price-cell-out { grid-area: out; justify-content: flex-start; }
  .px-price-cell-label { display: inline; }
  .px-price-item-actions { grid-area: act; align-self: center; }
  .px-price-add-fields { grid-template-columns: minmax(0, 1fr); }
}
`

			exports.PRICING_CSS = PRICING_CSS
		},
		"./styles/accounts.js": (exports, require) => {
			/**
 * 「套餐余额」板块的样式（.px-acc-*）。
 *
 * 形态是「一家一张卡」的网格：左环形条画总余额，右边每个额度窗口一行细进度条，
 * 底部一个默认收起的「凭据与开关」。所有选择器必须以 .px- 开头。
 *
 * 四条硬约束（都来自项目里的既有铁律，渲染闸门会查）：
 *   1. **不铺 --px-surface-2**：白色是页面里唯一的「块」，次级底色只留给真正
 *      内凹的槽（白名单在 render-check 里）。这里的轨道用 --px-layer-3。
 *   2. **不读产品 --dsw-***：只用自己的 --px-*，深浅两套由 theme.js 的
 *      TOKENS 自动换支，因此本文件**不需要**深色分支。
 *   3. **数字走 tabular-nums**，否则百分比与倒计时的小时数会左右跳。
 *   4. **不做卡中卡**：本段容器是透明的（只有标题 + 网格），白色与阴影只给
 *      每一张厂商卡——那才是这一屏的分区单位。
 *
 * 注意：本文件的内容是**模板字符串**，注释里绝不能出现反引号（会提前闭合）。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 accounts。
 */
const ACCOUNTS_CSS = `
/* ── 整段：标题 + 卡片网格 ─────────────────────────────────────── */
/* 根节点保留了 .px-account-grid 这个旧钩子（渲染闸门按它找这一块），但外观不再由
   它给：那套规则来自早先的两栏布局（auto-fit minmax(320px, 1fr)），会把标题与
   卡片并排成两栏。这里用两个类同时命中（0,2,0）压住它，并把容器改成透明的单列：
   分区感交给每张卡自己的白底与阴影。 */
.px-acc.px-account-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  align-items: start;
  margin-bottom: 12px;
  padding: 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.px-acc-head {
  display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
}
.px-acc-title {
  margin: 0; font-size: 13px; font-weight: 650; color: var(--px-ink);
  letter-spacing: 0.01em;
}
.px-acc-count {
  font-size: 11px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
.px-acc-busy { margin-left: auto; font-size: 11px; color: var(--px-muted); }

/* ── 卡片网格：窄屏自然塌成单列 ─────────────────────────────────── */
.px-acc-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  align-items: stretch;
}

/* 一张厂商卡：flex 纵向排列，卡底那行用 margin-top:auto 顶到底边。
   为什么不用 grid：卡片被并排的邻居拉成等高时，grid 会把多出来的高度**分给每一行**，
   于是两张高度不同的卡里，「徽标那一行」落到了不同的纵坐标上（实测差 12px）——
   三张卡并排、徽标参差不齐，一眼就觉得没对齐。flex 下多出来的高度只落在
   卡底那一条 auto 外边距里，卡头与额度区各自保持自然高度。 */
.px-acc-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  min-width: 0;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: box-shadow var(--px-dur) var(--px-ease),
              border-color var(--px-dur) var(--px-ease);
}
.px-acc-card:hover { box-shadow: var(--px-elev-2); }
/* 卡头固定两行（第一行是谁，第二行状态 + 核验）。让它们挤在一行里自己折行的话，
   长厂商名加两枚徽标会随机折成两三行，三张卡并排时卡头高度不一。 */
.px-acc-card-head {
  display: grid; gap: 6px; align-content: start;
  min-width: 0;
}
.px-acc-card-id {
  display: flex; align-items: baseline; gap: 8px;
  min-width: 0;
}
.px-acc-plan-name {
  font-size: 13px; color: var(--px-ink);
  min-width: 0;
  overflow-wrap: anywhere;
}
.px-acc-card-meta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
/* 核验级别：11px、只有两个字。它不是主信息，但用户需要它来判断
   「这个数字能不能当准」，所以不能藏进折叠区。 */
.px-acc-verif {
  font-size: 11px; color: var(--px-muted);
  white-space: nowrap;
}
/* 监看开关：**无边框的小字按钮**。它是偏好而不是每张卡的主要动作，
   做成描边按钮会和状态徽标抢位置，300px 宽的卡头会被挤成三行。
   选中态只换文字色 —— 「当前监看」这件事在费用条那边已经有强表达，
   这里再给一个实底会让同一张卡里出现两个视觉重音。 */
.px-acc-monitor {
  appearance: none; font: inherit;
  margin-left: auto;
  flex: none;
  padding: 0 2px;
  font-size: 11px; font-weight: 570;
  color: var(--px-muted);
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--px-line-2);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--px-dur-fast) var(--px-ease),
              border-color var(--px-dur-fast) var(--px-ease);
}
.px-acc-monitor:hover { color: var(--px-pink-deep); border-bottom-color: var(--px-pink-deep); }
.px-acc-monitor:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }
.px-acc-monitor.active { color: var(--px-pink-deep); border-bottom-color: transparent; }
/* 状态徽标只改文字色与描边色：底色由 .px-badge 保持透明——
   实色底一旦与所在容器同色，整个徽标就只剩文字浮着。 */
.px-acc-badge-ok {
  color: var(--px-tone-green);
  border-color: color-mix(in srgb, var(--px-tone-green) 30%, transparent);
}
.px-acc-badge-warn {
  color: var(--px-tone-yellow);
  border-color: color-mix(in srgb, var(--px-tone-yellow) 34%, transparent);
}
.px-acc-badge-error {
  color: var(--px-tone-red);
  border-color: color-mix(in srgb, var(--px-tone-red) 34%, transparent);
}
/* 失败原因单独一行：徽标只给四档状态，真正可操作的句子（缺哪个凭据名、
   鉴权是怎么被拒的）在这里，字数不限但要小一号。 */
.px-acc-reason {
  margin: 0; font-size: 11px; line-height: 1.55;
  color: var(--px-ink-2);
  overflow-wrap: anywhere;
}
.px-acc-reason-error { color: var(--px-tone-red); }
.px-acc-reason-warn { color: var(--px-detail-label); }

/* ── 卡内主体：左环 + 右条 ─────────────────────────────────────── */
/* 左栏与右栏都**顶对齐**（不是垂直居中）：三张卡并排时窗口数各不相同，
   垂直居中会把三个环放在三个不同的高度上（实测差 36px），一眼看着就是没对齐。
   顶对齐之后，环排成一条横线，窗口多寡只影响条往下延伸的长度。 */
.px-acc-card-body {
  display: flex; align-items: flex-start; gap: 14px;
  min-width: 0;
}

/* 环形条：直径 76（再大就把右侧的窗口行挤下去），描边 8。
   填充色是**单一强调色**，只有告警（已用 ≥ 90% 或已超限）才转红。 */
.px-acc-ring {
  position: relative;
  flex: none;
  width: 76px; height: 76px;
  display: grid; place-items: center;
}
.px-acc-ring-svg { display: block; width: 76px; height: 76px; }
/* 轨道与填充都只给 stroke：fill 必须显式关掉，否则 SVG 圆默认填黑。 */
.px-acc-ring-track {
  fill: none;
  stroke: var(--px-layer-3);
  stroke-width: 8;
}
.px-acc-ring-fill {
  fill: none;
  stroke: var(--px-pink-deep);
  stroke-width: 8;
  stroke-linecap: round;
  transition: stroke-dasharray var(--px-dur-slow) var(--px-ease-out);
}
.px-acc-ring-alert { stroke: var(--px-tone-red); }
/* 中心数字画在 SVG 外面（绝对定位）：SVG 里的 text 拿不到 CSS 令牌，
   字号也不受页面缩放控制。 */
.px-acc-ring-center {
  position: absolute;
  inset: 0;
  display: grid; place-content: center; justify-items: center;
  gap: 1px;
  text-align: center;
  pointer-events: none;
}
.px-acc-ring-value {
  font-size: 15px; font-weight: 660; line-height: 1.15;
  color: var(--px-ink);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
/* 只有剩余金额的厂商（例如 65.55 这种信用额）在 76px 里放不下 15px 的字号，
   降一档而不是截断——数字截断就是撒谎。 */
.px-acc-ring-value.long { font-size: 11.5px; letter-spacing: 0; }
.px-acc-ring-label {
  font-size: 10px; line-height: 1.2;
  color: var(--px-muted);
}

/* ── 额度窗口：一行一个，竖向排列 ───────────────────────────────── */
.px-acc-wins {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 8px;
}
.px-acc-win { display: grid; gap: 3px; min-width: 0; }
.px-acc-win-head { display: flex; align-items: baseline; gap: 6px; }
.px-acc-win-name {
  font-size: 11px; font-weight: 570;
  color: var(--px-ink-2);
}
.px-acc-win-used {
  margin-left: auto;
  font-size: 11px; font-weight: 620;
  color: var(--px-ink-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.px-acc-win-used.alert { color: var(--px-tone-red); }
.px-acc-win-over {
  font-size: 10px; font-weight: 620;
  color: var(--px-tone-red);
  padding: 0 5px;
  border-radius: var(--px-r-pill);
  border: 1px solid color-mix(in srgb, var(--px-tone-red) 40%, transparent);
}
/* 条高 6px、胶囊圆角：再粗就和环形条抢注意力了。轨道走 layer-3（内凹），
   不用 surface-2——那会把卡内切出一块米色。 */
.px-acc-win-track {
  height: 6px;
  border-radius: var(--px-r-pill);
  background: var(--px-layer-3);
  overflow: hidden;
}
.px-acc-win-fill {
  display: block; height: 100%;
  border-radius: var(--px-r-pill);
  background: var(--px-pink-deep);
  transition: width var(--px-dur-slow) var(--px-ease-out);
}
.px-acc-win-fill.alert { background: var(--px-tone-red); }
.px-acc-win-foot {
  font-size: 10.5px; line-height: 1.5;
  color: var(--px-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

/* ── 空态 / 状态行 ─────────────────────────────────────────────── */
.px-acc-empty {
  margin: 0; padding: 8px 10px;
  flex: 1 1 auto;
  font-size: 11px; line-height: 1.55;
  color: var(--px-ink-2);
  border: 1px dashed var(--px-line-2);
  border-radius: var(--px-r-sm);
}
.px-acc-state { margin: 0; font-size: 11.5px; line-height: 1.55; color: var(--px-ink-2); }
.px-acc-state.px-acc-error { color: var(--px-tone-red); }
.px-acc-state.px-acc-ok { color: var(--px-tone-green); }
.px-acc-state.px-acc-off { color: var(--px-muted); }
.px-acc-note {
  margin: 0; font-size: 11px; color: var(--px-muted); line-height: 1.55;
}

/* ── 卡底：凭据与开关（默认收起）────────────────────────────────── */
/* margin-top:auto 把这一条压到卡底：卡片被拉高时多出来的空间落在这里，
   于是并排几张卡的「凭据与开关」在同一横线上。 */
.px-acc-config {
  margin-top: auto;
  border-top: 1px dashed var(--px-line-2);
  padding-top: 8px;
}
.px-acc-config > summary {
  font-size: 11px;
  color: var(--px-muted);
  cursor: pointer;
}
.px-acc-config > summary:hover { color: var(--px-ink-2); }
.px-acc-config[open] > summary { color: var(--px-ink-2); }
.px-acc-config-body { display: grid; gap: 8px; margin-top: 8px; }
.px-acc-config-foot {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 6px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; color: var(--px-muted);
}
.px-acc-config-foot a { color: var(--px-pink-deep); text-decoration: none; }
.px-acc-config-foot a:hover { text-decoration: underline; }
.px-acc-endpoint {
  font-size: 10.5px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.px-acc-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--px-muted);
  cursor: pointer;
}
.px-acc-toggle input { accent-color: var(--px-pink-deep); }

/* ── 「这家凭据怎么配」 ────────────────────────────────────────── */
.px-acc-setup { margin-top: 2px; }
.px-acc-steps {
  margin: 6px 0 0; padding-left: 18px;
  font-size: 11.5px; color: var(--px-ink-2); line-height: 1.65;
}
.px-acc-steps li { margin: 2px 0; }
.px-acc-setup-link { margin: 8px 0 0; font-size: 11.5px; }
.px-acc-setup-link a { color: var(--px-pink-deep); text-decoration: none; }
.px-acc-setup-link a:hover { text-decoration: underline; }
.px-acc-setup-where { margin-top: 8px; }
.px-acc-setup-where > p { margin: 0 0 6px; font-size: 11.5px; color: var(--px-ink-2); }
/* 路径要能整条读出来、能复制：等宽 + allow-wrap，不省略号截断。 */
.px-acc-setup-path {
  display: block;
  padding: 6px 8px;
  font-size: 11px;
  overflow-wrap: anywhere;
  color: var(--px-ink);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
}
.px-acc-setup-refs { margin: 6px 0 0; padding-left: 18px; font-size: 11px; line-height: 1.7; }
.px-acc-setup-refs code { font-size: 11px; color: var(--px-ink); }
.px-acc-setup-note { margin-left: 6px; color: var(--px-muted); }
.px-acc-setup-hint {
  margin: 8px 0 0; font-size: 10.5px; line-height: 1.6; color: var(--px-muted);
}
.px-acc-setup-hint code { font-size: 10.5px; }
.px-acc-files { margin-top: 8px; }
.px-acc-files > p { margin: 0 0 6px; font-size: 11.5px; color: var(--px-ink-2); }
.px-acc-file-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.px-acc-file-list > li { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.px-acc-file-path { font-size: 10.5px; overflow-wrap: anywhere; color: var(--px-ink-2); }
.px-acc-file-flag {
  font-size: 10.5px; color: var(--px-muted);
  padding: 1px 7px; border-radius: var(--px-r-pill);
  border: 1px solid var(--px-line);
}
.px-acc-file-flag.present {
  color: var(--px-tone-green);
  border-color: color-mix(in srgb, var(--px-tone-green) 30%, transparent);
}

/* ── 移除凭据 ─────────────────────────────────────────────────── */
.px-acc-remove { margin-top: 2px; }
.px-acc-ref-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.px-acc-ref-row { display: grid; gap: 3px; }
.px-acc-ref-label {
  display: inline-flex; align-items: baseline; gap: 6px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--px-ink-2);
}
.px-acc-ref-label code { font-size: 11px; color: var(--px-ink); }
.px-acc-ref-purpose { font-size: 11px; color: var(--px-muted); }
.px-acc-ref-source {
  font-size: 10.5px; color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
/* 不可移除的原因要看得见：用浅黄底 + 描边，不抢红色（红留给真正的故障）。 */
.px-acc-ref-blocked {
  font-size: 10.5px; line-height: 1.55;
  color: var(--px-ink-2);
  padding: 5px 8px;
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-yellow) 20%, transparent);
  border: 1px solid color-mix(in srgb, var(--px-yellow) 40%, var(--px-line));
  overflow-wrap: anywhere;
}
.px-acc-remove-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.px-acc-confirm {
  margin: 8px 0 0; font-size: 11px; line-height: 1.55;
  color: var(--px-ink-2);
  padding: 6px 9px;
  border-radius: var(--px-r-sm);
  background: color-mix(in srgb, var(--px-red) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--px-red) 34%, var(--px-line));
  overflow-wrap: anywhere;
}
.px-acc-remove-result { margin: 8px 0 0; padding-left: 16px; font-size: 11px; line-height: 1.6; }
.px-acc-ok { color: var(--px-tone-green); }
.px-acc-bad { color: var(--px-tone-red); }

/* ── 按钮 ─────────────────────────────────────────────────────── */
.px-acc-btn {
  appearance: none; font: inherit;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 11px; font-weight: 570;
  color: var(--px-ink-2);
  background: transparent;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  cursor: pointer;
  transition: color var(--px-dur-fast) var(--px-ease),
              border-color var(--px-dur-fast) var(--px-ease);
}
.px-acc-btn:hover:not(:disabled) { color: var(--px-ink); border-color: var(--px-pink-deep); }
.px-acc-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-acc-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.px-acc-btn.ghost { border-style: dashed; }
.px-acc-btn.active { border-style: solid; color: var(--px-pink-deep); border-color: var(--px-pink-deep); }
/* 「确认移除」是危险动作，用红色描边明确区分于普通按钮。 */
.px-acc-btn.danger {
  color: var(--px-tone-red);
  border-color: color-mix(in srgb, var(--px-tone-red) 50%, transparent);
}

/* ── 「添加厂商」 ─────────────────────────────────────────────── */
.px-acc-add-list { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.px-acc-add-row {
  display: grid; gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-sm);
  font-size: 11.5px; color: var(--px-ink-2);
}
.px-acc-add-main {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.px-acc-add-row b { font-weight: 600; color: var(--px-ink); }
.px-acc-add-note { font-size: 11px; color: var(--px-muted); }
.px-acc-add-ref {
  margin-right: auto;
  font-size: 10.5px;
  color: var(--px-ink-2);
  overflow-wrap: anywhere;
}
.px-acc-add-hint-text {
  font-size: 10.5px; line-height: 1.6; color: var(--px-muted);
  overflow-wrap: anywhere;
}
.px-acc-add-setup > summary {
  font-size: 11px;
  color: var(--px-pink-deep);
  cursor: pointer;
}
.px-acc-add-hint { margin-top: 2px; }

/* ── 免责（一句话）────────────────────────────────────────────── */
.px-acc-disclaimer {
  margin: 0; font-size: 10.5px; line-height: 1.6;
  color: var(--px-detail-label);
}
.px-acc-disclaimer-mark {
  color: var(--px-muted);
  cursor: help;
}

/* ── 窄屏：卡片单列、窗口行的百分比不再靠右挤 ───────────────────── */
@media (max-width: 640px) {
  .px-acc-cards { grid-template-columns: 1fr; }
}
@media (max-width: 380px) {
  .px-acc-card-body { gap: 10px; }
  .px-acc-win-used { margin-left: 0; }
}

/* ── 降低动效偏好：环与条的推进改为立即到位 ─────────────────────
   它们表达的是「现在的额度」，延迟出现只会让人以为数字在动。 */
@media (prefers-reduced-motion: reduce) {
  .px-acc-card,
  .px-acc-ring-fill,
  .px-acc-win-fill,
  .px-acc-monitor { transition: none; }
}
`

			exports.ACCOUNTS_CSS = ACCOUNTS_CSS
		},
		"./styles/session.js": (exports, require) => {
			/**
 * 会话标签页（`conversation.view` 里的「费用」）的样式（.px-sv-*）。
 *
 * 它与看板共用 --px-* 令牌，但**不是看板的一部分**：这一页挂在会话视图里，
 * 上下是产品的会话区，因此只能用自己的 .px-sv-* 选择器，不得外溢。
 *
 * ## 这一页的视觉规则（改之前先读完）
 *
 * 1) **一页只有一个主角：顶部那个金额。** 它 34px/700、用 --px-ink（不是强调色），
 *    其余所有数字都比它小一档以上。层级靠字号 + 字重 + 空间拉开，不靠再加一个色块。
 * 2) **强调色（--px-pink-deep）只出现在「当前状态 / 选中」两处**：进行中徽标、
 *    以及账户被手动指定时的徽标。占比条一律中性（墨色淡涂），不做彩虹。
 *    状态色（绿/黄/红）只表达状态：额度告急、账户不可用。
 * 3) **卡片不嵌套卡片。** 卡片里只有「行 + 细条」与表格；细分隔用 1px 描边，
 *    不铺 --px-surface-2（次级底色只留给真正内凹的轨道，渲染闸门有白名单）。
 * 4) 数字一律 tabular-nums：逐行金额位数一跳，整张表就在抖。
 * 5) 间距全是 4 的倍数；同族元素（计量行、表格行、成员行）行距一致。
 *
 * 由 theme.js 汇总进 STYLES；条目名必须是 `session`。
 */
const SESSION_CSS = `
/* ── 外壳 ─────────────────────────────────────────────────────── */
/* 版式是**显式的四行**，不是 auto-fit 网格。
 *
 * 早先用 repeat(auto-fit, minmax(320px, 1fr))：卡片的列数由容器宽度决定，于是
 * 「逐日花费 | 账户」那一行在某个宽度下只剩两块、右边空出一大片——用户的原话是
 * 「搞这么多空隙出来为什么」。行数、每行几块现在都由这里写死，宽度变化只改列数，
 * 不会再出现「这一行少一块」的空白。 */
.px-sv {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 20px 28px;
  font-family: var(--px-ui-font);
  color: var(--px-ink);
  font-size: 12.5px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
}
.px-sv * { box-sizing: border-box; }
.px-sv-num { font-variant-numeric: tabular-nums; }

/* 通栏的几类：抬头、含表格的那张卡、脚注、空态与降级态。
   容器已改成纵向 flex，通栏是默认行为；这两条保留是为了兼容 .px-sv-card-wide
   这个显式标记（卡片自身仍不该被挤成半栏）。 */
.px-sv-head,
.px-sv-notes,
.px-sv-empty,
.px-sv-state,
.px-sv-card-wide,
.px-sv-card:has(.px-sv-table-wrap) { grid-column: 1 / -1; }

/* ── 第一行：hero 指标（照「图二」：彩色左边条 + 大号数字 + 脚注）── */
/* 固定四列而不是 auto-fit：这一行**恰好**四块，auto-fit 会按最小宽度算出 5 列，
   于是右边空一格——正是这一轮要消灭的那种空白。窄屏依次塌成 2 列 / 2 列。 */
.px-sv-heroes {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.px-sv-heroes > .px-hero { min-width: 0; }

/* ── 第二行 / 第四行：并排的分区行 ───────────────────────────────── */
/* 类名是 .px-sv-band（一条「分区带」），**不叫 .px-sv-row**：
   .px-sv-row 已经被「计量行」（标签 + 数值 + 细条）占用了，两者同名会让
   计量行拿到 display:grid / 分区带拿到 flex-direction:column ——
   实测结果就是「三块并排」实际竖着叠起来。 */
.px-sv-band {
  display: grid;
  gap: 12px;
  align-items: stretch;
  min-width: 0;
}
/* 第二行：左「耗时构成」+ 右两张（计价时段 / 用量构成）。
   左块稍宽（堆叠条要长度才读得出比例），右边两张等分。 */
.px-sv-band-split {
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr);
}
/* 第四行：三块等分。补上「请求分布」之后这一行不再有空白。 */
.px-sv-band-three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
/* 耗时块本身已经是「白块 + 描边」（.px-timing 自带），这里只负责让它占满格高，
   并去掉它作为独立块时的那点下外边距。 */
.px-sv-timing-cell { display: flex; min-width: 0; }
.px-sv-timing-cell > .px-timing {
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
}

/* ── 抬头：只说明「这是哪条会话」，金额交给第一行的 hero 卡 ───────── */
/* 抬头刻意**不做卡片**：它是一条页眉，用一条细线与下面的卡片分开。
   卡片里再套卡片会让「谁是一页的开头」读不出来。
   早先抬头右侧放的是 34px 大金额，现在金额挪进 hero 卡（带色条）——
   同一个数字在一页里出现两次，读者会开始怀疑哪个才是总数。 */
.px-sv-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--px-line);
}
.px-sv-head-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.px-sv-eyebrow {
  color: var(--px-detail-label);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.px-sv-head-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.px-sv-title {
  margin: 0;
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: 0.01em;
}
/* 小字走 --px-detail-label 而不是 --px-muted：#8a7969 在白底上只有 4.18:1，
   低于 AA 的 4.5（项目就是为这件事单独加了这个令牌）。#75655a 是 5.58:1。 */
.px-sv-hint { color: var(--px-detail-label); font-size: 11px; }
.px-sv-muted { color: var(--px-detail-label); }

/* 后台刷新失败：一行轻提示，不换掉已经显示的数字。 */
.px-sv-stale {
  margin: 0;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--px-tone-yellow) 55%, transparent);
  border-radius: var(--px-r-md);
  background: color-mix(in srgb, var(--px-tone-yellow) 12%, transparent);
  color: var(--px-ink);
  font-size: 11.5px;
}

/* 徽标：描边胶囊。强调色只买「当前」这一层意思（进行中 / 手动指定），
   用淡色底 + 墨色字，而不是把 11px 的粉字直接压在白底上（那样对比度不够）。 */
.px-sv-tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  color: var(--px-ink-2);
  font-size: 11px;
  white-space: nowrap;
}
.px-sv-tag-live,
.px-sv-tag-accent {
  border-color: color-mix(in srgb, var(--px-pink-deep) 40%, transparent);
  background: color-mix(in srgb, var(--px-pink-deep) 11%, transparent);
  color: var(--px-ink);
}

/* ── 卡片：白色是唯一的「块」 ─────────────────────────────────── */
.px-sv-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* min-width: 0 是必需的：卡片是 grid/flex 的子项，默认 min-width:auto 时
     表格的固有宽度会把整张卡撑宽，进而把页面顶出横向滚动条（420px 下实测过）。 */
  min-width: 0;
  padding: 16px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
}
.px-sv-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
/* 卡片标题只做「这一格是什么」，12px/600/字距 0.06em：比正文重、比数字轻。 */
.px-sv-card-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--px-ink-2);
}
.px-sv-card-note {
  color: var(--px-detail-label);
  font-size: 11px;
  white-space: nowrap;
}
.px-sv-card-foot {
  /* 卡片被拉齐到同一行最高那张时，脚注压到底：留白落在脚注上方，
     而不是让脚注浮在卡片中间。 */
  margin: auto 0 0;
  color: var(--px-detail-label);
  font-size: 11px;
  line-height: 1.6;
}

/* ── 计量行：标签 + 数值在上，细条在下 ───────────────────────── */
/* 这一页原来是一排大号数字格（6 个描边小方块），读起来像仪表盘墙。
   改成「一行一个指标」：左标签右数值，下面一根 5px 细条表示它在总量里的份额。
   同样的信息占更少面积，也省掉了 6 个描边框。 */
.px-sv-rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.px-sv-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.px-sv-row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.px-sv-row-label {
  color: var(--px-ink-2);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.px-sv-row-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  flex: 0 0 auto;
}
.px-sv-row-value {
  font-size: 13px;
  font-weight: 600;
}
/* 占比是附注，不是第二个数字：更小、更淡、定宽右对齐，位数变化不会推挤金额。 */
.px-sv-row-pct {
  min-width: 3.6em;
  text-align: right;
  color: var(--px-detail-label);
  font-size: 11px;
  font-weight: 400;
}

/* ── 占比条：轨道用描边色，填充按语义上色（用户要的「彩色条形」）── */
.px-sv-meter {
  display: block;
  height: 4px;
  border-radius: var(--px-r-pill);
  background: var(--px-line);
  overflow: hidden;
}
.px-sv-meter-thin { height: 4px; }
.px-sv-meter-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: color-mix(in srgb, var(--px-ink) 30%, transparent);
  transition: width var(--px-dur) var(--px-ease);
}
/* 语义色：峰=粉、闲=绿（用户确认的口径）；四桶沿用看板「构成」那一套
   （命中=蓝、未命中=紫、写入=黄、输出=粉），于是从看板堆叠柱看到这一页的
   占比条，颜色一一对应。全部走 --px-* 令牌，不写死十六进制。 */
.px-sv-meter-fill-pink { background: var(--px-tone-pink); }
.px-sv-meter-fill-green { background: var(--px-tone-green); }
.px-sv-meter-fill-blue { background: var(--px-tone-blue); }
.px-sv-meter-fill-purple { background: var(--px-tone-purple); }
.px-sv-meter-fill-yellow { background: var(--px-tone-yellow); }
.px-sv-meter-fill-accent { background: var(--px-detail-accent); }
/* 红色只留给「额度快用完了」这一类真状态。 */
.px-sv-meter-fill-warn { background: var(--px-tone-red); }

/* 计量行标签前的色点：与条同色，于是「哪一格是峰、哪一格是闲」不用读字。 */
.px-sv-tick {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 50%;
  flex: none;
  vertical-align: middle;
}
.px-sv-tick-pink { background: var(--px-tone-pink); }
.px-sv-tick-green { background: var(--px-tone-green); }
.px-sv-tick-blue { background: var(--px-tone-blue); }
.px-sv-tick-purple { background: var(--px-tone-purple); }
.px-sv-tick-yellow { background: var(--px-tone-yellow); }
.px-sv-tick-accent { background: var(--px-detail-accent); }

/* ── 请求分布（峰/闲水平条）───────────────────────────────────── */
/* 条本身沿用看板的 .px-peak-bar / .px-peak-fill / .px-peak-rest（同一种语言），
   这里只按用户确认的口径换掉颜色：峰=粉、闲=绿。
   覆盖**限定在 .px-sv 之下**：看板那边的同一组类是黄/蓝，不能一起改掉。 */
.px-sv .px-peak-fill {
  background: var(--px-tone-pink);
  transition: width var(--px-dur) var(--px-ease);
}
.px-sv .px-peak-rest {
  background: var(--px-tone-green);
  opacity: 0.32;
}
.px-sv-peak { display: flex; flex-direction: column; gap: 8px; }
.px-sv-peak-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.px-sv-peak-peak { color: var(--px-tone-pink); font-size: 12px; font-weight: 600; }
.px-sv-peak-idle { color: var(--px-tone-green); font-size: 12px; font-weight: 600; }

/* ── 派生指标（缓存命中率）：一条细线隔开的收尾读数 ───────────── */
.px-sv-figure {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 4px 12px;
  padding-top: 12px;
  border-top: 1px solid var(--px-line);
}
.px-sv-figure-label { color: var(--px-ink-2); font-size: 12px; }
.px-sv-figure-value {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.px-sv-figure-note {
  grid-column: 1 / -1;
  color: var(--px-detail-label);
  font-size: 11px;
}

/* ── 逐模型明细表 ─────────────────────────────────────────────── */
/* min-width: 0 同卡片那条：不让表格的固有宽度把 flex 父项撑开。 */
.px-sv-table-wrap {
  overflow-x: auto;
  min-width: 0;
}
.px-sv-table {
  width: 100%;
  border-collapse: collapse;
}
.px-sv-table th,
.px-sv-table td {
  padding: 8px;
  text-align: left;
  white-space: nowrap;
}
/* 表头走新的中性层次：不加底色，靠 10.5px + 0.08em 字距 + 一条 line-2 下边线。 */
.px-sv-table thead th {
  padding-bottom: 8px;
  color: var(--px-ink-2);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  border-bottom: 1px solid var(--px-line-2);
}
.px-sv-table tbody td {
  font-size: 12px;
  border-bottom: 1px solid var(--px-line);
}
.px-sv-table tbody tr:last-child td { border-bottom: none; }
/* 行悬停极淡着色，不换底、不变脸（与看板 .px-btn 的 hover 同一口径）。 */
.px-sv-table tbody tr:hover td { background: color-mix(in srgb, var(--px-ink) 4%, transparent); }
/* 合计行：一条 line-2 上边线 + 更多的上方留白，让它明显是「另一段」。 */
.px-sv-table tfoot th,
.px-sv-table tfoot td {
  padding-top: 8px;
  font-size: 12px;
  font-weight: 700;
  color: var(--px-ink);
  border-top: 1px solid var(--px-line-2);
  border-bottom: none;
}
/* 右对齐要压过 .px-sv-table th/td 的 left（选择器权重：都带 .px-sv-table）。 */
.px-sv-table th.px-sv-col-num,
.px-sv-table td.px-sv-col-num { text-align: right; }
.px-sv-model {
  display: inline-block;
  max-width: 26ch;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  font-weight: 500;
}
.px-sv-badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  margin-left: 8px;
  padding: 0 8px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  color: var(--px-ink-2);
  font-size: 10px;
}
/* 「估算」是状态：淡黄底 + 墨色字。直接把 10px 的黄字压在白底上会看不清。 */
.px-sv-badge-warn {
  border-color: color-mix(in srgb, var(--px-tone-yellow) 55%, transparent);
  background: color-mix(in srgb, var(--px-tone-yellow) 14%, transparent);
  color: var(--px-ink);
}
.px-sv-unit { color: var(--px-ink-2); }
.px-sv-amount-cell { font-weight: 700; }

/* ── 逐日花费：迷你柱状（日期 + 条 + 金额）───────────────────── */
/* 原来是一排「日期 / 大号金额 / token 数」，三列都重。改成一根按最大值归一化的
   细条之后，哪天最贵一眼就看出来，金额仍然在，token 数收掉了（它与金额重复表达
   同一件事，而这一格只有半栏宽）。 */
.px-sv-days,
.px-sv-members {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.px-sv-day {
  display: grid;
  grid-template-columns: 3em minmax(40px, 1fr) auto;
  align-items: center;
  gap: 12px;
}
.px-sv-day-label {
  color: var(--px-ink-2);
  font-size: 11.5px;
}
.px-sv-day-value {
  font-size: 12px;
  font-weight: 600;
  text-align: right;
}

/* ── 账户 ─────────────────────────────────────────────────────── */
.px-sv-account {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.px-sv-account-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.px-sv-account-label {
  color: var(--px-ink-2);
  font-size: 12px;
}
/* 余额/额度是这一页第二重要的数字：22px，比正文大一档，比抬头金额小一档。 */
.px-sv-account-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
}
/* 不可用是状态：一个红点 + 墨色文字。
   不把「不可用」整串染红——浅色的 --px-tone-red 在白底上只有 4.02:1，
   14px 的文字达不到 AA；红点是非文字元素（要求 3:1），4.02 足够。 */
.px-sv-account-unavailable .px-sv-account-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--px-ink);
  font-size: 15px;
  font-weight: 600;
}
.px-sv-account-unavailable .px-sv-account-value::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--px-tone-red);
}
.px-sv-account .px-sv-meter { width: 100%; }

/* ── 团队成员 ─────────────────────────────────────────────────── */
.px-sv-member {
  display: grid;
  grid-template-columns: minmax(6em, 1fr) minmax(48px, 1.2fr) auto;
  align-items: center;
  gap: 12px;
}
.px-sv-member-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.px-sv-member-value {
  font-size: 12px;
  font-weight: 600;
  text-align: right;
}

/* ── 脚注：只在数字需要打折扣时出现 ───────────────────────────── */
.px-sv-notes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--px-line);
}
.px-sv-notes p {
  margin: 0;
  color: var(--px-detail-label);
  font-size: 11px;
  line-height: 1.6;
}

.px-sv-empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--px-line-2);
  border-radius: var(--px-r-md);
  color: var(--px-ink-2);
  font-size: 12px;
  text-align: center;
}

/* ── 降级卡片：四种状态各说各的下一步动作 ─────────────────────── */
/* 居中成一段话，而不是一条横幅：这一页在这种状态下**没有别的内容**，
   横幅式提示会让下面留出一大片空白，看起来像没渲染完。
   不再用 3px 左色条：那正是「侧边条纹」那种最典型的装饰，
   状态改由一个状态点 + 一行小标签表达。 */
.px-sv-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 44px 24px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  text-align: center;
}
.px-sv-state-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.px-sv-state-mark {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--px-muted);
}
.px-sv-state-label {
  color: var(--px-ink-2);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.px-sv-state-text {
  margin: 0;
  max-width: 46ch;
  color: var(--px-ink);
  font-size: 13px;
  line-height: 1.6;
  text-wrap: pretty;
}
.px-sv-state-detail {
  margin: 0;
  max-width: 46ch;
  color: var(--px-detail-label);
  font-size: 11.5px;
  word-break: break-word;
}
.px-sv-state-loading .px-sv-state-mark {
  background: var(--px-tone-blue);
  animation: px-sv-pulse 1.4s var(--px-ease) infinite;
}
.px-sv-state-missing .px-sv-state-mark,
.px-sv-state-missing-route .px-sv-state-mark { background: var(--px-tone-yellow); }
.px-sv-state-failed .px-sv-state-mark { background: var(--px-tone-red); }

.px-sv-btn {
  height: 28px;
  margin-top: 4px;
  padding: 0 16px;
  color: var(--px-ink);
  /* 按钮是「块」，用白色 + 描边（与看板 .px-btn 一致），不用次级底色。 */
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-pill);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease), transform var(--px-dur-fast) var(--px-ease);
}
/* hover 用强调色：这是这一页唯一的「主操作」。 */
.px-sv-btn:hover {
  border-color: color-mix(in srgb, var(--px-pink-deep) 55%, transparent);
  background: color-mix(in srgb, var(--px-pink-deep) 8%, transparent);
}
.px-sv-btn:active { transform: scale(0.97); }
.px-sv-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }

@keyframes px-sv-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ── 宽屏塌缩：先并排、再收列，任何宽度都不留空格子 ─────────────── */
/* 1100 以下：第二行把「耗时构成」放整行、下面两张卡并排；
   第四行三块改成两列、第三块（请求分布）跨满整行。
   跨行是刻意的——三块塞进两列必然有一个空格子，那正是要消灭的空白。 */
@media (max-width: 1100px) {
  .px-sv-band-split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-sv-band-split > .px-sv-timing-cell { grid-column: 1 / -1; }
  .px-sv-band-three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .px-sv-band-three > :last-child { grid-column: 1 / -1; }
}

/* 880 以下：四枚 hero 改成 2×2。150px 的最小宽度是主题里定的，
   四列在这个宽度会把「平均每轮 1m2s」这类脚注挤成省略号。 */
@media (max-width: 880px) {
  .px-sv-heroes { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ── 窄屏：一列，表格去掉两家次要列，行距收紧 ───────────────────── */
@media (max-width: 720px) {
  .px-sv { padding: 16px 12px 24px; gap: 12px; }
  .px-sv-card { padding: 16px; }
  /* 720 以下所有分区行塌成单列：两列在 420 上会把「计价时段」压到
     读不出金额与占比的差别，而单列永远不会横向溢出。 */
  .px-sv-band-split,
  .px-sv-band-three { grid-template-columns: minmax(0, 1fr); }
  .px-sv-band-split > .px-sv-timing-cell,
  .px-sv-band-three > :last-child { grid-column: auto; }
  /* 提供商与单价在窄屏让位：模型 + 三档 token + 金额才是读数的主干，
     全留着就必然横向滚动。单价仍在单元格的 title 里。 */
  .px-sv-col-provider,
  .px-sv-col-unit { display: none; }
  .px-sv-table th,
  .px-sv-table td { padding: 8px 4px; }
  .px-sv-day { grid-template-columns: 2.6em minmax(28px, 1fr) auto; gap: 8px; }
  .px-sv-member { grid-template-columns: minmax(4em, 1fr) auto; }
  .px-sv-member .px-sv-meter { display: none; }
  .px-sv-state { padding: 32px 18px; }
  .px-sv-figure-value { font-size: 16px; }
}

/* 手机宽度：再把「写入」让位——它只在缓存写入发生过时才出现，
   而这一列撑出来就是一条横向滚动条。合计行仍然对得上（四桶之和在卡头）。 */
@media (max-width: 520px) {
  .px-sv-col-write { display: none; }
}

@media (max-width: 460px) {
  .px-sv-model { max-width: 9ch; }
  .px-sv-account-value { font-size: 20px; }
  .px-sv-card { padding: 12px; }
}

/* 深色：令牌已经在 body[data-ds-dark-theme] 下换过一支，这里只去掉阴影，
   免得白/深色卡片在暗底上像浮起来的纸片。 */
body[data-ds-dark-theme] .px-sv-card,
body[data-ds-dark-theme] .px-sv-state {
  box-shadow: none;
}

/* 减少动效偏好：占比条与呼吸点不再动画。 */
@media (prefers-reduced-motion: reduce) {
  .px-sv-meter-fill { transition: none; }
  .px-sv-state-loading .px-sv-state-mark { animation: none; }
}
`

			exports.SESSION_CSS = SESSION_CSS
		},
		"./theme.js": (exports, require) => {
			const m1 = require("./styles/accounts.js")
			const m2 = require("./styles/pricing.js")
			const m3 = require("./styles/session.js")
			/**
 * 视觉系统：只负责插件自己的两块界面——用量看板整页，以及输入框下方
 * 费用条 / 页面内提示条。全部用插件自己的 --px-* 令牌与 .px-* 类名。
 *
 * **不碰产品配色。** 早先这里带两套 `--dsw-alias-*` 主题（奶油·昼 / 暮色·夜）、
 * 一层令牌覆盖和一张全局皮肤样式表，等于替用户改掉整个产品界面的底色、文字色、
 * 按钮圆角、滚动条与选中色。皮肤已按需求移除：产品原版的深浅色与背景完全交还
 * DSH，插件只在上面那两块自己的界面上配色。
 *
 * 深浅色仍然跟着产品走：产品把 data-ds-dark-theme 打在 body 上，TOKENS 里
 * **读**这个属性、给出深色的一套 --px-* 取值。读产品属性是允许的，**写**产品的
 * --dsw-* 令牌不是（那会连产品窗口与侧栏的背景一起改掉）。
 * @module dsh-pixel-dashboard/client/theme
 */

const ACCOUNTS_CSS = m1.ACCOUNTS_CSS
const PRICING_CSS = m2.PRICING_CSS
const SESSION_CSS = m3.SESSION_CSS
/*
 * 这里**不该再有** PIXEL_THEMES / PALETTE_OVERRIDES 一类东西。
 *
 * 它们曾把两套 --dsw-alias-* 令牌注册成可选主题（设置 → 外观里的
 * 奶油·昼 / 暮色·夜），并默认叠一层 overrideTokens 覆盖。两者都会改动
 * **产品自己**的配色：用户打开的不止是这个看板，还有整个窗口、侧栏与会话区。
 * 皮肤功能已按需求移除，于是那两个导出连同 entry.js 里的注册与覆盖一起删掉了。
 *
 * 渲染闸门对这件事是**反向断言**：themes 与 paletteLayers 必须为 0。
 * 看板自己的配色不靠它们，靠 TOKENS 的 --px-* 变量 + DASHBOARD 里的 .px-*
 * 选择器；深色跟随产品靠读 body 上的 data-ds-dark-theme。
 */

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
  /* ── 浅色：白卡片 + 淡暖底 + 极少数内凹槽 ─────────────────────────────
     **这一页的观感规则只有一条：白色是唯一的「块」，米色只在「凹进去」的地方出现。**

     早先这里错在**面积**，不在明度：--px-surface-2 被拿去铺了 18 处
     （表头、余额说明条、单价行、价格表单、套餐块、时钟块、通知块……），
     于是白色卡片里嵌着一块块米色，看起来「东一块西一块」。
     第一版修复还把它调暗去「拉开层次」，等于把那些碎块**做得更显眼**，
     在真实界面上更丑——数值全绿，观感更差。

     现在的分工：
       --px-surface   #ffffff   所有卡片、面板、按钮（页面里唯一的「块」）
       --px-bg        #f6f2ea   页面底（卡片浮在它上面）
       --px-surface-2 #ece6da   只用于**内凹**：进度条轨道、分段控件底、
                                表头、输入框。四个地方，不再扩散。

     改这三个值时请保持「白 = 块、米 = 凹」，而不是靠对比度数字自我安慰。
     tools/render-check.mjs 里有一道闸门盯着「谁在铺 surface-2」的白名单。 */
  --px-bg: #f6f2ea;
  --px-surface: #ffffff;
  --px-surface-2: #ece6da;
  --px-line: rgba(87, 68, 58, 0.10);
  --px-line-2: rgba(87, 68, 58, 0.18);

  /* ── 中性层次的第二层与第三层 ──────────────────────────────────────
     页面需要「块 → 分区 → 内容」三层，早先是靠**七种彩色**去区分模块
     （每张概览卡一条不同颜色的顶栏、每个面板一个彩色圆点），于是整页像
     打翻了调色盘——用户的原话是「配色割裂」。

     现在只留一层中性面：面板头、工具条、表头共用 --px-layer-2，
     需要再凹一档（进度条轨道、表头压边）用 --px-layer-3。
     用 color-mix 而非写死的米色：深浅两套自动成立，不用各配一份。
     **强调色只留给「当前状态 / 主操作」**，不再当装饰。 */
  --px-layer-2: color-mix(in srgb, var(--px-ink) 3.5%, transparent);
  --px-layer-3: color-mix(in srgb, var(--px-ink) 6%, transparent);

  /* ── 品牌鲸鱼（头像插画用，不是界面色）───────────────────────────
     这是**插画**用色，不参与界面语义；用 DeepSeek 的蓝，深浅两套各给一档，
     保证在浅底上是「深蓝鲸鱼」、在深底上是「亮蓝鲸鱼」。 */
  --px-whale: #4d6bfe;
  --px-whale-belly: #9fb0ff;
  --px-whale-spout: #cddcff;
  --px-whale-eye: #ffffff;
  --px-whale-soft: color-mix(in srgb, #4d6bfe 12%, transparent);

  --px-pink: #f2a8c4;
  --px-pink-deep: #d9739b;
  --px-pink-soft: #fdeef4;
  /* 会话详情的强调色：浅色下用粉（与看板主色一致）。
     深色下换成紫——粉色在暗底上偏灰、像脏掉的高光，紫色同族但更清透。 */
  --px-detail-accent: #d9739b;
  --px-detail-accent-soft: #fdeef4;
  --px-detail-accent-line: #f2a8c4;
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
  /* 浮层里的次要文字（分节标签、行标签、脚注）。
     为什么不直接用 --px-muted：那个色在白底上的对比度实测 4.18，**低于 AA 的 4.5**，
     而浮层里这些字只有 11~12px，读起来吃力（版式审计把这一条判红过）。
     往墨色偏一档即可达标，且深浅两套自动成立——深色下墨色是亮的，方向自然正确。 */
  --px-detail-label: #75655a;

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
  /* 深色浮层里的次要文字：比 --px-muted 更亮一档，同样是为了过 AA（暗底上要更亮）。 */
  --px-detail-label: #acb5cd;

  --px-pink-soft: #3a2b34;
  /* 详情强调色在深色下走紫：见浅色处说明。 */
  --px-detail-accent: #c3aef0;
  --px-detail-accent-soft: #2f2b45;
  --px-detail-accent-line: #8b6cc4;
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
 * 看板局部样式：全部使用 px- 前缀类名，不依赖产品内部类名，
 * 因此产品升级不会让看板错版。
 *
 * 早先这里前面还有一张 SKIN 样式表（`body` 网格底纹、全局 button/input 的圆角与
 * transition、`::-webkit-scrollbar`、`::selection`）。它已按需求删除——那张表写的
 * 全是**全局元素选择器**，等于替用户重绘整个产品界面；产品的原版背景与控件观感
 * 应当原样交还 DSH。
 *
 * 删掉它之后有两个连带后果，都在本文件里就地补上了，改这块时别丢：
 *   1) 全局的 `button, input { border-radius; transition }` 没了，于是看板自己的
 *      控件必须自己写圆角与过渡。`--px-*` 令牌的取值不受影响（它读的是产品打在
 *      body 上的 data-ds-dark-theme），因此深浅色仍然对。
 *   2) 全局 `:focus-visible` 的焦点环也没了，`.px-*` 控件要自己给一条，
 *      否则键盘操作时看不出焦点在哪。
 * 底纹没了之后 `.px-topbar` 的毛玻璃底色更要紧：它原本盖在 body 网格上，
 * 现在下面就是产品自己的背景，因此这一层仍保留 color-mix + backdrop-filter。
 */
const DASHBOARD = `
/* 看板整页自己铺底色。早先这一层是透明的，背景靠 SKIN 打在 body 上的网格底纹；
   皮肤删掉之后不铺就只剩产品自己的背景，浅色下奶油色卡片会直接浮在产品底色上、
   整页也没有「这是插件的一页」的边界。铺 --px-bg 只给**这一页**上色，
   不碰产品任何元素——这正是「插件只在自己的界面上用自己的配色」的意思。 */
.px-root {
  box-sizing: border-box;
  min-height: 100%;
  padding: 16px 20px 36px;
  background: var(--px-bg);
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

/* 看板里的按钮。圆角与过渡**必须自己写**：早先这两条由 SKIN 那条全局
   button/input 规则提供，皮肤删掉之后不自己写就会变成直角、且 hover 是硬切。
   令牌取值（--px-r-sm 等）不受影响，因此深浅色仍然对。 */
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
  transition:
    background-color var(--px-dur) var(--px-ease),
    border-color var(--px-dur) var(--px-ease),
    color var(--px-dur-fast) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease),
    transform var(--px-dur-fast) var(--px-ease);
}
.px-btn:hover:not(:disabled) {
  /* 按钮 hover：极淡着色，而不是换成米色块——否则一悬停就「变脸」。 */
  background: color-mix(in srgb, var(--px-ink) 6%, transparent);
  box-shadow: var(--px-elev-2);
  transform: translateY(-1px);
}
.px-btn:active:not(:disabled) { transform: translateY(0) scale(0.98); box-shadow: var(--px-elev-1); }
.px-btn:disabled { opacity: 0.55; cursor: default; }
/* 焦点环：全局 :focus-visible 规则随 SKIN 一起删了，看板自己的控件要自己给一条，
   否则键盘操作时看不出焦点落在哪个按钮上。 */
.px-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-btn.primary {
  color: #fff; border-color: transparent;
  background: linear-gradient(145deg, var(--px-pink), var(--px-pink-deep));
  box-shadow: 0 2px 10px color-mix(in srgb, var(--px-pink-deep) 35%, transparent);
}
.px-btn.small { padding: 5px 11px; font-size: 12px; }
/* 破坏性动作（移除凭据）。红底只给这一个按钮：插件里其余动作都不是不可撤销的，
   把危险色摊开用会让真正的警告失去分量。 */
.px-btn.danger {
  color: #fff; border-color: transparent;
  background: var(--px-tone-red);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--px-tone-red) 32%, transparent);
}
.px-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--px-tone-red) 86%, #000);
}
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
/* 分段控件里的每一枚选项。圆角跟着 thumb 走（6px）——早先这颗按钮自己没有圆角，
   靠的是 SKIN 那条全局 button 规则；全局规则删掉后不补就变成直角，
   而 thumb 仍是圆角，一枚圆角滑块在直角按钮上滑动看起来像错位。 */
.px-seg-btn {
  position: relative; z-index: 1;
  padding: 5px 13px;
  font: inherit; font-size: 12px; font-weight: 550;
  color: var(--px-muted);
  background: none; border: none; cursor: pointer;
  border-radius: 6px;
  transition:
    color var(--px-dur-fast) var(--px-ease),
    background-color var(--px-dur) var(--px-ease);
}
.px-seg-btn:hover { color: var(--px-ink-2); }
.px-seg-btn[aria-selected='true'] { color: var(--px-ink); }
.px-seg-btn:focus-visible { outline: none; box-shadow: var(--px-ring); }

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
  padding: 8px 14px;
  /* 第二层中性面：让「面板头」与「面板内容」分开，而不是靠给每个面板配一种颜色。
     分隔线仍在，但它现在是**强化**而不是唯一的层级信号。 */
  background: var(--px-layer-2);
  border-bottom: 1px solid var(--px-line);
}
.px-panel-title { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 620; letter-spacing: 0.01em; color: var(--px-ink); }
.px-panel-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; opacity: 0.85; }
.px-tone-bg-blue { background: var(--px-tone-blue); }
.px-tone-bg-pink { background: var(--px-tone-pink); }
.px-tone-bg-green { background: var(--px-tone-green); }
.px-tone-bg-yellow { background: var(--px-tone-yellow); }
.px-tone-bg-purple { background: var(--px-tone-purple); }
.px-tone-bg-red { background: var(--px-tone-red); }
.px-panel-extra { font-size: 11.5px; color: var(--px-muted); }
/* 标题右侧的同排数字（消费趋势的合计）：比标题弱、比普通正文强，
   并与标题之间留一道竖线，说明「这是这句话的注脚」。 */
.px-panel-total {
  margin-left: 10px; padding-left: 10px;
  border-left: 1px solid var(--px-line-2);
  font-size: 11.5px; font-weight: 560; color: var(--px-ink-2);
  font-variant-numeric: tabular-nums;
}
/* 卡片头部的小开关（「我的单价」）：原生 checkbox + 文案，不做自绘开关——
   这类二级选项用系统控件最稳（键盘、读屏、深浅色都不用再管）。 */
.px-inline-toggle {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; color: var(--px-muted);
  cursor: pointer; user-select: none;
}
.px-inline-toggle input { margin: 0; accent-color: var(--px-pink-deep); }
.px-inline-toggle:hover { color: var(--px-ink-2); }
/* ── 顶行的「用户卡」：官方账号头像 + 余额 + 官网入口 ────────────────
   布局按用户要求：**头像占左侧主区域、余额占右侧主区域**，官网入口固定在右上角，
   赠送金 / 累计消费与钱放在同一列（它们是钱的注脚，不该散落到别处）。
   尺寸/圆角/阴影与 .px-stat 同族：同一行里出现两种卡片语言，读起来像两块不同的东西。 */
.px-user {
  position: relative;
  display: flex; align-items: center; gap: 12px;
  padding: 12px 14px 11px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: box-shadow var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease);
}
.px-user:hover { box-shadow: var(--px-elev-2); border-color: var(--px-line-2); }
/* 左侧主区域：头像（主视觉）+ 名字（小字，不显示手机号） */
.px-user-who { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 0 1 auto; }
.px-user-avatar {
  flex: none;
  position: relative;
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 12px;
  overflow: hidden;
  background: var(--px-whale-soft);
}
/* 真实头像：铺满底板并裁成同一圆角；失败时（img 被 display:none）露出鲸鱼。 */
.px-user-avatar > img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
/* 未登录：底板退成中性层让「这是占位」可读，但**鲸鱼保持彩色**（用户要求不置灰）。 */
.px-user.off .px-user-avatar { background: var(--px-layer-2); }
.px-whale { display: block; }
.px-user-name {
  font-size: 11px; font-weight: 560; color: var(--px-muted); letter-spacing: 0.06em;
  max-width: 110px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 右侧主区域：总余额（大）+ 赠送 / 累计消费（小），右对齐成一块 */
.px-user-money {
  display: grid; gap: 3px; justify-items: end;
  margin-left: auto; min-width: 0; padding-right: 52px;
}
.px-user-total {
  font-size: 24px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.1;
  color: var(--px-ink); font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.px-user-sub {
  font-size: 10px; color: var(--px-muted); line-height: 1.3;
  text-align: right; font-variant-numeric: tabular-nums;
  max-width: 160px;
}
.px-user-state { font-size: 11.5px; color: var(--px-muted); line-height: 1.45; text-align: right; }
.px-user-state.warn { color: var(--px-tone-red); }
/* 官网入口：固定右上角，不参与左右两个主区域的排布 */
.px-user-link {
  position: absolute; top: 9px; right: 12px;
  font-size: 11.5px; color: var(--px-ink-2);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: color var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-user-link:hover { color: var(--px-ink); border-bottom-color: var(--px-line-2); }
.px-user-link:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }

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
  /* 小提示：透明 + 描边。铺米色会在标题行末尾多出一枚色块。 */
  background: transparent;
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
/* 概览卡：**中性**。
   早先每张卡顶部有一条不同颜色的渐变线 + 右上角一团彩色光晕（::before / ::after），
   四张卡就是四种颜色。用户的原话是「配色割裂」——强调色被当成了装饰。
   现在卡片只说数字：标签、数值、脚注三层字号拉开，颜色一律走墨色系；
   强调色只留给「当前状态 / 主操作」（分段选中、徽标、链接）。
   悬停只改描边与阴影，不做位移，避免一屏四个卡在鼠标扫过时此起彼伏。 */
.px-stat {
  position: relative;
  padding: 12px 14px 11px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-1);
  transition: box-shadow var(--px-dur) var(--px-ease), border-color var(--px-dur) var(--px-ease);
}
.px-stat:hover { box-shadow: var(--px-elev-2); border-color: var(--px-line-2); }
.px-stat-label { font-size: 11px; font-weight: 560; color: var(--px-muted); letter-spacing: 0.06em; }
.px-stat-value {
  margin: 7px 0 6px;
  font-family: var(--px-num-font);
  font-size: 27px; line-height: 1.12; letter-spacing: -0.01em;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
}
.px-stat-foot { font-size: 11.5px; color: var(--px-muted); line-height: 1.65; }

/* 徽标：**透明底 + 描边**，不用实色底。
   它会被放进各种深浅不同的容器里（卡片、表头、奶油色的辅助块），实色底一旦
   与父级同色就等于消失——实测 .px-badge 落在 .px-notify-permission
   （同样是 surface-2）上时对比度是 **1.000**，整个徽标只剩文字浮着。
   透明底 + 描边在任何父级上都成立，且不参与「三层表面」的层次语义。
   注意本段在模板字符串里：注释中不能出现反引号（这个坑踩过两次）。 */
.px-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px; font-weight: 570;
  border-radius: var(--px-r-pill);
  background: transparent;
  color: var(--px-ink-2);
  border: 1px solid var(--px-line-2);
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
/* 团队标记：会话清单里标出「它属于/它就是一个智能体团队」。
   用紫色而不是粉/绿——后两者在这份界面里已经有含义（粉 = 高峰/选中，
   绿 = 空闲/正常），团队是另一种维度，混用会让人读成时段状态。 */
.px-badge.team {
  background: color-mix(in srgb, var(--px-purple) 34%, transparent);
  color: var(--px-tone-purple);
  border-color: color-mix(in srgb, var(--px-tone-purple) 28%, transparent);
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

/* 图例：**强制一行**。
   早先是 flex-wrap + 16px 间距，供应商一多就折成两行、而且条目之间空得很开
   （用户反馈「间隙有点大、最好一行显示完」）。现在不换行、间距收到 10px、
   字号小一档；放不下时横向滚动而不是折行（滚动条隐藏，但可滚）。 */
.px-legend {
  display: flex; flex-wrap: nowrap; align-items: center; gap: 10px;
  margin-top: 8px; font-size: 11.5px;
  overflow-x: auto; scrollbar-width: none;
}
.px-legend::-webkit-scrollbar { display: none; }
.px-legend-item { display: inline-flex; align-items: center; gap: 5px; color: var(--px-muted); white-space: nowrap; flex: none; }
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
.px-table th { font-size: 10.5px; font-weight: 600; color: var(--px-ink-2); background: var(--px-layer-2); letter-spacing: 0.08em; }
/* 表头下沿压一档：数据行与表头的分界靠这条线，不靠底色——单靠底色时
   用户的原话是「表头和背景色一样」，层次根本没立起来。 */
.px-table thead th { border-bottom: 1px solid var(--px-line-2); }
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
/* **不要**把 display:flex 加在 td 上：td 一旦脱离表格布局，
   该列的剩余宽度就不再被它占据，于是展开行的粉色底只铺到文字处，
   右侧露出一块刺眼的白（用户报的「条目里缺一块」就是它）。
   正确做法是 td 保持表格单元格，flex 放进内层 div。 */
.px-session-cell-inner {
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
  background: transparent;
  border: 1px solid var(--px-line);
  white-space: nowrap;
}
.px-session-id {
  /* 会话 id 仍然可查（悬停 title 可复制），但排在标题之后、视觉上退到最末 */
  color: var(--px-muted);
  white-space: nowrap;
}

/* 可点的标题：点它跳到那条会话。用下划线提示「这里是一个动作」，
   靠 hover 变色确认，而不是整行变色——整行点的是「展开」。 */
.px-session-link { cursor: pointer; }
.px-session-link:hover { text-decoration: underline; text-underline-offset: 2px; }
.px-session-link:focus-visible {
  outline: 2px solid var(--px-accent);
  outline-offset: 2px;
  border-radius: 3px;
}
.px-session-row { cursor: pointer; }
/* 展开状态：**不铺底色**——详情区本身已经是一块内容区，整行再加底色会叠成
   两层色块（正是用户说的「东一块西一块」）。改用左侧色条 + 标题加粗。 */
.px-session-row-open > td:first-child {
  box-shadow: inset 3px 0 0 var(--px-accent);
}
.px-session-when { color: var(--px-muted); white-space: nowrap; }

/* ============================================================
   会话详情的视觉设计（第二轮重做）

   用户对上一版的评价是「底色还是很丑、没有视觉重点、看不出收起展开」。
   因此这一版按三条重来：

   1) **白 + 粉**：详情区底色用白色（与页面唯一的「块」一致），
      只在顶部叠一层极淡的粉色晕染作为「这是同一行的延续」的信号；
      强调色统一用马卡龙粉（--px-pink-deep），不再铺奶油色底。
   2) **层级靠字号与留白**：四个主打指标（金额/Token/时长/工具）用大号数字，
      其余明细是安静的标签-值行——上一版把所有数字做成同样大小，所以没有落点。
   3) **状态可发现**：行首折叠箭头（▸/▾）表达「能点」，hover 换底色；
      团队用标签页切换成员，不再拆成多行。
   ============================================================ */

/* 行首折叠箭头：可发现性的唯一落点，给了明确的 12px 槽位与转动动画。 */
.px-session-chev { width: 18px; padding-right: 0 !important; }
.px-chev {
  display: inline-block;
  color: var(--px-muted);
  font-size: 10px; line-height: 1;
  transition: transform var(--px-dur) var(--px-ease), color var(--px-dur) var(--px-ease);
}
.px-chev-open { transform: rotate(90deg); color: var(--px-detail-accent); }
.px-session-row:hover .px-chev { color: var(--px-detail-accent); }

/* 行 hover：告诉用户整行可点。展开行用左侧粉色条标出位置，
   不铺底色（铺了会与详情区叠成两层色块）。 */
.px-session-row { cursor: pointer; transition: background var(--px-dur) var(--px-ease); }
.px-session-row:hover > td { background: var(--px-hover, rgba(0, 0, 0, .02)); }
/* 展开行：整行铺**淡强调色**。同一时刻只展开一行，所以不会出现满屏碎色块；
   用底色而不是只画侧条，是因为用户明确要「区分其他收起态的条目」。 */
.px-session-row-open > td { background: var(--px-detail-accent-soft); }
.px-session-row-open > td:first-child { box-shadow: inset 3px 0 0 var(--px-detail-accent); }
.px-session-when { color: var(--px-muted); white-space: nowrap; }

/* ── 详情容器：白底 + 顶部粉色晕染 ─────────────────────────────── */
.px-session-detail-row > td { padding: 0; border-top: 0; }
.px-session-detail {
  padding: 16px 18px 18px;
  background:
    linear-gradient(180deg, var(--px-detail-accent-soft) 0, transparent 120px),
    var(--px-surface);
  /* **不要 border-top**（用户：条目与详情之间那条黑线去掉）：上一行的粉色底
     已经把两者分开了，再压一条实边会变成一道生硬的缝。 */
  border-left: 3px solid var(--px-detail-accent);
}

/* ── 成员标签页 ───────────────────────────────────────────────── */
.px-dtabs {
  display: flex; gap: 6px; flex-wrap: wrap;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--px-line);
}
.px-dtab {
  appearance: none;
  padding: 5px 12px;
  font: inherit; font-size: 12px; font-weight: 550;
  color: var(--px-ink-2);
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-pill);
  cursor: pointer;
  transition: all var(--px-dur) var(--px-ease);
}
.px-dtab:hover { border-color: var(--px-detail-accent-line); color: var(--px-detail-accent); }
.px-dtab-on {
  color: var(--px-detail-accent);
  background: var(--px-detail-accent-soft);
  border-color: var(--px-detail-accent-line);
  font-weight: 650;
}

/* ── 四个主打指标：第一眼的落点 ───────────────────────────────── */
.px-heroes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.px-hero {
  display: flex; flex-direction: column; gap: 3px;
  padding: 11px 13px 10px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-left: 3px solid var(--px-accent);
  border-radius: var(--px-r-md);
  box-shadow: var(--px-elev-1);
  min-width: 0;
  --px-accent: var(--px-detail-accent);
}
.px-hero-accent { --px-accent: var(--px-detail-accent); }
.px-hero-blue { --px-accent: var(--px-tone-blue); }
.px-hero-green { --px-accent: var(--px-tone-green); }
.px-hero-purple { --px-accent: var(--px-tone-purple); }
.px-hero-label {
  font-size: 11px; font-weight: 550; color: var(--px-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.px-hero-value {
  font-family: var(--px-num-font);
  font-size: 23px; line-height: 1.15; letter-spacing: .3px;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
}
.px-hero-foot {
  font-size: 10.5px; color: var(--px-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}


/* ── 两栏明细：安静的标签-值行，靠虚线分隔而不是每项一张卡 ───────── */
.px-dcols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: 6px 28px;
  margin-bottom: 14px;
}
.px-dcol { min-width: 0; }
.px-dcol-title {
  display: block; margin-bottom: 6px;
  font-size: 11px; font-weight: 650; letter-spacing: .05em;
  color: var(--px-muted);
}
.px-drow {
  display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
  padding: 5px 0;
  border-bottom: 1px dashed var(--px-line);
  font-size: 12px;
}
.px-drow:last-child { border-bottom: 0; }
.px-drow-label {
  display: flex; align-items: center; gap: 7px;
  color: var(--px-muted);
  min-width: 0;
}
.px-drow-value {
  font-family: var(--px-num-font);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--px-ink);
  text-align: right;
  word-break: break-word;
}
/* 语义色点：与 hero 的色条同一套颜色，于是「这数属于哪类」不用读文字 */
.px-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.px-dot-pink { background: var(--px-pink); }
.px-dot-blue { background: var(--px-tone-blue); }
.px-dot-green { background: var(--px-tone-green); }
.px-dot-purple { background: var(--px-tone-purple); }
.px-dot-yellow { background: var(--px-tone-yellow); }
.px-dot-accent { background: var(--px-detail-accent); }

/* ── 峰时/闲时：两段都画出来，两端百分比上色 ──────────────────── */
.px-dpeak { max-width: 520px; }
.px-dpeak-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  margin-bottom: 7px;
}
.px-dpeak-split { display: flex; gap: 12px; font-size: 11.5px; }
.px-peak-bar {
  display: flex;
  height: 10px; border-radius: var(--px-r-pill);
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
  overflow: hidden;
}
.px-peak-fill {
  display: block; height: 100%;
  background: linear-gradient(90deg, var(--px-yellow-deep), var(--px-yellow));
  transition: width .25s var(--px-ease);
}
.px-peak-rest { display: block; flex: 1; height: 100%; background: var(--px-tone-blue); opacity: .22; }
.px-peak-peak { color: var(--px-yellow-deep); font-weight: 600; }
.px-peak-idle { color: var(--px-tone-blue); font-weight: 600; }



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
  /* 两张趋势卡**等高**（用户要求）。两张图都是固定 240px 高，等高靠 stretch
     把卡片拉到同一底边；图本身高度一致，所以看起来是齐的。 */
  align-items: stretch;
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
   宽度（"周一至周五（不含法定节假日）09:00–12:00、14:00–18:00" 这行本身就要 340px 左右），
   余下全部让给日历，格子才不至于缩到看不清。
   用 minmax(fr) 而不是固定 px：窄屏时两栏等比收缩，且左栏有 280px 下限兜底。 */
.px-pair {
  display: grid;
  grid-template-columns: minmax(280px, 0.6fr) minmax(0, 1.4fr);
  gap: 12px;
  /* 两张卡**等高**（用户要求）：左栏内容少，按内容高度会把底边留在半空，
     与右边那张日历卡参差不齐。stretch 让两张卡一起到底部线对齐。 */
  align-items: stretch;
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
  /* 第一列是**色块**（一个模型可能多家来源，并排几个小方块），第二列才是模型名。
     色块必须自成一列：若让它和模型名挤在同一个 flex 里，行与行之间的色块个数不同
     就会把模型名推到不同的起始位置（实测 4 个色块 → 名称起点 66px、1 个 → 33px），
     看起来就是「有的行前面突出一块空白」。 */
  grid-template-columns: auto minmax(0, 1fr) auto auto auto;
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
  /* 单价行是**卡片里的列表行**，不是独立的块：不铺底色，只靠行间距分隔。
     早先铺 surface-2，一张卡片里会因此出现一排米色横条——正是「东一块西一块」。 */
  background: transparent;
  font-size: 11.5px; color: var(--px-muted);
}
/* 隔行轻微着色用来跟读；它必须极淡，否则又变成「色块」 */
.px-rate:nth-child(even) { background: color-mix(in srgb, var(--px-ink) 3%, transparent); }
/* 第 2 列：模型名 + 归一后的键 + 来源数。允许收缩，不把右列挤走 */
.px-rate-who {
  grid-column: 2; grid-row: 1;
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  min-width: 0;
}
.px-rate-who > b { color: var(--px-ink); font-size: 12px; }
.px-rate-prices {
  /* 直接落在列表的第 2–4 列上，并继续用 subgrid 往下继承，
     于是三个价格列与表头、与其它行共享同一组轨道宽度。 */
  grid-column: 3 / -1; grid-row: 1;
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
/* 第 1 列：一个模型可能由多家提供商提供，这里并排它们的色块（与环图同一套配色）。
   收窄间距并让它们成组，读起来才像「同一个模型的几个来源」而不是几件不相干的东西。
   本列宽度由全表最宽的那一组色块决定（subgrid），因此模型名在所有行上左边界一致。 */
.px-rate-tones {
  grid-column: 1; grid-row: 1;
  display: inline-flex; align-items: center; gap: 3px; flex: none;
}
/* 窄屏：价格换到第二行，不要横向挤成参差 */
/* 单价编辑器的样式已搬到 styles/pricing.js（v3：编辑器从看板正文移进设置弹层）。
   这里**不要**再写 .px-price-editor / .px-price-form / .px-price-actions 一类规则——
   那几块 UI 现在只由 pricing 那一张表负责，两边各写一份迟早会漂移。 */
.px-balance-state.px-ok {
  background: color-mix(in srgb, var(--px-tone-green) 20%, var(--px-surface-2));
  color: var(--px-ink-2);
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
  transition:
    border-color var(--px-dur) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease),
    background-color var(--px-dur) var(--px-ease);
}
.px-input:disabled { opacity: 0.55; }
/* 输入框的焦点环同样要自己给（全局那条随 SKIN 删了）：原来那圈 outline 是
   产品默认样式，在暗色底下几乎看不见。 */
.px-input:focus-visible { outline: none; border-color: var(--px-pink-deep); box-shadow: var(--px-ring); }
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
.px-balance-state.px-ok {
  background: color-mix(in srgb, var(--px-tone-green) 20%, var(--px-surface-2));
  color: var(--px-ink-2);
}

@media (max-width: 720px) {
  /* 窄屏：价格整行换到第二行。此时每一行都占满同一宽度，因此均分三列即可让
     列与列继续对齐——这里刻意**不用 subgrid**（上一层的轨道只剩 1 列了，
     继承下来会把三个价格竖着叠起来）。 */
  /* 色块仍单独一列（宽度由本表最宽的一组决定），模型名跟在它右边：
     不这样做，色块个数不同同样会让名称左边界参差——那正是宽屏下修掉的那个问题。 */
  .px-rate { grid-template-columns: auto minmax(0, 1fr); }
  .px-rate-tones { grid-column: 1; grid-row: 1; }
  .px-rate-who { grid-column: 2; grid-row: 1; }
  /* 六个数字框在窄屏塌成单列：并排会让每个框窄到看不清数字 */
  .px-rate-pairs { grid-template-columns: minmax(0, 1fr); }
  .px-rate-prices {
    grid-column: 1 / -1; grid-row: 2;
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
   conversation.composer.dock 是**横向 flex 行**（.dock：display:flex +
   justify-content:center + gap:12px），我们是这行里的**一项**，因此这一层只做
   inline-flex、按内容取宽，绝不占满整行。
   占满整行会与官方胶囊抢宽度，把「1 轮 · 38 步」「2.1M tok」挤成省略号——那正是
   用户截图反馈的现象。旧版这里写作 width:100%（还带左右内边距），前提是「容器为
   纵向 flex 且没有 gap」——那是 .root 的样式，不是 .dock 的，属于认错了容器。
   两种落位共用这一层：
     · 旧契约（DSH ≤ 0.2.0-rc.2）portal 进官方统计容器，追加为末子节点 → 官方右边；
     · 新契约（DSH ≥ 0.2.1-alpha.1）作为槽位项，靠 order 排在官方胶囊之后 → 官方右边。 */
.px-pill-group {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
  max-width: 100%;
  min-width: 0;
  /* 字号必须自己定：.px-pill 用 font: inherit，而 dock 那一行没有自己的字号。
     旧版这一点由 .px-cost-row 提供，它被本层取代后要照旧带上，否则徽标会跟着
     产品外壳的字号走，和官方胶囊并排时大小不一致。 */
  font-size: var(--dsh-content-font-size-secondary, 13px);
}

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
  /* 与详情面板里的角标同一处修正：淡黄底上的 10px 文字必须用 --px-ink。
     原来写 --px-tone-yellow，实测对比度只有约 2.6:1——「估算」两个字在浅色下
     基本读不出来，而它是「这个数字不是精确值」的唯一提示。 */
  background: color-mix(in srgb, var(--px-yellow) 45%, transparent);
  color: var(--px-ink);
  font-size: 10px; font-weight: 600;
  line-height: 1.6;
}
/* 拿不到费用时的告警态：不要在界面上装作一切正常 */
.px-pill-warn { background: color-mix(in srgb, var(--px-red) 14%, transparent); }
.px-pill-warn .px-pill-dot { background: var(--px-tone-red); }
.px-pill-warn .px-pill-value { color: var(--px-tone-red); }

/* 可点击的那一枚：详情面板的入口。
   它必须是 <button> 而不是带 onClick 的 <span>——键盘用户要能 Tab 上来按回车，
   读屏软件要能播报「可展开」。因此这里要把浏览器按钮的默认外观全部清掉，
   否则 dock 里会冒出一个灰底描边的方盒，与旁边两枚胶囊完全不是一套东西。
   小三角是唯一的可见提示：不带它，用户不知道这一枚与旁边那两枚**行为不同**。 */
.px-pill-button {
  appearance: none;
  font: inherit;
  cursor: pointer;
  /* tailwind/normalize 之类会把 button 的字色重置掉，这里显式接回来 */
  color: var(--px-label-tertiary);
}
.px-pill-button:focus-visible {
  outline: none;
  box-shadow: var(--px-ring);
}
.px-pill-button[aria-expanded='true'] {
  background: color-mix(in srgb, var(--px-ink) 9%, transparent);
}
.px-pill-caret {
  width: 0; height: 0; flex: none;
  margin-left: 1px;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  /* 收起时朝上（面板在**上方**弹出），展开后翻过来朝下 */
  border-bottom: 5px solid currentColor;
  opacity: 0.62;
  transition: transform var(--px-dur-fast) var(--px-ease);
}
.px-pill-button[aria-expanded='true'] .px-pill-caret { transform: rotate(180deg); }

/* ── 费用详情面板（点开费用徽标后弹在它上方）──────────────────────
   之前这块信息全塞在 title 属性里，落地成一个**裸的系统浮窗**：字号跟操作系统走、
   换行由浏览器决定、配色不听产品的深浅色、鼠标一移开就消失，而且没法点击。
   用户的原话是「现在直接是一个裸文本浮窗，不好看」。

   这不是看板的一部分，所以它**不能**套 .px-panel：那个是「页面里的卡片」，
   有 12px 外边距与 hover 抬升；这里是一个浮层，位置由 JS 算、宽度按内容取。

   ## 底色为什么走 --px-surface 而不是 --px-bg
   面板浮在**产品自己的输入框区域**上方，背景是产品的底色（深浅都有可能），
   而 .px-toast 已经在用 --px-surface 做同一件事：浮层要自己是一块干净的表面，
   不能指望底下的颜色与看板页面一致。 */
.px-detail-anchor {
  /* 定位与宽度由 panelStyle() 以内联样式给出（它要量锚点矩形）；
     这里只兜住「JS 没给样式时也不塌成 0 宽」。 */
  z-index: 2147483000;
  max-width: calc(100vw - 24px);
}
.px-detail {
  --px-accent: var(--px-tone-pink);
  box-sizing: border-box;
  padding: 13px 14px 12px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-lg);
  background: var(--px-surface);
  box-shadow: var(--px-elev-3);
  color: var(--px-ink-2);
  font-family: var(--px-ui-font);
  font-size: 12px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  animation: px-detail-in var(--px-dur) var(--px-ease-out);
  /* 浮层里的文字可以被选中复制（金额常要贴到别处），但拖选不该把后面的产品
     界面一起带上——user-select: text 明确允许本层内部选中。 */
  user-select: text;
}
.px-detail * { box-sizing: border-box; }
.px-detail-tone-purple { --px-accent: var(--px-tone-purple); }
.px-detail-tone-red { --px-accent: var(--px-tone-red); }

/* 抬头：色点 + 标题 + 「估算」角标 + 右侧大号金额。
   大号金额与标题同一行：面板不宽，另起一行会让第一屏只剩一个数字。 */
.px-detail-head {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--px-line);
}
.px-detail-mark {
  align-self: center;
  width: 7px; height: 7px; flex: none;
  border-radius: 50%;
  background: var(--px-accent);
}
.px-detail-title { color: var(--px-ink); font-size: 12.5px; font-weight: 620; }
.px-detail-badge {
  align-self: center;
  padding: 0 5px;
  border-radius: var(--px-r-pill);
  /* 角标底色是淡黄强调，文字必须**足够深**。
     实测过：原来写 color: var(--px-tone-yellow)（#c99a2e）落在淡黄底上，
     对比度只有 2.58:1——版式审计直接把这一条判红，而肉眼在浅色下确实读不清
     那个 10px 的「估算」。改成 --px-ink（墨色），它是深浅两套各自定义过的，
     在淡黄底上成立，在深色模式下也成立。 */
  background: color-mix(in srgb, var(--px-yellow) 45%, transparent);
  color: var(--px-ink);
  font-size: 10px; font-weight: 600; line-height: 1.6;
}
.px-detail-headline {
  margin-left: auto;
  color: var(--px-ink);
  font-size: 15px; font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* 分节：每节一个抬头，节与节之间用极淡的分隔线，不加底色。
   「白块里再嵌色块」正是用户报过的「东一块西一块」，浮层里尤其明显。 */
.px-detail-section { padding-top: 9px; }
.px-detail-section + .px-detail-section { margin-top: 9px; border-top: 1px dashed var(--px-line); }
.px-detail-section-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
}
.px-detail-section-label {
  color: var(--px-detail-label);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.px-detail-section-total {
  margin-left: auto;
  color: var(--px-ink-2);
  font-size: 11.5px; font-weight: 600;
}

/* 一行：标签 | 占比条 | 数值。
   占比条那一列**固定宽度并允许为空**：各行的数值因此左边缘对齐，
   而「用量构成」那几行没有比例可画，留白比让数值左右跳整齐得多。 */
.px-detail-rows { display: grid; gap: 4px; }
.px-detail-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px minmax(52px, auto);
  align-items: center;
  gap: 8px;
}
.px-detail-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--px-detail-label);
}
.px-detail-row-meter { display: flex; align-items: center; }
.px-detail-row-value {
  color: var(--px-ink);
  font-weight: 570;
  text-align: right;
  white-space: nowrap;
}
/* 占比条轨道用**描边色**而不是 --px-surface-2：面板本身已经是白「块」，
   再铺一块米色轨道就是「白块里嵌色块」。这条与看板那条「谁在铺次级底色」
   的白名单闸门是同一条规则，因此刻意不进白名单。 */
.px-detail-meter {
  display: block;
  width: 100%;
  height: 4px;
  border-radius: var(--px-r-pill);
  background: var(--px-line);
  overflow: hidden;
}
.px-detail-meter-fill {
  display: block;
  height: 100%;
  border-radius: var(--px-r-pill);
  transition: width var(--px-dur-slow) var(--px-ease-out);
}
.px-detail-tone-bg-blue { background: var(--px-tone-blue); }
.px-detail-tone-bg-pink { background: var(--px-tone-pink); }
.px-detail-tone-bg-green { background: var(--px-tone-green); }
.px-detail-tone-bg-yellow { background: var(--px-tone-yellow); }
.px-detail-tone-bg-purple { background: var(--px-tone-purple); }
.px-detail-tone-bg-red { background: var(--px-tone-red); }

/* 脚注：口径说明。字号再小一号、颜色再淡一档——它是「读到了才安心」的内容，
   不该与数字抢注意力，但也不能省（省掉用户会以为金额就是账单）。 */
.px-detail-notes {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--px-line);
  color: var(--px-detail-label);
  font-size: 11px;
  line-height: 1.6;
}
.px-detail-notes p { margin: 0; }
.px-detail-notes p + p { margin-top: 4px; }
@keyframes px-detail-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── 侧栏「用量看板」行上的时段倒计时 ────────────────────────────
   一行文字，用颜色区分时期：
     高峰中（红）→ 2时15分后空闲期
     空闲中（绿）→ 空闲期剩2时15分

   刻意**没有环形进度**：那枚环要「已走 ÷ 总长」，而各段长度差几十倍
   （午休 2 小时、周末 63 小时，春节那种长连休 255 小时），环在长段里几乎不动，
   看起来像坏了。
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
  /* 卡片里的一行「倒计时」，不该是一块米色：改成极淡的着色底，
     只为把这一行与上面的标题分开，仍读作「同一张卡片里的内容」。 */
  background: color-mix(in srgb, var(--px-ink) 4%, transparent);
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
  /* 一行状态说明，不是一块卡片：描边 + 透明底，放在白卡片里不抢眼。 */
  background: transparent;
  border: 1px solid var(--px-line);
  font-size: 11.5px; line-height: 1.6; color: var(--px-muted);
}
/* 两个异常态才上色：正常态保持安静，异常才需要被看见。 */
.px-balance-state.px-warn {
  background: color-mix(in srgb, var(--px-yellow) 20%, transparent);
  border-color: color-mix(in srgb, var(--px-yellow) 40%, var(--px-line));
  color: var(--px-ink-2);
}
.px-balance-state.px-error {
  background: color-mix(in srgb, var(--px-red) 16%, transparent);
  border-color: color-mix(in srgb, var(--px-red) 38%, var(--px-line));
  color: var(--px-ink-2);
}
.px-balance-privacy {
  margin: 12px 0 0;
  padding-top: 10px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; line-height: 1.7; color: var(--px-muted);
}
.px-balance-state.px-off { background: transparent; color: var(--px-muted); }

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
  /* 一家一块：靠**描边**分块，不铺底色。卡片里再套一片米色块，
     是最典型的「东一块西一块」来源——白卡片里浮着一排米色方块。 */
  background: transparent;
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
  /* 折叠的「怎么配」说明：描边即可，不铺底色（它已在一个有描边的块里）。 */
  background: transparent;
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

/* 「移除套餐凭据」：破坏性动作，因此整块折进 details 且默认收起。
   危险色只用在「移除」按钮与确认态上——满屏红字会让真正的警告失效。 */
.px-cred-details { margin-top: 10px; }
.px-cred { margin-top: 10px; }
.px-cred-head {
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  margin-bottom: 6px;
}
.px-cred-head > b { font-size: 13px; font-weight: 620; color: var(--px-ink); }
.px-cred-head .px-muted { margin: 0; }
.px-cred-intro { margin: 0 0 10px; font-size: 11.5px; line-height: 1.75; color: var(--px-muted); }
.px-cred-intro code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
}
.px-cred-note { margin: 0 0 10px; font-size: 11.5px; line-height: 1.7; }
.px-cred-vendors { display: grid; gap: 10px; }
.px-cred-vendor {
  padding: 8px 11px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: transparent;
}
.px-cred-vendor-name {
  display: block; margin-bottom: 5px;
  font-size: 12px; font-weight: 620; color: var(--px-ink);
}
.px-cred-list { margin: 0; padding: 0; list-style: none; }
/* 一行一条引用名。用 grid 让「勾选框 + 名字」对齐，说明文字跟在后面，
   窄屏时允许换行而不是把名字截断。 */
.px-cred-row {
  display: grid;
  grid-template-columns: auto auto auto auto 1fr;
  align-items: baseline;
  gap: 4px 8px;
  padding: 3px 0;
  font-size: 11.5px;
}
.px-cred-row.locked { opacity: 0.75; }
.px-cred-pick { display: inline-flex; align-items: baseline; gap: 6px; }
.px-cred-pick input { margin: 0; cursor: pointer; }
.px-cred-pick input:disabled { cursor: not-allowed; }
.px-cred-name {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink);
  word-break: break-all;
}
.px-cred-hint { font-family: var(--px-num-font); font-size: 11px; color: var(--px-muted); }
.px-cred-source { font-size: 11px; color: var(--px-muted); }
.px-cred-purpose { font-size: 11px; color: var(--px-muted); }
/* 「这一条插件改不了」的原因与出路：必须与可勾选的行**看得出区别**，
   否则用户会反复去点那个禁用的勾选框。 */
.px-cred-blocked {
  grid-column: 1 / -1;
  font-size: 11px; line-height: 1.7;
  color: var(--px-tone-yellow);
}
.px-cred-cli {
  margin: 7px 0 0; padding-top: 6px;
  border-top: 1px dashed var(--px-line-2);
  font-size: 11px; line-height: 1.7; color: var(--px-muted);
}
.px-cred-cli code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink-2);
  word-break: break-all;
}
.px-cred-results {
  margin-top: 10px; padding: 8px 11px;
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
  font-size: 11.5px;
}
.px-cred-results > b { display: block; margin-bottom: 5px; color: var(--px-ink); }
.px-cred-results ul { margin: 0; padding-left: 16px; list-style: none; }
.px-cred-results li { margin-bottom: 3px; line-height: 1.7; }
.px-cred-results li.ok code { color: var(--px-tone-green); }
.px-cred-results li.bad code { color: var(--px-tone-red); }
.px-cred-results code {
  font-family: var(--px-num-font);
  font-size: 11px; margin-right: 6px;
}
.px-cred-results li.bad span { color: var(--px-tone-red); }
/* 二次确认：与上面的清单**视觉上分开**（边框 + 底色），让「现在按下去就会删」
   这件事一眼可辨，而不是和普通说明混在一起。 */
.px-cred-confirm {
  margin-top: 10px; padding: 9px 11px;
  border: 1px solid var(--px-tone-red);
  border-radius: var(--px-r-sm);
  background: var(--px-surface);
}
.px-cred-confirm > p { margin: 0 0 6px; font-size: 11.5px; line-height: 1.7; color: var(--px-ink); }
.px-cred-confirm ul { margin: 0; padding-left: 16px; list-style: none; }
.px-cred-confirm li { margin-bottom: 3px; font-size: 11.5px; }
.px-cred-confirm code {
  font-family: var(--px-num-font);
  font-size: 11px; color: var(--px-ink);
}
.px-cred-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 9px; }

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
.px-plan-chip:hover { background: color-mix(in srgb, var(--px-ink) 7%, transparent); }
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
  background: transparent;
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

/* 余额 / 套餐额度阈值那一组样式已删除（v3：预警能力整体取消，余额改在
   会话标签页与费用条里直接看）。不要加回来——那套 UI 背后是一条每分钟轮询、
   边沿触发、还要用户维护阈值的通知链，正是被取消的东西。 */

.px-notify-inputs { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
.px-notify-input {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: var(--px-ink-2);
}
/* 阈值输入框。圆角与过渡原本由 SKIN 的全局 button/input 规则统一给，皮肤删掉后
   必须在这里自己写——否则这几个框会变成直角，跟旁边同样走 --px-r-sm 的
   .px-input 摆在一起明显不一致。选择器仍以 .px-* 开头，不外溢到产品界面。 */
.px-notify-input input {
  width: 84px;
  padding: 5px 8px;
  font-family: var(--px-num-font);
  font-size: 12.5px;
  color: var(--px-ink);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-sm);
  transition:
    border-color var(--px-dur) var(--px-ease),
    box-shadow var(--px-dur) var(--px-ease);
}
.px-notify-input input:focus-visible {
  outline: none; border-color: var(--px-pink-deep); box-shadow: var(--px-ring);
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
/* 子智能体进展：**有意的弱一档**。它不用任何语义色（绿=完成、黄=待办、红=失败），
   只用描边色，于是它与「主会话完成」在页面上不会混成同一类事。 */
.px-toast-progress { border-left: 3px solid var(--px-line-2); }
/* 可点的提示条（带着会话 id 的那些）：点一下切到那条会话。
   容器是 pointer-events: none（让提示条不挡住它下面的产品界面），所以这里必须
   把它**单独**开回来，否则整条提示条都收不到点击——点了没反应，而没有任何报错。 */
.px-toast-clickable {
  pointer-events: auto;
  cursor: pointer;
  transition: background-color var(--px-dur-fast) var(--px-ease);
}
.px-toast-clickable:hover { background: color-mix(in srgb, var(--px-ink) 7%, transparent); }
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
  /* 阈值那一组已随预警能力删除，窄屏不再需要为它写媒体查询。 */
  .px-model-grid { grid-template-columns: 1fr; justify-items: center; }
  .px-root { padding: 14px 14px 40px; }
  .px-topbar { margin: -14px -14px 16px; padding: 12px 14px; top: -14px; }
}

/* 降级动效：**只作用在插件自己的元素上**。
   早先这条选择器写的是全局通配符（随 SKIN 一起删了）——那会连产品自己的动画一起
   关掉，而用户可能正依赖产品的某个过渡来理解状态变化。这里一律走 .px-*，
   于是系统开了「减少动态效果」时只有本插件的动效被压到 1ms。 */
@media (prefers-reduced-motion: reduce) {
  .px-root *, .px-toast, .px-pill, .px-detail, .px-period-inline {
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
  }
}

/* ── 展开/收起过渡 ───────────────────────────────────────────────────
   详情行只在展开时渲染（条件渲染），所以这里做的是**入场动画**：
   淡入 + 轻微上移。比高度动画更稳——详情内容由异步数据驱动，
   测量高度往往拿到 0，硬做 height 过渡会跳。
   220ms + 项目既有 --px-ease，与其它交互的手感一致。 */
.px-session-detail-row > td { padding: 0; border: 0; }
.px-session-detail {
  animation: px-detail-in 220ms var(--px-ease) both;
}
@keyframes px-detail-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: none; }
}



/* ── 耗时构成：横向堆叠条 + 图例 ─────────────────────────────────────
   上一版是环形图，用户明确说不喜欢——环形要顺着弧长目测比例，读数成本高。
   换成一条横向堆叠条：谁占得多一眼可见，且与「请求分布」那条同一种语言。
   布局是三段式：左端总时长锚点 / 中间堆叠条 / 下方图例。 */
.px-timing {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 20px;
  align-items: center;
  padding: 14px 16px;
  margin-bottom: 14px;
  background: var(--px-surface);
  border: 1px solid var(--px-line);
  border-radius: var(--px-r-lg);
}
@media (max-width: 560px) {
  /* 窄屏：总时长与条上下排，否则条会被压得没法读比例。 */
  .px-timing { grid-template-columns: 1fr; }
}
.px-timing-total {
  display: flex; flex-direction: column; gap: 1px;
  min-width: 108px;
}
.px-timing-total b {
  font-family: var(--px-num-font);
  font-size: 22px; line-height: 1.15; letter-spacing: .3px;
  font-variant-numeric: tabular-nums;
  color: var(--px-ink);
}
.px-timing-total span { font-size: 10.5px; color: var(--px-muted); }
.px-timing-avg { font-variant-numeric: tabular-nums; }
.px-timing-main { min-width: 0; }
.px-timing-bar {
  display: flex;
  height: 12px;
  border-radius: var(--px-r-pill);
  overflow: hidden;
  background: var(--px-surface-2);
  border: 1px solid var(--px-line);
}
.px-timing-seg { display: block; height: 100%; }
.px-timing-seg-yellow { background: var(--px-yellow); }
.px-timing-seg-blue { background: var(--px-tone-blue); }
.px-timing-seg-green { background: var(--px-tone-green); }
.px-timing-legend {
  display: flex; flex-wrap: wrap; gap: 6px 18px;
  margin-top: 8px;
}
.px-timing-item {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px;
}
.px-timing-item-name { color: var(--px-ink-2); }
.px-timing-item-pct {
  font-family: var(--px-num-font);
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  color: var(--px-ink);
}
.px-timing-item-ms {
  font-family: var(--px-num-font);
  font-variant-numeric: tabular-nums;
  color: var(--px-muted);
}
/* 三段各自的色点：与堆叠条同色，于是「哪一段对应哪一行」不用配对读。 */
.px-tdot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.px-tdot-yellow { background: var(--px-yellow); }
.px-tdot-blue { background: var(--px-tone-blue); }
.px-tdot-green { background: var(--px-tone-green); }
.px-timing-note {
  margin: 7px 0 0;
  font-size: 10.5px; line-height: 1.5;
  color: var(--px-muted);
}
/* 空态：没有 step 计时时给一句解释，而不是留一块空白。 */
.px-timing-empty {
  display: block;
  padding: 12px 16px;
}
.px-timing-empty-title {
  display: block; margin-bottom: 3px;
  font-size: 11px; font-weight: 650; color: var(--px-muted);
}

/* ════════════════════════════════════════════════════════════════════
   设置弹层（通知 / 单价 / 显示）
   ════════════════════════════════════════════════════════════════════
   遮罩与面板都挂在 body 上（不是 .px-root 里），因此这里的样式一律以
   .px-modal 开头，不与看板其它块共享选择器。

   浅色下的规则与别处一致：**白色是唯一的块**——面板铺 --px-surface，
   页签条与关闭按钮都是透明底 + 描边，不用米色填任何一块。 */
.px-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 2147482000;
  display: grid;
  place-items: center;
  padding: 24px;
  /* 遮罩只能用黑色半透明：它要压暗**产品自己的界面**，而 --px-ink 在深色下是浅色，
     拿它调透明度会得到一个「白色的遮罩」，整个界面反而更亮。 */
  background: rgba(12, 10, 18, 0.38);
  animation: px-fade var(--px-dur) var(--px-ease) both;
}
/* 深色下页面本身就暗，遮罩要压得更实才看得出「弹层浮在上面」。
   这里读的是产品打在 body 上的属性（只看不写），不是改产品配色。 */
body[data-ds-dark-theme] .px-modal-mask { background: rgba(0, 0, 0, 0.58); }
.px-modal {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: min(78vh, 760px);
  background: var(--px-surface);
  border: 1px solid var(--px-line-2);
  border-radius: var(--px-r-lg);
  box-shadow: var(--px-elev-3);
  animation: px-rise var(--px-dur-slow) var(--px-ease-out) both;
  outline: none;
}
.px-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--px-line);
}
.px-modal-title { font-size: 14px; font-weight: 650; color: var(--px-ink); }
.px-modal-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--px-line);
}
.px-modal-tab {
  padding: 7px 13px;
  font-size: 12.5px;
  color: var(--px-muted);
  background: transparent;
  /* 只留描边不留底色：选中与未选中的差别是「描边 + 文字色」，不是色块。 */
  border: 1px solid transparent;
  border-bottom: 2px solid transparent;
  border-radius: var(--px-r-sm) var(--px-r-sm) 0 0;
  cursor: pointer;
  transition: color var(--px-dur-fast) var(--px-ease), border-color var(--px-dur-fast) var(--px-ease);
}
.px-modal-tab:hover { color: var(--px-ink); }
.px-modal-tab-on {
  color: var(--px-ink);
  font-weight: 620;
  border-bottom-color: var(--px-detail-accent);
}
.px-modal-tab:focus-visible { outline: none; box-shadow: var(--px-ring); }
.px-modal-body {
  padding: 14px 16px 18px;
  overflow-y: auto;
}

/* 显示偏好的每一行：标签 + 控件一行，说明另起一行铺满 */
.px-prefs { display: grid; gap: 16px; }
.px-pref {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 12px;
}
.px-pref-label { font-size: 12.5px; font-weight: 560; color: var(--px-ink); }
.px-pref-control { display: inline-flex; align-items: center; gap: 7px; }
.px-pref-input { width: 104px; }
.px-pref-select { min-width: 120px; }
.px-pref-hint {
  grid-column: 1 / -1;
  font-size: 11px;
  line-height: 1.55;
  color: var(--px-muted);
}

/* ════════════════════════════════════════════════════════════════════
   模型分布 ＋ 费用明细：卡片组与共用工具条
   ════════════════════════════════════════════════════════════════════ */
.px-model-group { margin-bottom: 12px; }
.px-model-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 10px;
  font-size: 11.5px;
  color: var(--px-muted);
}
.px-model-bar-hint { color: var(--px-label-tertiary); }
/* 合计与窗口的关系：一行小字，安静地贴在表下 */
.px-model-sum {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--px-muted);
  font-variant-numeric: tabular-nums;
}
/* 顶栏的「设置」：与刷新同一档按钮，只是不需要额外配色 */
.px-settings-btn { margin-left: 2px; }

/* ════════════════════════════════════════════════════════════════════
   消费 Top 会话：精简表（会话名 / 花费 / token / 最后活跃）
   ════════════════════════════════════════════════════════════════════ */
.px-top-session-table { table-layout: auto; }
.px-top-session-row { cursor: pointer; }
/* 展开态：整行提亮一档（层次层而不是彩色），并给左侧一道 2px 强调边——
   这是「当前展开的是哪一条」的唯一信号；不用彩色块（那会与表头抢层级）。 */
.px-top-session-row.open { background: var(--px-layer-2); }
.px-top-session-row.open > td:first-child { box-shadow: inset 2px 0 0 var(--px-pink-deep); }
.px-top-session-detail-row > td {
  padding: 10px 14px 12px;
  background: var(--px-layer-2);
  border-bottom: 1px solid var(--px-line-2);
  white-space: normal;
}
.px-top-detail { display: grid; gap: 8px; }
.px-top-detail-sum { display: flex; flex-wrap: wrap; gap: 16px; font-size: 11.5px; color: var(--px-muted); }
.px-top-detail-sum b { color: var(--px-ink); font-weight: 620; font-variant-numeric: tabular-nums; }
.px-top-detail-models { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.px-top-detail-models > li {
  display: grid; grid-template-columns: minmax(0, 1fr) 84px 88px auto;
  gap: 10px; align-items: baseline;
  font-size: 11.5px; font-variant-numeric: tabular-nums;
}
.px-top-detail-model { color: var(--px-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.px-top-detail-cost { color: var(--px-ink); font-weight: 620; text-align: right; }
.px-top-detail-state { margin: 0; font-size: 11px; color: var(--px-muted); }
/* 团队区：与上面的「峰谷」用虚线分隔而不是再加一层卡片——它属于同一条明细。 */
.px-top-detail-team { display: grid; gap: 4px; padding-top: 7px; border-top: 1px dashed var(--px-line); }
.px-top-detail-team-title { font-size: 11.5px; color: var(--px-muted); }
.px-top-detail-team-title b { color: var(--px-ink); font-weight: 620; font-variant-numeric: tabular-nums; }
.px-top-detail-members { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.px-top-detail-members > li {
  display: grid; grid-template-columns: minmax(0, 1fr) 84px 88px;
  gap: 10px; align-items: baseline; font-size: 11.5px; font-variant-numeric: tabular-nums;
}
/* 逐日：一行小 chips，日期在前、金额在后；不换行到底也允许折行。 */
.px-top-detail-days {
  display: flex; flex-wrap: wrap; gap: 4px 14px;
  padding-top: 7px; border-top: 1px dashed var(--px-line);
  font-size: 11.5px;
}
.px-top-detail-day { display: inline-flex; align-items: baseline; gap: 5px; color: var(--px-muted); }
.px-top-detail-day i { font-style: normal; font-size: 10.5px; }
.px-top-detail-day b { color: var(--px-ink-2); font-weight: 600; font-variant-numeric: tabular-nums; }
/* 会话名 + 展开三角：两者同排，三角旋转说明当前状态 */
.px-session-open { display: inline-flex; align-items: center; gap: 6px; }
.px-session-open:focus-visible { outline: none; box-shadow: var(--px-ring); border-radius: var(--px-r-sm); }
/* 会话名本身是按钮：整行可点只是鼠标方便，键盘可达要靠它 */
.px-session-open {
  padding: 0;
  font: inherit;
  font-weight: 620;
  color: var(--px-ink);
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.px-session-open:hover { text-decoration: underline; text-underline-offset: 2px; }
.px-session-open:focus-visible {
  outline: none;
  border-radius: var(--px-r-sm);
  box-shadow: var(--px-ring);
}

/* ════════════════════════════════════════════════════════════════════
   柱状图（逐日消费 / token 构成）
   ════════════════════════════════════════════════════════════════════
   柱子的填充走 px-tone-fill-*（SVG 的 fill），与环图、折线同一套色；
   悬停时只压暗整列背景，**不改柱高**——改高度会让读数与静止时不一致。 */
.px-bar { shape-rendering: crispEdges; }
.px-hover-band { fill: color-mix(in srgb, var(--px-ink) 7%, transparent); }
.px-tip-total {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--px-line-2);
  color: var(--px-ink);
}

/* 「我的价」那一列与单价行里的第二行：用描边徽标区分，不用实色底 */
.px-my-rate { color: var(--px-ink); }
.px-my-rate-badge { border-color: var(--px-detail-accent-line); color: var(--px-detail-accent); }
.px-rate-mine {
  grid-column: 3 / -1;
  grid-row: 2;
  padding-top: 2px;
}
.px-rate-mine code { color: var(--px-detail-accent); }
`

/**
 * 样式表清单：装配与卸载共用同一份来源。
 *
 * **只有两张。** 早先还有第三张 `['skin', SKIN]`（全局皮肤），已随皮肤功能移除。
 * 两张就够了，因为配色分工是清楚的：
 *   - `tokens`：--px-* 变量（:root 浅色 + body[data-ds-dark-theme] 深色），只管变量；
 *   - `dashboard`：全部 .px-* 选择器，看板整页 + 费用条 + 提示条的实样式。
 * 两者都不写全局元素选择器，因此不会外溢到产品界面。渲染闸门断言这里恰好两张。
 */
const STYLES = [
  ['tokens', TOKENS],
  ['dashboard', DASHBOARD],
  ['pricing', PRICING_CSS],
  ['accounts', ACCOUNTS_CSS],
  ['session', SESSION_CSS],
]

			exports.STYLES = STYLES
		},
		"./Notifier.js": (exports, require) => {
			const m1 = require("./notify.js")
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
 *   - **余额 / 套餐额度：不再有任何轮询。** 那两项预警已按用户要求整体取消
 *     （它们应当「想看的时候看一眼」，不该打断人）；余额与额度现在改在会话标签页
 *     与输入框费用条里直接读，见 `client/sessionView.js` 与 `client/SessionCost.js`。
 *
 * ## 降级不静默
 *
 * 系统通知发不出去（没授权、非安全上下文）时，回落成**页面内提示条**，
 * 而不是丢掉这条提醒。用户关掉了浏览器通知却什么也收不到，会以为功能坏了。
 * @module dsh-pixel-dashboard/client/Notifier
 */

const PresenceTracker = m1.PresenceTracker
const SeenTracker = m1.SeenTracker
const composeInteraction = m1.composeInteraction
const composeNotice = m1.composeNotice
const conversationOnScreen = m1.conversationOnScreen
const fetchNotices = m1.fetchNotices
const permissionOf = m1.permissionOf
const shouldStayQuiet = m1.shouldStayQuiet
const playSound = m1.playSound
const requestFocus = m1.requestFocus
const soundPlan = m1.soundPlan
/** 宿主日志轮询间隔。日志在宿主内存里，读一次很便宜。 */
const NOTICE_POLL_MS = 4_000

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
   * 记一次「点了通知之后跳转成不成功」。
   *
   * 单独一个字段而不是往 record 里塞：跳转发生在通知**已经展示之后**，
   * 它需要更新的是那条已有记录，而不是新增一条。
   * @param {{at:number,sessionId:string,ok:boolean,error?:string}} outcome - 结果。
   */
  noteClick(outcome) {
    this.lastClick = outcome
    const index = this.recent.findIndex((item) => item?.sessionId === outcome.sessionId)
    if (index < 0) return
    const target = this.recent[index]
    const next = {
      ...target,
      clickFailed: outcome.ok ? undefined : String(outcome.error ?? '未知原因'),
      clickOk: outcome.ok === true,
    }
    const recent = [...this.recent]
    recent[index] = next
    this.patch({ recent })
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
  constructor({ store, uiSession, sessions, layout, workspace, scope = globalThis }) {
    this.store = store
    this.uiSession = uiSession
    this.sessions = sessions
    this.layout = layout
    this.workspace = workspace
    /** AudioContext 复用一个，避免每次发声都新建（浏览器对实例数有限制）。 */
    this.soundCache = {}
    this.scope = scope
    this.seen = new SeenTracker()
    /**
     * 在场跟踪：判断「当前会话完成时该不该静默」。
     *
     * 它是运行时唯一持有环境读数的东西——配置与权限住在 store（唯一状态家），
     * 而焦点 / 可见性 / 最近输入是**环境**而不是配置，也不该进 store 让面板每
     * 4 秒重渲染一次。见 {@link PresenceTracker}。
     */
    this.presence = new PresenceTracker(scope)
    this.timers = []
    this.unsubscribe = undefined
    this.disposed = false
    /** 上一次据以判定「配置变了」的引用。 */
    this.lastConfig = undefined
    /**
     * 订阅 store 的配置变化。
     *
     * 为什么需要：配置可能**后到**（首轮 `readPending()` 跑在宿主第一次答话之前，
     * 那时 `#enabled` 一律为 false，于是一个页面加载时就已存在的授权请求会一直
     * 不被提醒）。配置一到手就补发一次。
     *
     * 余额 / 额度预警取消后，这里**不再重置任何锁存器**：没有锁存器了。
     * 回调里只比较引用并补发待办，不再写 config，因此不会递归。
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
        tag: 'dsh-px-test',
        level: 'ok',
      }, 'test')
    }
    // 权限的初值从浏览器读一次写进 store：面板首帧就该显示真实状态。
    this.store.setPermission(permissionOf(scope))
    this.#syncFromStore()
  }

  /**
   * 认出配置变化并补发一次待办。
   *
   * 余额 / 额度预警取消后，这里**没有锁存器要重置**：那条「配置变了要重新武装」
   * 的路径随预警一起删掉了。剩下唯一要做的事是补发待办——配置可能晚于首轮
   * `readPending()` 到达（见 `#notifyPending` 的说明）。
   */
  #syncFromStore() {
    if (this.disposed) return
    const config = this.store.config
    if (config === this.lastConfig) return
    this.lastConfig = config
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
    this.presence.start()
    this.#ensurePendingSubscription()
    this.readPending()
    this.pollNotices()
    // 只剩一条轮询：宿主通知日志。余额 / 额度那条 30 秒的轮询随预警一起删掉了。
    this.timers.push(setInterval(() => {
      this.#ensurePendingSubscription()
      this.pollNotices()
    }, NOTICE_POLL_MS))
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
    this.presence.stop()
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
          tag: 'dsh-px-drop',
          level: 'warn',
        }, 'system')
      }
      for (const notice of fresh) {
        // 「子智能体跑完一轮」与「主会话跑完」走**不同的开关**：
        // 团队里成员收工是进展同步，很多人只想要结论（主会话跑完）那一条。
        // 失败一律走 notifyError —— 失败不该因为「它只是个成员」而被降级。
        const progress = notice.subagent === true && notice.category === 'done'
        const gate = notice.category === 'done'
          ? (progress ? 'notifySubagent' : 'notifyDone')
          : 'notifyError'
        if (!this.#enabled(gate)) continue
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

  /** 某个开关是否打开（总开关优先）。 */
  #enabled(key) {
    const config = this.config
    if (config === undefined) return false
    if (config.notifyEnabled === false) return false
    return config[key] !== false
  }

  /**
   * 当前主视图显示的会话 id。
   *
   * **不能用 `sessions.list.getSnapshot().current`**：0.2.1 的客户端列表快照只有
   * `ids / byId / phase / projectionsBySession`，`current` 恒为 `undefined`。
   * 早先的判据读的就是它，于是 `shouldStayQuiet` 里「当前会话」这一条永远不成立
   * ——「当前会话不打扰」实际处于永不生效的状态（用户关掉它也看不出差别，
   * 原因就在这里）。
   *
   * 真正的事实来源有两个，按可靠性依次取：
   *   1) `sessions.list.byId[id].retainedBy.mainView > 0` —— 主视图的 retain 计数，
   *      这正是 DSH 自己 `isMain()` 的判据；
   *   2) `uiSession.mainRetainId` —— 派生值，作为兜底。
   * @returns {string|undefined} 会话 id；判不出来时 undefined（调用方按「不静默」处理）。
   */
  currentSessionId() {
    try {
      const byId = this.sessions?.()?.list?.getSnapshot?.()?.byId
      if (byId !== undefined && byId !== null) {
        for (const [id, row] of Object.entries(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return id
        }
      }
    } catch {
      // 读不出来就往下走兜底，绝不在这里抛。
    }
    try {
      const retained = this.uiSession?.()?.mainRetainId
      if (typeof retained === 'string' && retained !== '') return retained
    } catch {
      // 同上。
    }
    return undefined
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
   *
   * **焦点不再直接读 `document.hasFocus()`**：Electron 里窗口若在未聚焦状态下
   * 加载，那个读数会永远为 true（electron/electron#7125），于是主会话的每次完成
   * 都被静默——用户报的正是「只有子智能体完成才提醒」。现在焦点、可见性、最近
   * 输入三项都由 {@link PresenceTracker} 汇总，判不出来就不静默。
   * @param {object} notice - 宿主通知记录。
   * @returns {boolean} 是否跳过。
   */
  #quiet(notice) {
    return shouldStayQuiet(notice, {
      config: this.config,
      current: this.currentSessionId(),
      onScreen: conversationOnScreen(this.scope?.document),
      ...this.presence.read(),
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
    // 切换会话的正主是 `uiWorkspace.openSession(target)`。它内部做三件事：
    // `sessions.retain(target, { source: 'mainView' })`（让主视图持有这条会话，
    // 也是 `retainedBy.mainView` 的计数来源）、写 selection、再
    // `layout.selectPanel(null)` 退出主区面板。
    //
    // 早先这里调的是 `sessions.open(id)`——那个方法在 0.2.1 的客户端控制器上
    // **根本不存在**（实测 `open=undefined`，方法表里只有 retain/using/fork/...），
    // 于是异常被 catch 吞掉，表现就是「点通知只把窗口带到前台、会话没切」。
    try {
      const workspace = this.workspace?.()
      if (workspace !== undefined && typeof workspace.openSession === 'function') {
        workspace.openSession(id)
        return true
      }
    } catch (error) {
      // 会话可能已被删除、或属于另一台机器：不让它打断运行时。
      this.lastOpenError = String(error?.message ?? error)
      return false
    }
    // 兜底：服务缺失时至少退出主区面板，免得看起来「完全没反应」。
    try {
      const layout = this.layout?.()
      if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
    } catch {
      // 面板服务缺失：不阻断。
    }
    this.lastOpenError = 'uiWorkspace 服务不可用（宿主版本过旧？）'
    return false
  }

  /**
   * 播放提示音（只在用户选择了「自己发声」的音效时才调用）。
   *
   * ## 为什么内置音效用 WebAudio 合成而不是放音频文件
   *
   * 插件产物要能随包发布，塞 wav/mp3 会让包体和构建都变复杂；而三个提示音无非是
   * 几声正弦音，现场合成几行就够，且**不需要网络、不需要用户额外授权**。
   *
   * ## 为什么全程 try/catch 且失败不抛
   *
   * `AudioContext` 在部分环境里需要用户手势才能 resume、也可能被策略禁用。
   * 声音是附加体验：放不出来**绝不能**影响通知本身（通知已经弹出来了）。
   * @param {{play:'chime'|'soft'|'deep'|'custom'|undefined, url:string}} plan - 发声口径。
   */
  #playSound(plan) {
    // 与面板的「试听」共用同一个函数，避免两处发出的声音不一致。
    playSound(plan, this.scope, this.soundCache)
  }

  /**
   * 派发一条通知：系统通知优先，不可用时回落页面内提示条。
   *
   * ## 先尝试、后记账（踩过的坑）
   *
   * 这里的顺序是「先弹、再把结果记进最近通知」，而不是先记账再弹。早先是反的，
   * 后果是一次真实的排障灾难：用户在桌面端看到「最近通知」里明明有记录、系统却
   * 一条气泡都没有，而 `catch` 把构造失败**静默吞掉**，于是既没有气泡、也没有
   * 任何线索——只能靠对着 `LastNotificationAddedTime` 这类外部读数一步步反推。
   *
   * 归因就错在 catch 的注释上：它假定「构造失败一定是环境问题（未授权 / 非安全
   * 上下文）」，可实测存在**同一个进程里控制台 `new Notification()` 能弹、插件里
   * 同样的调用却弹不出**的情况——失败可能与这一条通知的内容有关，而不是环境。
   * 既然这种失败是**可归因到单条通知**的事实，就必须让它可见。
   * @param {object} spec - 文案（可带 sessionId）。
   * @param {string} category - 类别（面板展示与统计用）。
   */
  #fire(spec, category) {
    const failure = this.#deliver(spec)
    this.#push(spec, category, failure)
  }

  /**
   * 尝试弹系统通知。
   *
   * 返回值刻意区分三种「没弹」：**undefined = 正常**（含「没授权，按设计回落提示条」）、
   * 字符串 = 本可以弹却失败了，原因要写进最近通知给用户看。
   * @param {object} spec - 文案。
   * @returns {string|undefined} 失败原因；正常返回 undefined。
   */
  #deliver(spec) {
    if (this.permission !== 'granted') return undefined
    const Notification = this.scope?.Notification
    if (typeof Notification !== 'function') return '环境里没有 Notification，无法弹系统通知'
    try {
      // 提示音口径：自己发声时把系统通知设成 silent，否则会「系统一声 + 插件一声」。
      const plan = soundPlan(this.config)
      // tag 让**同一轮**会话的新通知替换旧的那条，而不是在通知中心堆成一列
      // （同一条会话跑了很多轮时尤其明显）。
      // `silent` **只在需要静音时才传**：默认的「跟随系统」什么都不传，
      // 保证和改动之前完全一样的构造参数，避免再引入未知回退。
      const options = { body: spec.body, tag: spec.tag }
      if (plan.silent) options.silent = true
      const notification = new Notification(spec.title, options)
      // 自己发声放在构造之后：通知构造失败时不该还有一声孤零零的响。
      if (plan.play !== undefined) this.#playSound(plan)
      // 点通知切到那条会话。只在**确实带着会话 id** 时挂这个回调：
      // 测试通知那类不属于任何会话的提醒，点它切会话是无意义的动作。
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : ''
      if (sessionId !== '') {
        notification.onclick = () => {
          // ## 顺序是这里最要紧的东西（踩过回退）
          //
          // 曾经能生效的版本里，切会话那一步是**立刻抛错**的（调了不存在的
          // sessions.open），所以 `focus()` 早就执行完了。改成真正能切之后，
          // `uiWorkspace.openSession` 会同步触发主区重挂载（退出看板 + 重建整个
          // 会话视图），把渲染进程占住几百毫秒——而用户看到的是「点了，窗口还是
          // 没到前台」。
          //
          // 所以顺序固定为：**先请求聚焦 → 再收通知 → 最后才做切会话这件重活**，
          // 并追加一次延迟重试（有的引擎会丢掉「页面正忙时」的第一次聚焦请求）。
          try {
            this.scope?.focus?.()
          } catch {
            // 聚焦失败不影响后面的切会话。
          }
          // 渲染进程自己提不动窗口（实测 window.focus() 无效），所以请宿主代劳：
          // 宿主用系统命令唤起 `dsh://open`，由 Electron 主进程的
          // focusPrimaryWindow() 做 restore→show→focus。失败也不影响切会话。
          void requestFocus()
          try {
            this.scope?.setTimeout?.(() => {
              try {
                this.scope?.focus?.()
              } catch {
                // 重试失败就到此为止：这是尽力而为的一步。
              }
            }, 80)
          } catch {
            // 没有 setTimeout 的环境（测试闸门）：跳过重试。
          }
          try {
            // 把系统通知收掉：否则通知中心里会留着一条已经处理过的提醒。
            notification.close?.()
          } catch {
            // 关不掉也不影响切会话。
          }
          // 切会话放最后：这一步会重建主区，可能占住渲染进程。
          // 结果**必须可见**——用户报过「点了没反应」，而当时异常被吞掉，
          // 只能靠反查宿主 API 才查出来（sessions.open 根本不存在）。
          try {
            const ok = this.openSession(sessionId)
            this.store.noteClick({ at: Date.now(), sessionId, ok, error: this.lastOpenError })
          } catch (error) {
            this.store.noteClick({ at: Date.now(), sessionId, ok: false, error: String(error?.message ?? error) })
          }
          return true
        }
      }
      return undefined
    } catch (error) {
      // **绝不静默**：把原因带出去写进最近通知。用户看到的「有记录却没气泡」
      // 与「构造时抛错」之间必须有可见的因果，而不是靠注册表反推。
      const detail = error instanceof Error ? error.message : String(error)
      const name = error instanceof Error && error.name !== '' ? `${error.name}: ` : ''
      return `系统通知没有弹出来（${name}${detail}）`
    }
  }

  /**
   * 记一条派发记录，并刷新页面内提示。
   * @param {object} spec - 文案。
   * @param {string} category - 类别。
   * @param {string} [failure] - 系统通知未能弹出的原因；有值时记进这一条记录。
   */
  #push(spec, category, failure) {
    const entry = { at: Date.now(), category, ...spec }
    // 失败原因跟着这一条走：面板据此在行尾标出来，用户不必再猜。
    if (typeof failure === 'string' && failure !== '') entry.failed = failure
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
      // 切换会话的正主：uiWorkspace.openSession(target)。
      // 不能用 sessions.open —— 0.2.1 的 sessions 服务没有这个方法。
      workspace: () => ctx.get('uiWorkspace'),
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
			const m3 = require("./costDetail.js")
			const m4 = require("./format.js")
			const m5 = require("./plans.js")
			const m6 = require("./planView.js")
			const m7 = require("./team.js")
			const m8 = require("./usage.js")
			/**
 * 输入框下方的本次会话费用条（含账户余额与套餐额度）。
 *
 * ## 布局：始终落在**官方统计的右边**，且**不另起一整行**
 *
 * `conversation.composer.dock` 是**横向 flex 行**（`InputBar.module.css` 的 `.dock`：
 * `display:flex` + `justify-content:center` + `gap:12px`，自古如此、各版本一致）。
 * 因此槽位里的 `order` 决定**左右**，而不是「离输入框多远」。
 *
 * 官方统计在同一槽位里有**两代契约**，本插件的目标是两代都排在官方数据右边：
 *
 *   1) **旧契约（DSH ≤ 0.2.0-rc.2）**：`StatsPills` 是**一条**登记（`order: 0`），
 *      根元素带 `data-composer-stats`。我们把徽标 **portal 进那个容器**——追加为
 *      最后一个子节点，于是自然排在官方内容之后。桌面端一直是这个观感。
 *   2) **新契约（DSH ≥ 0.2.1-alpha.1）**：官方拆成 `activity`(0) / `usage`(1) 两条
 *      登记，`data-composer-stats` **被移除**，改由每枚胶囊带 `data-composer-stat`。
 *      此时没有可 portal 的容器，我们以**同一槽位的普通一项**渲染、`order` 取一个
 *      明显大于官方胶囊的值（见 {@link COST_ENTRY_ORDER}），照样落在官方右边。
 *
 * 两个必须记住的坑：
 *   - **不要给自己 `width: 100%`。** 这一行是横向 flex，占满整行会与官方胶囊抢宽度，
 *     把「1 轮 · 38 步」「2.1M tok」挤成省略号（用户截图反馈过）。只做 inline-flex，
 *     让每个胶囊各按内容取宽。旧代码里的 `.px-cost-row` 正是这个错误的来源——它基于
 *     「容器是纵向 flex 且没有 gap」这个**错误前提**（那是 `.root`，不是 `.dock`）。
 *   - **官方统计会整体消失。** 没有 token 活动时两代契约都不渲染，此时我们单独居中
 *     一项即可，不需要为它准备另一套外壳。
 *
 * 数据来源分三条路，各司其职、互不拖垮：
 *   - 会话投影 `tokenUsage` 给出即时可见的 token 总数（本地、零延迟）；
 *   - 宿主数据里该会话的 `cost` 给出**精确**金额（按每条请求发生时段分档计价）；
 *   - 余额与套餐各有自己的开关与缓存。
 *
 * ## 详情从 `title` 改成**可点击展开的面板**
 *
 * 用户报过：「对话框下方的计价详情……现在直接是一个裸文本浮窗，不好看」。
 * 那几个字的系统浮窗有四个问题：字号与配色听操作系统的、换行靠浏览器自己决定、
 * 鼠标一移开就消失（读不完）、而且**没法点击**——触屏与键盘用户根本打不开。
 *
 * 现在的做法是照官方统计胶囊的既有交互（`StatsPills` 的 `useStatDialog`）：
 * 徽标变成一枚 `<button aria-expanded>`，点开后把面板 portal 到 `document.body`、
 * 用 `position: fixed` 贴在徽标**上方**并夹进视口。面板内容由 `costDetail.js`
 * 折成纯数据（见那个模块的说明），这里只负责摆。
 *
 * 四条不能省的交互细节，都是踩过或必然踩到的：
 *   - **容器仍然不许 `width:100%`**：面板是 portal 出去的固定定位元素，宽度
 *     按内容取（上限 360px），与 dock 那一行无关；dock 里那一枚仍是 inline-flex。
 *   - **点外面要关、Esc 要关、滚动要关**。滚动要关是因为面板用 fixed 定位，
 *     它不会跟着输入框动；不关就会看见一个悬在空中的面板。
 *   - **`pointerdown` 而不是 `click`**：`click` 要等鼠标抬起，用户按住拖动时
 *     面板会一直开着并选中背景文字。
 *   - **收起时面板内容不渲染**。`renderToStaticMarkup` 不执行 effect，因此闸门看到的
 *     就是「默认收起」这一态——与真实首屏一致。
 * @module dsh-pixel-dashboard/client/SessionCost
 */

const React = require('react')
const createPortal = require('react-dom').createPortal
const resolveAccount = m1.resolveAccount
const fetchBalance = m2.fetchBalance
const costDetailModel = m3.costDetailModel
const formatCny = m4.formatCny
const formatTokens = m4.formatTokens
const fetchPlans = m5.fetchPlans
const useSelectedPlan = m6.useSelectedPlan
const findTeamOf = m7.findTeamOf
const teamSummaryOf = m7.teamSummaryOf
const fetchDashboard = m8.fetchDashboard
const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

/** 费用条在下方常驻区的位置。 */
const COST_ENTRY_ID = 'pixel-cost'

/**
 * 在 `conversation.composer.dock` 里的排序值。
 *
 * 该槽位是**横向 flex 行**（左侧先渲染），所以这个值决定我们排在官方胶囊的
 * **左边还是右边**。两代官方契约的 `order` 分别是：
 *
 *   - 旧契约：`StatsPills` 一条，`order: 0`（我们 portal 进它内部，槽位里只有一个
 *     官方项，取任何值都不影响观感）；
 *   - 新契约：`activity` = 0、`usage` = 1。
 *
 * 取 `2` 使我们在两代契约里都排在官方数据**之后**（即右侧）——这正是用户偏好的
 * 桌面端布局。早先用 `-10` 是为了「贴着输入框」，而那是基于「容器是纵向排列」的
 * 错误前提：横向行里负值等于把插件胶囊排到官方数据**左边**，与官方抢宽度时还会
 * 把官方胶囊挤成省略号。
 *
 * 留出余量（不写 1 而写 2）是为了将来官方再加一枚胶囊时我们仍在其右。
 */
const COST_ENTRY_ORDER = 2

/**
 * 旧契约的锚点选择器：`StatsPills` 的根元素。
 *
 * 只有 DSH ≤ 0.2.0-rc.2 才有这个标记；0.2.1-alpha.1 起官方把统计拆成两条登记并
 * 移除了它（见模块顶部的两代契约说明）。因此它**命中与否都不会出错**：
 * 命中就 portal 进去（追加为末子节点 = 排在官方内容右边），
 * 不命中就以槽位项渲染、靠 {@link COST_ENTRY_ORDER} 排到右边。
 */
const STATS_ANCHOR_SELECTOR = '[data-composer-stats]'

/**
 * 新契约里**显示 token 用量**的那枚官方胶囊（DSH ≥ 0.2.1-alpha.1）。
 *
 * 官方把统计拆成 `activity`（轮次 / 步数 / 速度）与 `usage`（token 总量与缓存命中）
 * 两条登记，每枚胶囊的根元素带 `data-composer-stat="<id>"`（`StatsPills.tsx` 的
 * `PlainPill` / `DialogPill`，且写进了官方 README 与 e2e）。
 *
 * **只认 `usage` 那一枚**，不认「任意一枚官方胶囊」：token 数只有 `usage` 在显示。
 * 例如 compact 模式下 `ActivityPill` 可能在场而 `UsagePill` 因为算不出缓存命中率
 * 而不渲染——那时若按「有官方胶囊就算重复」去抑制，token 总量就会在界面上消失。
 * 本插件自己的胶囊不带这个属性，因此不会数到自己。
 */
const OFFICIAL_USAGE_PILL_SELECTOR = '[data-composer-stat="usage"]'

/** 面板与徽标之间纵向留出的距离（面板在徽标**上方**）。 */
const PANEL_GAP = 8

/** 面板与视口边缘之间必须留下的距离（与官方 stat-dialog 的 12px 一致）。 */
const PANEL_MARGIN = 12

/** 面板宽度上限：比官方 stat-dialog（440px）窄一些，它只有文字与条。 */
const PANEL_MAX_WIDTH = 360

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
 * 观察官方统计当前的形态（两代契约各探一次），返回可 portal 的锚点，以及
 * 「官方是否已经在显示 token 数」。
 *
 * 必须观察 DOM 而不是只查一次：官方统计与我们由不同的 fiber 挂载，先后不定；
 * 且它会在「没有 token 活动」时整体卸载，之后再回来。
 *
 * 两个返回值各自有用，且**判据不同**（这点容易写错）：
 *   - `anchor`：旧契约（≤ 0.2.0-rc.2）里那个容器。非空就 portal 进去，于是我们的
 *     徽标追加在官方内容**之后**（= 右侧），与桌面端观感一致。
 *   - `showsTokens`：官方**是否正在显示 token 总量**，用来决定要不要省掉我们那枚
 *     重复的 token。两代契约的判据不一样：旧契约的统计条本身就在显示 token；新契约
 *     则要看 `usage` 那一枚在不在（`activity` 只显示轮次/速度，不显示 token）。
 *     因此**不能**简化成「有官方胶囊就算重复」——compact 模式下可能只有 activity 在场。
 * @returns {{anchor: Element|null, showsTokens: boolean}} 官方统计的形态。
 */
function useOfficialStats() {
  const [state, setState] = useState({ anchor: null, showsTokens: false })

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined
    const read = () => {
      const anchor = document.querySelector(STATS_ANCHOR_SELECTOR)
      // 旧契约：那条统计条自己就在显示 token 数 → 命中锚点即视为重复。
      // 新契约：只有 usage 那枚显示 token（querySelector 对它返回非 null）。
      //
      // querySelector 只被调用一次是刻意的：渲染闸门的替身 document 只提供
      // querySelector（没有 querySelectorAll），所以这里必须只用它。
      const usage = anchor !== null ? anchor : document.querySelector(OFFICIAL_USAGE_PILL_SELECTOR)
      return { anchor, showsTokens: usage !== null }
    }
    setState(read())

    if (typeof MutationObserver === 'undefined' || document.body === null || document.body === undefined) {
      return undefined
    }
    const observer = new MutationObserver(() => {
      const next = read()
      // 逐字段比较，避免每次 DOM 变动都触发一次重渲染
      setState((prev) => (prev.anchor === next.anchor && prev.showsTokens === next.showsTokens ? prev : next))
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  return state
}

/**
 * 团队那一枚徽标的完整文案：标签、数值、角标与悬停说明。
 *
 * 抽成纯函数是为了让渲染闸门**直接断言字符串**：悬停内容在静态渲染里永远看不到
 * （`title` 只是属性），而「按成员分列」正是这个功能唯一的信息出口。
 * 面板起来之后 `title` 仍保留同一句话作为**降级通道**（无 JS 环境、以及悬停速览
 * 时不必点开也能看到），因此两者必须说同一件事。
 *
 * ## 两个取值刻意分开
 *
 * | 字段 | 用来回答 |
 * |---|---|
 * | `value` | 这个团队一共花了多少 |
 * | `tag` | 这个数字是「团队」而不是「本次会话」——不标的话两个 ¥ 并排没人分得清 |
 *
 * **不再产出 `title`。** 早先这里拼了一大段多行文本喂给 `title` 属性，落地成一个
 * 浏览器原生的裸浮窗（用户报的「不好看」正是它）。详情现在由 `costDetailModel()`
 * 折成结构化的面板内容，成员明细在面板的「成员」一节里——字符串版在这里就是
 * 第二份口径，删掉它而不是留着当备份：两处文本一定会漂移。
 * @param {object|undefined} summary - {@link teamSummaryOf} 的结果。
 * @returns {{value:string,tag:string,memberCount:number}|undefined} 文案。
 */
function teamPillOf(summary) {
  if (summary === undefined || summary === null) return undefined
  return {
    value: formatCny(summary.cost),
    // 角标写「团队」而不是「N 人」：这一枚的价值在于「这是团队口径」，
    // 人数在详情面板里已经写清楚了，挤在 10px 的角标里反而读不出来。
    tag: '团队',
    memberCount: summary.memberCount,
  }
}

/**
 * 悬浮面板的定位：贴在锚点**上方**、水平居中，并夹进视口。
 *
 * ## 为什么不是「算一次就定」
 *
 * 官方那套 `useAnchoredPosition` 是**量两轮**：先把面板按隐藏渲染（`visibility:
 * hidden` 但仍有布局），量出它真实的高度，第二帧才把位置定下来。这里同样这么做，
 * 因为只看锚点矩形是不够的——我们不知道面板会长多高（团队模式有 N 个成员，
 * 窄屏上标题还会折行），而「高度未知就猜一个 bottom」必然在某一类会话上错位。
 *
 * ## 三条规则
 *
 *   - **优先向上弹**：锚点在输入框下方，往下弹会盖住输入框本身；
 *   - **上面放不下就翻到下面**：窗口很矮时（笔记本横向分屏）面板比上方空间还高，
 *     硬贴上去会把标题推出视口顶部；
 *   - **夹进视口**：水平方向居中，遇到左右边缘就贴边；宽度也夹到
 *     `100vw - 2*margin`，否则窄屏上右半边会被裁掉。
 *
 * 返回值里的 `placed` 是给闸门看的：它说明「位置真的算过」，而不是停在测量态。
 * @param {object} input - open / anchorRef / panelRef。
 * @returns {{style:object|undefined, placed:boolean}} 内联样式与是否已定位。
 */
function useDetailPlacement(input) {
  const { open, anchorRef, panelRef } = input
  const [placement, setPlacement] = useState({ style: undefined, placed: false })

  // 收起时把测量结果一起丢掉：下次点开必须重新量（会话换了、金额位数变了、
  // 窗口被拖过——沿用上一轮的位置必然错）。
  useEffect(() => {
    if (open !== true) setPlacement({ style: undefined, placed: false })
  }, [open])

  // useLayoutEffect 而不是 useEffect：后者在**绘制之后**才跑，用户会看到面板
  // 先在错误位置闪一下再跳过去。这个仓库的打包器按普通函数名转译，两者都能用。
  useEffect(() => {
    if (open !== true) return undefined
    const anchor = anchorRef?.current
    const panel = panelRef?.current
    if (anchor === null || anchor === undefined) return undefined
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined

    /**
     * 量一次并排布。锚点或面板还没挂上（首帧）时安静返回，下一帧由 effect
     * 依赖里的 open 变化不会再来，因此这里同时监听一次 rAF 兜底。
     */
    const place = () => {
      const node = anchorRef?.current
      if (node === null || node === undefined) return
      if (typeof node.getBoundingClientRect !== 'function') return
      const rect = node.getBoundingClientRect()
      const panelHeight = Number(panelRef?.current?.offsetHeight ?? 0)
      const viewportWidth = Number(window.innerWidth ?? 0) || 0
      const viewportHeight = Number(window.innerHeight ?? 0) || 0

      // 视口宽为 0（jsdom / 尚未布局）时不做相对计算，给一个能断言的居中布局。
      if (viewportWidth <= 0 || viewportHeight <= 0) {
        setPlacement({
          style: { position: 'fixed', left: `${PANEL_MARGIN}px`, top: `${PANEL_MARGIN}px`, width: `min(${PANEL_MAX_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px))` },
          placed: true,
        })
        return
      }

      const width = Math.min(PANEL_MAX_WIDTH, Math.max(0, viewportWidth - PANEL_MARGIN * 2))
      const centerX = rect.width > 0 ? rect.left + rect.width / 2 : viewportWidth / 2
      const left = Math.min(
        Math.max(PANEL_MARGIN, centerX - width / 2),
        Math.max(PANEL_MARGIN, viewportWidth - PANEL_MARGIN - width),
      )

      // 上方空间够就用 bottom 贴住锚点顶部：用 bottom 而不是 top，是因为
      // 面板高度会随后续刷新（金额位数、成员增减）变化，bottom 定位能让它在
      // 高度变化时仍然**贴着**锚点，而 top 定位会让它从锚点往上长到一半卡住。
      const spaceAbove = rect.top - PANEL_GAP - PANEL_MARGIN
      const spaceBelow = viewportHeight - rect.bottom - PANEL_GAP - PANEL_MARGIN
      const fitsAbove = panelHeight <= 0 || panelHeight <= spaceAbove
      if (fitsAbove && rect.top > 0) {
        setPlacement({
          style: { position: 'fixed', left: `${Math.round(left)}px`, bottom: `${Math.round(viewportHeight - rect.top + PANEL_GAP)}px`, width: `${Math.round(width)}px` },
          placed: true,
        })
        return
      }
      // 上面放不下、下面更宽裕：翻到下面（顶边贴住锚点底部）
      if (spaceBelow > spaceAbove) {
        setPlacement({
          style: { position: 'fixed', left: `${Math.round(left)}px`, top: `${Math.round(Math.max(PANEL_MARGIN, rect.bottom + PANEL_GAP))}px`, width: `${Math.round(width)}px` },
          placed: true,
        })
        return
      }
      // 两边都放不下：仍然向上，但贴到视口顶边，保证整块内容可达（可滚动）
      setPlacement({
        style: { position: 'fixed', left: `${Math.round(left)}px`, top: `${PANEL_MARGIN}px`, width: `${Math.round(width)}px` },
        placed: true,
      })
    }

    place()
    // 面板里可能还有一次性布局（字体加载、占比条过渡），再量一次兜住。
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => { place() })
      : undefined
    // 滚动时重新量：输入框那一块是 sticky 的，滚到吸附边界之后锚点的视口坐标
    // 会变，而面板是 fixed 定位、不会自己跟过去。capture 阶段收事件是因为
    // 真正的滚动容器是会话区，它不在 body 的事件冒泡路径上。
    const onScroll = () => { place() }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      if (raf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    }
    // panelRef 是 ref，不会触发重渲染；open 变化才是重新量的时机。
  }, [open, anchorRef, panelRef])

  return placement
}

/**
 * 测量态的内联样式：**隐藏但仍参与布局**，因此 `offsetHeight` 量得到真实高度。
 *
 * 用 `visibility: hidden` 而不是 `display: none`：后者不产生盒子，量出来永远是 0，
 * 于是「上面放不下就翻到下面」这条判断永远得到 0，等于没写。
 * @returns {object} 内联样式。
 */
function measureStyle() {
  return {
    position: 'fixed',
    left: '0px',
    top: '0px',
    visibility: 'hidden',
    width: `min(${PANEL_MAX_WIDTH}px, calc(100vw - ${PANEL_MARGIN * 2}px))`,
  }
}

/**
 * 详情面板本体（**纯展示**）：抬头 + 大号金额 + 各分节 + 脚注。
 *
 * 只有一份数据来源（{@link costDetailModel}），因此面板里一个数字都不算。
 * 每条带 `share` 的行都会画一根占比条，轨道用 `--px-line`（描边色）而不是
 * `--px-surface-2`：面板本身已经是白色「块」，再铺一块米色轨道就变成
 * 「白块里嵌色块」——那正是用户报过的「东一块西一块」。
 * @param {object} props - model（{@link costDetailModel} 的结果）。
 * @returns {object|null} React 元素。
 */
function CostDetailPanel(props) {
  const { model } = props
  if (model === undefined || model === null || model.empty === true) return null

  return h(
    'div',
    {
      className: `px-detail px-detail-tone-${model.tone}`,
      role: 'dialog',
      'aria-label': `${model.title}计价详情`,
    },
    h(
      'div',
      { className: 'px-detail-head' },
      h('span', { className: 'px-detail-mark' }),
      h('span', { className: 'px-detail-title' }, model.title),
      model.badge === undefined ? null : h('span', { className: 'px-detail-badge' }, model.badge),
      h('span', { className: 'px-detail-headline' }, model.headline),
    ),
    model.sections.map((section, index) => h(
      'section',
      { key: `${section.label}-${index}`, className: 'px-detail-section' },
      h(
        'div',
        { className: 'px-detail-section-head' },
        h('span', { className: 'px-detail-section-label' }, section.label),
        section.total === undefined ? null : h('span', { className: 'px-detail-section-total' }, section.total),
      ),
      h(
        'div',
        { className: 'px-detail-rows' },
        section.rows.map((row, rowIndex) => h(
          'div',
          { key: `${row.label}-${rowIndex}`, className: 'px-detail-row' },
          h('span', { className: 'px-detail-row-label', title: row.hint }, row.label),
          h(
            'span',
            { className: 'px-detail-row-meter' },
            Number.isFinite(row.share)
              ? h(
                'span',
                { className: 'px-detail-meter' },
                h('i', {
                  className: `px-detail-meter-fill px-detail-tone-bg-${row.tone ?? section.tone ?? model.tone}`,
                  style: { width: `${Math.round(Math.max(0, Math.min(1, row.share)) * 100)}%` },
                }),
              )
              : null,
          ),
          h('span', { className: 'px-detail-row-value' }, row.value),
        )),
      ),
    )),
    model.notes.length === 0
      ? null
      : h('div', { className: 'px-detail-notes' }, model.notes.map((note, index) => h('p', { key: index }, note))),
  )
}

/**
 * 一枚徽标：图标点 + 标签 + 数值 + 可选角标。视觉对齐产品的统计胶囊（13px、
 * tertiary 文字、24px 圆角、悬停微微加深），因此并排时不显得是「外来的」。
 *
 * 可点的那一枚渲染成 `<button>`（带 `aria-expanded` / `aria-haspopup`），
 * 不可点的（token 数、余额）仍是 `<span>`——**别让用户去点一个点了没反应的东西**。
 * @param {object} props - tone / label / value / title / warn / tag / onClick / expanded / refOf。
 * @returns {object} React 元素。
 */
function Pill(props) {
  const { tone, label, value, title, warn, tag, onClick, expanded, refOf } = props
  const className = `px-pill${warn === true ? ' px-pill-warn' : ''}${onClick === undefined ? '' : ' px-pill-button'}`
  const children = [
    h('i', { key: 'dot', className: `px-pill-dot${tone === undefined ? '' : ` px-tone-bg-${tone}`}` }),
    label === undefined ? null : h('span', { key: 'label', className: 'px-pill-label' }, label),
    h('b', { key: 'value', className: 'px-pill-value' }, value),
    // 角标：用来点明「这个数字是怎么来的」（如「估算」），只写进 title 是不够的
    // ——悬停提示在用户不主动悬停时等于不存在。
    tag === undefined ? null : h('span', { key: 'tag', className: 'px-pill-tag' }, tag),
    // 可点的那一枚才显示小三角：它是「这里有东西可展开」的唯一可见提示。
    onClick === undefined ? null : h('i', { key: 'caret', className: 'px-pill-caret', 'aria-hidden': 'true' }),
  ]

  if (onClick === undefined) {
    return h('span', { className: className, title }, children)
  }
  return h(
    'button',
    {
      type: 'button',
      className: className,
      title,
      onClick,
      'aria-haspopup': 'dialog',
      'aria-expanded': expanded === true,
      'aria-label': `${label ?? ''} ${value}，展开计价详情`.trim(),
      ref: refOf,
    },
    children,
  )
}

/**
 * 徽标组：本次会话费用（+ 可选 token）、以及**按当前模型来源绑定**的那一份
 * 账户事实（官方余额或某家套餐的最紧窗口）。
 *
 * 纯展示**外加一个可展开的详情面板**：费用那一枚（或团队那一枚）是按钮，
 * 点开后在它的上方弹出 `CostDetailPanel`。
 *
 * ## 两件事刻意分开
 *
 *   - **本次会话消费**永远显示（这正是用户要求的：它是一条与「用谁的钱」无关的
 *     事实），金额按定价表分档折算。宿主给不出时才显示「费用不可用」。
 *   - **账户那一枚**由 {@link resolveAccount} 按 provider 来源挑，只有一个，
 *     不再是余额与套餐并排。挑不出来就不渲染，而不是硬塞一个无关的数字。
 * @param {object} props - cost / tokens / failed / account / showTokens / unpriced / usage / team。
 * @returns {object|null} React 元素。
 */
function SessionCostPills(props) {
  const { cost, tokens, failed, account, showTokens = true, unpriced, usage, team } = props
  // 详情面板默认收起：真实首屏与静态渲染里都必须是「没有浮层」这一态。
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const panelRef = useRef(null)
  // 与 `open` 同步的一份 ref：`toggle` 想读到「当前是开还是关」而不把 open 放进
  // 依赖里（那样每次开合都会重新创建回调，Pill 上的 onClick 也跟着变）。
  const openRef = useRef(false)

  // 什么都没拿到、也不是失败：不渲染空壳。
  // 必须返回 null 而不是空元素：容器没有 gap，空元素会污染产品的间距节奏。
  // 团队口径也算「拿到了东西」：成员都还没跑过请求时合计是 ¥0，那是**已知的 0**，
  // 不是「不知道」——但**空成员列表**不算（见 teamSummaryOf 的说明）。
  if (cost === undefined && failed !== true && account === undefined && team === undefined
    && (tokens === undefined || tokens === 0)) return null

  // 「缺少计算公式」这件事必须说出来：那个模型不在价目表里，金额是**按 Flash
  // 单价估的**，跟看板费用明细里标的「估算价」是同一件事。角标 + 面板脚注两处都写。
  const unpricedList = Array.isArray(unpriced) ? unpriced.filter((name) => name !== '') : []

  const model = costDetailModel({ cost, failed, team, account, usage, unpriced: unpricedList })
  // 开合状态是本组件自己的。**不在 setOpen 的更新函数里做副作用**：
  // React 在 StrictMode 下会把更新函数调用两次，副作用（回调外部、埋点之类）
  // 因此会重复执行；这里先把 next 算出来再提交。
  const toggle = useCallback(() => {
    const next = openRef.current !== true
    openRef.current = next
    setOpen(next)
  }, [])
  const closing = useCallback(() => {
    openRef.current = false
    setOpen(false)
  }, [])

  usePanelDismiss({ open, setOpen: closing, anchorRef, panelRef })
  const placement = useDetailPlacement({ open, anchorRef, panelRef })
  const panel = open === true && typeof createPortal === 'function' && typeof document !== 'undefined'
    ? createPortal(
      h(
        'div',
        {
          ref: panelRef,
          className: 'px-detail-anchor',
          // 还没量到时用测量态（隐藏但占位）。绝不能不给 style：那样面板会以
          // 静态流的方式插进 body 末尾，先在整个页面底部闪一下再跳上来。
          style: placement.placed === true ? placement.style : measureStyle(),
          'data-px-detail-placed': placement.placed === true ? 'true' : 'false',
        },
        h(CostDetailPanel, { model }),
      ),
      document.body,
    )
    : null
  // 没有 createPortal（服务端渲染 / 渲染闸门的替身环境）时**整块不渲染**：
  // 面板是固定定位的浮层，塞回 dock 那一行会把横向行撑开、与官方胶囊抢宽度。

  /**
   * 团队模式：**这一枚取代**「本次会话」那一枚，而不是并排再加一枚。
   *
   * ## 为什么是取代而不是并列
   *
   * dock 那一行是横向 flex，宽度是与官方胶囊抢的。团队合计与本次会话金额
   * 并排会多占一格，而两者的差（teammate 那部分）才是用户想看的——把它写进
   * 详情面板的「成员」一节，既省下宽度，又直接回答了「谁花的」。
   * 因此团队模式下，**本次会话的金额移到面板里**，不丢信息。
   */
  const teamText = teamPillOf(team)
  if (teamText !== undefined) {
    return h(
      React.Fragment,
      null,
      h(Pill, {
        tone: 'purple',
        label: '团队合计',
        value: teamText.value,
        tag: teamText.tag,
        onClick: toggle,
        expanded: open,
        refOf: anchorRef,
      }),
      showTokens && team.tokens !== undefined && team.tokens > 0
        ? h(Pill, { tone: 'blue', value: `${formatTokens(team.tokens)} tokens`, title: `团队合计 ${team.memberCount} 位成员` })
        : null,
      h(AccountPill, { account }),
      panel,
    )
  }

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
      // **刻意不给 `title`。** 这一枚是按钮，详情全部在面板里；再挂一段多行
      // title 就等于同时保留两条信息通道，而悬停那条正是用户嫌丑的原生裸浮窗
      // （而且是**打开的**面板之上再弹一个系统提示，两个东西会打架）。
      // 无障碍的「可展开 + 名字」由 aria-expanded / aria-label 承担。
      onClick: toggle,
      expanded: open,
      refOf: anchorRef,
    }),
    showTokens && tokens !== undefined && tokens > 0
      ? h(Pill, { tone: 'blue', value: `${formatTokens(tokens)} tokens` })
      : null,
    h(AccountPill, { account }),
    panel,
  )
}

/**
 * 面板的收起规则：点面板与徽标之外、按 Esc、改变窗口大小。
 *
 * 三条各防一类「面板挂在半空中」的观感问题：
 *   - **点外面**用 `pointerdown` 而不是 `click`：`click` 要等鼠标抬起，用户按住
 *     拖动时会一直开着，并沿途选中背景文字；
 *   - **Esc** 是无障碍的最低要求，面板带 `role="dialog"` 就必须能 Esc 关掉；
 *   - **窗口改变大小**要关：面板用 fixed 定位、宽度由上一次测量算出，窗口一变
 *     它就落在错误的位置上。换成「关掉」而不是「重算」——重算需要再量一次锚点，
 *     而用户此时多半正在拖窗口，跟着动的浮层比收起更烦人。
 *
 * ## 滚动**不在这里关**，而是重新定位（见 useDetailPlacement）
 *
 * 输入框那一块在会话区里是 sticky 的，而面板贴在它上方：用户滚会话时输入框不动，
 * 面板也不该动；但滚动会改变锚点的视口坐标（sticky 有吸附边界），
 * 所以滚完得重新量一次。为了不每滚一帧都量，这里只**清掉已定位标记**——
 * 下一帧布局稳定后 placement 会重算，而重算期间面板保持原位不闪。
 * @param {object} input - open / setOpen / anchorRef / panelRef。
 * @returns {void}
 */
function usePanelDismiss(input) {
  const { open, setOpen, anchorRef, panelRef } = input
  useEffect(() => {
    if (open !== true) return undefined
    if (typeof document === 'undefined') return undefined

    const onPointerDown = (event) => {
      const target = event?.target
      if (target === null || target === undefined) return
      const insidePanel = typeof panelRef.current?.contains === 'function' && panelRef.current.contains(target)
      const insideAnchor = typeof anchorRef.current?.contains === 'function' && anchorRef.current.contains(target)
      if (!insidePanel && !insideAnchor) setOpen(false)
    }
    const onKeyDown = (event) => { if (event?.key === 'Escape') setOpen(false) }
    const onResize = () => { setOpen(false) }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize)
    }
  }, [open, setOpen, anchorRef, panelRef])
}

/**
 * 那一枚账户徽标：按来源不同渲染成余额或套餐窗口。
 *
 * 它**不可点击**：账户这一节已经在费用面板里了，再给它一个自己的浮层只会让人
 * 以为点哪个都能展开，而实际上只有费用那一枚有内容。详情写进 `title`。
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
 * 独立呈现形态：把所有徽标包成一个 **inline-flex 组**。
 *
 * 这个外壳和 portal 进去时用的 `.px-pill-group` 是**同一个观感**（inline、按内容
 * 取宽、gap 12px），因为 `conversation.composer.dock` 本来就是横向 flex 行：我们
 * 只是这行里的**一项**，不该占满整行。
 *
 * 早先这里是个 `width: 100%` 的 `.px-cost-row`（还带左右内边距），前提是「容器为
 * 纵向 flex 且没有 gap」——那其实是 `.root` 的样式，不是 `.dock` 的。在横向行里
 * 占满宽度会与官方胶囊抢空间，把「1 轮 · 38 步」「2.1M tok」挤成省略号。
 * @param {object} props - 同 {@link SessionCostPills}。
 * @returns {object|null} React 元素。
 */
function SessionCostView(props) {
  const { cost, failed, account, tokens, team } = props
  // 用同样的判据决定要不要渲染外壳，避免出现「空的一项」（那会多出一个 gap）
  if (cost === undefined && failed !== true && account === undefined && team === undefined
    && (tokens === undefined || tokens === 0)) return null

  return h('div', { className: 'px-pill-group' }, h(SessionCostPills, props))
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
    cost: undefined, failed: false, balance: undefined, plans: undefined, unpriced: [], team: undefined,
  })
  const official = useOfficialStats()
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
          /**
           * 团队归属：**用同一次响应**算出，不额外发请求。
           *
           * 找不到团队（单人会话 / 旧宿主没有 `teams[]`）时是 undefined，
           * 于是费用条完全退回改动前的单会话口径——见 team.js 的退化表。
           */
          const team = teamSummaryOf(findTeamOf(data, sessionId), { formatCny, formatTokens })
          // 会话在、但没带 cost：宿主是旧实现。标成失败，不要继续转圈。
          setState((prev) => ({
            ...prev,
            cost: row?.cost,
            failed: row !== undefined && row.cost === undefined,
            team,
            // 这个会话用到的模型里，哪些不在价目表里？金额仍是宿主按 Flash 兜底
            // 单价算的，界面上要标成「估算」——与看板费用明细的口径一致。
            unpriced: unpricedModelsOf(row, data.models),
          }))
        })
        .catch(() => {
          // 取数失败（宿主没起来 / 请求出错）也要明说，不静默停在「折算中」
          if (!cancelled) {
            setState((prev) => ({ ...prev, cost: undefined, failed: true, unpriced: [], team: undefined }))
          }
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
    // 团队口径：当前会话属于某个多成员团队时，这一枚换成「团队合计」，
    // 成员明细进详情面板（见 SessionCostPills 的说明）。
    team: state.team,
    // 面板里的「用量构成」一节要的是分桶数字，不是总数——投影给的就是这份，
    // 原样交下去，免得面板再去发一次请求。
    usage: totals,
    // 官方正在显示 token 总数时不再重复一枚——两代契约里那都是同一个事实。
    // 用 showsTokens 而不是「官方在不在」：新契约的 activity 只显示轮次/速度，
    // 那时 token 总量仍应由我们补上（否则界面上就没有 token 了）。
    showTokens: official.showsTokens !== true,
    tokens: billedTokens(totals),
  })

  // 旧契约（≤ 0.2.0-rc.2）：portal 进官方统计容器，追加为末子节点 = 排在它右边
  if (official.anchor !== null && typeof createPortal === 'function') {
    return createPortal(h('span', { className: 'px-pill-group' }, pills), official.anchor)
  }
  // 新契约（≥ 0.2.1-alpha.1）或官方统计不在场：作为**同一横向行里的一项**渲染。
  // 顺序由 COST_ENTRY_ORDER 决定（大于官方胶囊 → 落在右边），宽度由内容决定
  // （inline-flex），所以既排在官方右边，也不会把官方胶囊挤窄。
  return h('div', { className: 'px-pill-group' }, pills)
}

			exports.COST_ENTRY_ID = COST_ENTRY_ID
			exports.COST_ENTRY_ORDER = COST_ENTRY_ORDER
			exports.STATS_ANCHOR_SELECTOR = STATS_ANCHOR_SELECTOR
			exports.OFFICIAL_USAGE_PILL_SELECTOR = OFFICIAL_USAGE_PILL_SELECTOR
			exports.totalsOf = totalsOf
			exports.billedTokens = billedTokens
			exports.unpricedModelsOf = unpricedModelsOf
			exports.teamPillOf = teamPillOf
			exports.CostDetailPanel = CostDetailPanel
			exports.SessionCostPills = SessionCostPills
			exports.SessionCostView = SessionCostView
			exports.SessionCost = SessionCost
		},
		"./priceSettings.js": (exports, require) => {
			const m1 = require("./rates.js")
			/**
 * 「单价设置」界面。
 *
 * 这个文件负责**只**回答一个问题：某个模型的单价是多少、我能不能改它。
 * 由看板的设置弹层（「单价」页签）与「费用明细」里的补价入口共同使用，
 * 因此**不持有**看板状态——数据与写回都通过 props 传入。
 *
 * 两个导出是看板侧的稳定接口（签名一改，看板与费用明细都要跟着改）：
 *   - {@link PriceSettingsView}：设置弹层里的整页（按提供商分页 + 编辑 + 导入导出）
 *   - {@link PriceSettingsButton}：费用明细里那一行「补价」入口（点开浮层编辑单个模型）
 *
 * ## 为什么按**提供商**分页
 *
 * 旧版把价目表里**所有**厂商的模型平铺在一页上（几十个模型、每家六格价格），
 * 用户的原话是「特别丑，一下子都不知道该怎么设置」。更根本的问题是那些厂商里
 * 大部分**用户根本没在用**：价目表随插件发布，而每个人的 DSH 里只接了其中几家。
 * 所以这一页的条目来源换成 `data.models`（用户自己的路由与用量），按提供商分栏：
 * 左栏是「我实际拥有的提供商」，右栏只画选中那一家下面的模型。没出现过的厂商
 * 一律不占版面。
 *
 * ## 为什么只显示两个数
 *
 * 每行只列「未命中 / 输出」两档（元 / 百万 token）。缓存命中那一档很少影响判断，
 * 六格平铺正是旧版「一屏输入框」的来源。分时定价的模型写成「空闲 / 高峰」一对，
 * 顺序在栏头说一次。徽标（不分时 / 按最低档）全部去掉：用户看不懂它们，而它们
 * 回答的问题（这个价是怎么来的）改用 `title` 悬停说明。
 *
 * ## 静态渲染（SSR）约束
 *
 * 这一页会被闸门用 `renderToStaticMarkup` 直接渲染（它在默认关闭的弹层里，
 * 整页渲染看不到它）。因此：
 *   - **默认态必须有内容**：提供商与模型来自 props 的 `data.models`，
 *     价目来自 `data.pricing.rates` / `data.customRates`，不依赖 effect 里的取数；
 *   - **默认态不出现表单**（`.px-price-form` / 新增表单），否则「一屏输入框」
 *     会盖掉清单；
 *   - 取数（`fetchRates`）只是进页面后的一次**校正**，失败也照常可用（旧宿主没有那条路由）。
 *
 * ## 三条界面口径（都不是装饰）
 *
 *   1) **校验只有宿主一份。** 这里不重复写「合不合法」的判断，只把候选文档 POST 上去，
 *      再如实展示宿主回的错误。两处各写一份，迟早出现「界面说没问题、宿主拒绝」。
 *   2) **改价不等于改口径。** 保存的是**覆盖条目**：内置价目仍原样保留，
 *      想回到官方价删掉覆盖即可（界面上有「恢复官方价」）。
 *   3) **金额一律人民币。** 美元价目在填写时可选 USD，但折算与展示口径只有一个：
 *      宿主按 `usdToCny` 折好再交下来，界面写「按汇率 X 折算」。
 *   4) **倍率不在界面上。** 旧版有一整块「我的倍率」，用户反馈「这个功能也没用」。
 *      宿主的 `markup` 能力保留（`pricing.markup` / `setMarkup`），界面不再展示、
 *      也不再改它；保存时把**读到的现有 markup 原样回传**，绝不清空用户已配的值。
 *
 * @module dsh-pixel-dashboard/client/priceSettings
 */

const React = require('react')
// 浮层必须 portal 到 body：它挂在**表格单元格**里，而表格外层有横向滚动容器
// （overflow 非 visible）。留在原地时浮层会被那个容器裁剪/带着滚动，还会把
// 单元格撑开——实测就是「浮层盖住表格、位置乱跳」。
// 与费用详情面板同一条规则：定位用 fixed，落点按锚点量出来。
// 这里用默认导入而不是 `import { createPortal }`：react-dom 在 Node 里是 CJS，
// 命名导出会被闸门的 ESM 直接 import 打挂（dashboard.js 里记过同一条坑）。
const ReactDOM = require('react-dom')
const documentOf = m1.documentOf
const draftOf = m1.draftOf
const entryOfDraft = m1.entryOfDraft
const exportDocument = m1.exportDocument
const fetchRates = m1.fetchRates
const parseImported = m1.parseImported
const saveRates = m1.saveRates
const h = React.createElement

/** 自定义条目那个伪提供商的 id。真提供商的 id 是 DSH 路由名，不会与它撞。 */
const EXTRA_ID = '\u0000extra'

/** 三个价档在界面上的顺序与说明。**只在编辑浮层里用**，清单里只列未命中 / 输出。 */
const PRICE_FIELDS = [
  { field: 'cacheHit', label: '缓存命中', hint: '命中缓存的输入 token 单价' },
  { field: 'cacheMiss', label: '未命中', hint: '未命中缓存的输入 token 单价' },
  { field: 'output', label: '输出', hint: '模型输出 token 单价' },
]

/**
 * 空表单的初值。
 *
 * 浮层打开时若推不出当前价（价目表里没有、也没有覆盖），**仍然要显示空表单**：
 * 用户点开就是为了填这一条。早先因为 `draft === null` 直接不渲染浮层，症状是
 * 「点了没反应、按钮却显示收起」。
 */
const EMPTY_DRAFT = { cacheHit: '', cacheMiss: '', output: '', currency: 'CNY' }

/**
 * 用「元 / 百万 token」显示一个数字：去掉多余的零，但不四舍五入到两位（小额会变成 0）。
 * @param {*} value - 任意值。
 * @returns {string} 文本；读不出数字时写「未知」（不写「—」：那不是一句人话）。
 */
function priceText(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '未知'
  if (amount === 0) return '0'
  if (Math.abs(amount) >= 100) return String(Math.round(amount * 100) / 100)
  return String(Math.round(amount * 1e6) / 1e6)
}

/**
 * 一个价档的展示文本。
 *
 * 宿主的价目里每档可能是 `{ idle, peak }`（分时）也可能是一个数（不分时）。
 * 分时且两档不同才写成「空闲 / 高峰」，同价只写一个数——摆两个相同的数纯属噪音。
 * @param {*} value - 价档值。
 * @returns {string} 文本。
 */
function pairText(value) {
  if (value === null || value === undefined) return '未知'
  if (typeof value !== 'object') {
    const single = Number(value)
    return Number.isFinite(single) ? priceText(single) : '未知'
  }
  const idle = Number(value.idle)
  const peak = Number(value.peak)
  const idleOk = Number.isFinite(idle)
  const peakOk = Number.isFinite(peak)
  if (!idleOk && !peakOk) return '未知'
  if (idleOk && peakOk && idle === peak) return priceText(idle)
  if (idleOk && peakOk) return priceText(idle) + ' / ' + priceText(peak)
  return priceText(idleOk ? idle : peak)
}

/**
 * 价档的悬停说明：把「这两个数分别是什么」说全。
 *
 * 界面上只显示两个数、不带标签（标签在栏头说一次），所以这一句是唯一能确认
 * 顺序的地方。**不分时 / 按最低档这类徽标已按用户要求去掉**，它们的含义移到这里。
 * @param {string} label - 档名。
 * @param {*} value - 价档值。
 * @returns {string} 悬停文本。
 */
function pairTitle(label, value) {
  const unit = ' 元 / 百万 token'
  if (value === null || typeof value !== 'object') return label + '：' + pairText(value) + unit
  const idle = Number(value.idle)
  const peak = Number(value.peak)
  const parts = []
  if (Number.isFinite(idle)) parts.push('空闲 ' + priceText(idle))
  if (Number.isFinite(peak)) parts.push('高峰 ' + priceText(peak))
  return label + '：' + (parts.length === 0 ? '未知' : parts.join('，')) + unit
}

/**
 * 取「编辑时该显示的数字」。
 *
 * 官方美元价目在宿主那边已经折成人民币（`native` 里留着原币值）。编辑时优先显示
 * **原币 + 原币种**：用户想改的通常是「官方那个 $2」，而不是「折算后的 14.6」——
 * 让他对着折算值改，下次改汇率就全乱了。人民币条目没有 `native`，直接用自己。
 * @param {object|undefined} rate - 价目条目（可能是宿主折好的视图）。
 * @returns {object|undefined} 适合编辑的条目。
 */
function editableRate(rate) {
  if (rate === null || typeof rate !== 'object') return undefined
  if (rate.native === null || typeof rate.native !== 'object') return rate
  return {
    ...rate,
    currency: rate.sourceCurrency ?? rate.native.currency ?? 'CNY',
    cacheHit: rate.native.cacheHit,
    cacheMiss: rate.native.cacheMiss,
    output: rate.native.output,
    ...(rate.native.cacheWrite === undefined ? { cacheWrite: undefined } : { cacheWrite: rate.native.cacheWrite }),
  }
}

/** 宿主回报的状态 → 可编辑的文档草稿。markup 只是**原样带着**，界面上不出现。 */
function draftDocument(status, pricing) {
  const base = documentOf(status, pricing)
  return {
    rates: { ...base.rates },
    markup: { ...base.markup },
    usdToCny: base.usdToCny,
  }
}

/** 把宿主抛出的错误拆成逐条展示的数组（`saveRates` 已把数组挂在 error 上）。 */
function errorLines(error) {
  const list = Array.isArray(error?.errors) ? error.errors : []
  if (list.length > 0) return list.map((line) => String(line))
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? ['保存失败：宿主没有给出原因'] : [message]
}

/**
 * 关键词匹配（模型键 / 显示名任一命中即可）。
 *
 * 大小写不敏感，且**忽略分隔符**：用户搜 `glm53` 也该搜到 `glm-5.3`
 * （与宿主 `normalizeModel` 的宽容度对齐，否则同一个名字在两处行为不一致）。
 * @param {string} text - 候选文本。
 * @param {string} query - 关键词。
 * @returns {boolean} 是否命中。
 */
function matchesQuery(text, query) {
  const target = String(text ?? '').toLowerCase()
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return true
  if (target.includes(needle)) return true
  const loose = needle.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  if (loose === '') return false
  return target.replace(/[^a-z0-9\u4e00-\u9fff]/g, '').includes(loose)
}

/**
 * 把 `data.models` 汇总成「提供商 → 它的模型」。
 *
 * **只列用户实际拥有的提供商**（`data.models` 里出现过的），不铺价目表里的全部厂商：
 * 用户没接的厂商不该占版面。模型按**归一键**（`rollup`）去重——价目是按模型索引的，
 * 同一模型走多条路由时价目是同一份，逐条重复没有信息量。
 *
 * 自己加的条目（`overrides` 里、模型清单里没有的键）按写入时的 `vendor` 认领：
 * 命中某家的标签或路由名就归到那一家（这样「新增一条」加的东西下一次还能看到、
 * 还能删）；都认不出时集中到最后一个「其他条目」——它们仍然生效，不能让用户
 * 在界面上够不着。
 * @param {object[]|undefined} models - 宿主 `models[]`。
 * @param {Record<string, object>} overrides - 待保存文档里的 rates（模型键 → 条目）。
 * @returns {{id:string,label:string,models:object[]}[]} 提供商列表（沿用 models 的顺序）。
 */
function providersOf(models, overrides) {
  const buckets = new Map()
  /** 取（或建）某提供商的分桶。 */
  const bucketOf = (id, label) => {
    if (!buckets.has(id)) buckets.set(id, { id, label, models: [], keys: new Set() })
    return buckets.get(id)
  }
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model?.provider === 'string' ? model.provider.trim() : ''
    const rawLabel = typeof model?.providerLabel === 'string' ? model.providerLabel.trim() : ''
    const bucket = bucketOf(id, rawLabel !== '' ? rawLabel : (id === '' ? '来源未知' : id))
    const key = typeof model?.rollup === 'string' && model.rollup !== ''
      ? model.rollup
      : (typeof model?.key === 'string' ? model.key : '')
    if (key === '' || bucket.keys.has(key)) continue
    bucket.keys.add(key)
    bucket.models.push({
      key,
      label: typeof model?.label === 'string' && model.label !== '' ? model.label : key,
      priced: model?.priced !== false,
      tiered: model?.tiered === true,
      routes: Array.isArray(model?.routes) ? model.routes.length : 0,
      custom: false,
    })
  }
  // 自己加的条目：vendor → 提供商。标签可能重复（极端情形），先到先得。
  const ownerOf = new Map()
  for (const bucket of buckets.values()) {
    if (!ownerOf.has(bucket.label)) ownerOf.set(bucket.label, bucket.id)
    if (bucket.id !== '' && !ownerOf.has(bucket.id)) ownerOf.set(bucket.id, bucket.id)
  }
  const leftovers = []
  for (const [key, rate] of Object.entries(overrides ?? {})) {
    if (rate === null || typeof rate !== 'object') continue
    let listed = false
    for (const bucket of buckets.values()) {
      if (bucket.keys.has(key)) { listed = true; break }
    }
    if (listed) continue
    const row = {
      key,
      label: typeof rate.label === 'string' && rate.label.trim() !== '' ? rate.label.trim() : key,
      priced: true,
      tiered: rate.tiered === true,
      routes: 0,
      custom: true,
    }
    const vendor = typeof rate.vendor === 'string' ? rate.vendor.trim() : ''
    const owner = ownerOf.get(vendor)
    if (owner === undefined) { leftovers.push(row); continue }
    const bucket = buckets.get(owner)
    bucket.keys.add(key)
    bucket.models.push(row)
  }
  for (const bucket of buckets.values()) bucket.models.sort((a, b) => a.key.localeCompare(b.key))
  // 顺序**保持 data.models 的顺序**（宿主按用量降序给），不按名字重排：
  // 左栏第一行就是用户用得最多的那一家，默认选中它——打开设置页正好落在
  // 他大概率要改的那一页上，而不是按拼音/字母碰运气。
  const list = [...buckets.values()]
  if (leftovers.length > 0) {
    leftovers.sort((a, b) => a.key.localeCompare(b.key))
    list.push({ id: EXTRA_ID, label: '其他条目', models: leftovers })
  }
  return list
}

/**
 * 单价设置整页。
 * @param {object} props - data（看板数据，含 data.models / data.pricing / data.customRates）、onSaved（保存后回调）。
 * @returns {object|null} React 元素。
 */
function PriceSettingsView(props) {
  const { data, onSaved } = props ?? {}
  const pricing = data?.pricing
  const effective = pricing?.rates !== null && typeof pricing?.rates === 'object' ? pricing.rates : {}
  const [doc, setDoc] = React.useState(() => draftDocument(data?.customRates, pricing))
  const [status, setStatus] = React.useState(() => data?.customRates ?? null)
  const [query, setQuery] = React.useState('')
  const [selectedId, setSelectedId] = React.useState(null)
  const [adding, setAdding] = React.useState(false)
  const [addDraft, setAddDraft] = React.useState(null)
  const [addError, setAddError] = React.useState('')
  const [errors, setErrors] = React.useState([])
  const [notice, setNotice] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [io, setIo] = React.useState({ open: false, text: '', error: '' })

  // 进页面后向宿主校正一次真实状态：`data.customRates` 来自看板取数（有 TTL 缓存），
  // 可能落后几十秒，而用户刚在这里改过价时那种「落后」会让人以为没生效。
  // **默认态不依赖它**（旧宿主 / 请求失败时清单照常显示），因此这里失败就安静降级。
  React.useEffect(() => {
    let alive = true
    fetchRates()
      .then((fresh) => {
        if (!alive) return
        setStatus(fresh)
        setDoc(draftDocument(fresh, pricing))
      })
      .catch(() => { /* 老宿主没有 /rates 路由：用 props 里那一份 */ })
    return () => { alive = false }
    // 只在挂载时取一次：本页自己保存后会直接用响应刷新，不必反复回取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 用户实际拥有的提供商（只来自 data.models + 自己加的条目）。 */
  const providers = React.useMemo(
    () => providersOf(data?.models, doc.rates),
    [data?.models, doc.rates],
  )

  // 选中的提供商：默认第一家。数据刷新后原来那家可能不在了（换了时间窗口），
  // 因此每次都按 id 重新定位，定位不到就落回第一家——**不要**用 effect 去同步，
  // 那会在两次渲染之间留一个「左栏没有选中项」的中间态。
  const active = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null

  /** 某家下面的一行：模型 + 当前生效价 + 是否我改过。 */
  const rowOf = (provider) => (model) => {
    const override = doc.rates[model.key]
    const mine = override !== null && typeof override === 'object'
    const rate = (mine ? override : undefined) ?? effective[model.key] ?? {}
    return { ...model, mine, rate }
  }

  const rows = active === null
    ? []
    : active.models
      .map(rowOf(active))
      .filter((row) => matchesQuery(row.key + ' ' + row.label, query))

  /** 所有已经出现在页面里的模型键：新增时要拒绝重复。 */
  const listedKeys = React.useMemo(() => {
    const keys = new Set()
    for (const provider of providers) for (const model of provider.models) keys.add(model.key)
    return keys
  }, [providers])

  /** 删掉一条覆盖（内置模型 = 回到官方价；自己加的条目 = 整条删掉）。 */
  const removeOverride = (key) => {
    setDoc((current) => {
      const next = { ...current.rates }
      delete next[key]
      return { ...current, rates: next }
    })
    setNotice(`已删掉「${key}」的覆盖，点「保存单价」后回到官方价`)
  }

  /** 新增一条：把「模型键 / 未命中 / 输出」整理成覆盖条目，插到当前提供商下面。 */
  const commitAdd = () => {
    if (active === null) return
    const key = String(addDraft?.key ?? '').trim()
    if (key === '') {
      setAddError('先填模型键，与你在 DSH 路由里看到的模型名一致即可，例如 deepseek-flash')
      return
    }
    if (listedKeys.has(key)) {
      setAddError(`「${key}」已经在列表里了，直接改那一行的单价`)
      return
    }
    const entry = entryOfDraft({
      label: key,
      // vendor 是「这条属于哪一家」的唯一线索：保存后重新进来靠它归位。
      vendor: active.label,
      currency: 'CNY',
      cacheMissIdle: addDraft?.cacheMiss,
      outputIdle: addDraft?.output,
    })
    if (entry === undefined) {
      setAddError('至少填「未命中」或「输出」其中一项，否则这条覆盖没有任何意义')
      return
    }
    setDoc((current) => ({ ...current, rates: { ...current.rates, [key]: entry } }))
    setAdding(false)
    setAddDraft(null)
    setAddError('')
    setQuery('')
    setNotice(`已加入「${key}」，点「保存单价」后生效`)
  }

  const save = async () => {
    setSaving(true)
    setErrors([])
    setNotice('')
    try {
      // 整份文档原样提交：rates 是覆盖值，markup 是**读到的现有值**（界面上不再提供
      // 入口，但要原样带着走，否则保存一次就把用户以前配的倍率清空了）。
      const response = await saveRates(doc)
      const fresh = response ?? doc
      setStatus(fresh)
      setDoc(draftDocument(fresh, pricing))
      setNotice(fresh?.persisted === false
        ? '已在本次运行内生效，但没能写进文件（看下方原因）'
        : '已保存。刷新看板即可看到新价。')
      if (typeof onSaved === 'function') onSaved(fresh)
    } catch (error) {
      // 校验失败**一个字节都没落盘**：宿主的 save() 先校验再写文件。
      setErrors(errorLines(error))
    } finally {
      setSaving(false)
    }
  }

  const doExport = () => {
    const text = exportDocument(doc)
    setIo({ open: true, text, error: '' })
    // 能写剪贴板就写好：导出的主要用途就是搬到另一台机器上。
    try { navigator.clipboard?.writeText?.(text)?.catch?.(() => {}) } catch { /* 剪贴板不可用就算了 */ }
  }

  const doImport = () => {
    const parsed = parseImported(io.text)
    if (parsed.error !== undefined) { setIo((current) => ({ ...current, error: parsed.error })); return }
    const imported = draftDocument(parsed.document, pricing)
    // 旧格式 / 手写 JSON 里常常没有 markup。缺它时**保留现有值**，不要用 {} 覆盖：
    // 那等于「导入一份单价，顺手清空别人的倍率配置」。
    const carriesMarkup = parsed.document?.markup !== null && typeof parsed.document?.markup === 'object'
    setDoc((current) => ({ ...imported, markup: carriesMarkup ? imported.markup : current.markup }))
    setIo({ open: true, text: '', error: '' })
    setAdding(false)
    setAddDraft(null)
    setNotice('已读入这份 JSON，确认无误后点「保存单价」才会真正生效')
  }

  /**
   * 浮层里直接保存成功后，把这一条并回本页的待保存文档。
   *
   * 浮层（{@link PriceSettingsButton}）是**直接落盘**的，而本页的改动还在草稿里。
   * 不并回来的话：用户先改了两行、又在某一行用浮层保存，接着点「保存单价」——
   * 本页那份旧草稿会把浮层刚写进去的那条盖掉（界面显示成功、文件里却没有）。
   * @param {string} key - 归一键。
   * @returns {(fresh:object)=>void} onSaved 回调。
   */
  const mergeSaved = (key) => (fresh) => {
    if (fresh !== null && typeof fresh === 'object') {
      setStatus(fresh)
      setDoc((current) => {
        const next = { ...current, rates: { ...current.rates } }
        const saved = fresh?.rates?.[key]
        if (saved !== undefined) next.rates[key] = saved
        else delete next.rates[key]
        if (fresh?.markup !== null && typeof fresh?.markup === 'object') next.markup = fresh.markup
        return next
      })
    }
    setNotice(`「${key}」已直接保存到宿主；本页其它还没保存的改动仍然保留`)
  }

  /**
   * 一个模型那一行。
   *
   * 拆成函数而不是嵌在 JSX 里：这一块有「当前值 / 是否我改过 / 是否分档 /
   * 是否外币 / 是否自定义」五组条件，平铺在一处会变成一屏读不完的嵌套三元表达式。
   * @param {object} row - 模型行（providersOf + rowOf 合并后的结果）。
   * @returns {object} React 元素。
   */
  const renderRow = (row) => {
    const rate = row.rate ?? {}
    // 分档/外币这类「这个数字是怎么来的」不再做成徽标，只在悬停时说一句。
    const extra = []
    if (row.tiered === true) extra.push('官方按输入长度分档，这里取最低档')
    if (rate.sourceCurrency === 'USD') {
      extra.push(`官方原价是美元，按汇率 ${rate.fx ?? doc.usdToCny} 折算`)
    }
    const note = extra.length === 0 ? '' : '；' + extra.join('；')
    const official = typeof rate.label === 'string' ? rate.label : ''
    return h('div', {
      className: 'px-price-item px-price-item-head' + (row.mine ? ' mine' : ''),
      key: row.key,
    },
    h('div', { className: 'px-price-item-name' },
      h('b', {
        title: official !== '' && official !== row.label ? `内置价目里的名字：${official}` : undefined,
      }, row.label),
      h('code', {
        className: 'px-muted',
        title: row.routes > 1 ? `合并了 ${row.routes} 条路由` : undefined,
      }, row.key),
      row.custom ? h('span', { className: 'px-price-item-tag', title: '你自己加的条目，不在插件内置价目里' }, '自定义') : null,
      row.priced === false ? h('span', { className: 'px-price-item-tag', title: '价目表里没有这个模型，暂按 Flash 的单价估算' }, '估算') : null),
    h('span', {
      className: 'px-price-cell px-price-cell-miss',
      title: pairTitle('未命中', rate.cacheMiss) + note,
    },
    h('i', { className: 'px-price-cell-label' }, '未命中'),
    pairText(rate.cacheMiss)),
    h('span', {
      className: 'px-price-cell px-price-cell-out',
      title: pairTitle('输出', rate.output) + note,
    },
    h('i', { className: 'px-price-cell-label' }, '输出'),
    pairText(rate.output)),
    h('span', { className: 'px-price-item-actions' },
      // 复用费用明细那一枚「改单价」：同一套浮层、同一套保存口径，不另写一套。
      h(PriceSettingsButton, {
        modelKey: row.key,
        label: row.label,
        rate: row.rate,
        pricing,
        markup: doc.markup,
        onSaved: mergeSaved(row.key),
      }),
      row.mine
        ? h('button', {
          type: 'button',
          className: 'px-fix-link px-price-reset',
          title: '删掉这条覆盖，回到插件内置的官方价',
          onClick: () => removeOverride(row.key),
        }, '恢复官方价')
        : null))
  }

  /**
   * 「新增一条」：在右栏顶部插一行可编辑的自定义模型。
   *
   * 旧版这一枚按钮点了只把搜索词当键塞进文档、再打开一个表单，用户看到的
   * 就是「点了没反应」。这里改成**明确的就地表单**：填模型键 / 未命中 / 输出
   * 就能记下，保存后归属于当前选中的提供商。
   * @param {object|null} provider - 当前提供商。
   * @returns {object|null} React 元素。
   */
  const renderAdd = (provider) => {
    // 「其他条目」是个只读的收容所：里面没有稳定归属，不让往里加。
    if (provider === null || provider.id === EXTRA_ID) return null
    if (adding !== true) {
      return h('div', { className: 'px-price-add' },
        h('button', {
          type: 'button',
          className: 'px-btn small',
          onClick: () => {
            setAdding(true)
            setAddDraft({ key: '', cacheMiss: '', output: '' })
            setAddError('')
            setNotice('')
          },
        }, '新增一条'),
        h('span', { className: 'px-muted px-note' },
          '给「' + provider.label + '」补一个内置价目里没有的模型（只需要填模型键与两个价）。'))
    }
    const field = (name, label, placeholder) => h('label', { className: 'px-rate-field', key: name },
      h('span', { className: 'px-rate-field-label' }, label),
      h('input', {
        className: 'px-input',
        type: 'text',
        inputMode: name === 'key' ? undefined : 'decimal',
        placeholder,
        value: addDraft?.[name] ?? '',
        onChange: (event) => setAddDraft((current) => ({ ...(current ?? {}), [name]: event.target.value })),
      }))
    return h('div', { className: 'px-price-add px-price-add-open' },
      h('div', { className: 'px-price-add-head' },
        h('b', null, '在「' + provider.label + '」下面新增一个模型'),
        h('span', { className: 'px-muted px-note' }, '单位同样是元 / 百万 token；不分时只填一个数即可。')),
      h('div', { className: 'px-price-add-fields' },
        field('key', '模型键', '例如 my-model-v1'),
        field('cacheMiss', '未命中', '0'),
        field('output', '输出', '0')),
      addError !== '' ? h('p', { className: 'px-price-inline-error' }, addError) : null,
      h('div', { className: 'px-price-actions' },
        h('button', { type: 'button', className: 'px-btn small primary', onClick: commitAdd }, '记下这条'),
        h('button', {
          type: 'button',
          className: 'px-btn small',
          onClick: () => { setAdding(false); setAddDraft(null); setAddError('') },
        }, '取消')))
  }

  const hostErrors = Array.isArray(status?.errors) ? status.errors : []
  const filePath = typeof status?.path === 'string' && status.path !== ''
    ? status.path
    : '(这台机器上还没确定价目文件路径——可能是旧宿主)'
  const overrides = Object.keys(doc.rates).length
  const mineCount = active === null
    ? 0
    : active.models.filter((model) => doc.rates[model.key] !== undefined).length

  return h('div', { className: 'px-price-settings' },
    h('p', { className: 'px-price-head' },
      h('b', null, '各模型单价'),
      '（元 / 百万 token，分时的写作「空闲 / 高峰」）。价目随插件发布，这里只列',
      h('b', null, '你在 DSH 里接过的提供商'),
      '；改的是',
      h('b', null, '你的覆盖值'),
      '，保存后立刻参与计价，并',
      h('b', null, '不再标「估算价」'),
      '。'),

    // ── 汇率（用户认可的既有能力，保持原样）────────────────────────
    h('div', { className: 'px-price-fx' },
      h('label', { className: 'px-rate-field', title: '美元价目的官方价按这个汇率折成人民币参与合计' },
        h('span', { className: 'px-rate-field-label' }, '汇率'),
        h('span', { className: 'px-muted' }, '1 美元 ='),
        h('input', {
          type: 'number',
          step: '0.01',
          min: '0',
          className: 'px-input',
          value: Number.isFinite(Number(doc.usdToCny)) ? String(doc.usdToCny) : '',
          disabled: saving,
          onChange: (event) => {
            const next = event.target.value
            setDoc((current) => ({ ...current, usdToCny: next === '' ? undefined : Number(next) }))
          },
        }),
        h('span', { className: 'px-muted' }, '元')),
      h('span', { className: 'px-muted px-note' },
        'OpenAI / Anthropic / Google / xAI 的官方价是美元，按这个汇率折算后与人民币价目相加。'
        + '改汇率会同时改变所有美元条目的金额。')),

    // ── 提供商分栏 ──────────────────────────────────────────────
    providers.length === 0
      ? h('p', { className: 'px-muted' },
        '这个时间窗口里还没有出现过模型，等有调用后这里会按提供商列出来。'
        + '急用的话可以点下面的「导入 / 导出 JSON」直接写一份价目。')
      : h('div', { className: 'px-price-console' },
        h('nav', { className: 'px-price-nav', 'aria-label': '提供商' },
          h('span', { className: 'px-price-nav-title' }, '提供商（按你接的那些）'),
          providers.map((provider) => {
            const on = active !== null && provider.id === active.id
            const changed = provider.models.filter((model) => doc.rates[model.key] !== undefined).length
            return h('button', {
              key: provider.id === '' ? '__unknown__' : provider.id,
              type: 'button',
              className: 'px-price-provider' + (on ? ' on' : ''),
              'aria-current': on ? 'true' : undefined,
              title: provider.id === EXTRA_ID
                ? '不属于当前任何提供商的自定义条目'
                : (provider.id === ''
                  ? '旧账本记录里没有提供商信息'
                  : '路由名 ' + provider.id),
              onClick: () => {
                setSelectedId(provider.id)
                setQuery('')
                setAdding(false)
                setAddDraft(null)
                setAddError('')
              },
            },
            h('span', { className: 'px-price-provider-label' }, provider.label),
            h('span', { className: 'px-price-provider-meta' },
              // **不再按提供商显示「M 条已改」**：单价是按**模型**存的，跨提供商共用，
              // 所以同一个模型在每家下面都会被标成「已改」。按家报数字会让用户以为
              // 「我只改了一家，怎么每家都说改过」——实测被当成 bug 报上来。
              // 这里只报模型数；「改过几条」统一在右栏标题里说一次，并写明口径。
              provider.models.length + ' 个模型'))
          })),
        h('section', { className: 'px-price-pane' },
          h('div', { className: 'px-price-pane-head' },
            h('b', { className: 'px-price-pane-title' }, active.label),
            h('span', { className: 'px-muted px-note', title: '单价按模型保存：同一个模型被多家提供商共用时，改一次对所有家生效' },
              mineCount > 0
                ? `${mineCount} 条已改（按模型共用，改一次对所有提供商生效）`
                : '还没改过这里的价'),
            h('div', { className: 'px-price-filters' },
              h('label', { className: 'px-rate-field' },
                h('span', { className: 'px-rate-field-label' }, '搜索'),
                h('input', {
                  type: 'search',
                  className: 'px-input px-price-search',
                  placeholder: '在这个提供商里筛选模型',
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                })))),
          // 新增入口放在清单**顶部**：点开后就地展开一行可填的表单，
          // 不跳页、不弹窗，填完立刻出现在下面这份清单里。
          renderAdd(active),
          h('div', { className: 'px-price-list' },
            h('div', { className: 'px-price-list-head' },
              h('span', null, '模型'),
              h('span', null, '未命中'),
              h('span', null, '输出'),
              h('span', null, '')),
            rows.length === 0
              ? h('p', { className: 'px-muted px-note' },
                query === ''
                  ? '这家下面还没有模型。'
                  : '这家下面没有匹配「' + query + '」的模型。搜索只在这个提供商里生效。')
              : rows.map(renderRow)))),

    // ── 导入 / 导出 ─────────────────────────────────────────────
    h('div', { className: 'px-price-io' },
      h('div', { className: 'px-price-actions' },
        h('button', {
          type: 'button',
          className: 'px-btn small',
          onClick: () => setIo((current) => ({ open: !current.open, text: current.open ? '' : current.text, error: '' })),
        }, io.open ? '收起 JSON' : '导入 / 导出 JSON'),
        h('button', { type: 'button', className: 'px-btn small', onClick: doExport, disabled: saving }, '导出（并复制）')),
      io.open
        ? h('div', { className: 'px-price-io-body' },
          h('textarea', {
            className: 'px-input px-price-json',
            spellCheck: false,
            rows: 8,
            placeholder: '{ "rates": { "my-model": { "cacheMiss": 2, "output": 8 } } }',
            value: io.text,
            onChange: (event) => setIo((current) => ({ ...current, text: event.target.value, error: '' })),
          }),
          io.error !== '' ? h('p', { className: 'px-price-inline-error' }, io.error) : null,
          h('div', { className: 'px-price-actions' },
            h('button', { type: 'button', className: 'px-btn small', onClick: doImport, disabled: saving }, '读入这段 JSON'),
            h('span', { className: 'px-muted px-note' }, '旧格式（顶层直接是「模型键 → 价目」）也能读入。')))
        : null),

    // ── 错误与保存 ──────────────────────────────────────────────
    errors.length > 0
      ? h('ul', { className: 'px-price-errors' }, errors.map((line) => h('li', { key: line }, line)))
      : null,
    hostErrors.length > 0
      ? h('ul', { className: 'px-price-errors' },
        hostErrors.map((line) => h('li', { key: line }, `文件里的这一条没生效：${line}`)))
      : null,
    typeof status?.error === 'string' && status.error !== ''
      ? h('p', { className: 'px-price-inline-error' }, `价目文件读写有问题：${status.error}`)
      : null,
    notice !== '' ? h('p', { className: 'px-muted px-note px-price-notice' }, notice) : null,
    h('div', { className: 'px-price-save' },
      h('button', { type: 'button', className: 'px-btn primary', disabled: saving, onClick: save },
        saving ? '保存中…' : '保存单价'),
      h('span', { className: 'px-muted px-note' }, `共 ${overrides} 条覆盖 · 文件：${filePath}`)),
  )
}

/**
 * 三个价档的六格输入（外加显示名 / 厂商 / 币种）。
 *
 * 每档都是「空闲 / 高峰」一对：**填两个一样的数就是不分成**。之所以坚持成对出现，
 * 是因为只显示一个数时用户无法表达「这个模型分时定价」，而错档正是这里最常见的错。
 * @param {object} props - draft / onChange。
 * @returns {object} React 元素。
 */
function PriceFields(props) {
  const { draft, onChange } = props
  const set = (key) => (event) => onChange?.({ ...draft, [key]: event.target.value })
  const field = (key, label) => h('label', { className: 'px-rate-field', key },
    h('span', { className: 'px-rate-field-label' }, label),
    h('input', {
      className: 'px-input',
      type: 'text',
      inputMode: 'decimal',
      value: draft?.[key] ?? '',
      onChange: set(key),
    }))
  return h('div', { className: 'px-price-form' },
    field('label', '显示名'),
    field('vendor', '厂商'),
    h('label', { className: 'px-rate-field', title: '美元价目选 USD；人民币选 CNY' },
      h('span', { className: 'px-rate-field-label' }, '币种'),
      h('select', { className: 'px-input', value: draft?.currency ?? 'CNY', onChange: set('currency') },
      h('option', { value: 'CNY' }, 'CNY'),
      h('option', { value: 'USD' }, 'USD'))),
    h('div', { className: 'px-rate-pairs' },
      PRICE_FIELDS.map((meta) => h('div', { className: 'px-rate-pair', key: meta.field },
        h('b', { title: meta.hint }, meta.label),
        field(`${meta.field}Idle`, '空闲'),
        field(`${meta.field}Peak`, '高峰')))))
}

/**
 * 单个模型的补价入口（费用明细 / 单价设置页每一行）。
 *
 * 与整页共用同一套表单与保存口径，区别只有两点：只编辑一个模型，且**先向宿主取一次**
 * 当前的覆盖值（手里那份可能只是生效价，分不清哪部分是用户改过的）。
 *
 * 关闭态返回的是「只有一枚按钮」的 span——**不是 null**：按钮本身必须常驻，
 * 用户才看得到入口；而表单项在关闭态一个都不渲染（否则会撑开表格行）。
 * @param {object} props - modelKey（归一键）/ label（显示名）/ rate / pricing / markup / onSaved。
 * @returns {object|null} React 元素。
 */
function PriceSettingsButton(props) {
  const { modelKey, label, onSaved } = props ?? {}
  const rollup = String(modelKey ?? '').split('@')[0]
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(null)
  const [errors, setErrors] = React.useState([])
  const [notice, setNotice] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  /**
   * 浮层落点（null = 还没量）。
   *
   * ## 为什么必须量、不能纯 CSS 定位
   *
   * 这个按钮在**表格行**里，父级有横向滚动容器。`position: absolute` 会被那个
   * 容器裁剪，而 `right: 0` 会让 340px 宽的浮层向左盖住模型名与前几列——
   * 实测截图里看到的就是这个。因此改成 portal 到 body + `position: fixed`，
   * 位置按按钮的实际矩形算，空间不够时**向上翻**。
   */
  const [pos, setPos] = React.useState(null)
  const wrapRef = React.useRef(null)
  const popRef = React.useRef(null)

  /** 量一次锚点，算出浮层落点（水平夹进视口，垂直优先向下、放不下就向上）。 */
  const place = React.useCallback(() => {
    const node = wrapRef.current
    if (node === null || typeof window === 'undefined') return
    const rect = node.getBoundingClientRect()
    const width = Math.min(360, Math.max(260, window.innerWidth - 32))
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
    // 浮层高度按内容估算（六个价框 + 标题 + 按钮约 300px）；不够就翻到上面去。
    const room = window.innerHeight - rect.bottom
    const top = room < 320 ? Math.max(12, rect.top - 312) : rect.bottom + 6
    setPos({ left, top, width })
  }, [])

  React.useEffect(() => {
    if (!open) return undefined
    place()
    /**
     * 三条关闭路径，与详情面板同一套：Esc、点外面、窗口变化。
     * 尺寸一变旧坐标就失效，继续显示只会落在错误的位置。
     */
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    const onDown = (event) => {
      const wrap = wrapRef.current
      const pop = popRef.current
      if (wrap !== null && wrap.contains(event.target)) return
      if (pop !== null && pop.contains(event.target)) return
      // 正在操作浮层里的原生下拉框（币种）时不关：某些平台上点选项那一下
      // 会派发到 document 上，表现就是「一点下拉，浮层没了」。
      const active = document.activeElement
      const tag = String(active?.tagName ?? '').toUpperCase()
      if (tag === 'SELECT' || tag === 'INPUT') return
      setOpen(false)
    }
    const onResize = () => { setOpen(false) }
    document.addEventListener('keydown', onKey, true)
    // pointerdown 而不是 click：按住拖动时 click 要等抬起，浮层会一直开着。
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, place])

  /**
   * 浮层节点**延迟构造**（函数而不是常量）。
   *
   * 这不是风格问题：浮层里要挂「保存这条」按钮，而 `submit` 是下面的 `const`。
   * 若在**这里**就把元素构造出来（`const popover = h(... onClick: submit ...)`），
   * 本函数体执行时 `submit` 还在暂时性死区 → 抛 ReferenceError → 整个看板白屏。
   * 实测：点了「补价」后整页变空白。
   * 包成函数后，构造发生在 `return` 那一句（`submit` 已初始化），因此安全。
   *
   * ## 判据只看 `open`，不看 `draft`
   *
   * 早先要求 `draft !== null` 才渲染。而 `draft` 是由「当前生效价」推出来的，
   * 某些模型（价目表里没有、且没有覆盖）推出来是空的，于是**按钮已经变成「收起」、
   * 浮层却一个节点都没渲染**——用户报的「点改单价没反应，直接显示收起」就是这个。
   * 现在只要打开就渲染，字段为空就显示空表单（用户自己填，正是「新增一条」的用途）。
   */
  const popoverOf = () => (open && typeof document !== 'undefined'
    ? ReactDOM.createPortal(
      h('div', {
        className: 'px-price-pop px-price-editor px-price-pop-fixed',
        ref: popRef,
        role: 'dialog',
        'aria-label': `改单价：${rollup}`,
        style: pos === null
          ? { visibility: 'hidden' }
          : { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` },
      },
      h('p', { className: 'px-price-pop-title' },
        h('b', null, label ?? rollup),
        h('code', { className: 'px-muted' }, rollup)),
      h(PriceFields, { draft: draft ?? EMPTY_DRAFT, onChange: setDraft }),
      errors.length > 0
        ? h('ul', { className: 'px-price-errors' }, errors.map((line) => h('li', { key: line }, line)))
        : null,
      notice !== '' ? h('p', { className: 'px-muted px-note' }, notice) : null,
      h('div', { className: 'px-price-actions' },
        h('button', { type: 'button', className: 'px-btn small primary', disabled: saving, onClick: submit },
          saving ? '保存中…' : '保存这条'),
        h('span', { className: 'px-muted px-note' }, '保存后不再标「估算价」'))),
      document.body)
    : null)

  /**
   * 开关浮层。
   *
   * **打开时立刻量一次锚点**（用事件目标，而不是等 effect）：effect 要等这一帧画完，
   * 期间浮层是 `visibility: hidden`；万一测量失败（父级未挂载、容器 0 宽等），
   * 它会**一直**不可见。点击时同步拿到矩形，至少保证可见且落在按钮附近。
   * @param {object} [event] - 点击事件（可选，测试里可能不给）。
   */
  const toggle = (event) => {
    const next = !open
    setOpen(next)
    setErrors([])
    setNotice('')
    if (!next) return
    // 同步定位：拿按钮矩形算一次，作为 effect 之前的兜底。
    const target = event?.currentTarget ?? wrapRef.current
    if (target !== null && target !== undefined && typeof window !== 'undefined') {
      const rect = target.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) {
        const width = Math.min(360, Math.max(260, window.innerWidth - 32))
        const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
        const room = window.innerHeight - rect.bottom
        const top = room < 320 ? Math.max(12, rect.top - 312) : rect.bottom + 6
        setPos({ left, top, width })
      }
    }
    // 打开时按**当前生效价**预填，并把宿主里的覆盖值叠上去（有的话）。
    // `draftOf` 可能给出空值，那也要能打开（空表单可编辑，不是不显示）。
    setDraft(draftOf(editableRate(props?.rate)) ?? EMPTY_DRAFT)
    fetchRates()
      .then((status) => {
        const mine = status?.rates?.[rollup]
        if (mine !== undefined) setDraft(draftOf(editableRate(mine)) ?? EMPTY_DRAFT)
      })
      .catch(() => { /* 老宿主没有这条路由：就用生效价预填 */ })
  }

  const submit = async () => {
    const entry = entryOfDraft(draft ?? {}, props?.rate)
    if (entry === undefined) {
      setErrors(['至少填「未命中」或「输出」其中一档'])
      return
    }
    setSaving(true)
    setErrors([])
    try {
      // **不能**在取不到宿主状态时拿空 rates 去提交：那会把别的覆盖条目整批删掉。
      // 读不到就明说，而不是「保存成功」了一个只剩一条的文件。
      const status = await fetchRates()
      const doc = draftDocument(status, props?.pricing)
      doc.rates[rollup] = entry
      // 界面上不再有倍率入口，但保存整份文档时要把它原样带回去（否则会清空）。
      if (doc.markup === null || typeof doc.markup !== 'object') {
        doc.markup = props?.markup !== null && typeof props?.markup === 'object' ? props.markup : {}
      }
      const response = await saveRates(doc)
      setNotice(response?.persisted === false ? '已生效，但没能写进文件' : '已保存')
      if (typeof onSaved === 'function') onSaved(response)
      setOpen(false)
    } catch (error) {
      setErrors(errorLines(error))
    } finally {
      setSaving(false)
    }
  }

  return h('span', { className: 'px-price-fix', ref: wrapRef },
    h('button', {
      type: 'button',
      // 这是一枚**次要操作**（只是修正一个单价），不该长得和「保存」一样重。
      // 早先是 px-btn small（有边框有阴影），在费用明细里每行一枚，整列都是按钮，
      // 观感很吵（用户原话「这个按钮很丑」）。改成链接式小按钮：无底无边，
      // 只在悬停时出现下划线。
      className: 'px-fix-link',
      title: '这个模型的实际单价与官方价目不同？点这里改成你的价',
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      onClick: toggle,
    }, open ? '收起' : '改单价'),
    popoverOf())
}

			exports.PriceSettingsView = PriceSettingsView
			exports.PriceSettingsButton = PriceSettingsButton
		},
		"./accountPanel.js": (exports, require) => {
			const m1 = require("./plans.js")
			/**
 * 「套餐余额」板块（看板里那一段卡片网格）。
 *
 * ## 它只做一件事：把第三方套餐的余额摊开
 *
 * 现金余额只接 DeepSeek 官方，由看板上独立的小板块呈现；本组件只渲染
 * **订阅套餐额度**。两笔账的单位互不相通（积分 / 美元信用额 / 百分比），
 * 因此这里不做任何换算、也不做跨厂商汇总——那会得到一个比没有数字更误导的结果。
 *
 * ## 为什么是「一家一张卡」
 *
 * 早先的形态是一叠标签页，一次只显示一家：多配两家之后，用户想比一眼
 * 「哪家快用完了」得来回点。现在每家一张卡、按网格平铺，一屏就能横向比较；
 * 没配过凭据的厂商收进底部的「添加厂商」折叠区，不占版面。
 *
 * 卡片内部左环右条：
 *   - 左：环形条画「总余额」。只给百分比的厂商用**剩余百分比**当环（已用越少环越长），
 *     中心是大号数字 + 一行小字（剩余 / 已超限）。
 *   - 右：每个额度窗口一行（5 小时 / 每周 / 每月 / 预算…），细进度条 + 已用百分比
 *     + 重置倒计时。窗口竖向排列。
 *   - 底部一个折叠入口「凭据与开关」：多数人配一次就不再动，不该一直占版面。
 *
 * ## 组件边界（契约，dashboard 按原样传 props）
 *
 * **本组件不发请求、不读存储。** 取数与写回都在看板那一层：
 *
 * ```js
 * AccountPanel({
 *   balance, balanceError, balanceBusy, onToggleBalance,   // 现金余额已移走，这里只接收不使用
 *   plans, plansError, plansBusy, onTogglePlans,
 *   credentials, credentialsError, onRemoved,
 *   now, timeZone, selectedPlan, onSelectPlan,
 * })
 * ```
 *
 * balance* 这几项保留在签名里只为兼容看板的调用（那里仍在取数），本组件不再渲染它们。
 *
 * ## 数字口径（不许改）
 *
 * 缺失显示 `—`、不显示 0；百分比可以超过 100 并标「已超限」；只给剩余额度的窗口
 * 不画假 0%，环与条留空并写明原因。
 * @module dsh-pixel-dashboard/client/accountPanel
 */

const React = require('react')
const allProviders = m1.allProviders
const credentialFiles = m1.credentialFiles
const credentialRows = m1.credentialRows
const formatResetLine = m1.formatResetLine
const orderWindows = m1.orderWindows
const partitionProviders = m1.partitionProviders
const providerStatus = m1.providerStatus
const quotaTone = m1.quotaTone
const shapeText = m1.shapeText
const vendorCredentialHint = m1.vendorCredentialHint
const vendorLinkOf = m1.vendorLinkOf
const vendorShape = m1.vendorShape
const vendorVerification = m1.vendorVerification
const windowProgress = m1.windowProgress
const VENDOR_SHORT = m1.VENDOR_SHORT
const { createElement: h, useMemo, useState } = React

/**
 * 环形条的直径与描边宽度（px）。
 *
 * 76 是上限：再大就会把右侧的窗口行挤到两行以下，而「一屏横向比较」正是这张卡存在的理由。
 */
const RING_SIZE = 76
const RING_STROKE = 8
/** 半径 =（直径 − 描边）/ 2：描边是居中压在圆周上的，减掉一整条才不会溢出视口。 */
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
/** 周长：dasharray 的「满环」长度。 */
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 窗口种类 → 兜底名字（宿主没给 label 时才用）。 */
const WINDOW_NAME = {
  fiveHour: '5 小时',
  weekly: '每周',
  monthly: '每月',
  budget: '预算',
}

/**
 * 一家厂商「配过还是没配过」。
 *
 * 判据是**有没有配过**，不是「成功还是失败」：`no-key` 是从没配过（可以收起来），
 * `rejected` / `request-failed` 是配过了但坏了（必须留在显眼处——那正是要看原因的时候）。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {boolean} 是否已配置过。
 */
function isConfigured(provider) {
  return provider?.ok === true || (provider?.ok !== true && provider?.reason !== 'no-key')
}

/**
 * 一家厂商在窄位置用的短名。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {string} 短名。
 */
function shortNameOf(provider) {
  const id = provider?.id
  if (typeof id === 'string' && VENDOR_SHORT[id] !== undefined) return VENDOR_SHORT[id]
  const name = provider?.name
  if (typeof name === 'string' && name !== '') return name
  return typeof id === 'string' ? id : '未知厂商'
}

/**
 * 状态徽标的文案与色调。
 *
 * 只说「可用 / 无额度 / 未配置 / 凭据被拒 / 取数失败」几档，细节原因另起一行写，
 * 不把一整段排查建议塞进徽标。
 *
 * `ok: true` 但一个窗口都没有的那一家单独给「无额度」：接口成功、额度却是空的
 * （套餐没生效、或接口改了形状）。把它算成「可用」会让用户以为是自己的错觉。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {{text:string,tone:'ok'|'warn'|'error'}} 徽标。
 */
function statusOf(provider) {
  if (provider?.ok === true) {
    const windows = Array.isArray(provider.windows) ? provider.windows : []
    return windows.length === 0
      ? { text: '无额度', tone: 'warn' }
      : { text: '可用', tone: 'ok' }
  }
  if (provider?.reason === 'no-key') return { text: '未配置', tone: 'warn' }
  if (provider?.reason === 'rejected') return { text: '凭据被拒', tone: 'error' }
  return { text: '取数失败', tone: 'error' }
}

/**
 * 核验级别的极简标注：一方核验 / 社区核验，解释放 title。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {{text:string,title:string}} 标注。
 */
function verificationOf(provider) {
  if (vendorVerification(provider) === 'community') {
    return {
      text: '社区核验',
      title: '端点来自社区逆向实现，没有官方文档或官方源码出处，可能随时失效',
    }
  }
  return { text: '一方核验', title: '端点来自官方文档，或官方 CLI / 客户端自己的源码' }
}

/**
 * 把一家的窗口压成「环形条要显示的那一个数」。
 *
 * 三条规则，都是为了不撒谎：
 *   1. 有百分比 → 取**最紧**的那个窗口（已用最多）画环：环长 = 剩余百分比。
 *      选最紧的是因为用户真正关心的是「哪个快用完了」，而一家的总余额由最紧的那个窗口决定。
 *   2. 只有剩余额度（没有百分比）→ 环留空（弧长 0），中心显示剩余额本身，
 *      绝不补一条 0% 的环。
 *   3. 什么都没有 → 中心 `—`、标签「无额度」。
 * @param {object[]} windows - 宿主返回的窗口。
 * @returns {{kind:'percent'|'amount'|'none',ratio:number,value:string,label:string,tone:string}} 摘要。
 */
function summarizeWindows(windows) {
  let tightest
  let amount
  for (const win of Array.isArray(windows) ? windows : []) {
    const progress = windowProgress(win)
    if (!progress.usable) continue
    if (progress.percentKnown) {
      if (tightest === undefined || progress.percent > tightest.percent) tightest = progress
      continue
    }
    if (amount === undefined && progress.remainingText !== '—') amount = progress
  }
  if (tightest !== undefined) {
    const remaining = Math.max(0, 100 - tightest.percent)
    return {
      kind: 'percent',
      ratio: remaining / 100,
      value: `${Math.round(remaining)}%`,
      label: tightest.over ? '已超限' : '剩余',
      tone: quotaTone(tightest.percent, tightest.over),
    }
  }
  if (amount !== undefined) {
    return { kind: 'amount', ratio: 0, value: amount.remainingText, label: '剩余', tone: 'none' }
  }
  return { kind: 'none', ratio: 0, value: '—', label: '无额度', tone: 'none' }
}

/**
 * 状态行（读中 / 失败 / 已关闭）。
 * @param {object} props - level / text。
 * @returns {object|null} React 元素。
 */
function StateLine(props) {
  const { level, text } = props
  if (typeof text !== 'string' || text === '') return null
  return h('p', { className: `px-acc-state px-acc-${level}` }, text)
}

/**
 * 环形条（总余额）。
 *
 * 用内联 SVG 的 **stroke-dasharray** 画弧，不用 CSS conic-gradient：
 *   - 弧长就是 `周长 × 剩余比例`，超过 100% 时夹到满环，数字仍照实显示；
 *   - 刻意**不写** `preserveAspectRatio`：这里要的就是 viewBox 自带的等比行为，
 *     写死任何一个值都会在非正方形容器里把圆压成椭圆。
 * 中心的大号数字画在 SVG 之外（绝对定位居中）：SVG 里的 `<text>` 在深色模式下
 * 拿不到 CSS 令牌，字号也不受页面缩放控制。
 * @param {object} props - balance（{@link summarizeWindows} 的结果）。
 * @returns {object} React 元素。
 */
function BalanceRing(props) {
  const { balance } = props
  const alert = balance.tone === 'red'
  const center = RING_SIZE / 2
  const arc = Math.max(0, Math.min(1, balance.ratio)) * RING_CIRCUMFERENCE
  return h('div', { className: 'px-acc-ring' },
    h('svg', {
      className: 'px-acc-ring-svg',
      viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`,
      role: 'img',
      'aria-label': `总余额：${balance.label} ${balance.value}`,
    },
      h('circle', { className: 'px-acc-ring-track', cx: center, cy: center, r: RING_RADIUS }),
      // 弧长为 0 时**不画**这个圆：长度为 0 的 dash 在某些渲染器上会画出一条圆头小点，
      // 看起来就像「还剩一点点」。
      arc <= 0
        ? null
        : h('circle', {
          className: `px-acc-ring-fill${alert ? ' px-acc-ring-alert' : ''}`,
          cx: center,
          cy: center,
          r: RING_RADIUS,
          strokeDasharray: `${arc.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
          transform: `rotate(-90 ${center} ${center})`,
        })),
    h('div', { className: 'px-acc-ring-center' },
      h('span', {
        className: `px-acc-ring-value${balance.value.length > 4 ? ' long' : ''}`,
      }, balance.value),
      h('span', { className: 'px-acc-ring-label' }, balance.label)))
}

/**
 * 一个额度窗口：窗口名 + 细进度条 + 已用百分比 + 重置倒计时 + 一行脚注。
 *
 * **百分比未知时数字画 `—`、进度条不画**：一条 0% 的空条看起来像「一点没用」，
 * 而事实是「不知道」。百分比可以超过 100（额度用超时官方就这么给），数字照实显示，
 * 只有条的宽度夹到 100——把 140% 显示成 100% 等于把「严重超限」伪装成「刚好用满」。
 * @param {object} props - win / now / timeZone。
 * @returns {object} React 元素。
 */
function WindowRow(props) {
  const { win, now, timeZone } = props
  const progress = windowProgress(win)
  const tone = quotaTone(progress.percent, progress.over)
  const reset = formatResetLine(win?.resetAt, now, timeZone)
  const label = win?.label ?? WINDOW_NAME[win?.window] ?? win?.window ?? '额度'
  const parts = []
  if (progress.remainingText !== '—') parts.push(`剩余 ${progress.remainingText}`)
  if (progress.totalText !== '—') parts.push(`上限 ${progress.totalText}`)
  if (!progress.usable) parts.push('官方没有返回这一项的数值')
  else if (!progress.percentKnown) {
    // 只给余额的窗口（Command Code 的月度就是这样）：条与环都留空，
    // 但必须写出「为什么没有百分比」，否则空条会被读成「一点没用」。
    parts.push(progress.note === '' ? '官方只报了余额，没有已用额度' : progress.note)
  }
  if (reset !== undefined) parts.push(reset)

  return h('div', { className: 'px-acc-win' },
    h('div', { className: 'px-acc-win-head' },
      h('span', { className: 'px-acc-win-name' }, label),
      h('span', {
        className: `px-acc-win-used${tone === 'red' ? ' alert' : ''}`,
      }, progress.percentKnown ? `已用 ${progress.percent.toFixed(1)}%` : '已用 —'),
      progress.over ? h('span', { className: 'px-acc-win-over' }, '已超限') : null),
    h('div', { className: 'px-acc-win-track' },
      progress.percentKnown
        ? h('span', {
          className: `px-acc-win-fill${tone === 'red' ? ' alert' : ''}`,
          style: { width: `${progress.barPercent}%` },
        })
        : null),
    parts.length === 0 ? null : h('div', { className: 'px-acc-win-foot' }, parts.join(' · ')))
}

/**
 * 「这家凭据怎么配」：去哪拿 + 拿到后放哪 + 自动发现的文件。
 *
 * 三件事缺一件用户就会卡住：
 *   1. 去哪拿（可点链接 + 步骤）；
 *   2. 拿到后写进哪里（凭据文件**绝对路径** + 引用名）——DSH 设置里没有通用凭据
 *      编辑器，所以路径必须写出来；
 *   3. 插件还会自动读哪些本机文件（只读、不删），否则「我没配怎么有数字」无法解释。
 *
 * 缺凭据时**默认展开**（那正是用户需要它的时刻），配好就折叠。
 * @param {object} props - setup / credentialFile / files / open。
 * @returns {object|null} React 元素。
 */
function SetupHelp(props) {
  const { setup, credentialFile, files, open } = props
  if (setup === null || typeof setup !== 'object') return null
  const acquire = Array.isArray(setup.acquire) ? setup.acquire : []
  const refs = Array.isArray(setup.refs) ? setup.refs : []
  const discovered = Array.isArray(files) ? files : []
  const file = typeof credentialFile === 'string' ? credentialFile : ''
  if (acquire.length === 0 && refs.length === 0 && discovered.length === 0) return null
  const link = typeof setup.keyURL === 'string' && setup.keyURL !== '' ? setup.keyURL : ''
  const linkName = typeof setup.keyURLName === 'string' && setup.keyURLName !== ''
    ? setup.keyURLName
    : '打开创建页'

  return h('details', { className: 'px-details px-plan-setup px-acc-setup', open: open === true },
    h('summary', null, '这家凭据怎么配'),
    acquire.length === 0
      ? null
      : h('ol', { className: 'px-acc-steps' },
        acquire.map((step, index) => h('li', { key: index }, step))),
    // 入口只在**展开时**画在这里：`<details>` 折叠时子节点仍在 DOM 里，
    // 无条件渲染会与页脚那一个入口重复，同一块里两个同样的链接会让「点哪个」变成问题。
    open !== true || link === ''
      ? null
      : h('p', { className: 'px-acc-setup-link' },
        h('a', { href: link, target: '_blank', rel: 'noreferrer' }, `${linkName} ↗`)),
    refs.length === 0
      ? null
      : h('div', { className: 'px-acc-setup-where' },
        h('p', null, '把下面这些项写进 DSH 凭据文件（或设成同名环境变量）：'),
        file === '' ? null : h('code', { className: 'px-plan-setup-path px-acc-setup-path' }, file),
        h('ul', { className: 'px-acc-setup-refs' },
          refs.map((item) => h('li', { key: item.name },
            h('code', null, `${item.name}: ${item.example === '' ? '…' : item.example}`),
            item.note === '' ? null : h('span', { className: 'px-acc-setup-note' }, item.note))))),
    discovered.length === 0
      ? null
      : h('div', { className: 'px-acc-files' },
        h('p', null, '插件还会自动读这些本机文件（只读、不写、不删）：'),
        h('ul', { className: 'px-acc-file-list' },
          discovered.map((item) => h('li', { key: item.path },
            h('code', { className: 'px-acc-file-path' }, item.path),
            // 「在不在」只有真的查过才敢说：凭据清单没拿到时 present 是 undefined，
            // 那时**不画**这个标记（画成「不存在」就是在陈述我们并不知道的事实）。
            item.present === true || item.present === false
              ? h('span', { className: `px-acc-file-flag${item.present ? ' present' : ''}` },
                item.present ? '存在' : '不存在')
              : null,
            item.note === '' ? null : h('span', { className: 'px-acc-setup-note' }, item.note))))),
    h('p', { className: 'px-acc-setup-hint' },
      '凭据文件改完由 DSH 自动重载，不用重启；环境变量则要写进 ',
      h('code', null, '<DSH_HOME>/.env'),
      ' 或启动 dsh 前 export，然后重启 dsh 才生效。'))
}

/**
 * 「移除凭据」：勾选 + 二次确认。
 *
 * 删的是用户的密钥且不可撤销，因此**默认一条都不勾**，第一次点只进入确认态列出
 * 将删的名字，第二次才真的发请求。来自启动环境变量或 `.env` 回落层的名字
 * **禁用勾选**（`unset` 对它们无效或会被上游拒绝），操作原因直接写在行上。
 *
 * 另有一类只读文件：别人的 App 的登录文件，插件永远不删，但要列出来——
 * 不说的话，用户清完凭据文件里那把之后插件照样能读到，「已移除」就是假的。
 * @param {object} props - credentials / vendorId / credentialFile / onRemoved。
 * @returns {object|null} React 元素。
 */
function CredentialSection(props) {
  const { credentials, vendorId, credentialFile, vendorName, onRemoved } = props
  const [checked, setChecked] = useState({})
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState([])

  const rows = useMemo(() => credentialRows(credentials, vendorId), [credentials, vendorId])
  const files = useMemo(() => credentialFiles(credentials, vendorId), [credentials, vendorId])
  const selected = rows.filter((row) => row.selectable && checked[row.ref?.name] === true)
  const configured = rows.filter((row) => row.ref?.configured === true)

  if (credentials === null || credentials === undefined) return null
  if (rows.length === 0) return null

  const toggle = (name) => {
    setConfirming(false)
    setChecked((prev) => ({ ...prev, [name]: prev[name] !== true }))
  }

  const submit = async () => {
    if (selected.length === 0) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    try {
      const result = typeof onRemoved === 'function'
        ? await onRemoved(selected.map((row) => row.ref.name))
        : undefined
      const results = Array.isArray(result?.results) ? result.results : []
      setMessages(results.map((item) => ({
        ok: item.ok === true,
        text: `${item.name}：${item.message ?? (item.ok === true ? '已移除。' : '未移除。')}`,
      })))
      setChecked({})
      setConfirming(false)
    } catch (error) {
      setMessages([{ ok: false, text: error instanceof Error ? error.message : String(error) }])
    } finally {
      setBusy(false)
    }
  }

  const writable = credentials.writable === true

  return h('details', { className: 'px-details px-acc-remove' },
    h('summary', null, `移除${vendorName === '' ? '' : ` ${vendorName} `}的凭据`),
    !writable
      ? h('p', { className: 'px-acc-note' },
        '这台机器上宿主没有可写的凭据服务，因此这里只能查看、不能移除。')
      : null,
    h('ul', { className: 'px-acc-ref-list' },
      rows.map((row) => h('li', { key: row.ref.name, className: 'px-acc-ref-row' },
        h('label', { className: 'px-acc-ref-label' },
          h('input', {
            type: 'checkbox',
            checked: checked[row.ref.name] === true,
            disabled: !row.selectable || !writable || busy,
            onChange: () => toggle(row.ref.name),
          }),
          h('code', null, row.ref.name),
          h('span', { className: 'px-acc-ref-purpose' }, row.ref.purpose ?? '')),
        h('span', { className: 'px-acc-ref-source' },
          row.ref.configured === true
            ? `已配置 · ${row.ref.sourceLabel || row.ref.source || '未知来源'}${row.ref.hint === '' ? '' : ` · ${row.ref.hint}`}`
            : '未配置'),
        row.ref.selectable !== true && row.ref.configured === true
          ? h('span', { className: 'px-acc-ref-blocked' }, row.ref.blockedReason || '这一条不能由插件移除')
          : null))),
    files.length === 0
      ? null
      : h('ul', { className: 'px-acc-ref-list px-acc-ref-files' },
        files.map((file) => h('li', { key: file.path, className: 'px-acc-ref-row' },
          h('code', null, file.path),
          h('span', { className: 'px-acc-ref-source' }, file.present ? '存在（插件不删它）' : '不存在'),
          file.note === '' ? null : h('span', { className: 'px-acc-ref-blocked' }, file.note)))),
    configured.length === 0 && files.length === 0
      ? null
      : h('div', { className: 'px-acc-remove-actions' },
        h('button', {
          type: 'button',
          className: `px-acc-btn${confirming ? ' danger' : ''}`,
          disabled: selected.length === 0 || busy || !writable,
          onClick: submit,
        }, confirming ? `确认移除 ${selected.length} 条` : '移除勾选的凭据'),
        confirming
          ? h('button', {
            type: 'button',
            className: 'px-acc-btn ghost',
            disabled: busy,
            onClick: () => { setConfirming(false); setChecked({}) },
          }, '取消')
          : null),
    confirming
      ? h('p', { className: 'px-acc-confirm' },
        `将删除：${selected.map((row) => row.ref.name).join('、')}。这一步不可撤销。`)
      : null,
    messages.length === 0
      ? null
      : h('ul', { className: 'px-acc-remove-result' },
        messages.map((item, index) => h('li', {
          key: index,
          className: item.ok ? 'px-acc-ok' : 'px-acc-bad',
        }, item.text))),
    credentialFile === '' || credentialFile === undefined
      ? null
      : h('p', { className: 'px-acc-note' }, '可移除的凭据只来自 DSH 凭据文件：',
        h('code', { className: 'px-acc-setup-path' }, credentialFile)))
}

/**
 * 合并「宿主 setup 里列出的文件」与「凭据清单里查到的文件」。
 *
 * 两处的来源不同：`provider.setup.files` 是**取数时**就带下来的路径（一定有），
 * `credentials.providers[].files` 是**查清单时**才有的，多带一个 `present`。
 * 只取其一都会缺一半信息：前者没有「在不在」，后者在凭据路由不可用时整个没有。
 * 合并后按路径去重，凭据那份优先（它更详细）。
 * @param {Array<{path:string,present?:boolean,note:string}>} resolvedFiles - 凭据清单里的文件。
 * @param {Array<{path:string,note:string}>} setupFiles - setup 块里的文件。
 * @returns {Array<{path:string,present:boolean|undefined,note:string}>} 合并结果。
 */
function mergeFiles(resolvedFiles, setupFiles) {
  const out = []
  const seen = new Set()
  for (const file of Array.isArray(resolvedFiles) ? resolvedFiles : []) {
    if (typeof file?.path !== 'string' || file.path === '' || seen.has(file.path)) continue
    seen.add(file.path)
    out.push({ path: file.path, present: file.present, note: typeof file.note === 'string' ? file.note : '' })
  }
  for (const file of Array.isArray(setupFiles) ? setupFiles : []) {
    if (typeof file?.path !== 'string' || file.path === '' || seen.has(file.path)) continue
    seen.add(file.path)
    out.push({ path: file.path, present: undefined, note: typeof file.note === 'string' ? file.note : '' })
  }
  return out
}

/**
 * 一家厂商要配的凭据名（用于「添加厂商」那一行）。
 *
 * 优先取宿主给的候选名列表的第一个（那是插件真正会先试的那一个），
 * 其次取 setup 里第一个 refs 的名字，最后退回 `keyRef`。
 * 写出来的用处很直接：用户不用点开就知道要往凭据文件里加哪一行。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {string} 凭据引用名；都没有时是空串。
 */
function primaryRefOf(provider) {
  const list = Array.isArray(provider?.keyRefs) ? provider.keyRefs : []
  const first = list.find((name) => typeof name === 'string' && name !== '')
  if (first !== undefined) return first
  const refs = Array.isArray(provider?.setup?.refs) ? provider.setup.refs : []
  const fromSetup = refs.find((item) => typeof item?.name === 'string' && item.name !== '')
  if (fromSetup !== undefined) return fromSetup.name
  return typeof provider?.keyRef === 'string' ? provider.keyRef : ''
}

/**
 * 一家厂商的卡片：左环（总余额）+ 右条（每个窗口一行）+ 底部折叠的凭据与开关。
 *
 * @param {object} props - provider / now / timeZone / credentialFile / credentials /
 *   credentialsError / onRemoved / selectedPlan / onSelectPlan /
 *   plansEnabled / plansLocked / onTogglePlans。
 * @returns {object} React 元素。
 */
function AccountCard(props) {
  const {
    provider, now, timeZone, credentialFile, credentials, credentialsError,
    onRemoved, selectedPlan, onSelectPlan, plansEnabled, plansLocked, onTogglePlans,
  } = props
  const status = statusOf(provider)
  const verification = verificationOf(provider)
  const windows = orderWindows(provider?.windows)
  const balance = summarizeWindows(windows)
  const setup = provider?.setup
  const files = mergeFiles(credentialFiles(credentials, provider?.id), setup?.files)
  const link = vendorLinkOf(provider)
  const monitored = selectedPlan === provider?.id
  const needsKey = provider?.ok !== true && provider?.reason === 'no-key'

  // 详细原因（鉴权被拒 / 取数失败 / 缺哪个凭据名）单独一行，只有出问题时才出现。
  const detail = status.tone === 'ok' ? '' : providerStatus(provider).text
  // 凭据要求那句话：宿主 setup 里有了就以它为准（更具体），否则用回落表。
  // 两种来源都必须有——用户最容易错的地方各不相同（智谱要套餐专属 Key、
  // 火山要 AK/SK、Codex/Cursor 要登录态 token），留空等于把这一步留给他猜。
  const hasSetupSteps = Array.isArray(setup?.acquire) && setup.acquire.length > 0
  const credentialHint = hasSetupSteps ? '' : vendorCredentialHint(provider)
  const note = typeof provider?.note === 'string' && provider.note !== '' ? provider.note : ''

  return h('article', { className: 'px-acc-card', 'data-vendor': provider?.id },
    // 卡头固定两行：第一行「是谁」，第二行「什么状态、口径可不可信」。
    // 排成一行让它们自己换行的话，长厂商名加两枚徽标会随机折成两三行，
    // 三张卡并排时卡头高度各不相同，看起来像没对齐。
    h('header', { className: 'px-acc-card-head' },
      h('div', { className: 'px-acc-card-id' },
        h('b', { className: 'px-acc-plan-name px-plan-name' }, provider?.name ?? '未知厂商'),
        // 监看开关做成一颗**无边框的小字按钮**：它是偏好，不是每张卡的主要动作。
        // 做成描边按钮会和状态徽标抢位置。
        h('button', {
          type: 'button',
          className: `px-acc-monitor${monitored ? ' active' : ''}`,
          'aria-pressed': monitored ? 'true' : 'false',
          title: monitored
            ? '费用条与侧栏会优先显示这一家的额度；再点一次回到「自动（最紧）」'
            : '设为监看：费用条与侧栏优先显示这一家的额度',
          onClick: () => {
            if (typeof onSelectPlan !== 'function') return
            // 再点一次取消监看，回到「自动（最紧）」——否则用户回不到自动模式。
            onSelectPlan(monitored ? undefined : provider?.id)
          },
        }, monitored ? '监看中' : '监看')),
      h('div', { className: 'px-acc-card-meta' },
        provider?.plan === undefined || provider?.plan === '' ? null : h('span', { className: 'px-badge' }, provider.plan),
        // 状态徽标：note 挂在 title 上（对「可用」的家它只是口径补充，
        // 不该再占一整行；对失败的家真正的原因走下面那行）。
        h('span', {
          className: `px-badge px-acc-badge-${status.tone}`,
          title: note === '' ? undefined : note,
        }, status.text),
        h('span', { className: 'px-acc-verif', title: verification.title }, verification.text))),

    detail === '' ? null : h('p', { className: `px-acc-reason px-acc-reason-${status.tone}` }, detail),

    h('div', { className: 'px-acc-card-body' },
      h(BalanceRing, { balance }),
      windows.length === 0
        ? h('p', { className: 'px-acc-empty' },
          needsKey
            ? '还没有可显示的额度：先展开下面的「凭据与开关」配好凭据。'
            : '还没有可显示的额度（原因见上）。')
        : h('div', { className: 'px-acc-wins' },
          windows.map((win) => h(WindowRow, {
            key: `${win.window}:${win.label}`,
            win,
            now,
            timeZone,
          })))),

    // 「凭据与开关」默认收起：多数人配一次就不再动，展开它就等于每张卡都摊着
    // 一段凭据说明——那正是上一版被嫌乱的原因。**缺凭据的那一家除外**：
    // 那时用户正需要配法，折叠起来只是多一次点击。
    h('details', { className: 'px-details px-acc-config', open: needsKey === true },
      h('summary', null, '凭据与开关'),
      h('div', { className: 'px-acc-config-body' },
        credentialHint === ''
          ? null
          : h('p', { className: 'px-acc-note px-acc-cred-hint' }, `凭据要求：${credentialHint}`),
        h(SetupHelp, { setup, credentialFile, files, open: false }),
        credentialsError === '' || credentialsError === undefined
          ? null
          : h(StateLine, { level: 'error', text: `凭据清单读取失败：${credentialsError}` }),
        h(CredentialSection, {
          credentials,
          vendorId: provider?.id,
          vendorName: provider?.name ?? '',
          credentialFile,
          onRemoved,
        }),
        h('div', { className: 'px-acc-config-foot' },
          h('label', { className: 'px-acc-toggle' },
            h('input', {
              type: 'checkbox',
              checked: plansEnabled !== false,
              disabled: plansLocked === true,
              onChange: (event) => {
                if (typeof onTogglePlans === 'function') onTogglePlans(event.target.checked)
              },
            }),
            h('span', null, plansEnabled === false ? '套餐查询已关闭' : '套餐查询已开启')),
          provider?.endpoint === undefined
            ? null
            : h('span', {
              className: 'px-acc-endpoint',
              title: '未文档化的内部接口，可能随官方改动失效',
            }, `数据源 ${provider.endpoint}`),
          link === undefined
            ? null
            : h('a', { href: link.href, target: '_blank', rel: 'noreferrer' }, link.label)))))
}

/**
 * 「添加厂商」：没配过凭据的家收在这里，点开就能看用途与配法。
 *
 * 为什么不删掉它们：插件支持哪些家、每家怎么配，是用户装之前就要查得到的信息。
 * 它们只是不该在配好之前占版面。
 * @param {object} props - providers / credentialFile / credentials / defaultOpen。
 * @returns {object|null} React 元素。
 */
function AddVendorSection(props) {
  const { providers, credentialFile, credentials, defaultOpen } = props
  if (!Array.isArray(providers) || providers.length === 0) return null
  return h('details', { className: 'px-details px-acc-add', open: defaultOpen === true },
    h('summary', null, `添加厂商（还有 ${providers.length} 家未配置的厂商）`),
    // 一家都没配时上面是空的：这时必须有一句解释，否则新用户会以为面板坏了。
    defaultOpen === true
      ? h('p', { className: 'px-acc-note px-acc-add-hint' },
        '配好凭据即可查看额度：每一家的「查看怎么配」里都写明了去哪拿、以及要写进这台机器上的哪个文件。')
      : null,
    h('ul', { className: 'px-acc-add-list' },
      providers.map((provider) => {
        const files = mergeFiles(credentialFiles(credentials, provider?.id), provider?.setup?.files)
        const link = vendorLinkOf(provider)
        const ref = primaryRefOf(provider)
        const setup = provider?.setup
        const steps = Array.isArray(setup?.acquire) ? setup.acquire.length : 0
        const refs = Array.isArray(setup?.refs) ? setup.refs.length : 0
        // 宿主没给 setup 块时也要有个入口（旧宿主只有 keyRef）。三条来源全空时
        // 不画一个点开是空的折叠区，而是照实说明「没有配法说明」——空折叠区
        // 会让用户以为是自己点错了。
        const hasSetup = setup !== null && typeof setup === 'object'
          && steps + refs + files.length > 0
        // setup 已经写清了怎么配时不再叠加回落表那句：同一块里说两遍
        // （一处更具体、一处更笼统）只会让人怀疑哪个才算数。
        const hint = steps > 0 ? '' : vendorCredentialHint(provider)
        return h('li', { key: provider.id, className: 'px-acc-add-row' },
          h('div', { className: 'px-acc-add-main' },
            h('b', null, shortNameOf(provider)),
            h('span', { className: 'px-acc-add-note' },
              shapeText(vendorShape(provider)) || '订阅套餐额度'),
            // 要配的引用名直接写出来：不点开也知道要往凭据文件里加哪一行。
            ref === '' ? null : h('code', { className: 'px-acc-add-ref' }, ref)),
          hint === '' ? null : h('span', { className: 'px-acc-add-hint-text' }, hint),
          !hasSetup && link === undefined
            ? h('span', { className: 'px-acc-add-note' }, '插件没有提供这一家的配法说明（宿主版本可能较旧）。')
            : h('details', { className: 'px-acc-add-setup' },
              h('summary', null, '查看怎么配'),
              h(SetupHelp, { setup, credentialFile, files, open: false }),
              link === undefined
                ? null
                : h('p', { className: 'px-acc-setup-link' },
                  h('a', { href: link.href, target: '_blank', rel: 'noreferrer' }, link.label))))
      }))
  )
}

/**
 * 「套餐余额」整段：标题 + 每张厂商卡 + 添加厂商 + 一句免责。
 *
 * 现金余额不在这里：它只接 DeepSeek 官方，由看板上独立的小板块呈现。
 * @param {object} props - 见文件头的契约。
 * @returns {object} React 元素。
 */
function AccountPanel(props) {
  const {
    plans, plansError, plansBusy, onTogglePlans,
    credentials, credentialsError, onRemoved,
    now, timeZone, selectedPlan, onSelectPlan,
  } = props ?? {}

  const providers = useMemo(() => allProviders(plans), [plans])
  // 「当前监看」的那一家即使没配凭据也留在卡片区：用户刚在别处把它设成监看，
  // 这里却找不到它，是自相矛盾的界面。
  const { active, idle } = useMemo(
    () => partitionProviders(providers, { current: selectedPlan }),
    [providers, selectedPlan],
  )
  const configured = useMemo(() => active.filter((provider) => isConfigured(provider)), [active])

  // `plans === undefined` 与「取到了但一家都没有」是两件事：
  // 前者是**还没取到**（宿主在跑第一次聚合、或旧宿主没有这条路由），后者是
  // 确实一家都没配。混成一件会让用户在加载期看到「插件不支持任何厂商」。
  // 注意看板整页首次渲染时 plans / credentials / selectedPlan **都是 undefined**。
  const plansPending = plans === undefined && (plansError === undefined || plansError === '')
  // `plansError` 只要非空就要显示，**不管 `plans` 有没有到手**：
  // 缓存里可能还留着上一次成功的数据，而这一次请求已经失败了——那时只显示旧数据
  // 等于把「刚才失败了」藏起来。
  const plansFailed = typeof plansError === 'string' && plansError !== ''

  const plansEnabled = plans?.enabled !== false
  const plansLocked = plans?.lockedByEnv === true
  const credentialFile = credentials?.credentialFile

  return h('section', { className: 'px-acc px-card px-account px-account-grid' },
    h('div', { className: 'px-acc-head' },
      h('h3', { className: 'px-acc-title' }, '套餐余额'),
      active.length === 0
        ? null
        : h('span', { className: 'px-acc-count' }, `${active.length} 家`),
      plansBusy === true
        ? h('span', { className: 'px-acc-busy' }, '读取中…')
        : null),

    plansPending
      ? h(StateLine, { level: 'off', text: '套餐额度读取中…（首次打开要等宿主跑一次聚合）' })
      : null,
    plansFailed
      ? h(StateLine, { level: 'error', text: `套餐额度读取失败：${plansError}` })
      : null,
    plansEnabled === false
      ? h(StateLine, {
        level: 'off',
        text: plansLocked
          ? '套餐查询已被环境变量 DSH_PIXEL_PLANS 关闭'
          : '套餐查询已关闭：宿主不会向任何第三方端点发请求（可在各家的「凭据与开关」里重新打开）',
      })
      : null,

    active.length === 0
      ? null
      : h('div', { className: 'px-acc-cards' },
        active.map((provider) => h(AccountCard, {
          key: provider.id,
          provider,
          now,
          timeZone,
          credentialFile,
          credentials,
          credentialsError,
          onRemoved,
          selectedPlan,
          onSelectPlan,
          plansEnabled,
          plansLocked,
          onTogglePlans,
        }))),

    // 没配过的家收进「添加厂商」：默认折叠，点开能看每一家的用途与配法。
    // 一家都没配时**默认展开**——那时上面是空的，收起会让新用户什么都看不到。
    h(AddVendorSection, {
      providers: idle,
      credentialFile,
      credentials,
      defaultOpen: configured.length === 0 && providers.length > 0,
    }),

    providers.length === 0 && !plansPending && !plansFailed
      ? h('p', { className: 'px-acc-empty' }, '宿主没有返回任何厂商数据：插件或宿主版本可能不一致。')
      : null,

    // 唯一保留的免责：接口确实未文档化，这一句必须留着（一句话，不再占版面）。
    h('p', { className: 'px-acc-disclaimer' },
      h('span', {
        className: 'px-acc-disclaimer-mark',
        title: '各家用的是其前端 / CLI 自己在用的内部接口，官方没有文档保证；'
          + '一家失败只影响那一家，凭据只在本机使用。',
      }, 'ⓘ'),
      ' 接口未公开文档化，可能随官方改动失效。')
  )
}

			exports.AccountPanel = AccountPanel
		},
		"./sessionView.js": (exports, require) => {
			const m1 = require("./account.js")
			const m2 = require("./balance.js")
			const m3 = require("./format.js")
			const m4 = require("./plans.js")
			const m5 = require("./planView.js")
			const m6 = require("./sessionDetailView.js")
			/**
 * 会话标签页（`conversation.view` 槽位里的「费用」）。
 *
 * 定位：看板回答「全局花了多少、花在哪」；这一页回答「**这条会话**花了多少、
 * 花在哪些模型上、当前走的账户还剩多少」。它与输入框下方那枚费用条是同一份数据
 * 的摘要与明细关系——费用条是摘要，这里是完整明细。
 *
 * 数据来自宿主的 `GET /dsh-pixel/session?id=<sessionId>`（按会话 × 模型的逐条明细），
 * 而不是看板的全量 `/data`：后者不含按会话的模型明细（那会让响应体积翻几倍）。
 *
 * ## 版式：四行，彩色，不留空
 *
 * | 行 | 内容 | 为什么 |
 * |---|---|---|
 * | 1 | 四枚 hero：估算金额 / 总 Token / 模型耗时 / 工具调用 | 「图二」的主打指标，带语义色左边条 |
 * | 2 | 耗时堆叠条 + 计价时段 + 用量构成 | 等待模型(黄)/模型回复(蓝)/工具执行(绿)；右边两张并排填满 |
 * | 3 | 逐模型明细（通栏） | 钱具体花在哪几款模型上 |
 * | 4 | 逐日花费 + 账户 + 请求分布 | 三块并排，右侧不再有「第三行右边一大片空白」 |
 *
 * **行是写死的，列由媒体查询收缩**（见 `styles/session.js`）：早先用 `auto-fit`
 * 让宽度决定列数，于是某一行的卡片数量与列数对不上，右边空出半屏——用户的原话是
 * 「搞这么多空隙出来为什么」。
 *
 * ## 三层结构（服务端渲染闸门只能看到第一层，因此必须分层）
 *
 * | 层 | 谁 | 干什么 |
 * |---|---|---|
 * | {@link fetchSession} | 纯取数 | 只负责把 HTTP 的四种失败**分类**（见下），不做文案 |
 * | {@link sessionCostModel} | 纯函数 | 把宿主负载折成「这一页要显示的每个数字与每句说明」 |
 * | {@link SessionCostPanel} | 纯展示 | 只摆位置，一个数字都不算 |
 * | {@link SessionCostView} | 容器 | 取数、定时刷新、把余额/套餐与当前模型来源对上 |
 *
 * 这样拆是因为 `renderToStaticMarkup` **不执行 effect**：容器在闸门里永远停在
 * 「加载中」，若把文案与计算写在容器里，其余状态就永远没被验过。
 *
 * ## 明细留在内存里（用户：『每次读明细都要重新加载吗？』）
 *
 * {@link fetchSession} 带一层 60 秒的模块级缓存：切标签页、反复展开同一条会话都
 * 不再发作请求；刷新失败**不清掉旧值**（显示旧数字 + 一行「刷新失败」）。
 * 缓存放模块作用域是刻意的——看板「消费 Top 会话」的展开与这一页共用同一个
 * `fetchSession`，两处必须吃同一份，否则会漂移成「同一会话两处金额不同」。
 *
 * ## 四种降级必须都看得见
 *
 * | 状态 | 触发 | 必须说清的事 |
 * |---|---|---|
 * | `loading` | 首帧 / 还没回 | 正在读哪条会话 |
 * | `missing` | 404 且宿主答 `会话不存在` | 这条会话不在计费记录里（可能已删 / 只在别的设备） |
 * | `missing-route` | 404 但宿主没给 `会话不存在` | **旧宿主没有这条路由**——重启 dsh 才有 |
 * | `failed` | 500 / 网络错误 | 具体原因 + 可以重试 |
 *
 * 404 的两个含义**必须分开**：混成一句「取数失败」会让「升级插件」与「换一条会话」
 * 这两种完全不同的下一步动作变成一个猜谜。判据是宿主在 404 时有没有回
 * `{ error: '会话不存在' }`——旧宿主那条路由根本不存在，回的是网关的默认 404。
 *
 * ## 加法必须对得上（严格相等，不是近似）
 *
 * 页面上一共两个「合计」，都**只由它自己的明细行相加得到**：
 *   - 顶部「本次会话费用」= 逐模型金额之和（宿主保证与它自己的 `cost` 逐位相等）；
 *   - 逐日一节**不另立合计**，避免同一页出现两个可能差 10⁻⁶ 的总数（Lead 口径）。
 *
 * ## 缺失写 `—`，不写 0
 *
 * 「不知道」与「真的是 0」是两件事：缓存命中率的分母为 0 时**整行省略**，
 * 拿不到单价时写 `—` 并标注「按兜底价估算」，账户取不到时写原因而不是 ¥0。
 * @module dsh-pixel-dashboard/client/sessionView
 */

const React = require('react')
const resolveAccount = m1.resolveAccount
const fetchBalance = m2.fetchBalance
const formatCny = m3.formatCny
const formatDurationMs = m3.formatDurationMs
const formatTokens = m3.formatTokens
const shortDate = m3.shortDate
const fetchPlans = m4.fetchPlans
const useSelectedPlan = m5.useSelectedPlan
// 「图二」那套彩色富信息的两个零件：hero 卡（左侧色条）与三色耗时堆叠条。
// 与看板共用同一份实现（sessionDetailView.js），两处视觉不会各写一版。
const HeroCard = m6.HeroCard
const TimingBreakdownView = m6.TimingBreakdownView
const { createElement: h, useCallback, useEffect, useMemo, useState } = React

/**
 * 槽位项 id。
 *
 * 与输入框费用条（`conversation.composer.dock` 里的 `pixel-cost`）同名是刻意的：
 * 它们是「同一笔钱的摘要与明细」，在两个互不重叠的槽位里各自唯一。
 */
const SESSION_VIEW_ID = 'pixel-cost'

/** 宿主会话明细路由（契约第 4 节）。 */
const SESSION_URL = '/dsh-pixel/session'

/**
 * 刷新间隔。
 *
 * 宿主侧 `/data` 有 20 秒 TTL、账本聚合也不是免费的，因此这里不复用 4 秒那种
 * 快节奏：会话页是「读数」而不是「监视器」，30 秒足够，且切换会话时会立刻重取。
 */
const SESSION_REFRESH_MS = 30_000

/**
 * 明细在**内存里**留多久（用户：『每次读明细都要重新加载吗？就不能留到内存里？』）。
 *
 * 60 秒比定时刷新（30 秒）长，因此**定时刷新**永远是真的去取一次（它带 `refresh`），
 * 而「切走再切回来」「关掉展开再点开」这类重复动作直接命中缓存、不再发请求。
 *
 * 为什么放模块作用域而不是组件 state：看板「消费 Top 会话」的展开与费用页是两个
 * 组件，共用一个 `fetchSession`。缓存放模块级，两处才吃到同一份；放各自组件里
 * 就是两份数据、两套 TTL，迟早漂移成「同一会话两处金额不同」。
 * @type {Map<string, {at:number, payload:object}>}
 */
const detailCache = new Map()

/**
 * 缓存有效期。
 * @type {number}
 */
const SESSION_CACHE_TTL_MS = 60_000

/**
 * 读内存缓存里**还没过期**的那一份（不触发任何请求）。
 *
 * 给 {@link SessionCostView} 的初始 state 用：切回这个标签页时首帧就是数字，
 * 而不是先闪一下「正在读取…」再等一次往返。
 * @param {string} sessionId - 会话 id。
 * @returns {object|undefined} 宿主负载；没有或已过期时 undefined。
 */
function peekSession(sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return undefined
  const entry = detailCache.get(id)
  if (entry === undefined) return undefined
  if (Date.now() - entry.at >= SESSION_CACHE_TTL_MS) return undefined
  return entry.payload
}

/**
 * 清空内存缓存（测试与「手动清缓存」用）。
 * @returns {void}
 */
function clearSessionCache() {
  detailCache.clear()
}

/** 这一页的降级状态（每一种都有可见说明，见 {@link SESSION_STATE_TEXT}）。 */
const SESSION_STATES = ['loading', 'ready', 'missing', 'missing-route', 'failed', 'no-session']

/**
 * 每种降级状态必须说出口的那句话。
 *
 * 单独抽成常量而不是散在 JSX 里：渲染闸门可以直接断言这些字符串，而
 * `renderToStaticMarkup` 不执行 effect —— 容器在闸门里永远停在 `loading`，
 * 其余状态的文案若写在容器里就等于永远没被验过。
 */
const SESSION_STATE_TEXT = Object.freeze({
  loading: '正在读取这条会话的费用明细…',
  missing: '宿主没有这条会话的计费记录：它可能已被删除，或只存在于另一台设备上。',
  'missing-route': '当前宿主还没有会话明细接口（插件版本可能过旧，重启 dsh 试试）。',
  failed: '取不到这条会话的费用明细。',
  // 槽位没给会话 id：不假装「加载中」（那会永远转下去），也不留白。
  'no-session': '没有选中会话：选中一条会话后，这里会显示它的费用明细。',
})

/**
 * 每种降级状态的**短标签**（状态点的上一行小字）。
 *
 * 与 {@link SESSION_STATE_TEXT} 分开：那一段是「发生了什么、下一步做什么」的长句，
 * 这一段只负责让人三秒内认出是哪一种状态。两者都抽成常量，闸门可以直接断言。
 */
const SESSION_STATE_LABEL = Object.freeze({
  loading: '正在读取',
  missing: '会话不存在',
  'missing-route': '宿主版本过旧',
  failed: '取数失败',
  'no-session': '未选中会话',
})

/** 「—」：缺失的统一写法（绝不写成 0）。 */
const DASH = '—'

/**
 * 读一个数字；读不懂就是 undefined，而不是 0。
 * @param {unknown} value - 原始值。
 * @returns {number|undefined} 有限数或 undefined。
 */
function maybeNumber(value) {
  if (value === null || value === undefined || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 用量四桶。
 *
 * **整份 totals 读不到时返回 `undefined`，而不是一排 0。** 这是项目里反复强调的
 * 那条口径：「不知道」与「真的是 0」是两件事——一排 0 会被读成「这段会话没用量」，
 * 而事实可能是宿主这一行没给数据。调用方据此显示 `—` 或整行省略。
 *
 * 单个桶缺失（旧记录没有 `cacheWrite`）按 0 处理：那确实是「这个桶没用量」，
 * 而且四个桶加起来就是计费总量，缺一个会算出偏小的总量。
 * @param {object|undefined} totals - 宿主用法形状 `usage`。
 * @returns {{hit:number,miss:number,write:number,output:number,billed:number}|undefined} 四桶与计费总量。
 */
function usageBuckets(totals) {
  if (totals === null || typeof totals !== 'object') return undefined
  const num = (field) => maybeNumber(totals[field]) ?? 0
  const hit = num('cacheHit')
  const miss = num('cacheMiss')
  const write = num('cacheWrite')
  const output = num('output')
  return { hit, miss, write, output, billed: hit + miss + write + output }
}

/**
 * 缓存命中率：命中读 ÷ **计费输入**（命中 + 未命中 + 写入）。
 *
 * 分母取「计费输入」而不是「全部 token」，与官方统计胶囊、看板、费用条同一口径；
 * 分母为 0 时返回 `undefined`（调用方整行省略），**不是 0%**——「还没有输入」与
 * 「缓存一次都没命中」是两种完全不同的处境，写成 0% 会让人去查缓存配置。
 * @param {object|undefined} totals - 宿主用法形状 `usage`。
 * @returns {number|undefined} 0..1 的比例；读不到或分母为 0 时 undefined。
 */
function cacheRatio(totals) {
  const buckets = usageBuckets(totals)
  if (buckets === undefined) return undefined
  const billedInput = buckets.hit + buckets.miss + buckets.write
  if (billedInput <= 0) return undefined
  return Math.min(1, buckets.hit / billedInput)
}

/**
 * 某一列跨行求和；任一行缺用量就返回 undefined。
 * @param {Array<{buckets:object|undefined}>} rows - 明细行。
 * @param {'hit'|'miss'|'write'|'output'|'billed'} field - 桶名。
 * @returns {number|undefined} 合计。
 */
function sumBucket(rows, field) {
  let total = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.buckets === null || row?.buckets === undefined) return undefined
    total += row.buckets[field] ?? 0
  }
  return total
}

/**
 * 按「行」求和，任何一行金额缺失就返回 undefined。
 *
 * 为什么不把缺失行当 0 继续加：那会让「某一行我们不知道」显示成一个**看起来精确**的
 * 合计，而用户会拿它去对账。宁可整块合计写 `—`，也不给一个错的数。
 * @param {Array<{amount:number|undefined}>} rows - 明细行。
 * @returns {number|undefined} 合计；任一行为 undefined 时 undefined。
 */
function sumAmounts(rows) {
  let total = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Number.isFinite(row?.amount)) return undefined
    total += row.amount
  }
  return total
}

/**
 * 单价数字的写法：不带币种符号，最多两位小数。
 * @param {number} value - 每百万 token 的单价。
 * @returns {string} 形如 `0.5`、`5.00`、`20`。
 */
function priceNumber(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return DASH
  if (Math.abs(amount) >= 100) return amount.toFixed(0)
  if (Math.abs(amount) >= 1) return amount.toFixed(2)
  return String(Number(amount.toFixed(4)))
}

/**
 * 带币种的单价文本。
 * @param {number} value - 金额。
 * @param {string} currency - 币种（CNY / USD / …）。
 * @returns {string} 形如 `¥0.5`、`$1.00`。
 */
function unitMoney(value, currency) {
  if (currency === 'CNY') return `¥${priceNumber(value)}`
  return `${currency} ${priceNumber(value)}`
}

/**
 * 把一档价目折算成「本条会话实际生效的」人民币价。
 *
 * 两种情况必须区别对待：
 *   - 价目是人民币 → 直接乘倍率；
 *   - 价目是美元 → 有汇率就折算并注明，**没有汇率就照实显示原币种**。
 *     把 USD 当 CNY 显示是这类界面里最糟的一种错：数字看起来完全正常。
 * @param {number} value - 原始单价（每百万 token）。
 * @param {string} currency - 价目的币种。
 * @param {object|undefined} pricing - 宿主负载里的 pricing（带 `usdToCny`）。
 * @returns {{amount:number,currency:string,converted:boolean}} 生效价。
 */
function toCny(value, currency, pricing) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return { amount: NaN, currency: 'CNY', converted: false }
  const code = String(currency ?? 'CNY').toUpperCase()
  if (code === 'CNY') return { amount, currency: 'CNY', converted: false }
  const fx = maybeNumber(pricing?.usdToCny)
  if (fx !== undefined && fx > 0) return { amount: amount * fx, currency: 'CNY', converted: true, from: code }
  return { amount, currency: code, converted: false }
}

/**
 * 某个模型的**生效单价**：价目 × 提供商倍率，两档时段各一份。
 *
 * ## 键是复合键，**不要**自己按路由名再查一次
 *
 * 宿主 `pricing.models` 的键是 `modelKey`（`deepseek-flash@commandcode`）——与
 * `entries[].key` 完全同一个键。早先各界面各自按模型的裸名去查价目，于是同一个模型
 * 在不同提供商下取到了同一份价（AGENT.md 里记着这条：客户端不能自己按路由 id 查价）。
 *
 * ## `markup ?? 1`
 *
 * 提供商倍率字段（`markup`）由定价工作流随后补上；缺省按 1 处理，字段一上线这里
 * 自动生效，不需要再改一行代码。
 * @param {object} entry - `entries[]` 的一行。
 * @param {object|undefined} pricing - 宿主负载里的 pricing。
 * @returns {{text:string,hint:string,tone:string}|undefined} 单价文本；拿不到价目时 undefined。
 */
function unitPriceOf(entry, pricing) {
  if (entry?.priced === false) return undefined
  const key = String(entry?.key ?? '')
  if (key === '') return undefined
  const models = pricing?.models
  const model = models !== null && typeof models === 'object' ? models[key] : undefined
  const rates = model?.rates
  if (rates === null || typeof rates !== 'object') return undefined
  const markup = maybeNumber(model?.markup ?? 1) ?? 1
  const currency = String(rates.currency ?? pricing?.currency ?? 'CNY').toUpperCase()

  const cell = (bucket) => {
    const peak = maybeNumber(bucket?.peak)
    const idle = maybeNumber(bucket?.idle)
    if (peak === undefined && idle === undefined) return undefined
    return {
      peak: toCny((peak ?? 0) * markup, currency, pricing),
      idle: toCny((idle ?? 0) * markup, currency, pricing),
    }
  }
  const hit = cell(rates.cacheHit)
  const miss = cell(rates.cacheMiss)
  const output = cell(rates.output)
  if (hit === undefined || miss === undefined || output === undefined) return undefined

  // 主列只放**高峰档**那一组（两档并排会把单价列撑成两行字）；
  // 空闲档与倍率写进悬停说明，想核对的人一点就看得到。
  const money = (item) => unitMoney(item.amount, item.currency)
  const text = `${money(miss.peak)} / ${money(hit.peak)} / ${money(output.peak)}`
  const parts = [
    `每百万 token（高峰）：未命中 ${money(miss.peak)} · 命中 ${money(hit.peak)} · 输出 ${money(output.peak)}`,
    `空闲：未命中 ${money(miss.idle)} · 命中 ${money(hit.idle)} · 输出 ${money(output.idle)}`,
  ]
  // 缓存写入按 1.25 × 标准输入价计（价目里没有单独一档），核对金额时会用到这一句。
  parts.push('缓存写入按 1.25 × 标准输入价计')
  if (markup !== 1) parts.push(`已含 ${markup}× 提供商倍率`)
  if (hit.peak.converted === true) {
    parts.push(`USD 价目按 1 USD = ${pricing?.usdToCny} CNY 折算`)
  } else if (hit.peak.currency !== 'CNY') {
    parts.push(`价目是 ${hit.peak.currency}，宿主未提供汇率，未折算成人民币`)
  }
  return { text, hint: parts.join('｜'), tone: hit.peak.currency === 'CNY' ? 'ok' : 'warn' }
}

/**
 * 把 0..1 的占比写成 `62.0%`；拿不到占比时返回 undefined（界面整块省略）。
 *
 * 放在模型层而不是渲染层：面板只摆位置，一个数字都不算。
 * @param {number|undefined} share - 0..1。
 * @returns {string|undefined} 形如 `62.0%`。
 */
function shareTextOf(share) {
  if (!Number.isFinite(share)) return undefined
  return `${(share * 100).toFixed(1)}%`
}

/**
 * 由宿主负载折出这一页要显示的全部内容（纯函数）。
 *
 * ## 合计只有一个来源：逐模型金额之和
 *
 * 宿主的 `payload.cost` 与「逐行 `entries[].cost.standard` 之和」在 10⁻⁶ 量级可能有
 * 尾差（两边各自按 6 位取整）。这里**以逐行求和为准**（Lead 钉死的口径），顶部金额
 * 就是那个和；`payload.cost` 只用来取分时计价与「错峰省下」这几项，不参与加法。
 *
 * ## 逐日不立合计
 *
 * 逐日金额之和同样与顶部合计有 10⁻⁶ 尾差。同一页并列两个「合计」一定会有人在心里
 * 加一遍，然后发现对不上——所以逐日一节只列每天的数字，不另写一个总数。
 * @param {object|undefined} payload - `/dsh-pixel/session` 的响应。
 * @returns {object|undefined} 面板数据；payload 不可读时 undefined。
 */
function sessionCostModel(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const session = payload.session !== null && typeof payload.session === 'object' ? payload.session : {}
  const pricing = payload.pricing !== null && typeof payload.pricing === 'object' ? payload.pricing : {}
  const entries = Array.isArray(payload.entries) ? payload.entries : []
  const rawDays = Array.isArray(payload.days) ? payload.days : []

  const models = entries.map((entry) => {
    const buckets = usageBuckets(entry?.totals)
    const amount = maybeNumber(entry?.cost?.standard)
    const unit = unitPriceOf(entry, pricing)
    return {
      key: String(entry?.key ?? entry?.label ?? ''),
      label: String(entry?.label ?? entry?.rollup ?? entry?.key ?? '未知模型'),
      provider: String(entry?.providerLabel ?? entry?.provider ?? ''),
      vendor: String(entry?.vendor ?? ''),
      // 宿主明说「不在价目表里」才算未定价。旧宿主没这个字段时按「有价目」理解，
      // 但下面单价列拿不到价目仍会写「—」并标注估算——两条信息互不替代。
      priced: entry?.priced !== false,
      buckets,
      unitText: unit === undefined ? DASH : unit.text,
      unitHint: unit === undefined
        ? (entry?.priced === false
          ? '这个模型不在价目表里，金额按兜底单价估算（不是它的官方价）'
          : '宿主没有提供这个模型的价目，金额仍是宿主算好的那一份')
        : unit.hint,
      unitTone: unit === undefined ? 'warn' : unit.tone,
      amount,
      amountText: amount === undefined ? DASH : formatCny(amount),
    }
  })

  // 加起来得到的合计（可能 undefined：某一行缺金额时整块写 —）。
  const modelsTotal = sumAmounts(models)
  const modelsTotalText = modelsTotal === undefined ? DASH : formatCny(modelsTotal)

  const days = rawDays.map((row) => {
    const amount = maybeNumber(row?.cost?.standard)
    return {
      key: String(row?.key ?? ''),
      label: shortDate(row?.key),
      buckets: usageBuckets(row?.totals),
      amount,
      amountText: amount === undefined ? DASH : formatCny(amount),
    }
  })

  // 逐日条的相对长度：按**这几天里最贵的一天**归一，而不是按合计。
  // 归一化到合计会让「只有一天有花费」时那根条只占 1/N，看起来像几乎没花；
  // 归一化到最大值则每天之间的相对高低一眼可读，这正是迷你柱状图要表达的东西。
  const busiestDay = days.reduce(
    (max, day) => (day.amount !== undefined && day.amount > max ? day.amount : max),
    0,
  )
  for (const day of days) {
    day.share = busiestDay > 0 && day.amount !== undefined ? day.amount / busiestDay : undefined
  }

  // 分时计价：两档金额**由逐行 cost 相加得到**，与顶部合计同一个来源。
  //
  // 为什么不直接读 `payload.cost.peak/idle`：会话合计是「逐行取整后再相加」的，
  // 而 `payload.cost` 是宿主自己另算的一份（两条路在 10⁻⁶ 量级可能不同）。
  // 屏幕上只能有一个合计口径——用户一定会把两档加起来跟顶部对一遍。
  // entries 为空（宿主没给明细）时才退回合计对象那一份。
  const costSource = payload.cost !== null && typeof payload.cost === 'object' ? payload.cost : session.cost
  const sumOfCostField = (field) => {
    let total = 0
    let seen = false
    for (const entry of entries) {
      const value = maybeNumber(entry?.cost?.[field])
      if (value === undefined) return undefined
      total += value
      seen = true
    }
    return seen ? total : undefined
  }
  const peak = sumOfCostField('peak') ?? maybeNumber(costSource?.peak)
  const idle = sumOfCostField('idle') ?? maybeNumber(costSource?.idle)
  const ifAllIdle = maybeNumber(costSource?.ifAllIdle)
  const saved = maybeNumber(costSource?.saved)
  // 占比分母就是顶部那个合计（modelsTotal），不是第二份「标准价」。
  const splitBase = modelsTotal !== undefined && modelsTotal > 0
    ? modelsTotal
    : (maybeNumber(costSource?.standard) ?? undefined)
  const split = peak === undefined && idle === undefined
    ? undefined
    : {
      base: splitBase,
      rows: [
        {
          key: 'peak',
          label: '高峰时段',
          hint: '工作日 09:00-12:00、14:00-18:00',
          // 峰=粉、闲=绿（用户确认的配色口径）。条上的色点与条同色。
          tone: 'pink',
          amount: peak,
          text: peak === undefined ? DASH : formatCny(peak),
          share: splitBase !== undefined && splitBase > 0 && peak !== undefined ? Math.min(1, peak / splitBase) : undefined,
        },
        {
          key: 'idle',
          label: '空闲时段',
          hint: '其余时段与全部法定节假日',
          tone: 'green',
          amount: idle,
          text: idle === undefined ? DASH : formatCny(idle),
          share: splitBase !== undefined && splitBase > 0 && idle !== undefined ? Math.min(1, idle / splitBase) : undefined,
        },
      ],
    }
  // 占比文本也在模型层算好：面板不碰数字。
  for (const row of split?.rows ?? []) row.shareText = shareTextOf(row.share)

  // 总量与分桶：整份 totals 读不到时这些字段全部 undefined（界面上不画一排 0）。
  const sessionBuckets = usageBuckets(session.totals)
  const hitRate = cacheRatio(session.totals)

  /**
   * 四桶 + 各自在计费总量里的份额，供「指标 + 细条」一行一条地画。
   *
   * `write` 这一桶也照常给：旧记录没有它时按 0（见 {@link usageBuckets}），
   * 面板用 `hasWrite` 决定要不要显示这一行，而不是在这里删数据。
   *
   * 每桶一个语义色（与看板趋势图「构成」那四段同一套）：命中=蓝、未命中=紫、
   * 写入=黄、输出=粉。这样从看板的堆叠柱看到这一页的占比条，颜色是一一对应的。
   */
  const bucketRows = sessionBuckets === undefined
    ? undefined
    : [
      { key: 'hit', label: '缓存命中', tone: 'blue', text: formatTokens(sessionBuckets.hit) },
      { key: 'miss', label: '未命中', tone: 'purple', text: formatTokens(sessionBuckets.miss) },
      { key: 'write', label: '缓存写入', tone: 'yellow', text: formatTokens(sessionBuckets.write) },
      { key: 'output', label: '输出', tone: 'pink', text: formatTokens(sessionBuckets.output) },
    ].map((row) => ({
      ...row,
      share: sessionBuckets.billed > 0 ? (sessionBuckets[row.key] ?? 0) / sessionBuckets.billed : undefined,
    }))

  // ── 第一行的四枚 hero（照「图二」的口径）────────────────────────
  //
  // 数据全部来自 `/dsh-pixel/session` 的 `session` 行：`cost` / `totals.local` /
  // `timing.totalMs` / `toolCalls` / `turns` / `maxTurnMs`。缺字段一律写 `—`
  // （「不知道」不是「零」），这是用户在旧宿主上验证过的行为。
  //
  // 「估算金额」用**逐模型金额之和**（modelsTotal），与页面上其它合计同一个来源；
  // 直接读 `session.cost.standard` 会与逐模型表差 10⁻⁶，屏幕上两个数会被拿去对账。
  const sessionTotals = session.totals !== null && typeof session.totals === 'object'
    ? session.totals
    : undefined
  const totalTokens = maybeNumber(sessionTotals?.local)
  const timing = session.timing !== null && typeof session.timing === 'object' ? session.timing : {}
  const turns = maybeNumber(session.turns)
  const modelMs = maybeNumber(timing.totalMs)
  const toolCalls = maybeNumber(session.toolCalls)
  const maxTurnMs = maybeNumber(session.maxTurnMs)
  const peakRequests = maybeNumber(sessionTotals?.peak?.requests)
  const idleRequests = maybeNumber(sessionTotals?.idle?.requests)
  const requestTotal = peakRequests === undefined && idleRequests === undefined
    ? undefined
    : (peakRequests ?? 0) + (idleRequests ?? 0)
  const peakRatio = requestTotal !== undefined && requestTotal > 0
    ? (peakRequests ?? 0) / requestTotal
    : undefined
  // 平均每轮 = 模型耗时 ÷ 轮次（与看板详情同一口径：模型真正在干活的那段时间）。
  const avgTurnMs = modelMs !== undefined && modelMs > 0 && turns !== undefined && turns > 0
    ? modelMs / turns
    : undefined

  const heroes = [
    {
      key: 'cost',
      tone: 'accent',
      label: '估算金额',
      value: modelsTotal === undefined ? DASH : formatCny(modelsTotal),
      foot: saved !== undefined && saved > 0
        ? `错峰省下 ${formatCny(saved)}`
        : '全部落在高峰时段',
    },
    {
      key: 'tokens',
      tone: 'blue',
      label: '总 Token',
      value: totalTokens === undefined ? DASH : formatTokens(totalTokens),
      foot: requestTotal === undefined ? undefined : `${requestTotal} 次请求`,
    },
    {
      key: 'timing',
      tone: 'green',
      label: '模型耗时',
      value: modelMs === undefined || modelMs <= 0 ? DASH : formatDurationMs(modelMs),
      foot: avgTurnMs === undefined ? '等待 + 回复 + 工具' : `平均每轮 ${formatDurationMs(avgTurnMs)}`,
    },
    {
      key: 'tools',
      tone: 'purple',
      label: '工具调用',
      value: toolCalls === undefined ? DASH : `${toolCalls} 次`,
      foot: maxTurnMs === undefined || maxTurnMs <= 0
        ? undefined
        : `最久一轮 ${formatDurationMs(maxTurnMs)}`,
    },
  ]

  // 团队：只在多成员时成立（宿主已保证 <2 位时为 null，这里再兜一层）。
  //
  // 注意 `team.cost` 是**费用对象**（`{standard, peak, idle, ifAllIdle, saved}`），
  // 与 `entries[].cost` 同形，不是裸数字——早先按数字读会得到 NaN，界面上写「—」，
  // 看起来像「团队没有数据」。这里两种形状都认（旧宿主可能给数字）。
  const rawTeam = payload.team !== null && typeof payload.team === 'object' ? payload.team : undefined
  const members = Array.isArray(rawTeam?.members) ? rawTeam.members : []
  const teamCost = maybeNumber(rawTeam?.cost?.standard ?? rawTeam?.cost)
  const team = rawTeam === undefined || members.length < 2
    ? undefined
    : {
      cost: teamCost,
      costText: teamCost === undefined ? DASH : formatCny(teamCost),
      memberCount: members.length,
      members: members.map((member) => {
        const memberCost = maybeNumber(member?.cost?.standard ?? member?.cost)
        return {
          id: String(member?.id ?? member?.name ?? ''),
          name: String(member?.name ?? member?.title ?? member?.id ?? '成员'),
          role: String(member?.role ?? ''),
          live: member?.live === true,
          buckets: usageBuckets(member?.totals),
          amount: memberCost,
          amountText: memberCost === undefined ? DASH : formatCny(memberCost),
          share: memberCost !== undefined && teamCost !== undefined && teamCost > 0
            ? Math.min(1, memberCost / teamCost)
            : undefined,
        }
      }),
    }

  const unpriced = models.filter((row) => row.priced === false).map((row) => row.label)
  const noRate = models.filter((row) => row.priced === true && row.unitText === DASH).map((row) => row.label)

  const notes = []
  if (unpriced.length > 0) {
    notes.push(`其中 ${unpriced.join('、')} 不在价目表里，金额按兜底单价估算，不是它们的官方价。`)
  }
  if (noRate.length > 0) {
    notes.push(`${noRate.join('、')} 取不到单价：金额仍是宿主算好的那一份，单价列显示「—」。`)
  }
  // 「错峰已省」不放脚注：它是分时计价这一块的结论，脚注只留给「数字要打折扣时」的说明。
  // 放在卡片里，读者看完高峰/空闲两行正好接上这句。

  const title = typeof session.title === 'string' && session.title !== '' ? session.title : ''
  const workspace = typeof session.workspace === 'string' ? session.workspace : ''

  return {
    // 抬头：标题为空时给一句占位，而不是让抬头只剩一个金额
    title,
    titleText: title === '' ? '未命名会话' : title,
    workspace,
    live: session.live === true,
    generatedAt: maybeNumber(payload.generatedAt),
    version: typeof payload.version === 'string' ? payload.version : undefined,
    // 金额
    total: modelsTotal,
    totalText: modelsTotalText,
    split,
    ifAllIdle,
    saved,
    // 分时计价的结论（错峰省下多少）：给「计价时段」卡片用，拿不到时为 undefined
    savedText: saved === undefined || saved <= 0 ? undefined : formatCny(saved),
    ifAllIdleText: ifAllIdle === undefined ? undefined : formatCny(ifAllIdle),
    // 用量
    buckets: sessionBuckets,
    bucketRows,
    // 第一行的四枚 hero（估算金额 / 总 Token / 模型耗时 / 工具调用）
    heroes,
    // 第二行左半：三色耗时堆叠条。`turns` 是「平均每轮」的除数，与看板详情同一口径。
    timing: { ...timing, turns: turns ?? 0 },
    // 第四行右半：峰/闲请求分布（与看板详情里那条 .px-peak-bar 同一种表达）
    requests: peakRatio === undefined
      ? undefined
      : {
        peak: peakRequests ?? 0,
        idle: idleRequests ?? 0,
        total: requestTotal,
        ratio: peakRatio,
        peakText: `${Math.round(peakRatio * 100)}%`,
        idleText: `${Math.round((1 - peakRatio) * 100)}%`,
      },
    // 卡片头右上角的「计费总量」：它是四桶之和，不是金额，与合计不冲突
    billedText: sessionBuckets === undefined ? undefined : formatTokens(sessionBuckets.billed),
    hitRate,
    // 命中率整行省略的条件在模型层就定好（分母为 0 时 undefined）
    hitRateText: hitRate === undefined ? undefined : `${(hitRate * 100).toFixed(1)}%`,
    // 明细
    models,
    modelsTotal,
    modelsTotalText,
    hasWrite: models.some((row) => (row.buckets?.write ?? 0) > 0),
    days,
    // 账户与团队
    team,
    currency: String(pricing.currency ?? 'CNY'),
    notes,
    // 空态：宿主确实有这条会话，但一条计费记录都没有
    empty: models.length === 0 && days.length === 0,
  }
}

/**
 * 表格/列表里的一个 token 数字：拿不到用量就写 `—`。
 * @param {object|undefined} buckets - {@link usageBuckets} 的产出。
 * @param {'hit'|'miss'|'write'|'output'|'billed'} field - 桶名。
 * @returns {string} 缩略后的 token 数或 `—`。
 */
function tokenText(buckets, field) {
  if (buckets === null || buckets === undefined) return DASH
  return formatTokens(buckets[field] ?? 0)
}

/**
 * 表格合计行里的一个 token 数字：任一行缺用量就写 `—`（不把缺失当 0 加起来）。
 * @param {Array<{buckets:object|undefined}>} rows - 明细行。
 * @param {'hit'|'miss'|'write'|'output'|'billed'} field - 桶名。
 * @returns {string} 缩略后的 token 数或 `—`。
 */
function sumText(rows, field) {
  const total = sumBucket(rows, field)
  return total === undefined ? DASH : formatTokens(total)
}

/**
 * 一根占比条。轨道用描边色，不用色块底——卡片本身已经是「白块」，
 * 再铺一层米色轨道就变成「白块里嵌色块」。
 *
 * ## 填充是**彩色的**（用户这一轮明确要求）
 *
 * 上一轮把填充做成了中性墨色淡涂，用户的原话是「怎么什么颜色都没啊」。
 * 因此这里按 `tone` 取语义色：峰=粉、闲=绿、命中=蓝、未命中=紫、写入=黄、
 * 输出=粉，逐日与成员走强调色。颜色只从 `--px-*` 令牌来，不写死十六进制。
 *
 * 不传 `tone` 时仍是中性墨色——账户额度那根条不是「数据占比」，它是状态，
 * 中性底 + 告急变红（`warn`）才不会被读成「用了很多颜色」。
 * @param {object} props - share（0..1）/ thin / tone（`warn` 或语义色名）。
 * @returns {object|null} React 元素；share 不是有限数时不画（「不知道」不画成 0）。
 */
function Meter(props) {
  const { share, thin, tone } = props
  if (!Number.isFinite(share)) return null
  const width = `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`
  const className = thin === true ? 'px-sv-meter px-sv-meter-thin' : 'px-sv-meter'
  // `warn` 是状态红；其余 tone 是数据语义色；都没有时保持中性。
  const fill = tone === 'warn'
    ? 'px-sv-meter-fill px-sv-meter-fill-warn'
    : (typeof tone === 'string' && tone !== ''
      ? `px-sv-meter-fill px-sv-meter-fill-${tone}`
      : 'px-sv-meter-fill')
  return h(
    'span',
    { className, 'aria-hidden': 'true' },
    h('i', { className: fill, style: { width } }),
  )
}

/**
 * 一条「计量行」：左边标签、右边数值（可带占比），下面一根表示份额的细条。
 *
 * 为什么不是一排「指标格」：这一页同时要显示四桶用量、两档计价、逐日与成员，
 * 全都做成描边小方块就成了仪表盘墙——每格一个框、每格一个数，读的人得先数框。
 * 一行一个指标 + 一根细条，同样信息占一半面积，也把「谁占大头」直接画出来了。
 * @param {object} props - label / value / hint / share / shareText / thin / tone。
 * @returns {object} React 元素。
 */
function MeterRow(props) {
  const { label, value, hint, share, shareText, thin, tone } = props
  return h(
    'div',
    { className: 'px-sv-row' },
    h(
      'div',
      { className: 'px-sv-row-head' },
      h('span', { className: 'px-sv-row-label', title: hint },
        // 色点与条同色：一行里「哪一格是峰、哪一格是闲」不用读字。
        tone === undefined ? null : h('i', { className: `px-sv-tick px-sv-tick-${tone}`, 'aria-hidden': 'true' }),
        label),
      h(
        'span',
        { className: 'px-sv-row-meta' },
        h('b', { className: 'px-sv-num px-sv-row-value' }, value),
        shareText === undefined
          ? null
          : h('span', { className: 'px-sv-num px-sv-row-pct' }, shareText),
      ),
    ),
    h(Meter, { share, thin, tone }),
  )
}

/**
 * 一张分区卡：统一的卡头（标题 + 右上角的低强调附注）+ 任意内容。
 *
 * 卡头右上角只放**不重复**的信息（模型个数、天数、团队合计）。
 * 早先那里放的是本页合计金额，于是同一个数字在一页里出现了三次，
 * 用户会开始怀疑哪个才是总数。
 * @param {object} props - title / note / wide / children。
 * @returns {object} React 元素。
 */
function PanelCard(props) {
  const { title, note, wide, children } = props
  const className = wide === true ? 'px-sv-card px-sv-card-wide' : 'px-sv-card'
  return h(
    'div',
    { className },
    h(
      'div',
      { className: 'px-sv-card-head' },
      h('h3', { className: 'px-sv-card-title' }, title),
      note === undefined ? null : h('span', { className: 'px-sv-card-note' }, note),
    ),
    children,
  )
}

/**
 * 降级卡片：加载中 / 会话不存在 / 旧宿主 / 取数失败。
 *
 * 四句话各不相同，因为它们要求的**下一步动作**不同（等一会 / 换一条会话 /
 * 重启宿主 / 重试）。混成一句「不可用」是最容易被当成「插件坏了」的写法。
 *
 * 版式是居中一段话：这种状态下这一页**没有别的内容**，用横幅式提示会让下面
 * 留出一大片空白，看起来像没渲染完。状态由「状态点 + 一行短标签」表达，
 * 不再用 3px 左色条（侧边条纹是最典型的 AI 装饰）。
 * @param {object} props - phase / error / onRetry。
 * @returns {object} React 元素。
 */
function StateCard(props) {
  const { phase, error, onRetry } = props
  const text = SESSION_STATE_TEXT[phase] ?? SESSION_STATE_TEXT.failed
  const label = SESSION_STATE_LABEL[phase] ?? SESSION_STATE_LABEL.failed
  // 三种失败都允许重试：会话不存在也可能只是账本还没落盘、旧宿主重启后就有了。
  // loading 与 no-session 不给按钮——前者已经在自己轮询，后者没有会话 id 可重取。
  const canRetry = phase === 'failed' || phase === 'missing' || phase === 'missing-route'
  return h(
    'div',
    {
      className: `px-sv-state px-sv-state-${phase}`,
      role: phase === 'loading' ? 'status' : 'alert',
      'data-px-sv-state': phase,
    },
    h(
      'span',
      { className: 'px-sv-state-tag' },
      h('span', { className: 'px-sv-state-mark', 'aria-hidden': 'true' }),
      h('span', { className: 'px-sv-state-label' }, label),
    ),
    h('p', { className: 'px-sv-state-text' }, text),
    phase === 'failed' && typeof error === 'string' && error !== ''
      ? h('p', { className: 'px-sv-state-detail' }, error)
      : null,
    canRetry && typeof onRetry === 'function'
      ? h('button', { type: 'button', className: 'px-sv-btn', onClick: onRetry }, '重试')
      : null,
  )
}

/**
 * 账户一节：按当前模型来源绑定**一个**账户（余额或某家套餐）。
 *
 * 与费用条那一枚同一套判据（{@link resolveAccount}），所以两处不会各说各话。
 * 取不到时写明原因，**绝不显示 0**——「余额查不到」被写成「¥0」会让用户以为钱没了。
 *
 * 这里的两处换算（百分比取整、0..1 归一）是纯展示换算：账户数据来自另一个接口，
 * 不属于 {@link sessionCostModel} 的负载，因此没法在模型层算。
 * @param {object} props - account。
 * @returns {object} React 元素。
 */
function AccountBlock(props) {
  const { account } = props
  if (account === undefined || account === null || account.kind === 'none') {
    return h('p', { className: 'px-sv-empty' }, '当前模型来源没有可显示的账户信息（既没有官方余额，也没有这一家的套餐额度）。')
  }

  if (account.kind === 'balance') {
    return h(
      'div',
      { className: 'px-sv-account' },
      h(
        'div',
        { className: 'px-sv-account-head' },
        h('span', { className: 'px-sv-account-label' }, 'DeepSeek 官方余额'),
        // 来源认不出、退回官方余额时要说清这是**推断**，否则读的人会以为这就是他在用的账户。
        account.source === 'fallback' ? h('span', { className: 'px-sv-tag' }, '推断') : null,
      ),
      h('b', { className: 'px-sv-num px-sv-account-value' }, account.text),
      h('p', { className: 'px-sv-card-foot' },
        '来自官方余额接口，由本机宿主用 DSH 自己的 Key 查询，Key 不离开本机。'),
    )
  }

  if (account.kind === 'plan') {
    const percent = Number(account.plan?.percent)
    const known = Number.isFinite(percent)
    return h(
      'div',
      { className: 'px-sv-account' },
      h(
        'div',
        { className: 'px-sv-account-head' },
        h('span', { className: 'px-sv-account-label' }, account.fullLabel ?? account.label),
        // 「手动指定」是**选中**状态，正是强调色该出现的两处之一。
        account.source === 'selected'
          ? h('span', { className: 'px-sv-tag px-sv-tag-accent' }, '手动指定')
          : null,
      ),
      h('b', { className: 'px-sv-num px-sv-account-value' }, known ? `${percent.toFixed(1)}%` : DASH),
      h(Meter, {
        share: known ? Math.min(1, Math.max(0, percent / 100)) : undefined,
        // 红色只在真的逼近上限时出现；其余时候这条轨道是中性色。
        tone: known && percent >= 75 ? 'warn' : undefined,
      }),
      h('p', { className: 'px-sv-card-foot' },
        `${account.plan?.window?.label ?? '当前'}窗口额度已用。来自厂商内部接口，仅供参照。`),
    )
  }

  // unavailable：必须给出原因
  return h(
    'div',
    { className: 'px-sv-account px-sv-account-unavailable' },
    h(
      'div',
      { className: 'px-sv-account-head' },
      h('span', { className: 'px-sv-account-label' }, account.label ?? '账户'),
    ),
    h('b', { className: 'px-sv-account-value' }, '不可用'),
    h('p', { className: 'px-sv-card-foot' },
      `${account.reason ?? '暂时取不到数据'}。切换模型或修好凭据后会自动恢复。`),
  )
}

/**
 * 面板本体（**纯展示**）。
 *
 * 一个数字都不算：所有值、甚至每句说明都来自 {@link sessionCostModel}。
 * 这样闸门可以拿一份假负载直接断言渲染结果，而不必经过取数与 effect。
 * @param {object} props - model / account / phase / error / onRetry / staleError。
 * @returns {object} React 元素。
 */
function SessionCostPanel(props) {
  const { model, account, phase = 'ready', error, onRetry, staleError } = props
  const state = SESSION_STATES.includes(phase) ? phase : 'ready'

  if (state !== 'ready' || model === undefined) {
    return h(
      'section',
      { className: 'px-sv', 'aria-label': '本次会话费用' },
      h(StateCard, { phase: state === 'ready' ? 'loading' : state, error, onRetry }),
    )
  }

  const showWrite = model.hasWrite === true
  const models = model.models
  const days = model.days

  return h(
    'section',
    { className: 'px-sv', 'aria-label': '本次会话费用', 'data-px-sv': 'ready' },
    // ── 抬头：只回答「这是哪条会话」─────────────────────────────
    // 金额已经从抬头的 34px 大数字挪进下面第一行的 hero 卡（带左侧色条）。
    // 挪的理由是「同一个数字不该在一页里出现两次」：抬头一个大金额 + hero 里一枚
    // 估算金额，读者会开始怀疑哪个才是总数。抬头因此回归成一条页眉。
    h(
      'header',
      { className: 'px-sv-head' },
      h(
        'div',
        { className: 'px-sv-head-main' },
        h('span', { className: 'px-sv-eyebrow' }, '本次会话费用'),
        h(
          'div',
          { className: 'px-sv-head-line' },
          h('h2', { className: 'px-sv-title', title: model.titleText }, model.titleText),
          model.workspace === '' ? null : h('span', { className: 'px-sv-tag' }, model.workspace),
          model.live === true ? h('span', { className: 'px-sv-tag px-sv-tag-live' }, '进行中') : null,
        ),
      ),
      h('span', { className: 'px-sv-hint' }, '已按每条请求的发生时段分档计价'),
    ),

    // 后台刷新失败时不清空已读到的数字：留着旧数据，只加一行说明。
    staleError === undefined || staleError === ''
      ? null
      : h('p', { className: 'px-sv-stale', role: 'status' },
        `刷新失败，显示的是上一次读到的数据（${staleError}）。`),

    // ── 空态：有会话但没有任何计费记录 ───────────────────────────
    model.empty === true
      ? h('p', { className: 'px-sv-empty' }, '这条会话还没有产生任何计费用量：发一条消息之后这里就会有数字。')
      : null,

    // ── 第一行：三枚 hero（+ 工具调用），照「图二」的规格 ───────────
    // 这是用户点名要回来的东西：彩色左边条 + 大号数字 + 一行脚注。
    h('div', { className: 'px-sv-heroes', 'data-px-sv-row': 'heroes' },
      model.heroes.map((hero) => h(HeroCard, {
        key: hero.key,
        tone: hero.tone,
        label: hero.label,
        value: hero.value,
        foot: hero.foot,
      }))),

    // ── 第二行：耗时构成 + 计价时段 + 用量构成（并排）───────────────
    // 三块铺满整行：左边是三色堆叠条（等待模型=黄 / 模型回复=蓝 / 工具执行=绿），
    // 右边两条是金额与用量的分档。早先这一行只有两张卡、右边空着一大片，
    // 正是用户说的「搞这么多空隙出来为什么」。
    h('div', { className: 'px-sv-band px-sv-band-split', 'data-px-sv-row': 'timing' },
      h('div', { className: 'px-sv-timing-cell' }, h(TimingBreakdownView, { timing: model.timing })),
      // 计价时段：两档金额 + 各自占比
      // 卡头右上角不再重复顶部那个合计（一页出现三次同一个数字，读者会怀疑哪个才是总数）。
      // 两档的定义放在脚注里，而不是塞进两行标签的悬停说明：那是这一页唯一的术语表。
      model.split === undefined ? null : h(
        PanelCard,
        { title: '计价时段' },
        h(
          'div',
          { className: 'px-sv-rows' },
          model.split.rows.map((row) => h(MeterRow, {
            key: row.key,
            label: row.label,
            value: row.text,
            hint: row.hint,
            share: row.share,
            shareText: row.shareText,
            tone: row.tone,
          })),
        ),
        // 错峰省下的钱是这一块的结论，接在两行后面读起来正好；拿不到就不画。
        model.savedText === undefined ? null : h(
          'div',
          { className: 'px-sv-figure' },
          h('span', { className: 'px-sv-figure-label' }, '错峰已省'),
          h('b', { className: 'px-sv-num px-sv-figure-value' }, model.savedText),
          model.ifAllIdleText === undefined
            ? null
            : h('span', { className: 'px-sv-figure-note' }, `若全部落在空闲时段需 ${model.ifAllIdleText}`),
        ),
        // 术语定义压到卡片底：卡片被拉齐到同行最高时，留白落在它与上一块之间，
        // 而不是把脚注顶在中间。
        h('p', { className: 'px-sv-card-foot' },
          '高峰为工作日 09:00-12:00 与 14:00-18:00，其余时段与法定节假日按空闲计。'),
      ),

      // 用量构成 + 缓存命中率
      // 四桶各占一行（标签 + 数值 + 份额细条），命中率作为收尾读数单独一条。
      // 早先这里是六个描边小方块，其中「计费 token」与四桶之和重复，已挪到卡头做附注。
      model.bucketRows === undefined ? null : h(
        PanelCard,
        {
          title: '用量构成',
          note: model.billedText === undefined ? undefined : `计费 ${model.billedText} token`,
        },
        h(
          'div',
          { className: 'px-sv-rows' },
          model.bucketRows.map((row) => (row.key === 'write' && !showWrite
            ? null
            : h(MeterRow, {
              key: row.key,
              label: row.label,
              value: row.text,
              share: row.share,
              tone: row.tone,
            }))),
        ),
        // 命中率**整行省略**而不是显示 0%：分母为 0 等于「还没有任何输入」。
        model.hitRateText === undefined ? null : h(
          'div',
          { className: 'px-sv-figure' },
          h('span', { className: 'px-sv-figure-label' }, '缓存命中率'),
          h('b', { className: 'px-sv-num px-sv-figure-value' }, model.hitRateText),
          h('span', { className: 'px-sv-figure-note' }, '命中读 ÷ 计费输入（命中 + 未命中 + 写入）'),
        ),
      ),
    ),

    // ── 逐模型明细（通栏）───────────────────────────────────────
    // 表头改成中性层次：10.5px + 0.08em 字距 + --px-ink-2，不铺底色。
    // 合计行用一条 line-2 上边线 + 更多上方留白，明确「这是另一段」，而不是又一行。
    // 卡头附注写模型个数，让「这一部分有多少条」不必去数行。
    models.length === 0 ? null : h(
      PanelCard,
      { title: '逐模型明细', note: `${models.length} 个模型`, wide: true },
      h(
        'div',
        { className: 'px-sv-table-wrap' },
        h(
          'table',
          { className: 'px-sv-table' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, '模型'),
            h('th', { scope: 'col', className: 'px-sv-col-provider' }, '提供商'),
            h('th', { scope: 'col', className: 'px-sv-col-num' }, '命中'),
            h('th', { scope: 'col', className: 'px-sv-col-num' }, '未命中'),
            showWrite ? h('th', { scope: 'col', className: 'px-sv-col-num px-sv-col-write' }, '写入') : null,
            h('th', { scope: 'col', className: 'px-sv-col-num' }, '输出'),
            h('th', { scope: 'col', className: 'px-sv-col-num px-sv-col-unit' }, '单价 /M'),
            h('th', { scope: 'col', className: 'px-sv-col-num' }, '金额'),
          )),
          h('tbody', null, models.map((row) => h(
            'tr',
            { key: row.key === '' ? row.label : row.key },
            h('td', null,
              h('span', { className: 'px-sv-model', title: row.key === '' ? row.label : row.key }, row.label),
              row.priced === false
                ? h('span', { className: 'px-sv-badge px-sv-badge-warn', title: '这个模型不在价目表里，金额按兜底单价估算' }, '估算')
                : null),
            h('td', { className: 'px-sv-col-provider px-sv-muted' }, row.provider === '' ? DASH : row.provider),
            h('td', { className: 'px-sv-col-num px-sv-num' }, tokenText(row.buckets, 'hit')),
            h('td', { className: 'px-sv-col-num px-sv-num' }, tokenText(row.buckets, 'miss')),
            showWrite ? h('td', { className: 'px-sv-col-num px-sv-num px-sv-col-write' }, tokenText(row.buckets, 'write')) : null,
            h('td', { className: 'px-sv-col-num px-sv-num' }, tokenText(row.buckets, 'output')),
            h('td', { className: 'px-sv-col-num px-sv-num px-sv-unit px-sv-col-unit', title: row.unitHint }, row.unitText),
            h('td', { className: 'px-sv-col-num px-sv-num px-sv-amount-cell' }, row.amountText),
          ))),
          h('tfoot', null, h('tr', null,
            h('th', { scope: 'row', colSpan: 2 }, '合计'),
            h('td', { className: 'px-sv-col-num px-sv-num' }, sumText(models, 'hit')),
            h('td', { className: 'px-sv-col-num px-sv-num' }, sumText(models, 'miss')),
            showWrite
              ? h('td', { className: 'px-sv-col-num px-sv-num px-sv-col-write' }, sumText(models, 'write'))
              : null,
            h('td', { className: 'px-sv-col-num px-sv-num' }, sumText(models, 'output')),
            h('td', { className: 'px-sv-col-num px-sv-col-unit' }, ''),
            h('td', { className: 'px-sv-col-num px-sv-num px-sv-amount-cell' }, model.modelsTotalText),
          )),
        ),
      ),
    ),

    // ── 第四行：逐日花费 | 账户 | 请求分布（三块并排）─────────────
    // 早先这一行只有两块，右边空出半屏——用户的原话是「搞这么多空隙出来为什么」。
    // 补上第三块（请求分布）之后，这一行被三块铺满，右侧不再有空白。
    h('div', { className: 'px-sv-band px-sv-band-three', 'data-px-sv-row': 'bottom' },
      // 逐日花费：迷你柱状（不另立合计，见 sessionCostModel 的说明）
      // 日期 + 归一化细条 + 金额。条长按这几天里最贵的一天归一，哪天最贵一眼可读；
      // 原来的 token 数列收掉了——它与金额在这一格只有半栏宽时表达的是同一件事。
      days.length === 0 ? null : h(
        PanelCard,
        { title: '逐日花费', note: `${days.length} 天` },
        h('ul', { className: 'px-sv-days' }, days.map((day) => h(
          'li',
          { key: day.key, className: 'px-sv-day' },
          h('span', { className: 'px-sv-day-label' }, day.label),
          h(Meter, { share: day.share, thin: true, tone: 'accent' }),
          h('b', { className: 'px-sv-num px-sv-day-value' }, day.amountText),
        ))),
        h('p', { className: 'px-sv-card-foot' }, '条长按这几天里最贵的一天归一。'),
      ),

      // 账户
      h(
        PanelCard,
        { title: '当前模型来源的账户', note: '按这条会话正在用的来源绑定' },
        h(AccountBlock, { account }),
      ),

      // 请求分布：峰/闲两段（与看板详情那条水平条同一种表达）。
      // 它同时是「模型的回复时间」那组数据之外，用户最想看到的时间事实：
      // 这次会话有多少请求落在贵时段。
      h(
        PanelCard,
        {
          title: '请求分布',
          note: model.requests === undefined ? undefined : `共 ${model.requests.total} 次`,
        },
        model.requests === undefined
          ? h('p', { className: 'px-sv-empty' }, '这条会话没有记录请求的发生时刻（旧宿主，或来自其它设备的历史）。')
          : h('div', { className: 'px-sv-peak' },
            h('div', { className: 'px-sv-peak-head' },
              h('span', { className: 'px-sv-peak-peak' }, `峰时 ${model.requests.peakText}`),
              h('span', { className: 'px-sv-peak-idle' }, `闲时 ${model.requests.idleText}`)),
            h('div', {
              className: 'px-peak-bar',
              title: `峰时 ${model.requests.peak} 次 / 闲时 ${model.requests.idle} 次请求`,
            },
            h('span', { className: 'px-peak-fill', style: { width: model.requests.peakText } }),
            h('span', { className: 'px-peak-rest' })),
            h('p', { className: 'px-sv-card-foot' },
              `峰时 ${model.requests.peak} 次 · 闲时 ${model.requests.idle} 次请求。`)),
      ),
    ),

    // ── 团队（多成员时才有）────────────────────────────────────
    model.team === undefined ? null : h(
      PanelCard,
      {
        title: `团队成员（${model.team.memberCount} 位）`,
        // 团队合计与本次会话合计是两笔账，附注里明写「团队合计」，避免被读成同一个数。
        note: `团队合计 ${model.team.costText}`,
        wide: true,
      },
      h('ul', { className: 'px-sv-members' }, model.team.members.map((member) => h(
        'li',
        { key: member.id, className: 'px-sv-member' },
        h('span', { className: 'px-sv-member-name' }, member.name,
          // 徽标写「负责人」而不是 role 的原值 lead：成员名本身常常就叫 lead，
          // 两处同字会读成重复。
          member.role === 'lead' ? h('span', { className: 'px-sv-tag' }, '负责人') : null),
        h(Meter, { share: member.share, thin: true, tone: 'accent' }),
        h('b', { className: 'px-sv-num px-sv-member-value' }, member.amountText),
      ))),
      h('p', { className: 'px-sv-card-foot' }, '团队口径是给「一支团队一起花了多少」用的，本会话自己的金额在上方。'),
    ),

    // ── 脚注：只在数字需要打折扣时才出现 ────────────────────────
    model.notes.length === 0
      ? null
      : h('div', { className: 'px-sv-notes' }, model.notes.map((note, index) => h('p', { key: index }, note))),
  )
}

/**
 * 槽位组件：取数 + 定时刷新 + 把账户与当前模型来源对上。
 *
 * 作为 `conversation.view` 的槽位项渲染，因此会收到该槽位的标准属性
 * （`sessionId`、`useProjection` 等）。切换会话时 `sessionId` 变化会立刻重取。
 *
 * ## 三种数据源各取各的
 *
 * 会话明细（`/dsh-pixel/session`）、余额（`/dsh-pixel/balance`）、套餐
 * （`/dsh-pixel/plans`）互不依赖：任一坏掉都不该把另外两个拖成空白。账户那一块
 * 与输入框费用条同一套判据（{@link resolveAccount}），因此两处不会各说各话。
 *
 * ## `props.data` 是给闸门的直通口
 *
 * 传了 `data` 就跳过取数直接渲染（`renderToStaticMarkup` 不执行 effect，容器在
 * 闸门里永远停在「加载中」，否则 ready 那一整棵结构永远没被验过）。
 *
 * ## 首帧先吃内存缓存，再在后台刷新
 *
 * 初始 state 直接用 {@link peekSession} 拿到的那一份：切回这个标签页时**首帧就有
 * 数字**，不再「先闪一下加载中再等一次往返」。缓存过期后由下面的 effect 静默刷新，
 * 刷新失败也**不清空**已显示的旧数据（加一行「刷新失败」）。
 *
 * ## 定时器只在页面可见时跑
 *
 * 标签页切到后台时清掉 interval：一个看不见的面板每 30 秒请求一次宿主纯属浪费
 * （宿主那次调用要碰账本聚合）。切回来时先刷新一次再重新起表。
 * @param {object} props - 槽位标准属性（含 sessionId / useProjection / data）。
 * @returns {object} React 元素。
 */
function SessionCostView(props) {
  const sessionId = props?.sessionId
  const injected = props?.data
  const [state, setState] = useState(() => {
    // 首帧：有新鲜缓存就直接进 ready（用户要的「留到内存里」）。
    const cached = peekSession(sessionId)
    return cached === undefined
      ? { phase: 'loading', data: undefined, error: '' }
      : { phase: 'ready', data: cached, error: '' }
  })
  const [nonce, setNonce] = useState(0)
  const [accountData, setAccountData] = useState({ balance: undefined, plans: undefined })

  const reload = useCallback(() => { setNonce((value) => value + 1) }, [])

  useEffect(() => {
    // 闸门直通口：给了 data 就不取数（也不起定时器）。
    if (injected !== undefined) return undefined
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    let cancelled = false
    /**
     * 先把状态对齐到**这条**会话的缓存。
     *
     * 两个作用：
     *   - 有新鲜缓存 → 立刻 ready（首帧就有数字，而不是先闪「正在读取」）；
     *   - 没有缓存 → 退回 loading。这一条不能省：`sessionId` 变化时组件通常不重挂，
     *     若沿用上一份 `state.data`，切换会话的那一瞬间会把**上一条会话的金额**
     *     显示在这条会话的标题下面——数字看起来完全正常，因此最难被发现。
     */
    const cached = peekSession(sessionId)
    setState((prev) => {
      if (cached !== undefined) return { phase: 'ready', data: cached, error: '' }
      if (prev.phase === 'loading' && prev.data === undefined) return prev
      return { phase: 'loading', data: undefined, error: '' }
    })
    const load = (refresh) => {
      fetchSession(sessionId, { refresh })
        .then((payload) => {
          if (!cancelled) setState({ phase: 'ready', data: payload, error: '' })
        })
        .catch((error) => {
          if (cancelled) return
          const message = String(error?.message ?? error ?? '')
          // 失败时**先看手上有没有旧数据**：有就继续显示它（另加一行「刷新失败」），
          // 没有才退到降级卡片。把已经读到的数字清空是最糟的一种「修复」。
          if (refresh === true) {
            setState((prev) => (prev.phase === 'ready' && prev.data !== undefined
              ? { ...prev, error: message }
              : { phase: 'failed', data: undefined, error: message }))
            return
          }
          const reason = typeof error?.reason === 'string' ? error.reason : 'failed'
          const phase = reason === 'missing' || reason === 'missing-route' ? reason : 'failed'
          setState({ phase, data: undefined, error: message })
        })
    }
    // 缓存命中时这里几乎是同步的（不发请求），页面已经是 ready。
    // `nonce > 0` 是「点了重试」：那时必须真的取一次，命中缓存也要取。
    load(nonce > 0)

    /**
     * 定时器只在页面可见时存在：`document.visibilityState` 判定，切后台就清掉。
     * 闸门（renderToStaticMarkup）里没有 document，直接当作可见——effect 本来也不跑。
     */
    const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    let timer
    const start = () => {
      if (timer !== undefined) return
      timer = setInterval(() => { load(true) }, SESSION_REFRESH_MS)
    }
    const stop = () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (isVisible()) {
        load(true)
        start()
      } else {
        stop()
      }
    }
    if (isVisible()) start()
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      cancelled = true
      stop()
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }
  }, [sessionId, nonce, injected])

  useEffect(() => {
    if (injected !== undefined) return undefined
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    let cancelled = false
    fetchBalance({})
      .then((payload) => { if (!cancelled) setAccountData((prev) => ({ ...prev, balance: payload })) })
      .catch(() => { if (!cancelled) setAccountData((prev) => ({ ...prev, balance: undefined })) })
    fetchPlans({})
      .then((payload) => { if (!cancelled) setAccountData((prev) => ({ ...prev, plans: payload })) })
      .catch(() => { if (!cancelled) setAccountData((prev) => ({ ...prev, plans: undefined })) })
    return () => { cancelled = true }
  }, [sessionId, injected])

  // 当前会话正在用的模型路由（DSH 逐请求记录的事实）。读不到时 resolveAccount
  // 会走它自己的回落链，而不是随便挑一个账户显示。
  const selection = props?.useProjection?.('modelSelection')
  const selectedPlan = useSelectedPlan()
  const account = useMemo(
    () => resolveAccount({
      selection,
      balance: accountData.balance,
      plans: accountData.plans,
      selectedPlan,
    }),
    [selection, accountData.balance, accountData.plans, selectedPlan],
  )

  const payload = injected !== undefined ? injected : state.data
  const model = useMemo(() => sessionCostModel(payload), [payload])
  // 槽位没给会话 id 时既不取数也不假装加载中（见 SESSION_STATE_TEXT 的 no-session）。
  const hasSession = typeof sessionId === 'string' && sessionId !== ''
  const phase = injected !== undefined ? 'ready' : (hasSession ? state.phase : 'no-session')

  return h(SessionCostPanel, {
    model,
    account,
    phase,
    error: state.error,
    // ready 但带着错误 = 「后台刷新失败，显示的是缓存」：面板据此加一行说明，
    // 而不是把已经显示的数字换回降级卡片。
    staleError: phase === 'ready' && state.error !== '' ? state.error : undefined,
    onRetry: reload,
  })
}

/**
 * 取一条会话的明细。
 *
 * 失败**分类**而不是只报一句话：调用方要靠 `error.reason` 决定显示哪一种降级。
 *
 * | reason | 触发 | 界面上要说的 |
 * |---|---|---|
 * | `no-session` | 没有 sessionId | 不渲染（槽位没给会话） |
 * | `missing` | 404 + 宿主答「会话不存在」 | 换一条会话 / 它已被删除 |
 * | `missing-route` | 404 但没有那句 | 旧宿主，重启 dsh |
 * | `failed` | 500 / 网络 / 解析失败 | 具体原因 + 重试 |
 *
 * ## 内存缓存（60 秒）
 *
 * `refresh !== true` 且缓存还新鲜时**直接返回缓存，不发请求**。这条路径是用户那
 * 句「每次读明细都要重新加载吗」的正面回答：切标签页、反复展开同一条会话，都不再
 * 走一次网络。
 *
 * **请求失败时不动缓存里的旧值**：读错一次不该把已经看到的数字清空——调用方会
 * 继续显示旧数据，另加一行「刷新失败」。这是「宁可显示旧数字，也不给一片空白」。
 * @param {string} sessionId - 会话 id。
 * @param {{refresh?:boolean, signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主负载。
 */
async function fetchSession(sessionId, options = {}) {
  const id = String(sessionId ?? '')
  if (id === '') {
    const error = new Error('没有会话 id')
    error.reason = 'no-session'
    throw error
  }
  // 只有显式 refresh 才绕过缓存；定时刷新走的是 refresh:true，因此它仍会真的取数。
  if (options.refresh !== true) {
    const cached = peekSession(id)
    if (cached !== undefined) return cached
  }
  const query = `id=${encodeURIComponent(id)}${options.refresh === true ? '&refresh=1' : ''}`
  let response
  try {
    response = await fetch(`${SESSION_URL}?${query}`, {
      signal: options.signal,
      headers: { accept: 'application/json' },
    })
  } catch (cause) {
    const error = new Error(`与本机宿主通信失败：${String(cause?.message ?? cause)}`)
    error.reason = 'failed'
    throw error
  }

  if (response.status === 404) {
    let body
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    const error = new Error(typeof body?.error === 'string' ? body.error : 'HTTP 404')
    // 判据是宿主有没有回那句 `会话不存在`：旧宿主这条路由根本不存在，网关回的
    // 404 没有这个字段。两者要说的下一步动作完全不同，因此必须分开。
    error.reason = body?.error === '会话不存在' ? 'missing' : 'missing-route'
    throw error
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = body.error
    } catch {
      // 响应不是 JSON 时保留状态码
    }
    const error = new Error(detail)
    error.reason = 'failed'
    throw error
  }

  try {
    const payload = await response.json()
    // 只有**成功且解析得出来**的响应才进缓存：404 / 500 不该被记住，
    // 否则「重启宿主后就有了」那种情形会一直被缓存里的失败挡住。
    const now = Date.now()
    // 顺手清掉过期条目：Map 只写不删的话，翻过一百条会话就会一直攒着 payload
    // （每条都带逐模型 + 逐日明细），长开着的页面会慢慢吃内存。
    for (const [key, entry] of detailCache) {
      if (now - entry.at >= SESSION_CACHE_TTL_MS) detailCache.delete(key)
    }
    detailCache.set(id, { at: now, payload })
    return payload
  } catch (cause) {
    const error = new Error(`宿主返回的不是合法 JSON：${String(cause?.message ?? cause)}`)
    error.reason = 'failed'
    throw error
  }
}

			exports.SESSION_VIEW_ID = SESSION_VIEW_ID
			exports.SESSION_URL = SESSION_URL
			exports.SESSION_REFRESH_MS = SESSION_REFRESH_MS
			exports.SESSION_CACHE_TTL_MS = SESSION_CACHE_TTL_MS
			exports.peekSession = peekSession
			exports.clearSessionCache = clearSessionCache
			exports.SESSION_STATES = SESSION_STATES
			exports.SESSION_STATE_TEXT = SESSION_STATE_TEXT
			exports.SESSION_STATE_LABEL = SESSION_STATE_LABEL
			exports.usageBuckets = usageBuckets
			exports.cacheRatio = cacheRatio
			exports.sumBucket = sumBucket
			exports.sumAmounts = sumAmounts
			exports.unitPriceOf = unitPriceOf
			exports.sessionCostModel = sessionCostModel
			exports.SessionCostPanel = SessionCostPanel
			exports.SessionCostView = SessionCostView
			exports.fetchSession = fetchSession
		},
		"./sessionDetailView.js": (exports, require) => {
			const m1 = require("./format.js")
			/**
 * 「图二」那一套彩色富信息的会话详情视图。
 *
 * ## 为什么单独成一个文件
 *
 * 这四个组件（{@link HeroCard} / {@link DetailRow} / {@link TimingBreakdownView} /
 * {@link SessionDetail}）是**两处共用**的：
 *   - 看板「消费 Top 会话」展开时（`dashboard.js` 的 `TopSessions`）；
 *   - 会话标签页「费用」（`sessionView.js` 的 `SessionCostPanel`）的第一行与第二行。
 *
 * 早先它们只住在 `dashboard.js` 里，费用页要复用就只能复制一份——两份视觉实现
 * 迟早漂移（这一轮之前正是「克制配色」把费用页做成了中性墨色，而看板还留着彩色）。
 * 因此把「图二的实现」抽到这里，两个页面 import 同一份。
 *
 * ## 视觉口径（**不要重写**）
 *
 * 用户明确说过喜欢这一版：hero 卡带左侧色条、耗时是三色堆叠条、明细是标签-色点-值。
 * 配色与版式全部在 `theme.js` 的 DASHBOARD 常量里（`.px-hero*` / `.px-timing*` /
 * `.px-drow*` / `.px-peak*`），本文件只负责结构与读数，一行样式都不写。
 * @module dsh-pixel-dashboard/client/sessionDetailView
 */

const React = require('react')
const formatCny = m1.formatCny
const formatDurationMs = m1.formatDurationMs
const formatTokens = m1.formatTokens
const { createElement: h } = React

/**
 * 详情里的一枚「主打指标」卡（hero）。
 *
 * ## 视觉层级
 *
 * 十来个数字做成同样大小会变成数字墙。这里分两层：
 *   - **hero**：最该被第一眼看到（金额、token、耗时、工具次数）——大号数字 + 左侧色条；
 *   - **明细**：其余数字用小号标签-值行，靠虚线分隔，安静地排在下面。
 * @param {object} props - tone / label / value / foot。
 * @returns {object} React 元素。
 */
function HeroCard(props) {
  const { tone, label, value, foot } = props
  return h('div', { className: `px-hero px-hero-${tone ?? 'accent'}` },
    h('span', { className: 'px-hero-label' }, label),
    h('span', { className: 'px-hero-value' }, value),
    foot === undefined || foot === '' ? null : h('span', { className: 'px-hero-foot' }, foot))
}

/**
 * 明细行：左侧色点 + 标签，右侧数值。
 *
 * 色点与 hero 的色条用同一套语义色，于是「这个数属于哪一类」不用读文字就知道。
 * @param {object} props - tone / label / value / title。
 * @returns {object} React 元素。
 */
function DetailRow(props) {
  const { tone, label, value, title } = props
  return h('div', { className: 'px-drow', title },
    h('span', { className: 'px-drow-label' },
      h('span', { className: `px-dot px-dot-${tone ?? 'blue'}` }),
      label),
    h('span', { className: 'px-drow-value' }, value))
}

/**
 * 会话耗时构成：横向堆叠条 + 图例。
 *
 * ## 为什么不用环形图（上一版被否）
 *
 * 环形图的问题是**读数成本高**：要顺着弧长目测比例，且中间的总时长与三段的关系
 * 不明显。用户明确说不喜欢，而且他先前就表达过偏好「条形」。
 *
 * ## 这一版的做法
 *
 * 一条横向堆叠条把三段按比例铺开（谁占得多一眼可见），下面三行图例给出
 * 精确百分比与时长。总时长放在条的**左端**作为锚点——先看到「总共多久」，
 * 再看「花在哪」，符合阅读顺序。
 *
 * ## 配色
 *
 * 等待（暖黄）→ 回复（蓝）→ 工具（青绿），沿用项目既有马卡龙 token。
 * @param {object} props - timing。
 * @returns {object} React 元素。
 */
function TimingBreakdownView(props) {
  const { timing } = props
  const ttft = Number(timing?.ttftMs ?? 0)
  const gen = Number(timing?.genMs ?? 0)
  const tools = Number(timing?.toolsMs ?? 0)
  const total = ttft + gen + tools

  if (!Number.isFinite(total) || total <= 0) {
    return h('div', { className: 'px-timing px-timing-empty' },
      h('span', { className: 'px-timing-empty-title' }, '耗时构成'),
      h('span', { className: 'px-muted' },
        '这份日志里没有 step 计时（可能是更早版本写入的日志，或该会话没有完整跑过一轮）。'))
  }

  const segments = [
    { key: 'wait', value: ttft, tone: 'yellow', label: '等待模型' },
    { key: 'reply', value: gen, tone: 'blue', label: '模型回复' },
    { key: 'tools', value: tools, tone: 'green', label: '工具执行' },
  ].filter((segment) => segment.value > 0)
  const percent = (value) => Math.round((value / total) * 100)

  return h('div', { className: 'px-timing' },
    // 左端：总时长锚点
    h('div', { className: 'px-timing-total' },
      h('b', null, formatDurationMs(total)),
      h('span', null, '模型在干活'),
      // 平均每轮放在这里：它是「总时长 ÷ 轮次」，与总时长同源，放一起最自然。
      Number(timing.turns) > 0
        ? h('span', { className: 'px-timing-avg' }, `平均每轮 ${formatDurationMs(total / Number(timing.turns))}`)
        : null),
    // 中间：堆叠条
    h('div', { className: 'px-timing-main' },
      h('div', { className: 'px-timing-bar' },
        segments.map((segment) => h('span', {
          key: segment.key,
          className: `px-timing-seg px-timing-seg-${segment.tone}`,
          style: { width: `${(segment.value / total) * 100}%` },
          title: `${segment.label} ${formatDurationMs(segment.value)}（${percent(segment.value)}%）`,
        }))),
      // 图例：色点 + 名称 + 百分比 + 时长
      h('div', { className: 'px-timing-legend' },
        segments.map((segment) => h('span', { key: segment.key, className: 'px-timing-item' },
          h('span', { className: `px-tdot px-tdot-${segment.tone}` }),
          h('span', { className: 'px-timing-item-name' }, segment.label),
          h('span', { className: 'px-timing-item-pct' }, `${percent(segment.value)}%`),
          h('span', { className: 'px-timing-item-ms' }, formatDurationMs(segment.value))))),
      // 「思考」无法切分：如实说明，不给假数。
      h('p', { className: 'px-timing-note' },
        '「模型思考」与「模型回复」在同一条消息里到达，日志层面无法分离，',
        '因此合并计入「模型回复」。')))
}

/**
 * 一个会话的用量详情（就地展开）。
 *
 * ## 布局（三轮迭代后的定稿）
 *
 *   1. 团队标签页（有成员时）
 *   2. 四枚 hero 指标：金额 / Token / 模型耗时 / 工具次数
 *   3. 耗时构成横向堆叠条——回答「时间花在哪」
 *   4. 两栏明细：花费与时段 / 时间与模型
 *   5. 请求分布条
 *
 * ## 时间口径（用户纠正的关键点）
 *
 * 「活跃时长 = 创建到最后使用」被用户否掉了：会话放三周再用，会被算成几百小时。
 * 现在 hero 里的「模型耗时」= 等待 + 回复 + 工具，即**模型真正在干活的那段时间**；
 * 「平均每轮」= 模型耗时 / 轮次。这才是「我花了多少时间等它」。
 *
 * ## `models` 的兜底
 *
 * 看板展开时 `lead` 是 `/data` 的会话行（带 `models`），但**团队成员**来自
 * `data.teams[].members`，那一份没有 `models` 字段。原来这里直接
 * `session.models.join()`，一切到成员标签页就抛 TypeError（整块详情变白）。
 * 因此只对这一个字段收口，读数与视觉都不变。
 * @param {object} props - lead / members / timezone。
 * @returns {object} React 元素。
 */
function SessionDetail(props) {
  const { lead, members } = props
  const [picked, setPicked] = React.useState(-1)
  const list = Array.isArray(members) ? members : []
  const index = picked >= 0 && picked < list.length ? picked : -1
  const session = index < 0 ? lead : list[index]

  const totals = session.totals ?? {}
  const cost = session.cost ?? {}
  const timing = session.timing ?? {}
  const activeMs = Number(timing.totalMs ?? 0)
  const turns = Number(session.turns ?? 0)
  const avgTurnMs = activeMs > 0 && turns > 0 ? activeMs / turns : undefined
  const maxTurnMs = Number.isFinite(session.maxTurnMs) && session.maxTurnMs > 0 ? session.maxTurnMs : undefined

  const peek = totals.peak ?? {}
  const pello = totals.idle ?? {}
  const peakTokens = Number(peek.local ?? 0)
  const idleTokens = Number(pello.local ?? 0)
  const peakRequests = Number(peek.requests ?? 0)
  const idleRequests = Number(pello.requests ?? 0)
  const totalRequests = peakRequests + idleRequests
  const peakRatio = totalRequests > 0 ? peakRequests / totalRequests : undefined
  const hitBase = Number(totals.cacheHit ?? 0) + Number(totals.cacheMiss ?? 0) + Number(totals.cacheWrite ?? 0)
  const hitRate = hitBase > 0 ? Math.round((Number(totals.cacheHit ?? 0) / hitBase) * 100) : undefined

  // 团队标签用 DSH 官方称呼（Lead / 成员名），不用内部视角的「本会话」。
  const labelOf = (member, i) => {
    if (i < 0) return 'Lead'
    const name = typeof member.memberName === 'string' ? member.memberName.trim() : ''
    return name !== '' ? name : `成员 ${i + 1}`
  }
  const tabs = list.length === 0
    ? null
    : h('div', { className: 'px-dtabs', role: 'tablist' },
      [-1, ...list.keys()].map((i) => h('button', {
        key: i,
        type: 'button',
        role: 'tab',
        'aria-selected': index === i,
        className: `px-dtab${index === i ? ' px-dtab-on' : ''}`,
        title: (i < 0 ? lead : list[i]).id,
        onClick: (event) => { event.stopPropagation(); setPicked(i) },
      }, labelOf(i < 0 ? lead : list[i], i))))

  return h('div', {
    className: 'px-session-detail',
    onClick: (event) => { event.stopPropagation() },
  },
  tabs,
  h('div', { className: 'px-heroes' },
    h(HeroCard, { tone: 'accent', label: '估算金额', value: formatCny(Number(cost.standard ?? 0)),
      foot: Number(cost.saved ?? 0) > 0
        ? `错峰省下 ${formatCny(Number(cost.saved ?? 0))}`
        : '全部落在高峰时段' }),
    h(HeroCard, { tone: 'blue', label: '总 Token', value: formatTokens(Number(totals.local ?? 0)),
      foot: `${totalRequests} 次请求` }),
    // 模型耗时而不是「活跃时长」——见函数说明里的口径纠正。
    h(HeroCard, { tone: 'green', label: '模型耗时', value: activeMs > 0 ? formatDurationMs(activeMs) : '—',
      foot: avgTurnMs === undefined ? '等待 + 回复 + 工具' : `平均每轮 ${formatDurationMs(avgTurnMs)}` }),
    h(HeroCard, { tone: 'purple', label: '工具调用', value: Number.isFinite(session.toolCalls) ? `${session.toolCalls} 次` : '—',
      foot: maxTurnMs === undefined ? undefined : `最久一轮 ${formatDurationMs(maxTurnMs)}` })),

  // 耗时构成：横向堆叠条 + 图例（替代上一版的环形图——用户明确不喜欢）。
  h(TimingBreakdownView, { timing: { ...timing, turns: Number(session.turns ?? 0) } }),

  h('div', { className: 'px-dcols' },
    h('div', { className: 'px-dcol' },
      h('b', { className: 'px-dcol-title' }, '花费与时段'),
      h(DetailRow, { tone: 'yellow', label: '峰时 Token', value: formatTokens(peakTokens),
        title: `高峰时段发出 ${peakRequests} 次请求` }),
      h(DetailRow, { tone: 'blue', label: '闲时 Token', value: formatTokens(idleTokens),
        title: `空闲时段发出 ${idleRequests} 次请求` }),
      h(DetailRow, { tone: 'purple', label: '峰时占比', value: peakRatio === undefined ? '—' : `${Math.round(peakRatio * 100)}%`,
        title: '按请求数计：峰时请求 / 总请求' }),
      hitRate === undefined ? null : h(DetailRow, { tone: 'green', label: '缓存命中率', value: `${hitRate}%`,
        title: '命中 / (命中 + 未命中 + 写入)' })),
    h('div', { className: 'px-dcol' },
      h('b', { className: 'px-dcol-title' }, '时间与模型'),
      h(DetailRow, {
        tone: 'accent',
        label: '模型 × 提供商',
        value: (Array.isArray(session.models) ? session.models.join('、') : '') || '—',
      }))),

  peakRatio === undefined
    ? null
    : h('div', { className: 'px-dpeak' },
      h('div', { className: 'px-dpeak-head' },
        h('b', { className: 'px-dcol-title' }, '请求分布'),
        h('span', { className: 'px-dpeak-split' },
          h('span', { className: 'px-peak-peak' }, `峰时 ${Math.round(peakRatio * 100)}%`),
          h('span', { className: 'px-peak-idle' }, `闲时 ${Math.round((1 - peakRatio) * 100)}%`))),
      h('div', {
        className: 'px-peak-bar',
        title: `峰时 ${peakRequests} 次 / 闲时 ${idleRequests} 次请求`,
      },
      h('span', { className: 'px-peak-fill', style: { width: `${Math.round(peakRatio * 100)}%` } }),
      h('span', { className: 'px-peak-rest' }))))
}

			exports.HeroCard = HeroCard
			exports.DetailRow = DetailRow
			exports.TimingBreakdownView = TimingBreakdownView
			exports.SessionDetail = SessionDetail
		},
		"./dashboard.js": (exports, require) => {
			const m1 = require("./accountPanel.js")
			const m2 = require("./priceSettings.js")
			const m3 = require("./sessionView.js")
			const m4 = require("./sessionDetailView.js")
			const m5 = require("./balance.js")
			const m6 = require("./Notifier.js")
			const m7 = require("./notify.js")
			const m8 = require("./plans.js")
			const m9 = require("./planView.js")
			const m10 = require("./provider.js")
			const m11 = require("./format.js")
			const m12 = require("./graph.js")
			const m13 = require("./usage.js")
			/**
 * 用量看板主体：总览指标、时段状态与倒计时、活跃日历、Token 趋势、
 * 模型分布、费用估算与会话清单。只读投影，不修改任何会话状态。
 *
 * 计费口径与官方一致：高峰（**周一至周五、不含中国法定节假日** 9:00–12:00、
 * 14:00–18:00）与空闲时段分别按各自单价计价，空闲价为高峰价的一半；
 * 全部周末与法定节假日全天都按空闲计费（含调休上班的周末）。
 * 历史用量按每条请求实际发生的时段归档，因此费用不是用一个折扣近似出来的。
 * @module dsh-pixel-dashboard/client/dashboard
 */

const React = require('react')
// react-dom 只用来把设置弹层挂到 body 上。**用默认导入取 createPortal，不用命名导入**：
// 打包后走的是 require('react-dom')（没问题），但渲染闸门与 DOM 闸门会把
// lib/client/dashboard.js 当 ESM 直接 import，而 react-dom 在 Node 里是 CommonJS，
// 命名导出会直接抛「Named export 'createPortal' not found」——整个闸门连页面
// 都渲染不出来。默认导入在两种环境下都成立（CJS 互操作给的是 module.exports）。
const ReactDOM = require('react-dom')
const AccountPanel = m1.AccountPanel
const PriceSettingsButton = m2.PriceSettingsButton
const PriceSettingsView = m2.PriceSettingsView
// 「消费 Top 会话」点开时要在原地取这条会话的明细，因此复用会话标签页那条取数口
// （同一个 `/dsh-pixel/session`，同一套错误分类）。不复制一份 fetch：两份迟早漂移。
const cacheRatio = m3.cacheRatio
const fetchSession = m3.fetchSession
const usageBuckets = m3.usageBuckets
// 「图二」那套彩色详情视图（hero 卡 / 耗时堆叠条 / 明细行）从本文件抽到
// sessionDetailView.js：会话标签页的费用页也要用同一份实现，两处共用才不会漂移。
// 这里保留 `export { SessionDetail }` 是为了不破坏既有 import（渲染闸门就按它取）。
const SessionDetail = m4.SessionDetail
const balanceAvailable = m5.balanceAvailable
const balanceStatus = m5.balanceStatus
const fetchBalance = m5.fetchBalance
const formatMoney = m5.formatMoney
const setToggle = m5.setToggle
const notifyStore = m6.notifyStore
const NOTIFY_DEFAULTS = m7.NOTIFY_DEFAULTS
const NOTIFY_FLAGS = m7.NOTIFY_FLAGS
const NOTIFY_SOUND_OPTIONS = m7.NOTIFY_SOUND_OPTIONS
const PERMISSION_TEXT = m7.PERMISSION_TEXT
const playSound = m7.playSound
const soundPlan = m7.soundPlan
const composeRecentLine = m7.composeRecentLine
const permissionOf = m7.permissionOf
const requestPermission = m7.requestPermission
const saveNotify = m7.saveNotify
const credentialRows = m8.credentialRows
const credentialSummary = m8.credentialSummary
const fetchPlanCredentials = m8.fetchPlanCredentials
const fetchPlans = m8.fetchPlans
const formatResetLine = m8.formatResetLine
const partitionProviders = m8.partitionProviders
const providerChoices = m8.providerChoices
const providerStatus = m8.providerStatus
const quotaTone = m8.quotaTone
const removePlanCredentials = m8.removePlanCredentials
const tightestWindow = m8.tightestWindow
const windowProgress = m8.windowProgress
const WINDOW_ORDER = m8.WINDOW_ORDER
const planViewStore = m9.planViewStore
const useSelectedPlan = m9.useSelectedPlan
const PLAN_SHORT = m10.PLAN_SHORT
const formatCountdown = m11.formatCountdown
const formatCny = m11.formatCny
const formatCnyAxis = m11.formatCnyAxis
const formatDateTime = m11.formatDateTime
const formatDurationMs = m11.formatDurationMs
const formatMinuteOfDay = m11.formatMinuteOfDay
const formatSpan = m11.formatSpan
const formatTokens = m11.formatTokens
const minuteOfDay = m11.minuteOfDay
const ActivityCalendar = m12.ActivityCalendar
const BarChart = m12.BarChart
const BarList = m12.BarList
const DonutChart = m12.DonutChart
const TrendChart = m12.TrendChart
const useCountUp = m12.useCountUp
const dailyCosts = m13.dailyCosts
const dimensionSeries = m13.dimensionSeries
const fetchDashboard = m13.fetchDashboard
const priceByModel = m13.priceByModel
const ratesFor = m13.ratesFor
const recentDays = m13.recentDays
const sumByModel = m13.sumByModel
const sumRows = m13.sumRows
const TONES = m13.TONES
const toneBg = m13.toneBg
const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

// 详情视图的实现在 sessionDetailView.js（会话标签页的费用页共用同一份）。
// 这里转出一道导出：渲染闸门与既有调用方都按 `dashboard.js` 取 SessionDetail，
// 搬文件不该改变它们的 import 路径。

/** 趋势窗口选项。 */
const RANGES = [
  { id: '7', label: '7 日', days: 7 },
  { id: '30', label: '30 日', days: 30 },
  { id: '90', label: '90 日', days: 90 },
]

/**
 * 「构成」维度的四段：缓存命中 / 未命中 / 写入 / 输出。
 *
 * **恰好四段，且四段之和等于总量。** 账本里的计费 token 是
 * `cacheHit + cacheMiss + cacheWrite + output`（见宿主 `recordOf` 的 `u`），
 * 思考 token 不计入其中（它是输出的一部分）。早先只画三段（缺写入），
 * 于是堆叠柱的高度与卡片上的「窗口 Token」永远差一截，而那种差
 * 既不报错、也不会被谁发现——用户只会觉得两个数字对不上。
 */
const TYPE_SERIES = [
  { key: 'cacheHit', label: '缓存命中', tone: 'blue' },
  { key: 'cacheMiss', label: '未命中', tone: 'purple' },
  { key: 'cacheWrite', label: '写入', tone: 'yellow' },
  { key: 'output', label: '输出', tone: 'pink' },
]

/**
 * Token 趋势的分组维度选项。
 *
 * `type`（构成）用逐日行上的四段字段画**堆叠柱**，另外两个维度要现场按
 * `byModel` 聚合（见 `dimensionSeries`）画折线。**只显示一个维度**而不是把三个
 * 叠加：三种维度会把同一个 token 数重复计入，叠在一起就得到一个假的总量。
 *
 * 顺序按用户的使用频率排：模型 → 供应商 → 构成，默认「模型」（看板首先要回答
 * 「哪个模型花得最多」）。
 */
const TREND_DIMENSIONS = [
  { id: 'model', label: '模型' },
  { id: 'provider', label: '供应商' },
  { id: 'type', label: '构成' },
]

/**
 * 按模型 / 提供商分组时最多画几条线。
 *
 * 老账本里能出现十几个 `模型@提供商` 条目，全画上去就是一团互相压住的线，
 * 图例也会长到把面板撑开。超出的合成「其他」（见 `dimensionSeries`）。
 */
const TREND_SERIES_LIMIT = 5

/**
 * 消费趋势的两条序列：官方价 / 我的价。
 *
 * **并列而不是叠加**：两根柱子回答的是同一个问题的两个答案（「按官方价多少」
 * 与「按我补的价多少」），叠起来的高度没有意义。默认只画官方价——绝大多数
 * 人没有自定义价目，多一根同高的柱子只会让人以为哪里错了。
 */
const COST_SERIES_OFFICIAL = { key: 'official', label: '官方价', tone: 'pink' }
const COST_SERIES_MINE = { key: 'mine', label: '我的价', tone: 'blue' }

/**
 * 浏览器本地偏好：**统一前缀 `px.pref.`**，全部有默认值。
 *
 * 为什么放 localStorage 而不是宿主：这些是**这台机器上这块屏幕**的显示偏好
 * （看几天、先看哪个维度、展开多少条），跟着浏览器走才合理；写进宿主配置
 * 会让它跨设备同步，反而变成「我在手机上改了一下，桌面端布局也变了」。
 *
 * 读到脏值一律回默认：localStorage 里的东西可能是别的版本写的、可能是 `null`
 * 字符串、也可能是用户手改的。**绝不把脏值传进渲染**——那正是 `NaN` 与
 * 「空图表」的来源。
 */
const PREF_PREFIX = 'px.pref.'
const PREF_DEFAULT = {
  modelMinTokens: 10_000_000,
  modelLimit: 5,
  trendDim: 'model',
  showMyRate: false,
  range: '30',
}

/**
 * 读一条偏好。
 * @param {string} key - 不含前缀的键名。
 * @returns {*} 原始字符串值；读不到（或没有 localStorage）时 undefined。
 */
function readPrefRaw(key) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return undefined
    const value = localStorage.getItem(`${PREF_PREFIX}${key}`)
    return value === null ? undefined : value
  } catch {
    // 隐私模式 / 被禁用时 localStorage 可能直接抛错，退回默认值即可。
    return undefined
  }
}

/**
 * 写一条偏好。
 * @param {string} key - 不含前缀的键名。
 * @param {*} value - 要写入的值（布尔写成 `1` / `0`）。
 * @returns {void}
 */
function writePref(key, value) {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) return
    localStorage.setItem(`${PREF_PREFIX}${key}`, String(value))
  } catch {
    // 写不进去不影响本次会话：内存里的 state 已经生效。
  }
}

/** 非负有限数：脏值回默认。 */
function prefNumber(value, fallback, min = 0) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min) return fallback
  return number
}

/** 布尔：接受 '1' / '0' / 'true' / 'false'，其余回默认。 */
function prefBool(value, fallback) {
  if (value === undefined) return fallback
  const text = String(value).toLowerCase()
  if (text === '1' || text === 'true') return true
  if (text === '0' || text === 'false') return false
  return fallback
}

/** 枚举：不在候选里就回默认。 */
function prefEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

/**
 * 一条偏好 + 它的归一化函数，做成 `useState` 的形态。
 *
 * 归一化在**读与写两侧都做**：写入时挡住调用方传进来的脏值（比如输入框里
 * 正打着的空串），读取时挡住存储里的历史脏值。
 * @param {string} key - 不含前缀的键名。
 * @param {Function} normalize - 归一化函数 `(raw) => value`。
 * @returns {[*, Function]} 当前值与 setter。
 */
function usePref(key, normalize) {
  const [value, setValue] = useState(() => normalize(readPrefRaw(key)))
  const set = useCallback((next) => {
    // 归一化 + 落盘都在**事件处理里**做，不写进 setState 的 updater：
    // updater 可能在渲染期被 React 重复调用（StrictMode / 并发渲染），
    // 在那里写 localStorage 就成了「渲染时有副作用」。
    const shaped = normalize(next)
    writePref(key, shaped)
    setValue(shaped)
  }, [key, normalize])
  return [value, set]
}

/** 把高峰窗口数组渲染成 `9:00–12:00、14:00–18:00`。 */
/**
 * 「法定节假日」那一行的取值：说明节假日全天按空闲计费，以及日历收录到哪一年。
 *
 * 两件事都必须说：**口径**（节假日全天空闲，正是它让国庆期间的周四、周五便宜下来）
 * 与**覆盖范围**（这份日历只收录到某一年）。少了后者，跨到表外年份时界面会继续按
 * 「周一至周五」判断却不说明，用户看到的就是一个悄悄错了的时段——而这类错误不报错、
 * 不崩溃，只是把高峰按空闲计价。
 *
 * 拿不到时返回「—」而不是编一句：旧宿主根本没有这条例外，写「已收录」就是在撒谎。
 * @param {object} data - 看板数据。
 * @returns {string} 形如 `全天按空闲计费 · 已收录 2026`。
 */
function holidayRuleText(data) {
  const years = data?.peakRule?.holidays?.years
  if (!Array.isArray(years) || years.length === 0) return '—'
  const list = [...years].sort((a, b) => Number(a) - Number(b)).join('、')
  return `全天按空闲计费 · 已收录 ${list}`
}

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
  // `tone` 仍然接收但**不再着色**：概览卡是中性卡（见 theme.js 里 .px-stat 的说明），
  // 四张卡用四种颜色是「配色割裂」的直接来源。保留参数是为了不改所有调用点。
  const { label, value, format, foot, delay } = props
  return h(
    'div',
    { className: 'px-stat px-rise', style: { animationDelay: `${delay ?? 0}ms` } },
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
    props.title,
    // 标题右侧的**同排**内容（目前只有「消费趋势」的合计用它）。
    // 放在标题旁边而不是卡片最右侧：那个数字是「这张卡在说多少」，
    // 与右边的控件（切换器 / 开关）不是一类东西，离得越远越难对应。
    props.titleExtra === undefined ? null : h('span', { className: 'px-panel-total' }, props.titleExtra))

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

/**
 * 像素鲸鱼头像（DeepSeek 的品牌形象）。
 *
 * 为什么自己画而不是用官方素材：插件**零依赖、离线可用**，不能去拉远程图片，
 * 也不该把别人的品牌资源打进产物里再分发。这里用 16×16 像素网格画一只蓝鲸：
 * 圆身、上翘尾鳍、一道水柱、一颗白眼。像素风与项目名同族，小尺寸下比矢量插画清楚。
 *
 * 未登录时整体降透明度并转灰：它是**占位头像**，不该看起来像已经登录了某个人。
 * @param {object} props - size 像素边长；muted 为真时画成占位态。
 * @returns {object} React 元素。
 */
function WhaleAvatar(props) {
  const size = Number(props.size ?? 34)
  const muted = props.muted === true
  /** 16×16 网格上的方块：x/y 是格坐标，w/h 是格数。 */
  const blocks = [
    // 水柱（更淡的一档）
    { x: 7, y: 2, w: 1, h: 1, tone: 'spout' },
    { x: 9, y: 2, w: 1, h: 1, tone: 'spout' },
    { x: 8, y: 3, w: 1, h: 1, tone: 'spout' },
    // 尾鳍（上翘）
    { x: 2, y: 4, w: 1, h: 1 }, { x: 3, y: 5, w: 1, h: 1 },
    { x: 1, y: 5, w: 1, h: 1 }, { x: 2, y: 6, w: 1, h: 1 },
    // 身体
    { x: 4, y: 6, w: 8, h: 1 }, { x: 3, y: 7, w: 10, h: 1 },
    { x: 3, y: 8, w: 10, h: 1 }, { x: 4, y: 9, w: 8, h: 1 },
    { x: 5, y: 10, w: 6, h: 1 },
    // 腹部（更淡，给体积感）
    { x: 4, y: 9, w: 8, h: 1, tone: 'belly' },
    { x: 5, y: 10, w: 6, h: 1, tone: 'belly' },
    // 眼睛
    { x: 10, y: 7, w: 1, h: 1, tone: 'eye' },
  ]
  const toneOf = (tone) => {
    if (tone === 'eye') return 'var(--px-whale-eye)'
    if (tone === 'belly') return 'var(--px-whale-belly)'
    if (tone === 'spout') return 'var(--px-whale-spout)'
    return 'var(--px-whale)'
  }
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    focusable: 'false',
    className: `px-whale${muted ? ' px-whale-muted' : ''}`,
    shapeRendering: 'crispEdges',
  }, blocks.map((block, index) => h('rect', {
    key: index,
    x: block.x, y: block.y, width: block.w, height: block.h,
    fill: toneOf(block.tone),
  })))
}

/**
 * 顶行的**用户卡**：官方账号头像 + 余额 + 官网入口。
 *
 * 用户的要求：把官方余额放到顶部那一行，做成「头像 + 余额 + 链接」的用户卡；
 * 未登录时头像用经典蓝鲸占位。
 *
 * 诚实性优先于好看：
 *   - 未登录（拿不到官方凭据）→ **不发请求**，头像转占位态，写明缺哪个引用名；
 *   - 取数失败 → 保留上一次金额（若有），并在次数旁注明失败原因；
 *   - 正常 → 直接给金额与币种，不做汇率换算。
 * @param {object} props - payload / error / busy。
 * @returns {object} React 元素。
 */
function UserBalanceCard(props) {
  const { payload, error, busy, totalSpend } = props
  const rows = Array.isArray(payload?.balances) ? payload.balances : []
  /** 三种判据任一成立即算未登录（账号服务 / 旧 reason / 新 signedIn）。 */
  const signedIn = payload?.signedIn !== false
    && payload?.reason !== 'no-key'
    && payload?.reason !== 'not-signed-in'
  const failed = typeof error === 'string' && error !== ''
  const account = payload?.account
  const links = payload?.links ?? account?.links ?? {}
  /** 头像：登录后优先用官方给的 avatarUrl；没有或加载失败再退回鲸鱼。 */
  const avatarUrl = typeof account?.avatarUrl === 'string' && account.avatarUrl !== ''
    ? account.avatarUrl
    : ''

  /**
   * **只显示一个总余额**（用户要求）。
   *
   * 优先人民币钱包——它是主账户；接口若同时给多币种，这里**不做汇率换算**，
   * 直接取人民币那一个，其余币种不进这一格（避免把两个币种加成一个假数）。
   * 赠送金与累计消费降级成角落小字：它们是注释，不是主角。
   */
  const wallets = Array.isArray(payload?.wallets) ? payload.wallets : rows
  const primary = wallets.find((row) => row?.currency === 'CNY')
    ?? wallets.find((row) => Number.isFinite(Number(row?.total)))
  const bonusRows = Array.isArray(payload?.bonusWallets) ? payload.bonusWallets : []
  const bonus = bonusRows.reduce((sum, row) => sum + (Number(row?.total) || 0), 0)
  const spend = Number.isFinite(Number(totalSpend)) ? Number(totalSpend) : undefined

  const state = (() => {
    if (failed) return { text: `余额读取失败：${error}`, tone: 'warn' }
    if (payload === undefined) return { text: '读取中…', tone: 'muted' }
    if (payload.enabled === false) return { text: '余额查询已关闭', tone: 'muted' }
    if (!signedIn) {
      const ref = typeof payload.apiKeyEnv === 'string' && payload.apiKeyEnv !== ''
        ? `（缺 ${payload.apiKeyEnv}）`
        : ''
      return { text: `未登录官方账号${ref}`, tone: 'muted' }
    }
    if (primary === undefined) return { text: '官方接口没有返回余额', tone: 'muted' }
    return undefined
  })()

  const nameText = signedIn
    ? (typeof account?.name === 'string' && account.name !== '' ? account.name : 'DeepSeek 官方')
    : '未登录'
  const contact = typeof account?.contact === 'string' && account.contact !== '' ? account.contact : ''

  /**
   * 角落小字：赠送金与累计消费。两个都可能没有（未登录 / 无赠送 / 账本为空），
   * 只显示拿得到的那部分；都没有就整行不渲染，不留一条空白。
   */
  const extra = []
  if (signedIn && bonus > 0) extra.push(`赠送 ${formatCny(bonus)}`)
  if (spend !== undefined && spend > 0) extra.push(`累计消费 ${formatCny(spend)}`)

  return h('div', { className: `px-user${signedIn ? '' : ' off'}`, 'aria-label': 'DeepSeek 官方账户' },
    // 右上角：官网入口（用户要求放这里，而不是跟钱挤在一列）
    h('a', {
      className: 'px-user-link',
      href: typeof links.topUpUrl === 'string' && links.topUpUrl !== ''
        ? links.topUpUrl
        : 'https://platform.deepseek.com/usage',
      target: '_blank',
      rel: 'noreferrer',
      title: '在 DeepSeek 官网查看余额、用量与充值',
    }, signedIn ? '更多 ↗' : '去登录 ↗'),
    // 左侧主区域：头像（主视觉）+ 名字（小字，不显示手机号）
    h('div', { className: 'px-user-who' },
      h('span', { className: 'px-user-avatar' },
        avatarUrl !== '' ? h('img', {
          src: avatarUrl,
          alt: '',
          loading: 'lazy',
          referrerPolicy: 'no-referrer',
          onError: (event) => { event.currentTarget.style.display = 'none' },
        }) : null,
        h(WhaleAvatar, { size: 40 })),
      h('span', { className: 'px-user-name', title: nameText }, nameText)),
    // 右侧主区域：钱与「钱相关的注脚」放在一起（总余额 / 赠送 / 累计消费）
    h('div', { className: 'px-user-money' },
      state === undefined
        ? h('b', { className: 'px-user-total' }, formatMoney(primary.total, primary.currency))
        : h('span', {
          className: `px-user-state${state.tone === 'warn' ? ' warn' : ''}`,
          title: state.text,
        }, state.text),
      extra.length === 0
        ? null
        : h('span', {
          className: 'px-user-sub',
          title: '赠送金来自官方钱包；累计消费是本机按各模型官方单价估算的合计，不是实际账单',
        }, extra.join(' · '))))
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
      // 落在法定节假日里时宿主给出的节日名（国庆节 / 春节…），否则空串。
      // 只看 peak 无法解释「周中白天为什么便宜」，而那一刻用户最需要的就是这句解释。
      holiday: typeof data.period.holiday === 'string' ? data.period.holiday : '',
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
  // 「移除凭据」清单：与套餐额度**分开取**。两者失败互不牵连——凭据路由在旧宿主上
  // 会是 404（那时只是不画移除入口），而额度照常显示。
  //
  // 这里刻意**不带 busy**：移除过程中的「进行中」由 CredentialRemoval 自己持有。
  // 共用一个 busy 会让开关与删除互相干扰，而删除最要紧的正是防连点。
  const [credentials, setCredentials] = useState({ payload: undefined, error: '' })

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

  const loadCredentials = useCallback(() => {
    fetchPlanCredentials()
      .then((payload) => { setCredentials((prev) => ({ ...prev, payload, error: '' })) })
      .catch((error) => {
        // 旧宿主上这条路由是 404：那时**不显示错误**，只是不画移除入口。
        // 把「这台宿主没有这个功能」报成一屏红字，会让升级插件的人以为坏了。
        const message = String(error?.message ?? error)
        setCredentials((prev) => ({
          ...prev,
          error: message.includes('宿主没有') ? '' : message,
        }))
      })
  }, [])

  /**
   * 移除完成后的收尾。
   *
   * 必须**重新取一次额度**：那家现在是「未配置」了，而额度缓存（宿主 30 秒、
   * 浏览器这份）里还留着上一次成功的快照。不重取的话用户会看到「明明移除了，
   * 额度还在」——那正是最容易让人以为移除没生效的现象。
   * @param {object} body - 宿主的移除结果（含复核后的新清单）。
   */
  const afterRemoval = useCallback((body) => {
    if (body?.credentials !== undefined) {
      setCredentials((prev) => ({ ...prev, payload: body.credentials, error: '' }))
    } else {
      loadCredentials()
    }
    loadPlans(true)
  }, [loadCredentials, loadPlans])

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
    fetchPlanCredentials()
      .then((payload) => { if (!cancelled) setCredentials((prev) => ({ ...prev, payload })) })
      .catch((error) => {
        if (cancelled) return
        const message = String(error?.message ?? error)
        setCredentials((prev) => ({ ...prev, error: message.includes('宿主没有') ? '' : message }))
      })
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
    credentials: credentials.payload,
    credentialsError: credentials.error,
    onRemoved: afterRemoval,
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
    credentials, credentialsError, onRemoved,
    onRatesSaved,
  } = props
  /**
   * 四组显示偏好全部存在 localStorage（前缀 `px.pref.`），脏值回默认。
   *
   * 归一化函数用 `useCallback` 固定下来：`usePref` 的 setter 依赖它，
   * 每次渲染换一个新函数会让 setter 的引用一直变（虽然无害，但会把
   * 传给子组件的回调也一起变掉，白白触发重渲染）。
   */
  const normalizeRange = useCallback(
    (raw) => prefEnum(raw, RANGES.map((item) => item.id), PREF_DEFAULT.range),
    [],
  )
  const [rangeId, setRangeId] = usePref('range', normalizeRange)
  /**
   * Token 趋势的分组维度。
   *
   * 三种维度回答三个不同问题，**不互相替代**，因此做成切换而不是叠加：
   *   - 模型：哪个模型用得最多（同一个模型跨提供商合并，否则会重复计数）；
   *   - 供应商：量从哪条路由来；
   *   - 构成：量花在哪一段（缓存命中 / 未命中 / 写入 / 输出，堆叠柱）。
   */
  const normalizeDim = useCallback(
    (raw) => prefEnum(raw, TREND_DIMENSIONS.map((item) => item.id), PREF_DEFAULT.trendDim),
    [],
  )
  const [trendBy, setTrendBy] = usePref('trendDim', normalizeDim)
  const normalizeMinTokens = useCallback(
    (raw) => prefNumber(raw, PREF_DEFAULT.modelMinTokens, 0),
    [],
  )
  const [minTokens, setMinTokens] = usePref('modelMinTokens', normalizeMinTokens)
  const normalizeModelLimit = useCallback(
    (raw) => Math.round(prefNumber(raw, PREF_DEFAULT.modelLimit, 1)),
    [],
  )
  const [modelLimit, setModelLimit] = usePref('modelLimit', normalizeModelLimit)
  const normalizeShowMyRate = useCallback((raw) => prefBool(raw, PREF_DEFAULT.showMyRate), [])
  const [showMyRate, setShowMyRate] = usePref('showMyRate', normalizeShowMyRate)
  /** 「展开全部」是一次性的查看动作，不进偏好：下次打开仍然先看精简视图。 */
  const [expandAll, setExpandAll] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  // Token 趋势按维度摊开：`type`（构成）自己攒四段做堆叠柱，
  // 模型 / 提供商则从每天的 byModel 现场聚合（见 dimensionSeries 的注释）。
  const trend = useMemo(() => {
    if (trendBy !== 'type') {
      return { ...dimensionSeries(points, data.models, trendBy, { limit: TREND_SERIES_LIMIT }), stacked: false }
    }
    // 四段一律取自当天的 `totals`（含 cacheWrite），四段之和 === 当天 local，
    // 因此堆叠柱的高度与卡片上的窗口 Token 必然对得上。
    const shaped = points.map((point) => {
      const totals = point.totals ?? {}
      const row = { key: point.key }
      for (const line of TYPE_SERIES) row[line.key] = Number(totals[line.key] ?? 0)
      return row
    })
    return { series: TYPE_SERIES, points: shaped, stacked: true }
  }, [trendBy, points, data.models])

  /**
   * 「我的单价」覆盖后的价目：把用户补的价逐条盖到宿主交下来的那份上面。
   *
   * 只覆盖、不重建：未补价的模型继续用宿主那一份（含「估算价」的兜底口径），
   * 于是「我的价」与「官方价」的差别**只来自用户改过的那几条**。
   * 覆盖两个入口（`models` 与 `rates`）是因为 `ratesFor()` 两条都会查：
   * 新宿主走 `models`，旧宿主只有整张 `rates`。
   * @type {object}
   */
  const myPricing = useMemo(() => {
    const mine = data.customRates?.rates
    if (mine === undefined || mine === null || Object.keys(mine).length === 0) return data.pricing
    const models = { ...(data.pricing?.models ?? {}) }
    const rates = { ...(data.pricing?.rates ?? {}) }
    for (const [key, rate] of Object.entries(mine)) {
      if (rate === undefined || rate === null) continue
      models[key] = rate
      rates[key] = rate
    }
    return { ...data.pricing, models, rates }
  }, [data.pricing, data.customRates])

  /**
   * 消费趋势：逐日金额柱状图。
   *
   * 默认只画官方价一根柱；勾选「我的单价」后与官方价**并列**画第二根
   * （分组柱，不是叠加——两根柱回答同一个问题的两个答案，叠起来没有意义）。
   * 两列都走 `dailyCosts()`，因此逐日相加仍等于卡片标题行那个合计。
   */
  const costPoints = useMemo(() => {
    const official = dailyCosts(points, data.pricing)
    const mine = showMyRate ? dailyCosts(points, myPricing) : null
    return official.map((row, index) => ({
      key: row.key,
      official: row.cost,
      mine: mine === null ? undefined : mine[index]?.cost,
    }))
  }, [points, data.pricing, myPricing, showMyRate])
  const costSeries = useMemo(
    () => (showMyRate ? [COST_SERIES_OFFICIAL, COST_SERIES_MINE] : [COST_SERIES_OFFICIAL]),
    [showMyRate],
  )
  /** 我的价与官方价的差额（正数 = 我填得更贵）。只改了价的模型才影响它。 */
  const myRateDelta = useMemo(() => {
    if (!showMyRate) return 0
    return priceByModel(rangeByModel, myPricing).standard - rangeCost.standard
  }, [showMyRate, rangeByModel, myPricing, rangeCost])

  /**
   * 模型分布 / 费用明细的聚焦集合。
   *
   * 两条规则按用户要求串起来：
   *   1. **消耗阈值**（默认 1000 万 token）：只统计达到阈值的模型；
   *   2. **默认显示最近使用的 N 款**（默认 5），可「展开全部」。
   * 一条都达不到阈值时**回落成用量前 5**——面板绝不空白。
   *
   * 「最近使用」不是按名字猜的：逐日行里该条目最后一次出现的下标就是它的
   * 最近使用时刻，与排序同源，因此不会出现「显示的名字与排序依据不一致」。
   * 颜色一律按**在 `models` 里的原始下标**取，与环图同源（两处各按过滤后的
   * 下标取色，同一个条目会在两张图里显示成不同颜色——这是老 bug）。
   */
  const modelFocus = useMemo(() => {
    const models = Array.isArray(data.models) ? data.models : []
    const rows = models.map((model, index) => {
      const key = entryKeyOf(model)
      const usage = rangeByModel[key]
      let lastIndex = -1
      for (let point = points.length - 1; point >= 0; point -= 1) {
        const usageOfDay = points[point]?.byModel?.[key]
        if (usageOfDay !== undefined && Number(usageOfDay.local ?? 0) > 0) { lastIndex = point; break }
      }
      return {
        model,
        key,
        tone: TONES[index % TONES.length],
        // 逐条用量原样带上：费用明细要按它算高峰 / 空闲 token 与金额，
        // 在那边再查一次 `rangeByModel` 就等于把同一份数据取两遍。
        usage: usage ?? {},
        tokens: Number(usage?.local ?? 0),
        lastIndex,
      }
    }).filter((row) => row.lastIndex >= 0 || row.tokens > 0)

    // 最近使用的排在前面；同一天用过的按用量降序，保证顺序稳定。
    const byRecency = [...rows].sort((a, b) => (b.lastIndex - a.lastIndex) || (b.tokens - a.tokens))
    const qualified = byRecency.filter((row) => row.tokens >= minTokens)
    const fellBack = qualified.length === 0
    const pool = fellBack
      ? [...rows].sort((a, b) => b.tokens - a.tokens).slice(0, Math.max(1, modelLimit))
      : qualified
    const shown = expandAll ? pool : pool.slice(0, Math.max(1, modelLimit))
    return {
      rows,
      shown,
      /** 阈值之外还剩几条候选（「展开全部」里有几条）。 */
      poolSize: pool.length,
      hiddenCount: Math.max(0, pool.length - shown.length),
      fellBack,
      // 被阈值挡在外面的条目（用来说明「合计与上表的关系」）
      rest: rows.filter((row) => !shown.some((item) => item.key === row.key)),
    }
  }, [data.models, rangeByModel, points, minTokens, modelLimit, expandAll])

  /** 上表未列出的那些模型的花费。逐条独立计算，不做减法（避免尾数漂移）。 */
  const restCost = useMemo(() => {
    if (modelFocus.rest.length === 0) return { standard: 0, count: 0 }
    const subset = {}
    for (const row of modelFocus.rest) {
      const usage = rangeByModel[row.key]
      if (usage !== undefined) subset[row.key] = usage
    }
    return { standard: priceByModel(subset, data.pricing).standard, count: Object.keys(subset).length }
  }, [modelFocus.rest, rangeByModel, data.pricing])

  /** 消费 Top 会话：按花费降序取前 8，点击进入该会话。 */
  const topSessions = useMemo(() => {
    const sessions = Array.isArray(data.sessions) ? data.sessions : []
    const numeric = (value) => (value === undefined || value === null || !Number.isFinite(Number(value))
      ? undefined
      : Number(value))
    return sessions
      .map((session) => ({
        session,
        cost: numeric(session?.cost?.standard),
        tokens: numeric(session?.totals?.local),
      }))
      .sort((a, b) => ((b.cost ?? 0) - (a.cost ?? 0)) || ((b.tokens ?? 0) - (a.tokens ?? 0)))
      .slice(0, 8)
  }, [data.sessions])

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
        refreshing ? '刷新中' : '刷新'),
        // 设置是**弹层**而不是页面上的一块：通知、单价、显示偏好都是「偶尔改一次」
        // 的东西，常驻在正文里会占掉用户每次都要滚过去的高度。
        h('button', {
          type: 'button',
          className: 'px-btn small px-settings-btn',
          'aria-haspopup': 'dialog',
          'aria-expanded': settingsOpen,
          onClick: () => { setSettingsOpen(true) },
        }, '设置'))),

    h('div', { className: 'px-stats' },
      // 第一格：官方账号用户卡（头像 + **总余额** + 官网入口）。
      // 用户要求放在最左边第一位——它是「我是谁、还剩多少钱」，读的顺序上排在最前。
      h(UserBalanceCard, {
        payload: balance,
        error: balanceError,
        busy: balanceBusy,
        // 累计消费：官网有这个数，但账号接口没有。这里用本机账本的
        // **按官方单价估算**的累计金额（口径写在 title 里，不冒充实际账单）。
        totalSpend: Number(data.cost?.standard ?? 0),
      }),
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

    // ── 时段与计费 ＋ 活跃日历：**第二行**（用户指定）────────────
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
          // 节假日里把节日名写进徽标：那一刻「为什么是空闲」比「是空闲」更需要说明，
          // 因为按星期几看它本该是高峰。没有节日时退回原来的四种字。
          period.peak ? '高峰时段计费中'
            : (period.holiday === '' ? '空闲时段计费中' : `${period.holiday} · 空闲计费`)),
      },
      h('div', { className: 'px-period' },
        h('div', { className: 'px-period-clock' },
          h('span', { className: 'px-period-clock-label' },
            period.peak ? '距转空闲' : '距转高峰'),
          h('b', { className: 'px-period-clock-value' }, formatCountdown(period.remainMs)),
          h('span', { className: 'px-period-clock-foot' },
            `${formatMinuteOfDay(period.minute)} · ${data.timezone}`)),
        h('div', { className: 'px-rows px-period-rows' },
          // 「周一至周五」后面必须跟上「不含法定节假日」：否则国庆期间的周四、周五
          // 明明按空闲计费，这一行却说着「高峰时段 = 周一至周五」，自相矛盾。
          // 「法定节假日」单独一行已按用户要求去掉（它把这张卡撑高，而且口径已经
          // 写在上面这一行的括号里）；节假日当天的解释改由卡片右上角的徽标承担。
          h(Row, {
            label: '高峰时段',
            value: `周一至周五（不含法定节假日）${formatWindows(data.peakRule?.windows)}`,
          }),
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
      // 构成用**堆叠柱**（四段之和 === 当天总量），模型 / 供应商用折线
      // （它们回答「谁用得多」，曲线比柱子更容易看出趋势）。
      trend.stacked
        ? h(BarChart, {
          points: trend.points,
          series: trend.series,
          stacked: true,
          formatAxis: formatTokens,
          formatValue: formatTokens,
          ariaLabel: 'token 构成堆叠柱',
        })
        : h(TrendChart, {
          points: trend.points,
          series: trend.series,
          formatAxis: formatTokens,
          formatValue: formatTokens,
        })),

      h(Panel, {
        title: `${range.label}消费趋势`,
        tone: 'pink',
        delay: 320,
        // 合计金额**跟在标题右边**（用户要求）。柱子的形状告诉「哪天贵」，
        // 这个数字回答「一共多少」；勾了「我的单价」时并排列两个合计。
        titleExtra: showMyRate && myRateDelta !== 0
          ? `官方 ${formatCny(rangeCost.standard)} · 我的 ${formatCny(rangeCost.standard + myRateDelta)}`
          : formatCny(rangeCost.standard),
        // 右侧放「我的单价」开关：它只影响这张图画几根柱子，属于这张卡自己的控件
        // （原来在设置弹层的「显示」页里，用户得翻两层才找得到）。
        extra: h('label', { className: 'px-inline-toggle', title: '勾上后与官方价并列再画一根柱子（不叠加）' },
          h('input', {
            type: 'checkbox',
            checked: showMyRate === true,
            onChange: (event) => { setShowMyRate(event.target.checked) },
          }),
          h('span', null, '我的单价')),
      },
      h(BarChart, {
        points: costPoints,
        series: costSeries,
        // 轴用紧凑金额（`¥0.038`），读数与合计仍用完整的 formatCny
        formatAxis: formatCnyAxis,
        formatValue: formatCny,
        ariaLabel: '逐日消费柱状图',
      }))),

    // ── 套餐余额：第三方订阅额度（每家一张卡，环形条 + 进度条）────────
    h(AccountPanel, {
      balance,
      balanceError,
      balanceBusy,
      onToggleBalance,
      plans,
      plansError,
      plansBusy,
      onTogglePlans,
      credentials,
      credentialsError,
      onRemoved,
      now,
      timeZone: data.timezone,
      selectedPlan,
      onSelectPlan,
    }),

    // ── 模型分布 ＋ 费用明细：同一张卡片组，共用一条阈值 / 条数工具条 ──
    // 两块必须显示**同一批**模型，否则「环图里有的、明细里没有」会把对账搞乱。
    h('div', { className: 'px-model-group' },
      h('div', { className: 'px-model-bar' },
        h('span', { className: 'px-model-bar-hint' },
          modelFocus.fellBack
            ? `没有模型达到 ${formatTokens(minTokens)}，按用量显示前 ${modelFocus.poolSize} 款`
            : `只统计 ≥ ${formatTokens(minTokens)} 的模型 · 最近使用的 ${modelFocus.shown.length} 款`),
        modelFocus.poolSize > modelFocus.shown.length
          ? h('button', {
            type: 'button',
            className: 'px-btn small',
            onClick: () => { setExpandAll(true) },
          }, `展开全部（共 ${modelFocus.poolSize} 款）`)
          : null,
        expandAll && modelFocus.poolSize > Math.max(1, modelLimit)
          ? h('button', {
            type: 'button',
            className: 'px-btn small',
            onClick: () => { setExpandAll(false) },
          }, '只看最近使用')
          : null,
        modelFocus.rest.length > 0
          ? h('span', { className: 'px-muted' },
            `另有 ${modelFocus.rest.length} 款未列出，合计 ${formatCny(restCost.standard)}`)
          : null),

      h('div', { className: 'px-grid-2' },
        h(Panel, { title: '模型分布', tone: 'purple', delay: 340 },
          h(ModelBreakdown, {
            rows: modelFocus.shown,
            rangeTotals,
            totalRows: modelFocus.rows.length,
            minTokens,
            fellBack: modelFocus.fellBack,
          })),
        h(Panel, { title: '费用明细', tone: 'pink', delay: 380 },
          h(CostTable, {
            rows: modelFocus.shown,
            pricing: data.pricing,
            myPricing,
            showMyRate,
            rangeCost,
            restCost,
            split,
            rangeLabel: range.label,
            // 补价入口交给定价工作流（费用明细里每条一个按钮，点开浮层改单个模型）
            onRatesSaved,
          })))),

    // ── 消费 Top 会话 ──────────────────────────────────────────────
    // 完整会话清单不再留在看板（它进会话标签页），这里只留「花得最多的几条」，
    // 点击进去看那条会话的账——看板要回答的是「花在哪」，不是「一共有几条会话」。
    h(Panel, {
      title: '消费 Top 会话',
      tone: 'blue',
      delay: 420,
      extra: `共 ${Array.isArray(data.sessions) ? data.sessions.length : 0} 个会话 · 按花费排序`,
    },
    h(TopSessions, { rows: topSessions, timezone: data.timezone, teams: data.teams })),

    // 底部口径说明：只留**会改变读数理解**的两句（多厂商单价怎么来、金额是什么口径）。
    // 详细的计费口径属于 README，天天摆在读数下面只会让人先跨过它才能看到数字。
    h('p', { className: 'px-source' },
      '单价与时段口径来自 ',
      h('a', {
        href: data.pricing?.source ?? 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
        target: '_blank',
        rel: 'noreferrer',
      }, '各厂商官方定价页'),
      // 「实际账单以服务商为准」在买断制下是误导：第三方中转 / Coding Plan
      // 不按 token 计费，所以这里的金额与它们毫无关系，而不是「略有出入」。
      '。金额按各模型官方单价估算；第三方中转与 Coding Plan 是买断制，不按 token 计费，不在此列。'),

    // 设置弹层放在最后：它渲染到 body 上（浮层），与页面排版无关，
    // 放这里只是让「点开设置」这个动作的入口与出口在代码里也挨着。
    h(SettingsDialog, {
      open: settingsOpen,
      onClose: () => { setSettingsOpen(false) },
      data,
      onRatesSaved,
      minTokens,
      onMinTokens: setMinTokens,
      modelLimit,
      onModelLimit: setModelLimit,
      showMyRate,
      onShowMyRate: setShowMyRate,
      trendDim: trendBy,
      onTrendDim: setTrendBy,
    }),
  )
}

/**
 * 会话的显示名：与 DSH 侧栏同一条回落链。
 *
 * 持久标题 → 工作目录末段 → 会话 id 片段。旧宿主不返回 `title`，只有 `workspace`，
 * 那时至少显示目录名（用户认得出），而不是退回一串十六进制。
 * @param {object} session - `sessions[]` 里的一行。
 * @returns {string} 显示名。
 */
function sessionTitleOf(session) {
  const raw = typeof session?.title === 'string' ? session.title.trim() : ''
  if (raw !== '') return raw
  const workspace = typeof session?.workspace === 'string' ? session.workspace.trim() : ''
  if (workspace !== '') return workspace
  return `${String(session?.id ?? '').slice(8, 16)}…`
}

/**
 * 消费 Top 会话：只留「花得最多的几条」，点标题进入该会话。
 *
 * 完整会话清单**不再留在看板**（它进会话标签页）：看板要回答的是「花在哪」，
 * 而一百多行的清单只会把「还剩多少」推到很远的地方。
 *
 * 跳转走的是通知运行时那一条已经验证过的通道（`notifyStore().openSession`），
 * 不自己找 `uiWorkspace`：那条路径已经处理了「duplicate 服务不可用」「先 focus
 * 再切会话」等一堆坑，看板没必要再实现一遍。
 * @param {object} props - rows（已排好序的 `{session,cost,tokens}`）/ timezone / teams。
 * @returns {object} React 元素。
 */
function TopSessions(props) {
  const { rows, timezone, teams } = props
  /**
   * 展开哪一条（**不跳转会话**）。
   *
   * 用户的要求改过一次：原来点标题是跳到那条会话，现在要「展开显示该会话的费用明细」。
   * 判据也顺手变清楚了：这张表是**看板**的读数工具（谁最贵、贵在哪），
   * 跳走会把人从"比较"拽进"单条"，反而丢上下文。
   */
  const [expanded, setExpanded] = useState('')
  /** 会话 id → { status, payload, error }：同一条反复点开不该反复取数。 */
  const [details, setDetails] = useState({})

  const load = useCallback((sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    setDetails((prev) => (prev[sessionId] === undefined || prev[sessionId].status === 'failed'
      ? { ...prev, [sessionId]: { status: 'loading' } }
      : prev))
    fetchSession(sessionId)
      .then((payload) => {
        setDetails((prev) => ({ ...prev, [sessionId]: { status: 'ready', payload } }))
      })
      .catch((error) => {
        setDetails((prev) => ({
          ...prev,
          [sessionId]: { status: 'failed', error: String(error?.message ?? error) },
        }))
      })
  }, [])

  const toggle = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    setExpanded((prev) => {
      if (prev === sessionId) return ''
      load(sessionId)
      return sessionId
    })
  }

  /**
   * 这条会话所属团队的**其它成员**（不含它自己）。
   *
   * 数据取自 `/data` 的 `teams[].members`：团队归属只有宿主算得出来（要沿父链向上
   * 走），客户端不该自己按 `teamId` 再拼一遍成员表。没有团队时返回空数组，
   * `SessionDetail` 就不会画标签页。
   *
   * 成员行与 `/data` 的会话行**不是同一个形状**（它只有 totals/cost/name，没有
   * timing/toolCalls/models）。这里补成 `SessionDetail` 认的形状：切到成员标签页时
   * 缺字段显示 `—`，而不是把整块详情炸掉。
   * @param {object} session - 当前会话行。
   * @returns {object[]} 可直接交给 `SessionDetail` 的成员数组。
   */
  const membersOfSession = (session) => {
    const teamId = typeof session?.teamId === 'string' ? session.teamId : ''
    const list = Array.isArray(teams) ? teams : []
    const team = teamId === '' ? undefined : list.find((row) => String(row?.id ?? '') === teamId)
    const members = Array.isArray(team?.members) ? team.members : []
    const selfId = String(session?.id ?? '')
    return members
      .filter((member) => String(member?.id ?? '') !== selfId)
      .map((member) => ({
        ...member,
        // 标签页读的是 `memberName`（会话行上的字段名），团队名册里叫 `name`。
        memberName: typeof member.memberName === 'string' && member.memberName !== ''
          ? member.memberName
          : String(member?.name ?? ''),
        // 团队口径只有用量与金额，没有逐模型的键：给空数组而不是 undefined，
        // SessionDetail 里那句 models.join 才不会在切标签页时抛错。
        models: Array.isArray(member.models) ? member.models : [],
        timing: member.timing ?? {},
      }))
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return h('p', { className: 'px-muted' }, '还没有会话记录。跑一轮对话之后这里会按花费排出前几名。')
  }

  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table px-top-session-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, '会话'),
          h('th', { className: 'px-num' }, '花费'),
          h('th', { className: 'px-num' }, 'Token'),
          h('th', null, '最后活跃'))),
      h('tbody', null,
        rows.map(({ session, cost, tokens }) => {
          const title = sessionTitleOf(session)
          const id = String(session?.id ?? '')
          const lastAt = Number(session?.lastAt ?? 0) || Number(session?.createdAt ?? 0)
          const isOpen = expanded !== '' && expanded === id
          return [
            h('tr', {
              key: id !== '' ? id : title,
              className: `px-top-session-row${isOpen ? ' open' : ''}`,
              onClick: () => { toggle(id) },
            },
            h('td', null,
              // 标题是一枚按钮：整行可点只是鼠标方便，**键盘可达**靠它
              // （`<span onClick>` 的话 Tab 永远到不了这一行）。
              h('button', {
                type: 'button',
                className: 'px-session-open',
                'aria-expanded': isOpen,
                title: `${title}\n${id}`,
                onClick: (event) => { event.stopPropagation(); toggle(id) },
              },
              // 展开指示：小三角随状态旋转，说明「这里能点开」。
              h('i', { className: `px-caret${isOpen ? ' open' : ''}`, 'aria-hidden': 'true' }),
              h('span', null, title)),
              session?.live === true ? h('span', { className: 'px-badge ok' }, '进行中') : null),
            h('td', { className: 'px-num' },
              cost === undefined ? h('span', { className: 'px-muted' }, '—') : formatCny(cost)),
            h('td', { className: 'px-num' },
              tokens === undefined ? h('span', { className: 'px-muted' }, '—') : formatTokens(tokens)),
            h('td', null, lastAt > 0 ? formatDateTime(lastAt, timezone) : h('span', { className: 'px-muted' }, '—'))),
            isOpen
              ? h('tr', { key: `${id}-detail`, className: 'px-top-session-detail-row' },
                h('td', { colSpan: 4 },
                  // 「图二」那一套：四枚彩色 hero + 三色耗时堆叠条 + 峰/闲明细。
                  // 用户明确要它回来（「之前那种版本都挺好看的」），所以这里用完整版，
                  // 而不是前一轮被做稀的紧凑版。
                  h(SessionDetail, {
                    key: 'rich',
                    lead: session,
                    members: membersOfSession(session),
                    timezone,
                  }),
                  // 下面是**逐模型金额**小表（来自 `/dsh-pixel/session` 的 entries）：
                  // 它回答「这条会话的钱具体花在哪几款模型上」，是 SessionDetail 没有的一层。
                  // 用户要的是「更丰富」，不是「替换」，因此两块都留。
                  h(SessionDetailInline, { key: 'models', state: details[id], timezone })))
              : null,
          ]
        }))))
}

/**
 * Top 会话里展开的那块明细：**紧凑版**，不是把整个会话标签页搬过来。
 *
 * 这里只回答「这条会话贵在哪」：峰谷拆分 + 逐模型金额（最多 6 行）。
 * 要看逐日、缓存命中率、余额绑定，去会话里的「费用」标签页——两处职责不同，
 * 都铺满会让这张表从"比较"退化成"第二份报表"。
 * @param {object} props - state（loading/ready/failed）/ timezone。
 * @returns {object} React 元素。
 */
function SessionDetailInline(props) {
  const { state } = props
  if (state === undefined || state.status === 'loading') {
    return h('p', { className: 'px-muted px-top-detail-state' }, '读取这条会话的明细…')
  }
  if (state.status === 'failed') {
    return h('p', { className: 'px-muted px-top-detail-state' }, `取不到明细：${state.error}`)
  }
  const payload = state.payload ?? {}
  const entries = Array.isArray(payload.entries) ? payload.entries : []
  const days = Array.isArray(payload.days) ? payload.days : []
  const total = payload.cost ?? {}
  if (entries.length === 0 && days.length === 0) {
    return h('p', { className: 'px-muted px-top-detail-state' }, '这条会话没有按模型的用量记录（可能是旧宿主或其它设备的历史）。')
  }
  const shown = entries.slice(0, 6)
  const rest = entries.length - shown.length
  // 缓存命中率的分母是**计费输入**（命中 + 未命中 + 写入）；没有输入时整项省略，
  // 写成 0% 会把「还没有输入」显示成「缓存完全没命中」，是两种处境。
  const totals = payload.session?.totals
  const ratio = totals === undefined ? undefined : cacheRatio(totals)
  const buckets = totals === undefined ? undefined : usageBuckets(totals)
  const team = payload.team
  const teamMembers = Array.isArray(team?.members) ? team.members : []

  return h('div', { className: 'px-top-detail' },
    // 第一行：四项事实并排（峰/谷/可省/命中率）。命中率缺就不渲染那一项。
    h('div', { className: 'px-top-detail-sum' },
      h('span', null, '高峰 ', h('b', null, formatCny(total.peak ?? 0))),
      h('span', null, '空闲 ', h('b', null, formatCny(total.idle ?? 0))),
      h('span', null, '若全走空闲可省 ', h('b', null, formatCny(total.saved ?? 0))),
      ratio === undefined
        ? null
        : h('span', null, '缓存命中率 ', h('b', null, `${(ratio * 100).toFixed(1)}%`)),
      buckets === undefined
        ? null
        : h('span', null, '计费输入 ', h('b', null, formatTokens(buckets.billed)))),

    // 团队：这条会话若是某个多成员团队的一员，把「整队花了多少、谁花得多」说清楚。
    // 少这一块，用户会以为这一行的金额就是全部（而团队口径本来就不一样）。
    team === null || team === undefined
      ? null
      : h('div', { className: 'px-top-detail-team' },
        h('span', { className: 'px-top-detail-team-title' },
          `团队成员 ${team.memberCount ?? teamMembers.length} 位 · 合计 `,
          h('b', null, formatCny(team.cost?.standard ?? 0))),
        h('ul', { className: 'px-top-detail-members' },
          teamMembers.slice(0, 4).map((member) => h('li', { key: member.id },
            h('span', { className: 'px-top-detail-model', title: member.name }, member.name ?? member.id),
            h('span', { className: 'px-num' }, formatTokens(member.totals?.local)),
            h('span', { className: 'px-num px-top-detail-cost' }, formatCny(member.cost?.standard ?? 0))))),
        teamMembers.length > 4
          ? h('p', { className: 'px-muted px-top-detail-state' }, `另有 ${teamMembers.length - 4} 位成员未列出。`)
          : null),

    h('ul', { className: 'px-top-detail-models' },
      shown.map((entry) => h('li', { key: entry.key },
        h('span', { className: 'px-top-detail-model', title: entry.key }, entry.label ?? entry.rollup ?? entry.key),
        h('span', { className: 'px-num' }, formatTokens(entry.totals?.local)),
        h('span', { className: 'px-num px-top-detail-cost' }, formatCny(entry.cost?.standard ?? 0)),
        entry.priced === false ? h('span', { className: 'px-badge' }, '估算价') : null))),
    rest > 0
      ? h('p', { className: 'px-muted px-top-detail-state' }, `另有 ${rest} 款模型未列出（去会话的「费用」标签页看全部）。`)
      : null,

    // 逐日：最多 6 天，做成一行紧凑的「日期 · 金额」而不是又一张表。
    days.length === 0
      ? null
      : h('div', { className: 'px-top-detail-days' },
        days.slice(-6).map((day) => h('span', { key: day.key, className: 'px-top-detail-day' },
          h('i', null, day.key.slice(5)),
          h('b', null, formatCny(day.cost?.standard ?? 0))))))
}

/** 设置弹层的页签：通知 / 模型单价 / 显示。 */
const SETTINGS_TABS = [
  { id: 'notify', label: '通知' },
  // 「单价」页按**提供商**分栏（左栏是你接的那几家，右栏是那一家下面的模型），
  // 因此页签名字写全「模型单价」：它不再是价目表的总览，而是逐家的价格设置。
  { id: 'pricing', label: '模型单价' },
  { id: 'display', label: '显示' },
]

/**
 * 设置弹层。
 *
 * 三块「偶尔改一次」的东西从看板正文收进来：通知开关（原先占了整整一张卡片）、
 * 单价设置、以及显示偏好（阈值 / 显示条数 / 趋势默认维度 / 是否画我的单价）。
 *
 * 四条交互约束，每条都对应一类用户打不开或关不掉：
 *   - **收起时整个节点不渲染**（不是 `display:none`）：留一个不可见的壳会挡住下面的点击，
 *     而界面上完全看不出来；
 *   - **Esc 关**：`role="dialog"` 就必须能 Esc 收起；
 *   - **点外面关**：用 `pointerdown` 而不是 `click`——后者要等鼠标抬起，用户按住拖动
 *     （比如选文字）时面板会一直开着；
 *   - **打开时把焦点移进面板**：键盘用户不必先 Tab 一圈才到内容上。
 *
 * 浮层挂到 `document.body`：留在 `.px-root` 里会被卡片的 `overflow` 与入场动画裁掉。
 * @param {object} props - open / onClose / data / onRatesSaved / 各偏好与 setter。
 * @returns {object|null} React 元素。
 */
function SettingsDialog(props) {
  const {
    open, onClose, data, onRatesSaved,
    minTokens, onMinTokens, modelLimit, onModelLimit,
    showMyRate, onShowMyRate, trendDim, onTrendDim,
  } = props
  const [tab, setTab] = useState('notify')
  const panelRef = useRef(null)
  // 阈值 / 条数用草稿：输入过程中不能每敲一个字符就改看板（「1」与「1000 万」
  // 是两个完全不同的筛选条件，中间态会让下面两张卡片连续闪烁）。
  const [wanDraft, setWanDraft] = useState('')
  const [limitDraft, setLimitDraft] = useState('')

  useEffect(() => {
    if (open !== true) return
    setWanDraft(String(Math.round(Number(minTokens) / 10_000)))
    setLimitDraft(String(Math.round(Number(modelLimit))))
  }, [open, minTokens, modelLimit])

  useEffect(() => {
    if (open !== true) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose?.()
      }
    }
    // capture 阶段收键：产品自己也监听 Esc（关输入框、退出面板），
    // 不抢在它前面的话，「关设置」会先被别的东西吃掉。
    document.addEventListener('keydown', onKey, true)
    const node = panelRef.current
    if (node !== null && typeof node.focus === 'function') node.focus()
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open, onClose])

  if (open !== true) return null

  const commitWan = () => {
    const wan = Number(wanDraft)
    onMinTokens?.(Number.isFinite(wan) && wan >= 0 ? wan * 10_000 : PREF_DEFAULT.modelMinTokens)
  }
  const commitLimit = () => {
    const value = Number(limitDraft)
    onModelLimit?.(Number.isFinite(value) && value >= 1 ? Math.round(value) : PREF_DEFAULT.modelLimit)
  }

  const body = tab === 'notify'
    ? h(NotifyPanel)
    : tab === 'pricing'
      ? h(PriceSettingsView, { data, onSaved: onRatesSaved })
      : h('div', { className: 'px-prefs' },
        h('label', { className: 'px-pref' },
          h('span', { className: 'px-pref-label' }, '模型消耗阈值'),
          h('span', { className: 'px-pref-control' },
            h('input', {
              type: 'number',
              min: 0,
              step: 100,
              className: 'px-input px-pref-input',
              value: wanDraft,
              onChange: (event) => { setWanDraft(event.target.value) },
              onBlur: commitWan,
              onKeyDown: (event) => { if (event.key === 'Enter') commitWan() },
            }),
            h('span', { className: 'px-muted' }, '万 token')),
          h('span', { className: 'px-pref-hint' },
            '「模型分布」「费用明细」只统计窗口内消耗达到这个量的模型；一款都达不到时按用量显示前几款。')),
        h('label', { className: 'px-pref' },
          h('span', { className: 'px-pref-label' }, '默认显示条数'),
          h('span', { className: 'px-pref-control' },
            h('input', {
              type: 'number',
              min: 1,
              step: 1,
              className: 'px-input px-pref-input',
              value: limitDraft,
              onChange: (event) => { setLimitDraft(event.target.value) },
              onBlur: commitLimit,
              onKeyDown: (event) => { if (event.key === 'Enter') commitLimit() },
            }),
            h('span', { className: 'px-muted' }, '款')),
          h('span', { className: 'px-pref-hint' }, '超过这个数就收起，卡片上有「展开全部」。')),
        // 「消费趋势里显示我的单价」已**搬到消费趋势卡片上**（用户要求）：
        // 它改的是那张图画几根柱子，属于那张卡自己的控件，不该埋在设置里翻两层。
        h('label', { className: 'px-pref' },
          h('span', { className: 'px-pref-label' }, '趋势默认维度'),
          h('span', { className: 'px-pref-control' },
            h('select', {
              className: 'px-input px-pref-select',
              value: trendDim,
              onChange: (event) => { onTrendDim?.(event.target.value) },
            },
            TREND_DIMENSIONS.map((item) => h('option', { key: item.id, value: item.id }, item.label)))),
          h('span', { className: 'px-pref-hint' },
            'Token 趋势先画哪个维度；在卡片上切换也会被记住。')))

  const dialog = h('div', {
    className: 'px-modal-mask',
    onPointerDown: (event) => {
      // 只有点在遮罩本身上才关：点面板内部不该关（用户正在里面选东西）。
      if (event.target !== event.currentTarget) return
      /**
       * **正在操作原生下拉框时不要关**。
       *
       * 用户在设置里选「趋势默认维度 / 条数」时，下拉选项列表是浏览器自己画的浮层；
       * 在某些平台上点选项的那一下会把 pointerdown 派发到遮罩上，于是「刚点开下拉，
       * 整个设置面板就没了」——用户报的「下拉框会自动关闭」就是这个。
       * 判据取焦点：此刻焦点还在 select（或文本输入框）里，就说明这次点击是它的交互。
       */
      const active = typeof document === 'undefined' ? null : document.activeElement
      if (active !== null && active !== undefined) {
        const tag = String(active.tagName ?? '').toUpperCase()
        if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return
      }
      onClose?.()
    },
  },
  h('div', {
    className: 'px-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': '看板设置',
    tabIndex: -1,
    ref: panelRef,
  },
  h('header', { className: 'px-modal-head' },
    h('b', { className: 'px-modal-title' }, '设置'),
    h('button', {
      type: 'button',
      className: 'px-btn small px-modal-close',
      onClick: () => { onClose?.() },
      'aria-label': '关闭设置',
    }, '关闭')),
  h('div', { className: 'px-modal-tabs', role: 'tablist' },
    SETTINGS_TABS.map((item) => h('button', {
      key: item.id,
      type: 'button',
      role: 'tab',
      'aria-selected': tab === item.id,
      className: `px-modal-tab${tab === item.id ? ' px-modal-tab-on' : ''}`,
      onClick: () => { setTab(item.id) },
    }, item.label))),
  h('div', { className: 'px-modal-body' }, body)))

  // 服务端渲染 / 无 document 时直接内联渲染：闸门只渲染静态整页，弹层默认关闭，
  // 因此这一支实际只在「有人真的点开了设置」时成立。
  //
  // 判据里带上 `document.body`：渲染闸门给的是一个只带 head 的假 document，
  // 在那种环境下 createPortal 会直接抛（服务端渲染不支持 portal）。
  const portal = ReactDOM?.createPortal
  const canPortal = typeof document !== 'undefined' && document !== null && document.body != null
  if (!canPortal || typeof portal !== 'function') return dialog
  return portal(dialog, document.body)
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
 * 「移除套餐凭据」区块：逐条勾选 + 二次确认。
 *
 * ## 为什么是「勾选 + 二次确认」而不是每家一个「移除」按钮
 *
 * 用户的原话是「在客户端添加主动删除套餐凭据的功能」。删的是他自己配的密钥，
 * 而且是**不可撤销**的（DSH 的凭据文件写完就没了，插件不保留副本）。因此：
 *
 *   1. **默认全部不勾选。** 一点进来就勾好了，等于把「删除」做成了默认动作；
 *   2. **点「移除」先进入确认态**，把要删的名字逐条列出来再让用户按第二次。
 *      只按一次就删，误触的代价是密钥没了。
 *
 * ## 不可移除的条目照实画出来，但不给勾选框
 *
 * 来源是启动环境变量或 `.env` 回落层时，`unset` 要么抛错、要么是**静默空操作**。
 * 画一个勾选框再让它失败，比不画更糟——用户会以为插件坏了。所以这一类**显示**、
 * 标明来源与出路，但勾选框是禁用状态，并写清为什么。
 * @param {object} props - payload / error / busy / onRemoved / credentialFile。
 * @returns {object|null} React 元素。
 */
function CredentialRemoval(props) {
  const { payload, error, busy, onRemoved, credentialFile } = props
  /** @type {[string[], Function]} 已勾选的引用名。 */
  const [picked, setPicked] = useState([])
  /** 二次确认态：按下「移除」后进入，列出将删的条目。 */
  const [confirming, setConfirming] = useState(false)
  /** 上一次移除的逐条结果（宿主的原文）。 */
  const [results, setResults] = useState(null)
  const [localError, setLocalError] = useState('')
  /**
   * 正在发请求。
   *
   * 本地状态而不是读父级的 `busy`：父级那个是**开关**用的（余额 / 套餐），
   * 与这条路径共用会让两边互相干扰。而且这里最要紧的是防连点——
   * 删密钥的请求发两次，第二次会在第一次删完之后再删一次同样的名字。
   */
  const [working, setWorking] = useState(false)
  const disabled = busy === true || working === true

  const rows = credentialRows(payload)
  const summary = credentialSummary(payload)
  // 宿主没有可写的凭据服务（老版本 / 未挂载）：整块只在有可移除项时才画，
  // 且此时必须说清「这台机器上改不了」。
  const canWrite = payload?.writable === true

  // 清单变了（移除成功后宿主会交下新的一份）就把勾选与确认态清掉：
  // 留着已失效的勾选，下一次点「移除」会去删一批用户没再看过的东西。
  useEffect(() => {
    setPicked([])
    setConfirming(false)
  }, [payload])

  if (payload === undefined || payload === null) {
    return error === undefined || error === ''
      ? null
      : h('p', { className: 'px-balance-state px-error' }, `凭据清单读取失败：${error}`)
  }
  // 一条都没配过时整块不渲染：那正是「没什么可移除」的状态，
  // 摊开一张全是「未配置」的表只是噪音。
  if (summary.configured === 0) return null

  const togglePick = (name) => {
    setResults(null)
    setLocalError('')
    setPicked((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]))
  }

  /** 真正发移除请求。 */
  const submit = () => {
    const refs = picked
    if (refs.length === 0 || disabled) return
    setConfirming(false)
    setLocalError('')
    setWorking(true)
    removePlanCredentials(refs)
      .then((body) => {
        setResults(body)
        onRemoved?.(body)
      })
      .catch((failure) => { setLocalError(String(failure?.message ?? failure)) })
      .finally(() => { setWorking(false) })
  }

  /** 一条凭据的勾选框 + 说明。 */
  const row = (entry) => {
    const { ref, vendor } = entry
    const id = `${vendor}:${ref.name}`
    const locked = !entry.selectable || disabled
    return h('li', { key: id, className: `px-cred-row${entry.selectable ? '' : ' locked'}` },
      h('label', { className: 'px-cred-pick' },
        h('input', {
          type: 'checkbox',
          checked: picked.includes(ref.name),
          disabled: locked,
          onChange: () => { togglePick(ref.name) },
        }),
        h('code', { className: 'px-cred-name' }, ref.name)),
      ref.configured === true
        ? h('span', { className: 'px-badge' }, '已配置')
        : h('span', { className: 'px-badge idle' }, '未配置'),
      // 打码尾段：用户据此确认删的是**哪一把**（换过 Key 的机器上这一步很关键），
      // 而它不足以还原出密钥。
      ref.hint === undefined || ref.hint === ''
        ? null
        : h('span', { className: 'px-cred-hint' }, ref.hint),
      ref.sourceLabel === undefined || ref.sourceLabel === ''
        ? null
        : h('span', { className: 'px-cred-source' }, `来自 ${ref.sourceLabel}`),
      h('span', { className: 'px-cred-purpose' }, ref.purpose ?? ''),
      // 不可移除时把「为什么」和「那该怎么办」写在原地——只画一个禁用的勾选框，
      // 用户不知道下一步该去哪。
      entry.selectable || ref.configured !== true
        ? null
        : h('span', { className: 'px-cred-blocked' }, ref.blockedReason ?? '这一条插件改不了。'))
  }

  /** 一家厂商一块。 */
  const vendorBlock = (provider) => {
    const refs = Array.isArray(provider?.refs) ? provider.refs : []
    const cli = provider?.cliFile
    const entries = credentialRows({ providers: [provider] })
    const anyConfigured = refs.some((ref) => ref.configured === true) || cli?.hasKey === true
    if (!anyConfigured) return null
    return h('div', { key: provider.id, className: 'px-cred-vendor' },
      h('b', { className: 'px-cred-vendor-name' }, provider.name ?? provider.id),
      h('ul', { className: 'px-cred-list' }, entries.map(row)),
      // CLI 密钥文件：**只提示、不提供删除**。插件一直只读别人的密钥文件，
      // 但用户必须知道「移除完这里，那家可能仍然是已配置」。
      cli === undefined || cli.hasKey !== true
        ? null
        : h('p', { className: 'px-cred-cli' },
          h('b', null, '另外还读到一份 CLI 凭据：'),
          h('code', null, cli.path ?? ''),
          ` ${cli.note ?? ''}`))
  }

  const pickedRows = rows.filter((entry) => picked.includes(entry.ref.name))

  return h('div', { className: 'px-cred' },
    h('div', { className: 'px-cred-head' },
      h('b', null, '移除套餐凭据'),
      h('span', { className: 'px-muted' },
        `已配置 ${summary.configured} 条 · 其中可直接移除 ${summary.removable} 条`)),
    h('p', { className: 'px-cred-intro' },
      '勾选之后点「移除」，宿主的凭据服务会把这些名字从',
      h('code', null, credentialFile === undefined || credentialFile === '' ? '凭据文件' : credentialFile),
      '里删掉。移除后这些厂商会回到「未配置」。',
      h('b', null, '此操作不可撤销'),
      '，插件不保留副本——但你可以按每一家「这家凭据怎么配」里的步骤重新配回来。'),

    !canWrite
      ? h('p', { className: 'px-cred-note px-warn' },
        '宿主没有可写的凭据服务，这台机器上无法移除；下面只列出各条的现状。')
      : null,

    localError === ''
      ? null
      : h('p', { className: 'px-balance-state px-error' }, localError),
    error !== undefined && error !== ''
      ? h('p', { className: 'px-balance-state px-error' }, `凭据清单读取失败：${error}`)
      : null,

    h('div', { className: 'px-cred-vendors' },
      (Array.isArray(payload.providers) ? payload.providers : []).map(vendorBlock)),

    // 逐条结果：**成功与失败都照实列出来**。只报「已完成」会让用户以为
    // 那条来自环境变量的也删掉了，而它其实一条都没动。
    results === null
      ? null
      : h('div', { className: 'px-cred-results' },
        h('b', null, '上一次移除的结果'),
        h('ul', null, (Array.isArray(results.results) ? results.results : []).map((item) => h('li', {
          key: item.name,
          className: item.ok === true ? 'ok' : 'bad',
        },
        h('code', null, item.name),
        h('span', null, item.ok === true ? '已移除' : `未移除：${item.message ?? ''}`))))),

    confirming
      ? h('div', { className: 'px-cred-confirm' },
        h('p', null, `确认要从凭据文件里删除下面 ${picked.length} 条吗？删掉之后这些厂商会回到「未配置」。`),
        h('ul', null, pickedRows.map((entry) => h('li', { key: `c-${entry.vendor}-${entry.ref.name}` },
          h('code', null, entry.ref.name),
          h('span', { className: 'px-muted' }, ` ${entry.vendorName}`)))),
        h('div', { className: 'px-cred-actions' },
          h('button', {
            type: 'button',
            className: 'px-btn danger',
            disabled: disabled,
            onClick: submit,
          }, working === true ? '移除中…' : `确认移除 ${picked.length} 条`),
          h('button', {
            type: 'button',
            className: 'px-btn',
            disabled: working === true,
            onClick: () => { setConfirming(false) },
          }, '取消')))
      : h('div', { className: 'px-cred-actions' },
        h('button', {
          type: 'button',
          className: 'px-btn danger',
          // 一条都没勾、或宿主不能写时按钮不可用：**不给一个必然失败的动作**。
          disabled: picked.length === 0 || !canWrite || disabled,
          onClick: () => { setConfirming(true) },
        }, picked.length === 0 ? '移除' : `移除选中的 ${picked.length} 条`)),
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
 * 订阅套餐额度面板：每家的各窗口进度 + 切换器 + 开关 + 隐私说明 + 移除凭据。
 *
 * 这里刻意**不做**任何金额换算：智谱的积分、Command Code 的美元信用额与火山的
 * 积分是几套互不相通的单位，混在一起加总只会得到一个没有意义的数字。
 *
 * 「移除凭据」这一块**不受套餐总开关影响**：关掉监控只是不发请求，
 * 而「我想把这家删掉」与「我要不要看它的额度」是两件事——关着开关反而更需要
 * 那个入口（用户正是准备不再用它了）。
 *
 * 导出是为了让渲染闸门能直接渲染它（面板在整页里是并排两栏之一，单独断言它的
 * 内部结构比从整页 HTML 里切片段更可靠）。
 * @param {object} props - payload / error / busy / now / onToggle / selected / onSelect
 *   / compact / timeZone / credentials / credentialsError / onRemoved。
 * @returns {object} React 元素。
 */
function PlansPanel(props) {
  const {
    payload, error, busy, now, onToggle, selected, onSelect, compact, timeZone,
    credentials, credentialsError, onRemoved,
  } = props
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

    // 「移除套餐凭据」：折进 <details> 且默认收起。它是**破坏性**动作，
    // 常驻展开会让误触的机会变大；而它也不是日常要看的东西。
    //
    // **一条都没配过时整块（含 summary）都不渲染**：只藏内容会让用户看到一个
    // 点开是空壳的入口——那比没有入口更让人困惑。判据放在这里而不是组件内部，
    // 正是因为 summary 也在这一层。
    credentialSummary(credentials).configured === 0
      ? null
      : h('details', { className: 'px-details px-cred-details' },
        h('summary', null, '移除套餐凭据'),
        h(CredentialRemoval, {
          payload: credentials,
          error: credentialsError,
          onRemoved,
          // 路径优先取清单自己那一份（两处都由宿主解析，值相同）；
          // 清单还没到手时退回套餐负载里的那份，免得这一行空着。
          credentialFile: credentials?.credentialFile ?? payload?.credentialFile,
        })),

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
 * 通知面板：系统通知授权、分类开关、待办与最近通知。
 *
 * 它住在**设置弹层**的「通知」页签里，不再占看板正文的一整张卡片：通知开关是
 * 「偶尔改一次」的东西，而看板要回答的是「花了多少 / 花在哪 / 还剩多少」。
 *
 * 余额预警与套餐额度预警**整体取消**（连同阈值设置）：余额在会话标签页与输入框
 * 费用条里直接看得见，实时弹通知只是重复说同一件事。因此这里只剩授权三态、
 * 开关列表、待办与最近通知。
 * @returns {object} React 元素。
 */
/**
 * 面板里的试听：用**与真实通知完全相同的发声函数**播一次。
 *
 * 为什么必须共用：如果试听另写一套，用户会听到「试听是这个声、真实通知是另一个声」
 * ——那是最难解释的一类不一致，而且只在真跑完一轮时才会暴露。
 *
 * 组件外的时间戳做去重：换选项时 `click` 与 `change` 会先后触发，不去重就会连响两声。
 * 400ms 足够覆盖这两个事件的间隔，又短到不会挡住用户「再点一次再听一次」。
 * @param {string} mode - 下拉框选项值。
 * @param {string} [url] - 自定义音频地址。
 */
let lastPreviewAt = 0
function previewOnce(mode) {
  if (mode === 'system' || mode === 'off') return
  const now = Date.now()
  if (now - lastPreviewAt < 400) return
  lastPreviewAt = now
  try {
    // 自定义音效的地址存在配置里，点击时读**最新**值（ref 由调用方更新）。
    playSound(soundPlan({ notifySound: mode, notifySoundUrl: previewUrl }))
  } catch {
    // 试听失败不影响任何设置：用户还能通过下一次真实通知确认。
  }
}

/** 最近一次渲染看到的自定义音频地址，供试听读取（避免把整份 config 传进模块级函数）。 */
let previewUrl = ''

/**
 * 通知面板（设置弹层的「通知」页签）。
 *
 * **导出是为了闸门能直接渲染它**：弹层默认关着，静态渲染整页永远看不到这块内容，
 * 而「授权三态各写不同的字」「申请授权只在 default 下出现」这些恰恰是最需要断言的
 * ——混成一句「未授权」会让用户反复点一个不会有任何反应的按钮。
 * @returns {object} React 元素。
 */
function NotifyPanel() {
  const store = useMemo(() => notifyStore(), [])
  const snapshot = useNotifySnapshot(store)
  const config = { ...NOTIFY_DEFAULTS, ...(snapshot.config ?? {}) }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
  const soundMode = typeof config.notifySound === 'string' ? config.notifySound : 'system'
  // 试听函数是模块级的（不进组件闭包），自定义音频地址在这里同步给它。
  previewUrl = typeof config.notifySoundUrl === 'string' ? config.notifySoundUrl : ''

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

    // ── 提示音 ────────────────────────────────────────────────────
    // 只影响**本插件的通知**，不动 Windows 全局声音设置：
    // 选「关闭」或任一自定义音效时，我们给系统通知加 `silent`，
    // 再由插件自己发声（内置音效现场合成，自定义给个音频地址）。
    h('div', { className: 'px-notify-flags' },
      h('label', { className: 'px-notify-flag px-notify-sound', title: '只影响 DSH 的通知气泡，不改 Windows 全局声音设置' },
        h('span', null, '提示音'),
        h('select', {
          className: 'px-input px-notify-sound-select',
          value: soundMode,
          disabled: saving,
          // 点开下拉就先响一声当前选项。
          // 原生 <select> 在「重复选中同一项」时**不触发 change**，只靠 onChange 的话
          // 「再点一次听一遍」会没声音；而加个试听按钮又多余。两个入口都接上，
          // 再用 400ms 去重，避免换选项时连响两次。
          onClick: () => { previewOnce(soundMode) },
          onChange: (event) => {
            const next = event.target.value
            save({ notifySound: next })
            // 切到能自己发声的音效就**当场试听一遍**：否则用户只能等下一次
            // 通知才知道自己选的是什么声音，选错了也无从发现。
            previewOnce(next)
          },
        },
        NOTIFY_SOUND_OPTIONS.map((option) => h('option', {
          key: option.value,
          value: option.value,
          title: option.hint,
        }, option.label))))),
    soundMode === 'system' || soundMode === 'off'
      ? null
      : h('p', { className: 'px-muted px-note px-notify-sound-note' },
        soundMode === 'system'
          ? ''
          : '「跟随系统」和「关闭」没有可试听的声音——前者交给系统，后者就是不响。'),
    soundMode === 'custom'
      ? h('div', { className: 'px-notify-flags' },
        h('label', { className: 'px-notify-flag px-notify-sound', title: 'http(s) 音频链接，或 data:audio/… 内联音频' },
          h('span', null, '音频地址'),
          h('input', {
            type: 'text',
            className: 'px-input px-notify-sound-url',
            defaultValue: config.notifySoundUrl ?? '',
            placeholder: 'https://example.com/done.mp3',
            disabled: saving,
            onBlur: (event) => { save({ notifySoundUrl: event.target.value.trim() }) },
            onKeyDown: (event) => { if (event.key === 'Enter') { save({ notifySoundUrl: event.target.value.trim() }) } },
          })))
      : null,


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
          // 带会话 id 的才可点：不属于任何会话的记录（例如权限与测试通知）
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
        '余额与套餐额度不再实时弹通知——在会话标签页与输入框上方的费用条里直接看，'
        + '比每条都提醒一次省事得多。',
        '刷新页面会清空「最近通知」，一切都只在内存里，不写任何文件。')),
  )
}

/**
 * 模型分布：环图 + 条形占比（按当前时间窗口）。
 *
 * 一条 = **模型 × 提供商**，与费用明细同一口径：同一个 DeepSeek 模型经三条路由
 * 调用就是三份用量（单价与额度归属都不同），而 `模型路由名 + 模型外显名` 那种
 * 「名字里有两条信息」的展示让人分不清哪一条才是模型。
 *
 * 只画**聚焦集合**（达到消耗阈值、最近使用的 N 款）：看这张图要回答的是「谁占大头」，
 * 一二十条长尾条目会把环图切成一圈无法辨认的细线。
 * @param {object} props - rows / rangeTotals / totalRows / minTokens / fellBack。
 * @returns {object} React 元素。
 */
function ModelBreakdown(props) {
  const { rows: focused, rangeTotals, totalRows, minTokens, fellBack } = props
  const rows = Array.isArray(focused) ? focused : []
  const visible = rows
    .filter((row) => Number(row.tokens ?? 0) > 0)
    .map((row) => {
      const share = rangeTotals.local > 0 ? (Number(row.tokens) / rangeTotals.local) * 100 : 0
      return {
        key: row.key,
        label: row.model?.label ?? row.key,
        // 颜色来自 `models` 的**原始下标**（见 View 里的 modelFocus），
        // 与费用明细、单价列表完全同源。
        tone: row.tone,
        value: Number(row.tokens),
        text: `${formatTokens(row.tokens)} · ${share.toFixed(1)}%`,
      }
    })
  if (visible.length === 0) {
    return h('p', { className: 'px-muted' }, '当前时间窗口内没有模型调用。')
  }
  const biggest = visible.reduce((best, row) => (row.value > best.value ? row : best), visible[0])
  return h('div', { className: 'px-model-grid' },
    h(DonutChart, {
      slices: visible.map((row) => ({ key: row.key, value: row.value, tone: row.tone })),
      centerTitle: '窗口内 token',
      // 中心是**整个窗口**的总量：环上只画聚焦的那几款，但「这个窗口一共用了多少」
      // 才是读者要对的那个数，换成一个「显示中的小计」会让人以为总量变小了。
      centerValue: formatTokens(rangeTotals.local),
    }),
    h('div', { className: 'px-model-side' },
      h(BarList, { rows: visible }),
      h('p', { className: 'px-muted px-note' },
        `共 ${Number(totalRows ?? visible.length)} 个「模型 × 提供商」条目 · `
        + `最大一项：${biggest.label}（${formatTokens(biggest.value)}）· `
        + (fellBack === true
          ? `没有模型达到 ${formatTokens(minTokens)}，按用量取前 ${visible.length} 款`
          : `只统计 ≥ ${formatTokens(minTokens)} 的模型`))))
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
 *
 * ## 合计行 = 上表各行之和（不是窗口合计）
 *
 * 这张表默认只列**达到消耗阈值、最近使用的那几款**（长尾条目收在「展开全部」里）。
 * 因此合计行必须是**上表几行之和**——否则「合计」与它下面看得见的明细对不上，
 * 而那种矛盾会让读者不再相信任何一个数字。窗口总计与「未列出的那部分」写在
 * 表下那一行里，两者相加就是窗口合计。
 * @param {object} props - rows / pricing / myPricing / showMyRate / rangeCost / restCost / rangeLabel / onRatesSaved。
 * @returns {object} React 元素。
 */
function CostTable(props) {
  const {
    rows: focused, pricing, myPricing, showMyRate,
    rangeCost, restCost, rangeLabel, onRatesSaved,
  } = props

  const rows = (Array.isArray(focused) ? focused : []).map((entry) => {
    const model = entry.model ?? {}
    const key = entry.key
    const usage = entry.usage ?? {}
    // 价目优先用宿主**逐条**交下来的那一份（含 GLM 这类原生 id 查不到的情况），
    // 拿不到才退回整张价目表。
    const rates = model.rates ?? ratesFor(pricing, key)
    return {
      key,
      label: typeof model.label === 'string' && model.label !== '' ? model.label : key,
      provider: typeof model.provider === 'string' ? model.provider : '',
      providerLabel: typeof model.providerLabel === 'string' ? model.providerLabel : '',
      rollup: typeof model.rollup === 'string' && model.rollup !== '' ? model.rollup : key,
      // 这一条合并了哪些路由 id，悬停可查（同一个模型在网关里有多个叫法是常态）
      routes: Array.isArray(model.routes) ? model.routes.filter((name) => typeof name === 'string') : [],
      rates,
      // 配色按**在 `models` 里的原始下标**取（由 View 的 modelFocus 算好），
      // 与「模型分布」环图完全同源。
      tone: entry.tone,
      // 不分时的模型 peak 与 idle 相同；按 peak 判定即可
      flat: Number(rates.cacheMiss?.peak ?? 0) === Number(rates.cacheMiss?.idle ?? 0)
        && Number(rates.output?.peak ?? 0) === Number(rates.output?.idle ?? 0),
      // 宿主标注的可信度：兜底价要显式说明，别让猜的数字看起来像官方价
      priced: model.priced !== false,
      tiered: model.tiered === true,
      cost: priceByModel({ [key]: usage }, pricing),
      // 「我的价」只在勾了复选框时才算：没勾的时候算出来是白算，还会让人
      // 以为界面在用一个看不见的价目。
      myCost: showMyRate === true ? priceByModel({ [key]: usage }, myPricing ?? pricing) : undefined,
      peak: peakTokensOf(usage),
      idle: idleTokensOf(usage),
      total: Number(usage.local ?? 0),
    }
  })

  if (rows.length === 0) {
    return h('p', { className: 'px-muted' },
      '当前时间窗口内没有模型调用。换一个时间窗口，或去设置里把模型消耗阈值调低。')
  }

  const anyTiered = rows.some((row) => row.tiered)
  const anyUnpriced = rows.some((row) => !row.priced)
  const anyUnknownProvider = rows.some((row) => row.provider === '')
  const anyFlat = rows.some((row) => row.flat)
  const anyMyRate = showMyRate === true

  /**
   * 单价按**模型**归组，而不是逐条（逐提供商）重复列出。
   *
   * 依据是一个事实：**价目表本身就按模型索引**（`MODEL_RATES` 的键里没有提供商）。
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

  // 合计行严格等于上表各行之和（见函数说明最后一段）
  const totalPeak = rows.reduce((sum, row) => sum + (row.flat ? row.total : row.peak), 0)
  const totalIdle = rows.reduce((sum, row) => sum + (row.flat ? 0 : row.idle), 0)
  const totalCost = rows.reduce((sum, row) => sum + row.cost.standard, 0)
  const totalMy = rows.reduce((sum, row) => sum + (row.myCost?.standard ?? 0), 0)
  const rest = restCost ?? { standard: 0, count: 0 }

  /** 某一组有没有被用户改过价（改过才多画一行「我的价」）。 */
  const myRateOf = (groupKey) => {
    if (showMyRate !== true || myPricing === undefined || myPricing === null) return undefined
    const mine = myPricing.models?.[groupKey] ?? myPricing.rates?.[groupKey]
    const official = pricing?.models?.[groupKey] ?? pricing?.rates?.[groupKey]
    if (mine === undefined || mine === official) return undefined
    return mine
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
            h('th', { className: 'px-num' }, `${rangeLabel}金额`),
            // 「我的价」只在勾选后出现：平时多一列全是同一个数的金额，
            // 只会让人以为是两条不同的账。
            anyMyRate ? h('th', { className: 'px-num' }, '我的价') : null)),
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
                row.tiered ? h('span', { className: 'px-badge' }, '按最低档') : null,
                // 补价入口：定价工作流提供（点开浮层改这一条的单价，改完金额立刻重算）。
                // `rate` 与 `pricing` 必须传：浮层要按**当前生效价**预填六个框，
                // 不传的话打开就是六个空框——用户既看不出现在是多少，也容易只填一半。
                h(PriceSettingsButton, {
                  modelKey: row.rollup,
                  label: row.label,
                  rate: row.rates,
                  pricing,
                  onSaved: onRatesSaved,
                })),
              h('td', null, row.provider === ''
                ? h('span', { className: 'px-muted', title: '旧账本记录里没有提供商信息' }, '来源未知')
                : (row.providerLabel === '' ? row.provider : row.providerLabel)),
              h('td', { className: 'px-num' }, formatTokens(peak)),
              // 不分时的那一格写成「—」而不是留空：留空会让人以为数据丢了
              h('td', { className: 'px-num' }, idle === null ? h('span', { className: 'px-muted' }, '—') : formatTokens(idle)),
              h('td', { className: 'px-num' }, formatCny(row.cost.standard)),
              anyMyRate
                ? h('td', { className: 'px-num px-my-rate' },
                  row.myCost === undefined ? h('span', { className: 'px-muted' }, '—') : formatCny(row.myCost.standard))
                : null)
          }),
          h('tr', { className: 'px-row-total' },
            h('td', null, '合计'),
            h('td', null, ''),
            h('td', { className: 'px-num' }, formatTokens(totalPeak)),
            h('td', { className: 'px-num' }, formatTokens(totalIdle)),
            h('td', { className: 'px-num' }, formatCny(totalCost)),
            anyMyRate ? h('td', { className: 'px-num px-my-rate' }, formatCny(totalMy)) : null)))),

    // 合计与窗口的关系：这张表只列了聚焦的那几款，剩下的必须有个去处，
    // 否则「合计」比上面那张概览卡小一截，读者会以为哪边算错了。
    h('p', { className: 'px-model-sum' },
      `上表合计 ${formatCny(totalCost)}`,
      rest.count > 0
        ? `（另 ${rest.count} 款未列出，合计 ${formatCny(rest.standard)}）`
        : '',
      `· 窗口合计 ${formatCny(rangeCost.standard)}`),

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
        const mine = myRateOf(group.key)
        return h('div', { key: `rate-${group.key}`, className: 'px-rate' },
          // 色块与模型名是**两个兄弟列**，不是「色块挤在名称前面」：
          //   第 1 列 = 色块（本行有几个来源就几个方块）
          //   第 2 列 = 模型名 + 归一后的键 + 来源数
          // 这一列宽度由全表最宽的那一组决定，名称左边界一致。
          h('span', { className: 'px-rate-tones' },
            group.rows.map((item) => h('i', {
              key: item.key,
              // **必须用背景色类**，不能用 `toneFill()`：后者产出的是
              // `px-tone-fill-*`，那是给 SVG 设 `fill` 的类。这里的色块是 HTML
              // 的 `<i>`，`fill` 对它的背景毫无作用——色块会变成全透明。
              className: `px-rate-swatch ${toneBg(item.tone)}`,
              title: item.providerLabel === '' ? '来源未知' : item.providerLabel,
            }))),
          h('span', { className: 'px-rate-who' },
            h('b', null, officialLabel),
            h('span', { className: 'px-muted px-mono' }, group.key),
            row.priced ? null : h('span', { className: 'px-badge' }, '估算价'),
            mine === undefined ? null : h('span', { className: 'px-badge px-my-rate-badge' }, '我的价'),
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
                : `¥${row.rates.output.idle} / ¥${row.rates.output.peak}`))),
          // 「我的价」在**同一行的第二行**里给出来：官方价与我的价的关系是
          // 「同一个模型的两种价」，并排放才看得出差多少。
          mine === undefined
            ? null
            : h('span', { className: 'px-rate-prices px-rate-mine' },
              h('span', null, h('em', null, '我的 · 缓存命中'), h('code', null, `¥${mine.cacheHit?.peak ?? 0}`)),
              h('span', null, h('em', null, '我的 · 未命中'), h('code', null, `¥${mine.cacheMiss?.peak ?? 0}`)),
              h('span', null, h('em', null, '我的 · 输出'), h('code', null, `¥${mine.output?.peak ?? 0}`))))
      })),

    // 面板底部**不写常驻说明**：单价单位、金额口径这类「恒为真」的话每块面板都
    // 摆一遍，等于让人每次看数字前先跨过一段文字（用户明确要求删过）。它们该在
    // README 的「计费口径」里。这里只留**会改变你对上面那些数字的理解**的三句。
    h('p', { className: 'px-muted px-note' },
      anyFlat
        // 表里同时有「一个价」和「两个价」的行时，必须说明差别；
        // 只写一个值的模型不分时（高峰与空闲同价），这是读者最常问的那一句。
        ? '写成一个值的模型不分时（高峰与空闲同价），写成两个值的按「空闲 / 高峰」分档。'
        : '',
      anyMyRate ? '标「我的价」的模型用你在设置里补的单价，用来和官方价对照。' : '',
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
 * ## 设计审计（第二轮，用户要求「不要只改我说的地方」）
 *
 * 逐条问过「这样对吗、有依据吗、失效时什么样」，结论如下：
 *
 * 1. **默认排序**：按最后使用倒序。旧宿主无 `lastAt` 时退回 `createdAt`，
 *    保证排序永远稳定——否则那一批会话会挤到最前，看起来像排序坏了。
 * 2. **交互**：点标题跳会话（有副作用的导航），点其余区域就地展开（无副作用）。
 *    把跳转钉在标题上，避免「想展开却切走了会话」。
 * 3. **展开态必须看得出来**：行首 ▸/▾ 箭头 + **整行粉色底**（同一时刻只展开一行，
 *    所以不会出现用户担心的满屏碎色块）。
 * 4. **团队**：lead 行标「团队 · N 名成员」；成员不占行，展开后以**标签页**切换，
 *    标签用 DSH 官方称呼（Lead / 成员名），而不是内部视角的「本会话」。
 * 5. **时长的相对尺度**：详情里有对比条，参照系是**本列表内最久的会话**——
 *    绝对尺度会让大多数会话缩成看不见的线。
 * 6. **旧宿主兼容**：缺字段一律显示 `—`，不显示 0（「不知道」≠「零」）。
 * @param {object} props - sessions / timezone / onOpenSession。
 * @returns {object} React 元素。
 */
function SessionTable(props) {
  const { sessions, timezone } = props
  // 一次只展开一行：多行同时展开会让表格高度剧烈跳动。
  const [expanded, setExpanded] = React.useState('')

  if (sessions.length === 0) return h('p', { className: 'px-muted' }, '还没有会话记录。')

  const lastOf = (session) => Number(session.lastAt ?? 0) || Number(session.createdAt ?? 0)
  // ── 团队归组：成员挂在 lead 下，不自己成为一行 ──────────────────────
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const membersOf = new Map()
  const roots = []
  for (const session of sessions) {
    if (session.role === 'teammate' && typeof session.teamId === 'string' && byId.has(session.teamId)) {
      const list = membersOf.get(session.teamId) ?? []
      list.push(session)
      membersOf.set(session.teamId, list)
    } else {
      roots.push(session)
    }
  }
  for (const list of membersOf.values()) {
    list.sort((a, b) => (Number(a.depth ?? 1) - Number(b.depth ?? 1)) || (lastOf(b) - lastOf(a)))
  }
  roots.sort((a, b) => lastOf(b) - lastOf(a))

  // ── 先算出所有行，再套 h() ─────────────────────────────────────────
  //
  // 早先这里是嵌套的 h(tbody, null, map(...).flat())，括号层数一多就极难数对
  // （我为这一处连续改错三次，还误伤过别的表格）。改成「先拼数组、再交给 h()」后
  // 结构一眼可数，也让「详情行」这种可变行数的拼接变得可控。
  const bodyRows = []
  for (const session of roots.slice(0, 40)) {
    const shortId = `${String(session.id).slice(8, 16)}…`
    const workspace = typeof session.workspace === 'string' ? session.workspace : ''
    const raw = typeof session.title === 'string' ? session.title.trim() : ''
    // 与 DSH 侧栏的 displayTitleOf 同一条回落链：持久标题 → 工作目录末段 → 会话 id。
    // 宿主已经算好了同样的链，这里再走一遍是为了**旧宿主**——它不返回 title，
    // 只有 workspace；那时至少显示目录名（用户认得出），而不是退回一串十六进制。
    const title = raw !== '' ? raw : (workspace !== '' ? workspace : shortId)
    const showWorkspace = workspace !== '' && workspace !== title
    const isOpen = expanded === session.id
    const members = membersOf.get(session.id) ?? []
    const openTitle = (event) => {
      if (typeof props.onOpenSession !== 'function') return
      event.stopPropagation()
      props.onOpenSession(session.id)
    }
    bodyRows.push(h('tr', {
      key: session.id,
      className: `px-session-row${isOpen ? ' px-session-row-open' : ''}`,
      'aria-expanded': isOpen,
      onClick: () => { setExpanded(isOpen ? '' : session.id) },
    },
    // 折叠箭头：可发现性的落点，展开时旋转 90°。
    h('td', { className: 'px-session-chev' },
      h('span', { className: `px-chev${isOpen ? ' px-chev-open' : ''}`, 'aria-hidden': 'true' }, '▸')),
    h('td', { className: 'px-session-when' },
      formatDateTime(Number(session.lastAt ?? 0) || session.createdAt, timezone)),
    h('td', null,
      h('div', { className: 'px-session-cell-inner' },
      h('span', {
        className: 'px-session-title px-session-link',
        role: 'link',
        tabIndex: 0,
        title: `${title}\n${session.id}`,
        onClick: openTitle,
        onKeyDown: (event) => { if (event.key === 'Enter') openTitle(event) },
      }, title),
      session.live ? h('span', { className: 'px-badge ok' }, '进行中') : null,
      // 团队标记：写明成员数，不展开也知道这个会话背后有团队。
      members.length > 0
        ? h('span', { className: 'px-badge team', title: '展开后可用标签页查看每个成员' },
          `团队 · ${members.length} 名成员`)
        : null,
      showWorkspace
        ? h('span', { className: 'px-session-workspace', title: session.cwd ?? '' }, workspace)
        : null,
      // 会话 id 只在这里以次要样式出现（悬停可复制）；**不进详情卡片**——
      // 用户明确说它对分析没用。
      h('span', { className: 'px-session-id px-mono', title: session.id }, shortId))),
    h('td', null, String(session.turns)),
    h('td', null, formatTokens(session.totals.local)),
    h('td', null, formatSpan(session.firstAt, session.lastAt))))

    if (isOpen) {
      bodyRows.push(h('tr', { key: `${session.id}-detail`, className: 'px-session-detail-row' },
        h('td', { colSpan: 6 }, h(SessionDetail, { lead: session, members, timezone }))))
    }
  }

  const headerRow = h('tr', null,
    h('th', { className: 'px-session-chev', 'aria-label': '展开' }),
    h('th', { title: '最后一次活动的时刻' }, '最后使用'),
    h('th', null, '会话'),
    h('th', null, '轮次'),
    h('th', null, 'Token'),
    h('th', { title: '从首次活动到最后一次活动的跨度——人真正付出的是时间' }, '活跃时长'))

  return h('div', { className: 'px-table-wrap' },
    h('table', { className: 'px-table px-session-table' },
      h('thead', null, headerRow),
      h('tbody', null, bodyRows)))
}

			exports.Dashboard = Dashboard
			exports.View = View
			exports.PlansPanel = PlansPanel
			exports.NotifyPanel = NotifyPanel
			exports.SessionTable = SessionTable
			exports.SessionDetail = SessionDetail
		},
		"./entry.js": (exports, require) => {
			const m1 = require("./dashboard.js")
			const m2 = require("./Notifier.js")
			const m3 = require("./period.js")
			const m4 = require("./SessionCost.js")
			const m5 = require("./sessionView.js")
			const m6 = require("./theme.js")
			/**
 * dsh-pixel-dashboard 的浏览器半边：
 * 1) 装载视觉系统样式表（tokens / dashboard / pricing / accounts / session 五张，
 *    都是 .px-* 局部样式）；
 * 2) 在侧栏面板列表与主区注册用量看板；
 * 3) 在输入框下方注册本次会话费用条，在会话标签页注册「费用」（会话作用域）。
 *
 * **不再注册可选主题、也不再覆盖产品令牌。** 早先这里有「奶油·昼 / 暮色·夜」两套
 * 主题注册与一层 overrideTokens 覆盖，等于替用户改掉整个产品界面的配色；皮肤已按
 * 需求移除，产品原版的深浅色与背景完全交还 DSH。看板自己的配色不依赖它们：
 * 靠 theme.js 的 --px-* 令牌 + .px-* 选择器，深色跟随读 body 上的 data-ds-dark-theme。
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
const SESSION_VIEW_ID = m5.SESSION_VIEW_ID
const SessionCostView = m5.SessionCostView
const STYLES = m6.STYLES
const { createElement: h, useEffect, useRef, useState } = React

/** 插件标识，同时用作样式标签与主题来源名。 */
const PACKAGE_ID = 'dsh-pixel-dashboard'

/** 侧栏面板与主区共用同一个 id：侧栏按钮靠它选中主区面板。 */
const PANEL_ID = 'pixel-usage'

/**
 * 会话标签页「费用」的排序与标签（契约第 4 节钉死）。
 *
 * `conversation.view` 是**会话作用域**的 list 槽位，一次只渲染一个视图，
 * 现有占用者是 chat(0) / trajectory(10) / context(20) / fleet(30) / stats(40)。
 * 取 50 使这一页排在它们**之后**：它是「回头看这笔钱花在哪」的地方，
 * 不该抢在对话视图前面。
 */
const SESSION_VIEW_ORDER = 50

/** 标签文字。用户可见文案不写 Markdown（强调用 <b>，这里不需要）。 */
const SESSION_VIEW_LABEL = '费用'

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

  // 会话标签页的「费用」：`conversation.view` 是**会话作用域**的 list 槽位，
  // 一次只渲染一个视图（现有 chat / trajectory / context / fleet / stats）。
  // order=50 落在它们之后：这一页是「读数」的地方，不该抢在对话前面。
  // 与费用条同一个 id 是刻意的——它们是同一笔钱的摘要与明细，槽位不同、互不冲突。
  slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: SESSION_VIEW_ID, order: SESSION_VIEW_ORDER, label: SESSION_VIEW_LABEL },
    SessionCostView,
  ))
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
