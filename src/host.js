/**
 * dsh-pixel-dashboard 的宿主半边：把会话日志抽成用量账本，再按账本汇总
 * token 用量、模型分布、会话清单与活跃热力图，通过只读 HTTP 路由交给浏览器半边。
 *
 * 三个口径上的关键点：
 *   1) 每条请求按它**实际发生时刻**所属的时段（高峰 / 空闲）分别累计，
 *      于是费用可以精确到「这笔当时是高峰还是空闲」，而不是整段套一个折扣；
 *   2) 缓存未命中输入由 input - cacheRead - cacheWrite 反推，避免把缓存命中的
 *      token 重复计入高价档（totalTokens 含缓存命中，不能直接用）；
 *   3) 统计口径来自**账本**而不是直接读会话日志：账本是一份按请求去重的小文件，
 *      重复扫描不会翻倍，因此重装或换机都不会丢历史、也不会多算（见 lib/ledger.js）。
 *
 * 除了账本文件，宿主不落任何新状态。
 * @module dsh-pixel-dashboard/lib/host
 */
import { homedir } from 'node:os'
import { rename, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  DEFAULT_TIMEZONE,
  MODEL_RATES,
  PEAK_WEEKDAYS,
  PEAK_WINDOWS,
  activeMarkup,
  activeRates,
  costOf,
  dateKey,
  markupOf,
  normalizeModel,
  periodState,
  pricingOf,
  ratesOf,
  usdToCny,
  zonedFacts,
  zonedParts,
} from './pricing.js'
import { HOLIDAY_KEYS, HOLIDAY_YEARS } from './holidays.js'
import { CustomRates } from './custom-rates.js'
import { UsageLedger, rateKeyOfModelKey, recordOf, rollupOf, usageOfRecord } from './ledger.js'
import { BalanceService } from './balance.js'
import { PlansService } from './plans.js'
import { Preferences, resolvePrefsPath } from './prefs.js'
import { TimingBreakdown } from './timing.js'
import {
  NOTIFY_DEFAULTS,
  NotifyJournal,
  normalizeNotify,
  noticeOf,
} from './notify.js'

/** 路由前缀：看板数据挂在这里，避免和产品路由相撞。 */
const ROUTE_PREFIX = '/dsh-pixel'

/**
 * 把 DSH 桌面端窗口拉到前台。
 *
 * 原理见 `/focus` 路由的说明：桌面壳在 `app.on('open-url')` 里把
 * `dsh://open` 映射到 `focusPrimaryWindow()`（restore → show → focus），
 * 而宿主是独立 Node 进程，可以用系统命令唤起这个协议。
 *
 * ## 为什么用 `start` 而不是 `shell.openExternal`
 *
 * 宿主跑在 `runtime/primary-runtime` 的 Node 里，**不是** Electron 主进程，
 * `require('electron')` 在这里拿不到。因此只能走系统层：
 * Windows 用 `cmd /c start "" "dsh://open"`，macOS 用 `open`，Linux 用 `xdg-open`。
 *
 * ## 失败一律不抛
 *
 * 浏览器场景（纯 `dsh web`）根本没有这个协议处理器；受限环境也可能被策略拦下。
 * 这些都只意味着「窗口没被拉到前台」，绝不该影响已经完成的会话切换——因此这里
 * 把所有异常收敛成 `{ attempted, ok, detail }` 交给调用方。
 * @returns {Promise<{attempted:boolean,ok:boolean,detail?:string}>} 结果。
 */
