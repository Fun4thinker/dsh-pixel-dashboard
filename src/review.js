/** Lightweight review projection. No event, arguments, result body or assistant text is retained. */
import { posix, win32 } from 'node:path'
import { zonedFacts, zonedParts } from './pricing.js'
import { overlapMs, questionWaitProjection, toolResultId } from './timing.js'

const DAY_MS = 86_400_000
const finiteTime = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const round6 = (value) => Math.round(value * 1e6) / 1e6

/** Canonical full path identity, not a basename. Unknown paths have their own bucket. */
export function workspaceOf(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (raw === '') return { id: 'unknown:', path: '', label: '(未知目录)' }
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(raw)
  const api = windows ? win32 : posix
  let path = api.normalize(raw)
  const root = api.parse(path).root
  while (path.length > root.length && /[\\/]$/.test(path)) path = path.slice(0, -1)
  // Windows paths are case-insensitive; POSIX paths are not. Keep display spelling intact.
  return { id: windows ? path.replaceAll('\\', '/').toLowerCase() : path, path, label: api.basename(path) || path }
}

/** Source declarations verified against installed 0.2.2-rc.3 source (not runtime owner data).
 * Tools registry does not expose plugin ownership and scoped tools may shadow these names.
 * Keep the evidence and method on the wire so a declaration is never presented as recorded fact.
 */
const TOOL_DECLARATIONS = new Map()
for (const [names, packageName, label, evidence, kind = 'builtin'] of [
  [['read', 'write', 'edit'], '@deepseek-ai/dsh-tool-fs', 'DSH 文件', 'src/read.ts:77; src/write.ts:73; src/edit.ts:85'],
  [['glob', 'grep'], '@deepseek-ai/dsh-tool-fs-search', 'DSH 文件搜索', 'src/glob.ts:321; src/grep.ts:286'],
  [['pwsh'], '@deepseek-ai/dsh-tool-pwsh', 'DSH PowerShell', 'src/index.ts:408'],
  [['cordis_inspect_list', 'cordis_inspect_query'], '@deepseek-ai/dsh-tool-cordis', 'DSH Cordis Inspect', 'src/index.ts:22,43'],
  [['web_search', 'web_fetch'], '@deepseek-ai/dsh-tool-web', 'DSH 网络', 'src/search.ts:362; src/fetch.ts:458'],
  [['load_workspace_dependencies'], '@deepseek-ai/dsh-tool-workspace-dependencies', 'DSH 工作区依赖', 'src/index.ts:294'],
  [['working_directory'], '@deepseek-ai/dsh-tool-working-directory', 'DSH 工作目录', 'src/index.ts:20'],
  [['create_worktree'], '@deepseek-ai/dsh-experimental-tool-worktree', 'DSH Worktree', 'src/index.ts:17'],
  [['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'], '@deepseek-ai/dsh-tool-agent-team', 'DSH 团队任务', 'src/index.ts:117,143,184,200'],
  [['propose_action'], '@deepseek-ai/dsh-action-cards', 'DSH 操作提案', 'src/projection.ts:8; src/index.ts:196'],
  [['skill'], '@deepseek-ai/dsh-tool-skill', 'DSH 技能', 'src/index.ts:85,165'],
  [['job_output', 'job_list', 'job_kill'], '@deepseek-ai/dsh-tool-jobs', 'DSH 后台任务', 'src/index.ts:432,547,569'],
  [['present'], '@deepseek-ai/dsh-tool-present', 'DSH 文件交付', 'src/index.ts:38'],
  [['get_goal', 'create_goal', 'update_goal'], '@deepseek-ai/dsh-tool-goal', 'DSH 目标', 'src/index.ts:195,207,234'],
  [['ask_user_question'], '@deepseek-ai/dsh-tool-ask-user', 'DSH 用户提问', 'src/index.ts:39'],
  [['todo_write'], '@deepseek-ai/dsh-tool-todo', 'DSH 待办', 'src/index.ts:136'],
  [['workflow'], '@deepseek-ai/dsh-tool-workflow', 'DSH 工作流', 'src/index.ts:60,331 (default name)'],
  [['send_message', 'list_agents', 'wait_agent'], '@deepseek-ai/dsh-tool-subagent-control', 'DSH 代理协作', 'src/index.ts:44,84; src/list-agents.ts:46,95; src/wait-agent.ts:90'],
  [['subagent', 'subagent_fork', 'list_subagent_models'], '@deepseek-ai/dsh-tool-subagent', 'DSH 子代理', 'src/index.ts:84,208,338; src/list-models.ts:109; dsh-base/cordis.patch.yml:401 (fork name)'],
  [['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'], '@deepseek-ai/dsh-tool-schedule', 'DSH 定时任务', 'src/index.ts:371,393,418,434'],
  [['read_image'], '@deepseek-ai/dsh-tool-fs', 'DSH 文件', 'src/read-image.ts:287'],
  [['exit_plan_mode'], '@deepseek-ai/dsh-plan-mode', 'DSH 计划模式', 'src/index.ts:64,280'],
  [['plugin_manager'], '@deepseek-ai/dsh-plugin-manager', 'DSH 插件管理', 'src/tools.ts:87'],
  [['codex_image_generate', 'codex_subscription_preferences'], 'dsh-codex-subscription', 'Codex 订阅插件', '3.2.18 lib/index.js:949,5466,18708,19274', 'third-party'],
  [['create_skill'], '@michengai/dsh-skills-manager', '技能管理插件', '1.4.10 lib/index.js:340,368', 'third-party'],
  [['dsh_im_group_history', 'dsh_im_group_file', 'dsh_im_return_file'], '@xmanrui/dsh-im', 'IM 插件', '5.10.0 src/channels/shared/group-history-access.mjs:87,122; semantic/artifact.mjs:7,655,730', 'third-party'],
]) {
  for (const name of names) TOOL_DECLARATIONS.set(name, { kind, label, packageName, method: 'declaration', evidence: `${packageName} ${evidence}` })
}

