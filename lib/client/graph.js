/**
 * 像素风图表的现代做法：平滑曲线 + 渐变面积 + 跟随光标的读数浮层。
 *
 * 尺寸策略：所有 SVG 都用「viewBox + 实测像素宽高」1:1 绘制，**不用**
 * preserveAspectRatio="none"。之前用 none 配固定像素高度会把几何非等比拉伸，
 * 折线的点和日历的格子被拉成长条，看起来就是“显示异常”。
 * @module dsh-pixel-dashboard/client/graph
 */

import React from 'react'
import { formatCny, formatTokens, shortDate } from './format.js'

const { createElement: h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } = React

/** 配色轮换，对应 CSS 的 --px-tone-* 变量。 */
export const TONES = ['blue', 'pink', 'green', 'yellow', 'purple', 'red']

/** 渐变 id 序号：同页多图不能重名。 */
let gradientSeq = 0

/**
 * 观察容器宽度，用实测像素尺寸绘图，避免非等比拉伸。
 * @param {number} fallback - 尚未测到宽度时的兜底值。
 * @returns {[object, number]} ref 与当前宽度。
 */
export function useMeasuredWidth(fallback) {
  const ref = useRef(null)
  const [width, setWidth] = useState(fallback)
  // 服务端渲染没有布局，用 useEffect 即可；浏览器里用 layout effect 避免首帧跳一下
  const useIsomorphic = typeof window === 'undefined' ? useEffect : useLayoutEffect
  useIsomorphic(() => {
    const node = ref.current
    if (node === null) return undefined
    const sync = () => {
      const next = Math.round(node.clientWidth)
      if (next > 0) setWidth((prev) => (prev === next ? prev : next))
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(sync)
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])
  return [ref, width]
}

/**
 * 单调三次插值：曲线平滑且不过冲（Fritsch–Carlson 限制切线）。
 * @param {number[]} xs - 横坐标。
 * @param {number[]} ys - 纵坐标。
 * @returns {string} SVG path 的 d 属性。
 */
function smoothPath(xs, ys) {
  const n = xs.length
  if (n === 0) return ''
  if (n === 1) return `M ${xs[0]} ${ys[0]}`
  if (n === 2) return `M ${xs[0]} ${ys[0]} L ${xs[1]} ${ys[1]}`

  const dx = []
  const slope = []
  for (let i = 0; i < n - 1; i += 1) {
    const step = xs[i + 1] - xs[i]
    dx.push(step)
    slope.push((ys[i + 1] - ys[i]) / (step === 0 ? 1 : step))
  }
  const m = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      m[i] = 0
    } else {
      const w1 = 2 * dx[i] + dx[i - 1]
      const w2 = dx[i] + 2 * dx[i - 1]
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i])
    }
  }

  let d = `M ${xs[0]} ${ys[0]}`
  for (let i = 0; i < n - 1; i += 1) {
    const third = dx[i] / 3
    d += ` C ${xs[i] + third} ${ys[i] + m[i] * third},`
      + ` ${xs[i + 1] - third} ${ys[i + 1] - m[i + 1] * third},`
      + ` ${xs[i + 1]} ${ys[i + 1]}`
  }
  return d
}

