/**
 * 第三方订阅套餐（Coding Plan）额度查询。
 *
 * 目前支持两家：
 *
 *   1) **智谱 GLM Coding Plan** — 5 小时积分 + 每周积分（官方**没有**月度额度）。
 *   2) **Command Code** — 5 小时 / 每周 / 每月三个滚动窗口。
 *
 * ## 关于这些接口的诚实说明（改动前务必读完）
 *
 * **两家都没有公开文档化的额度 API。** 这里用的是它们**前端自己在用**的内部接口：
 *
 *   - 智谱：`GET open.bigmodel.cn/api/monitor/usage/quota/limit`，
 *     鉴权是 **裸 API Key（不带 `Bearer ` 前缀）**；
 *     失败时 **HTTP 仍是 200**，必须看响应体里的 `success` 字段。
 *   - Command Code：`GET api.commandcode.ai/alpha/billing/credits`，
 *     鉴权是 `Authorization: Bearer <key>`；失败走真实的 401。
 *
 * 因此这些接口**可能随时变更**，本模块全程 fail-soft：任何一家取不到都只把
 * 那一家标成错误，绝不影响另一家、也绝不影响看板其余部分。
 *
 * ## 凭据（隐私相关，别放宽）
 *
 * 按用户选择，凭据来源是「显式配置优先，其次自动发现本机 CLI 凭据」：
 *
 *   | 厂商 | 显式配置（复用 DSH credentials） | 自动发现 |
 *   |---|---|---|
 *   | 智谱 | `ZHIPU_CODING_API_KEY` | —（智谱没有官方 CLI 凭据文件） |
 *   | Command Code | `COMMAND_CODE_API_KEY` | `~/.commandcode/auth.json` 的 `apiKey` |
 *
 * 两条硬约束：
 *   - **Key 只在宿主进程内使用**，绝不写进响应、日志或落盘。响应里只回报来源
 *     （`credentials` / `env` / `cli-file`）与一个**打码后的尾部片段**，便于用户
 *     确认「用的是哪一把」，而不足以还原出密钥。
 *   - **端点固定为官方域名，不接受任何形式的改写**（无环境变量、无配置项）。
 *     与余额那一套同样的理由：端点决定 Key 发给谁。
 *
 * 智谱的 Coding Plan Key 与平台普通 API Key **不通用**，必须是「个人编程套餐」
 * 里单独新建的那把；用错会在两个阶段暴露——标准 API 能过、quota 接口报
 * `Authentication Failed`。
 * @module dsh-pixel-dashboard/lib/plans
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 智谱 quota 接口：固定官方域名。 */
export const ZHIPU_QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'

/** 智谱 quota 接口路径，供界面上标出来源。 */
export const ZHIPU_QUOTA_PATH = '/api/monitor/usage/quota/limit'

/** Command Code 额度接口：固定官方域名。 */
export const COMMAND_CODE_CREDITS_URL = 'https://api.commandcode.ai/alpha/billing/credits'

/** Command Code 额度接口路径。 */
export const COMMAND_CODE_CREDITS_PATH = '/alpha/billing/credits'

/** Command Code 订阅周期接口，用于补出月度刷新时间。 */
export const COMMAND_CODE_SUBSCRIPTION_URL = 'https://api.commandcode.ai/alpha/billing/subscriptions'

/**
 * 复刻 DSH 从 provider 路由名派生凭据引用的规则。
 *
 * **这是与「用自定义提供商添加 Command Code」配套的关键。** 在 设置 → 模型 里
 * 手填一个 provider 路由（如 `commandcode`）并填入 API Key 时，DSH 不会问你
 * 环境变量叫什么，而是按下面这条规则自己派生引用名并把 Key 存到那里
 * （见 ui-settings-models/src/client/store.ts 的 `deriveKeyRef`）：
 *
 *     `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
 *
 * 于是 `commandcode` → `COMMANDCODE_API_KEY`（**没有下划线**），
 * 而 `command-code` / `command_code` → `COMMAND_CODE_API_KEY`。
 *
 * 早先本插件只认 `COMMAND_CODE_API_KEY`：用户按 `commandcode` 这个名字添加时，
 * Key 实际存在 `COMMANDCODE_API_KEY`，插件永远读不到——症状是「明明配了却一直
 * 说没配」。照抄同一条规则并加进候选，就不必依赖用户恰好怎么拼路由名。
 * @param {string} provider - provider 路由名。
 * @returns {string} 派生出的凭据引用名。
 */
