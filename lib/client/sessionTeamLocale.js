/** Session fee tab: team-scoped labels. DSH locale parameters use `{name}`. */
const PREFIX = 'sessionTeam.'

function messages(entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, text]) => [PREFIX + key, text]))
}

export const SESSION_TEAM_MESSAGES = {
  zh: messages({
    teamName: '智能体团队',
    lead: '负责人',
    worker: '子智能体',
    nestedWorker: '{depth} 级子智能体',
    externalWorker: '外部子智能体',
    unavailable: '未提供',
    cost: '团队估算费用',
    costPartial: '已记录费用（估算）',
    costAll: '{count} 位成员合计',
    costCoverage: '已计入 {count}/{total} 位成员',
    tokens: '团队 Token',
    tokensPartial: '已记录 Token',
    requests: '{count} 次模型请求',
    time: '团队有效耗时',
    timeAll: '至少一位成员在处理；并行重叠只算一次',
    timePartial: '仅 {count}/{total} 位成员有计时；并行重叠只算一次',
    timeNone: '暂无已完成轮次的计时记录',
    tools: '团队工具调用',
    toolsPartial: '已记录工具调用',
    calls: '{count} 次',
    members: '成员费用明细',
    memberCount: '{count} 位成员',
    agent: '智能体',
    estimatedCost: '估算费用',
    share: '费用占比',
    shareLocal: '本地费用占比',
    duration: '有效耗时',
    current: '当前会话',
    timeNote: '顶部有效耗时是把各成员的处理区间合并后去重的时间，不是它们之和：并行重叠只算一次，也不含等待你答复的时间。成员表给的是各自的有效耗时。',
    externalNote: '外部子智能体未提供用量、费用或耗时，不计入以上数字。「未提供」不代表免费。',
    localShareNote: '费用占比以本地已记录的成员费用合计为分母，不含外部子智能体。',
    overview: '智能体团队 · 费用总览',
    detail: '当前会话明细',
    session: '本次会话费用',
    teamRegion: '团队费用',
    heading: '{scope}：{title}',
    pricingHint: '已按每条请求的发生时段分档计价',
    detailHint: '以下只显示当前会话的明细，不合并其他成员的明细。',
    inheritedHint: '当前会话的账本明细可能包含从父会话继承的请求；这些不是本成员新增的费用，团队汇总不会重复计入。',
    empty: '当前会话还没有计费记录。',
  }),
  en: messages({
    teamName: 'Agent team',
    lead: 'Lead',
    worker: 'Subagent',
    nestedWorker: 'Level {depth} subagent',
    externalWorker: 'External subagent',
    unavailable: 'Not reported',
    cost: 'Estimated team cost',
    costPartial: 'Estimated recorded cost',
    costAll: 'Total for {count} members',
    costCoverage: '{count} of {total} members included',
    tokens: 'Team tokens',
    tokensPartial: 'Recorded tokens',
    requests: 'Model requests: {count}',
    time: 'Team effective time',
    timeAll: 'At least one member working; overlap counted once',
    timePartial: 'Only {count}/{total} members timed; overlap counted once',
    timeNone: 'No timing records for completed turns',
    tools: 'Team tool calls',
    toolsPartial: 'Recorded tool calls',
    calls: '{count}',
    members: 'Cost by member',
    memberCount: '{count} members',
    agent: 'Agent',
    estimatedCost: 'Estimated cost',
    share: 'Cost share',
    shareLocal: 'Share of local cost',
    duration: 'Effective time',
    current: 'Current session',
    timeNote: 'The headline is the merged, de-duplicated working time: overlapping parallel runs count once, and time spent waiting for your reply is excluded. The member table shows each member’s own effective time.',
    externalNote: 'External subagents do not report usage, cost or time here. Their figures are excluded, not counted as zero.',
    localShareNote: 'Percentages are shares of the locally recorded member costs. External subagents are excluded.',
    overview: 'Team cost overview',
    detail: 'Current session details',
    session: 'Session cost',
    teamRegion: 'Team cost',
    heading: '{scope}: {title}',
    pricingHint: 'Each request is priced for the time it occurred.',
    detailHint: 'The details below are from this session only. Other members’ details are not combined here.',
    inheritedHint: 'This session’s ledger may include requests inherited from its parent. These are not new charges for this member and are not counted again in the team total.',
    empty: 'There are no billing records for this session yet.',
  }),
}

/** Use the bound locale service when available; preserve placeholder names if a value is missing. */
export function teamTranslator(boundText) {
  return (key, params) => {
    const fullKey = PREFIX + key
    const translated = typeof boundText === 'function' ? boundText(fullKey, params) : undefined
    if (typeof translated === 'string' && translated !== '' && translated !== fullKey) return translated
    const template = SESSION_TEAM_MESSAGES.zh[fullKey] ?? key
    return params == null ? template : template.replace(/\{(\w+)\}/g,
      (placeholder, name) => Object.hasOwn(params, name) ? String(params[name]) : placeholder)
  }
}
