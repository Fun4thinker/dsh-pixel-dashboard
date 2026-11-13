/**
 * 自定义单价：让用户**不改源码、不重新构建**就能给任意模型补一个官方价。
 *
 * ## 为什么需要它
 *
 * 内置价目表（`pricing.js` 的 `MODEL_RATES`）是随插件发布的，改一个数就要动源码、
 * 重新构建、再重启宿主。可是新模型发布得很勤，而「我用的那个模型没有价」的表现
 * 是它被标成「估算价」，金额按 Flash 兜底折算——数字有、也不报错，只是错的。
 * 用户想把它改对，原先**没有任何可用的入口**。
 *
 * 因此这里给出一份本机 JSON 文件作为唯一入口，并把它接进运行时价目表
 * （`pricing.js` 的 `setCustomRates`）。
 *
 * ## 文件形状（v3：文档式）
 *
 * 落在 `$DSH_HOME/plugins/dsh-pixel-dashboard/custom-rates.json`，
 * 与用量账本、开关同一个目录；`DSH_PIXEL_RATES` 可覆盖路径。
 *
 * ```json
 * {
 *   "usdToCny": 7.3,
 *   "markup": { "commandcode": 1.2 },
 *   "rates": {
 *     "gpt-6-alstra": {
 *       "label": "GPT-6 Alstra",
 *       "vendor": "OpenAI",
 *       "cacheHit": 1,
 *       "cacheMiss": 10,
 *       "output": 40
 *     },
 *     "some-tiered-model": {
 *       "label": "Some Tiered",
 *       "currency": "USD",
 *       "cacheHit": { "idle": 0.5, "peak": 1 },
 *       "cacheMiss": { "idle": 5, "peak": 10 },
 *       "output": { "idle": 20, "peak": 40 }
 *     }
 *   }
 * }
 * ```
 *
 * 写一个数 = 不分时（高峰空闲同价）；写 `{ peak, idle }` = 分时。
 * `currency` 省略即人民币；写 `USD` 表示那几个数字是美元，按 `usdToCny` 折成人民币参与计价。
 *
 * **旧格式仍然能读**：v2 的文件顶层直接就是「模型键 → 价目」，没有 `rates` 那一层。
 * 读到那种形状时整份当作 `rates`，其余两项取默认值（见 {@link parseRatesDocument}）——
 * 升级插件不该让用户已经写好的价失效。
 *
 * ## 三条硬约束
 *
 *   1) **只覆盖，不猜测。** 这里写进去的价会被当作**该模型的官方价**参与计价并
 *      且不再标「估算价」。因此宁可留空也不要随便填——填错的数字界面上看不出来。
 *   2) **坏条目显式报错，不静默忽略。** 用户手写 JSON 出错的方式很多（少一个分档、
 *      值写成字符串），静默跳过会让他以为「插件没生效」。这里把每条错误连同模型名
 *      一起回报给界面。
 *   3) **校验先于落盘。** 写坏文件会让下次启动也跟着坏，而重启后被清空的价目表
 *      比「这次没写成功」难查得多。
 * @module dsh-pixel-dashboard/lib/custom-rates
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_USD_TO_CNY,
  cnyRateTable,
  setCustomRates,
  setMarkup,
  setUsdToCny,
  usdToCny,
  validateCustomRates,
} from './pricing.js'

/**
 * 解析自定义价目文件路径。
 * @param {object} [env] - 环境变量来源。
 * @returns {string|undefined} 绝对路径；推不出时 undefined（功能关闭）。
 */
export function resolveCustomRatesPath(env = process.env) {
  const configured = env?.DSH_PIXEL_RATES
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = env?.DSH_HOME ?? (env?.USERPROFILE ?? homedir())
  if (typeof home !== 'string' || home.trim() === '') return undefined
  return join(home.trim(), 'plugins', 'dsh-pixel-dashboard', 'custom-rates.json')
}

/**
 * 一份自定义价目文档的默认值。
 *
 * `usdToCny` 用 `undefined` 而不是 7.3：**没配过**与**配成 7.3** 是两件事，
 * 前者应该跟随内置默认值（以后改了默认值它跟着变），后者是用户的明确选择。
 */
function emptyDocument() {
  return { rates: {}, markup: {}, usdToCny: undefined, errors: [] }
}

/**
 * 判断一份输入是「文档式」还是 v2 的「扁平式」。
 *
 * 判据只有一条：顶层有没有 `rates` 这个**对象**。v2 的扁平式里 `rates` 只会是
 * 某个模型的键名（用户给自己的模型起名叫 `rates` 的概率极低，而即便真发生，
 * 也只会被当成文档——两者冲突时宁可认文档，因为文档是我们写出去的那一种）。
 * @param {unknown} input - 解析后的 JSON。
 * @returns {boolean} 是否文档式。
 */
