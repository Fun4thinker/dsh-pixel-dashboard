/**
 * 第三方订阅套餐（Coding Plan）额度查询。
 *
 * 目前支持六家，分两批接入：
 *
 *   1) **智谱 GLM Coding Plan** — 5 小时积分 + 每周积分（官方**没有**月度额度）。
 *   2) **Command Code** — 5 小时 / 每周 / 每月三个滚动窗口。
 *   3) **火山方舟** — 控制面 OpenAPI，Agent Plan（绝对值）/ Coding Plan（百分比）。
 *   4) **Codex（ChatGPT 套餐）** — 只有百分比，主/次两个滚动窗口。
 *   5) **Cursor** — 只有百分比，一个计费周期（**社区核验**，见 CURSOR_USAGE_URL）。
 *   6) **Opencode** — Go 套餐百分比 ×3 ＋ Console 预算（美元绝对值）。
 *
 * 现金余额**只有 DeepSeek 官方**（见 lib/balance.js）：套餐额度换不成金额，
 * 不同厂商之间也不做换算或汇总——它们回答的是不同的问题。
 *
 * ## 关于这些接口的诚实说明（改动前务必读完）
 *
 * **六家都没有公开文档化的「个人套餐额度」API。** 这里用的是它们**前端 / CLI 自己
 * 在调**的内部接口，因此**可能随时失效**。本模块全程 fail-soft：任何一家取不到都
 * 只把那一家标成错误，绝不影响其余各家、也绝不影响看板其余部分。
 *
 * 每一家的结果都带三样元信息，界面据此如实交代可信度：
 *   - `verification`：`first-party`（有一方来源可核验：开源代码或官方文档）或
 *     `community`（只有社区逆向实现，Cursor 就是这一档）；
 *   - `shape`：`percent` / `absolute` / `remaining` / `mixed`，见 {@link SHAPE_LABELS}；
 *   - `evidence`：核验出处的链接。
 *
 * ## 凭据（隐私相关，别放宽）
 *
 * 按用户选择，凭据来源是「显式配置优先，其次自动发现本机 CLI 凭据」：
 *
 *   | 厂商 | 显式配置（复用 DSH credentials） | 自动发现 |
 *   |---|---|---|
 *   | 智谱 | `ZHIPU_CODING_API_KEY` | —（智谱没有官方 CLI 凭据文件） |
 *   | Command Code | `COMMAND_CODE_API_KEY` | `~/.commandcode/auth.json` 的 `apiKey` |
 *   | 火山方舟 | `VOLC_ACCESS_KEY_ID` + `VOLC_SECRET_ACCESS_KEY` | —（两把都要配） |
 *   | Codex | `CODEX_ACCESS_TOKEN` + `CODEX_ACCOUNT_ID` | `$CODEX_HOME/auth.json`（默认 `~/.codex`） |
 *   | Cursor | `CURSOR_ACCESS_TOKEN` | `~/.cursor/auth.json` / `%APPDATA%\Cursor\auth.json` |
 *   | Opencode | `OPENCODE_API_KEY` + `OPENCODE_WORKSPACE_ID` | `$XDG_DATA_HOME/opencode/auth.json` |
 *
 * 三条硬约束：
 *   - **Key 只在宿主进程内使用**，绝不写进响应、日志或落盘。响应里只回报来源
 *     （`credentials` / `env` / `cli-file`）与一个**打码后的尾部片段**，便于用户
 *     确认「用的是哪一把」，而不足以还原出密钥。
 *   - **端点固定为官方域名，不接受任何形式的改写**（无环境变量、无配置项）。
 *     与余额那一套同样的理由：端点决定 Key 发给谁。
 *   - **别人的凭据文件只读不写**（Codex / Cursor / Opencode / Command Code CLI）。
 *     也**不做 token refresh**：刷新要写回那些文件，越权了。
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
 *
 * 除了「怎么配」，这一块还要诚实交代三件事（都是用户判断可信度时必须知道的）：
 *   - `verification`：这个端点是不是有**一方来源**（开源代码 / 官方文档）可核验；
 *     `community` 表示只有社区逆向实现，界面必须说出来，不能让用户以为它是官方的；
 *   - `shape`：这家给的是**百分比**、**绝对值**还是**只有剩余额**；
 *   - `evidence`：核验出处链接（点开就能自己核对）。
 * @param {object} spec - keyURL / keyURLName / acquire / refs / where / files / verification / shape / evidence。
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
    // 自动发现路径：写出来用户才知道「为什么我没配它也能查到」。
    files: (Array.isArray(spec.files) ? spec.files : []).map((item) => ({
      path: String(item.path ?? ''),
      note: String(item.note ?? ''),
    })),
    // 数据形状：`percent`（只有百分比）/ `absolute`（绝对值）/ `remaining`（只有剩余额）。
    shape: SHAPE_LABELS[spec.shape] === undefined ? '' : String(spec.shape),
    verification: spec.verification === 'community' ? 'community' : 'first-party',
    evidence: String(spec.evidence ?? ''),
  }
}

/**
 * 数据形状 → 给用户看的说法。
 *
 * 这一张表是「不把不同厂商的额度换算成金额」那条铁律的落地：三家给的东西
 * 单位互不相通（百分比 / 美元 / 积分），界面上照实说形状，不做跨厂商比较。
 */
export const SHAPE_LABELS = Object.freeze({
  percent: '官方只给百分比',
  absolute: '官方给绝对值（已用 + 上限）',
  remaining: '官方只给剩余额',
  mixed: '套餐给百分比，预算给金额',
})

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

/**
 * Codex / Cursor / Opencode 常见的自定义 provider 路由名。
 *
 * 与 `ZHIPU_ROUTES` 等同一个用途：用户用「自定义提供商」接这三家时，DSH 会按路由名
 * 派生凭据引用名。**这一组在客户端 `client/plans.js` 里有一份镜像**
 * （`EXTRA_PLAN_ROUTES`），用于「当前会话用的是哪一家 → 该显示哪家的额度」。
 * 两份漂移的表现是「套餐卡片里有这一家、费用条旁边却始终不显示」——没有报错。
 */
export const CODEX_ROUTES = ['codex', 'codex-cli', 'openai-codex', 'chatgpt-codex']
export const CURSOR_ROUTES = ['cursor', 'cursor-agent']
export const OPENCODE_ROUTES = ['opencode', 'opencode-zen', 'zen']

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

/* ══════════════════════════════════════════════════════════════════
 * 新增三家：Codex / Cursor / Opencode
 *
 * 每一家的端点、鉴权头与凭据文件格式都来自**可核验的来源**，注释里给出链接：
 * 优先是它们自己 CLI / 客户端的开源代码（Codex、Opencode 都是开源的），
 * 官方文档只在代码不可读时才算数。**核验不到的字段一个都不编**：
 * 解析器只读代码里真实出现过的字段名，读不到就留 undefined（界面显示 `—`）。
 *
 * 三家的数据形状**互不相同**，这正是不能「统一成金额」的理由：
 *
 *   | 厂商 | 形状 | 窗口 |
 *   |---|---|---|
 *   | Codex | **只有百分比**（`used_percent`）+ 重置时刻 | 主/次两个滚动窗口 |
 *   | Cursor | **只有百分比**（`totalPercentUsed`）+ 计费周期 | 一个计费周期 |
 *   | Opencode | Go 套餐**百分比** ×3；Console 预算**绝对值**（美元） | rolling/weekly/monthly + 预算 |
 *
 * 所有端点都是**未文档化的内部接口**（官方没有把它们写进公开 API 文档），
 * 因此与前三家同样按「随时会失效」写：单家失败只标那一家。
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Codex（OpenAI Codex CLI）的额度接口。
 *
 * **核验来源（可点开对照）**：
 *   `codex-rs/backend-client/src/client/rate_limit_resets.rs` 里
 *   `rate_limit_status_url()`：ChatGPT 侧的 base 是 `chatgpt.com/backend-api`，
 *   路径拼成 `/wham/usage`；API 风格 base（不含 `/backend-api`）则是 `/api/codex/usage`。
 *   https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
 *
 * 鉴权是 **ChatGPT 登录态的 access token**（`Authorization: Bearer …`）外加
 * `chatgpt-account-id` 头（见同目录 `client.rs` 的 `headers_with()` 与
 * `codex-rs/http-client/src/openai_headers.rs`）。**不是 API Key**：用 `sk-` 开头的
 * 平台 Key 打这个端点只会得到 401，所以凭据候选里刻意不派生 `<route>_API_KEY`。
 *
 * 响应形状（`RateLimitStatusPayload`，测试用的线上样本在
 * `codex-rs/app-server/tests/suite/v2/rate_limits.rs`）：
 *
 *     { "plan_type": "team",
 *       "rate_limit": { "allowed": true, "limit_reached": false,
 *                       "primary_window":   { "used_percent": 42, "limit_window_seconds": 3600,
 *                                             "reset_after_seconds": 120, "reset_at": 2000000000 },
 *                       "secondary_window": { … } },
 *       "rate_limit_reset_credits": { "available_count": 0 } }
 *
 * 注意 `reset_at` 是**秒**，`limit_window_seconds` 才是窗口长度（分钟 = 秒/60）。
 * 窗口身份**必须按 `limit_window_seconds` 判**，不能按 primary/secondary 的位置猜：
 * 代码里 primary 既出现过 1 小时也出现过 5 小时。
 */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Codex 额度接口路径，供界面标出来源。 */
