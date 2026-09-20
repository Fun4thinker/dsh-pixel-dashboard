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
import {
  VOLC_API_VERSION,
  VOLC_CONTENT_TYPE,
  VOLC_DEFAULT_REGION,
  VOLC_OPENAPI_HOST,
  isVolcAuthErrorCode,
  signVolcRequest,
  volcResponseError,
} from './volc-sign.js'

/** 智谱 quota 接口：固定官方域名。 */
export const ZHIPU_QUOTA_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'

/** 智谱 quota 接口路径，供界面上标出来源。 */
export const ZHIPU_QUOTA_PATH = '/api/monitor/usage/quota/limit'

/** Command Code 额度接口：固定官方域名。 */
export const COMMAND_CODE_CREDITS_URL = 'https://api.commandcode.ai/alpha/billing/credits'

/** Command Code 额度接口路径。 */
export const COMMAND_CODE_CREDITS_PATH = '/alpha/billing/credits'

/** Command Code 订阅周期接口：给月度窗口补刷新时间，也给出套餐身份（`data.planId`）。 */
export const COMMAND_CODE_SUBSCRIPTION_URL = 'https://api.commandcode.ai/alpha/billing/subscriptions'

/**
 * Command Code 用量汇总接口：**月度百分比的另一半**。
 *
 * `billing/credits` 的 `credits.monthlyCredits` 只是**剩余**余额（裸数字，没有 used、
 * 没有 cap），单靠它算不出「月消耗百分比」。真正的「本计费周期已用信用额」在这里：
 * `totalMonthlyCredits`（`periodBasis` 为 `billing-period`）。
 *
 * 早先只调 credits 那一个接口，月度窗口因此只有剩余值——界面上就永远显示 0.0%（见
 * `client/plans.js` 的 `windowProgress`）。实测这个接口与 credits 同时可用，
 * 两者相加正好等于套餐的名义月额度。
 */
export const COMMAND_CODE_USAGE_URL = 'https://api.commandcode.ai/alpha/usage/summary'

/** Command Code 用量汇总接口路径。 */
export const COMMAND_CODE_USAGE_PATH = '/alpha/usage/summary'

/**
 * 订阅 `planId` → 展示名与**名义**月度额度（美元信用额）。
 *
 * 取自官方定价页的额度表与官方 CLI bundle 的 plan map（与
 * `@mars-sea/dsh-commandcode-provider` 同步自 `command-code@1.53.0`）：
 * Go `$10` / GOAT `$70` / Pro `$80` / Max 10× `$150` / Max 20× `$300` / Team Pro `$40`。
 *
 * **只按完整 id 精确匹配，绝不做前缀匹配。** 老一代 `individual-pro` 名义是 `$30`，
 * 而现在的 Pro 是 `individual-pro-v1` = `$80`：前缀匹配会让新套餐继承旧额度，
 * 于是月度百分比整整错一个计费周期，而且看起来完全合理。
 *
 * 未收录的 id 就**没有**名义额度——没有名义额度时不做任何推算，宁可不给百分比。
 */
export const COMMAND_CODE_PLANS = Object.freeze({
  'individual-go': Object.freeze({ name: 'Go', monthlyCredits: 10 }),
  'individual-goat': Object.freeze({ name: 'GOAT', monthlyCredits: 70 }),
  'individual-pro': Object.freeze({ name: 'Pro', monthlyCredits: 30 }),
  'individual-pro-v1': Object.freeze({ name: 'Pro', monthlyCredits: 80 }),
  'individual-provider': Object.freeze({ name: 'Provider', monthlyCredits: 15 }),
  'individual-max': Object.freeze({ name: 'Max', monthlyCredits: 150 }),
  'individual-ultra': Object.freeze({ name: 'Ultra', monthlyCredits: 300 }),
  'teams-pro': Object.freeze({ name: 'Teams Pro', monthlyCredits: 40 }),
})

/**
 * 把订阅 `planId` 解析成展示名与名义月度额度。
 * @param {string|undefined} planId - 官方 `subscriptions.data.planId`。
 * @returns {{name:string,monthlyCredits:number}|undefined} 未收录的 id 返回 undefined。
 */
export function commandCodePlanInfo(planId) {
  if (typeof planId !== 'string' || planId.trim() === '') return undefined
  const normalized = planId.trim().toLowerCase().replace(/_/g, '-')
  return Object.hasOwn(COMMAND_CODE_PLANS, normalized) ? COMMAND_CODE_PLANS[normalized] : undefined
}