export function deriveKeyRef(provider) {
  return `${String(provider ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * 由显式候选名 + 常见路由名，拼出「值得去试」的引用名列表（顺序即优先级）。
 *
 * 显式约定名在前，DSH 派生名在后：文档里写明的引用名优先，
 * 但用户按任意常见路由名添加时也能命中。
 * @param {string[]} explicit - 显式候选引用名。
 * @param {string[]} routes - 常见 provider 路由名。
 * @returns {string[]} 去重后的候选引用名。
 */
export function candidateRefs(explicit, routes) {
  const out = []
  for (const name of [...explicit, ...routes.map(deriveKeyRef)]) {
    if (typeof name === 'string' && name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/** Command Code 常见的自定义 provider 路由名（DSH 据此派生凭据名）。 */
export const COMMAND_CODE_ROUTES = ['command-code', 'commandcode', 'command_code', 'cmd']

/** 智谱常见的自定义 provider 路由名。 */
export const ZHIPU_ROUTES = ['zhipu-coding', 'zai-coding-cn', 'zhipu', 'bigmodel', 'glm']

/** 智谱 Coding Plan 的候选凭据引用名（按优先级）。 */
export const ZHIPU_KEY_ENVS = candidateRefs(
  ['ZHIPU_CODING_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY'],
  ZHIPU_ROUTES,
)

/** Command Code 的候选凭据引用名（按优先级）。 */
export const COMMAND_CODE_KEY_ENVS = candidateRefs(
  ['COMMAND_CODE_API_KEY', 'COMMANDCODE_API_KEY'],
  COMMAND_CODE_ROUTES,
)

/** 兼容旧名：第一候选。 */
export const ZHIPU_KEY_ENV = ZHIPU_KEY_ENVS[0]

/** 兼容旧名：第一候选。 */
export const COMMAND_CODE_KEY_ENV = COMMAND_CODE_KEY_ENVS[0]

/** 单次上游请求超时。 */
export const REQUEST_TIMEOUT_MS = 12_000

/** 额度缓存有效期：额度变化比余额频繁，取 30 秒。 */
export const PLANS_TTL_MS = 30_000

/** 响应体上限，防止异常响应撑爆内存。 */
const MAX_RESPONSE_BYTES = 128 * 1024

/**
 * 窗口种类 → 中文名。
 * `fiveHour` / `weekly` / `monthly` 三家通用，智谱没有 `monthly`。
 */
export const WINDOW_LABELS = {
  fiveHour: '5 小时',
  weekly: '每周',
  monthly: '每月',
}

/**
 * 把密钥打码成「可辨认但不可还原」的片段。
 *
 * 目的只有一个：让用户在界面上确认插件读到的是**哪一把** Key（例如填错成普通
 * 平台 Key 时能一眼看出），而不是展示密钥本身。只保留尾 4 位，且要求原值足够长
 * 才给尾段——太短的串直接全部打码，避免畸形短 Key 被整个回显出来。
 * @param {string} value - 原始密钥。
 * @returns {string} 形如 `…a1b2` 或 `(已打码)`。
 */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (text.length < 12) return '(已打码)'
  return `…${text.slice(-4)}`
}

/**
 * 解析 Command Code 的本机凭据文件路径。
 * 支持 `COMMANDCODE_HOME` 覆盖（该产品自身还没有这个环境变量，这里留个口子便于测试）。
 * @param {object} [env] - 环境变量来源。
 * @returns {string} 绝对路径。
 */
export function commandCodeAuthPath(env = process.env) {
  const home = typeof env?.COMMANDCODE_HOME === 'string' && env.COMMANDCODE_HOME.trim() !== ''
    ? env.COMMANDCODE_HOME.trim()
    : join(env?.USERPROFILE ?? env?.HOME ?? homedir(), '.commandcode')
  return join(home, 'auth.json')
}

/**
 * 从 Command Code 的本机凭据文件里读 API Key。
 *
 * 文件是**另一个 App 的密钥文件**，所以这里只读不写、读失败一律当作「没有」。
 * @param {string} path - auth.json 路径。
 * @returns {string|undefined} Key；读不到时 undefined。
 */
export function readCommandCodeKey(path) {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const key = parsed?.apiKey
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析智谱接口返回的额度条目，切成 5 小时 / 每周窗口。
 *
 * 两个必须照做的细节（都来自社区踩坑记录，别自作聪明改掉）：
 *   1) 窗口分类看显式字段 **`unit`**（3 = 5 小时，6 = 每周），**不要**按
 *      `nextResetTime` 排序来猜——周期末尾周窗口会比 5h 窗口先重置，靠时间排序
 *      必然标反。
 *   2) `percentage` 是**已用百分比**且可能被向下取整，因此优先用绝对值
 *      （`usage` / `currentValue` / `remaining`）自行算百分比；只有百分比时
 *      就照抄，不假装精确。
 * @param {object} payload - 接口响应体。
 * @returns {{level:string,plan:string,windows:object[],unparsed:number}} 归一结果。
 */
export function parseZhipuQuota(payload) {
  const data = payload?.data ?? {}
  const level = typeof data.level === 'string' ? data.level : ''
  const limits = Array.isArray(data.limits) ? data.limits : []
  /** @type {object[]} */
  const windows = []
  let unparsed = 0

  for (const item of limits) {
    if (item === null || typeof item !== 'object') {
      unparsed += 1
      continue
    }
    const type = String(item.type ?? '').toUpperCase()
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') {
      unparsed += 1
      continue
    }
    const unit = Number(item.unit)
    // unit 缺失时不猜窗口：宁可少显示一个窗口，也不把 5h 的数挂到「每周」上。
    const window = unit === 3 ? 'fiveHour' : unit === 6 ? 'weekly' : undefined
    if (window === undefined) {
      unparsed += 1
      continue
    }
    windows.push(buildWindow({
      window,
      // 智谱给的是「已用百分比」；绝对值字段各家版本说法不一，能拿到就用
      usedPercent: numberOrUndefined(item.percentage),
      used: numberOrUndefined(item.currentValue),
      total: numberOrUndefined(item.usage),
      remainingAbsolute: numberOrUndefined(item.remaining),
      resetAt: normalizeEpoch(item.nextResetTime),
      source: 'zhipu',
    }))
  }
  return { level, plan: levelToPlan(level), windows, unparsed }
}

/**
 * 解析 Command Code 的额度响应。
 *
 * 形状（来自其 CLI 自身的调用，非公开文档）：
 *   `credits.windowLimits.fiveHour` / `.weekly` = `{ used, cap, resetAt, exceeded }`
 *   `credits.credits.monthlyCredits` 可能是对象，也可能是**裸数字（剩余额度）**，
 *   后者要把 cap 反推成 `used + remaining`。
 * @param {object} payload - `/alpha/billing/credits` 响应体。
 * @param {object} [subscription] - `/alpha/billing/subscriptions` 响应体（可选）。
 * @returns {{plan:string,windows:object[],unparsed:number}} 归一结果。
 */
export function parseCommandCodeCredits(payload, subscription) {
  // 响应可能被包一层 `{ success, data }`，也可能就是裸对象
  const data = payload?.data ?? payload ?? {}
  const limits = data.windowLimits ?? data.window_limits ?? {}
  /** @type {object[]} */
  const windows = []
  let unparsed = 0

  for (const [key, window] of [['fiveHour', 'fiveHour'], ['weekly', 'weekly']]) {
    const raw = limits[key]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'object' || (!hasNumber(raw.used) && !hasNumber(raw.cap))) {
      unparsed += 1
      continue
    }
    windows.push(buildWindow({
      window,
      used: numberOrUndefined(raw.used),
      total: numberOrUndefined(raw.cap),
      remainingAbsolute: numberOrUndefined(raw.remaining),
      resetAt: normalizeEpoch(raw.resetAt ?? raw.reset_at),
      exceeded: raw.exceeded === true,
      source: 'commandcode',
    }))
  }

  // 月度：可能是对象（带 used/cap/resetAt），也可能是裸数字（剩余额度）
  const monthly = data.credits?.monthlyCredits ?? data.monthlyCredits
  const periodEnd = normalizeEpoch(
    subscription?.data?.currentPeriodEnd
    ?? subscription?.currentPeriodEnd
    ?? data.currentPeriodEnd,
  )
  if (typeof monthly === 'number' && Number.isFinite(monthly)) {
    // 裸数字 = 剩余额度，且这里只给了「剩多少」，没有已用与总额。
    // 把 remaining 原样报出去，让界面显示「剩余 $X」而不是编一个百分比。
    windows.push(buildWindow({
      window: 'monthly',
      remainingAbsolute: monthly,
      resetAt: periodEnd,
      source: 'commandcode',
    }))
  } else if (monthly !== null && typeof monthly === 'object') {
    windows.push(buildWindow({
      window: 'monthly',
      used: numberOrUndefined(monthly.used),
      total: numberOrUndefined(monthly.cap ?? monthly.total),
      remainingAbsolute: numberOrUndefined(monthly.remaining),
      resetAt: normalizeEpoch(monthly.resetAt ?? monthly.reset_at) ?? periodEnd,
      exceeded: monthly.exceeded === true,
      source: 'commandcode',
    }))
  }

  const plan = typeof data.plan === 'string'
    ? data.plan
    : typeof data.subscription?.plan === 'string' ? data.subscription.plan : ''
  return { plan, windows, unparsed }
}

/** 是否有可用的有限数字。 */
function hasNumber(value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value))
}

/** 转成有限数字，否则 undefined（`null` 与空串不能变成 0）。 */
function numberOrUndefined(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 把可能是秒或毫秒的时间戳归一成毫秒。
 * @param {unknown} value - 原始时间戳。
 * @returns {number|undefined} 毫秒时间戳。
 */
function normalizeEpoch(value) {
  const number = numberOrUndefined(value)
  if (number === undefined || number <= 0) return undefined
  // 小于 1e12 视作秒（2001 年之前的毫秒值没有实际意义）
  return number < 1e12 ? Math.round(number * 1000) : Math.round(number)
}

/** 智谱套餐档位名归一。 */
function levelToPlan(level) {
  const text = String(level ?? '').toLowerCase()
  if (text.includes('max')) return 'Max'
  if (text.includes('pro')) return 'Pro'
  if (text.includes('lite')) return 'Lite'
  if (text.includes('standard')) return 'Standard'
  return level === '' ? '' : level
}

/**
 * 组装一个窗口对象，并把「能算的都算出来，算不出的一律留 undefined」。
 *
 * 三条规则，都是为了让界面不撒谎：
 *   - 有绝对值（used + total）就用绝对值算百分比，比接口给的取整百分比准；
 *   - 只有「剩余」而没有总额时，**不编百分比**，只报剩余值；
 *   - 任何缺失都留 undefined，由界面显示 `—`，绝不显示成 0。
 * @param {object} input - 原始窗口事实。
 * @returns {object} 归一窗口。
 */
function buildWindow(input) {
  const used = input.used
  const total = input.total
  // 只有剩余、没有总额时，用剩余反推「已用 = 总额 - 剩余」是不可行的
  // （总额未知），因此这种情况下不计算百分比。
  let usedPercent = numberOrUndefined(input.usedPercent)
  if (used !== undefined && total !== undefined && total > 0) {
    usedPercent = (used / total) * 100
  }
  const remaining = input.remainingAbsolute !== undefined
    ? input.remainingAbsolute
    : (used !== undefined && total !== undefined ? total - used : undefined)
  return {
    window: input.window,
    label: WINDOW_LABELS[input.window] ?? input.window,
    used: used === undefined ? undefined : round2(used),
    total: total === undefined ? undefined : round2(total),
    remaining: remaining === undefined ? undefined : round2(remaining),
    // 只挡下溢（负数没有意义），**不挡上溢**：额度用超时百分比会大于 100，
    // 而「超了多少」正是最该让用户看见的信息。把它夹到 100 会让 140% 显示成 100%，
    // 等于把「已严重超限」伪装成「刚好用满」。进度条的宽度由客户端单独夹取。
    usedPercent: usedPercent === undefined ? undefined : round2(Math.max(0, usedPercent)),
    resetAt: input.resetAt,
    exceeded: input.exceeded === true,
    source: input.source,
    // 只有百分比（没有绝对值）时标出来，界面可提示「官方只给了百分比」
    percentOnly: used === undefined && total === undefined && usedPercent !== undefined,
  }
}

/** 保留两位小数。 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 多厂商套餐额度查询器：解析凭据 → 请求 → 缓存。
 *
 * 依赖全部以取值函数注入，因此缺少 credentials 服务时仍能靠环境变量与本机 CLI
 * 凭据工作（这正是用户选择的「自动发现」）。
 */
export class PlansService {
  /**
   * @param {object} deps - 依赖。
   * @param {() => object|undefined} deps.credentials - ctx.credentials。
   * @param {Function} [deps.fetchImpl] - fetch 实现；测试注入用。
   * @param {number} [deps.ttlMs] - 缓存有效期。
   * @param {number} [deps.timeoutMs] - 单次请求超时。
   * @param {object} [deps.env] - 环境变量来源。
   * @param {string} [deps.commandCodeAuthFile] - Command Code auth.json 路径覆盖（测试用）。
   * @param {object} [deps.prefs] - 开关持久化（与余额共用一套 prefs）。
   */
  constructor({
    credentials,
    fetchImpl,
    ttlMs = PLANS_TTL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    env = process.env,
    commandCodeAuthFile,
    prefs,
  } = {}) {
    this.credentials = credentials
    this.fetchImpl = fetchImpl ?? globalThis.fetch
    this.ttlMs = ttlMs
    this.timeoutMs = timeoutMs
    this.env = env
    this.commandCodeAuthFile = commandCodeAuthFile
    this.prefs = prefs
    /** @type {object|undefined} */
    this.cache = undefined
    this.cacheAt = 0
    /** @type {Promise<object>|undefined} */
    this.inflight = undefined
  }

  /** 缓存失效（开关变化或手动刷新时用）。 */
  invalidate() {
    this.cache = undefined
    this.cacheAt = 0
  }

  /**
   * 解析某家厂商的 Key 及其来源。
   *
   * 会按顺序试**全部候选引用名**（见 {@link candidateRefs}），因为用户用自定义
   * provider 添加时，DSH 派生的引用名取决于他当时怎么拼路由名
   * （`commandcode` → `COMMANDCODE_API_KEY`，`command-code` → `COMMAND_CODE_API_KEY`）。
   *
   * 顺序：逐候选试 DSH credentials（运行时解析，支持 `.env` 分层与热更新）→
   * 逐候选试进程环境 → Command Code 专属的本机 CLI 凭据文件。
   * @param {string[]} refs - 候选凭据引用名（按优先级）。
   * @param {string} [cliFile] - CLI 凭据文件路径（仅 Command Code 有）。
   * @returns {Promise<{value:string,source:string,ref:string}|undefined>} Key、来源与命中的引用名。
   */
  async resolveKey(refs, cliFile) {
    const candidates = Array.isArray(refs) ? refs : [refs]
    const credentials = this.credentials?.()
    for (const ref of candidates) {
      if (credentials !== undefined) {
        try {
          const hit = await credentials.resolve(ref)
          if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') {
            return {
              value: hit.value.trim(),
              source: typeof hit.source === 'string' ? hit.source : 'credentials',
              ref,
            }
          }
        } catch {
          // 引用名非法或存储读失败：继续试下一个候选
        }
      }
      const ambient = this.env?.[ref]
      if (typeof ambient === 'string' && ambient.trim() !== '') {
        return { value: ambient.trim(), source: 'env', ref }
      }
    }
    if (cliFile !== undefined) {
      const fromFile = readCommandCodeKey(cliFile)
      if (fromFile !== undefined) return { value: fromFile, source: 'cli-file', ref: '(CLI auth.json)' }
    }
    return undefined
  }

  /**
   * 查询全部套餐额度（带 TTL 缓存与并发合并）。
   *
   * 两家各自独立取：一家失败不影响另一家（失败信息随该家一起返回）。
   * @param {{refresh?:boolean}} [options] - refresh 为真时跳过缓存。
   * @returns {Promise<object>} 负载（永不含 Key）。
   */
  async read(options = {}) {
    const enabled = await this.enabled()
    if (!enabled) {
      return { enabled: false, lockedByEnv: this.lockedByEnv, providers: [], fetchedAt: null }
    }
    const now = Date.now()
    if (options.refresh !== true && this.cache !== undefined && now - this.cacheAt < this.ttlMs) {
      return { ...this.cache, cached: true }
    }
    if (this.inflight !== undefined) return this.inflight

    this.inflight = Promise.all([
      this.#readZhipu(),
      this.#readCommandCode(),
    ])
      .then((providers) => {
        const payload = { enabled: true, fetchedAt: Date.now(), providers }
        this.cache = payload
        this.cacheAt = Date.now()
        return payload
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * 套餐监控的开关。与余额开关共用一个 prefs 对象，但键不同。
   * @returns {Promise<boolean>} 是否启用。
   */
  async enabled() {
    if (this.lockedByEnv) return false
    if (this.prefs === undefined) return true
    const value = await this.prefs()
    return value?.plansEnabled !== false
  }

  /** `DSH_PIXEL_PLANS=0/false/off` 时硬性关闭。 */
  get lockedByEnv() {
    const raw = this.env?.DSH_PIXEL_PLANS
    if (typeof raw !== 'string') return false
    const value = raw.trim().toLowerCase()
    return value === '0' || value === 'false' || value === 'off' || value === 'no'
  }

  /**
   * 智谱 GLM Coding Plan 额度。
   * @returns {Promise<object>} 该家的结果。
   */
  async #readZhipu() {
    const base = {
      id: 'zhipu',
      name: '智谱 GLM Coding Plan',
      docURL: 'https://www.bigmodel.cn/coding-plan/personal/usage',
      endpoint: ZHIPU_QUOTA_PATH,
      // 官方只有 5 小时与每周两个额度，没有月度——界面上要说明这点，
      // 否则用户会以为月度那一栏是坏的。
      supportedWindows: ['fiveHour', 'weekly'],
      note: '官方只设 5 小时与每周额度，没有月度额度。',
    }
    const key = await this.resolveKey(ZHIPU_KEY_ENVS)
    if (key === undefined) {
      return { ...base, ok: false, reason: 'no-key', keyRef: ZHIPU_KEY_ENV, keyRefs: ZHIPU_KEY_ENVS, windows: [] }
    }
    const response = await this.#requestJson(ZHIPU_QUOTA_URL, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'accept-language': 'en-US,en',
        // 智谱这个接口收的是**裸 Key**，加 Bearer 反而会鉴权失败
        authorization: key.value,
      },
    })
    if (response.error !== undefined) {
      return { ...base, ok: false, reason: 'request-failed', error: response.error, keyRef: key.ref, keySource: key.source, keyHint: maskSecret(key.value), windows: [] }
    }
    // 关键：这个接口鉴权失败时 HTTP 仍是 200，必须看 success
    if (response.body?.success === false) {
      const message = typeof response.body?.msg === 'string' ? response.body.msg : '鉴权失败'
      return {
        ...base,
        ok: false,
        reason: 'rejected',
        error: message,
        hint: '智谱的 Coding Plan 需要套餐专属 Key（在「个人编程套餐」里新建），平台普通 API Key 不通用。',
        keyRef: key.ref,
        keySource: key.source,
        keyHint: maskSecret(key.value),
        windows: [],
      }
    }
    const parsed = parseZhipuQuota(response.body)
    return {
      ...base,
      ok: true,
      plan: parsed.plan,
      level: parsed.level,
      keyRef: key.ref,
      keySource: key.source,
      keyHint: maskSecret(key.value),
      windows: parsed.windows,
      ...(parsed.unparsed > 0 ? { warning: `有 ${parsed.unparsed} 条额度记录无法识别（接口可能已变更）` } : {}),
    }
  }

  /**
   * Command Code 额度。
   * @returns {Promise<object>} 该家的结果。
   */
  async #readCommandCode() {
    const base = {
      id: 'commandcode',
      name: 'Command Code',
      docURL: 'https://commandcode.ai/studio',
      endpoint: COMMAND_CODE_CREDITS_PATH,
      supportedWindows: ['fiveHour', 'weekly', 'monthly'],
      note: '',
    }
    const authFile = this.commandCodeAuthFile ?? commandCodeAuthPath(this.env)
    const key = await this.resolveKey(COMMAND_CODE_KEY_ENVS, authFile)
    if (key === undefined) {
      return { ...base, ok: false, reason: 'no-key', keyRef: COMMAND_CODE_KEY_ENV, keyRefs: COMMAND_CODE_KEY_ENVS, windows: [], authFile }
    }
    const headers = { accept: 'application/json', authorization: `Bearer ${key.value}` }
    const response = await this.#requestJson(COMMAND_CODE_CREDITS_URL, { headers })
    if (response.error !== undefined) {
      return { ...base, ok: false, reason: 'request-failed', error: response.error, keyRef: key.ref, keySource: key.source, keyHint: maskSecret(key.value), authFile, windows: [] }
    }
    if (response.body?.success === false) {
      const message = response.body?.error?.message ?? response.body?.message ?? '鉴权失败'
      return { ...base, ok: false, reason: 'rejected', error: String(message), keyRef: key.ref, keySource: key.source, keyHint: maskSecret(key.value), authFile, windows: [] }
    }
    // 订阅周期只用于给月度窗口补一个刷新时间，取不到不算失败。
    let subscription
    try {
      const sub = await this.#requestJson(COMMAND_CODE_SUBSCRIPTION_URL, { headers })
      if (sub.error === undefined && sub.body?.success !== false) subscription = sub.body
    } catch {
      subscription = undefined
    }
    const parsed = parseCommandCodeCredits(response.body, subscription)
    return {
      ...base,
      ok: true,
      plan: parsed.plan,
      keyRef: key.ref,
      keySource: key.source,
      keyHint: maskSecret(key.value),
      authFile,
      windows: parsed.windows,
      ...(parsed.unparsed > 0 ? { warning: `有 ${parsed.unparsed} 条额度记录无法识别（接口可能已变更）` } : {}),
    }
  }

  /**
   * 发一次请求并把结果归一成 `{body}` 或 `{error}`。
   *
   * 只回报状态码与一句人话，**不回传响应体**——上游响应里可能回显凭据，
   * 而这条路径会直达浏览器。
   * @param {string} url - 固定官方端点。
   * @param {object} init - fetch 参数。
   * @returns {Promise<{body?:object,error?:string,status?:number}>} 结果。
   */
  async #requestJson(url, init) {
    if (typeof this.fetchImpl !== 'function') return { error: '当前运行环境没有可用的 fetch' }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...init, method: 'GET', signal: controller.signal })
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) return { error: '响应过大', status: response.status }
      if (!response.ok) return { error: `HTTP ${response.status}`, status: response.status }
      try {
        return { body: JSON.parse(text), status: response.status }
      } catch {
        return { error: '响应不是合法 JSON', status: response.status }
      }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return { error: aborted ? '请求超时' : '网络请求失败' }
    } finally {
      clearTimeout(timer)
    }
  }
}
