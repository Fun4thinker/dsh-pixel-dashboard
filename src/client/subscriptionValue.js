import React from 'react'
import { subscriptionValueText } from './subscriptionValueLocale.js'
import { buildPurchasingPower } from './purchasingPower.js'

const { createElement: h, useCallback, useEffect, useId, useMemo, useRef, useState } = React
const ENDPOINT = '/dsh-pixel/subscription-value'
const TIMEZONE = 'Asia/Shanghai'
// The first read may need to scan the historical ledger; writes only persist configuration.
const READ_TIMEOUT_MS = 60_000
const WRITE_TIMEOUT_MS = 20_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const MONTH_CURRENCIES = ['USD', 'CNY']
const CONFIG_ERRORS = new Set([
  'invalid-action', 'invalid-route', 'invalid-fee', 'invalid-currency', 'invalid-anchor',
  'invalid-quota-vendor', 'codex-in-use', 'plan-limit', 'storage-failed', 'invalid-request',
])
const dateKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})

class ValueRequestError extends Error {
  constructor(kind, detail) {
    super(kind)
    this.kind = kind
    this.detail = detail
  }
}

async function requestValue(controller, action) {
  const timeout = setTimeout(() => controller.abort(), action ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS)
  try {
    const response = await fetch(ENDPOINT, {
      cache: 'no-store',
      mode: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(action ? { 'Content-Type': 'application/json' } : {}) },
      ...(action ? { method: 'POST', body: JSON.stringify(action) } : {}),
    })
    if (!action && ([404, 405, 501].includes(response.status)
      || (response.ok && response.headers?.get?.('content-type')?.includes('text/html')))) {
      throw new ValueRequestError('unsupported')
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      if (controller.signal.aborted) throw error
      // An HTTP failure still has an actionable status even without a JSON body.
    }
    if (action && typeof body?.error === 'string' && (!response.ok || body.ok === false)) {
      const detail = body.error.trim().slice(0, 180)
      if (detail !== '') throw new ValueRequestError('diagnostic', detail)
    }
    if (!response.ok) {
      if (!action && body?.error === 'usage-unavailable') throw new ValueRequestError('usage-unavailable')
      throw new ValueRequestError('http', response.status)
    }
    if (action) {
      if (body?.ok === true) return body
      throw new ValueRequestError(body?.ok === false ? 'unknown' : 'response')
    }
    if (body?.schema !== undefined && body.schema !== 1) throw new ValueRequestError('unsupported')
    if (body?.schema !== 1 || body.timezone !== TIMEZONE || !Array.isArray(body.plans)) {
      throw new ValueRequestError('response')
    }
    return body
  } finally {
    clearTimeout(timeout)
  }
}

/** Coalesce read triggers but never apply a GET issued before a confirmed write. */
function useValueSnapshot(revision, quotaRevision) {
  const [state, setState] = useState({ payload: null, loading: true, error: null })
  const [writeAction, setWriteAction] = useState(null)
  const instance = useRef(null)

  const reload = useCallback(async function load(force = false) {
    const owner = instance.current
    if (owner === null || (owner.unsupported && !force)) return
    if (owner.read || owner.write) {
      owner.readAgain = true
      return
    }
    const controller = new AbortController()
    owner.read = controller
    setState((prev) => prev.loading ? prev : { ...prev, loading: true })
    try {
      const payload = await requestValue(controller)
      if (instance.current !== owner || owner.read !== controller) return
      owner.unsupported = false
      setState({ payload, loading: false, error: null })
    } catch (error) {
      if (instance.current !== owner || owner.read !== controller) return
      const failure = error instanceof ValueRequestError ? error
        : new ValueRequestError(controller.signal.aborted ? 'readTimeout' : 'network')
      owner.unsupported = failure.kind === 'unsupported'
      setState((prev) => ({ ...prev, loading: false, error: failure }))
    } finally {
      if (instance.current === owner && owner.read === controller) {
        owner.read = null
        const readAgain = owner.readAgain
        owner.readAgain = false
        if (readAgain && !owner.unsupported) void load()
      }
    }
  }, [])

  useEffect(() => {
    const owner = { read: null, write: null, readAgain: false, unsupported: false }
    instance.current = owner
    return () => {
      instance.current = null
      owner.read?.abort()
      owner.write?.abort()
    }
  }, [])
  useEffect(() => { void reload() }, [revision, quotaRevision, reload])

  const write = useCallback(async (action) => {
    const owner = instance.current
    if (owner === null || owner.write) return null
    const controller = new AbortController()
    owner.write = controller
    owner.readAgain ||= owner.read !== null
    owner.read?.abort()
    owner.read = null
    setState((prev) => ({ ...prev, loading: false }))
    setWriteAction(action.action)
    let succeeded = false
    try {
      const payload = await requestValue(controller, action)
      if (instance.current !== owner) return null
      succeeded = true
      // Do not display amounts tied to the previous configuration under the new one.
      setState({ payload: null, loading: true, error: null })
      return payload
    } catch (error) {
      if (instance.current !== owner) return null
      return { ok: false, error: error instanceof ValueRequestError ? error : new ValueRequestError('writeNetwork') }
    } finally {
      if (instance.current === owner) {
        owner.write = null
        setWriteAction(null)
        const readAgain = owner.readAgain
        owner.readAgain = false
        if (succeeded || readAgain) void reload(succeeded)
      }
    }
  }, [reload])

  return { ...state, reload, write, writeAction }
}

