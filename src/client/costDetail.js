/**
 * 输入框下方费用条的**详情面板数据**（纯函数，不含 React）。
 *
 * ## 为什么要单独一层
 *
 * 详情以前全塞在 `title` 属性里——那是一个**裸的系统浮窗**：字号跟着操作系统走、
 * 换行由浏览器决定、深浅色不听产品、鼠标一移开就消失，而且**没法点击**。
 * 用户的原话是「现在直接是一个裸文本浮窗，不好看」。
 *
 * 于是详情改成一个真正的面板。但面板要显示的东西（分档金额、用量构成、
 * 账户、成员、注释）**不该在 JSX 里现算**，否则每次改文案都要动渲染代码，
 * 而且服务端渲染闸门（`renderToStaticMarkup` 不执行 effect）看不到内容，
 * 只能断言 `title` 字符串——那正是「数字对了、界面还是丑的」这类问题的来源。
 *
 * 因此这里把「面板显示什么」折成一份**纯数据**：
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `title` / `tone` / `badge` | 抬头：这是本次会话还是团队合计、有没有「估算」角标 |
 * | `headline` | 抬头下面那个大号金额 |
 * | `sections[]` | 分节：分时计价 / 用量构成 / 成员 / 账户 |
 * | `notes[]` | 脚注：钱是按什么口径算出来的 |
 *
 * 渲染层（`CostDetailPanel`）只负责把这些字符串摆漂亮，一个数字都不算；
 * 闸门则可以直接断言这些字符串，不必去猜 JSX 的结构。
 *
 * ## 三处口径必须与看板一致
 *
 *   1. **金额全部取宿主算好的那份**，不在这里重新累加——重算会引入第二种取整方式，
 *      而屏幕上会同时出现「合计」与「各分项」，用户一定会加起来对一遍（见
 *      AGENT.md「团队合计 = 成员金额之和，逐位相等」）。
 *   2. **缓存命中率的分母是「计费输入」**（未命中 + 命中读 + 写入），与官方
 *      统计胶囊同一口径；分母为 0 时**不显示这一行**，而不是显示 0%。
 *   3. **「不知道」与「真的是 0」是两件事**：拿不到的字段整行省略，不写 0。
 * @module dsh-pixel-dashboard/client/costDetail
 */

import { formatCny, formatTokens } from './format.js'

/** 分时计价里两档的色调：高峰粉、空闲绿，与看板「高峰占比」同一套语义。 */
const PERIOD_TONE = { peak: 'pink', idle: 'green' }

/** 成员配色轮换：与看板的 tone 轮换同源，深色下自动换亮号。 */
const MEMBER_TONES = ['purple', 'blue', 'green', 'yellow', 'red', 'pink']

/**
 * 把用量对象里的一桶数字读成有限数（缺失按 0，脏数据按 0）。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @param {string} field - 字段名。
 * @returns {number} 非负有限数。
 */