/** Explicit scoped/recorded evidence overrides declaration matches. No exclusion heuristic. */
export function createToolSourceResolver(overrides) {
  return (name, context) => {
    const explicit = typeof overrides === 'function' ? overrides(name, context) : overrides?.get?.(name)
    return explicit ?? TOOL_DECLARATIONS.get(name)
  }
}

/** Resolver receives (name, { sessionId, turn, callId }) for scoped-name disambiguation. */
export function toolSourceOf(name, toolSources, context = {}) {
  const source = createToolSourceResolver(toolSources)(name, context)
  if (!source || !['builtin', 'third-party', 'unknown'].includes(source.kind)) {
    return { kind: 'unknown', label: '来源未知', packageName: '', method: 'unknown', evidence: '' }
  }
  return {
    kind: source.kind,
    label: String(source.label || (source.kind === 'builtin' ? 'DSH 内置' : source.kind === 'third-party' ? '第三方' : '来源未知')),
    packageName: String(source.packageName ?? ''),
    method: source.kind === 'unknown' ? 'unknown' : source.method === 'declaration' ? 'declaration' : 'recorded',
    evidence: String(source.evidence ?? ''),
  }
}

/** Stream-derived scalar facts. Direct user inputs and manual retry start human rounds.
 * The official loop starts a turn BEFORE admitting its user/message. Steering within
 * the same execution turn is deduplicated; machine continuations and question replies
 * are not new human-initiated conversation rounds. No message body is retained.
 */