/**
 * 「已用 + 剩余」与套餐名义额度的容差。
 *
 * 月度 cap 是**两个接口两个数**相加得到的：跨计费周期滚动或中途换套餐时，这两个数
 * 可能属于不同周期，和看起来合理却差着几十个百分点。名义额度就是那把尺子——按比例
 * 与四舍五入只会让真值偏离零点几个百分点（GOAT 实测读到 70.23 对名义 70），
 * 而跨周期会偏得远得多。超出容差时**一个百分比都不给**，而不是留一个错的在界面上。
 */
export const COMMAND_CODE_CAP_TOLERANCE = 0.25

/**
 * 火山方舟（Volcengine Ark）用量接口路径，供界面上标出来源。
 *
 * 形如 `/?Action=...&Region=...&Version=...`；Action 有两个候选，见
 * {@link VOLC_ACTIONS}。
 */
export const VOLC_QUOTA_PATH = `/?Action=<Action>&Version=${VOLC_API_VERSION}`

/** 火山控制面 OpenAPI 网关（与数据面推理域名 ark.cn-beijing.volces.com 不同）。 */
export const VOLC_QUOTA_HOST = VOLC_OPENAPI_HOST

/**
 * 火山方舟 AK/SK 的创建入口（IAM 的「API 访问密钥」页）。
 *
 * 刻意**不是**方舟控制台。AK/SK 是账号级 IAM 凭据，在「访问密钥」页新建；而
 * 方舟控制台（`console.volcengine.com/ark`）里能拿到的是推理用的 `ark-` Key
 * ——恰好是本接口在网关格式层就会拒掉的那一把。早先唯一的链接指向方舟控制台，
 * 用户照着找只会拿到错误的凭据，然后一直失败。
 */
export const VOLC_KEY_URL = 'https://console.volcengine.com/iam/keymanage/'

/** 智谱编程套餐页（套餐专属 Key 在这里新建）。 */
export const ZHIPU_KEY_URL = 'https://www.bigmodel.cn/coding-plan/personal/usage'

/** Command Code 工作台（API Key 在这里创建）。 */
export const COMMAND_CODE_KEY_URL = 'https://commandcode.ai/studio'

/**
 * 构造一家的「凭据去哪拿、配到哪」说明块。
 *
 * **这一节存在的理由（别删）**：DSH 的设置界面里**没有通用的凭据编辑器**。
 * 「设置 → 模型」只把你填的 Key 存到它自己派生的 `<路由名>_API_KEY` 之下
 * （见 ui-settings-models 的 `deriveKeyRef`），而火山要的
 * `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY` **永远不可能**由那条规则推导出来。
 * 于是用户看到「请配成 VOLC_ACCESS_KEY_ID」时，界面里根本没有能输入的框——
 * 只说「写进 DSH 凭据库」等于没说。
 *
 * 真正能写进去的只有两处，界面上必须把这两处都写出来：
 *   1. 凭据文件 `<DSH_HOME>/.credentials.yaml` 的 `refs:` 段；
 *   2. 同名环境变量（含 `<DSH_HOME>/.env`、项目 `.env`，或启动前 export）。
 * @param {object} spec - keyURL / keyURLName / acquire / refs / where。
 * @returns {object} 说明块（纯数据，供界面直接渲染）。
 */
export function setupOf(spec) {
  return {
    keyURL: String(spec.keyURL ?? ''),
    keyURLName: String(spec.keyURLName ?? ''),
    acquire: Array.isArray(spec.acquire) ? spec.acquire.map(String) : [],
    refs: (Array.isArray(spec.refs) ? spec.refs : []).map((item) => ({
      name: String(item.name ?? ''),
      example: String(item.example ?? ''),
      note: String(item.note ?? ''),
    })),
  }
}

/**
 * 解析 DSH 凭据文件路径，供界面告诉用户「这两行写进哪个文件」。
 *
 * 与 DSH 自己的规则一致（`dsh-credentials-local` 的默认 `path`）：
 * `$DSH_HOME/.credentials.yaml`，`DSH_HOME` 缺省为 `~/.dsh`。
 *
 * **为什么不直接让用户去设置界面填**：DSH 的设置里没有通用凭据编辑器，
 * 「设置 → 模型」只会写它自己派生的 `<路由>_API_KEY`。所以对
 * `VOLC_ACCESS_KEY_ID` 这类名字，文件是唯一可靠的去处——界面必须把**路径**
 * 写出来，而不是只说「写进 DSH 凭据库」。
 * @param {object} [env] - 环境变量来源（默认 process.env）。
 * @returns {string} 绝对路径（最后的兜底是 OS 主目录，因此总是有值）。
 */
