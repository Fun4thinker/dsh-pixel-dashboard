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

/**
 * llm-deepseek 的 settings 命名空间：读它才能拿到「dsh 实际在用的」key 引用与地址。
 *
 * 0.1.7 起它同时是**当前 profile 里的条目 id**（见 {@link readSettingsSection}）。
 */
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
 * 读一个 settings section 的解析值。**两代 API 都认，且读不到要说出来。**
 *
 * DSH 在 0.1.7 把 settings 服务从「按命名空间注册 + `get(ns)` 取值」改成了
 * 「投影当前 profile 条目的 Config 派生表单」：`settings-file` 整包删除，
 * `get(ns)` / `register()` / `installSection()` **全部消失**，只剩
 * `describe()` 返回描述符数组，值在每一项的 `value` 上。
 *
 * 旧代码写的是 `settings?.()?.get?.(ns)`：方法不存在时可选链把「API 没了」
 * 静默吞成 undefined，于是**用户配的自定义 baseURL / 凭据名被无声忽略**，
 * 余额改从官方端点查——数字看起来完全正常，只是答的不是用户问的那个问题。
 * 这类「静默换了个数据源」比报错难查得多，因此这里：
 *
 *   1) **先新后旧**——`describe()` 是当前契约，`get()` 只作为旧宿主回落；
 *   2) 读完回报**实际走的是哪一代**（`via`），供界面把降级显式说出来；
 *   3) 两代都不认时回报 `unreadable` + 原因，**而不是伪造成「没有配置」**。
 *
 * `absent` 与 `unreadable` 刻意分开：前者是「本组合没挂 settings 服务」，
 * 那时用户本来也无处配置，用官方默认端点是**正确**的，不该报警；后者是
 * 「服务在、但我们对不上话」，此时用默认端点是**猜测**，必须让用户看见。
 * @param {object|undefined} settings - ctx.settings（可能不存在）。
 * @param {string} ns - 命名空间 / profile 条目 id。
 * @returns {{value:object|undefined,via:'entry'|'legacy'|'absent'|'unreadable',error?:string}} 读取结果。
 */
export function readSettingsSection(settings, ns) {
  if (settings === null || settings === undefined) return { value: undefined, via: 'absent' }
  // 新版（0.1.7+）：describe() 返回描述符数组，值在 value 上；不传 redactSecrets
  // 才能读到真实配置（本进程是宿主，不是远端表单客户端）。
  if (typeof settings.describe === 'function') {
    try {
      const rows = settings.describe()
      if (Array.isArray(rows)) {
        const row = rows.find((item) => item !== null && typeof item === 'object' && item.ns === ns)
        const value = row?.value
        // 找不到这一条 = 该 profile 没有这个条目，属于「确实没有配置」，
        // 与「API 对不上」是两件事，因此仍旧回报 entry。
        return { value: value !== null && typeof value === 'object' ? value : undefined, via: 'entry' }
      }
    } catch (error) {
      // describe 抛错不直接判定失败：可能是旧服务恰好也有同名方法，落到 get 再试一次。
      // 真正两代都不行时才由下面的分支回报 unreadable，并把这里的原因带上。
      return readLegacySection(settings, ns, error)
    }
  }
  return readLegacySection(settings, ns, undefined)
}

/**
 * 旧版（<= 0.1.6）的 `get(ns)` 路径；新版不可用时才走到这里。
 * @param {object} settings - settings 服务。
 * @param {string} ns - 命名空间。
 * @param {unknown} entryError - `describe()` 已经失败的原因（若有）。
 * @returns {{value:object|undefined,via:'legacy'|'unreadable',error?:string}} 读取结果。
 */
function readLegacySection(settings, ns, entryError) {
  if (typeof settings.get === 'function') {
    try {
      const value = settings.get(ns)
      return { value: value !== null && typeof value === 'object' ? value : undefined, via: 'legacy' }
    } catch (error) {
      return { value: undefined, via: 'unreadable', error: messageOf(error) }
    }
  }
  // 两个方法都没有：认不出这代 settings API。**绝不悄悄当没配置**。
  return {
    value: undefined,
    via: 'unreadable',
    error: entryError === undefined
      ? 'settings 服务既没有 describe() 也没有 get()'
      : `describe() 失败：${messageOf(entryError)}`,
  }
}

/** 把任意抛出物压成一句可读的原因。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
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
   *
   * 读 settings 走 {@link readSettingsSection}（两代 API 兼容）。**读不到时
   * 仍然用官方默认端点**——余额整块不该因为 settings 对不上话就消失——但会把
   * 「这是猜的」如实带出去（`settingsVia` / `settingsError`），由界面明说。
   * @returns {{apiKeyEnv:string,baseURL:string,settingsVia:string,settingsError:string|undefined}} 端点事实。
   */
  endpoint() {
    let read
    try {
      read = readSettingsSection(this.settings?.(), DEEPSEEK_SETTINGS_NS)
    } catch (error) {
      // 连读取函数本身都抛错（理论上不该发生）时同样不许静默：
      // 记账为 unreadable，让界面把降级说出来。
      read = { value: undefined, via: 'unreadable', error: messageOf(error) }
    }
    const section = read.value
    const configuredRef = typeof section?.apiKeyEnv === 'string' ? section.apiKeyEnv.trim() : ''
    const configuredBase = typeof section?.baseURL === 'string' ? section.baseURL.trim() : ''
    return {
      apiKeyEnv: configuredRef !== '' ? configuredRef : DEFAULT_API_KEY_ENV,
      baseURL: configuredBase !== '' ? configuredBase : OFFICIAL_BASE_URL,
      settingsVia: read.via,
      settingsError: read.error,
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
    const { apiKeyEnv, baseURL, settingsVia, settingsError } = this.endpoint()
    const base = {
      enabled,
      // 这两项是**诊断**，不是数据：界面据它说明「端点是从哪儿推出来的」。
      // 之所以必须交下去，是因为 settings 读不到时我们仍会用官方默认端点，
      // 而「按默认端点查到的余额」与「按用户配置的端点查到的余额」看起来一模一样。
      settingsVia,
      ...(settingsError === undefined ? {} : { settingsError }),
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
