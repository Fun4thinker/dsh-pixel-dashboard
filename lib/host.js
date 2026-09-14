/**
 * dsh-pixel-dashboard 的宿主半边：把会话日志抽成用量账本，再按账本汇总
 * token 用量、模型分布、会话清单与活跃热力图，通过只读 HTTP 路由交给浏览器半边。
 *
 * 三个口径上的关键点：
 *   1) 每条请求按它**实际发生时刻**所属的时段（高峰 / 空闲）分别累计，
 *      于是费用可以精确到「这笔当时是高峰还是空闲」，而不是整段套一个折扣；
 *   2) 缓存未命中输入由 input - cacheRead - cacheWrite 反推，避免把缓存命中的
 *      token 重复计入高价档（totalTokens 含缓存命中，不能直接用）；
 *   3) 统计口径来自**账本**而不是直接读会话日志：账本是一份按请求去重的小文件，
 *      重复扫描不会翻倍，因此重装或换机都不会丢历史、也不会多算（见 lib/ledger.js）。
 *
 * 除了账本文件，宿主不落任何新状态。
 * @module dsh-pixel-dashboard/lib/host
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TIMEZONE,
  MODEL_RATES,
  PEAK_WEEKDAYS,
  PEAK_WINDOWS,
  costOf,
  dateKey,
  isPeak,
  normalizeModel,
  periodState,
  pricingOf,
  ratesOf,
  zonedParts,
} from './pricing.js'
import { UsageLedger, recordOf, usageOfRecord } from './ledger.js'
import { BalanceService } from './balance.js'
import { PlansService } from './plans.js'
import { Preferences, resolvePrefsPath } from './prefs.js'

/** 路由前缀：看板数据挂在这里，避免和产品路由相撞。 */
const ROUTE_PREFIX = '/dsh-pixel'

/**
 * 实现版本号，由构建脚本按宿主源码哈希注入。
 * 未构建时保持占位符，便于一眼看出这是源码树而非产物。
 */
const IMPL_VERSION = 'd7be421a'

/**
 * 数据能力声明：客户端据此判断「宿主有没有这项数据」，而不是比对版本哈希。
 *
 * 用能力而不是版本相等，是因为哈希会随任何源码改动而变，包括完全不影响数据
 * 形状的改动（例如删掉一个没人用的字段）。用哈希当闸门会把好数据一起挡掉，
 * 表现是界面永远停在加载/折算中。
 *
 * 新增或改变某个字段的含义时，把对应能力名加到这里。
 */
const CAPABILITIES = [
  'period',
  'peakRule',
  'sessionCost',
  'calendarByDay',
  'tieredRates',
  'crossDeviceLedger',
  'balance',
  'balanceToggle',
  'thirdPartyPlans',
]

/** 快照缓存有效期：会话日志只在使用后变化，短缓存即可挡住频繁刷新。 */
const SNAPSHOT_TTL_MS = 20_000

/** 单次读取的事件条数。 */
const READ_CHUNK = 500

/** 热力图回看的自然日数（一年视图）。 */
const HEATMAP_DAYS = 371

/** 单个会话允许读取的最大事件数，防止异常日志拖垮一次请求。 */
const MAX_EVENTS_PER_SESSION = 200_000

/** 空用量累加器：总量 + 分时段。 */
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
 * 把一份**已归一**的用量并入累加器，并按发生时刻记入高峰或空闲档。
 *
 * 入参的形状与 `usageOfRecord()` 的返回值一致（cacheHit / cacheMiss / cacheWrite /
 * output / reasoning / local / requests）。早先这个函数是照着会话事件的原始 usage
 * 字段（inputTokens / cacheReadTokens…）写的，改成账本后字段名对不上，
 * 于是每一项都读到 undefined、只有请求计数在涨——聚合结果全为 0 而毫无报错。
 * @param {object} acc - 累加器。
 * @param {object} usage - 归一后的用量。
 * @param {boolean} peak - 该请求是否落在高峰时段。
 * @returns {void}
 */