export const CODEX_USAGE_PATH = '/backend-api/wham/usage'

/** Codex 登录与用量说明（官方文档站，`docs/authentication.md` 指向这里）。 */
export const CODEX_KEY_URL = 'https://developers.openai.com/codex/auth'

/** 端点的核验出处。 */
export const CODEX_EVIDENCE_URL = 'https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs'

/**
 * Codex 的凭据引用名：ChatGPT 登录态 access token。
 *
 * 之所以叫 `CODEX_ACCESS_TOKEN` 而不是 `CODEX_API_KEY`：`~/.codex/auth.json` 里
 * `tokens.access_token` 是 OAuth 令牌（JWT），与 `OPENAI_API_KEY` 是**两套东西**
 * （见 `codex-rs/login/src/auth/storage.rs` 的 `AuthDotJson`，它同时有
 * `OPENAI_API_KEY` 与 `tokens` 两个字段）。用户若把平台 Key 当这个用会一直 401。
 */
export const CODEX_TOKEN_ENVS = ['CODEX_ACCESS_TOKEN', 'OPENAI_CODEX_ACCESS_TOKEN']

/**
 * Codex 的 workspace / account id 引用名（`chatgpt-account-id` 头）。
 *
 * 大多数情况下从 `~/.codex/auth.json` 的 `tokens.account_id` 就能拿到；
 * 这一组是给「只把 token 配进凭据文件」的人兜底的。
 */
export const CODEX_ACCOUNT_ENVS = ['CODEX_ACCOUNT_ID', 'CHATGPT_ACCOUNT_ID']

/** 兼容旧名：第一候选。 */
export const CODEX_TOKEN_ENV = CODEX_TOKEN_ENVS[0]

/**
 * 解析「本机主目录」，**并且尊重显式传入的空环境**。
 *
 * 这一条不是洁癖：`env` 是依赖注入的接缝，测试与预检会传 `{}` 表示
 * 「这台机器上什么都没配」。若这里回落到 `os.homedir()`，那个「空环境」就会
 * 去读**真实开发机**的 `~/.codex/auth.json` 之类文件并真的发网络请求——
 * 于是闸门里的公共 fetch 替身被别的厂商的请求污染（实测踩过：
 * 火山那条断言拿到的是 Cursor/Codex 的 URL）。
 *
 * 因此规则是：显式给了 env 但没有主目录变量 → **不猜**，返回 undefined，
 * 自动发现整体跳过。实际运行时 `process.env` 一定带 USERPROFILE / HOME。
 * @param {object|undefined} env - 环境变量来源。
 * @returns {string|undefined} 主目录绝对路径；无法推导时 undefined。
 */
function homeOf(env) {
  if (env === null || env === undefined) return homedir()
  const raw = env.USERPROFILE ?? env.HOME
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return raw.trim()
}

/**
 * Codex 凭据文件的默认目录名（`CODEX_HOME` 可覆盖）。
 * @param {object} [env] - 环境变量来源。
 * @returns {string} auth.json 的绝对路径；推不出主目录时是空串（表示「不自动发现」）。
 */
export function codexAuthPath(env = process.env) {
  const configured = typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== ''
    ? env.CODEX_HOME.trim()
    : undefined
  const home = configured ?? homeOf(env)
  if (home === undefined) return ''
  return join(home, configured === undefined ? '.codex' : '', 'auth.json')
}

/**
 * 从 Codex 的 `auth.json` 里读 access token 与 account id。
 *
 * 这是**另一个 App 的登录凭据文件**：只读不写，读失败一律安静当作「没配」。
 * 只取两个字段（`tokens.access_token` / `tokens.account_id`），其余一概不碰。
 * @param {string} path - auth.json 路径。
 * @returns {{accessToken:string,accountId:string|undefined}|undefined} 读不到时 undefined。
 */
export function readCodexAuth(path) {
  const parsed = readJsonFile(path)
  const tokens = parsed?.tokens
  if (tokens === undefined || tokens === null || typeof tokens !== 'object') return undefined
  const accessToken = stringOrUndefined(tokens.access_token)
  if (accessToken === undefined) return undefined
  return { accessToken, accountId: stringOrUndefined(tokens.account_id) }
}

/**
 * Opencode（sst/opencode）Go 套餐额度接口：**只有百分比**。
 *
 * **核验来源**：`packages/core/src/usage-limits.ts` 的 `readGo()` 里
 * `HttpClientRequest.get(`${new URL(server).origin}/zen/go/v1/usage`)`，
 * 头是 `bearerToken(credential.access|key)` + `x-opencode-org-id: <workspaceID>`。
 * server 默认 `https://opencode.ai/console`（`packages/core/src/console-access.ts`
 * 的 `defaultServer`），`new URL(...).origin` 因此是 `https://opencode.ai`。
 * https://github.com/sst/opencode/blob/dev/packages/core/src/usage-limits.ts
 *
 * 响应形状（同文件 `GoUsage` / `GoMeter`）：
 *
 *     { "usage": { "rolling": { "status": "ok"|"rate-limited", "percent": 12.5, "resetsAt": "2026-11-20T…" },
 *                  "weekly":  { … }, "monthly": { … } } }
 *
 * 403 有确定含义：**该 workspace 没订 Go**（代码里 `status === 403 → undefined`），
 * 不是错误，因此调用方把它当作「没有这个窗口」而不是失败。
 */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** Opencode Go 额度接口路径。 */
export const OPENCODE_GO_USAGE_PATH = '/zen/go/v1/usage'

/**
 * Opencode Console 的预算接口：**绝对值**（美元上限与已花）。
 *
 * **核验来源**：`readBudgets()` → `GET ${server}/api/policies/current-budgets`，
 * 头同 ConsoleAccess：`Authorization: Bearer <key|oauth access>` +
 * `x-org-id: <workspaceID>`（`packages/core/src/console-access.ts`）。
 * 403 是服务账号 Key 的正常情况（代码里 `403 → []`）。
 *
 * 响应是一个数组，每项 `{ ruleID, limitDollars, spentDollars, scope, per, coverage,
 * models, vendors, resetsAt }`（见同文件 `ConsoleBudget`）。
 */
export const OPENCODE_BUDGETS_URL = 'https://opencode.ai/console/api/policies/current-budgets'

/** Opencode 预算接口路径。 */
export const OPENCODE_BUDGETS_PATH = '/console/api/policies/current-budgets'

/** Opencode Console（登录、查看用量与充值）。 */
export const OPENCODE_KEY_URL = 'https://opencode.ai/console'

/** 端点的核验出处。 */
export const OPENCODE_EVIDENCE_URL = 'https://github.com/sst/opencode/blob/dev/packages/core/src/usage-limits.ts'

/**
 * Opencode 的凭据引用名。
 *
 * 既可以是 Console 的 **API Key**（`ocgw_` 开头这类），也可以是 OAuth access
 * （`Credential.OAuth` 的 `access`）——两者在 `ConsoleAccess.headers()` 里是同一个
 * `Authorization: Bearer` 位置。这里只收显式名字 + provider 派生的
 * `<route>_API_KEY`（这条路线在 DSH 里是用户真能填进去的地方）。
 */
export const OPENCODE_KEY_ENVS = candidateRefs(
  ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY', 'OPENCODE_CONSOLE_KEY'],
  OPENCODE_ROUTES,
)

/**
 * Opencode 的 workspace id（请求头 `x-opencode-org-id` / `x-org-id`）。
 *
 * **两个接口都要求它**：Go 额度用 `x-opencode-org-id`，Console 预算用 `x-org-id`。
 * 没有它就只能回报「缺 workspace id」——现编一个只会得到 403，反而更难查。
 */
export const OPENCODE_WORKSPACE_ENVS = ['OPENCODE_WORKSPACE_ID', 'OPENCODE_ORG_ID']

/** 兼容旧名：第一候选。 */
export const OPENCODE_KEY_ENV = OPENCODE_KEY_ENVS[0]

/** Opencode 的 workspace id 第一候选。 */
export const OPENCODE_WORKSPACE_ENV = OPENCODE_WORKSPACE_ENVS[0]

/**
 * Opencode 的数据目录（`$XDG_DATA_HOME/opencode`，否则 `~/.local/share/opencode`）。
 *
 * 取自 `packages/util/src/global-roots.ts`：`data = XDG_DATA_HOME || ~/.local/share`，
 * 再拼应用名。历史版本的登录凭据就是这里的 `auth.json`
 * （`packages/core/src/database/migration/…_import_legacy_credentials.ts`）。
 */
export function opencodeAuthPath(env = process.env) {
  const configured = typeof env?.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim() !== ''
    ? env.XDG_DATA_HOME.trim()
    : undefined
  const base = configured ?? (homeOf(env) === undefined ? undefined : join(homeOf(env), '.local', 'share'))
  if (base === undefined) return ''
  return join(base, 'opencode', 'auth.json')
}

/**
 * 从 Opencode 的历史凭据文件里读 API Key 与 workspace id。
 *
 * 文件形状（V1 `auth.json`）是一个 `{ [providerID]: credential }` 映射，
 * credential 形如 `{ type: 'api'|'oauth', key|access, metadata: { orgID, server } }`。
 * 只认 `opencode` 这一条，并且**只读**。读不到返回 undefined（安静当作没配）。
 * @param {string} path - auth.json 路径。
 * @returns {{apiKey:string,workspaceId:string|undefined}|undefined} 读不到时 undefined。
 */
