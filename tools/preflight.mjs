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
import { tmpdir, homedir } from 'node:os'
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
/**
 * 记录 ctx.effect 的注销函数。
 *
 * 宿主把每条路由都注册在 `ctx.effect` 里（fiber 销毁时注销），因此替身必须有这个
 * API——少了它，`apply` 会以 `ctx.effect is not a function` 直接失败。
 * 收集起来也方便断言「路由确实能被注销」。
 */
const effectDisposers = []
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register: (route) => {
          // 与真实实现同一口径：重复路径必须抛错，否则漏注销的 bug 会溜过去。
          if (routes.some((item) => item.path === route.path)) {
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
          }
          routes.push(route)
          return () => {
            const at = routes.indexOf(route)
            if (at >= 0) routes.splice(at, 1)
          }
        },
      }
    }
    return undefined
  },
  on(event, handler) {
    const list = hostListeners.get(event) ?? []
    list.push(handler)
    hostListeners.set(event, list)
  },
  // cordis 语义：回调的返回值是 disposer，fiber 销毁时由框架调用。
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') effectDisposers.push(dispose)
    return () => {}
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
// 单会话明细（会话标签页）。它的存在本身就是一项能力：旧宿主没有这条路由，
// 会话标签页要显示「当前宿主不支持这条明细」而不是空白。
const sessionRoute = routeOf('/dsh-pixel/session')
const toggleRoute = routeOf('/dsh-pixel/toggle')
const notifyRoute = routeOf('/dsh-pixel/notify')
// 桌面端把窗口拉到前台（宿主唤起 dsh://open）。
const focusRoute = routeOf('/dsh-pixel/focus')
const ratesRoute = routeOf('/dsh-pixel/rates')
const credsRoute = routeOf('/dsh-pixel/plan-credentials')
// 路由条数是**有意**钉死的：新增路由必须在这里显式加一行，并想清楚它是否需要
// 同源闸门与写权限，而不是让新增悄悄溜过去（见 lib/host.js 的注册处）。
// 11 = version / period / balance / plans / session / notify / focus / toggle / rates / plan-credentials / data
assert.equal(routes.length, 11, `应注册恰好十一条路由，实际 ${routes.length}`)

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
function call(route, method = 'GET', url = route.path, body, headers = {}) {  return new Promise((resolve, reject) => {
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

/**
 * 隐私闸门：响应里**不得出现凭据的值**。
 *
 * ## 为什么不能搜朴素的 `'sk-'` 子串（这一版踩过）
 *
 * 空白名单搜整串的做法会把**说明文案**误判成泄漏：新版各家的「怎么配凭据」
 * 里有一句「要的是登录态 access token，不是 `sk-` 开头的平台 API Key」——
 * 那句话里就带着 `sk-`。而它恰恰是用户最需要读到的一句。
 *
 * 因此这里只认**凭据形态**：`Bearer <token>`、`sk-` 后面跟足够长的 key 字符、
 * 或 JWT（`eyJ…`）。漏掉说明文案、钉住真正的泄漏。
 */
const SECRET_SHAPES = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/, 'Bearer 令牌'],
  [/sk-[A-Za-z0-9_-]{16,}/, 'sk- 平台 Key'],
  [/eyJ[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/AKLT[A-Za-z0-9]{10,}/, '火山 AccessKey'],
]
/**
 * @param {string} text - 已序列化的响应。
 * @param {string} label - 出错时点名是哪条路由。
 * @returns {void}
 */
function assertNoSecrets(text, label) {
  for (const [pattern, name] of SECRET_SHAPES) {
    assert.ok(!pattern.test(text), `${label}里出现了疑似凭据内容（${name}）：${String(pattern)}`)
  }
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
  'period', 'periodClock', 'peakRule',
  // 时段口径的**例外**：法定节假日全天按空闲计费。缺这一项说明宿主还是旧口径，
  // 国庆那类日子的白天会被算成高峰、金额偏高两倍。
  'holidayCalendar',
  'sessionCost', 'calendarByDay', 'tieredRates', 'crossDeviceLedger',
  'balance', 'balanceToggle', 'thirdPartyPlans',
  // 「移除凭据」：查各家凭据现状 + 按用户勾选逐条移除。缺这一项说明宿主还是
  // 没有这条路由的旧版本，界面据此不画移除入口（而不是画一个必然失败的按钮）。
  'planCredentials',
  'notifyJournal', 'notifyThresholds',
  // 桌面端把窗口拉到前台的能力（dsh://open → focusPrimaryWindow）。
  'focusWindow',
  // 会话清单里的预览标题（与 DSH 侧栏同源）。旧的 id 片段用户对不上侧栏任何一个会话。
  'sessionTitle',
  // 单会话明细路由。缺这一项说明宿主还是旧版本，会话标签页据此显示
  // 「当前宿主不支持这条明细」，而不是画一张空表。
  'sessionDetail',
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
// 法定节假日表必须随规则一起下发：客户端要用它说明「哪几天按空闲计」与「收录到哪一年」。
// 断言的是**形状与关键日期**，不是整份表——否则每年更新日历时这条闸门都会无意义地红。
assert.ok(Array.isArray(payload.peakRule.holidays?.days), 'peakRule 应带上节假日表')
assert.ok(payload.peakRule.holidays.days.includes('2026-10-01'), '国庆首日必须在节假日表里')
assert.ok(Array.isArray(payload.peakRule.holidays?.years), '节假日表应说明收录了哪些年份')
assert.ok(payload.peakRule.note.includes('法定节假日'), '口径说明里必须写明法定节假日这一条')
assert.ok(payload.period !== undefined, '响应应含当前时段状态')
assert.equal(payload.offPeak, undefined, '旧的 offPeak 字段不应再出现')
assert.equal(typeof payload.ledger?.path, 'string', '响应应回报账本路径，便于确认跨设备同步是否生效')

// ── 单会话明细路由（会话标签页的取数口）───────────────────────────
const { UsageCatalog } = await import(pathToFileURL(join(root, 'lib', 'host.js')).href)
//
// 会话标签页要回答「这条会话花了多少、花在哪些模型上」。它与看板的口径必须
// **一致**（同一套分档计价），但又不能为此拉全量 `/data`。这里钉三件事：
//   1) 路由的三种错误形态（缺参 400 / 认不出 404 / 只读 405）；
//   2) 逐模型金额之和 == 响应里的合计（严格相等，用户一定会加一遍）；
//   3) 逐日金额之和与合计一致（两种分组各自取整，允许 1e-6 尾差，不放过 1% 级偏差）。
{
  const missingId = await call(sessionRoute, 'GET', '/dsh-pixel/session')
  assert.equal(missingId.statusCode, 400, '缺 id 参数应回 400，而不是给一份空明细')
  const unknownId = await call(sessionRoute, 'GET', '/dsh-pixel/session?id=session-does-not-exist')
  assert.equal(unknownId.statusCode, 404, '会话不存在应回 404（与「没有用量」是两件事）')
  const wrongMethod = await call(sessionRoute, 'POST', '/dsh-pixel/session?id=x')
  assert.equal(wrongMethod.statusCode, 405, '明细路由只读，POST 应回 405')

  // 造一条跨两天、两个模型的会话：一天高峰、一天国庆（空闲）。
  const peakDay = Date.parse('2026-09-30T02:00:00Z')
  const idleDay = Date.parse('2026-10-03T02:00:00Z')
  const sessionId = 'session-detail-0000-0000-000000000000'
  const detailEvents = [
    { type: 'turn/start', seq: 0, time: peakDay },
    {
      type: 'assistant/message',
      seq: 1,
      time: peakDay,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
        usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 400, cacheWriteTokens: 0 },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: idleDay,
      data: {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'glm-5.3' } },
        usage: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  ]
  const detailPersistence = {
    async list() {
      return [{ header: { id: sessionId, createdAt: peakDay, cwd: 'D:\\blog' }, revision: 'r1', eventCount: detailEvents.length }]
    },
    async open() {
      return {
        async read(offset = 0, length = 500) { return { events: detailEvents.slice(offset, offset + length) } },
        async close() {},
      }
    },
  }
  const ledgerFile = join(tmpdir(), `dsh-pixel-session-${process.pid}.jsonl`)
  rmSync(ledgerFile, { force: true })
  const detailCatalog = new UsageCatalog({
    persistence: () => detailPersistence,
    sessions: () => undefined,
    timezone: () => 'Asia/Shanghai',
    ledgerPath: ledgerFile,
  })
  const detail = await detailCatalog.readSessionDetail(sessionId)
  assert.ok(detail !== undefined, '有账本记录的会话应能取到明细')
  assert.equal(detail.session.id, sessionId)
  assert.equal(detail.entries.length, 2, '两个模型应各占一行')
  // 顺序：按金额降序，用户第一眼要看到最贵的那一行
  assert.ok(
    Number(detail.entries[0].cost.standard) >= Number(detail.entries[1].cost.standard),
    '逐模型明细应按金额降序',
  )
  // 每一行都必须是**该行自己**的金额（不是会话合计的复制）：两行金额相加要等于合计
  const entrySum = detail.entries.reduce((sum, entry) => sum + Number(entry.cost.standard ?? 0), 0)
  assert.equal(
    Math.round(entrySum * 1e6) / 1e6,
    detail.cost.standard,
    '逐模型金额之和必须严格等于响应里的合计',
  )
  const daySum = detail.days.reduce((sum, day) => sum + Number(day.cost.standard ?? 0), 0)
  assert.ok(
    Math.abs(daySum - detail.cost.standard) < 1e-5,
    `逐日金额之和应与合计一致（两种分组各自取整，允许 1e-6 尾差）：${daySum} vs ${detail.cost.standard}`,
  )
  assert.equal(detail.days.length, 2, '两天的用量应各占一行')
  // 分档必须真的分开：一天在节前工作日（高峰）、一天在国庆（空闲）
  assert.ok(Number(detail.cost.peak) > 0, '高峰那天应计入高峰档')
  assert.ok(Number(detail.cost.idle) > 0, '国庆那天应按空闲档计费')
  // 单价随明细下发：客户端不得自己按路由 id 去价目表查（查不到会静默回落 Flash 价）
  for (const entry of detail.entries) {
    assert.ok(detail.pricing.models[entry.key]?.rates !== undefined, `明细应带上 ${entry.key} 的单价`)
    assert.equal(entry.priced, true, `${entry.key} 在价目表里，应标为已定价`)
  }
  // 外显名 / 提供商名要能直接用，不必客户端再拼
  for (const entry of detail.entries) {
    assert.equal(typeof entry.label, 'string', '每行应带显示名')
    assert.equal(entry.provider, 'deepseek-official')
  }
  assert.equal(await detailCatalog.readSessionDetail('session-nope'), undefined, '认不出的会话应返回 undefined')
  rmSync(ledgerFile, { force: true })
}

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
  // 本段总长必须落在**真实可能**的区间里，而且高峰段与空闲段的界不一样：
  //   高峰段：最短 1 分钟（刚跨过边界）、最长 4 小时（14:00–18:00）；
  //   空闲段：最长是**长连休**，2026 年春节是 2/13（周五）18:00 → 2/24（周二）9:00，
  //          连着 255 小时。旧口径里最长只有周末 63 小时，把上界钉在 63 小时会让
  //          「跑在假期里的那一天」永远红——那是闸门本身错了，不是代码错了。
  if (phase.peak) {
    assert.ok(
      phase.periodMs <= 4 * 3600_000 + 1000,
      `高峰段最长 4 小时（14:00–18:00），实际 ${phase.periodMs / 60_000} 分钟`,
    )
  } else {
    assert.ok(
      phase.periodMs > 0 && phase.periodMs <= 255 * 3600_000 + 1000,
      `空闲段应落在 (0, 255 小时]（最长的是春节长连休），实际 ${phase.periodMs / 60_000} 分钟`,
    )
  }
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

const sampleCatalog = new UsageCatalog({
  persistence: () => samplePersistence,
  sessions: () => undefined,
  timezone: () => 'Asia/Shanghai',
})
const sample = await sampleCatalog.read()
rmSync(sandboxLedger, { force: true })

// ── 节假日口径：同一时刻的用量必须因「是不是法定节假日」而分到不同档 ────
// 这是这次改动的**行为契约**：国庆期间的周四白天原来算高峰、现在算空闲。
// 只断言「函数返回 false」不够——这条要走完账本 → 聚合 → 分档的整条路，
// 因为真正花钱的是聚合出来的 peak / idle 那两份 token。
{
  /** 造一份只有一条请求的假会话。 */
  const oneRequestAt = (time) => ({
    async list() {
      return [{ header: { id: 'session-holiday-0000-0000-000000000000', createdAt: time, cwd: 'D:\\blog' }, revision: 'r1', eventCount: 2 }]
    },
    async open() {
      const events = [
        { type: 'turn/start', seq: 0, time },
        {
          type: 'assistant/message',
          seq: 1,
          time,
          data: {
            turn: 1,
            step: 1,
            message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
            usage: { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        },
      ]
      return {
        async read(offset = 0, length = 500) { return { events: events.slice(offset, offset + length) } },
        async close() {},
      }
    },
  })
  /** 跑一次聚合，返回分档后的峰值 token。 */
  const peakTokensAt = async (iso, tag) => {
    const catalog = new UsageCatalog({
      persistence: () => oneRequestAt(Date.parse(iso)),
      sessions: () => undefined,
      timezone: () => 'Asia/Shanghai',
      ledgerPath: join(tmpdir(), `dsh-pixel-holiday-${process.pid}-${tag}.jsonl`),
    })
    const result = await catalog.read()
    return result.overview.totals.peak.cacheMiss
  }
  // 国庆里的周四 10:00（北京）：应为空闲 → 高峰档 0
  assert.equal(await peakTokensAt('2026-10-01T02:00:00Z', 'oct1'), 0, '国庆期间的白天不得计入高峰档')
  // 节前周三 10:00（北京）：同样的墙钟时刻与星期几，只是不在假期里 → 全额计入高峰档
  // （这条对照不能省：单看上面的 0，一个「永远返回 0」的实现也能通过。）
  assert.equal(await peakTokensAt('2026-09-30T02:00:00Z', 'sep30'), 1000, '节前工作日的白天应计入高峰档')
}

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
// 逐模型单价表：**两个键、两种形状** ——
//   复合键（`模型@提供商`）= 包装 `{rates, markup, currency}`，带该提供商的倍率；
//   裸键（`模型`）        = **裸 RATE**，代表官方价（看板把它当价目直接读字段）。
// 把裸键也做成包装会让看板的「我的价」三档全部取到 undefined、显示成 ¥0，
// 而界面上完全看不出异常——所以这里两种形状都要钉住。
const samplePriced = sample.pricing.models['deepseek-flash@deepseek-official']
assert.ok(samplePriced !== undefined, '按复合键应查得到单价')
assert.equal(samplePriced.rates, sample.models[0].rates, '复合键包装里的价目应与模型条目是同一个对象')
assert.equal(samplePriced.markup, 1, '没有配倍率时，提供商倍率必须是 1（不是 0，也不是缺省 undefined）')
const sampleOfficial = sample.pricing.models['deepseek-flash']
assert.equal(sampleOfficial, sample.models[0].rates, '裸键必须**就是**那份裸 RATE 对象（看板按价目直接读字段）')
assert.equal(typeof sample.pricing.usdToCny, 'number', '响应应带上美元折算汇率（界面要标出按汇率折算）')
assert.ok(sample.pricing.usdToCny > 0, '汇率必须是正数')
assert.equal(typeof sample.pricing.markup, 'object', '应带上提供商倍率表（按裸键查价时也要能显示倍率）')
assert.ok(sample.sessions[0].cost.standard > 0, '会话应带非零费用摘要')
assert.equal(sample.ledger.total, 1, '账本应记录一条')

// ── 「今天」必须由宿主按站点时区给出，不能拿 days.at(-1) 顶替 ──────
// 历史事故：卡片上的「今日费用」读的是 `days.at(-1)`，那是「最后一个有数据
// 的日子」。今天还没跑过请求时它就是昨天，于是「今日」显示的是昨天的数字。
// 这里钉住：overview.today 必须是**生成时刻所在的站点日**，且与 windows.today
// 同源（两者各算一次就会漂移）。
assert.equal(
  payload.overview.today,
  new Intl.DateTimeFormat('en-CA', { timeZone: payload.timezone }).format(new Date(payload.generatedAt)),
  'overview.today 必须是站点时区下的今天，而不是最后有数据的那天',
)
// 不写死日期（示例事件固定在 2026-09-10，而聚合跑在真实当前时刻），只钉住语义：
// `windows.today` 必须与 overview.today 在 days 里的那一行同源——今天没有事件
// 就是 0，**绝不能**退化成「最后有数据那天」的量。两者混同正是被报上来的故障。
{
  const todayRow = sample.days.find((row) => row.key === sample.overview.today)
  assert.equal(
    sample.windows.today.local,
    todayRow?.totals.local ?? 0,
    'windows.today 必须对应 overview.today 那一行，而不是最后有数据的那天',
  )
}

const rejected = await call(dataRoute, 'POST')
assert.equal(rejected.statusCode, 405, 'POST 应返回 405')

// ── 日历每格的消费估计：索引与口径都必须和日行**完全同源** ──────────
// 悬停某一格显示的是「那一天的消费估计」。两件事必须对上，否则用户会看到
// 「格子上的金额」与「日行里的金额」互相矛盾：
//   1. **索引**：`heatmap.costs[i]` 必须与 `heatmap.requests[i]` 是同一天
//      （同一套 day 序号），不是 `days` 那种稀疏数组；
//   2. **口径**：按每条请求**发生时刻**的时段分档算，与 `days[].cost` 一致。
{
  const first = Date.parse(`${sample.heatmap.firstDay}T00:00:00Z`)
  let matched = 0
  for (const row of sample.days) {
    const index = Math.round((Date.parse(`${row.key}T00:00:00Z`) - first) / 86_400_000)
    assert.ok(index >= 0 && index < sample.heatmap.days, `${row.key} 应落在日历范围内`)
    // **严格相等**，不是「近似相等」。早先这里是两处各算一遍：记录循环里逐条累加
    // 得到 2.1017944，而日行金额被 `sessionCost()` 四舍五入到 6 位得 2.101794。
    // 差的是尾数，却恰好落在用户会逐位比对的同一个数字上（实测 6 天里 5 天不一致）。
    // 现在日历金额是从 dayRows 派生的，因此必须**一位不差**。
    assert.equal(
      Number(sample.heatmap.costs[index]),
      Number(row.cost.standard),
      `日历第 ${index} 格（${row.key}）的消费估计必须与该日行金额完全相等`,
    )
    matched += 1
  }
  assert.ok(matched > 0, '示例数据应至少有一天，否则这条断言是空转')
  // 空日历格必须是 0（不是 undefined）：客户端按 day 序号直接取，
  // undefined 会让悬停显示成 `NaN` 或空白。
  assert.equal(sample.heatmap.costs.length, sample.heatmap.days, 'costs 的长度应与日历天数一致')
  assert.ok(
    sample.heatmap.costs.every((value) => Number.isFinite(Number(value))),
    'costs 里不得有非有限值（客户端会直接渲染它）',
  )
  // 「有数据的日行都写进了对应的格」：格里的钱不能凭空出现，
  // 也不能有日行漏掉（漏掉就是悬停显示 —，而那天明明有消费）。
  const dayTotal = sample.days.reduce((sum, row) => sum + Number(row.cost.standard), 0)
  const cellTotal = sample.heatmap.costs.reduce((sum, value) => sum + Number(value), 0)
  assert.ok(
    Math.abs(dayTotal - cellTotal) < 1e-9,
    `日历格金额之和应等于日行金额之和：${cellTotal} vs ${dayTotal}`,
  )
}

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
// 登录态：界面据此决定「显示金额」还是「显示未登录 + 官网入口」。
// 它必须是布尔而不是 undefined：客户端拿 undefined 会当成"未知"，
// 于是既不敢显示金额、也不敢说未登录，最后什么也不显示。
assert.equal(balancePayload.signedIn, false,
  '拿不到官方凭据时应明确回报 signedIn:false（界面据此不发请求、显示未登录）')

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
assert.equal(configured.endpoint().settingsVia, 'legacy', '旧版 get(ns) 路径应被认出并标注为 legacy')

// ── settings 的两代 API：0.1.7 删掉了 get(ns)，只剩 describe() ──────────────
// 这是本次兼容性修复的核心。DSH 0.1.7 把 settings 换成「投影 profile 条目 Config 的
// 表单服务」：get/register/installSection 全没了。旧代码的 `?.get?.()` 会把
// 「API 没了」静默吞成 undefined，于是用户配的自定义端点被无声忽略——数字照常
// 显示，只是答错了问题。以下三条钉住：新版能读到、读不到时降级可见、绝不静默。
const { readSettingsSection } = await import(pathToFileURL(join(root, 'lib', 'balance.js')).href)
const modern = new BalanceService({
  credentials: () => undefined,
  // 新版 settings：只有 describe()，没有 get()
  settings: () => ({
    describe: () => [
      { ns: 'some-other-entry', value: { baseURL: 'https://ignore.example' } },
      { ns: 'llm-deepseek', value: { baseURL: 'https://proxy.internal', apiKeyEnv: 'MY_KEY' } },
    ],
  }),
  prefsPath: sandboxPrefs,
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
})
assert.equal(modern.endpoint().settingsVia, 'entry', '0.1.7 的 describe() 路径必须被认出来')
assert.equal(modern.endpoint().baseURL, 'https://proxy.internal', '新版 describe() 里的 baseURL 应被采纳')
assert.equal(modern.endpoint().apiKeyEnv, 'MY_KEY', '新版 describe() 里的凭据引用应被采纳')
// describe() 找不到该条目 = 该 profile 确实没配这一项，属于正常空状态，不该报警
assert.equal(
  readSettingsSection({ describe: () => [] }, 'llm-deepseek').via,
  'entry',
  'describe() 里没有这一条属于「确实没配」，不是读不懂',
)
// 两代 API 都没有 → **必须**报 unreadable，而不是伪造成「没配置」
const unknownApi = readSettingsSection({ someOtherMethod: () => {} }, 'llm-deepseek')
assert.equal(unknownApi.via, 'unreadable', '认不出的 settings API 必须回报 unreadable')
assert.ok(
  typeof unknownApi.error === 'string' && unknownApi.error !== '',
  'unreadable 必须带一句可读的原因，界面靠它说明降级',
)
assert.equal(
  readSettingsSection(undefined, 'llm-deepseek').via,
  'absent',
  '服务整体缺失属于 absent（用户本来也无处配置），不该报成 unreadable',
)
// describe() 抛错时必须回落旧 get，而不是直接判定失败
const describeThrows = readSettingsSection({
  describe: () => { throw new Error('descriptor boom') },
  get: () => ({ baseURL: 'https://fallback.internal' }),
}, 'llm-deepseek')
assert.equal(describeThrows.via, 'legacy', 'describe() 抛错应回落旧 get() 路径')
assert.equal(describeThrows.value.baseURL, 'https://fallback.internal', '回落路径要能真的取到值')
// 端点事实必须把「这是猜的」带出去：界面据此把降级显示出来
const unreadableService = new BalanceService({
  credentials: () => undefined,
  settings: () => ({ someOtherMethod: () => {} }),
  prefsPath: sandboxPrefs,
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
})
assert.equal(unreadableService.endpoint().settingsVia, 'unreadable', '端点推导应如实标注 unreadable')
assert.equal(unreadableService.endpoint().baseURL, 'https://api.deepseek.com', '读不到 settings 时仍回落官方端点')
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
// 六家：现金余额只有 DeepSeek 官方（走 /balance），套餐额度就这六家。
// 清单要**完整**：少一家等于界面上干脆没有那家的入口；多一家等于画一个永远
// 取不到数的块。新增厂商时这里必须显式改一行。
assert.deepEqual(
  plansPayload.providers.map((provider) => provider.id).sort(),
  ['codex', 'commandcode', 'cursor', 'opencode', 'volcengine', 'zhipu'],
  '应包含智谱、Command Code、火山方舟、Codex、Cursor、Opencode 六家',
)
// 预检环境既没有 DSH 凭据服务、也没有相关环境变量。
//
// **但有三家会读别的 App 的登录态**（Codex 的 `~/.codex/auth.json`、Cursor 的
// `auth.json`、Opencode 的 `auth.json`）。开发机上这些文件很可能真的存在，
// 于是它们会去发一次真实请求并失败——那是如实反映「本机有登录态但取数失败」，
// 与「没配凭据」是两种处境，因此这里不把 reason 钉死成 no-key，而是钉住
// 「一定要给出一个可解释的原因」＋「绝不能把凭据本身漏出来」。
const PLAN_FAILURE_REASONS = ['no-key', 'rejected', 'request-failed', 'unsupported']
for (const provider of plansPayload.providers) {
  assert.equal(provider.ok, false, `${provider.id} 未配 Key 时不应报成功`)
  assert.ok(
    PLAN_FAILURE_REASONS.includes(provider.reason),
    `${provider.id} 的失败原因应可解释（${PLAN_FAILURE_REASONS.join(' / ')}），实际 ${provider.reason}`,
  )
  assert.ok(Array.isArray(provider.windows), `${provider.id} 的 windows 应是数组`)
  // 每家都要能说清「我的凭据从哪来、去哪拿」——只有原因没有下一步，用户会卡死。
  assert.equal(typeof provider.setup?.keyURL, 'string', `${provider.id} 应给出凭据获取地址`)
}
// 没有任何 CLI 登录态可读的两家必须仍是 no-key（这条与上面互为对照：
// 谁都报 request-failed 就说明「缺凭据」这条分支根本没人走通）。
for (const id of ['zhipu', 'volcengine']) {
  const provider = plansPayload.providers.find((item) => item.id === id)
  assert.equal(provider.reason, 'no-key', `${id} 没有可自动发现的凭据文件，应回报 no-key`)
}
// 凭据绝不能出现在响应里。这一条与环境无关，而且比「reason 是 no-key」更要紧
// ——漏一次就是永久泄漏。
assertNoSecrets(JSON.stringify(plansPayload), '套餐响应')
// 智谱官方只有 5 小时与每周，**没有**月度；这一条要留在数据里让界面解释清楚
const zhipu = plansPayload.providers.find((provider) => provider.id === 'zhipu')
assert.deepEqual(zhipu.supportedWindows, ['fiveHour', 'weekly'], '智谱只有 5 小时与每周窗口')
const commandCode = plansPayload.providers.find((provider) => provider.id === 'commandcode')
assert.deepEqual(commandCode.supportedWindows, ['fiveHour', 'weekly', 'monthly'], 'Command Code 应有三个窗口')
// 隐私闸门：套餐响应里绝不能出现凭据的**值**（只看凭据形态，见 assertNoSecrets）。
assertNoSecrets(JSON.stringify(plansPayload), '套餐响应')

// 解析器：用假响应验窗口归类与「缺失不显示成 0」
const plansModule = await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)
const {
  parseZhipuQuota, parseCommandCodeCredits, maskSecret, readCommandCodeKey,
  deriveKeyRef, COMMAND_CODE_KEY_ENVS, commandCodePlanInfo, COMMAND_CODE_USAGE_PATH,
  COMMAND_CODE_CAP_TOLERANCE,
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

// ── 套餐身份（planId）与月度百分比 ──────────────────────────────
// 用户报过：能配好套餐、5 小时与每周都正常，**只有月度永远是 0%**。
// 根因是三件事叠在一起：credits 接口对月度只给「剩余」（裸数字），宿主因此算不出
// 百分比，而客户端把「不知道」兜底成了 0。修法是补齐另外两个接口：
//   `subscriptions` 给 planId（套餐身份 → 名义月额度与显示名），
//   `usage/summary` 给「本计费周期已用」。
// 这一组断言钉的就是这三者拼起来的口径。
assert.ok(COMMAND_CODE_USAGE_PATH.endsWith('/usage/summary'),
  `月度已用要去用量汇总接口取，实际路径 ${COMMAND_CODE_USAGE_PATH}`)

// 套餐表：Go / GOAT 的月额度必须不同——这正是用户问的那点
assert.equal(commandCodePlanInfo('individual-go')?.name, 'Go')
assert.equal(commandCodePlanInfo('individual-go')?.monthlyCredits, 10, 'Go 是 $10/月')
assert.equal(commandCodePlanInfo('individual-goat')?.name, 'GOAT')
assert.equal(commandCodePlanInfo('individual-goat')?.monthlyCredits, 70, 'GOAT 是 $70/月')
assert.equal(commandCodePlanInfo('individual-go')?.monthlyCredits
  !== commandCodePlanInfo('individual-goat')?.monthlyCredits, true, 'Go 与 GOAT 的额度不得混同')
// 只按完整 id 精确匹配：老一代 Pro 是 $30，现在的 Pro（v1）是 $80。
// 前缀匹配会让新套餐继承旧额度，然后整整一个计费周期的百分比都是错的。
assert.equal(commandCodePlanInfo('individual-pro')?.monthlyCredits, 30, '老一代 Pro 是 $30')
assert.equal(commandCodePlanInfo('individual-pro-v1')?.monthlyCredits, 80, '现在的 Pro 是 $80')
assert.equal(commandCodePlanInfo('individual-pro-v2'), undefined, '未收录的代次不得继承上一代的额度')
assert.equal(commandCodePlanInfo('individual-max')?.monthlyCredits, 150, 'Max 10× 是 $150')
assert.equal(commandCodePlanInfo('individual-ultra')?.monthlyCredits, 300, 'Max 20× 是 $300')
assert.equal(commandCodePlanInfo('teams-pro')?.monthlyCredits, 40, 'Team Pro 是 $40')
assert.equal(commandCodePlanInfo('individual_goat')?.name, 'GOAT', '下划线写法应归一')
assert.equal(commandCodePlanInfo(undefined), undefined)
assert.equal(commandCodePlanInfo(''), undefined)
assert.ok(COMMAND_CODE_CAP_TOLERANCE > 0 && COMMAND_CODE_CAP_TOLERANCE < 1, '容差应是比例而不是绝对值')

// 真实账号的形状（2026-09 实测）：月度只有剩余余额，已用在用量汇总接口里
//
// **重置时刻必须用「相对未来」的日期，不能写死一个具体日期。** 这里原先写的是
// `2026-10-14T12:26:13.000Z`（就是当时实测到的那个计费周期末），而下面有一条
// 断言要求它是「未来的毫秒时间戳」——于是日期一过，闸门自己就红了，
// 与任何代码改动都无关。这种「时间炸弹」最难排查：现象是某一天突然全红，
// 而 git diff 里什么都没有。改成相对时间后，这条用例永远只在验契约本身
// （ISO 串能不能被解析成未来时刻），不再依赖今天几号。
const futurePeriodEnd = new Date(Date.now() + 9 * 86_400_000).toISOString()
const ccLive = parseCommandCodeCredits({
  credits: { belowThreshold: false, monthlyCredits: 65.5512769625, freeCredits: 0, purchasedCredits: 0 },
  windowLimits: {
    limited: true,
    fiveHour: { used: 0.094074736, cap: 14, exceeded: false, resetAt: 1_789_880_547_252 },
    weekly: { used: 4.4487230375, cap: 35, exceeded: false, resetAt: 1_789_994_691_968 },
  },
}, {
  success: true,
  data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: futurePeriodEnd },
}, {
  totalCount: 1350,
  totalCredits: 4.429013998500001,
  totalMonthlyCredits: 4.429013998500001,
  periodBasis: 'billing-period',
})
assert.equal(ccLive.plan, 'GOAT', 'planId 应归一成套餐显示名')
assert.equal(ccLive.planId, 'individual-goat', 'planId 也要原样交下来供诊断')
const ccLiveMonth = ccLive.windows.find((win) => win.window === 'monthly')
assert.equal(ccLiveMonth.used, 4.43, '月度已用应来自用量汇总接口（4.429 → 4.43）')
assert.equal(ccLiveMonth.total, 69.98, '月度总额 = 已用 + 剩余（69.9803 → 69.98）')
assert.equal(ccLiveMonth.remaining, 65.55, '月度剩余来自 credits 的裸数字')
assert.equal(ccLiveMonth.usedPercent, 6.33, `月度真实已用约 6.33%，实际 ${ccLiveMonth.usedPercent}`)
assert.notEqual(ccLiveMonth.usedPercent, 0, '月度百分比绝不能是 0（那是「未知被画成 0」的老毛病）')
// 月度的**重置时刻**也必须到手。用户报过：「看不出月额度多久后重置」——
// 5 小时与每周都带 resetAt，月度却只能靠 `subscriptions` 的 `currentPeriodEnd`，
// 而那个字段是 **ISO 日期串**（`"2026-10-14T12:26:13.000Z"` 这种形状），不是数字时间戳。
// 早先 `normalizeEpoch` 只认数字，ISO 串被静默读成 undefined：不报错、不显示 0，
// 只是月度那一栏永远少一句「多久后重置」——最容易被当成「本来就没有」的形态。
assert.equal(ccLiveMonth.resetAt, Date.parse(futurePeriodEnd),
  '月度重置时刻必须能从 ISO 串的 currentPeriodEnd 解析出来（这正是用户报的那个缺失）')
assert.ok(Number.isFinite(ccLiveMonth.resetAt) && ccLiveMonth.resetAt > Date.now(),
  '月度重置时刻应是未来的毫秒时间戳')
// 数字形状**不能**因为新增 ISO 支持而回归：秒/毫秒都照旧
const ccEpochShapes = parseCommandCodeCredits(
  { credits: { monthlyCredits: { used: 1, cap: 10, resetAt: 1_790_000_000_000 } } },
  { data: { planId: 'individual-goat', currentPeriodEnd: futurePeriodEnd } },
)
const ccEpochMonth = ccEpochShapes.windows.find((win) => win.window === 'monthly')
assert.equal(ccEpochMonth.resetAt, 1_790_000_000_000, '数字毫秒时间戳照旧优先于订阅周期')
// 秒级数字仍按秒换算（而不是当成 1970 年的毫秒）
const ccSeconds = parseCommandCodeCredits(
  { credits: { monthlyCredits: { used: 1, cap: 10 } } },
  { data: { planId: 'individual-goat', currentPeriodEnd: 1_781_000_000 } },
)
assert.equal(ccSeconds.windows.find((win) => win.window === 'monthly').resetAt, 1_781_000_000_000,
  '秒级时间戳仍应 ×1000；ISO 支持不得改变这条既有口径')
// 既不是数字也不是合法日期时不编造时刻（宁可没有倒计时，也不显示假的）
const ccNoReset = parseCommandCodeCredits(
  { credits: { monthlyCredits: { used: 1, cap: 10 } } },
  { data: { planId: 'individual-goat', currentPeriodEnd: '不是日期' } },
)
assert.equal(ccNoReset.windows.find((win) => win.window === 'monthly').resetAt, undefined,
  '认不出的时刻应留 undefined，而不是编一个出来')

// 用量汇总接口取不到时：有套餐身份就按名义额度反推，并把「这是推算」说出来
const ccNoUsage = parseCommandCodeCredits(
  { credits: { monthlyCredits: 65.5512769625 } },
  { data: { planId: 'individual-goat' } },
)
const ccNoUsageMonth = ccNoUsage.windows.find((win) => win.window === 'monthly')
assert.equal(ccNoUsageMonth.total, 70, '没有用量接口时应回落到套餐名义额度')
assert.equal(ccNoUsageMonth.used, 4.45, '已用 = 名义额度 - 剩余（4.4487 → 4.45）')
assert.equal(ccNoUsageMonth.usedPercent, 6.36, `按名义额度算出的百分比，实际 ${ccNoUsageMonth.usedPercent}`)
assert.ok(String(ccNoUsageMonth.note).includes('名义额度'), '推算出来的百分比必须标注来源，不能伪装成官方数字')

// Go 套餐（$10）：同一套逻辑，额度更小
const ccGo = parseCommandCodeCredits({ credits: { monthlyCredits: 9 } }, { data: { planId: 'individual-go' } })
const ccGoMonth = ccGo.windows.find((win) => win.window === 'monthly')
assert.equal(ccGoMonth.total, 10, 'Go 的月度总额应是 $10 而不是 $70')
assert.equal(ccGoMonth.usedPercent, 10, 'Go：已用 1/10 = 10%')

// 未收录的套餐：没有名义额度可推算，但「已用 + 剩余」仍能给出百分比
const ccUnknownPlan = parseCommandCodeCredits(
  { credits: { monthlyCredits: 30 } },
  { data: { planId: 'individual-future' } },
  { totalMonthlyCredits: 10 },
)
const ccUnknownMonth = ccUnknownPlan.windows.find((win) => win.window === 'monthly')
assert.equal(ccUnknownPlan.plan, 'individual-future', '未收录的档位原样报 id，也比空白强')
assert.equal(ccUnknownMonth.usedPercent, 25, '没有名义额度时用「已用 + 剩余」算（10/40）')

// 跨计费周期 / 换套餐：两个接口的两个数不属于同一周期时，**一个百分比都不给**
const ccMismatch = parseCommandCodeCredits(
  { credits: { monthlyCredits: 200 } },
  { data: { planId: 'individual-goat' } },
  { totalMonthlyCredits: 300 },
)
const ccMismatchMonth = ccMismatch.windows.find((win) => win.window === 'monthly')
assert.equal(ccMismatchMonth.usedPercent, undefined, '对不上名义额度时不得给百分比')
assert.equal(ccMismatchMonth.used, undefined, '对不上时也不能给出「已用」这个假事实')
assert.equal(ccMismatchMonth.total, undefined, '对不上时不能给出总额')
assert.equal(ccMismatchMonth.remaining, 200, '能确定的那一项（剩余余额）照常给')
assert.ok(String(ccMismatchMonth.note).includes('对不上'), '不给百分比时必须说明原因，界面据此显示 —')

// 买过充值信用额：基线要把 free / purchased 一起算，否则整个周期都拿不到百分比
const ccPurchased = parseCommandCodeCredits(
  { credits: { monthlyCredits: 120, freeCredits: 0, purchasedCredits: 100 } },
  { data: { planId: 'individual-goat' } },
  { totalMonthlyCredits: 50 },
)
const ccPurchasedMonth = ccPurchased.windows.find((win) => win.window === 'monthly')
assert.equal(ccPurchasedMonth.total, 170, '充值过的账号：总额 = 已用 + 剩余')
assert.equal(ccPurchasedMonth.usedPercent, 29.41, `50/170 = 29.41%，实际 ${ccPurchasedMonth.usedPercent}`)

// 剩余比名义额度还大（换套餐当天等）：既不推算，也不生成负数已用
const ccOverNominal = parseCommandCodeCredits(
  { credits: { monthlyCredits: 80 } },
  { data: { planId: 'individual-goat' } },
)
const ccOverNominalMonth = ccOverNominal.windows.find((win) => win.window === 'monthly')
assert.equal(ccOverNominalMonth.usedPercent, undefined, '剩余超过名义额度时不得反推出负数已用')
assert.equal(ccOverNominalMonth.remaining, 80, '剩余照实显示')

// 端到端（注入 fetch）：三个接口都要真的发出去，月度百分比随之出现——
// 只调 credits 那一个接口，正是「月度永远 0%」的成因。
const ccRequests = []
const ccService = new plansModule.PlansService({
  credentials: () => ({
    resolve: async (ref) => (ref === 'COMMAND_CODE_API_KEY'
      ? { value: 'user_cc_e2e_0123456789', source: 'file' }
      : undefined),
  }),
  prefs: async () => ({ plansEnabled: true }),
  env: {},
  fetchImpl: async (url, init) => {
    ccRequests.push({ url, auth: init?.headers?.authorization })
    const json = (body) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    if (url.endsWith('/alpha/billing/credits')) {
      return json({
        credits: { monthlyCredits: 65.5512769625, freeCredits: 0, purchasedCredits: 0 },
        windowLimits: { fiveHour: { used: 0.09, cap: 14, resetAt: 1_789_880_547_252 } },
      })
    }
    if (url.endsWith('/alpha/billing/subscriptions')) {
      return json({ success: true, data: { planId: 'individual-goat', currentPeriodEnd: futurePeriodEnd } })
    }
    if (url.endsWith('/alpha/usage/summary')) return json({ totalMonthlyCredits: 4.429013998500001 })
    return new Response('{}', { status: 404 })
  },
})
const ccEnd = (await ccService.read({ refresh: true })).providers.find((item) => item.id === 'commandcode')
assert.equal(ccEnd.ok, true, `Command Code 应取数成功：${JSON.stringify(ccEnd)}`)
assert.equal(ccEnd.plan, 'GOAT', '卡片上的套餐徽标应显示 GOAT')
assert.equal(ccEnd.planId, 'individual-goat')
const ccEndMonth = ccEnd.windows.find((win) => win.window === 'monthly')
assert.equal(ccEndMonth.usedPercent, 6.33, `端到端月度百分比应算出来，实际 ${ccEndMonth.usedPercent}`)
assert.ok(ccRequests.some((item) => item.url.endsWith('/alpha/usage/summary')),
  '必须请求用量汇总接口——少了它月度只有剩余余额，界面就只能显示 —')
assert.ok(ccRequests.some((item) => item.url.endsWith('/alpha/billing/subscriptions')),
  '必须请求订阅接口拿 planId')
// 隐私：Key 只能出现在 Authorization 头里，响应体里一个字节都不能有
assert.ok(!JSON.stringify(ccEnd).includes('user_cc_e2e_0123456789'), '响应里泄露了 Command Code Key')
assert.ok(ccRequests.every((item) => String(item.auth ?? '').startsWith('Bearer ')),
  'Command Code 的鉴权必须是 Bearer 头')

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

// ── 「去哪拿、配到哪」必须随数据交下来（用户报过的坑）─────────────
// 只写「请配成 VOLC_ACCESS_KEY_ID」是不够的：DSH 的设置界面只写它自己派生的
// `<路由>_API_KEY`，用户**根本找不到能填这个名字的输入框**。所以每一家都必须带上
// 一条**可点的创建链接**和一个**列出确切引用名**的说明块。
{
  const { resolveCredentialFilePath } = await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)
  assert.equal(
    resolveCredentialFilePath({ DSH_HOME: 'C:\\Users\\x\\.dsh' }),
    join('C:\\Users\\x\\.dsh', '.credentials.yaml'),
    '凭据文件路径应落在 DSH_HOME 下',
  )
  assert.equal(
    resolveCredentialFilePath({ USERPROFILE: 'C:\\Users\\x' }),
    join('C:\\Users\\x', '.dsh', '.credentials.yaml'),
    '没有 DSH_HOME 时退回 ~/.dsh',
  )
  // 两者都没有时退回 OS 的 homedir()——这是 DSH 自己的规则，
  // 不是「猜」：凭据文件总得落在一个确定的地方。
  assert.equal(
    resolveCredentialFilePath({}),
    join(homedir(), '.dsh', '.credentials.yaml'),
    '既没有 DSH_HOME 也没有 USERPROFILE 时应退回 OS 主目录',
  )

  // 三家都要有 setup，且必须能回答「去哪拿」和「配到哪」
  for (const provider of volcPayload.providers) {
    const setup = provider.setup
    assert.ok(setup !== undefined, `${provider.id} 缺少 setup（用户无从知道去哪拿凭据）`)
    assert.ok(setup.keyURL.startsWith('https://'), `${provider.id} 的 setup.keyURL 应是可点链接`)
    assert.ok(setup.acquire.length > 0, `${provider.id} 的 setup 应给出获取步骤`)
    assert.ok(setup.refs.length > 0, `${provider.id} 的 setup 应列出确切的凭据引用名`)
    for (const ref of setup.refs) {
      assert.ok(ref.name !== '' && ref.example !== '', `${provider.id} 的凭据项应有名字与示例`)
      // 引用名必须与真实解析的名字一致，否则用户照着配还是配不上
      assert.ok(
        provider.keyRef === undefined || ref.name === provider.keyRef || ref.note !== '',
        `${provider.id} 的凭据项 ${ref.name} 应说明它是什么`,
      )
    }
  }

  // 火山那一条**绝不能**把方舟推理控制台当作 AK 获取入口：
  // 那个页面给的是 `ark-` 推理 Key，正是本接口在网关格式层拒绝的那一把。
  const volcSetup = volcProvider.setup
  assert.ok(
    volcSetup.keyURL.includes('iam/keymanage'),
    `火山的 AK 获取入口应是 IAM 的 API 访问密钥页，实际 ${volcSetup.keyURL}`,
  )
  assert.ok(
    !volcSetup.keyURL.includes('console.volcengine.com/ark'),
    '火山的 AK 获取入口不得指向方舟推理控制台（那里只有 ark- 推理 Key）',
  )
  assert.ok(
    volcSetup.acquire.join(' ').includes('不在方舟控制台'),
    '火山必须明说这个页面不在方舟控制台里——这是用户找不到 AK 的根本原因',
  )
  // 「配到哪」：负载里要带上这台机器的凭据文件路径
  assert.equal(
    volcPayload.credentialFile,
    resolveCredentialFilePath({}),
    '负载应带上本机凭据文件路径，供界面直接显示',
  )
}

// ── 移除套餐凭据：清单、逐条勾选、以及三条「不能撒谎」的规则 ──────────
// 这是本插件唯一会**删掉用户密钥**的功能，因此闸门要钉住的不只是「能删」，
// 更是三种**删不掉**的情形必须被如实说清，而不是报成功。
{
  const plansForCreds = await import(pathToFileURL(join(root, 'lib', 'plans.js')).href)
  const {
    planVendorInventory, removableOf, blockedReasonOf, credentialSourceLabel,
    PlansService, ZHIPU_KEY_ENVS, COMMAND_CODE_KEY_ENVS, VOLC_AK_ENVS, VOLC_SK_ENVS,
    CODEX_TOKEN_ENVS, CODEX_ACCOUNT_ENVS, CURSOR_TOKEN_ENVS, OPENCODE_KEY_ENVS, OPENCODE_WORKSPACE_ENVS,
  } = plansForCreds

  // 1) 清单必须**覆盖各家解析时真正会试的全部候选名**。
  //    漏一个的后果最严重：用户点了移除，那家照样能解析到 Key，界面却显示已移除。
  const inventory = planVendorInventory()
  // 六家：与 `/plans` 的 provider 清单必须**同一组**（两处各写一份就会漂移，
  // 而漂移的表现是「某个厂商的凭据删不掉，界面上却根本不提它的移除入口」）。
  assert.deepEqual(
    inventory.map((vendor) => vendor.id),
    ['zhipu', 'commandcode', 'volcengine', 'codex', 'cursor', 'opencode'],
    '移除清单应覆盖六家',
  )
  const refsOfVendor = (id) => new Set(inventory.find((item) => item.id === id).refs.map((item) => item.name))
  for (const name of ZHIPU_KEY_ENVS) {
    assert.ok(refsOfVendor('zhipu').has(name), `移除清单漏了智谱的候选名 ${name}`)
  }
  for (const name of COMMAND_CODE_KEY_ENVS) {
    assert.ok(refsOfVendor('commandcode').has(name), `移除清单漏了 Command Code 的候选名 ${name}`)
  }
  for (const name of [...VOLC_AK_ENVS, ...VOLC_SK_ENVS]) {
    assert.ok(refsOfVendor('volcengine').has(name), `移除清单漏了火山的候选名 ${name}`)
  }
  // 三家新厂商同样要「试哪些名字就列哪些名字」——漏一个同样是「点了移除还读得到」。
  const NEW_VENDOR_REFS = {
    codex: [...CODEX_TOKEN_ENVS, ...CODEX_ACCOUNT_ENVS],
    cursor: [...CURSOR_TOKEN_ENVS],
    opencode: [...OPENCODE_KEY_ENVS, ...OPENCODE_WORKSPACE_ENVS],
  }
  for (const [id, names] of Object.entries(NEW_VENDOR_REFS)) {
    for (const name of names) {
      assert.ok(refsOfVendor(id).has(name), `移除清单漏了 ${id} 的候选名 ${name}`)
    }
  }
  // 反向：清单里也不该有各家解析时根本不会试的名字（删一个无关的键同样是越权）
  const allCandidates = new Set([
    ...ZHIPU_KEY_ENVS, ...COMMAND_CODE_KEY_ENVS, ...VOLC_AK_ENVS, ...VOLC_SK_ENVS,
    ...CODEX_TOKEN_ENVS, ...CODEX_ACCOUNT_ENVS, ...CURSOR_TOKEN_ENVS,
    ...OPENCODE_KEY_ENVS, ...OPENCODE_WORKSPACE_ENVS,
  ])
  for (const vendor of inventory) {
    for (const item of vendor.refs) {
      assert.ok(allCandidates.has(item.name), `移除清单里的 ${item.name} 并不是任何一家的候选名`)
      assert.ok(item.purpose !== '', `${item.name} 应说明它是什么`)
    }
  }
  // Command Code 的 CLI 密钥文件必须出现在清单里：不列出来，用户清完文件里那把
  // 之后插件照样读得到 CLI 那把，界面上却是「未配」——自相矛盾。
  assert.equal(
    inventory.find((item) => item.id === 'commandcode').cliFile,
    true,
    'Command Code 必须带上 CLI 凭据文件那一条',
  )

  // 2) 「能不能删」必须按**来源层**判断，而不是「有凭据服务就能删」。
  //    三种层的实际效果完全不同：
  //      file        → 真正删掉那一行                     → 可移除
  //      env         → 抛错（上游 assertUnshadowed）      → 不可移除
  //      *-env(.env) → **静默空操作**，删完照样回落该文件 → 不可移除
  assert.equal(removableOf('file'), true, '凭据文件层应可移除')
  assert.equal(removableOf('credentials'), true, '凭据服务层应可移除')
  assert.equal(removableOf('env'), false, '启动环境变量层不可移除（写入会被上游拒绝）')
  assert.equal(removableOf('project-env'), false,
    '项目 .env 层不可移除——unset 对它是静默空操作，报成功就是撒谎')
  assert.equal(removableOf('user-env'), false, '<DSH_HOME>/.env 层不可移除，理由同上')
  assert.ok(blockedReasonOf('env').includes('环境变量'), '不可移除时必须说清原因')
  assert.ok(blockedReasonOf('project-env').includes('.env'), '不可移除时必须指出该去改哪个文件')
  assert.equal(blockedReasonOf('file'), '', '可移除时不该有「改不了」的说明')
  assert.equal(credentialSourceLabel('env').includes('改不了'), true,
    '来源层的说明本身就要点明插件改不了这一层')

  // 3) 路由行为：清单只读，且如实回报「这台机器上能不能写」
  const emptyPayload = JSON.parse((await call(credsRoute)).body)
  assert.equal(emptyPayload.writable, false,
    '预检的 ctx 没有 credentials 服务，应如实回报不可写（而不是假装能删）')
  assert.equal(emptyPayload.providers.length, 6, '清单应列出六家')
  // 只看凭据形态：清单里必然会出现引用名（如 `CODEX_ACCESS_TOKEN`）与说明文案，
  // 那些不是泄漏；真正不许出现的是凭据的值。
  assertNoSecrets(JSON.stringify(emptyPayload), '凭据清单')
  for (const provider of emptyPayload.providers) {
    for (const ref of provider.refs) {
      assert.equal(ref.configured, false, `${ref.name} 在预检环境里应是未配置`)
      assert.equal(ref.removable, false, `${ref.name} 未配置时不该是可移除的`)
    }
  }
  // 白名单：拒绝清单之外的引用名（这条路由从浏览器可达，不能凭一个字符串删任意键）
  const notAllowed = JSON.parse((await call(credsRoute, 'POST', credsRoute.path, { refs: ['PATH'] })).body)
  assert.equal(notAllowed.results[0].ok, false, '不在白名单里的引用名必须被拒绝')
  assert.equal(notAllowed.results[0].reason, 'not-allowed')
  // 没有可写的凭据服务时说清楚，而不是静默当成功
  const noService = JSON.parse((await call(credsRoute, 'POST', credsRoute.path, { refs: ['VOLC_ACCESS_KEY_ID'] })).body)
  assert.equal(noService.results[0].ok, false, '没有凭据服务时不得报成功')
  assert.equal(noService.results[0].reason, 'no-service')
  // 请求体校验与同源闸门
  assert.equal((await call(credsRoute, 'POST', credsRoute.path, { refs: 'VOLC_ACCESS_KEY_ID' })).statusCode, 400,
    'refs 必须是数组')
  assert.equal(
    (await call(credsRoute, 'POST', credsRoute.path, { refs: ['VOLC_ACCESS_KEY_ID'] }, { 'sec-fetch-site': 'cross-site' })).statusCode,
    403,
    '跨站请求不得触发删除',
  )

  // 4) 真正的移除：用假凭据服务驱动，验「删对了哪一层」与「删不掉时怎么说」
  const attempts = []
  /** 造一个可控的凭据服务；`store` 决定每条引用名来自哪一层。 */
  const fakeService = (store) => new PlansService({
    credentials: () => ({
      resolve: async (ref) => (store[ref] === undefined
        ? undefined
        : { value: store[ref].value, source: store[ref].source }),
      describe: async (ref) => ({ configured: store[ref] !== undefined, writable: store[ref]?.source === 'file' }),
      unset: async (ref) => {
        attempts.push(ref)
        if (store[ref] === undefined) return
        // 照抄 DSH 的真实语义：env 层抛错、.env 层静默不动、file 层删掉
        if (store[ref].source === 'env') {
          throw new Error(`credentials-local: "${ref}" is supplied read-only by the launching environment`)
        }
        if (store[ref].source === 'file') delete store[ref]
      },
    }),
    prefs: async () => ({ plansEnabled: true }),
    env: {},
    fetchImpl: async () => { throw new Error('不该发请求') },
  })

  // 4a) file 层：真删掉，并回报成功
  const fileStore = { VOLC_ACCESS_KEY_ID: { value: 'AKLTaaaaaaaaaaaaaaaa', source: 'file' } }
  const fileResult = await fakeService(fileStore).removeCredentials(['VOLC_ACCESS_KEY_ID'])
  assert.equal(fileResult.results[0].ok, true, '凭据文件层应能真正移除')
  assert.equal(fileStore.VOLC_ACCESS_KEY_ID, undefined, '凭据文件层应被真正删掉')
  assert.equal(
    fileResult.credentials.providers.find((p) => p.id === 'volcengine').refs
      .find((r) => r.name === 'VOLC_ACCESS_KEY_ID').configured,
    false,
    '复核后应回报未配置',
  )

  // 4b) env 层：上游抛错 → 如实回报失败与原因，绝不报成功
  const envStore = { VOLC_ACCESS_KEY_ID: { value: 'AKLTbbbbbbbbbbbbbbbb', source: 'env' } }
  const envResult = await fakeService(envStore).removeCredentials(['VOLC_ACCESS_KEY_ID'])
  assert.equal(envResult.results[0].ok, false, '启动环境变量层不得报成功')
  assert.equal(envResult.results[0].reason, 'rejected')
  assert.ok(envResult.results[0].message.includes('read-only'), '应把上游那句人话带出来')
  assert.equal(envStore.VOLC_ACCESS_KEY_ID.value, 'AKLTbbbbbbbbbbbbbbbb', 'env 层的值不该被改动')

  // 4c) .env 回落层：unset 是**静默空操作**。这是最阴的一种——不抛错、不改变任何
  //     东西；不复核就会把「什么都没变」报成「已移除」。
  const dotenvStore = { ZHIPU_CODING_API_KEY: { value: 'zhipu-cccccccccccc', source: 'project-env' } }
  const dotenvResult = await fakeService(dotenvStore).removeCredentials(['ZHIPU_CODING_API_KEY'])
  assert.equal(dotenvResult.results[0].ok, false,
    '.env 回落层是静默空操作，必须靠复核抓出来——报成功就是撒谎')
  assert.equal(dotenvResult.results[0].reason, 'still-configured')
  assert.ok(dotenvResult.results[0].message.includes('.env'), '复核失败时应告诉用户去改哪里')

  // 4d) 清单必须标出「哪一层、能不能删」——界面据此才画得出禁用的勾选框
  const mixed = await fakeService({
    VOLC_ACCESS_KEY_ID: { value: 'AKLTdddddddddddddddd', source: 'file' },
    VOLC_SECRET_ACCESS_KEY: { value: 'eeeeeeeeeeeeeeeeeeee', source: 'env' },
  }).credentialInventory()
  const volcRefs = mixed.providers.find((p) => p.id === 'volcengine').refs
  const akRow = volcRefs.find((r) => r.name === 'VOLC_ACCESS_KEY_ID')
  const skRow = volcRefs.find((r) => r.name === 'VOLC_SECRET_ACCESS_KEY')
  assert.equal(akRow.removable, true, 'file 层的 AK 应可移除')
  assert.equal(skRow.removable, false, 'env 层的 SK 不可移除')
  assert.ok(skRow.blockedReason !== '', '不可移除的条目必须带上原因')
  // 打码：清单可以给尾段（用于确认删的是哪一把），但绝不能给完整值
  assert.equal(akRow.hint, '…dddd', '应只回报打码尾段')
  assert.ok(!JSON.stringify(mixed).includes('AKLTdddddddddddddddd'), '清单里不得出现凭据原值')
  assert.ok(!JSON.stringify(mixed).includes('eeeeeeeeeeeeeeeeeeee'), '清单里不得出现凭据原值')
  assert.ok(attempts.includes('VOLC_ACCESS_KEY_ID'), '移除应真的调用凭据服务的 unset')
}

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
const { pricingOf, normalizeModel, MODEL_RATES, ratesOf, usdToCny } = pricingModule

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

// 自建网关的部署标记（`-local` / 快照日 …）指的是同一个模型，必须折到同一行。
// 实测本机 `glm-5.3-flash-local` 走 `company-local` 路由，早先一个都认不出
// → 静默落 deepseek-flash 兜底价（¥0.70，按 GLM 应为 ¥1.57）。
assert.equal(normalizeModel('glm-5.3-flash-local'), 'glm-5.3-flash', '带部署标记的路由名应折到 Flash 档')
assert.equal(pricingOf('glm-5.3-flash-local').known, true, '带部署标记的路由名必须有官方价，不能落兜底')
assert.equal(normalizeModel('glm-5.3-highspeed'), 'glm-5.3', '满血档的部署标记仍折到满血档')
// 「提供商/」前缀与部署标记**同时**出现时，两段都要各自处理掉
assert.equal(normalizeModel('z-ai/glm-5.3-flash-local'), 'glm-5.3-flash', '前缀 + 部署标记应一起处理')
// 跨族不得被后缀带过去：`-local` 不足以把不存在的版本折进现行价目
assert.equal(normalizeModel('deepseek-v5-local'), 'deepseek-v5-local', '跨族不许借后缀折进现行价目')
assert.equal(pricingOf('deepseek-v5-local').known, false, '不存在的版本不能因为有 local 后缀就变成已知价')
// 没见过的标记不得被猜：剥后缀只能认清单里那几个
assert.equal(pricingOf('glm-5.3-flash-ultra').known, false, '没见过的标记应照旧认不出')

// FlashX 是**独立定价的模型**，不是 Flash 的记号：官方价 2 / 7 / 0.57 对 0.8 / 2.8 / 0.23。
// 当成部署后缀剥掉会低估 2.5 倍，而本机 `commandcode` 路由下确实挂着 `z-ai/glm-5.3-flashx`。
assert.equal(normalizeModel('z-ai/glm-5.3-flashx'), 'glm-5.3-flashx', 'FlashX 应折到自己那一行，不是 Flash')
assert.deepEqual(MODEL_RATES['glm-5.3-flashx'].cacheMiss, { peak: 2, idle: 2 }, 'FlashX 输入应为 2 元')
assert.deepEqual(MODEL_RATES['glm-5.3-flashx'].output, { peak: 7, idle: 7 }, 'FlashX 输出应为 7 元')
assert.deepEqual(MODEL_RATES['glm-5.3-flashx'].cacheHit, { peak: 0.57, idle: 0.57 }, 'FlashX 缓存命中应为 0.57 元')
assert.notEqual(
  MODEL_RATES['glm-5.3-flashx'], MODEL_RATES['glm-5.3-flash'],
  'FlashX 与 Flash 必须是两份不同的价目条目',
)

// ── 千问：统一按**中国内地（华北2 北京）**取价 ──────────────────────
//
// 千问同一模型在不同地域价差很大（qwen3.8-max 北京 $1.650/$4.951 vs 新加坡
// $2/$6），而账本里没有地域信息。这里钉住「统一按内地价」这个约定：
// 换价时必须同时改这里，否则口径会悄悄漂回国际站。
// 美元按 7.2 折人民币（与内置表其余条目同币种）。
assert.equal(MODEL_RATES['qwen3.8-max'].cacheMiss.peak, 12,
  'qwen3.8-max 输入应为国内站整数价 ¥12——不要用美元折算，折算会得到 11.88 这种对不上账的数字')
assert.equal(MODEL_RATES['qwen3.8-max'].output.peak, 36, 'qwen3.8-max 输出应为 ¥36')
assert.equal(MODEL_RATES['qwen3.8-max'].cacheHit.peak, 1.5, 'qwen3.8-max 缓存命中应为 ¥1.5')
// 3.7-max 与 3.8-max 输入输出同价，但**缓存命中价不同**（2.4 vs 1.5）：
// 折叠成一条会算错缓存成本，而这正是长会话里占比最大的部分。
assert.equal(MODEL_RATES['qwen3.7-max'].cacheHit.peak, 2.4, 'qwen3.7-max 缓存命中是 ¥2.4，与 3.8-max 不同')
// qwen3.7-flash 分三档（0.2/0.6/1.2），取最低档必须标 tiered，否则会被当成精确价。
assert.equal(MODEL_RATES['qwen3.7-flash'].cacheMiss.peak, 0.2, 'qwen3.7-flash 输入应为最低档 ¥0.2')
assert.equal(MODEL_RATES['qwen3.7-flash'].tiered, true, '分档模型必须标 tiered')
// 限时 8 折：按折后价录，按原价会高估 25%。
assert.equal(MODEL_RATES['qwen3.7-plus'].cacheMiss.peak, 1.6, 'qwen3.7-plus 应取 8 折后的 ¥1.6')
// OpenAI：账本里真实出现的 gpt-5.6-terra 必须有价，否则它一直显示「估算价」。
//
// **价目表里存的是官方原币（USD），人民币值只在生效视图里按汇率折算。**
// 早先这里断言的是写死的 `$2 × 7.2 = 14.4`：那时汇率是常量 7.2，而现在汇率
// 由用户在设置里改，写死的人民币值会与界面上的金额对不上（用户改了汇率，
// 金额变了而这条断言还在测旧的 7.2）。因此这里分两段钉：
//   1) 原币价目必须与官方页一致（USD）；
//   2) 生效视图的人民币值必须 = 原币 × 当前汇率（构造上不可能漂移）。
assert.equal(MODEL_RATES['gpt-5.6-terra'].currency, 'USD', 'OpenAI 价目是美元，不能写死成人民币')
assert.deepEqual(MODEL_RATES['gpt-5.6-terra'].cacheMiss, { peak: 2, idle: 2 }, 'gpt-5.6-terra 输入 $2/M')
assert.deepEqual(MODEL_RATES['gpt-5.6-terra'].output, { peak: 12, idle: 12 }, 'gpt-5.6-terra 输出 $12/M')
assert.equal(ratesOf('gpt-5.6-terra').cacheMiss.peak, Number((2 * usdToCny()).toFixed(6)),
  '生效视图必须按当前汇率折算（改了汇率金额要跟着变）')
assert.equal(ratesOf('gpt-5.6-terra').currency, 'CNY', '生效视图一律是人民币')
assert.equal(pricingOf('gpt-5.6-terra').known, true, '账本里出现过的模型必须 known=true')
assert.equal(MODEL_RATES['qwen-max'].cacheMiss.peak, 2.484,
  'qwen-max 是内地特例价 $0.345，与国际站 $1.6 差 4 倍多，不能折进 qwen3.8-max')
assert.equal(MODEL_RATES['qwen3.8-max'].tiered, true,
  '千问按阶梯计价，必须标 tiered —— 界面据此注明「按最低档估算」而不是假装精确')
// 日期后缀与 qwen/ 前缀指向同一个计价模型：不折叠就会各变成一行「估算价」。
assert.equal(normalizeModel('qwen3.8-max-0902'), 'qwen3.8-max', '日期后缀应折到基础模型')
assert.equal(normalizeModel('qwen/qwen3.7-max'), 'qwen3.7-max', 'qwen/ 前缀应折到基础模型')
assert.equal(normalizeModel('qwen3.6-plus'), 'qwen3.7-plus', '上一代 plus 折到当前 plus')
// 没录价的模型必须如实标成「不知道」——不能让它看起来像官方价。
{
  const unknown = pricingOf('some-unreleased-model-x')
  assert.equal(unknown.known, false, '未录价的模型必须 known=false，界面据此显示「估算价」')
}

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

// 客户端 `cost.js` 里**抄了一份**兜底价目（独立打包，没有从宿主 import 的通道）。
// 抄一份的失效模式是「改了宿主忘了改那里」，而症状只在旧宿主上出现，平时看不见。
// 因此在这里把两边逐项钉死：数字不一致就直接失败，逼人同步。
{
  const clientCost = readFileSync(join(root, 'src', 'client', 'cost.js'), 'utf8')
  const block = clientCost.match(/const FALLBACK_RATES = \{[\s\S]*?\n\}/)
  assert.ok(block !== null, '客户端 cost.js 里应有一份 FALLBACK_RATES（找不到说明它被改名了，请同步这条闸门）')
  const hostFallback = MODEL_RATES['deepseek-flash']
  for (const field of ['cacheHit', 'cacheMiss', 'output']) {
    for (const side of ['peak', 'idle']) {
      const pattern = new RegExp(`${field}:\\s*\\{[^}]*${side}:\\s*([0-9.]+)`)
      const found = block[0].match(pattern)
      assert.ok(found !== null, `客户端兜底价里读不到 ${field}.${side}`)
      assert.equal(
        Number(found[1]), hostFallback[field][side],
        `客户端兜底价的 ${field}.${side}（${found[1]}）与宿主 deepseek-flash（${hostFallback[field][side]}）不一致`,
      )
    }
  }
}

// ── 通知与预警：宿主侧的结束事实 + 阈值配置读写 ──────────────────
const notifyModule = await import(pathToFileURL(join(root, 'lib', 'notify.js')).href)
const {
  MAX_AGENT_LABEL_CHARS, NOTIFY_DEFAULTS, NotifyJournal, isSubagentHeader, normalizeNotify, noticeOf, truncate,
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

// 1b) 子智能体：身份由**会话头**判定，文案由客户端区分
//
// 用户报的正是这条：「桌面通知在子智能体完成时会触发，但内容里没有标识这只是
// 子智能体完成了任务」。子代理的 turn/end 与主会话是**同一条事件**，区别只在
// 会话头的 `origin` / `parentSession` 上——宿主必须在这里标出来，客户端才可能
// 说出「有新进展」而不是「已完成」。
const subHeader = {
  id: 'session-sub',
  cwd: 'D:\\blog',
  origin: 'subagent',
  parentSession: 'session-lead',
  delegationDepth: 1,
}
const subNotice = noticeOf(
  { id: 'session-sub', header: subHeader },
  { type: 'turn/end', time: 1, data: { turn: 2, reason: { kind: 'completed' } } },
  'blog',
  { name: 'alice', label: 'x'.repeat(400) },
)
assert.equal(subNotice.subagent, true, '子智能体的 turn/end 必须被标成 subagent')
assert.equal(subNotice.agentName, 'alice', '应带上团队名册里的名字')
assert.ok(
  typeof subNotice.agentLabel === 'string' && subNotice.agentLabel.length <= MAX_AGENT_LABEL_CHARS,
  `子智能体描述必须截断到 ${MAX_AGENT_LABEL_CHARS} 以内，实际 ${subNotice.agentLabel?.length}`,
)
assert.equal(subNotice.category, 'done', '子智能体的正常结束仍归 done 一侧（由客户端换措辞，不是换成失败）')

// 两个字段各自成立都要认得出来：`origin` 是语义标记，`parentSession` 是关系事实。
// 只看一个会在真实数据里漏判——链断了的子会话只有 origin，而老会话可能没写 origin。
assert.equal(isSubagentHeader({ parentSession: 'p' }), true, '只有 parentSession 时也应认作子智能体')
assert.equal(isSubagentHeader({ origin: 'subagent' }), true, '只有 origin 时也应认作子智能体')
assert.equal(isSubagentHeader({ id: 'x', cwd: 'D:\\w' }), false, '普通会话不是子智能体')
assert.equal(isSubagentHeader(undefined), false, '读不到会话头时不能猜成子智能体')
assert.equal(isSubagentHeader({ origin: 'other', parentSession: '' }), false, '认不出的取值不能当成子智能体')

// **主会话不得出现 subagent 字段**：客户端拿「有这个字段」当唯一判据，
// 多写一个 `subagent: false` 会让「只在是的时候写」这条契约失效（将来谁改一行
// 就静默改了全部主会话的文案）。
const mainNotice = noticeOf(
  { id: 'session-main', header: { id: 'session-main', cwd: 'D:\\blog' } },
  { type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  'blog',
)
assert.ok(!Object.hasOwn(mainNotice, 'subagent'), '主会话的通知里不该有 subagent 字段')
assert.equal(mainNotice.label, '已完成', '主会话的结论词仍是宿主给的那一份（客户端不改它）')

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
//
// **余额 / 套餐额度预警已整体取消**（v3）。因此这一节现在钉的是反向事实：
// 归一化会把旧配置文件里的阈值键**丢掉**，而不是继续传播它们。
// 旧版这里逐个断言阈值表的大小写归一、负值丢弃、原型键拦截……那些逻辑随
// 功能一起删掉了；留一句「阈值还能调」的断言，只会让人以为功能还在。
const clean = normalizeNotify({
  notifyDone: 'yes',
  // 旧配置文件里可能还带着这些键：读进来必须被丢掉，而不是又被写回去。
  warnBalance: { cny: 10, USD: '5', __proto__: 999, BAD: -1 },
  warnQuotaPercent: 250,
  notifyBalance: false,
  notifyQuota: false,
})
assert.equal(clean.notifyDone, NOTIFY_DEFAULTS.notifyDone, '非布尔值应退回默认值')
for (const stale of ['warnBalance', 'warnQuotaPercent', 'notifyBalance', 'notifyQuota']) {
  assert.ok(!Object.hasOwn(clean, stale), `旧配置里的 ${stale} 应被丢弃（该能力已取消）`)
}
assert.deepEqual(Object.keys(clean).sort(), Object.keys(NOTIFY_DEFAULTS).sort(), '归一结果只能含已知键')

// 3b) 提示音：认不出的模式必须回落到 `system`（= 什么都不改），**不是**静音。
//     默认成静音会让没设过的人以为通知坏了；而 `system` 只是「不动系统音效」。
assert.equal(normalizeNotify({}).notifySound, 'system', '没设过提示音时应跟随系统')
assert.equal(normalizeNotify({ notifySound: 'nope' }).notifySound, 'system', '认不出的模式应回落 system')
assert.equal(normalizeNotify({ notifySound: 'off' }).notifySound, 'off', 'off 是合法取值')
assert.equal(normalizeNotify({ notifySound: 'chime' }).notifySound, 'chime', '内置音效是合法取值')
// 音频地址最终会进 new Audio(url)：只放行 http(s) 与 data:audio，
// 其余协议（尤其是 javascript:）一律丢弃——否则等于给配置触发任意行为留口子。
assert.equal(normalizeNotify({ notifySoundUrl: 'https://a/b.mp3' }).notifySoundUrl, 'https://a/b.mp3')
assert.equal(normalizeNotify({ notifySoundUrl: 'data:audio/wav;base64,AAAA' }).notifySoundUrl, 'data:audio/wav;base64,AAAA')
assert.equal(normalizeNotify({ notifySoundUrl: 'javascript:alert(1)' }).notifySoundUrl, '', '非音频协议必须被丢弃')
assert.equal(normalizeNotify({ notifySoundUrl: 'file:///C:/a.mp3' }).notifySoundUrl, '', '本地文件路径必须被丢弃')
assert.equal(normalizeNotify({ notifySoundUrl: 'x'.repeat(4096) }).notifySoundUrl, '', '超长地址应被丢弃')

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

// 6) 子智能体的**名字**：两个来源都在日志里，而判定发生在 turn/end 那一刻
//
//    名字只写在 Lead 的日志里（`team/member`），一句话描述只写在子会话自己的
//    日志里（`subagent/descriptor`）——两者都不可能从 turn/end 时的活 Session
//    对象上读到。所以监听器必须顺着事件流抄一份小表。这条用例钉住的是
//    「抄下来了没有」与「键有没有张冠李戴」（team/member 的键是**成员自己的**
//    会话 id，不是 Lead 的；写错就会给 A 的通知安上 B 的名字）。
const subSubject = { id: 'session-sub-x', header: { cwd: 'D:\\blog', origin: 'subagent', parentSession: 'session-lead', delegationDepth: 1 } }
const leadSubject = { id: 'session-lead', header: { cwd: 'D:\\blog' } }
sessionEventHandlers[0](leadSubject, {
  type: 'team/member',
  time: 1,
  data: {
    version: 2,
    teamId: 'team-1',
    member: { id: 'session-sub-x', name: 'alice', description: '审查通知文案', provider: 'deepseek', context: 'fresh', phase: 'active' },
  },
})
sessionEventHandlers[0](subSubject, { type: 'subagent/descriptor', time: 2, data: { mode: 'one-shot', label: '审查通知文案' } })
sessionEventHandlers[0](subSubject, {
  type: 'turn/end',
  time: 3,
  data: { turn: 1, reason: { kind: 'completed' } },
})
// 名字在 Lead 的日志里、描述在子会话自己的日志里；两边都不在 turn/end 上。
const subEvents = JSON.parse((await call(notifyRoute, 'GET', '/dsh-pixel/notify?since=0')).body).events
const subEntry = subEvents.at(-1)
assert.equal(subEntry.subagent, true, '子智能体的 turn/end 必须标成 subagent')
assert.equal(subEntry.agentName, 'alice', `通知里应写出是哪一个子智能体，实际 ${JSON.stringify(subEntry)}`)
assert.equal(subEntry.agentLabel, '审查通知文案', '应带上 spawn 时那句职责说明')

// 名册里的名字**不能张冠李戴**：Lead 自己的 turn/end 不该被安上成员的名字。
sessionEventHandlers[0](leadSubject, {
  type: 'turn/end',
  time: 4,
  data: { turn: 1, reason: { kind: 'completed' } },
})
const leadEntry = JSON.parse((await call(notifyRoute, 'GET', '/dsh-pixel/notify?since=0')).body).events.at(-1)
assert.ok(!Object.hasOwn(leadEntry, 'subagent'), 'Lead 自己的 turn/end 不是子智能体，不该带 subagent 字段')
assert.ok(!Object.hasOwn(leadEntry, 'agentName'), 'Lead 的通知不该继承某个成员的名字')

// 7) 「子智能体进展」开关的默认值：开着（否则团队成员的进展会被静默吞掉）
assert.equal(NOTIFY_DEFAULTS.notifySubagent, true, '「子智能体进展」默认应开着')
assert.equal(
  normalizeNotify({ notifySubagent: false }).notifySubagent,
  false,
  '关掉这个开关必须能存下来（否则面板上点了没反应）',
)

// 8) 名字表必须有界，且淘汰的是**最旧**的
//
// 它是常驻内存：一台长跑的机器上会话数没有上限。没有上限时这份表会随会话数
// 线性增长——而且症状是「用久了内存慢慢涨」，最难归因的那一类。反过来，若淘汰
// 方向写错（丢最新的），名字就会永远只剩最早那批。
const SUBAGENT_FACT_LIMIT = 500
for (let i = 0; i < SUBAGENT_FACT_LIMIT + 20; i += 1) {
  sessionEventHandlers[0](leadSubject, {
    type: 'team/member',
    time: 10 + i,
    data: { version: 2, teamId: 'team-flood', member: { id: `session-flood-${i}`, name: `m${i}`, description: '', provider: 'p', context: 'fresh', phase: 'active' } },
  })
}
/** 让某条（可能已被淘汰的）会话报一个 turn/end，返回它拿到的通知。 */
const noticeFor = async (sessionId) => {
  sessionEventHandlers[0](
    { id: sessionId, header: { cwd: 'D:\\w', origin: 'subagent', parentSession: 'session-lead' } },
    { type: 'turn/end', time: 99, data: { turn: 1, reason: { kind: 'completed' } } },
  )
  const body = JSON.parse((await call(notifyRoute, 'GET', '/dsh-pixel/notify?since=0')).body)
  return body.events.at(-1)
}
assert.equal((await noticeFor('session-flood-519')).agentName, 'm519', '最新的名字必须留在表里')
const evicted = await noticeFor('session-flood-0')
assert.ok(
  !Object.hasOwn(evicted, 'agentName'),
  `超出上限后最旧的名字应被淘汰（否则这张表会随会话数线性增长），实际 ${JSON.stringify(evicted)}`,
)
assert.equal(evicted.subagent, true, '名字被淘汰不影响「这是个员工」这个事实')

// 写开关：用仍然存在的字段（`notifyDone`）验证「合并 + 持久化」两条语义。
// 阈值键（warnBalance 等）已随预警功能取消——写进来必须被忽略，见下面那条。
const notifyWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', { notifyDone: false })
assert.equal(notifyWrite.statusCode, 200, `POST 应返回 200，实际 ${notifyWrite.statusCode}`)
const written = JSON.parse(notifyWrite.body)
assert.equal(written.config.notifyDone, false, '开关应被写入')
assert.equal(written.config.notifySubagent, true, '未提交的项应保持原值（合并语义）')
// 写回后读一次，确认真的持久化到隔离的 prefs 文件里
const reread = JSON.parse((await call(notifyRoute, 'GET')).body)
assert.equal(reread.config.notifyDone, false, '重新读取应看到刚写入的开关')
// 已取消的阈值键：写进来返回 200（不是报错——旧版本客户端可能还在发），
// 但**配置里不能出现它**。否则「界面已经删了阈值，配置里还留着」会让人以为功能没删干净。
const staleWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', { warnBalance: { CNY: 20 }, warnQuotaPercent: 90 })
assert.equal(staleWrite.statusCode, 200, '旧客户端提交阈值不应报错（否则它的其余开关也写不进去）')
const staleConfig = JSON.parse(staleWrite.body).config
assert.ok(!Object.hasOwn(staleConfig, 'warnBalance'), '阈值键不得写进配置（该能力已取消）')
assert.ok(!Object.hasOwn(staleConfig, 'warnQuotaPercent'), '额度阈值不得写进配置')
// 跨站被拒：写路由不接受跨站表单触发
const crossSiteWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', { notifyDone: true }, { 'sec-fetch-site': 'cross-site' })
assert.equal(crossSiteWrite.statusCode, 403, '跨站写请求应被拒绝')
// 非法体被拒（数组不是对象）
const badWrite = await call(notifyRoute, 'POST', '/dsh-pixel/notify', [1, 2, 3])
assert.equal(badWrite.statusCode, 400, '数组体应被拒绝')
// 只读方法之外一律 405
const putRoute = await call(notifyRoute, 'PUT', '/dsh-pixel/notify')
assert.equal(putRoute.statusCode, 405, 'PUT 应返回 405')

// ── /focus：桌面端把窗口拉到前台 ────────────────────────────────────
//
// 渲染进程提不动窗口（实测 window.focus() 无效、preload 无 focus 通道），
// 所以由宿主用系统命令唤起 `dsh://open`，交给 Electron 主进程的
// focusPrimaryWindow() 做 restore→show→focus。三条断言：
//   1) 只接受 POST（它会让宿主启动外部程序，不该被 GET 触发）；
//   2) 跨站请求必须拒绝（同上，否则任意网页都能戳它）；
//   3) 正常 POST 返回 200 且带上 attempted/ok 字段，让调用方能判断结果。
assert.ok(focusRoute !== undefined, '应注册 /dsh-pixel/focus 路由')
const focusGet = await call(focusRoute, 'GET', '/dsh-pixel/focus')
assert.equal(focusGet.statusCode, 405, '/focus 的 GET 应返回 405')
const focusCrossSite = await call(focusRoute, 'POST', '/dsh-pixel/focus', undefined, { 'sec-fetch-site': 'cross-site' })
assert.equal(focusCrossSite.statusCode, 403, '/focus 的跨站 POST 应被拒绝')
const focusOk = await call(focusRoute, 'POST', '/dsh-pixel/focus')
assert.equal(focusOk.statusCode, 200, '/focus 的正常 POST 应返回 200')
const focusBody = JSON.parse(focusOk.body)
assert.equal(typeof focusBody.attempted, 'boolean', '/focus 应回报 attempted')
assert.equal(typeof focusBody.ok, 'boolean', '/focus 应回报 ok')

// ── 自定义单价：用户不必改源码就能补一个官方价 ──────────────────────
//
// 这是用户要求的入口：新模型发布得很勤，而「我用的模型没有价」的表现是它被标成
// 「估算价」并按 Flash 兜底折算——数字有、不报错，只是错的。以下钉四件事：
// 写进去能生效（含归一）、分时写法不被压平、写错要报出是哪一条、坏文件不清空。
{
  const { CustomRates } = await import(pathToFileURL(join(root, 'lib', 'custom-rates.js')).href)
  const { pricingOf, normalizeModel, setCustomRates } = await import(pathToFileURL(join(root, 'lib', 'pricing.js')).href)
  const ratesFile = join(tmpdir(), `dsh-pixel-preflight-rates-${process.pid}.json`)
  rmSync(ratesFile, { force: true })

  const store = new CustomRates({ path: ratesFile })
  // 文件不存在是「还没配过」，不是错误
  const empty = await store.load()
  assert.equal(empty.loaded, false, '价目文件缺失应回报未加载，而不是报错')
  assert.deepEqual(empty.errors, [], '文件缺失不该产生校验错误')

  // 用户举的例子：给一个价目表里没有的模型补官方价
  const saved = await store.save({
    'gpt-6-alstra': { label: 'GPT-6 Alstra', vendor: 'OpenAI', cacheHit: 1, cacheMiss: 10, output: 40 },
  })
  assert.equal(saved.ok, true, `写入自定义价目应成功，实际 ${JSON.stringify(saved)}`)
  assert.equal(saved.persisted, true, '写入应落盘')
  const alstra = pricingOf('gpt-6-Alstra')
  assert.equal(alstra.known, true, '自定义价应被当作已知价（否则仍会标估算价）')
  assert.equal(alstra.custom, true, '自定义价应被标记为 custom，供界面区分')
  assert.equal(alstra.rates.output.peak, 40, '自定义输出价应生效')
  assert.equal(alstra.rates.output.idle, 40, '只写一个数应视为不分时（高峰空闲同价）')
  assert.equal(normalizeModel('gpt-6-Alstra'), 'gpt-6-alstra', '自定义模型名也要能被归一命中')

  // 分时写法：{ idle, peak } 必须照写出来的读，**不能**被压成同价
  const tiered = await store.save({
    'tiered-x': { cacheHit: { idle: 0.5, peak: 1 }, cacheMiss: { idle: 5, peak: 10 }, output: { idle: 20, peak: 40 } },
  })
  assert.equal(tiered.ok, true, '分时写法应被接受')
  const tx = pricingOf('tiered-x')
  assert.equal(tx.rates.output.peak, 40, '分时条目的高峰价应保留')
  assert.equal(tx.rates.output.idle, 20, '分时条目的空闲价应保留（踩过：曾被压成与高峰同价）')
  assert.notDeepEqual(tx.rates.output.peak, tx.rates.output.idle, '分时条目两个档必须不同')

  // 写错要指出是**哪一条、哪一项**，并且一个字节都不落盘
  const badFile = join(tmpdir(), `dsh-pixel-preflight-rates-bad-${process.pid}.json`)
  rmSync(badFile, { force: true })
  const badStore = new CustomRates({ path: badFile })
  const bad = await badStore.save({ broken: { cacheHit: 'abc', cacheMiss: 1, output: 2 } })
  assert.equal(bad.ok, false, '不合法的价目应被拒绝')
  assert.ok(
    bad.errors.some((line) => line.includes('broken') && line.includes('cacheHit')),
    `校验错误应点名模型与字段，实际 ${JSON.stringify(bad.errors)}`,
  )
  assert.equal(existsSync(badFile), false, '校验失败不得落盘（否则下次启动跟着坏）')

  // 非法 JSON：**同一个实例**在已经读到好价之后遇到坏文件，必须保留上一次生效的价。
  // （真实场景：宿主启动时读到了好价，用户中途把文件改坏，下一次复查不该把价清空。）
  // 新实例没有「上一次」可言，因此这里用同一个 store。
  writeFileSync(ratesFile, '{ not json', 'utf8')
  await store.load()
  assert.ok(store.describe().error !== undefined, '非法 JSON 应报出可读原因')
  assert.equal(pricingOf('tiered-x').known, true, '文件损坏时应保留上一次生效的价，而不是清空')

  rmSync(ratesFile, { force: true })
  rmSync(badFile, { force: true })
  // 清掉进程内的自定义价，避免影响后续断言
  setCustomRates({})
}

// 恢复：把开关文件清干净，避免影响后续断言
rmSync(sandboxPrefs, { force: true })

console.log(`预检通过：插件形状、${routes.length} 条路由、版本注入（${info.version}）、能力声明、空/非空聚合、`
  + 'POST 拒绝、时段时钟、余额隐私与开关、套餐解析与凭据打码、多厂商价目、自定义单价、通知日志与开关')

rmSync(sandboxPrefs, { force: true })
