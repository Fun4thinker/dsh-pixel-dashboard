/**
 * 通知与预警（宿主半边）：把会话的**结束事实**收成一份可在浏览器里轮询的小日志，
 * 并定义预警阈值配置的默认值与校验规则。
 *
 * ## 为什么这件事必须有一半在宿主做
 *
 * 浏览器**看不到后台会话的 `turn/end`**。客户端的会话事件窗口只对「已上台」
 * （当前选中）的会话分页装载，后台会话的窗口是空的——而那正是你最需要被提醒的场景。
 * 宿主对每个活着的会话都能收到 `session/event`，所以「完成 / 失败 / 中断」这一类
 * 判定只能在这里做。三件事的分工因此是：
 *
 *   - **任务完成 / 失败 / 中断** → 宿主侧判定（本模块），落进一个环形日志；
 *   - **需要授权 / 回答** → 浏览器侧直接读 `ctx.uiSession.pendingInteractions`，
 *     DSH 自己已经把待办发布到全局，不必再绕宿主一趟；
 *   - **余额 / 套餐阈值预警** → 浏览器侧算（它本来就在取余额与额度，复用同一条
 *     TTL 缓存即可），宿主只负责**存**这份配置。
 *
 * ## 宿主不落任何新文件
 *
 * 日志只活在内存里，且有明确上限（{@link JOURNAL_LIMIT}）。插件重载即清空——
 * 这是刻意的：提醒是「刚刚发生的事」，不是历史数据，落盘只会带来
 * 「重启后补播一堆旧提醒」这种更糟的行为。
 * @module dsh-pixel-dashboard/lib/notify
 */

/**
 * `turn/end` 的 `reason.kind` → 通知口径。
 *
 * 覆盖 `TurnEndReasonMap` 当前的全部成员。**认不出的 kind 一律落到 `unknown`**
 * 并归入 `error` 一侧，而不是当成完成——把一次失败说成「已完成」是这里最不能
 * 犯的错（`TurnEndReasonMap` 是可合并扩展的，官方随时可能加新成员）。
 */
export const TURN_OUTCOMES = {
  completed: { category: 'done', level: 'ok', label: '已完成' },
  error: { category: 'error', level: 'error', label: '失败' },
  aborted: { category: 'error', level: 'warn', label: '已中断' },
  blocked: { category: 'error', level: 'warn', label: '被阻断' },
  'max-tokens': { category: 'error', level: 'warn', label: '达到输出上限' },
  interrupted: { category: 'error', level: 'warn', label: '异常结束' },
}

/** 认不出的 `reason.kind` 的口径：偏保守，宁可多提醒也不谎报完成。 */
export const UNKNOWN_OUTCOME = { category: 'error', level: 'warn', label: '已结束（原因未知）' }

/** 详情文本上限：错误信息可能很长，而它要进操作系统通知，必须截断。 */
export const MAX_DETAIL_CHARS = 240

/** 环形日志容量。够覆盖「去开个会回来」的量级，又不会无限增长。 */
export const JOURNAL_LIMIT = 100

/** 阈值里允许出现的币种代码形状。 */
const CURRENCY_RE = /^[A-Z][A-Z0-9]{1,7}$/

/** 阈值允许的币种条目上限，防止异常请求把配置撑大。 */
export const MAX_WARN_CURRENCIES = 12

/**
 * 通知配置里的布尔字段清单。
 *
 * 单独列出来是给**两处**共用：默认值表，以及宿主从请求体里挑字段时的白名单。
 * 有了它就不可能出现「补丁里夹带了一个没见过的键，被悄悄写进配置文件」。
 */
export const NOTIFY_BOOL_FIELDS = [
  'notifyEnabled',
  'notifyDone',
  'notifyError',
  'notifyInteraction',
  'notifyBalance',
  'notifyQuota',
  'notifyQuietFocused',
]

/**
 * 通知配置默认值。
 *
 * 两个刻意的默认：
 *   - `warnBalance` 默认**空**。额度预警一上来就该安静，否则每个新用户都会被
 *     一条自己没设过的阈值提醒；面板上会说明「填一个数值才开始预警该币种」。
 *   - `warnQuotaPercent` 默认 90，与看板里既有的 `quotaTone()` 红色档一致——
 *     用户在进度条上看到的红色与收到提醒应当是同一件事。
 *
 * 冻结：`Preferences` 的默认值是**按引用**并入读结果的，任何一处误改都会污染
 * 默认值本身。冻结后误改会在严格模式下直接抛错，而不是静默改坏。
 */