async function raiseDesktopWindow() {
  try {
    const { spawn } = await import('node:child_process')
    if (process.platform === 'win32') {
      // `start` 是 cmd 内建命令；第一个空串是窗口标题占位，否则带引号的 URL 会被
      // 当成标题而不是目标（这是 start 的经典坑）。
      const child = spawn('cmd', ['/c', 'start', '', 'dsh://open'], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: false,
      })
      child.unref?.()
      return { attempted: true, ok: true }
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(opener, ['dsh://open'], { detached: true, stdio: 'ignore' })
    child.unref?.()
    return { attempted: true, ok: true }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 实现版本号，由构建脚本按宿主源码哈希注入。
 * 未构建时保持占位符，便于一眼看出这是源码树而非产物。
 */
const IMPL_VERSION = '__DSH_PIXEL_IMPL_VERSION__'

/**
 * 数据能力声明：客户端据此判断「宿主有没有这项数据」，而不是比对版本哈希。
 *
 * 用能力而不是版本相等，是因为哈希会随任何源码改动而变，包括完全不影响数据
 * 形状的改动（例如删掉一个没人用的字段）。用哈希当闸门会把好数据一起挡掉，
 * 表现是界面永远停在加载/折算中。
 *
 * 新增或改变某个字段的含义时，把对应能力名加到这里。
 */
const CAPABILITIES = [
  'period',
  // 独立的时段路由：侧栏那枚指示灯靠它拿到「本段总长」，从而画出环形进度。
  // 单独列一个名字是因为它可能缺失（旧宿主）而 `/data` 仍在——那时指示灯不画，
  // 看板其余部分照常，而不是整块界面按版本哈希一起降级。
  'periodClock',
  'peakRule',
  // 时段口径从「周末 + 工作日高峰」改成「周末 + 法定节假日全天都空闲」。
  // 客户端据此区分新旧口径：旧宿主在国庆这种「周四/周五的白天」会把用量算成高峰，
  // 金额因此偏高两倍。缺这个能力名时界面照实标注「宿主未包含节假日日历」，
  // 而不是把一张偏高两倍的费用表当成官方口径展示。
  'holidayCalendar',
  'sessionCost',
  'calendarByDay',
  'tieredRates',
  'crossDeviceLedger',
  'balance',
  'balanceToggle',
  'thirdPartyPlans',
  // 「移除凭据」：查询各家凭据现状 + 按用户勾选逐条移除。
  // 单独声明是因为它可能缺失（旧宿主）而套餐面板其余部分仍在——那时
  // 界面只是不画移除入口，而不是整块降级。
  'planCredentials',
  // 通知日志（会话结束事实）与预警阈值配置。两者一起声明：客户端只要拿到
  // `/notify` 这条路由就能同时读写它们，拆成两个能力名没有意义。
  'notifyJournal',
  'notifyThresholds',
  // 桌面端「把窗口拉到前台」：宿主用系统命令唤起 dsh://open，
  // 由 Electron 主进程的 focusPrimaryWindow() 完成 restore+show+focus。
  'focusWindow',
  // 会话清单里的**预览标题**（与 DSH 侧栏同源）。旧宿主只给会话 id，
  // 那时界面回落到显示 id 片段，而不是显示一个不存在的标题。
  'sessionTitle',
  // 模型条目的身份从「模型路由名」改成「模型 × 提供商」：数据里的 `models[].key`
  // 与按日/按会话的 `byModel` 键都跟着变成复合键。旧宿主给的还是单个模型名，
  // 客户端按两种键都能查价（见 cost.js 的 ratesFor）。
  'modelProvider',
  // 智能体团队：`sessions[]` 上多了 `teamId` / `role` / `memberName`，并新增
  // `teams[]` 分组。缺这一项时客户端退回「每会话一行」的老行为——那时费用条
  // 显示的是单会话金额，而不是团队合计。
  'agentTeam',
  // 单会话明细路由（`GET /dsh-pixel/session?id=`）：会话标签页据此画逐模型明细
  // 与逐日花费。旧宿主没有这条路由（404），那时会话标签页显示「当前宿主不支持
  // 这条明细」而不是空白——降级必须可见。
  'sessionDetail',
]

/** 快照缓存有效期：会话日志只在使用后变化，短缓存即可挡住频繁刷新。 */
const SNAPSHOT_TTL_MS = 20_000

/** 单次读取的事件条数。 */
const READ_CHUNK = 500

/** 热力图回看的自然日数（一年视图）。 */
const HEATMAP_DAYS = 371

/** 单个会话允许读取的最大事件数，防止异常日志拖垮一次请求。 */
const MAX_EVENTS_PER_SESSION = 200_000

/**
 * 「会话 id → 子智能体名字 / 描述」这份小表的容量上限。
 *
 * 它是**常驻内存**：一台长跑的机器上会话数量没有上限，而这里存的只是显示用的
 * 名字。满了就丢最早的（见通知监听器里的 `remember`），代价只是某条老会话的
 * 通知少一个名字——这比随会话数线性增长的内存好得多。
 */
const AGENT_FACT_LIMIT = 500

/**
 * 派生缓存的 schema 版本。
 *
 * **每加/改一个 readSession 的派生字段就 +1。** 指纹里不含它时，新增字段会被
 * 旧缓存挡住——读出来的对象没有新字段，界面显示成空或 0，而且不报错。
 * 这个坑已经踩过一次（加 timing 时，用户看到「模型耗时 —」）。
 */
const CACHE_SCHEMA = 2

/** 空用量累加器：总量 + 分时段。 */
function emptyUsage() {
  return {
    cacheHit: 0,
    cacheMiss: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    local: 0,
    requests: 0,
    // 分档桶必须与总量桶**同构**（都含 cacheWrite / local）：早先只放了
    // cacheHit / cacheMiss / output / requests，于是「峰时用了多少 token」
    // 与「分时金额里的缓存写入成本」都无从得出。同构之后，任何按桶读数的
    // 代码在两个层级上的行为一致，也不会再漏掉某个字段。
    peak: { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, local: 0, requests: 0 },
    idle: { cacheHit: 0, cacheMiss: 0, cacheWrite: 0, output: 0, local: 0, requests: 0 },
  }
}

/**
 * 把一份**已归一**的用量并入累加器，并按发生时刻记入高峰或空闲档。
 *
 * 入参的形状与 `usageOfRecord()` 的返回值一致（cacheHit / cacheMiss / cacheWrite /
 * output / reasoning / local / requests）。早先这个函数是照着会话事件的原始 usage
 * 字段（inputTokens / cacheReadTokens…）写的，改成账本后字段名对不上，
 * 于是每一项都读到 undefined、只有请求计数在涨——聚合结果全为 0 而毫无报错。
 * @param {object} acc - 累加器。
 * @param {object} usage - 归一后的用量。
 * @param {boolean} peak - 该请求是否落在高峰时段。
 * @returns {void}
 */
function addUsage(acc, usage, peak) {
  const cacheHit = Number(usage.cacheHit ?? 0)
  const cacheWrite = Number(usage.cacheWrite ?? 0)
  const cacheMiss = Number(usage.cacheMiss ?? 0)
  const output = Number(usage.output ?? 0)

  acc.cacheHit += cacheHit
  acc.cacheWrite += cacheWrite
  acc.cacheMiss += cacheMiss
  acc.output += output
  acc.reasoning += Number(usage.reasoning ?? 0)
  acc.local += Number(usage.local ?? 0)
  acc.requests += Number(usage.requests ?? 1)

  const bucket = peak ? acc.peak : acc.idle
  bucket.cacheHit += cacheHit
  bucket.cacheMiss += cacheMiss
  // **cacheWrite 与 local 也必须分档记**（踩过）：
  //   - 少了 cacheWrite，分时金额会漏掉「写缓存」那部分成本（按 1.25× 输入价计，
  //     在长会话里并不小）；
  //   - 少了 local，就没法回答「峰时用了多少 token、闲时用了多少」——
  //     而那正是用户在看「我是不是花了冤枉钱」时最先问的一句。
  bucket.cacheWrite += cacheWrite
  bucket.local += Number(usage.local ?? 0)
  bucket.output += output
  bucket.requests += 1
}

/**
 * 读取一个会话并**就地抽成派生结果**；任何读取失败都退化为已读到的前缀。
 *
 * 刻意**不返回原始事件数组**：一条会话日志动辄几十 MB（assistant 正文与工具
 * 结果占九成以上），而宿主只用得到三样——用量记录、轮次数、最新标题。把事件
 * 本身留在 `UsageCatalog.cache` 里，常驻内存就会随历史线性增长：实测 103 个
 * 会话、解压后 513 MB 的日志，有 1.1 GB 的事件对象被永久留着，只为产出
 * 一份 0.12 MB 的响应。看板刷新会在那一刻再叠一次扫描峰值，于是宿主被
 * 内存压力杀掉、桌面端表现成「突然重启」。
 *
 * 只留派生结果后同一批数据的常驻量是 3.85 MB —— 因为 513 MB 里的 64.8% 是
 * `assistant/message`，而每条只需要其中 226 字节的用量数字。
 *
 * ## 顺带抽取的两样「团队」事实
 *
 * - **本会话自己声明的成员**（`team/member` 事件，只在 Lead 日志里）：给出
 *   `teammate id → 名字` 这张表。这是**唯一**可信的名字来源——子会话的
 *   `subagent/descriptor.label` 存的是 spawn 时的 `description`（一句职责说明），
 *   不是团队里那个稳定、不可复用的 `name`。两者都收，名字优先取这张表。
 * - **本会话作为子代理时的描述**（`subagent/descriptor`）：只作名字缺失时的回落。
 *
 * 两样都只有几十字节，与「绝不缓存原始事件」不冲突（见上面那段内存账）。
 * @param {object} persistence - ctx.sessionPersistence。
 * @param {string} id - 会话 id。
 * @param {string} timeZone - 站点时区（归日要用；由调用方传入，本函数不持有 catalog）。
 * @returns {Promise<{records:object[],turns:number,title:string,days:string[],members:object[],label:string}>} 派生结果。
 */
async function readSession(persistence, id, timeZone) {
  /** @type {object[]} */
  const records = []
  let turns = 0
  /** 首次/最后一次活动时间（毫秒）；0 表示还没见过带时间的事件。 */
  let firstAt = 0
  let lastAt = 0
  /** 步数与工具调用次数：用量视角的「工作量」指标。 */
  let steps = 0
  let toolCalls = 0
  /** 本轮起点（turn/start 的 time）；0 = 没有进行中的轮次。 */
  let turnStartedAt = 0
  /** 已结算轮次的墙钟总时长与计数（供「平均每轮」）。 */
  let turnWallMs = 0
  let timedTurns = 0
  /** 最久一轮的时长。 */
  let maxTurnMs = 0
  /**
   * 耗时分解：模型等待（ttft）/ 回复（gen）/ 工具执行（tools）。
   *
   * 这是用户要的「真正有意义的时间」——「创建到最后使用」那种跨度会被
   * 「放了三周再来聊两句」的会话撑成几百小时，回答不了「我花了多少时间在等模型」。
   * 口径见 timing.js 的说明。
   */
  const timing = new TimingBreakdown()
  /** 最新的 `session/title` 文本（last-wins）。 */
  let title = ''
  /**
   * 本会话**作为 Lead** 声明过的团队成员：`[{ id, name, phase }]`。
   *
   * 同一成员会在每次生命周期变化时再写一条整体快照（provisioning → active /
   * failed），因此按 id 覆盖成 last-wins，而不是追加——否则一个成员会变成两行。
   * @type {Map<string, {id:string,name:string,phase:string}>}
   */
  const members = new Map()
  /**
   * 本会话**作为子代理**时的持久标签（`subagent/descriptor.label`）。
   *
   * 团队 spawn 传的是 `description`，普通 subagent 传的是任务描述；两者都只当
   * 「名字拿不到时的那一句话」，绝不当成成员名（那是另一个字段，见上面 members）。
   */
  let label = ''
  /**
   * 该会话有过请求的自然日（站点时区）。
   *
   * 在这里算而不是每轮扫描重算：它只取决于记录的时间戳，与实时模型目录无关，
   * 因此和 `records` 一样是「与目录无关的派生结果」。留在缓存里可以让用户每点
   * 一次刷新少付一次 Intl 格式化（实测每次 `formatToParts` 约 2.5–3.5µs）。
   * @type {Set<string>}
   */
  const days = new Set()
  let handle
  try {
    handle = await persistence.open(id, 'read')
  } catch {
    return { records, turns, title, days: [], members: [], label: '', firstAt, lastAt, steps, toolCalls, turnWallMs, timedTurns, maxTurnMs, timing: timing.toJSON() }
  }
  /** 已读事件总数（含不产出记录的），用于 `MAX_EVENTS_PER_SESSION` 闸门。 */
  let read = 0
  try {
    let offset = 0
    for (;;) {
      const page = await handle.read(offset, READ_CHUNK)
      const batch = page?.events ?? []
      if (batch.length === 0) break
      for (const event of batch) {
        if (event?.type === 'turn/start') turns += 1
        // ── 时间与步数：为「会话清单」的用量视角服务 ──────────────────
        //
        // 用户要的维度不只是钱和 token：**注意力与时间也是用量**。这里在既有的
        // 单次扫描里顺手收，不额外读盘：
        //   - firstAt / lastAt：会话跨度的两端（首次/最后一次活动）；
        //   - steps：`step/start` 的计数，反映「这轮被拆成多少步」；
        //   - toolCalls：`tool/call` 的计数，反映「动了多少次工具」。
        // 这些事件本身就是热路径上的普通事件，多记三个数字不影响扫描成本。
        const at = Number(event?.time)
        if (Number.isFinite(at) && at > 0) {
          if (firstAt === 0 || at < firstAt) firstAt = at
          if (at > lastAt) lastAt = at
        }
        if (event?.type === 'step/start') steps += 1
        if (event?.type === 'tool/call') toolCalls += 1
        // 耗时分解：同一遍扫描里顺带算，不额外读盘。
        timing.observe(event)

        // ── 轮次耗时：用户要的「等待模型输出总时长 / 平均每轮 / 最久一轮」──
        //
        // 口径与 dsh-context 的 TimingTotals 对齐（它的类型定义已公开说明）：
        //   turn/start 记下起点；turn/end 时得出这一轮的墙钟时长。
        // 累加 wallMs（供「平均每轮」）、记录 maxTurnMs（供「最久一轮」）。
        //
        // 注意：这是**墙钟时长**，包含工具执行与等待用户的时间，不等于「模型
        // 生成耗时」。后者需要 step 内 ttft/gen 细分，而 step 事件里没有那些
        // 时间戳——所以这里如实标成「轮次时长」，不冒充「模型耗时」。
        if (event?.type === 'turn/start' && Number.isFinite(at) && at > 0) {
          turnStartedAt = at
        }
        if (event?.type === 'turn/end' && turnStartedAt > 0 && Number.isFinite(at) && at > turnStartedAt) {
          const ms = at - turnStartedAt
          turnWallMs += ms
          timedTurns += 1
          if (ms > maxTurnMs) maxTurnMs = ms
          turnStartedAt = 0
        }
        // 标题事件是 log-only 的，last-wins：用户改名与模型生成的标题都走它。
        // 认不出形状时保留上一个已知标题，而不是把已有标题擦成空。
        if (event?.type === 'session/title') {
          const next = event.data?.title
          if (typeof next === 'string' && next.trim() !== '') title = next.trim()
        }
        // 团队名册（只在 Lead 的日志里）：整体快照，按成员 id last-wins。
        // 认不出形状就跳过那一条，绝不把已有名册清空——与标题同一条原则。
        if (event?.type === 'team/member') {
          const member = event.data?.member
          const memberId = typeof member?.id === 'string' ? member.id : ''
          const name = typeof member?.name === 'string' ? member.name : ''
          if (memberId !== '' && name !== '') {
            members.set(memberId, {
              id: memberId,
              name,
              phase: typeof member.phase === 'string' ? member.phase : 'active',
            })
          }
        }
        // 子代理描述：团队 spawn 时存的是 description，只作名字回落。
        if (event?.type === 'subagent/descriptor') {
          const next = event.data?.label
          if (typeof next === 'string' && next.trim() !== '') label = next.trim()
        }
        // 提供商补全（`withRouteOf`）**不在这里做**：它依赖实时模型目录，而目录
        // 每次扫描都重建。缓存里存未补全的记录，补全留给每一轮 collect，
        // 这样「设置里改了模型名」仍然立刻反映到看板上。
        const record = recordOf(id, event)
        if (record === undefined) continue
        records.push(record)
        // 一次格式化同时得到日期键与高峰判定中的日期部分（见 zonedFacts）
        days.add(zonedFacts(record.t, timeZone).key)
      }
      read += batch.length
      offset += batch.length
      if (batch.length < READ_CHUNK || read >= MAX_EVENTS_PER_SESSION) break
    }
  } catch {
    // 只读投影：读中断时用前缀数据，不阻塞页面。
  } finally {
    try {
      await handle.close()
    } catch {
      // 关闭失败不影响已读数据。
    }
  }
  return { records, turns, title, days: [...days].sort(), members: [...members.values()], label, firstAt, lastAt, steps, toolCalls, turnWallMs, timedTurns, maxTurnMs, timing: timing.toJSON() }
}

/**
 * 把「按模型 + 按时段」的用量折算成金额。
 * @param {Record<string, object>} byModel - 模型 → 含 peak/idle 分档的用量。
 * @returns {{standard:number,ifAllIdle:number,saved:number,peak:number,idle:number}}
 */
function costByModel(byModel) {
  let standard = 0
  let ifAllIdle = 0
  let peakPart = 0
  let idlePart = 0
  for (const [model, usage] of Object.entries(byModel)) {
    // 键可能是 `deepseek-flash@commandcode` 这类「模型 × 提供商」复合键：
    // 模型部分用来查价目表，提供商部分用来取**加价倍率**。
    //
    // 倍率（markup）是给第三方中转用的：它按 token 收你的钱，但单价与你那张
    // 官方价目表不同。没有倍率时这里恒为 1，行为与改动前完全一致。
    //
    // **宿主自己算的金额也必须乘倍率**（不是只在客户端乘）：`overview.cost`、
    // 每会话的 cost、每行的 cost 都出自这个函数，只要有一处漏乘，
    // 看板卡片（客户端重算）就会与宿主给的合计差出一个倍率——用户看到的是
    // 「明细加起来不等于合计」，而数字本身还都像对的。
    const factor = markupOf(providerOfModelKey(model))
    const rates = ratesOf(rateKeyOfModelKey(model))
    peakPart += costOf(usage.peak, rates, 'peak') * factor
    idlePart += costOf(usage.idle, rates, 'idle') * factor
    standard += (costOf(usage.peak, rates, 'peak') + costOf(usage.idle, rates, 'idle')) * factor
    // 同一份用量若全落在空闲时段能省多少。
    //
    // **每个字段都用 `?? 0` 兜底**（踩过）：旧缓存/旧宿主的分档桶里没有
    // cacheWrite，`undefined + undefined` 会算出 NaN，于是「若全在空闲时段」
    // 显示成 ¥0 —— 一个看起来像「没省下钱」的**结论**，实际是数据缺失。
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
    ifAllIdle += costOf(
      {
        cacheHit: num(usage.peak.cacheHit) + num(usage.idle.cacheHit),
        cacheMiss: num(usage.peak.cacheMiss) + num(usage.idle.cacheMiss),
        cacheWrite: num(usage.peak.cacheWrite) + num(usage.idle.cacheWrite),
        output: num(usage.peak.output) + num(usage.idle.output),
      },
      rates,
      'idle',
    ) * factor
  }
  return { standard, ifAllIdle, saved: standard - ifAllIdle, peak: peakPart, idle: idlePart }
}

/**
 * 从实时 LLM 注册表读一份「哪个提供商提供哪些模型」的目录。
 *
 * 这张表回答两个界面问题：
 *   1) 提供商该显示成什么名字（路由名 `workbuddy-cn` 对用户没有意义）；
 *   2) 模型该显示成什么名字——**以 DSH 设置里的外显名为准**，因此用户在设置里
 *      改了模型名，看板跟着改（这正是「支持跟随设置更新」）。
 *
 * 全程 fail-soft：LLM 服务没发布、某个提供商的模型列表读失败，都只是目录少一块，
 * 界面退回价目表里的名字。这是**展示层**的增强，绝不能让取数失败。
 *
 * 另外它顺手解决了一个历史遗留问题：像 `deepseek/deepseek-v4.1-flash` 这种
 * 「提供商/模型」形态的 id，能据此认出提供商，于是旧账本里认不出来源的记录
 * 也能归到正确的提供商下（见 ledger.js 的 upgradeRecord）。
 * @param {object|undefined} llm - ctx.get('llm')。
 * @returns {Promise<{providerNames:Map<string,string>,byProvider:Map<string,{name:string}>,byRollup:Map<string,{name:string,canonical:boolean}>,candidates:Map<string,Set<string>>,nativeProvider:Map<string,string>}>} 目录。
 */
async function buildModelDirectory(llm) {
  const empty = {
    providerNames: new Map(),
    byProvider: new Map(),
    byRollup: new Map(),
    candidates: new Map(),
    nativeProvider: new Map(),
  }
  if (llm === undefined || typeof llm.listProviders !== 'function') return empty
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    return empty
  }
  if (!Array.isArray(providers)) return empty

  const directory = {
    providerNames: new Map(),
    byProvider: new Map(),
    byRollup: new Map(),
    candidates: new Map(),
    nativeProvider: new Map(),
  }
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id.trim() : ''
    if (id === '') continue
    const name = typeof provider?.name === 'string' && provider.name.trim() !== '' ? provider.name.trim() : id
    directory.providerNames.set(id, name)
    let models = []
    try {
      // 只读查询：某一家读不出来（端点不通、模型列表接口报错）不影响其余各家
      models = typeof llm.listModels === 'function' ? (await llm.listModels(id)) ?? [] : []
    } catch {
      models = []
    }
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = typeof model?.id === 'string' ? model.id.trim() : ''
      if (modelId === '') continue
      const display = typeof model?.name === 'string' && model.name.trim() !== '' ? model.name.trim() : modelId
      directory.byProvider.set(`${id}\u0000${modelId}`, { name: display })
      // 候选表按**原生模型 id** 索引：账本里存的正是这个值（未归一的原始 id）。
      // 「只由一家提供」的模型可以据此确定提供商，多于一家时**不猜**。
      const set = directory.candidates.get(modelId) ?? new Set()
      set.add(id)
      directory.candidates.set(modelId, set)
      // 反查「某提供商的某个归一模型叫什么」：聚合后一个条目可能对应多条原生 id
      // （`hy4-preview-f` / `deepseek-v4.1-flash` / `deepseek-flash` 都是同一家的
      // 同一个模型），因此按归一键再建一张索引，名字随 DSH 设置变。
      //
      // 谁的名字算数：**原生 id 已经等于归一键的那条优先**——它就是该提供商的
      // 正式名字（`deepseek-flash` → 「DeepSeek Flash」），而别名条目
      // （`hy4-preview-f` → 「Work-Hy4 preview」）只是同一个模型在网关里的另一个
      // 入口。没有正式名字时才退回第一条别名，总比没有名字强。
      const rollupKey = `${id}\u0000${rollupOf(modelId)}`
      const existing = directory.byRollup.get(rollupKey)
      const canonical = rollupOf(modelId) === modelId
      if (existing === undefined || (canonical && existing.canonical !== true)) {
        directory.byRollup.set(rollupKey, { name: display, canonical })
      }
      // `提供商/模型` 形态的 id：斜杠左边是提供商的**自称**（不一定等于 DSH 的路由名）。
      // 真实路由名由这里的 `id` 给出，因此账本里那个自称要能被换成 id。
      const slash = modelId.indexOf('/')
      if (slash > 0 && slash < modelId.length - 1) {
        directory.nativeProvider.set(modelId, id)
      }
    }
  }
  return directory
}