function errorText(tr, error) {
  if (error.kind === 'diagnostic') {
    return CONFIG_ERRORS.has(error.detail) ? tr(`error.${error.detail}`) : error.detail
  }
  return tr(`error.${error.kind}`, { status: error.detail })
}

function knownRoutes(models) {
  const routes = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    const route = model?.provider
    if (typeof route !== 'string' || route.trim() === '') continue
    const label = typeof model.providerLabel === 'string' ? model.providerLabel.trim() : ''
    if (!routes.has(route) || (label !== '' && routes.get(route) === route)) {
      routes.set(route, label || route)
    }
  }
  return new Map([...routes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
}

function routeText(tr, routes, route) {
  const label = routes.get(route)
  return label && label !== route ? tr('routeChoice', { route, label }) : route
}

function amountKnown(value) {
  return Number.isFinite(value) && value >= 0
}

function validTime(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
}

function beijingToday() {
  const parts = Object.fromEntries(dateKeyFormat.formatToParts(Date.now()).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function validateDraft(draft, configs, editing) {
  if (!/^[^\s\p{C}]{1,96}$/u.test(draft.route)) return 'invalid-route'
  if (!editing && configs.some((plan) => plan.config.route === draft.route)) return 'duplicate'
  const fee = Number(draft.fee)
  if (!Number.isFinite(fee) || fee < 0.01 || fee > 1_000_000 || Number(fee.toFixed(2)) !== fee) return 'invalid-fee'
  if (!MONTH_CURRENCIES.includes(draft.currency)) return 'invalid-currency'
  const date = Date.parse(`${draft.anchorDate}T00:00:00Z`)
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(draft.anchorDate) || !Number.isFinite(date)
    || new Date(date).toISOString().slice(0, 10) !== draft.anchorDate
    || draft.anchorDate > beijingToday()) return 'invalid-anchor'
  if (draft.quotaVendor !== 'none' && draft.quotaVendor !== 'codex') return 'invalid-quota-vendor'
  return null
}

function formatters(locale) {
  let tag = typeof locale === 'string' && locale.trim() !== '' ? locale.replace(/_/g, '-') : 'zh'
  try {
    if (Intl.DateTimeFormat.supportedLocalesOf(tag).length === 0) tag = 'en'
  } catch {
    tag = 'en'
  }
  const currencies = (minimumFractionDigits) => new Map(MONTH_CURRENCIES.map((currency) => [currency,
    new Intl.NumberFormat(tag, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits, maximumFractionDigits: 2 }),
  ]))
  return {
    money: currencies(2), unit: currencies(0),
    number: new Intl.NumberFormat(tag, { maximumFractionDigits: 4 }),
    ratio: new Intl.NumberFormat(tag, { maximumFractionDigits: 2 }),
    percent: new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }),
    date: new Intl.DateTimeFormat(tag, { timeZone: TIMEZONE, dateStyle: 'medium' }),
    time: new Intl.DateTimeFormat(tag, { timeZone: TIMEZONE, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }),
  }
}

function moneyText(tr, fmt, amount, currency, compact = false) {
  const format = (compact ? fmt.unit : fmt.money).get(currency)
  if (!amountKnown(amount) || !format) return tr('unknown')
  if (amount > 0 && amount < 0.01) return tr('lessThan', { value: format.format(0.01) })
  return format.format(amount)
}

