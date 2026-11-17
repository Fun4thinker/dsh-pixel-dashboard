/** Scalar interval helpers shared by review and the legacy step diagnostics.
 * ask_user_question has no finer persisted answer boundary: its call→result span is
 * an estimate of human waiting, not machine work. Ordinary tools remain execution.
 */
export function unionRanges(ranges) {
  const sorted = ranges.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).map(([a, b]) => [a, b]).sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [a, b] of sorted) {
    const tail = merged.at(-1)
    if (tail && a <= tail[1]) tail[1] = Math.max(tail[1], b)
    else merged.push([a, b])
  }
  return merged
}
/** Intersect already unioned/sorted ranges, without re-sorting a session per step. */
export function clipRanges(ranges, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  let low = 0, high = ranges.length
  while (low < high) { const mid = (low + high) >>> 1; if (ranges[mid][1] <= start) low = mid + 1; else high = mid }
  const result = []
  for (let i = low; i < ranges.length && ranges[i][0] < end; i += 1) result.push([Math.max(start, ranges[i][0]), Math.min(end, ranges[i][1])])
  return result
}
export function overlapMs(ranges, start, end) {
  return clipRanges(ranges, start, end).reduce((sum, [a, b]) => sum + b - a, 0)
}
export function subtractRanges(ranges, exclusions) {
  if (ranges.length === 0) return []
  const cuts = unionRanges(exclusions), result = []
  for (const [start, end] of unionRanges(ranges)) {
    let cursor = start
    for (const [a, b] of cuts) {
      if (b <= cursor) continue
      if (a >= end) break
      if (a > cursor) result.push([cursor, Math.min(a, end)])
      cursor = Math.max(cursor, b)
      if (cursor >= end) break
    }
    if (cursor < end) result.push([cursor, end])
  }
  return result
}
export const isUserWaitTool = (name) => name === 'ask_user_question'

/** Distinguish ask ancestors (PTC pipelines) from independently running siblings.
 * Known ordinary leaf execution remains machine work even while another call asks
 * the human. Only asks themselves and their recorded ancestors lose tool duration.
 */
export function questionWaitProjection(calls, turnEnds, now) {
  const byKey = new Map(calls.map((call) => [`${call.nested ? 'ptc' : 'call'}:${call.callId}`, call]))
  const endOf = (call) => {
    const end = turnEnds.get(call.turn)
    return Math.min(now, Number.isFinite(call.endAt) ? call.endAt : now, Number.isFinite(end) ? end : now)
  }
  const askRanges = new Map(), ancestors = new Map()
  for (const ask of calls.filter((call) => isUserWaitTool(call.name))) {
    const range = [ask.at, endOf(ask)]
    askRanges.set(ask, [range])
    const visited = new Set([ask])
    let child = ask
    while (child.nested) {
      const parent = byKey.get(`ptc:${child.parentCallId}`) ?? byKey.get(`call:${child.parentCallId}`) ?? byKey.get(`call:${child.rootCallId}`)
      if (!parent || visited.has(parent)) break
      visited.add(parent)
      if (!ancestors.has(parent)) ancestors.set(parent, [])
      ancestors.get(parent).push(range)
      child = parent
    }
  }
  if (askRanges.size === 0) return { waits: [], forCall: () => [], endOf }
  const machine = unionRanges(calls.filter((call) => !isUserWaitTool(call.name)).flatMap((call) => subtractRanges([[call.at, endOf(call)]], ancestors.get(call) ?? [])))
  const waits = subtractRanges([...askRanges.values()].flat(), machine)
  const callWaits = new Map(askRanges)
  for (const [call, ranges] of ancestors) if (!callWaits.has(call)) callWaits.set(call, subtractRanges(ranges, machine))
  return { waits, forCall: (call) => callWaits.get(call) ?? [], endOf }
}
export const toolResultId = (data) => String(data?.message?.source?.callId ?? data?.message?.toolCallId ?? data?.callId ?? data?.id ?? '')