export function resolveCredentialFilePath(env = process.env) {
  const home = env?.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') {
    return join(home.trim(), '.credentials.yaml')
  }
  // USERPROFILE 优先（Windows），其余平台用 homedir()。
  // 兜底到 OS 主目录而不是返回空串：DSH 自己的默认就是 `~/.dsh`，
  // 这里返回空串只会让界面少一行路径，用户反而更不知道该写哪。
  const base = env?.USERPROFILE ?? homedir()
  return join(base, '.dsh', '.credentials.yaml')
}

/**
 * 火山方舟的两个用量 Action，按探测顺序排列。
 *
 * 同一账号可能订的是 Agent Plan（回**绝对值** Quota/Used）或 Coding Plan
 * （只回**百分比** Percent），官方没有「一次问清」的接口，所以按顺序试：
 *   1. `GetAFPUsage` — Agent Plan，绝对值；
 *   2. `GetCodingPlanUsage` — Coding Plan，百分比。
 *
 * 两家共用同一份 AK/SK，因此**鉴权失败直接停**、不再试下一个。
 */
export const VOLC_ACTIONS = [
  { action: 'GetAFPUsage', plan: 'Agent Plan' },
  { action: 'GetCodingPlanUsage', plan: 'Coding Plan' },
]

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

/** 火山方舟常见的自定义 provider 路由名。 */
export const VOLC_ROUTES = ['fangzhou', 'volcengine', 'ark', 'volces', 'doubao']

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

/**
 * 火山方舟的候选凭据引用名（AccessKey ID）。
 *
 * **注意与另外两家的根本区别**：火山的用量接口要的是**账号级 AK/SK 签名**，
 * 不是推理用的 `ark-` Bearer Key（后者在网关格式层就被拒，见 lib/volc-sign.js）。
 * 因此这里刻意**不派生** `FANGZHOU_API_KEY` 那类 provider 引用名——那把是推理 Key，
 * 拿它去签名只会得到 401/400，反而误导。只认名字里明确写着 AK 的两项。
 */
export const VOLC_AK_ENVS = ['VOLC_ACCESS_KEY_ID', 'VOLCENGINE_ACCESS_KEY_ID']

/** 火山方舟的候选凭据引用名（Secret Access Key），与 AK 一一对应。 */
export const VOLC_SK_ENVS = ['VOLC_SECRET_ACCESS_KEY', 'VOLCENGINE_SECRET_ACCESS_KEY']

/** 兼容旧名：第一候选。 */
export const ZHIPU_KEY_ENV = ZHIPU_KEY_ENVS[0]

/** 兼容旧名：第一候选。 */
export const COMMAND_CODE_KEY_ENV = COMMAND_CODE_KEY_ENVS[0]

/** 火山 AK 的第一候选。 */
export const VOLC_AK_ENV = VOLC_AK_ENVS[0]

/** 火山 SK 的第一候选。 */
export const VOLC_SK_ENV = VOLC_SK_ENVS[0]

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
 * 形状（来自其 CLI 自身的调用，非公开文档）——**三个接口拼出三个窗口**：
 *   `credits.windowLimits.fiveHour` / `.weekly` = `{ used, cap, resetAt, exceeded }`；
 *   `credits.credits.monthlyCredits` = **剩余**信用额（裸数字，或带 used/cap 的对象）；
 *   `usage.totalMonthlyCredits` = **本计费周期已用**信用额（月度百分比的另一半）；
 *   `subscriptions.data.planId` = 套餐身份（决定名义月额度，也用来核对上面那个和）。
 *
 * 月度百分比只在**站得住**的时候才给（判据见 {@link COMMAND_CODE_CAP_TOLERANCE}）：
 * 拿不到已用、或「已用 + 剩余」与名义额度对不上时，窗口只报剩余余额并留下 `note`，
 * 由界面渲染成 `—`——**绝不显示成 0%**（那正是这个函数早先的毛病：只调 credits 时
 * 月度只有剩余值，界面把「不知道」画成了「0.0%」）。
 * @param {object} payload - `/alpha/billing/credits` 响应体。
 * @param {object} [subscription] - `/alpha/billing/subscriptions` 响应体（可选）。
 * @param {object} [usage] - `/alpha/usage/summary` 响应体（可选）。
 * @returns {{plan:string,planId:string|undefined,windows:object[],unparsed:number}} 归一结果。
 */