export const NOTIFY_DEFAULTS = Object.freeze({
  notifyEnabled: true,
  notifyDone: true,
  notifyError: true,
  notifyInteraction: true,
  notifyBalance: true,
  notifyQuota: true,
  notifyQuietFocused: true,
  warnBalance: Object.freeze({}),
  warnQuotaPercent: 90,
})

/**
 * 转成有限数字，否则 undefined。
 *
 * 必须显式挡掉 `null` 与空串：`Number(null)` 与 `Number('')` 都是 0，
 * 而这里的 0 会被读成「阈值为 0」——即「余额一低于 0 就提醒」，
 * 与「用户没设过这个币种」是两件完全不同的事。
 * @param {unknown} value - 原始值。
 * @returns {number|undefined} 有限数字；读不懂时 undefined。
 */
function numberOrUndefined(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * 截断一段要展示给用户的文本。
 * @param {unknown} text - 原始文本。
 * @param {number} [max] - 上限字符数。
 * @returns {string|undefined} 截断后的文本；空文本返回 undefined。
 */
export function truncate(text, max = MAX_DETAIL_CHARS) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (value === '') return undefined
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
}

/**
 * 取某个 `turn/end` 原因对应的口径。
 * @param {string} kind - `reason.kind`。
 * @returns {{category:string,level:string,label:string}} 口径。
 */
export function outcomeOf(kind) {
  return Object.hasOwn(TURN_OUTCOMES, kind) ? TURN_OUTCOMES[kind] : UNKNOWN_OUTCOME
}

/**
 * 取消原因 → 一句人话。
 *
 * `aborted` 有四种来源，其中只有 `user` 是「你主动停的」；`parent` / `disposed`
 * 出现在宿主关停或上级会话结束时，把它们说成「你中断了」会让人以为是自己点的。
 * @param {unknown} cause - `reason.reason`。
 * @returns {string|undefined} 说明；认不出时 undefined（由调用方回落到默认标签）。
 */
export function cancelText(cause) {
  const kind = typeof cause?.kind === 'string' ? cause.kind : ''
  if (kind === 'user') return '你取消了这次运行'
  if (kind === 'parent') return '被上级会话取消'
  if (kind === 'hook') return truncate(`被钩子取消：${String(cause?.reason ?? '')}`, 120)
  if (kind === 'disposed') return '宿主关闭时中断'
  if (kind === 'legacy') return '中断（该记录未保存原因）'
  return undefined
}

/**
 * 把一个 `turn/end` 会话事件映射成一条通知记录。
 *
 * 纯函数：入参是宿主事件，出参是可直接 JSON 序列化的事实。**不做文案拼装**——
 * 措辞属于浏览器半边，因为只有它知道用户的界面语言、当前选中的会话与浏览器
 * 通知的授权状态。这里只回报「发生了什么」。
 * @param {object} session - 宿主 Session（读 `id` 与 `header.cwd`）。
 * @param {object} event - `session/event` 的第二个参数。
 * @param {string} [workspace] - 工作目录末段名，由调用方用与看板一致的口径算好。
 * @returns {object|undefined} 通知记录；不是 `turn/end` 或读不到会话 id 时 undefined。
 */
export function noticeOf(session, event, workspace) {
  if (event === null || typeof event !== 'object' || event.type !== 'turn/end') return undefined
  const data = event.data ?? {}
  const reason = data.reason ?? {}
  const kind = typeof reason.kind === 'string' && reason.kind !== '' ? reason.kind : 'unknown'
  const sessionId = String(session?.id ?? session?.header?.id ?? '')
  if (sessionId === '') return undefined

  const outcome = outcomeOf(kind)
  const notice = {
    at: numberOrUndefined(event.time) ?? Date.now(),
    sessionId,
    workspace: typeof workspace === 'string' && workspace !== '' ? workspace : '(未知目录)',
    turn: numberOrUndefined(data.turn) ?? 0,
    outcome: kind,
    category: outcome.category,
    level: outcome.level,
    label: outcome.label,
  }
  // 失败要带原因：只报「失败」而不给任何线索，等于让人回去翻日志。
  if (kind === 'error') {
    const detail = truncate(reason.error?.message)
    if (detail !== undefined) notice.detail = detail
    const code = truncate(reason.error?.code, 60)
    if (code !== undefined) notice.code = code
  }
  if (kind === 'aborted') {
    const detail = cancelText(reason.reason)
    if (detail !== undefined) notice.detail = detail
  }
  return notice
}

