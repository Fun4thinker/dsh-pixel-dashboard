/**
 * 「套餐余额」板块（看板里那一段卡片网格）。
 *
 * ## 它只做一件事：把第三方套餐的余额摊开
 *
 * 现金余额只接 DeepSeek 官方，由看板上独立的小板块呈现；本组件只渲染
 * **订阅套餐额度**。两笔账的单位互不相通（积分 / 美元信用额 / 百分比），
 * 因此这里不做任何换算、也不做跨厂商汇总——那会得到一个比没有数字更误导的结果。
 *
 * ## 为什么是「一家一张卡」
 *
 * 早先的形态是一叠标签页，一次只显示一家：多配两家之后，用户想比一眼
 * 「哪家快用完了」得来回点。现在每家一张卡、按网格平铺，一屏就能横向比较；
 * 没配过凭据的厂商收进底部的「添加厂商」折叠区，不占版面。
 *
 * 卡片内部左环右条：
 *   - 左：环形条画「总余额」。只给百分比的厂商用**剩余百分比**当环（已用越少环越长），
 *     中心是大号数字 + 一行小字（剩余 / 已超限）。
 *   - 右：每个额度窗口一行（5 小时 / 每周 / 每月 / 预算…），细进度条 + 已用百分比
 *     + 重置倒计时。窗口竖向排列。
 *   - 底部一个折叠入口「凭据与开关」：多数人配一次就不再动，不该一直占版面。
 *
 * ## 组件边界（契约，dashboard 按原样传 props）
 *
 * **本组件不发请求、不读存储。** 取数与写回都在看板那一层：
 *
 * ```js
 * AccountPanel({
 *   balance, balanceError, balanceBusy, onToggleBalance,   // 现金余额已移走，这里只接收不使用
 *   plans, plansError, plansBusy, onTogglePlans,
 *   credentials, credentialsError, onRemoved,
 *   now, timeZone, selectedPlan, onSelectPlan,
 * })
 * ```
 *
 * balance* 这几项保留在签名里只为兼容看板的调用（那里仍在取数），本组件不再渲染它们。
 *
 * ## 数字口径（不许改）
 *
 * 缺失显示 `—`、不显示 0；百分比可以超过 100 并标「已超限」；只给剩余额度的窗口
 * 不画假 0%，环与条留空并写明原因。
 * @module dsh-pixel-dashboard/client/accountPanel
 */

import React from 'react'
import {
  allProviders,
  credentialFiles,
  credentialRows,
  formatResetLine,
  orderWindows,
  partitionProviders,
  providerStatus,
  quotaTone,
  shapeText,
  vendorCredentialHint,
  vendorLinkOf,
  vendorShape,
  vendorVerification,
  windowProgress,
  VENDOR_SHORT,
} from './plans.js'

const { createElement: h, useMemo, useState } = React

/**
 * 环形条的直径与描边宽度（px）。
 *
 * 76 是上限：再大就会把右侧的窗口行挤到两行以下，而「一屏横向比较」正是这张卡存在的理由。
 */
const RING_SIZE = 76
const RING_STROKE = 8
/** 半径 =（直径 − 描边）/ 2：描边是居中压在圆周上的，减掉一整条才不会溢出视口。 */
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
/** 周长：dasharray 的「满环」长度。 */
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 窗口种类 → 兜底名字（宿主没给 label 时才用）。 */
const WINDOW_NAME = {
  fiveHour: '5 小时',
  weekly: '每周',
  monthly: '每月',
  budget: '预算',
}

/**
 * 一家厂商「配过还是没配过」。
 *
 * 判据是**有没有配过**，不是「成功还是失败」：`no-key` 是从没配过（可以收起来），
 * `rejected` / `request-failed` 是配过了但坏了（必须留在显眼处——那正是要看原因的时候）。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {boolean} 是否已配置过。
 */
function isConfigured(provider) {
  return provider?.ok === true || (provider?.ok !== true && provider?.reason !== 'no-key')
}

/**
 * 一家厂商在窄位置用的短名。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {string} 短名。
 */
function shortNameOf(provider) {
  const id = provider?.id
  if (typeof id === 'string' && VENDOR_SHORT[id] !== undefined) return VENDOR_SHORT[id]
  const name = provider?.name
  if (typeof name === 'string' && name !== '') return name
  return typeof id === 'string' ? id : '未知厂商'
}

/**
 * 状态徽标的文案与色调。
 *
 * 只说「可用 / 无额度 / 未配置 / 凭据被拒 / 取数失败」几档，细节原因另起一行写，
 * 不把一整段排查建议塞进徽标。
 *
 * `ok: true` 但一个窗口都没有的那一家单独给「无额度」：接口成功、额度却是空的
 * （套餐没生效、或接口改了形状）。把它算成「可用」会让用户以为是自己的错觉。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {{text:string,tone:'ok'|'warn'|'error'}} 徽标。
 */