export function parseCommandCodeCredits(payload, subscription, usage) {
  // 响应可能被包一层 `{ success, data }`，也可能就是裸对象
  const data = payload?.data ?? payload ?? {}
  const limits = data.windowLimits ?? data.window_limits ?? {}
  const creditBag = data.credits ?? {}
  const subData = subscription?.data ?? subscription ?? {}
  const usageBag = usage?.data ?? usage ?? {}
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

  // ── 月度：三个接口拼一个窗口 ────────────────────────────────
  const planId = stringOrUndefined(subData.planId) ?? stringOrUndefined(data.planId)
  const planInfo = commandCodePlanInfo(planId)
  const monthly = creditBag.monthlyCredits ?? data.monthlyCredits
  const monthlyObject = monthly !== null && typeof monthly === 'object' ? monthly : undefined
  const freeCredits = numberOrUndefined(creditBag.freeCredits)
  const purchasedCredits = numberOrUndefined(creditBag.purchasedCredits)
  const periodEnd = normalizeEpoch(subData.currentPeriodEnd ?? data.currentPeriodEnd)

  // 剩余：裸数字就是剩余余额；对象里优先自带 remaining
  const remainingCredits = typeof monthly === 'number' && Number.isFinite(monthly)
    ? monthly
    : numberOrUndefined(monthlyObject?.remaining)
  // 已用：对象自带的最准，其次用量汇总接口（`totalMonthlyCredits` = 本计费周期已用）
  let usedCredits = numberOrUndefined(monthlyObject?.used)
    ?? numberOrUndefined(usageBag.totalMonthlyCredits)
    ?? numberOrUndefined(usageBag.totalCredits)
  let capCredits = numberOrUndefined(monthlyObject?.cap ?? monthlyObject?.total)
  let note

  if (capCredits === undefined && usedCredits !== undefined && remainingCredits !== undefined) {
    // 两个接口两个数相加 = 月度总额。相加之前先拿名义额度当尺子量一量：
    // 跨计费周期或中途换套餐时，这两个数可能属于不同周期，和看着合理却差得远。
    const sum = usedCredits + remainingCredits
    if (sum > 0 && capIsPlausible(sum, planInfo, freeCredits, purchasedCredits)) {
      capCredits = sum
    } else {
      usedCredits = undefined
      note = planInfo === undefined
        ? '本期已用与剩余之和对不上，本期不给月度百分比'
        : `本期已用与剩余之和（$${round2(sum)}）与套餐名义额度（$${planInfo.monthlyCredits}）对不上，本期不给月度百分比`
    }
  }
  if (usedCredits === undefined && capCredits === undefined
    && planInfo !== undefined && remainingCredits !== undefined
    && remainingCredits <= planInfo.monthlyCredits) {
    // 只有剩余、但有套餐身份：按**名义**额度反推已用。这是推算，明说。
    capCredits = planInfo.monthlyCredits
    usedCredits = planInfo.monthlyCredits - remainingCredits
    note = `月度总额按套餐名义额度（$${planInfo.monthlyCredits}）推算`
  }

  if (monthly !== undefined || usedCredits !== undefined || capCredits !== undefined) {
    windows.push(buildWindow({
      window: 'monthly',
      used: usedCredits,
      total: capCredits,
      remainingAbsolute: remainingCredits,
      resetAt: normalizeEpoch(monthlyObject?.resetAt ?? monthlyObject?.reset_at) ?? periodEnd,
      exceeded: monthlyObject?.exceeded === true,
      note,
      source: 'commandcode',
    }))
  }

  // 套餐名：认得的 planId 用官方的档位名，其次原样报 planId（未收录的档位也比空白强）
  const plan = planInfo?.name
    ?? planId
    ?? stringOrUndefined(data.plan)
    ?? stringOrUndefined(subData.plan)
    ?? ''
  return { plan, planId, windows, unparsed }
}

/**
 * 火山方舟 Coding Plan 的窗口名归一。
 *
 * 线上字段是 `Level`，实测取值 `session` / `weekly` / `monthly`（另有 `daily`）。
 * **`session` 就是控制台上的「5 小时」**——照抄字面会显示成一个陌生的「会话」，
 * 所以这里显式映射，并保留若干同义写法做防御。
 * @param {string} label - 原始窗口名。
 * @returns {'fiveHour'|'weekly'|'monthly'|undefined} 归一窗口名。
 */
