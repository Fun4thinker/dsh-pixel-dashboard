/**
 * 自检脚本：不依赖 DSH 运行时，用假数据源验证时段判定、费用折算与日志聚合。
 *
 * 时段口径取自官方定价页：
 *   高峰 = 周一至周五 9:00–12:00、14:00–18:00（北京时间），其余为空闲。
 * 用法: node tools/test.mjs
 */
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DEFAULT_TIMEZONE,
  FALLBACK_RATES,
  MODEL_RATES,
  PEAK_WINDOWS,
  costOf,
  dateKey,
  isPeak,
  normalizeModel,
  periodState,
  pricingOf,
  ratesOf,
  zonedParts,
} from '../packages/plugin/lib/pricing.js'
import { UsageCatalog } from '../packages/plugin/lib/host.js'
import { UsageLedger, mergeRecords, parseLedger, recordOf, usageOfRecord } from '../packages/plugin/lib/ledger.js'

let passed = 0
/**
 * 断言包装：输出每条用例的结论。
 *
 * 必须 await 返回值——异步用例若不被等待，它的断言会在计数之后才执行，
 * 失败时既不算失败也不影响退出码，等于没测。
 * @param {string} name - 用例名。
 * @param {Function} fn - 用例体，可为 async。
 * @returns {Promise<void>}
 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
  }
}

/** 时间戳简写。2026-09-10 是周四。 */
const T = (iso) => Date.parse(iso)

console.log('pricing：高峰 / 空闲判定（北京时间）')

await check('工作日 8:59 是空闲、9:00 起是高峰', () => {
  assert.equal(isPeak(T('2026-09-10T00:59:00Z'), DEFAULT_TIMEZONE), false, '8:59 应为空闲')
  assert.equal(isPeak(T('2026-09-10T01:00:00Z'), DEFAULT_TIMEZONE), true, '9:00 应为高峰')
})

await check('12:00 结束上午高峰、14:00 开始下午高峰、18:00 结束', () => {
  assert.equal(isPeak(T('2026-09-10T03:59:00Z'), DEFAULT_TIMEZONE), true, '11:59 仍为高峰')
  assert.equal(isPeak(T('2026-09-10T04:00:00Z'), DEFAULT_TIMEZONE), false, '12:00 应为空闲')
  assert.equal(isPeak(T('2026-09-10T05:59:00Z'), DEFAULT_TIMEZONE), false, '13:59 应为空闲')
  assert.equal(isPeak(T('2026-09-10T06:00:00Z'), DEFAULT_TIMEZONE), true, '14:00 应为高峰')
  assert.equal(isPeak(T('2026-09-10T09:59:00Z'), DEFAULT_TIMEZONE), true, '17:59 仍为高峰')
  assert.equal(isPeak(T('2026-09-10T10:00:00Z'), DEFAULT_TIMEZONE), false, '18:00 应为空闲')
})

await check('周末全天都是空闲', () => {
  // 2026-09-12 周六、2026-09-13 周日
  for (const iso of ['2026-09-12T01:00:00Z', '2026-09-12T06:00:00Z', '2026-09-13T03:00:00Z']) {
    assert.equal(isPeak(T(iso), DEFAULT_TIMEZONE), false, `${iso} 应为空闲`)
  }
})

await check('凌晨与深夜都是空闲（此前把 00:30–08:30 当优惠窗口是错的）', () => {
  assert.equal(isPeak(T('2026-09-09T17:00:00Z'), DEFAULT_TIMEZONE), false, '北京 01:00 应为空闲')
  assert.equal(isPeak(T('2026-09-10T15:00:00Z'), DEFAULT_TIMEZONE), false, '北京 23:00 应为空闲')
})

await check('窗口表与官方一致', () => {
  assert.deepEqual(PEAK_WINDOWS, [
    { startMinute: 540, endMinute: 720 },
    { startMinute: 840, endMinute: 1080 },
  ])
})

console.log('pricing：下一次时段切换')

await check('高峰中给出距结束时间', () => {
  // 北京 11:00 → 距 12:00 还有 60 分钟
  const state = periodState(T('2026-09-10T03:00:00Z'), DEFAULT_TIMEZONE)
  assert.equal(state.peak, true)
  assert.equal(Math.round(state.nextChangeMs / 60_000), 60)
})

