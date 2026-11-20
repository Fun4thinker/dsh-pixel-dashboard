import assert from 'node:assert/strict'
import { test } from 'node:test'

const source = process.argv.includes('--built') ? 'lib' : 'src'
const { buildPurchasingPower } = await import(`../${source}/client/purchasingPower.js`)

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const beijing = (value) => Date.parse(`${value}+08:00`)
const config = { route: 'openai-codex', fee: 100, currency: 'USD', anchorDate: '2026-11-16', quotaVendor: 'codex' }

function row(start, end, fields = {}) {
  return {
    start, end, current: false, complete: true, tokens: 0, requests: 0,
    pricedTokens: 0, unpricedTokens: 0, unverifiedRequests: 0,
    apiValue: 0, ratio: null, tiered: false, custom: false, ...fields,
  }
}

function quota(durationMs, ...windows) {
  return { id: String(durationMs), durationMs, windows }
}

function snapshot(generatedAt, plans, fields = {}) {
  return { schema: 1, timezone: 'Asia/Shanghai', generatedAt, dataThrough: generatedAt, usdToCny: 7,
    usagePartial: false, plans, ...fields }
}

function closeTo(actual, expected) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `expected ${expected}, got ${actual}`)
}

test('41% with API-equivalent $127 yields about $5.442857 per $1 for the full current week', () => {
  const first = beijing('2026-11-16T00:00:00')
  const now = beijing('2026-11-20T13:49:00')
  const start = beijing('2026-11-17T11:30:00')
  const current = { current: true, complete: false }
  const bill = row(first, first + 30 * DAY, current)
  const week = Object.freeze(row(start, start + WEEK, { ...current, observedAt: now, usedPercent: 41, apiValue: 127 }))
  const fiveHours = row(now - HOUR, now + 4 * HOUR, { ...current, observedAt: now, usedPercent: 8, apiValue: 3 })
  const plan = { config, billing: [bill], quota: [quota(5 * HOUR, fiveHours), quota(WEEK, week)] }
  const [{ periods, monthlyAverage }] = buildPurchasingPower(snapshot(now, [plan]))
  assert.deepEqual(periods.map(({ id, durationMs }) => [id, durationMs]), [
    ['billing', null], [String(5 * HOUR), 5 * HOUR], [String(WEEK), WEEK],
  ])
  const [projected] = periods[2].rows
  closeTo(projected.costShare, 100 * 7 / 30)
  closeTo(projected.power, 5.442857142857143)
  assert.deepEqual(projected, { ...week, costShare: projected.costShare, power: projected.power, estimated: false })
  assert.equal(periods[0].rows[0].costShare, 100)
  closeTo(periods[1].rows[0].costShare, 100 * 5 / (30 * 24))
  assert.strictEqual(monthlyAverage, periods[0].average)
  assert.deepEqual(periods[2].average, { value: null, count: 0, total: 0 })

  const later = now + DAY
  const laterWeek = { ...week, apiValue: 156, usedPercent: 65, observedAt: later }
  const [laterPlan] = buildPurchasingPower(snapshot(later, [{ ...plan, quota: [quota(WEEK, laterWeek)] }]))
  const [laterRow] = laterPlan.periods[1].rows
  assert.equal(laterRow.end - laterRow.start, WEEK)
  assert.equal(laterRow.start, start)
  assert.equal(laterRow.end, start + WEEK)
  assert.equal(laterRow.costShare, projected.costShare)
  closeTo(laterRow.power, 156 / projected.costShare)
})

test('prorates exact Beijing leap-month boundaries, including beyond the last Host bill', () => {
  const jan31 = beijing('2024-01-31T00:00:00')
  const feb29 = beijing('2024-02-29T00:00:00')
  const mar31 = beijing('2024-03-31T00:00:00')
  const reset = feb29 + 2 * DAY + 17 * HOUR
  const now = feb29 - HOUR
  const week = row(reset - WEEK, reset, { current: true, complete: false, apiValue: 43 })
  const onBoundary = row(feb29 - 5 * HOUR, feb29, { current: true, complete: false, apiValue: 5 })
  const afterBoundary = row(mar31, mar31 + 5 * HOUR, { apiValue: 2 })
  const plan = { config: { ...config, anchorDate: '2024-01-31' },
    billing: [row(jan31, feb29, { current: true, complete: false })],
    quota: [quota(5 * HOUR, onBoundary), quota(WEEK, week)] }
  const [{ periods }] = buildPurchasingPower(snapshot(now, [plan]))
  const [projected] = periods[2].rows
  const cost = 100 * ((5 - 17 / 24) / 29 + (2 + 17 / 24) / 31)
  closeTo(projected.costShare, cost)
  closeTo(projected.power, 43 / cost)
  closeTo(periods[1].rows[0].costShare, 100 * 5 / (29 * 24))

  const [withoutRecentBills] = buildPurchasingPower(snapshot(mar31 + DAY, [{ ...plan, billing: [],
    quota: [quota(5 * HOUR, { ...onBoundary, current: false, complete: true }, afterBoundary)] }]))
  assert.deepEqual(withoutRecentBills.monthlyAverage, { value: null, count: 0, total: 0 })
  const [newMonth, endsAtBoundary] = withoutRecentBills.periods[1].rows
  closeTo(newMonth.costShare, 100 * 5 / (30 * 24)) // Mar 31 → Apr 30, not Mar 29 → Apr 29.
  closeTo(endsAtBoundary.costShare, 100 * 5 / (29 * 24))
})