/**
 * 单个会话的费用摘要，供输入框下方的费用条使用。
 * 金额保留 6 位小数：单次会话可能只有几分钱，过早取整会变成 0。
 *
 * ## `ifAllIdle` / `saved` 必须一起返回（踩过）
 *
 * 早先这里只挑了 `standard / peak / idle` 三个字段，把 `costByModel` 算好的
 * `ifAllIdle`（假设全部落在空闲时段的理论金额）与 `saved`（错峰省下的钱）丢了。
 * 后果是会话详情里那两行**永远显示 ¥0**——而 ¥0 看起来像「没省下钱」这个**结论**，
 * 不像「数据缺失」。用户在会话详情里报的就是这个：明明有 1.6 亿 token，却说省下 ¥0。
 *
 * 教训：摘要函数不要「挑字段返回」，要么全给、要么明确说明为什么砍掉。
 * @param {Record<string, object>} byModel - 会话内模型 → 分档用量。
 * @returns {{standard:number,peak:number,idle:number,ifAllIdle:number,saved:number}}
 */
function sessionCost(byModel) {
  const total = costByModel(byModel)
  const round = (value) => Math.round(value * 1e6) / 1e6
  return {
    standard: round(total.standard),
    peak: round(total.peak),
    idle: round(total.idle),
    ifAllIdle: round(total.ifAllIdle),
    saved: round(total.saved),
  }
}

/**
 * 把一个会话解析成「团队里的一员」。
 *
 * ## 判据只用会话头的**持久**字段，不猜
 *
 * | 字段 | 含义 | 来源 |
 * |---|---|---|
 * | `parentSession` | 直接父会话 id | 子会话创建时写入，不可变（`child-agent.ts`） |
 * | `origin` | `'subagent'` 表示它是一个子代理 | 同上，只作导航分类 |
 * | `delegationDepth` | 递归深度，顶层为 0 | 同上，会随持久化保留 |
 *
 * **`origin === 'subagent'` 但 `parentSession` 缺失时按「独立根」处理**，不往上猜：
 * 续跑的子会话可能在父进程先销毁时短暂存活（见 DSH 的 `roster.ts` 注释），
 * 把这种会话硬挂到某个 lead 名下，会把一份用量记到错误的团队上——而那种错误
 * 在界面上完全看不出来（数字有、也不报错，只是算错了地方）。
 *
 * ## 深度不限一跳
 *
 * teammate 自己**也可以再派子代理**。因此归属要一路向上走到没有父会话的那个
 * 根，而不是只看直接父。走链时有两条保护：
 *   - **必须有界**：`delegationDepth` 与访问集合双保险，防止日志里的环（或
 *     伪造数据）把扫描拖成死循环。
 *   - **父会话不在本机存储里时，把已知的最高祖先当根**，并标记 `detached`。
 *     那种情况是「父会话已被删除」——链断了，但仍然要把这段用量归到某个团队，
 *     否则它会从团队合计里凭空消失。
 * @param {{id:string,header:object}} session - 会话元信息（含持久 header）。
 * @param {Map<string, {id:string,header:object}>} byId - 本次扫描的全部会话。
 * @returns {{teamId:string,role:'lead'|'teammate',depth:number,parent:string,detached:boolean}} 归属。
 */
function teamPlacementOf(session, byId) {
  const header = session.header ?? {}
  const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
  const depth = Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0
  // 没有父会话 = 自己就是一个根 ⇒ 它是一个独立的团队（哪怕它是子代理——
  // 见函数说明：那种情况下宁可当独立根，也不猜一个父）。
  if (parent === '') {
    return { teamId: session.id, role: 'lead', depth: 0, parent: '', detached: false }
  }
  let currentId = parent
  let root = parent
  let detached = false
  const seen = new Set([session.id])
  // 有界推进：真实深度是个位数量级，64 段足够，且能挡住环。
  for (let hop = 0; hop < 64; hop += 1) {
    if (currentId === '' || seen.has(currentId)) break
    seen.add(currentId)
    root = currentId
    const next = byId.get(currentId)
    if (next === undefined) {
      // 父会话不在本机（已删除 / 来自别的机器）：链到此为止，以已知的最高祖先为根。
      detached = true
      break
    }
    const nextHeader = next.header ?? {}
    const grandParent = typeof nextHeader.parentSession === 'string' ? nextHeader.parentSession : ''
    if (grandParent === '') break
    currentId = grandParent
  }
  return { teamId: root, role: 'teammate', depth, parent, detached }
}

/**
 * 把一个团队里各成员的用量/费用汇总成一行。
 *
 * ## 合计必须是「成员之和」，而不是「先合并模型再算一遍」
 *
 * 用户要的交互是：费用条上显示团队合计 → **悬停展开成逐成员金额**。于是
 * 屏幕上会同时出现这两个数，而用户一定会把它们加起来对一遍。
 *
 * 两种做法在这一步会分叉：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | 先合并各成员的同名模型用量，再按单价折算 | 更「精确」，但与成员行之和差 **1e-6** 量级 |
 * | 直接把每成员已取整的金额相加 | 与展开后的每一行**严格相等** |
 *
 * 选后者。理由是 `AGENT.md` 里那条教训的同一条：日历金额与日行金额差的是尾数，
 * 却恰好落在**用户会逐位比对的同一个数字**上（实测 6 天里 5 天对不上）。
 * 这里同理——尾差本身无害，但「加起来不等于合计」会让人怀疑整个数字。
 *
 * 与看板总量的关系不受影响：`overview.cost` 是全量 `costByModel` 独立算的，
 * 而团队合计只在这些**多成员团队**内部使用，两者从不同屏并排出现。
 * @param {object[]} members - 该团队的成员（含 lead）会话行。
 * @returns {{totals:object,cost:object}} 汇总。
 */
function summarizeTeam(members) {
  const round = (value) => Math.round(value * 1e6) / 1e6
  let standard = 0
  let peak = 0
  let idle = 0
  let ifAllIdle = 0
  let saved = 0
  const totals = emptyUsage()
  for (const member of members) {
    standard += Number(member.cost?.standard ?? 0)
    peak += Number(member.cost?.peak ?? 0)
    idle += Number(member.cost?.idle ?? 0)
    // 团队合计必须把 ifAllIdle / saved 也加起来：它们会显示在团队那一行，
    // 只算 standard 会让「省了多少」在团队视图里恒为 0。
    ifAllIdle += Number(member.cost?.ifAllIdle ?? 0)
    saved += Number(member.cost?.saved ?? 0)
    const memberTotals = member.totals ?? {}
    for (const field of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local', 'requests']) {
      totals[field] += Number(memberTotals[field] ?? 0)
    }
    for (const bucket of ['peak', 'idle']) {
      // 分档桶里同样有 cacheWrite 与 local：少加它们，峰闲 token 与分时金额都会偏小。
      for (const field of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'local', 'requests']) {
        totals[bucket][field] += Number(memberTotals?.[bucket]?.[field] ?? 0)
      }
    }
  }
  // 金额逐项取整到 6 位：成员那一侧已经是 6 位，求和后再取一次可以挡住浮点误差
  // （0.1 + 0.2 这类），并保持「成员之和 === 合计」这条等式**逐位**成立。
  return {
    totals,
    cost: {
      standard: round(standard),
      peak: round(peak),
      idle: round(idle),
      ifAllIdle: round(ifAllIdle),
      saved: round(saved),
    },
  }
}

/**
 * 解析账本文件路径。
 *
 * 默认落在 `$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl`，即本机。
 * `DSH_PIXEL_LEDGER` 可以覆盖它：想让账本跟着插件目录走、或独立放到别处时可用。
 * @returns {string|undefined} 绝对路径；两者都推不出时返回 undefined（禁用账本）。
 */
function resolveLedgerPath() {
  const configured = process.env.DSH_PIXEL_LEDGER
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = process.env.DSH_HOME
    ?? (process.env.USERPROFILE ?? homedir())
  if (typeof home !== 'string' || home.trim() === '') return undefined
  return join(home.trim(), 'plugins', 'dsh-pixel-dashboard', 'usage-ledger.jsonl')
}

/** 本机标识：账本里记录来源，便于分辨哪台机器贡献了多少。 */
function resolveMachine() {
  const explicit = process.env.DSH_PIXEL_MACHINE
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'unknown'
}

/** 看板数据聚合器：会话级增量缓存 + 账本 + 整体快照缓存 + 并发合并。 */
export class UsageCatalog {
  /**
   * @param {object} deps - 依赖取值函数，全部惰性读取可选服务。
   * @param {() => object|undefined} deps.persistence - sessionPersistence。
   * @param {() => object|undefined} deps.sessions - sessions（判断会话是否在线）。
   * @param {() => string} deps.timezone - 站点时区。
   * @param {() => object|undefined} [deps.llm] - LLM 注册表（模型 / 提供商显示名）。
   * @param {string} [deps.ledgerPath] - 账本路径；显式传入便于测试。
   * @param {string} [deps.machine] - 本机标识。
   */
  constructor({ persistence, sessions, timezone, llm, ledgerPath, machine, customRates }) {
    this.persistence = persistence
    this.sessions = sessions
    this.timezone = timezone
    this.llm = llm ?? (() => undefined)
    /** @type {object|undefined} 用户补充的价目（见 lib/custom-rates.js）。 */
    this.customRates = customRates
    this.machine = machine ?? resolveMachine()
    this.ledgerPath = () => ledgerPath ?? resolveLedgerPath()
    const path = this.ledgerPath()
    /** @type {UsageLedger|undefined} */
    this.ledger = path === undefined ? undefined : new UsageLedger(path)
    /**
     * 会话级派生缓存：会话 id → 指纹 + 从日志抽出的**派生结果**。
     *
     * 存派生结果（记录 / 轮次数 / 标题）而不是原始事件，是这份缓存唯一要紧的
     * 设计约束，理由见 {@link readSession}：一台跑得久的机器上，事件本身能让
     * 常驻内存涨到 GB 级，而宿主只用得到其中约 0.8% 的字节。
     * @type {Map<string, {fingerprint:string, records:object[], turns:number, title:string}>}
     */
    this.cache = new Map()
    /**
     * 会话级派生缓存的**磁盘副本**。
     *
     * ## 为什么必须落盘（用户实测：每次打开看板都要等）
     *
     * 内存缓存解决了「同一进程内重复读」，但解决不了**重启后第一次打开**：
     * 一台跑得久的机器上有 300+ 会话、近 300MB 日志，冷启动要逐个解压扫一遍，
     * 而用户能感知到的正是这一次等待。
     *
     * 落盘后重启即复用：指纹（日志 revision / 事件数 / 字节数 / 时区）没变的会话
     * 直接跳过读取。这正是 dsh-context 那种「新装插件历史数据立刻就有」的做法。
     *
     * 写盘策略是**延迟合并**：扫描结束后统一写一次，而不是每个会话写一次——
     * 否则 300 个会话会产生 300 次小写入，比读日志还慢。
     */
    this.cacheFile = path === undefined ? undefined : join(dirname(path), 'session-cache.json')
    this.cacheDirty = false
    this.cacheSaveTimer = undefined
    this.snapshot = undefined
    this.snapshotAt = 0
    this.inflight = undefined
    /**
     * 单会话明细（会话 id → 取整后的逐模型 / 逐日用量）。
     *
     * 与 `snapshot` 同一生命周期：`build()` 生成快照时一起写这里。
     * 它**不参与 `/data` 序列化**，只被 `/dsh-pixel/session` 按 id 取一条。
     * @type {Map<string, {byModel:object, byDay:object}>|undefined}
     */
    this.sessionDetails = undefined
  }

  /** 让下一次请求重新扫盘。 */
  invalidate() {
    this.snapshot = undefined
    this.snapshotAt = 0
  }

  /**
   * 从磁盘恢复会话级派生缓存。
   *
   * 坏文件**一律当没有**：缓存只是加速，读不出来就退回全量扫描，绝不能让
   * 一个损坏的缓存文件把看板整个搞挂（与 prefs 的「坏文件当没写过」同一口径）。
   * @returns {Promise<void>} 完成。
   */
  async loadDiskCache() {
    if (this.cacheFile === undefined || this.cacheLoaded) return
    this.cacheLoaded = true
    try {
      const text = await readFile(this.cacheFile, 'utf8')
      const parsed = JSON.parse(text)
      const rows = parsed?.sessions
      if (rows === null || typeof rows !== 'object') return
      for (const [id, row] of Object.entries(rows)) {
        // 只认当前版本写出的结构；字段缺失的那条直接跳过，由扫描重建。
        if (typeof row?.fingerprint !== 'string') continue
        this.cache.set(id, row)
      }
    } catch {
      // 没有缓存文件（首次运行）或文件损坏：都按「没有缓存」处理。
    }
  }

  /** 把会话级缓存写回磁盘（延迟合并，扫描结束后调一次）。 */
  scheduleCacheSave() {
    if (this.cacheFile === undefined || this.cacheDirty) return
    this.cacheDirty = true
    this.cacheSaveTimer = setTimeout(() => {
      this.cacheDirty = false
      const sessions = {}
      for (const [id, row] of this.cache) sessions[id] = row
      // 先写临时文件再改名：中途崩溃不会留下半个 JSON 把下次启动拖下水。
      const tmp = `${this.cacheFile}.tmp`
      writeFile(tmp, JSON.stringify({ version: 1, sessions }), 'utf8')
        .then(() => rename(tmp, this.cacheFile))
        .catch(() => {
          // 写不进去只是下次启动慢一点，不该影响任何请求。
        })
    }, 2000)
    this.cacheSaveTimer?.unref?.()
  }