await check('午休空闲中给出距下午高峰开始时间', () => {
  // 北京 12:30 → 距 14:00 还有 90 分钟
  const state = periodState(T('2026-09-10T04:30:00Z'), DEFAULT_TIMEZONE)
  assert.equal(state.peak, false)
  assert.equal(Math.round(state.nextChangeMs / 60_000), 90)
})

await check('周五下班后一直空闲到周一 9:00', () => {
  // 2026-09-11 周五 18:30（北京）→ 下一次高峰是周一 9:00
  const state = periodState(T('2026-09-11T10:30:00Z'), DEFAULT_TIMEZONE)
  assert.equal(state.peak, false)
  assert.equal(state.nextPeak, true)
  const parts = zonedParts(T('2026-09-11T10:30:00Z') + state.nextChangeMs, DEFAULT_TIMEZONE)
  assert.equal(parts.weekday, 1, '应落在周一')
  assert.equal(parts.hour, 9, '应在 9 点')
})

console.log('pricing：价目与折算')

await check('模型名归一：旧名折叠到 flash', () => {
  assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-chat'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-reasoner'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-v4-pro'), 'deepseek-v4-pro')
})

await check('flash 单价与官方一致', () => {
  const rates = ratesOf('deepseek-flash')
  assert.deepEqual(rates.cacheHit, { peak: 0.04, idle: 0.02 })
  assert.deepEqual(rates.cacheMiss, { peak: 2, idle: 1 })
  assert.deepEqual(rates.output, { peak: 8, idle: 4 })
})

await check('v4-pro 单价与官方一致', () => {
  const rates = ratesOf('deepseek-v4-pro')
  assert.deepEqual(rates.cacheHit, { peak: 0.3, idle: 0.15 })
  assert.deepEqual(rates.cacheMiss, { peak: 9, idle: 4.5 })
  assert.deepEqual(rates.output, { peak: 27, idle: 13.5 })
})

await check('DeepSeek 分时价：空闲恰为高峰价的一半', () => {
  // 「空闲价 = 高峰价的一半」是 **DeepSeek 的分时规则**，不是所有厂商的通用规则：
  // 智谱 GLM 等按量定价不分时（peak === idle）。因此这里只对 flat !== true 的条目断言。
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (rates.flat === true) continue
    for (const field of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(rates[field].idle * 2, rates[field].peak, `${key}.${field} 不满足半价关系`)
    }
  }
})

await check('不分时的厂商单价：peak 与 idle 相同', () => {
  let checked = 0
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (rates.flat !== true) continue
    checked += 1
    for (const field of ['cacheHit', 'cacheMiss', 'output']) {
      // 写两个相同的数是为了复用同一套聚合逻辑；若哪天不相等，说明 flat 标错了
      assert.equal(rates[field].idle, rates[field].peak, `${key}.${field} 标了 flat 但两档不等`)
    }
  }
  assert.ok(checked > 0, '应至少有一个不分时的厂商条目（否则这条断言形同虚设）')
})

await check('智谱 GLM 单价与官方一致（元 / 百万 token）', () => {
  const glm = ratesOf('glm-5.3')
  assert.deepEqual(glm.cacheMiss, { peak: 8, idle: 8 }, 'GLM-5.3 输入应为 8')
  assert.deepEqual(glm.output, { peak: 28, idle: 28 }, 'GLM-5.3 输出应为 28')
  assert.deepEqual(glm.cacheHit, { peak: 2, idle: 2 }, 'GLM-5.3 缓存命中应为 2')
  const flash = ratesOf('glm-5.3-flash')
  assert.deepEqual(flash.cacheMiss, { peak: 0.8, idle: 0.8 }, 'GLM-5.3-Flash 输入应为 0.8')
  assert.deepEqual(flash.output, { peak: 2.8, idle: 2.8 }, 'GLM-5.3-Flash 输出应为 2.8')
  // 智谱历史模型按官方说明自动折叠到现行模型
  assert.equal(normalizeModel('glm-5.1'), 'glm-5.3', 'GLM-5.1 应折到 GLM-5.3')
  assert.equal(normalizeModel('glm-4.7'), 'glm-5.3-flash', 'GLM-4.7 应折到 GLM-5.3-Flash')
})