function statusOf(provider) {
  if (provider?.ok === true) {
    const windows = Array.isArray(provider.windows) ? provider.windows : []
    return windows.length === 0
      ? { text: '无额度', tone: 'warn' }
      : { text: '可用', tone: 'ok' }
  }
  if (provider?.reason === 'no-key') return { text: '未配置', tone: 'warn' }
  if (provider?.reason === 'rejected') return { text: '凭据被拒', tone: 'error' }
  return { text: '取数失败', tone: 'error' }
}

/**
 * 核验级别的极简标注：一方核验 / 社区核验，解释放 title。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {{text:string,title:string}} 标注。
 */
function verificationOf(provider) {
  if (vendorVerification(provider) === 'community') {
    return {
      text: '社区核验',
      title: '端点来自社区逆向实现，没有官方文档或官方源码出处，可能随时失效',
    }
  }
  return { text: '一方核验', title: '端点来自官方文档，或官方 CLI / 客户端自己的源码' }
}

/**
 * 把一家的窗口压成「环形条要显示的那一个数」。
 *
 * 三条规则，都是为了不撒谎：
 *   1. 有百分比 → 取**最紧**的那个窗口（已用最多）画环：环长 = 剩余百分比。
 *      选最紧的是因为用户真正关心的是「哪个快用完了」，而一家的总余额由最紧的那个窗口决定。
 *   2. 只有剩余额度（没有百分比）→ 环留空（弧长 0），中心显示剩余额本身，
 *      绝不补一条 0% 的环。
 *   3. 什么都没有 → 中心 `—`、标签「无额度」。
 * @param {object[]} windows - 宿主返回的窗口。
 * @returns {{kind:'percent'|'amount'|'none',ratio:number,value:string,label:string,tone:string}} 摘要。
 */
function summarizeWindows(windows) {
  let tightest
  let amount
  for (const win of Array.isArray(windows) ? windows : []) {
    const progress = windowProgress(win)
    if (!progress.usable) continue
    if (progress.percentKnown) {
      if (tightest === undefined || progress.percent > tightest.percent) tightest = progress
      continue
    }
    if (amount === undefined && progress.remainingText !== '—') amount = progress
  }
  if (tightest !== undefined) {
    const remaining = Math.max(0, 100 - tightest.percent)
    return {
      kind: 'percent',
      ratio: remaining / 100,
      value: `${Math.round(remaining)}%`,
      label: tightest.over ? '已超限' : '剩余',
      tone: quotaTone(tightest.percent, tightest.over),
    }
  }
  if (amount !== undefined) {
    return { kind: 'amount', ratio: 0, value: amount.remainingText, label: '剩余', tone: 'none' }
  }
  return { kind: 'none', ratio: 0, value: '—', label: '无额度', tone: 'none' }
}

/**
 * 状态行（读中 / 失败 / 已关闭）。
 * @param {object} props - level / text。
 * @returns {object|null} React 元素。
 */
function StateLine(props) {
  const { level, text } = props
  if (typeof text !== 'string' || text === '') return null
  return h('p', { className: `px-acc-state px-acc-${level}` }, text)
}

/**
 * 环形条（总余额）。
 *
 * 用内联 SVG 的 **stroke-dasharray** 画弧，不用 CSS conic-gradient：
 *   - 弧长就是 `周长 × 剩余比例`，超过 100% 时夹到满环，数字仍照实显示；
 *   - 刻意**不写** `preserveAspectRatio`：这里要的就是 viewBox 自带的等比行为，
 *     写死任何一个值都会在非正方形容器里把圆压成椭圆。
 * 中心的大号数字画在 SVG 之外（绝对定位居中）：SVG 里的 `<text>` 在深色模式下
 * 拿不到 CSS 令牌，字号也不受页面缩放控制。
 * @param {object} props - balance（{@link summarizeWindows} 的结果）。
 * @returns {object} React 元素。
 */
