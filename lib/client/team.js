/**
 * 智能体团队在客户端的派生逻辑：从宿主 `teams[]` 里挑出「当前会话所属的那个团队」，
 * 并把它渲染成费用条要用的两样东西——**一个合计**与**一段按成员分列的说明**。
 *
 * ## 为什么默认显示团队合计
 *
 * 用户在团队模式下关心的不是「我这个 lead 会话花了多少」，而是**这一队一共花了多少**
 * ——teammate 是 lead 派生出去的同一件事的一部分，把它们的钱分开看没有意义。
 * 因此：当前会话属于某个多成员团队时，费用条那一枚显示**团队合计**；
 * 悬停时按成员逐行列出，看得到「谁花的」。
 *
 * ## 三条不能省的退化路径
 *
 * | 情况 | 行为 |
 * |---|---|
 * | 旧宿主（没有 `teams[]`） | 完全退回单会话口径，与改动前逐字节一致 |
 * | 当前会话不属于任何多成员团队 | 同上——单人团队不必单列，那只是普通的会话 |
 * | 宿主给了团队但成员列表为空 | 不显示团队口径（宁可显示单会话，也不显示一个 0） |
 *
 * **第三种是最容易写错的一条**：`teams[]` 里理论上不该出现空成员，但数据来自
 * 磁盘与会话头，宿主的 fail-soft 会让它有机会为空。那时若照直渲染 `¥0.0000`，
 * 用户看到的是「这个团队一分钱没花」——而真实情况是「我们不知道」。
 * @module dsh-pixel-dashboard/client/team
 */

/**
 * 团队归属的稳定键：宿主给的 `teamId`，取不到时退回会话自己。
 *
 * 与宿主 `teamPlacementOf()` 的回落同一条规则：没有父会话的会话**自己就是根**。
 * 两边各写一次是为了让「旧宿主没有 teamId」时仍能算出同一个键——而它们的判据
 * 必须一致，否则宽屏下费用条会显示 A 团队、看板却把它算进 B。
 * @param {object|undefined} session - 会话行。
 * @returns {string} 团队键；连会话都没有时是空串。
 */
export function teamKeyOf(session) {
  const teamId = typeof session?.teamId === 'string' ? session.teamId : ''
  if (teamId !== '') return teamId
  return typeof session?.id === 'string' ? session.id : ''
}

/**
 * 找出当前会话所属的团队。
 *
 * 两条判据，缺一不可：
 *   1. 团队里有**不止一个**成员——单人团队就是普通会话，给它换一套口径只会让人困惑；
 *   2. 团队确实包含当前会话——`leadId` 或某个成员 id 命中都算，因为用户可能正停在
 *      某个 teammate 的会话界面里（DSH 允许打开 teammate 的会话）。
 *
 * 命中多个时取**成员最多的那个**：会话头理论上只有一个父会话，因此不该出现多个，
 * 而万一出现（跨设备账本里同一 id 被两条链认领），大团队是信息更全的那一个。
 * @param {object|undefined} data - 宿主响应。
 * @param {string|undefined} sessionId - 当前会话 id。
 * @returns {object|undefined} 命中的团队行；不属于任何团队时为 undefined。
 */
export function findTeamOf(data, sessionId) {
  const teams = Array.isArray(data?.teams) ? data.teams : []
  const id = typeof sessionId === 'string' ? sessionId : ''
  if (id === '') return undefined
  let best
  for (const team of teams) {
    if (team === null || typeof team !== 'object') continue
    const members = Array.isArray(team.members) ? team.members : []
    if (members.length < 2) continue
    const inside = team.leadId === id || members.some((member) => member?.id === id)
    if (!inside) continue
    if (best === undefined || members.length > (best.members?.length ?? 0)) best = team
  }
  return best
}

/**
 * 团队里某个成员该显示成什么名字。
 *
 * 三层回落，**每一层都是事实**，不做猜测：
 *   - `name`：宿主从 `team/member` 名册里取到的团队名（`researcher`、`writer` 这种）；
 *   - 会话标题：名册里没有它时（普通子代理、或名册还没落盘）用侧栏那一句话；
 *   - id 片段：两个都没有时的最后保底，让这一行至少不是空白。
 * @param {object|undefined} member - 团队成员。
 * @returns {string} 可显示的名字。
 */