await check('DSH 实际模型名折到 flash（否则会被标成估算价）', () => {
  // 本机账本里有近 2000 条 deepseek-v4.1-flash：不折叠就会走兜底并被标成「估算价」
  assert.equal(normalizeModel('deepseek-v4.1-flash'), 'deepseek-flash')
  assert.equal(pricingOf('deepseek-v4.1-flash').known, true, '折叠后应被认作已知价')
  assert.equal(pricingOf('glm-5.3').known, true, 'GLM-5.3 应被认作已知价')
})

await check('未知模型被标成「价不知道」而不是假装官方价', () => {
  const unknown = pricingOf('some-future-model-xyz')
  assert.equal(unknown.known, false, '未知模型必须标记 known=false')
  assert.equal(unknown.rates, FALLBACK_RATES, '未知模型应兜底到 Flash 单价')
  // 分档定价的模型（官方按输入长度分档）只取最低档，并标出来
  assert.equal(pricingOf('glm-4.6v').tiered, true, 'GLM-4.6V 应标记为分档定价')
})

await check('同一份用量高峰计价是空闲的两倍', () => {
  const usage = { cacheHit: 2_000_000, cacheMiss: 1_000_000, output: 500_000 }
  const rates = ratesOf('deepseek-flash')
  // 空闲：2×0.02 + 1×1 + 0.5×4 = 0.04 + 1 + 2 = 3.04
  assert.equal(Number(costOf(usage, rates, 'idle').toFixed(6)), 3.04)
  assert.equal(Number(costOf(usage, rates, 'peak').toFixed(6)), 6.08)
})

console.log('pricing：时区归日')

await check('站点时区日期键与 UTC 不同（跨日边界）', () => {
  assert.equal(dateKey(T('2026-09-10T17:00:00Z'), DEFAULT_TIMEZONE), '2026-09-11')
  assert.equal(zonedParts(T('2026-09-10T17:00:00Z'), DEFAULT_TIMEZONE).hour, 1)
})

console.log('aggregation：会话日志聚合')

/** 造一条带用量的 assistant/message。 */
function message(seq, time, model, tokens) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: seq,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model } },
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        totalTokens: tokens.input + tokens.output,
        cacheReadTokens: tokens.cacheRead ?? 0,
        cacheWriteTokens: tokens.cacheWrite ?? 0,
        reasoningTokens: tokens.reasoning ?? 0,
      },
    },
  }
}

const now = T('2026-09-10T04:00:00Z') // 周四 12:00 北京 → 空闲
// 高峰样本：周四 10:00 / 10:30 北京（= 02:00Z / 02:30Z）
// 空闲样本：周四 12:30 / 12:40 北京（= 04:30Z / 04:40Z）
const logA = [
  { type: 'turn/start', seq: 0, time: T('2026-09-10T02:00:00Z') },
  message(1, T('2026-09-10T02:00:00Z'), 'deepseek-flash', { input: 1000, output: 200, cacheRead: 800 }),
  message(2, T('2026-09-10T04:30:00Z'), 'deepseek-flash', { input: 2000, output: 400, cacheRead: 1500, cacheWrite: 100 }),
  { type: 'turn/start', seq: 3, time: T('2026-09-10T04:30:00Z') },
  message(4, T('2026-09-10T04:40:00Z'), 'deepseek-reasoner', { input: 500, output: 900, reasoning: 300 }),
]
const logB = [message(0, T('2026-09-10T02:30:00Z'), 'deepseek-chat', { input: 300, output: 100 })]

/** 假 persistence：复刻 list / stat / open 的最小语义。 */
function fakePersistence(sessions) {
  return {
    async list() {
      return Object.entries(sessions).map(([id, events]) => ({
        header: { id, createdAt: events[0]?.time ?? now, cwd: 'D:\\blog' },
        revision: String(events.length),
        eventCount: events.length,
      }))
    },
    async open(id) {
      return {
        async read(offset = 0, length = 500) {
          return { events: (sessions[id] ?? []).slice(offset, offset + length) }
        },
        async close() {},
      }
    },
  }
}

