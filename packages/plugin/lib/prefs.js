/**
 * 本机开关存储：余额查询与第三方套餐监控共用的一个小 JSON 文件。
 *
 * 为什么要单独一个模块：两个功能各自都有开关，若各自读—改—写同一个文件，
 * 就会互相覆盖（A 读到旧内容、B 写入、A 再写入，B 的改动消失）。这里把
 * 「读 → 合并 → 原子写回」收敛到一处，写入串行化。
 *
 * 文件默认落在 `$DSH_HOME/plugins/dsh-pixel-dashboard/balance-prefs.json`
 * （沿用余额功能上线时的文件名，避免用户已有的开关丢失）。
 * @module dsh-pixel-dashboard/lib/prefs
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 解析开关文件路径。
 * @param {object} [env] - 环境变量来源。
 * @returns {string|undefined} 绝对路径；推不出时 undefined。
 */
export function resolvePrefsPath(env = process.env) {
  const configured = env?.DSH_PIXEL_BALANCE_PREFS
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = env?.DSH_HOME ?? (env?.USERPROFILE ?? homedir())
  if (typeof home !== 'string' || home.trim() === '') return undefined
  return join(home.trim(), 'plugins', 'dsh-pixel-dashboard', 'balance-prefs.json')
}

/**
 * 开关存储：带内存缓存、写入串行、原子落盘。
 */
export class Preferences {
  /**
   * @param {string|undefined} path - 文件路径；undefined 表示只读默认值。
   * @param {object} [defaults] - 默认值。
   */
  constructor(path, defaults = {}) {
    this.path = path
    this.defaults = defaults
    /** @type {object|undefined} */
    this.data = undefined
    /** @type {Promise<void>} 写入队列，保证并发更新不互相覆盖。 */
    this.queue = Promise.resolve()
    /** @type {string|undefined} */
    this.lastError = undefined
  }

  /**
   * 读取全部开关（带内存缓存）。
   * @returns {Promise<object>} 开关对象。
   */
  async read() {
    if (this.data !== undefined) return this.data
    if (this.path === undefined || !existsSync(this.path)) {
      this.data = { ...this.defaults }
      return this.data
    }
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'))
      this.data = parsed !== null && typeof parsed === 'object'
        ? { ...this.defaults, ...parsed }
        : { ...this.defaults }
    } catch (error) {
      // 坏文件当没写过：开关回到默认值，不影响看板
      this.lastError = error instanceof Error ? error.message : String(error)
      this.data = { ...this.defaults }
    }
    return this.data
  }

  /**
   * 合并一个补丁并落盘。
   *
   * 写入串行化：后一次写入基于前一次的结果，因此两个功能同时改开关不会丢改动。
   * 落盘失败**不抛错**——内存里的选择已经生效，抛错只会让一次点击看起来失败。
   * @param {object} patch - 要合并的键值。
   * @returns {Promise<{persisted:boolean,data:object}>} 结果。
   */
  async patch(patch) {
    const run = async () => {
      const current = await this.read()
      this.data = { ...current, ...patch }
      if (this.path === undefined) return { persisted: false, data: this.data }
      try {
        await mkdir(dirname(this.path), { recursive: true })
        const temporary = `${this.path}.tmp`
        await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
        await rename(temporary, this.path)
        return { persisted: true, data: this.data }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        return { persisted: false, data: this.data }
      }
    }
    // 排队：把本次写入接到上一次之后，无论上次成功或失败
    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
}