function addUsage(acc, usage, peak) {
  const cacheHit = Number(usage.cacheHit ?? 0)
  const cacheWrite = Number(usage.cacheWrite ?? 0)
  const cacheMiss = Number(usage.cacheMiss ?? 0)
  const output = Number(usage.output ?? 0)

  acc.cacheHit += cacheHit
  acc.cacheWrite += cacheWrite
  acc.cacheMiss += cacheMiss
  acc.output += output
  acc.reasoning += Number(usage.reasoning ?? 0)
  acc.local += Number(usage.local ?? 0)
  acc.requests += Number(usage.requests ?? 1)

  const bucket = peak ? acc.peak : acc.idle
  bucket.cacheHit += cacheHit
  bucket.cacheMiss += cacheMiss
  bucket.output += output
  bucket.requests += 1
}

/**
 * 读取一个会话的全部事件；任何读取失败都退化为已读到的前缀。
 * @param {object} persistence - ctx.sessionPersistence。
 * @param {string} id - 会话 id。
 * @returns {Promise<object[]>} 事件数组。
 */
async function readEvents(persistence, id) {
  let handle
  try {
    handle = await persistence.open(id, 'read')
  } catch {
    return []
  }
  const events = []
  try {
    let offset = 0
    for (;;) {
      const page = await handle.read(offset, READ_CHUNK)
      const batch = page?.events ?? []
      if (batch.length === 0) break
      for (const event of batch) events.push(event)
      offset += batch.length
      if (batch.length < READ_CHUNK || events.length >= MAX_EVENTS_PER_SESSION) break
    }
  } catch {
    // 只读投影：读中断时用前缀数据，不阻塞页面。
  } finally {
    try {
      await handle.close()
    } catch {
      // 关闭失败不影响已读数据。
    }
  }
  return events
}

/**
 * 把「按模型 + 按时段」的用量折算成金额。
 * @param {Record<string, object>} byModel - 模型 → 含 peak/idle 分档的用量。
 * @returns {{standard:number,ifAllIdle:number,saved:number,peak:number,idle:number}}
 */
function costByModel(byModel) {
  let standard = 0
  let ifAllIdle = 0
  let peakPart = 0
  let idlePart = 0
  for (const [model, usage] of Object.entries(byModel)) {
    const rates = ratesOf(model)
    peakPart += costOf(usage.peak, rates, 'peak')
    idlePart += costOf(usage.idle, rates, 'idle')
    standard += costOf(usage.peak, rates, 'peak') + costOf(usage.idle, rates, 'idle')
    // 同一份用量若全落在空闲时段能省多少
    ifAllIdle += costOf(
      {
        cacheHit: usage.peak.cacheHit + usage.idle.cacheHit,
        cacheMiss: usage.peak.cacheMiss + usage.idle.cacheMiss,
        output: usage.peak.output + usage.idle.output,
      },
      rates,
      'idle',
    )
  }
  return { standard, ifAllIdle, saved: standard - ifAllIdle, peak: peakPart, idle: idlePart }
}

/**
 * 单个会话的费用摘要，供输入框下方的费用条使用。
 * 金额保留 6 位小数：单次会话可能只有几分钱，过早取整会变成 0。
 * @param {Record<string, object>} byModel - 会话内模型 → 分档用量。
 * @returns {{standard:number,peak:number,idle:number}}
 */
function sessionCost(byModel) {
  const total = costByModel(byModel)
  const round = (value) => Math.round(value * 1e6) / 1e6
  return { standard: round(total.standard), peak: round(total.peak), idle: round(total.idle) }
}

/**
 * 解析账本文件路径。
 *
 * 默认落在 `$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl`，即本机。
 * `DSH_PIXEL_LEDGER` 可以覆盖它：想让账本跟着插件目录走、或独立放到别处时可用。
 * @returns {string|undefined} 绝对路径；两者都推不出时返回 undefined（禁用账本）。
 */
function resolveLedgerPath() {
  const configured = process.env.DSH_PIXEL_LEDGER
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME
    ?? (process.env.USERPROFILE ?? homedir())
  if (typeof home !== 'string' || home.trim() === '') return undefined
  return join(home.trim(), 'plugins', 'dsh-pixel-dashboard', 'usage-ledger.jsonl')
}

/** 本机标识：账本里记录来源，便于分辨哪台机器贡献了多少。 */
function resolveMachine() {
  const explicit = process.env.DSH_PIXEL_MACHINE
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown'
}

