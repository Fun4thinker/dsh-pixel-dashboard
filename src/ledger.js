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
 *
 * ## 「这是哪个模型」在记录里有三份，各司其职
 *
 * | 字段 | 是什么 | 谁在用 |
 * |---|---|---|
 * | `n` | 该路由**原生**的模型 id（`deepseek-v4.1-flash`） | 反查用户设置里的外显名 |
 * | `r` | 归一后的**价目表键**（`deepseek-flash`） | 聚合与计价，唯一的条目身份 |
 * | `p` | 提供商路由名（`deepseek-official` / `commandcode` …） | 条目身份的另一半 |
 *
 * 同一个模型由不同提供商提供服务时，单价、余额与套餐额度完全不同，因此
 * `r + p` 才是一条条目的身份；而 `n` 必须原样保留，否则再也查不回用户在
 * DSH 里给这条路由起的名字（那是可以改的，改了要跟着变）。
 * @module dsh-pixel-dashboard/lib/ledger
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeModel } from './pricing.js'

/** 记录里用到的 token 分项。 */
const TOKEN_FIELDS = ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local']

/** 归一后的价目表键的形状：`deepseek-flash@commandcode` / `glm-5.3-flash`。 */
export function modelKeyOf(record) {
  const rollup = typeof record?.r === 'string' && record.r !== '' ? record.r : normalizeModel(record?.n ?? record?.m)
  const provider = typeof record?.p === 'string' ? record.p.trim() : ''
  return provider === '' ? rollup : `${rollup}@${provider}`
}

/**
 * 把模型归一成价目表键，先剥掉「提供商自称/」前缀。
 *
 * 多家聚合网关（Command Code 之类）的模型 id 是 `提供商/模型` 形态：
 * `deepseek/deepseek-v4.1-flash`、`z-ai/glm-5.3-flash`。斜杠左边与下面记的
 * 提供商是同一件事的两种写法，留着会让这些模型永远落不到价目表上——
 * 表现是同一个模型多出一行、并被标成「估算价」，也就是用户看到的
 * 「provider 不同就分成不同条目」里最刺眼的那一半。
 *
 * 剥完仍然认不出来时**不硬塞**：宁可保留原名让它单独一行并标「估算价」，
 * 也不要把它折叠进一个错误的模型行。
 * @param {string} native - 路由上的原生模型 id。
 * @returns {string} 价目表键。
 */
export function rollupOf(native) {
  const name = String(native ?? '').trim()
  const slash = name.indexOf('/')
  if (slash > 0 && slash < name.length - 1) {
    const tail = name.slice(slash + 1)
    const normalizedTail = normalizeModel(tail)
    if (normalizedTail !== tail) return normalizedTail
  }
  return normalizeModel(name)
}

/** 条目身份里的价目表键部分（去掉 `@提供商` 后缀）。 */
export function rateKeyOfModelKey(modelKey) {
  const text = String(modelKey ?? '')
  const at = text.indexOf('@')
  return at <= 0 ? text : text.slice(0, at)
}

/**
 * 从一条会话事件里抽出账本记录；非用量事件返回 undefined。
 *
 * 缓存未命中输入用 `input - cacheRead - cacheWrite` 反推：`totalTokens` 含缓存命中，
 * 直接当未命中用会把便宜的命中量按贵价计费。
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
  const source = event.data?.message?.source
  const native = typeof source?.model === 'string' && source.model.trim() !== '' ? source.model.trim() : 'unknown'
  const provider = typeof source?.provider === 'string' ? source.provider.trim() : ''

  return {
    k: `${sessionId}:${seq}`, // 幂等键
    s: sessionId,
    t: time,
    n: native,
    // 提供商为空串 = 认不出（旧账本记录，或事件里本来就没有 source）。
    // 刻意不写 undefined：JSONL 里那个键会整条消失，读回来时无从分辨「没有」与「空」。
    p: provider,
    // 归一在**写入时**做：历史记录一旦落盘就固定了，每次聚合都重算既慢又容易两处漂移。
    r: rollupOf(native),
    i: Math.round(input),
    h: Math.round(cacheRead),
    w: Math.round(cacheWrite),
    o: Math.round(output),
    g: Math.round(Number(usage.reasoningTokens ?? 0)),
    u: Math.round(cacheMiss + cacheRead + cacheWrite + output), // 计费 token
  }
}

/**
 * 把记录还原成聚合用的用量对象。
 * @param {object} record - 账本记录。
 * @returns {{cacheHit:number,cacheMiss:number,cacheWrite:number,output:number,reasoning:number,local:number,requests:number}}
 */
