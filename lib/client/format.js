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
 * 坐标轴用的紧凑金额：**按数量级选小数位**，而不是固定保留。
 *
 * 与 {@link formatCny} 的分工：那个用在读数与合计上，越精确越好；这个要塞进
 * Y 轴左边那 48px 里，而消费估计的刻度常常是 `¥0.0075` 这种——固定 4 位小数会
 * 让标签比刻度间距还宽，两个标签叠在一起就都读不出来了。
 * 按数量级降到 3 位左右有效数字，宽度就稳定在 6~7 个字符以内。
 * @param {number} value - 金额。
 * @returns {string} 形如 `¥12`、`¥1.5`、`¥0.038`。
 */
export function formatCnyAxis(value) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount === 0) return '¥0'
  const abs = Math.abs(amount)
  if (abs >= 1000) return `¥${Math.round(amount)}`
  if (abs >= 10) return `¥${amount.toFixed(0)}`
  if (abs >= 1) return `¥${amount.toFixed(1)}`
  if (abs >= 0.1) return `¥${amount.toFixed(2)}`
  if (abs >= 0.01) return `¥${amount.toFixed(3)}`
  return `¥${amount.toFixed(4)}`
}

/**
 * token 数按**大模型通用单位**缩略：K / M / 亿。
 *
 * K 与 M 保留英文写法：这套界面里的数字几乎全是 token，而 token 的通用单位就是
 * K / M——模型文档写「128K 上下文」「1M tokens」，用同一套单位读者不必二次换算。
 *
 * 十亿档改成中文的「亿」：`B` 是 billion（10⁹），中文的「亿」是 10⁸，**两者不是
 * 同一个数**。只把后缀换成中文而沿用 `B` 的阈值，会让同一个数字平白差一个数量级
 * （`1_395_646_416` 会显示成「1.40亿」，而它其实是 13.96 亿）。因此这一档的阈值
 * 按「亿」本身取 10⁸。
 *
 * 于是相邻档位的比值不再统一是 1000——**K→M 是 1000，M→亿 是 100**——进位判断
 * 必须按各自的实际比值来（见下）。
 *
 * 三档阶梯（外加不足千的原值）：
 *
 * | 数量级 | 单位 | 小数位 | 例 |
 * |---|---|---|---|
 * | ≥ 1 亿 | `亿` | 2 | `6.17亿` |
 * | ≥ 100 万 | `M` | 2 | `6.17M` |
 * | ≥ 1 千 | `K` | 1 | `300.0K` |
 * | 其余 | — | 0 | `999` |
 *
 * **进位后跨过阈值时要升档**：`999_999` 按 K 算是 `999.999K`，四舍五入成
 * `1000.0K`——那既难看又会让同一个数在两处以两种单位出现。因此先取可用档位，
 * 再检查四舍五入后的尾数是否已达**上一档的起点**（K 是 1000，M 是 100），
 * 是就升到上一档（得到 `1.00M`；而 `99_999_999` 得到 `1.00亿` 而不是 `100.00M`）。
 * @param {number} value - token 数。
 * @returns {string} 形如 `6.17亿`、`617.28M`、`300.0K`、`999`。
 */
export function formatTokens(value) {
  const amount = Number(value ?? 0)
  // 显式挡掉非有限数：下面所有比较对 NaN 都为 false，会一路走到
  // `String(Math.round(NaN))`，把字面的 `NaN` 渲染出来。这些数字直接来自宿主字段。
  if (!Number.isFinite(amount)) return '0'
  const abs = Math.abs(amount)
  /** 从小到大：先定位可用的最小档位，再按需向上进位。 */
  const LADDER = [
    { scale: 1e3, digits: 1, suffix: 'K' },
    { scale: 1e6, digits: 2, suffix: 'M' },
    { scale: 1e8, digits: 2, suffix: '亿' },
  ]
  let index = -1
  for (let i = 0; i < LADDER.length; i += 1) if (abs >= LADDER[i].scale) index = i
  if (index === -1) return String(Math.round(amount))
  // 四舍五入可能把尾数推到下一档的起点（见上面 `999_999` 与 `99_999_999` 两个
  // 例子），那就升一档。**上限不能写死 1000**：档位比值是 1000 / 100 两段，
  // 写死 1000 会让 `99_999_999` 停在 `100.00M`——正好是 1 亿，该用「亿」。
  // 最大档不再升：token 数到 `1000.00亿` 已不现实，而凭空造一个「万亿」更糟。
  while (index < LADDER.length - 1) {
    const step = LADDER[index]
    const start = LADDER[index + 1].scale / step.scale
    if (Number((amount / step.scale).toFixed(step.digits)) < start) break
    index += 1
  }
  const step = LADDER[index]
  return `${(amount / step.scale).toFixed(step.digits)}${step.suffix}`
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
