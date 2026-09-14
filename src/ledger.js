/**
 * 用量账本：把会话日志里的每一次模型请求抽成一条独立记录，追加进一份 JSONL 文件。
 *
 * 为什么需要它：
 *   1) 会话日志是压缩的多帧文件，解析成本高，且每台机器只看得见自己的；
 *      账本把「每次请求的关键字段」独立成一份小文件，看板只读它。
 *   2) 记录按 `sessionId:seq` 去重，因此重新安装、把账本拷到另一台机器、
 *      或同一批日志被重复扫描，都不会让历史翻倍——是**合并**而不是覆盖。
 *
 * 账本默认落在 `$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl`，
 * 也就是本机。想连历史一起搬到新电脑，就复制这个文件到相同相对位置。
 * @module dsh-pixel-dashboard/lib/ledger
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeModel } from './pricing.js'

/** 记录里用到的 token 分项。 */
const TOKEN_FIELDS = ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local']

/**
 * 从一条会话事件里抽出账本记录；非用量事件返回 undefined。
 *
 * 缓存未命中输入用 `input - cacheRead - cacheWrite` 反推：`totalTokens` 含缓存命中，
 * 直接当未命中用会把便宜的命中量按贵价计费。
 * 模型名在这里就归一（`deepseek-chat` → `deepseek-flash` 等旧名折叠），
 * 否则账本里会混进价目表认不出的名字，费用只能落到兜底单价上。
 * @param {string} sessionId - 会话 id。
 * @param {object} event - 持久化会话事件。
 * @returns {object|undefined} 账本记录。
 */
export function recordOf(sessionId, event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'assistant/message') return undefined
  const usage = event.data?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const seq = Number(event.seq)
  const time = Number(event.time)
  if (!Number.isFinite(seq) || !Number.isFinite(time)) return undefined

  const input = Number(usage.inputTokens ?? 0)
  const cacheRead = Number(usage.cacheReadTokens ?? 0)
  const cacheWrite = Number(usage.cacheWriteTokens ?? 0)
  const output = Number(usage.outputTokens ?? 0)
  const cacheMiss = Math.max(0, input - cacheRead - cacheWrite)
  const model = event.data?.message?.source?.model

  return {
    k: `${sessionId}:${seq}`, // 幂等键
    s: sessionId,
    t: time,
    m: normalizeModel(typeof model === 'string' ? model : 'unknown'),
    i: Math.round(input),
    r: Math.round(cacheRead),
    w: Math.round(cacheWrite),
    o: Math.round(output),
    n: Math.round(Number(usage.reasoningTokens ?? 0)),
    u: Math.round(cacheMiss + cacheRead + cacheWrite + output), // 计费 token
  }
}

/**
 * 把记录还原成聚合用的用量对象。
 * @param {object} record - 账本记录。
 * @returns {{cacheHit:number,cacheMiss:number,cacheWrite:number,output:number,reasoning:number,local:number,requests:number}}
 */
export function usageOfRecord(record) {
  const cacheHit = Number(record?.r ?? 0)
  const cacheWrite = Number(record?.w ?? 0)
  const output = Number(record?.o ?? 0)
  // 未命中 = 计费总量 - 其它三项（账本里只存总输入与两个缓存分项）
  const cacheMiss = Math.max(0, Number(record?.i ?? 0) - cacheHit - cacheWrite)
  return {
    cacheHit,
    cacheMiss,
    cacheWrite,
    output,
    reasoning: Number(record?.n ?? 0),
    local: Number(record?.u ?? 0),
    requests: 1,
  }
}

/**
 * 解析账本文本，遇到坏行跳过而不是整份作废——账本是追加写的，
 * 云盘同步可能留下半行，不能因为一行坏了就丢掉全部历史。
 * @param {string} text - JSONL 文本。
 * @returns {{records:object[],badLines:number}} 解析结果。
 */
export function parseLedger(text) {
  const records = []
  let badLines = 0
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.k === 'string') records.push(parsed)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  return { records, badLines }
}

/**
 * 按幂等键合并两组记录。
 * @param {object[]} existing - 已有记录。
 * @param {object[]} incoming - 新记录。
 * @returns {{merged:object[], added:number}} 合并结果与新增条数。
 */
export function mergeRecords(existing, incoming) {
  const byKey = new Map()
  for (const record of existing) byKey.set(record.k, record)
  let added = 0
  for (const record of incoming) {
    if (!byKey.has(record.k)) added += 1
    byKey.set(record.k, record)
  }
  // 按时间排序，云盘上多机追加后顺序会乱，排序后便于人工查看
  const merged = [...byKey.values()].sort((a, b) => Number(a.t) - Number(b.t))
  return { merged, added }
}

/** 序列化账本为 JSONL。 */
export function serializeLedger(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

/** 一条不含计费字段的最小记录校验。 */
function isValid(record) {
  return record !== null && typeof record === 'object'
    && typeof record.k === 'string' && record.k !== ''
    && Number.isFinite(Number(record.t))
    && typeof record.m === 'string'
}

/**
 * 账本文件读写：读取、合并、原子写回。
 *
 * 用「读—并—写临时文件—改名」而不是追加写：云端同步的文件允许多机交错，
 * 原子改名能避免同步客户端读到写了一半的文件。
 */
export class UsageLedger {
  /**
   * @param {string} path - 账本文件路径。
   */
  constructor(path) {
    this.path = path
    this.records = []
    this.keySet = new Set()
    this.loaded = false
    this.lastError = undefined
  }

  /** 读取账本；文件不存在视为空账本。 */
  async load() {
    try {
      if (!existsSync(this.path)) {
        this.records = []
        this.keySet = new Set()
        this.loaded = true
        return { records: 0, badLines: 0 }
      }
      const text = await readFile(this.path, 'utf8')
      const { records, badLines } = parseLedger(text)
      this.records = records
      this.keySet = new Set(records.map((record) => record.k))
      this.loaded = true
      return { records: records.length, badLines }
    } catch (error) {
      // 读不到就当空账本继续跑，看板退化为只统计本机会话
      this.lastError = error instanceof Error ? error.message : String(error)
      this.records = []
      this.keySet = new Set()
      this.loaded = true
      return { records: 0, badLines: 0 }
    }
  }

  /**
   * 合并一批记录并写回。
   * @param {object[]} incoming - 来自本机会话日志的记录。
   * @returns {Promise<{added:number,total:number}>} 合并结果。
   */
  async merge(incoming) {
    if (!this.loaded) await this.load()
    const fresh = incoming.filter((record) => isValid(record) && !this.keySet.has(record.k))
    if (fresh.length === 0) return { added: 0, total: this.records.length }

    const merged = [...this.records, ...fresh].sort((a, b) => Number(a.t) - Number(b.t))
    await this.#writeAtomic(merged)
    this.records = merged
    for (const record of fresh) this.keySet.add(record.k)
    return { added: fresh.length, total: merged.length }
  }

  /** 账本是否已有内容。 */
  get size() {
    return this.records.length
  }

  /**
   * 原子写回：先写临时文件再改名，避免同步客户端读到半个文件。
   * @param {object[]} records - 全部记录。
   * @returns {Promise<void>}
   */
  async #writeAtomic(records) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, serializeLedger(records), 'utf8')
    await rename(temporary, this.path)
  }
}

/** 账本记录里可用的 token 字段清单，供别处做一致性检查。 */
export const LEDGER_TOKEN_FIELDS = TOKEN_FIELDS