export function usageOfRecord(record) {
  const cacheHit = Number(record?.h ?? 0)
  const cacheWrite = Number(record?.w ?? 0)
  const output = Number(record?.o ?? 0)
  // 未命中 = 输入总量 - 两个缓存分项（账本里只存总输入与两个缓存分项）
  const cacheMiss = Math.max(0, Number(record?.i ?? 0) - cacheHit - cacheWrite)
  return {
    cacheHit,
    cacheMiss,
    cacheWrite,
    output,
    reasoning: Number(record?.g ?? 0),
    local: Number(record?.u ?? 0),
    requests: 1,
  }
}

/**
 * 一条记录**仅凭自身**能补出来的字段。
 * @param {object} record - 已升级布局的记录。
 * @returns {object} 需要补写的字段。
 */
function enrichmentOf(record) {
  return {
    // 提供商为空 → 从原生模型名再认一次（斜杠形态能认出来）
    p: record.p === '' ? providerFromNativeModel(String(record.n ?? '')) : record.p,
  }
}

/**
 * 把旧版账本记录就地升级到当前布局。
 *
 * 旧记录只有 `m`（当时存的是归一后的模型名）与 `r`（缓存命中 token）——
 * **同一个键 `r` 在新布局里表示价目表键**，这是本文件唯一一处必须显式迁移的
 * 结构性变化：不迁移就会把「缓存命中 token 数」当成模型名去聚合，
 * 界面上会出现一行叫 `1234567` 的模型。
 *
 * 迁移有三条硬约束：
 *   1. **幂等键 `k` 保持原样。** 改了它，同一批会话日志再扫一遍就会被当成新记录
 *      ——历史直接翻倍。这比丢几条旧记录糟得多。
 *   2. **提供商只从原生模型名反推，推不出就留空。** 「源码里写了 xxx 就是自建的」
 *      这种猜测会在用户换路由后变成长期错误归属，而空串至少是诚实的。
 *      留空的记录会被后续扫描**补全**（见 {@link needsRouteEnrichment}）。
 *   3. **不改动计费数字**：只重排字段与补元信息。
 * @param {object} record - 账本里的原始记录。
 * @returns {{record:object,upgraded:boolean}|undefined} 升级结果；坏记录返回 undefined。
 */
export function upgradeRecord(record) {
  if (record === null || typeof record !== 'object') return undefined
  if (typeof record.k !== 'string' || record.k === '') return undefined
  if (!Number.isFinite(Number(record.t))) return undefined
  if (typeof record.n === 'string') {
    // 新布局：只可能还需要补一次「斜杠形态的提供商」。`m` 是迁移留下的痕迹，
    // 写回时才会真正删掉——因此只要它还在，这次读取就算「做过迁移」，
    // 文件必须落盘一次（否则下次读还是同一份带 `m` 的文件，迁移永远不结束）。
    const next = { ...record, ...enrichmentOf(record) }
    return { record: next, upgraded: Object.hasOwn(record, 'm') }
  }

  const legacyModel = typeof record.m === 'string' ? record.m.trim() : ''
  if (legacyModel === '') return undefined
  const cacheRead = Number(record.r ?? 0)
  // 旧布局的 r 是缓存命中 token：移进 h，再把 r 让给价目表键
  const { m: _m, r: _r, n: _n, ...rest } = record
  return {
    record: {
      ...rest,
      h: Number.isFinite(cacheRead) ? Math.round(cacheRead) : 0,
      n: legacyModel,
      p: providerFromNativeModel(legacyModel),
      r: rollupOf(legacyModel),
      g: Math.round(Number(record.n ?? 0)),
    },
    upgraded: true,
  }
}

