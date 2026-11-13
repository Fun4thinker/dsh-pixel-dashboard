/**
 * 自定义单价（浏览器半边）：取数、保存与表单草稿。
 *
 * 与宿主 lib/custom-rates.js 成对。这里刻意**不重复任何校验逻辑**：校验只有宿主
 * 那一份（它同时负责落盘），浏览器只负责把用户输入整理成候选对象，并如实展示宿主
 * 返回的错误。两处各写一份校验，迟早会出现「界面说没问题、宿主拒绝」这种最难解释的分歧。
 * @module dsh-pixel-dashboard/client/rates
 */

/** 自定义价目路由，与宿主注册路径一致。 */
const RATES_URL = '/dsh-pixel/rates'

/** 价目不是关键路径，超时给短一些，失败就明说。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 取自定义价目的当前状态。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主回报的状态（路径、条数、条目、错误）。
 */
export async function fetchRates(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(RATES_URL, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      // 404 有确定含义：宿主是还没有这条路由的旧版本。明说，而不是抛「HTTP 404」。
      if (response.status === 404) throw new Error('宿主没有自定义价目路由（插件版本可能过旧，重启 dsh 试试）')
      throw new Error('HTTP ' + response.status)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 保存整份自定义价目。
 *
 * 参数**两种形状都接受**，由宿主那边的 `parseRatesDocument()` 判别：
 *   - 文档式 `{ rates, markup, usdToCny }`（v3，设置弹层用这一种）；
 *   - v2 的扁平式「模型键 → 价目」（老界面、以及用户手写的脚本仍在用）。
 *
 * 校验失败时宿主回 400 并带上逐条原因，这里把它抛成 Error（消息是拼接后的人话），
 * 让面板能直接把原因摆在用户面前——「保存失败」四个字帮不了他。
 * @param {object} documentOrRates - 文档式或扁平式自定义价目。
 * @returns {Promise<object>} 宿主回报的新状态。
 * @throws {Error} 校验失败或网络失败。
 */
export async function saveRates(documentOrRates) {
  const response = await fetch(RATES_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ rates: documentOrRates }),
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : []
    const detail = errors.length > 0
      ? errors.join('；')
      : (typeof payload?.error === 'string' ? payload.error : 'HTTP ' + response.status)
    const failure = new Error(detail)
    // 把**逐条**原因也挂上去：界面要能把「哪一条的哪一项」一条条列出来，
    // 而不是让用户从一段用分号连起来的长句里自己拆。
    if (errors.length > 0) failure.errors = errors
    throw failure
  }
  return payload
}

/**
 * 把界面上的一行输入整理成价目条目。
 *
 * 与宿主的校验口径一致：
 *   - 每档各填**一个数** → 不分时；
 *   - 同一档填 idle 与 peak 两个数 → 分时；
 *   - 缓存命中留空 → 按 0 计（很多模型没有缓存优惠，逼用户填一个 0 反而增加出错机会）。
 *
 * 空字符串一律视为「没填」而不是 0：`Number('')` 是 0，会把「没填」变成「免费」——
 * 那正是本项目反复强调要避免的一类静默错误。
 * @param {object} input - 界面字段。
 * @returns {object|undefined} 价目条目；输入与输出都为空时 undefined。
 */