export function readOpencodeAuth(path) {
  const parsed = readJsonFile(path)
  const entry = parsed?.opencode
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
  const apiKey = stringOrUndefined(entry.key) ?? stringOrUndefined(entry.access)
  if (apiKey === undefined) return undefined
  const workspaceId = stringOrUndefined(entry.metadata?.orgID)
  return { apiKey, workspaceId }
}

/**
 * Cursor 的当前计费周期用量接口（Connect RPC，POST 空对象）。
 *
 * ## 核验级别：**社区逆向，非一方来源**
 *
 * Cursor 的 CLI 与客户端**不是开源的**，官方文档只公开了团队/企业的 Admin API
 * （`/teams/daily-usage-data` 一类，那是团队聚合用量，不是**个人套餐额度**），
 * 因此这个端点没有「开源代码或官方文档」可依。
 *
 * 它的依据是两个**互相独立**的开源实现给出了一致的地址、鉴权头与响应字段：
 *   1. `rarf/hermes-quota-plugin` 的 `quota_providers/cursor.py`（注释写明这是
 *      `cursor-agent` CLI 自己在调的两个 Connect RPC，并附了观测到的响应样本）；
 *   2. `PowerUserZ/OpenTokenUsage` 的 `docs/providers/cursor.md`（同一个
 *      `aiserver.v1.DashboardService` 服务与 `GET/POST` 说明）。
 * https://github.com/rarf/hermes-quota-plugin/blob/master/quota_providers/cursor.py
 *
 * **因此这条适配器的 `verification` 标成 `community`**，界面会明确写「未核验到
 * 官方来源」。产品里只解析这两份实现都点到的字段，其余一律留 `—`。
 */
export const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'

/** Cursor 用量接口路径（Connect RPC，POST `{}`）。 */
export const CURSOR_USAGE_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage'

/** Cursor 控制台（查看用量与套餐）。 */
export const CURSOR_KEY_URL = 'https://cursor.com/dashboard'

/** 端点的核验出处（社区实现）。 */
export const CURSOR_EVIDENCE_URL = 'https://github.com/rarf/hermes-quota-plugin/blob/master/quota_providers/cursor.py'

/**
 * Cursor 的凭据引用名：CLI/桌面端登录态 access token（短时 JWT）。
 *
 * 过期的表现是 401，需要用户在 Cursor 里重新登录（`cursor-agent login`）。
 * 本插件**不做 refresh**：那要往另一个 App 的凭据存储里写，越权了。
 */
export const CURSOR_TOKEN_ENVS = ['CURSOR_ACCESS_TOKEN', 'CURSOR_SESSION_TOKEN']

/** 兼容旧名：第一候选。 */
export const CURSOR_TOKEN_ENV = CURSOR_TOKEN_ENVS[0]

/**
 * Cursor 登录凭据文件的**候选路径**（按平台，取自上面那两份实现）。
 *
 * CLI 把会话存在 `~/.cursor/auth.json`（macOS）、`$XDG_CONFIG_HOME/cursor/auth.json`
 * （Linux）、`%APPDATA%\Cursor\auth.json`（Windows），键名 `accessToken`。
 * 桌面端还存在 SQLite（`state.vscdb`）——**本插件不读它**：读 SQLite 要么引第三方
 * 依赖、要么自己写二进制解析器，两者都不划算（本项目零依赖）。
 * @param {object} [env] - 环境变量来源。
 * @returns {string[]} 候选路径（去重、保持优先级）。
 */
export function cursorAuthPaths(env = process.env) {
  const home = homeOf(env)
  const out = []
  const appdata = typeof env?.APPDATA === 'string' && env.APPDATA.trim() !== '' ? env.APPDATA.trim() : ''
  const xdgConfig = typeof env?.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim() !== ''
    ? env.XDG_CONFIG_HOME.trim()
    : ''
  if (appdata !== '') out.push(join(appdata, 'Cursor', 'auth.json'))
  if (home !== undefined) out.push(join(home, '.cursor', 'auth.json'))
  if (xdgConfig !== '') out.push(join(xdgConfig, 'cursor', 'auth.json'))
  return [...new Set(out)]
}

/**
 * 从 Cursor 的 auth.json 里读 access token。只读，读失败安静当成没配。
 * @param {string} path - auth.json 路径。
 * @returns {string|undefined} token；读不到时 undefined。
 */
export function readCursorAuth(path) {
  const parsed = readJsonFile(path)
  return stringOrUndefined(parsed?.accessToken) ?? stringOrUndefined(parsed?.access_token)
}

/**
 * 读一个 JSON 文件（**只读**，失败一律安静返回 undefined）。
 *
 * 三家的自动发现都走这里。刻意不抛错：这些文件属于**别的 App**，
 * 读不到是常态（没装、没登录、权限不同），不该让一家厂商的卡片变成错误态。
 * @param {string} path - 绝对路径。
 * @returns {object|undefined} 解析结果；不存在或读不懂时 undefined。
 */
