import assert from 'node:assert/strict'
import { test } from 'node:test'

const source = process.argv.includes('--built') ? 'lib' : 'src'
const { buildSubscriptionValue } = await import(`../${source}/subscription-value.js`)
const { DEFAULT_USD_TO_CNY, setCustomRates, setMarkup, setUsdToCny, validateCustomRates } = await import(`../${source}/pricing.js`)

const beijing = (value) => Date.parse(`${value}+08:00`)
const config = { route: 'openai-codex', fee: 20, currency: 'USD', anchorDate: '2024-01-31', quotaVendor: 'codex' }

function project({ configs = [config], records = [], observations = new Map(), now, dataThrough = now, usagePartial } = {}) {
  return buildSubscriptionValue({ configs, records, observations, now, dataThrough, usagePartial })
}

test('Beijing month-end anchors clamp in February, recover in March, and keep four rows at most', () => {
  const now = beijing('2024-03-31T00:00:00')
  const result = project({ now })
  assert.equal(result.schema, 1)
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.equal(result.generatedAt, now)
  assert.equal(result.dataThrough, now)
  assert.equal(result.usagePartial, false)
  assert.deepEqual(result.plans[0].config, config)
  assert.deepEqual(result.plans[0].billing.map(({ start, end, current, complete }) => [start, end, current, complete]), [
    [beijing('2024-03-31T00:00:00'), beijing('2024-04-30T00:00:00'), true, false],
    [beijing('2024-02-29T00:00:00'), beijing('2024-03-31T00:00:00'), false, true],
    [beijing('2024-01-31T00:00:00'), beijing('2024-02-29T00:00:00'), false, true],
  ])
  const [later] = project({ now: beijing('2025-02-28T00:00:00') }).plans
  assert.deepEqual(later.billing.map(({ start }) => start), [
    beijing('2025-02-28T00:00:00'), beijing('2025-01-31T00:00:00'),
    beijing('2024-12-31T00:00:00'), beijing('2024-11-30T00:00:00'),
  ])
  assert.deepEqual(project({ now: beijing('2024-01-30T23:59:59.999') }).plans[0].billing, [])
})

let sequence = 0
function request(t, fields = {}) {
  const k = `session:${++sequence}`
  const record = { k, s: 'session', t, p: config.route, v: true, n: 'gpt-6-sol', r: 'gpt-6-sol', i: 1_000_000, h: 0, w: 0, o: 0, g: 0, ...fields }
  return { u: Math.max(0, record.i - record.h - record.w) + record.h + record.w + record.o, ...record }
}

test('billing includes left edges and the data watermark, but excludes right edges and future records', () => {
  const anchor = beijing('2024-01-31T00:00:00')
  const february = beijing('2024-02-29T00:00:00')
  const march = beijing('2024-03-31T00:00:00')
  const now = march + 2
  const records = [anchor - 1, february - 1, february, march - 1, march, march + 1, now, now + 1].map((t) => request(t))
  const current = project({ now, records, dataThrough: march + 1 }).plans[0].billing
  assert.deepEqual(current[0], {
    start: march, end: beijing('2024-04-30T00:00:00'), current: true, complete: false,
    tokens: 2_000_000, requests: 2, pricedTokens: 2_000_000, unpricedTokens: 0, unverifiedRequests: 0,
    apiValue: 4, ratio: 0.2, tiered: false, custom: false,
  })
  assert.deepEqual(current.slice(1).map(({ requests, apiValue }) => [requests, apiValue]), [[2, 4], [1, 2]])

  const futureWatermark = project({ now, records, dataThrough: now + 1 }).plans[0].billing[0]
  assert.equal(futureWatermark.requests, 3)
  assert.equal(futureWatermark.complete, false)

  const partial = project({ now, records, dataThrough: february, usagePartial: true })
  assert.equal(partial.usagePartial, true)
  assert.deepEqual(partial.plans[0].billing.map(({ requests, apiValue, ratio, complete }) => [requests, apiValue, ratio, complete]), [
    [0, null, null, false], [1, 2, 0.1, false], [1, 2, 0.1, true],
  ])
  const emptyButCovered = project({ now, dataThrough: march }).plans[0].billing[0]
  assert.equal(emptyButCovered.apiValue, 0)
  assert.equal(emptyButCovered.ratio, 0)
  assert.equal(project({ now, dataThrough: null }).plans[0].billing[0].apiValue, null)
})

function configuredPricing(t, custom, fx, markup = {}) {
  const checked = validateCustomRates(custom)
  assert.deepEqual(checked.errors, [])
  t.after(() => {
    setCustomRates({})
    setMarkup({})
    setUsdToCny(DEFAULT_USD_TO_CNY)
  })
  setUsdToCny(fx)
  setCustomRates(checked.rates)
  setMarkup(markup)
}

