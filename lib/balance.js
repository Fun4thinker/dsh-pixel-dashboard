/**
 * 官方账户余额查询（宿主半边）。
 *
 * 只做一件事：用 DSH 自己给官方 DeepSeek provider 用的那把 API Key，向官方
 * `GET {baseURL}/user/balance` 要一次余额，然后把**金额**交给浏览器半边。
 *
 * 四条硬约束（前三条都是隐私相关的，改动前请先读完）：
 *
 *   1) **Key 只留在宿主进程。** 它从 credentials 服务解析出来，只用于拼一个
 *      `Authorization` 头。绝不写进任何响应体、日志或账本；响应里只回报「来源层」
 *      （`env` / `file`），不回报值本身。浏览器半边从头到尾看不见 Key。
 *   2) **只向官方端点发请求。** 地址按宿主 adapter 的同一套规则推导
 *      （settings.baseURL → `$DEEPSEEK_BASE_URL` → 官方公网地址），不引入任何第三方。
 *   3) **可以被关掉。** 关掉后本模块一次网络请求都不发。`DSH_PIXEL_BALANCE=0`
 *      是更硬的一层开关：用于不希望有任何外发请求的环境（CI、别人的机器）。
 *   4) **失败要可见。** 拿不到余额时回报 `error`，由界面明说，而不是显示 0 或空白。
 *
 * 币种与金额一律照抄接口返回值，不做任何汇率换算——猜币种比不显示更糟。
 * 接口可能返回多个币种（`balance_infos` 是数组），因此这里保持数组形状。
 * @module dsh-pixel-dashboard/lib/balance
 */

import { Preferences, resolvePrefsPath } from './prefs.js'

/** 官方公网地址：与 llm-deepseek 的 PUBLIC_BASE_URL 一致。 */
export const OFFICIAL_BASE_URL = 'https://api.deepseek.com'

/** 官方 provider 默认使用的凭据引用名。 */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 官方 provider 路由名，用于在文案与诊断里指明数据来源。 */
export const OFFICIAL_PROVIDER = 'deepseek-official'

/** llm-deepseek 的 settings 命名空间：读它才能拿到「dsh 实际在用的」key 引用与地址。 */
export const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** 余额缓存有效期：官方余额变动不频繁，一分钟足够新。 */
export const BALANCE_TTL_MS = 60_000

/** 单次上游请求超时：余额不是关键路径，宁可快速失败也不拖住界面。 */
export const REQUEST_TIMEOUT_MS = 10_000

/** 余额查询响应里允许出现的最大字节数，防止异常响应撑爆内存。 */
const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * 解析余额开关的持久化路径。
 *
 * 与用量账本同一目录（`$DSH_HOME/plugins/dsh-pixel-dashboard/`），因此「换电脑」
 * 时它和账本一样是可选带走的本机状态。`DSH_PIXEL_BALANCE_PREFS` 可以覆盖。
 *
 * 注意：这个文件现在由 {@link Preferences} 统一管理，并与第三方套餐监控的开关
 * **共用同一个文件**（键不同）。不要再往这里加「读—改—写」逻辑，否则两个功能
 * 会互相覆盖。
 * @param {object} [env] - 环境变量来源。
 * @returns {string|undefined} 绝对路径；推不出时返回 undefined（开关退化为只读默认值）。
 */
export function resolveBalancePrefsPath(env = process.env) {
  return resolvePrefsPath(env)
}

/**
 * 把接口返回的金额字符串解析成数字。
 *
 * 接口给的是**字符串**（`"-0.79"`），直接 `Number()` 对正常值是对的。但有两个
 * 陷阱必须显式挡掉，否则「缺失」会被当成「0」——而界面上 0 就是「余额空了」：
 *   - `Number(null)` === 0
 *   - `Number('')` === 0
 * 字段缺失（`undefined`）本来就会得到 NaN，但 JSON 里的 `null` 与空串不会。
 * @param {unknown} value - 接口字段值。
 * @returns {number|undefined} 金额；缺失或读不懂时为 undefined。
 */
export function parseAmount(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : undefined
}

/**
 * 归一化官方 `/user/balance` 的响应体。
 *
 * 只挑出真正要显示的字段，并把金额转成数字；任何结构对不上的地方都退化为
 * 「缺这一项」，而不是抛错——接口加字段不该让整块界面失败。
 * @param {object} body - 接口 JSON。
 * @returns {{available:boolean|null,balances:object[]}} 归一化结果。
 */
export function normalizeBalance(body) {
  const available = typeof body?.is_available === 'boolean' ? body.is_available : null
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const balances = infos
    .filter((info) => info !== null && typeof info === 'object')
    .map((info) => ({
      currency: typeof info.currency === 'string' ? info.currency : 'UNKNOWN',
      total: parseAmount(info.total_balance),
      granted: parseAmount(info.granted_balance),
      toppedUp: parseAmount(info.topped_up_balance),
    }))
  return { available, balances }
}

