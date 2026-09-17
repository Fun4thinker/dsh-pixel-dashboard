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
import { UsageLedger, rateKeyOfModelKey, recordOf, rollupOf, usageOfRecord } from './ledger.js'
import { BalanceService } from './balance.js'
import { PlansService } from './plans.js'
import { Preferences, resolvePrefsPath } from './prefs.js'
import {
  NOTIFY_DEFAULTS,
  NotifyJournal,
  normalizeNotify,
  noticeOf,
} from './notify.js'

/** 路由前缀：看板数据挂在这里，避免和产品路由相撞。 */
const ROUTE_PREFIX = '/dsh-pixel'

/**
 * 实现版本号，由构建脚本按宿主源码哈希注入。
 * 未构建时保持占位符，便于一眼看出这是源码树而非产物。
 */
const IMPL_VERSION = '__DSH_PIXEL_IMPL_VERSION__'

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
  // 独立的时段路由：侧栏那枚指示灯靠它拿到「本段总长」，从而画出环形进度。
  // 单独列一个名字是因为它可能缺失（旧宿主）而 `/data` 仍在——那时指示灯不画，
  // 看板其余部分照常，而不是整块界面按版本哈希一起降级。
  'periodClock',
  'peakRule',
  'sessionCost',
  'calendarByDay',
  'tieredRates',
  'crossDeviceLedger',
  'balance',
  'balanceToggle',
  'thirdPartyPlans',
  // 通知日志（会话结束事实）与预警阈值配置。两者一起声明：客户端只要拿到
  // `/notify` 这条路由就能同时读写它们，拆成两个能力名没有意义。
  'notifyJournal',
  'notifyThresholds',
  // 会话清单里的**预览标题**（与 DSH 侧栏同源）。旧宿主只给会话 id，
  // 那时界面回落到显示 id 片段，而不是显示一个不存在的标题。
  'sessionTitle',
  // 模型条目的身份从「模型路由名」改成「模型 × 提供商」：数据里的 `models[].key`
  // 与按日/按会话的 `byModel` 键都跟着变成复合键。旧宿主给的还是单个模型名，
  // 客户端按两种键都能查价（见 cost.js 的 ratesFor）。
  'modelProvider',
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
    // 键可能是 `deepseek-flash@commandcode` 这类「模型 × 提供商」复合键：
    // 提供商不参与定价（同一模型各家的价目表条目本就不同，未知的按兜底价），
    // 因此取键里的模型部分去查价。
    const rates = ratesOf(rateKeyOfModelKey(model))
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
 * 从实时 LLM 注册表读一份「哪个提供商提供哪些模型」的目录。
 *
 * 这张表回答两个界面问题：
 *   1) 提供商该显示成什么名字（路由名 `workbuddy-cn` 对用户没有意义）；
 *   2) 模型该显示成什么名字——**以 DSH 设置里的外显名为准**，因此用户在设置里
 *      改了模型名，看板跟着改（这正是「支持跟随设置更新」）。
 *
 * 全程 fail-soft：LLM 服务没发布、某个提供商的模型列表读失败，都只是目录少一块，
 * 界面退回价目表里的名字。这是**展示层**的增强，绝不能让取数失败。
 *
 * 另外它顺手解决了一个历史遗留问题：像 `deepseek/deepseek-v4.1-flash` 这种
 * 「提供商/模型」形态的 id，能据此认出提供商，于是旧账本里认不出来源的记录
 * 也能归到正确的提供商下（见 ledger.js 的 upgradeRecord）。
 * @param {object|undefined} llm - ctx.get('llm')。
 * @returns {Promise<{providerNames:Map<string,string>,byProvider:Map<string,{name:string}>,byRollup:Map<string,{name:string,canonical:boolean}>,candidates:Map<string,Set<string>>,nativeProvider:Map<string,string>}>} 目录。
 */