/**
 * 折线趋势图：平滑曲线 + 渐变面积 + 跟随光标的读数浮层。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
export function TrendChart(props) {
  const { points, series, formatAxis, formatValue, height = 240 } = props
  const [hover, setHover] = useState(null)
  const [wrapRef, width] = useMeasuredWidth(720)
  const uid = useMemo(() => `pxgrad${(gradientSeq += 1)}`, [])

  const pad = { top: 16, right: 14, bottom: 26, left: 58 }
  const innerW = Math.max(60, width - pad.left - pad.right)
  const innerH = Math.max(60, height - pad.top - pad.bottom)

  const max = useMemo(() => {
    let peak = 0
    for (const point of points) for (const line of series) peak = Math.max(peak, Number(point[line.key] ?? 0))
    return peak === 0 ? 1 : peak * 1.08
  }, [points, series])

  const stepX = points.length > 1 ? innerW / (points.length - 1) : innerW
  const xOf = useCallback((index) => pad.left + index * stepX, [pad.left, stepX])
  const yOf = useCallback(
    (value) => pad.top + innerH - (Number(value ?? 0) / max) * innerH,
    [pad.top, innerH, max],
  )

  const ticks = useMemo(
    () => Array.from({ length: 5 }, (_, index) => ({ value: (max / 4) * index, y: yOf((max / 4) * index) })),
    [max, yOf],
  )

  const onMove = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    const index = Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))))
    setHover(index)
  }

  // 轴标签数量随宽度自适应，窄屏不至于挤成一团
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 68))))
  const hoverLabel = hover === null ? '' : shortDate(points[hover].key)
  const baseline = pad.top + innerH

  return h(
    'div',
    { className: 'px-chart-wrap', ref: wrapRef, style: { position: 'relative' } },
    h(
      'svg',
      {
        className: 'px-chart',
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': 'token 用量趋势',
      },
      h('defs', null,
        series.map((line) =>
          h('linearGradient', { key: line.key, id: `${uid}-${line.key}`, x1: 0, y1: 0, x2: 0, y2: 1 },
            h('stop', { offset: '0%', stopColor: `var(--px-tone-${line.tone})`, stopOpacity: 0.28 }),
            h('stop', { offset: '100%', stopColor: `var(--px-tone-${line.tone})`, stopOpacity: 0 })))),
      ticks.map((tick, index) =>
        h('g', { key: `tick${index}` },
          h('rect', { x: pad.left, y: tick.y, width: innerW, height: 1, className: 'px-grid-line' }),
          h('text', { x: pad.left - 10, y: tick.y + 3.5, className: 'px-axis-text', textAnchor: 'end' },
            formatAxis ? formatAxis(tick.value) : Math.round(tick.value)))),
      series.map((line) => {
        const xs = points.map((_, index) => xOf(index))
        const ys = points.map((point) => yOf(point[line.key]))
        const d = smoothPath(xs, ys)
        if (d === '') return null
        // 面积先画、折线后画，保证线永远压在面积之上
        return h('g', { key: line.key },
          h('path', {
            className: 'px-area',
            d: `${d} L ${xs.at(-1)} ${baseline} L ${xs[0]} ${baseline} Z`,
            fill: `url(#${uid}-${line.key})`,
          }),
          h('path', { className: `px-line px-tone-${line.tone}`, d, fill: 'none' }))
      }),
      hover === null ? null : h('rect', {
        className: 'px-hover-line',
        x: xOf(hover),
        y: pad.top,
        width: 1,
        height: innerH,
      }),
      hover === null ? null : series.map((line) =>
        h('circle', {
          key: `dot-${line.key}`,
          className: `px-dot px-tone-${line.tone}`,
          cx: xOf(hover),
          cy: yOf(points[hover][line.key]),
          r: 3.4,
        })),
      points.map((point, index) =>
        index % labelEvery === 0 || index === points.length - 1
          ? h('text', {
            key: `x${index}`,
            x: xOf(index),
            y: height - 7,
            className: 'px-axis-text',
            textAnchor: 'middle',
          }, shortDate(point.key))
          : null),
      h('rect', {
        x: pad.left,
        y: pad.top,
        width: innerW,
        height: innerH,
        fill: 'transparent',
        onMouseMove: onMove,
        onMouseLeave: () => { setHover(null) },
      }),
    ),
    hover === null ? null : h(
      'div',
      { className: 'px-tip', style: { left: `${Math.min(78, Math.max(22, (xOf(hover) / width) * 100))}%` } },
      h('div', { className: 'px-tip-head' }, hoverLabel),
      series.map((line) =>
        h('div', { key: line.key, className: 'px-tip-row' },
          h('i', { className: `px-legend-swatch px-tone-${line.tone}` }),
          h('span', null, line.label),
          h('b', null, formatValue ? formatValue(points[hover][line.key]) : points[hover][line.key]))),
    ),
    h(
      'div',
      { className: 'px-legend' },
      series.map((line) =>
        h('span', { key: line.key, className: 'px-legend-item' },
          h('i', { className: `px-legend-swatch px-tone-${line.tone}` }),
          h('span', null, line.label),
          h('b', { className: `px-legend-value${hover === null ? '' : ' on'}` },
            hover === null ? '' : (formatValue ? formatValue(points[hover][line.key]) : '')))),
      h('span', { className: 'px-legend-tip' }, hover === null ? '悬停曲线查看当日明细' : hoverLabel),
    ),
  )
}

/**
 * 环图：按份额绘制扇形，中心显示主读数。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
export function DonutChart(props) {
  const { slices, centerTitle, centerValue, size = 190 } = props
  const cx = 100
  const cy = 100
  const radius = 74
  const thickness = 16
  const total = slices.reduce((sum, slice) => sum + Number(slice.value ?? 0), 0)

  /** 扇形路径：外弧 + 内弧闭合。 */
  const arcPath = (start, end) => {
    const outer = radius
    const inner = radius - thickness
    const large = end - start > Math.PI ? 1 : 0
    const at = (r, angle) => `${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)}`
    return [
      `M ${at(outer, start)}`,
      `A ${outer} ${outer} 0 ${large} 1 ${at(outer, end)}`,
      `L ${at(inner, end)}`,
      `A ${inner} ${inner} 0 ${large} 0 ${at(inner, start)}`,
      'Z',
    ].join(' ')
  }

  const arcs = []
  if (total > 0) {
    let cursor = -Math.PI / 2
    for (const slice of slices) {
      const value = Number(slice.value)
      const full = (value / total) * Math.PI * 2
      if (value > 0) {
        // 留 1.5° 间隙，视觉更透气
        arcs.push({ ...slice, start: cursor, end: cursor + Math.max(0.02, full - 0.015) })
      }
      cursor += full
    }
  }

  return h(
    'div',
    { className: 'px-donut' },
    h(
      'svg',
      {
        className: 'px-donut-svg',
        viewBox: '0 0 200 200',
        width: size,
        height: size,
        role: 'img',
        'aria-label': centerTitle,
      },
      h('circle', {
        cx,
        cy,
        r: radius - thickness / 2,
        fill: 'none',
        stroke: 'var(--px-surface-2)',
        strokeWidth: thickness,
      }),
      arcs.map((arc, index) =>
        h('path', {
          key: arc.key ?? index,
          className: `px-slice px-tone-fill-${arc.tone ?? 'blue'}`,
          d: arcPath(arc.start, arc.end),
        })),
      h('text', { x: cx, y: cy - 2, className: 'px-donut-value', textAnchor: 'middle' }, centerValue),
      h('text', { x: cx, y: cy + 17, className: 'px-donut-title', textAnchor: 'middle' }, centerTitle),
      total === 0
        ? h('text', { x: cx, y: cy + 36, className: 'px-axis-text', textAnchor: 'middle' }, '暂无数据')
        : null,
    ),
  )
}

