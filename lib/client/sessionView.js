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

import React from 'react'
import { resolveAccount } from './account.js'
import { fetchBalance } from './balance.js'
import { formatCny, formatDurationMs, formatTokens, shortDate } from './format.js'
import { fetchPlans } from './plans.js'
import { useSelectedPlan } from './planView.js'
// 「图二」那套彩色富信息的两个零件：hero 卡（左侧色条）与三色耗时堆叠条。
// 与看板共用同一份实现（sessionDetailView.js），两处视觉不会各写一版。
import { HeroCard, TimingBreakdownView } from './sessionDetailView.js'

const { createElement: h, useCallback, useEffect, useMemo, useState } = React

/**
 * 槽位项 id。
 *
 * 与输入框费用条（`conversation.composer.dock` 里的 `pixel-cost`）同名是刻意的：
 * 它们是「同一笔钱的摘要与明细」，在两个互不重叠的槽位里各自唯一。
 */
export const SESSION_VIEW_ID = 'pixel-cost'

/** 宿主会话明细路由（契约第 4 节）。 */
export const SESSION_URL = '/dsh-pixel/session'

/**
 * 刷新间隔。
 *
 * 宿主侧 `/data` 有 20 秒 TTL、账本聚合也不是免费的，因此这里不复用 4 秒那种
 * 快节奏：会话页是「读数」而不是「监视器」，30 秒足够，且切换会话时会立刻重取。
 */
export const SESSION_REFRESH_MS = 30_000

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
export const SESSION_CACHE_TTL_MS = 60_000

/**
 * 读内存缓存里**还没过期**的那一份（不触发任何请求）。
 *
 * 给 {@link SessionCostView} 的初始 state 用：切回这个标签页时首帧就是数字，
 * 而不是先闪一下「正在读取…」再等一次往返。
 * @param {string} sessionId - 会话 id。
 * @returns {object|undefined} 宿主负载；没有或已过期时 undefined。
 */
export function peekSession(sessionId) {
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
export function clearSessionCache() {
  detailCache.clear()
}

/** 这一页的降级状态（每一种都有可见说明，见 {@link SESSION_STATE_TEXT}）。 */
export const SESSION_STATES = ['loading', 'ready', 'missing', 'missing-route', 'failed', 'no-session']

/**
 * 每种降级状态必须说出口的那句话。
 *
 * 单独抽成常量而不是散在 JSX 里：渲染闸门可以直接断言这些字符串，而
 * `renderToStaticMarkup` 不执行 effect —— 容器在闸门里永远停在 `loading`，
 * 其余状态的文案若写在容器里就等于永远没被验过。
 */
export const SESSION_STATE_TEXT = Object.freeze({
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
export const SESSION_STATE_LABEL = Object.freeze({
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
export function usageBuckets(totals) {
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
export function cacheRatio(totals) {
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
export function sumBucket(rows, field) {
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
export function sumAmounts(rows) {
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
export function unitPriceOf(entry, pricing) {
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
export function sessionCostModel(payload) {
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
export function SessionCostPanel(props) {
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
export function SessionCostView(props) {
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
export async function fetchSession(sessionId, options = {}) {
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