export class ReviewFacts {
  constructor() {
    this.executions = []
    this.humanTurns = []
    this.tools = []
    this.starts = new Map()
    this.calls = new Map()
    this.humans = new Set()
    this.currentTurn = null
    this.activityAt = null
  }
  observe(event) {
    const data = event?.data ?? {}
    const at = finiteTime(event?.time) ? event.time : null
    const turn = Number.isFinite(data.turn) ? data.turn : this.currentTurn
    if (/^(turn|step)\/(start|end)$/.test(event?.type) || ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event?.type)) {
      if (at !== null) this.activityAt = Math.max(this.activityAt ?? 0, at)
    }
    if (event?.type === 'turn/start') {
      this.currentTurn = turn
      if (!this.starts.has(turn)) {
        const execution = { turn, start: at, at: null, reason: '' }
        this.executions.push(execution)
        this.starts.set(turn, execution)
      }
    }
    if (event?.type === 'user/message' && this.currentTurn !== null && this.starts.has(turn) && ['user', 'retry'].includes(data.source?.kind) && !this.humans.has(turn)) {
      this.humans.add(turn)
      this.humanTurns.push({ turn, at })
    }
    if (event?.type === 'turn/end') {
      let execution = this.starts.get(turn)
      if (!execution) {
        execution = { turn, start: null, at: null, reason: '' }
        this.starts.set(turn, execution)
        this.executions.push(execution)
      }
      if (execution.at === null) { execution.at = at; execution.reason = String(data.reason?.kind ?? '') }
      this.currentTurn = null
    }
    const nestedStart = event?.type === 'tool/ptc-dispatch-start'
    if (event?.type === 'tool/call' || nestedStart) {
      const callId = String(nestedStart ? data.subCallId ?? '' : data.callId ?? data.id ?? '')
      const key = `${nestedStart ? 'ptc' : 'call'}:${callId}`
      if (callId !== '' && this.calls.has(key)) return
      const call = { name: String(data.name ?? '(未知工具)'), at, endAt: null, durationMs: null, status: 'pending', turn: turn ?? this.calls.get(`call:${data.rootCallId}`)?.turn ?? null, callId, nested: nestedStart, rootCallId: nestedStart ? String(data.rootCallId ?? '') : '', parentCallId: nestedStart ? String(data.parentCallId ?? '') : '' }
      this.tools.push(call)
      if (callId !== '') this.calls.set(key, call)
    }
    const nestedEnd = event?.type === 'tool/ptc-dispatch'
    if (event?.type === 'tool/result' || nestedEnd) {
      const id = nestedEnd ? String(data.subCallId ?? '') : toolResultId(data)
      const call = this.calls.get(`${nestedEnd ? 'ptc' : 'call'}:${id}`)
      if (!call || call.status !== 'pending') return
      call.endAt = at
      call.durationMs = call.at !== null && at !== null && at >= call.at ? at - call.at : null
      call.status = data.error || data.isError || data.message?.isError ? 'error' : 'completed'
    }
  }
  toJSON() {
    const projection = { executions: this.executions, humanTurns: this.humanTurns, tools: this.tools, activityAt: this.activityAt }
    return { ...projection, turns: completedExecutionTurns(projection) }
  }
}

/** Unreturned asks stop at their known execution end, otherwise at snapshot now.
 * No synthetic tool/result or completed invocation is created by this exclusion.
 */
export function userWaitRanges(projection, now = Infinity) {
  const ends = new Map((projection.executions ?? []).map((turn) => [turn.turn, turn.at]))
  return questionWaitProjection(projection.tools ?? [], ends, now).waits
}
export function completedExecutionTurns(projection, now = Infinity) {
  const waits = userWaitRanges(projection, now)
  return (projection.executions ?? []).filter((turn) => finiteTime(turn.at) && turn.at <= now && !['aborted', 'interrupted', 'error'].includes(turn.reason)).map((turn) => {
    const wallMs = finiteTime(turn.start) && turn.at >= turn.start ? turn.at - turn.start : null
    const awaitingUserMs = wallMs === null ? null : overlapMs(waits, turn.start, turn.at)
    return { ...turn, wallMs, awaitingUserMs, durationMs: wallMs === null ? null : wallMs - awaitingUserMs }
  })
}

/** Last N site-calendar days including today, from local midnight to now, inclusive.
 * Binary-search the first instant belonging to the start date: this handles DST (23/25h days)
 * and midnight offset transitions without assuming a fixed UTC offset.
 */
export function reviewRange(days, now, timezone) {
  if (![7, 30, 90].includes(days)) throw new RangeError('days 只支持 7、30 或 90')
  if (!finiteTime(now)) throw new RangeError('无效的复盘时间')
  const parts = zonedParts(now, timezone)
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - (days - 1) * DAY_MS)
  const key = date.toISOString().slice(0, 10)
  const nominal = Date.parse(`${key}T00:00:00Z`)
  let low = nominal - 2 * DAY_MS
  let high = nominal + 2 * DAY_MS
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (zonedFacts(mid, timezone).key < key) low = mid + 1
    else high = mid
  }
  return { days, start: low, end: now }
}

