/**
 * 通知与预警（浏览器半边）：判定、去重与文案。**纯逻辑，不含 React**，
 * 因此可以直接被渲染闸门渲染、被单元测试断言。
 *
 * ## 三条职责边界
 *
 *   1) **会话结束**（完成 / 失败 / 中断）的事实由宿主给（见宿主 lib/notify.js）。
 *      浏览器拿不到后台会话的 `turn/end`，所以这里只负责「要不要弹、弹什么」。
 *   2) **需要授权 / 回答**由浏览器自己发现：DSH 把待办发布在 `ctx.uiSession` 上，
 *      直接读它比让宿主再转发一趟更短、也不会与产品自己的状态脱节。
 *      **可观察量有两代**：0.1.6-alpha.2 起是 `uiSession.sessionStatus`
 *      （`Map<SessionId, SessionStatus>`，待办在每条的 `pendingInteraction` 上），
 *      更早是 `uiSession.pendingInteractions`（`Map<SessionId, interaction>`）。
 *      读数的兼容层在 `NotifierRuntime#pendingSource`——**不要在这里只认一代**。
 *   3) **余额 / 套餐阈值**在这里算：余额与额度本来就在这一侧取（同一份 60s / 30s
 *      缓存），把阈值判定放到宿主只会让同一份数字被解析两次。
 *
 * ## 为什么不落任何状态
 *
 * 「已经提醒过什么」全部只在内存里。提醒是**瞬时**的：刷新页面后重新从上一次
 * 已知的边界开始，正是用户期望的行为。落盘反而会带来「换了台机器还弹旧提醒」
 * 这类更难解释的现象。
 * @module dsh-pixel-dashboard/client/notify
 */

/** 通知配置取数与写回路由。 */
export const NOTIFY_URL = '/dsh-pixel/notify'

/** 配置请求超时。 */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * 通知配置的默认值，与宿主 lib/notify.js 的 `NOTIFY_DEFAULTS` 一致。
 *
 * 两侧各留一份是刻意的：宿主那份是**权威**（每次读取都会带上），这份只在
 * 「宿主还没答话」时兜底，好让面板第一帧就能渲染出正确的开关状态而不是空壳。
 * 两边改一处忘了另一处**不会**造成功能错误——宿主的回应总会覆盖它。
 */
export const NOTIFY_DEFAULTS = {
  notifyEnabled: true,
  notifyDone: true,
  notifyError: true,
  notifyInteraction: true,
  notifyBalance: true,
  notifyQuota: true,
  notifyQuietFocused: true,
  warnBalance: {},
  warnQuotaPercent: 90,
}

/** 开关的展示元数据：面板按这个顺序渲染，文案只有这一份来源。 */
export const NOTIFY_FLAGS = [
  { key: 'notifyEnabled', label: '总开关', hint: '关掉后不再弹任何通知（面板仍会记录最近发生的事）' },
  { key: 'notifyDone', label: '任务完成', hint: '一轮对话正常跑完时提醒' },
  { key: 'notifyError', label: '失败 / 中断', hint: '轮次报错、被取消、达到输出上限或异常结束时提醒' },
  { key: 'notifyInteraction', label: '等待授权 / 回答', hint: '需要你点授权，或 AI 提问等你回答时提醒' },
  { key: 'notifyBalance', label: '余额预警', hint: '账户余额低于下面设定的阈值时提醒' },
  { key: 'notifyQuota', label: '套餐额度预警', hint: '任一套餐窗口已用比例达到阈值时提醒' },
  { key: 'notifyQuietFocused', label: '当前会话不打扰', hint: '你正开着、正看着的那个会话跑完时不弹通知，避免自己吓自己；别的会话照常提醒' },
]

/** 浏览器通知权限的展示文案。 */
export const PERMISSION_TEXT = {
  granted: '已允许，通知会出现在系统通知中心',
  denied: '已被浏览器拒绝，请在地址栏左侧的站点设置里重新允许',
  default: '尚未授权，点击右侧按钮申请',
  unsupported: '当前环境没有 Notification API（可能是非安全上下文），只能用页面内提示',
}