function readJsonFile(path) {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 「移除凭据」的清单：每一家要动哪些引用名。
 *
 * ## 为什么是**推导**出来的，而不是手抄一张表
 *
 * 移除功能最不能出的错是「漏掉一个候选名」：用户点了移除，那家照样能解析到 Key，
 * 界面却显示「已移除」。手抄一张表迟早会与 {@link candidateRefs} 漂移——两者
 * 表达的是同一组事实。
 *
 * 因此这里**直接调用各家解析时用的那个函数**，把候选名接出来。于是
 * 「插件会去试的名字」与「移除按钮会删的名字」在构造上就是同一个集合，
 * 不存在只改一边的可能。
 */

/** 各家解析凭据时实际会试的引用名（顺序即优先级）。 */
const VENDOR_REF_NAMES = Object.freeze({
  zhipu: ZHIPU_KEY_ENVS,
  commandcode: COMMAND_CODE_KEY_ENVS,
  volcengine: Object.freeze([...VOLC_AK_ENVS, ...VOLC_SK_ENVS]),
  codex: Object.freeze([...CODEX_TOKEN_ENVS, ...CODEX_ACCOUNT_ENVS]),
  cursor: CURSOR_TOKEN_ENVS,
  opencode: Object.freeze([...OPENCODE_KEY_ENVS, ...OPENCODE_WORKSPACE_ENVS]),
})

/**
 * 某个引用名对这家厂商意味着什么。
 *
 * 认不出的名字**照实说认不出**，不编一个用途出来——清单里出现的每一个名字都会
 * 显示在用户眼前，编出来的说明就是一条假信息。
 * @param {string} id - 厂商 id。
 * @param {string} ref - 引用名。
 * @returns {string} 说明。
 */
function refPurposeOf(id, ref) {
  const known = {
    ZHIPU_CODING_API_KEY: '编程套餐专属 Key（插件优先用这一把）',
    ZHIPU_API_KEY: '智谱平台 Key（与编程套餐不通用）',
    BIGMODEL_API_KEY: '智谱平台 Key 的另一种写法',
    COMMAND_CODE_API_KEY: 'Command Code 工作台里创建的 API Key',
    COMMANDCODE_API_KEY: '同一把 Key，按 provider 路由名派生的引用名',
    CMD_API_KEY: '按 provider 路由名 `cmd` 派生的引用名',
    VOLC_ACCESS_KEY_ID: 'AccessKey ID（控制面签名用，不是 ark- 推理 Key）',
    VOLCENGINE_ACCESS_KEY_ID: 'AccessKey ID 的另一种写法',
    VOLC_SECRET_ACCESS_KEY: 'Secret Access Key（与 AK 成对）',
    VOLCENGINE_SECRET_ACCESS_KEY: 'Secret Access Key 的另一种写法',
    CODEX_ACCESS_TOKEN: 'Codex 的 ChatGPT 登录态 access token（JWT，不是 sk- 平台 Key）',
    OPENAI_CODEX_ACCESS_TOKEN: '同一把 Codex access token 的另一种写法',
    CODEX_ACCOUNT_ID: 'Codex 的 workspace / 账号 id（请求头 chatgpt-account-id）',
    CHATGPT_ACCOUNT_ID: '同一个账号 id 的通用写法',
    CURSOR_ACCESS_TOKEN: 'Cursor 登录态 access token（短时 JWT，过期需重新登录）',
    CURSOR_SESSION_TOKEN: '同一把 Cursor token 的另一种写法',
    OPENCODE_API_KEY: 'OpenCode Console 的 API Key（或 OAuth access token）',
    OPENCODE_ZEN_API_KEY: 'OpenCode Zen 的 Key（与 Console Key 同一个鉴权位置）',
    OPENCODE_CONSOLE_KEY: 'OpenCode Console Key 的另一种写法',
    OPENCODE_WORKSPACE_ID: 'OpenCode Console 的 workspace id（请求头 x-opencode-org-id）',
    OPENCODE_ORG_ID: '同一个 workspace id 的另一种写法（预算接口用 x-org-id）',
  }
  if (Object.hasOwn(known, ref)) return known[ref]
  // 派生名：`<路由名>_API_KEY`。反推回路由名比留空更有用。
  if (ref.endsWith('_API_KEY')) {
    return `按 provider 路由名派生的引用名（${ref.slice(0, -'_API_KEY'.length)}）`
  }
  return ''
}

/** 厂商显示名（与各家 `base.name` 一致）。 */
const VENDOR_NAMES = Object.freeze({
  zhipu: '智谱 GLM Coding Plan',
  commandcode: 'Command Code',
  volcengine: '火山方舟 Coding Plan',
  codex: 'Codex（ChatGPT 套餐）',
  cursor: 'Cursor',
  opencode: 'Opencode',
})

/** 全部厂商 id（顺序即界面默认顺序：先老三家，再新三家）。 */
export const PLAN_VENDOR_IDS = Object.freeze(['zhipu', 'commandcode', 'volcengine', 'codex', 'cursor', 'opencode'])

/**
 * 「移除凭据」要动哪些引用名——**由各家的候选名推导**，不手抄。
 *
 * 移除功能最不能出的错是「漏掉一个候选名」：用户点了移除，那家照样能解析到 Key，
 * 界面却显示「已移除」。因此这里直接取各家解析时用的那份候选名列表
 * （{@link ZHIPU_KEY_ENVS} / {@link COMMAND_CODE_KEY_ENVS} / {@link VOLC_AK_ENVS}
 * + {@link VOLC_SK_ENVS} / {@link CODEX_TOKEN_ENVS} 等），于是「插件会试的名字」
 * 与「移除会删的名字」在构造上就是同一个集合，不存在只改一边的可能。
 *
 * `files` 是各家**本机凭据文件**的候选路径（只读、不删）：界面必须把它们列出来，
 * 否则用户清完凭据文件里那把之后，插件照样能从别的 App 的文件里读到，界面上却是
 * 「未配」——自相矛盾。只读不写，因此没有 `removable`。
 * @param {object} [env] - 环境变量来源（路径推导用；缺省 process.env）。
 * @returns {Array<{id:string,name:string,refs:Array<{name:string,purpose:string}>,cliFile:boolean,files:Array<{path:string,note:string}>}>} 清单。
 */
export function planVendorInventory(env = process.env) {
  const cliFileVendors = new Set(['commandcode'])
  return PLAN_VENDOR_IDS.map((id) => ({
    id,
    name: VENDOR_NAMES[id],
    refs: VENDOR_REF_NAMES[id].map((ref) => ({ name: ref, purpose: refPurposeOf(id, ref) })),
    // Command Code 的 Key 还可能来自**另一个 App 的密钥文件**。它必须在清单里：
    // 不列出来，用户移除完文件里的那把之后插件照样读得到 CLI 那把，
    // 界面上却是「未配」——自相矛盾。
    cliFile: cliFileVendors.has(id),
    files: credentialFilesOf(id, env),
  }))
}

/**
 * 某一家**自动发现**会读的本机凭据文件（只读、不删）。
 *
 * Codex / Cursor / Opencode 都靠读它们自己 CLI 的登录态工作，所以这些路径是
 * 「为什么没配凭据也能查到额度」的答案，必须能在界面上看到。
 * @param {string} id - 厂商 id。
 * @param {object} [env] - 环境变量来源。
 * @returns {Array<{path:string,note:string}>} 文件说明（没有自动发现的家返回空数组）。
 */
function credentialFilesOf(id, env = process.env) {
  const files = []
  const add = (path, note) => {
    // 推不出主目录时路径是空串：**不列出来**（列一个空路径只会让人困惑），
    // 自动发现也随之跳过——见 homeOf 的注释。
    if (typeof path === 'string' && path !== '') files.push({ path, note })
  }
  if (id === 'commandcode') {
    add(commandCodeAuthPath(env),
      'Command Code CLI 的登录文件（另一个 App 的密钥文件，插件只读不写、不会删除它）')
  } else if (id === 'codex') {
    add(codexAuthPath(env),
      'Codex CLI 的登录文件；插件只读它的 tokens.access_token / tokens.account_id，不写、不删')
  } else if (id === 'cursor') {
    for (const path of cursorAuthPaths(env)) {
      add(path, 'Cursor CLI 的登录文件（accessToken）；插件只读，不写、不删。桌面端的 SQLite 存储不读')
    }
  } else if (id === 'opencode') {
    add(opencodeAuthPath(env),
      'Opencode 历史版本的登录文件（auth.json）；插件只读 opencode 那一条，不写、不删')
  }
  // 智谱与火山没有官方 CLI 凭据文件：空数组如实表达「没有可自动发现的来源」。
  return files
}

/**
 * 凭据来源层 → 给用户看的一句话。
 *
 * 这一层**必须显示出来**：用户点「移除」之后那家还是「已配置」时，唯一能解释
 * 为什么的就是来源层——是启动时的环境变量（插件改不了），还是 `.env` 回落层
 * （`unset` 动不了它），或者根本是另一个 App 的文件。
 */
export const CREDENTIAL_SOURCE_LABELS = Object.freeze({
  env: '启动 dsh 时的环境变量（插件改不了）',
  file: 'DSH 凭据文件',
  'project-env': '项目目录的 .env（插件改不了）',
  'user-env': '<DSH_HOME>/.env（插件改不了）',
  credentials: 'DSH 凭据服务',
  'file+cli': 'DSH 凭据文件 + CLI 文件',
})

/**
 * 把来源层 id 转成给用户看的说明。
 * @param {string|undefined} source - 来源层。
 * @returns {string} 说明；认不出时原样返回，读不到时是空串。
 */
export function credentialSourceLabel(source) {
  if (typeof source !== 'string' || source === '') return ''
  return CREDENTIAL_SOURCE_LABELS[source] ?? source
}

/**
 * 这一层提供的凭据**能不能**通过 `credentials.unset` 真正移除。
 *
 * ## 为什么必须按层判断，而不是「有 credentials 服务就能删」
 *
 * DSH 的解析优先级是 `环境变量 > 凭据文件 > 项目 .env > <DSH_HOME>/.env`，而
 * `unset` **只动凭据文件那一层**。于是「能不能删」分成三种，混成一种就会撒谎：
 *
 * | 来源层 | `unset` 的实际效果 | 界面该说什么 |
 * |---|---|---|
 * | `env`（启动时环境变量） | **抛错**（上游显式拒绝这次写入） | 让用户去 shell 里取消 |
 * | `file`（凭据文件） | 真正删掉那一行 | 可以移除 |
 * | `project-env` / `user-env`（`.env` 回落层） | **静默空操作**：删一行不存在的记录，解析照样回落到该 `.env` | **不可移除**，让用户去改 `.env` |
 *
 * 第三行是最阴的一种：不报错、不抛异常，删完那家照样是「已配置」。所以这里
 * 直接把它判成不可移除，界面如实显示原因——而不是画一个必然无效的勾选框。
 * @param {string|undefined} source - resolve 回报的来源层。
 * @returns {boolean} 是否可移除。
 */
export function removableOf(source) {
  return source === 'file' || source === 'credentials'
}

/**
 * 不可移除时给用户的一句「那该怎么办」。
 * @param {string|undefined} source - resolve 回报的来源层。
 * @returns {string} 原因与出路；认得出但可移除时是空串。
 */
export function blockedReasonOf(source) {
  if (source === 'env') {
    return '这一条来自启动 dsh 时的环境变量，插件改不了：'
      + '请在启动 dsh 的终端 / 脚本里取消它（或从 <DSH_HOME>/.env 里删掉后重启 dsh）。'
  }
  if (source === 'project-env' || source === 'user-env') {
    return `这一条来自 .env 回落层（${credentialSourceLabel(source)}），`
      + '不在插件能改的凭据文件里：请自己编辑那个 .env 文件，改完重启 dsh。'
  }
  return ''
}

/** 单次上游请求超时。 */
export const REQUEST_TIMEOUT_MS = 12_000

/** 额度缓存有效期：额度变化比余额频繁，取 30 秒。 */
export const PLANS_TTL_MS = 30_000

/** 响应体上限，防止异常响应撑爆内存。 */
const MAX_RESPONSE_BYTES = 128 * 1024

/**
 * 窗口种类 → 中文名。
 * `fiveHour` / `weekly` / `monthly` 各家通用，智谱没有 `monthly`。
 *
 * `budget` 是新增的一种：Opencode 的 Console 预算是**按模型集合划的月度金额上限**，
 * 与 Go 套餐那三个滚动窗口是两笔不同的账，混成一个 `monthly` 会把两种口径叠在
 * 同一个进度条上——因此单列一种，标签也由宿主按规则名给。
 */
export const WINDOW_LABELS = {
  fiveHour: '5 小时',
  weekly: '每周',
  monthly: '每月',
  budget: '预算',
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
  const configured = typeof env?.COMMANDCODE_HOME === 'string' && env.COMMANDCODE_HOME.trim() !== ''
    ? env.COMMANDCODE_HOME.trim()
    : undefined
  const home = configured ?? (homeOf(env) === undefined ? undefined : join(homeOf(env), '.commandcode'))
  if (home === undefined) return ''
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

/**
 * Codex 的窗口长度（秒）→ 本插件的窗口种类。
 *
 * **必须按长度判，不能按 primary/secondary 的位置判。** 上游代码里 primary 既出现过
 * 3600 秒也出现过 18000 秒（`rate_limits` 的测试样本两种都有），按位置猜会把
 * 「5 小时额度」标成「每小时」。
 * @param {number|undefined} seconds - `limit_window_seconds`。
 * @returns {{window:string,label:string}|undefined} 窗口种类与标签；读不出时 undefined。
 */
function codexWindowOf(seconds) {
  const value = numberOrUndefined(seconds)
  if (value === undefined || value <= 0) return undefined
  const minutes = Math.round(value / 60)
  if (minutes === 300) return { window: 'fiveHour', label: WINDOW_LABELS.fiveHour }
  if (minutes === 10080) return { window: 'weekly', label: WINDOW_LABELS.weekly }
  if (minutes === 60) return { window: 'hourly', label: '每小时' }
  // 认不出的长度**照实显示长度本身**，不硬塞进某个已知窗口：
  // 把它塞进「每周」会让用户按错误的窗口安排工作。
  if (minutes % 1440 === 0) return { window: `window${minutes}`, label: `${minutes / 1440} 天` }
  if (minutes % 60 === 0) return { window: `window${minutes}`, label: `${minutes / 60} 小时` }
  return { window: `window${minutes}`, label: `${minutes} 分钟` }
}

/**
 * 解析 Codex 的 `/wham/usage` 响应。
 *
 * 形状见 {@link CODEX_USAGE_URL} 的注释。三条硬规则：
 *   1. 只有 `used_percent`，**没有绝对值**——因此窗口标 `percentOnly`，
 *      界面说明「官方只给百分比」，不假装精确；
 *   2. `reset_at` 是**秒**，其余时间戳语义都走 {@link normalizeEpoch}；
 *   3. `rate_limit.limit_reached === true` 时标 `exceeded`（额度已耗尽），
 *      这是官方给的最强信号，不能因为百分比没到 100 就不显示。
 * @param {object} payload - 响应体。
 * @returns {{windows:object[],unparsed:number,plan:string}} 归一结果。
 */
export function parseCodexUsage(payload) {
  const limit = payload?.rate_limit ?? payload?.rateLimit ?? {}
  const windows = []
  let unparsed = 0
  const limitReached = limit?.limit_reached === true || limit?.limitReached === true

  for (const key of ['primary_window', 'secondary_window']) {
    const raw = limit?.[key] ?? limit?.[key.replace(/_([a-z])/g, (_all, char) => char.toUpperCase())]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'object') {
      unparsed += 1
      continue
    }
    const slot = codexWindowOf(raw.limit_window_seconds ?? raw.limitWindowSeconds)
    if (slot === undefined) {
      // 没有窗口长度就没法说清「这是多久的额度」：宁可少显示一个窗口，也不猜。
      unparsed += 1
      continue
    }
    windows.push(buildWindow({
      window: slot.window,
      label: slot.label,
      usedPercent: numberOrUndefined(raw.used_percent ?? raw.usedPercent),
      resetAt: normalizeEpoch(raw.reset_at ?? raw.resetAt),
      exceeded: limitReached,
      source: 'codex',
    }))
  }

  const planType = stringOrUndefined(payload?.plan_type ?? payload?.planType) ?? ''
  return { windows, unparsed, plan: codexPlanLabel(planType) }
}

/**
 * Codex 的 `plan_type` → 展示名。
 *
 * 取值表来自 `codex-rs/backend-client/src/client.rs` 里 `map_plan_type()` 的分支
 * （free/plus/pro/…/team/enterprise）。认不出的值**原样显示**，不猜档位。
 * @param {string} planType - 原始取值。
 * @returns {string} 展示名；空串表示上游没给。
 */
function codexPlanLabel(planType) {
  const text = String(planType ?? '').trim().toLowerCase()
  if (text === '') return ''
  const known = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    promax: 'Pro Max',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edtech: 'Edu',
    edu: 'Edu',
    eduplus: 'Edu Plus',
    edupro: 'Edu Pro',
    sci: 'Sci',
    sciplus: 'Sci Plus',
  }
  return known[text] ?? planType
}

