/**
 * 「单价设置」界面。
 *
 * 这个文件负责**只**回答一个问题：某个模型的单价是多少、我能不能改它。
 * 由看板的设置弹层（「单价」页签）与「费用明细」里的补价入口共同使用，
 * 因此**不持有**看板状态——数据与写回都通过 props 传入。
 *
 * 两个导出是看板侧的稳定接口（签名一改，看板与费用明细都要跟着改）：
 *   - {@link PriceSettingsView}：设置弹层里的整页（厂商分组 + 搜索 + 编辑 + 导入导出）
 *   - {@link PriceSettingsButton}：费用明细里那一行「补价」入口（点开浮层编辑单个模型）
 *
 * ## 为什么清单常驻、表单点开才出现
 *
 * 设置页要同时回答四个问题：汇率是多少、每家倍率多少、有哪些模型、怎么批量导入。
 * 一进来就把几十个模型的六格价格全铺开，反而会把「有哪些模型」这条主线淹掉——
 * 所以**清单**是默认态，**表单**由某一行的「改这条」点开（一次只编辑一个）。
 *
 * ## 静态渲染（SSR）约束
 *
 * 这一页会被闸门用 `renderToStaticMarkup` 直接渲染（它在默认关闭的弹层里，
 * 整页渲染看不到它）。因此：
 *   - **默认态必须有内容**：清单来自 props 的 `data.pricing.rates` / `data.customRates`，
 *     不依赖 effect 里的取数；
 *   - **默认态不出现表单**（`px-price-form`），否则「一屏输入框」会盖掉清单；
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
  filterGroups,
  groupByVendor,
  parseImported,
  saveRates,
} from './rates.js'

const h = React.createElement

/** 三个价档在界面上的顺序与说明。空闲 / 高峰的列序在表头说一次，行内不再重复。 */
const PRICE_FIELDS = [
  { field: 'cacheHit', label: '缓存命中', hint: '命中缓存的输入 token 单价' },
  { field: 'cacheMiss', label: '未命中', hint: '未命中缓存的输入 token 单价' },
  { field: 'output', label: '输出', hint: '模型输出 token 单价' },
]