/**
 * 每个用例组用独立的账本文件。
 * 共用一份会让先跑的用例把记录留在账本里，后面的断言就被污染
 * （曾如此：会话费用断言突然变成 0，因为峰值记录来自别的用例）。
 * @param {string} tag - 用途标签。
 * @returns {string} 临时账本路径。
 */
const ledgerFor = (tag) => join(tmpdir(), `dsh-pixel-test-${tag}-${process.pid}.jsonl`)

const catalog = new UsageCatalog({
  persistence: () => fakePersistence({ a: logA, b: logB }),
  sessions: () => undefined,
  timezone: () => DEFAULT_TIMEZONE,
  ledgerPath: ledgerFor('aggregate'),
})

const data = await catalog.read()

await check('累计用量把缓存命中/未命中/输出分开统计', () => {
  // 命中 800+1500=2300；未命中 (1000-800)+(2000-1500-100)+500+300=1400；输出 1600
  assert.equal(data.overview.totals.cacheHit, 2300)
  assert.equal(data.overview.totals.cacheMiss, 1400)
  assert.equal(data.overview.totals.cacheWrite, 100)
  assert.equal(data.overview.totals.output, 1600)
  assert.equal(data.overview.totals.local, 2300 + 1400 + 100 + 1600)
})

await check('每条请求按发生时刻分入高峰 / 空闲档', () => {
  const totals = data.overview.totals
  // 高峰：第 1 条（周四 10:00）+ logB（周四 10:30）
  assert.equal(totals.peak.cacheHit, 800)
  assert.equal(totals.peak.cacheMiss, 500)
  assert.equal(totals.peak.output, 300)
  assert.equal(totals.peak.requests, 2)
  // 空闲：第 2、4 条
  assert.equal(totals.idle.cacheHit, 1500)
  assert.equal(totals.idle.cacheMiss, 900)
  assert.equal(totals.idle.output, 1300)
  assert.equal(totals.idle.requests, 2)
  // 分档之和必须等于总量
  assert.equal(totals.peak.cacheHit + totals.idle.cacheHit, totals.cacheHit)
  assert.equal(totals.peak.cacheMiss + totals.idle.cacheMiss, totals.cacheMiss)
  assert.equal(totals.peak.output + totals.idle.output, totals.output)
})

await check('旧模型名被折叠到现行模型（deepseek-chat → flash）', () => {
  assert.deepEqual([...new Set(data.models.map((row) => row.model))].sort(), ['deepseek-flash'])
})

await check('费用按分档单价折算，不是整段套一个折扣', () => {
  const model = data.models[0]
  const rates = ratesOf(model.model)
  const expected = costOf(model.totals.peak, rates, 'peak') + costOf(model.totals.idle, rates, 'idle')
  assert.equal(Number(model.cost.standard.toFixed(6)), Number(expected.toFixed(6)))
  assert.ok(model.cost.standard > 0)
})

await check('汇总给出标准价与「全走空闲」对比', () => {
  assert.ok(data.cost.standard > 0)
  assert.ok(data.cost.ifAllIdle <= data.cost.standard, '全空闲不应更贵')
  assert.equal(Number(data.cost.saved.toFixed(6)), Number((data.cost.standard - data.cost.ifAllIdle).toFixed(6)))
})

await check('时段状态随站点时区返回，并带上官方口径说明', () => {
  assert.equal(data.period.peak, false, '周四 12:00 北京应为空闲')
  assert.equal(data.peakRule.windows.length, 2)
  assert.ok(data.peakRule.note.includes('周一至周五'))
  assert.ok(data.pricing.source.includes('api-docs.deepseek.com'))
})

await check('按站点时区归日，跨日不错位', () => {
  assert.deepEqual(data.days.map((row) => row.key), ['2026-09-10'])
})

await check('热力图把请求落到正确的日/小时格', () => {
  const dayIndex = Math.round(
    (Date.parse(`${data.days.at(-1).key}T00:00:00Z`) - Date.parse(`${data.heatmap.firstDay}T00:00:00Z`)) / 86_400_000,
  )
  assert.equal(data.heatmap.cells[dayIndex * 24 + 10], 2, '北京 10 点应有 2 次')
  assert.equal(data.heatmap.cells[dayIndex * 24 + 12], 2, '北京 12 点应有 2 次')
})

