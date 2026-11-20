import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dateKey } from './pricing.js'

const MAX_PLANS = 12
const MAX_WINDOWS_PER_LENGTH = 6
const MAX_WINDOWS = 36
const MIN_DURATION_MS = 60_000
const MAX_DURATION_MS = 31 * 86_400_000
const QUOTA_SAMPLE_INTERVAL_MS = 5 * 60_000

const objectOf = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = (error) => ({ ok: false, error })

function routeOf(value) {
  if (typeof value !== 'string') return undefined
  const route = value.trim()
  return /^[^\s\p{C}]{1,96}$/u.test(route) ? route : undefined
}

function configOf(value, now) {
  if (!objectOf(value)) return failure('invalid-request')
  const route = routeOf(value.route)
  if (route === undefined) return failure('invalid-route')
  const { fee, currency, anchorDate, quotaVendor = 'none' } = value
  if (!Number.isFinite(fee) || fee < 0.01 || fee > 1_000_000 || Number(fee.toFixed(2)) !== fee) {
    return failure('invalid-fee')
  }
  if (currency !== 'USD' && currency !== 'CNY') return failure('invalid-currency')
  if (typeof anchorDate !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(anchorDate)) return failure('invalid-anchor')
  const date = new Date(`${anchorDate}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== anchorDate
    || (now !== undefined && anchorDate > dateKey(now))) return failure('invalid-anchor')
  if (quotaVendor !== 'none' && quotaVendor !== 'codex') return failure('invalid-quota-vendor')
  // Persist only the declared fields. Unknown data (including credentials) never enters the store.
  return { ok: true, config: { route, fee, currency, anchorDate, quotaVendor } }
}

function validWindow(row) {
  return objectOf(row) && [row.start, row.end, row.observedAt, row.durationMs].every(Number.isSafeInteger)
    && row.durationMs >= MIN_DURATION_MS && row.durationMs <= MAX_DURATION_MS && row.end - row.start === row.durationMs
    && row.start <= row.observedAt && row.observedAt < row.end
    && Number.isFinite(row.usedPercent) && row.usedPercent >= 0
}

function trimWindows(windows) {
  const counts = new Map()
  return [...windows].sort((a, b) => b.end - a.end).filter((window) => {
    const count = (counts.get(window.durationMs) ?? 0) + 1
    counts.set(window.durationMs, count)
    return count <= MAX_WINDOWS_PER_LENGTH
  }).slice(0, MAX_WINDOWS)
}

/** A quota observation uses the actual duration and reset supplied by Codex, never a calendar guess. */
export function codexQuotaSample(provider, scope, at) {
  if (provider?.ok !== true || typeof scope !== 'string' || !Number.isSafeInteger(at)) return undefined
  const byLength = new Map()
  for (const window of provider.windows ?? []) {
    const durationMs = window.durationMs
    const row = {
      start: window.resetAt - durationMs, end: window.resetAt, durationMs,
      observedAt: at, usedPercent: window.usedPercent,
    }
    if (!validWindow(row)) continue
    // Two different simultaneous resets at the same length can't be identified by length alone.
    if (byLength.has(durationMs)) byLength.set(durationMs, undefined)
    else byLength.set(durationMs, row)
  }
  return { scope, at, windows: [...byLength.values()].filter(Boolean) }
}

function withObservations(previous, sample) {
  let windows = previous
  for (const next of sample.windows) {
    // When idle, the upstream can supply a new prospective reset on each read. It isn't a
    // used window. Never seed history with it, or replace a known used interval with it.
    if (next.usedPercent <= 0) continue
    const same = windows.find((row) => row.durationMs === next.durationMs && row.end === next.end)
    if (same && (same.observedAt >= next.observedAt
      || (same.usedPercent === next.usedPercent && next.observedAt - same.observedAt < QUOTA_SAMPLE_INTERVAL_MS))) continue
    // A reset adjustment can shift an active interval. Keep only its latest bounds; otherwise two
    // overlapping bars of the same length would double count the same usage events.
    windows = windows.filter((row) => row.durationMs !== next.durationMs || row.end <= next.start || row.start >= next.end)
    windows.push(next)
  }
  return windows === previous ? previous : trimWindows(windows)
}

function unpack(value) {
  if (value?.schema !== 1 || !Array.isArray(value.configs) || value.configs.length > MAX_PLANS) {
    throw new Error('Invalid subscription value store')
  }
  const configs = value.configs.map((config) => {
    const parsed = configOf(config)
    if (!parsed.ok) throw new Error('Invalid subscription value configuration')
    return parsed.config
  })
  const linked = configs.filter((config) => config.quotaVendor === 'codex')
  if (linked.length > 1 || new Set(configs.map((config) => config.route)).size !== configs.length) {
    throw new Error('Duplicate subscription value configuration')
  }
  const quota = value.quota
  if (!quota || linked[0]?.route !== quota.route || typeof quota.scope !== 'string' || !Array.isArray(quota.windows)) {
    return { configs, quota: null }
  }
  return { configs, quota: {
    route: quota.route, scope: quota.scope, windows: trimWindows(quota.windows.filter(validWindow)),
  } }
}

/** Plugin-owned local state. Both UI and agent use configure(); failed writes do not change read state. */
export class SubscriptionValueStore {
  #path
  #loading
  #state
  #queue = Promise.resolve()

  constructor(path) {
    this.#path = path
  }

  async read() {
    if (this.#state !== undefined) return this.#state
    this.#loading ??= this.#load().finally(() => { this.#loading = undefined })
    return this.#loading
  }

  async #load() {
    try {
      this.#state = this.#path === undefined
        ? { configs: [], quota: null }
        : unpack(JSON.parse(await readFile(this.#path, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.#state = { configs: [], quota: null }
    }
    return this.#state
  }

  #edit(change) {
    const run = async () => {
      const previous = await this.read()
      const { state = previous, result } = change(previous)
      if (state !== previous) {
        if (this.#path === undefined) throw new Error('Subscription value store is read-only')
        await mkdir(dirname(this.#path), { recursive: true })
        const temporary = `${this.#path}.tmp`
        await writeFile(temporary, `${JSON.stringify({ schema: 1, ...state }, null, 2)}\n`, 'utf8')
        await rename(temporary, this.#path)
        this.#state = state
      }
      return result
    }
    const next = this.#queue.then(run)
    this.#queue = next.catch(() => {})
    return next
  }

  async configure(input, now = Date.now()) {
    if (!objectOf(input)) return failure('invalid-request')
    if (!['list', 'save', 'remove'].includes(input.action)) return failure('invalid-action')
    try {
      if (input.action === 'list') return { ok: true, configs: (await this.read()).configs }
      if (input.action === 'remove') {
        const route = routeOf(input.route)
        if (route === undefined) return failure('invalid-route')
        return await this.#edit((state) => {
          const configs = state.configs.filter((config) => config.route !== route)
          if (configs.length === state.configs.length) return { result: { ok: true, removed: false } }
          return { state: { configs, quota: state.quota?.route === route ? null : state.quota }, result: { ok: true, removed: true } }
        })
      }
      const parsed = configOf(input.config, now)
      if (!parsed.ok) return parsed
      const { config } = parsed
      return await this.#edit((state) => {
        const index = state.configs.findIndex((entry) => entry.route === config.route)
        if (index < 0 && state.configs.length >= MAX_PLANS) return { result: failure('plan-limit') }
        if (config.quotaVendor === 'codex'
          && state.configs.some((entry) => entry.route !== config.route && entry.quotaVendor === 'codex')) {
          return { result: failure('codex-in-use') }
        }
        if (index >= 0 && JSON.stringify(config) === JSON.stringify(state.configs[index])) return { result: parsed }
        const configs = [...state.configs]
        if (index < 0) configs.push(config)
        else configs[index] = config
        const quota = config.quotaVendor === 'none' && state.quota?.route === config.route ? null : state.quota
        return { state: { configs, quota }, result: parsed }
      })
    } catch {
      return failure('storage-failed')
    }
  }

  async observe(sample) {
    if (!sample) return
    return this.#edit((state) => {
      const route = state.configs.find((config) => config.quotaVendor === 'codex')?.route
      if (route === undefined) return {}
      const current = state.quota
      const sameScope = current?.route === route && current.scope === sample.scope
      const previous = sameScope ? current.windows : []
      const windows = withObservations(previous, sample)
      if (windows === previous && (sameScope || !current)) return {}
      return { state: { configs: state.configs, quota: { route, scope: sample.scope, windows } } }
    })
  }
}

