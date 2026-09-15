/**
 * 侧栏时段倒计时：显示在「用量看板」那一行的右侧，以及它的取数与相位计算。
 *
 * ## 为什么单独一条取数路由，而不是复用 `/dsh-pixel/data`
 *
 * 这段倒计时要**每秒**重画，而 `/data` 会全量扫描会话日志与账本、带 20 秒 TTL、
 * 首次可能几十秒才回来。挂在它上面有两个直接后果：页面一打开要等一次全量扫描
 * 才看得到；账本读不出来时连「现在是高峰还是空闲」这种纯时钟信息也一起没了。
 *
 * 因此宿主另开了一条 `/dsh-pixel/period`：只跑一次纯函数 `periodState()`，
 * 不碰账本、不碰会话日志，因此**永远廉价、永远可用**。
 *
 * ## 为什么要自己算相位，而不是每秒问宿主
 *
 * 宿主给出「下一次切换还有多少毫秒」，浏览器拿到之后就本地递减
 * （与看板里的 `usePeriod` 同一套口径）。每秒发一个请求既没必要，也会在页面
 * 切到后台时白烧电。只有跨过切换点时才回去取新的一段（见 `usePeriodPhase`）。
 *
 * ## 显示什么
 *
 * **一行文字，用颜色区分时期**（红 = 高峰，绿 = 空闲）：
 *
 *   高峰中 → `2时15分后空闲期`（这段是贵的，说清什么时候变便宜）
 *   空闲中 → `空闲期剩2时15分`（这段是便宜的，说清还能便宜多久）
 *
 * 刻意**不画环形进度**：那枚环要「已走 ÷ 总长」，而各段长度差几十倍
 * （午休 2 小时、周末 63 小时），环在周末几乎不动，看起来像坏了。
 * 文字直说「还剩多久」既准确又省地方。
 * @module dsh-pixel-dashboard/client/period
 */

import React from 'react'
import { compactCountdown, formatCountdown } from './format.js'

const { createElement: h, useEffect, useMemo, useRef, useState } = React

/** 时段取数路由，与宿主注册路径一致。 */
const PERIOD_URL = '/dsh-pixel/period'

/** 纯时钟数据，不是关键路径：超时给短一些，失败就不显示。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 本地递减的步长：一秒一格，倒计时里的秒数才会跳。 */
const TICK_MS = 1_000

/**
 * 拿不到快照时的重试间隔。
 *
 * 不按每秒重试：宿主是旧版本时这条路由**永远**是 404，每秒打一次等于给每个
 * 装过旧宿主的页面白白加一个长期请求。也不放弃重试：宿主可能只是还没起来，
 * 或者刚从「旧版本」升级完——那时用户不该还看不到倒计时。
 */
const RETRY_MS = 30_000

/**
 * 一行文字要占的宽度（px），供 {@link panelEntryLayout} 判断放不放得下。
 *
 * 按最长的那种文案估：`空闲期剩2天15时` ≈ 9 个字符（汉字约 11px、数字约 7px），
 * 加上与标题之间的间隙，约 100px。
 */
export const CAPTION_WIDTH = 100

/**
 * 行宽门槛：决定这段倒计时显示成什么样子。
 *
 * ## 它放在哪
 *
 * 由容器 **portal 进产品的 row 元素**，因此它天然是一个 flex 兄弟节点、
 * 排在「用量看板」四个字的右边。（产品只把图标槽给了插件，所以在插槽内部
 * 无论怎么定位都到不了标题右边；详见 entry.js 的 `usePanelRow`。）
 *
 * ## 门限做什么
 *
 * 它是 flex 项，会把标题往左挤，因此窄行必须自己让路：
 *
 *   - `full`（行宽 ≥ {@link INLINE_MIN_ROW}）：完整的 `空闲期剩2时15分`；
 *   - `short`（≥ {@link SIDE_MIN_ROW}）：只留最关键的时长（`2时15分`），
 *     省掉时期字样——颜色已经在说时期了；
 *   - `none`：侧栏收起成图标条（整行只有几十像素），什么文字都放不下。
 *
 * 门槛怎么来的：标题「用量看板」4 个汉字约 56px + 图标 16 + 间隙，
 * 再加上 {@link CAPTION_WIDTH} 的文案宽度，两边之和即得。
 */
export const INLINE_MIN_ROW = 210

/** 「只显示时长」的最低行宽。 */
export const SIDE_MIN_ROW = 150

/**
 * 倒计时该显示成什么样子。
 *
 * 纯函数，不读时钟、不碰 DOM，因此可以直接用固定行宽校验。
 * @param {{rowWidth?:number}} [options] - 整行宽度（px）。
 * @returns {{placement:'full'|'short'|'none'}} 排版决定。
 */