await check('会话清单带上轮次与工作区名', () => {
  assert.equal(data.sessions.length, 2)
  assert.equal(data.sessions.find((row) => row.id === 'a').turns, 2)
  assert.equal(data.sessions.find((row) => row.id === 'a').workspace, 'blog')
})

await check('每个会话都带费用摘要（供输入框下方费用条使用）', () => {
  for (const session of data.sessions) {
    assert.ok(session.cost !== undefined, `${session.id} 缺少 cost`)
    assert.equal(typeof session.cost.standard, 'number')
    assert.equal(typeof session.cost.peak, 'number')
    assert.equal(typeof session.cost.idle, 'number')
    // 两档金额之和必须等于总额，否则费用条与看板会互相矛盾
    assert.equal(
      Number((session.cost.peak + session.cost.idle).toFixed(6)),
      Number(session.cost.standard.toFixed(6)),
      `${session.id} 的分档金额之和对不上总额`,
    )
  }
})

await check('会话费用按分档口径算出，与模型单价一致', () => {
  // a 会话：1 条高峰（周四 10:00）+ 2 条空闲（12:30 / 12:40）
  const sessionA = data.sessions.find((row) => row.id === 'a')
  const rates = ratesOf('deepseek-flash')
  const expectedPeak = costOf({ cacheHit: 800, cacheMiss: 200, output: 200 }, rates, 'peak')
  const expectedIdle = costOf({ cacheHit: 1500, cacheMiss: 900, output: 1300 }, rates, 'idle')
  assert.equal(Number(sessionA.cost.peak.toFixed(6)), Number(expectedPeak.toFixed(6)))
  assert.equal(Number(sessionA.cost.idle.toFixed(6)), Number(expectedIdle.toFixed(6)))
})

await check('落在高峰时段的会话只累计高峰金额', () => {
  // b 会话唯一一条在周四 10:30（北京），属高峰，因此空闲金额应为 0
  const sessionB = data.sessions.find((row) => row.id === 'b')
  assert.equal(sessionB.cost.idle, 0)
  assert.ok(sessionB.cost.peak > 0)
})

await check('缺失 persistence 时退化为空数据而不抛错', async () => {
  const empty = new UsageCatalog({
    persistence: () => undefined,
    sessions: () => undefined,
    timezone: () => DEFAULT_TIMEZONE,
    ledgerPath: join(tmpdir(), 'dsh-pixel-test-empty.jsonl'),
  })
  const result = await empty.read()
  assert.equal(result.overview.sessions, 0)
  assert.equal(result.days.length, 0)
})

console.log('ledger：本机用量账本')

/** 造一条带用量的会话事件。 */
const ledgerEvent = (seq, time, model, u) => ({
  type: 'assistant/message',
  seq,
  time,
  data: {
    usage: u,
    message: { source: { model } },
  },
})

const ledgerPath = join(tmpdir(), `dsh-pixel-ledger-${process.pid}.jsonl`)
rmSync(ledgerPath, { force: true })

await check('记录里模型名已归一，旧名不会绕过价目表', () => {
  const record = recordOf('s1', ledgerEvent(1, 1000, 'deepseek-chat', { inputTokens: 10, outputTokens: 1 }))
  assert.equal(record.m, 'deepseek-flash')
  assert.equal(recordOf('s1', ledgerEvent(2, 1000, 'deepseek-reasoner', { inputTokens: 1, outputTokens: 1 })).m, 'deepseek-flash')
})

await check('缓存未命中由 input 反推，不把命中算成未命中', () => {
  const record = recordOf('s1', ledgerEvent(1, 1000, 'deepseek-flash', {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
  }))
  const usage = usageOfRecord(record)
  assert.equal(usage.cacheHit, 800)
  assert.equal(usage.cacheWrite, 50)
  assert.equal(usage.cacheMiss, 150, '1000 - 800 - 50')
  // 计费量 = 未命中 150 + 命中 800 + 写入 50 + 输出 100
  assert.equal(usage.local, 1100)
})

await check('非用量事件不产生记录', () => {
  assert.equal(recordOf('s1', { type: 'turn/start', seq: 1, time: 1 }), undefined)
  assert.equal(recordOf('s1', { type: 'assistant/message', seq: 1, time: 1, data: {} }), undefined)
  // 缺 seq / time 的记录无法做幂等键，必须丢弃
  assert.equal(recordOf('s1', { type: 'assistant/message', time: 1, data: { usage: {} } }), undefined)
})

