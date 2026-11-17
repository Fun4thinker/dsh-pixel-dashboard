/** Read-only models for the composer account card and completed-execution time view. */
import { balanceRows, formatMoney } from './balance.js'
import { formatDurationMs, formatDateTime } from './format.js'
import { formatQuota, formatResetLine, windowProgress } from './plans.js'
import { memberNameOf } from './team.js'

function timingOf(row) {
  const completed = numberOf(row?.completedTurns)
  const effective = numberOf(row?.completedTurnMs)
  const known = completed > 0 && effective !== undefined && effective >= 0
  return { completed, known, effective: known ? effective : undefined,
    wall: known ? numberOf(row.completedWallMs) : undefined,
    wait: known ? numberOf(row.awaitingUserMs) : undefined }
}
const duration = (value) => value === undefined || value < 0 ? '—' : formatDurationMs(value)
export function timeDetailModel({ row, team, sessions = [] } = {}) {
  if (Array.isArray(team?.members) && team.members.length > 1) {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const members = team.members.map((member) => ({ member, timing: timingOf(byId.get(member.id)) }))
    const known = members.filter(({ timing }) => timing.known)
    const sum = (field) => {
      const values = known.map(({ timing }) => timing[field]).filter((value) => value !== undefined && value >= 0)
      if (field !== 'effective' && values.length !== known.length) return undefined
      return values.length ? values.reduce((total, value) => total + value, 0) : undefined
    }
    return { title: '团队时间', tone: 'green', headline: duration(sum('effective')), badge: `计时 ${known.length}/${members.length}`, empty: false,
      sections: [
        { label: known.length < members.length ? '已知计时合计' : '已完成执行合计', rows: [
          { label: '有效处理', value: duration(sum('effective')) },
          { label: '等待用户（近似）', value: duration(sum('wait')) },
          { label: '原始轮次用时', value: duration(sum('wall')) },
        ] },
        { label: '成员有效处理', rows: members.map(({ member, timing }) => ({ label: `${memberNameOf(member)}${member.role === 'lead' ? ' · Lead' : ''}`, value: duration(timing.effective) })) },
      ],
      notes: [`${known.length}/${members.length} 位成员有已完成执行计时；缺测未计入合计。问答工具区间近似排除。`, '成员可能并行，累计时长不是实际经过时间或人的在线时长。'],
    }
  }
  const timing = timingOf(row)
  return { title: '本会话时间', tone: 'green', headline: duration(timing.effective), empty: false,
    sections: [
      { label: '已完成执行', rows: [
        { label: '有效处理', value: duration(timing.effective), tone: 'green' },
        { label: '等待用户（近似）', value: duration(timing.wait), tone: 'yellow' },
        { label: '原始轮次用时', value: duration(timing.wall), hint: timing.wall === undefined ? undefined : `${timing.wall}ms` },
      ] },
      { label: '执行节奏', rows: [
        { label: '人机对话', value: numberOf(row?.turns) === undefined ? '—' : `${row.turns} 轮` },
        { label: '已完成执行', value: timing.completed === undefined ? '—' : `${timing.completed} 轮` },
        { label: '平均有效处理 / 轮', value: timing.known ? duration(timing.effective / timing.completed) : '—' },
        { label: '最久有效一轮', value: timing.known ? duration(numberOf(row.maxCompletedTurnMs)) : '—' },
      ] },
    ],
    notes: [timing.known ? '仅统计本会话全程有起止计时的已完成执行，已排除问答工具区间（近似）。' : '暂无已完成执行计时；不会把尚未返回的问答等待当作机器耗时。'],
  }
}

function numberOf(value) {
  if (value === undefined || value === null || typeof value === 'string' && value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
export function accountDetailModel({ account, provider, now = Date.now(), timezone } = {}) {
  const result = { title: '账户余额', ariaLabel: '账户详情', headline: account?.text ?? '—', tone: 'green', sections: [], notes: [], empty: !account || account.kind === 'none' }
  if (account?.source === 'fallback') result.notes.push('模型来源暂未识别，当前账户来自自动回落；不代表已确认此会话使用它。')
  if (account?.source === 'selected') result.notes.push('当前显示你手动监看的账户，不代表已确认此会话使用它。')
  if (account?.kind === 'unavailable') {
    result.title = account.label || '账户状态'
    result.headline = '不可用'
    result.tone = 'red'
    result.notes.push(account.reason || '暂时取不到数据。')
    return result
  }
  if (account?.kind === 'balance') {
    const payload = account.payload ?? {}
    result.badge = payload.source === 'account' ? '官方账户' : payload.official === false ? '自建端点' : payload.official === true ? '官方接口' : '账户接口'
    if (payload.available === false) { result.tone = 'red'; result.notes.push('账户接口标记余额不可用。') }
    for (const balance of balanceRows(payload)) {
      const currency = balance.currency
      const rows = [{ label: '总可用', value: balance.total === undefined ? '—' : formatMoney(balance.total, currency) }]
      for (const [label, amount] of [['充值余额', balance.toppedUp], ['赠送余额', balance.granted]]) {
        if (amount !== undefined) rows.push({ label, value: formatMoney(amount, currency) })
      }
      result.sections.push({ label: `${currency} 余额构成`, rows })
    }
  }
  if (account?.kind === 'plan') {
    result.title = `${account.fullLabel || account.label} 额度`
    result.tone = 'purple'
    result.badge = '内部接口'
    const selected = windowProgress(account.plan?.window)
    result.headline = selected.percentKnown ? `${selected.percent.toFixed(1)}% 已用` : `剩余 ${selected.remainingText}`
    const windows = Array.isArray(provider?.windows) ? provider.windows : account.plan?.window ? [account.plan.window] : []
    for (const window of windows) {
      const progress = windowProgress(window)
      const rows = [
        { label: '已用比例', value: progress.percentKnown ? `${progress.percent.toFixed(1)}%` : '—', share: progress.percentKnown ? progress.barPercent / 100 : undefined, tone: progress.over ? 'red' : 'purple' },
        { label: '剩余额度', value: progress.remainingText },
      ]
      if (numberOf(window.used) !== undefined) rows.push({ label: '已用额度', value: formatQuota(window.used, window.unit) })
      if (numberOf(window.total) !== undefined) rows.push({ label: '总额度', value: progress.totalText })
      const reset = formatResetLine(window.resetAt, now, timezone)
      if (reset) rows.push({ label: '重置时间', value: reset, wrap: true })
      result.sections.push({ label: window.label || window.window || '额度窗口', rows })
      if (window.note) result.notes.push(String(window.note))
      if (progress.estimated) result.notes.push(`${window.label || '此窗口'}只给百分比，精度有限。`)
    }
  }
  const payload = account?.kind === 'balance' ? account.payload : provider
  const updated = numberOf(payload?.fetchedAt)
  const info = []
  if (account?.kind === 'balance' || updated !== undefined) info.push({ label: '更新时间', value: updated > 0 ? formatDateTime(updated, timezone) : '—' })
  if (account?.source === 'route' && account.route?.provider) info.push({ label: '模型来源', value: String(account.route.provider), wrap: true })
  if (payload?.account?.name) info.push({ label: '账号', value: String(payload.account.name), wrap: true })
  if (info.length) result.sections.push({ label: '查询信息', rows: info })
  return result
}
