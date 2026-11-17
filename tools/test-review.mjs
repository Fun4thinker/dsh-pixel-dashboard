/** Standalone source-level review regressions. Does not build or touch existing test.mjs. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import plugin, { UsageCatalog } from '../src/host.js'
import { ReviewFacts, buildReview, reviewRange, toolSourceOf, workspaceOf } from '../src/review.js'
import { setMarkup } from '../src/pricing.js'
import { TimingBreakdown } from '../src/timing.js'

let passed = 0
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`) }
  catch (error) { console.error(`  ✗ ${name}`); console.error(error); process.exitCode = 1 }
}
const T = Date.parse
const timezone = 'Asia/Shanghai'
const now = T('2026-11-17T12:00:00+08:00')
const event = (type, time, data = {}) => ({ type, time, data })
const project = (...events) => {
  const facts = new ReviewFacts()
  for (const event of events) facts.observe(event)
  return facts.toJSON()
}
const rec = (s, seq, t, i = 1000, p = '') => ({ k: `${s}:${seq}`, s, t, n: 'deepseek-flash', r: 'deepseek-flash', p, i, h: 0, w: 0, o: 100, g: 0, u: i + 100 })
const modelOfRecord = (record) => ({ key: record.p ? `${record.r}@${record.p}` : record.r, label: record.r })
const costOfRecords = (records) => records.reduce((n, record) => n + record.u, 0) / 1e6
function review(overrides = {}) {
  return buildReview({ records: [], sessions: [{ id: 'a', title: 'A', cwd: 'D:\\one\\repo' }], facts: new Map(), generatedAt: now, now, timezone, days: 7, scope: 'all', modelOfRecord, costOfRecords, ...overrides })
}
function persistenceOf(fixtures, { failOpen = false, failRead = false, failList = false } = {}) {
  let reads = 0
  return {
    get reads() { return reads },
    async list() { if (failList) throw new Error('list exploded'); return fixtures.map(({ id, cwd, events, parentSession, origin, delegationDepth }) => ({ header: { id, cwd, createdAt: 0, parentSession, origin, delegationDepth }, revision: '1', eventCount: events.length })) },
    async open(id) {
      if (failOpen) throw new Error('open exploded')
      const fixture = fixtures.find((row) => row.id === id)
      return {
        inheritedEventCount: fixture.inheritedEventCount ?? 0,
        async read(offset, length) { reads += 1; if (failRead) throw new Error('read exploded'); return { events: fixture.events.slice(offset, offset + length) } },
        async close() {},
      }
    },
  }
}
const catalogs = []
const dirs = []
async function catalogOf(fixtures, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-review-test-'))
  dirs.push(directory)
  const persistence = persistenceOf(fixtures, options)
  const catalog = new UsageCatalog({ persistence: () => persistence, sessions: () => undefined, timezone: () => timezone, ledgerPath: join(directory, 'ledger.jsonl'), ...options })
  catalogs.push(catalog)
  return { catalog, persistence, directory }
}
const assistant = (seq, time, inputTokens = 1000, provider = '') => ({ type: 'assistant/message', seq, time, data: { turn: 1, step: 1, usage: { inputTokens, outputTokens: 100 }, message: { role: 'assistant', source: { kind: 'model', model: 'deepseek-flash', provider }, content: [{ type: 'text', text: 'DO_NOT_RETAIN_ASSISTANT_BODY' }] } } })

console.log('review: strict calendar windows, independent scopes and lightweight facts')
await check('ask_user_question long human wait is not machine processing time', () => {
  const facts = project(
    event('turn/start', now - 3_600_000, { turn: 1 }),
    event('tool/call', now - 3_599_000, { turn: 1, callId: 'ask', name: 'ask_user_question' }),
    event('tool/result', now - 1000, { turn: 1, message: { source: { callId: 'ask' } } }),
    event('turn/end', now, { turn: 1, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 2000)
  assert.equal(result.summary.wallMs, 3_600_000)
  assert.equal(result.summary.awaitingUserMs, 3_598_000)
  assert.equal(result.tools[0].durationMs, 0)
  assert.equal(result.tools[0].rawMs, 3_598_000)
})
await check('legacy step diagnostics exclude nested PTC asks, using official result shape', () => {
  const timing = new TimingBreakdown()
  for (const e of [
    event('step/start', 0, { turn: 1, step: 1 }),
    event('assistant/message', 500),
    event('tool/call', 1000, { turn: 1, callId: 'root', name: 'run_code' }),
    event('tool/ptc-dispatch-start', 1000, { rootCallId: 'root', subCallId: 'ask', name: 'ask_user_question' }),
    event('tool/ptc-dispatch', 3_599_000, { rootCallId: 'root', subCallId: 'ask', isError: false }),
    event('tool/result', 3_599_000, { message: { source: { kind: 'tool', callId: 'root' } } }),
    event('step/end', 3_600_000, { turn: 1, step: 1 }),
  ]) timing.observe(e)
  assert.equal(timing.toJSON().totalMs, 2000)
  assert.equal(timing.toJSON().toolsMs, 0)
  assert.equal(timing.toJSON().awaitingUserMs, 3_598_000)
})
await check('7/30/90 site-calendar windows include today and stop exactly at now', () => {
  for (const days of [7, 30, 90]) {
    const range = reviewRange(days, now, timezone)
    assert.equal(range.end, now)
    assert.equal(range.start, T('2026-11-17T00:00:00+08:00') - (days - 1) * 86_400_000)
  }
  assert.throws(() => reviewRange(14, now, timezone), /days/)
})
await check('calendar window respects daylight-saving rather than N×24 elapsed hours', () => {
  const range = reviewRange(7, T('2026-11-04T12:00:00-08:00'), 'America/Los_Angeles')
  assert.equal(range.start, T('2026-10-29T00:00:00-07:00'))
})
await check('boundaries include start and now but exclude older and future requests', () => {
  const { start } = reviewRange(7, now, timezone)
  const result = review({ records: [rec('a', 1, start - 1), rec('a', 2, start), rec('a', 3, now), rec('a', 4, now + 1)] })
  assert.equal(result.summary.requests, 2)
  assert.equal(result.summary.tokens, 2200)
  assert.equal(result.hours.length, 24)
  assert.equal(result.weekHours.length, 168)
  assert.equal(result.weekHours[0].weekday, 0)
  assert.equal(result.summary.durationMs, null)
  assert.equal(result.sessions[0].durationMs, null)
  assert.equal(result.sessions[0].days.every((day) => day.durationMs === null), true)
  assert.deepEqual(result.coverage, { timedSessions: 0, sessionCount: 1, unknownSourceCalls: 0, archiveSource: 'unknown', totalSessions: 1, hiddenArchived: 0, hiddenInactive: 0, unknownArchive: 1 })
})
await check('completed execution conditions retain exact milliseconds and legitimate zero', () => {
  const facts = project(
    event('turn/start', 0, { turn: 1 }), event('turn/end', 0, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', 10_000, { turn: 2 }), event('turn/end', 12_999, { turn: 2, reason: { kind: 'completed' } }),
    ...['aborted', 'interrupted', 'error'].flatMap((kind, n) => [event('turn/start', 20_000 + n * 10_000, { turn: n + 3 }), event('turn/end', 25_000 + n * 10_000, { turn: n + 3, reason: { kind } })]),
    event('turn/start', 60_000, { turn: 6 }),
  )
  assert.deepEqual(facts.turns.map((turn) => turn.durationMs), [0, 2999])
  const result = review({ generatedAt: 70_000, now: 70_000, timezone: 'UTC', facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 2999)
  assert.equal(result.summary.completedTurns, 2)
})
await check('missing start remains untimed, rather than fabricated zero', () => {
  const facts = project(event('turn/end', now - 1000, { turn: 1, reason: { kind: 'completed' } }))
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.completedTurns, 0)
  assert.equal(result.summary.durationMs, null)
  assert.equal(result.sessions[0].maxTurnMs, null)
})
await check('cross-midnight execution is clipped at the window and split by local hour', () => {
  const end = T('2026-11-11T00:01:01+08:00')
  const facts = project(event('turn/start', end - 125_900, { turn: 1 }), event('turn/end', end, { turn: 1, reason: { kind: 'completed' } }))
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 61_000)
  assert.equal(result.hours[0].durationMs, 61_000)
  assert.equal(result.hours[23].durationMs, 0)
  assert.equal(result.weekHours[2 * 24].durationMs, 61_000) // Wednesday
  assert.deepEqual(result.sessions[0].days.map((day) => day.key), ['2026-11-11'])
})
await check('an old session with recent activity does not acquire its entire lifetime', () => {
  const facts = project(event('turn/start', now - 30 * 86_400_000, { turn: 1 }), event('turn/end', now - 29 * 86_400_000, { turn: 1, reason: { kind: 'completed' } }), event('turn/start', now - 3000, { turn: 2 }), event('turn/end', now - 1000, { turn: 2, reason: { kind: 'completed' } }))
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 2000)
  assert.equal(result.summary.completedTurns, 1)
})
await check('workspace scope uses normalized full paths, never identical trailing names', () => {
  const result = review({ records: [rec('a', 1, now), rec('b', 1, now), rec('c', 1, now)], sessions: [{ id: 'a', cwd: 'D:\\one\\repo\\' }, { id: 'b', cwd: 'D:\\two\\repo' }, { id: 'c', cwd: '' }] })
  assert.equal(result.workspaces.length, 3)
  assert.equal(result.workspaces.filter((row) => row.label === 'repo').length, 2)
  assert.equal(result.workspaces.find((row) => row.id === 'unknown:').sessionCount, 1)
  assert.equal(workspaceOf('D:\\ONE\\repo\\..\\repo').id, workspaceOf('d:/one/repo').id)
  assert.notEqual(workspaceOf('/one/Repo').id, workspaceOf('/one/repo').id)
})
await check('lead and parallel child sessions are independent, never re-summed team totals', () => {
  const facts = new Map(['a', 'b'].map((id) => [id, project(event('turn/start', now - 5000, { turn: 1 }), event('turn/end', now, { turn: 1, reason: { kind: 'completed' } }))]))
  const result = review({ sessions: [{ id: 'a', cwd: '/repo', teamId: 'a', cost: { standard: 100 } }, { id: 'b', cwd: '/repo', parentSession: 'a' }], records: [rec('a', 1, now), rec('b', 1, now)], facts })
  assert.equal(result.summary.durationMs, 10_000)
  assert.equal(result.summary.requests, 2)
  assert.equal(result.summary.cost, 0.0022)
  assert.equal(result.workspaces[0].sessionCount, 2)
})
await check('review teams expose scoped Lead and nested member consumption without double-counting own money', () => {
  const sessions = [
    {id:'a',title:'Lead',cwd:'/repo',teamId:'a',role:'lead',depth:0},
    {id:'b',title:'Worker',cwd:'/repo',teamId:'a',role:'teammate',depth:1,memberName:'researcher'},
    {id:'c',title:'Nested',cwd:'/repo',teamId:'a',role:'teammate',depth:2,memberName:'checker'},
  ]
  const facts = new Map([['a',project(event('turn/start',now-2000,{turn:1}),event('turn/end',now,{turn:1}))],['b',project(event('turn/start',now-3000,{turn:1}),event('turn/end',now,{turn:1}))]])
  const result = review({sessions,facts,records:sessions.map((row)=>rec(row.id,1,now))})
  assert.equal(result.teams.length,1)
  const team = result.teams[0]
  assert.equal(team.leadId,'a')
  assert.deepEqual(team.members.map((row)=>row.id),['a','b','c'])
  assert.equal(team.members[1].name,'researcher')
  assert.equal(team.members[2].depth,2)
  assert.equal(team.cost,0.0033)
  assert.equal(team.tokens,3300)
  assert.equal(team.requests,3)
  assert.equal(team.durationMs,5000)
  assert.equal(team.timedMemberCount,2)
  assert.equal(team.members[2].durationMs,null)
  assert.equal(result.summary.cost,0.0033)
  assert.equal(result.sessions[0].cost,0.0011)
  assert.equal(result.workspaces[0].cost,0.0033)
  assert.equal(result.sessions.every((row)=>row.teamId==='a'),true)
})
await check('team members honor 7/30/90 window and recent archive/unknown scope, never filling hidden Lead with zero', () => {
  const ids=['a','b','c','d']
  const sessions=ids.map((id,index)=>({id,title:id,cwd:'/repo',teamId:'a',role:id==='a'?'lead':'teammate',depth:index,archived:id==='a'?true:id==='c'?null:false}))
  const old=now-20*86_400_000
  const facts=new Map(ids.map((id)=>[id,project(event('assistant/message',id==='d'?old:now))]))
  const records=ids.map((id,index)=>rec(id,1,id==='d'?old:now,(index+1)*1000))
  const recent=review({sessions,facts,records,scope:'recent'})
  const team=recent.teams[0]
  assert.deepEqual(team.members.map((row)=>row.id),['b'])
  assert.equal(team.visibleMemberCount,1)
  assert.equal(team.windowMemberCount,3)
  assert.equal(team.knownMemberCount,4)
  assert.equal(team.hiddenMemberCount,2)
  assert.equal(team.outsideWindowMemberCount,1)
  assert.equal(team.leadInScope,false)
  assert.equal(team.durationMs,null)
  assert.equal(team.wallMs,null)
  assert.equal(team.awaitingUserMs,null)
  assert.equal(team.timedMemberCount,0)
  assert.equal(team.cost,recent.sessions[0].cost)
  for(const days of [7,30,90]) {
    const all=review({sessions,facts,records,scope:'all',days})
    assert.equal(all.teams[0].members.length,days===7?3:4)
    assert.equal(all.teams[0].members[0].id,'a')
    assert.equal(all.teams[0].hiddenMemberCount,0)
    assert.equal(all.summary.cost,all.ledgerSummary.cost)
  }
})
await check('names, matching directories and bare parent ids cannot fabricate a review team', () => {
  const result=review({sessions:[{id:'a',title:'Lead',cwd:'/repo'},{id:'b',title:'Lead worker',cwd:'/repo',parentId:'a',parentSession:'a'}],records:[rec('a',1,now),rec('b',1,now)]})
  assert.deepEqual(result.teams,[])
  assert.equal(result.sessions.every((row)=>row.teamId===undefined),true)
})
await check('top-level and nested PTC results pair correctly, including legitimate 0ms', () => {
  const facts = project(
    event('turn/start', now - 10_000, { turn: 1 }),
    event('tool/call', now - 8000, { turn: 1, callId: 'root', name: 'run_code', arguments: 'SECRET_ARGUMENTS' }),
    event('tool/ptc-dispatch-start', now - 6000, { rootCallId: 'root', subCallId: 'nested', name: 'read', arguments: { secret: true } }),
    event('tool/ptc-dispatch', now - 6000, { rootCallId: 'root', subCallId: 'nested', isError: false, content: 'SECRET_RESULT' }),
    event('tool/result', now - 1000, { turn: 1, message: { source: { callId: 'root' }, toolCallId: 'root', content: 'SECRET_RESULT' } }),
    event('tool/result', now, { callId: 'root' }), // duplicated result must not change timing
    event('turn/end', now, { turn: 1, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.toolCalls, 2)
  assert.equal(result.summary.durationMs, 10_000) // not 10,000 + root + nested
  assert.equal(result.tools.find((tool) => tool.name === 'read').durationMs, 0)
  assert.equal(result.tools.find((tool) => tool.name === 'read').avgMs, 0)
  assert.equal(result.tools.find((tool) => tool.name === 'run_code').durationMs, 7000)
  assert.equal(JSON.stringify(facts).includes('SECRET'), false)
  assert.equal(result.tools.some((tool) => 'cost' in tool), false)
})
await check('unmatched calls stay untimed; errors and top-level callId are supported', () => {
  const facts = project(event('tool/call', now - 10, { callId: 'one', name: 'custom_tool' }), event('tool/result', now, { callId: 'one', error: { code: 'FAIL' } }), event('tool/call', now, { callId: 'pending', name: 'pending_tool' }))
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.tools.find((tool) => tool.name === 'custom_tool').activity[0].status, 'error')
  assert.equal(result.tools.find((tool) => tool.name === 'custom_tool').maxMs, 10)
  assert.equal(result.tools.find((tool) => tool.name === 'pending_tool').durationMs, null)
  assert.equal(result.summary.unknownSourceCalls, 2)
  assert.equal(result.summary.thirdPartyCalls, 0)
})
await check('future tool results cannot manufacture completed timing at snapshot now', () => {
  const facts = project(event('tool/call', now, { callId: 'x', name: 'read' }), event('tool/result', now + 1000, { callId: 'x' }))
  const tool = review({ facts: new Map([['a', facts]]) }).tools[0]
  assert.equal(tool.durationMs, null)
  assert.equal(tool.timedCalls, 0)
  assert.equal(tool.maxMs, null)
  assert.equal(tool.avgMs, null)
  assert.equal(tool.activity[0].status, 'pending')
})
await check('declarations are explicit and recorded/scoped attribution overrides matching names', () => {
  assert.equal(toolSourceOf('read').kind, 'builtin')
  assert.equal(toolSourceOf('load_workspace_dependencies').kind, 'builtin')
  assert.equal(toolSourceOf('codex_image_generate').kind, 'third-party')
  assert.equal(toolSourceOf('some_unmatched_name').kind, 'unknown')
  const source = toolSourceOf('read', new Map([['read', { kind: 'third-party', label: 'Scoped override', packageName: 'my-reader', evidence: 'recorded by caller' }]]))
  assert.equal(source.method, 'recorded')
  assert.equal(source.packageName, 'my-reader')
  const facts = project(event('tool/call', now, { callId: 's', name: 'same_name' }))
  const result = review({ facts: new Map([['a', facts], ['b', facts]]), toolSources: (name, scope) => ({ kind: scope.sessionId === 'a' ? 'builtin' : 'third-party', packageName: scope.sessionId }) })
  assert.equal(result.tools.length, 2)
  assert.equal(result.summary.thirdPartyCalls, 1)
})
await check('calls remain exact beyond 30 recent samples; oldest slowest is retained independently', () => {
  const facts = new ReviewFacts()
  for (let n = 0; n < 45; n += 1) {
    facts.observe(event('tool/call', now - 50_000 + n * 1000, { callId: String(n), name: 'read' }))
    facts.observe(event('tool/result', now - 50_000 + n * 1000 + (n === 0 ? 999 : 1), { message: { toolCallId: String(n) } }))
  }
  const result = review({ facts: new Map([['a', facts.toJSON()]]) })
  const tool = result.tools[0]
  assert.equal(tool.calls, 45)
  assert.equal(tool.timedCalls, 45)
  assert.equal(tool.activity.length, 30)
  assert.equal(tool.slowest.callId, '0')
  assert.equal(tool.slowest.durationMs, 999)
  assert.equal(tool.activity.some((row) => row.callId === '0'), false)
  assert.equal(tool.durationMs, 1043)
})
await check('pure projection exposes incomplete reads, not silent empty totals', () => {
  assert.throws(() => review({ facts: new Map([['a', { error: 'broken page' }]]) }), /broken page/)
})

await check('human activity counts admitted user/retry rounds, not model steps or automatic sources', () => {
  const user = (at, kind = 'user') => event('user/message', at, { role: 'user', source: { kind }, content: [{ type: 'text', text: 'DO_NOT_RETAIN_HUMAN' }] })
  const facts = project(
    event('turn/start', now - 12_000, { turn: 1 }), event('step/start', now - 11_900, { turn: 1 }), user(now - 11_800),
    event('step/start', now - 11_000, { turn: 1 }), user(now - 10_900),
    event('turn/end', now - 10_000, { turn: 1, reason: { kind: 'completed' } }),
    ...['goal', 'agent-message', 'subagent-settled', 'user-question-reply', 'retry'].flatMap((kind, n) => [
      event('turn/start', now - 9000 + n * 1000, { turn: n + 2 }), user(now - 8900 + n * 1000, kind), event('turn/end', now - 8500 + n * 1000, { turn: n + 2, reason: { kind: n === 4 ? 'aborted' : 'completed' } }),
    ]),
  )
  const result = review({ facts: new Map([['a', facts]]), records: [rec('a', 1, now), rec('a', 2, now), rec('a', 3, now)] })
  assert.equal(result.schema, 2)
  assert.equal(result.summary.turns, 2)
  assert.equal(result.summary.requests, 3)
  assert.equal(result.summary.completedTurns, 5)
  assert.equal(result.hours.reduce((n, row) => n + row.turns, 0), 2)
  assert.equal(result.weekHours.reduce((n, row) => n + row.turns, 0), 2)
  assert.equal(result.sessions[0].days[0].turns, 2)
  assert.equal(JSON.stringify(facts).includes('DO_NOT_RETAIN'), false)
})
await check('failed/stopped human rounds count activity without completed execution inflation', () => {
  const facts = project(...['aborted', 'interrupted', 'error', 'completed'].flatMap((kind, n) => [
    event('turn/start', now - 10_000 + n * 2000, { turn: n + 1 }),
    event('user/message', now - 9900 + n * 2000, { source: { kind: 'user' } }),
    event('turn/end', now - 9000 + n * 2000, { turn: n + 1, reason: { kind } }),
  ]))
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.turns, 4)
  assert.equal(result.summary.completedTurns, 1)
  assert.equal(result.summary.durationMs, 1000)
})
await check('parallel asks union once; ordinary root execution and PTC tool effective time share exclusions', () => {
  const facts = project(
    event('turn/start', now - 10_000, { turn: 1 }),
    event('tool/call', now - 10_000, { turn: 1, callId: 'root', name: 'run_code' }),
    event('tool/ptc-dispatch-start', now - 9000, { rootCallId: 'root', subCallId: 'ask1', name: 'ask_user_question' }),
    event('tool/ptc-dispatch-start', now - 8000, { rootCallId: 'root', subCallId: 'ask2', name: 'ask_user_question' }),
    event('tool/ptc-dispatch', now - 2000, { rootCallId: 'root', subCallId: 'ask1' }),
    event('tool/ptc-dispatch', now - 1000, { rootCallId: 'root', subCallId: 'ask2' }),
    event('tool/result', now, { message: { source: { callId: 'root' } } }),
    event('turn/end', now, { turn: 1, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 2000)
  assert.equal(result.summary.awaitingUserMs, 8000)
  assert.equal(result.summary.wallMs, 10_000)
  assert.equal(result.tools.find((row) => row.name === 'run_code').durationMs, 2000)
  const asks = result.tools.find((row) => row.name === 'ask_user_question')
  assert.equal(asks.durationMs, 0)
  assert.equal(asks.rawMs, 14_000)
  assert.equal(asks.waitMs, 14_000) // per-call resource time, unlike unioned wall-clock time
})
await check('unreturned ask is excluded to known turn end and never fabricates a completed tool', () => {
  const facts = project(
    event('turn/start', now - 20_000, { turn: 1 }),
    event('tool/call', now - 19_000, { turn: 1, callId: 'ask', name: 'ask_user_question' }),
    event('turn/end', now - 15_000, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', now - 10_000, { turn: 2 }),
    event('turn/end', now, { turn: 2, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 11_000)
  assert.equal(result.summary.awaitingUserMs, 4000)
  assert.equal(result.tools[0].durationMs, null)
  assert.equal(result.tools[0].rawMs, null)
  assert.equal(result.tools[0].waitMs, 4000)
  assert.equal(result.tools[0].timedCalls, 0)
  assert.equal(result.tools[0].activity[0].status, 'pending')
})
await check('unreturned ask on open execution stops exclusion at snapshot now', () => {
  const facts = project(event('turn/start', now - 10_000, { turn: 1 }), event('tool/call', now - 9000, { turn: 1, name: 'ask_user_question', callId: 'pending' }))
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, null)
  assert.equal(result.summary.completedTurns, 0)
  assert.equal(result.tools[0].waitMs, 9000)
  assert.equal(result.tools[0].timedCalls, 0)
})
await check('wait union is intersected with the window and each completed turn', () => {
  const start = reviewRange(7, now, timezone).start
  const facts = project(
    event('turn/start', start - 60_000, { turn: 1 }),
    event('user/message', start - 59_000, { source: { kind: 'user' } }),
    event('tool/call', start - 30_000, { turn: 1, name: 'ask_user_question', callId: 'ask' }),
    event('tool/result', start + 30_000, { message: { source: { callId: 'ask' } } }),
    event('turn/end', start + 60_000, { turn: 1, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.wallMs, 60_000)
  assert.equal(result.summary.awaitingUserMs, 30_000)
  assert.equal(result.summary.durationMs, 30_000)
  assert.equal(result.summary.turns, 0)
  assert.equal(result.hours[0].durationMs, 30_000)
  assert.equal(result.sessions[0].days[0].durationMs, 30_000)
})
await check('recent scope excludes archived, inherited-only and unknown without losing ledger totals', () => {
  const own = project(event('turn/start', now - 1000, { turn: 1 }), event('user/message', now - 900, { source: { kind: 'user' } }), event('tool/call', now - 500, { name: 'read', callId: 'read' }))
  const inherited = { executions: [], humanTurns: [], tools: [], activityAt: now - 20 * 86_400_000, inheritedEventCount: 10 }
  const sessions = [{ id: 'a', archived: false }, { id: 'b', archived: true }, { id: 'c', archived: false }, { id: 'd', archived: null }]
  const facts = new Map([['a', own], ['b', own], ['c', inherited], ['d', own]])
  const records = sessions.map(({ id }) => rec(id, 1, now))
  const recent = review({ sessions, facts, records, scope: 'recent', archiveSource: 'workspaceRegistry' })
  assert.deepEqual(recent.sessions.map((row) => row.id), ['a'])
  assert.equal(recent.summary.requests, 1)
  assert.equal(recent.summary.turns, 1)
  assert.equal(recent.summary.ledgerSessions, 1)
  assert.equal(recent.summary.toolCalls, 1)
  assert.equal(recent.ledgerSummary.requests, 4)
  assert.equal(recent.ledgerSummary.cost, 0.0044)
  assert.equal(recent.coverage.hiddenArchived, 1)
  assert.equal(recent.coverage.hiddenInactive, 1)
  assert.equal(recent.coverage.unknownArchive, 1)
  assert.equal(recent.coverage.totalSessions, 4)
  const all = review({ sessions, facts, records, scope: 'all' })
  assert.equal(all.summary.requests, 4)
  assert.equal(all.summary.toolCalls, 3)
  assert.equal(all.coverage.hiddenArchived, 0)
  assert.equal(all.sessions.find((row) => row.id === 'b').archived, true)
  assert.equal(all.sessions.find((row) => row.id === 'c').activityAt, now - 20 * 86_400_000)
})

await check('late result is capped at its own execution boundary, never leaks into a later turn', () => {
  const facts = project(
    event('turn/start', now - 20_000, { turn: 1 }),
    event('tool/call', now - 19_000, { turn: 1, name: 'ask_user_question', callId: 'old' }),
    event('turn/end', now - 15_000, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', now - 10_000, { turn: 2 }),
    event('tool/result', now - 1000, { turn: 1, message: { source: { callId: 'old' } } }),
    event('turn/end', now, { turn: 2, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.summary.durationMs, 11_000)
  assert.equal(result.summary.awaitingUserMs, 4000)
})
await check('parallel ordinary leaf execution is machine work, not sibling ask waiting', () => {
  const facts = project(
    event('turn/start', now - 12_000, { turn: 1 }),
    event('step/start', now - 12_000, { turn: 1 }), event('assistant/message', now - 11_500),
    event('tool/call', now - 11_000, { turn: 1, name: 'ask_user_question', callId: 'ask' }),
    event('tool/call', now - 10_000, { turn: 1, name: 'read', callId: 'read' }),
    event('tool/result', now - 5000, { message: { source: { callId: 'read' } } }),
    event('tool/result', now - 1000, { message: { source: { callId: 'ask' } } }),
    event('step/end', now, { turn: 1 }), event('turn/end', now, { turn: 1, reason: { kind: 'completed' } }),
  )
  const result = review({ facts: new Map([['a', facts]]) })
  assert.equal(result.tools.find((row) => row.name === 'read').durationMs, 5000)
  assert.equal(result.tools.find((row) => row.name === 'read').waitMs, 0)
  assert.equal(result.tools.find((row) => row.name === 'ask_user_question').durationMs, 0)
  assert.equal(result.summary.durationMs, 7000)
  assert.equal(result.summary.awaitingUserMs, 5000)
})

await check('nested PTC ancestors exclude their own asks but keep independent sibling execution', () => {
  const events = [
    event('turn/start', now - 10_000, { turn: 1 }), event('step/start', now - 10_000, { turn: 1 }), event('assistant/message', now - 9500),
    event('tool/call', now - 10_000, { turn: 1, name: 'run_code', callId: 'root' }),
    event('tool/ptc-dispatch-start', now - 9000, { rootCallId: 'root', parentCallId: 'root', subCallId: 'mid', name: 'run_code' }),
    event('tool/ptc-dispatch-start', now - 8000, { rootCallId: 'root', parentCallId: 'mid', subCallId: 'ask', name: 'ask_user_question' }),
    event('tool/ptc-dispatch-start', now - 6000, { rootCallId: 'root', parentCallId: 'mid', subCallId: 'read', name: 'read' }),
    event('tool/ptc-dispatch', now - 4000, { rootCallId: 'root', subCallId: 'read' }),
    event('tool/ptc-dispatch', now - 2000, { rootCallId: 'root', subCallId: 'ask' }),
    event('tool/ptc-dispatch', now - 1000, { rootCallId: 'root', subCallId: 'mid' }),
    event('tool/result', now, { message: { source: { callId: 'root' } } }),
    event('step/end', now, { turn: 1 }), event('turn/end', now, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const result = review({ facts: new Map([['a', project(...events)]]) })
  assert.equal(result.summary.awaitingUserMs, 4000)
  assert.equal(result.summary.durationMs, 6000)
  assert.equal(result.tools.find((row) => row.name === 'read').durationMs, 2000)
  assert.equal(result.tools.find((row) => row.name === 'run_code').durationMs, 10_000)
  const timing = new TimingBreakdown()
  for (const e of events) timing.observe(e)
  assert.equal(timing.toJSON().toolsMs, 6000)
  assert.equal(timing.toJSON().awaitingUserMs, 4000)
})

console.log('review: UsageCatalog integration and exact route contract')
await check('review requests and money equal current 7-day ledger/day aggregation including markups', async () => {
  const start = reviewRange(7, now, timezone).start
  const fixtures = [{ id: 'a', cwd: '/repo', events: [assistant(0, start - 1), assistant(1, start, 2000, 'marked'), assistant(2, T('2026-11-16T10:00:00+08:00'), 6000, 'marked'), assistant(3, now, 3000, 'marked')] }]
  setMarkup({ marked: 1.7 })
  const { catalog, persistence } = await catalogOf(fixtures)
  const snapshot = catalog.adoptSnapshot(await catalog.build(now))
  const result = await catalog.readReview(7, 'all')
  const dayRows = snapshot.days.filter((day) => T(`${day.key}T00:00:00+08:00`) >= start)
  assert.equal(result.summary.requests, dayRows.reduce((n, day) => n + day.totals.requests, 0))
  assert.ok(Math.abs(result.summary.cost - dayRows.reduce((n, day) => n + day.cost.standard, 0)) <= 0.000001)
  const reads = persistence.reads
  assert.equal(await catalog.readReview(7, 'all'), result)
  assert.equal(persistence.reads, reads)
  assert.equal(result.range.end, snapshot.generatedAt)
  const defaults = await catalog.readReview()
  assert.equal(defaults.range.days, 30)
  setMarkup({})
})
await check('UsageCatalog passes trusted nested header topology and roster names into windowed review teams', async () => {
  const {catalog} = await catalogOf([
    {id:'a',cwd:'/repo',events:[event('team/member',now-1000,{member:{id:'b',name:'researcher'}}),assistant(1,now)]},
    {id:'b',cwd:'/repo',parentSession:'a',origin:'subagent',delegationDepth:1,events:[assistant(0,now)]},
    {id:'c',cwd:'/repo',parentSession:'b',origin:'subagent',delegationDepth:2,events:[assistant(0,now)]},
    {id:'ordinary',cwd:'/repo',events:[assistant(0,now)]},
  ])
  const snapshot = catalog.adoptSnapshot(await catalog.build(now))
  const result = await catalog.readReview(7,'all')
  assert.equal(result.teams.length,1)
  assert.equal(result.teams[0].knownMemberCount,3)
  assert.equal(result.teams[0].members.find((member)=>member.id==='b').name,'researcher')
  assert.equal(result.teams[0].members.find((member)=>member.id==='c').depth,2)
  assert.equal(result.sessions.find((row)=>row.id==='ordinary').teamId,undefined)
  assert.equal(result.summary.requests,4)
  assert.equal(result.summary.cost,snapshot.days.reduce((sum,day)=>sum+day.cost.standard,0))
  assert.equal(JSON.stringify(result.teams).includes('DO_NOT_RETAIN'),false)
})
await check('review reuses existing detached-parent and cycle topology safeguards without guessing a Lead', async () => {
  const fixtures=[
    {id:'orphan-one',parentSession:'missing-lead',origin:'subagent',delegationDepth:1,events:[assistant(0,now)]},
    {id:'orphan-two',parentSession:'missing-lead',origin:'subagent',delegationDepth:1,events:[assistant(0,now)]},
    {id:'cycle-a',parentSession:'cycle-b',origin:'subagent',events:[assistant(0,now)]},
    {id:'cycle-b',parentSession:'cycle-a',origin:'subagent',events:[assistant(0,now)]},
    {id:'ordinary',events:[assistant(0,now)]},
  ]
  const {catalog}=await catalogOf(fixtures)
  catalog.adoptSnapshot(await catalog.build(now))
  const result=await catalog.readReview(7,'all')
  assert.equal(result.teams.length,1)
  assert.equal(result.teams[0].id,'missing-lead')
  assert.equal(result.teams[0].leadKnown,false)
  assert.equal(result.teams[0].leadInScope,false)
  assert.equal(result.teams[0].members.length,2)
  assert.equal(result.teams[0].members.every((row)=>row.detached===true),true)
  assert.equal(result.sessions.find((row)=>row.id==='cycle-a').teamId,undefined)
  assert.equal(result.summary.requests,5)
})
await check('source cache retains no original events/args/results and exposes shared completed fields', async () => {
  const events = [event('turn/start', now - 2999, { turn: 1 }), assistant(1, now - 2000), event('tool/call', now - 1000, { turn: 1, name: 'read', callId: 'x', arguments: 'DO_NOT_RETAIN_ARGS' }), event('tool/result', now, { message: { toolCallId: 'x', content: 'DO_NOT_RETAIN_RESULTS' } }), event('turn/end', now, { turn: 1, reason: { kind: 'completed' } })].map((e, seq) => ({ ...e, seq }))
  const { catalog } = await catalogOf([{ id: 'a', cwd: '/repo', events }])
  const snapshot = catalog.adoptSnapshot(await catalog.build(now))
  assert.equal(JSON.stringify([...catalog.cache.values()]).includes('DO_NOT_RETAIN'), false)
  assert.equal(snapshot.sessions[0].completedTurnMs, 2999)
  assert.equal(snapshot.sessions[0].completedTurns, 1)
  assert.equal(snapshot.sessions[0].maxCompletedTurnMs, 2999)
  assert.equal((await catalog.readSessionDetail('a')).session.completedTurnMs, 2999)
})
await check('inherited child timing/tools are excluded but financials retain original ledger scope', async () => {
  const prefix = [event('turn/start', now - 8000, { turn: 1 }), assistant(1, now - 7000), event('turn/end', now - 6000, { turn: 1, reason: { kind: 'completed' } })].map((e, seq) => ({ ...e, seq }))
  const owned = [event('turn/start', now - 3000, { turn: 2 }), assistant(4, now - 2000), event('turn/end', now, { turn: 2, reason: { kind: 'completed' } })].map((e, i) => ({ ...e, seq: i + prefix.length }))
  const { catalog } = await catalogOf([{ id: 'a', cwd: '/repo', events: prefix }, { id: 'b', cwd: '/repo', parentSession: 'a', inheritedEventCount: prefix.length, events: [...prefix, ...owned] }])
  const snapshot = catalog.adoptSnapshot(await catalog.build(now))
  const result = await catalog.readReview(7, 'all')
  assert.equal(result.summary.requests, 3)
  assert.equal(result.summary.requests, snapshot.days.reduce((n, day) => n + day.totals.requests, 0))
  assert.equal(result.summary.durationMs, 5000)
  assert.equal(result.summary.completedTurns, 2)
  assert.equal(result.coverage.inheritedRequests, 1)
  assert.equal(result.teams.length, 1)
  assert.equal(result.teams[0].requests, 3, 'team attribution retains the existing inherited ledger ownership')
  assert.ok(Math.abs(result.teams[0].cost - result.summary.cost) < 0.000001)
})
await check('disk snapshot without review waits for one real build instead of returning zero', async () => {
  const { catalog, directory, persistence } = await catalogOf([{ id: 'a', cwd: '/repo', events: [assistant(0, Date.now() - 1000)] }])
  await writeFile(join(directory, 'ledger.jsonl.snapshot.json'), JSON.stringify({ version: 3, builtAt: now, payload: { generatedAt: now, timezone, sessions: [] }, details: {} }))
  const result = await catalog.readReview(7, 'all')
  assert.equal(result.summary.requests, 1)
  assert.ok(persistence.reads > 0)
  assert.ok(catalog.reviewInput)
})
await check('read failure is visible in review, while existing dashboard stays fail-soft', async () => {
  for (const failure of [{ failOpen: true }, { failRead: true }, { failList: true }]) {
    const { catalog } = await catalogOf([{ id: 'a', cwd: '/repo', events: [assistant(0, now)] }], failure)
    catalog.adoptSnapshot(await catalog.build(now))
    await assert.rejects(catalog.readReview(7, 'all'), /exploded/)
  }
})
await check('schema v4 invalidates previous v3 per-session derived semantics', async () => {
  const { catalog, directory, persistence } = await catalogOf([{ id: 'a', cwd: '/repo', events: [assistant(0, now)] }])
  await writeFile(join(directory, 'session-cache.json'), JSON.stringify({ version: 1, sessions: { a: { fingerprint: `v3:1:1:@${timezone}`, records: [], turns: 999, days: [], members: [], review: { turns: [], tools: [], executions: [], humanTurns: [] } } } }))
  catalog.adoptSnapshot(await catalog.build(now))
  assert.ok(persistence.reads > 0)
  assert.equal((await catalog.readReview(7, 'all')).summary.requests, 1)
})
await check('human calendar/day/session activity is independent of model requests and inherited history', async () => {
  const yesterday = T('2026-11-16T23:59:59+08:00'), today = yesterday + 2000
  const human = event('user/message', today, { role: 'user', source: { kind: 'user' }, content: 'DO_NOT_RETAIN_INPUT' })
  const prefix = [event('turn/start', yesterday, { turn: 1 }), event('step/start', yesterday + 1, { turn: 1 }), human, assistant(3, today + 100), event('turn/end', today + 1000, { turn: 1, reason: { kind: 'completed' } })].map((e, seq) => ({ ...e, seq }))
  const own = [event('turn/start', now - 5000, { turn: 2 }), event('user/message', now - 4900, { source: { kind: 'goal' } }), assistant(7, now - 4000), event('turn/end', now - 3000, { turn: 2, reason: { kind: 'completed' } })].map((e, n) => ({ ...e, seq: prefix.length + n }))
  const { catalog } = await catalogOf([{ id: 'a', events: prefix }, { id: 'b', inheritedEventCount: prefix.length, events: [...prefix, ...own] }])
  const snapshot = catalog.adoptSnapshot(await catalog.build(now))
  assert.equal(snapshot.overview.activeDays, 1)
  assert.equal(snapshot.overview.turns, 1)
  assert.equal(snapshot.overview.streaks.longest, 1)
  assert.equal(snapshot.heatmap.turns.at(-1), 1)
  assert.equal(snapshot.heatmap.maxTurns, 1)
  assert.equal(snapshot.heatmap.requests.at(-1), 3)
  assert.equal(snapshot.days.find((row) => row.key === '2026-11-17').turns, 1)
  assert.equal(snapshot.sessions.find((row) => row.id === 'a').turns, 1)
  assert.equal(snapshot.sessions.find((row) => row.id === 'b').turns, 0)
  const detail = await catalog.readSessionDetail('a')
  assert.equal(detail.days.find((row) => row.key === '2026-11-17').turns, 1)
  assert.equal((await catalog.readReview(7, 'all')).summary.turns, 1)
})
await check('human-only failed round creates an active day with zero machine requests', async () => {
  const events = [event('turn/start', now - 1000, { turn: 1 }), event('user/message', now - 900, { source: { kind: 'user' } }), event('turn/end', now, { turn: 1, reason: { kind: 'error' } })].map((e, seq) => ({ ...e, seq }))
  const { catalog } = await catalogOf([{ id: 'a', events }])
  const snapshot = catalog.adoptSnapshot(await catalog.build(now))
  assert.equal(snapshot.overview.activeDays, 1)
  assert.equal(snapshot.days[0].turns, 1)
  assert.equal(snapshot.days[0].totals.requests, 0)
  assert.equal(snapshot.heatmap.turns.at(-1), 1)
  const detail = await catalog.readSessionDetail('a')
  assert.equal(detail.days[0].turns, 1)
  assert.equal(detail.days[0].totals.requests, 0)
})
await check('completed session card and legacy step diagnostics both exclude ask waits, pending remains uncompleted', async () => {
  const events = [
    event('turn/start', now - 20_000, { turn: 1 }), event('step/start', now - 20_000, { turn: 1 }),
    event('user/message', now - 19_900, { source: { kind: 'user' } }), assistant(3, now - 19_500),
    event('tool/call', now - 19_000, { turn: 1, name: 'ask_user_question', callId: 'ask' }),
    event('tool/result', now - 11_000, { message: { source: { kind: 'tool', callId: 'ask' } } }),
    event('step/end', now - 10_000, { turn: 1 }), event('turn/end', now - 10_000, { turn: 1, reason: { kind: 'completed' } }),
    event('turn/start', now - 5000, { turn: 2 }), event('tool/call', now - 4000, { turn: 2, name: 'ask_user_question', callId: 'pending' }),
  ].map((e, seq) => ({ ...e, seq }))
  const { catalog } = await catalogOf([{ id: 'a', events }])
  const snapshot = catalog.adoptSnapshot(await catalog.build(now)), session = snapshot.sessions[0]
  assert.equal(session.completedTurnMs, 2000)
  assert.equal(session.completedWallMs, 10_000)
  assert.equal(session.awaitingUserMs, 8000)
  assert.equal(session.completedTurns, 1)
  assert.equal(session.timing.totalMs, 2000)
  assert.equal(session.timing.toolsMs, 0)
  const detail = await catalog.readSessionDetail('a')
  assert.equal(detail.session.completedTurnMs, 2000)
  assert.equal(detail.session.completedWallMs, 10_000)
  assert.equal(detail.session.awaitingUserMs, 8000)
  const result = await catalog.readReview(7, 'all')
  assert.equal(result.summary.durationMs, 2000)
  assert.equal(result.tools[0].timedCalls, 1)
  assert.equal(result.tools[0].activity.find((row) => row.callId === 'pending').durationMs, null)
})
await check('missing registry is unknown, recent is conservative, all preserves ledger coverage', async () => {
  const { catalog } = await catalogOf([{ id: 'a', events: [assistant(0, now)] }])
  catalog.adoptSnapshot(await catalog.build(now))
  const recent = await catalog.readReview(7)
  assert.equal(recent.scope, 'recent')
  assert.equal(recent.summary.requests, 0)
  assert.equal(recent.ledgerSummary.requests, 1)
  assert.equal(recent.coverage.unknownArchive, 1)
  assert.equal(recent.coverage.archiveSource, 'unknown')
  const all = await catalog.readReview(7, 'all')
  assert.equal(all.summary.requests, 1)
  assert.equal(all.sessions[0].archived, null)
})
await check('archive getter changes scope immediately without a log rescan or mutating registry', async () => {
  let ids = []
  const registry = { get archivedSessionIds() { return ids } }
  const { catalog, persistence } = await catalogOf([{ id: 'a', events: [assistant(0, now)] }], { workspaceRegistry: () => registry })
  catalog.adoptSnapshot(await catalog.build(now))
  assert.equal((await catalog.readReview(7)).summary.requests, 1)
  const reads = persistence.reads
  ids = ['a']
  const recent = await catalog.readReview(7)
  assert.equal(recent.summary.requests, 0)
  assert.equal(recent.coverage.hiddenArchived, 1)
  assert.equal(recent.ledgerSummary.requests, 1)
  assert.equal((await catalog.readReview(7, 'all')).sessions[0].archived, true)
  assert.equal(persistence.reads, reads)
  ids = []
  assert.equal((await catalog.readReview(7)).summary.requests, 1)
})
await check('route is exact, validates days, scope and methods, defaults to recent/30 and exposes errors', async () => {
  const routes = []
  const disposers = []
  const original = UsageCatalog.prototype.readReview
  const ctx = {
    get() { return undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on() { return () => {} },
  }
  async function request(route, method, url) {
    const response = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
    await route.handler({ method, url, resume() {} }, response)
    return response
  }
  try {
    plugin.apply(ctx)
    const route = routes.find((route) => route.path === '/dsh-pixel/review')
    assert.equal(route.kind, 'exact')
    let requested, requestedScope
    UsageCatalog.prototype.readReview = async function (days, scope) { requested = days; requestedScope = scope; return { schema: 2, scope } }
    assert.equal((await request(route, 'GET', '/dsh-pixel/review')).statusCode, 200)
    assert.equal(requested, 30)
    assert.equal(requestedScope, 'recent')
    for (const scope of ['recent', 'all']) {
      assert.equal((await request(route, 'GET', `/dsh-pixel/review?scope=${scope}`)).statusCode, 200)
      assert.equal(requestedScope, scope)
    }
    for (const scope of ['', 'archived', 'ALL', 'invalid']) assert.equal((await request(route, 'GET', `/dsh-pixel/review?scope=${scope}`)).statusCode, 400)
    for (const days of ['0', '1', '14', 'invalid', '', '7.0', '7.5', '07', 'NaN']) assert.equal((await request(route, 'GET', `/dsh-pixel/review?days=${days}`)).statusCode, 400)
    for (const days of ['7', '30', '90']) { assert.equal((await request(route, 'GET', `/dsh-pixel/review?days=${days}`)).statusCode, 200); assert.equal(requested, Number(days)) }
    assert.equal((await request(route, 'POST', '/dsh-pixel/review')).statusCode, 405)
    assert.equal((await request(route, 'HEAD', '/dsh-pixel/review')).body, undefined)
    UsageCatalog.prototype.readReview = async function () { throw new Error('visible failure') }
    const failed = await request(route, 'GET', '/dsh-pixel/review')
    assert.equal(failed.statusCode, 500)
    assert.equal(JSON.parse(failed.body).error, 'visible failure')
  } finally { UsageCatalog.prototype.readReview = original; for (const dispose of disposers.reverse()) dispose() }
})

for (const catalog of catalogs) {
  clearTimeout(catalog.cacheSaveTimer)
  clearTimeout(catalog.rebuildTimer)
}
// Only remove directories created by this test, after checking their resolved intended targets.
for (const directory of dirs) {
  const target = resolve(directory)
  assert.equal(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'), true)
  assert.match(target, /dsh-review-test-/)
  await rm(target, { recursive: true, force: true })
}
console.log(`\n${passed} review tests passed${process.exitCode ? ' (failures above)' : ''}`)