/**
 * 活跃日历的「天序号 → 网格位置」映射：列为一周、行为星期几。
 *
 * 单独抽成纯函数，好让渲染闸门能直接断言它，而不是隔着 React 去量坐标
 * ——历史事故（`floor(day / 7)` 分列导致 9/10 下面显示 9/4）正是没人量过
 * 「下面一格是不是后一天」才漏出去的。
 *
 * **列号必须补上首列的空缺**：首日未必是周日，第一列是残缺的一周。
 * `Math.floor((leadWeekday + day) / 7)` 才是「从网格第一个周日数起的第几列」。
 * @param {number} dayIndex - 距首日的天数（0 起）。
 * @param {number} leadWeekday - 首日是周几（0 = 周日）。
 * @returns {{column:number,weekday:number}} 列号与行号。
 */
export function calendarCellOf(dayIndex, leadWeekday) {
  const offset = Number(leadWeekday) || 0
  return {
    column: Math.floor((offset + Number(dayIndex)) / 7),
    weekday: (offset + Number(dayIndex)) % 7,
  }
}

/**
 * 活跃日历：一天一个方块，列为一周、行为星期几（GitHub 贡献图那种）。
 *
 * 这里刻意只画到「天」粒度。早先的版本想把 24 小时也塞进同一格，于是每格
 * 只有 0.4px 高、9px 宽，画出来自然是条形——一年 × 24 小时压不进一张图。
 *
 * 格子边长为整数且宽高相等：取整避免相邻格因浮点坐标产生 1px 细缝，
 * 等宽等高才保证是方块而不是条形。
 *
 * **列必须按「周」对齐，而不是按 `floor(day / 7)`。** 首日未必落在周日，
 * 因此第一列是**残缺的一周**：它前面几行（周日…首日的前一天）没有格子，
 * 首日只出现在自己那一行上。列号要按「距所属那一周的周日有多少天」算。
 *
 * 早先按 `floor(day / 7)` 分列，等于把首列当成完整一周：列内 7 天的星期几
 * 是首日星期几起的一个循环，一旦首日不是周日，循环就会在列内绕回去，
 * 于是「下面一格」不再是后一天。实测（首日 2025-09-12，周五）：
 * 9/10（周四）下面显示的是 9/4（上周五，比它早 6 天），9/17 下面是 9/11。
 * 用户顺着「往下就是往后」去读当天的用量，拿到的其实是另一天的数字。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
export function ActivityCalendar(props) {
  const { firstDay, days, requests, sessions, tokens, costs, maxRequests } = props
  const [tip, setTip] = useState(null)
  const [wrapRef, width] = useMeasuredWidth(900)

  const labelW = 26
  const gap = 3
  const first = Date.parse(`${firstDay}T00:00:00Z`)
  const parsedLead = new Date(first).getUTCDay()
  /**
   * 首日是周几（0 = 周日）。它同时是「第一列要空掉几行」和「列号偏移量」。
   *
   * 必须是有限数：首日缺失或非法时 `getUTCDay()` 给 NaN，坐标会一路算成 NaN，
   * 而 SVG 遇到 `x="NaN"` 会**静默丢掉整格**——界面只表现为「日历少了一块」。
   */
  const leadWeekday = Number.isFinite(parsedLead) ? parsedLead : 0
  // 脏 days（缺失 / 字符串 / NaN）同样要挡住：`Math.max(1, NaN)` 仍是 NaN。
  const totalDays = Math.max(0, Math.trunc(Number(days) || 0))
  const weekCols = Math.max(1, Math.ceil((totalDays + leadWeekday) / 7))
  const available = Math.max(100, width - labelW - 4)
  // 正方形边长：先按可用宽度定，再限制上限，避免宽屏上变成大色块
  const cell = Math.max(4, Math.min(Math.floor((available - gap * (weekCols - 1)) / weekCols), 15))
  const slot = cell + gap
  const gridW = weekCols * slot - gap
  const gridH = 7 * slot - gap
  const top = 16
  const height = Math.ceil(top + gridH + 26)

  const scaleMax = Math.max(1, Number(maxRequests ?? 1))
  const level = (value) => {
    if (!value) return 0
    const ratio = value / scaleMax
    if (ratio > 0.62) return 4
    if (ratio > 0.38) return 3
    if (ratio > 0.16) return 2
    return 1
  }

  const rects = []
  for (let day = 0; day < totalDays; day += 1) {
    // 位置与星期几都来自同一个映射：`weekday` 不再另算一次
    // （两处各算一次正是「列对了、行错了」这类错位的来源）。
    const { column, weekday } = calendarCellOf(day, leadWeekday)
    const value = Number(requests?.[day] ?? 0)
    rects.push(h('rect', {
      key: day,
      className: `px-heat px-heat-${level(value)}`,
      x: labelW + column * slot,
      y: top + weekday * slot,
      width: cell,
      height: cell,
      rx: 2,
      onMouseEnter: () => { setTip({ day, value }) },
      onMouseLeave: () => { setTip(null) },
    }))
  }

  const tipDate = tip === null ? '' : new Date(first + tip.day * 86_400_000).toISOString().slice(0, 10)
  const tipSessions = tip === null ? 0 : Number(sessions?.[tip.day] ?? 0)
  const tipTokens = tip === null ? 0 : Number(tokens?.[tip.day] ?? 0)
  // 消费估计：宿主按「每条请求发生的时段」逐日算好（见 host.js 的 dayRows[].cost）。
  // 缺失时显示 `—` 而不是 ¥0——「不知道」与「真的是 0」是两件事。
  const tipCostRaw = tip === null ? undefined : costs?.[tip.day]
  const tipCost = tipCostRaw === undefined || tipCostRaw === null || !Number.isFinite(Number(tipCostRaw))
    ? undefined
    : Number(tipCostRaw)

  return h(
    'div',
    { className: 'px-heat-wrap', ref: wrapRef },
    h(
      'svg',
      {
        className: 'px-heat-svg',
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: 'img',
        'aria-label': '全年活跃日历',
      },
      // 星期标签与格子垂直居中对齐
      [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
        h('text', {
          key: `w${weekday}`,
          x: labelW - 7,
          y: top + weekday * slot + cell / 2 + 3.5,
          className: 'px-axis-text',
          textAnchor: 'end',
        }, ['日', '一', '二', '三', '四', '五', '六'][weekday])),
      rects,
      ...monthTicks(first, totalDays, leadWeekday, labelW, slot, top),
      // 强度图例
      h('g', { transform: `translate(${labelW} ${top + gridH + 15})` },
        h('text', { x: -8, y: 0, className: 'px-axis-text', textAnchor: 'end' }, '少'),
        [0, 1, 2, 3, 4].map((index) =>
          h('rect', {
            key: index,
            className: `px-heat px-heat-${index}`,
            x: index * 11,
            y: -cell + 3,
            width: cell * 0.8,
            height: cell * 0.8,
            rx: 2,
          })),
        h('text', { x: 62, y: 0, className: 'px-axis-text' }, '多'),
        h('text', { x: gridW, y: 0, className: 'px-axis-text', textAnchor: 'end' },
          `最深一天 ${scaleMax} 次请求`)),
    ),
    h('div', { className: 'px-heat-tip' },
      tip === null
        ? '每格 = 一天 · 颜色越深请求越多 · 悬停看当天用量与消费估计'
        : [
          tipDate,
          `${tip.value} 次请求`,
          `${tipSessions} 个会话`,
          `${formatTokens(tipTokens)} tokens`,
          // 消费估计放在最后并标出来源：它是**本地估算**，不是账单
          tipCost === undefined ? '消费估计 —' : `消费估计 ${formatCny(tipCost)}`,
        ].join(' · ')),
  )
}

