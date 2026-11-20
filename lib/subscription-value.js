/** 套餐价值：按北京时间账期用本机账本折算等效 API 金额。 */
import { usageOfRecord } from './ledger.js'
import { DEFAULT_TIMEZONE, MODEL_RATES, activeRates, costOf, isCustomRate, isPeak, normalizeModel, pricingOf, usdToCny } from './pricing.js'

// 订阅账期锚定北京时间 00:00；不使用运行机器的本地时区。
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const BILLING_LIMIT = 4
const QUOTA_LIMIT = 6

function monthBoundary(monthIndex, anchorDay) {
  const date = new Date(0)
  // 下个月的第 0 日即本月月底。每次都用原始锚点日，不从上次夹过的日期推算。
  date.setUTCFullYear(Math.floor(monthIndex / 12), monthIndex % 12 + 1, 0)
  return date.setUTCDate(Math.min(anchorDay, date.getUTCDate())) - BEIJING_OFFSET_MS
}

function intervalRow(start, end, now, through) {
  return {
    start, end, current: start <= now && now < end, complete: end <= through,
    tokens: 0, requests: 0, pricedTokens: 0, unpricedTokens: 0, unverifiedRequests: 0,
    apiValue: 0, ratio: null, tiered: false, custom: false,
  }
}

function billingRows(anchorMonth, anchorDay, now, through) {
  const today = new Date(now + BEIJING_OFFSET_MS)
  let month = today.getUTCFullYear() * 12 + today.getUTCMonth()
  if (now < monthBoundary(month, anchorDay)) month -= 1
  const rows = []
  for (; month >= anchorMonth && rows.length < BILLING_LIMIT; month -= 1) {
    rows.push(intervalRow(monthBoundary(month, anchorDay), monthBoundary(month + 1, anchorDay), now, through))
  }
  return rows
}

function quotaRows(observations, anchor, now, through) {
  const byDuration = new Map()
  for (const observation of observations) {
    const { start, observedAt, durationMs } = observation
    if (start < anchor || start > now || observedAt > now) continue
    if (!byDuration.has(durationMs)) byDuration.set(durationMs, [])
    byDuration.get(durationMs).push(observation)
  }
  return [...byDuration.keys()].sort((a, b) => a - b).map((durationMs) => ({
    id: String(durationMs),
    durationMs,
    windows: byDuration.get(durationMs).sort((a, b) => b.start - a.start).slice(0, QUOTA_LIMIT)
      .map(({ start, end, observedAt, usedPercent }) => ({ ...intervalRow(start, end, now, through), observedAt, usedPercent })),
  }))
}

function rateOf(record, rateTable) {
  const native = typeof record.n === 'string' ? record.n.trim() : ''
  const model = native === '' || native === 'unknown' ? record.r : native
  // 必须绕开合并后的单价表：补价不能把官方模型、别名或部署变体遮成自定义价。
  const key = normalizeModel(model, { builtInOnly: true })
  if (Object.hasOwn(MODEL_RATES, key)) return { rates: MODEL_RATES[key], custom: false }

  const candidates = new Set([record.r, pricingOf(model).key, model])
  const customOf = (key) => Object.hasOwn(rateTable, key) && isCustomRate(key)
  // 只允许实际路由对应的补价；规范化意外命中的「别家模型@路由」不能当成通用模型价。
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const scoped = `${candidate}@${record.p}`
    if (customOf(scoped)) return { rates: rateTable[scoped], custom: true }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && !candidate.includes('@') && customOf(candidate)) {
      return { rates: rateTable[candidate], custom: true }
    }
  }
  return undefined
}

function costInCurrency(usage, rates, time, currency, fx) {
  // 自定义美元价的生效视图已经四舍五入为人民币。拿其原币档计算，避免过早舍入或重复换汇。
  const native = rates.native ?? rates
  const period = isPeak(time, DEFAULT_TIMEZONE) ? 'peak' : 'idle'
  const amount = costOf(usage, native, period)
  const original = native.currency ?? 'CNY'
  if (original === currency) return amount
  return original === 'USD' ? amount * fx : amount / fx
}

function aggregateRows(rows, records, config, through, fx, rateTable, usagePartial) {
  for (const { record, time } of records) {
    const matching = rows.filter(({ start, end }) => start <= time && time < end)
    if (matching.length === 0) continue
    const usage = usageOfRecord(record)
    const buckets = [usage.cacheHit, usage.cacheMiss, usage.cacheWrite, usage.output]
    const tokens = record.u == null ? buckets.reduce((sum, value) => sum + value, 0) : usage.local
    if (record.v !== true || ![tokens, ...buckets].every((value) => Number.isFinite(value) && value >= 0)) {
      for (const row of matching) row.unverifiedRequests += 1
      continue
    }
    const price = rateOf(record, rateTable)
    const amount = price === undefined ? NaN : costInCurrency(usage, price.rates, time, config.currency, fx)
    for (const row of matching) {
      row.requests += usage.requests
      row.tokens += tokens
      if (!Number.isFinite(amount) || amount < 0) {
        row.unpricedTokens += tokens
      } else {
        row.pricedTokens += tokens
        row.apiValue += amount
        row.tiered ||= price.rates.tiered === true
        row.custom ||= price.custom
      }
    }
  }
  for (const row of rows) {
    const noVerifiedUsage = row.requests === 0 && (row.unverifiedRequests > 0 || usagePartial)
    if (row.start > through || noVerifiedUsage || (row.pricedTokens === 0 && row.unpricedTokens > 0)
      || !Number.isFinite(row.apiValue)) row.apiValue = null
  }
}

/**
 * 把已经验证的套餐配置和额度观测投影成看板快照，不读档也不更新观测。
 * dataThrough 是账本水位；complete 只说区间已结束且水位已到，不代表价格或来源全部可信。
 * 额度百分比是 observedAt 的上游快照，窗口内的账本用量则仍按统一水位统计。
 */
export function buildSubscriptionValue({ configs, records, observations, now, dataThrough, usagePartial = false }) {
  const through = Number.isFinite(dataThrough) ? Math.min(now, dataThrough) : -Infinity
  const fx = usdToCny()
  const rateTable = activeRates()
  const byRoute = new Map(configs.map(({ route }) => [route, []]))
  for (const record of records) {
    const matching = byRoute.get(record?.p)
    if (matching === undefined) continue
    const time = Number(record.t)
    if (Number.isFinite(time) && time <= through) matching.push({ record, time })
  }
  const plans = configs.map((config) => {
    const [year, month, day] = config.anchorDate.split('-').map(Number)
    const anchorMonth = year * 12 + month - 1
    const billing = billingRows(anchorMonth, day, now, through)
    const quota = config.quotaVendor === 'codex'
      ? quotaRows(observations?.get(config.route) ?? [], monthBoundary(anchorMonth, day), now, through)
      : []
    // 同一请求可以落在不同长度的窗口；每行独立展示，不能相加成「额度合计」。
    const rows = [...billing, ...quota.flatMap(({ windows }) => windows)]
    aggregateRows(rows, byRoute.get(config.route), config, through, fx, rateTable, usagePartial)
    for (const row of billing) if (row.apiValue !== null) row.ratio = row.apiValue / config.fee
    return { config, billing, quota }
  })
  return { schema: 1, timezone: DEFAULT_TIMEZONE, generatedAt: now, dataThrough, usdToCny: fx, usagePartial, plans }
}