/**
 * 解析 Opencode 的 Go 套餐额度（`/zen/go/v1/usage`）。
 *
 * 三个窗口都只有 `percent`（0–100），因此标 `percentOnly`。
 * `status === 'rate-limited'` 是官方「已拒绝新请求」的说法，换算成 `exceeded`——
 * 它可能发生在百分比还没到 100 的时候，所以不能只看数字。
 *
 * 时间戳是 **ISO 日期串**（`Schema.DateFromString`），因此走 {@link normalizeEpoch}
 * 的第二条分支；数字与串两种形状它都认。
 * @param {object} payload - 响应体。
 * @returns {{windows:object[],unparsed:number}} 归一结果。
 */
export function parseOpencodeGo(payload) {
  const usage = payload?.usage ?? {}
  const windows = []
  let unparsed = 0
  const slots = [
    ['rolling', 'fiveHour', '5 小时滚动'],
    ['weekly', 'weekly', WINDOW_LABELS.weekly],
    ['monthly', 'monthly', WINDOW_LABELS.monthly],
  ]
  for (const [key, window, label] of slots) {
    const meter = usage?.[key]
    if (meter === null || meter === undefined) continue
    if (typeof meter !== 'object') {
      unparsed += 1
      continue
    }
    const percent = numberOrUndefined(meter.percent)
    if (percent === undefined) {
      unparsed += 1
      continue
    }
    windows.push(buildWindow({
      window,
      label,
      usedPercent: percent,
      resetAt: normalizeEpoch(meter.resetsAt),
      exceeded: meter.status === 'rate-limited',
      source: 'opencode',
    }))
  }
  return { windows, unparsed }
}

/**
 * 解析 Opencode 的 Console 预算（`/console/api/policies/current-budgets`）。
 *
 * 与 Go 那三个窗口是**两种口径**：这里是**绝对值**（美元上限与已花），
 * 因此用过/上限算百分比，并在 `note` 里写清覆盖范围（全部模型 / 指定模型、
 * 个人 / 全员共享）——只报一个百分比会让用户以为它和 Go 的额度是一回事。
 *
 * 字段名逐个来自 `packages/core/src/usage-limits.ts` 的 `ConsoleBudget`。
 * @param {object} payload - 响应体（一个数组）。
 * @returns {{windows:object[],unparsed:number}} 归一结果。
 */
export function parseOpencodeBudgets(payload) {
  const list = Array.isArray(payload) ? payload : []
  const windows = []
  let unparsed = 0
  for (const item of list) {
    if (item === null || typeof item !== 'object') {
      unparsed += 1
      continue
    }
    const total = numberOrUndefined(item.limitDollars)
    const used = numberOrUndefined(item.spentDollars)
    if (total === undefined && used === undefined) {
      unparsed += 1
      continue
    }
    const scope = item.scope === 'combined' ? '全员共享' : '每人各自'
    const coverage = item.coverage === 'all' ? '全部模型' : '指定模型'
    windows.push(buildWindow({
      window: 'budget',
      // 规则 id 由官方给，直接拿来区分多个预算；给不出就退回「预算」。
      label: stringOrUndefined(item.ruleID) === undefined
        ? WINDOW_LABELS.budget
        : `${WINDOW_LABELS.budget} · ${stringOrUndefined(item.ruleID)}`,
      used,
      total,
      resetAt: normalizeEpoch(item.resetsAt),
      note: `${coverage} · ${scope}（Console 预算，单位美元）`,
      source: 'opencode',
    }))
  }
  return { windows, unparsed }
}

/**
 * 解析 Cursor 的当前计费周期用量（`GetCurrentPeriodUsage`）。
 *
 * **只解析两份社区实现都点到的字段**（见 {@link CURSOR_USAGE_URL} 的核验说明）：
 *   - `planUsage.totalPercentUsed`：本计费周期**已用百分比**（最权威的那一个）；
 *   - `planUsage.limit` / `planUsage.remaining`：仅在官方没给百分比时用于反算；
 *   - `billingCycleEnd`：**毫秒**时间戳（字符串或数字）；
 *   - `spendLimitUsage.individualUsed` / `individualLimit`：按需付费的**自身上限**
 *     （额度用尽后的第二道闸），有就给一条绝对值窗口。
 *
 * 刻意**不取** `autoPercentUsed` / `apiPercentUsed`：那是 Cursor 自己的两种模式细分，
 * 与本插件「还剩多少」的口径不同，摆进来会变成第三个互相矛盾的百分比。
 * @param {object} payload - 响应体。
 * @returns {{windows:object[],unparsed:number,plan:string}} 归一结果。
 */