/** 看板数据聚合器：会话级增量缓存 + 账本 + 整体快照缓存 + 并发合并。 */
export class UsageCatalog {
  /**
   * @param {object} deps - 依赖取值函数，全部惰性读取可选服务。
   * @param {() => object|undefined} deps.persistence - sessionPersistence。
   * @param {() => object|undefined} deps.sessions - sessions（判断会话是否在线）。
   * @param {() => string} deps.timezone - 站点时区。
   * @param {string} [deps.ledgerPath] - 账本路径；显式传入便于测试。
   * @param {string} [deps.machine] - 本机标识。
   */
  constructor({ persistence, sessions, timezone, ledgerPath, machine }) {
    this.persistence = persistence
    this.sessions = sessions
    this.timezone = timezone
    this.machine = machine ?? resolveMachine()
    this.ledgerPath = () => ledgerPath ?? resolveLedgerPath()
    const path = this.ledgerPath()
    /** @type {UsageLedger|undefined} */
    this.ledger = path === undefined ? undefined : new UsageLedger(path)
    /** @type {Map<string, {fingerprint:string, events:object[]}>} */
    this.cache = new Map()
    this.snapshot = undefined
    this.snapshotAt = 0
    this.inflight = undefined
  }

  /** 让下一次请求重新扫盘。 */
  invalidate() {
    this.snapshot = undefined
    this.snapshotAt = 0
  }

