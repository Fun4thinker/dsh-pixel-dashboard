/** Display-only purchasing power derived from the existing subscription-value v1 snapshot. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const asArray = (value) => Array.isArray(value) ? value : []
const validTime = (ms) => Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15
const knownAmount = (value) => Number.isFinite(value) && value >= 0

function anchorOf(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
  return { start: date.getTime() - BEIJING_OFFSET_MS, day: date.getUTCDate() }
}

function monthBoundary(monthIndex, day) {
  const year = Math.floor(monthIndex / 12)
  const month = monthIndex % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  // Clamp each month from the original anchor, not from the preceding boundary.
  return Date.UTC(year, month, Math.min(day, lastDay)) - BEIJING_OFFSET_MS
}

function billingMonthAt(time, day) {
  const date = new Date(time + BEIJING_OFFSET_MS)
  const month = date.getUTCFullYear() * 12 + date.getUTCMonth()
  return time < monthBoundary(month, day) ? month - 1 : month
}

function quotaCostShare({ start, end }, fee, anchor, billingRows) {
  if (fee === null || anchor === null || start < anchor.start) return null
  const bill = billingRows.find((row) => row.start <= start && end <= row.end)
  if (bill !== undefined) return fee * ((end - start) / (bill.end - bill.start))

  // Only extrapolate boundaries when the Host has no single bill covering this interval.
  // The requested window is half-open, so a reset exactly on a boundary belongs to the prior bill.
  const first = billingMonthAt(start, anchor.day)
  const last = billingMonthAt(end - 1, anchor.day)
  const firstStart = monthBoundary(first, anchor.day)
  const firstEnd = monthBoundary(first + 1, anchor.day)
  let share = (Math.min(end, firstEnd) - start) / (firstEnd - firstStart)
  if (last > first) {
    const lastStart = monthBoundary(last, anchor.day)
    const lastEnd = monthBoundary(last + 1, anchor.day)
    share += last - first - 1 + (end - lastStart) / (lastEnd - lastStart)
  }
  const cost = fee * share
  return Number.isFinite(cost) && cost > 0 ? cost : null
}

function powerOf(amount, cost) {
  if (!knownAmount(amount) || !Number.isFinite(cost) || cost <= 0) return null
  const ratio = amount / cost
  return Number.isFinite(ratio) ? ratio : null
}

function averageOf(rows, generatedAt) {
  let count = 0
  let total = 0
  let amount = 0
  let cost = 0
  for (const row of rows) {
    if (row.current === true || (Number.isFinite(generatedAt) && row.end > generatedAt)) continue
    total += 1
    if (row.complete !== true || row.estimated || !knownAmount(row.apiValue) || row.costShare === null) continue
    count += 1
    amount += row.apiValue
    cost += row.costShare
  }
  return { value: count === 0 ? null : powerOf(amount, cost), count, total }
}

function periodOf(id, durationMs, sourceRows, costFor, payload) {
  const rows = asArray(sourceRows)
    .filter((row) => validTime(row?.start) && validTime(row?.end) && row.start < row.end)
    .sort((a, b) => Number(b.current === true) - Number(a.current === true) || b.start - a.start)
    .map((row) => {
      const costShare = costFor(row)
      const estimated = payload.usagePartial === true || row.unpricedTokens > 0
      return { ...row, power: powerOf(row.apiValue, costShare), costShare, estimated }
    })
  return { id, durationMs, rows, average: averageOf(rows, payload.generatedAt) }
}

export function buildPurchasingPower(payload) {
  const plans = []
  for (const plan of asArray(payload?.plans)) {
    const config = plan?.config
    if (config == null) continue
    const fee = Number.isFinite(config.fee) && config.fee > 0 ? config.fee : null
    const anchor = anchorOf(config.anchorDate)
    const billing = periodOf('billing', null, plan.billing, () => fee, payload)
    const periods = [billing]
    for (const group of asArray(plan.quota)) {
      const durationMs = group?.durationMs
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) continue
      periods.push(periodOf(String(durationMs), durationMs, group.windows,
        (row) => quotaCostShare(row, fee, anchor, billing.rows), payload))
    }
    plans.push({ config, periods, monthlyAverage: billing.average })
  }
  return plans
}