function closeTo(actual, expected) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= Number.EPSILON * 8 * Math.max(1, Math.abs(expected)),
    `expected ${expected}, got ${actual}`)
}

test('native official rates beat custom aliases and markups, respect request-time tiers, and convert both ways', (t) => {
  const alias = 'deepseek-v4.1-flash'
  const dated = 'deepseek-v4-flash-ga-260731'
  const override = { cacheMiss: 300, output: 600 }
  configuredPricing(t, {
    'deepseek-flash': override,
    [`deepseek-flash@${config.route}`]: override,
    [alias]: override,
    [dated]: override,
  }, 8, { [config.route]: 10, 'team-cny': 4 })

  const peak = beijing('2026-11-10T09:00:00')
  const idle = beijing('2026-11-10T12:00:00')
  const gpt = { n: 'gpt-6.2-sol', r: 'gpt-6.2-sol', i: 500_000, h: 100_000, w: 200_000, o: 100_000, g: 80_000 }
  const result = project({
    configs: [config, { ...config, route: 'team-cny', currency: 'CNY', fee: 160 }],
    now: beijing('2026-11-10T12:30:00'),
    records: [
      request(peak, { n: alias, r: alias }),
      request(idle, { n: dated, r: dated }),
      request(peak, { n: 'deepseek-flash', r: 'deepseek-flash' }),
      request(peak, gpt),
      request(peak, { ...gpt, p: 'team-cny' }),
    ],
  })
  assert.equal(result.usdToCny, 8)
  const [usd, cny] = result.plans.map(({ billing }) => billing[0])
  // DeepSeek: ¥2 + ¥1 + ¥2; GPT: $0.01 hit + $0.50 write + $0.40 miss + $1 output.
  closeTo(usd.apiValue, 2.535)
  closeTo(usd.ratio, 0.12675)
  closeTo(cny.apiValue, 15.28)
  closeTo(cny.ratio, 0.0955)
  assert.equal(usd.tokens, 3_600_000)
  assert.equal(usd.pricedTokens, 3_600_000)
  assert.equal(usd.unpricedTokens, 0)
  assert.equal(usd.tiered, true)
  assert.equal(usd.custom, false)
})

test('unknown usage stays unpriced unless a model or same-route custom rate is explicit', (t) => {
  configuredPricing(t, {
    indie: { cacheMiss: 5, output: 7 },
    [`indie@${config.route}`]: { cacheMiss: 3, output: 4 },
    'route-only@another-route': { cacheMiss: 9, output: 9 },
    'tiny-usd': { currency: 'USD', cacheMiss: 0.00000002, output: 0 },
    'known-free': { cacheMiss: 0, output: 0 },
  }, 8)

  const now = beijing('2026-11-10T15:00:00')
  const use = (p, model) => request(now, { p, n: model, r: model })
  const routes = [config.route, 'model-rate', 'unpriced-only', 'same-rate-in-cny', 'free']
  const configs = routes.map((route) => ({ ...config, route, currency: 'CNY' }))
  const records = [
    use(config.route, 'indie'), use(config.route, 'not-listed'),
    use('model-rate', 'indie'),
    use('unpriced-only', 'route-only'), use('unpriced-only', 'constructor'), use('unpriced-only', '__proto__'),
    use('unpriced-only', 'indieopenai-codex'),
    use('same-rate-in-cny', 'tiny-usd'), use('free', 'known-free'),
  ]
  const [mixed, generic, unknown, tiny, free] = project({ configs, records, now }).plans.map(({ billing }) => billing[0])
  assert.deepEqual([mixed.apiValue, mixed.ratio, mixed.tokens, mixed.pricedTokens, mixed.unpricedTokens, mixed.custom],
    [3, 0.15, 2_000_000, 1_000_000, 1_000_000, true])
  assert.equal(generic.apiValue, 5)
  assert.deepEqual([unknown.apiValue, unknown.ratio, unknown.requests, unknown.pricedTokens, unknown.unpricedTokens, unknown.custom],
    [null, null, 4, 0, 4_000_000, false])
  closeTo(tiny.apiValue, 0.00000016)
  assert.equal(tiny.custom, true)
  assert.deepEqual([free.apiValue, free.ratio, free.pricedTokens, free.unpricedTokens, free.custom], [0, 0, 1_000_000, 0, true])
})