export function volcWindowName(label) {
  const text = String(label ?? '').toLowerCase().trim()
  if (['session', '5h', 'fivehour', 'five_hour', 'five-hour', 'rolling_5h', 'rolling'].includes(text)) {
    return 'fiveHour'
  }
  if (['weekly', 'week', '7d'].includes(text)) return 'weekly'
  if (['monthly', 'month'].includes(text)) return 'monthly'
  return undefined
}

/**
 * 解析火山方舟 `GetAFPUsage`（Agent Plan）的 `Result`。
 *
 * 三个窗口 `AFPFiveHour` / `AFPWeekly` / `AFPMonthly` 各给**绝对值**
 * `Quota` / `Used`，因此百分比自己算（比接口口径可控）。`ResetTime` 是**毫秒**。
 *
 * 两条照做不误的规则：
 *   1. `Quota <= 0` 视为该窗口未订阅/未启用，**跳过**——这也是把「已鉴权但没订
 *      Agent Plan」识别成空结果、从而回落到 Coding Plan 探测的依据。
 *   2. `AFPDaily` **刻意不取**：官方控制台自己把它隐藏了（其 Quota 常高于周上限，
 *      是历史默认值而不是强制限额），照实显示会误导。
 * @param {object} result - 响应里的 `Result`。
 * @returns {{windows:object[],unparsed:number,planType:string}} 归一结果。
 */
export function parseVolcAgentPlan(result) {
  const windows = []
  let unparsed = 0
  for (const [key, window] of [
    ['AFPFiveHour', 'fiveHour'],
    ['AFPWeekly', 'weekly'],
    ['AFPMonthly', 'monthly'],
  ]) {
    const raw = result?.[key]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'object') {
      unparsed += 1
      continue
    }
    const total = numberOrUndefined(raw.Quota)
    // 未订阅/未启用的窗口：不算「坏数据」，静默跳过
    if (total === undefined || total <= 0) continue
    windows.push(buildWindow({
      window,
      used: numberOrUndefined(raw.Used),
      total,
      resetAt: normalizeEpoch(raw.ResetTime),
      source: 'volcengine',
    }))
  }
  const planType = typeof result?.PlanType === 'string' ? result.PlanType.trim() : ''
  return { windows, unparsed, planType }
}

/**
 * 解析火山方舟 `GetCodingPlanUsage`（Coding Plan）的 `Result`。
 *
 * 这个接口**只给百分比**，没有 used/total（官方口径如此），所以窗口会带
 * `percentOnly` 标记，界面上说明「官方只给了百分比」——不假装精确。
 * `ResetTimestamp` 是**秒**（与 Agent Plan 的毫秒不同，`normalizeEpoch` 会分辨）。
 *
 * 数组字段名按 `QuotaUsage` 取，另留两个同义名做防御（该接口无逐字段官方文档）。
 * @param {object} result - 响应里的 `Result`。
 * @returns {{windows:object[],unparsed:number}} 归一结果。
 */
export function parseVolcCodingPlan(result) {
  const windows = []
  let unparsed = 0
  const list = result?.QuotaUsage ?? result?.Usages ?? result?.Details
  if (!Array.isArray(list)) return { windows, unparsed }

  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      unparsed += 1
      continue
    }
    const window = volcWindowName(item.Level ?? item.Type ?? item.Period ?? item.Window ?? item.Label)
    // 认不出的窗口（如 daily）跳过：宁可少显示一个，也不把它挂到别的窗口上
    if (window === undefined) {
      unparsed += 1
      continue
    }
    windows.push(buildWindow({
      window,
      usedPercent: numberOrUndefined(
        item.Percent ?? item.UsedPercent ?? item.UsagePercent,
      ),
      resetAt: normalizeEpoch(item.ResetTimestamp ?? item.ResetTime),
      source: 'volcengine',
    }))
  }
  return { windows, unparsed }
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