function isDocument(input) {
  return input !== null
    && typeof input === 'object'
    && !Array.isArray(input)
    && input.rates !== null
    && typeof input.rates === 'object'
    && !Array.isArray(input.rates)
}

/**
 * 校验并整形一份自定义价目文档（**同时接受 v2 扁平式**）。
 *
 * 三类内容的校验口径各自独立，错误信息也各自点名到具体那一项：
 *   - `rates`：交给 `pricing.js` 的 `validateCustomRates`（它负责「哪一个模型的哪一档」）；
 *   - `markup`：提供商路由名 → 正数倍率；
 *   - `usdToCny`：正数汇率。
 * @param {unknown} input - 待校验的原始对象（文档式或扁平式）。
 * @returns {{rates:object,markup:object,usdToCny:number|undefined,errors:string[]}} 结果。
 */
export function parseRatesDocument(input) {
  const doc = emptyDocument()
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    doc.errors.push('顶层需要是一个对象：{ rates, markup, usdToCny }，或旧格式「模型键 → 价目」')
    return doc
  }
  // v2 扁平式：整份都是价目条目。
  const ratesInput = isDocument(input) ? input.rates : input
  const checked = validateCustomRates(ratesInput)
  doc.rates = checked.rates
  doc.errors.push(...checked.errors)
  // 扁平式里不存在 markup / usdToCny 两项（真写了也会被当成模型键而报错，
  // 这比静默忽略更好：用户会看到「模型 rates 需要是一个对象」这种明确提示）。
  if (!isDocument(input)) return doc

  if (input.markup !== undefined) {
    if (input.markup === null || typeof input.markup !== 'object' || Array.isArray(input.markup)) {
      doc.errors.push('markup 需要是一个对象：提供商路由名 → 倍率，例如 { "commandcode": 1.2 }')
    } else {
      for (const [provider, value] of Object.entries(input.markup)) {
        const name = String(provider ?? '').trim()
        const amount = Number(value)
        if (name === '') { doc.errors.push('markup 里存在空的提供商名'); continue }
        if (!Number.isFinite(amount) || amount <= 0) {
          doc.errors.push(`倍率「${name}」需要是一个正数，实际 ${JSON.stringify(value)}`)
          continue
        }
        doc.markup[name] = amount
      }
    }
  }
  if (input.usdToCny !== undefined) {
    const amount = Number(input.usdToCny)
    if (!Number.isFinite(amount) || amount <= 0) {
      doc.errors.push(`usdToCny 需要是一个正数，实际 ${JSON.stringify(input.usdToCny)}`)
    } else {
      doc.usdToCny = amount
    }
  }
  return doc
}

/**
 * 自定义价目的读写与生效。
 *
 * 读完即生效（接进运行时价目表、倍率与汇率），因此界面与计价立刻按新值走。
 * 文件缺失**不算错**：那是「还没配过」的正常状态。
 */
export class CustomRates {
  /**
   * @param {object} [options] - 选项。
   * @param {string|undefined} [options.path] - 文件路径；undefined 表示禁用。
   * @param {object} [options.env] - 环境变量来源；测试注入用。
   */
  constructor({ path, env = process.env } = {}) {
    this.path = path ?? resolveCustomRatesPath(env)
    /** @type {object} 当前生效的自定义条目（原币，按声明）。 */
    this.rates = {}
    /** @type {Record<string, number>} 当前生效的提供商倍率。 */
    this.markup = {}
    /** @type {number|undefined} 文件里声明的汇率；undefined = 没配过。 */
    this.usdToCny = undefined
    /** @type {string[]} 上一次读取/写入留下的校验错误。 */
    this.errors = []
    /** @type {string|undefined} 读取或写入失败的原因。 */
    this.lastError = undefined
    /** 上次读取时文件的修改时间与大小，用于判断要不要重读。 */
    this.stamp = undefined
  }

  /** 功能是否可用（路径推得出来）。 */
  get enabled() {
    return this.path !== undefined
  }

  /**
   * 把当前生效的三项接进运行时。
   * @returns {void}
   */
  apply() {
    // 顺序有讲究：汇率要先落，否则自定义的 USD 条目会用旧汇率折一次视图。
    if (this.usdToCny === undefined) setUsdToCny(DEFAULT_USD_TO_CNY)
    else setUsdToCny(this.usdToCny)
    setMarkup(this.markup)
    setCustomRates(this.rates)
  }