test('only exactly matched, explicitly verified persisted requests contribute to usage', () => {
  const now = beijing('2026-11-12T09:30:00')
  const records = [
    request(now),
    request(now, { v: false, s: 'inherited' }),
    request(now, { v: undefined }),
    request(now, { v: 1 }),
    request(now, { v: 'true' }),
    request(now, { p: 'another-route' }),
    request(now, { p: ` ${config.route} ` }),
    request(now, { p: undefined, n: `${config.route}/gpt-6-sol`, cwd: `D:/${config.route}` }),
  ]
  const [row] = project({ now, records }).plans[0].billing
  assert.deepEqual([row.requests, row.tokens, row.apiValue, row.unverifiedRequests], [1, 1_000_000, 2, 4])
  const [unverifiedOnly] = project({ now, records: records.slice(1) }).plans[0].billing
  assert.deepEqual([unverifiedOnly.requests, unverifiedOnly.tokens, unverifiedOnly.apiValue, unverifiedOnly.unverifiedRequests], [0, 0, null, 4])
  const [malformed] = project({ now, records: [request(now, { o: NaN })] }).plans[0].billing
  assert.deepEqual([malformed.requests, malformed.apiValue, malformed.unverifiedRequests], [0, null, 1])
})

test('Codex reset windows compare only real observations of the same duration, separately from billing', () => {
  const hour = 3_600_000
  const fiveHours = 5 * hour
  const week = 7 * 24 * hour
  const codex = { ...config, anchorDate: '2026-11-01' }
  const withoutQuota = { ...codex, route: 'no-quota', quotaVendor: 'none' }
  const now = beijing('2026-11-12T09:30:00')
  const dataThrough = beijing('2026-11-12T09:15:00')
  const observed = (date, durationMs, usedPercent) => {
    const start = beijing(date)
    return Object.freeze({ start, end: start + durationMs, durationMs, observedAt: start + 300_000, usedPercent })
  }
  const weekly = observed('2026-11-09T10:00:00', week, 43)
  const previousWeek = observed('2026-11-02T10:00:00', week, 98)
  const preAnchorWeek = observed('2026-10-26T10:00:00', week, 48)
  const currentShort = observed('2026-11-12T09:00:00', fiveHours, 63.5)
  const recentShort = ['11T11', '10T02', '07T01', '06T08', '05T10', '04T10', '03T10']
    .map((time, index) => observed(`2026-11-${time}:00:00`, fiveHours, 78 - index))
  const feed = Object.freeze([weekly, ...recentShort.slice().reverse(), preAnchorWeek, currentShort, previousWeek])
  const observations = new Map([[codex.route, feed], [withoutQuota.route, feed]])
  const records = [
    request(previousWeek.start),
    request(recentShort[0].start),
    request(recentShort[0].end),
    request(beijing('2026-11-11T19:00:00')),
    request(currentShort.start),
    request(beijing('2026-11-12T09:10:00')),
    request(dataThrough),
    request(dataThrough + 1),
    request(dataThrough, { v: false }),
  ]
  const [plan, disabled] = project({ configs: [codex, withoutQuota], records, observations, now, dataThrough }).plans
  const [short, long] = plan.quota
  assert.deepEqual(plan.quota.map(({ id, durationMs }) => [id, durationMs]), [['18000000', fiveHours], ['604800000', week]])
  assert.deepEqual(short.windows.map(({ start }) => start), [currentShort.start, ...recentShort.slice(0, 5).map(({ start }) => start)])
  assert.deepEqual(long.windows.map(({ start }) => start), [weekly.start, previousWeek.start])
  assert.deepEqual(disabled.quota, [])
  assert.deepEqual(short.windows[0], {
    start: currentShort.start, end: currentShort.end, current: true, complete: false,
    tokens: 3_000_000, requests: 3, pricedTokens: 3_000_000, unpricedTokens: 0, unverifiedRequests: 1,
    apiValue: 6, ratio: null, tiered: false, custom: false,
    observedAt: currentShort.observedAt, usedPercent: 63.5,
  })
  assert.deepEqual(short.windows.slice(1).map(({ requests, apiValue, ratio, complete }) => [requests, apiValue, ratio, complete]), [
    [1, 2, null, true], [0, 0, null, true], [0, 0, null, true], [0, 0, null, true], [0, 0, null, true],
  ])
  assert.deepEqual(long.windows.map(({ requests, apiValue, ratio, complete }) => [requests, apiValue, ratio, complete]), [
    [6, 12, null, false], [1, 2, null, true],
  ])
  assert.deepEqual([plan.billing[0].requests, plan.billing[0].apiValue, plan.billing[0].ratio], [7, 14, 0.7])

  const partial = project({ configs: [codex], records, observations, now, dataThrough: weekly.start - 1 }).plans[0]
  assert.deepEqual(partial.quota[1].windows.map(({ current, complete, apiValue }) => [current, complete, apiValue]), [
    [true, false, null], [false, false, 2],
  ])
})
