/**
 * 「单价设置」界面。
 *
 * 这个文件负责**只**回答一个问题：某个模型的单价是多少、我能不能改它。
 * 由看板的设置弹层（「单价」页签）与「费用明细」里的补价入口共同使用，
 * 因此**不持有**看板状态——数据与写回都通过 props 传入。
 *
 * 两个导出是看板侧的稳定接口（签名一改，看板与费用明细都要跟着改）：
 *   - {@link PriceSettingsView}：设置弹层里的整页（按提供商分页 + 编辑 + 导入导出）
 *   - {@link PriceSettingsButton}：费用明细里那一行「补价」入口（点开浮层编辑单个模型）
 *
 * ## 为什么按**提供商**分页
 *
 * 旧版把价目表里**所有**厂商的模型平铺在一页上（几十个模型、每家六格价格），
 * 用户的原话是「特别丑，一下子都不知道该怎么设置」。更根本的问题是那些厂商里
 * 大部分**用户根本没在用**：价目表随插件发布，而每个人的 DSH 里只接了其中几家。
 * 所以这一页的条目来源换成 `data.models`（用户自己的路由与用量），按提供商分栏：
 * 左栏是「我实际拥有的提供商」，右栏只画选中那一家下面的模型。没出现过的厂商
 * 一律不占版面。
 *
 * ## 为什么只显示两个数
 *
 * 每行只列「未命中 / 输出」两档（元 / 百万 token）。缓存命中那一档很少影响判断，
 * 六格平铺正是旧版「一屏输入框」的来源。分时定价的模型写成「空闲 / 高峰」一对，
 * 顺序在栏头说一次。徽标（不分时 / 按最低档）全部去掉：用户看不懂它们，而它们
 * 回答的问题（这个价是怎么来的）改用 `title` 悬停说明。
 *
 * ## 静态渲染（SSR）约束
 *
 * 这一页会被闸门用 `renderToStaticMarkup` 直接渲染（它在默认关闭的弹层里，
 * 整页渲染看不到它）。因此：
 *   - **默认态必须有内容**：提供商与模型来自 props 的 `data.models`，
 *     价目来自 `data.pricing.rates` / `data.customRates`，不依赖 effect 里的取数；
 *   - **默认态不出现表单**（`.px-price-form` / 新增表单），否则「一屏输入框」
 *     会盖掉清单；
 *   - 取数（`fetchRates`）只是进页面后的一次**校正**，失败也照常可用（旧宿主没有那条路由）。
 *
 * ## 三条界面口径（都不是装饰）
 *
 *   1) **校验只有宿主一份。** 这里不重复写「合不合法」的判断，只把候选文档 POST 上去，
 *      再如实展示宿主回的错误。两处各写一份，迟早出现「界面说没问题、宿主拒绝」。
 *   2) **改价不等于改口径。** 保存的是**覆盖条目**：内置价目仍原样保留，
 *      想回到官方价删掉覆盖即可（界面上有「恢复官方价」）。
 *   3) **金额一律人民币。** 美元价目在填写时可选 USD，但折算与展示口径只有一个：
 *      宿主按 `usdToCny` 折好再交下来，界面写「按汇率 X 折算」。
 *   4) **倍率不在界面上。** 旧版有一整块「我的倍率」，用户反馈「这个功能也没用」。
 *      宿主的 `markup` 能力保留（`pricing.markup` / `setMarkup`），界面不再展示、
 *      也不再改它；保存时把**读到的现有 markup 原样回传**，绝不清空用户已配的值。
 *
 * @module dsh-pixel-dashboard/client/priceSettings
 */

import React from 'react'
// 浮层必须 portal 到 body：它挂在**表格单元格**里，而表格外层有横向滚动容器
// （overflow 非 visible）。留在原地时浮层会被那个容器裁剪/带着滚动，还会把
// 单元格撑开——实测就是「浮层盖住表格、位置乱跳」。
// 与费用详情面板同一条规则：定位用 fixed，落点按锚点量出来。
// 这里用默认导入而不是 `import { createPortal }`：react-dom 在 Node 里是 CJS，
// 命名导出会被闸门的 ESM 直接 import 打挂（dashboard.js 里记过同一条坑）。
import ReactDOM from 'react-dom'
import {
  documentOf,
  draftOf,
  entryOfDraft,
  exportDocument,
  fetchRates,
  parseImported,
  saveRates,
} from './rates.js'

const h = React.createElement

/** 自定义条目那个伪提供商的 id。真提供商的 id 是 DSH 路由名，不会与它撞。 */
const EXTRA_ID = '\u0000extra'

/** 三个价档在界面上的顺序与说明。**只在编辑浮层里用**，清单里只列未命中 / 输出。 */
const PRICE_FIELDS = [
  { field: 'cacheHit', label: '缓存命中', hint: '命中缓存的输入 token 单价' },
  { field: 'cacheMiss', label: '未命中', hint: '未命中缓存的输入 token 单价' },
  { field: 'output', label: '输出', hint: '模型输出 token 单价' },
]

/**
 * 空表单的初值。
 *
 * 浮层打开时若推不出当前价（价目表里没有、也没有覆盖），**仍然要显示空表单**：
 * 用户点开就是为了填这一条。早先因为 `draft === null` 直接不渲染浮层，症状是
 * 「点了没反应、按钮却显示收起」。
 */
const EMPTY_DRAFT = { cacheHit: '', cacheMiss: '', output: '', currency: 'CNY' }

/**
 * 用「元 / 百万 token」显示一个数字：去掉多余的零，但不四舍五入到两位（小额会变成 0）。
 * @param {*} value - 任意值。
 * @returns {string} 文本；读不出数字时写「未知」（不写「—」：那不是一句人话）。
 */
function priceText(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '未知'
  if (amount === 0) return '0'
  if (Math.abs(amount) >= 100) return String(Math.round(amount * 100) / 100)
  return String(Math.round(amount * 1e6) / 1e6)
}