/** 非空字符串，否则 undefined。 */
function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 「已用 + 剩余」算出来的月度总额，是否与套餐名义额度站得住。
 *
 * 名义额度是**尺子**，不是事实来源：真实 cap 会因按比例、四舍五入偏离零点几个百分点，
 * 所以给 25% 的容差；而跨计费周期/换套餐造成的错配会偏得远得多。
 *
 * 三种情况一律放行（没有尺子就不否决）：未收录的套餐、名义额度非正、以及用户买过
 * 充值信用额——`used` 里含 free/purchased 的花费，基线必须把这两项一起算进去，
 * 否则任何买过加油包的人都会整个周期拿不到百分比。
 * @param {number} sum - 「已用 + 剩余」。
 * @param {{monthlyCredits:number}|undefined} planInfo - 套餐表查到的名义额度。
 * @param {number} [freeCredits] - 赠送信用额。
 * @param {number} [purchasedCredits] - 充值信用额。
 * @returns {boolean} 是否可信。
 */
function capIsPlausible(sum, planInfo, freeCredits, purchasedCredits) {
  const nominal = planInfo?.monthlyCredits
  if (nominal === undefined || nominal <= 0) return true
  const baseline = nominal + (freeCredits ?? 0) + (purchasedCredits ?? 0)
  if (baseline <= 0) return true
  const ratio = sum / baseline
  return ratio >= 1 - COMMAND_CODE_CAP_TOLERANCE && ratio <= 1 + COMMAND_CODE_CAP_TOLERANCE
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
 *   - 只有「剩余」而没有总额时，**不编百分比**，只报剩余值，并可带一句 `note`
 *     说明为什么没有百分比（界面据此显示 `—` 而不是 0%）；
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
    // 为什么这个窗口没有百分比（或百分比是推算的）：界面照实说出来，别让用户猜
    note: stringOrUndefined(input.note),
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
      this.#readVolcengine(),
    ])
      .then((providers) => {
        const payload = {
          enabled: true,
          fetchedAt: Date.now(),
          providers,
          // 「配到哪」：DSH 设置里没有通用的凭据编辑器，文件是唯一可靠的去处。
          // 路径在宿主解析（浏览器拿不到 env），浏览器只负责显示。
          credentialFile: resolveCredentialFilePath(this.env),
        }
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
      docURL: ZHIPU_KEY_URL,
      endpoint: ZHIPU_QUOTA_PATH,
      // 官方只有 5 小时与每周两个额度，没有月度——界面上要说明这点，
      // 否则用户会以为月度那一栏是坏的。
      supportedWindows: ['fiveHour', 'weekly'],
      note: '官方只设 5 小时与每周额度，没有月度额度。',
      setup: setupOf({
        keyURL: ZHIPU_KEY_URL,
        keyURLName: '智谱「个人编程套餐」页',
        acquire: [
          '在「个人编程套餐」里**新建**一把 Key——必须是套餐专属的那把。',
          '平台普通的 API Key **不通用**：标准模型调用能过，但额度查询会报 Authentication Failed。',
        ],
        refs: [{ name: 'ZHIPU_CODING_API_KEY', example: '...', note: '编程套餐专属 Key' }],
      }),
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
      docURL: COMMAND_CODE_KEY_URL,
      endpoint: COMMAND_CODE_CREDITS_PATH,
      supportedWindows: ['fiveHour', 'weekly', 'monthly'],
      note: '',
      setup: setupOf({
        keyURL: COMMAND_CODE_KEY_URL,
        keyURLName: 'Command Code 工作台',
        acquire: [
          '在工作台里创建 API Key。',
          '已经装过 Command Code CLI 并登录过的话**不用手动配**：插件会自动读本机的凭据文件。',
        ],
        refs: [{ name: 'COMMAND_CODE_API_KEY', example: '...', note: '装过 CLI 时可留空' }],
      }),
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
    // 订阅周期（套餐身份 + 月度刷新时间）与用量汇总（本期已用）**同时发**：
    // 两者互不依赖，串行只会让卡片多等一个来回。任一个失败都不算整家失败——
    // 少了「已用」就退化成「只报剩余余额」，而不是把整块界面变成错误态。
    const [subResult, usageResult] = await Promise.all([
      this.#requestJson(COMMAND_CODE_SUBSCRIPTION_URL, { headers }),
      this.#requestJson(COMMAND_CODE_USAGE_URL, { headers }),
    ])
    const accepted = (result) => (
      result.error === undefined && result.body?.success !== false ? result.body : undefined
    )
    const subscription = accepted(subResult)
    const usage = accepted(usageResult)
    const parsed = parseCommandCodeCredits(response.body, subscription, usage)
    return {
      ...base,
      ok: true,
      plan: parsed.plan,
      planId: parsed.planId,
      keyRef: key.ref,
      keySource: key.source,
      keyHint: maskSecret(key.value),
      authFile,
      windows: parsed.windows,
      ...(parsed.unparsed > 0 ? { warning: `有 ${parsed.unparsed} 条额度记录无法识别（接口可能已变更）` } : {}),
    }
  }

  /**
   * 火山方舟（Agent Plan / Coding Plan）额度。
   *
   * 与另外两家的**根本区别**：这不是数据面的 Bearer 接口，而是控制面 OpenAPI，
   * 要求 AK/SK 签名（见 lib/volc-sign.js）。推理用的 `ark-` Key 塞进 Authorization
   * 会在网关**格式层**被拒（400 / InvalidAuthorization），所以：
   *
   *   - 凭据只认 `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY` 这类明确写着 AK 的
   *     引用名，**刻意不纳入 provider 派生的推理 Key**——那把在这里必然失败，
   *     纳进来只会把用户引到错误的排查方向。
   *   - 鉴权类错误**立刻停**：两个 Action 共用同一份 AK/SK，换一个试没有意义。
   *   - 其它错误继续试下一个 Action（Agent Plan ↔ Coding Plan 是两种订阅）。
   *
   * @returns {Promise<object>} 该家的结果。
   */
  async #readVolcengine() {
    const base = {
      id: 'volcengine',
      name: '火山方舟 Coding Plan',
      docURL: VOLC_KEY_URL,
      endpoint: VOLC_QUOTA_PATH,
      supportedWindows: ['fiveHour', 'weekly', 'monthly'],
      // 界面上必须说清楚这里要的是 AK/SK 而不是推理 Key——这是唯一容易配错的地方
      note: '用量接口在控制面，需火山账号的 AccessKey ID / Secret（与推理用的 ark- Key 是两套凭据）。',
      // 「去哪拿、配到哪」——见 setupOf 的注释：DSH 设置里没有能填这两个名字的输入框，
      // 只说「配成 VOLC_ACCESS_KEY_ID」用户是做不到的。
      setup: setupOf({
        keyURL: VOLC_KEY_URL,
        keyURLName: '火山引擎控制台 → API 访问密钥',
        acquire: [
          '登录火山引擎控制台，打开「访问控制 → API 访问密钥」（也常写作「密钥管理」）。',
          '点「新建密钥」，按提示完成身份认证，然后下载凭证——Secret Access Key 只在创建时显示一次，关掉就再也看不到。',
          '注意：这个页面在火山引擎账号的 IAM 里，不在方舟控制台里。方舟控制台给的是推理用的 ark- Key，那个这里用不了。',
        ],
        refs: [
          { name: 'VOLC_ACCESS_KEY_ID', example: 'AKLT...', note: 'AccessKey ID' },
          { name: 'VOLC_SECRET_ACCESS_KEY', example: '...', note: 'Secret Access Key（两把都要配齐）' },
        ],
      }),
    }
    const accessKeyId = await this.resolveKey(VOLC_AK_ENVS)
    const secretAccessKey = await this.resolveKey(VOLC_SK_ENVS)
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      // 只配了一半时要说清缺哪一个，否则用户不知道该补什么
      const missing = accessKeyId === undefined ? VOLC_AK_ENV : VOLC_SK_ENV
      return {
        ...base,
        ok: false,
        reason: 'no-key',
        keyRef: missing,
        keyRefs: accessKeyId === undefined ? VOLC_AK_ENVS : VOLC_SK_ENVS,
        // 这句话必须同时回答「去哪拿」和「拿到后放哪」，只答一半用户就卡住了。
        // 下面 setup 块给出可点的链接与完整步骤，这里只留一句摘要。
        hint: '需要在火山引擎账号的 IAM 里创建 AccessKey ID / Secret Access Key（不是方舟的推理 API Key），两把都要配齐；界面上找不到能填这两个名字的输入框，往凭据文件里写——展开下面的「这家凭据怎么配」有完整步骤与本机路径。',
        windows: [],
      }
    }

    const errors = []
    for (const { action, plan } of VOLC_ACTIONS) {
      const call = await this.#volcCall(action, accessKeyId.value, secretAccessKey.value, base)
      if (call.error !== undefined) {
        // 鉴权类：两个 Action 共用凭据，换一个也是同样结果，直接停
        if (call.auth === true) {
          return {
            ...base,
            ok: false,
            reason: 'rejected',
            error: call.error,
            hint: '这里要的是火山账号的 AccessKey ID / Secret Access Key，而不是方舟推理用的 ark- 开头的 Key；'
              + 'AK/SK 在火山引擎账号的 IAM「API 访问密钥」里创建（见下面的「怎么配」）。',
            keyRef: accessKeyId.ref,
            keySource: accessKeyId.source,
            keyHint: `AK ${maskSecret(accessKeyId.value)}`,
            windows: [],
          }
        }
        errors.push(`${action}: ${call.error}`)
        continue
      }
      const result = call.body?.Result ?? call.body ?? {}
      const parsed = action === 'GetAFPUsage'
        ? parseVolcAgentPlan(result)
        : parseVolcCodingPlan(result)
      if (parsed.windows.length === 0) {
        // 已鉴权但该 plan 没数据：多半是没订这一种，继续试下一个
        errors.push(`${action}: 未返回额度窗口`)
        continue
      }
      const planType = parsed.planType === undefined || parsed.planType === ''
        ? plan
        : `${plan} ${parsed.planType}`
      return {
        ...base,
        ok: true,
        plan: planType,
        keyRef: accessKeyId.ref,
        keySource: accessKeyId.source,
        keyHint: `AK ${maskSecret(accessKeyId.value)}`,
        windows: parsed.windows,
        ...(parsed.unparsed > 0 ? { warning: `有 ${parsed.unparsed} 条额度记录无法识别（接口可能已变更）` } : {}),
      }
    }
    // 两个 Action 都没数据：不谎报成功，把每家的话带出来
    return {
      ...base,
      ok: false,
      reason: 'request-failed',
      error: errors.join('；') || '未返回额度窗口',
      hint: '已通过鉴权但没查到套餐额度：确认账号确实订了 Agent Plan 或 Coding Plan。',
      keyRef: accessKeyId.ref,
      keySource: accessKeyId.source,
      keyHint: `AK ${maskSecret(accessKeyId.value)}`,
      windows: [],
    }
  }

  /**
   * 发一次火山控制面 OpenAPI 调用（签名 POST）。
   *
   * 与 {@link PlansService} 的 `#requestJson` 分开，因为火山这边有三点不同：
   *   1. 要 POST + 签名头，不是裸 GET；
   *   2. **失败也带 JSON 信封**——网关对签名/凭据错误常返 400/401 且 body 是
   *      `ResponseMetadata.Error`，只看状态码无法区分「凭据不对」与「接口坏了」；
   *   3. 需要把鉴权类错误单独标出来（`auth: true`），调用方据此决定要不要继续试。
   *
   * 隐私：只回报错误码与消息这两个安全字段，**不回传响应体**。
   * @param {string} action - OpenAPI Action。
   * @param {string} accessKeyId - AK。
   * @param {string} secretAccessKey - SK。
   * @param {object} base - 该家的基础字段（含 docURL 等，这里只用来取 region）。
   * @returns {Promise<{body?:object,error?:string,auth?:boolean}>} 结果。
   */
  async #volcCall(action, accessKeyId, secretAccessKey, base) {
    if (typeof this.fetchImpl !== 'function') return { error: '当前运行环境没有可用的 fetch' }
    let signed
    try {
      signed = signVolcRequest({
        accessKeyId,
        secretAccessKey,
        action,
        region: this.volcRegion ?? VOLC_DEFAULT_REGION,
      })
    } catch (error) {
      return { error: `签名失败：${error instanceof Error ? error.message : String(error)}` }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetchImpl(signed.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': VOLC_CONTENT_TYPE,
          'x-date': signed.xDate,
          'x-content-sha256': signed.xContentSha256,
          authorization: signed.authorization,
        },
        body: '',
      })
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) return { error: '响应过大' }
      let body
      try {
        body = JSON.parse(text)
      } catch {
        return { error: response.ok ? '响应不是合法 JSON' : `HTTP ${response.status}` }
      }
      // 火山业务错误常以 200 携带信封返回，所以**先看信封、再看状态码**
      const envelope = volcResponseError(body)
      if (envelope !== undefined) {
        return {
          error: `${envelope.code || `HTTP ${response.status}`}${envelope.message === '' ? '' : `：${envelope.message}`}`,
          auth: isVolcAuthErrorCode(envelope.code),
        }
      }
      if (!response.ok) {
        return { error: `HTTP ${response.status}`, auth: response.status === 401 || response.status === 403 }
      }
      return { body }
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return { error: aborted ? '请求超时' : '网络请求失败' }
    } finally {
      clearTimeout(timer)
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
