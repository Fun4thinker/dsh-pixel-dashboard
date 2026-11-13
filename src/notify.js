/**
 * 通知（宿主半边）：把会话的**结束事实**收成一份可在浏览器里轮询的小日志，
 * 并定义通知开关配置的默认值与校验规则。
 *
 * ## 为什么这件事必须有一半在宿主做
 *
 * 浏览器**看不到后台会话的 `turn/end`**。客户端的会话事件窗口只对「已上台」
 * （当前选中）的会话分页装载，后台会话的窗口是空的——而那正是你最需要被提醒的场景。
 * 宿主对每个活着的会话都能收到 `session/event`，所以「完成 / 失败 / 中断」这一类
 * 判定只能在这里做。分工因此是：
 *
 *   - **任务完成 / 失败 / 中断** → 宿主侧判定（本模块），落进一个环形日志；
 *   - **需要授权 / 回答** → 浏览器侧直接读 `ctx.uiSession.pendingInteractions`，
 *     DSH 自己已经把待办发布到全局，不必再绕宿主一趟。
 *
 * ## 余额与额度预警已整体取消（2.14.0）
 *
 * 用户明确要求**不要实时通知余额/额度**：那两件事是「想知道的时候去看一眼」，
 * 而不是「必须被打断的事」。于是：
 *
 *   - 阈值配置（`warnBalance` / `warnQuotaPercent`）与本模块的归一化函数一起删除；
 *   - 对应的两个开关（`notifyBalance` / `notifyQuota`）也删掉——开关留着却没有任何
 *     阈值可设，只会让人以为功能坏了。
 *
 * 余额与额度改在**会话标签页**与**输入框费用条**里直接看（那是读数，不是提醒）。
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

/**
 * 子代理名字（团队名册里那个稳定名字）与一句话描述的显示上限。
 *
 * 两者都会进系统通知的标题 / 正文，而描述可能是一整句话（spawn 时的
 * `description`）。不截断的话，标题会被撑成一行读不完的长句，Windows 上还会
 * 被通知中心省略——用户看到的是「子智能体 审查一下这个通知文案到底是怎么……」。
 */
export const MAX_AGENT_NAME_CHARS = 32
export const MAX_AGENT_LABEL_CHARS = 80

/** 环形日志容量。够覆盖「去开个会回来」的量级，又不会无限增长。 */
export const JOURNAL_LIMIT = 100

/**
 * 通知配置里的布尔字段清单。
 *
 * 单独列出来是给**两处**共用：默认值表，以及宿主从请求体里挑字段时的白名单。
 * 有了它就不可能出现「补丁里夹带了一个没见过的键，被悄悄写进配置文件」。
 */
export const NOTIFY_BOOL_FIELDS = [
  'notifyEnabled',
  'notifyDone',
  'notifySubagent',
  'notifyError',
  'notifyInteraction',
  'notifyQuietFocused',
]

/**
 * 通知配置默认值。
 *
 * 冻结：`Preferences` 的默认值是**按引用**并入读结果的，任何一处误改都会污染
 * 默认值本身。冻结后误改会在严格模式下直接抛错，而不是静默改坏。
 *
 * 余额 / 额度阈值（`warnBalance` / `warnQuotaPercent`）**已整体删除**：那两项预警
 * 不再是功能，余额改在会话标签页与费用条里直接看（见模块说明）。
 */
export const NOTIFY_DEFAULTS = Object.freeze({
  notifyEnabled: true,
  notifyDone: true,
  // 子智能体跑完一轮：**开着**通知，但客户端把结论写成「有新进展」而不是
  // 「已完成」，并给一个更弱的等级（见 client/notify.js 的 composeNotice）。
  // 默认开着是为了不丢信息：团队里哪个成员收工了，本身是有用的进展同步；
  // 关掉的那一档是「连进展也不想被打扰」，由用户自己决定。
  notifySubagent: true,
  notifyError: true,
  notifyInteraction: true,
  notifyQuietFocused: true,
  // 提示音：默认跟随系统（与浏览器/Windows 的默认行为一致，不改变现有观感）。
  // 其余取值由客户端解释，宿主只负责存一份干净的字符串。
  notifySound: 'system',
  notifySoundUrl: '',
})

/**
 * 提示音允许的取值。
 *
 * `system` 是「什么都不做」——交给系统的默认提示音，和现在完全一样。
 * 其余取值表示**由插件自己发声**，此时系统通知会被设成 `silent`，
 * 否则会出现「系统一声 + 插件一声」的双响。
 *
 * 为什么不做成 `notifySound: boolean`：用户要求「能关、也能自己选音效」，
 * 这是一组互斥选项而不是一个开关。用枚举可以把「关掉」和「换一个」放进同一个
 * 下拉框，配置里也不会出现 `sound=false` + `soundUrl=xxx` 这种自相矛盾的组合。
 */
export const NOTIFY_SOUND_MODES = ['system', 'off', 'chime', 'soft', 'deep', 'custom']

/** 自定义音效地址的长度上限（够放一个 URL 或 data URI，又不至于把配置撑爆）。 */
export const MAX_SOUND_URL_CHARS = 2048

/**
 * 归一化提示音设置。
 *
 * 认不出的模式一律回到 `system`：那是**保持原样**的安全默认，而不是「静音」
 * ——把用户没设过的东西默认成静音，会让他以为通知坏了。
 * @param {unknown} value - 原始模式。
 * @returns {string} 归一化后的模式。
 */
export function normalizeSoundMode(value) {
  return typeof value === 'string' && NOTIFY_SOUND_MODES.includes(value)
    ? value
    : NOTIFY_DEFAULTS.notifySound
}