/**
 * 一个价档的展示文本。
 *
 * 宿主的价目里每档可能是 `{ idle, peak }`（分时）也可能是一个数（不分时）。
 * 分时且两档不同才写成「空闲 / 高峰」，同价只写一个数——摆两个相同的数纯属噪音。
 * @param {*} value - 价档值。
 * @returns {string} 文本。
 */
function pairText(value) {
  if (value === null || value === undefined) return '未知'
  if (typeof value !== 'object') {
    const single = Number(value)
    return Number.isFinite(single) ? priceText(single) : '未知'
  }
  const idle = Number(value.idle)
  const peak = Number(value.peak)
  const idleOk = Number.isFinite(idle)
  const peakOk = Number.isFinite(peak)
  if (!idleOk && !peakOk) return '未知'
  if (idleOk && peakOk && idle === peak) return priceText(idle)
  if (idleOk && peakOk) return priceText(idle) + ' / ' + priceText(peak)
  return priceText(idleOk ? idle : peak)
}

/**
 * 价档的悬停说明：把「这两个数分别是什么」说全。
 *
 * 界面上只显示两个数、不带标签（标签在栏头说一次），所以这一句是唯一能确认
 * 顺序的地方。**不分时 / 按最低档这类徽标已按用户要求去掉**，它们的含义移到这里。
 * @param {string} label - 档名。
 * @param {*} value - 价档值。
 * @returns {string} 悬停文本。
 */
function pairTitle(label, value) {
  const unit = ' 元 / 百万 token'
  if (value === null || typeof value !== 'object') return label + '：' + pairText(value) + unit
  const idle = Number(value.idle)
  const peak = Number(value.peak)
  const parts = []
  if (Number.isFinite(idle)) parts.push('空闲 ' + priceText(idle))
  if (Number.isFinite(peak)) parts.push('高峰 ' + priceText(peak))
  return label + '：' + (parts.length === 0 ? '未知' : parts.join('，')) + unit
}

/**
 * 取「编辑时该显示的数字」。
 *
 * 官方美元价目在宿主那边已经折成人民币（`native` 里留着原币值）。编辑时优先显示
 * **原币 + 原币种**：用户想改的通常是「官方那个 $2」，而不是「折算后的 14.6」——
 * 让他对着折算值改，下次改汇率就全乱了。人民币条目没有 `native`，直接用自己。
 * @param {object|undefined} rate - 价目条目（可能是宿主折好的视图）。
 * @returns {object|undefined} 适合编辑的条目。
 */
function editableRate(rate) {
  if (rate === null || typeof rate !== 'object') return undefined
  if (rate.native === null || typeof rate.native !== 'object') return rate
  return {
    ...rate,
    currency: rate.sourceCurrency ?? rate.native.currency ?? 'CNY',
    cacheHit: rate.native.cacheHit,
    cacheMiss: rate.native.cacheMiss,
    output: rate.native.output,
    ...(rate.native.cacheWrite === undefined ? { cacheWrite: undefined } : { cacheWrite: rate.native.cacheWrite }),
  }
}

/** 宿主回报的状态 → 可编辑的文档草稿。markup 只是**原样带着**，界面上不出现。 */
function draftDocument(status, pricing) {
  const base = documentOf(status, pricing)
  return {
    rates: { ...base.rates },
    markup: { ...base.markup },
    usdToCny: base.usdToCny,
  }
}

/** 把宿主抛出的错误拆成逐条展示的数组（`saveRates` 已把数组挂在 error 上）。 */
function errorLines(error) {
  const list = Array.isArray(error?.errors) ? error.errors : []
  if (list.length > 0) return list.map((line) => String(line))
  const message = error instanceof Error ? error.message : String(error)
  return message.trim() === '' ? ['保存失败：宿主没有给出原因'] : [message]
}

/**
 * 关键词匹配（模型键 / 显示名任一命中即可）。
 *
 * 大小写不敏感，且**忽略分隔符**：用户搜 `glm53` 也该搜到 `glm-5.3`
 * （与宿主 `normalizeModel` 的宽容度对齐，否则同一个名字在两处行为不一致）。
 * @param {string} text - 候选文本。
 * @param {string} query - 关键词。
 * @returns {boolean} 是否命中。
 */
function matchesQuery(text, query) {
  const target = String(text ?? '').toLowerCase()
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return true
  if (target.includes(needle)) return true
  const loose = needle.replace(/[^a-z0-9\u4e00-\u9fff]/g, '')
  if (loose === '') return false
  return target.replace(/[^a-z0-9\u4e00-\u9fff]/g, '').includes(loose)
}

/**
 * 把 `data.models` 汇总成「提供商 → 它的模型」。
 *
 * **只列用户实际拥有的提供商**（`data.models` 里出现过的），不铺价目表里的全部厂商：
 * 用户没接的厂商不该占版面。模型按**归一键**（`rollup`）去重——价目是按模型索引的，
 * 同一模型走多条路由时价目是同一份，逐条重复没有信息量。
 *
 * 自己加的条目（`overrides` 里、模型清单里没有的键）按写入时的 `vendor` 认领：
 * 命中某家的标签或路由名就归到那一家（这样「新增一条」加的东西下一次还能看到、
 * 还能删）；都认不出时集中到最后一个「其他条目」——它们仍然生效，不能让用户
 * 在界面上够不着。
 * @param {object[]|undefined} models - 宿主 `models[]`。
 * @param {Record<string, object>} overrides - 待保存文档里的 rates（模型键 → 条目）。
 * @returns {{id:string,label:string,models:object[]}[]} 提供商列表（沿用 models 的顺序）。
 */