function num(usage, field) {
  const value = Number(usage?.[field] ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 缓存命中率：命中读 ÷ 计费输入。
 *
 * 分母为 0（这个会话还没产生任何输入）时返回 undefined——**不是 0%**：
 * 0% 会把「还没有输入」显示成「缓存完全没命中」，那是两种完全不同的处境。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @returns {number|undefined} 0..1 之间的比例。
 */
export function cacheHitRate(usage) {
  const read = num(usage, 'cacheReadTokens')
  const billed = read + num(usage, 'uncachedInputTokens') + num(usage, 'cacheWriteTokens')
  if (billed === 0) return undefined
  return Math.min(1, read / billed)
}

/**
 * 计费 token 总数（缓存命中读 + 未命中 + 写入 + 输出）。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @returns {number} token 数。
 */
export function billedTotal(usage) {
  return num(usage, 'cacheReadTokens') + num(usage, 'uncachedInputTokens')
    + num(usage, 'cacheWriteTokens') + num(usage, 'outputTokens')
}

/**
 * 分时计价那一节：两档各自的金额与占比。
 *
 * 占比用于画进度条，分母是 `standard`。某一档为 0 时占比也是 0——进度条空白，
 * 但**行仍然显示**：用户看到「空闲 ¥0」才知道这段会话全在高峰时段跑的，
 * 这比整行消失有用得多。
 * @param {object|undefined} cost - 宿主给的 `{standard, peak, idle}`。
 * @returns {{label:string,total:string,rows:object[]}} 分节。
 */
function splitSection(cost) {
  const standard = Number(cost?.standard ?? 0)
  const peak = Number(cost?.peak ?? 0)
  const idle = Number(cost?.idle ?? 0)
  const shareOf = (value) => (standard > 0 ? Math.min(1, Math.max(0, value / standard)) : 0)
  return {
    label: '分时计价',
    total: formatCny(standard),
    rows: [
      {
        label: '高峰时段',
        value: formatCny(peak),
        share: shareOf(peak),
        tone: PERIOD_TONE.peak,
        hint: '工作日 09:00–12:00、14:00–18:00',
      },
      {
        label: '空闲时段',
        value: formatCny(idle),
        share: shareOf(idle),
        tone: PERIOD_TONE.idle,
        hint: '其余时段与全部法定节假日',
      },
    ],
  }
}

/**
 * 用量构成那一节：四个计费桶 + 缓存命中率 + 总量。
 *
 * 全部为 0 时整节省略（返回 undefined）：新会话刚开就弹出一排 `0` 没有信息量，
 * 而它会让「还没开始算」看起来像「算完了，都是 0」。
 * @param {object|undefined} usage - 投影里的用量总量。
 * @returns {{label:string,rows:object[]}|undefined} 分节。
 */
function usageSection(usage) {
  const read = num(usage, 'cacheReadTokens')
  const miss = num(usage, 'uncachedInputTokens')
  const write = num(usage, 'cacheWriteTokens')
  const output = num(usage, 'outputTokens')
  const total = read + miss + write + output
  if (total === 0) return undefined
  const rows = [
    { label: '缓存命中读', value: formatTokens(read) },
    { label: '未缓存输入', value: formatTokens(miss) },
  ]
  // 缓存写入多数会话是 0：照实给一行「0」会让读者去找「为什么我没写入」，
  // 而它只是这次没触发阈值。为 0 时省掉这一行。
  if (write > 0) rows.push({ label: '缓存写入', value: formatTokens(write) })
  rows.push({ label: '输出', value: formatTokens(output) })
  const rate = cacheHitRate(usage)
  if (rate !== undefined) rows.push({ label: '缓存命中率', value: `${(rate * 100).toFixed(1)}%` })
  rows.push({ label: '计费 token', value: formatTokens(total) })
  return { label: '用量构成', rows }
}

/**
 * 账户那一节：按 `account.kind` 只出一个对象（余额**或**套餐，不并排）。
 *
 * 不并排不是排版偏好：两者来自完全不同的账户（按量计费的余额 vs 买断的套餐额度），
 * 摆在一起会让人以为是同一笔钱的两个数字（见 account.js 的模块说明）。
 * @param {object|undefined} account - {@link resolveAccount} 的结果。
 * @returns {{label:string,rows:object[]}|undefined} 分节。
 */
function accountSection(account) {
  if (account === undefined || account === null || account.kind === 'none') return undefined

  if (account.kind === 'balance') {
    const rows = [{ label: '账户余额', value: account.text }]
    // 端点是不是官方，只有**不是**的时候值得说。是的话这句话纯属噪音。
    if (account.payload?.official === false) {
      rows.push({ label: '查询端点', value: '非官方公网地址' })
    }
    return { label: '账户', rows }
  }

  if (account.kind === 'plan') {
    const percent = Number(account.plan?.percent ?? 0)
    return {
      label: '账户',
      rows: [{
        label: `${account.fullLabel ?? account.label} · ${account.plan.window.label}`,
        value: `${percent.toFixed(1)}%`,
        // 百分比可以超过 100（额度用超时官方就是给 >100 的值）：
        // 条夹到满，数字照实显示，否则「已严重超限」会被伪装成「刚好用满」。
        share: Math.min(1, Math.max(0, percent / 100)),
        tone: percent >= 75 || account.plan.window.exceeded === true ? 'red' : 'purple',
        hint: account.source === 'selected' ? '你在看板上手动指定了监看这一家' : '当前会话走的是这一家',
      }],
    }
  }

  // 不可用：**必须**说出来并给出原因。静默不渲染会被当成插件坏了。
  return {
    label: '账户',
    rows: [{
      label: account.label,
      value: '不可用',
      tone: 'red',
      hint: account.reason ?? '暂时取不到数据',
    }],
  }
}

/**
 * 团队那一节：按成员分列，每人一行带金额与 token。
 *
 * 金额取宿主算好的那份（`member.cost.standard`），**不在这里从合计反推**：
 * 「团队合计 = 成员之和」是宿主保证到小数点后 6 位的等式，客户端重算一次就会
 * 出现第二种取整方式，屏幕上两个数加起来对不上（AGENT.md 里那条教训）。
 * @param {object|undefined} team - {@link teamSummaryOf} 的结果。
 * @returns {{label:string,rows:object[]}|undefined} 分节。
 */
function membersSection(team) {
  if (team === undefined || team === null) return undefined
  const lines = Array.isArray(team.lines) ? team.lines : []
  if (lines.length === 0) return undefined
  const total = Number(team.cost ?? 0)
  return {
    label: `成员（${lines.length} 位）`,
    rows: lines.map((line, index) => ({
      label: line.role === 'lead' ? `${line.name} · lead` : line.name,
      value: formatCny(Number(line.cost ?? 0)),
      share: total > 0 ? Math.min(1, Math.max(0, Number(line.cost ?? 0) / total)) : 0,
      tone: MEMBER_TONES[index % MEMBER_TONES.length],
      // token 数缺失时整段省略——「不知道」不写成 0 tokens。
      hint: Number(line.tokens ?? 0) > 0 ? `${formatTokens(line.tokens)} tokens` : undefined,
    })),
  }
}

/**
 * 脚注：这些钱是**怎么算出来的**。
 *
 * 三条各说一件事，缺一个用户就会对数字产生错误的信任：
 *   1. 口径是「全走官方 API 要花多少」，不是实际账单；
 *   2. 买断制的第三方中转 / Coding Plan 根本不按 token 计费，不在估算范围内；
 *   3. 有模型不在价目表里时，那部分是按 Flash 兜底单价估的（与看板「估算价」同一口径）。
 * @param {object} input - 见 {@link costDetailModel}。
 * @returns {string[]} 注释行。
 */
function notesOf(input) {
  const notes = []
  const unpriced = Array.isArray(input.unpriced)
    ? input.unpriced.filter((name) => typeof name === 'string' && name !== '')
    : []
  if (unpriced.length > 0) {
    notes.push(`注意：${unpriced.join('、')} 不在价目表里，暂按 Flash 单价估算。`)
  }
  if (input.failed === true) {
    notes.push('宿主没有给出这条会话的费用数据，金额一栏因此不可用。')
    notes.push('刷新页面或重启 dsh 后若仍然如此，多半是插件与宿主版本不一致。')
    return notes
  }
  const team = input.team !== undefined && input.team !== null
  if (team) {
    notes.push('团队合计 = 各成员金额之和。teammate 是 lead 派生出去的同一件事，因此默认显示整队的钱。')
    notes.push('金额按各模型官方单价估算，即「这些 token 若全部走官方 API 需要花多少钱」；'
      + '第三方中转与 Coding Plan 是买断制、不按 token 计费，不在此列。')
    return notes
  }
  notes.push('按各模型官方单价估算，即「这些 token 若全部走官方 API 需要花多少钱」——'
    + '不是实际账单；第三方中转与 Coding Plan 是买断制、不按 token 计费，不在此列。')
  return notes
}

/**
 * 折出详情面板要显示的全部内容。
 *
 * 两种口径**互斥**，与费用条上那一枚一致：属于多成员团队时是团队口径，
 * 否则是单会话口径。判据只看 `team` 在不在，不在这里重新判断团队归属
 * （那由 team.js 的 `findTeamOf` 负责，两者判据分叉会让费用条与面板说的不是同一件事）。
 * @param {object} [input] - 见 {@link SessionCostPills} 的属性。
 * @returns {{tone:string,title:string,headline:string,badge:string|undefined,sections:object[],notes:string[],empty:boolean}} 面板数据。
 */
export function costDetailModel(input = {}) {
  const { cost, failed, team, account, usage, unpriced } = input
  const teamMode = team !== undefined && team !== null

  // 什么都没有：既不渲染徽标也不渲染面板（调用方据此不画空壳）。
  const nothing = cost === undefined && failed !== true && account === undefined
    && !teamMode && usage === undefined
  if (nothing) {
    return { tone: 'pink', title: '', headline: '', badge: undefined, sections: [], notes: [], empty: true }
  }

  const sections = []
  if (failed !== true && cost !== undefined) sections.push(splitSection(cost))
  if (teamMode) {
    const members = membersSection(team)
    if (members !== undefined) sections.push(members)
    // 团队口径下「本次会话」不丢：它就在这一节里，回答「我这一支花了多少」。
    if (cost !== undefined && Number(team.cost ?? 0) > 0) {
      const share = Math.min(1, Math.max(0, Number(cost.standard ?? 0) / Number(team.cost)))
      sections.push({
        label: '本次会话',
        rows: [{
          label: '本会话花费',
          value: formatCny(Number(cost.standard ?? 0)),
          share,
          tone: 'pink',
          hint: `占团队 ${(share * 100).toFixed(1)}%`,
        }],
      })
    }
  } else {
    // 单会话口径才显示用量构成：团队口径下这里的用量是**本会话**的，
    // 摆在大号团队金额下面会被读成团队用量——两笔账混在一起比不显示更糟。
    const usageBlock = usageSection(usage)
    if (usageBlock !== undefined) sections.push(usageBlock)
  }
  const accountBlock = accountSection(account)
  if (accountBlock !== undefined) sections.push(accountBlock)

  const headline = failed === true
    ? '费用不可用'
    : (cost === undefined ? '折算中…' : formatCny(Number(cost.standard ?? 0)))

  return {
    tone: failed === true ? 'red' : (teamMode ? 'purple' : 'pink'),
    title: teamMode ? '团队合计' : '本次会话',
    headline,
    badge: Array.isArray(unpriced) && unpriced.length > 0 ? '估算' : undefined,
    sections,
    notes: notesOf({ ...input, unpriced }),
    empty: sections.length === 0 && headline === '',
  }
}