/**
 * 归一化自定义音效地址。
 *
 * 只接受 `http(s):` / `data:audio/` 这类能直接喂给 `Audio` 的来源，其余一律丢弃。
 * 这条闸门是**安全**性质而不是洁癖：这个值最终会进 `new Audio(url)`，放任意字符串
 * 进去等于给「用配置触发任意请求」留了一道口子。
 * @param {unknown} value - 原始地址。
 * @returns {string} 干净地址；不可用时空串。
 */
export function normalizeSoundUrl(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_SOUND_URL_CHARS) return ''
  if (!/^(https?:\/\/|data:audio\/)/i.test(trimmed)) return ''
  return trimmed
}

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
 * 这个会话头属于子智能体吗？
 *
 * ## 判据是会话头里两个**创建时写入、不可变**的字段
 *
 * `SessionHeader`（DSH 的公开契约）里：
 *   - `origin === 'subagent'` —— 它**是不是**一个子代理（语义标记）；
 *   - `parentSession` —— 直接父会话 id（关系事实）。
 *
 * 两个都认，任一个成立即算子智能体：
 *   - 只看 `parentSession` 会在「链断了」时漏判——父会话被删、或续跑的子会话在
 *     父进程先销毁时短暂独立存活（DSH `roster.ts` 有注解），那些会话仍然是子代理；
 *   - 只看 `origin` 又依赖宿主一定写了这个字段（它是可选的）。
 *
 * **不要拿「名字能不能查到」当判据。** 名字只是文案，查不到也必须认出来——
 * 认不出来就会把子智能体的收工说成「你的模型输出完毕，可以继续推进」，而那正是
 * 这条功能要修的那个错误（用户报的原话）。
 * @param {object|undefined} header - `session.header`。
 * @returns {boolean} 是否子智能体（含团队里的 teammate）。
 */
export function isSubagentHeader(header) {
  if (header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.parentSession === 'string' && header.parentSession !== ''
}

/**
 * 把一个 `turn/end` 会话事件映射成一条通知记录。
 *
 * 纯函数：入参是宿主事件，出参是可直接 JSON 序列化的事实。**不做文案拼装**——
 * 措辞属于浏览器半边，因为只有它知道用户的界面语言、当前选中的会话与浏览器
 * 通知的授权状态。这里只回报「发生了什么」。
 *
 * ## 子智能体必须被**标出来**
 *
 * 子代理（含团队 teammate）的每一轮结束都会走到这里，而它的 `turn/end` 与主会话
 * 长得一模一样。不标出来的后果不是「少一条信息」，而是**说错话**：同一条
 * 「已完成」放在子智能体身上会被读成「你的会话跑完了，可以继续推进」，可实际上
 * 主会话还在等它。因此这里带上 `subagent` 以及可选的 `agentName` / `agentLabel`
 * （名字来自团队名册，描述来自 `subagent/descriptor`，两者都由调用方查好传进来，
 * 本函数**不去读日志**——那是调用方的事，且这里必须是纯函数）。
 *
 * 缺字段时的降级方向是「什么都不知道」：旧宿主不认这两个字段，客户端于是按
 * 主会话处理（与改动前完全一致），不会凭空说出「子智能体」四个字。
 * @param {object} session - 宿主 Session（读 `id` 与 `header`）。
 * @param {object} event - `session/event` 的第二个参数。
 * @param {string} [workspace] - 工作目录末段名，由调用方用与看板一致的口径算好。
 * @param {{name?:string,label?:string}} [agent] - 该子智能体的名字与一句话描述；非子智能体时忽略。
 * @returns {object|undefined} 通知记录；不是 `turn/end` 或读不到会话 id 时 undefined。
 */
export function noticeOf(session, event, workspace, agent) {
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
  // 子智能体身份：只在**是**的时候写这个字段，因此「有 subagent 字段」就是唯一判据，
  // 客户端不必再猜。缺失 = 主会话 = 改动前的行为。
  if (isSubagentHeader(session?.header)) {
    notice.subagent = true
    const name = truncate(agent?.name, MAX_AGENT_NAME_CHARS)
    if (name !== undefined) notice.agentName = name
    const label = truncate(agent?.label, MAX_AGENT_LABEL_CHARS)
    if (label !== undefined) notice.agentLabel = label
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
 * 把任意（可能是残缺的、甚至是对手的）输入归一成一份完整配置。
 *
 * 始终返回**新对象**且只含已知键：调用方可以直接把它当补丁写盘，
 * 不必担心请求体里夹带的东西被存下来。
 *
 * 余额 / 额度阈值那几项**不再出现在结果里**：旧配置文件里残留的
 * `warnBalance` / `warnQuotaPercent` / `notifyBalance` / `notifyQuota` 会在下一次
 * 读取时被这里丢掉（白名单只认 {@link NOTIFY_BOOL_FIELDS} 与下面两个音效字段），
 * 于是「配置文件里还留着上一版的阈值」不会让界面再冒出一个幽灵开关。
 * @param {unknown} raw - 原始输入，允许只给一部分字段。
 * @returns {object} 完整配置。
 */
export function normalizeNotify(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const field of NOTIFY_BOOL_FIELDS) {
    out[field] = typeof source[field] === 'boolean' ? source[field] : NOTIFY_DEFAULTS[field]
  }
  // 提示音两项是字符串而不是布尔，单独归一（见 normalizeSoundMode 的说明）。
  out.notifySound = normalizeSoundMode(source.notifySound)
  out.notifySoundUrl = normalizeSoundUrl(source.notifySoundUrl)
  return out
}