function providersOf(models, overrides) {
  const buckets = new Map()
  /** 取（或建）某提供商的分桶。 */
  const bucketOf = (id, label) => {
    if (!buckets.has(id)) buckets.set(id, { id, label, models: [], keys: new Set() })
    return buckets.get(id)
  }
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model?.provider === 'string' ? model.provider.trim() : ''
    const rawLabel = typeof model?.providerLabel === 'string' ? model.providerLabel.trim() : ''
    const bucket = bucketOf(id, rawLabel !== '' ? rawLabel : (id === '' ? '来源未知' : id))
    const key = typeof model?.rollup === 'string' && model.rollup !== ''
      ? model.rollup
      : (typeof model?.key === 'string' ? model.key : '')
    if (key === '' || bucket.keys.has(key)) continue
    bucket.keys.add(key)
    bucket.models.push({
      key,
      label: typeof model?.label === 'string' && model.label !== '' ? model.label : key,
      priced: model?.priced !== false,
      tiered: model?.tiered === true,
      routes: Array.isArray(model?.routes) ? model.routes.length : 0,
      custom: false,
    })
  }
  // 自己加的条目：vendor → 提供商。标签可能重复（极端情形），先到先得。
  const ownerOf = new Map()
  for (const bucket of buckets.values()) {
    if (!ownerOf.has(bucket.label)) ownerOf.set(bucket.label, bucket.id)
    if (bucket.id !== '' && !ownerOf.has(bucket.id)) ownerOf.set(bucket.id, bucket.id)
  }
  const leftovers = []
  for (const [key, rate] of Object.entries(overrides ?? {})) {
    if (rate === null || typeof rate !== 'object') continue
    let listed = false
    for (const bucket of buckets.values()) {
      if (bucket.keys.has(key)) { listed = true; break }
    }
    if (listed) continue
    const row = {
      key,
      label: typeof rate.label === 'string' && rate.label.trim() !== '' ? rate.label.trim() : key,
      priced: true,
      tiered: rate.tiered === true,
      routes: 0,
      custom: true,
    }
    const vendor = typeof rate.vendor === 'string' ? rate.vendor.trim() : ''
    const owner = ownerOf.get(vendor)
    if (owner === undefined) { leftovers.push(row); continue }
    const bucket = buckets.get(owner)
    bucket.keys.add(key)
    bucket.models.push(row)
  }
  for (const bucket of buckets.values()) bucket.models.sort((a, b) => a.key.localeCompare(b.key))
  // 顺序**保持 data.models 的顺序**（宿主按用量降序给），不按名字重排：
  // 左栏第一行就是用户用得最多的那一家，默认选中它——打开设置页正好落在
  // 他大概率要改的那一页上，而不是按拼音/字母碰运气。
  const list = [...buckets.values()]
  if (leftovers.length > 0) {
    leftovers.sort((a, b) => a.key.localeCompare(b.key))
    list.push({ id: EXTRA_ID, label: '其他条目', models: leftovers })
  }
  return list
}

/**
 * 单价设置整页。
 * @param {object} props - data（看板数据，含 data.models / data.pricing / data.customRates）、onSaved（保存后回调）。
 * @returns {object|null} React 元素。
 */