function ratioText(tr, fmt, ratio) {
  const value = (n) => tr('ratioValue', { value: fmt.ratio.format(n) })
  if (!amountKnown(ratio)) return tr('unknown')
  if (ratio > 0 && ratio < 0.01) return tr('lessThan', { value: value(0.01) })
  // Do not round a near-baseline reading onto the 1× marker.
  if (ratio >= 0.995 && ratio < 1) return tr('lessThan', { value: value(1) })
  if (ratio > 1 && ratio < 1.005) return tr('greaterThan', { value: value(1) })
  return value(ratio)
}

function percentText(tr, fmt, fraction) {
  const percent = (n) => fmt.percent.format(n)
  if (fraction > 0 && fraction < 0.001) return tr('lessThan', { value: percent(0.001) })
  if (fraction > 0.999 && fraction < 1) return tr('lessThan', { value: percent(1) })
  return percent(fraction)
}

function button(text, props) {
  return h('button', { type: 'button', className: 'px-value-button', ...props }, text)
}

function ConfigEditor({ id, tr, routes, configs, config, write, writeAction, onCancel, onConfirmed }) {
  const editing = config !== null
  const [draft, setDraft] = useState(() => editing ? { ...config, fee: String(config.fee) } : {
    route: '', fee: '', currency: 'USD', anchorDate: '', quotaVendor: 'none',
  })
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState(null)
  const [manualRoute, setManualRoute] = useState(routes.size === 0)
  const routePicker = !editing && routes.size > 0
  const invalidField = ({
    'error.invalid-route': 'route', 'error.duplicate': 'route', 'error.invalid-fee': 'fee',
    'error.invalid-currency': 'currency', 'error.invalid-anchor': 'anchorDate',
    'error.invalid-quota-vendor': 'quotaVendor',
  })[failure?.reason ?? `error.${failure?.error?.detail}`]
  const form = useRef(null)
  const focusField = useRef(null)
  const removeButton = useRef(null)
  const cancelRemoval = useRef(null)
  const busy = writeAction !== null
  useEffect(() => { focusField.current?.focus() }, [])
  useEffect(() => {
    if (invalidField) form.current?.elements.namedItem(invalidField)?.focus()
  }, [failure, invalidField])
  useEffect(() => {
    if (routePicker && manualRoute) form.current?.elements.namedItem('route')?.focus()
  }, [routePicker, manualRoute])
  const returnToRemove = useRef(false)
  useEffect(() => {
    if (confirming) cancelRemoval.current?.focus()
    else if (returnToRemove.current) {
      returnToRemove.current = false
      removeButton.current?.focus()
    }
  }, [confirming])
  const field = (name) => (event) => {
    const { value } = event.target
    setDraft((prev) => ({ ...prev, [name]: value }))
    if (failure !== null) setFailure(null)
  }

  const submit = async (event) => {
    event.preventDefault()
    if (busy || confirming) return
    const invalid = validateDraft(draft, configs, editing)
    if (invalid !== null) {
      setFailure({ key: 'saveFailed', reason: `error.${invalid}` })
      return
    }
    setFailure(null)
    const result = await write({ action: 'save', config: { ...draft, fee: Number(draft.fee) } })
    if (result?.ok === true) onConfirmed('saved', result.config?.route ?? draft.route)
    else if (result?.ok === false) setFailure({ key: 'saveFailed', error: result.error })
  }

  const remove = async () => {
    if (busy || !confirming) return
    setFailure(null)
    const result = await write({ action: 'remove', route: config.route })
    if (result?.ok === true) onConfirmed(result.removed === false ? 'alreadyRemoved' : 'removed', config.route)
    else if (result?.ok === false) setFailure({ key: 'removeFailed', error: result.error })
  }

  const routeLabel = routes.get(draft.route)
  const unseen = !editing && draft.route !== '' && !routes.has(draft.route)
  const pickRoute = (event) => {
    const value = event.target.value
    setManualRoute(value === 'manual')
    setDraft((previous) => ({ ...previous, route: value.startsWith('route:') ? value.slice(6) : '' }))
    setFailure(null)
  }
  return h('div', { id, className: 'px-value-editor' },
    h('h3', { className: 'px-value-subtitle' }, tr(editing ? 'editTitle' : 'addTitle')),
    h('form', { ref: form, noValidate: true, onSubmit: submit, 'aria-busy': busy },
      h('fieldset', { className: 'px-value-fieldset', disabled: busy, hidden: confirming },
        h('div', { className: 'px-value-fields' },
          h('div', { className: 'px-value-field px-value-field-wide' },
            routePicker ? h(React.Fragment, null,
              h('label', { htmlFor: `${id}-route-picker` }, tr('routePick')),
              h('select', {
                id: `${id}-route-picker`, name: manualRoute ? undefined : 'route', className: 'px-value-input', ref: focusField,
                value: manualRoute ? 'manual' : draft.route === '' ? '' : `route:${draft.route}`, onChange: pickRoute,
                'aria-invalid': !manualRoute && invalidField === 'route' ? true : undefined,
                'aria-describedby': `${id}-route-help`,
              }, h('option', { value: '' }, tr('routePrompt')),
              Array.from(routes.keys(), (route) => h('option', { key: route, value: `route:${route}` }, routeText(tr, routes, route))),
              h('option', { value: 'manual' }, tr('routeManual')))) : null,
            editing || manualRoute || !routePicker ? h(React.Fragment, null,
              h('label', { htmlFor: `${id}-route` }, tr('route')),
              h('input', {
                id: `${id}-route`, name: 'route', type: 'text', className: 'px-value-input', required: true,
                ref: editing || routePicker ? undefined : focusField, readOnly: editing, value: draft.route, onChange: field('route'),
                placeholder: tr('routePlaceholder'), spellCheck: false, autoComplete: 'off', autoCapitalize: 'none',
                'aria-invalid': invalidField === 'route' ? true : undefined,
                'aria-describedby': `${id}-route-help${unseen ? ` ${id}-route-unseen` : ''}`,
              })) : null,
            h('p', { className: 'px-value-muted', id: `${id}-route-help` }, tr(editing ? 'routeLocked' : 'routeHelp')),
            unseen ? h('p', { className: 'px-value-muted', id: `${id}-route-unseen` }, tr('routeUnseen'))
              : editing && routeLabel && routeLabel !== draft.route ? h('p', { className: 'px-value-muted' }, routeLabel) : null),
          h('div', { className: 'px-value-field' },
            h('label', { htmlFor: `${id}-fee` }, tr('fee')),
            h('input', {
              id: `${id}-fee`, name: 'fee', ref: editing ? focusField : undefined, className: 'px-value-input',
              type: 'number', inputMode: 'decimal', min: '0.01', max: '1000000', step: '0.01', required: true,
              value: draft.fee, onChange: field('fee'), 'aria-invalid': invalidField === 'fee' ? true : undefined,
            })),
          h('div', { className: 'px-value-field' },
            h('label', { htmlFor: `${id}-currency` }, tr('currency')),
            h('select', { id: `${id}-currency`, name: 'currency', className: 'px-value-input', value: draft.currency,
              onChange: field('currency'), 'aria-invalid': invalidField === 'currency' ? true : undefined },
              h('option', { value: 'USD' }, tr('currencyUsd')),
              h('option', { value: 'CNY' }, tr('currencyCny')))),
          h('div', { className: 'px-value-field' },
            h('label', { htmlFor: `${id}-anchor` }, tr('anchor')),
            h('input', {
              id: `${id}-anchor`, name: 'anchorDate', type: 'date', className: 'px-value-input', value: draft.anchorDate,
              min: '2000-01-01', max: beijingToday(), onChange: field('anchorDate'), required: true,
              'aria-describedby': `${id}-anchor-help`, 'aria-invalid': invalidField === 'anchorDate' ? true : undefined,
            }),
            h('p', { className: 'px-value-muted', id: `${id}-anchor-help` }, tr('anchorHelp'))),
          h('div', { className: 'px-value-field' },
            h('label', { htmlFor: `${id}-quota` }, tr('quotaVendor')),
            h('select', {
              id: `${id}-quota`, name: 'quotaVendor', className: 'px-value-input', value: draft.quotaVendor,
              onChange: field('quotaVendor'), 'aria-describedby': `${id}-quota-help`, 'aria-invalid': invalidField === 'quotaVendor' ? true : undefined,
            },
            h('option', { value: 'none' }, tr('quotaNone')),
            h('option', { value: 'codex' }, tr('quotaCodex'))),
            h('p', { className: 'px-value-muted', id: `${id}-quota-help` }, tr('quotaHelp')),
            config?.quotaVendor === 'codex' && draft.quotaVendor === 'none'
              ? h('p', { className: 'px-value-note' }, tr('unlinkQuota')) : null)),
        h('p', { className: 'px-value-muted' }, tr('storageHelp')),
        h('div', { className: 'px-value-actions' },
          button(tr(writeAction === 'save' ? 'saving' : 'save'), { type: 'submit', 'data-primary': '' }),
          button(tr('cancel'), { onClick: onCancel }),
          editing ? button(tr('remove'), {
            ref: removeButton, 'data-danger': '', onClick: () => { setFailure(null); setConfirming(true) },
          }) : null)),
      confirming ? h('div', { className: 'px-value-confirm', role: 'group', 'aria-label': tr('removeConfirm') },
        h('p', null, tr('removePrompt', { route: config.route })),
        h('div', { className: 'px-value-actions' },
          button(tr('cancel'), {
            ref: cancelRemoval, disabled: busy, onClick: () => {
              setFailure(null)
              returnToRemove.current = true
              setConfirming(false)
            },
          }),
          button(tr(writeAction === 'remove' ? 'removing' : 'removeConfirm'), {
            disabled: busy, 'data-danger': '', onClick: () => { void remove() },
          }))) : null,
      failure === null ? null : h('p', { role: 'alert', className: 'px-value-error' }, tr(failure.key, {
        reason: failure.reason ? tr(failure.reason) : errorText(tr, failure.error),
      }))))
}