/** Same configuration operation as the UI Host route; no credentials or quota login changes. */
export function subscriptionValueConfigTool(store) {
  return {
    name: 'pixel_subscription_value_config',
    description: 'List or edit local Usage Dashboard subscription value settings. Save or remove only at the user’s request; this does not change a paid subscription.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'remove'] },
        route: { type: 'string', description: 'Exact DSH provider route, for remove.' },
        config: {
          type: 'object', additionalProperties: false, required: ['route', 'fee', 'currency', 'anchorDate'],
          description: 'Complete settings for save, replacing the entry for this route.',
          properties: {
            route: { type: 'string', description: 'Exact DSH provider route used exclusively for this subscription.' },
            fee: { type: 'number', description: 'Monthly price, 0.01 to 1000000 with at most two decimal places.' },
            currency: { type: 'string', enum: ['CNY', 'USD'] },
            anchorDate: { type: 'string', description: 'Start of the first billing period to include, YYYY-MM-DD, Asia/Shanghai; monthly renewals use this day.' },
            quotaVendor: { type: 'string', enum: ['none', 'codex'], description: 'Codex only if this route uses the same account as the quota card; default none.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' }, config: { type: 'object' }, configs: { type: 'array', items: { type: 'object' } }, removed: { type: 'boolean' } }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args) => store.configure(args),
  }
}