export function memberNameOf(member) {
  const name = typeof member?.name === 'string' ? member.name.trim() : ''
  if (name !== '') return name
  const title = typeof member?.title === 'string' ? member.title.trim() : ''
  if (title !== '') return title
  const id = typeof member?.id === 'string' ? member.id : ''
  return id === '' ? '(未知成员)' : `${id.slice(0, 8)}…`
}

/**
 * 把一份团队汇总折成费用条要用的描述。
 *
 * **金额一律取宿主算好的那份**（`team.cost`），不在这里重新累加成员：
 * 宿主已经把「合计 = 成员之和」保证到小数点后 6 位（见 `summarizeTeam`），
 * 客户端再算一遍只会引入第二种取整方式。
 * @param {object|undefined} team - 宿主 `teams[]` 的一行。
 * @param {{formatCny:Function, formatTokens:Function}} format - 格式化函数。
 * @returns {object|undefined} `{cost, tokens, memberCount, lines}`；没有团队时 undefined。
 */
export function teamSummaryOf(team, format) {
  const members = Array.isArray(team?.members) ? team.members : []
  if (team === undefined || team === null || members.length < 2) return undefined
  const cost = Number(team?.cost?.standard)
  if (!Number.isFinite(cost)) return undefined
  /**
   * 逐成员一行：金额 + token。刻意**不做排序**——宿主的顺序是「lead 第一、其余按
   * 花费降序」，那是唯一一次排序，在这里重排会让悬停列表与看板里的成员顺序不一致。
   */
  const lines = members.map((member) => {
    // 金额读不出时保留 undefined 而不是折成 0：详情面板要据此整行省略，
    // 而 0 会把「不知道」画成「这个人一分钱没花」。
    const rawCost = Number(member?.cost?.standard)
    const memberCost = Number.isFinite(rawCost) ? rawCost : undefined
    const tokens = Number(member?.tokens ?? 0)
    const role = member?.role === 'lead' ? 'lead' : '成员'
    const name = memberNameOf(member)
    return {
      id: typeof member?.id === 'string' ? member.id : '',
      name,
      role,
      // 面板要的是**结构化数值**，不是拼好的字符串：它要按金额画占比条、
      // 自己决定标签怎么排。字符串只留给悬停说明（`text` / `detail`）。
      cost: memberCost,
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : undefined,
      // token 数缺失时整段省略，而不是写 0——「不知道」与「真的是 0」是两件事。
      text: `${name}（${role}） ${format.formatCny(memberCost ?? 0)}`
        + (Number.isFinite(tokens) && tokens > 0 ? ` · ${format.formatTokens(tokens)} tokens` : ''),
      detail: `${name}（${role}） · `
        + `${format.formatCny(memberCost ?? 0)}`
        + (Number.isFinite(tokens) && tokens > 0 ? ` · ${format.formatTokens(tokens)} tokens` : ''),
    }
  })
  return {
    cost,
    tokens: Number(team?.totals?.local ?? 0),
    memberCount: members.length,
    // 团队标题用于悬停说明的抬头（「团队合计」那一行下面接成员列表）。
    title: typeof team.title === 'string' ? team.title : '',
    lines,
  }
}

/**
 * 团队汇总 → 一句「按成员分列」的纯文本。
 *
 * **不再是界面的一部分。** 它早先喂给费用徽标的 `title` 属性（那是用户说的
 * 「裸文本浮窗」），现在详情由 `costDetail.js` 折成结构化面板。
 * 保留它是因为它仍是一个方便的、可断言的**整体快照**：`tools/render-check.mjs`
 * 用它一眼确认「成员名 + 金额都在」，比逐节翻 sections 更直接，而且它不参与渲染，
 * 将来漂移了也只会让闸门红、不会让界面错。
 * @param {object|undefined} summary - {@link teamSummaryOf} 的结果。
 * @returns {string} 多行文本；没有团队时是空串。
 */
export function teamDetailText(summary) {
  if (summary === undefined || summary === null) return ''
  const count = summary.memberCount
  const head = `团队合计（${count} 位成员）`
  return [head, ...summary.lines.map((line) => `· ${line.detail}`)].join('\n')
}