  /**
   * 读取看板数据（TTL 缓存；并发请求共用同一次扫描）。
   * @returns {Promise<object>} 看板数据。
   */
  async read() {
    const now = Date.now()
    if (this.snapshot !== undefined && now - this.snapshotAt < SNAPSHOT_TTL_MS) return this.snapshot
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.build(now)
      .then((snapshot) => {
        this.snapshot = snapshot
        this.snapshotAt = Date.now()
        return snapshot
      })
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /**
   * 单会话明细：供会话标签页（`conversation.view` 的「费用」）使用。
   *
   * ## 为什么不复用 `/data`
   *
   * `/data` 是**全量**的：160 多个会话、十几个模型、一年日历。而会话标签页
   * 一次只显示**一条**会话，让它在每次切换标签页时拉全量数据既慢又浪费。
   * 因此宿主单独交一条：逐模型用量 + 逐日用量 + 该会话用到的单价。
   *
   * ## 金额口径：合计 = 逐行金额之和
   *
   * 每行金额用 `sessionCost()`（与费用条、看板完全同一套分档口径）算一次并
   * 取整到 6 位，**合计取这些已取整行值之和**。这样屏幕上「合计」与它下面
   * 那几行之和**严格相等**——用户一定会加一遍，尾差会让整个数字显得不可信。
   * 与输入框费用条那一枚（按原始用量算完才取整）在 10⁻⁶ 量级可能相差一点，
   * 但界面上都按分显示，看不到差异。
   * @param {string} id - 会话 id。
   * @returns {Promise<object|undefined>} undefined 表示这条会话不存在。
   */
  async readSessionDetail(id) {
    const data = await this.read()
    const session = (data.sessions ?? []).find((row) => row.id === id)
    if (session === undefined) return undefined
    const detail = this.sessionDetails?.get(id) ?? { byModel: {}, byDay: {} }
    // 模型显示名 / 提供商名：`data.models` 里已经算好，直接按复合键索引。
    const metas = new Map((data.models ?? []).map((model) => [model.key, model]))

    const entries = Object.entries(detail.byModel).map(([key, totals]) => {
      const meta = metas.get(key)
      const rollup = meta?.rollup ?? rateKeyOfModelKey(key)
      const prices = pricingOf(rollup)
      const rates = prices.rates
      return {
        key,
        rollup,
        provider: meta?.provider ?? '',
        providerLabel: meta?.providerLabel ?? '',
        // 外显名以 DSH 设置里那条为准（`data.models` 已按同一规则算好），
        // 拿不到才退回价目表里的官方名。
        label: meta?.label ?? rates?.label ?? rollup,
        vendor: rates?.vendor ?? '',
        // 价目表里没有这个模型时如实标出来：金额是估算，不是官方价。
        priced: prices.known === true,
        totals,
        cost: sessionCost({ [key]: totals }),
      }
    })
    entries.sort((a, b) => Number(b.cost.standard) - Number(a.cost.standard))

    const days = Object.entries(detail.byDay)
      .map(([key, dayModels]) => ({
        key,
        totals: roundUsage(sumUsageOf(dayModels)),
        // 当天的金额仍按**逐模型**算：拿日合计查一次价只会命中一个模型，
        // 其余落到兜底价（实测能差五倍）。
        cost: sessionCost(dayModels),
      }))
      .sort((a, b) => a.key.localeCompare(b.key))

    const round6 = (value) => Math.round(value * 1e6) / 1e6
    const total = { standard: 0, peak: 0, idle: 0, ifAllIdle: 0, saved: 0 }
    for (const entry of entries) {
      for (const field of Object.keys(total)) total[field] += Number(entry.cost?.[field] ?? 0)
    }
    for (const field of Object.keys(total)) total[field] = round6(total[field])

    // 该会话用到的模型单价：客户端不必自己按路由 id 再查一次价目表
    // （查不到会静默回落 Flash 价，那正是「表格列错位」的老根因）。
    const pricing = {}
    for (const entry of entries) {
      const prices = pricingOf(entry.rollup)
      pricing[entry.key] = {
        rates: prices.rates,
        // 这一行的**加价倍率**：按它自己的提供商取，缺省 1。
        markup: markupOf(entry.provider),
        currency: prices.rates?.currency ?? data.pricing?.currency ?? 'CNY',
      }
    }

    // 团队口径：只有**真的多成员**的团队才给（单人会话在界面上不该变成「团队」）。
    const teamRow = (data.teams ?? []).find((team) => team.id === session.teamId)
    const team = teamRow !== undefined && Number(teamRow.memberCount ?? 0) >= 2
      ? {
        id: teamRow.id,
        title: teamRow.title,
        memberCount: teamRow.memberCount,
        cost: teamRow.cost,
        totals: teamRow.totals,
        members: (teamRow.members ?? []).map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          live: member.live === true,
          totals: member.totals,
          cost: member.cost,
        })),
      }
      : null

    return {
      generatedAt: data.generatedAt,
      timezone: data.timezone,
      version: data.version,
      capabilities: data.capabilities,
      session,
      entries,
      days,
      cost: total,
      pricing: {
        currency: data.pricing?.currency ?? 'CNY',
        unit: data.pricing?.unit ?? 'per-million-tokens',
        ...(data.pricing?.usdToCny === undefined ? {} : { usdToCny: data.pricing.usdToCny }),
        models: pricing,
        source: data.pricing?.source,
      },
      team,
    }
  }

  /**
   * 扫描全部会话：抽账本记录、收集会话元信息，并把记录并入账本。
   *
   * 账本是「合并」语义：本机日志里已有的记录按 `sessionId:seq` 去重后追加，
   * 因此多台机器各自跑一遍，就能在同一份账本上累积出完整历史。
   * @param {number} now - 当前时刻。
   * @returns {Promise<{records:object[],sessions:object[],ledger:{path:string,machine:string,added:number,total:number,enabled:boolean,error?:string}}>}
   */
  async collect(now) {
    const persistence = this.persistence()
    const snapshots = persistence === undefined ? [] : await this.listSnapshots(persistence)
    // 模型 / 提供商显示名目录：每次扫描重建一次（设置里改了模型名立刻反映到看板上）。
    const directory = await buildModelDirectory(this.llm())
    /** @type {object[]} */
    const records = []
    /** @type {object[]} */
    const sessions = []
    /**
     * 本轮扫描到的全部会话元信息（id → `{ id, header }`），供团队归属向上走链。
     *
     * 单列一张表而不是复用 `sessions[]`：归属计算发生在行构造**之前**，而
     * `sessions[]` 的行是按显示顺序排的、字段也已经被加工过。
     * @type {Map<string, {id:string,header:object}>}
     */
    const byId = new Map()

    // 第一遍：会话元信息 + 团队归属。归属要「向上走链」，因此必须先把本条
    // 会话的父会话也收齐，而不能边遍历边判（父会话可能排在子会话之后）。
    const visits = snapshots
      .map((snapshot) => ({ snapshot, header: snapshot.header ?? {} }))
      .filter((item) => String(item.header.id ?? '') !== '')
    for (const { header } of visits) {
      const id = String(header.id)
      byId.set(id, { id, header })
    }

    for (const { snapshot, header } of visits) {
      const id = String(header.id)
      const timezone = this.timezone()
      // 指纹 = 派生结果所依赖的**全部**输入：schema 版本 + 日志身份 + 站点时区。
      // 时区必须计入：`days` 就是按它把时间戳归日的，换时区而不失效缓存会让
      // 会话清单里的日期与看板的日行对不上（生产里它是常量，但缓存不该靠这个假设）。
      const fingerprint = `v${CACHE_SCHEMA}:${String(snapshot.revision ?? '')}:${snapshot.eventCount ?? ''}:${snapshot.sizeBytes ?? ''}@${timezone}`
      const cached = this.cache.get(id)
      // 缓存里存的是**派生结果**（记录 / 轮次数 / 标题 / 归日 / 名册），
      // 不是原始事件——见 readSession 的说明：留事件本身会让常驻内存随历史线性增长。
      let derived
      if (cached !== undefined && cached.fingerprint === fingerprint) {
        derived = cached
      } else {
        derived = { fingerprint, ...(await readSession(persistence, id, timezone)) }
        this.cache.set(id, derived)
      }

      const sessionDays = derived.days
      // 提供商补全在**每一轮**扫描时做，而不是缓存进派生结果：目录每次重建，
      // 补全结果因此跟着设置走（缓存的只有与目录无关的那部分）。
      for (const record of derived.records) records.push(withRouteOf(record, directory))

      const cwd = typeof header.cwd === 'string' ? header.cwd : ''
      const placement = teamPlacementOf({ id, header }, byId)
      sessions.push({
        id,
        // 成员名/职责默认空串而不是缺字段：客户端会读它们决定徽标文案，
        // 缺字段（undefined）在 JSX 里会渲染成空，但 `undefined !== ''` 这类判据
        // 到处都要多写一个分支——统一给空串，含义仍是「没有」。
        memberName: '',
        createdAt: Number(header.createdAt ?? 0),
        cwd,
        workspace: workspaceLabel(cwd),
        // 预览标题与 DSH 侧栏同源（见 displayTitleOf）：会话清单靠它把
        // 一行十六进制 id 换成用户认得出的那一句话。
        title: displayTitleOf(derived.title, cwd, id),
        agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
        isSeeded: header.isSeeded === true,
        turns: derived.turns,
        // ── 用量视角的时间维度 ──────────────────────────────────────
        //
        // 金额与 token 只说明「花了多少资源」，而人真正消耗的是**注意力与时间**：
        // 跑了 40 分钟的会话与 40 秒结束的会话，对使用者的负担完全不同。
        // 这里给出跨度两端、步数与工具调用次数——全部来自同一次日志扫描，不额外读盘。
        //
        // 用 0 而不是缺省字段：0 的含义是「没有可比数据」（空会话 / 旧宿主），
        // 客户端据此显示 `—`，而不是假装「0 秒」。
        firstAt: derived.firstAt,
        lastAt: derived.lastAt,
        steps: derived.steps,
        toolCalls: derived.toolCalls,
        // 轮次耗时：总墙钟 / 已结算轮数 / 最久一轮（0 = 没有可比数据）。
        turnWallMs: derived.turnWallMs,
        /**
         * 耗时分解（等待 / 回复 / 工具）。
         *
         * 用户明确否掉了「活跃时长 = 创建到最后使用」：放三周再来聊两句的会话会被
         * 算成几百小时。这里给的是**模型真正在干活**的那段时间。
         */
        timing: derived.timing,
        timedTurns: derived.timedTurns,
        maxTurnMs: derived.maxTurnMs,
        // 已排好序（见 readSession）：这里是「与目录无关」的派生结果，直接复用。
        days: sessionDays,
        live: this.sessions?.()?.get?.(id) !== undefined,
        // 团队归属：`lead` 是团队根，`teammate` 归到 `teamId` 名下。
        // 缺这两个字段的就是旧宿主（客户端据此退回单会话口径，见 capabilities 的 agentTeam）。
        teamId: placement.teamId,
        role: placement.role,
        // 深度 > 1 的成员是「teammate 自己再派的子代理」——它仍算该团队的一部分，
        // 但界面上要说清它离 lead 有多远，否则会与直接成员混成一排。
        depth: placement.depth,
        // 父会话已被删除 / 不在本机：链断了，但仍然归到已知的最高祖先。
        ...(placement.detached ? { detached: true } : {}),
      })
    }

    // 这一轮扫描补上了新会话/新事件就落盘，下次启动直接复用（见 scheduleCacheSave）。
    // 放在循环之后统一写一次，避免 300 个会话产生 300 次小写入。
    this.scheduleCacheSave()

    /**
     * 名册：`teammate id → 团队里的名字`。
     *
     * **只有 Lead 的日志里有 `team/member`**（见 readSession），因此这里按
     * `derived.members` 逐条铺开。名字缺失时退回子会话的 `subagent/descriptor.label`
     * 再退回 id 片段——三层回落，但**绝不猜**一个名字出来。
     * @type {Map<string, {name:string,phase:string}>}
     */
    const roster = new Map()
    for (const session of visits) {
      const id = String(session.header.id)
      const derived = this.cache.get(id)
      for (const member of derived?.members ?? []) {
        roster.set(member.id, { name: member.name, phase: member.phase })
      }
    }
    for (const row of sessions) {
      if (row.role !== 'teammate') continue
      const known = roster.get(row.id)
      const derived = this.cache.get(row.id)
      row.memberName = known?.name ?? ''
      // 名册上的生命周期（provisioning / active / failed）只在**名册有它**时才有意义；
      // 普通子代理不在任何团队里，因此留空而不是编一个 phase。
      if (known !== undefined) row.memberPhase = known.phase
      // 一句话职责（spawn 时的 description）——与 name 不是一回事，单独一个字段。
      if (typeof derived?.label === 'string' && derived.label !== '') row.memberLabel = derived.label
    }

    // 账本不可用时（路径都推不出）退化为只统计本机日志，而不是整块失败
    const added = this.ledger === undefined
      ? { added: 0, total: records.length }
      : await this.ledger.merge(records)
    const ledger = {
      path: this.ledger?.path ?? null,
      machine: this.machine,
      enabled: this.ledger !== undefined,
      added: added.added,
      total: added.total,
      // 旧账本里没有提供商字段。这两个计数只报**本次**扫描发生的迁移与补全，
      // 报完即清零：否则「账本被迁移过」会一直挂在界面上，看起来像每次都出问题。
      ...(this.ledger?.upgraded > 0 ? { upgraded: this.ledger.upgraded } : {}),
      ...(added.enriched > 0 ? { enriched: added.enriched } : {}),
      ...(this.ledger?.dropped > 0 ? { dropped: this.ledger.dropped } : {}),
      ...(this.ledger?.lastError === undefined ? {} : { error: this.ledger.lastError }),
    }
    if (this.ledger !== undefined) {
      this.ledger.upgraded = 0
      this.ledger.dropped = 0
    }
    const merged = this.ledger === undefined ? records : this.ledger.records
    return { records: merged, sessions, ledger, directory }
  }

  /**
   * 扫描并聚合看板数据。
   * @param {number} now - 当前时刻。
   * @returns {Promise<object>} 看板数据。
   */
  async build(now) {
    // 先把上次运行留下的会话缓存捞回来：重启后第一次打开看板不必重扫 300+ 会话。
    // 必须在 collectSessions 之前，否则这一轮又变成全量扫描。
    await this.loadDiskCache()
    const timezone = this.timezone()
    // 每次聚合前复查自定义价目：改了文件不必重启，刷新看板即生效。
    // 失败不影响取数（价目退回内置表），但错误会随 payload 交到界面。
    // 先把文件读进来（有变化才重读），再取状态
    try {
      await this.customRates?.load?.()
    } catch {
      // load 内部已把失败记进 lastError；这里只防止它意外抛出拖垮取数。
    }
    let ratesStatus
    try {
      ratesStatus = this.customRates?.describe?.()
    } catch {
      // describe 纯内存读取，正常不会抛；真抛了也不该拖垮整块看板。
      ratesStatus = undefined
    }
    const { records, sessions, ledger, directory } = await this.collect(now)

    /** @type {Map<string, object>} */
    const days = new Map()
    /** @type {Record<string, object>} */
    const modelTotals = {}
    /** @type {Map<string, {rollup:string,provider:string,natives:Set<string>,usage:object}>} */
    const modelMeta = new Map()
    /** @type {Map<string, object>} */
    const bySession = new Map()
    /**
     * 单会话的逐模型 / 逐日用量：**只给会话标签页那条路由**用，不进 `/data`。
     *
     * 为什么单独留一份而不是塞进 `sessions[]`：`sessions[]` 有 160 多行，
     * 每行再带十几条模型明细会让 `/data` 体积翻好几倍，而看板一次也用不到
     * 那些明细（它只显示每会话的合计）。反过来，会话标签页每次只看**一条**
     * 会话，一条的明细只有几百字节。
     *
     * 因此这里只留「派生结果」（取整后的用量），并且**不随 `/data` 序列化**：
     * 它由 `/dsh-pixel/session` 按会话 id 取一条。
     * @type {Map<string, {byModel:object, byDay:object}>}
     */
    const sessionDetails = new Map()
    /**
     * 日历数据：按天索引的请求 / 会话 / token。
     *
     * 早先这里还有一份「星期 × 小时」分布，供单独的小时热力图使用；那张图已按
     * 需求去掉，这里就不再计算——留着没人读，只会让响应变大。
     */
    const calendar = {
      requests: new Array(HEATMAP_DAYS).fill(0),
      sessions: new Array(HEATMAP_DAYS).fill(0),
      tokens: new Array(HEATMAP_DAYS).fill(0),
      // 每格的消费估计。与 requests 同一套 day 索引，悬停时直接用同一个 `cell`。
      costs: new Array(HEATMAP_DAYS).fill(0),
    }
    /** 同一格里可能有多条请求，按会话去重需要逐格收集。 */
    const daySessions = Array.from({ length: HEATMAP_DAYS }, () => new Set())
    const heatmap = new Array(HEATMAP_DAYS * 24).fill(0)
    const anchor = zonedParts(now, timezone)
    const anchorUtc = Date.UTC(anchor.year, anchor.month - 1, anchor.day)
    const firstDayUtc = anchorUtc - (HEATMAP_DAYS - 1) * 86_400_000

    for (const record of records) {
      const usage = usageOfRecord(record)
      if (usage.local <= 0 && usage.requests === 0) continue
      const sessionId = String(record.s ?? '')
      // 条目身份 = **模型 × 提供商**。模型部分用归一后的价目表键（旧名 / 带发售日的
      // 变体名都折到同一行），而不是路由上的原生 id —— 否则同一个 DeepSeek 模型
      // 会因为 `deepseek-v4.1-flash` / `deepseek/deepseek-v4.1-flash` 这种写法差异
      // 各占一行，看起来像好几个模型。
      const rollup = String(record.r ?? '') === '' ? rollupOf(record.n ?? record.m) : String(record.r)
      // 提供商优先用 DSH 实时目录反查出来的**路由名**：账本里旧的迁移值可能是网关
      // 自己的叫法（Command Code 的 id 前缀是 `deepseek/`，路由名却是 `commandcode`）。
      const provider = directory.nativeProvider.get(String(record.n ?? ''))
        ?? String(record.p ?? '')
      const model = provider === '' ? rollup : `${rollup}@${provider}`

      // 关键：按该请求**发生时刻**判定时段。跨设备记录同样带原始时间戳，
      // 因此别的机器在高峰时段跑的量不会被按本机当前时段错算。
      //
      // 一次格式化取齐「日期键 + 高峰判定 + 墙钟时/日」：这三个量全部来自同一个
      // 时间戳，分别调 `dateKey()` / `isPeak()` / `zonedParts()` 会把同一次 Intl
      // 格式化重复三遍。实测本机 20,007 条记录因此每次聚合白花约 6 万次调用。
      const facts = zonedFacts(Number(record.t), timezone)
      const peak = facts.peak

      const meta = modelMeta.get(model) ?? { rollup, provider, natives: new Set() }
      if (typeof record.n === 'string' && record.n !== '') meta.natives.add(record.n)
      modelMeta.set(model, meta)

      addUsage((modelTotals[model] ??= emptyUsage()), usage, peak)

      const sessionAcc = bySession.get(sessionId)
        ?? { totals: emptyUsage(), byModel: {}, days: new Set(), byDay: {} }
      addUsage(sessionAcc.totals, usage, peak)
      addUsage((sessionAcc.byModel[model] ??= emptyUsage()), usage, peak)
      bySession.set(sessionId, sessionAcc)

      const key = facts.key
      sessionAcc.days.add(key)
      // 逐日 × 逐模型用量：会话标签页要画「这条会话哪天花了多少」。
      //
      // **必须按模型分开存**，不能只存当天的合计：金额是按模型单价折算的，
      // 拿日合计去查一次价只能查到一个模型，其余会落到兜底价——金额会错，
      // 而且不报错。实测把日期键当模型键去查价，第二天（GLM-5.3）的金额
      // 从 ¥0.0244 掉到 ¥0.0032，合计相差五倍。
      const dayModels = (sessionAcc.byDay[key] ??= {})
      addUsage((dayModels[model] ??= emptyUsage()), usage, peak)
      const day = days.get(key) ?? { key, totals: emptyUsage(), byModel: {}, sessions: new Set() }
      addUsage(day.totals, usage, peak)
      addUsage((day.byModel[model] ??= emptyUsage()), usage, peak)
      day.sessions.add(sessionId)
      days.set(key, day)

      const parts = facts.parts
      const cell = Math.round((Date.UTC(parts.year, parts.month - 1, parts.day) - firstDayUtc) / 86_400_000)
      if (cell >= 0 && cell < HEATMAP_DAYS) {
        heatmap[cell * 24 + parts.hour] += 1
        calendar.requests[cell] += 1
        calendar.tokens[cell] += Number(record.i ?? 0) + Number(record.o ?? 0)
        daySessions[cell].add(sessionId)
      }
    }

    // 把账本里的用量合进会话元信息：会话可能来自别的机器，本机没有它的日志
    for (const session of sessions) {
      const acc = bySession.get(session.id)
      bySession.delete(session.id)
      if (acc === undefined) {
        session.totals = roundUsage(emptyUsage())
        session.cost = sessionCost({})
        session.models = []
        continue
      }
      session.totals = roundUsage(acc.totals)
      // 会话级费用：输入框下方的费用条直接用它显示「本次会话花了多少」。
      // 这里就按分档算好，避免客户端再拼一遍口径。
      session.cost = sessionCost(acc.byModel)
      session.models = Object.keys(acc.byModel).sort()
      session.days = [...acc.days].sort()
      // 明细只留取整后的派生用量：会话标签页按它画逐模型表与逐日花费。
      // 这里只存结果、不留 `acc.byModel` 引用——留引用等于把原始累加器
      // 钉在快照上，而 `bySession` 随后就该被回收。
      sessionDetails.set(session.id, {
        byModel: roundByModel(acc.byModel),
        byDay: roundByDayModels(acc.byDay),
      })
    }
    // 仅存在于账本（其它机器）的会话也补进清单，否则跨设备历史会凭空消失
    for (const [sessionId, acc] of bySession) {
      // 明细同样要留：这些会话也能在会话标签页里打开（它们确实有账本里的用量）。
      sessionDetails.set(sessionId, {
        byModel: roundByModel(acc.byModel),
        byDay: roundByDayModels(acc.byDay),
      })
      sessions.push({
        id: sessionId,
        createdAt: Number(records.find((record) => record.s === sessionId)?.t ?? 0),
        cwd: '',
        workspace: '(其它设备)',
        // 账本里只有用量，没有标题也没有工作目录：按同一条回落链给会话 id，
        // 界面上会把它连同「(其它设备)」一起显示，不会被误认成本机会话。
        title: displayTitleOf('', '', sessionId),
        agentPreset: '',
        isSeeded: false,
        turns: 0,
        totals: roundUsage(acc.totals),
        cost: sessionCost(acc.byModel),
        models: Object.keys(acc.byModel).sort(),
        days: [...acc.days].sort(),
        live: false,
        // 只在账本里出现的会话没有会话头，因此**没有任何团队线索**：
        // 它是自己的根（旧宿主 / 跨设备历史都是这个口径），而不是被猜进某个团队。
        teamId: sessionId,
        role: 'lead',
        depth: 0,
        memberName: '',
      })
    }

    const dayRows = [...days.values()]
      .map((day) => ({
        key: day.key,
        totals: roundUsage(day.totals),
        byModel: roundByModel(day.byModel),
        sessions: day.sessions.size,
        // 当天的消费估计（按每条请求**发生时刻**的时段分档算）。
        // 与 `costByModel` 同一口径，因此日行相加与总费用一致。
        cost: sessionCost(day.byModel),
      }))
      .sort((a, b) => a.key.localeCompare(b.key))

    /**
     * 日历每格的消费估计，**从 `dayRows` 派生**，而不是在记录循环里另算一遍。
     *
     * 两处各算一次看着「同源」，实际会漂移：记录循环里逐条累加得到 2.1017944，
     * 而 `sessionCost()` 会把日行金额**四舍五入到 6 位**（2.101794）。于是悬停某一格
     * 显示的金额与该日行、与按日明细都对不上——差的是尾数，但它恰好落在用户会
     * 逐位比对的同一个数字上（实测 6 天里 5 天不一致）。
     *
     * 因此这里只做**一次映射**：日行的 key 反算出格号，金额直接用 `cost.standard`。
     * 构造上不可能再漂移。
     */
    for (const row of dayRows) {
      const cell = Math.round(
        (Date.parse(`${row.key}T00:00:00Z`) - firstDayUtc) / 86_400_000,
      )
      if (cell >= 0 && cell < HEATMAP_DAYS) calendar.costs[cell] = Number(row.cost?.standard ?? 0)
    }

    const today = dateKey(now, timezone)
    const todayTotals = dayRows.find((row) => row.key === today)?.totals ?? roundUsage(emptyUsage())
    const models = Object.entries(modelTotals)
      .map(([model, usage]) => {
        const meta = modelMeta.get(model) ?? { rollup: rateKeyOfModelKey(model), provider: '', natives: new Set() }
        const pricing = pricingOf(meta.rollup)
        const rates = pricing.rates
        // 外显名优先用 DSH 设置里那一条（同一个归一模型在某提供商下可能对应多条
        // 原生 id，取哪一条由 buildModelDirectory 的 canonical 规则决定）。
        //
        // 设置里把名字留空时 DSH 会让名字等于模型 id（`deepseek-flash`），
        // 那不是一个「外显名」，直接显示会得到一行没有可读名字的条目；
        // 退回价目表里的官方名，再不行才用归一键。
        const catalogName = meta.provider === ''
          ? undefined
          : directory.byRollup.get(`${meta.provider}\u0000${meta.rollup}`)?.name
        const label = catalogName === undefined || catalogName === meta.rollup
          ? (rates.label ?? meta.rollup)
          : catalogName
        return {
          // key 就是条目身份：`模型@提供商`。客户端一律用它去 byModel 里定位用量。
          key: model,
          model,
          rollup: meta.rollup,
          provider: meta.provider,
          providerLabel: meta.provider === ''
            ? ''
            : (directory.providerNames.get(meta.provider) ?? meta.provider),
          // 外显名以 **DSH 设置里的名字**为准（用户改了就跟着改），
          // 设置里读不到（或名字只是模型 id）时才退回价目表里的官方名。
          label,
          // 这一条底下合并了哪些路由 id（`hy4-preview-f` 与 `deepseek-v4.1-flash`
          // 都折进了同一个 Flash）。账本里保留的原生名就是它们，界面上悬停可查——
          // 少了它，「为什么这两个名字合成一行」在界面上无从验证。
          routes: [...meta.natives].sort(),
          // 只在该路由**自己就是价目表那一行**时给具体版本号。价目表是官方
          // DeepSeek 的版本（`DeepSeek-V4.1-Flash`），套到别的提供商那条路由上
          // 就是替第三方承诺了一个它没给的版本号。
          version: meta.provider === '' || meta.provider === 'deepseek-official' ? (rates.version ?? '') : '',
          // 单价是否真的知道：兜底价会被界面标成「按 Flash 估算」，不假装精确
          priced: pricing.known,
          tiered: pricing.tiered,
          vendor: pricing.vendor,
          // 逐模型单价：客户端**不能**再去宿主的价目表里按原生 id 查一次——
          // 那里没有 `deepseek/deepseek-v4.1-flash` 这类路由 id，查不到就会静默
          // 回落到 Flash 价（踩过：GLM 那一行的「不分时」判定因此算错，表格列数错位）。
          rates,
          cost: {
            standard: costOf(usage.peak, rates, 'peak') + costOf(usage.idle, rates, 'idle'),
            peakOnly: costOf(usage.peak, rates, 'peak'),
            idlePart: costOf(usage.idle, rates, 'idle'),
          },
          totals: roundUsage(usage),
        }
      })
      .sort((a, b) => b.totals.local - a.totals.local)

    const roundedModelTotals = {}
    for (const [model, usage] of Object.entries(modelTotals)) roundedModelTotals[model] = roundUsage(usage)

    /**
     * 团队分组：把 `sessions[]` 按 `teamId` 归拢。
     *
     * ## 只有「真的成团队」的才单列
     *
     * `members.length > 1` 才算团队。一个光杆会话（本机绝大多数）既没有 teammate、
     * 也没人把它当队友，给它单开一行团队只会让清单翻倍，而信息量为零。
     * 这些「单人团队」仍保留 `teamId`（就是它自己），因此客户端按 teamId 找永远
     * 找得到——只是不必列出来。
     *
     * ## 每个成员都要能被展开
     *
     * 用户要的是「费用条默认显示团队合计，悬停按成员分列」。因此每条团队行都带
     * 逐成员的 `cost` 与 `totals`，客户端不必自己再算一遍（口径只在一个地方）。
     * @type {object[]}
     */
    const teams = (() => {
      /** @type {Map<string, object[]>} */
      const groups = new Map()
      for (const session of sessions) {
        const teamId = typeof session.teamId === 'string' && session.teamId !== ''
          ? session.teamId
          : session.id
        const bucket = groups.get(teamId) ?? []
        bucket.push(session)
        groups.set(teamId, bucket)
      }
      /**
       * 成员排序：lead 永远第一，其余按「费用降序 → 开始时间降序」。
       * 按费用排是因为用户点开这一行就是想看「谁花的」，花钱多的先看到。
       */
      const orderMembers = (list) => [...list].sort((a, b) => {
        if (a.role !== b.role) return a.role === 'lead' ? -1 : 1
        const diff = Number(b.cost?.standard ?? 0) - Number(a.cost?.standard ?? 0)
        if (diff !== 0) return diff
        return Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)
      })
      const out = []
      for (const [teamId, list] of groups) {
        if (list.length < 2) continue
        const members = orderMembers(list)
        const lead = members.find((member) => member.role === 'lead')
        const summary = summarizeTeam(members)
        out.push({
          id: teamId,
          // 团队本身没有名字（DSH 的团队是隐式根，只有成员有名字），
          // 因此用 lead 的标题当团队标题——那正是用户在侧栏认得出的那一句话。
          title: lead?.title ?? displayTitleOf('', '', teamId),
          leadId: lead?.id ?? teamId,
          // 成员数含 lead 自己：界面上写「3 位成员」时用户数的是人，不是「队友数」。
          memberCount: members.length,
          totals: summary.totals,
          cost: summary.cost,
          members: members.map((member) => ({
            id: member.id,
            title: member.title,
            role: member.role,
            // 团队名册里的名字（`team/member`）优先；没有就退回子代理描述；再退回标题。
            name: member.memberName !== undefined && member.memberName !== ''
              ? member.memberName
              : (member.memberLabel ?? member.title),
            depth: member.depth ?? 0,
            live: member.live === true,
            ...(member.detached === true ? { detached: true } : {}),
            ...(member.memberPhase === undefined ? {} : { phase: member.memberPhase }),
            turns: member.turns,
            tokens: Number(member.totals?.local ?? 0),
            totals: member.totals,
            cost: member.cost,
          })),
        })
      }
      return out.sort((a, b) => Number(b.cost?.standard ?? 0) - Number(a.cost?.standard ?? 0))
    })()

    // 单会话明细挂在数据对象上供 `/dsh-pixel/session` 按 id 取一条；
    // 它**不参与 `/data` 的序列化**（下方响应体是逐字段挑出来拼的，不会带上它）。
    this.sessionDetails = sessionDetails

    return {
      generatedAt: now,
      timezone,
      version: IMPL_VERSION,
      capabilities: CAPABILITIES,
      // 账本信息：路径与来源机器，用于确认跨设备同步是否生效
      machine: this.machine,
      ledger,
      period: periodState(now, timezone),
      peakRule: {
        windows: PEAK_WINDOWS,
        weekdays: PEAK_WEEKDAYS,
        // 法定节假日表：客户端只用来**说明**（哪几天被当成空闲、日历收录到哪一年），
        // 判定一律以宿主按每条请求发生时刻算出的分档为准，绝不在浏览器里重算一遍——
        // 两边各算一次就会漂移，而对不上的数字比没有数字更糟。
        holidays: { years: HOLIDAY_YEARS, days: [...HOLIDAY_KEYS].sort() },
        note: '高峰时段为北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00；'
          + '其余时段，包括全部周末与中国法定节假日全天，均为空闲时段，空闲价为高峰价的一半。'
          + '调休上班的周末同样按空闲时段计费。',
      },
      // 自定义价目的状态（路径、条数、错误）交到界面：用户需要知道
      // 「我写的价到底生效了没」，而不是只能靠金额反推。
      ...(ratesStatus === undefined ? {} : { customRates: ratesStatus }),
      pricing: {
        currency: 'CNY',
        unit: 'per-million-tokens',
        // 美元价目折算成人民币用的汇率。价目表里 USD 的条目由 pricing.js 的
        // 生效视图统一折算，界面也要标出「按汇率 X 折算」，否则用户看到一个
        // 人民币金额会以为是官方人民币价。
        usdToCny: usdToCny(),
        // 提供商加价倍率（第三方中转按 token 收的价往往与官方不同）。
        // 只是给界面展示「这一家乘了几倍」，金额本身在 costByModel 里已经算进去了。
        markup: activeMarkup(),
        // 生效中的价目表 = 内置 + 用户补充（见 lib/custom-rates.js）。
        // 交**生效的那一份**，否则界面「单价表」显示的还是内置价，而金额已经按
        // 自定义价算了——同一张卡片上两个数字互相矛盾。
        rates: activeRates(),
        // 逐模型单价，按**模型键**与**归一键**各索引一次（见 ratesOfModels）。
        // 客户端拿到的是宿主已经查好的那一份，不必也不能自己按路由 id 再查一次
        // （查不到会静默回落 Flash 价）。
        models: ratesOfModels(models),
        source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      },
      overview: {
        totals: sumDays(dayRows),
        sessions: sessions.length,
        activeDays: dayRows.length,
        firstDay: dayRows[0]?.key ?? null,
        lastDay: dayRows.at(-1)?.key ?? null,
        // 站点时区下的「今天」。客户端必须用它去 days 里定位当天，
        // **不能**拿 `days.at(-1)` 当今天：那是「最后一个有数据的日子」，
        // 今天还没跑过请求时它就是昨天，卡片上的「今日费用」会显示昨天的数字。
        today,
        streaks: streaks(dayRows.map((row) => row.key), today),
        modelsUsed: models.length,
      },
      windows: {
        today: todayTotals,
        last7: sumDays(dayRows.slice(-7)),
        last30: sumDays(dayRows.slice(-30)),
        all: sumDays(dayRows),
      },
      cost: costByModel(roundedModelTotals),
      days: dayRows,
      models,
      sessions: sessions.sort((a, b) => b.createdAt - a.createdAt),
      // 智能体团队分组（只有真的多成员的团队才在这里）。`sessions[]` 上另有
      // `teamId` / `role` 可供客户端自行归组，这一份是宿主已经算好的合计，
      // 保证「团队合计」与「成员分列」用的是同一份口径、同一份取整。
      teams,
      heatmap: {
        firstDay: new Date(firstDayUtc).toISOString().slice(0, 10),
        days: HEATMAP_DAYS,
        cells: heatmap,
        max: Math.max(1, ...heatmap),
        // 按天聚合：一天一个方块，供年历使用
        requests: calendar.requests,
        sessions: calendar.sessions.map((_, index) => daySessions[index].size),
        tokens: calendar.tokens,
        // 每格的消费估计，与 requests / tokens **同一套 day 索引**（同一天序号，
        // 不是 `days` 那种稀疏数组）。悬停某格时直接按同一个 `day` 取，
        // 不必再拿日期去反查——两套索引混用正是错位的来源。
        costs: calendar.costs,
        maxRequests: Math.max(1, ...calendar.requests),
      },
    }
  }

  /**
   * 列出可读会话快照。
   * @param {object} persistence - ctx.sessionPersistence。
   * @returns {Promise<object[]>} 快照数组。
   */
  async listSnapshots(persistence) {
    try {
      const all = await persistence.list()
      return Array.isArray(all) ? all.filter((row) => row !== null && typeof row === 'object') : []
    } catch {
      return []
    }
  }
}

