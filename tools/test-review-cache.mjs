/** Window/scope cache regression, no Harness, browser or real network needed. */
import assert from 'node:assert/strict'
import { createReviewCache } from '../src/client/reviewStore.js'
const data = (days = 7, scope = 'recent') => ({ schema: 2, scope, range: { days }, sessions: [], tools: [], hours: [] })
const response = (value) => ({ ok: true, json: async () => value })
let passed = 0
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (error) { process.exitCode = 1; console.error(`  ✗ ${name}: ${error.message}`) }
}
await check('inflight work survives rapid revision renders and is shared, not restarted', async () => {
  let release, calls = 0
  const cache = createReviewCache(() => { calls += 1; return new Promise((resolve) => { release = resolve }) })
  const a = cache.load({ days: 7, scope: 'recent', revision: 1 })
  const b = cache.load({ days: 7, scope: 'recent', revision: 2 })
  await Promise.resolve()
  assert.equal(calls, 1)
  release(response(data()))
  const [left, right] = await Promise.all([a, b])
  assert.equal(left, right)
  assert.equal(cache.peek(7, 'recent'), left)
})
await check('returning to a cached period is immediate and scopes never mix', async () => {
  let calls = 0
  const cache = createReviewCache(async (url) => {
    calls += 1
    const parsed = new URL(url, 'http://test')
    return response(data(Number(parsed.searchParams.get('days')), parsed.searchParams.get('scope')))
  })
  const seven = await cache.load({ days: 7, scope: 'recent', revision: 1 })
  await cache.load({ days: 30, scope: 'recent', revision: 1 })
  const back = await cache.load({ days: 7, scope: 'recent', revision: 1 })
  assert.equal(seven, back)
  assert.equal(calls, 2)
  assert.equal(cache.peek(7, 'all'), null)
  await cache.load({ days: 7, scope: 'all', revision: 1 })
  assert.equal(cache.peek(7, 'all').scope, 'all')
  assert.equal(cache.peek(7, 'recent').scope, 'recent')
})
await check('refresh failure retains the old correctly-labelled period snapshot', async () => {
  let fail = false
  const cache = createReviewCache(async () => { if (fail) throw new Error('network unavailable'); return response(data()) })
  const old = await cache.load({ days: 7, scope: 'recent', revision: 1 })
  fail = true
  await assert.rejects(cache.load({ days: 7, scope: 'recent', revision: 2 }), /network/)
  assert.equal(cache.peek(7, 'recent'), old)
  assert.equal(cache.peek(30, 'recent'), null)
})
await check('synchronous request failure does not leave a permanently rejected inflight cache', async () => {
  let calls = 0
  const cache = createReviewCache(() => { if (++calls === 1) throw new Error('sync failure'); return response(data()) })
  await assert.rejects(cache.load({ days: 7, revision: 1 }), /sync/)
  assert.equal((await cache.load({ days: 7, revision: 1 })).schema, 2)
})
await check('old duration schema and wrong scope are rejected, never cached as current', async () => {
  const cache = createReviewCache(async () => response({ ...data(), schema: 1 }))
  await assert.rejects(cache.load({ days: 7, revision: 1 }), /口径/)
  assert.equal(cache.peek(7, 'recent'), null)
  const wrong = createReviewCache(async () => response(data(7, 'all')))
  await assert.rejects(wrong.load({ days: 7, scope: 'recent', revision: 1 }), /口径/)
})
console.log(`\n${passed} review cache checks passed`)