async function buildModelDirectory(llm) {
  const empty = {
    providerNames: new Map(),
    byProvider: new Map(),
    byRollup: new Map(),
    candidates: new Map(),
    nativeProvider: new Map(),
  }
  if (llm === undefined || typeof llm.listProviders !== 'function') return empty
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return empty
  }
  if (!Array.isArray(providers)) return empty

  const directory = {
    providerNames: new Map(),
    byProvider: new Map(),
    byRollup: new Map(),
    candidates: new Map(),
    nativeProvider: new Map(),
  }
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id.trim() : ''
    if (id === '') continue
    const name = typeof provider?.name === 'string' && provider.name.trim() !== '' ? provider.name.trim() : id
    directory.providerNames.set(id, name)
    let models = []
    try {
      // 只读查询：某一家读不出来（端点不通、模型列表接口报错）不影响其余各家
      models = typeof llm.listModels === 'function' ? (await llm.listModels(id)) ?? [] : []
    } catch {
      models = []
    }
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = typeof model?.id === 'string' ? model.id.trim() : ''
      if (modelId === '') continue
      const display = typeof model?.name === 'string' && model.name.trim() !== '' ? model.name.trim() : modelId
      directory.byProvider.set(`${id}\u0000${modelId}`, { name: display })
      // 候选表按**原生模型 id** 索引：账本里存的正是这个值（未归一的原始 id）。
      // 「只由一家提供」的模型可以据此确定提供商，多于一家时**不猜**。
      const set = directory.candidates.get(modelId) ?? new Set()
      set.add(id)
      directory.candidates.set(modelId, set)
      // 反查「某提供商的某个归一模型叫什么」：聚合后一个条目可能对应多条原生 id
      // （`hy4-preview-f` / `deepseek-v4.1-flash` / `deepseek-flash` 都是同一家的
      // 同一个模型），因此按归一键再建一张索引，名字随 DSH 设置变。
      //
      // 谁的名字算数：**原生 id 已经等于归一键的那条优先**——它就是该提供商的
      // 正式名字（`deepseek-flash` → 「DeepSeek Flash」），而别名条目
      // （`hy4-preview-f` → 「Work-Hy4 preview」）只是同一个模型在网关里的另一个
      // 入口。没有正式名字时才退回第一条别名，总比没有名字强。
      const rollupKey = `${id}\u0000${rollupOf(modelId)}`
      const existing = directory.byRollup.get(rollupKey)
      const canonical = rollupOf(modelId) === modelId
      if (existing === undefined || (canonical && existing.canonical !== true)) {
        directory.byRollup.set(rollupKey, { name: display, canonical })
      }
      // `提供商/模型` 形态的 id：斜杠左边是提供商的**自称**（不一定等于 DSH 的路由名）。
      // 真实路由名由这里的 `id` 给出，因此账本里那个自称要能被换成 id。
      const slash = modelId.indexOf('/')
      if (slash > 0 && slash < modelId.length - 1) {
        directory.nativeProvider.set(modelId, id)
      }
    }
  }
  return directory
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
   * @param {() => object|undefined} [deps.llm] - LLM 注册表（模型 / 提供商显示名）。
   * @param {string} [deps.ledgerPath] - 账本路径；显式传入便于测试。
   * @param {string} [deps.machine] - 本机标识。
   */
  constructor({ persistence, sessions, timezone, llm, ledgerPath, machine }) {
    this.persistence = persistence
    this.sessions = sessions
    this.timezone = timezone
    this.llm = llm ?? (() => undefined)
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
    // 模型 / 提供商显示名目录：每次扫描重建一次（设置里改了模型名立刻反映到看板上）。
    const directory = await buildModelDirectory(this.llm())
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
      /** 最新的 `session/title` 文本（last-wins）。 */
      let title = ''
      for (const event of events) {
        if (event?.type === 'turn/start') turns += 1
        // 标题事件是 log-only 的，last-wins：用户改名与模型生成的标题都走它。
        // 认不出形状时保留上一个已知标题，而不是把已有标题擦成空。
        if (event?.type === 'session/title') {
          const next = event.data?.title
          if (typeof next === 'string' && next.trim() !== '') title = next.trim()
        }
        const record = recordOf(id, event)
        if (record === undefined) continue
        records.push(withRouteOf(record, directory))
        sessionDays.add(dateKey(record.t, this.timezone()))
      }

      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      sessions.push({
        id,
        createdAt: Number(header.createdAt ?? 0),
        cwd,
        workspace: workspaceLabel(cwd),
        // 预览标题与 DSH 侧栏同源（见 displayTitleOf）：会话清单靠它把
        // 一行十六进制 id 换成用户认得出的那一句话。
        title: displayTitleOf(title, cwd, id),
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
      // 旧账本里没有提供商字段。这两个计数只报**本次**扫描发生的迁移与补全，
      // 报完即清零：否则「账本被迁移过」会一直挂在界面上，看起来像每次都出问题。
      ...(this.ledger?.upgraded > 0 ? { upgraded: this.ledger.upgraded } : {}),
      ...(added.enriched > 0 ? { enriched: added.enriched } : {}),
      ...(this.ledger?.dropped > 0 ? { dropped: this.ledger.dropped } : {}),
      ...(this.ledger?.lastError === undefined ? {} : { error: this.ledger.lastError }),
    }
    if (this.ledger !== undefined) {
      this.ledger.upgraded = 0
      this.ledger.dropped = 0
    }
    const merged = this.ledger === undefined ? records : this.ledger.records
    return { records: merged, sessions, ledger, directory }
  }

  /**
   * 扫描并聚合看板数据。
   * @param {number} now - 当前时刻。
   * @returns {Promise<object>} 看板数据。
   */
  async build(now) {
    const timezone = this.timezone()
    const { records, sessions, ledger, directory } = await this.collect(now)

    /** @type {Map<string, object>} */
    const days = new Map()
    /** @type {Record<string, object>} */
    const modelTotals = {}
    /** @type {Map<string, {rollup:string,provider:string,natives:Set<string>,usage:object}>} */
    const modelMeta = new Map()
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
      // 每格的消费估计。与 requests 同一套 day 索引，悬停时直接用同一个 `cell`。
      costs: new Array(HEATMAP_DAYS).fill(0),
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
      // 条目身份 = **模型 × 提供商**。模型部分用归一后的价目表键（旧名 / 带发售日的
      // 变体名都折到同一行），而不是路由上的原生 id —— 否则同一个 DeepSeek 模型
      // 会因为 `deepseek-v4.1-flash` / `deepseek/deepseek-v4.1-flash` 这种写法差异
      // 各占一行，看起来像好几个模型。
      const rollup = String(record.r ?? '') === '' ? rollupOf(record.n ?? record.m) : String(record.r)
      // 提供商优先用 DSH 实时目录反查出来的**路由名**：账本里旧的迁移值可能是网关
      // 自己的叫法（Command Code 的 id 前缀是 `deepseek/`，路由名却是 `commandcode`）。
      const provider = directory.nativeProvider.get(String(record.n ?? ''))
        ?? String(record.p ?? '')
      const model = provider === '' ? rollup : `${rollup}@${provider}`

      // 关键：按该请求**发生时刻**判定时段。跨设备记录同样带原始时间戳，
      // 因此别的机器在高峰时段跑的量不会被按本机当前时段错算。
      const peak = isPeak(Number(record.t), timezone)

      const meta = modelMeta.get(model) ?? { rollup, provider, natives: new Set() }
      if (typeof record.n === 'string' && record.n !== '') meta.natives.add(record.n)
      modelMeta.set(model, meta)

      addUsage((modelTotals[model] ??= emptyUsage()), usage, peak)

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
        // 账本里只有用量，没有标题也没有工作目录：按同一条回落链给会话 id，
        // 界面上会把它连同「(其它设备)」一起显示，不会被误认成本机会话。
        title: displayTitleOf('', '', sessionId),
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
        // 当天的消费估计（按每条请求**发生时刻**的时段分档算）。
        // 与 `costByModel` 同一口径，因此日行相加与总费用一致。
        cost: sessionCost(day.byModel),
      }))
      .sort((a, b) => a.key.localeCompare(b.key))

    /**
     * 日历每格的消费估计，**从 `dayRows` 派生**，而不是在记录循环里另算一遍。
     *
     * 两处各算一次看着「同源」，实际会漂移：记录循环里逐条累加得到 2.1017944，
     * 而 `sessionCost()` 会把日行金额**四舍五入到 6 位**（2.101794）。于是悬停某一格
     * 显示的金额与该日行、与按日明细都对不上——差的是尾数，但它恰好落在用户会
     * 逐位比对的同一个数字上（实测 6 天里 5 天不一致）。
     *
     * 因此这里只做**一次映射**：日行的 key 反算出格号，金额直接用 `cost.standard`。
     * 构造上不可能再漂移。
     */
    for (const row of dayRows) {
      const cell = Math.round(
        (Date.parse(`${row.key}T00:00:00Z`) - firstDayUtc) / 86_400_000,
      )
      if (cell >= 0 && cell < HEATMAP_DAYS) calendar.costs[cell] = Number(row.cost?.standard ?? 0)
    }

    const today = dateKey(now, timezone)
    const todayTotals = dayRows.find((row) => row.key === today)?.totals ?? roundUsage(emptyUsage())
    const models = Object.entries(modelTotals)
      .map(([model, usage]) => {
        const meta = modelMeta.get(model) ?? { rollup: rateKeyOfModelKey(model), provider: '', natives: new Set() }
        const pricing = pricingOf(meta.rollup)
        const rates = pricing.rates
        // 外显名优先用 DSH 设置里那一条（同一个归一模型在某提供商下可能对应多条
        // 原生 id，取哪一条由 buildModelDirectory 的 canonical 规则决定）。
        //
        // 设置里把名字留空时 DSH 会让名字等于模型 id（`deepseek-flash`），
        // 那不是一个「外显名」，直接显示会得到一行没有可读名字的条目；
        // 退回价目表里的官方名，再不行才用归一键。
        const catalogName = meta.provider === ''
          ? undefined
          : directory.byRollup.get(`${meta.provider}\u0000${meta.rollup}`)?.name
        const label = catalogName === undefined || catalogName === meta.rollup
          ? (rates.label ?? meta.rollup)
          : catalogName
        return {
          // key 就是条目身份：`模型@提供商`。客户端一律用它去 byModel 里定位用量。
          key: model,
          model,
          rollup: meta.rollup,
          provider: meta.provider,
          providerLabel: meta.provider === ''
            ? ''
            : (directory.providerNames.get(meta.provider) ?? meta.provider),
          // 外显名以 **DSH 设置里的名字**为准（用户改了就跟着改），
          // 设置里读不到（或名字只是模型 id）时才退回价目表里的官方名。
          label,
          // 这一条底下合并了哪些路由 id（`hy4-preview-f` 与 `deepseek-v4.1-flash`
          // 都折进了同一个 Flash）。账本里保留的原生名就是它们，界面上悬停可查——
          // 少了它，「为什么这两个名字合成一行」在界面上无从验证。
          routes: [...meta.natives].sort(),
          // 只在该路由**自己就是价目表那一行**时给具体版本号。价目表是官方
          // DeepSeek 的版本（`DeepSeek-V4.1-Flash`），套到别的提供商那条路由上
          // 就是替第三方承诺了一个它没给的版本号。
          version: meta.provider === '' || meta.provider === 'deepseek-official' ? (rates.version ?? '') : '',
          // 单价是否真的知道：兜底价会被界面标成「按 Flash 估算」，不假装精确
          priced: pricing.known,
          tiered: pricing.tiered,
          vendor: pricing.vendor,
          // 逐模型单价：客户端**不能**再去宿主的价目表里按原生 id 查一次——
          // 那里没有 `deepseek/deepseek-v4.1-flash` 这类路由 id，查不到就会静默
          // 回落到 Flash 价（踩过：GLM 那一行的「不分时」判定因此算错，表格列数错位）。
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
        // 逐模型单价，按**归一键**索引：客户端拿到的是宿主已经查好的那一份，
        // 不必也不能自己按路由 id 再查一次（查不到会静默回落 Flash 价）。
        models: ratesOfModels(models),
        source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      },
      overview: {
        totals: sumDays(dayRows),
        sessions: sessions.length,
        activeDays: dayRows.length,
        firstDay: dayRows[0]?.key ?? null,
        lastDay: dayRows.at(-1)?.key ?? null,
        // 站点时区下的「今天」。客户端必须用它去 days 里定位当天，
        // **不能**拿 `days.at(-1)` 当今天：那是「最后一个有数据的日子」，
        // 今天还没跑过请求时它就是昨天，卡片上的「今日费用」会显示昨天的数字。
        today,
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
        // 每格的消费估计，与 requests / tokens **同一套 day 索引**（同一天序号，
        // 不是 `days` 那种稀疏数组）。悬停某格时直接按同一个 `day` 取，
        // 不必再拿日期去反查——两套索引混用正是错位的来源。
        costs: calendar.costs,
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

/**
 * 给一条账本记录补上「提供商」——只有在能**确定**时才补。
 *
 * 只有一种情况算确定：该原生模型 id 在实时模型目录里只由**一家**提供商提供，
 * 或它本身就是 `提供商/模型` 形态（斜杠左边就是提供商的自称）。
 * 其余一律留空串：把认不出的记录随便归给某一家，会让「按提供商区分」这件事
 * 从一个事实退化成一次猜测——而用户看这张表的目的正是分辨来源。
 * @param {object} record - `recordOf()` 产出的记录。
 * @param {object} directory - `buildModelDirectory()` 的结果。
 * @returns {object} 可能补上 `p` 的记录。
 */
function withRouteOf(record, directory) {
  if (typeof record.p === 'string' && record.p !== '') return record
  const native = typeof record.n === 'string' ? record.n : ''
  const inferred = directory.nativeProvider.get(native)
    ?? (directory.candidates.get(native)?.size === 1 ? [...directory.candidates.get(native)][0] : undefined)
  return inferred === undefined || inferred === '' ? record : { ...record, p: inferred }
}

/**
 * 把逐模型单价按**归一键**摊平成一张表，供客户端按同一口径计价。
 *
 * 客户端拿到的原生 id 可能是 `deepseek/deepseek-v4.1-flash`（路由 id），
 * 而价目表里只有 `deepseek-flash`。让客户端自己查就会静默回落到 Flash 价——
 * 那正是「GLM 那一行被当成不分时、表格列数错位」的根因。宿主这里已经知道
 * 每一行的模型是什么，直接把它用的那份价目交出去。
 * @param {object[]} models - `build()` 里已算好的模型条目。
 * @returns {Record<string, object>} 归一键 → 价目表条目。
 */
function ratesOfModels(models) {
  const out = {}
  for (const model of models) {
    if (out[model.rollup] === undefined) out[model.rollup] = model.rates
  }
  return out
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

/**
 * 工作目录 → 末段目录名（取不到时是空串，不编占位）。
 *
 * 与 DSH 客户端的 `workspaceTitleOf` 同一口径：两种分隔符都认，
 * 末尾的分隔符忽略。
 * @param {unknown} cwd - 绝对工作目录。
 * @returns {string} 目录末段；空/无末段时是空串。
 */
function workspaceBase(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

/** 工作目录 → 展示用名（取不到时给一个可读占位）。 */
function workspaceLabel(cwd) {
  if (cwd === '') return '(未知目录)'
  return workspaceBase(cwd) || cwd
}

/**
 * 会话预览标题：持久标题 → 工作目录末段 → 会话 id。
 *
 * **刻意与 DSH 侧栏任务栏同源。** 客户端 `session-controller` 的
 * `displayTitleOf()` 就是这三档回落，侧栏那一行显示的正是它；这里照抄同一条
 * 规则，看板里的会话清单才会与用户眼睛看到的侧栏标题是**同一个字符串**。
 * 早先会话清单只显示 `session.id.slice(8, 16)`——一串十六进制，用户没法把它
 * 和侧栏里任何一个会话对上号。
 * @param {string} title - `session/title` 事件折叠出的最新标题。
 * @param {string} cwd - 会话创建时的工作目录。
 * @param {string} id - 会话 id。
 * @returns {string} 可读的预览标题。
 */
function displayTitleOf(title, cwd, id) {
  if (typeof title === 'string' && title !== '') return title
  const base = workspaceBase(cwd)
  return base !== '' ? base : id
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
 * 轻量的同源闸门：写配置的路由不接受跨站表单触发。
 *
 * `sec-fetch-site` 缺失（老浏览器 / 命令行）时**不拦**——用它当唯一凭据会把
 * 正常用法一起挡掉；它只是让现代浏览器里的跨站 POST 多一道拦截。
 * @param {object} req - IncomingMessage。
 * @returns {boolean} 是否应当拒绝。
 */
function crossSite(req) {
  const site = req.headers?.['sec-fetch-site']
  return typeof site === 'string' && site !== 'same-origin' && site !== 'none'
}

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
      // LLM 注册表用于两件事：提供商的显示名，以及模型在 **DSH 设置里** 的名字。
      // 它可能晚于本插件发布（客户端插件之间没有顺序保证），因此惰性读取，
      // 读不到就退回价目表里的名字——只影响标签，不影响任何数字。
      llm: () => ctx.get('llm'),
    })

    // 开关存储两个功能**共用**：各写各的文件会互相覆盖（读—改—写竞态）。
    const prefs = new Preferences(resolvePrefsPath(), { balanceEnabled: true, plansEnabled: true, ...NOTIFY_DEFAULTS })

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

    /**
     * 会话结束事实的通知日志（见 lib/notify.js）。
     *
     * 只活在内存里、有明确上限，且**不受开关控制地照记**：一条记录只是一个
     * 小对象，而「刚把通知打开却什么也收不到」比多占几百字节糟得多。
     * 开关与阈值都在同一次读取里交给浏览器，由它决定要不要弹。
     */
    const journal = new NotifyJournal()

    /** 读出归一化后的通知配置。补丁在写入前已归一，这里再归一一次兜住手改的文件。 */
    const notifyConfig = async () => normalizeNotify(await prefs.read())

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
      path: `${ROUTE_PREFIX}/period`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 只跑一次纯函数：不碰账本、不碰会话日志，因此这条路由永远廉价、永远可用。
        // 侧栏那枚时段指示灯要每秒重画，挂到 `/data`（全量扫描 + 20s TTL）上的话，
        // 页面打开要等一次全量扫描才看得到它，账本读不出来时连纯时钟信息也一起没了。
        const now = Date.now()
        sendJson(res, 200, {
          generatedAt: now,
          timezone: DEFAULT_TIMEZONE,
          version: IMPL_VERSION,
          period: periodState(now, DEFAULT_TIMEZONE),
          peakRule: { windows: PEAK_WINDOWS, weekdays: PEAK_WEEKDAYS },
        }, req.method === 'HEAD')
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

    /**
     * 通知日志 + 预警阈值配置。
     *
     * `GET  /dsh-pixel/notify?since=<cursor>` 读增量（游标缺失 = 从现在开始订阅）；
     * `POST /dsh-pixel/notify` 写阈值与开关。
     *
     * 读写共用一条路由是刻意的：两者永远一起被需要（面板一进来就要同时显示
     * 「当前阈值」和「最近发生了什么」），拆成两条只会让客户端多写一次取数的
     * 错误处理。写走 POST，与只读的余额 / 套餐路由口径一致。
     */
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/notify`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const config = await notifyConfig()
          sendJson(
            res,
            200,
            { config, ...journal.read({ since: url.searchParams.get('since') }) },
            req.method === 'HEAD',
          )
          return
        }
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (crossSite(req)) {
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
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body 需要是一个对象' })
          return
        }
        // 先与现值合并再归一：面板允许只提交改动的那一项，其余保持不动。
        const merged = { ...(await notifyConfig()), ...body }
        const { persisted } = await prefs.patch(normalizeNotify(merged))
        sendJson(res, 200, { config: await notifyConfig(), persisted })
      },
    })


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
        // 拒绝时要把请求体抽干：不读干净会让这条 keep-alive 连接上的后续请求错位。
        if (crossSite(req)) {
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

    // 会话结束时记一条通知事实。判定与文案都在 lib/notify.js 里，这里只做转接。
    //
    // 为什么必须在这里做：客户端的事件窗口只装载**当前选中**的会话，后台会话的
    // `turn/end` 在浏览器里是看不到的——而那恰恰是最需要被提醒的时候。
    //
    // 整个处理体包在 try/catch 里：`session/event` 是一条**热路径**，持久化、
    // 投影、遥测都挂在上面。监听器抛错会中断同一次 emit 的后续订阅者（最坏的
    // 后果是会话日志没落盘），而这条通知最多只是少一条提醒。附加功能的失败
    // 绝不能升级成主链路的失败——与余额 / 套餐的 fail-soft 是同一条口径。
    ctx.on('session/event', (session, event) => {
      try {
        const notice = noticeOf(session, event, workspaceLabel(session?.header?.cwd ?? ''))
        if (notice === undefined) return
        journal.record(notice)
        // 日志变了就顺手让看板快照失效：面板里的「最近通知」不必等满一个 TTL。
        catalog.invalidate()
      } catch (error) {
        ctx.logger?.warn?.(
          error instanceof Error ? error : new Error(`通知记录失败：${String(error)}`),
        )
      }
    })
  },
}