const usageBucket = () => ({ cost: 0, tokens: 0, requests: 0, turns: 0, durationMs: 0, wallMs: 0, awaitingUserMs: 0 })
const dayBucket = (key) => ({ key, ...usageBucket(), durationMs: null, wallMs: null, awaitingUserMs: null, completedTurns: 0, toolCalls: 0 })

/** Attribution is an additional view of scoped own rows, never another accounting bucket.
 * Only host-derived topology is accepted; a title/path or bare parent id is not evidence.
 * Counts distinguish known roster, current window, and selected scope, without exposing
 * excluded members' consumption or silently filling missing Lead/clock values with zero.
 */
function teamsOfReview(metas, rows, candidates) {
  const groups = new Map()
  for (const meta of metas.values()) {
    if (typeof meta.teamId !== 'string' || meta.teamId === '' || !['lead', 'teammate'].includes(meta.role)) continue
    const list = groups.get(meta.teamId) ?? []
    list.push(meta); groups.set(meta.teamId, list)
  }
  const nullableSum = (members, field) => {
    const values = members.map((member) => member[field]).filter((value) => typeof value === 'number' && Number.isFinite(value))
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  }
  const out = []
  for (const [id, known] of groups) {
    if (known.length < 2) continue
    const visible = known.filter((meta) => rows.has(meta.id))
    if (visible.length === 0) continue
    const lead = known.find((meta) => meta.role === 'lead' && meta.id === id)
    const members = visible.map((meta) => {
      const row = rows.get(meta.id)
      row.teamId = id
      return {
        id: row.id, title: row.title, name: meta.memberName || meta.memberLabel || row.title,
        role: meta.role, depth: Number.isSafeInteger(meta.depth) ? meta.depth : 0,
        ...(meta.detached === true ? { detached: true } : {}),
        cost: row.cost, tokens: row.tokens, requests: row.requests,
        durationMs: row.durationMs, wallMs: row.wallMs, awaitingUserMs: row.awaitingUserMs,
        activityAt: row.activityAt,
      }
    }).sort((a, b) => (a.role === 'lead' ? 0 : 1) - (b.role === 'lead' ? 0 : 1)
      || b.cost - a.cost || a.id.localeCompare(b.id))
    const windowMemberCount = known.filter((meta) => candidates.has(meta.id)).length
    out.push({
      id, title: lead?.title || '团队', leadId: lead?.id ?? id,
      knownMemberCount: known.length, windowMemberCount, visibleMemberCount: members.length,
      hiddenMemberCount: windowMemberCount - members.length,
      outsideWindowMemberCount: known.length - windowMemberCount,
      leadKnown: !!lead, leadInScope: members.some((member) => member.id === id && member.role === 'lead'),
      leadInWindow: candidates.has(id), detached: !lead || known.some((meta) => meta.detached === true),
      cost: round6(nullableSum(members, 'cost') ?? 0), tokens: nullableSum(members, 'tokens'), requests: nullableSum(members, 'requests'),
      durationMs: nullableSum(members, 'durationMs'), wallMs: nullableSum(members, 'wallMs'), awaitingUserMs: nullableSum(members, 'awaitingUserMs'),
      timedMemberCount: members.filter((member) => typeof member.durationMs === 'number' && Number.isFinite(member.durationMs)).length,
      members,
    })
  }
  return out.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id))
}

/** Independent session scopes: ledger never establishes own recent activity.
 * Money/requests retain ledger ownership (including inherited records) and pricing.
 * Human turns belong to first admitted human input; completed execution spans are
 * clipped to the window and local hour/day, then their unioned question waits removed.
 */