export function composeRate(input) {
  const num = (value) => {
    if (value === undefined || value === null) return undefined
    const text = String(value).trim()
    if (text === '') return undefined
    const amount = Number(text)
    return Number.isFinite(amount) && amount >= 0 ? amount : undefined
  }
  const pair = (idle, peak) => {
    const low = num(idle)
    const high = num(peak)
    if (low === undefined && high === undefined) return undefined
    // 只填了一个档：另一个档按同一个值算（用户多半是想写不分时）
    if (low === undefined) return { idle: high, peak: high }
    if (high === undefined) return { idle: low, peak: low }
    return { idle: low, peak: high }
  }
  const cacheMiss = pair(input?.cacheMissIdle, input?.cacheMissPeak)
  const output = pair(input?.outputIdle, input?.outputPeak)
  if (cacheMiss === undefined && output === undefined) return undefined
  const zero = { idle: 0, peak: 0 }
  const label = typeof input?.label === 'string' && input.label.trim() !== '' ? input.label.trim() : undefined
  const vendor = typeof input?.vendor === 'string' && input.vendor.trim() !== '' ? input.vendor.trim() : '自定义'
  // 币种：只认 CNY / USD，其余按 CNY（界面上是下拉框，走到这里说明是脏数据）。
  const currency = String(input?.currency ?? '').trim().toUpperCase() === 'USD' ? 'USD' : 'CNY'
  const cacheWrite = pair(input?.cacheWriteIdle, input?.cacheWritePeak)
  const entry = {
    vendor,
    currency,
    cacheHit: pair(input?.cacheHitIdle, input?.cacheHitPeak) ?? zero,
    cacheMiss,
    output,
  }
  if (label !== undefined) entry.label = label
  if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite
  return entry
}

/**
 * 把一个条目摊平成界面上的输入框草稿。
 *
 * 条目里每个字段都可能是「一个数」或 `{ idle, peak }`；编辑器统一按分时的六格
 * 展示，不分时的条目两格填同一个值。这样只有一种编辑形态，用户不必先判断
 * 「这个模型是不是分时」——那个判断对他的任务没有任何帮助。
 * @param {object|undefined} rate - 价目条目。
 * @returns {object} 表单草稿。
 */
export function draftOf(rate) {
  const text = (value) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? '' : String(Number(value)))
  const side = (field, key) => {
    const value = rate?.[field]
    if (value === undefined || value === null) return ''
    if (typeof value === 'object') return text(value[key])
    return text(value)
  }
  return {
    label: typeof rate?.label === 'string' ? rate.label : '',
    vendor: typeof rate?.vendor === 'string' ? rate.vendor : '',
    currency: String(rate?.currency ?? 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY',
    cacheHitIdle: side('cacheHit', 'idle'),
    cacheHitPeak: side('cacheHit', 'peak'),
    cacheMissIdle: side('cacheMiss', 'idle'),
    cacheMissPeak: side('cacheMiss', 'peak'),
    outputIdle: side('output', 'idle'),
    outputPeak: side('output', 'peak'),
    cacheWriteIdle: side('cacheWrite', 'idle'),
    cacheWritePeak: side('cacheWrite', 'peak'),
  }
}

/**
 * 把草稿写回成价目条目（保存前用）。
 *
 * 与 {@link composeRate} 的区别：这里**保留模型键之外的原字段**（`tiered` / `asOf` /
 * `source` 等），只覆盖用户改过的那几个价。设置页是按整条价目编辑的，若把
 * 「分档定价」「官方出处」这些字段丢掉，保存一次就等于把一个官方条目的属性抹平了。
 * @param {object} draft - 表单草稿。
 * @param {object} [base] - 原始条目（可为空）。
 * @returns {object|undefined} 价目条目；价格全空时 undefined。
 */
export function entryOfDraft(draft, base) {
  const composed = composeRate(draft)
  if (composed === undefined) return undefined
  const carried = {}
  for (const key of ['tiered', 'asOf', 'source', 'contextWindow', 'maxOutput', 'version']) {
    if (base?.[key] !== undefined) carried[key] = base[key]
  }
  return { ...carried, ...composed }
}

/**
 * 把价目表按厂商分组（设置页要「厂商分组 + 搜索」）。
 *
 * 分组键取 `vendor`；缺失一律归到「未标注厂商」而不是丢掉——丢掉的条目在界面上
 * 就等于不存在，用户会以为插件没读到它。
 * @param {Record<string, object>} rates - 模型键 → 价目条目。
 * @returns {{vendor:string,items:{key:string,rate:object}[]}[]} 分组（按厂商名排序）。
 */