export function panelEntryLayout(options = {}) {
  const rowWidth = Number(options?.rowWidth)
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) {
    // 量不到宽度（服务端渲染 / 无 ResizeObserver）：什么都不显示最保险——
    // 它不占横向空间，因此不会因为猜错宽度而把标题挤坏。
    return { placement: 'none' }
  }
  if (rowWidth >= INLINE_MIN_ROW) return { placement: 'full' }
  if (rowWidth >= SIDE_MIN_ROW) return { placement: 'short' }
  return { placement: 'none' }
}

/**
 * 取一个有限数，读不懂时回落到兜底值。
 *
 * 必须显式挡掉 NaN：`Number(undefined)` 与 `Number('x')` 都是 NaN，而
 * `Math.max(0, NaN)` 仍是 NaN——一路算下去会渲染出 `NaN时NaN分后空闲期`
 * 这种串。倒计时是每秒重画的，出问题会一直闪。
 * @param {unknown} value - 待转换的值。
 * @param {number} [fallback] - 读不懂时的取值。
 * @returns {number} 有限数。
 */
function finite(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * 取当前时段状态（宿主侧纯函数，不碰账本）。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 形如 `{ generatedAt, timezone, period }`。
 */
export async function fetchPeriod(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(PERIOD_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`时段状态请求失败：HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 由宿主快照与当前时刻算出倒计时要显示的一切。
 *
 * 纯函数，不含 React、不读时钟（`now` 由调用方给），因此可以直接用固定时刻校验。
 * 拿不到可用快照时返回 `undefined`，调用方据此**什么都不显示**——旧宿主上它
 * 就是不存在，而不是写一句永远停在「空闲」的话（那是在陈述一个我们并不知道的事实）。
 * @param {object|undefined} snapshot - 宿主 `/dsh-pixel/period` 的响应。
 * @param {number} now - 当前时刻（毫秒）。
 * @returns {object|undefined} 相位信息；不可用时为 undefined。
 */
export function periodPhase(snapshot, now) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const period = snapshot.period
  if (period === null || typeof period !== 'object') return undefined

  const peak = period.peak === true
  const at = finite(now, 0)
  const generated = finite(snapshot.generatedAt, at)
  // 本地递减：宿主快照可能已经放了一会儿，也可能因页面休眠而放了很久。
  const sinceSnapshot = Math.max(0, at - generated)
  const remainMs = Math.max(0, finite(period.nextChangeMs) - sinceSnapshot)
  const remain = compactCountdown(remainMs)

  return {
    peak,
    // 红 = 高峰（正贵着）、绿 = 空闲（正便宜）。侧栏那段文字的颜色由它决定。
    tone: peak ? 'red' : 'green',
    label: peak ? '高峰时段' : '空闲时段',
    nextLabel: peak ? '距转空闲' : '距转高峰',
    // 一行文案，两个时期各说各的话：
    //   高峰中 → 「2时15分后空闲期」——这段是贵的，重点是**什么时候变便宜**；
    //   空闲中 → 「空闲期剩2时15分」——这段是便宜的，重点是**还能便宜多久**。
    // 措辞与 peak 的对应关系只在这里拼，因为拼错的表现是「高峰」配了一句
    // 空闲期的文案——两句话都在说空闲，但主次正好相反。
    caption: peak ? `${remain}后空闲期` : `空闲期剩${remain}`,
    // 「只有时长」的短版本，供窄栏使用（颜色已经在说时期了）
    shortCaption: remain,
    remainMs,
    countdown: formatCountdown(remainMs),
    timezone: typeof snapshot.timezone === 'string' ? snapshot.timezone : '',
  }
}

/**
 * 按钮悬停说明：状态 + 倒计时。
 * @param {object|undefined} phase - periodPhase 的结果。
 * @returns {string} 提示文本。
 */
export function periodTitle(phase) {
  if (phase === undefined) return '用量看板'
  const where = phase.timezone === '' ? '' : ` · ${phase.timezone}`
  return `用量看板 · ${phase.label} · ${phase.nextLabel} ${phase.countdown}${where}`
}

/**
 * 时段倒计时文字：侧栏「用量看板」那一行右侧的一行小字。
 *
 * ```
 * [▮] 用量看板        2时15分后空闲期     ← 高峰中（红）
 * [▮] 用量看板        空闲期剩2时15分     ← 空闲中（绿）
 * ```
 *
 * **只有文字，没有环形进度。** 两个时期各说各的话，并用颜色区分：
 *   高峰（红）→「N后空闲期」  —— 这段是贵的，重点是**什么时候变便宜**；
 *   空闲（绿）→「空闲期剩N」  —— 这段是便宜的，重点是**还能便宜多久**。
 *
 * 名字里的 `Dot` 是历史沿用（它原先是图标角上的一颗点、后来是一枚环）；
 * 现在它是一段文字，`PeriodDot` 这个名字保留是为了不改动 entry.js 的接线。
 *
 * ## 窄栏降级
 *
 * `placement` 由 {@link panelEntryLayout} 按行宽给出：
 *   - `full` —— 完整的 `空闲期剩2时15分`；
 *   - `short` —— 只有时长（`2时15分`）：颜色已经在说时期了，省下的字留给标题；
 *   - `none` —— 侧栏收起成图标条，整行只有几十像素，什么都不显示。
 *
 * 纯展示，无副作用——取数在 {@link usePeriodPhase} 里，因此这一层可以直接静态渲染校验。
 * @param {object} props - phase 与 placement。
 * @returns {object|null} React 元素；没有相位信息或放不下时为 null。
 */
export function PeriodDot(props) {
  const phase = props?.phase
  if (phase === undefined || phase === null) return null
  const placement = props?.placement ?? 'full'
  if (placement === 'none') return null

  // 一行文案；窄栏只留时长。两处都必须有兜底：`caption` 缺失时（旧相位对象）
  // 退回时长，否则会渲染出「undefined后空闲期」这种串。
  const text = placement === 'short'
    ? (phase.shortCaption ?? '')
    : (typeof phase.caption === 'string' && phase.caption !== '' ? phase.caption : (phase.shortCaption ?? ''))
  if (text === '') return null

  return h('span', {
    // 颜色类区分时期：红 = 高峰、绿 = 空闲。
    className: `px-period-inline px-period-tone-${phase.tone === 'red' ? 'red' : 'green'}`,
    // 这一行是纯时钟信息，读屏软件从按钮的 aria-label 拿「用量看板」即可；
    // 但它同时是**可见**信息，因此不能像装饰那样 aria-hidden。
    title: periodTitle(phase),
  }, text)
}

/**
 * 时段相位的取数与每秒递减。
 *
 * 三条刷新时机，各自解决一个真实场景：
 *   1) **挂载时取一次** —— 页面打开就有指示灯；
 *   2) **跨过切换点再取** —— 倒计时归零说明那一段已经结束，回去取新的一段；不靠
 *      固定轮询，因为不同时段长度差得极远（午休 2 小时、周末 63 小时）；
 *   3) **页面重新可见时再取** —— 休眠 / 切到后台期间 `setInterval` 会被节流甚至暂停，
 *      光靠本地递减会算岔，回前台时以宿主为准重新对齐。
 *
 * 取数失败（旧宿主没有这条路由 / 宿主还没起来）一律清成 undefined：宁可不画，
 * 也不要停在上一次的状态上假装仍然准确。此后按 {@link RETRY_MS} 低频重试。
 * @returns {object|undefined} 相位信息，交给 {@link PeriodDot}。
 */
export function usePeriodPhase() {
  const [snapshot, setSnapshot] = useState(undefined)
  const [now, setNow] = useState(() => Date.now())
  /** 快照的最新值：定时器回调不能依赖渲染闭包，否则每秒都要重建一次定时器。 */
  const latest = useRef(undefined)
  /** 上一次发起取数的时刻，用于给失败重试限流。 */
  const lastAttempt = useRef(0)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      lastAttempt.current = Date.now()
      fetchPeriod()
        .then((payload) => {
          if (cancelled) return
          latest.current = payload
          setSnapshot(payload)
          setNow(Date.now())
        })
        .catch(() => {
          if (cancelled) return
          latest.current = undefined
          setSnapshot(undefined)
        })
    }
    const step = () => {
      const at = Date.now()
      setNow(at)
      if (latest.current === undefined) {
        // 还没有可用快照：低频重试，既不放弃，也不至于每秒打一个请求。
        if (at - lastAttempt.current >= RETRY_MS) load()
        return
      }
      const phase = periodPhase(latest.current, at)
      // 倒计时归零 = 这一段已经走完，回去取新的一段。
      if (phase !== undefined && phase.remainMs <= 0) load()
    }
    load()
    const timer = setInterval(step, TICK_MS)
    // 回前台立刻对齐：休眠期间的本地递减不可信。
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
    }
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisible)
    }
  }, [])

  return useMemo(() => periodPhase(snapshot, now), [snapshot, now])
}