/**
 * 通知日志：定长环形缓冲 + 单调游标。
 *
 * 游标（`id`）单调递增且**不因裁剪而回退**，浏览器按 `id > since` 拉增量；
 * 这样即使一次断了很久、旧记录已被裁掉，也能通过 `dropped` 明确告诉用户
 * 「中间丢了若干条」，而不是安静地少提醒几条。
 */
export class NotifyJournal {
  /**
   * @param {object} [options] - 选项。
   * @param {number} [options.limit] - 容量上限。
   */
  constructor({ limit = JOURNAL_LIMIT } = {}) {
    this.limit = Math.max(1, Math.floor(Number(limit) || JOURNAL_LIMIT))
    /** @type {object[]} 升序，最旧在前。 */
    this.events = []
    this.nextId = 1
  }

  /** 最新一条的游标；没有记录时为 0。 */
  get tip() {
    return this.nextId - 1
  }

  /**
   * 记一条通知，并补上自增游标。
   * @param {object} notice - {@link noticeOf} 的产出。
   * @returns {object} 带 `id` 的记录。
   */
  record(notice) {
    const entry = { id: this.nextId, ...notice }
    this.nextId += 1
    this.events.push(entry)
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit)
    return entry
  }

  /** 清空。插件重载时用。 */
  clear() {
    this.events = []
  }

  /**
   * 读增量。
   *
   * `since` 缺失或不是有限数字时返回**当前游标 + 空列表**：这是「开始订阅」的
   * 语义——新开的页面只关心此后发生的事，不该把历史提醒重播一遍。
   * @param {{since?:unknown}} [options] - 选项。
   * @returns {{cursor:number,events:object[],dropped:boolean}} 增量。
   */
  read(options = {}) {
    const since = numberOrUndefined(options.since)
    if (since === undefined) return { cursor: this.tip, events: [], dropped: false }
    const events = this.events.filter((entry) => entry.id > since)
    const oldest = this.events[0]?.id
    // 有记录被裁掉了才叫「丢了」：只比游标小说明本来就还没记过。
    const dropped = oldest !== undefined && since < oldest - 1
    return { cursor: this.tip, events, dropped }
  }
}

/**
 * 归一化余额预警阈值表。
 *
 * 逐项校验而不是整体信任请求体：币种键必须像币种代码（这条正则同时挡掉
 * `__proto__` 这类会污染原型的键），数值必须是有限的非负数。**读不懂的条目
 * 直接丢弃**，而不是退化成 0——0 在这里意味着「余额一低于 0 就提醒」。
 * @param {unknown} value - 原始阈值表。
 * @returns {Record<string, number>} 干净的阈值表。
 */
export function normalizeWarnBalance(value) {
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  let count = 0
  for (const key of Object.keys(value)) {
    if (count >= MAX_WARN_CURRENCIES) break
    const currency = String(key).toUpperCase()
    if (!CURRENCY_RE.test(currency)) continue
    const amount = numberOrUndefined(value[key])
    if (amount === undefined || amount < 0) continue
    out[currency] = amount
    count += 1
  }
  return out
}

/**
 * 归一化套餐额度预警百分比。
 *
 * 允许超过 100：官方额度用超时会给出 >100 的百分比，而「只在超限后提醒」
 * 是一个正当的用法。上限 1000 只是防呆。
 * @param {unknown} value - 原始值。
 * @returns {number} 0..1000 的阈值；0 表示关闭套餐预警。
 */
export function normalizeQuotaPercent(value) {
  if (value === null || value === undefined || value === '') return NOTIFY_DEFAULTS.warnQuotaPercent
  const amount = Number(value)
  if (!Number.isFinite(amount)) return NOTIFY_DEFAULTS.warnQuotaPercent
  return Math.min(1000, Math.max(0, Math.round(amount * 10) / 10))
}

/**
 * 把任意（可能是残缺的、甚至是对手的）输入归一成一份完整配置。
 *
 * 始终返回**新对象**且只含已知键：调用方可以直接把它当补丁写盘，
 * 不必担心请求体里夹带的东西被存下来。
 * @param {unknown} raw - 原始输入，允许只给一部分字段。
 * @returns {object} 完整配置。
 */
export function normalizeNotify(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const field of NOTIFY_BOOL_FIELDS) {
    out[field] = typeof source[field] === 'boolean' ? source[field] : NOTIFY_DEFAULTS[field]
  }
  out.warnBalance = normalizeWarnBalance(source.warnBalance)
  out.warnQuotaPercent = normalizeQuotaPercent(source.warnQuotaPercent)
  return out
}