export function PriceSettingsView(props) {
  const { data, onSaved } = props ?? {}
  const pricing = data?.pricing
  const effective = pricing?.rates !== null && typeof pricing?.rates === 'object' ? pricing.rates : {}
  const [doc, setDoc] = React.useState(() => draftDocument(data?.customRates, pricing))
  const [status, setStatus] = React.useState(() => data?.customRates ?? null)
  const [query, setQuery] = React.useState('')
  const [selectedId, setSelectedId] = React.useState(null)
  const [adding, setAdding] = React.useState(false)
  const [addDraft, setAddDraft] = React.useState(null)
  const [addError, setAddError] = React.useState('')
  const [errors, setErrors] = React.useState([])
  const [notice, setNotice] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [io, setIo] = React.useState({ open: false, text: '', error: '' })

  // 进页面后向宿主校正一次真实状态：`data.customRates` 来自看板取数（有 TTL 缓存），
  // 可能落后几十秒，而用户刚在这里改过价时那种「落后」会让人以为没生效。
  // **默认态不依赖它**（旧宿主 / 请求失败时清单照常显示），因此这里失败就安静降级。
  React.useEffect(() => {
    let alive = true
    fetchRates()
      .then((fresh) => {
        if (!alive) return
        setStatus(fresh)
        setDoc(draftDocument(fresh, pricing))
      })
      .catch(() => { /* 老宿主没有 /rates 路由：用 props 里那一份 */ })
    return () => { alive = false }
    // 只在挂载时取一次：本页自己保存后会直接用响应刷新，不必反复回取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 用户实际拥有的提供商（只来自 data.models + 自己加的条目）。 */
  const providers = React.useMemo(
    () => providersOf(data?.models, doc.rates),
    [data?.models, doc.rates],
  )

  // 选中的提供商：默认第一家。数据刷新后原来那家可能不在了（换了时间窗口），
  // 因此每次都按 id 重新定位，定位不到就落回第一家——**不要**用 effect 去同步，
  // 那会在两次渲染之间留一个「左栏没有选中项」的中间态。
  const active = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null

  /** 某家下面的一行：模型 + 当前生效价 + 是否我改过。 */
  const rowOf = (provider) => (model) => {
    const override = doc.rates[model.key]
    const mine = override !== null && typeof override === 'object'
    const rate = (mine ? override : undefined) ?? effective[model.key] ?? {}
    return { ...model, mine, rate }
  }

  const rows = active === null
    ? []
    : active.models
      .map(rowOf(active))
      .filter((row) => matchesQuery(row.key + ' ' + row.label, query))

  /** 所有已经出现在页面里的模型键：新增时要拒绝重复。 */
  const listedKeys = React.useMemo(() => {
    const keys = new Set()
    for (const provider of providers) for (const model of provider.models) keys.add(model.key)
    return keys
  }, [providers])

  /**
   * 删掉一条覆盖（内置模型 = 回到官方价；自己加的条目 = 整条删掉）。
   *
   * **必须立刻落盘**，不能只改本地草稿等用户再点「保存单价」。
   * 用户实测：「点了恢复官方价，关掉设置面板再打开，又要重新恢复」——
   * 因为原来只改了组件状态，没写文件。恢复是一个**独立且完整**的动作，
   * 用户点它就是要生效，不该再等第二次确认。
   * @param {string} key - 归一键。
   * @returns {Promise<void>} 完成。
   */
  const removeOverride = async (key) => {
    if (saving === true) return
    setErrors([])
    setNotice('')
    setSaving(true)
    try {
      // 以**宿主当前状态**为底，删掉这一个键，再把整份文档提交上去。
      // 用宿主状态而不是本地草稿：本地草稿可能含还没保存的编辑，那会把它们一起写进去。
      const status = await fetchRates()
      const base = draftDocument(status, props?.pricing)
      const nextRates = { ...base.rates }
      delete nextRates[key]
      const response = await saveRates({ ...base, rates: nextRates })
      setStatus(response)
      setDoc((current) => ({ ...current, rates: nextRates }))
      setNotice(response?.persisted === false
        ? `已恢复「${key}」的官方价，但没能写进文件`
        : `已恢复「${key}」的官方价`)
      if (typeof onSaved === 'function') onSaved(response)
    } catch (error) {
      setErrors(errorLines(error))
    } finally {
      setSaving(false)
    }
  }

  /** 新增一条：把「模型键 / 未命中 / 输出」整理成覆盖条目，插到当前提供商下面。 */
  const commitAdd = () => {
    if (active === null) return
    const key = String(addDraft?.key ?? '').trim()
    if (key === '') {
      setAddError('先填模型键，与你在 DSH 路由里看到的模型名一致即可，例如 deepseek-flash')
      return
    }
    if (listedKeys.has(key)) {
      setAddError(`「${key}」已经在列表里了，直接改那一行的单价`)
      return
    }
    const entry = entryOfDraft({
      label: key,
      // vendor 是「这条属于哪一家」的唯一线索：保存后重新进来靠它归位。
      vendor: active.label,
      currency: 'CNY',
      cacheMissIdle: addDraft?.cacheMiss,
      outputIdle: addDraft?.output,
    })
    if (entry === undefined) {
      setAddError('至少填「未命中」或「输出」其中一项，否则这条覆盖没有任何意义')
      return
    }
    setDoc((current) => ({ ...current, rates: { ...current.rates, [key]: entry } }))
    setAdding(false)
    setAddDraft(null)
    setAddError('')
    setQuery('')
    setNotice(`已加入「${key}」，点「保存单价」后生效`)
  }

  const save = async () => {
    setSaving(true)
    setErrors([])
    setNotice('')
    try {
      // 整份文档原样提交：rates 是覆盖值，markup 是**读到的现有值**（界面上不再提供
      // 入口，但要原样带着走，否则保存一次就把用户以前配的倍率清空了）。
      const response = await saveRates(doc)
      const fresh = response ?? doc
      setStatus(fresh)
      setDoc(draftDocument(fresh, pricing))
      setNotice(fresh?.persisted === false
        ? '已在本次运行内生效，但没能写进文件（看下方原因）'
        : '已保存。刷新看板即可看到新价。')
      if (typeof onSaved === 'function') onSaved(fresh)
    } catch (error) {
      // 校验失败**一个字节都没落盘**：宿主的 save() 先校验再写文件。
      setErrors(errorLines(error))
    } finally {
      setSaving(false)
    }
  }

  const doExport = () => {
    const text = exportDocument(doc)
    setIo({ open: true, text, error: '' })
    // 能写剪贴板就写好：导出的主要用途就是搬到另一台机器上。
    try { navigator.clipboard?.writeText?.(text)?.catch?.(() => {}) } catch { /* 剪贴板不可用就算了 */ }
  }

  const doImport = () => {
    const parsed = parseImported(io.text)
    if (parsed.error !== undefined) { setIo((current) => ({ ...current, error: parsed.error })); return }
    const imported = draftDocument(parsed.document, pricing)
    // 旧格式 / 手写 JSON 里常常没有 markup。缺它时**保留现有值**，不要用 {} 覆盖：
    // 那等于「导入一份单价，顺手清空别人的倍率配置」。
    const carriesMarkup = parsed.document?.markup !== null && typeof parsed.document?.markup === 'object'
    setDoc((current) => ({ ...imported, markup: carriesMarkup ? imported.markup : current.markup }))
    setIo({ open: true, text: '', error: '' })
    setAdding(false)
    setAddDraft(null)
    setNotice('已读入这份 JSON，确认无误后点「保存单价」才会真正生效')
  }

  /**
   * 浮层里直接保存成功后，把这一条并回本页的待保存文档。
   *
   * 浮层（{@link PriceSettingsButton}）是**直接落盘**的，而本页的改动还在草稿里。
   * 不并回来的话：用户先改了两行、又在某一行用浮层保存，接着点「保存单价」——
   * 本页那份旧草稿会把浮层刚写进去的那条盖掉（界面显示成功、文件里却没有）。
   * @param {string} key - 归一键。
   * @returns {(fresh:object)=>void} onSaved 回调。
   */
  const mergeSaved = (key) => (fresh) => {
    if (fresh !== null && typeof fresh === 'object') {
      setStatus(fresh)
      setDoc((current) => {
        const next = { ...current, rates: { ...current.rates } }
        const saved = fresh?.rates?.[key]
        if (saved !== undefined) next.rates[key] = saved
        else delete next.rates[key]
        if (fresh?.markup !== null && typeof fresh?.markup === 'object') next.markup = fresh.markup
        return next
      })
    }
    setNotice(`「${key}」已直接保存到宿主；本页其它还没保存的改动仍然保留`)
  }

  /**
   * 一个模型那一行。
   *
   * 拆成函数而不是嵌在 JSX 里：这一块有「当前值 / 是否我改过 / 是否分档 /
   * 是否外币 / 是否自定义」五组条件，平铺在一处会变成一屏读不完的嵌套三元表达式。
   * @param {object} row - 模型行（providersOf + rowOf 合并后的结果）。
   * @returns {object} React 元素。
   */
  const renderRow = (row) => {
    const rate = row.rate ?? {}
    // 分档/外币这类「这个数字是怎么来的」不再做成徽标，只在悬停时说一句。
    const extra = []
    if (row.tiered === true) extra.push('官方按输入长度分档，这里取最低档')
    if (rate.sourceCurrency === 'USD') {
      extra.push(`官方原价是美元，按汇率 ${rate.fx ?? doc.usdToCny} 折算`)
    }
    const note = extra.length === 0 ? '' : '；' + extra.join('；')
    const official = typeof rate.label === 'string' ? rate.label : ''
    return h('div', {
      className: 'px-price-item px-price-item-head' + (row.mine ? ' mine' : ''),
      key: row.key,
    },
    h('div', { className: 'px-price-item-name' },
      h('b', {
        title: official !== '' && official !== row.label ? `内置价目里的名字：${official}` : undefined,
      }, row.label),
      h('code', {
        className: 'px-muted',
        title: row.routes > 1 ? `合并了 ${row.routes} 条路由` : undefined,
      }, row.key),
      row.custom ? h('span', { className: 'px-price-item-tag', title: '你自己加的条目，不在插件内置价目里' }, '自定义') : null,
      row.priced === false ? h('span', { className: 'px-price-item-tag', title: '价目表里没有这个模型，暂按 Flash 的单价估算' }, '估算') : null),
    h('span', {
      className: 'px-price-cell px-price-cell-miss',
      title: pairTitle('未命中', rate.cacheMiss) + note,
    },
    h('i', { className: 'px-price-cell-label' }, '未命中'),
    pairText(rate.cacheMiss)),
    h('span', {
      className: 'px-price-cell px-price-cell-out',
      title: pairTitle('输出', rate.output) + note,
    },
    h('i', { className: 'px-price-cell-label' }, '输出'),
    pairText(rate.output)),
    h('span', { className: 'px-price-item-actions' },
      // 复用费用明细那一枚「改单价」：同一套浮层、同一套保存口径，不另写一套。
      h(PriceSettingsButton, {
        modelKey: row.key,
        label: row.label,
        rate: row.rate,
        pricing,
        markup: doc.markup,
        onSaved: mergeSaved(row.key),
      }),
      row.mine
        ? h('button', {
          type: 'button',
          className: 'px-fix-link px-price-reset',
          title: '删掉这条覆盖，回到插件内置的官方价',
          onClick: () => removeOverride(row.key),
        }, '恢复官方价')
        : null))
  }

  /**
   * 「新增一条」：在右栏顶部插一行可编辑的自定义模型。
   *
   * 旧版这一枚按钮点了只把搜索词当键塞进文档、再打开一个表单，用户看到的
   * 就是「点了没反应」。这里改成**明确的就地表单**：填模型键 / 未命中 / 输出
   * 就能记下，保存后归属于当前选中的提供商。
   * @param {object|null} provider - 当前提供商。
   * @returns {object|null} React 元素。
   */
  const renderAdd = (provider) => {
    // 「其他条目」是个只读的收容所：里面没有稳定归属，不让往里加。
    if (provider === null || provider.id === EXTRA_ID) return null
    if (adding !== true) {
      return h('div', { className: 'px-price-add' },
        h('button', {
          type: 'button',
          className: 'px-btn small',
          onClick: () => {
            setAdding(true)
            setAddDraft({ key: '', cacheMiss: '', output: '' })
            setAddError('')
            setNotice('')
          },
        }, '新增一条'),
        h('span', { className: 'px-muted px-note' },
          '给「' + provider.label + '」补一个内置价目里没有的模型（只需要填模型键与两个价）。'))
    }
    const field = (name, label, placeholder) => h('label', { className: 'px-rate-field', key: name },
      h('span', { className: 'px-rate-field-label' }, label),
      h('input', {
        className: 'px-input',
        type: 'text',
        inputMode: name === 'key' ? undefined : 'decimal',
        placeholder,
        value: addDraft?.[name] ?? '',
        onChange: (event) => setAddDraft((current) => ({ ...(current ?? {}), [name]: event.target.value })),
      }))
    return h('div', { className: 'px-price-add px-price-add-open' },
      h('div', { className: 'px-price-add-head' },
        h('b', null, '在「' + provider.label + '」下面新增一个模型'),
        h('span', { className: 'px-muted px-note' }, '单位同样是元 / 百万 token；不分时只填一个数即可。')),
      h('div', { className: 'px-price-add-fields' },
        field('key', '模型键', '例如 my-model-v1'),
        field('cacheMiss', '未命中', '0'),
        field('output', '输出', '0')),
      addError !== '' ? h('p', { className: 'px-price-inline-error' }, addError) : null,
      h('div', { className: 'px-price-actions' },
        h('button', { type: 'button', className: 'px-btn small primary', onClick: commitAdd }, '记下这条'),
        h('button', {
          type: 'button',
          className: 'px-btn small',
          onClick: () => { setAdding(false); setAddDraft(null); setAddError('') },
        }, '取消')))
  }

  const hostErrors = Array.isArray(status?.errors) ? status.errors : []
  const filePath = typeof status?.path === 'string' && status.path !== ''
    ? status.path
    : '(这台机器上还没确定价目文件路径——可能是旧宿主)'
  const overrides = Object.keys(doc.rates).length
  const mineCount = active === null
    ? 0
    : active.models.filter((model) => doc.rates[model.key] !== undefined).length

  return h('div', { className: 'px-price-settings' },
    h('p', { className: 'px-price-head' },
      h('b', null, '各模型单价'),
      '（元 / 百万 token，分时的写作「空闲 / 高峰」）。价目随插件发布，这里只列',
      h('b', null, '你在 DSH 里接过的提供商'),
      '；改的是',
      h('b', null, '你的覆盖值'),
      '，保存后立刻参与计价，并',
      h('b', null, '不再标「估算价」'),
      '。'),

    // ── 汇率（用户认可的既有能力，保持原样）────────────────────────
    h('div', { className: 'px-price-fx' },
      h('label', { className: 'px-rate-field', title: '美元价目的官方价按这个汇率折成人民币参与合计' },
        h('span', { className: 'px-rate-field-label' }, '汇率'),
        h('span', { className: 'px-muted' }, '1 美元 ='),
        h('input', {
          type: 'number',
          step: '0.01',
          min: '0',
          className: 'px-input',
          value: Number.isFinite(Number(doc.usdToCny)) ? String(doc.usdToCny) : '',
          disabled: saving,
          onChange: (event) => {
            const next = event.target.value
            setDoc((current) => ({ ...current, usdToCny: next === '' ? undefined : Number(next) }))
          },
        }),
        h('span', { className: 'px-muted' }, '元')),
      h('span', { className: 'px-muted px-note' },
        'OpenAI / Anthropic / Google / xAI 的官方价是美元，按这个汇率折算后与人民币价目相加。'
        + '改汇率会同时改变所有美元条目的金额。')),

    // ── 提供商分栏 ──────────────────────────────────────────────
    providers.length === 0
      ? h('p', { className: 'px-muted' },
        '这个时间窗口里还没有出现过模型，等有调用后这里会按提供商列出来。'
        + '急用的话可以点下面的「导入 / 导出 JSON」直接写一份价目。')
      : h('div', { className: 'px-price-console' },
        h('nav', { className: 'px-price-nav', 'aria-label': '提供商' },
          h('span', { className: 'px-price-nav-title' }, '提供商（按你接的那些）'),
          providers.map((provider) => {
            const on = active !== null && provider.id === active.id
            const changed = provider.models.filter((model) => doc.rates[model.key] !== undefined).length
            return h('button', {
              key: provider.id === '' ? '__unknown__' : provider.id,
              type: 'button',
              className: 'px-price-provider' + (on ? ' on' : ''),
              'aria-current': on ? 'true' : undefined,
              title: provider.id === EXTRA_ID
                ? '不属于当前任何提供商的自定义条目'
                : (provider.id === ''
                  ? '旧账本记录里没有提供商信息'
                  : '路由名 ' + provider.id),
              onClick: () => {
                setSelectedId(provider.id)
                setQuery('')
                setAdding(false)
                setAddDraft(null)
                setAddError('')
              },
            },
            h('span', { className: 'px-price-provider-label' }, provider.label),
            h('span', { className: 'px-price-provider-meta' },
              // **不再按提供商显示「M 条已改」**：单价是按**模型**存的，跨提供商共用，
              // 所以同一个模型在每家下面都会被标成「已改」。按家报数字会让用户以为
              // 「我只改了一家，怎么每家都说改过」——实测被当成 bug 报上来。
              // 这里只报模型数；「改过几条」统一在右栏标题里说一次，并写明口径。
              provider.models.length + ' 个模型'))
          })),
        h('section', { className: 'px-price-pane' },
          h('div', { className: 'px-price-pane-head' },
            h('b', { className: 'px-price-pane-title' }, active.label),
            h('span', { className: 'px-muted px-note', title: '单价按模型保存：同一个模型被多家提供商共用时，改一次对所有家生效' },
              mineCount > 0
                ? `${mineCount} 条已改（按模型共用，改一次对所有提供商生效）`
                : '还没改过这里的价'),
            h('div', { className: 'px-price-filters' },
              h('label', { className: 'px-rate-field' },
                h('span', { className: 'px-rate-field-label' }, '搜索'),
                h('input', {
                  type: 'search',
                  className: 'px-input px-price-search',
                  placeholder: '在这个提供商里筛选模型',
                  value: query,
                  onChange: (event) => setQuery(event.target.value),
                })))),
          // 新增入口放在清单**顶部**：点开后就地展开一行可填的表单，
          // 不跳页、不弹窗，填完立刻出现在下面这份清单里。
          renderAdd(active),
          h('div', { className: 'px-price-list' },
            h('div', { className: 'px-price-list-head' },
              h('span', null, '模型'),
              h('span', null, '未命中'),
              h('span', null, '输出'),
              h('span', null, '')),
            rows.length === 0
              ? h('p', { className: 'px-muted px-note' },
                query === ''
                  ? '这家下面还没有模型。'
                  : '这家下面没有匹配「' + query + '」的模型。搜索只在这个提供商里生效。')
              : rows.map(renderRow)))),

    // ── 导入 / 导出 ─────────────────────────────────────────────
    h('div', { className: 'px-price-io' },
      h('div', { className: 'px-price-actions' },
        h('button', {
          type: 'button',
          className: 'px-btn small',
          onClick: () => setIo((current) => ({ open: !current.open, text: current.open ? '' : current.text, error: '' })),
        }, io.open ? '收起 JSON' : '导入 / 导出 JSON'),
        h('button', { type: 'button', className: 'px-btn small', onClick: doExport, disabled: saving }, '导出（并复制）')),
      io.open
        ? h('div', { className: 'px-price-io-body' },
          h('textarea', {
            className: 'px-input px-price-json',
            spellCheck: false,
            rows: 8,
            placeholder: '{ "rates": { "my-model": { "cacheMiss": 2, "output": 8 } } }',
            value: io.text,
            onChange: (event) => setIo((current) => ({ ...current, text: event.target.value, error: '' })),
          }),
          io.error !== '' ? h('p', { className: 'px-price-inline-error' }, io.error) : null,
          h('div', { className: 'px-price-actions' },
            h('button', { type: 'button', className: 'px-btn small', onClick: doImport, disabled: saving }, '读入这段 JSON'),
            h('span', { className: 'px-muted px-note' }, '旧格式（顶层直接是「模型键 → 价目」）也能读入。')))
        : null),

    // ── 错误与保存 ──────────────────────────────────────────────
    errors.length > 0
      ? h('ul', { className: 'px-price-errors' }, errors.map((line) => h('li', { key: line }, line)))
      : null,
    hostErrors.length > 0
      ? h('ul', { className: 'px-price-errors' },
        hostErrors.map((line) => h('li', { key: line }, `文件里的这一条没生效：${line}`)))
      : null,
    typeof status?.error === 'string' && status.error !== ''
      ? h('p', { className: 'px-price-inline-error' }, `价目文件读写有问题：${status.error}`)
      : null,
    notice !== '' ? h('p', { className: 'px-muted px-note px-price-notice' }, notice) : null,
    h('div', { className: 'px-price-save' },
      h('button', { type: 'button', className: 'px-btn primary', disabled: saving, onClick: save },
        saving ? '保存中…' : '保存单价'),
      h('span', { className: 'px-muted px-note' }, `共 ${overrides} 条覆盖 · 文件：${filePath}`)),
  )
}

/**
 * 三个价档的六格输入（外加显示名 / 厂商 / 币种）。
 *
 * 每档都是「空闲 / 高峰」一对：**填两个一样的数就是不分成**。之所以坚持成对出现，
 * 是因为只显示一个数时用户无法表达「这个模型分时定价」，而错档正是这里最常见的错。
 * @param {object} props - draft / onChange。
 * @returns {object} React 元素。
 */
function PriceFields(props) {
  const { draft, onChange } = props
  const set = (key) => (event) => onChange?.({ ...draft, [key]: event.target.value })
  const field = (key, label) => h('label', { className: 'px-rate-field', key },
    h('span', { className: 'px-rate-field-label' }, label),
    h('input', {
      className: 'px-input',
      type: 'text',
      inputMode: 'decimal',
      value: draft?.[key] ?? '',
      onChange: set(key),
    }))
  return h('div', { className: 'px-price-form' },
    field('label', '显示名'),
    field('vendor', '厂商'),
    h('label', { className: 'px-rate-field', title: '美元价目选 USD；人民币选 CNY' },
      h('span', { className: 'px-rate-field-label' }, '币种'),
      h('select', { className: 'px-input', value: draft?.currency ?? 'CNY', onChange: set('currency') },
      h('option', { value: 'CNY' }, 'CNY'),
      h('option', { value: 'USD' }, 'USD'))),
    h('div', { className: 'px-rate-pairs' },
      PRICE_FIELDS.map((meta) => h('div', { className: 'px-rate-pair', key: meta.field },
        h('b', { title: meta.hint }, meta.label),
        field(`${meta.field}Idle`, '空闲'),
        field(`${meta.field}Peak`, '高峰')))))
}

/**
 * 单个模型的补价入口（费用明细 / 单价设置页每一行）。
 *
 * 与整页共用同一套表单与保存口径，区别只有两点：只编辑一个模型，且**先向宿主取一次**
 * 当前的覆盖值（手里那份可能只是生效价，分不清哪部分是用户改过的）。
 *
 * 关闭态返回的是「只有一枚按钮」的 span——**不是 null**：按钮本身必须常驻，
 * 用户才看得到入口；而表单项在关闭态一个都不渲染（否则会撑开表格行）。
 * @param {object} props - modelKey（归一键）/ label（显示名）/ rate / pricing / markup / onSaved。
 * @returns {object|null} React 元素。
 */
export function PriceSettingsButton(props) {
  const { modelKey, label, onSaved } = props ?? {}
  const rollup = String(modelKey ?? '').split('@')[0]
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(null)
  const [errors, setErrors] = React.useState([])
  const [notice, setNotice] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  /**
   * 浮层落点（null = 还没量）。
   *
   * ## 为什么必须量、不能纯 CSS 定位
   *
   * 这个按钮在**表格行**里，父级有横向滚动容器。`position: absolute` 会被那个
   * 容器裁剪，而 `right: 0` 会让 340px 宽的浮层向左盖住模型名与前几列——
   * 实测截图里看到的就是这个。因此改成 portal 到 body + `position: fixed`，
   * 位置按按钮的实际矩形算，空间不够时**向上翻**。
   */
  const [pos, setPos] = React.useState(null)
  const wrapRef = React.useRef(null)
  const popRef = React.useRef(null)

  /** 量一次锚点，算出浮层落点（水平夹进视口，垂直优先向下、放不下就向上）。 */
  const place = React.useCallback(() => {
    const node = wrapRef.current
    if (node === null || typeof window === 'undefined') return
    const rect = node.getBoundingClientRect()
    const width = Math.min(360, Math.max(260, window.innerWidth - 32))
    const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
    // 浮层高度按内容估算（六个价框 + 标题 + 按钮约 300px）；不够就翻到上面去。
    const room = window.innerHeight - rect.bottom
    const top = room < 320 ? Math.max(12, rect.top - 312) : rect.bottom + 6
    setPos({ left, top, width })
  }, [])

  React.useEffect(() => {
    if (!open) return undefined
    place()
    /**
     * 三条关闭路径，与详情面板同一套：Esc、点外面、窗口变化。
     * 尺寸一变旧坐标就失效，继续显示只会落在错误的位置。
     */
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
    const onDown = (event) => {
      const wrap = wrapRef.current
      const pop = popRef.current
      if (wrap !== null && wrap.contains(event.target)) return
      if (pop !== null && pop.contains(event.target)) return
      // 正在操作浮层里的原生下拉框（币种）时不关：某些平台上点选项那一下
      // 会派发到 document 上，表现就是「一点下拉，浮层没了」。
      const active = document.activeElement
      const tag = String(active?.tagName ?? '').toUpperCase()
      if (tag === 'SELECT' || tag === 'INPUT') return
      setOpen(false)
    }
    const onResize = () => { setOpen(false) }
    document.addEventListener('keydown', onKey, true)
    // pointerdown 而不是 click：按住拖动时 click 要等抬起，浮层会一直开着。
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, place])

  /**
   * 浮层节点**延迟构造**（函数而不是常量）。
   *
   * 这不是风格问题：浮层里要挂「保存这条」按钮，而 `submit` 是下面的 `const`。
   * 若在**这里**就把元素构造出来（`const popover = h(... onClick: submit ...)`），
   * 本函数体执行时 `submit` 还在暂时性死区 → 抛 ReferenceError → 整个看板白屏。
   * 实测：点了「补价」后整页变空白。
   * 包成函数后，构造发生在 `return` 那一句（`submit` 已初始化），因此安全。
   *
   * ## 判据只看 `open`，不看 `draft`
   *
   * 早先要求 `draft !== null` 才渲染。而 `draft` 是由「当前生效价」推出来的，
   * 某些模型（价目表里没有、且没有覆盖）推出来是空的，于是**按钮已经变成「收起」、
   * 浮层却一个节点都没渲染**——用户报的「点改单价没反应，直接显示收起」就是这个。
   * 现在只要打开就渲染，字段为空就显示空表单（用户自己填，正是「新增一条」的用途）。
   */
  const popoverOf = () => (open && typeof document !== 'undefined'
    ? ReactDOM.createPortal(
      h('div', {
        className: 'px-price-pop px-price-editor px-price-pop-fixed',
        ref: popRef,
        role: 'dialog',
        'aria-label': `改单价：${rollup}`,
        style: pos === null
          ? { visibility: 'hidden' }
          : { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` },
      },
      h('p', { className: 'px-price-pop-title' },
        h('b', null, label ?? rollup),
        h('code', { className: 'px-muted' }, rollup)),
      h(PriceFields, { draft: draft ?? EMPTY_DRAFT, onChange: setDraft }),
      errors.length > 0
        ? h('ul', { className: 'px-price-errors' }, errors.map((line) => h('li', { key: line }, line)))
        : null,
      notice !== '' ? h('p', { className: 'px-muted px-note' }, notice) : null,
      h('div', { className: 'px-price-actions' },
        h('button', { type: 'button', className: 'px-btn small primary', disabled: saving, onClick: submit },
          saving ? '保存中…' : '保存这条'),
        h('span', { className: 'px-muted px-note' }, '保存后不再标「估算价」'))),
      document.body)
    : null)

  /**
   * 开关浮层。
   *
   * **打开时立刻量一次锚点**（用事件目标，而不是等 effect）：effect 要等这一帧画完，
   * 期间浮层是 `visibility: hidden`；万一测量失败（父级未挂载、容器 0 宽等），
   * 它会**一直**不可见。点击时同步拿到矩形，至少保证可见且落在按钮附近。
   * @param {object} [event] - 点击事件（可选，测试里可能不给）。
   */
  const toggle = (event) => {
    const next = !open
    setOpen(next)
    setErrors([])
    setNotice('')
    if (!next) return
    // 同步定位：拿按钮矩形算一次，作为 effect 之前的兜底。
    const target = event?.currentTarget ?? wrapRef.current
    if (target !== null && target !== undefined && typeof window !== 'undefined') {
      const rect = target.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) {
        const width = Math.min(360, Math.max(260, window.innerWidth - 32))
        const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))
        const room = window.innerHeight - rect.bottom
        const top = room < 320 ? Math.max(12, rect.top - 312) : rect.bottom + 6
        setPos({ left, top, width })
      }
    }
    // 打开时按**当前生效价**预填，并把宿主里的覆盖值叠上去（有的话）。
    // `draftOf` 可能给出空值，那也要能打开（空表单可编辑，不是不显示）。
    setDraft(draftOf(editableRate(props?.rate)) ?? EMPTY_DRAFT)
    fetchRates()
      .then((status) => {
        const mine = status?.rates?.[rollup]
        if (mine !== undefined) setDraft(draftOf(editableRate(mine)) ?? EMPTY_DRAFT)
      })
      .catch(() => { /* 老宿主没有这条路由：就用生效价预填 */ })
  }

  const submit = async () => {
    const entry = entryOfDraft(draft ?? {}, props?.rate)
    if (entry === undefined) {
      setErrors(['至少填「未命中」或「输出」其中一档'])
      return
    }
    setSaving(true)
    setErrors([])
    try {
      // **不能**在取不到宿主状态时拿空 rates 去提交：那会把别的覆盖条目整批删掉。
      // 读不到就明说，而不是「保存成功」了一个只剩一条的文件。
      const status = await fetchRates()
      const doc = draftDocument(status, props?.pricing)
      doc.rates[rollup] = entry
      // 界面上不再有倍率入口，但保存整份文档时要把它原样带回去（否则会清空）。
      if (doc.markup === null || typeof doc.markup !== 'object') {
        doc.markup = props?.markup !== null && typeof props?.markup === 'object' ? props.markup : {}
      }
      const response = await saveRates(doc)
      setNotice(response?.persisted === false ? '已生效，但没能写进文件' : '已保存')
      if (typeof onSaved === 'function') onSaved(response)
      setOpen(false)
    } catch (error) {
      setErrors(errorLines(error))
    } finally {
      setSaving(false)
    }
  }

  return h('span', { className: 'px-price-fix', ref: wrapRef },
    h('button', {
      type: 'button',
      // 这是一枚**次要操作**（只是修正一个单价），不该长得和「保存」一样重。
      // 早先是 px-btn small（有边框有阴影），在费用明细里每行一枚，整列都是按钮，
      // 观感很吵（用户原话「这个按钮很丑」）。改成链接式小按钮：无底无边，
      // 只在悬停时出现下划线。
      className: 'px-fix-link',
      title: '这个模型的实际单价与官方价目不同？点这里改成你的价',
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      onClick: toggle,
    }, open ? '收起' : '改单价'),
    popoverOf())
}