/**
 * 「最近通知」里给**被静默**那条加的尾注。
 *
 * 单独放这里而不是写死在面板里：运行时写入的 `quiet` 标记与面板展示的这句话是
 * 同一件事的两半，两边各写一份就会出现「标了 quiet 但界面不说明」这种半截状态。
 * 闸门也对它断言，因此改了文案就必须同步改测试——不会静默漂移。
 */
export const QUIET_MARK = '（已静默，未弹窗）'

/**
 * 「最近通知」里某一行的正文。
 *
 * 抽成纯函数是为了让闸门能直接断言它——面板把「最近通知」默认收起，
 * 整页静态渲染根本到不了这一块（`Collapse` 收起时**不渲染**内容），
 * 写死在 JSX 里的文案就等于永远没被验过。
 * @param {object} item - `store.recent` 里的一项。
 * @returns {string} 行正文。
 */
export function composeRecentLine(item) {
  const title = String(item?.title ?? '')
  const body = item?.body === undefined || item.body === '' ? '' : ` — ${String(item.body)}`
  // 被「当前会话不打扰」静默的那条照样列出来，并明说它没弹：否则用户看到的是
  // 「有个会话完成了却什么都没发生」，只会以为功能漏了提醒。
  return `${title}${body}${item?.quiet === true ? QUIET_MARK : ''}`
}

/**
 * 请求地址 → 系统通知权限。
 *
 * 三种「没有 Notification API」的情况都要归到 `unsupported`：
 * 服务端渲染（`window` 不存在）、非安全上下文（http 且非 localhost，浏览器
 * 会隐藏该 API）、以及老浏览器。把它们混进 `default` 会让面板显示一个点了
 * 没反应的按钮。
 * @param {object} [scope] - 全局对象，测试注入用。
 * @returns {'granted'|'denied'|'default'|'unsupported'} 权限状态。
 */
export function permissionOf(scope = globalThis) {
  const Notification = scope?.Notification
  if (typeof Notification !== 'function') return 'unsupported'
  const value = Notification.permission
  return value === 'granted' || value === 'denied' ? value : 'default'
}

/**
 * 会话界面的 DOM 锚点：DSH 的 `ConversationRoot` 把这个属性打在滚动容器上。
 *
 * 用它而不是某个 CSS 类名（类名是压缩产物，一升级就变），也不用
 * `list.current`——**「选中了哪条会话」与「屏幕上是什么」是两件事**，
 * 见 {@link shouldStayQuiet}。
 */
export const CONVERSATION_ANCHOR_SELECTOR = '[data-conversation-scroll]'

/** 主区被某个浮层占满时的标记：会话界面还在 DOM 里，但用户看不见它。 */
export const FULLSCREEN_OVERLAY_SELECTOR = '[data-rightbar-fullscreen]'

/**
 * 「会话界面此刻真的在屏幕上吗」。
 *
 * ## 为什么要问这一句
 *
 * DSH 的主区是**一个 keyed 槽位**（`renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })`）：
 * 选中「用量看板」这类全局面板时，会话界面**整个不挂载**——而
 * `sessions.list.current` 仍然停在上次选中的那条会话上。
 *
 * 于是只比较 `current` 就会得出「他正在看这条会话」的错误结论，把提醒静默吞掉。
 * 用户正在看**看板**时收到「别的会话完成了」本该弹的提醒，表现就是「漏提醒」。
 *
 * ## 判不出来时一律返回 false（= 不静默）
 *
 * 少静默一次最多是「你盯着它跑完，通知和界面同时响」这种轻微打扰；多静默一次
 * 则是**一条永远不会被看见的提醒**。两者不对称，所以任何读不出来的情况
 * （没有 `document`、选择器被上游改掉、查询抛错）都必须落到「不静默」那一侧。
 * @param {object} [doc] - `document` 之类能 querySelector 的对象。
 * @returns {boolean} 会话界面是否确实在屏幕上。
 */
export function conversationOnScreen(doc) {
  if (typeof doc?.querySelector !== 'function') return false
  try {
    // 浮层占满主区时会话界面并没有被卸载，只是被盖住了——对用户而言同样是「没在看」。
    if (doc.querySelector(FULLSCREEN_OVERLAY_SELECTOR) !== null) return false
    return doc.querySelector(CONVERSATION_ANCHOR_SELECTOR) !== null
  } catch {
    return false
  }
}