function Quality({ tr, fmt, row }) {
  const count = (n) => amountKnown(n) ? fmt.number.format(n) : tr('unknown')
  const notes = [
    tr('usage', { tokens: count(row.tokens), requests: count(row.requests) }),
    row.tokens > 0 && amountKnown(row.pricedTokens) ? tr('coverage', { percent: percentText(tr, fmt, row.pricedTokens / row.tokens) }) : null,
    row.unverifiedRequests > 0 ? tr('unverified', { requests: count(row.unverifiedRequests) }) : null,
    row.tiered ? tr('tiered') : null,
    row.custom ? tr('custom') : null,
  ].filter(Boolean)
  return h('ul', { className: 'px-value-quality' }, notes.map((text) => h('li', { key: text }, text)))
}

function Bar({ value, scale, current = false, quota = false }) {
  const width = (n) => `${Math.max(0, Math.min(100, n / scale * 100))}%`
  const known = amountKnown(value)
  return h('div', { className: 'px-value-track', 'aria-hidden': 'true', 'data-quota': quota ? '' : undefined,
    'data-unknown': known ? undefined : '',
  },
  known && value > 0 ? h('span', { className: 'px-value-fill', 'data-current': current ? '' : undefined, style: { width: width(value) } }) : null,
  quota ? null : h('span', { className: 'px-value-baseline-mark', style: { left: width(1) } }))
}