/**
 * 在每月一日所在列上方标出月份。
 *
 * 列号必须与格子用**同一个** `leadWeekday` 偏移量算，否则首列残缺时
 * 月份刻度会整体错开一列，看起来像格子跑到了隔壁月。
 * @param {number} first - 首日时间戳。
 * @param {number} days - 总天数。
 * @param {number} leadWeekday - 首日是周几（首列要空掉的格数）。
 * @param {number} labelW - 左侧标签宽度。
 * @param {number} slot - 列距。
 * @param {number} top - 网格顶部 y。
 * @returns {object[]} 文本元素数组。
 */
function monthTicks(first, days, leadWeekday, labelW, slot, top) {
  const labels = []
  let lastMonth = -1
  for (let day = 0; day < days; day += 1) {
    const date = new Date(first + day * 86_400_000)
    const month = date.getUTCMonth()
    if (month === lastMonth) continue
    lastMonth = month
    labels.push(h('text', {
      key: `m${month}-${day}`,
      x: labelW + Math.floor((leadWeekday + day) / 7) * slot,
      y: top - 5,
      className: 'px-axis-text',
    }, `${month + 1}月`))
  }
  return labels
}

/**
 * 水平条形列表：模型占比等紧凑对比。
 * @param {object} props - 组件属性。
 * @returns {object} React 元素。
 */