/**
 * 给一条账本记录补上「提供商」——只有在能**确定**时才补。
 *
 * 只有一种情况算确定：该原生模型 id 在实时模型目录里只由**一家**提供商提供，
 * 或它本身就是 `提供商/模型` 形态（斜杠左边就是提供商的自称）。
 * 其余一律留空串：把认不出的记录随便归给某一家，会让「按提供商区分」这件事
 * 从一个事实退化成一次猜测——而用户看这张表的目的正是分辨来源。
 * @param {object} record - `recordOf()` 产出的记录。
 * @param {object} directory - `buildModelDirectory()` 的结果。
 * @returns {object} 可能补上 `p` 的记录。
 */
function withRouteOf(record, directory) {
  if (typeof record.p === 'string' && record.p !== '') return record
  const native = typeof record.n === 'string' ? record.n : ''
  const inferred = directory.nativeProvider.get(native)
    ?? (directory.candidates.get(native)?.size === 1 ? [...directory.candidates.get(native)][0] : undefined)
  return inferred === undefined || inferred === '' ? record : { ...record, p: inferred }
}

/**
 * 从复合键里取提供商（`模型@提供商` → `提供商`）。
 *
 * 与 {@link rateKeyOfModelKey} 正好互补：那个取模型部分去查价，这个取提供商
 * 部分去查**加价倍率**。裸键（没有 `@`）表示「官方价」，返回空串，倍率按 1 算。
 * @param {string} modelKey - 复合键或裸模型键。
 * @returns {string} 提供商路由名；裸键时是空串。
 */
