/**
 * 预检脚本：用假的 Cordis 上下文加载宿主半边，验证插件形状、路由注册与数据返回。
 * 这样不必重启正在运行的 dsh 就能发现 apply 里的问题。
 *
 * 全程隔离：账本路径指向临时文件（见下方环境变量），因此不会读取也不会污染
 * 你本机真实的用量账本——否则「空数据源」其实带着真实历史，断言会莫名其妙地失败。
 * 用法: node tools/preflight.mjs
 */
import { strict as assert } from 'node:assert'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
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
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
    return undefined
  },
  on() {},
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
const balanceRoute = routeOf('/dsh-pixel/balance')
const plansRoute = routeOf('/dsh-pixel/plans')
const toggleRoute = routeOf('/dsh-pixel/toggle')
assert.equal(routes.length, 5, `应注册恰好五条路由，实际 ${routes.length}`)

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
assert.equal(payload.version, info.version, '数据响应里的版本应与版本路由一致')
// 能力声明是客户端判断兼容性的唯一依据，必须齐全——缺项会让对应界面降级。
// 注意「齐全」是指**声明**要完整，而不是要求客户端按它拦截取数（见 README 的设计约束）。
const REQUIRED_CAPABILITIES = [
  'period', 'peakRule', 'sessionCost', 'calendarByDay', 'tieredRates', 'crossDeviceLedger',
  'balance', 'balanceToggle', 'thirdPartyPlans',
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
// 旧模型名应被折叠到现行模型
assert.deepEqual(sample.models.map((row) => row.model), ['deepseek-flash'], '旧模型名应折叠为 deepseek-flash')
assert.ok(sample.sessions[0].cost.standard > 0, '会话应带非零费用摘要')
assert.equal(sample.ledger.total, 1, '账本应记录一条')

const rejected = await call(dataRoute, 'POST')
assert.equal(rejected.statusCode, 405, 'POST 应返回 405')

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
  ['commandcode', 'zhipu'],
  '应包含智谱与 Command Code 两家',
)
// 预检环境既没有凭据服务也没有环境变量、更没有 CLI 凭据文件：两家都应明说没配 Key
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

console.log(`预检通过：插件形状、5 条路由、版本注入（${info.version}）、能力声明、空/非空聚合、`
  + 'POST 拒绝、余额隐私与开关、套餐解析与凭据打码、多厂商价目')

rmSync(sandboxPrefs, { force: true })