export function buildReview({ records, sessions, facts, generatedAt, timezone, days = 30, now = generatedAt, scope = 'recent', archiveSource = 'unknown', toolSources, costOfRecords, modelOfRecord }) {
  if (!['recent', 'all'].includes(scope)) throw new RangeError('scope 只支持 recent 或 all')
  const range = reviewRange(days, now, timezone)
  const inside = (at) => finiteTime(at) && at >= range.start && at <= range.end
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...usageBucket() }))
  const weekHours = Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, ...usageBucket() }))
  const metas = new Map(sessions.map((session) => [session.id, session]))
  const rows = new Map(), toolRows = new Map(), candidates = new Set(), active = new Set()
  const activityTimes = new Map()
  for (const [id, projection] of facts) {
    if (projection.error) throw new Error(`复盘读取会话 ${id} 失败：${projection.error}`)
    const allTimes = [projection.activityAt, ...(projection.humanTurns ?? []).map((row) => row.at), ...(projection.executions ?? []).flatMap((row) => [row.start, row.at]), ...(projection.tools ?? []).flatMap((row) => [row.at, row.endAt])].filter((at) => finiteTime(at) && at <= now)
    if (allTimes.length) activityTimes.set(id, allTimes.reduce((max, at) => Math.max(max, at), 0))
    if (allTimes.some(inside)) { active.add(id); candidates.add(id) }
    if (completedExecutionTurns(projection, now).some((turn) => turn.durationMs !== null && turn.at >= range.start && turn.start <= range.end)) candidates.add(id)
  }
  const seen = new Set()
  const windowRecords = records.filter((record) => {
    if (!inside(Number(record.t)) || seen.has(record.k)) return false
    seen.add(record.k); candidates.add(String(record.s ?? '')); return true
  })
  const archivedOf = (id) => typeof metas.get(id)?.archived === 'boolean' ? metas.get(id).archived : null
  const selected = new Set([...candidates].filter((id) => scope === 'all' || archivedOf(id) === false && active.has(id)))
  const selectedRecords = windowRecords.filter((record) => selected.has(String(record.s ?? '')))
  const ledgerSummary = { cost: costOfRecords(windowRecords), tokens: windowRecords.reduce((sum, record) => sum + Number(record.u ?? Number(record.i ?? 0) + Number(record.o ?? 0)), 0), requests: windowRecords.length, sessionCount: new Set(windowRecords.map((record) => record.s)).size }
  let inheritedRequests = 0
  const metricsAt = (at) => {
    const { parts } = zonedFacts(at, timezone)
    return [hours[parts.hour], weekHours[((parts.weekday + 6) % 7) * 24 + parts.hour]]
  }
  const ensure = (id) => {
    if (rows.has(id)) return rows.get(id)
    const meta = metas.get(id) ?? {}, workspace = workspaceOf(meta.cwd)
    const row = { id, title: meta.title || id, workspace: workspace.label, cwd: meta.cwd ?? '', ...usageBucket(), durationMs: null, wallMs: null, awaitingUserMs: null, archived: archivedOf(id), activityAt: activityTimes.get(id) ?? null, completedTurns: 0, toolCalls: 0, maxTurnMs: null, lastAt: 0, models: [], days: [], _records: [], _models: new Map(), _days: new Map(), _workspace: workspace }
    rows.set(id, row); return row
  }
  const dayOf = (row, at) => {
    const key = zonedFacts(at, timezone).key
    if (!row._days.has(key)) row._days.set(key, { ...dayBucket(key), _records: [] })
    return row._days.get(key)
  }
  for (const id of selected) ensure(id)
  for (const record of selectedRecords) {
    const id = String(record.s ?? '')
    const inherited = Number(facts.get(id)?.inheritedEventCount ?? 0)
    const seq = Number(String(record.k ?? '').slice(id.length + 1))
    if (inherited > 0 && Number.isFinite(seq) && seq < inherited) inheritedRequests += 1
    const row = ensure(id), at = Number(record.t)
    const tokens = Number(record.u ?? Number(record.i ?? 0) + Number(record.o ?? 0))
    const model = modelOfRecord(record)
    const modelRow = row._models.get(model.key) ?? { label: model.label, cost: 0, tokens: 0, _records: [] }
    modelRow.tokens += tokens; modelRow._records.push(record); row._models.set(model.key, modelRow)
    row._records.push(record); row.tokens += tokens; row.requests += 1; row.lastAt = Math.max(row.lastAt, at)
    const day = dayOf(row, at)
    day.tokens += tokens; day.requests += 1; day._records.push(record)
    for (const bucket of metricsAt(at)) { bucket.tokens += tokens; bucket.requests += 1; (bucket._records ??= []).push(record) }
  }
  for (const [id, projection] of facts) {
    if (!selected.has(id)) continue
    const row = ensure(id), waits = userWaitRanges(projection, now)
    for (const human of projection.humanTurns ?? []) {
      if (!inside(human.at)) continue
      row.turns += 1; dayOf(row, human.at).turns += 1
      for (const bucket of metricsAt(human.at)) bucket.turns += 1
    }
    for (const turn of completedExecutionTurns(projection, now)) {
      if (turn.durationMs === null || turn.at < range.start || turn.start > range.end) continue
      const start = Math.max(range.start, turn.start), end = Math.min(range.end, turn.at)
      const wallMs = end - start, awaitingUserMs = overlapMs(waits, start, end), durationMs = wallMs - awaitingUserMs
      if (inside(turn.at)) { row.completedTurns += 1; dayOf(row, turn.at).completedTurns += 1 }
      row.maxTurnMs = Math.max(row.maxTurnMs ?? 0, durationMs)
      for (const [key, value] of Object.entries({ wallMs, awaitingUserMs, durationMs })) row[key] = (row[key] ?? 0) + value
      // Split at site-local hour boundaries (including half-hour-offset time zones).
      let cursor = start
      do {
        const parts = zonedParts(cursor, timezone)
        const boundary = cursor + (60 - parts.minute) * 60_000 - cursor % 60_000
        const stop = Math.min(end, boundary)
        const wall = stop - cursor, waiting = overlapMs(waits, cursor, stop)
        for (const bucket of [dayOf(row, cursor), ...metricsAt(cursor)]) {
          bucket.wallMs = (bucket.wallMs ?? 0) + wall
          bucket.awaitingUserMs = (bucket.awaitingUserMs ?? 0) + waiting
          bucket.durationMs = (bucket.durationMs ?? 0) + wall - waiting
        }
        cursor = stop
      } while (cursor < end)
    }
    const executionEnds = new Map((projection.executions ?? []).map((turn) => [turn.turn, turn.at]))
    const questionTiming = questionWaitProjection(projection.tools ?? [], executionEnds, now)
    for (const call of projection.tools ?? []) {
      if (!inside(call.at)) continue
      row.toolCalls += 1; row.lastAt = Math.max(row.lastAt, call.at); dayOf(row, call.at).toolCalls += 1
      const source = toolSourceOf(call.name, toolSources, { sessionId: id, turn: call.turn, callId: call.callId })
      const key = JSON.stringify([call.name, source.kind, source.packageName, source.label, source.method, source.evidence])
      let tool = toolRows.get(key)
      if (!tool) { tool = { id: key, name: call.name, source, calls: 0, timedCalls: 0, durationMs: null, rawMs: null, waitMs: 0, avgMs: null, maxMs: null, lastAt: 0, sessionCount: 0, activity: [], slowest: null, _sessions: new Set() }; toolRows.set(key, tool) }
      const completed = finiteTime(call.endAt) && call.endAt <= now && call.durationMs !== null
      const stop = questionTiming.endOf(call)
      const waitMs = overlapMs(questionTiming.forCall(call), call.at, stop)
      const rawMs = completed ? call.endAt - call.at : null
      const durationMs = completed ? Math.max(0, stop - Math.max(range.start, call.at) - waitMs) : null
      const activity = { sessionId: id, sessionTitle: row.title, workspace: row.workspace, at: call.at, durationMs, rawMs, waitMs, status: completed ? call.status : 'pending', turn: call.turn, callId: call.callId }
      tool.calls += 1; tool.waitMs += waitMs; tool.lastAt = Math.max(tool.lastAt, call.at); tool._sessions.add(id)
      tool.activity.push(activity); tool.activity.sort((a, b) => b.at - a.at); if (tool.activity.length > 30) tool.activity.length = 30
      if (durationMs !== null) {
        tool.timedCalls += 1; tool.durationMs = (tool.durationMs ?? 0) + durationMs; tool.rawMs = (tool.rawMs ?? 0) + rawMs
        if (tool.slowest === null || durationMs > tool.maxMs) { tool.maxMs = durationMs; tool.slowest = activity }
      }
    }
  }
  const workspaces = new Map()
  for (const row of rows.values()) {
    row.cost = costOfRecords(row._records)
    row.models = [...row._models.values()].map(({ _records, ...model }) => ({ ...model, cost: costOfRecords(_records) })).sort((a, b) => b.cost - a.cost)
    row.days = [...row._days.values()].map(({ _records, ...day }) => ({ ...day, cost: costOfRecords(_records) })).sort((a, b) => a.key.localeCompare(b.key))
    const workspace = row._workspace
    const group = workspaces.get(workspace.id) ?? { ...workspace, ...usageBucket(), durationMs: null, wallMs: null, awaitingUserMs: null, completedTurns: 0, sessionCount: 0, sessionIds: [], toolCalls: 0, _records: [] }
    for (const record of row._records) group._records.push(record)
    for (const field of ['tokens', 'requests', 'turns', 'completedTurns', 'toolCalls']) group[field] += row[field]
    for (const field of ['durationMs', 'wallMs', 'awaitingUserMs']) if (row[field] !== null) group[field] = (group[field] ?? 0) + row[field]
    group.sessionCount += 1; group.sessionIds.push(row.id); workspaces.set(workspace.id, group)
    for (const field of ['_records', '_models', '_days', '_workspace']) delete row[field]
  }
  const tools = [...toolRows.values()].map(({ _sessions, ...tool }) => ({ ...tool, avgMs: tool.timedCalls ? tool.durationMs / tool.timedCalls : null, sessionCount: _sessions.size })).sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id))
  const resultSessions = [...rows.values()].sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id))
  const timedSessions = resultSessions.filter((row) => row.durationMs !== null).length
  const unknownSourceCalls = tools.filter((tool) => tool.source.kind === 'unknown').reduce((n, tool) => n + tool.calls, 0)
  const summary = { ...usageBucket(), cost: costOfRecords(selectedRecords), durationMs: null, wallMs: null, awaitingUserMs: null, completedTurns: 0, toolCalls: 0, timedSessions, sessionCount: rows.size, ledgerSessions: new Set(selectedRecords.map((record) => record.s)).size, thirdPartyCalls: 0, unknownSourceCalls }
  for (const row of resultSessions) {
    for (const field of ['tokens', 'requests', 'turns', 'completedTurns', 'toolCalls']) summary[field] += row[field]
    for (const field of ['durationMs', 'wallMs', 'awaitingUserMs']) if (row[field] !== null) summary[field] = (summary[field] ?? 0) + row[field]
  }
  summary.thirdPartyCalls = tools.filter((tool) => tool.source.kind === 'third-party').reduce((n, tool) => n + tool.calls, 0)
  const coverage = { timedSessions, sessionCount: rows.size, unknownSourceCalls, archiveSource, totalSessions: candidates.size, hiddenArchived: 0, hiddenInactive: 0, unknownArchive: 0, ...(inheritedRequests > 0 ? { inheritedRequests } : {}) }
  for (const id of candidates) {
    if (archivedOf(id) === null) coverage.unknownArchive += 1
    else if (scope === 'recent' && archivedOf(id)) coverage.hiddenArchived += 1
    else if (scope === 'recent' && !active.has(id)) coverage.hiddenInactive += 1
  }
  const finishBucket = ({ _records, ...bucket }) => ({ ...bucket, cost: costOfRecords(_records ?? []) })
  const teams = teamsOfReview(metas, rows, candidates)
  return { schema: 2, scope, generatedAt, timezone, range, summary, ledgerSummary, teams, hours: hours.map(finishBucket), weekHours: weekHours.map(finishBucket), sessions: resultSessions, workspaces: [...workspaces.values()].map(({ _records, ...group }) => ({ ...group, cost: round6(costOfRecords(_records)) })).sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id)), tools, coverage }
}