/**
 * 官方账户余额查询器：解析凭据 → 请求 → 缓存。
 *
 * 依赖全部以取值函数注入（credentials / settings 都可能不存在），因此缺少任一
 * 可选服务时退化为「余额不可用」而不是让整块插件失效。
 */
export class BalanceService {
  /**
   * @param {object} deps - 依赖。
   * @param {() => object|undefined} deps.credentials - ctx.credentials（凭据接缝）。
   * @param {() => object|undefined} deps.settings - ctx.settings（读 llm-deepseek 段）。
   * @param {string} [deps.prefsPath] - 开关持久化路径；显式传入便于测试。
   * @param {Preferences} [deps.prefs] - 开关存储；由宿主传入以便与套餐开关共用一个文件。
   * @param {Function} [deps.fetchImpl] - fetch 实现；测试注入用。
   * @param {number} [deps.ttlMs] - 缓存有效期。
   * @param {number} [deps.timeoutMs] - 单次请求超时。
   * @param {object} [deps.env] - 环境变量来源；测试注入用。
   */
  constructor({
    credentials,
    settings,
    prefsPath,
    prefs,
    fetchImpl,
    ttlMs = BALANCE_TTL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    env = process.env,
  }) {
    this.credentials = credentials
    this.settings = settings
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    this.env = env
    this.cache = undefined
    this.cacheAt = 0
    // 开关存储：优先用宿主注入的共享实例；否则按路径自建（测试与单文件使用）。
    this.prefs = prefs ?? new Preferences(prefsPath ?? resolvePrefsPath(env), { balanceEnabled: true })
    /** @type {Promise<object>|undefined} 并发的取数合并。 */
    this.inflight = undefined
  }

  /**
   * 缓存失效。开关变化或手动刷新时调用，保证下一次读是一次真实请求。
   * @returns {void}
   */
  invalidate() {
    this.cache = undefined
    this.cacheAt = 0
  }

  /**
   * `DSH_PIXEL_BALANCE=0/false/off` 时硬性关闭：一次请求都不发，且界面开关只读。
   * @returns {boolean} 是否被环境变量锁死为关闭。
   */
  get lockedByEnv() {
    const raw = this.env?.DSH_PIXEL_BALANCE
    if (typeof raw !== 'string') return false
    const value = raw.trim().toLowerCase()
    return value === '0' || value === 'false' || value === 'off' || value === 'no'
  }

  /**
   * 读取开关状态（带内存缓存）。
   * @returns {Promise<boolean>} 是否启用余额查询；默认启用。
   */
  async enabled() {
    if (this.lockedByEnv) return false
    const data = await this.prefs.read()
    return data.balanceEnabled !== false
  }

  /**
   * 写入开关并持久化。
   *
   * 落盘失败（只读盘、路径推不出）时**不抛错**：内存里的选择已经生效，
   * 抛错只会让一次点击看起来失败。下次启动会退回默认值，这一点在文档里写明。
   * @param {boolean} value - 目标状态。
   * @returns {Promise<{enabled:boolean,persisted:boolean}>} 结果。
   */
  async setEnabled(value) {
    const enabled = value === true
    if (this.lockedByEnv) return { enabled: false, persisted: false }
    // 关掉时立刻清缓存：重新打开必须是一次真实请求，而不是端上一份旧快照。
    this.cache = undefined
    this.cacheAt = 0
    const { persisted } = await this.prefs.patch({ balanceEnabled: enabled })
    return { enabled, persisted }
  }

  /**
   * 推导「dsh 实际在用」的凭据引用与端点地址。
   *
   * 凭据引用与 llm-deepseek 的规则一致：settings 段优先，其次官方默认名。
   * 端点地址刻意**只认两处**：settings 段里显式配置的 `baseURL`，或官方公网地址。
   *
   * 为什么**不**读 `process.env.DEEPSEEK_BASE_URL`（虽然 adapter 会读它）：
   * 端点地址决定「把 API Key 发到哪」，而进程环境不是可信来源——任何能在本机设
   * 一个环境变量的东西都能借此把 Key 引到自己的服务器上。DSH 自己也只从可信的
   * launch-environment 层读这个变量，正是这个道理。本插件不引入
   * `@deepseek-ai/dsh-launch-environment` 依赖（保持「只用 Node 内建模块」），
   * 因此这里直接放弃这一层：要么 settings 里显式配了（那是运维的明确决定），
   * 要么就查官方地址。宁可少支持一种内部代理端点，也不开一条 Key 外泄路径。
   * @returns {{apiKeyEnv:string,baseURL:string}} 端点事实。
   */
  endpoint() {
    let section
    try {
      section = this.settings?.()?.get?.(DEEPSEEK_SETTINGS_NS)
    } catch {
      // settings 段读失败不该让余额这条路整段失效：退回官方默认端点。
      section = undefined
    }
    const configuredRef = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv.trim() : ''
    const configuredBase = typeof section?.baseURL === 'string' ? section.baseURL.trim() : ''
    return {
      apiKeyEnv: configuredRef !== '' ? configuredRef : DEFAULT_API_KEY_ENV,
      baseURL: configuredBase !== '' ? configuredBase : OFFICIAL_BASE_URL,
    }
  }

