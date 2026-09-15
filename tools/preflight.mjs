/**
 * 预检脚本：用假的 Cordis 上下文加载宿主半边，验证插件形状、路由注册与数据返回。
 * 这样不必重启正在运行的 dsh 就能发现 apply 里的问题。
 *
 * 全程隔离：账本路径指向临时文件（见下方环境变量），因此不会读取也不会污染
 * 你本机真实的用量账本——否则「空数据源」其实带着真实历史，断言会莫名其妙地失败。
 * 用法: node tools/preflight.mjs
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 校验构建产物：源码树里的版本号还是占位符，只有产物才代表真正部署的东西。 */
const built = join(root, 'lib', 'host.js')
if (!existsSync(built)) {
  console.error(`找不到构建产物 ${built}；先运行 node tools/build-deploy.mjs`)
  process.exit(1)
}

// 必须在 import 宿主模块之前设置：宿主在构造聚合器时就会解析账本路径
const sandboxLedger = join(tmpdir(), `dsh-pixel-preflight-${process.pid}.jsonl`)
rmSync(sandboxLedger, { force: true })
process.env.DSH_PIXEL_LEDGER = sandboxLedger
process.env.DSH_PIXEL_MACHINE = 'preflight'
// 余额开关也要隔离：否则下面测开关时会写到你本机真实的 balance-prefs.json
const sandboxPrefs = join(tmpdir(), `dsh-pixel-preflight-prefs-${process.pid}.json`)
rmSync(sandboxPrefs, { force: true })
process.env.DSH_PIXEL_BALANCE_PREFS = sandboxPrefs
// 明确要求「能查」：若环境里恰好设了 DSH_PIXEL_BALANCE=0，开关闸门会被锁死
delete process.env.DSH_PIXEL_BALANCE
delete process.env.DSH_PIXEL_PLANS
// 自动发现那一路也要隔离：否则本机若真的装了 Command Code，
// 「未配 Key」的断言会因为你自己的凭据而失败（假数据源带着真实凭据）。
delete process.env.COMMAND_CODE_API_KEY
delete process.env.ZHIPU_CODING_API_KEY
process.env.COMMANDCODE_HOME = join(tmpdir(), `dsh-pixel-cc-home-${process.pid}`)

const mod = await import(pathToFileURL(built).href)
const plugin = mod.default
assert.ok(plugin !== undefined, '宿主半边必须默认导出插件对象')
assert.equal(typeof plugin.apply, 'function', '插件对象需要 apply')
assert.deepEqual(
  plugin.inject,
  ['webServer'],
  "必须声明 inject: ['webServer']；实测 apply 执行时 webServer 可能尚未发布，自行判空返回会让整行静默不激活",
)

/** 记录注册结果的最小 webServer 替身。 */
const routes = []
/** 记录 ctx.on 注册的监听器，供下面驱动 `session/event` 用。 */
const hostListeners = new Map()
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
    return undefined
  },
  on(event, handler) {
    const list = hostListeners.get(event) ?? []
    list.push(handler)
    hostListeners.set(event, list)
  },
}
// apply 通过 ctx.webServer 访问已声明注入的服务；替身提供同名属性。
ctx.webServer = ctx.get('webServer')

plugin.apply(ctx)

/** 按路径找已注册路由。 */
const routeOf = (path) => {
  const route = routes.find((item) => item.path === path)
  assert.ok(route !== undefined, `缺少路由 ${path}`)
  assert.equal(route.kind, 'exact', `${path} 应为精确匹配`)
  return route
}

const dataRoute = routeOf('/dsh-pixel/data')
const versionRoute = routeOf('/dsh-pixel/version')
const periodRoute = routeOf('/dsh-pixel/period')
const balanceRoute = routeOf('/dsh-pixel/balance')
const plansRoute = routeOf('/dsh-pixel/plans')
const toggleRoute = routeOf('/dsh-pixel/toggle')
const notifyRoute = routeOf('/dsh-pixel/notify')
assert.equal(routes.length, 7, `应注册恰好七条路由，实际 ${routes.length}`)

/**
 * 最小 req/res 替身。
 * req 实现了 data/end/on，因此需要读体的路由（余额开关）也能被驱动。
 * @param {object} route - 已注册路由。
 * @param {string} [method] - HTTP 方法。
 * @param {string} [url] - 请求地址。
 * @param {object} [body] - 要 POST 的 JSON 体。
 * @param {object} [headers] - 额外请求头。
 * @returns {Promise<{statusCode:number,headers:object,body:string|undefined}>} 响应。
 */
function call(route, method = 'GET', url = route.path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(chunk) { resolve({ statusCode: this.statusCode, headers: this.headers, body: chunk }) },
    }
    const listeners = {}
    const req = {
      method,
      url,
      headers,
      on(event, handler) { listeners[event] = handler; return this },
      destroy() {},
    }
    // 读体的路由会在 handler 的同步段里注册 data/end 监听，因此**先调用 handler**，
    // 再在下一个 tick 补发请求体。若放在 handler 的 .then 里发，读体的路由会
    // 永远等不到 end —— 双方互等，整个预检挂死。
    let result
    try {
      result = route.handler(req, res)
    } catch (error) {
      reject(error)
      return
    }
    setImmediate(() => {
      try {
        const text = body === undefined ? '' : JSON.stringify(body)
        if (typeof listeners.data === 'function' && text !== '') listeners.data(Buffer.from(text, 'utf8'))
        if (typeof listeners.end === 'function') listeners.end()
      } catch (error) {
        reject(error)
      }
    })
    Promise.resolve(result).catch(reject)
  })
}

const versioned = await call(versionRoute)
assert.equal(versioned.statusCode, 200)
const info = JSON.parse(versioned.body)
assert.equal(typeof info.version, 'string', '版本路由应返回 version')
assert.ok(!info.version.includes('__DSH_PIXEL'), `版本号未被构建注入：${info.version}`)
assert.equal(info.routePrefix, '/dsh-pixel')

const ok = await call(dataRoute)
assert.equal(ok.statusCode, 200, `GET 应返回 200，实际 ${ok.statusCode}`)
const payload = JSON.parse(ok.body)
assert.equal(typeof payload.generatedAt, 'number', '响应应含 generatedAt')
assert.equal(payload.version, info.version, '数据响应里的版本应与版本路由一致')// 能力声明是客户端判断兼容性的唯一依据，必须齐全——缺项会让对应界面降级。
// 注意「齐全」是指**声明**要完整，而不是要求客户端按它拦截取数（设计约束见 AGENT.md）。
const REQUIRED_CAPABILITIES = [
  'period', 'periodClock', 'peakRule', 'sessionCost', 'calendarByDay', 'tieredRates', 'crossDeviceLedger',
  'balance', 'balanceToggle', 'thirdPartyPlans', 'notifyJournal', 'notifyThresholds',
  // 会话清单里的预览标题（与 DSH 侧栏同源）。旧的 id 片段用户对不上侧栏任何一个会话。
  'sessionTitle',
]
assert.ok(Array.isArray(payload.capabilities), '响应应含 capabilities 数组')
for (const name of REQUIRED_CAPABILITIES) {
  assert.ok(payload.capabilities.includes(name), `capabilities 缺少 ${name}`)
}
assert.equal(payload.overview.sessions, 0, '无 persistence 时会话数应为 0')
assert.ok(Array.isArray(payload.days), '响应应含 days 数组')
assert.equal(payload.heatmap.days, 371, '热力图应覆盖 371 天')
assert.equal(payload.pricing.currency, 'CNY', '应带上计价币种')
// 时段口径必须是官方的高峰窗口，而不是旧的「错峰窗口」
assert.equal(payload.peakRule.windows.length, 2, '应有上午/下午两个高峰窗口')
assert.deepEqual(payload.peakRule.weekdays, [1, 2, 3, 4, 5], '高峰只落在工作日')
assert.ok(payload.period !== undefined, '响应应含当前时段状态')
assert.equal(payload.offPeak, undefined, '旧的 offPeak 字段不应再出现')
assert.equal(typeof payload.ledger?.path, 'string', '响应应回报账本路径，便于确认跨设备同步是否生效')