function providerOfModelKey(modelKey) {
  const text = String(modelKey ?? '')
  const at = text.indexOf('@')
  return at < 0 ? '' : text.slice(at + 1)
}

/**
 * 把逐模型单价按**归一键**摊平成一张表，供客户端按同一口径计价。
 *
 * 客户端拿到的原生 id 可能是 `deepseek/deepseek-v4.1-flash`（路由 id），
 * 而价目表里只有 `deepseek-flash`。让客户端自己查就会静默回落到 Flash 价——
 * 那正是「GLM 那一行被当成不分时、表格列数错位」的根因。宿主这里已经知道
 * 每一行的模型是什么，直接把它用的那份价目交出去。
 *
 * ## 两个键的形状**不一样**（这里踩过一次）
 *
 * | 键 | 形状 | 含义 | 谁在用 |
 * |---|---|---|---|
 * | `模型@提供商` | `{ rates, markup, currency }` | 该**路由**的价目：单价 × 该提供商的倍率 | 会话标签页、费用明细逐行 |
 * | 裸 `模型` | **裸 RATE**（`{cacheHit, cacheMiss, output, …}`） | **官方价**，倍率恒为 1 | 看板的「官方价 vs 我的价」对比 |
 *
 * 裸键**必须保持裸 RATE**：看板那边把它当价目直接读 `mine.cacheHit?.peak`，
 * 若改成包装对象，三个数字会全部取到 undefined 并按 `?? 0` 显示成 **¥0**——
 * 有数字、不报错、完全看不出异常。`tools/test.mjs` 也因此断言裸键**就是**
 * `models[0].rates` 那个对象。
 * @param {object[]} models - `build()` 里已算好的模型条目。
 * @returns {Record<string, object>} 键 → 价目（复合键是包装，裸键是 RATE）。
 */
function ratesOfModels(models) {
  const out = {}
  for (const model of models) {
    // 精确身份：带该提供商的倍率。会话标签页按 modelKey 读这个包装。
    out[model.key] = { rates: model.rates, markup: markupOf(model.provider), currency: 'CNY' }
    // 官方价（裸键）：保持 v2 的**裸 RATE**，看板与 test.mjs 都按它读。
    if (out[model.rollup] === undefined) out[model.rollup] = model.rates
  }
  return out
}

/**
 * 分档桶里要保留的字段。
 *
 * 单列一份常量而不是在每处手写清单（踩过三次）：`roundUsage` 的 bucket、
 * `sumDays` 的累加、`summarizeTeam` 的汇总都必须用**同一份**字段列表。
 * 每次漏掉 cacheWrite，分时金额就少算「写缓存」那部分；漏掉 local，
 * 「峰时/闲时各用了多少 token」就无从回答——而这两处都不会报错，只会静默偏小。
 */
const BUCKET_FIELDS = ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'local', 'requests']

/** 用量取整（含分时段），减小响应体积。 */
function roundUsage(usage) {
  const bucket = (value) => {
    const out = {}
    for (const field of BUCKET_FIELDS) out[field] = Math.round(Number(value?.[field] ?? 0))
    return out
  }
  return {
    cacheHit: Math.round(usage.cacheHit),
    cacheMiss: Math.round(usage.cacheMiss),
    cacheWrite: Math.round(usage.cacheWrite),
    output: Math.round(usage.output),
    reasoning: Math.round(usage.reasoning),
    local: Math.round(usage.local),
    requests: Math.round(usage.requests),
    peak: bucket(usage.peak),
    idle: bucket(usage.idle),
  }
}

/** @param {Record<string, object>} byModel - 模型 → 用量。 */
function roundByModel(byModel) {
  const out = {}
  for (const [model, usage] of Object.entries(byModel)) out[model] = roundUsage(usage)
  return out
}

/**
 * 逐日 × 逐模型用量取整（日期键 → 模型 → 用量）。
 *
 * 与 {@link roundByModel} 同形，只是多一层日期。**必须走 `roundUsage`**：
 * 手写一份取整会漏掉某个分档字段，而漏掉的表现是「分时金额与合计对不上」
 * ——不报错，只是数字小一点。
 * @param {Record<string, Record<string, object>>} byDay - 日期键 → 模型 → 用量。
 * @returns {Record<string, Record<string, object>>} 取整后的副本。
 */
