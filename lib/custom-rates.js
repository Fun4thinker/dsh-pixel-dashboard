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
 * ## 文件形状
 *
 * 落在 `$DSH_HOME/plugins/dsh-pixel-dashboard/custom-rates.json`，
 * 与用量账本、开关同一个目录；`DSH_PIXEL_RATES` 可覆盖路径。
 *
 * ```json
 * {
 *   "gpt-6-alstra": {
 *     "label": "GPT-6 Alstra",
 *     "vendor": "OpenAI",
 *     "cacheHit": 1,
 *     "cacheMiss": 10,
 *     "output": 40
 *   },
 *   "some-tiered-model": {
 *     "label": "Some Tiered",
 *     "cacheHit": { "idle": 0.5, "peak": 1 },
 *     "cacheMiss": { "idle": 5, "peak": 10 },
 *     "output": { "idle": 20, "peak": 40 }
 *   }
 * }
 * ```
 *
 * 写一个数 = 不分时（高峰空闲同价）；写 `{ peak, idle }` = 分时。
 *
 * ## 两条硬约束
 *
 *   1) **只覆盖，不猜测。** 这里写进去的价会被当作**该模型的官方价**参与计价并
 *      且不再标「估算价」。因此宁可留空也不要随便填——填错的数字界面上看不出来。
 *   2) **坏条目显式报错，不静默忽略。** 用户手写 JSON 出错的方式很多（少一个分档、
 *      值写成字符串），静默跳过会让他以为「插件没生效」。这里把每条错误连同模型名
 *      一起回报给界面。
 * @module dsh-pixel-dashboard/lib/custom-rates
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setCustomRates, validateCustomRates } from './pricing.js'

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
 * 自定义价目的读写与生效。
 *
 * 读完即生效（接进运行时价目表），因此界面与计价立刻按新价走。
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
    /** @type {object} 当前生效的自定义条目。 */
    this.rates = {}
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
   * 读取文件并让其中通过校验的条目立即生效。
   *
   * 每次都先比对 mtime + size，没变就不重读——这个函数会挂在看板取数路径上，
   * 而看板取数有 30 秒 TTL 缓存，实际调用不频繁，但省掉无谓的磁盘读总是好的。
   * @returns {Promise<{loaded:boolean,count:number,errors:string[]}>} 读取结果。
   */
  async load() {
    if (this.path === undefined) {
      this.rates = {}
      this.errors = []
      this.stamp = undefined
      setCustomRates({})
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
        this.errors = []
        this.lastError = undefined
        setCustomRates({})
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
    const { rates, errors } = validateCustomRates(parsed)
    this.rates = rates
    this.errors = errors
    this.lastError = undefined
    setCustomRates(rates)
    return { loaded: true, count: Object.keys(rates).length, errors }
  }

  /**
   * 写入一份新条目并立即生效。
   *
   * 校验**先于落盘**：写坏文件会让下次启动也跟着坏，而重启后被清空的价目表
   * 比「这次没写成功」难查得多。校验失败时一个字节都不落盘。
   * @param {unknown} input - 完整的自定义条目对象。
   * @returns {Promise<{ok:boolean,errors:string[],persisted:boolean}>} 结果。
   */
  async save(input) {
    const { rates, errors } = validateCustomRates(input)
    if (errors.length > 0) return { ok: false, errors, persisted: false }
    this.rates = rates
    this.errors = []
    setCustomRates(rates)
    if (this.path === undefined) return { ok: true, errors: [], persisted: false }
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      await writeFile(temporary, `${JSON.stringify(rates, null, 2)}\n`, 'utf8')
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

  /** 供界面展示的一段说明（路径与状态）。 */
  describe() {
    return {
      enabled: this.enabled,
      path: this.path ?? null,
      count: Object.keys(this.rates).length,
      rates: this.rates,
      ...(this.errors.length > 0 ? { errors: this.errors } : {}),
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }
}