export function parseCursorUsage(payload) {
  const planUsage = payload?.planUsage ?? {}
  const windows = []
  let unparsed = 0
  const resetAt = normalizeEpoch(payload?.billingCycleEnd)

  const totalPercent = numberOrUndefined(planUsage.totalPercentUsed)
  const limit = numberOrUndefined(planUsage.limit)
  const remaining = numberOrUndefined(planUsage.remaining)
  let usedPercent = totalPercent
  let note
  if (usedPercent === undefined) {
    // 没有百分比时只在**两者都在**的情况下反算；只有一半时留空（显示 —）。
    if (limit !== undefined && remaining !== undefined && limit > 0) {
      usedPercent = ((limit - remaining) / limit) * 100
      note = '百分比按「上限 − 剩余」反算（官方没直接给）'
    } else {
      unparsed += 1
    }
  }
  if (usedPercent !== undefined) {
    windows.push(buildWindow({
      window: 'monthly',
      label: '本计费周期',
      usedPercent,
      resetAt,
      note,
      source: 'cursor',
    }))
  }

  const spend = payload?.spendLimitUsage
  if (spend !== null && spend !== undefined && typeof spend === 'object') {
    const used = numberOrUndefined(spend.individualUsed)
    const cap = numberOrUndefined(spend.individualLimit)
    // 只在**上限 > 0** 时画：上限为 0 表示「没开按需付费」，那不是「已用满」。
    if (cap !== undefined && cap > 0) {
      windows.push(buildWindow({
        window: 'budget',
        label: '按需付费上限',
        used,
        total: cap,
        resetAt,
        note: '额度用尽后的按需上限（单位：美分，照官方口径显示）',
        source: 'cursor',
      }))
    }
  }

  return { windows, unparsed, plan: '' }
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
 * 把重置时刻归一成毫秒时间戳。**两种形状都要认**。
 *
 * 1) 数字（或纯数字字符串）：小于 1e12 视作**秒**，否则是毫秒。
 *    智谱 `nextResetTime`、火山 `ResetTime`（毫秒）/ `ResetTimestamp`（秒）、
 *    Command Code 的 5 小时与每周 `resetAt` 都是这种。
 * 2) **ISO 日期串**：Command Code 的订阅周期 `data.currentPeriodEnd` 给的是
 *    `"2026-10-14T12:26:13.000Z"` 这样的字符串。
 *
 * 第 2 条是补上的**真实缺陷**（用户报「看不出月额度多久后重置」）：早先这里只走
 * `numberOrUndefined`，ISO 串被 `Number()` 读成 `NaN` → 一律返回 undefined，
 * 于是月度窗口的 `resetAt` **静默丢失**——5 小时与每周照常倒计时，只有月度那一栏
 * 永远没有「多久后重置」。它不报错、也不显示 0，只是安静地少一句话，
 * 因此特别难被当成 bug 发现。
 *
 * 先试数字再试日期串是**必须的顺序**：纯数字字符串（如 `"1789880547252"`）交给
 * `Date.parse` 会得到一个荒唐的结果，而 `numberOrUndefined` 能正确认出它。
 * @param {unknown} value - 原始时间戳（数字 / 纯数字串 / ISO 日期串）。
 * @returns {number|undefined} 毫秒时间戳；认不出时 undefined。
 */
