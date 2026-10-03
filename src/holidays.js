/**
 * 中国法定节假日表（站点时区），官方口径。
 *
 * ## 为什么这份表直接决定计价
 *
 * DeepSeek 的分时定价不是「周一到周五高峰」，而是：
 *
 *   北京时间**周一至周五（不含中国法定节假日）** 9:00–12:00、14:00–18:00 为高峰；
 *   其余时段——**包括全部周末与中国法定节假日全天**——都是空闲时段
 *   （空闲价 = 高峰价的一半）。见
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ 。
 *
 * 于是有两条容易搞反、而且搞反了不会有任何报错的规则：
 *
 *   1) **法定节假日全天都算空闲**，哪怕它正落在周一至周五的 9:00–12:00 里。
 *      2026-10-01（周四）、10-02（周五）就是这样两天：只看星期几会把它们的白天
 *      算成高峰，而官方是按空闲计费的。
 *   2) **调休上班的周末仍然算空闲**。官方说明原文是「调休上班的周末、中国法定
 *      节假日全天均按空闲时段计费」，因此《放假调休通知》里那些周六周日上班日
 *      **不**进这张表——把它们当工作日会与官方口径正好相反。周末本来就是空闲，
 *      这张表只需要管法定节假日。
 *
 * 换句话说，判定高峰只需要「是不是法定节假日」这一个例外，日历里没有第二条规则。
 *
 * ## 收录范围
 *
 * 只收**全体公民放假的节日**（元旦 / 春节 / 清明 / 劳动节 / 端午 / 中秋 / 国庆）
 * 及其调休连休日，即《国务院办公厅关于……部分节假日安排的通知》里点明的那几天。
 *
 * **从 2026 年开始收录。** 本插件 2026 年上线，账本里没有更早的用量；收录更早的
 * 年份只会多出一份没人查的表。表外年份退回「按周一至周五」判断，界面照实说明
 * 覆盖范围（见 {@link HOLIDAY_YEARS} 与 {@link holidayYearCovered}），不假装知道。
 * 下一年度的通知（惯例在上一年 11 月发布）到手后，照同样格式往
 * {@link HOLIDAY_PERIODS} 追加一组即可，其余代码一行都不用改。
 *
 * ## 为什么是写死的表，而不是农历算法
 *
 * 农历无法从公历用公式推出，而补假规则（法定假日逢周末要在工作日补假）又要把结果
 * 挪到工作日，两者叠起来没有任何可以自查的算法。漏判一天不会报错，只会把一笔高峰
 * 请求按空闲计价——那正是最容易骗到自己的错。官方通知是一年一次、公开可逐字核对的
 * 事实，因此这里照抄。
 *
 * 来源：《国务院办公厅关于 2026 年部分节假日安排的通知》，2025-11-04 发布。
 * @module dsh-pixel-dashboard/lib/holidays
 */

/**
 * 已收录的年份（升序）。
 *
 * 客户端与看板据此显示「节假日表已收录到哪一年」；跨到表外时判定退回纯
 * 「周一至周五」，并照实说明。
 * @type {readonly number[]}
 */
export const HOLIDAY_YEARS = Object.freeze([2026])

/**
 * 法定节假日连休段（起止**含**两端），站点时区的日期键。
 *
 * 按「段」而不是按天写，是为了能逐条对着通知核对——通知本身就是按段发布的
 * （「国庆节：10 月 1 日至 7 日放假调休，共 7 天」）。判定用的按天集合由它推导，
 * 因此不存在「段写对了、天没展开全」这种中间态。
 *
 * 段的边界**只取放假的那几天**，不含调休上班的周末（见文件头第 2 条）。
 * @type {readonly {name:string,start:string,end:string}[]}
 */