function roundByDayModels(byDay) {
  const out = {}
  for (const [day, byModel] of Object.entries(byDay ?? {})) {
    const bucket = {}
    for (const [model, usage] of Object.entries(byModel ?? {})) bucket[model] = roundUsage(usage)
    out[day] = bucket
  }
  return out
}

/**
 * 把「模型 → 用量」求合成一份用量（同一天多个模型摊成一行）。
 *
 * 合计桶与分档桶都要累加：缺一档的表现同样是「分时金额对不上」，且不抛错。
 * @param {Record<string, object>} byModel - 模型 → 用量。
 * @returns {object} 合计用量。
 */
function sumUsageOf(byModel) {
  const acc = emptyUsage()
  for (const usage of Object.values(byModel ?? {})) {
    for (const field of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local', 'requests']) {
      acc[field] += Number(usage?.[field] ?? 0)
    }
    for (const part of ['peak', 'idle']) {
      for (const field of BUCKET_FIELDS) acc[part][field] += Number(usage?.[part]?.[field] ?? 0)
    }
  }
  return acc
}

/** 求和多天用量。 */
function sumDays(rows) {
  const acc = emptyUsage()
  for (const row of rows) {
    const totals = row.totals ?? {}
    for (const key of ['cacheHit', 'cacheMiss', 'cacheWrite', 'output', 'reasoning', 'local', 'requests']) {
      acc[key] += Number(totals[key] ?? 0)
    }
    for (const part of ['peak', 'idle']) {
      for (const key of BUCKET_FIELDS) {
        acc[part][key] += Number(totals[part]?.[key] ?? 0)
      }
    }
  }
  return roundUsage(acc)
}

/**
 * 由活跃日期表算当前与最长连续天数。
 * @param {string[]} keys - 升序 `YYYY-MM-DD`。
 * @param {string} today - 站点时区的今天。
 * @returns {{current:number,longest:number}}
 */
function streaks(keys, today) {
  if (keys.length === 0) return { current: 0, longest: 0 }
  const dayMs = 86_400_000
  let longest = 1
  let run = 1
  for (let i = 1; i < keys.length; i += 1) {
    run = Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`) === dayMs ? run + 1 : 1
    if (run > longest) longest = run
  }
  const tailGap = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${keys.at(-1)}T00:00:00Z`)) / dayMs
  let current = 0
  if (tailGap <= 1) {
    current = 1
    for (let i = keys.length - 1; i > 0; i -= 1) {
      if (Date.parse(`${keys[i]}T00:00:00Z`) - Date.parse(`${keys[i - 1]}T00:00:00Z`) !== dayMs) break
      current += 1
    }
  }
  return { current, longest }
}

/**
 * 工作目录 → 末段目录名（取不到时是空串，不编占位）。
 *
 * 与 DSH 客户端的 `workspaceTitleOf` 同一口径：两种分隔符都认，
 * 末尾的分隔符忽略。
 * @param {unknown} cwd - 绝对工作目录。
 * @returns {string} 目录末段；空/无末段时是空串。
 */
function workspaceBase(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

/** 工作目录 → 展示用名（取不到时给一个可读占位）。 */
function workspaceLabel(cwd) {
  if (cwd === '') return '(未知目录)'
  return workspaceBase(cwd) || cwd
}

/**
 * 会话预览标题：持久标题 → 工作目录末段 → 会话 id。
 *
 * **刻意与 DSH 侧栏任务栏同源。** 客户端 `session-controller` 的
 * `displayTitleOf()` 就是这三档回落，侧栏那一行显示的正是它；这里照抄同一条
 * 规则，看板里的会话清单才会与用户眼睛看到的侧栏标题是**同一个字符串**。
 * 早先会话清单只显示 `session.id.slice(8, 16)`——一串十六进制，用户没法把它
 * 和侧栏里任何一个会话对上号。
 * @param {string} title - `session/title` 事件折叠出的最新标题。
 * @param {string} cwd - 会话创建时的工作目录。
 * @param {string} id - 会话 id。
 * @returns {string} 可读的预览标题。
 */
function displayTitleOf(title, cwd, id) {
  if (typeof title === 'string' && title !== '') return title
  const base = workspaceBase(cwd)
  return base !== '' ? base : id
}

/**
 * 统一的 JSON 响应出口。
 *
 * 抽出来是因为「状态码 + 两个头 + 序列化」这三件事在四条路由里重复了十来次，
 * 而漏掉 `cache-control: no-store` 这类错误**不会报错**，只会让浏览器端
 * 拿到过期数据——这种错最难查，交给一个函数保证。
 * @param {object} res - ServerResponse。
 * @param {number} status - 状态码。
 * @param {object} payload - 要序列化的负载。
 * @param {boolean} [headOnly] - 只写头，不写体（HEAD 请求）。
 * @returns {void}
 */
function sendJson(res, status, payload, headOnly) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(headOnly === true ? undefined : JSON.stringify(payload))
}

/** 允许的请求体上限：开关只有 `{enabled:boolean}` 几十字节。 */
const MAX_BODY_BYTES = 4 * 1024

/**
 * 轻量的同源闸门：写配置的路由不接受跨站表单触发。
 *
 * `sec-fetch-site` 缺失（老浏览器 / 命令行）时**不拦**——用它当唯一凭据会把
 * 正常用法一起挡掉；它只是让现代浏览器里的跨站 POST 多一道拦截。
 * @param {object} req - IncomingMessage。
 * @returns {boolean} 是否应当拒绝。
 */
function crossSite(req) {
  const site = req.headers?.['sec-fetch-site']
  return typeof site === 'string' && site !== 'same-origin' && site !== 'none'
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 超限时**不**销毁连接：销毁会让那条 keep-alive 连接来不及把 400 响应写回去，
 * 调用方就只能看到一个「连接被重置」而不是「请求体过大」。这里改为停止累积、
 * 继续把剩余数据读掉（drain），让连接保持可用。
 * @param {object} req - IncomingMessage。
 * @returns {Promise<unknown>} 解析结果。
 * @throws {Error} 体过大或不是合法 JSON。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let oversize = false
    let settled = false
    /** 只结算一次：data/end/error 可能在同一请求里都触发。 */
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk) => {
      if (oversize) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        oversize = true
        chunks.length = 0
        fail(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => { fail(error) })
    req.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        settled = true
        resolve(undefined)
        return
      }
      // 先解析再标记已结算：若把 settled 提前置真，JSON.parse 抛错时 fail()
      // 会因为「已结算」直接返回，这个 Promise 就永远不落地了。
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        fail(new Error('请求体不是合法 JSON'))
        return
      }
      settled = true
      resolve(parsed)
    })
  })
}

/**
 * 宿主半边插件体：注册只读数据路由，并在会话提交后让缓存失效。
 *
 * 以对象形式导出，因为必须声明 `inject: ['webServer']`：实测在 profile 组合里
 * apply 执行时 webServer 可能尚未发布，此时若自行判空返回，整行会静默不激活
 * （路由 404 且没有任何报错）。交给 Cordis 等待服务就绪才是正确做法。
 * 其余服务（sessionPersistence / sessions）可能确实不存在，保持 ctx.get 惰性读取。
 */