/**
 * 这条会话结束提醒是否应当**不打扰**。
 *
 * 四个条件**同时**成立才跳过，缺一个就照常提醒：
 *
 *   1) 开关开着（默认开着）；
 *   2) 页面确实有焦点——否则用户切去了别的标签页 / 别的应用，正是最该提醒的时候；
 *   3) 这条提醒说的**就是**当前选中的那条会话；
 *   4) 那条会话的界面**真的在屏幕上**（见 {@link conversationOnScreen}）。
 *
 * 第 4 条是后补的，也正是原先漏掉的一条：只比 `current` 会把「主区停在看板上」
 * 误判成「正在看这条会话」，于是那条会话完成时提醒被静默吞掉。
 *
 * 纯函数：所有环境读数由调用方取好传进来，因此闸门可以逐条钉住这四件事。
 * @param {object} notice - 宿主通知记录。
 * @param {object} view - 当前视图事实。
 * @param {object|undefined} view.config - 通知配置。
 * @param {boolean} view.focused - 页面是否有焦点。
 * @param {unknown} view.current - 当前选中的会话 id。
 * @param {boolean} view.onScreen - 会话界面是否在屏幕上。
 * @returns {boolean} 是否跳过这条提醒。
 */
export function shouldStayQuiet(notice, view) {
  // 配置还没到手时**不静默**：`undefined` 是「还没读到用户设置」，不是「用户开了它」。
  // 生产路径上此时 `#enabled` 已经先一步跳过（没配置就一律不派发），这一条只是把
  // 契约钉死，免得日后有人绕过 `#enabled` 直接调它。
  if (view?.config === undefined) return false
  if (view.config.notifyQuietFocused === false) return false
  if (view?.focused !== true) return false
  const sessionId = String(notice?.sessionId ?? '')
  // 没有会话 id 的提醒（余额 / 套餐阈值）不属于任何会话，谈不上「正在看它」。
  if (sessionId === '') return false
  const current = view?.current
  if (current === undefined || String(current) !== sessionId) return false
  return view?.onScreen === true
}