  /**
   * 读取文件并让其中通过校验的条目立即生效。
   *
   * 每次都先比对 mtime + size，没变就不重读——这个函数会挂在看板取数路径上，
   * 而看板取数有 30 秒 TTL 缓存，实际调用不频繁，但省掉无谓的磁盘读总是好的。
   * @returns {Promise<{loaded:boolean,count:number,errors:string[]}>} 读取结果。
   */
  async load() {
    if (this.path === undefined) {
      this.rates = {}
      this.markup = {}
      this.usdToCny = undefined
      this.errors = []
      this.stamp = undefined
      this.apply()
      return { loaded: false, count: 0, errors: [] }
    }
    let text
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(this.path)
      const stamp = `${info.mtimeMs}:${info.size}`
      // 文件没动过就不必重读，但**首次**仍要读（stamp 为 undefined）
      if (this.stamp === stamp) {
        return { loaded: false, count: Object.keys(this.rates).length, errors: this.errors }
      }
      this.stamp = stamp
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      // 文件不存在 = 还没配过，属于正常空状态，不当作错误
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        this.rates = {}
        this.markup = {}
        this.usdToCny = undefined
        this.errors = []
        this.lastError = undefined
        this.apply()
        return { loaded: false, count: 0, errors: [] }
      }
      this.lastError = error instanceof Error ? error.message : String(error)
      return { loaded: false, count: Object.keys(this.rates).length, errors: this.errors }
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // JSON 语法错误必须明说：用户会盯着文件找半天，界面直接指出「不是合法 JSON」
      // 比让他去猜有用得多。此时**保留**上一次生效的价，不清空。
      this.lastError = `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`
      return { loaded: false, count: Object.keys(this.rates).length, errors: this.errors }
    }
    const doc = parseRatesDocument(parsed)
    this.rates = doc.rates
    this.markup = doc.markup
    this.usdToCny = doc.usdToCny
    this.errors = doc.errors
    this.lastError = undefined
    this.apply()
    return { loaded: true, count: Object.keys(doc.rates).length, errors: doc.errors }
  }

  /**
   * 写入一份新配置并立即生效。
   *
   * 接受两种形状：文档式 `{ rates, markup, usdToCny }`，以及 v2 的扁平式
   * 「模型键 → 价目」（老界面 / 手写脚本仍在用）。落盘时**一律写文档式**——
   * 旧格式读得进、新格式写得出的不对称是单向升级，回不去是有意的：
   * 只有一份文件，不该有两种写法长期并存。
   * @param {unknown} input - 完整的自定义条目 / 文档。
   * @returns {Promise<{ok:boolean,errors:string[],persisted:boolean}>} 结果。
   */
  async save(input) {
    const doc = parseRatesDocument(input)
    if (doc.errors.length > 0) return { ok: false, errors: doc.errors, persisted: false }
    this.rates = doc.rates
    this.markup = doc.markup
    this.usdToCny = doc.usdToCny
    this.errors = []
    this.apply()
    if (this.path === undefined) return { ok: true, errors: [], persisted: false }
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const payload = {
        // 没配过汇率时不写这一项，跟随内置默认值（见 emptyDocument 的说明）。
        ...(this.usdToCny === undefined ? {} : { usdToCny: this.usdToCny }),
        markup: this.markup,
        rates: this.rates,
      }
      const temporary = `${this.path}.tmp`
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(temporary, this.path)
      // 自己写完之后 stamp 会与旧值不一致（或没记录过）；丢掉它，
      // 让下一次 load 重新读一遍，避免「内存里有、文件里没有」的错觉。
      this.stamp = undefined
      this.lastError = undefined
      return { ok: true, errors: [], persisted: true }
    } catch (error) {
      // 内存里的价已经生效（本次会话可用），但要如实说没落盘
      this.lastError = error instanceof Error ? error.message : String(error)
      return { ok: true, errors: [], persisted: false }
    }
  }

  /** 供界面展示的一段说明（路径、状态、倍率、汇率）。 */
  describe() {
    return {
      enabled: this.enabled,
      path: this.path ?? null,
      count: Object.keys(this.rates).length,
      // 交出去的是**人民币视图**：看板会把它逐条盖到 `pricing.models` / `pricing.rates`
      // 上（见 dashboard 的「我的单价」），而那一层只认人民币数字。交原币 USD 数字
      // 会让同一个模型在两处显示成相差 7 倍的两个金额。
      rates: cnyRateTable(this.rates, usdToCny()),
      markup: this.markup,
      usdToCny: this.usdToCny ?? usdToCny(),
      ...(this.errors.length > 0 ? { errors: this.errors } : {}),
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }
}