export default {
  name: 'pixel-dashboard',

  inject: ['webServer'],

  /**
   * @param {object} ctx - 宿主 Cordis 上下文，webServer 已就绪。
   * @returns {void}
   */
  apply(ctx) {
    // 用户补充的单价（$DSH_HOME/plugins/dsh-pixel-dashboard/custom-rates.json）。
    // **必须建在 catalog 之前**：聚合器在构造时就接住它，而它自己的构造只记路径、
    // 不读盘（真正的读取发生在每次聚合前的 load()）。
    // 读一次就生效，且每次看板取数都复查文件——用户改完价格文件不必重启 dsh，
    // 刷新看板即可看到新价（见 lib/custom-rates.js）。
    const customRates = new CustomRates({})

    const catalog = new UsageCatalog({
      persistence: () => ctx.get('sessionPersistence'),
      sessions: () => ctx.get('sessions'),
      timezone: () => DEFAULT_TIMEZONE,
      // 自定义价目交给聚合器：它负责在每次聚合前复查文件
      customRates,
      // LLM 注册表用于两件事：提供商的显示名，以及模型在 **DSH 设置里** 的名字。
      // 它可能晚于本插件发布（客户端插件之间没有顺序保证），因此惰性读取，
      // 读不到就退回价目表里的名字——只影响标签，不影响任何数字。
      llm: () => ctx.get('llm'),
    })

    // 开关存储两个功能**共用**：各写各的文件会互相覆盖（读—改—写竞态）。
    const prefs = new Preferences(resolvePrefsPath(), { balanceEnabled: true, plansEnabled: true, ...NOTIFY_DEFAULTS })

    // 余额查询：凭据与设置都惰性读取，缺任一项都退化为「余额不可用」，
    // 而不是让整个插件失效（见 lib/balance.js）。
    const balance = new BalanceService({
      credentials: () => ctx.get('credentials'),
      settings: () => ctx.get('settings'),
      // 「当前登录的 DeepSeek 账号」：头像 / 昵称 / 余额 / 官方链接都从它来。
      // 惰性读取（旧宿主、web 端未登录时它是 undefined），缺失时 BalanceService
      // 自动退回按 API Key 查 /user/balance 的老路径。
      account: () => ctx.get('deepseekAccount'),
      prefs,
    })

    // 第三方套餐额度（智谱 Coding Plan / Command Code）。两家都是未文档化的内部
    // 接口，因此全程 fail-soft：一家失败只标那一家（见 lib/plans.js）。
    const plans = new PlansService({
      credentials: () => ctx.get('credentials'),
      prefs: () => prefs.read(),
    })

    /**
     * 会话结束事实的通知日志（见 lib/notify.js）。
     *
     * 只活在内存里、有明确上限，且**不受开关控制地照记**：一条记录只是一个
     * 小对象，而「刚把通知打开却什么也收不到」比多占几百字节糟得多。
     * 开关与阈值都在同一次读取里交给浏览器，由它决定要不要弹。
     */
    const journal = new NotifyJournal()

    /**
     * 「会话 id → 子智能体的名字 / 一句话描述」。
     *
     * ## 为什么要在事件流里攒这一张表
     *
     * 通知里要写「子智能体 alice 有新进展」，而名字有两个来源，**都在日志里**：
     *   - 团队名册（`team/member` 的 `member.name`）——但那些事件**只写进 Lead 的
     *     日志**，子会话自己那份里没有；
     *   - 子代理描述（`subagent/descriptor` 的 `label`）——写在**子会话自己**的
     *     日志里，是 spawn 时那句 `description`。
     *
     * 通知的判定发生在 `turn/end` 这一刻，那里只有一个活的 Session 对象，读不到
     * 日志。所以只能顺着 `session/event` 把它们抄下来：两条事件都很小（几十字节），
     * 而文件名册是 last-wins 的整体快照，重写同一个键即可，不会堆积。
     *
     * ## 上限与判据
     *
     * 有界（{@link AGENT_FACT_LIMIT}）：这是常驻内存，一台长跑的机器上会话数量
     * 没有上限，而这里存的是**显示用**的名字——丢掉旧的只会让某条老会话的通知
     * 少一个名字，不该反过来撑大内存。刻意**不落盘**：名字只是文案，重启后缺失
     * 时通知照样能发（只是不写名字）。
     */
    const agentNames = new Map()
    const agentLabels = new Map()
    /**
     * 写进有界表：超上限时丢最早的一条（Map 保证插入顺序）。
     *
     * 先 `delete` 再 `set` 是为了让「重新出现的键」变成最新的一条，否则名册
     * （last-wins 的整体快照）会一直停在最早的位置，成为最先被丢掉的条目。
     * @param {Map<string,string>} table - 目标表。
     * @param {string} key - 键（会话 id）。
     * @param {string} value - 值。
     */
    const remember = (table, key, value) => {
      table.delete(key)
      table.set(key, value)
      while (table.size > AGENT_FACT_LIMIT) {
        const oldest = table.keys().next().value
        // 表空时 `value` 是 undefined：没有可丢的就停，绝不在这里绕成死循环。
        if (oldest === undefined) break
        table.delete(oldest)
      }
    }
    /**
     * 抄一条「名字 / 描述」事实。
     *
     * `team/member` 落在**名册**上（键是成员自己的会话 id，不是 Lead 的），
     * `subagent/descriptor` 落在**发事件的那条会话**上。两者键不同源，因此不能
     * 用一个统一的 key 写进去——那正是「名字张冠李戴」的成因。
     * @param {string} sessionId - 发事件的会话 id。
     * @param {object|undefined} event - 会话事件。
     */
    const rememberAgentFact = (sessionId, event) => {
      const type = event?.type
      if (type === 'team/member') {
        const member = event.data?.member
        const id = typeof member?.id === 'string' ? member.id : ''
        const name = typeof member?.name === 'string' ? member.name.trim() : ''
        // 名册是整体快照、last-wins：同名成员每次生命周期变化都会再写一条。
        if (id !== '' && name !== '') remember(agentNames, id, name)
        return
      }
      if (type === 'subagent/descriptor') {
        const label = event.data?.label
        if (typeof label === 'string' && label.trim() !== '' && sessionId !== '') {
          remember(agentLabels, sessionId, label.trim())
        }
      }
    }

    /** 读出归一化后的通知配置。补丁在写入前已归一，这里再归一一次兜住手改的文件。 */
    const notifyConfig = async () => normalizeNotify(await prefs.read())

    /**
     * 注册一条宿主路由，并让它随本插件的销毁一起注销。
     *
     * ## 为什么必须过 ctx.effect（这不是洁癖，是一个会让插件启动失败的缺陷）
     *
     * `webServer.register()` **返回一个注销函数**，注销的时机由调用方负责。裸调 `register`
     * 等于把路由永久留在 webServer 上。而本插件的 profile 开着 `patchReload: live`：
     * profile 折叠插件行时 Cordis 会**销毁这条 fiber 再重新 apply**。第二次 apply 时
     * 上一轮的 8 条路由仍在表里，`register` 于是在第一条上抛：
     *
     *   webserver: duplicate exact route "/dsh-pixel/version"
     *
     * 表现就是桌面端重启后「1 entry did not activate pixel-dashboard」——插件整块不激活，
     * 看板、费用条、时段指示灯一起消失，而报错只在启动日志里。DSH 自家包（如
     * open-in-app）一律写成 `ctx.effect(() => ctx.webServer.register({...}))`，本插件原先
     * 漏了这一层。
     *
     * 把 register 的返回值交给 effect：fiber 销毁时调用它，路由随之释放，下一次 apply
     * 拿到的是干净的表。
     * @param {{kind:'exact'|'prefix',path:string,handler:Function}} route - 路由定义。
     * @returns {void}
     */
    const route = (route) => {
      ctx.effect(() => ctx.webServer.register(route), `pixel-dashboard: ${route.path}`)
    }

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/version`,
      handler: (req, res) => {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify({ version: IMPL_VERSION, routePrefix: ROUTE_PREFIX }))
      },
    })

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/period`,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 只跑一次纯函数：不碰账本、不碰会话日志，因此这条路由永远廉价、永远可用。
        // 侧栏那枚时段指示灯要每秒重画，挂到 `/data`（全量扫描 + 20s TTL）上的话，
        // 页面打开要等一次全量扫描才看得到它，账本读不出来时连纯时钟信息也一起没了。
        const now = Date.now()
        sendJson(res, 200, {
          generatedAt: now,
          timezone: DEFAULT_TIMEZONE,
          version: IMPL_VERSION,
          period: periodState(now, DEFAULT_TIMEZONE),
          // 侧栏那行倒计时只用得到 period；这里仍带上规则，是为了让「为什么现在是
          // 空闲」在国庆那类日子能说清是哪个节（见 ./holidays.js）。
          peakRule: { windows: PEAK_WINDOWS, weekdays: PEAK_WEEKDAYS, holidayYears: HOLIDAY_YEARS },
        }, req.method === 'HEAD')
      },
    })

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/balance`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        let payload
        try {
          payload = await balance.read({ refresh: url.searchParams.get('refresh') === '1' })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        // HEAD 与 GET 走同一条逻辑，但只回头部；金额是唯一载荷，不必为其开一条分支。
        sendJson(res, 200, payload, req.method === 'HEAD')
      },
    })

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/plans`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        let payload
        try {
          payload = await plans.read({ refresh: url.searchParams.get('refresh') === '1' })
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        sendJson(res, 200, payload, req.method === 'HEAD')
      },
    })

    /**
     * 单会话明细（会话标签页用）。
     *
     * `GET /dsh-pixel/session?id=<sessionId>`
     *
     * 只读、无副作用：不重扫会话日志（复用 `/data` 那份快照的 TTL 缓存），
     * 因此频繁切换会话标签页不会把磁盘读爆。会话 id 认不出时回 404 而不是
     * 空对象——「这条会话不存在」与「这条会话没有任何用量」是两件事，
     * 界面上说法完全不同。
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/session`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('id') ?? ''
        if (id === '') {
          sendJson(res, 400, { error: '缺少 id 参数' })
          return
        }
        let payload
        try {
          payload = await catalog.readSessionDetail(id)
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (payload === undefined) {
          sendJson(res, 404, { error: '会话不存在' })
          return
        }
        sendJson(res, 200, payload, req.method === 'HEAD')
      },
    })

    /**
     * 通知日志 + 预警阈值配置。
     *
     * `GET  /dsh-pixel/notify?since=<cursor>` 读增量（游标缺失 = 从现在开始订阅）；
     * `POST /dsh-pixel/notify` 写阈值与开关。
     *
     * 读写共用一条路由是刻意的：两者永远一起被需要（面板一进来就要同时显示
     * 「当前阈值」和「最近发生了什么」），拆成两条只会让客户端多写一次取数的
     * 错误处理。写走 POST，与只读的余额 / 套餐路由口径一致。
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/notify`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const config = await notifyConfig()
          sendJson(
            res,
            200,
            { config, ...journal.read({ since: url.searchParams.get('since') }) },
            req.method === 'HEAD',
          )
          return
        }
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (crossSite(req)) {
          req.resume?.()
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'body 需要是一个对象' })
          return
        }
        // 先与现值合并再归一：面板允许只提交改动的那一项，其余保持不动。
        const merged = { ...(await notifyConfig()), ...body }
        const { persisted } = await prefs.patch(normalizeNotify(merged))
        sendJson(res, 200, { config: await notifyConfig(), persisted })
      },
    })

    /**
     * `POST /dsh-pixel/focus` —— 把 DSH 桌面端窗口拉到前台。
     *
     * ## 为什么这件事要绕到宿主来做
     *
     * 渲染进程**没有**任何提窗口的能力：实测 `window.focus()` 无效，preload 暴露的
     * 桥（`PLATFORM_IPC` / `DESKTOP_IPC`）里也没有 focus / activate / raise。
     * 但桌面壳的主进程里有现成实现 `focusPrimaryWindow()`，它做
     * `restore() → show() → focus()`，并被三处调用：托盘点击、`app.on('activate')`、
     * 以及 **`dsh://open` 协议**（`app.setAsDefaultProtocolClient('dsh')` +
     * `app.on('open-url')`）。
     *
     * 渲染进程触发不了协议（主窗口的 `setWindowOpenHandler` 只放行 http/https，
     * `dsh://` 被 deny），但**宿主是 Node 进程，可以启动外部程序**——于是这里用
     * 一次 `start "" "dsh://open"` 把系统唤起，由主进程接管并聚焦窗口。
     *
     * ## 失败即静默，但要如实回报
     *
     * 这条路径依赖「桌面端装了协议处理器」。在纯 `dsh web`（浏览器）里它没有意义，
     * 也可能在受限环境里失败——那都只是「窗口没被拉到前台」，绝不能影响
     * 已经完成的会话切换。因此永远返回 200 + `{ attempted, ok }`，把结果交给调用方决定。
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/focus`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 这条路由会让宿主启动外部程序，因此同样只接受同源请求。
        if (crossSite(req)) {
          req.resume?.()
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        req.resume?.()
        const result = await raiseDesktopWindow()
        sendJson(res, 200, result)
      },
    })


    const TOGGLES = {
      balance: { key: 'balanceEnabled', service: balance, label: '余额查询' },
      plans: { key: 'plansEnabled', service: plans, label: '第三方套餐监控' },
    }

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/toggle`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        // 轻量的同源闸门：这个开关会让宿主向第三方端点发请求，不接受跨站表单触发。
        // 拒绝时要把请求体抽干：不读干净会让这条 keep-alive 连接上的后续请求错位。
        if (crossSite(req)) {
          req.resume?.()
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const target = TOGGLES[String(body?.target ?? '')]
        if (target === undefined) {
          sendJson(res, 400, { error: `target 需要是 ${Object.keys(TOGGLES).join(' / ')} 之一` })
          return
        }
        if (typeof body?.enabled !== 'boolean') {
          sendJson(res, 400, { error: 'body 需要 { target, enabled: boolean }' })
          return
        }
        if (target.service.lockedByEnv) {
          sendJson(res, 200, {
            target: body.target,
            enabled: false,
            persisted: false,
            lockedByEnv: true,
            message: `${target.label}已被环境变量关闭`,
          })
          return
        }
        const { persisted } = await prefs.patch({ [target.key]: body.enabled })
        // 关掉时立刻清缓存：重新打开必须是一次真实请求，而不是端上一份旧快照。
        target.service.invalidate?.()
        sendJson(res, 200, { target: body.target, enabled: body.enabled, persisted, lockedByEnv: false })
      },
    })

    /**
     * 自定义价目：读取（GET）与写入（POST）。
     *
     * 这条路由存在的唯一理由是**让用户不必改源码就能补价**：新模型发布得很勤，
     * 而「我用的模型没有价」的表现是它被标成「估算价」并按 Flash 兜底折算——
     * 数字有、不报错，只是错的。
     *
     * 写入走 PUT 语义（整份替换）而不是增量补丁：价目是一个小对象，整份提交最
     * 不容易出现「漏了一个字段导致某条价消失」。校验失败**一个字节都不落盘**，
     * 并把每一条错误原文回报给界面。
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/rates`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendJson(res, 200, customRates.describe(), req.method === 'HEAD')
          return
        }
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (crossSite(req)) {
          req.resume?.()
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const payload = body !== null && typeof body === 'object' ? body.rates : undefined
        if (payload === undefined || payload === null || typeof payload !== 'object') {
          sendJson(res, 400, { error: 'body 需要是 { rates: { 模型键: 价目 } }' })
          return
        }
        const saved = await customRates.save(payload)
        if (!saved.ok) {
          // 校验失败：状态码 400 + 逐条原因。界面直接展示，而不是一句「保存失败」。
          sendJson(res, 400, { ...customRates.describe(), errors: saved.errors })
          return
        }
        sendJson(res, 200, { ...customRates.describe(), persisted: saved.persisted })
      },
    })

    /**
     * 套餐凭据的现状清单 + 按勾选移除。
     *
     * `GET  /dsh-pixel/plan-credentials` 读现状（只读，不动任何东西）；
     * `POST /dsh-pixel/plan-credentials` 移除用户**明确勾选**的那几条。
     *
     * 读写共用一条路由，理由与 `/notify` 相同：界面一进「移除套餐」就同时需要
     * 「现在有什么」与「移除后变成什么」，拆成两条只会让客户端多写一次取数的
     * 错误处理。而移除的返回体**就是**复核后的新清单，用户不必再点一次刷新。
     *
     * 这是本插件第二条**写**路由（第一条是开关）。它比开关危险得多——删的是
     * 用户自己配的密钥，所以三道闸门缺一不可：
     *   1. 同源检查（跨站表单不得触发删除）；
     *   2. 宿主的 `credentials.unset` 原样调用（不手改 YAML：那会绕过 DSH 的
     *      跨进程文件锁与 0600/0700 权限处理，并可能覆盖另一个进程刚写的记录）；
     *   3. 引用名白名单（见 lib/plans.js 的 planVendorInventory）。
     *
     * 走 `route()` 而不是裸 `ctx.webServer.register`：新增这条路时上游刚修掉
     * 「重新 apply 时 duplicate route」那个缺陷（2.10.2），裸调用会原样复现它。
     */
    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/plan-credentials`,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          try {
            sendJson(res, 200, await plans.credentialInventory(), req.method === 'HEAD')
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method !== 'POST') {
          req.resume?.()
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        if (crossSite(req)) {
          req.resume?.()
          sendJson(res, 403, { error: 'cross-site request rejected' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const refs = body?.refs
        if (!Array.isArray(refs) || refs.some((name) => typeof name !== 'string')) {
          sendJson(res, 400, { error: 'body 需要是 { refs: string[] }' })
          return
        }
        try {
          sendJson(res, 200, await plans.removeCredentials(refs))
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    })

    route({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/data`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.searchParams.get('refresh') === '1') catalog.invalidate()
        let body
        try {
          body = JSON.stringify(await catalog.read())
        } catch (error) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(req.method === 'HEAD' ? undefined : body)
      },
    })

    // 会话提交/关闭后数据会变：标记失效，下一次请求重扫。
    ctx.on('session/flush', () => {
      catalog.invalidate()
    })
    ctx.on('session/disposed', () => {
      catalog.invalidate()
    })

    // 会话结束时记一条通知事实。判定与文案都在 lib/notify.js 里，这里只做转接。
    //
    // 为什么必须在这里做：客户端的事件窗口只装载**当前选中**的会话，后台会话的
    // `turn/end` 在浏览器里是看不到的——而那恰恰是最需要被提醒的时候。
    //
    // **子智能体的 `turn/end` 与主会话长得一模一样**（同一条事件、同样的 reason），
    // 区别只在会话头的 `origin` / `parentSession` 上。而「谁刚收工」恰恰是要不要
    // 把用户叫回来的分水岭：主会话跑完 = 该你了；子智能体跑完 = 只是有进展。
    // 因此这里顺带喂一份名字（见 agentNames），由浏览器决定措辞与强度。
    //
    // 整个处理体包在 try/catch 里：`session/event` 是一条**热路径**，持久化、
    // 投影、遥测都挂在上面。监听器抛错会中断同一次 emit 的后续订阅者（最坏的
    // 后果是会话日志没落盘），而这条通知最多只是少一条提醒。附加功能的失败
    // 绝不能升级成主链路的失败——与余额 / 套餐的 fail-soft 是同一条口径。
    ctx.on('session/event', (session, event) => {
      try {
        const sessionId = String(session?.id ?? session?.header?.id ?? '')
        // 先抄下来「谁是子智能体、叫什么」——`turn/end` 走到下面时就要用，
        // 而这两类事件本身很小（见 agentNames 的说明）。
        rememberAgentFact(sessionId, event)
        const notice = noticeOf(
          session,
          event,
          workspaceLabel(session?.header?.cwd ?? ''),
          // 名字与描述**只在已知时**才传：缺失时通知里就不写名字，
          // 而不是编一个「子智能体 1」出来。
          { name: agentNames.get(sessionId), label: agentLabels.get(sessionId) },
        )
        if (notice === undefined) return
        journal.record(notice)
        // 日志变了就顺手让看板快照失效：面板里的「最近通知」不必等满一个 TTL。
        catalog.invalidate()
      } catch (error) {
        ctx.logger?.warn?.(
          error instanceof Error ? error : new Error(`通知记录失败：${String(error)}`),
        )
      }
    })
  },
}