export function BarList(props) {
  const { rows } = props
  const max = rows.reduce((peak, row) => Math.max(peak, Number(row.value ?? 0)), 0) || 1
  return h(
    'div',
    { className: 'px-barlist' },
    rows.map((row) =>
      h('div', { key: row.key, className: 'px-barrow' },
        h('span', { className: 'px-barrow-label', title: row.label }, row.label),
        h('span', { className: 'px-barrow-track' },
          h('i', {
            className: `px-barrow-fill px-tone-${row.tone}`,
            style: { width: `${(Number(row.value ?? 0) / max) * 100}%` },
          })),
        h('span', { className: 'px-barrow-value' }, row.text))),
  )
}

/**
 * 数字滚动：指标出现时平滑爬到目标值，避免生硬跳变。
 * @param {number} target - 目标值。
 * @param {number} [duration] - 动画时长（毫秒）。
 * @returns {number} 当前显示值。
 */
export function useCountUp(target, duration = 620) {
  const [value, setValue] = useState(0)
  const fromRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const to = Number(target ?? 0)
    if (from === to) {
      setValue(to)
      return undefined
    }
    // 尊重“减少动态效果”，也不假设宿主一定提供 rAF：两者缺一就直接落值。
    const reduce = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined
    if (reduce || raf === undefined) {
      fromRef.current = to
      setValue(to)
      return undefined
    }
    let handle = 0
    const started = performance.now()
    const tick = (now) => {
      const t = Math.min(1, (now - started) / duration)
      // easeOutCubic：起步快、收尾稳
      setValue(from + (to - from) * (1 - (1 - t) ** 3))
      if (t < 1) handle = raf(tick)
      else fromRef.current = to
    }
    handle = raf(tick)
    return () => {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
    }
  }, [target, duration])
  return value
}