function BalanceRing(props) {
  const { balance } = props
  const alert = balance.tone === 'red'
  const center = RING_SIZE / 2
  const arc = Math.max(0, Math.min(1, balance.ratio)) * RING_CIRCUMFERENCE
  return h('div', { className: 'px-acc-ring' },
    h('svg', {
      className: 'px-acc-ring-svg',
      viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`,
      role: 'img',
      'aria-label': `总余额：${balance.label} ${balance.value}`,
    },
      h('circle', { className: 'px-acc-ring-track', cx: center, cy: center, r: RING_RADIUS }),
      // 弧长为 0 时**不画**这个圆：长度为 0 的 dash 在某些渲染器上会画出一条圆头小点，
      // 看起来就像「还剩一点点」。
      arc <= 0
        ? null
        : h('circle', {
          className: `px-acc-ring-fill${alert ? ' px-acc-ring-alert' : ''}`,
          cx: center,
          cy: center,
          r: RING_RADIUS,
          strokeDasharray: `${arc.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`,
          transform: `rotate(-90 ${center} ${center})`,
        })),
    h('div', { className: 'px-acc-ring-center' },
      h('span', {
        className: `px-acc-ring-value${balance.value.length > 4 ? ' long' : ''}`,
      }, balance.value),
      h('span', { className: 'px-acc-ring-label' }, balance.label)))
}

/**
 * 一个额度窗口：窗口名 + 细进度条 + 已用百分比 + 重置倒计时 + 一行脚注。
 *
 * **百分比未知时数字画 `—`、进度条不画**：一条 0% 的空条看起来像「一点没用」，
 * 而事实是「不知道」。百分比可以超过 100（额度用超时官方就这么给），数字照实显示，
 * 只有条的宽度夹到 100——把 140% 显示成 100% 等于把「严重超限」伪装成「刚好用满」。
 * @param {object} props - win / now / timeZone。
 * @returns {object} React 元素。
 */
function WindowRow(props) {
  const { win, now, timeZone } = props
  const progress = windowProgress(win)
  const tone = quotaTone(progress.percent, progress.over)
  const reset = formatResetLine(win?.resetAt, now, timeZone)
  const label = win?.label ?? WINDOW_NAME[win?.window] ?? win?.window ?? '额度'
  const parts = []
  if (progress.remainingText !== '—') parts.push(`剩余 ${progress.remainingText}`)
  if (progress.totalText !== '—') parts.push(`上限 ${progress.totalText}`)
  if (!progress.usable) parts.push('官方没有返回这一项的数值')
  else if (!progress.percentKnown) {
    // 只给余额的窗口（Command Code 的月度就是这样）：条与环都留空，
    // 但必须写出「为什么没有百分比」，否则空条会被读成「一点没用」。
    parts.push(progress.note === '' ? '官方只报了余额，没有已用额度' : progress.note)
  }
  if (reset !== undefined) parts.push(reset)

  return h('div', { className: 'px-acc-win' },
    h('div', { className: 'px-acc-win-head' },
      h('span', { className: 'px-acc-win-name' }, label),
      h('span', {
        className: `px-acc-win-used${tone === 'red' ? ' alert' : ''}`,
      }, progress.percentKnown ? `已用 ${progress.percent.toFixed(1)}%` : '已用 —'),
      progress.over ? h('span', { className: 'px-acc-win-over' }, '已超限') : null),
    h('div', { className: 'px-acc-win-track' },
      progress.percentKnown
        ? h('span', {
          className: `px-acc-win-fill${tone === 'red' ? ' alert' : ''}`,
          style: { width: `${progress.barPercent}%` },
        })
        : null),
    parts.length === 0 ? null : h('div', { className: 'px-acc-win-foot' }, parts.join(' · ')))
}

/**
 * 「这家凭据怎么配」：去哪拿 + 拿到后放哪 + 自动发现的文件。
 *
 * 三件事缺一件用户就会卡住：
 *   1. 去哪拿（可点链接 + 步骤）；
 *   2. 拿到后写进哪里（凭据文件**绝对路径** + 引用名）——DSH 设置里没有通用凭据
 *      编辑器，所以路径必须写出来；
 *   3. 插件还会自动读哪些本机文件（只读、不删），否则「我没配怎么有数字」无法解释。
 *
 * 缺凭据时**默认展开**（那正是用户需要它的时刻），配好就折叠。
 * @param {object} props - setup / credentialFile / files / open。
 * @returns {object|null} React 元素。
 */
function SetupHelp(props) {
  const { setup, credentialFile, files, open } = props
  if (setup === null || typeof setup !== 'object') return null
  const acquire = Array.isArray(setup.acquire) ? setup.acquire : []
  const refs = Array.isArray(setup.refs) ? setup.refs : []
  const discovered = Array.isArray(files) ? files : []
  const file = typeof credentialFile === 'string' ? credentialFile : ''
  if (acquire.length === 0 && refs.length === 0 && discovered.length === 0) return null
  const link = typeof setup.keyURL === 'string' && setup.keyURL !== '' ? setup.keyURL : ''
  const linkName = typeof setup.keyURLName === 'string' && setup.keyURLName !== ''
    ? setup.keyURLName
    : '打开创建页'

  return h('details', { className: 'px-details px-plan-setup px-acc-setup', open: open === true },
    h('summary', null, '这家凭据怎么配'),
    acquire.length === 0
      ? null
      : h('ol', { className: 'px-acc-steps' },
        acquire.map((step, index) => h('li', { key: index }, step))),
    // 入口只在**展开时**画在这里：`<details>` 折叠时子节点仍在 DOM 里，
    // 无条件渲染会与页脚那一个入口重复，同一块里两个同样的链接会让「点哪个」变成问题。
    open !== true || link === ''
      ? null
      : h('p', { className: 'px-acc-setup-link' },
        h('a', { href: link, target: '_blank', rel: 'noreferrer' }, `${linkName} ↗`)),
    refs.length === 0
      ? null
      : h('div', { className: 'px-acc-setup-where' },
        h('p', null, '把下面这些项写进 DSH 凭据文件（或设成同名环境变量）：'),
        file === '' ? null : h('code', { className: 'px-plan-setup-path px-acc-setup-path' }, file),
        h('ul', { className: 'px-acc-setup-refs' },
          refs.map((item) => h('li', { key: item.name },
            h('code', null, `${item.name}: ${item.example === '' ? '…' : item.example}`),
            item.note === '' ? null : h('span', { className: 'px-acc-setup-note' }, item.note))))),
    discovered.length === 0
      ? null
      : h('div', { className: 'px-acc-files' },
        h('p', null, '插件还会自动读这些本机文件（只读、不写、不删）：'),
        h('ul', { className: 'px-acc-file-list' },
          discovered.map((item) => h('li', { key: item.path },
            h('code', { className: 'px-acc-file-path' }, item.path),
            // 「在不在」只有真的查过才敢说：凭据清单没拿到时 present 是 undefined，
            // 那时**不画**这个标记（画成「不存在」就是在陈述我们并不知道的事实）。
            item.present === true || item.present === false
              ? h('span', { className: `px-acc-file-flag${item.present ? ' present' : ''}` },
                item.present ? '存在' : '不存在')
              : null,
            item.note === '' ? null : h('span', { className: 'px-acc-setup-note' }, item.note))))),
    h('p', { className: 'px-acc-setup-hint' },
      '凭据文件改完由 DSH 自动重载，不用重启；环境变量则要写进 ',
      h('code', null, '<DSH_HOME>/.env'),
      ' 或启动 dsh 前 export，然后重启 dsh 才生效。'))
}

/**
 * 「移除凭据」：勾选 + 二次确认。
 *
 * 删的是用户的密钥且不可撤销，因此**默认一条都不勾**，第一次点只进入确认态列出
 * 将删的名字，第二次才真的发请求。来自启动环境变量或 `.env` 回落层的名字
 * **禁用勾选**（`unset` 对它们无效或会被上游拒绝），操作原因直接写在行上。
 *
 * 另有一类只读文件：别人的 App 的登录文件，插件永远不删，但要列出来——
 * 不说的话，用户清完凭据文件里那把之后插件照样能读到，「已移除」就是假的。
 * @param {object} props - credentials / vendorId / credentialFile / onRemoved。
 * @returns {object|null} React 元素。
 */
function CredentialSection(props) {
  const { credentials, vendorId, credentialFile, vendorName, onRemoved } = props
  const [checked, setChecked] = useState({})
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState([])

  const rows = useMemo(() => credentialRows(credentials, vendorId), [credentials, vendorId])
  const files = useMemo(() => credentialFiles(credentials, vendorId), [credentials, vendorId])
  const selected = rows.filter((row) => row.selectable && checked[row.ref?.name] === true)
  const configured = rows.filter((row) => row.ref?.configured === true)

  if (credentials === null || credentials === undefined) return null
  if (rows.length === 0) return null

  const toggle = (name) => {
    setConfirming(false)
    setChecked((prev) => ({ ...prev, [name]: prev[name] !== true }))
  }

  const submit = async () => {
    if (selected.length === 0) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    try {
      const result = typeof onRemoved === 'function'
        ? await onRemoved(selected.map((row) => row.ref.name))
        : undefined
      const results = Array.isArray(result?.results) ? result.results : []
      setMessages(results.map((item) => ({
        ok: item.ok === true,
        text: `${item.name}：${item.message ?? (item.ok === true ? '已移除。' : '未移除。')}`,
      })))
      setChecked({})
      setConfirming(false)
    } catch (error) {
      setMessages([{ ok: false, text: error instanceof Error ? error.message : String(error) }])
    } finally {
      setBusy(false)
    }
  }

  const writable = credentials.writable === true

  return h('details', { className: 'px-details px-acc-remove' },
    h('summary', null, `移除${vendorName === '' ? '' : ` ${vendorName} `}的凭据`),
    !writable
      ? h('p', { className: 'px-acc-note' },
        '这台机器上宿主没有可写的凭据服务，因此这里只能查看、不能移除。')
      : null,
    h('ul', { className: 'px-acc-ref-list' },
      rows.map((row) => h('li', { key: row.ref.name, className: 'px-acc-ref-row' },
        h('label', { className: 'px-acc-ref-label' },
          h('input', {
            type: 'checkbox',
            checked: checked[row.ref.name] === true,
            disabled: !row.selectable || !writable || busy,
            onChange: () => toggle(row.ref.name),
          }),
          h('code', null, row.ref.name),
          h('span', { className: 'px-acc-ref-purpose' }, row.ref.purpose ?? '')),
        h('span', { className: 'px-acc-ref-source' },
          row.ref.configured === true
            ? `已配置 · ${row.ref.sourceLabel || row.ref.source || '未知来源'}${row.ref.hint === '' ? '' : ` · ${row.ref.hint}`}`
            : '未配置'),
        row.ref.selectable !== true && row.ref.configured === true
          ? h('span', { className: 'px-acc-ref-blocked' }, row.ref.blockedReason || '这一条不能由插件移除')
          : null))),
    files.length === 0
      ? null
      : h('ul', { className: 'px-acc-ref-list px-acc-ref-files' },
        files.map((file) => h('li', { key: file.path, className: 'px-acc-ref-row' },
          h('code', null, file.path),
          h('span', { className: 'px-acc-ref-source' }, file.present ? '存在（插件不删它）' : '不存在'),
          file.note === '' ? null : h('span', { className: 'px-acc-ref-blocked' }, file.note)))),
    configured.length === 0 && files.length === 0
      ? null
      : h('div', { className: 'px-acc-remove-actions' },
        h('button', {
          type: 'button',
          className: `px-acc-btn${confirming ? ' danger' : ''}`,
          disabled: selected.length === 0 || busy || !writable,
          onClick: submit,
        }, confirming ? `确认移除 ${selected.length} 条` : '移除勾选的凭据'),
        confirming
          ? h('button', {
            type: 'button',
            className: 'px-acc-btn ghost',
            disabled: busy,
            onClick: () => { setConfirming(false); setChecked({}) },
          }, '取消')
          : null),
    confirming
      ? h('p', { className: 'px-acc-confirm' },
        `将删除：${selected.map((row) => row.ref.name).join('、')}。这一步不可撤销。`)
      : null,
    messages.length === 0
      ? null
      : h('ul', { className: 'px-acc-remove-result' },
        messages.map((item, index) => h('li', {
          key: index,
          className: item.ok ? 'px-acc-ok' : 'px-acc-bad',
        }, item.text))),
    credentialFile === '' || credentialFile === undefined
      ? null
      : h('p', { className: 'px-acc-note' }, '可移除的凭据只来自 DSH 凭据文件：',
        h('code', { className: 'px-acc-setup-path' }, credentialFile)))
}

/**
 * 合并「宿主 setup 里列出的文件」与「凭据清单里查到的文件」。
 *
 * 两处的来源不同：`provider.setup.files` 是**取数时**就带下来的路径（一定有），
 * `credentials.providers[].files` 是**查清单时**才有的，多带一个 `present`。
 * 只取其一都会缺一半信息：前者没有「在不在」，后者在凭据路由不可用时整个没有。
 * 合并后按路径去重，凭据那份优先（它更详细）。
 * @param {Array<{path:string,present?:boolean,note:string}>} resolvedFiles - 凭据清单里的文件。
 * @param {Array<{path:string,note:string}>} setupFiles - setup 块里的文件。
 * @returns {Array<{path:string,present:boolean|undefined,note:string}>} 合并结果。
 */
function mergeFiles(resolvedFiles, setupFiles) {
  const out = []
  const seen = new Set()
  for (const file of Array.isArray(resolvedFiles) ? resolvedFiles : []) {
    if (typeof file?.path !== 'string' || file.path === '' || seen.has(file.path)) continue
    seen.add(file.path)
    out.push({ path: file.path, present: file.present, note: typeof file.note === 'string' ? file.note : '' })
  }
  for (const file of Array.isArray(setupFiles) ? setupFiles : []) {
    if (typeof file?.path !== 'string' || file.path === '' || seen.has(file.path)) continue
    seen.add(file.path)
    out.push({ path: file.path, present: undefined, note: typeof file.note === 'string' ? file.note : '' })
  }
  return out
}

/**
 * 一家厂商要配的凭据名（用于「添加厂商」那一行）。
 *
 * 优先取宿主给的候选名列表的第一个（那是插件真正会先试的那一个），
 * 其次取 setup 里第一个 refs 的名字，最后退回 `keyRef`。
 * 写出来的用处很直接：用户不用点开就知道要往凭据文件里加哪一行。
 * @param {object} provider - 宿主返回的一家结果。
 * @returns {string} 凭据引用名；都没有时是空串。
 */
function primaryRefOf(provider) {
  const list = Array.isArray(provider?.keyRefs) ? provider.keyRefs : []
  const first = list.find((name) => typeof name === 'string' && name !== '')
  if (first !== undefined) return first
  const refs = Array.isArray(provider?.setup?.refs) ? provider.setup.refs : []
  const fromSetup = refs.find((item) => typeof item?.name === 'string' && item.name !== '')
  if (fromSetup !== undefined) return fromSetup.name
  return typeof provider?.keyRef === 'string' ? provider.keyRef : ''
}

/**
 * 一家厂商的卡片：左环（总余额）+ 右条（每个窗口一行）+ 底部折叠的凭据与开关。
 *
 * @param {object} props - provider / now / timeZone / credentialFile / credentials /
 *   credentialsError / onRemoved / selectedPlan / onSelectPlan /
 *   plansEnabled / plansLocked / onTogglePlans。
 * @returns {object} React 元素。
 */
function AccountCard(props) {
  const {
    provider, now, timeZone, credentialFile, credentials, credentialsError,
    onRemoved, selectedPlan, onSelectPlan, plansEnabled, plansLocked, onTogglePlans,
  } = props
  const status = statusOf(provider)
  const verification = verificationOf(provider)
  const windows = orderWindows(provider?.windows)
  const balance = summarizeWindows(windows)
  const setup = provider?.setup
  const files = mergeFiles(credentialFiles(credentials, provider?.id), setup?.files)
  const link = vendorLinkOf(provider)
  const monitored = selectedPlan === provider?.id
  const needsKey = provider?.ok !== true && provider?.reason === 'no-key'

  // 详细原因（鉴权被拒 / 取数失败 / 缺哪个凭据名）单独一行，只有出问题时才出现。
  const detail = status.tone === 'ok' ? '' : providerStatus(provider).text
  // 凭据要求那句话：宿主 setup 里有了就以它为准（更具体），否则用回落表。
  // 两种来源都必须有——用户最容易错的地方各不相同（智谱要套餐专属 Key、
  // 火山要 AK/SK、Codex/Cursor 要登录态 token），留空等于把这一步留给他猜。
  const hasSetupSteps = Array.isArray(setup?.acquire) && setup.acquire.length > 0
  const credentialHint = hasSetupSteps ? '' : vendorCredentialHint(provider)
  const note = typeof provider?.note === 'string' && provider.note !== '' ? provider.note : ''

  return h('article', { className: 'px-acc-card', 'data-vendor': provider?.id },
    // 卡头固定两行：第一行「是谁」，第二行「什么状态、口径可不可信」。
    // 排成一行让它们自己换行的话，长厂商名加两枚徽标会随机折成两三行，
    // 三张卡并排时卡头高度各不相同，看起来像没对齐。
    h('header', { className: 'px-acc-card-head' },
      h('div', { className: 'px-acc-card-id' },
        h('b', { className: 'px-acc-plan-name px-plan-name' }, provider?.name ?? '未知厂商'),
        // 监看开关做成一颗**无边框的小字按钮**：它是偏好，不是每张卡的主要动作。
        // 做成描边按钮会和状态徽标抢位置。
        h('button', {
          type: 'button',
          className: `px-acc-monitor${monitored ? ' active' : ''}`,
          'aria-pressed': monitored ? 'true' : 'false',
          title: monitored
            ? '费用条与侧栏会优先显示这一家的额度；再点一次回到「自动（最紧）」'
            : '设为监看：费用条与侧栏优先显示这一家的额度',
          onClick: () => {
            if (typeof onSelectPlan !== 'function') return
            // 再点一次取消监看，回到「自动（最紧）」——否则用户回不到自动模式。
            onSelectPlan(monitored ? undefined : provider?.id)
          },
        }, monitored ? '监看中' : '监看')),
      h('div', { className: 'px-acc-card-meta' },
        provider?.plan === undefined || provider?.plan === '' ? null : h('span', { className: 'px-badge' }, provider.plan),
        // 状态徽标：note 挂在 title 上（对「可用」的家它只是口径补充，
        // 不该再占一整行；对失败的家真正的原因走下面那行）。
        h('span', {
          className: `px-badge px-acc-badge-${status.tone}`,
          title: note === '' ? undefined : note,
        }, status.text),
        h('span', { className: 'px-acc-verif', title: verification.title }, verification.text))),

    detail === '' ? null : h('p', { className: `px-acc-reason px-acc-reason-${status.tone}` }, detail),

    h('div', { className: 'px-acc-card-body' },
      h(BalanceRing, { balance }),
      windows.length === 0
        ? h('p', { className: 'px-acc-empty' },
          needsKey
            ? '还没有可显示的额度：先展开下面的「凭据与开关」配好凭据。'
            : '还没有可显示的额度（原因见上）。')
        : h('div', { className: 'px-acc-wins' },
          windows.map((win) => h(WindowRow, {
            key: `${win.window}:${win.label}`,
            win,
            now,
            timeZone,
          })))),

    // 「凭据与开关」默认收起：多数人配一次就不再动，展开它就等于每张卡都摊着
    // 一段凭据说明——那正是上一版被嫌乱的原因。**缺凭据的那一家除外**：
    // 那时用户正需要配法，折叠起来只是多一次点击。
    h('details', { className: 'px-details px-acc-config', open: needsKey === true },
      h('summary', null, '凭据与开关'),
      h('div', { className: 'px-acc-config-body' },
        credentialHint === ''
          ? null
          : h('p', { className: 'px-acc-note px-acc-cred-hint' }, `凭据要求：${credentialHint}`),
        h(SetupHelp, { setup, credentialFile, files, open: false }),
        credentialsError === '' || credentialsError === undefined
          ? null
          : h(StateLine, { level: 'error', text: `凭据清单读取失败：${credentialsError}` }),
        h(CredentialSection, {
          credentials,
          vendorId: provider?.id,
          vendorName: provider?.name ?? '',
          credentialFile,
          onRemoved,
        }),
        h('div', { className: 'px-acc-config-foot' },
          h('label', { className: 'px-acc-toggle' },
            h('input', {
              type: 'checkbox',
              checked: plansEnabled !== false,
              disabled: plansLocked === true,
              onChange: (event) => {
                if (typeof onTogglePlans === 'function') onTogglePlans(event.target.checked)
              },
            }),
            h('span', null, plansEnabled === false ? '套餐查询已关闭' : '套餐查询已开启')),
          provider?.endpoint === undefined
            ? null
            : h('span', {
              className: 'px-acc-endpoint',
              title: '未文档化的内部接口，可能随官方改动失效',
            }, `数据源 ${provider.endpoint}`),
          link === undefined
            ? null
            : h('a', { href: link.href, target: '_blank', rel: 'noreferrer' }, link.label)))))
}

/**
 * 「添加厂商」：没配过凭据的家收在这里，点开就能看用途与配法。
 *
 * 为什么不删掉它们：插件支持哪些家、每家怎么配，是用户装之前就要查得到的信息。
 * 它们只是不该在配好之前占版面。
 * @param {object} props - providers / credentialFile / credentials / defaultOpen。
 * @returns {object|null} React 元素。
 */
function AddVendorSection(props) {
  const { providers, credentialFile, credentials, defaultOpen } = props
  if (!Array.isArray(providers) || providers.length === 0) return null
  return h('details', { className: 'px-details px-acc-add', open: defaultOpen === true },
    h('summary', null, `添加厂商（还有 ${providers.length} 家未配置的厂商）`),
    // 一家都没配时上面是空的：这时必须有一句解释，否则新用户会以为面板坏了。
    defaultOpen === true
      ? h('p', { className: 'px-acc-note px-acc-add-hint' },
        '配好凭据即可查看额度：每一家的「查看怎么配」里都写明了去哪拿、以及要写进这台机器上的哪个文件。')
      : null,
    h('ul', { className: 'px-acc-add-list' },
      providers.map((provider) => {
        const files = mergeFiles(credentialFiles(credentials, provider?.id), provider?.setup?.files)
        const link = vendorLinkOf(provider)
        const ref = primaryRefOf(provider)
        const setup = provider?.setup
        const steps = Array.isArray(setup?.acquire) ? setup.acquire.length : 0
        const refs = Array.isArray(setup?.refs) ? setup.refs.length : 0
        // 宿主没给 setup 块时也要有个入口（旧宿主只有 keyRef）。三条来源全空时
        // 不画一个点开是空的折叠区，而是照实说明「没有配法说明」——空折叠区
        // 会让用户以为是自己点错了。
        const hasSetup = setup !== null && typeof setup === 'object'
          && steps + refs + files.length > 0
        // setup 已经写清了怎么配时不再叠加回落表那句：同一块里说两遍
        // （一处更具体、一处更笼统）只会让人怀疑哪个才算数。
        const hint = steps > 0 ? '' : vendorCredentialHint(provider)
        return h('li', { key: provider.id, className: 'px-acc-add-row' },
          h('div', { className: 'px-acc-add-main' },
            h('b', null, shortNameOf(provider)),
            h('span', { className: 'px-acc-add-note' },
              shapeText(vendorShape(provider)) || '订阅套餐额度'),
            // 要配的引用名直接写出来：不点开也知道要往凭据文件里加哪一行。
            ref === '' ? null : h('code', { className: 'px-acc-add-ref' }, ref)),
          hint === '' ? null : h('span', { className: 'px-acc-add-hint-text' }, hint),
          !hasSetup && link === undefined
            ? h('span', { className: 'px-acc-add-note' }, '插件没有提供这一家的配法说明（宿主版本可能较旧）。')
            : h('details', { className: 'px-acc-add-setup' },
              h('summary', null, '查看怎么配'),
              h(SetupHelp, { setup, credentialFile, files, open: false }),
              link === undefined
                ? null
                : h('p', { className: 'px-acc-setup-link' },
                  h('a', { href: link.href, target: '_blank', rel: 'noreferrer' }, link.label))))
      }))
  )
}

/**
 * 「套餐余额」整段：标题 + 每张厂商卡 + 添加厂商 + 一句免责。
 *
 * 现金余额不在这里：它只接 DeepSeek 官方，由看板上独立的小板块呈现。
 * @param {object} props - 见文件头的契约。
 * @returns {object} React 元素。
 */
export function AccountPanel(props) {
  const {
    plans, plansError, plansBusy, onTogglePlans,
    credentials, credentialsError, onRemoved,
    now, timeZone, selectedPlan, onSelectPlan,
  } = props ?? {}

  const providers = useMemo(() => allProviders(plans), [plans])
  // 「当前监看」的那一家即使没配凭据也留在卡片区：用户刚在别处把它设成监看，
  // 这里却找不到它，是自相矛盾的界面。
  const { active, idle } = useMemo(
    () => partitionProviders(providers, { current: selectedPlan }),
    [providers, selectedPlan],
  )
  const configured = useMemo(() => active.filter((provider) => isConfigured(provider)), [active])

  // `plans === undefined` 与「取到了但一家都没有」是两件事：
  // 前者是**还没取到**（宿主在跑第一次聚合、或旧宿主没有这条路由），后者是
  // 确实一家都没配。混成一件会让用户在加载期看到「插件不支持任何厂商」。
  // 注意看板整页首次渲染时 plans / credentials / selectedPlan **都是 undefined**。
  const plansPending = plans === undefined && (plansError === undefined || plansError === '')
  // `plansError` 只要非空就要显示，**不管 `plans` 有没有到手**：
  // 缓存里可能还留着上一次成功的数据，而这一次请求已经失败了——那时只显示旧数据
  // 等于把「刚才失败了」藏起来。
  const plansFailed = typeof plansError === 'string' && plansError !== ''

  const plansEnabled = plans?.enabled !== false
  const plansLocked = plans?.lockedByEnv === true
  const credentialFile = credentials?.credentialFile

  return h('section', { className: 'px-acc px-card px-account px-account-grid' },
    h('div', { className: 'px-acc-head' },
      h('h3', { className: 'px-acc-title' }, '套餐余额'),
      active.length === 0
        ? null
        : h('span', { className: 'px-acc-count' }, `${active.length} 家`),
      plansBusy === true
        ? h('span', { className: 'px-acc-busy' }, '读取中…')
        : null),

    plansPending
      ? h(StateLine, { level: 'off', text: '套餐额度读取中…（首次打开要等宿主跑一次聚合）' })
      : null,
    plansFailed
      ? h(StateLine, { level: 'error', text: `套餐额度读取失败：${plansError}` })
      : null,
    plansEnabled === false
      ? h(StateLine, {
        level: 'off',
        text: plansLocked
          ? '套餐查询已被环境变量 DSH_PIXEL_PLANS 关闭'
          : '套餐查询已关闭：宿主不会向任何第三方端点发请求（可在各家的「凭据与开关」里重新打开）',
      })
      : null,

    active.length === 0
      ? null
      : h('div', { className: 'px-acc-cards' },
        active.map((provider) => h(AccountCard, {
          key: provider.id,
          provider,
          now,
          timeZone,
          credentialFile,
          credentials,
          credentialsError,
          onRemoved,
          selectedPlan,
          onSelectPlan,
          plansEnabled,
          plansLocked,
          onTogglePlans,
        }))),

    // 没配过的家收进「添加厂商」：默认折叠，点开能看每一家的用途与配法。
    // 一家都没配时**默认展开**——那时上面是空的，收起会让新用户什么都看不到。
    h(AddVendorSection, {
      providers: idle,
      credentialFile,
      credentials,
      defaultOpen: configured.length === 0 && providers.length > 0,
    }),

    providers.length === 0 && !plansPending && !plansFailed
      ? h('p', { className: 'px-acc-empty' }, '宿主没有返回任何厂商数据：插件或宿主版本可能不一致。')
      : null,

    // 唯一保留的免责：接口确实未文档化，这一句必须留着（一句话，不再占版面）。
    h('p', { className: 'px-acc-disclaimer' },
      h('span', {
        className: 'px-acc-disclaimer-mark',
        title: '各家用的是其前端 / CLI 自己在用的内部接口，官方没有文档保证；'
          + '一家失败只影响那一家，凭据只在本机使用。',
      }, 'ⓘ'),
      ' 接口未公开文档化，可能随官方改动失效。')
  )
}