/**
 * 由一条宿主通知事实拼出通知标题与正文。
 *
 * 标题带工作目录名：同时跑几个会话时，「已完成」这三个字本身不提供任何信息，
 * 而「哪个目录完成了」才是你要判断「现在要不要回去看」的依据。
 * @param {object} notice - 宿主 lib/notify.js 产出的记录。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
export function composeNotice(notice) {
  const workspace = typeof notice?.workspace === 'string' && notice.workspace !== ''
    ? notice.workspace
    : '(未知目录)'
  const label = typeof notice?.label === 'string' && notice.label !== '' ? notice.label : '已结束'
  const turn = Number(notice?.turn ?? 0)
  const parts = []
  if (notice?.detail !== undefined && notice.detail !== '') parts.push(String(notice.detail))
  if (notice?.code !== undefined && notice.code !== '') parts.push(`(${notice.code})`)
  parts.push(turn > 0 ? `第 ${turn} 轮` : '会话')
  return {
    title: `${workspace} · ${label}`,
    body: parts.join(' · '),
    // tag 让同一条会话的新通知替换旧的那条，而不是在通知中心堆成一列
    tag: `dsh-pixel-${String(notice?.sessionId ?? '')}-${turn}`,
    level: typeof notice?.level === 'string' ? notice.level : 'ok',
    // 会话 id 单独带一份（**不**去解析 tag）：点击通知要能切到那条会话。
    // 从 tag 反解析看似可行，但 tag 是人可读的拼接串，格式一变就静默失效。
    sessionId: typeof notice?.sessionId === 'string' ? notice.sessionId : '',
  }
}

/**
 * 由一条待办交互拼出通知文案。
 *
 * 三种待办给的是**不同的字段**（授权是 `toolName`，提问是 `questions`，计划评审
 * 是 `questions[0].question` + `detail`），因此按 `kind` 分开读，而不是猜一个
 * 共同字段——猜错的表现是通知里写着「undefined 需要你的许可」。
 *
 * `plan-review` 是 DSH 里 `question` 的一个特例（kind 由 `planReviewOf` 判定，
 * 见 ui-user-questions 的 contract/slots.ts）。它值得单独一句文案：那是**计划
 * 审批**，比普通提问更需要人回来看一眼。
 * @param {object} interaction - uiSession 待办快照里的一项（两代 API 见 NotifierRuntime#pendingSource）。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
export function composeInteraction(interaction) {
  const kind = typeof interaction?.kind === 'string' ? interaction.kind : ''
  const key = String(interaction?.key ?? '')
  // 待办总是挂在某条会话上（两代 API 都是 Map<SessionId, …>）。
  // 点击「需要你的授权」那一类通知切过去，正是这个通知存在的意义。
  const sessionId = typeof interaction?.sessionId === 'string' ? interaction.sessionId : ''
  if (kind === 'approval') {
    const tool = typeof interaction.toolName === 'string' && interaction.toolName !== ''
      ? interaction.toolName
      : '某个工具'
    const reason = typeof interaction.reason === 'string' && interaction.reason !== ''
      ? ` · ${interaction.reason}`
      : ''
    return {
      title: '需要你的授权',
      body: `${tool} 请求执行授权${reason}`,
      tag: `dsh-pixel-approval-${key}`,
      level: 'warn',
      sessionId,
    }
  }
  if (kind === 'question' || kind === 'plan-review') {
    const questions = Array.isArray(interaction.questions) ? interaction.questions : []
    const first = questions[0]
    // 字段优先级：`question` 是正文，`header` 只是短标题（可能没有）
    const text = typeof first?.question === 'string' && first.question !== ''
      ? first.question
      : (typeof first?.header === 'string' && first.header !== '' ? first.header : '')
    const more = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
    return {
      title: kind === 'plan-review' ? '有一份计划等你确认' : 'AI 在等你回答',
      body: `${text === '' ? '有一个问题需要你回复' : text}${more}`,
      tag: `dsh-pixel-question-${key}`,
      level: 'warn',
      sessionId,
    }
  }
  return {
    title: '需要你处理',
    body: '有一个待办需要你的输入',
    tag: `dsh-pixel-interaction-${key}`,
    level: 'warn',
    sessionId,
  }
}

/**
 * 从余额负载里挑出「低于阈值」的币种。
 *
 * 只比较**有阈值**且**真的拿到了金额**的币种：
 *   - 没有阈值的币种跳过，否则每个币种都会在默认 0 阈值下立刻报警；
 *   - 金额缺失（`undefined`）时**绝不**当成 0——那会造出「余额为 0」的假警报，
 *     而真实原因可能只是接口没返回。这正是宿主余额模块反复强调的那条口径。
 * @param {object|undefined} payload - `/dsh-pixel/balance` 的负载。
 * @param {Record<string, number>} thresholds - 币种 → 阈值。
 * @returns {Array<{currency:string,total:number,threshold:number}>} 触发项（按币种升序）。
 */