function periodRange(tr, fmt, period, row) {
  const formatter = period.id === 'billing' ? fmt.date : fmt.time
  return tr('periodRange', { start: formatter.format(row.start), end: formatter.format(row.end) })
}

function periodTitle(tr, fmt, { id, durationMs: ms }) {
  if (id === 'billing') return tr('billing')
  if (ms === HOUR * 5) return tr('durationFiveHours')
  if (ms === DAY * 7) return tr('durationWeek')
  for (const [key, unit] of [['durationDays', DAY], ['durationHours', HOUR], ['durationMinutes', 60_000], ['durationSeconds', 1000]]) {
    if (ms % unit === 0 || unit === 1000) return tr(key, { count: fmt.number.format(ms / unit) })
  }
}

function initialPeriod(periods) {
  const quota = periods.filter((period) => period.durationMs !== null && period.rows.some((row) => row.current))
  return quota.find((period) => period.durationMs === 7 * DAY) ?? quota.at(-1) ?? periods[0]
}

function Receipt({ tr, fmt, plan, period, row, tracking }) {
  const quota = period.id !== 'billing'
  const { currency, fee } = plan.config
  const amount = (value, compact = false) => moneyText(tr, fmt, value, currency, compact)
  const percent = row?.usedPercent
  const percentKnown = amountKnown(percent)
  const headline = ratioText(tr, fmt, row?.power)
  const metric = (tone, label, value, child = null, title) => h('div', {
    className: 'px-value-metric', 'data-tone': tone, title,
  }, h('dt', null, label), h('dd', null, value, child))
  const quotaLabel = row?.current && tracking === 'ready' ? 'quotaUsed' : 'quotaLastUsed'
  const quotaAt = percentKnown && validTime(row?.observedAt) ? tr('quotaAt', { time: fmt.time.format(row.observedAt) }) : undefined
  const formula = quota ? tr('quotaShare', { cost: amount(row?.costShare) }) : tr('billingShare', { cost: amount(fee) })
  const unit = amount(1, true)
  const unitLine = amountKnown(row?.power) ? h('strong', null,
    tr('unitLine', { unit, api: amount(row.power, true) })) : null
  const warning = !row ? 'noCurrent' : row.estimated ? 'partialReceipt'
    : !amountKnown(row.power) ? 'unknownReceipt' : null
  return h(React.Fragment, null,
    h('dl', { className: 'px-value-receipt' },
      quota
        ? metric('quota', tr(quotaLabel), percentKnown ? percentText(tr, fmt, percent / 100) : tr('unknown'),
          h(Bar, { value: percent, scale: 100, quota: true }), quotaAt)
        : metric('quota', tr('monthlyFee'), amount(fee)),
      metric('amount', tr(row?.current ? 'equivalentToDate' : 'equivalent'), amount(row?.apiValue)),
      metric('power', tr('power'), headline, null, formula)),
    h('div', { className: 'px-value-context' },
      h('span', { className: 'px-value-line' }, unitLine,
        h('span', null, tr('baseline', { unit }))),
      h('span', { className: 'px-value-line' },
        row && !row.current ? h('strong', null, tr('lastPeriod')) : null,
        quota && row?.current && validTime(row.end) ? tr('resetAt', { time: fmt.time.format(row.end) }) : null,
        quota && row ? h('span', null, formula) : null)),
    warning ? h('p', { className: 'px-value-note', 'data-warn': '' }, tr(warning)) : null)
}

