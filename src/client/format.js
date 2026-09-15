/**
 * 展示层格式化助手：数字、金额、时间、日期。纯函数，无外部依赖。
 * @module dsh-pixel-dashboard/client/format
 */

/**
 * 人民币金额格式化：小额保留更多位，避免显示成 ¥0.00。
 * @param {number} value - 金额。
 * @returns {string} 形如 `¥12.34`。
 */
export function formatCny(value) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount === 0) return '¥0'
  if (Math.abs(amount) >= 1) return `¥${amount.toFixed(2)}`
  if (Math.abs(amount) >= 0.01) return `¥${amount.toFixed(3)}`
  return `¥${amount.toFixed(4)}`
}

/**
 * token 数按中文习惯缩略。
 * @param {number} value - token 数。
 * @returns {string} 形如 `1.23 亿`。
 */
export function formatTokens(value) {
  const amount = Number(value ?? 0)
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)} 亿`
  if (amount >= 100_000) return `${(amount / 10_000).toFixed(1)} 万`
  if (amount >= 10_000) return `${(amount / 10_000).toFixed(2)} 万`
  return String(Math.round(amount))
}

/**
 * 毫秒差格式化为倒计时文本。
 *
 * 与 {@link compactCountdown} 一样必须显式挡掉非有限数：`Math.max(0, NaN)` 仍是
 * `NaN`，会渲染成 `NaN 秒`。看板里那条倒计时直接读宿主字段，脏数据是会见得到的。
 * @param {number} ms - 剩余毫秒。
 * @returns {string} 形如 `3 小时 12 分 05 秒`。
 */
export function formatCountdown(ms) {
  const raw = Number(ms)
  if (!Number.isFinite(raw)) return '0 秒'
  const total = Math.max(0, Math.floor(raw / 1000))
  const pad = (value) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours} 小时 ${pad(minutes)} 分 ${pad(seconds)} 秒`
  if (minutes > 0) return `${minutes} 分 ${pad(seconds)} 秒`
  return `${seconds} 秒`
}

/**
 * 毫秒差格式化为**紧凑**倒计时，供侧栏那一行使用。
 *
 * 与 {@link formatCountdown} 的分工：那个写在悬停提示里，读得越清楚越好；
 * 这个要塞进侧栏行图标旁边，每多一个字就少一个字给「用量看板」这个标题。
 * `3 小时 12 分 05 秒` 有十几个字符宽（约 90px），足以把标题挤没；
 * 紧凑版最长 5 个字符（如 `2天3时`），因此放得下。
 *
 * **必须显式挡掉非有限数**：`Math.max(0, NaN)` 仍然是 `NaN`，一路会渲染成
 * `NaN天NaN时` 这种串。脏数据在真实环境里是会见到的（宿主字段缺失、时钟异常），
 * 而这是每秒重画的一行，出问题会一直闪。读不懂就显示 `0秒`。
 * @param {number} ms - 剩余毫秒。
 * @returns {string} 形如 `45秒`、`45分`、`3时12分`、`2天3时`。
 */
export function compactCountdown(ms) {
  const raw = Number(ms)
  if (!Number.isFinite(raw)) return '0秒'
  const total = Math.max(0, Math.floor(raw / 1000))
  if (total < 60) return `${total}秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}时${minutes % 60}分`
  return `${Math.floor(hours / 24)}天${hours % 24}时`
}

/**
 * “当天第几分钟”渲染为 `HH:MM`。
 * @param {number} minuteOfDay - 0..1439。
 * @returns {string} 形如 `08:30`。
 */
export function formatMinuteOfDay(minuteOfDay) {
  const minute = (((Number(minuteOfDay) || 0) % 1440) + 1440) % 1440
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** 日期键 `YYYY-MM-DD` → `M/D`。 */
export function shortDate(key) {
  const parts = String(key).split('-')
  if (parts.length !== 3) return String(key)
  return `${Number(parts[1])}/${Number(parts[2])}`
}

/** 时刻 → 站点时区下的 `MM-DD HH:MM`。 */
export function formatDateTime(epochMs, timeZone) {
  if (!epochMs) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs))
}

/**
 * 站点时区下某时刻的“当天第几分钟”。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {number} 0..1439。
 */
export function minuteOfDay(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(epochMs))
  const bag = {}
  for (const part of parts) if (part.type !== 'literal') bag[part.type] = part.value
  return (Number(bag.hour) % 24) * 60 + Number(bag.minute)
}

/** 日期键位移。 */
export function shiftKey(key, deltaDays) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + deltaDays * 86_400_000).toISOString().slice(0, 10)
}