// ── 时段路由：侧栏指示灯的取数口 ────────────────────────────────
// 侧栏那枚点靠它画环形进度，因此这里锁住三件事：**纯时钟**（不依赖账本/会话，
// 因此永远可用）、本段长度可算（`prevChangeMs + nextChangeMs`，没有它就画不出比例）、
// 以及只读方法之外一律 405。
{
  const periodRes = await call(periodRoute)
  assert.equal(periodRes.statusCode, 200, `GET /period 应返回 200，实际 ${periodRes.statusCode}`)
  const clock = JSON.parse(periodRes.body)
  assert.equal(typeof clock.generatedAt, 'number', '/period 应含 generatedAt')
  assert.equal(clock.timezone, 'Asia/Shanghai', '/period 应带上站点时区')
  assert.equal(Object.hasOwn(clock, 'ledger'), false, '/period 不得带上账本信息（它是纯时钟，不读账本）')
  const phase = clock.period
  assert.equal(typeof phase.peak, 'boolean', '/period 应给出当前是否高峰')
  assert.equal(typeof phase.nextChangeMs, 'number', '/period 应给出距下次切换的毫秒数')
  assert.equal(typeof phase.prevChangeMs, 'number', '/period 应给出本段已走的毫秒数')
  assert.equal(typeof phase.periodMs, 'number', '/period 应给出本段总长（环形进度靠它）')
  // 本段总长必须恰好是「已走 + 还剩」：这是界面画比例的**唯一**依据，
  // 算错会让环长与倒计时对不上（弧走满了倒计时却还有一大截）。
  assert.equal(
    phase.periodMs,
    phase.prevChangeMs + phase.nextChangeMs,
    'periodMs 必须等于 prevChangeMs + nextChangeMs',
  )
  assert.ok(phase.prevChangeMs >= 0 && phase.nextChangeMs >= 0, '两个方向的时间差都不应为负')
  // 本段总长必须落在真实窗口里：最短的段是午休（2 小时），最长的是周末（63 小时）。
  assert.ok(
    phase.periodMs >= 120 * 60_000 - 1000 && phase.periodMs <= 63 * 3600_000 + 1000,
    `periodMs 应落在 2 小时 ~ 63 小时之间，实际 ${phase.periodMs / 60_000} 分钟`,
  )
  // 非只读方法一律拒绝（与余额 / 套餐 / 通知同一口径）
  const periodPost = await call(periodRoute, 'POST', '/dsh-pixel/period')
  assert.equal(periodPost.statusCode, 405, 'POST /period 应返回 405')
}

// ── 客户端 URL 与宿主路由必须对得上 ─────────────────────────────
// 这两边是**两个文件里的两个字符串**，写岔了不会有任何报错：宿主照常注册、
// 客户端照常请求，只是请求打到 404 上，指示灯安静地永远不出现。因此直接查源码。
{
  const periodClient = readFileSync(join(root, 'lib', 'client', 'period.js'), 'utf8')
  assert.ok(
    periodClient.includes("'/dsh-pixel/period'"),
    '客户端 period.js 必须请求 /dsh-pixel/period——与宿主注册路径写岔了指示灯会静默不出现',
  )
}

// ── 非空数据闸门 ───────────────────────────────────────────────
// 上面全用空数据源，只能证明「不报错」，证明不了「算得对」。
// 曾有一个字段名不匹配的 bug：聚合结果全为 0 却毫无报错，正是这类断言缺失导致的。
// 这里给一份真实的假会话，断言聚合结果必须与手算一致。
const SAMPLE_TIME = Date.parse('2026-09-10T02:00:00Z') // 周四 10:00 北京 → 高峰
const sampleEvents = [
  { type: 'turn/start', seq: 0, time: SAMPLE_TIME },
  {
    type: 'assistant/message',
    seq: 1,
    time: SAMPLE_TIME,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-chat' } },
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 600, cacheWriteTokens: 0, reasoningTokens: 0 },
    },
  },
]
const samplePersistence = {
  async list() {
    return [{
      header: { id: 'session-preflight-0000-0000-000000000000', createdAt: SAMPLE_TIME, cwd: 'D:\\blog' },
      revision: 'r1',
      eventCount: sampleEvents.length,
    }]
  },
  async open() {
    return {
      async read(offset = 0, length = 500) { return { events: sampleEvents.slice(offset, offset + length) } },
      async close() {},
    }
  },
}

const { UsageCatalog } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
const sampleCatalog = new UsageCatalog({
  persistence: () => samplePersistence,
  sessions: () => undefined,
  timezone: () => 'Asia/Shanghai',
})
const sample = await sampleCatalog.read()
rmSync(sandboxLedger, { force: true })

// 手算：命中 600、未命中 1000-600-0=400、输出 200 → 计费量 1200
assert.equal(sample.overview.totals.cacheHit, 600, `命中量应为 600，实际 ${sample.overview.totals.cacheHit}`)
assert.equal(sample.overview.totals.cacheMiss, 400, `未命中量应为 400，实际 ${sample.overview.totals.cacheMiss}`)
assert.equal(sample.overview.totals.output, 200, `输出应为 200，实际 ${sample.overview.totals.output}`)
assert.equal(sample.overview.totals.local, 1200, `计费量应为 1200，实际 ${sample.overview.totals.local}`)
assert.equal(sample.overview.totals.requests, 1)
assert.ok(sample.overview.totals.local > 0, '有数据时聚合结果不得为 0——这正是字段名不匹配的症状')
// 10:00 北京属高峰，应全部落在高峰档
assert.equal(sample.overview.totals.peak.cacheHit, 600, '高峰档应记录该请求')
assert.equal(sample.overview.totals.idle.cacheHit, 0, '高峰时段不应计入空闲档')
// 旧模型名应被折叠到现行模型，且条目身份带上提供商。
// `sampleCatalog` 没有注入 LLM 目录，因此这里钉的正是「读不到目录也要照常工作」：
// 提供商取自事件里的 provider（而不是猜），外显名退回价目表。
assert.deepEqual(sample.models.map((row) => row.key), ['deepseek-flash@deepseek-official'], '旧模型名应折叠为 deepseek-flash 并带上提供商')
assert.deepEqual(sample.models.map((row) => row.rollup), ['deepseek-flash'])
assert.equal(sample.models[0].provider, 'deepseek-official')
assert.ok(sample.models[0].rates !== undefined, '每个条目必须带上自己那一份单价')
assert.equal(sample.pricing.models['deepseek-flash'], sample.models[0].rates, '逐模型单价表按归一键索引')
assert.ok(sample.sessions[0].cost.standard > 0, '会话应带非零费用摘要')
assert.equal(sample.ledger.total, 1, '账本应记录一条')

const rejected = await call(dataRoute, 'POST')
assert.equal(rejected.statusCode, 405, 'POST 应返回 405')