await check('同一记录重复合并只保留一份（幂等）', () => {
  const a = recordOf('s1', ledgerEvent(1, 1000, 'deepseek-flash', { inputTokens: 10, outputTokens: 1 }))
  const withDup = mergeRecords([a], [a])
  assert.equal(withDup.merged.length, 1)
  assert.equal(withDup.added, 0)
})

await check('两台机器的记录合并成一份历史', () => {
  const local = recordOf('s1', ledgerEvent(1, 1000, 'deepseek-flash', { inputTokens: 10, outputTokens: 1 }))
  const other = recordOf('s2', ledgerEvent(1, 2000, 'deepseek-flash', { inputTokens: 20, outputTokens: 2 }))
  const merged = mergeRecords([local], [other])
  assert.equal(merged.merged.length, 2)
  assert.equal(merged.added, 1)
  // 按时间排序，云端多机追加后顺序会乱，排序后便于人工查看
  assert.deepEqual(merged.merged.map((r) => r.t), [1000, 2000])
})

await check('坏行跳过而不是整份作废', () => {
  const text = '{"k":"a:1","t":1,"m":"x"}\n这不是 JSON\n\n{"k":"b:1","t":2,"m":"y"}\n'
  const { records, badLines } = parseLedger(text)
  assert.equal(records.length, 2)
  assert.equal(badLines, 1)
})

await check('账本落盘后可重读，且重复导入不增长', async () => {
  const ledger = new UsageLedger(ledgerPath)
  const batch = [
    recordOf('s1', ledgerEvent(1, 1000, 'deepseek-flash', { inputTokens: 10, outputTokens: 1 })),
    recordOf('s1', ledgerEvent(2, 1100, 'deepseek-flash', { inputTokens: 20, outputTokens: 2 })),
  ]
  const first = await ledger.merge(batch)
  assert.equal(first.added, 2)
  const again = await ledger.merge(batch)
  assert.equal(again.added, 0, '重复导入不应新增')
  assert.equal(again.total, 2)
  // 换一个实例重读，模拟下次启动
  const reopened = new UsageLedger(ledgerPath)
  await reopened.load()
  assert.equal(reopened.size, 2, '落盘内容应能重读')
})

await check('账本不存在时视为空账本而不是报错', async () => {
  const missing = new UsageLedger(join(tmpdir(), 'dsh-pixel-definitely-missing.jsonl'))
  const info = await missing.load()
  assert.equal(info.records, 0)
  assert.equal(missing.lastError, undefined)
})

console.log('ledger：合并与历史保留')

await check('把账本拷到另一台机器后，两边记录合并成一份历史', async () => {
  const otherPath = join(tmpdir(), `dsh-pixel-copied-${process.pid}.jsonl`)
  rmSync(otherPath, { force: true })
  // 模拟「从另一台机器带过来的账本」：里面有一条本机没有的记录
  const carried = new UsageLedger(otherPath)
  await carried.merge([recordOf('copied-session', ledgerEvent(1, T('2026-09-10T02:00:00Z'), 'deepseek-flash', {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
  }))])

  // 本机没有任何会话日志，只靠这份账本
  const catalog = new UsageCatalog({
    persistence: () => undefined,
    sessions: () => undefined,
    timezone: () => DEFAULT_TIMEZONE,
    ledgerPath: otherPath,
  })
  const result = await catalog.read()
  assert.equal(result.ledger.enabled, true)
  assert.equal(result.ledger.total, 1)
  assert.equal(result.overview.totals.output, 100_000, '账本里的历史用量应计入')
  assert.equal(result.overview.sessions, 1, '只存在于账本的会话也要出现在清单里')
  assert.equal(result.sessions[0].workspace, '(其它设备)')

  // 再读一次不该翻倍：这是「重复扫描/重复安装不丢也不多」的保证
  const again = await catalog.read()
  assert.equal(again.ledger.total, 1, '重复读取不应让记录翻倍')
  rmSync(otherPath, { force: true })
  rmSync(ledgerPath, { force: true })
})

console.log(`\n${passed} 项检查通过${process.exitCode === 1 ? '（另有失败项）' : ''}`)