/** 用「元 / 百万 token」显示一个数字：去掉多余的零，但不四舍五入到两位（小额会变成 0）。 */
function priceText(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  if (amount === 0) return '0'
  if (Math.abs(amount) >= 100) return String(Math.round(amount * 100) / 100)
  return String(Math.round(amount * 1e6) / 1e6)
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

/** 宿主回报的状态 → 可编辑的文档草稿。 */
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
 * 单价设置整页。
 * @param {object} props - data（看板数据，含 data.pricing / data.customRates）、onSaved（保存后回调）。
 * @returns {object|null} React 元素。
 */
export function PriceSettingsView(props) {
  const { data, onSaved } = props ?? {}
  const pricing = data?.pricing
  const effective = pricing?.rates !== null && typeof pricing?.rates === 'object' ? pricing.rates : {}
  const [doc, setDoc] = React.useState(() => draftDocument(data?.customRates, pricing))
  const [status, setStatus] = React.useState(() => data?.customRates ?? null)
  const [query, setQuery] = React.useState('')
  const [editing, setEditing] = React.useState(null)
  const [draft, setDraft] = React.useState(null)
  const [formError, setFormError] = React.useState('')
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

  /** 所有出现过的提供商（倍率那一节要列出来）。 */
  const providers = React.useMemo(() => {
    const seen = new Map()
    for (const model of Array.isArray(data?.models) ? data.models : []) {
      const id = typeof model?.provider === 'string' ? model.provider.trim() : ''
      if (id === '') continue
      const label = typeof model?.providerLabel === 'string' && model.providerLabel.trim() !== ''
        ? model.providerLabel.trim()
        : id
      if (!seen.has(id)) seen.set(id, label)
    }
    // 已经配了倍率但这次窗口里没出现过的提供商**不能消失**：否则用户再也删不掉它。
    for (const id of Object.keys(doc.markup)) if (!seen.has(id)) seen.set(id, id)
    return [...seen.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id))
  }, [data?.models, doc.markup])

  const groups = React.useMemo(
    () => filterGroups(groupByVendor({ ...effective, ...doc.rates }), query),
    [effective, doc.rates, query],
  )

  /** 点「改这条」：按当前价（优先我的覆盖）打开表单。 */
  const startEdit = (key) => {
    const base = editableRate(doc.rates[key]) ?? editableRate(effective[key])
    setEditing(key)
    setDraft(draftOf(base))
    setFormError('')
    setNotice('')
  }

  /** 把表单内容记进待保存的文档（**还没落盘**）。 */
  const commitEdit = () => {
    if (editing === null) return
    const base = doc.rates[editing] ?? effective[editing]
    const entry = entryOfDraft(draft ?? {}, base)
    if (entry === undefined) {
      // 全空 = 这条覆盖会被写成「零价」，而零价会让金额变成 ¥0 且不再是「估算价」，
      // 比不填危险得多。因此直接拒绝并说清原因。
      setFormError('至少填「未命中」或「输出」其中一档；全部留空不会保存任何东西')
      return
    }
    setDoc((current) => ({ ...current, rates: { ...current.rates, [editing]: entry } }))
    setEditing(null)
    setDraft(null)
    setFormError('')
    setNotice(`已记下「${editing}」，点「保存单价」后生效`)
  }

  const removeOverride = (key) => {
    setDoc((current) => {
      const next = { ...current.rates }
      delete next[key]
      return { ...current, rates: next }
    })
    if (editing === key) { setEditing(null); setDraft(null) }
    setNotice(`已删掉「${key}」的覆盖，点「保存单价」后回到官方价`)
  }

  const save = async () => {
    setSaving(true)
    setErrors([])
    setNotice('')
    try {
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
    setDoc(draftDocument(parsed.document, pricing))
    setIo({ open: true, text: '', error: '' })
    setNotice('已读入这份 JSON，确认无误后点「保存单价」才会真正生效')
  }

  /**
   * 一个模型那一行。
   *
   * 拆成函数而不是嵌在 JSX 里：这一块有「当前值 / 是否我改过 / 是否在编辑 /
   * 是否分档 / 是否外币」五组条件，平铺在一处会变成一屏读不完的嵌套三元表达式。
   * @param {{key:string, rate:object}} item - 模型键与生效价目。
   * @returns {object} React 元素。
   */
  const renderItem = (item) => {
    const mine = doc.rates[item.key] !== undefined
    const isEditing = editing === item.key
    const rate = item.rate ?? {}
    const flags = []
    // 这些徽标回答的都是「这个数字是怎么来的」，不是装饰：少一个，用户就会把
    // 折算价当原价、把最低档当精确价。
    if (rate.flat === true) flags.push(h('span', { key: 'flat', className: 'px-badge' }, '不分时'))
    if (rate.tiered === true) flags.push(h('span', { key: 'tiered', className: 'px-badge' }, '按最低档'))
    if (mine) flags.push(h('span', { key: 'mine', className: 'px-badge mine' }, '我的价'))
    if (rate.sourceCurrency === 'USD') {
      flags.push(h('span', {
        key: 'fx',
        className: 'px-badge',
        title: `官方原价 ${priceText(rate.native?.cacheMiss?.peak)} ${rate.sourceCurrency} / 百万 token`,
      }, `按汇率 ${rate.fx ?? doc.usdToCny} 折算`))
    }
    return h('div', { className: `px-price-item${mine ? ' mine' : ''}`, key: item.key },
      h('div', { className: 'px-price-item-head' },
        h('span', { className: 'px-price-item-name' },
          h('b', null, rate.label ?? item.key),
          h('code', { className: 'px-muted' }, item.key)),
        h('span', { className: 'px-price-item-prices' },
          PRICE_FIELDS.map((meta) => h('span', {
            key: meta.field,
            className: 'px-price-item-price',
            title: `${meta.label}：${meta.hint}（空闲 / 高峰）`,
          },
          h('span', { className: 'px-muted' }, meta.label),
          ` ${priceText(rate[meta.field]?.idle)} / ${priceText(rate[meta.field]?.peak)}`))),
        h('span', { className: 'px-price-item-flags' }, flags),
        h('span', { className: 'px-price-item-actions' },
          h('button', {
            type: 'button',
            className: 'px-btn small px-price-edit',
            title: '改这个模型的价（留空即用官方价）',
            onClick: () => (isEditing ? (setEditing(null), setDraft(null)) : startEdit(item.key)),
          }, isEditing ? '收起' : (mine ? '改我的价' : '改这条')),
          mine
            ? h('button', {
              type: 'button',
              className: 'px-btn small px-price-reset',
              title: '删掉这条覆盖，回到插件内置的官方价',
              onClick: () => removeOverride(item.key),
            }, '恢复官方价')
            : null)),
      isEditing && draft !== null ? h(PriceFields, { draft, onChange: setDraft }) : null,
      isEditing && formError !== '' ? h('p', { className: 'px-price-inline-error' }, formError) : null,
      isEditing && draft !== null
        ? h('div', { className: 'px-price-actions' },
          h('button', { type: 'button', className: 'px-btn small primary', onClick: commitEdit }, '记下这条'),
          h('button', {
            type: 'button',
            className: 'px-btn small',
            onClick: () => { setEditing(null); setDraft(null); setFormError('') },
          }, '取消'))
        : null)
  }

  /**
   * 一个厂商分组。
   * @param {{vendor:string, items:{key:string,rate:object}[]}} group - 分组。
   * @returns {object} React 元素。
   */
  const renderGroup = (group) => h('div', { className: 'px-price-group', key: group.vendor },
    h('div', { className: 'px-price-group-title' },
      h('b', null, group.vendor),
      h('span', { className: 'px-muted' }, ` · ${group.items.length} 个模型`)),
    group.items.map((item) => renderItem(item)))

  const hostErrors = Array.isArray(status?.errors) ? status.errors : []
  const filePath = typeof status?.path === 'string' && status.path !== ''
    ? status.path
    : '(这台机器上还没确定价目文件路径——可能是旧宿主)'
  const overrides = Object.keys(doc.rates).length

  return h('div', { className: 'px-price-settings' },
    h('p', { className: 'px-price-head' },
      h('b', null, '各模型官方单价'),
      '（元 / 百万 token，空闲 / 高峰）——官方价目随插件发布；这里改的是',
      h('b', null, '你的覆盖值'),
      '，保存后立刻参与计价，并',
      h('b', null, '不再标「估算价」'),
      '。'),

    // ── 汇率 ────────────────────────────────────────────────
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

    // ── 搜索 ────────────────────────────────────────────────
    h('div', { className: 'px-price-filters' },
      h('label', { className: 'px-rate-field' },
        h('span', { className: 'px-rate-field-label' }, '搜索'),
        h('input', {
          type: 'search',
          className: 'px-input px-price-search',
          placeholder: '模型键 / 显示名 / 厂商，例如 glm53 或 deepseek',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }))),

    // ── 厂商分组（清单常驻）───────────────────────────────────
    h('div', { className: 'px-price-groups' },
      groups.length === 0
        ? h('p', { className: 'px-muted' },
          '没有匹配的模型。价目表里没有的模型可以点下面的「新增一条」手动加价；'
          + '也可以清空搜索词看全部条目。')
        : groups.map((group) => renderGroup(group))),

    // ── 新增一条（价目表里没有的模型）────────────────────────
    h('div', { className: 'px-price-new' },
      h('button', {
        type: 'button',
        className: 'px-btn small',
        onClick: () => {
          const key = String(query ?? '').trim()
          if (key === '') {
            setErrors(['先在搜索框里写下模型的键名，再点「新增一条」——键与你在 DSH 里看到的模型名一致即可'])
            return
          }
          setErrors([])
          setDoc((current) => ({ ...current, rates: { ...current.rates, [key]: current.rates[key] ?? {} } }))
          startEdit(key)
        },
      }, '新增一条'),
      h('span', { className: 'px-muted px-note' }, '把你在路由里看到的模型名填进搜索框，再点这里。')),

    // ── 提供商倍率 ──────────────────────────────────────────
    h('div', { className: 'px-price-markup' },
      h('p', { className: 'px-price-head' },
        h('b', null, '我的倍率'),
        '（按提供商，默认 1）——中转站常在官方价上加价。填 1.2 表示那一家按官方价的 1.2 倍计，'
        + '只影响金额，不影响用量与归属。'),
      providers.length === 0
        ? h('p', { className: 'px-muted' }, '这个时间窗口里还没有出现过提供商，等有调用后这里会列出来。')
        : providers.map((provider) => h('label', { className: 'px-rate-field', key: provider.id },
          h('span', { className: 'px-rate-field-label', title: provider.id }, provider.label),
          h('input', {
            type: 'number',
            step: '0.05',
            min: '0',
            className: 'px-input px-price-markup-input',
            value: doc.markup[provider.id] === undefined ? '' : String(doc.markup[provider.id]),
            placeholder: '1',
            disabled: saving,
            onChange: (event) => {
              const raw = event.target.value
              setDoc((current) => {
                const next = { ...current.markup }
                if (raw.trim() === '') delete next[provider.id]
                else next[provider.id] = Number(raw)
                return { ...current, markup: next }
              })
            },
          }),
          h('span', { className: 'px-muted px-note' }, `路由名 ${provider.id}`)))),

    // ── 导入 / 导出 ─────────────────────────────────────────
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

    // ── 错误与保存 ──────────────────────────────────────────
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
  const field = (key, label) => h('label', { className: 'px-rate-field' },
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
 * 单个模型的补价入口（费用明细里的按钮）。
 *
 * 与整页共用同一套表单与保存口径，区别只有两点：只编辑一个模型，且**先向宿主取一次**
 * 当前的覆盖值（费用明细手里只有生效价，分不清哪部分是用户改过的）。
 *
 * 关闭态返回的是「只有一枚按钮」的 span——**不是 null**：按钮本身必须常驻，
 * 用户才看得到入口；而表单项在关闭态一个都不渲染（否则会撑开表格行）。
 * @param {object} props - modelKey（归一键）/ label（显示名）/ onSaved。
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
   */
  const popoverOf = () => (open && draft !== null && typeof document !== 'undefined'
    ? ReactDOM.createPortal(
      h('div', {
        className: 'px-price-pop px-price-editor px-price-pop-fixed',
        ref: popRef,
        role: 'dialog',
        'aria-label': `补价：${rollup}`,
        style: pos === null
          ? { visibility: 'hidden' }
          : { left: `${pos.left}px`, top: `${pos.top}px`, width: `${pos.width}px` },
      },
      h('p', { className: 'px-price-pop-title' },
        h('b', null, label ?? rollup),
        h('code', { className: 'px-muted' }, rollup)),
      h(PriceFields, { draft, onChange: setDraft }),
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

  const toggle = () => {
    const next = !open
    setOpen(next)
    setErrors([])
    setNotice('')
    if (!next) return
    // 打开时按**当前生效价**预填，并把宿主里的覆盖值叠上去（有的话）。
    setDraft(draftOf(editableRate(props?.rate)))
    fetchRates()
      .then((status) => {
        const mine = status?.rates?.[rollup]
        if (mine !== undefined) setDraft(draftOf(editableRate(mine)))
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
      const status = await fetchRates().catch(() => null)
      const doc = draftDocument(status, props?.pricing)
      doc.rates[rollup] = entry
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