/**
 * 这条记录是否**还缺**只有扫描会话日志才能补上的信息。
 *
 * 旧账本记录里的模型名是「当时归一过的」，`deepseek-v4.1-flash` 与
 * `deepseek/deepseek-v4.1-flash` 都变成了 `deepseek-flash`，提供商更是完全没有
 * ——于是同一个 DeepSeek 模型的各家用量被混成了一条。
 *
 * 判据是「**提供商还是空的**」。不要用 `m` 这种「迁移痕迹」当判据：它在 load
 * 时就被删掉了，于是第一次扫描之外再也命中不了，旧记录永远补不上模型与提供商
 * （实测踩过：37xx 条老记录重扫之后仍然全是「来源未知」）。
 *
 * 重扫的代价可以接受：`merge` 只在**真的补到了东西**时才落盘，而补到了提供商的
 * 记录下次就不满足这个条件了；真的认不出来源的记录会一直被扫到，但那也只是
 * 内存里的一次查找，不写盘。
 * @param {object} record - 已升级布局的记录。
 * @returns {boolean} 需要重扫补全时为真。
 */
export function needsRouteEnrichment(record) {
  return record !== null && typeof record === 'object'
    && typeof record.n === 'string' && (record.p === '' || record.p === undefined)
}

/**
 * 用扫描出来的权威记录覆盖旧账本的元信息，同时**保留旧记录的计费口径**。
 *
 * 为什么计数要保留旧的：账本里可能还有这台机器上早已删掉的会话，而会话日志会被
 * 修剪。旧记录的 token 数是那时唯一的事实，拿新扫描的字段整条覆盖它并没有更准确，
 * 却会悄悄改动历史金额。这里只补「这是哪个模型、经哪家提供商」，不动任何数字。
 * @param {object} existing - 账本里的旧记录（已升级布局）。
 * @param {object} fresh - 本次扫描产出的记录。
 * @returns {object} 合并后的记录。
 */
export function enrichRoute(existing, fresh) {
  return {
    ...existing,
    n: fresh.n,
    p: fresh.p,
    r: fresh.r,
  }
}

/**
 * 旧账本里的原生模型名 → 提供商路由名（**只处理确定能认出来的那一种**）。
 *
 * 唯一可靠的一类是斜杠形态：`deepseek/deepseek-v4.1-flash`、`z-ai/glm-5.3-flash`
 * ——斜杠左边是网关自己的提供商名（未必等于 DSH 路由名，宿主聚合时会换成真的那个）。
 *
 * **不要按「这个名字只可能是某一家」去推。** 实测本机账本里
 * `deepseek-flash` 同时由 `deepseek-official`、`zijie`、`workbuddy-cn` 提供，
 * 按名字推定会把别的提供商的用量记到官方头上——那不是「少一点信息」，
 * 而是一条**错误的归属**，比空着更糟。
 *
 * 空串的后果是界面显示「来源未知」；而用户下次启动 dsh 时宿主会重扫本机会话日志，
 * 扫描出来的记录带着事件里真实的 provider，且幂等键与旧记录相同，因此会**就地
 * 覆盖**旧记录——来源会被自动补上，不需要用户做任何事。
 * @param {string} nativeModel - 旧记录里的模型名。
 * @returns {string} 提供商路由名；认不出时为空串。
 */