// ── 会话预览标题：必须与 DSH 侧栏的 displayTitleOf 同一条回落链 ──────
// 这一列曾经显示 `id.slice(8, 16)`，用户拿一串十六进制对不上侧栏任何一行。
// 三条回落各自都要能命中，而且**顺序不能反**（有标题时用标题，没标题才退目录名）；
// 另外标题事件是 last-wins 的，用户改名后必须立刻反映出来。
{
  const titleTime = SAMPLE_TIME
  /** 造一个带标题事件的会话快照。 */
  const sessionWith = (id, cwd, events) => ({
    async list() {
      return [{ header: { id, createdAt: titleTime, cwd }, revision: 'r1', eventCount: events.length }]
    },
    async open() {
      return {
        async read(offset = 0, limit = 500) { return { events: events.slice(offset, offset + limit) } },
        async close() {},
      }
    },
  })
  const usageEvent = {
    type: 'assistant/message',
    seq: 1,
    time: titleTime,
    data: {
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  }
  /** 取某个会话的预览标题。 */
  const titleOf = async (id, cwd, events) => {
    const catalog = new UsageCatalog({
      persistence: () => sessionWith(id, cwd, events),
      sessions: () => undefined,
      timezone: () => 'Asia/Shanghai',
      ledgerPath: join(tmpdir(), `dsh-pixel-title-${process.pid}-${id}.jsonl`),
    })
    const result = await catalog.read()
    return result.sessions.find((row) => row.id === id)?.title
  }

  // 1) 有 session/title → 用它（且 last-wins）
  const titled = await titleOf('session-titled', 'D:\\blog', [
    { type: 'session/title', seq: 0, time: titleTime, data: { title: '旧标题', messageSeqs: [], source: { kind: 'fallback' } } },
    usageEvent,
    { type: 'session/title', seq: 2, time: titleTime, data: { title: '重构会话清单', messageSeqs: [0], source: { kind: 'user' } } },
  ])
  assert.equal(titled, '重构会话清单', `应取最新的 session/title，实际「${titled}」`)

  // 2) 没有标题 → 工作目录末段（两种分隔符都要能取出来）
  assert.equal(
    await titleOf('session-notitle', 'D:\\my_project\\blog', [usageEvent]),
    'blog',
    '没有标题时应回落到工作目录末段（与侧栏同源）',
  )
  assert.equal(
    await titleOf('session-posix', '/home/u/proj-a/', [usageEvent]),
    'proj-a',
    'POSIX 路径（含末尾分隔符）也应取到末段',
  )

  // 3) 既没有标题也没有工作目录 → 会话 id（而不是空白）
  assert.equal(
    await titleOf('session-noinfo', '', [usageEvent]),
    'session-noinfo',
    '标题与目录都拿不到时应回落到会话 id，绝不能是空串',
  )

  // 4) 畸形标题事件不得把已有标题擦成空：读不懂就保留上一个已知标题
  const partial = await titleOf('session-partial', 'D:\\blog', [
    { type: 'session/title', seq: 0, time: titleTime, data: { title: '有效标题', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'session/title', seq: 1, time: titleTime, data: { title: '' } },
    { type: 'session/title', seq: 2, time: titleTime, data: {} },
    { type: 'session/title', seq: 3, time: titleTime },
    usageEvent,
  ])
  assert.equal(partial, '有效标题', '读不懂的 session/title 不得把已有标题擦掉')

  // 5) 每个会话都必须带一个非空 title，否则界面会渲染成空白行
  for (const session of sample.sessions) {
    assert.equal(typeof session.title, 'string', `${session.id} 缺少 title`)
    assert.ok(session.title.length > 0, `${session.id} 的 title 不能是空串`)
  }
  // 上面那份假会话有工作目录、没有标题事件 → 应是目录末段
  assert.equal(sample.sessions[0].title, 'blog', `预览标题应是工作目录末段，实际「${sample.sessions[0].title}」`)
}

// ── 账户余额：隐私与开关 ────────────────────────────────────────
// 这一层的断言重点是「不发不该发的请求」与「不泄露 Key」，而不是余额数字本身
// （数字取决于线上账户，不能进闸门）。
const balance = await call(balanceRoute)
assert.equal(balance.statusCode, 200, `余额路由应返回 200，实际 ${balance.statusCode}`)
const balancePayload = JSON.parse(balance.body)
assert.equal(balancePayload.enabled, true, '默认应启用余额查询')
assert.equal(balancePayload.provider, 'deepseek-official', '应指明数据来自官方 provider')
assert.equal(balancePayload.apiKeyEnv, 'DEEPSEEK_API_KEY', '应使用官方默认凭据引用')
assert.equal(balancePayload.baseURL, 'https://api.deepseek.com', '未配置 baseURL 时应落到官方公网地址')
assert.equal(balancePayload.official, true, '默认端点应被识别为官方')
assert.ok(Array.isArray(balancePayload.balances), '余额应始终是数组（可能为空）')
// 预检环境没有 credentials 服务、也没有设 DEEPSEEK_API_KEY：应明确回报原因而不是假装 0
assert.equal(balancePayload.reason, 'no-key', '没配 Key 时应回报 no-key，而不是显示 0 余额')

// ── 隐私闸门：凭据的**值**绝不能跨到浏览器端 ──────────────────────
// 注意 `apiKeyEnv` 是引用的**名字**（DEEPSEEK_API_KEY），不是秘密——它出现在响应里
// 是刻意的（界面上要告诉用户「查的是哪个引用」）。所以不能靠搜字段名来判泄露，
// 而是种一个假 Key，断言它的值一个字节都没漏出去。
const SECRET_PROBE = 'sk-preflight-must-not-leak-0123456789'
process.env.DEEPSEEK_API_KEY = SECRET_PROBE
/** 记录假 fetch 收到的请求，用于断言端点与 Authorization 头。 */
const calls = []
// 单独造一个实例并注入假 fetch：预检不该真的打网络。
const { BalanceService } = await import(pathToFileURL(join(root, 'lib', 'balance.js')).href)
const probeService = new BalanceService({
  credentials: () => undefined,
  settings: () => undefined,
  prefsPath: sandboxPrefs,
  fetchImpl: async (url, init) => {
    calls.push({ url, auth: init?.headers?.authorization })
    return {
      ok: true,
      status: 200,
      text: async () => '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"12.34","granted_balance":"0.00","topped_up_balance":"12.34"}]}',
    }
  },
})
const probe = await probeService.read({ refresh: true })
const probeBody = JSON.stringify(probe)
assert.ok(
  !probeBody.includes(SECRET_PROBE),
  `余额响应里泄露了 API Key 的值：${probeBody.slice(0, 200)}`,
)
assert.ok(!probeBody.includes('Bearer'), `余额响应里不该出现 Authorization 头：${probeBody.slice(0, 200)}`)
// Key 确实被用上了（只是留在了宿主进程里，没有出现在响应中）
assert.equal(calls.length, 1, '应恰好向上游发一次请求')
assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance', `端点应拼在 baseURL 之后，实际 ${calls[0].url}`)
assert.equal(calls[0].auth, `Bearer ${SECRET_PROBE}`, 'Key 应通过 Authorization 头发出')
// 金额应被解析成数字，币种照抄接口值
assert.equal(probe.balances.length, 1)
assert.equal(probe.balances[0].currency, 'CNY')
assert.equal(probe.balances[0].total, 12.34, '接口给的字符串金额应转成数字')
assert.equal(probe.balances[0].toppedUp, 12.34)
assert.equal(probe.balances[0].granted, 0, '零值也要照抄，不能被当成缺失')
assert.equal(probe.available, true)
// 缓存：第二次读不应再打网络
const cachedProbe = await probeService.read()
assert.equal(calls.length, 1, 'TTL 内应命中缓存，不再请求上游')
assert.equal(cachedProbe.cached, true, '应标记为来自缓存')
// refresh 必须绕过缓存
await probeService.read({ refresh: true })
assert.equal(calls.length, 2, 'refresh 应强制重新请求')
// 失败态：上游出错时要回报 error，而不是装作余额为 0
const failing = new BalanceService({
  credentials: () => undefined,
  prefsPath: sandboxPrefs,
  fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
})
const failed = await failing.read()
assert.equal(failed.error, 'HTTP 401', '上游失败应回报状态码')
assert.deepEqual(failed.balances, [], '失败时不应编造余额')
// 解析不出金额时不能变成 0：宁缺勿假
const bogus = new BalanceService({
  credentials: () => undefined,
  prefsPath: sandboxPrefs,
  fetchImpl: async () => ({
    ok: true,
    status: 200,
    text: async () => '{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"n/a"}]}',
  }),
})
assert.equal((await bogus.read()).balances[0].total, undefined, '读不懂的金额应是 undefined，而不是 0')
// null / 空串绝不能变成 0：JSON 里字段缺失可能是 null，而界面上 0 就是「余额空了」。
// Number(null) 与 Number('') 都等于 0，所以这两条必须显式挡掉。
const { parseAmount } = await import(pathToFileURL(join(root, 'lib', 'balance.js')).href)
assert.equal(parseAmount(null), undefined, 'null 金额必须是 undefined，不能变成 0')
assert.equal(parseAmount(''), undefined, '空串金额必须是 undefined，不能变成 0')
assert.equal(parseAmount('   '), undefined, '空白金额必须是 undefined，不能变成 0')
assert.equal(parseAmount(undefined), undefined, '缺失金额必须是 undefined')
assert.equal(parseAmount('n/a'), undefined, '读不懂的金额必须是 undefined')
// 真实的 0 与负数仍要照抄
assert.equal(parseAmount('0.00'), 0, '真实的 0 应保留为 0')
assert.equal(parseAmount('-0.79'), -0.79, '负数应保留')
assert.equal(parseAmount('12.34'), 12.34, '正常金额应解析')
// 没配 baseURL 时**只认官方地址**：即使进程环境里设了 DEEPSEEK_BASE_URL 也不跟。
// 这是刻意的——端点决定 Key 发给谁，不能被一个环境变量改道。
process.env.DEEPSEEK_BASE_URL = 'https://evil.example.com'
const envRedirect = new BalanceService({
  credentials: () => undefined,
  prefsPath: sandboxPrefs,
  fetchImpl: async (url, init) => { calls.push({ url, auth: init?.headers?.authorization }); return { ok: true, status: 200, text: async () => '{}' } },
})
assert.equal(envRedirect.endpoint().baseURL, 'https://api.deepseek.com', 'DEEPSEEK_BASE_URL 不得改道余额端点')
delete process.env.DEEPSEEK_BASE_URL
// settings 里显式配了 baseURL 才跟随（那是运维的明确决定）
const configured = new BalanceService({
  credentials: () => undefined,
  settings: () => ({ get: () => ({ baseURL: 'https://proxy.internal', apiKeyEnv: 'MY_KEY' }) }),
  prefsPath: sandboxPrefs,
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
})
assert.equal(configured.endpoint().baseURL, 'https://proxy.internal', 'settings 显式配置应被采纳')
assert.equal(configured.endpoint().apiKeyEnv, 'MY_KEY', 'settings 里的凭据引用应被采纳')
assert.equal(configured.read !== undefined, true)
const configuredRead = await configured.read({ refresh: true })
assert.equal(configuredRead.official, false, '非官方端点应被标记出来')
delete process.env.DEEPSEEK_API_KEY

// 开关：POST 关闭后必须真的不再查
const off = await call(toggleRoute, 'POST', toggleRoute.path, { target: 'balance', enabled: false })
assert.equal(off.statusCode, 200, `开关应返回 200，实际 ${off.statusCode}`)
assert.equal(JSON.parse(off.body).enabled, false, '开关应被接受')
const afterOff = JSON.parse((await call(balanceRoute)).body)
assert.equal(afterOff.enabled, false, '关闭后应回报 enabled:false')
assert.equal(afterOff.reason, undefined, '关闭态下不应再去解析凭据')
assert.deepEqual(afterOff.balances, [], '关闭态下不应有余额条目')

// 开关必须按 target 分发，且互不干扰（两个功能共用一个 prefs 文件）
const plansOff = await call(toggleRoute, 'POST', toggleRoute.path, { target: 'plans', enabled: false })
assert.equal(JSON.parse(plansOff.body).enabled, false, '套餐开关应被接受')
assert.equal(JSON.parse((await call(plansRoute)).body).enabled, false, '关闭后套餐应回报 enabled:false')
// 关键回归点：关掉套餐**不能**把余额也关掉（共用一个 prefs 文件时的写覆盖）
assert.equal(JSON.parse((await call(balanceRoute)).body).enabled, false, '余额此时也应是关闭的（此前已关）')
await call(toggleRoute, 'POST', toggleRoute.path, { target: 'balance', enabled: true })
assert.equal(JSON.parse((await call(balanceRoute)).body).enabled, true, '余额应能单独打开')
assert.equal(JSON.parse((await call(plansRoute)).body).enabled, false, '打开余额不得把套餐一起打开')
await call(toggleRoute, 'POST', toggleRoute.path, { target: 'plans', enabled: true })
assert.equal(JSON.parse((await call(plansRoute)).body).enabled, true, '套餐应能单独打开')
assert.equal(JSON.parse((await call(balanceRoute)).body).enabled, true, '打开套餐不得影响余额')
// 未知 target 必须被拒
assert.equal(
  (await call(toggleRoute, 'POST', toggleRoute.path, { target: 'nope', enabled: true })).statusCode,
  400,
  '未知 target 应返回 400',
)

// 非法请求体必须被拒，且不改变开关状态
const badBody = await call(toggleRoute, 'POST', toggleRoute.path, { target: 'balance', enabled: 'yes' })
assert.equal(badBody.statusCode, 400, `非法开关值应返回 400，实际 ${badBody.statusCode}`)
const crossSite = await call(toggleRoute, 'POST', toggleRoute.path, { target: 'balance', enabled: true }, { 'sec-fetch-site': 'cross-site' })
assert.equal(crossSite.statusCode, 403, `跨站开关请求应返回 403，实际 ${crossSite.statusCode}`)
const stillOff = JSON.parse((await call(balanceRoute)).body)
assert.equal(stillOff.enabled, true, '被拒的请求不得改变开关状态（余额此前已打开）')

// GET 开关路由应 405（它是 POST-only）
assert.equal((await call(toggleRoute, 'GET')).statusCode, 405, '开关路由只接受 POST')

// 坏体 / 超大体都必须被拒，而且**必须给出响应**（不是把连接挂住）。
// 这里直接驱动路由，绕过上面的 JSON 便利层，才能造出「不是 JSON」与「超大」两种体。
/**
 * 以原始字符串体调用路由。
 * @param {object} route - 已注册路由。
 * @param {string} rawBody - 原始请求体。
 * @param {object} [headers] - 额外请求头。
 * @returns {Promise<{statusCode:number,body:string|undefined}>} 响应。
 */
function callRaw(route, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value },
      end(chunk) { resolve({ statusCode: this.statusCode, headers: this.headers, body: chunk }) },
    }
    const listeners = {}
    const req = {
      method: 'POST',
      url: route.path,
      headers,
      on(event, handler) { listeners[event] = handler; return this },
      resume() {},
      destroy() {},
    }
    let result
    try {
      result = route.handler(req, res)
    } catch (error) {
      reject(error)
      return
    }
    setImmediate(() => {
      try {
        if (typeof listeners.data === 'function') listeners.data(Buffer.from(rawBody, 'utf8'))
        if (typeof listeners.end === 'function') listeners.end()
      } catch (error) {
        reject(error)
      }
    })
    Promise.resolve(result).catch(reject)
  })
}