function normalizeEpoch(value) {
  const number = numberOrUndefined(value)
  if (number !== undefined) {
    if (number <= 0) return undefined
    // 小于 1e12 视作秒（2001 年之前的毫秒值没有实际意义）
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
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
    // 标签可以显式给（Codex 的窗口按真实长度算出来、Opencode 的预算按规则区分），
    // 缺省才退回窗口种类名。
    label: stringOrUndefined(input.label) ?? WINDOW_LABELS[input.window] ?? input.window,
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
      this.#readCodex(),
      this.#readCursor(),
      this.#readOpencode(),
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
   * 逐条查一份引用名现在的状态（**不含值**，只回报是否存在、来自哪一层、能不能写）。
   *
   * 一次 describe + 一次 resolve 都要发：`describe` 给 `writable`，`resolve` 给
   * **来源层**——而来源层恰恰是这里最要紧的一项，见 {@link removableOf}。
   * @param {string[]} names - 引用名。
   * @returns {Promise<Array<object>>} 逐条状态。
   */
  async #inspectRefs(names) {
    const credentials = this.credentials?.()
    const out = []
    for (const name of names) {
      /** @type {object} */
      const entry = {
        name,
        configured: false,
        source: '',
        sourceLabel: '',
        writable: false,
        hint: '',
        removable: false,
        blockedReason: '',
      }
      let hit
      if (credentials !== undefined) {
        try {
          hit = await credentials.resolve(name)
        } catch {
          // 引用名非法或存储读失败：当作「这一条查不到」，不让整份清单失败
          hit = undefined
        }
      }
      // 环境变量这一层由插件自己兜底读：宿主没有 credentials 服务时（老版本 /
      // 未挂载），套餐取数本身就是靠这条路工作的，清单必须与它同源。
      if (hit === undefined) {
        const ambient = this.env?.[name]
        if (typeof ambient === 'string' && ambient.trim() !== '') {
          hit = { value: ambient.trim(), source: 'env' }
        }
      }
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') {
        entry.configured = true
        entry.source = typeof hit.source === 'string' ? hit.source : 'credentials'
        entry.sourceLabel = credentialSourceLabel(entry.source)
        entry.hint = maskSecret(hit.value.trim())
      }
      let described
      if (credentials !== undefined) {
        try {
          described = await credentials.describe(name)
        } catch {
          described = undefined
        }
      }
      // DSH 报的「这一条能不能写」。**注意它不等于「能不能移除」**：
      // 对 `.env` 回落层 DSH 报 writable: true（存一个值确实会覆盖它），
      // 但 `unset` 对那一层是静默空操作。判据是 removable，不是这个。
      // 留着它只为诊断（用户问「为什么这条不行」时能看出 DSH 自己怎么看）。
      entry.writable = described?.writable === true
      entry.removable = entry.configured && removableOf(entry.source)
      entry.blockedReason = entry.configured && !entry.removable ? blockedReasonOf(entry.source) : ''
      out.push(entry)
    }
    return out
  }

  /**
   * 「移除凭据」面板要用的清单：每一家、每一条引用名现在的状态。
   *
   * 这是**只读**的：只查现状，不动任何东西。用户勾选之后才走
   * {@link removeCredentials}。
   *
   * 名字刻意**不叫 `credentials`**：构造函数里 `this.credentials` 存的是注入的
   * 凭据服务取值函数，同名方法会被那个实例字段整个盖掉——调用时拿到的是
   * 「凭据服务或 undefined」，而不是清单。症状是这条路由回一个空体，
   * 界面永远停在「读取失败」。
   * @returns {Promise<object>} 清单负载（**永不含凭据值**）。
   */
  async credentialInventory() {
    const inventory = planVendorInventory(this.env)
    const cliPath = this.commandCodeAuthFile ?? commandCodeAuthPath(this.env)
    const providers = []
    for (const vendor of inventory) {
      const refs = await this.#inspectRefs(vendor.refs.map((item) => item.name))
      // 把用途说明并回来（引用名是键，用途是本插件对它的解释）
      const purposeOf = new Map(vendor.refs.map((item) => [item.name, item.purpose]))
      for (const entry of refs) entry.purpose = purposeOf.get(entry.name) ?? ''
      /** @type {object|undefined} */
      let cliFile
      if (vendor.cliFile) {
        const hasKey = readCommandCodeKey(cliPath) !== undefined
        cliFile = {
          path: cliPath,
          present: existsSync(cliPath),
          hasKey,
          // 刻意**不提供删除**：那是另一个 App 的密钥文件，本插件一直只读不写。
          // 但它必须出现在清单里，否则用户清完文件里的那把之后，插件照样能读到
          // CLI 那把，界面上却是「未配」——自相矛盾。
          note: '另一个 App（Command Code CLI）的密钥文件。本插件只读不写，'
            + '不会删除它；要彻底移除请自己编辑该文件。',
        }
      }
      // 全部家的**自动发现文件**都列出来（只读、不删）：这是「为什么我没配凭据
      // 也能看到额度」的答案，也是「配了/没配」判断的另一半。
      const files = vendor.files.map((item) => ({
        path: item.path,
        present: existsSync(item.path),
        note: item.note,
      }))
      providers.push({
        id: vendor.id,
        name: vendor.name,
        refs,
        files,
        ...(cliFile === undefined ? {} : { cliFile }),
      })
    }
    return {
      providers,
      credentialFile: resolveCredentialFilePath(this.env),
      // 宿主有没有可写的凭据服务。「没有」时界面必须说清「这台机器上改不了」，
      // 而不是把每个勾选框都画出来然后全部失败。
      writable: typeof this.credentials?.()?.unset === 'function',
    }
  }

  /**
   * 移除用户**明确勾选**的凭据引用。
   *
   * ## 三条必须守住的规则
   *
   * 1. **只删白名单里的名字。** 逐条对照 {@link planVendorInventory}——这条路由
   *    能从浏览器被调用，只凭一个字符串就去删任意环境变量是危险的。
   * 2. **删完必须复核。** `unset` 对「由 `.env` 供值」的引用是**静默空操作**
   *    （见 {@link removableOf}）：它删掉一行本来就不存在的记录，然后解析照样
   *    回落到那个 `.env`。不复核就会把「什么都没变」报成「已移除」。
   * 3. **逐条回报结果**，不合并成一句「成功」。用户勾了三条、其中一条来自启动
   *    环境变量，就必须只把那一条标成失败并说明原因。
   * @param {string[]} names - 用户勾选的引用名。
   * @returns {Promise<object>} 逐条结果 + 复核后的清单。
   */
  async removeCredentials(names) {
    const requested = Array.isArray(names) ? names.filter((name) => typeof name === 'string') : []
    const allowed = new Set(planVendorInventory().flatMap((vendor) => vendor.refs.map((item) => item.name)))
    const credentials = this.credentials?.()
    const results = []
    for (const name of requested) {
      if (!allowed.has(name)) {
        results.push({ name, ok: false, reason: 'not-allowed', message: '这个引用名不在本插件的凭据清单里，拒绝改动。' })
        continue
      }
      if (typeof credentials?.unset !== 'function') {
        results.push({ name, ok: false, reason: 'no-service', message: '宿主没有可写的凭据服务，无法移除。' })
        continue
      }
      try {
        await credentials.unset(name)
      } catch (error) {
        // 最典型的一种：由**启动时的环境变量**供值，写会被显式拒绝（见 DSH 的
        // credentials-local：assertUnshadowed）。照实把上游那句人话带出来。
        results.push({
          name,
          ok: false,
          reason: 'rejected',
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      // 复核：删的是不是**真正在供值**的那一层
      const after = (await this.#inspectRefs([name]))[0]
      if (after.configured) {
        results.push({
          name,
          ok: false,
          reason: 'still-configured',
          source: after.source,
          sourceLabel: after.sourceLabel,
          message: after.blockedReason === ''
            ? `移除后仍然能读到这一条（现在来自「${after.sourceLabel || after.source}」），请到那一层手动删除。`
            : after.blockedReason,
        })
        continue
      }
      results.push({ name, ok: true, reason: 'removed', message: '已移除。' })
    }
    // 删完之后让缓存失效：下一次读必须是一次真实的凭据解析，
    // 而不是端上一份「移除前」的旧快照。
    this.invalidate()
    return { results, credentials: await this.credentialInventory() }
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
      // 智谱的 quota 接口没有公开文档、也没有可读的开源实现：核验级别是社区。
      shape: 'percent',
      verification: 'community',
      evidence: ZHIPU_KEY_URL,
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
        shape: 'percent',
        evidence: ZHIPU_KEY_URL,
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
      // 三个接口拼出三个窗口：5h/周给绝对值，月度只有剩余额（百分比靠另两个接口补）。
      shape: 'absolute',
      verification: 'community',
      evidence: COMMAND_CODE_KEY_URL,
      note: '',
      setup: setupOf({
        keyURL: COMMAND_CODE_KEY_URL,
        keyURLName: 'Command Code 工作台',
        acquire: [
          '在工作台里创建 API Key。',
          '已经装过 Command Code CLI 并登录过的话**不用手动配**：插件会自动读本机的凭据文件。',
        ],
        refs: [{ name: 'COMMAND_CODE_API_KEY', example: '...', note: '装过 CLI 时可留空' }],
        files: credentialFilesOf('commandcode', this.env),
        shape: 'absolute',
        evidence: COMMAND_CODE_KEY_URL,
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
      // Agent Plan 给绝对值，Coding Plan 只给百分比——两种形状并存，故标 mixed。
      shape: 'mixed',
      verification: 'community',
      evidence: VOLC_KEY_URL,
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
        shape: 'mixed',
        evidence: VOLC_KEY_URL,
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
   * Codex（ChatGPT 套餐）额度。
   *
   * 端点的核验与形状见 {@link CODEX_USAGE_URL}。这里是**只读另一个 App 的登录态**：
   * token 优先取凭据（`CODEX_ACCESS_TOKEN`），取不到才读 `$CODEX_HOME/auth.json`
   * 的 `tokens.access_token`——绝不写回、绝不 refresh（refresh 要写那个文件，越权）。
   *
   * `chatgpt-account-id` 也是必需的（`codex-rs/model-provider/src/runtime_auth.rs`
   * 的 `validate_runtime_selectors`：ChatGPT 身份的请求必须带它）。拿不到就不发请求，
   * 直接说清缺什么——瞎发只会得到 401，用户会以为 token 不对。
   * @returns {Promise<object>} 该家的结果。
   */
  async #readCodex() {
    const authFile = codexAuthPath(this.env)
    const base = {
      id: 'codex',
      name: VENDOR_NAMES.codex,
      docURL: CODEX_KEY_URL,
      endpoint: CODEX_USAGE_PATH,
      // Codex 的窗口不是「5 小时 + 每周」两种固定档：上游按 limit_window_seconds
      // 给，实测出现过 1 小时与 5 小时两种主窗口。这里只声明**认得的**两种，
      // 其余长度会以自身长度做标签显示（见 codexWindowOf）。
      supportedWindows: ['fiveHour', 'weekly'],
      shape: 'percent',
      verification: 'first-party',
      evidence: CODEX_EVIDENCE_URL,
      note: '官方只给「已用百分比」与重置时刻，没有绝对值。未文档化接口。',
      authFile,
      setup: setupOf({
        keyURL: CODEX_KEY_URL,
        keyURLName: 'Codex 登录与用量说明',
        acquire: [
          '装过 Codex CLI 并 `codex login` 登录过的话**不用手动配**：插件会自动读本机的 auth.json。',
          '手动配置要的是**登录态 access token**（auth.json 里的 tokens.access_token），不是 sk- 开头的平台 API Key——后者打这个端点只会 401。',
          '同时需要 workspace / 账号 id（auth.json 的 tokens.account_id），它要放进 chatgpt-account-id 请求头。',
        ],
        refs: [
          { name: 'CODEX_ACCESS_TOKEN', example: '(登录态 JWT)', note: 'ChatGPT 登录态 access token' },
          { name: 'CODEX_ACCOUNT_ID', example: '…', note: '仅当 auth.json 里读不到 account_id 时才需要' },
        ],
        files: credentialFilesOf('codex', this.env),
        shape: 'percent',
        evidence: CODEX_EVIDENCE_URL,
      }),
    }

    const token = await this.resolveKey(CODEX_TOKEN_ENVS)
    const fromFile = token === undefined ? readCodexAuth(authFile) : undefined
    const accessToken = token?.value ?? fromFile?.accessToken
    if (accessToken === undefined) {
      return {
        ...base,
        ok: false,
        reason: 'no-key',
        keyRef: CODEX_TOKEN_ENV,
        keyRefs: CODEX_TOKEN_ENVS,
        hint: '需要 Codex CLI 的登录态（本机 auth.json 或 CODEX_ACCESS_TOKEN）。'
          + '注意那不是 sk- 平台 Key。',
        windows: [],
      }
    }
    const configuredAccount = await this.resolveKey(CODEX_ACCOUNT_ENVS)
    const accountId = configuredAccount?.value ?? fromFile?.accountId
    if (accountId === undefined) {
      return {
        ...base,
        ok: false,
        reason: 'no-key',
        keyRef: CODEX_ACCOUNT_ENVS[0],
        keyRefs: CODEX_ACCOUNT_ENVS,
        keySource: token?.source ?? 'cli-file',
        keyHint: maskSecret(accessToken),
        hint: '拿到了 access token，但缺 workspace / 账号 id（auth.json 的 tokens.account_id 或 CODEX_ACCOUNT_ID）；'
          + '这个请求头不带会被上游拒掉。',
        windows: [],
      }
    }

    const response = await this.#requestJson(CODEX_USAGE_URL, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        // 与 Codex CLI 自己发的 UA 对齐（上游会看 UA 的客户端族）。
        'user-agent': 'codex-cli',
      },
    })
    const keyFields = {
      keyRef: token?.ref ?? '(auth.json)',
      keySource: token?.source ?? 'cli-file',
      keyHint: maskSecret(accessToken),
    }
    if (response.error !== undefined) {
      const rejected = response.status === 401 || response.status === 403
      return {
        ...base,
        ...keyFields,
        ok: false,
        reason: rejected ? 'rejected' : 'request-failed',
        error: response.error,
        ...(rejected
          ? { hint: 'Codex 的登录态过期或被拒：在终端里重新 `codex login`（或更新 CODEX_ACCESS_TOKEN）。' }
          : {}),
        windows: [],
      }
    }
    const parsed = parseCodexUsage(response.body)
    return {
      ...base,
      ...keyFields,
      ok: true,
      plan: parsed.plan,
      windows: parsed.windows,
      ...(parsed.unparsed > 0 ? { warning: `有 ${parsed.unparsed} 条额度记录无法识别（接口可能已变更）` } : {}),
    }
  }

  /**
   * Cursor 的套餐额度（**社区核验**，见 {@link CURSOR_USAGE_URL}）。
   *
   * 发的是 Connect RPC：`POST` 一个空对象 `{}`，`connect-protocol-version: 1`。
   * 401/403 表示登录态过期——Cursor 的 access token 是短时 JWT，只能由用户重新登录，
   * 本插件**不做 refresh**（那要写另一个 App 的凭据存储）。
   * @returns {Promise<object>} 该家的结果。
   */
  async #readCursor() {
    const paths = cursorAuthPaths(this.env)
    const base = {
      id: 'cursor',
      name: VENDOR_NAMES.cursor,
      docURL: CURSOR_KEY_URL,
      endpoint: CURSOR_USAGE_PATH,
      supportedWindows: ['monthly'],
      shape: 'percent',
      // 关键：Cursor 的 CLI/客户端不开源、官方也没有文档化这个接口，
      // 因此核验级别只能是 community，界面必须把这件事说出来。
      verification: 'community',
      evidence: CURSOR_EVIDENCE_URL,
      note: '官方只给「本计费周期已用百分比」；接口未文档化且未核验到一方来源（社区逆向），随时可能失效。',
      authFiles: paths,
      setup: setupOf({
        keyURL: CURSOR_KEY_URL,
        keyURLName: 'Cursor 控制台（用量与套餐）',
        acquire: [
          '装过 Cursor CLI 并登录过的话**不用手动配**：插件会读本机的 auth.json。',
          '手动配置要的是登录态 access token（JWT），不是 Cursor 控制台里的 API Key。',
          '这个接口是社区逆向出来的，官方没有公开文档；读不到或报 401 时先去 Cursor 里重新登录。',
        ],
        refs: [{ name: 'CURSOR_ACCESS_TOKEN', example: '(登录态 JWT)', note: 'Cursor 登录态 access token' }],
        files: credentialFilesOf('cursor', this.env),
        shape: 'percent',
        evidence: CURSOR_EVIDENCE_URL,
      }),
    }

    const token = await this.resolveKey(CURSOR_TOKEN_ENVS)
    let accessToken = token?.value
    let tokenSource = token?.source
    if (accessToken === undefined) {
      for (const path of paths) {
        const fromFile = readCursorAuth(path)
        if (fromFile !== undefined) {
          accessToken = fromFile
          tokenSource = 'cli-file'
          break
        }
      }
    }
    if (accessToken === undefined) {
      return {
        ...base,
        ok: false,
        reason: 'no-key',
        keyRef: CURSOR_TOKEN_ENV,
        keyRefs: CURSOR_TOKEN_ENVS,
        hint: '需要 Cursor 的登录态 access token（本机 auth.json 或 CURSOR_ACCESS_TOKEN）。'
          + '桌面端只把登录态放在 SQLite 里，插件不读它。',
        windows: [],
      }
    }

    const response = await this.#requestJson(CURSOR_USAGE_URL, {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'connect-protocol-version': '1',
      },
      body: '{}',
    }, 'POST')
    const keyFields = {
      keyRef: token?.ref ?? '(auth.json)',
      keySource: tokenSource ?? 'cli-file',
      keyHint: maskSecret(accessToken),
    }
    if (response.error !== undefined) {
      const rejected = response.status === 401 || response.status === 403
      return {
        ...base,
        ...keyFields,
        ok: false,
        reason: rejected ? 'rejected' : 'request-failed',
        error: response.error,
        ...(rejected
          ? { hint: 'Cursor 的登录态过期了：在 Cursor 里重新登录（cursor-agent login）后重试。' }
          : {}),
        windows: [],
      }
    }
    const parsed = parseCursorUsage(response.body)
    return {
      ...base,
      ...keyFields,
      ok: true,
      plan: parsed.plan,
      windows: parsed.windows,
      ...(parsed.unparsed > 0 ? { warning: `${parsed.unparsed} 个字段读不懂（接口可能已变更）` } : {}),
    }
  }

  /**
   * Opencode 的额度：Go 套餐（百分比 ×3）＋ Console 预算（美元绝对值）。
   *
   * 端点的核验与形状见 {@link OPENCODE_GO_USAGE_URL} 与 {@link OPENCODE_BUDGETS_URL}。
   * 两个接口**都要 workspace id**（分别是 `x-opencode-org-id` 与 `x-org-id`），
   * 没有它只能回报「缺 workspace id」。
   *
   * 两个接口各自 fail-soft：Go 返回 403 = 没订 Go（正常，不是错误）；
   * Console 预算返回 403 = 服务账号 Key（正常，返回空数组）。任一成功即可显示。
   * @returns {Promise<object>} 该家的结果。
   */
  async #readOpencode() {
    const authFile = opencodeAuthPath(this.env)
    const base = {
      id: 'opencode',
      name: VENDOR_NAMES.opencode,
      docURL: OPENCODE_KEY_URL,
      endpoint: OPENCODE_GO_USAGE_PATH,
      supportedWindows: ['fiveHour', 'weekly', 'monthly'],
      shape: 'mixed',
      verification: 'first-party',
      evidence: OPENCODE_EVIDENCE_URL,
      note: 'Go 套餐只有百分比；Console 预算是美元绝对值。两个接口都要 workspace id。未文档化接口（experimental）。',
      authFile,
      setup: setupOf({
        keyURL: OPENCODE_KEY_URL,
        keyURLName: 'OpenCode Console',
        acquire: [
          '在 OpenCode Console 里登录并（按需）订阅 Go；Key 在 Console 里创建。',
          '还需要 workspace id：它在 Console 的地址里（https://opencode.ai/console/<workspace-id>/…）。',
          '历史版本的 Opencode 会把登录态放在数据目录的 auth.json 里，插件会自动读（只读）。',
        ],
        refs: [
          { name: 'OPENCODE_API_KEY', example: 'ocgw_…', note: 'Console 的 API Key（或 OAuth access token）' },
          { name: 'OPENCODE_WORKSPACE_ID', example: 'wrk_…', note: 'Console 地址里的 workspace id' },
        ],
        files: credentialFilesOf('opencode', this.env),
        shape: 'mixed',
        evidence: OPENCODE_EVIDENCE_URL,
      }),
    }

    const key = await this.resolveKey(OPENCODE_KEY_ENVS)
    const fromFile = key === undefined ? readOpencodeAuth(authFile) : undefined
    const apiKey = key?.value ?? fromFile?.apiKey
    if (apiKey === undefined) {
      return {
        ...base,
        ok: false,
        reason: 'no-key',
        keyRef: OPENCODE_KEY_ENV,
        keyRefs: OPENCODE_KEY_ENVS,
        hint: '需要 OpenCode Console 的 Key（或本机 auth.json 里的登录态），并且还要 workspace id。',
        windows: [],
      }
    }
    const workspaceHit = await this.resolveKey(OPENCODE_WORKSPACE_ENVS)
    const workspaceId = workspaceHit?.value ?? fromFile?.workspaceId
    if (workspaceId === undefined) {
      return {
        ...base,
        ok: false,
        reason: 'no-key',
        keyRef: OPENCODE_WORKSPACE_ENV,
        keyRefs: OPENCODE_WORKSPACE_ENVS,
        keySource: key?.source ?? 'cli-file',
        keyHint: maskSecret(apiKey),
        hint: '拿到了 Key，但缺 workspace id（Console 地址里那一段，或 OPENCODE_WORKSPACE_ID）；'
          + '两个接口都要求它，缺了会被上游拒。',
        windows: [],
      }
    }

    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    }
    // 两个接口并行：互不依赖，串行只会让卡片多等一个来回。
    const [goResult, budgetResult] = await Promise.all([
      this.#requestJson(OPENCODE_GO_USAGE_URL, {
        headers: { ...headers, 'x-opencode-org-id': workspaceId },
      }),
      this.#requestJson(OPENCODE_BUDGETS_URL, {
        headers: { ...headers, 'x-org-id': workspaceId },
      }),
    ])

    // Go 的 403 = 该 workspace 没订 Go（上游代码里就是这么判的），不是失败。
    const goNotSubscribed = goResult.status === 403
    const go = goResult.error === undefined ? parseOpencodeGo(goResult.body) : { windows: [], unparsed: 0 }
    // 预算的 403 = 服务账号 Key（没有预算），同样不是失败。
    const budgets = budgetResult.error === undefined && Array.isArray(budgetResult.body)
      ? parseOpencodeBudgets(budgetResult.body)
      : { windows: [], unparsed: 0 }
    const windows = [...go.windows, ...budgets.windows]
    const keyFields = {
      keyRef: key?.ref ?? '(auth.json)',
      keySource: key?.source ?? 'cli-file',
      keyHint: maskSecret(apiKey),
    }

    if (windows.length > 0) {
      const parts = []
      if (goNotSubscribed) parts.push('该 workspace 没有订阅 Go 套餐')
      if (budgetResult.status === 403) parts.push('Console 预算对服务账号 Key 不开放')
      return {
        ...base,
        ...keyFields,
        ok: true,
        plan: '',
        windows,
        ...(parts.length === 0 ? {} : { note: `${base.note}（${parts.join('；')}）` }),
        ...(go.unparsed + budgets.unparsed > 0
          ? { warning: `有 ${go.unparsed + budgets.unparsed} 条额度记录无法识别（接口可能已变更）` }
          : {}),
      }
    }

    // 一个窗口都没拿到：把两个接口的原因如实说出来，别只剩一个空卡片。
    // 401 表示 Key 本身被拒；403 在这两个接口上各自有正常含义（没订 Go / 服务账号），
    // 所以只有 401 归到「凭据被拒绝」。
    const authFailed = goResult.status === 401 || budgetResult.status === 401
    const reasons = []
    if (goResult.error !== undefined && !goNotSubscribed) reasons.push(`Go：${goResult.error}`)
    if (budgetResult.error !== undefined && budgetResult.status !== 403) reasons.push(`预算：${budgetResult.error}`)
    if (goNotSubscribed) reasons.push('没有订阅 Go 套餐')
    return {
      ...base,
      ...keyFields,
      ok: false,
      reason: authFailed ? 'rejected' : 'request-failed',
      error: reasons.join('；') || '接口没有返回任何额度窗口',
      hint: authFailed
        ? 'Opencode 的 Key 被拒：在 Console 里确认 Key 仍然有效，并确认 workspace id 属于同一个 workspace。'
        : '已通过鉴权但没有可显示的额度：确认该 workspace 订了 Go 或设置了 Console 预算。',
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
   *
   * `method` 单独开一个参数而不是塞进 `init`：Cursor 那个 Connect RPC 是 `POST {}`，
   * 而其余四家都是 GET。把方法显式传进来，读代码时一眼能看出「这一家发了什么」。
   * @param {string} url - 固定官方端点。
   * @param {object} init - fetch 参数（headers / body）。
   * @param {'GET'|'POST'} [method] - HTTP 方法，缺省 GET。
   * @returns {Promise<{body?:object,error?:string,status?:number}>} 结果。
   */
  async #requestJson(url, init, method = 'GET') {
    if (typeof this.fetchImpl !== 'function') return { error: '当前运行环境没有可用的 fetch' }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...init, method, signal: controller.signal })
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