function providerFromNativeModel(nativeModel) {
  const slash = nativeModel.indexOf('/')
  if (slash > 0 && slash < nativeModel.length - 1) return nativeModel.slice(0, slash)
  return ''
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
 * @returns {{merged:object[],added:number}} 合并结果与新增条数。
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

/**
 * 一条不含计费字段的最小记录校验。
 *
 * 只查「能不能作为一条记录存在」：幂等键、时间、以及至少一种模型标识。
 * 计费字段缺失是允许的（那只是零用量），而模型标识缺失的记录连该归到哪一行都不知道。
 */
function isValid(record) {
  return record !== null && typeof record === 'object'
    && typeof record.k === 'string' && record.k !== ''
    && Number.isFinite(Number(record.t))
    && (typeof record.n === 'string' || typeof record.m === 'string')
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
    /** 本次读取时从旧布局升级过来的条数（0 表示无需迁移）。 */
    this.upgraded = 0
    /** 无法升级、已丢弃的坏记录条数。 */
    this.dropped = 0
  }

  /**
   * 读取账本；文件不存在视为空账本。
   *
   * 顺带把旧布局记录升级并写回：只在**确实还需要写**时才落盘，
   * 否则每次读账本都要重写一遍整个文件。
   * @returns {Promise<{records:number,badLines:number}>} 读取结果。
   */
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
      const upgradedRecords = []
      let upgraded = 0
      let dropped = 0
      for (const record of records) {
        const result = upgradeRecord(record)
        if (result === undefined) {
          dropped += 1
          continue
        }
        if (result.upgraded) upgraded += 1
        upgradedRecords.push(result.record)
      }
      this.records = upgradedRecords
      this.keySet = new Set(upgradedRecords.map((record) => record.k))
      this.upgraded = upgraded
      this.dropped = dropped
      this.loaded = true
      // 只要还有记录留着旧字段 `m`（迁移未完成）就写回一次：写回会把 `m` 删掉，
      // 于是这次迁移只发生一次，而不是每次读账本都重写整个文件。
      const pending = upgradedRecords.some((record) => Object.hasOwn(record, 'm'))
      if (upgraded > 0 || pending) await this.#writeAtomic(upgradedRecords)
      return { records: upgradedRecords.length, badLines }
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
   *
   * 两种更新：
   *   1) 账本里没有的键 → 追加；
   *   2) 账本里有、但仍是旧布局（{@link needsRouteEnrichment}）的键 → **就地补上**
   *      模型与提供商。
   *
   * 第 2 条是必须的：早先这里只 `if (!keySet.has(k))` 追加，于是旧记录永远停留在
   * 「没有提供商、模型名只有一个」的状态——用户重扫多少次都补不回来，
   * 界面上只能一直显示「来源未知」。补全只动 `n`/`p`/`r` 三个字段，**不动任何
   * 计费数字**（见 {@link enrichRoute}）。
   * @param {object[]} incoming - 来自本机会话日志的记录。
   * @returns {Promise<{added:number,total:number,enriched:number}>} 合并结果。
   */
  async merge(incoming) {
    if (!this.loaded) await this.load()
    const fresh = incoming.filter((record) => isValid(record) && !this.keySet.has(record.k))
    const byKey = new Map()
    for (const record of incoming) if (isValid(record)) byKey.set(record.k, record)

    let enriched = 0
    const next = this.records.map((record) => {
      if (!needsRouteEnrichment(record)) return record
      const authoritative = byKey.get(record.k)
      if (authoritative === undefined) return record
      enriched += 1
      return enrichRoute(record, authoritative)
    })
    if (fresh.length === 0 && enriched === 0) {
      return { added: 0, total: this.records.length, enriched: 0 }
    }

    const merged = [...next, ...fresh].sort((a, b) => Number(a.t) - Number(b.t))
    await this.#writeAtomic(merged)
    this.records = merged
    for (const record of fresh) this.keySet.add(record.k)
    return { added: fresh.length, total: merged.length, enriched }
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