// 不是 JSON：400，且必须真的回了响应（历史上这类分支很容易把 Promise 挂住）
const malformed = await callRaw(toggleRoute, '{not json')
assert.equal(malformed.statusCode, 400, `坏 JSON 应返回 400，实际 ${malformed.statusCode}`)
assert.ok(malformed.body !== undefined, '坏 JSON 也必须给出响应体，不能挂住连接')
// 超大：400，且同样必须回响应（这条路径曾用 req.destroy() 抢先断连，导致 400 写不回去）
const oversize = await callRaw(toggleRoute, JSON.stringify({ target: 'balance', enabled: true, pad: 'x'.repeat(64 * 1024) }))
assert.equal(oversize.statusCode, 400, `超大请求体应返回 400，实际 ${oversize.statusCode}`)
assert.ok(oversize.body !== undefined, '超大请求体也必须给出响应体')
assert.ok(oversize.body.includes('过大'), `超大请求体应说明原因：${oversize.body}`)
// 开关状态在这些坏请求之后必须仍然可读、未被破坏（余额此前已被打开）
assert.equal(JSON.parse((await call(balanceRoute)).body).enabled, true, '坏请求不得破坏开关状态')

// 再关再开：应恢复为可查询，且失败原因重新可见
await call(toggleRoute, 'POST', toggleRoute.path, { target: 'balance', enabled: false })
const on = await call(toggleRoute, 'POST', toggleRoute.path, { target: 'balance', enabled: true })
assert.equal(JSON.parse(on.body).enabled, true, '应能重新打开')
assert.equal(JSON.parse((await call(balanceRoute)).body).reason, 'no-key', '重新打开后应重新尝试解析凭据')
assert.equal(off.headers['cache-control'], 'no-store', '余额响应不得被缓存')

// ── 第三方套餐额度：解析、容错与隐私 ────────────────────────────
const plansPayload = JSON.parse((await call(plansRoute)).body)
assert.equal(plansPayload.enabled, true, '默认应启用套餐监控')
assert.ok(Array.isArray(plansPayload.providers), 'providers 应是数组')
assert.deepEqual(
  plansPayload.providers.map((provider) => provider.id).sort(),
  ['commandcode', 'volcengine', 'zhipu'],
  '应包含智谱、Command Code 与火山方舟三家',
)
// 预检环境既没有凭据服务也没有环境变量、更没有 CLI 凭据文件：三家都应明说没配 Key
for (const provider of plansPayload.providers) {
  assert.equal(provider.ok, false, `${provider.id} 未配 Key 时不应报成功`)
  assert.equal(provider.reason, 'no-key', `${provider.id} 应回报 no-key`)
  assert.ok(Array.isArray(provider.windows), `${provider.id} 的 windows 应是数组`)
}
// 智谱官方只有 5 小时与每周，**没有**月度；这一条要留在数据里让界面解释清楚
const zhipu = plansPayload.providers.find((provider) => provider.id === 'zhipu')
assert.deepEqual(zhipu.supportedWindows, ['fiveHour', 'weekly'], '智谱只有 5 小时与每周窗口')
const commandCode = plansPayload.providers.find((provider) => provider.id === 'commandcode')
assert.deepEqual(commandCode.supportedWindows, ['fiveHour', 'weekly', 'monthly'], 'Command Code 应有三个窗口')
// 隐私闸门：套餐响应里绝不能出现凭据的**值**
const plansBody = JSON.stringify(plansPayload)
for (const banned of ['Bearer ', 'sk-', 'eyJ']) {
  assert.ok(!plansBody.includes(banned), `套餐响应里出现了疑似凭据内容「${banned}」`)
}

// 解析器：用假响应验窗口归类与「缺失不显示成 0」
const plansModule = await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)
const {
  parseZhipuQuota, parseCommandCodeCredits, maskSecret, readCommandCodeKey,
  deriveKeyRef, COMMAND_CODE_KEY_ENVS,
} = plansModule

// 凭据名派生必须与 DSH **逐字一致**：用户用「自定义提供商」添加服务时，DSH 按路由名
// 自己派生引用名并把 Key 存到那里（ui-settings-models 的 deriveKeyRef）：
//   `${provider.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}_API_KEY`
// 早先本插件只认 COMMAND_CODE_API_KEY，而路由名 `commandcode` 会派生
// COMMANDCODE_API_KEY（无下划线）——Key 存进去了却永远读不到，
// 症状正是「明明配了却一直说没配」。
assert.equal(deriveKeyRef('commandcode'), 'COMMANDCODE_API_KEY', 'commandcode 应派生无下划线的引用名')
assert.equal(deriveKeyRef('command-code'), 'COMMAND_CODE_API_KEY', '连字符路由名应派生带下划线的引用名')
assert.equal(deriveKeyRef('command_code'), 'COMMAND_CODE_API_KEY', '下划线形式应归一')
assert.equal(deriveKeyRef('zhipu-coding'), 'ZHIPU_CODING_API_KEY', '智谱路由名应派生对应引用名')
// 两种拼法都必须能被找到，否则等于要求用户猜对拼写
assert.ok(COMMAND_CODE_KEY_ENVS.includes('COMMANDCODE_API_KEY'), '候选里必须有无下划线形式')
assert.ok(COMMAND_CODE_KEY_ENVS.includes('COMMAND_CODE_API_KEY'), '候选里必须有带下划线形式')