test('validates v1 anchor dates and never charges a quota window starting before the anchor', () => {
  const first = beijing('2026-11-16T00:00:00')
  const before = row(first - 1, first - 1 + 5 * HOUR, { apiValue: 1 })
  const exact = row(first, first + 5 * HOUR, { apiValue: 1 })
  const now = first + DAY
  const [plan] = buildPurchasingPower(snapshot(now, [{ config, quota: [quota(5 * HOUR, before, exact)] }]))
  const [bill, window] = plan.periods
  assert.deepEqual(bill, { id: 'billing', durationMs: null, rows: [], average: { value: null, count: 0, total: 0 } })
  closeTo(window.rows[0].costShare, 100 * 5 / (30 * 24))
  assert.equal(window.rows[1].costShare, null)
  assert.equal(window.rows[1].power, null)
  assert.equal(window.average.count, 1)
  assert.equal(window.average.total, 2)

  for (const invalid of ['2026-04-31', '2025-02-29', '1999-12-31', '2100-01-01', '2026-11-6']) {
    const [{ periods }] = buildPurchasingPower(snapshot(now, [{ config: { ...config, anchorDate: invalid },
      quota: [quota(5 * HOUR, exact)] }]))
    assert.equal(periods[1].rows[0].costShare, null, invalid)
  }
})

test('totals are ended intervals; weighted history includes known zero and excludes missing coverage', () => {
  const start = beijing('2024-01-31T00:00:00')
  const now = beijing('2024-03-15T00:00:00')
  const makeWeek = (day, fields) => row(start + day * DAY, start + (day + 7) * DAY, fields)
  const zero = makeWeek(0, { apiValue: 0 })
  const unverified = makeWeek(7, { apiValue: null, unverifiedRequests: 3 })
  const outage = makeWeek(14, { apiValue: 16, complete: false })
  const inherited = makeWeek(21, { apiValue: 70, unverifiedRequests: 7 })
  const crossMonth = makeWeek(28, { apiValue: 50 })
  const partialPrice = makeWeek(35, { apiValue: 5, unpricedTokens: 1 })
  const current = makeWeek(42, { apiValue: 999, current: true, complete: false })
  const future = makeWeek(49, { apiValue: 5000 })
  const windows = Object.freeze([zero, null, current, inherited, partialPrice, outage, future, crossMonth, unverified,
    { ...zero, end: zero.start }, { ...zero, start: '2024-01-31' }, { ...zero, end: NaN }, { ...zero, end: 1e20 }])
  const input = snapshot(now, [{ config: { ...config, anchorDate: '2024-01-31' }, quota: [{ ...quota(WEEK), windows }] }])
  const [{ periods }] = buildPurchasingPower(input)
  const { rows, average } = periods[1]
  assert.deepEqual(rows.map(({ start }) => start),
    [current, future, partialPrice, crossMonth, inherited, outage, unverified, zero].map(({ start }) => start))
  assert.deepEqual(rows.map(({ estimated }) => estimated), [false, false, true, false, false, false, false, false])
  assert.ok(rows[2].power > 0, 'display the part that could be priced even though it cannot enter an average')
  assert.ok(rows[5].power > 0, 'keep a known amount in an incomplete window')
  assert.equal(rows[6].power, null)
  assert.equal(rows[7].power, 0)
  assert.deepEqual(average, { value: average.value, count: 3, total: 6 })
  closeTo(average.value, (70 + 50) / (100 * (7 / 29 + 7 / 29 + 1 / 29 + 6 / 31)))

  const [withOutage] = buildPurchasingPower({ ...input, usagePartial: true })
  assert.deepEqual(withOutage.periods[1].average, { value: null, count: 0, total: 6 })
  assert.ok(withOutage.periods[1].rows.every(({ estimated }) => estimated))
  assert.equal(withOutage.periods[1].rows[7].power, 0)
})

test('different plans compare independently on the same completed monthly basis, without FX here', () => {
  const oct = beijing('2026-10-16T00:00:00')
  const nov = beijing('2026-11-16T00:00:00')
  const dec = beijing('2026-12-16T00:00:00')
  const now = nov + DAY
  const ended = row(oct, nov, { apiValue: 200 })
  const current = row(nov, dec, { current: true, complete: false, apiValue: 1500 })
  const usd = { config: { ...config, anchorDate: '2026-10-16' }, billing: [ended, current],
    quota: [quota(WEEK, row(oct, oct + WEEK, { apiValue: 1000 }))] }
  const cny = { config: { ...usd.config, route: 'team-cny', fee: 600, currency: 'CNY', quotaVendor: 'none' },
    billing: [{ ...ended, apiValue: 900 }, { ...current, apiValue: 0 }] }
  const plans = buildPurchasingPower(snapshot(now, [usd, cny]))
  assert.deepEqual(plans.map(({ config: { currency }, monthlyAverage }) => [currency, monthlyAverage]), [
    ['USD', { value: 2, count: 1, total: 1 }], ['CNY', { value: 1.5, count: 1, total: 1 }],
  ])
  assert.strictEqual(plans[0].monthlyAverage, plans[0].periods[0].average)
  assert.strictEqual(plans[1].monthlyAverage, plans[1].periods[0].average)
  assert.ok(plans[0].periods[1].average.value > plans[0].monthlyAverage.value)
  assert.equal(plans[1].periods[0].rows[0].power, 0)
  assert.deepEqual(buildPurchasingPower(null), [])
})