function PowerRows({ tr, fmt, items }) {
  const scale = Math.max(1.15, ...items.map(({ value }) => amountKnown(value) ? value : 0))
  return h(React.Fragment, null,
    h('ul', { className: 'px-value-compare-list' }, items.map((item) => h('li', {
      key: item.id, className: 'px-value-compare-row', 'data-current': item.current ? '' : undefined, title: item.title,
    },
    h('span', { className: 'px-value-compare-label' }, item.label,
      item.note ? h('span', { className: 'px-value-muted' }, ` · ${item.note}`) : null),
    h(Bar, { value: item.value, scale, current: item.current }),
    h('strong', { className: 'px-value-compare-reading' }, ratioText(tr, fmt, item.value))))),
    items.some(({ value }) => amountKnown(value)) ? h('p', { className: 'px-value-muted' }, tr('scaleLegend', { max: ratioText(tr, fmt, scale) })) : null)
}

function averageNote(tr, average) {
  return tr('samples', { count: average.count, total: average.total })
}

function PeriodDetail({ tr, fmt, selected, period, all, row, routes, snapshot, onRefreshQuota }) {
  const [refresh, setRefresh] = useState(null)
  const busy = useRef(false)
  const quota = period.id !== 'billing'
  const isCodex = selected.config.quotaVendor === 'codex'
  const amount = (value) => moneyText(tr, fmt, value, selected.config.currency)
  const items = period.rows.map((entry) => ({
    id: `${entry.start}/${entry.end}`, value: entry.power, label: periodRange(tr, fmt, period, entry), current: entry.current,
    note: tr(entry.current ? 'current' : entry.estimated || !entry.complete ? 'endedPartial' : 'ended'),
    title: tr('periodTooltip', { api: amount(entry.apiValue), cost: amount(entry.costShare) }),
  }))
  const means = all.map(({ config, monthlyAverage }) => ({
    id: config.route, label: routeText(tr, routes, config.route), current: config.route === selected.config.route,
    value: monthlyAverage.value, note: averageNote(tr, monthlyAverage),
  }))
  const refreshQuota = async () => {
    if (busy.current) return
    busy.current = true
    setRefresh('quotaRefreshing')
    try {
      await onRefreshQuota()
      setRefresh('quotaUpdated')
    } catch {
      setRefresh('quotaRefreshFailed')
    } finally {
      busy.current = false
    }
  }
  const observations = quota && validTime(row?.observedAt) ? tr('quotaAt', { time: fmt.time.format(row.observedAt) }) : null
  const tracking = snapshot.quotaTracking
  return h('div', { className: 'px-value-details' },
    h('div', { className: 'px-value-detail-head' },
      h('h3', { className: 'px-value-subtitle' }, tr('history', { period: periodTitle(tr, fmt, period) })),
      isCodex && typeof onRefreshQuota === 'function' ? button(tr(refresh === 'quotaRefreshing' ? refresh : 'quotaRefresh'), {
        onClick: () => { void refreshQuota() }, disabled: busy.current || tracking === 'disabled',
      }) : null),
    refresh && refresh !== 'quotaRefreshing' ? h('p', { role: 'status', className: 'px-value-note', 'data-warn': refresh === 'quotaRefreshFailed' ? '' : undefined }, tr(refresh)) : null,
    isCodex && tracking === 'disabled' ? h('p', { className: 'px-value-note' }, tr('quotaDisabled')) : null,
    isCodex && tracking === 'unavailable' ? h('p', { className: 'px-value-note' }, tr('quotaUnavailable')) : null,
    isCodex && snapshot.observationError ? h('p', { className: 'px-value-note', 'data-warn': '' }, tr('quotaObservationError')) : null,
    isCodex && selected.periods.length === 1 ? h('p', { className: 'px-value-muted' }, tr('quotaEmpty')) : null,
    items.length ? h(PowerRows, { tr, fmt, items }) : null,
    h('p', { className: 'px-value-muted' }, amountKnown(period.average.value)
      ? tr('rangeAverage', { power: ratioText(tr, fmt, period.average.value), samples: averageNote(tr, period.average) })
      : tr('noAverage', { samples: averageNote(tr, period.average) })),
    h('h3', { className: 'px-value-subtitle' }, tr('planAverages')),
    h(PowerRows, { tr, fmt, items: means }),
    h('details', { className: 'px-value-rules' },
      h('summary', null, tr('assumptions')),
      row ? h(Quality, { tr, fmt, row }) : null,
      h('ul', null,
        observations ? h('li', null, observations) : null,
        validTime(snapshot.dataThrough) ? h('li', null, tr('through', { time: fmt.time.format(snapshot.dataThrough) })) : null,
        h('li', null, tr('powerRule')),
        h('li', null, tr('averageRule')),
        h('li', null, tr('scope')),
        h('li', null, tr('repricing')))))
}