// 智谱：窗口分类必须看 unit，不能按 nextResetTime 猜
// （周期末尾周窗口会比 5h 先重置，按时间排序必然标反）
const zhipuParsed = parseZhipuQuota({
  success: true,
  data: {
    level: 'MaxPlan',
    limits: [
      // 故意让「每周」的 reset 更早，若按时间排序就会标反
      { type: 'TOKENS_LIMIT', percentage: 35.2, nextResetTime: 1_756_800_000_000, unit: 6, number: 7 },
      { type: 'TOKENS_LIMIT', percentage: 61.8, nextResetTime: 1_757_232_000_000, unit: 3, number: 5 },
    ],
  },
})
assert.equal(zhipuParsed.plan, 'Max', 'level 应归一成档位名')
assert.equal(zhipuParsed.windows.length, 2)
const zhipuFive = zhipuParsed.windows.find((win) => win.window === 'fiveHour')
const zhipuWeek = zhipuParsed.windows.find((win) => win.window === 'weekly')
assert.equal(zhipuFive.usedPercent, 61.8, 'unit=3 应归 5 小时窗口，即使它的 reset 更晚')
assert.equal(zhipuWeek.usedPercent, 35.2, 'unit=6 应归每周窗口，即使它的 reset 更早')
assert.ok(zhipuFive.percentOnly === true, '只有百分比时应标记 percentOnly')
// 有绝对值时优先按绝对值算，比接口给的取整百分比准
const precise = parseZhipuQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 1, currentValue: 61, usage: 4000, unit: 3 }] } })
assert.equal(precise.windows[0].usedPercent, 1.53, '有绝对值时应自行算百分比（1.525 → 1.53）')
// 不认识的 unit：宁可少一个窗口，也不要把数挂错窗口
const unknownUnit = parseZhipuQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 50, unit: 99 }] } })
assert.equal(unknownUnit.windows.length, 0, '未知 unit 不应被猜成某个窗口')
assert.equal(unknownUnit.unparsed, 1, '未知 unit 应计入 unparsed')
// 额度可以**用超**：官方会给 >100 的百分比。宿主不得把它夹到 100——
// 那会把「已严重超限」显示成「刚好用满」，正是最该让用户看见的信息被抹掉。
const overQuota = parseZhipuQuota({ data: { limits: [{ type: 'TOKENS_LIMIT', currentValue: 140, usage: 100, unit: 3 }] } })
assert.equal(overQuota.windows[0].usedPercent, 140, '超限百分比必须保留真值，不能被夹到 100')

// Command Code：三窗口 + 裸数字月度
const ccParsed = parseCommandCodeCredits({
  credits: { monthlyCredits: { used: 23, cap: 100, resetAt: 1_790_000_000_000 } },
  windowLimits: {
    fiveHour: { used: 0.24, cap: 3, resetAt: 1_789_000_000_000, exceeded: false },
    weekly: { used: 0.24, cap: 6, resetAt: 1_789_500_000_000, exceeded: true },
  },
})
assert.equal(ccParsed.windows.length, 3, '应解析出三个窗口')
const ccFive = ccParsed.windows.find((win) => win.window === 'fiveHour')
assert.equal(ccFive.used, 0.24)
assert.equal(ccFive.total, 3)
assert.equal(ccFive.remaining, 2.76, '剩余应由总额 - 已用算出')
assert.equal(ccFive.usedPercent, 8, '已用百分比应算出来')
const ccWeek = ccParsed.windows.find((win) => win.window === 'weekly')
assert.equal(ccWeek.exceeded, true, 'exceeded 标记要透传')
const ccMonth = ccParsed.windows.find((win) => win.window === 'monthly')
assert.equal(ccMonth.used, 23)
assert.equal(ccMonth.total, 100)
// 裸数字的月度 = 剩余额度，没有总额时不编百分比
const ccBare = parseCommandCodeCredits({ credits: { monthlyCredits: 42.5 } })
const bareMonth = ccBare.windows.find((win) => win.window === 'monthly')
assert.equal(bareMonth.remaining, 42.5, '裸数字应作为剩余额度')
assert.equal(bareMonth.usedPercent, undefined, '没有总额时不得编造百分比')
assert.equal(bareMonth.total, undefined, '没有总额时 total 应是 undefined 而不是 0')

// 打码：不得还原出密钥，且短值整体打码
assert.equal(maskSecret('sk-abcdefghijklmnop'), '…mnop', '长密钥只露尾 4 位')
assert.equal(maskSecret('short'), '(已打码)', '过短的密钥整体打码')
assert.ok(!maskSecret('sk-abcdefghijklmnop').includes('abcdefgh'), '打码结果不得含密钥主体')

// ── 火山方舟：签名 V4 + 两种 plan 的解析 ────────────────────────
// 火山用量接口在**控制面** OpenAPI 上，要 AK/SK 签名；推理用的 ark- Key 会被网关
// 在格式层拒掉（实测 400 InvalidAuthorization）。这里把签名的结构与不变量钉住。
const {
  parseVolcAgentPlan, parseVolcCodingPlan, volcWindowName, VOLC_AK_ENVS, VOLC_SK_ENVS,
} = plansModule

// 凭据候选**不得**混入 provider 派生的推理 Key：那把在这里必然失败，纳进来只会误导
assert.ok(!VOLC_AK_ENVS.some((name) => name === 'FANGZHOU_API_KEY'),
  '火山 AK 候选不得包含 FANGZHOU_API_KEY（那是推理 Key，签不了名）')
assert.ok(!VOLC_AK_ENVS.includes('COMMAND_CODE_API_KEY'), '火山 AK 候选不得混入别家引用名')
assert.ok(VOLC_AK_ENVS.includes('VOLC_ACCESS_KEY_ID'), '火山 AK 候选应含约定名')
assert.ok(VOLC_SK_ENVS.includes('VOLC_SECRET_ACCESS_KEY'), '火山 SK 候选应含约定名')
// AK 与 SK 是两把不同的引用名，不能是同一个
assert.notDeepEqual(VOLC_AK_ENVS, VOLC_SK_ENVS, 'AK 与 SK 的候选名必须不同')

// 窗口名归一：线上 Level=session 就是控制台的「5 小时」，照抄字面会显示成陌生的「会话」
assert.equal(volcWindowName('session'), 'fiveHour', 'session 必须映射成 5 小时窗口')
assert.equal(volcWindowName('SESSION'), 'fiveHour', '大小写不敏感')
assert.equal(volcWindowName('weekly'), 'weekly')
assert.equal(volcWindowName('monthly'), 'monthly')
assert.equal(volcWindowName('daily'), undefined, 'daily 不是我们要显示的窗口，应被跳过')
assert.equal(volcWindowName(''), undefined)
assert.equal(volcWindowName(undefined), undefined)

// Agent Plan：绝对值 Quota/Used，百分比自己算；AFPDaily 刻意不取
const afp = parseVolcAgentPlan({
  AFPFiveHour: { Quota: 1000, Used: 250, ResetTime: 1_789_000_000_000 },
  AFPWeekly: { Quota: 50000, Used: 12500, ResetTime: 1_789_500_000_000 },
  AFPMonthly: { Quota: 200000, Used: 50000, ResetTime: 1_790_000_000_000 },
  AFPDaily: { Quota: 999999, Used: 1, ResetTime: 1_789_000_000_000 },
  PlanType: 'medium',
})
assert.equal(afp.windows.length, 3, 'AFPDaily 应被跳过，只留三个窗口')
assert.equal(afp.planType, 'medium')
const afpFive = afp.windows.find((win) => win.window === 'fiveHour')
assert.equal(afpFive.used, 250)
assert.equal(afpFive.total, 1000)
assert.equal(afpFive.usedPercent, 25, '已用百分比应由 Used/Quota 算出')
assert.equal(afpFive.remaining, 750, '剩余应由总额 - 已用算出')
// ResetTime 是**毫秒**：不得被当成秒再乘 1000
assert.equal(afpFive.resetAt, 1_789_000_000_000, 'Agent Plan 的 ResetTime 是毫秒，不应再换算')
// Quota<=0 = 该窗口未订阅 → 跳过，而不是显示成 0 额度
const afpUnsub = parseVolcAgentPlan({
  AFPFiveHour: { Quota: 0, Used: 0, ResetTime: 1 },
  AFPWeekly: { Quota: 50000, Used: 1, ResetTime: 1_789_500_000_000 },
})
assert.equal(afpUnsub.windows.length, 1, 'Quota<=0 的窗口应视为未订阅并跳过')
assert.equal(afpUnsub.windows[0].window, 'weekly')
// 完全没订 Agent Plan → 空结果（上层据此回落到 Coding Plan 探测）
assert.equal(parseVolcAgentPlan({}).windows.length, 0, '无字段应返回空而不是编造窗口')