export function balanceAlerts(payload, thresholds) {
  if (payload?.enabled === false) return []
  const table = thresholds !== null && typeof thresholds === 'object' ? thresholds : {}
  const rows = Array.isArray(payload?.balances) ? payload.balances : []
  const out = []
  for (const row of rows) {
    const currency = String(row?.currency ?? '').toUpperCase()
    const threshold = Number(table[currency])
    if (!Number.isFinite(threshold)) continue
    const total = Number(row?.total)
    if (!Number.isFinite(total)) continue
    if (total < threshold) out.push({ currency, total, threshold })
  }
  return out.sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * 从套餐负载里挑出「已用比例达到阈值」的窗口。
 *
 * 只看 `ok === true` 的厂商，且只认**能算出百分比**的窗口（`usedPercent` 有限）。
 * 拿不到百分比时跳过而不是当成 0——「不知道用了多少」与「用了 0」是两件事。
 * @param {object|undefined} payload - `/dsh-pixel/plans` 的负载。
 * @param {number} threshold - 百分比阈值；<= 0 表示关闭。
 * @returns {Array<{provider:string,window:string,label:string,percent:number}>} 触发项。
 */
export function quotaAlerts(payload, threshold) {
  const limit = Number(threshold)
  if (!Number.isFinite(limit) || limit <= 0) return []
  if (payload?.enabled === false) return []
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const out = []
  for (const provider of providers) {
    if (provider?.ok !== true) continue
    for (const window of provider.windows ?? []) {
      const percent = Number(window?.usedPercent)
      if (!Number.isFinite(percent)) continue
      if (percent < limit) continue
      out.push({
        provider: String(provider.name ?? provider.id ?? '套餐'),
        window: String(window.window ?? ''),
        label: String(window.label ?? window.window ?? '额度'),
        percent,
      })
    }
  }
  return out
}

/**
 * 由套餐触发项拼通知文案。
 * @param {Array<object>} alerts - {@link quotaAlerts} 的产出。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
export function composeQuotaAlert(alerts) {
  const first = alerts[0] ?? {}
  const summary = alerts
    .slice(0, 3)
    .map((item) => `${item.provider} ${item.label} ${item.percent.toFixed(0)}%`)
    .join('、')
  const more = alerts.length > 3 ? ` 等 ${alerts.length} 项` : ''
  return {
    title: '套餐额度接近上限',
    body: `${summary}${more}`,
    tag: `dsh-pixel-quota-${String(first.provider ?? '')}-${String(first.window ?? '')}`,
    level: 'warn',
  }
}

/**
 * 由余额触发项拼通知文案。
 * @param {Array<object>} alerts - {@link balanceAlerts} 的产出。
 * @param {(value:number, currency:string)=>string} formatMoney - 金额格式化函数。
 * @returns {{title:string,body:string,tag:string,level:string}} 文案。
 */
export function composeBalanceAlert(alerts, formatMoney) {
  const summary = alerts
    .slice(0, 3)
    .map((item) => `${item.currency} ${formatMoney(item.total, item.currency)}（阈值 ${formatMoney(item.threshold, item.currency)}）`)
    .join('、')
  const more = alerts.length > 3 ? ` 等 ${alerts.length} 个币种` : ''
  return {
    title: '账户余额低于预警阈值',
    body: `${summary}${more}`,
    tag: `dsh-pixel-balance-${alerts.map((item) => item.currency).join('-')}`,
    level: 'error',
  }
}

/**
 * 预警锁存器：同一条预警在**情况持续**期间只报一次，恢复后才重新武装。
 *
 * 没有它，每一轮轮询（余额 60 秒一次）都会重新触发同一条预警，一分钟一条
 * 通知会让人立刻把整个功能关掉。判据是「从正常跨到告警」这个**边沿**，
 * 而不是「当前是否处于告警」。
 *
 * 键的粒度按用途分开：余额按币种、套餐按「厂商 + 窗口」。这样某一家恢复
 * 不会把另一家的告警状态一起清掉。
 */
export class AlertLatch {
  constructor() {
    /** @type {Set<string>} 当前处于告警态的键。 */
    this.active = new Set()
  }

  /**
   * 用一组当前处于告警的键更新锁存器。
   * @param {string[]} keys - 本轮处于告警态的键。
   * @returns {string[]} 本轮**新跨越**到告警态的键。
   */
  update(keys) {
    const next = new Set(keys)
    const fresh = []
    for (const key of next) {
      if (!this.active.has(key)) fresh.push(key)
    }
    this.active = next
    return fresh
  }

  /** 清空（关闭预警、或配置改变后重新开始）。 */
  reset() {
    this.active = new Set()
  }
}

/**
 * 去重游标：记住「已经提醒过」的宿主日志游标与待办键。
 *
 * 分三类各记一份，因为它们的分页方式不同：日志按单调游标，待办按 key 集合。
 * 混在一起会让「待办被回答后 key 消失」把游标也一起弄丢。
 */
export class SeenTracker {
  /**
   * @param {object} [options] - 选项。
   * @param {number} [options.maxInteractions] - 待办键的保留上限。
   */
  constructor({ maxInteractions = 200 } = {}) {
    /** 宿主日志游标：只处理 id 大于它的记录。 */
    this.cursor = undefined
    /** @type {Set<string>} 已经提醒过的待办键。 */
    this.interactions = new Set()
    this.maxInteractions = maxInteractions
  }

  /**
   * 挑出本批需要提醒的日志记录并推进游标。
   * @param {object} payload - `/dsh-pixel/notify` 的负载。
   * @returns {{fresh:object[],dropped:boolean,first:boolean}} 结果。
   */
  takeNotices(payload) {
    const events = Array.isArray(payload?.events) ? payload.events : []
    const cursor = Number(payload?.cursor)
    const first = this.cursor === undefined
    // 第一次取到游标：宿主在「没有 since」时返回空列表，因此这里天然不会重播历史。
    // 但若宿主是旧实现（不带 since 也返回全部），first 仍然挡住整批——
    // 刷新页面绝不该把上次会话的提醒再弹一遍。
    const fresh = first ? [] : events.filter((entry) => Number(entry?.id) > this.cursor)
    if (Number.isFinite(cursor)) this.cursor = cursor
    return { fresh, dropped: payload?.dropped === true, first }
  }

  /**
   * 挑出本批首次出现的待办键。
   *
   * 只记「见到过」而不主动清理已消失的键：`key` 由产品侧单调生成
   * （`approval:1`、`approval:2`…），不会复用；清理反而会让一个仍在等待的
   * 待办在两次轮询之间被重复提醒。为防长期运行下集合无限增长，超过上限时
   * **整体清空**——那时旧键早已不可能再出现，重建一次的成本可以忽略。
   * @param {Iterable<object>} interactions - 当前的待办集合。
   * @returns {object[]} 首次出现的待办。
   */
  takeInteractions(interactions) {
    const fresh = []
    for (const item of interactions) {
      const key = String(item?.key ?? '')
      if (key === '' || this.interactions.has(key)) continue
      this.interactions.add(key)
      fresh.push(item)
    }
    if (this.interactions.size > this.maxInteractions) this.interactions = new Set()
    return fresh
  }
}

/**
 * 取通知配置（宿主是权威）。
 * @param {{signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 形如 `{ cursor, events, config, dropped }`。
 */
export async function fetchNotify(options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(NOTIFY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      // 404 有确定含义：宿主是还没有通知路由的旧版本。明说，而不是抛 HTTP 404。
      if (response.status === 404) {
        throw new Error('宿主没有通知路由（插件版本可能过旧，重启 dsh 试试）')
      }
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 取增量日志。
 * @param {{since?:number, signal?:AbortSignal}} [options] - 选项。
 * @returns {Promise<object>} 宿主负载。
 */
export async function fetchNotices(options = {}) {
  const url = Number.isFinite(Number(options.since))
    ? `${NOTIFY_URL}?since=${encodeURIComponent(String(options.since))}`
    : NOTIFY_URL
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  const onAbort = () => { controller.abort() }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error('宿主没有通知路由（插件版本可能过旧，重启 dsh 试试）')
      }
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 写回通知配置。
 *
 * 只提交**改动的那部分**（宿主会与现值合并），因此面板里的「保存阈值」不必
 * 先把整份配置读全；也会让「两个人同时改了不同项」不至于互相覆盖。
 *
 * 失败要抛错而不是静默：用户点了开关却没生效，必须让他知道——否则下次打开
 * 界面看到状态又变回去会莫名其妙。这与余额 / 套餐开关的口径一致。
 * @param {object} patch - 要改的键值。
 * @returns {Promise<object>} 形如 `{ config, persisted }`。
 */
export async function saveNotify(patch) {
  const response = await fetch(NOTIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (typeof body?.error === 'string') detail = body.error
    } catch {
      // 响应不是 JSON 时保留状态码说明
    }
    throw new Error(`通知设置未生效：${detail}`)
  }
  return await response.json()
}

/**
 * 申请系统通知权限。
 *
 * 必须在**用户手势**里调用（浏览器要求），因此只能由面板上的按钮触发，
 * 绝不能在插件加载时自动调用——那样即使浏览器不报错，也会被用户当成骚扰，
 * 而且一旦被拒就再也拿不回来。
 * @param {object} [scope] - 全局对象，测试注入用。
 * @returns {Promise<string>} 申请后的权限状态。
 */
export async function requestPermission(scope = globalThis) {
  const Notification = scope?.Notification
  if (typeof Notification !== 'function') return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    return result === 'granted' || result === 'denied' ? result : 'default'
  } catch {
    return permissionOf(scope)
  }
}