  /**
   * 解析出用于查询的 Key。**返回值绝不出宿主进程。**
   *
   * 与 adapter 相同的优先级：有 credentials 接缝就走它（它自己会按
   * user-env / project-env / file / env 分层，其中就包含继承来的进程环境），
   * 没有接缝才退回 `process.env`。
   *
   * 这个兜底刻意只读进程环境、不读 `.env` 文件层：它只在「本组合没有挂 credentials
   * 接缝」这种罕见情况下生效，少读一层只会让余额显示不出来，不会误用别人的凭据。
   * 真正的风险点是**端点地址**（Key 发到哪），那个已在上面的 {@link endpoint} 里
   * 收紧到 settings 与官方地址两处。
   * @param {string} ref - 凭据引用名。
   * @returns {Promise<{value:string,source:string}|undefined>} Key 与来源层。
   */
  async #resolveKey(ref) {
    const credentials = this.credentials?.()
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') {
          return { value: hit.value.trim(), source: typeof hit.source === 'string' ? hit.source : 'credentials' }
        }
      } catch {
        // resolve 抛错（引用名非法、存储读失败）时继续走环境变量兜底
      }
    }
    const ambient = this.env?.[ref]
    if (typeof ambient === 'string' && ambient.trim() !== '') {
      return { value: ambient.trim(), source: 'env' }
    }
    return undefined
  }

  /**
   * 查询余额（带 TTL 缓存与并发合并）。
   *
   * 未启用时**不发任何请求**，直接回报 `{enabled:false}`。
   * @param {{refresh?:boolean}} [options] - refresh 为真时跳过缓存。
   * @returns {Promise<object>} 余额负载（永不含 Key）。
   */
  async read(options = {}) {
    const enabled = await this.enabled()
    const { apiKeyEnv, baseURL } = this.endpoint()
    const base = {
      enabled,
      provider: OFFICIAL_PROVIDER,
      apiKeyEnv,
      baseURL,
      official: baseURL.replace(/\/+$/u, '') === OFFICIAL_BASE_URL,
      lockedByEnv: this.lockedByEnv,
    }
    if (!enabled) return { ...base, balances: [], available: null, fetchedAt: null }

    const now = Date.now()
    if (options.refresh !== true && this.cache !== undefined && now - this.cacheAt < this.ttlMs) {
      return { ...this.cache, cached: true }
    }
    if (this.inflight !== undefined) return this.inflight

    this.inflight = this.#fetchBalance(base)
      .then((payload) => {
        // 只缓存成功结果：失败也要能立刻重试，而不是被 TTL 按住一分钟。
        if (payload.error === undefined) {
          this.cache = payload
          this.cacheAt = Date.now()
        }
        return payload
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * 真发一次请求。
   * @param {object} base - 端点事实（不含 Key）。
   * @returns {Promise<object>} 余额负载。
   */
  async #fetchBalance(base) {
    const key = await this.#resolveKey(base.apiKeyEnv)
    if (key === undefined) {
      return { ...base, balances: [], available: null, fetchedAt: null, reason: 'no-key' }
    }
    if (typeof this.fetchImpl !== 'function') {
      return { ...base, balances: [], available: null, fetchedAt: null, reason: 'no-fetch' }
    }
    const url = `${base.baseURL.replace(/\/+$/u, '')}/user/balance`
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${key.value}` },
        signal: controller.signal,
      })
      if (!response.ok) {
        // 只回报状态码。响应体可能很长且与凭据无关，带回来没有价值。
        return { ...base, balances: [], available: null, fetchedAt: Date.now(), keySource: key.source, error: `HTTP ${response.status}` }
      }
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) {
        return { ...base, balances: [], available: null, fetchedAt: Date.now(), keySource: key.source, error: '响应过大' }
      }
      const normalized = normalizeBalance(JSON.parse(text))
      return {
        ...base,
        available: normalized.available,
        balances: normalized.balances,
        fetchedAt: Date.now(),
        keySource: key.source,
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ...base,
        balances: [],
        available: null,
        fetchedAt: Date.now(),
        keySource: key.source,
        error: aborted ? '请求超时' : '网络请求失败',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