  /**
   * 读取看板数据（TTL 缓存；并发请求共用同一次扫描）。
   * @returns {Promise<object>} 看板数据。
   */
  async read() {
    const now = Date.now()
    if (this.snapshot !== undefined && now - this.snapshotAt < SNAPSHOT_TTL_MS) return this.snapshot
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.build(now)
      .then((snapshot) => {
        this.snapshot = snapshot
        this.snapshotAt = Date.now()
        return snapshot
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * 扫描全部会话：抽账本记录、收集会话元信息，并把记录并入账本。
   *
   * 账本是「合并」语义：本机日志里已有的记录按 `sessionId:seq` 去重后追加，
   * 因此多台机器各自跑一遍，就能在同一份账本上累积出完整历史。
   * @param {number} now - 当前时刻。
   * @returns {Promise<{records:object[],sessions:object[],ledger:{path:string,machine:string,added:number,total:number,enabled:boolean,error?:string}}>}
   */
  async collect(now) {
    const persistence = this.persistence()
    const snapshots = persistence === undefined ? [] : await this.listSnapshots(persistence)
    /** @type {object[]} */
    const records = []
    /** @type {object[]} */
    const sessions = []

    for (const snapshot of snapshots) {
      const header = snapshot.header ?? {}
      const id = String(header.id ?? '')
      if (id === '') continue
      const fingerprint = `${String(snapshot.revision ?? '')}:${snapshot.eventCount ?? ''}:${snapshot.sizeBytes ?? ''}`
      const cached = this.cache.get(id)
      let events
      if (cached !== undefined && cached.fingerprint === fingerprint) {
        events = cached.events
      } else {
        events = await readEvents(persistence, id)
        this.cache.set(id, { fingerprint, events })
      }

      const sessionDays = new Set()
      let turns = 0
      for (const event of events) {
        if (event?.type === 'turn/start') turns += 1
        const record = recordOf(id, event)
        if (record === undefined) continue
        records.push(record)
        sessionDays.add(dateKey(record.t, this.timezone()))
      }

      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      sessions.push({
        id,
        createdAt: Number(header.createdAt ?? 0),
        cwd,
        workspace: workspaceLabel(cwd),
        agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
        isSeeded: header.isSeeded === true,
        turns,
        days: [...sessionDays].sort(),
        live: this.sessions?.()?.get?.(id) !== undefined,
      })
    }

    // 账本不可用时（路径都推不出）退化为只统计本机日志，而不是整块失败
    const added = this.ledger === undefined
      ? { added: 0, total: records.length }
      : await this.ledger.merge(records)
    const ledger = {
      path: this.ledger?.path ?? null,
      machine: this.machine,
      enabled: this.ledger !== undefined,
      added: added.added,
      total: added.total,
      ...(this.ledger?.lastError === undefined ? {} : { error: this.ledger.lastError }),
    }
    const merged = this.ledger === undefined ? records : this.ledger.records
    return { records: merged, sessions, ledger }
  }

  /**
   * 扫描并聚合看板数据。
   * @param {number} now - 当前时刻。
   * @returns {Promise<object>} 看板数据。
   */
  async build(now) {
    const timezone = this.timezone()
    const { records, sessions, ledger } = await this.collect(now)

    /** @type {Map<string, object>} */
    const days = new Map()
    /** @type {Record<string, object>} */
    const modelTotals = {}
    /** @type {Map<string, object>} */
    const bySession = new Map()
    /**
     * 日历数据：按天索引的请求 / 会话 / token。
     *
     * 早先这里还有一份「星期 × 小时」分布，供单独的小时热力图使用；那张图已按
     * 需求去掉，这里就不再计算——留着没人读，只会让响应变大。
     */
    const calendar = {
      requests: new Array(HEATMAP_DAYS).fill(0),
      sessions: new Array(HEATMAP_DAYS).fill(0),
      tokens: new Array(HEATMAP_DAYS).fill(0),
    }
    /** 同一格里可能有多条请求，按会话去重需要逐格收集。 */
    const daySessions = Array.from({ length: HEATMAP_DAYS }, () => new Set())
    const heatmap = new Array(HEATMAP_DAYS * 24).fill(0)
    const anchor = zonedParts(now, timezone)
    const anchorUtc = Date.UTC(anchor.year, anchor.month - 1, anchor.day)
    const firstDayUtc = anchorUtc - (HEATMAP_DAYS - 1) * 86_400_000

    for (const record of records) {
      const usage = usageOfRecord(record)
      if (usage.local <= 0 && usage.requests === 0) continue
      const sessionId = String(record.s ?? '')
      const model = String(record.m ?? 'unknown')
      // 关键：按该请求**发生时刻**判定时段。跨设备记录同样带原始时间戳，
      // 因此别的机器在高峰时段跑的量不会被按本机当前时段错算。
      const peak = isPeak(Number(record.t), timezone)

      const modelAcc = (modelTotals[model] ??= emptyUsage())
      addUsage(modelAcc, usage, peak)

      const sessionAcc = bySession.get(sessionId) ?? { totals: emptyUsage(), byModel: {}, days: new Set() }
      addUsage(sessionAcc.totals, usage, peak)
      addUsage((sessionAcc.byModel[model] ??= emptyUsage()), usage, peak)
      bySession.set(sessionId, sessionAcc)

      const key = dateKey(Number(record.t), timezone)
      sessionAcc.days.add(key)
      const day = days.get(key) ?? { key, totals: emptyUsage(), byModel: {}, sessions: new Set() }
      addUsage(day.totals, usage, peak)
      addUsage((day.byModel[model] ??= emptyUsage()), usage, peak)
      day.sessions.add(sessionId)
      days.set(key, day)

      const parts = zonedParts(Number(record.t), timezone)
      const cell = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - firstDayUtc) / 86_400_000)
      if (cell >= 0 && cell < HEATMAP_DAYS) {
        heatmap[cell * 24 + parts.hour] += 1
        calendar.requests[cell] += 1
        calendar.tokens[cell] += Number(record.i ?? 0) + Number(record.o ?? 0)
        daySessions[cell].add(sessionId)
      }
    }

    // 把账本里的用量合进会话元信息：会话可能来自别的机器，本机没有它的日志
    for (const session of sessions) {
      const acc = bySession.get(session.id)
      bySession.delete(session.id)
      if (acc === undefined) {
        session.totals = roundUsage(emptyUsage())
        session.cost = sessionCost({})
        session.models = []
        continue
      }
      session.totals = roundUsage(acc.totals)
      // 会话级费用：输入框下方的费用条直接用它显示「本次会话花了多少」。
      // 这里就按分档算好，避免客户端再拼一遍口径。
      session.cost = sessionCost(acc.byModel)
      session.models = Object.keys(acc.byModel).sort()
      session.days = [...acc.days].sort()
    }
    // 仅存在于账本（其它机器）的会话也补进清单，否则跨设备历史会凭空消失
    for (const [sessionId, acc] of bySession) {
      sessions.push({
        id: sessionId,
        createdAt: Number(records.find((record) => record.s === sessionId)?.t ?? 0),
        cwd: '',
        workspace: '(其它设备)',
        agentPreset: '',
        isSeeded: false,
        turns: 0,
        totals: roundUsage(acc.totals),
        cost: sessionCost(acc.byModel),
        models: Object.keys(acc.byModel).sort(),
        days: [...acc.days].sort(),
        live: false,
      })
    }

    const dayRows = [...days.values()]
      .map((day) => ({
        key: day.key,
        totals: roundUsage(day.totals),
        byModel: roundByModel(day.byModel),
        sessions: day.sessions.size,
      }))
      .sort((a, b) => a.key.localeCompare(b.key))

    const today = dateKey(now, timezone)
    const todayTotals = dayRows.find((row) => row.key === today)?.totals ?? roundUsage(emptyUsage())
    const models = Object.entries(modelTotals)
      .map(([model, usage]) => {
        const pricing = pricingOf(model)
        const rates = pricing.rates
        return {
          model,
          label: rates.label ?? model,
          version: rates.version ?? '',
          // 单价是否真的知道：兜底价会被界面标成「按 Flash 估算」，不假装精确
          priced: pricing.known,
          tiered: pricing.tiered,
          vendor: pricing.vendor,
          rates,
          cost: {
            standard: costOf(usage.peak, rates, 'peak') + costOf(usage.idle, rates, 'idle'),
            peakOnly: costOf(usage.peak, rates, 'peak'),
            idlePart: costOf(usage.idle, rates, 'idle'),
          },
          totals: roundUsage(usage),
        }
      })
      .sort((a, b) => b.totals.local - a.totals.local)

    const roundedModelTotals = {}
    for (const [model, usage] of Object.entries(modelTotals)) roundedModelTotals[model] = roundUsage(usage)

    return {
      generatedAt: now,
      timezone,
      version: IMPL_VERSION,
      capabilities: CAPABILITIES,
      // 账本信息：路径与来源机器，用于确认跨设备同步是否生效
      machine: this.machine,
      ledger,
      period: periodState(now, timezone),
      peakRule: {
        windows: PEAK_WINDOWS,
        weekdays: PEAK_WEEKDAYS,
        note: '高峰时段为北京时间周一至周五 9:00–12:00、14:00–18:00，其余（含全部周末）为空闲时段，空闲价为高峰价的一半。',
      },
      pricing: {
        currency: 'CNY',
        unit: 'per-million-tokens',
        rates: MODEL_RATES,
        source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      },
      overview: {
        totals: sumDays(dayRows),
        sessions: sessions.length,
        activeDays: dayRows.length,
        firstDay: dayRows[0]?.key ?? null,
        lastDay: dayRows.at(-1)?.key ?? null,
        streaks: streaks(dayRows.map((row) => row.key), today),
        modelsUsed: models.length,
      },
      windows: {
        today: todayTotals,
        last7: sumDays(dayRows.slice(-7)),
        last30: sumDays(dayRows.slice(-30)),
        all: sumDays(dayRows),
      },
      cost: costByModel(roundedModelTotals),
      days: dayRows,
      models,
      sessions: sessions.sort((a, b) => b.createdAt - a.createdAt),
      heatmap: {
        firstDay: new Date(firstDayUtc).toISOString().slice(0, 10),
        days: HEATMAP_DAYS,
        cells: heatmap,
        max: Math.max(1, ...heatmap),
        // 按天聚合：一天一个方块，供年历使用
        requests: calendar.requests,
        sessions: calendar.sessions.map((_, index) => daySessions[index].size),
        tokens: calendar.tokens,
        maxRequests: Math.max(1, ...calendar.requests),
      },
    }
  }

  /**
   * 列出可读会话快照。
   * @param {object} persistence - ctx.sessionPersistence。
   * @returns {Promise<object[]>} 快照数组。
   */
  async listSnapshots(persistence) {
    try {
      const all = await persistence.list()
      return Array.isArray(all) ? all.filter((row) => row !== null && typeof row === 'object') : []
    } catch {
      return []
    }
  }
}

/** 用量取整（含分时段），减小响应体积。 */
function roundUsage(usage) {
  const bucket = (value) => ({
    cacheHit: Math.round(value.cacheHit),
    cacheMiss: Math.round(value.cacheMiss),
    output: Math.round(value.output),
    requests: Math.round(value.requests),
  })
  return {
    cacheHit: Math.round(usage.cacheHit),
    cacheMiss: Math.round(usage.cacheMiss),
    cacheWrite: Math.round(usage.cacheWrite),
    output: Math.round(usage.output),
    reasoning: Math.round(usage.reasoning),
    local: Math.round(usage.local),
    requests: Math.round(usage.requests),
    peak: bucket(usage.peak),
    idle: bucket(usage.idle),
  }
}

/** @param {Record<string, object>} byModel - 模型 → 用量。 */
function roundByModel(byModel) {
  const out = {}
  for (const [model, usage] of Object.entries(byModel)) out[model] = roundUsage(usage)
  return out
}

/** 求和多天用量。 */
function sumDays(rows) {
  const acc = emptyUsage()
  for (const row of rows) {
    const totals = row.totals ?? {}
    for (const key of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local', 'requests']) {
      acc[key] += Number(totals[key] ?? 0)
    }
    for (const part of ['peak', 'idle']) {
      for (const key of ['cacheHit', 'cacheMiss', 'output', 'requests']) {
        acc[part][key] += Number(totals[part]?.[key] ?? 0)
      }
    }
  }
  return roundUsage(acc)
}

/**
 * 由活跃日期表算当前与最长连续天数。
 * @param {string[]} keys - 升序 `YYYY-MM-DD`。
 * @param {string} today - 站点时区的今天。
 * @returns {{current:number,longest:number}}
 */
function streaks(keys, today) {
  if (keys.length === 0) return { current: 0, longest: 0 }
  const dayMs = 86_400_000
  let longest = 1
  let run = 1
  for (let i = 1; i < keys.length; i += 1) {
    run = Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`) === dayMs ? run + 1 : 1
    if (run > longest) longest = run
  }
  const tailGap = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${keys.at(-1)}T00:00:00Z`)) / dayMs
  let current = 0
  if (tailGap <= 1) {
    current = 1
    for (let i = keys.length - 1; i > 0; i -= 1) {
      if (Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`) !== dayMs) break
      current += 1
    }
  }
  return { current, longest }
}

/** 工作目录 → 末段目录名。 */
function workspaceLabel(cwd) {
  if (cwd === '') return '(未知目录)'
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd
}

/**
 * 统一的 JSON 响应出口。
 *
 * 抽出来是因为「状态码 + 两个头 + 序列化」这三件事在四条路由里重复了十来次，
 * 而漏掉 `cache-control: no-store` 这类错误**不会报错**，只会让浏览器端
 * 拿到过期数据——这种错最难查，交给一个函数保证。
 * @param {object} res - ServerResponse。
 * @param {number} status - 状态码。
 * @param {object} payload - 要序列化的负载。
 * @param {boolean} [headOnly] - 只写头，不写体（HEAD 请求）。
 * @returns {void}
 */
function sendJson(res, status, payload, headOnly) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(headOnly === true ? undefined : JSON.stringify(payload))
}

/** 允许的请求体上限：开关只有 `{enabled:boolean}` 几十字节。 */
const MAX_BODY_BYTES = 4 * 1024

/**
 * 读取并解析 JSON 请求体。
 *
 * 超限时**不**销毁连接：销毁会让那条 keep-alive 连接来不及把 400 响应写回去，
 * 调用方就只能看到一个「连接被重置」而不是「请求体过大」。这里改为停止累积、
 * 继续把剩余数据读掉（drain），让连接保持可用。
 * @param {object} req - IncomingMessage。
 * @returns {Promise<unknown>} 解析结果。
 * @throws {Error} 体过大或不是合法 JSON。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let oversize = false
    let settled = false
    /** 只结算一次：data/end/error 可能在同一请求里都触发。 */
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (oversize) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        oversize = true
        chunks.length = 0
        fail(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => { fail(error) })
    req.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        settled = true
        resolve(undefined)
        return
      }
      // 先解析再标记已结算：若把 settled 提前置真，JSON.parse 抛错时 fail()
      // 会因为「已结算」直接返回，这个 Promise 就永远不落地了。
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        fail(new Error('请求体不是合法 JSON'))
        return
      }
      settled = true
      resolve(parsed)
    })
  })
}

/**
 * 宿主半边插件体：注册只读数据路由，并在会话提交后让缓存失效。
 *
 * 以对象形式导出，因为必须声明 `inject: ['webServer']`：实测在 profile 组合里
 * apply 执行时 webServer 可能尚未发布，此时若自行判空返回，整行会静默不激活
 * （路由 404 且没有任何报错）。交给 Cordis 等待服务就绪才是正确做法。
 * 其余服务（sessionPersistence / sessions）可能确实不存在，保持 ctx.get 惰性读取。
 */
export default {
  name: 'pixel-dashboard',

  inject: ['webServer'],

  /**
   * @param {object} ctx - 宿主 Cordis 上下文，webServer 已就绪。
   * @returns {void}
   */
  apply(ctx) {
    const catalog = new UsageCatalog({
      persistence: () => ctx.get('sessionPersistence'),
      sessions: () => ctx.get('sessions'),
      timezone: () => DEFAULT_TIMEZONE,
    })

    // 开关存储两个功能**共用**：各写各的文件会互相覆盖（读—改—写竞态）。
    const prefs = new Preferences(resolvePrefsPath(), { balanceEnabled: true, plansEnabled: true })

    // 余额查询：凭据与设置都惰性读取，缺任一项都退化为「余额不可用」，
    // 而不是让整个插件失效（见 lib/balance.js）。
    const balance = new BalanceService({
      credentials: () => ctx.get('credentials'),
      settings: () => ctx.get('settings'),
      prefs,
    })

    // 第三方套餐额度（智谱 Coding Plan / Command Code）。两家都是未文档化的内部
    // 接口，因此全程 fail-soft：一家失败只标那一家（见 lib/plans.js）。
    const plans = new PlansService({
      credentials: () => ctx.get('credentials'),
      prefs: () => prefs.read(),
    })

    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/version`,
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ version: IMPL_VERSION, routePrefix: ROUTE_PREFIX }))
      },
    })

    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/balance`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        let payload
        try {
          payload = await balance.read({ refresh: url.searchParams.get('refresh') === '1' })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        // HEAD 与 GET 走同一条逻辑，但只回头部；金额是唯一载荷，不必为其开一条分支。
        sendJson(res, 200, payload, req.method === 'HEAD')
      },
    })

    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/plans`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        let payload
        try {
          payload = await plans.read({ refresh: url.searchParams.get('refresh') === '1' })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        sendJson(res, 200, payload, req.method === 'HEAD')
      },
    })

    /** 可切换的开关：路由名 → 在 prefs 里的键与默认值。 */
    const TOGGLES = {
      balance: { key: 'balanceEnabled', service: balance, label: '余额查询' },
      plans: { key: 'plansEnabled', service: plans, label: '第三方套餐监控' },
    }

    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 轻量的同源闸门：这个开关会让宿主向第三方端点发请求，不接受跨站表单触发。
        // sec-fetch-site 缺失（老浏览器/命令行）时不拦，避免把正常用法挡掉。
        const site = req.headers?.['sec-fetch-site']
        if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
          // 拒绝时要把请求体抽干：不读干净会让这条 keep-alive 连接上的后续请求错位。
          req.resume?.()
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const target = TOGGLES[String(body?.target ?? '')]
        if (target === undefined) {
          sendJson(res, 400, { error: `target 需要是 ${Object.keys(TOGGLES).join(' / ')} 之一` })
          return
        }
        if (typeof body?.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'body 需要 { target, enabled: boolean }' })
          return
        }
        if (target.service.lockedByEnv) {
          sendJson(res, 200, {
            target: body.target,
            enabled: false,
            persisted: false,
            lockedByEnv: true,
            message: `${target.label}已被环境变量关闭`,
          })
          return
        }
        const { persisted } = await prefs.patch({ [target.key]: body.enabled })
        // 关掉时立刻清缓存：重新打开必须是一次真实请求，而不是端上一份旧快照。
        target.service.invalidate?.()
        sendJson(res, 200, { target: body.target, enabled: body.enabled, persisted, lockedByEnv: false })
      },
    })

    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/data`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.searchParams.get('refresh') === '1') catalog.invalidate()
        let body
        try {
          body = JSON.stringify(await catalog.read())
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    })

    // 会话提交/关闭后数据会变：标记失效，下一次请求重扫。
    ctx.on('session/flush', () => {
      catalog.invalidate()
    })
    ctx.on('session/disposed', () => {
      catalog.invalidate()
    })
  },
}