function PowerIcon() {
  return h('span', { className: 'px-value-heading-icon', 'aria-hidden': 'true' },
    h('svg', { viewBox: '0 0 18 18', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.55,
      strokeLinecap: 'round', strokeLinejoin: 'round', focusable: 'false',
    }, h('path', { d: 'M10 2.5 4 10h4l-.4 5.5L14 8h-4.5L10 2.5Z' })))
}

/** Small local receipt; keep transaction controls and detailed comparisons off the default view. */
export function SubscriptionValuePanel({ models, revision, plans, onRefreshQuota, t, locale }) {
  const id = useId()
  const title = useRef(null)
  const editorTrigger = useRef(null)
  const [selectedRoute, setSelectedRoute] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [mode, setMode] = useState(null)
  const [editor, setEditor] = useState(null)
  const [notice, setNotice] = useState(null)
  useEffect(() => {
    if (editor !== null || editorTrigger.current === null) return
    const trigger = editorTrigger.current
    editorTrigger.current = null
    if (trigger.isConnected && !trigger.disabled) trigger.focus()
    else title.current?.focus()
  }, [editor])
  const state = useValueSnapshot(revision, plans?.fetchedAt)
  const fmt = useMemo(() => formatters(locale), [locale])
  const routes = useMemo(() => knownRoutes(models), [models])
  const configs = useMemo(() => buildPurchasingPower(state.payload), [state.payload])
  const tr = (key, params) => {
    const fullKey = `subscriptionValue.${key}`
    const text = typeof t === 'function' ? t(fullKey, params) : undefined
    return typeof text === 'string' && text !== '' && text !== fullKey ? text : subscriptionValueText(locale, fullKey, params)
  }
  const primary = configs.find(({ config }) => config.quotaVendor === 'codex') ?? configs[0]
  const selected = configs.find(({ config }) => config.route === selectedRoute) ?? primary
  const route = selected?.config.route
  const period = selected && (selected.periods.find((entry) => entry.id === selectedPeriod) ?? initialPeriod(selected.periods))
  const row = period?.rows.find((entry) => entry.current) ?? period?.rows[0]
  const openEditor = (config, event) => {
    editorTrigger.current = event.currentTarget
    setNotice(null)
    setEditor({ config })
  }
  const cancelEditor = () => { setEditor(null) }
  const onConfirmed = (key, savedRoute) => {
    editorTrigger.current = null
    setEditor(null)
    setMode(null)
    setNotice({ key, route: savedRoute })
    setSelectedRoute(key === 'saved' ? savedRoute : '')
    setSelectedPeriod(null)
    title.current?.focus()
  }
  const toggle = (next) => { setMode(mode === next ? null : next) }

  return h('section', { className: 'px-value-root', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-guide` },
    h('header', { className: 'px-value-header' },
      h('div', { className: 'px-value-heading' },
        h(PowerIcon),
        h('h2', { id: `${id}-title`, ref: title, tabIndex: -1, className: 'px-value-title' }, tr('title')),
        configs.length > 1 ? h('select', {
          className: 'px-value-input', 'aria-label': tr('planChoice'), value: route, disabled: editor !== null,
          onChange: (event) => { setSelectedRoute(event.target.value); setSelectedPeriod(null); setNotice(null) },
        }, configs.map(({ config }) => h('option', { key: config.route, value: config.route }, routeText(tr, routes, config.route))))
          : selected ? h('span', { className: 'px-value-route-label', title: route }, routes.get(route) ?? route) : null),
      selected ? h('div', { className: 'px-value-actions' },
        selected.periods.length > 1 ? h('select', {
          className: 'px-value-input', 'aria-label': tr('durationChoice'), value: period.id, disabled: editor !== null,
          onChange: (event) => { setSelectedPeriod(event.target.value) },
        }, selected.periods.map((entry) => h('option', { key: entry.id, value: entry.id }, periodTitle(tr, fmt, entry))))
          : h('span', { className: 'px-value-muted' }, periodTitle(tr, fmt, period)),
        button(tr('compare'), { 'aria-expanded': mode === 'compare', disabled: editor !== null, onClick: () => toggle('compare') }),
        button(tr('settings'), { 'aria-expanded': mode === 'settings', disabled: editor !== null || state.error !== null, onClick: () => toggle('settings') })) : null),
    notice ? h('p', { role: 'status', className: 'px-value-note' }, tr(notice.key, { route: notice.route })) : null,
    state.error ? h('div', { className: 'px-value-line' },
      h('p', { role: 'alert', className: 'px-value-error' }, state.error.kind === 'unsupported' ? tr('restart')
        : tr('loadFailed', { reason: errorText(tr, state.error) })),
      state.payload ? h('p', { className: 'px-value-muted' }, tr('stale')) : null,
      button(tr('retry'), { disabled: state.loading || state.writeAction !== null, onClick: () => { void state.reload(true) } })) : null,
    state.payload === null && state.error === null ? h('p', { role: 'status', className: 'px-value-muted' }, tr('loading')) : null,
    state.payload !== null && !selected && editor === null ? h('div', { className: 'px-value-empty' },
      h('p', { className: 'px-value-muted' }, tr('noPlans')),
      button(tr('add'), { 'data-primary': '', disabled: state.error !== null, onClick: (event) => openEditor(null, event) })) : null,
    selected ? h(Receipt, { tr, fmt, plan: selected, period, row, tracking: state.payload.quotaTracking }) : null,
    h('p', { id: `${id}-guide`, className: 'px-value-muted' }, tr('cardGuide')),
    mode === 'compare' && selected ? h(PeriodDetail, {
      key: route, tr, fmt, selected, period, row, all: configs, routes, snapshot: state.payload, onRefreshQuota,
    }) : null,
    mode === 'settings' && selected && editor === null ? h('div', { className: 'px-value-actions' },
      button(tr('edit'), { onClick: (event) => openEditor(selected.config, event) }),
      button(tr('add'), { onClick: (event) => openEditor(null, event) })) : null,
    editor ? h(ConfigEditor, {
      id: `${id}-editor`, tr, routes, configs, config: editor.config,
      write: state.write, writeAction: state.writeAction, onCancel: cancelEditor, onConfirmed,
    }) : null)
}