// Coding Plan：**只给百分比**，没有 used/total；ResetTimestamp 是**秒**
const coding = parseVolcCodingPlan({
  QuotaUsage: [
    { Level: 'session', Percent: 0, ResetTimestamp: 1_782_057_600 },
    { Level: 'weekly', Percent: 1.672568, ResetTimestamp: 1_782_057_600 },
    { Level: 'monthly', Percent: 0.836284, ResetTimestamp: 1_784_303_999 },
  ],
})
assert.equal(coding.windows.length, 3)
const codingWeek = coding.windows.find((win) => win.window === 'weekly')
assert.equal(codingWeek.usedPercent, 1.67, '百分比应保留两位小数')
assert.equal(codingWeek.used, undefined, '只给百分比时 used 必须是 undefined 而不是 0')
assert.equal(codingWeek.total, undefined, '只给百分比时 total 必须是 undefined 而不是 0')
assert.equal(codingWeek.percentOnly, true, '只有百分比时应标记 percentOnly')
// 秒 → 毫秒：1_782_057_600 应变成 1_782_057_600_000
assert.equal(codingWeek.resetAt, 1_782_057_600_000, 'ResetTimestamp 是秒，应换算成毫秒')
// 认不出的窗口跳过，且计入 unparsed
const codingPartial = parseVolcCodingPlan({
  QuotaUsage: [{ Level: 'daily', Percent: 5 }, { Level: 'weekly', Percent: 12 }, null],
})
assert.equal(codingPartial.windows.length, 1, 'daily 与坏记录应被跳过')
assert.equal(codingPartial.unparsed, 2, '跳过的记录应计入 unparsed')
// 未订阅、字段改名等情况下返回空而不是抛错
assert.equal(parseVolcCodingPlan({}).windows.length, 0)
assert.equal(parseVolcCodingPlan({ QuotaUsage: 'nope' }).windows.length, 0)

// 签名 V4：结构与不变量（无服务端金标准向量，因此锁定结构性契约）
const volcModule = await import(pathToFileURL(join(root, 'lib', 'volc-sign.js')).href)
const { signVolcRequest, canonicalQuery, volcDates, uriEncode, isVolcAuthErrorCode, volcResponseError } = volcModule

// canonical query 按 key 字母序；`-` 属 unreserved 不编码
assert.equal(canonicalQuery('GetAFPUsage', 'cn-beijing'),
  'Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01', 'canonical query 应排序且不编码 -')
// 编码必须按 RFC3986：encodeURIComponent 漏掉 !'()* ，照抄会签名不匹配
assert.equal(uriEncode('a b'), 'a%20b', '空格应编码成 %20')
assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A', "!'()* 必须编码（encodeURIComponent 不会）")
assert.equal(uriEncode('-_.~'), '-_.~', 'unreserved 四个符号不编码')

const fixedNow = Date.parse('2024-06-21T00:00:00Z')
assert.deepEqual(volcDates(fixedNow), { xDate: '20240621T000000Z', shortDate: '20240621' },
  'X-Date 必须是 UTC 的 yyyyMMddTHHmmssZ')

const signed = signVolcRequest({
  accessKeyId: 'AKLTtest', secretAccessKey: 'secretkey', action: 'GetAFPUsage', now: fixedNow,
})
// 空 body 的 SHA-256 是固定值，证明走的是空 body
assert.equal(signed.xContentSha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '空 body 的 SHA-256 应为固定值')
assert.equal(signed.xDate, '20240621T000000Z')
// 算法串**没有** AWS4 前缀、scope 以 request 结尾（照搬标准 SigV4 会失败）
assert.ok(signed.authorization.startsWith('HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request,'),
  `scope 或算法串不对：${signed.authorization}`)
assert.ok(signed.authorization.includes('SignedHeaders='), 'Authorization 必须声明 SignedHeaders')
const sigPart = /Signature=([0-9a-f]+)$/.exec(signed.authorization)
assert.ok(sigPart !== null, 'Authorization 末尾应是十六进制签名')
assert.equal(sigPart[1].length, 64, 'HMAC-SHA256 签名应是 64 位十六进制')
// 端点固定：签名用的 URL 必须是官方网关，且 query 与签名用的一致
assert.equal(signed.url, `https://open.volcengineapi.com/?${signed.query}`,
  'URL 必须由签名的同一份 canonical query 拼出，否则签名不匹配')
assert.ok(signed.url.startsWith('https://open.volcengineapi.com/'), '端点固定为官方控制面网关')
// 确定性：同样的输入必须给出同样的签名
const signedAgain = signVolcRequest({
  accessKeyId: 'AKLTtest', secretAccessKey: 'secretkey', action: 'GetAFPUsage', now: fixedNow,
})
assert.equal(signed.authorization, signedAgain.authorization, '签名必须确定')
// **SignedHeaders 与 canonical headers 必须同源**：这正是社区里争议「要不要排序」的那个
// 失败模式——只要两处由同一数组生成就不可能不一致。这里断言它们集合一致。
const declared = /SignedHeaders=([^,]+),/.exec(signed.authorization)[1].split(';')
for (const name of ['content-type', 'host', 'x-content-sha256', 'x-date']) {
  assert.ok(declared.includes(name), `SignedHeaders 应包含 ${name}`)
}
assert.equal(declared.length, 4, 'SignedHeaders 只应有这四个头')
// 换一把 SK 必须换出不同签名（否则等于没签）
const otherKey = signVolcRequest({
  accessKeyId: 'AKLTtest', secretAccessKey: 'other', action: 'GetAFPUsage', now: fixedNow,
})
assert.notEqual(otherKey.authorization, signed.authorization, '不同 SK 必须得到不同签名')

// 错误信封：火山业务错误常**以 200 携带信封**返回，只看状态码会把失败当成功
const envelope = volcResponseError({
  ResponseMetadata: { Error: { Code: 'InvalidAccessKey', Message: 'invalid' } },
})
assert.deepEqual(envelope, { code: 'InvalidAccessKey', message: 'invalid' })
assert.equal(volcResponseError({ ResponseMetadata: { RequestId: 'x' }, Result: {} }), undefined,
  '没有 Error 时应返回 undefined')
assert.equal(volcResponseError({ Error: { Code: 'X' } }).code, 'X', '顶层 Error 也要认')
// 鉴权类判定：决定是否附上「这里要 AK/SK」那条提示
assert.ok(isVolcAuthErrorCode('InvalidAccessKey'), 'InvalidAccessKey 属鉴权类')
assert.ok(isVolcAuthErrorCode('InvalidAuthorization'), 'InvalidAuthorization 属鉴权类')
assert.ok(isVolcAuthErrorCode('SignatureDoesNotMatch'), '签名不匹配属鉴权类')
assert.ok(isVolcAuthErrorCode('AccessDenied'), 'AccessDenied 属鉴权类')
assert.ok(!isVolcAuthErrorCode('InvalidActionOrVersion'), 'Action 名写错不是鉴权问题')
assert.ok(!isVolcAuthErrorCode('InternalError'), '服务端错误不是鉴权问题')

