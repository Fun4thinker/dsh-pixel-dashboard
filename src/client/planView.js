/**
 * 「当前监看的套餐」选择（纯存储 + 一个 React 订阅钩子）。
 *
 * ## 为什么是浏览器本地的偏好，而不是宿主配置
 *
 * 它只决定**界面上突出显示哪一家**——不影响取数、不影响预警、不影响宿主是否
 * 发请求。把它放进宿主配置会多出一条要落盘、要跨设备同步、要写进隐私说明的状态，
 * 而它的全部作用只是「我平时更关心哪一个」。因此放 `localStorage`：换台机器各挑
 * 各的，本来就是对的。
 *
 * ## 为什么要有订阅
 *
 * 这个选择有**两个**消费者：看板里的切换器，以及输入框下方费用条那一枚。它们
 * 在不同的 fiber 上、也可能只有其中一个挂在页面上（用户可能压根没打开看板）。
 * 用一个模块级的小存储做广播，两边都读同一份，就不会出现「看板里切了、费用条
 * 没跟着变」这种看起来像坏了的现象。
 *
 * ## localStorage 全程 fail-soft
 *
 * 隐私模式、被策略禁用的存储、跨站 iframe 都会让访问抛错。读不到就当没设过
 * （回落到自动挑最紧的那一家），写不进去也不影响本次运行内的选择——把存储
 * 失败升级成界面故障是不划算的。
 * @module dsh-pixel-dashboard/client/planView
 */

import React from 'react'

const { useSyncExternalStore } = React

/** 存储键。带插件前缀，避免与产品自己的键相撞。 */
export const SELECTED_PLAN_KEY = 'dsh-pixel-dashboard.selected-plan'

/**
 * 读取已保存的套餐选择。
 *
 * 空串与缺失一律归一成 `undefined`（「自动」），因为把自动挑出来的那一家
 * 当成用户的显式选择会让他永远回不到自动模式。
 * @returns {string|undefined} 厂商 id；没设过或读不到时 undefined。
 */
export function readSelectedPlan() {
  try {
    const value = globalThis.localStorage?.getItem(SELECTED_PLAN_KEY)
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 保存套餐选择。传 `undefined` / 空串表示「回到自动」。
 * @param {string|undefined} planId - 厂商 id，或 undefined 清除。
 * @returns {boolean} 是否成功写入存储（写不进去也已在内存里生效）。
 */
export function writeSelectedPlan(planId) {
  try {
    if (planId === undefined || planId === '') globalThis.localStorage?.removeItem(SELECTED_PLAN_KEY)
    else globalThis.localStorage?.setItem(SELECTED_PLAN_KEY, String(planId))
    return true
  } catch {
    return false
  }
}

/**
 * 套餐监看选择的模块级存储。
 *
 * 与通知那套同一个套路（见 Notifier.js 的 `NotifyStore`）：**状态只有一个家**，
 * 看板与费用条都订阅它。变化检测是必需的——`useSyncExternalStore` 在快照引用
 * 不变时跳过重渲染，而我们希望「点了同一项」不要引起任何重画。
 */
class PlanViewStore {
  constructor() {
    this.selected = readSelectedPlan()
    this.snapshot = this.selected
    /** @type {Set<() => void>} */
    this.listeners = new Set()
  }

  /** @returns {string|undefined} 当前选择（undefined = 自动）。 */
  getSnapshot() {
    return this.snapshot
  }

  /**
   * 订阅变化。
   * @param {() => void} listener - 回调。
   * @returns {() => void} 退订函数。
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 切换当前监看的套餐。
   * @param {string|undefined} planId - 目标厂商 id；undefined / 空串 = 自动。
   * @returns {boolean} 是否真的发生了变化。
   */
  select(planId) {
    const next = planId === undefined || planId === '' ? undefined : String(planId)
    if (next === this.snapshot) return false
    this.snapshot = next
    writeSelectedPlan(next)
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者抛错不该阻断其余订阅者，更不该让切换本身失败。
      }
    }
    return true
  }
}

/** @type {PlanViewStore|undefined} 惰性单例（不在导入时构造）。 */
let shared

/**
 * 取共享的套餐监看存储。
 * @returns {PlanViewStore} 单例。
 */
export function planViewStore() {
  shared ??= new PlanViewStore()
  return shared
}

/**
 * 订阅「当前监看的套餐」。
 *
 * 用 `useSyncExternalStore` 而不是 `useState` + `useEffect`：后者在「订阅发生在
 * 首次渲染之后」的窗口里会丢掉一次变化，而本插件里两个消费者由不同的 fiber
 * 挂载、先后不定，那正是最容易踩到这个窗口的场景。
 * @returns {string|undefined} 厂商 id；undefined = 自动。
 */
export function useSelectedPlan() {
  const store = planViewStore()
  return useSyncExternalStore(
    React.useCallback((listener) => store.subscribe(listener), [store]),
    React.useCallback(() => store.getSnapshot(), [store]),
    React.useCallback(() => store.getSnapshot(), [store]),
  )
}