/** Read only clocks and emptiness flags from durable stream records; never retain text/arguments.
 * Official dt values reconstruct cumulatively. Clock rollback is representable by DSH,
 * but cannot establish a trustworthy elapsed duration, so it stays unavailable here.
 */
function streamClock(stream, start, end) {
  if (!Array.isArray(stream)) return null
  let first = null, last = null, previous = start
  const safeTime = (value) => Number.isSafeInteger(value) && value >= start && value <= end
  const accept = (time, output) => {
    if (!safeTime(time) || time < previous) return false
    previous = time
    if (output) { if (first === null) first = time; last = time }
    return true
  }
  for (const record of stream) {
    if (!record || typeof record !== 'object') return null
    if (record.type === 'chunk') {
      const chunk = record.chunk
      if (!chunk || typeof chunk !== 'object') return null
      if (['text-delta', 'reasoning-delta'].includes(chunk.type) && typeof chunk.text !== 'string') return null
      if (chunk.type === 'tool-call-delta' && (typeof chunk.argumentsDelta !== 'string'
        || chunk.name !== undefined && typeof chunk.name !== 'string')) return null
      const output = ['text-delta', 'reasoning-delta'].includes(chunk.type)
        ? typeof chunk.text === 'string' && chunk.text !== ''
        : chunk.type === 'tool-call-delta' && (typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '' || typeof chunk.name === 'string')
      if (!accept(record.time, output)) return null
      continue
    }
    const packed = ['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)
    if (!packed) return null
    if (record.type === 'tool-call-chunks' && record.name !== undefined && typeof record.name !== 'string') return null
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    if (!Array.isArray(members) || !Array.isArray(record.dt) || members.length === 0
      || record.dt.length !== members.length - 1 || !safeTime(record.time0)) return null
    let time = record.time0
    for (let index = 0; index < members.length; index += 1) {
      if (typeof members[index] !== 'string') return null
      if (index > 0) {
        const delta = record.dt[index - 1]
        if (!Number.isSafeInteger(delta) || delta < 0 || !Number.isSafeInteger(time + delta)) return null
        time += delta
      }
      if (!accept(time, members[index] !== '' || record.type === 'tool-call-chunks' && record.name !== undefined)) return null
    }
  }
  return { first, last }
}

/** Step diagnostics exclude human waits from every machine component.
 * Legacy ttftMs is step start→complete assistant message (includes generation), not TTFT.
 * Legacy genMs is the remaining non-tool step processing, not streamed generation.
 * modelMs/otherMs expose those same values honestly; completed ranges retain no bodies.
 * Ordinary parallel tool costs remain per-call; other processing subtracts their union.
 */
export class TimingBreakdown {
  constructor() {
    this.steps = []
    this.current = null
    this.calls = new Map()
    this.turnEnds = new Map()
    this.lastAt = 0
  }
  get seen() { return this.steps.length > 0 }
  observe(event) {
    const at = event?.time
    if (!Number.isFinite(at) || at < 0) return
    this.lastAt = Math.max(this.lastAt, at)
    const data = event.data ?? {}
    switch (event.type) {
      case 'step/start': this.current = { start: at, first: null, turn: data.turn, step: data.step, calls: [], responses: [] }; break
      case 'assistant/message':
      case 'assistant/attempt': {
        const step = this.current
        if (!step || at < step.start || data.turn !== undefined && step.turn !== undefined && data.turn !== step.turn
          || data.step !== undefined && step.step !== undefined && data.step !== step.step) break
        if (event.type === 'assistant/message' && step.first === null) step.first = at
        step.responses.push({ at, complete: event.type === 'assistant/message', clock: streamClock(data.stream, step.start, at) })
        break
      }
      case 'tool/call':
      case 'tool/ptc-dispatch-start': {
        const nested = event.type === 'tool/ptc-dispatch-start'
        const id = String(nested ? data.subCallId ?? '' : data.callId ?? data.id ?? '')
        const key = `${nested ? 'ptc' : 'call'}:${id}`
        if (id && !this.calls.has(key)) {
          const call = { at, endAt: null, callId: id, name: String(data.name ?? ''), nested, rootCallId: data.rootCallId, parentCallId: data.parentCallId, turn: data.turn ?? this.calls.get(`call:${data.rootCallId}`)?.turn ?? this.current?.turn }
          this.calls.set(key, call)
          // Root calls account for machine tool time; nested dispatches only provide
          // additional wait evidence, avoiding double-counting the root pipeline.
          if (!nested && this.current) this.current.calls.push(call)
        }
        break
      }
      case 'tool/result':
      case 'tool/ptc-dispatch': {
        const nested = event.type === 'tool/ptc-dispatch'
        const call = this.calls.get(`${nested ? 'ptc' : 'call'}:${nested ? data.subCallId : toolResultId(data)}`)
        if (call && call.endAt === null) call.endAt = Math.max(call.at, at)
        break
      }
      case 'step/end':
        if (this.current && (data.turn !== undefined && this.current.turn !== undefined && data.turn !== this.current.turn
          || data.step !== undefined && this.current.step !== undefined && data.step !== this.current.step)) break
        if (this.current) this.steps.push({ ...this.current, end: at })
        this.current = null
        break
      case 'turn/end': this.turnEnds.set(data.turn, at); break
    }
  }
  toJSON(now = this.lastAt) {
    const calls = [...this.calls.values()]
    const { waits, forCall, endOf } = questionWaitProjection(calls, this.turnEnds, now)
    let ttftMs = 0, genMs = 0, toolsMs = 0, wallMs = 0, awaitingUserMs = 0
    let firstOutputWaitMs = 0, streamedMs = 0, responseSteps = 0, streamedSteps = 0, firstOutputSteps = 0
    for (const step of this.steps) {
      const end = Math.min(now, step.end)
      if (end < step.start) continue
      const responses = step.responses.filter((response) => response.at <= end)
      if (step.end <= now && responses.some((response) => response.complete)) {
        responseSteps += 1
        let uncertainEarlier = false
        for (const response of responses) {
          if (response.clock === null) { uncertainEarlier = true; continue }
          if (response.clock.first === null) continue
          if (!uncertainEarlier) {
            firstOutputWaitMs += response.clock.first - step.start - overlapMs(waits, step.start, response.clock.first)
            firstOutputSteps += 1
          }
          break
        }
        const intervals = unionRanges(responses.filter((response) => response.clock && response.clock.first !== null && response.clock.last > response.clock.first)
          .map((response) => [response.clock.first, response.clock.last]))
        if (intervals.length) {
          streamedSteps += 1
          streamedMs += overlapMs(subtractRanges(intervals, waits), step.start, end)
        }
      }
      wallMs += end - step.start
      awaitingUserMs += overlapMs(waits, step.start, end)
      if (step.first !== null) {
        const first = Math.min(end, Math.max(step.start, step.first))
        ttftMs += first - step.start - overlapMs(waits, step.start, first)
        const tools = step.calls.map((call) => [call.at, endOf(call)])
        genMs += end - first - overlapMs(unionRanges([...tools, ...clipRanges(waits, first, end)]), first, end)
      }
      for (const call of step.calls) {
        const start = Math.max(step.start, call.at)
        const stop = Math.min(end, endOf(call))
        if (stop >= start) toolsMs += stop - start - overlapMs(forCall(call), start, stop)
      }
    }
    return { ttftMs: Math.round(ttftMs), genMs: Math.round(genMs), modelMs: Math.round(ttftMs), otherMs: Math.round(genMs), firstOutputWaitMs: firstOutputSteps ? Math.round(firstOutputWaitMs) : null, streamedMs: streamedSteps ? Math.round(streamedMs) : null, responseSteps, streamedSteps, firstOutputSteps, toolsMs: Math.round(toolsMs), steps: this.steps.length, totalMs: Math.round(ttftMs + genMs + toolsMs), wallMs, awaitingUserMs }
  }
}