// 端到端（注入 fetch）：签名头必须真的带上，且不能把 AK/SK 写进响应
const volcSeen = {}
const volcService = new (await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)).PlansService({
  credentials: () => ({
    resolve: async (ref) => {
      if (ref === 'VOLC_ACCESS_KEY_ID') return { value: 'AKLTpreflight0123456789', source: 'file' }
      if (ref === 'VOLC_SECRET_ACCESS_KEY') return { value: 'c2VjcmV0LXByZWZsaWdodC0wMDAwMDAwMA', source: 'file' }
      return undefined
    },
  }),
  prefs: async () => ({ plansEnabled: true }),
  env: {},
  fetchImpl: async (url, init) => {
    volcSeen.url = url
    volcSeen.headers = init?.headers ?? {}
    // 只有第一个 Action 返回数据；第二个不该被调用
    if (url.includes('GetAFPUsage')) {
      return new Response(JSON.stringify({
        ResponseMetadata: { RequestId: 'x' },
        Result: { AFPFiveHour: { Quota: 100, Used: 40, ResetTime: 1_789_000_000_000 }, PlanType: 'small' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    volcSeen.secondCalled = true
    return new Response('{}', { status: 200 })
  },
})
const volcPayload = await volcService.read({ refresh: true })
const volcProvider = volcPayload.providers.find((item) => item.id === 'volcengine')
assert.ok(volcProvider !== undefined, '响应里应有火山那一家')
assert.equal(volcProvider.ok, true, `火山应取数成功：${JSON.stringify(volcProvider)}`)
assert.equal(volcProvider.windows.length, 1)
assert.equal(volcProvider.windows[0].usedPercent, 40, '40/100 应算出 40%')
// 请求必须真的发出签名头，且端点是控制面网关
assert.ok(volcSeen.url.startsWith('https://open.volcengineapi.com/?'), '应请求控制面网关')
assert.ok(/authorization/i.test(Object.keys(volcSeen.headers).join(' ')) || volcSeen.headers.authorization !== undefined,
  '必须带 Authorization 头')
assert.ok(String(volcSeen.headers.authorization ?? '').startsWith('HMAC-SHA256 Credential='),
  'Authorization 必须是火山 HMAC-SHA256 形式')
assert.equal(volcSeen.headers['x-content-sha256'],
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', '空 body 的 sha256 头')
assert.ok(volcSeen.secondCalled !== true, '第一个 Action 成功就不该再试第二个')
// 隐私：AK/SK 的值绝不能出现在响应里（这条路径直达浏览器）
const volcBody = JSON.stringify(volcProvider)
for (const secret of ['AKLTpreflight0123456789', 'c2VjcmV0LXByZWZsaWdodC0wMDAwMDAwMA']) {
  assert.ok(!volcBody.includes(secret), `火山响应里泄露了凭据值：${secret}`)
}
assert.ok(!volcBody.includes('c2VjcmV0'), '响应不得含 SK 任何片段')
// 打码后只留尾 4 位，可用于确认「用的是哪一把」
assert.ok(volcProvider.keyHint.includes('6789'), '应回报打码后的 AK 尾段')

// 只配了 AK 没配 SK：必须指出缺的是哪一个
const halfService = new (await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)).PlansService({
  credentials: () => ({
    resolve: async (ref) => (ref === 'VOLC_ACCESS_KEY_ID'
      ? { value: 'AKLTonlyak0123456789', source: 'file' }
      : undefined),
  }),
  prefs: async () => ({ plansEnabled: true }),
  env: {},
  fetchImpl: async () => { throw new Error('不该发请求：凭据不齐') },
})
const halfProvider = (await halfService.read({ refresh: true })).providers.find((item) => item.id === 'volcengine')
assert.equal(halfProvider.ok, false)
assert.equal(halfProvider.reason, 'no-key')
assert.equal(halfProvider.keyRef, 'VOLC_SECRET_ACCESS_KEY', '应指出缺的是 SK')
assert.ok(halfProvider.hint.includes('AccessKey'), '应说明这里要的是 AccessKey')

// 鉴权被拒：必须给出「这里要 AK/SK 而不是推理 Key」这条唯一有用的提示
const rejectedService = new (await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)).PlansService({
  credentials: () => ({
    resolve: async (ref) => (ref === 'VOLC_ACCESS_KEY_ID'
      ? { value: 'AKLTbad0123456789abc', source: 'file' }
      : ref === 'VOLC_SECRET_ACCESS_KEY' ? { value: 'bad-secret-value-here', source: 'file' } : undefined),
  }),
  prefs: async () => ({ plansEnabled: true }),
  env: {},
  fetchImpl: async () => new Response(JSON.stringify({
    ResponseMetadata: { Error: { Code: 'InvalidAccessKey', Message: 'bad key' } },
  }), { status: 401, headers: { 'content-type': 'application/json' } }),
})
const rejectedProvider = (await rejectedService.read({ refresh: true })).providers.find((item) => item.id === 'volcengine')
assert.equal(rejectedProvider.ok, false)
assert.equal(rejectedProvider.reason, 'rejected', '信封里的鉴权错误应归为 rejected（即使 HTTP 是 401）')
assert.ok(rejectedProvider.hint.includes('AccessKey'), '必须提示要的是 AccessKey 而不是推理 Key')

// 自动发现：读不到文件时必须安静地返回 undefined，而不是抛错
assert.equal(readCommandCodeKey(join(tmpdir(), `dsh-pixel-nonexistent-${process.pid}.json`)), undefined, '文件不存在时应返回 undefined')
const fakeAuth = join(tmpdir(), `dsh-pixel-auth-${process.pid}.json`)
rmSync(fakeAuth, { force: true })
writeFileSync(fakeAuth, JSON.stringify({ apiKey: 'cc-test-key-0123456789' }), 'utf8')
assert.equal(readCommandCodeKey(fakeAuth), 'cc-test-key-0123456789', '应能从 auth.json 读出 apiKey')
writeFileSync(fakeAuth, '{broken json', 'utf8')
assert.equal(readCommandCodeKey(fakeAuth), undefined, '坏文件应安静降级，不能抛错')
rmSync(fakeAuth, { force: true })

// ── 多厂商价目：智谱 GLM 与「估算价」的诚实标注 ──────────────────
const pricingModule = await import(pathToFileURL(join(root, 'lib', 'pricing.js')).href)
const { pricingOf, normalizeModel, MODEL_RATES } = pricingModule

// deepseek-v4.1-flash 是 DSH 实际在用的模型名（本机账本里有近 2000 条）。
// 不折叠的话它会走兜底：金额一样但被标成「估算价」并多出一行，看起来像另一个模型。
assert.equal(normalizeModel('deepseek-v4.1-flash'), 'deepseek-flash', 'DSH 实际模型名应折到 flash')
assert.equal(pricingOf('deepseek-v4.1-flash').known, true, '折叠后应被认作已知价')
// 智谱 GLM 现在有官方人民币单价（智谱定价页本身就是元/百万 token）
assert.equal(pricingOf('glm-5.3').known, true, 'GLM-5.3 应在价目表里')
assert.deepEqual(MODEL_RATES['glm-5.3'].cacheMiss, { peak: 8, idle: 8 }, 'GLM-5.3 输入应为 8 元且不分时')
assert.deepEqual(MODEL_RATES['glm-5.3'].output, { peak: 28, idle: 28 }, 'GLM-5.3 输出应为 28 元')
assert.deepEqual(MODEL_RATES['glm-5.3-flash'].cacheMiss, { peak: 0.8, idle: 0.8 }, 'GLM-5.3-Flash 输入应为 0.8 元')
assert.deepEqual(MODEL_RATES['glm-5.3-flash'].cacheHit, { peak: 0.23, idle: 0.23 }, 'GLM-5.3-Flash 缓存命中应为 0.23 元')
// 智谱历史模型按官方说明折叠到现行模型
assert.equal(normalizeModel('glm-5.1'), 'glm-5.3', 'GLM-5.1 应折到 GLM-5.3')
assert.equal(normalizeModel('glm-4.7'), 'glm-5.3-flash', 'GLM-4.7 应折到 GLM-5.3-Flash')
// 不分时的模型 peak 必须等于 idle——这是「flat」判定的依据，界面靠它决定列数
for (const [key, rates] of Object.entries(MODEL_RATES)) {
  if (rates.flat !== true) continue
  for (const field of ['cacheHit', 'cacheMiss', 'output']) {
    assert.equal(rates[field].peak, rates[field].idle, `${key}.${field} 标了 flat 但 peak ≠ idle`)
  }
}
// 兜底：未知模型必须被标成「不知道」，而不是假装有官方价
const unknownPricing = pricingOf('some-future-model-xyz')
assert.equal(unknownPricing.known, false, '未知模型必须标记为未知价')
assert.equal(unknownPricing.rates, MODEL_RATES['deepseek-flash'], '未知模型应兜底到 Flash 单价')
// 分档标注：GLM-4.6V 官方按输入长度分档，这里只取最低档并标出来
assert.equal(pricingOf('glm-4.6v').tiered, true, 'GLM-4.6V 应标记为分档定价（这里只按最低档）')

// ── 通知与预警：宿主侧的结束事实 + 阈值配置读写 ──────────────────
const notifyModule = await import(pathToFileURL(join(root, 'lib', 'notify.js')).href)
const {
  NOTIFY_DEFAULTS, NotifyJournal, normalizeNotify, noticeOf, truncate,
} = notifyModule

// 1) `turn/end` 的五种原因各自归类；**认不出的必须落到 error 一侧**，
//    把一次失败说成「已完成」是这里最不能犯的错（TurnEndReasonMap 可扩展）。
const outcomes = [
  ['completed', 'done'], ['error', 'error'], ['aborted', 'error'],
  ['blocked', 'error'], ['max-tokens', 'error'], ['interrupted', 'error'],
  ['some-future-reason', 'error'],
]
for (const [kind, category] of outcomes) {
  const notice = noticeOf(
    { id: 'session-1', header: { cwd: 'D:\\blog' } },
    { type: 'turn/end', time: 1, data: { turn: 3, reason: { kind } } },
    'blog',
  )
  assert.equal(notice.category, category, `reason.kind=${kind} 应归入 ${category}`)
  assert.equal(notice.turn, 3, '应带上轮次')
  assert.equal(notice.workspace, 'blog', '应带上工作目录名')
}
// 非 turn/end 事件不产生通知
assert.equal(
  noticeOf({ id: 's' }, { type: 'turn/start', time: 1, data: {} }, 'w'),
  undefined,
  '非 turn/end 事件不应产生通知',
)
// 失败要带原因；且必须截断（错误信息可能很长，而它要进系统通知）
const failedNotice = noticeOf(
  { id: 's' },
  { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'error', error: { message: 'x'.repeat(500), code: 'RATE_LIMIT' } } } },
  'w',
)
assert.ok(failedNotice.detail.length <= 240, `失败原因应被截断，实际 ${failedNotice.detail.length}`)
assert.equal(failedNotice.code, 'RATE_LIMIT', '失败应带上错误码')
assert.equal(truncate('  '), undefined, '空白文本应归一成 undefined')

// 2) 环形日志：容量上限 + 单调游标 + 「开始订阅」不重播历史
const journal = new NotifyJournal({ limit: 3 })
for (let i = 1; i <= 5; i += 1) journal.record({ at: i, sessionId: `s${i}`, category: 'done' })
assert.equal(journal.read({ since: 0 }).events.length, 3, '超出容量后应只保留最近 3 条')
const first = journal.read({})
assert.equal(first.events.length, 0, '不给 since 时应只回报当前游标，不重播历史')
assert.equal(first.cursor, 5, '游标应为最新一条的 id')
// 被裁掉之后要能明确说「中间丢了」，而不是安静地少提醒几条
const stale = journal.read({ since: 1 })
assert.equal(stale.dropped, true, 'since 早于最旧记录时应标出 dropped')
assert.equal(journal.read({ since: 4 }).dropped, false, '没丢记录时不应误报 dropped')

// 3) 配置归一：脏输入不能污染配置，也不能把「未设置」变成 0
const clean = normalizeNotify({
  notifyDone: 'yes',
  warnBalance: { cny: 10, USD: '5', __proto__: 999, BAD: -1, EMPTY: '', NULL: null },
  warnQuotaPercent: 250,
})
assert.equal(clean.notifyDone, NOTIFY_DEFAULTS.notifyDone, '非布尔值应退回默认值')
assert.equal(clean.warnBalance.CNY, 10, '币种键应归一成大写')
assert.equal(clean.warnBalance.USD, 5, '数字字符串应被接受')
assert.equal(clean.warnBalance.BAD, undefined, '负阈值应被丢弃')
assert.equal(clean.warnBalance.EMPTY, undefined, '空串不能被当成 0')
assert.equal(clean.warnBalance.NULL, undefined, 'null 不能被当成 0')
assert.ok(!Object.hasOwn(clean.warnBalance, '__proto__'), '原型键必须被正则挡掉')
assert.equal(clean.warnQuotaPercent, 250, '超过 100 的阈值是合法用法（只提醒超限）')
assert.equal(normalizeNotify({ warnQuotaPercent: 'abc' }).warnQuotaPercent, NOTIFY_DEFAULTS.warnQuotaPercent, '读不懂的百分比应退回默认')
assert.deepEqual(Object.keys(clean).sort(), Object.keys(NOTIFY_DEFAULTS).sort(), '归一结果只能含已知键')

// 4) 路由行为：GET 带 since 读增量；POST 写配置；跨站被拒
const notifyRead = await call(notifyRoute, 'GET', '/dsh-pixel/notify')
assert.equal(notifyRead.statusCode, 200)
const notifyPayload = JSON.parse(notifyRead.body)
assert.ok(notifyPayload.config !== undefined, 'GET 应带上配置')
assert.equal(notifyPayload.cursor, 0, '尚无会话事件时游标应为 0')
assert.equal(notifyPayload.events.length, 0)

// 驱动一次 session/event，确认宿主 listener 真的把事实记进了日志。
// 这条断言是「后台会话也能提醒」的核心：浏览器看不到这些事件，只有宿主能。
const sessionEventHandlers = hostListeners.get('session/event') ?? []
assert.equal(sessionEventHandlers.length, 1, '应恰好注册一个 session/event 监听器')
sessionEventHandlers[0](
  { id: 'session-abc', header: { cwd: 'D:\\my_project\\blog' } },
  { type: 'turn/end', time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
)
const afterEvent = JSON.parse((await call(notifyRoute, 'GET', '/dsh-pixel/notify?since=0')).body)
assert.equal(afterEvent.events.length, 1, '宿主应把 turn/end 记进通知日志')
assert.equal(afterEvent.events[0].category, 'done')
assert.equal(afterEvent.events[0].workspace, 'blog', '工作区名应由宿主算好')

// 5) 热路径安全：`session/event` 上还挂着持久化、投影与遥测，监听器抛错会中断
//    同一次 emit 的后续订阅者（最坏是会话日志没落盘）。因此无论喂进什么畸形
//    事件，这个监听器都必须安静返回，绝不向调用方抛错。
//
//    分两类断言，因为它们的正确行为不同：
//      - 结构上不是「某会话结束」的（非 turn/end、或会话 id 读不出来）→ 不记；
//      - 确实是 turn/end 但 reason 畸形 → **仍然要记**，只是归到「原因未知」。
//        一次真实结束不该因为字段坏掉就凭空消失；而且它必须落到 error 一侧，
//        绝不能因为读不懂就当成「已完成」。
const noRecordEvents = [
  { type: 'user/message', time: 1, data: {} },
  { type: 'turn/start', time: 1, data: { turn: 1 } },
]
const noSubjectValues = [{}, null, undefined, { header: {} }, { id: '', header: { cwd: null } }]
for (const weird of noRecordEvents) {
  for (const subject of [{ id: 'x', header: {} }, ...noSubjectValues]) {
    sessionEventHandlers[0](subject, weird)
  }
}
for (const subject of noSubjectValues) {
  sessionEventHandlers[0](subject, { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } })
}
// 读全量要用 since=0：不带 since 的 GET 是「从现在开始订阅」，按设计返回空列表。
const afterNoRecord = JSON.parse((await call(notifyRoute, 'GET', '/dsh-pixel/notify?since=0')).body)
assert.equal(afterNoRecord.events.length, 1, '非 turn/end 或读不出会话 id 时不得写入通知日志')

// 畸形 reason：结构可读、字段坏掉。仍须记一条，且必须归到 error 一侧。
const malformedReasonEvents = [
  { type: 'turn/end', time: 1, data: null },
  { type: 'turn/end', time: 1, data: { turn: 1, reason: null } },
  { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'error', error: null } } },
  { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'aborted', reason: null } } },
  { type: 'turn/end', time: 1 },
]
for (const weird of malformedReasonEvents) {
  sessionEventHandlers[0]({ id: 'session-bad', header: { cwd: 'D:\\x' } }, weird)
}
const afterBad = JSON.parse((await call(notifyRoute, 'GET', '/dsh-pixel/notify?since=0')).body)
assert.equal(
  afterBad.events.length,
  1 + malformedReasonEvents.length,
  '畸形 reason 的 turn/end 仍应记录（一次真实结束不该凭空消失）',
)
for (const entry of afterBad.events.slice(1)) {
  assert.equal(entry.category, 'error', `读不懂的 reason 必须归到 error 一侧，而不是假装完成：${JSON.stringify(entry)}`)
}

const notifyWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', { warnBalance: { CNY: 20 } })
assert.equal(notifyWrite.statusCode, 200, `POST 应返回 200，实际 ${notifyWrite.statusCode}`)
const written = JSON.parse(notifyWrite.body)
assert.equal(written.config.warnBalance.CNY, 20, '阈值应被写入')
assert.equal(written.config.notifyDone, true, '未提交的项应保持原值（合并语义）')
// 写回后读一次，确认真的持久化到隔离的 prefs 文件里
const reread = JSON.parse((await call(notifyRoute, 'GET')).body)
assert.equal(reread.config.warnBalance.CNY, 20, '重新读取应看到刚写入的阈值')
// 跨站被拒：写路由不接受跨站表单触发
const crossSiteWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', { warnQuotaPercent: 1 }, { 'sec-fetch-site': 'cross-site' })
assert.equal(crossSiteWrite.statusCode, 403, '跨站写请求应被拒绝')
// 非法体被拒（数组不是对象）
const badWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', [1, 2, 3])
assert.equal(badWrite.statusCode, 400, '数组体应被拒绝')
// 只读方法之外一律 405
const putRoute = await call(notifyRoute, 'PUT', '/dsh-pixel/notify')
assert.equal(putRoute.statusCode, 405, 'PUT 应返回 405')

// 恢复：把开关文件清干净，避免影响后续断言
rmSync(sandboxPrefs, { force: true })

console.log(`预检通过：插件形状、7 条路由、版本注入（${info.version}）、能力声明、空/非空聚合、`
  + 'POST 拒绝、时段时钟、余额隐私与开关、套餐解析与凭据打码、多厂商价目、通知日志与预警阈值')

rmSync(sandboxPrefs, { force: true })
