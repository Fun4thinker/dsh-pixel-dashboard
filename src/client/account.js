/**
 * 「这一行该显示哪一份账户事实」的纯解析（不含 React）。
 *
 * ## 要解决的是什么
 *
 * 输入框下方那一行原本把**官方余额**与**最紧的套餐窗口**并排显示。它们在语义上
 * 是互斥的两笔账：官方账户是按量计费的余额，套餐窗口是某个 Coding Plan 的订阅
 * 额度，两者来自完全不同的账户。并排摆着会让人以为它们是同一笔钱的两个数字。
 *
 * 因此这里按**当前会话正在用的模型来源**（provider 路由名）挑出唯一一个对象。
 *
 * ## 回落链（每一档都是刻意的）
 *
 *   1) 来源能认出来，且是某家套餐 → 那一家的额度窗口；
 *   2) 来源是官方 provider → 官方账户余额；
 *   3) 来源认不出（新会话还没有投影、或用户填了本插件不认识的自定义路由）：
 *      a. 用户显式指定过要监看哪一家 → 就用那一家；
 *      b. 否则退回官方余额（DSH 的默认路由就是官方，这是**最可能**的那一个）；
 *      c. 余额也拿不到（被关掉 / 没配 Key）→ 退回全部套餐里最紧的那个窗口。
 *
 * 认不出的来源下**不并排显示两个**：那等于把「我们不知道」伪装成一个并排的事实。
 * 附带 `source` 字段让界面能说清「这一枚是怎么挑出来的」。
 *
 * ## 「拿不到」要说出来（降级必须可见）
 *
 * 绑定到的那个对象取不到时**不静默不渲染**：用户会以为是插件坏了。这里返回一个
 * `unavailable` 结果，界面渲染成一枚告警徽标，悬停给出具体原因（没配 Key、
 * 请求失败、还是被关掉了）。
 * @module dsh-pixel-dashboard/client/account
 */

import { balanceSummary, balanceStatus, hasBalance } from './balance.js'
import { PLAN_LABELS, PLAN_SHORT, currentRoute, sourceOfProvider } from './provider.js'
import { providerById, providerStatus, tightestWindow } from './plans.js'

/** 结果种类。 */
export const ACCOUNT_KINDS = ['plan', 'balance', 'unavailable', 'none']

/**
 * 把「哪一家、哪个窗口」压成给界面用的一枚描述。
 * @param {object|undefined} payload - `/dsh-pixel/plans` 负载。
 * @param {string} planId - 厂商 id。
 * @param {'route'|'selected'|'fallback'} source - 这一枚是怎么挑出来的。
 * @returns {object} 描述。
 */
function planResult(payload, planId, source) {
  const provider = providerById(payload, planId)
  const label = PLAN_LABELS[planId] ?? provider?.name ?? planId
  const short = PLAN_SHORT[planId] ?? provider?.name ?? planId
  if (provider === undefined) {
    // 宿主根本没给这一家：多半是插件版本对不上，或者用户在切换器里选了
    // 一个已经被移除的厂商（选择存在 localStorage 里，会跨版本留着）。
    return {
      kind: 'unavailable',
      planId,
      label: short,
      source,
      reason: `宿主没有返回「${label}」的额度数据（插件或宿主版本可能不一致）`,
    }
  }
  const status = providerStatus(provider)
  const tightest = tightestWindow(payload, planId)
  if (tightest === undefined) {
    return {
      kind: 'unavailable',
      planId,
      label: short,
      source,
      reason: status.text === '' ? `${label} 暂时没有可用的额度窗口` : status.text,
    }
  }
  return {
    kind: 'plan',
    planId,
    label: short,
    fullLabel: label,
    source,
    plan: tightest,
  }
}

/**
 * 把官方账户余额压成给界面用的一枚描述。
 * @param {object|undefined} payload - `/dsh-pixel/balance` 负载。
 * @param {'route'|'fallback'} source - 这一枚是怎么挑出来的。
 * @returns {object} 描述。
 */
function balanceResult(payload, source) {
  const status = balanceStatus(payload)
  if (!hasBalance(payload)) {
    return { kind: 'unavailable', label: '余额', source, reason: status.text }
  }
  return { kind: 'balance', label: '余额', source, text: balanceSummary(payload), payload }
}

/**
 * 按当前模型来源挑出这一行该显示的那一份账户事实。
 *
 * 纯函数：不取数、不读时钟、不看全局，因此可以直接用固定输入校验。
 * @param {object} input - 输入。
 * @param {object|undefined} input.selection - `useProjection('modelSelection')` 的值。
 * @param {object|undefined} input.balance - `/dsh-pixel/balance` 负载。
 * @param {object|undefined} input.plans - `/dsh-pixel/plans` 负载。
 * @param {string|undefined} input.selectedPlan - 用户手动指定的厂商 id。
 * @returns {object} 见 {@link ACCOUNT_KINDS}。
 */
export function resolveAccount(input = {}) {
  const { selection, balance, plans, selectedPlan } = input
  const route = currentRoute(selection)
  const source = sourceOfProvider(route?.provider)
  const chosen = selectedPlan === undefined || selectedPlan === '' ? undefined : String(selectedPlan)

  // 1) 来源指向某家套餐：直接绑那一家（用户在界面上切过也不会盖掉它——
  //    「我正在用哪家」是事实，「我平时关心哪家」只是偏好）。
  if (source.kind === 'plan') {
    // 套餐总开关关掉时宿主回报 enabled:false 且 providers 为空，
    // 那时这一枚会走到 unavailable 并把「已关闭」说清楚，这是对的。
    return { ...planResult(plans, source.planId, 'route'), route }
  }

  // 2) 来源是官方：显示官方余额。
  if (source.kind === 'balance') return { ...balanceResult(balance, 'route'), route }

  // 3) 来源认不出。
  //    a. 用户显式挑过一家就用它——这正是「手动切换当前监看的套餐」的用处。
  if (chosen !== undefined) return { ...planResult(plans, chosen, 'selected'), route }
  //    b. 退回官方余额：DSH 的默认路由就是官方，这是最可能的那一个。
  const fallbackBalance = balanceResult(balance, 'fallback')
  if (fallbackBalance.kind === 'balance') return { ...fallbackBalance, route }
  //    c. 余额也拿不到：退回最紧的那个套餐窗口，至少还有东西可看。
  const tightest = tightestWindow(plans)
  if (tightest !== undefined) return { ...planResult(plans, tightest.planId, 'fallback'), route }
  //    三档都空：不渲染（而不是渲染一个空壳）。
  return { kind: 'none', route, source, reason: fallbackBalance.reason }
}