export function groupByVendor(rates) {
  const groups = new Map()
  for (const [key, rate] of Object.entries(rates ?? {})) {
    if (rate === null || typeof rate !== 'object') continue
    const vendor = typeof rate.vendor === 'string' && rate.vendor.trim() !== '' ? rate.vendor.trim() : '未标注厂商'
    const bucket = groups.get(vendor) ?? []
    bucket.push({ key, rate })
    groups.set(vendor, bucket)
  }
  return [...groups.entries()]
    .map(([vendor, items]) => ({
      vendor,
      items: items.sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor))
}

/**
 * 按关键词过滤分组（模型键 / 显示名 / 厂商任一命中即可）。
 *
 * 大小写不敏感，且**忽略分隔符**：用户搜 `glm53` 也该搜到 `glm-5.3`
 * （与宿主 `normalizeModel` 的宽容度对齐，否则同一个名字在两处行为不一致）。
 * @param {{vendor:string,items:{key:string,rate:object}[]}[]} groups - 分组。
 * @param {string} query - 关键词。
 * @returns {{vendor:string,items:{key:string,rate:object}[]}[]} 过滤后的分组。
 */
export function filterGroups(groups, query) {
  const text = String(query ?? '').trim().toLowerCase()
  if (text === '') return groups
  const loose = text.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  const hit = (value) => {
    const raw = String(value ?? '').toLowerCase()
    return raw.includes(text) || loose === '' || raw.replace(/[^a-z0-9\u4e00-\u9fff]/g, '').includes(loose)
  }
  return groups
    .map((group) => ({
      vendor: group.vendor,
      items: group.items.filter((item) => hit(item.key) || hit(item.rate?.label) || hit(group.vendor)),
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * 把宿主回报的状态整理成「编辑页需要的整份文档」。
 *
 * `data.customRates`（宿主 `describe()` 的输出）与 `/dsh-pixel/rates` 的形状一致，
 * 因此两处都能喂进来；缺项一律取安全默认值，**绝不把 undefined 传回保存**——
 * 那会让校验报「顶层需要是一个对象」这种看不出所以然的错。
 * @param {object|undefined} status - 宿主状态。
 * @param {object} [pricing] - 看板数据的 pricing 段（只用它的 usdToCny 兜底）。
 * @returns {{rates:object,markup:Record<string,number>,usdToCny:number}} 文档。
 */
export function documentOf(status, pricing) {
  const fallbackFx = Number(pricing?.usdToCny)
  const fx = Number(status?.usdToCny)
  return {
    rates: status?.rates !== null && typeof status?.rates === 'object' ? status.rates : {},
    markup: status?.markup !== null && typeof status?.markup === 'object' ? status.markup : {},
    usdToCny: Number.isFinite(fx) && fx > 0
      ? fx
      : (Number.isFinite(fallbackFx) && fallbackFx > 0 ? fallbackFx : 7.3),
  }
}

/**
 * 解析一份导入的 JSON 文本。
 *
 * 只做「是不是合法 JSON / 是不是对象」这两件事：**内容校验交给宿主**。
 * 两处各写一份校验，迟早出现「界面说没问题、宿主拒绝」这种最难解释的分歧。
 * @param {string} text - 粘贴或读进来的文本。
 * @returns {{document:object}|{error:string}} 解析结果。
 */
export function parseImported(text) {
  const source = String(text ?? '').trim()
  if (source === '') return { error: '没有内容：先粘贴一份 JSON，或从文件里导出后再导入' }
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return { error: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '顶层需要是一个对象：{ rates, markup, usdToCny }' }
  }
  // 旧格式（扁平「模型键 → 价目」）也接住：整份当成 rates，否则升级插件会让导入失败。
  if (parsed.rates !== null && typeof parsed.rates === 'object' && !Array.isArray(parsed.rates)) {
    return { document: parsed }
  }
  return { document: { rates: parsed, markup: {}, usdToCny: undefined } }
}

/**
 * 导出成一段可读 JSON（写文件 / 粘贴给别的机器用）。
 * @param {object} document - 文档。
 * @returns {string} JSON 文本。
 */
export function exportDocument(document) {
  const payload = {
    ...(Number.isFinite(Number(document?.usdToCny)) ? { usdToCny: Number(document.usdToCny) } : {}),
    markup: document?.markup ?? {},
    rates: document?.rates ?? {},
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}