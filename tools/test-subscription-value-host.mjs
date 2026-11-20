import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const built = process.argv.includes('--built')
const { SubscriptionValueStore, codexQuotaSample } = await import(built ? '../lib/subscription-value-store.js' : '../src/subscription-value-store.js')
const { PlansService, parseCodexUsage } = await import(built ? '../lib/plans.js' : '../src/plans.js')
const { default: plugin } = await import(built ? '../lib/host.js' : '../src/host.js')
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 20, 4)
const route = 'openai-codex'
const config = { route, fee: 20, currency: 'USD', anchorDate: '2026-10-20', quotaVendor: 'codex' }

const sampleOf = (at, reset, percent, scope = 'account-a') => codexQuotaSample({
  ok: true, windows: [{ durationMs: 5 * HOUR, resetAt: reset, usedPercent: percent }],
}, scope, at)

async function temp(action) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pixel-plan-value-'))
  try { await action(dir) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('configuration is validated, serialized and kept unchanged on failed persistence', async () => {
  await temp(async (dir) => {
    const path = join(dir, 'values.json')
    const store = new SubscriptionValueStore(path)
    const save = (fields) => store.configure({ action: 'save', config: { ...config, ...fields } }, NOW)
    assert.equal((await save({ route: 'mixed route' })).error, 'invalid-route')
    assert.equal((await save({ fee: '20' })).error, 'invalid-fee')
    assert.equal((await save({ fee: 1.001 })).error, 'invalid-fee')
    assert.equal((await save({ currency: 'EUR' })).error, 'invalid-currency')
    assert.equal((await save({ anchorDate: '2026-02-29' })).error, 'invalid-anchor')
    assert.equal((await save({ anchorDate: '2026-11-21' })).error, 'invalid-anchor')
    const results = await Promise.all([save({ unrecognized: 'not-persisted' }), save({ route: 'private-plan', quotaVendor: 'none', fee: 59, currency: 'CNY' })])
    assert.ok(results.every((entry) => entry.ok))
    assert.equal((await save({ route: 'another-codex' })).error, 'codex-in-use')
    assert.equal((await new SubscriptionValueStore(path).read()).configs.length, 2)
    assert.ok(!(await readFile(path, 'utf8')).includes('not-persisted'))
    const readOnly = new SubscriptionValueStore(undefined)
    assert.equal((await readOnly.configure({ action: 'save', config }, NOW)).error, 'storage-failed')
    assert.deepEqual((await readOnly.read()).configs, [])
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{bad')
    const corruptStore = new SubscriptionValueStore(corrupt)
    assert.equal((await corruptStore.configure({ action: 'save', config }, NOW)).error, 'storage-failed')
    assert.equal(await readFile(corrupt, 'utf8'), '{bad')
  })
})

test('quota samples need actual time bounds, keep disjoint observed windows, and isolate account changes', async () => {
  await temp(async (dir) => {
    const path = join(dir, 'values.json')
    const store = new SubscriptionValueStore(path)
    assert.ok((await store.configure({ action: 'save', config }, NOW)).ok)
    const parsed = parseCodexUsage({ rate_limit: { primary_window: { limit_window_seconds: 18000, reset_at: (NOW + HOUR) / 1000, used_percent: 10 } } })
    assert.equal(parsed.windows[0].durationMs, 5 * HOUR)
    assert.equal(codexQuotaSample({ ok: true, windows: parsed.windows }, 'scope', NOW).windows[0].start, NOW - 4 * HOUR)
    assert.deepEqual(codexQuotaSample({ ok: true, windows: [{ resetAt: NOW + HOUR, usedPercent: 7, window: 'fiveHour' }] }, 'scope', NOW).windows, [])
    assert.deepEqual(sampleOf(NOW, NOW + 6 * HOUR, 3).windows, [], 'future start is not a current observation')
    assert.deepEqual(codexQuotaSample({ ok: true, windows: [parsed.windows[0], { ...parsed.windows[0], resetAt: NOW + 2 * HOUR }] }, 'scope', NOW).windows, [], 'same-length simultaneous windows are ambiguous')
    await store.observe(sampleOf(NOW, NOW + HOUR, 0))
    assert.equal((await store.read()).quota, null, 'idle samples must not generate historical bars')
    await store.observe(sampleOf(NOW, NOW + HOUR, 10))
    await store.observe(sampleOf(NOW + 1, NOW + HOUR, 20))
    assert.equal((await store.read()).quota.windows[0].usedPercent, 20)
    await store.observe(sampleOf(NOW + 2, NOW + HOUR + 1000, 22))
    assert.equal((await store.read()).quota.windows.length, 1, 'correction must not double count overlapping windows')
    await store.observe(sampleOf(NOW + 6 * HOUR, NOW + 10 * HOUR, 15))
    assert.equal((await new SubscriptionValueStore(path).read()).quota.windows.length, 2, 'unobserved gap is not backfilled')
    await store.observe(sampleOf(NOW + 6 * HOUR + 1, NOW + 10 * HOUR, 0, 'account-b'))
    assert.deepEqual((await store.read()).quota.windows, [], 'no old-account observations survive a new account')
    await store.configure({ action: 'remove', route })
    assert.equal((await store.read()).quota, null)
  })
})

function mount(persistence) {
  const disposers = []
  const routes = new Map()
  const tools = new Map()
  const services = {
    sessionPersistence: persistence,
    webServer: { register: (entry) => { routes.set(entry.path, entry); return () => routes.delete(entry.path) } },
    tools: { register: (entry) => { tools.set(entry.name, entry); return () => tools.delete(entry.name) } },
  }
  const ctx = {
    webServer: services.webServer,
    get: (name) => services[name],
    inject: (_names, fn) => fn(ctx),
    effect: (fn) => { disposers.push(fn()) },
    on: () => {},
  }
  plugin.apply(ctx)
  return { routes, tools, dispose: () => { for (const dispose of disposers.reverse()) dispose?.() } }
}

function request(table, path, method = 'GET', body, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  return new Promise((resolve, reject) => {
    const res = { statusCode: 0, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(text) {
      resolve({ status: this.statusCode, headers: this.headers, data: text === undefined ? undefined : JSON.parse(text) })
    } }
    const entry = table.get(path.split('?')[0])
    assert.ok(entry, `Missing route ${path}`)
    const pending = entry.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    Promise.resolve(pending).catch(reject)
  })
}

test('built Host UI route and agent tool share config; inherited usage and unknown prices do not inflate value', async () => {
  await temp(async (dir) => {
    const previous = { now: Date.now, read: PlansService.prototype.read, scope: PlansService.prototype.codexScopeOf }
    const env = ['DSH_PIXEL_LEDGER', 'DSH_PIXEL_BALANCE_PREFS', 'DSH_PIXEL_RATES', 'DSH_PIXEL_PLANS']
    const originalEnv = env.map((key) => process.env[key])
    let host
    try {
      Date.now = () => NOW
      process.env.DSH_PIXEL_LEDGER = join(dir, 'ledger.jsonl')
      process.env.DSH_PIXEL_BALANCE_PREFS = join(dir, 'prefs.json')
      process.env.DSH_PIXEL_RATES = join(dir, 'rates.json')
      process.env.DSH_PIXEL_PLANS = '1'
      PlansService.prototype.read = async () => ({ enabled: true, fetchedAt: NOW, providers: [{ id: 'codex', ok: true, windows: [{ durationMs: 5 * HOUR, resetAt: NOW + HOUR, usedPercent: 12 }] }] })
      PlansService.prototype.codexScopeOf = () => 'private-account-hash'
      const event = (seq, provider, model, outputTokens) => ({
        type: 'assistant/message', seq, time: NOW - 45 * 60_000,
        data: { message: { source: { provider, model } }, usage: { inputTokens: 0, outputTokens } },
      })
      const own = event(1, route, 'gpt-5.6-terra', 1_000_000)
      const parent = [own, event(2, route, 'no-price-fixture', 10), event(3, 'separate-api-key', 'gpt-5.6-terra', 1_000_000)]
      const inherited = [own]
      await writeFile(process.env.DSH_PIXEL_LEDGER, `${JSON.stringify({ k: 'parent:1', s: 'parent', t: own.time, n: 'gpt-5.6-terra', p: 'old-inference', r: 'gpt-5.6-terra', i: 0, h: 0, w: 0, o: 1_000_000, u: 1_000_000 })}\n`)
      host = mount({
        list: async () => [{ header: { id: 'parent' } }, { header: { id: 'seeded', isSeeded: true, parentSession: 'parent' } }],
        open: async (id) => ({ inheritedEventCount: id === 'seeded' ? 1 : 0,
          read: async (offset, count) => ({ events: (id === 'seeded' ? inherited : parent).slice(offset, offset + count) }), close: async () => {} }),
      })
      const value = '/dsh-pixel/subscription-value'
      const call = (method, body, headers) => request(host.routes, value, method, body, headers)
      assert.deepEqual((await call()).data.plans, [])
      const body = { action: 'save', config }
      assert.equal((await call('POST', body, { 'sec-fetch-site': 'cross-site' })).status, 403)
      assert.equal((await call('POST', body, { 'content-type': 'text/plain' })).status, 415)
      assert.equal((await call('POST', { action: 'save', config: { ...config, fee: 0 } })).status, 400)
      assert.equal((await call('HEAD')).data, undefined)
      const tool = host.tools.get('pixel_subscription_value_config')
      const toolResult = await tool.execute(body)
      assert.equal(toolResult.ok, true)
      assert.deepEqual((await call('POST', body)).data, toolResult)
      assert.deepEqual((await tool.execute({ action: 'list' })).configs, [config])
      await request(host.routes, '/dsh-pixel/plans')
      const response = await call()
      assert.equal(response.status, 200)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.data.quotaTracking, 'ready')
      const [plan] = response.data.plans
      assert.deepEqual(plan.config, config)
      const [bill] = plan.billing
      assert.equal(bill.requests, 2)
      assert.equal(bill.tokens, 1_000_010)
      assert.equal(bill.pricedTokens, 1_000_000)
      assert.equal(bill.unpricedTokens, 10)
      assert.equal(bill.unverifiedRequests, 1, 'copied parent request must not double count')
      assert.equal(bill.apiValue, 12)
      assert.equal(bill.ratio, 0.6)
      assert.equal(plan.quota[0].windows[0].apiValue, 12)
      assert.equal(plan.quota[0].windows[0].ratio, null)
      assert.ok(!JSON.stringify(response.data).includes('private-account-hash'), 'scope key is host-only')
      const remove = { action: 'remove', route }
      assert.deepEqual((await call('POST', remove)).data, { ok: true, removed: true })
      assert.deepEqual((await tool.execute({ action: 'list' })).configs, [])
      assert.deepEqual((await call()).data.plans, [])
    } finally {
      host?.dispose()
      for (const [index, key] of env.entries()) {
        if (originalEnv[index] === undefined) delete process.env[key]
        else process.env[key] = originalEnv[index]
      }
      Date.now = previous.now
      PlansService.prototype.read = previous.read
      PlansService.prototype.codexScopeOf = previous.scope
    }
  })
})