export const HOLIDAY_PERIODS = Object.freeze([
  // 元旦：1/1（周四）至 1/3（周六）放假调休，共 3 天；1/4（周日）上班
  { name: '元旦', start: '2026-01-01', end: '2026-01-03' },
  // 春节：2/15（农历腊月二十八、周日）至 2/23（正月初七、周一），共 9 天
  { name: '春节', start: '2026-02-15', end: '2026-02-23' },
  // 清明节：4/4（周六）至 4/6（周一）放假，共 3 天
  { name: '清明节', start: '2026-04-04', end: '2026-04-06' },
  // 劳动节：5/1（周五）至 5/5（周二）放假调休，共 5 天；5/9（周六）上班
  { name: '劳动节', start: '2026-05-01', end: '2026-05-05' },
  // 端午节：6/19（周五）至 6/21（周日）放假，共 3 天
  { name: '端午节', start: '2026-06-19', end: '2026-06-21' },
  // 中秋节：9/25（周五）至 9/27（周日）放假，共 3 天
  { name: '中秋节', start: '2026-09-25', end: '2026-09-27' },
  // 国庆节：10/1（周四）至 10/7（周三）放假调休，共 7 天；10/10（周六）上班
  { name: '国庆节', start: '2026-10-01', end: '2026-10-07' },
])

/** 一天的毫秒数（用于把日期键在日轴上展开）。 */
const MS_PER_DAY = 86_400_000

/**
 * 日期键 → 日轴序号（自 1970-01-01 起的天数）。
 *
 * 用 UTC 造日期是刻意的：它只做**纯日历**加减，不受运行机器时区影响。
 * @param {string} key - `YYYY-MM-DD`。
 * @returns {number} 日轴序号。
 */
function dayNumber(key) {
  const [year, month, day] = String(key).split('-').map(Number)
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY)
}

/**
 * 把连休段展开成按天的日期键 → 节日名。
 *
 * 一份 Map 同时解决「是不是节假日」与「是哪个节」两个问题；判定落在导入账本的
 * 热路径上（每条记录都要判一次时段），因此不能每次现算。
 * @type {ReadonlyMap<string, string>}
 */
const HOLIDAY_NAMES = (() => {
  const map = new Map()
  for (const period of HOLIDAY_PERIODS) {
    const first = dayNumber(period.start)
    const last = dayNumber(period.end)
    // 段两端写反时**显式报错**，而不是静默展开成空段：那会让整个节日变成高峰日，
    // 而症状只是「某个假期多花了一倍钱」，没有任何报错可循。
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) {
      throw new Error(`节假日段不合法：${period.name} ${period.start} → ${period.end}`)
    }
    for (let day = first; day <= last; day += 1) {
      const key = new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
      // 同一段重叠（两份通知抄串行）也显式报错：后写的会静默覆盖前一个节日名。
      if (map.has(key)) throw new Error(`节假日段重叠：${key} 同时属于 ${map.get(key)} 与 ${period.name}`)
      map.set(key, period.name)
    }
  }
  return map
})()

/**
 * 收录范围内的全部节假日键。
 *
 * Set 而不是每次遍历数组：{@link isHoliday} 在导入账本时每条记录都要问一次。
 * @type {ReadonlySet<string>}
 */
export const HOLIDAY_KEYS = Object.freeze(new Set(HOLIDAY_NAMES.keys()))

/**
 * 这一天是不是中国法定节假日（含调休连休日）。
 *
 * 表外年份返回 false，也就是退回「按周一至周五判断」——调用方可以用
 * {@link holidayYearCovered} 区分「不是节假日」与「这一年还没收录」。
 * @param {string} key - `YYYY-MM-DD`（站点时区）。
 * @returns {boolean} 是法定节假日为真。
 */
export function isHoliday(key) {
  return HOLIDAY_NAMES.has(String(key))
}

/**
 * 这一天属于哪个节日；不是节假日时为空串。
 *
 * 用于界面照实说明「为什么现在是空闲」——例如国庆期间那十天写着「国庆节」，
 * 比只说「空闲时段」更能解释清楚。
 * @param {string} key - `YYYY-MM-DD`（站点时区）。
 * @returns {string} 节日名（如 `国庆节`）；不是节假日时为空串。
 */
export function holidayNameOf(key) {
  return HOLIDAY_NAMES.get(String(key)) ?? ''
}

/**
 * 这一年是否已收录节假日（供界面说明覆盖范围）。
 * @param {number} year - 公历年（站点时区）。
 * @returns {boolean} 已收录为真。
 */
export function holidayYearCovered(year) {
  return HOLIDAY_YEARS.includes(Number(year))
}
