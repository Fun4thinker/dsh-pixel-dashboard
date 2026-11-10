/**
 * 通知运行时（浏览器半边）：常驻的取数与派发循环。
 *
 * ## 为什么用 `ctx.effect` 而不是 React 组件
 *
 * 提醒必须**始终**在工作，而组件只在它所在的槽位被渲染时才挂着——用户打开
 * 设置面板时提醒才生效，这显然不对。因此这里用插件 fiber 上的 effect 起一个
 * 自带定时器的循环，随插件加载而活、随插件卸载而停。
 *
 * 于是也**不需要 React**：待办交互从 `ctx.uiSession` 上直接读快照并订阅
 * （那是 DSH 自己发布的全局可观察量），不必借助 hook。
 *
 * **待办的可观察量有两代，必须都认。** DSH 在 `0.1.6-alpha.2` 把待办从
 * `uiSession.pendingInteractions` 搬进了 `uiSession.sessionStatus`
 * （`Map<SessionId, {running, pendingInteraction, completionUnread}>`），旧属性被删除。
 * 而旧代码写的是 `uiSession.pendingInteractions`——属性不存在时可选链会把
 * 「API 没了」静默吞成 undefined，表现是**授权/提问永远不提醒**，既不报错也无迹象。
 * 见 {@link NotifierRuntime#pendingSource}。
 *
 * ## 三条数据源与各自的节奏
 *
 *   - 宿主通知日志：4 秒一次，纯内存读取，很轻；
 *   - 待办交互：事件驱动（订阅），零轮询；
 *   - 余额 / 套餐阈值：30 秒一次，且复用宿主侧已有的 60s / 30s 缓存，
 *     实际外发请求远少于轮询次数。
 *
 * ## 降级不静默
 *
 * 系统通知发不出去（没授权、非安全上下文）时，回落成**页面内提示条**，
 * 而不是丢掉这条提醒。用户关掉了浏览器通知却什么也收不到，会以为功能坏了。
 * @module dsh-pixel-dashboard/client/Notifier
 */

import { fetchBalance, formatMoney } from './balance.js'
import {
  AlertLatch,
  PresenceTracker,
  SeenTracker,
  balanceAlerts,
  composeBalanceAlert,
  composeInteraction,
  composeNotice,
  composeQuotaAlert,
  conversationOnScreen,
  fetchNotices,
  permissionOf,
  quotaAlerts,
  shouldStayQuiet,
  playSound,
  requestFocus,
  soundPlan,
} from './notify.js'
import { fetchPlans } from './plans.js'

/** 宿主日志轮询间隔。日志在宿主内存里，读一次很便宜。 */
const NOTICE_POLL_MS = 4_000

/** 余额 / 套餐阈值检查间隔。宿主侧另有 60s / 30s 缓存，实际外发请求更少。 */
const ALERT_POLL_MS = 30_000

/** 页面内提示条的驻留时长。 */
const TOAST_MS = 9_000

/** 面板里保留的「最近通知」条数。 */
const RECENT_LIMIT = 20

/**
 * 通知状态的**唯一所有者**：面板看到的、运行时据以决策的，都是这里的同一份值。
 *
 * ## 为什么必须「唯一」（这里踩过一次）
 *
 * 早先这里只存一份快照，而 `permission` / `config` 另有一份副本活在运行时里。
 * 后果是两个**看起来无关**的故障同时出现：
 *   1. 面板调 `store.setConfig(...)` → `TypeError: store.setConfig is not a function`
 *      （方法只在运行时上，面板拿不到运行时）；
 *   2. 即使用户在浏览器里点了「允许」，界面仍显示「未授权」——因为运行时在
 *      构造时把 `permission` 读了一次就再没刷新过，而面板显示的是另一份。
 *
 * 根因是同一种：**状态有两个家**。现在只有这一个家，运行时通过它读、也通过它写，
 * 面板订阅它。写入口是下面几个显式方法，谁也不持有副本，于是不可能再对不上。
 *
 * ## 变化检测
 *
 * {@link NotifyStore.prototype.patch} 会比较新旧快照，等价时不发布。日志轮询每
 * 4 秒跑一次，绝大多数轮次什么都没变；若每次都发布，`useSyncExternalStore`
 * 会因为快照引用变化让面板每 4 秒重渲染一次。
 */
export class NotifyStore {
  constructor() {
    /** @type {object|undefined} 归一化后的通知配置；undefined = 还没读到。 */
    this.config = undefined
    /** @type {'granted'|'denied'|'default'|'unsupported'} 浏览器通知权限。 */
    this.permission = 'default'
    /** @type {object[]} 最近派发过的通知（新在前）。 */
    this.recent = []
    /** @type {object|undefined} 当前的页面内提示。 */
    this.toast = undefined
    /** @type {string} 最近一次取数失败的原因。 */
    this.error = ''
    /** @type {object[]} 当前待办。 */
    this.pending = []
    /** 是否已经有过一次真实状态（面板据此区分「加载中」与「真的没有」）。 */
    this.ready = false
    this.snapshot = this.#build()
    /** @type {Set<() => void>} */
    this.listeners = new Set()
  }

  /** 由当前字段拼出快照对象。 */
  #build() {
    return {
      ready: this.ready,
      config: this.config,
      permission: this.permission,
      recent: this.recent,
      toast: this.toast,
      error: this.error,
      pending: this.pending,
    }
  }

  /** @returns {object} 当前快照（引用稳定，未变化时是同一个对象）。 */
  getSnapshot() {
    return this.snapshot
  }

  /**
   * 订阅变化。
   * @param {() => void} listener - 回调。
   * @returns {() => void} 退订函数。
   */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 更新若干字段并（必要时）发布。
   *
   * 只认已知字段：写进来一个没见过的键会被忽略，而不是悄悄进快照——快照的
   * 形状是面板与运行时之间的契约，多一个字段就多一处可能对不上的地方。
   * @param {object} fields - 要更新的字段。
   * @returns {boolean} 是否真的发布了。
   */
  patch(fields) {
    if (fields === null || typeof fields !== 'object') return false
    if (Object.hasOwn(fields, 'config')) this.config = fields.config
    if (Object.hasOwn(fields, 'permission')) this.permission = fields.permission
    if (Object.hasOwn(fields, 'recent')) this.recent = fields.recent
    if (Object.hasOwn(fields, 'toast')) this.toast = fields.toast
    if (Object.hasOwn(fields, 'error')) this.error = fields.error
    if (Object.hasOwn(fields, 'pending')) this.pending = fields.pending
    this.ready = true
    const next = this.#build()
    if (sameSnapshot(this.snapshot, next)) return false
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 一个订阅者抛错不该阻断其余订阅者，更不该让运行时停摆。
      }
    }
    return true
  }

  /**
   * 写入通知配置。
   *
   * 面板保存成功后调它（显示立刻更新），运行时从宿主取到新配置时也调它——
   * 两条路都落在同一个字段上，因此不会出现「面板显示一套、实际按另一套判定」。
   * @param {object} config - 完整配置。
   */
  setConfig(config) {
    this.patch({ config })
  }

  /**
   * 写入浏览器通知权限。
   * @param {'granted'|'denied'|'default'|'unsupported'} permission - 新权限。
   */
  setPermission(permission) {
    this.patch({ permission })
  }

  /** 记一条最近通知（新在前，超限截断）。 */
  pushRecent(entry) {
    this.patch({ recent: [entry, ...this.recent].slice(0, RECENT_LIMIT) })
  }

  /**
   * 记一次「点了通知之后跳转成不成功」。
   *
   * 单独一个字段而不是往 record 里塞：跳转发生在通知**已经展示之后**，
   * 它需要更新的是那条已有记录，而不是新增一条。
   * @param {{at:number,sessionId:string,ok:boolean,error?:string}} outcome - 结果。
   */
  noteClick(outcome) {
    this.lastClick = outcome
    const index = this.recent.findIndex((item) => item?.sessionId === outcome.sessionId)
    if (index < 0) return
    const target = this.recent[index]
    const next = {
      ...target,
      clickFailed: outcome.ok ? undefined : String(outcome.error ?? '未知原因'),
      clickOk: outcome.ok === true,
    }
    const recent = [...this.recent]
    recent[index] = next
    this.patch({ recent })
  }

  /**
   * 发一条测试通知。
   *
   * 这是一条**自证**通道：「通知到底能不能弹」不该靠用户去等一个真实任务跑完来
   * 推测。它走的是与真实提醒完全相同的路径——同一个派发方法、同一段判定逻辑，
   * 因此能弹就说明整条链路通；弹不出来，问题必定在浏览器授权或系统通知设置上。
   *
   * 落进「最近通知」是刻意的：即使系统通知弹不出来（被系统勿扰、被浏览器静默），
   * 面板里也会立刻多一条记录，用户至少能区分「没发出去」与「发出去了但没看见」。
   */
  publishTest() {
    this.onTest?.()
  }

  /**
   * 派发一条通知（内部与测试共用）。
   *
   * 通过 {@link NotifyStore.onFire} 交给运行时去弹——store 自己**不做**任何
   * 与浏览器 API 相关的事，它只是状态。这样「测试通知」与「真实通知」共用同一条
   * 派发路径，不会出现「测试能弹、真实不弹」这种最误导人的不一致。
   * @param {object} spec - 文案。
   */
  publish(spec) {
    this.onFire?.(spec, 'test')
  }

  /**
   * 切到某条会话。
   *
   * 与 {@link NotifyStore.publishTest} 同一个套路：store 只声明「要切过去」这个
   * 意图，真正碰产品的 sessions / layout 服务的动作住在运行时里（那里才有
   * 那两个服务的取值函数）。面板因此不必拿到运行时，也就不必再多一个跨模块单例
   * ——**状态与入口都只有这一个家**（这条约束在本文件顶部已经踩过一次）。
   * @param {string} sessionId - 目标会话 id。
   * @returns {boolean} 是否成功发起。
   */
  openSession(sessionId) {
    return this.onOpenSession?.(sessionId) === true
  }
}

/**
 * 两份快照是否等价（足以跳过重画）。
 *
 * 逐字段比而不是深比：`recent` / `pending` 都是**每次重建的新数组**，深比会
 * 让比较成本随条数增长，而这里只需要认出「内容没变」。数组按长度 + 逐项
 * 引用比较即可——运行时只会推入新对象，绝不会原地改旧对象。
 * @param {object} a - 旧快照。
 * @param {object} b - 新快照。
 * @returns {boolean} 是否等价。
 */
function sameSnapshot(a, b) {
  if (a.ready !== b.ready) return false
  if (a.permission !== b.permission) return false
  if (a.error !== b.error) return false
  if (a.toast !== b.toast) return false
  // 配置用 JSON 比：它是个小对象，且每次都是宿主给的新引用
  if (JSON.stringify(a.config ?? null) !== JSON.stringify(b.config ?? null)) return false
  if (!sameList(a.recent, b.recent)) return false
  if (!sameList(a.pending, b.pending)) return false
  return true
}

/** 两个数组是否逐项同引用。 */
function sameList(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * 模块级单例存储。
 *
 * 运行时与面板分属两个模块（`Notifier.js` / `dashboard.js`），实例不能在
 * 模块间直接传（打包器把它们放在各自的闭包里）。用一个**惰性创建**的单例
 * 让两边拿到同一个对象：谁先用到谁创建，后用到的人拿到同一份。
 *
 * 惰性而不是模块顶层 `new`：模块顶层构造会在**导入**时就执行，而导入发生在
 * 任何环境（包括无 DOM 的渲染闸门）——那时创建一个只有几个字段的对象虽然
 * 无害，但「导入即副作用」是个容易长歪的习惯，这里避开它。
 * @returns {NotifyStore} 单例。
 */
let sharedStore
export function notifyStore() {
  sharedStore ??= new NotifyStore()
  return sharedStore
}

/**
 * 通知运行时：轮询、判定、派发。
 *
 * **它不持有任何状态。** 配置、权限、最近通知、待办全部住在 {@link NotifyStore}
 * 里，运行时只是读写那个唯一副本（早先各持一份，导致「点了允许仍显示未授权」
 * 与面板调不到方法这两件事——见 `NotifyStore` 的说明）。
 */
export class NotifierRuntime {
  /**
   * @param {object} deps - 依赖。
   * @param {NotifyStore} deps.store - 唯一的状态所有者（面板订阅的同一个对象）。
   * @param {() => object|undefined} deps.uiSession - 客户端 uiSession 服务（可缺）。
   * @param {() => object|undefined} deps.sessions - 客户端 sessions 服务（可缺）。
   * @param {() => object|undefined} deps.layout - 客户端 layout 服务（可缺）；点通知切会话时要用。
   * @param {object} [deps.scope] - 全局对象，测试注入用。
   */
  constructor({ store, uiSession, sessions, layout, workspace, scope = globalThis }) {
    this.store = store
    this.uiSession = uiSession
    this.sessions = sessions
    this.layout = layout
    this.workspace = workspace
    /** AudioContext 复用一个，避免每次发声都新建（浏览器对实例数有限制）。 */
    this.soundCache = {}
    this.scope = scope
    this.seen = new SeenTracker()
    this.latch = new AlertLatch()
    /**
     * 在场跟踪：判断「当前会话完成时该不该静默」。
     *
     * 它是运行时唯一持有环境读数的东西——配置与权限住在 store（唯一状态家），
     * 而焦点 / 可见性 / 最近输入是**环境**而不是配置，也不该进 store 让面板每
     * 4 秒重渲染一次。见 {@link PresenceTracker}。
     */
    this.presence = new PresenceTracker(scope)
    this.timers = []
    this.unsubscribe = undefined
    this.disposed = false
    /** 上一次据以判定预警的配置引用，用于认出「配置变了」。 */
    this.lastConfig = undefined
    /**
     * 订阅 store 的配置变化。
     *
     * 为什么需要：面板保存设置后只改 store（它碰不到运行时的 latch）。若不跟着
     * 重置，用户把阈值从 90 改到 50 时，那些本来处于告警的窗口会被当成「早就
     * 提醒过」而**不再提醒**——改了设置却没反应，是最容易被当成坏了的现象。
     *
     * 回调里只做「比较 + 重置 + 补发待办」，不再写 config，因此不会递归。
     */
    this.storeUnsubscribe = store.subscribe(() => { this.#syncFromStore() })
    // 面板的「发一条测试通知」按钮经由 store 回到这里，于是测试与真实提醒
    // 走的是同一条派发路径（见 NotifyStore.publishTest 的说明）。
    store.onFire = (spec, category) => { this.#fire(spec, category) }
    // 面板里的「最近通知」行经由 store 回到这里：切会话要碰产品服务，
    // 而 store 刻意不持有任何服务取值函数（见 NotifyStore.openSession）。
    store.onOpenSession = (sessionId) => this.openSession(sessionId)
    // 测试通知也尊重总开关：关了总开关还在弹，比不弹更让人困惑。
    //
    // 例外是**配置还没到手**（宿主取数失败、或刚加载）：此时用户是主动点的按钮，
    // 拦下来只会让他以为按钮坏了。他点这一下本来就只是想确认浏览器这一侧通不通，
    // 而这个判断不依赖宿主的配置。
    store.onTest = () => {
      if (this.config !== undefined && this.config.notifyEnabled === false) return
      this.#fire({
        title: '测试通知',
        body: '看到这一条就说明通知链路是通的。',
        tag: 'dsh-px-test',
        level: 'ok',
      }, 'test')
    }
    // 权限的初值从浏览器读一次写进 store：面板首帧就该显示真实状态。
    this.store.setPermission(permissionOf(scope))
    this.#syncFromStore()
  }

  /** 认出配置变化并据此重置预警锁存、补发待办。 */
  #syncFromStore() {
    if (this.disposed) return
    const config = this.store.config
    if (config === this.lastConfig) return
    this.lastConfig = config
    this.latch.reset()
    this.#notifyPending()
  }

  /** 当前配置（永远来自 store 这一份）。 */
  get config() {
    return this.store.config
  }

  /**
   * 当前权限：**每次都重新读浏览器**，而不是用缓存值。
   *
   * 用户可以在不经过我们按钮的地方改权限（地址栏站点设置、浏览器设置页），
   * 只认自己写进去的那份会让界面永远停在旧状态——这正是「点了允许还说没授权」
   * 的直接原因之一。
   *
   * 读不到时保留 store 里的值：`unsupported` 是我们自己判定的结果（浏览器根本
   * 没有这个 API），而 `permissionOf` 在那种情况下也会返回 `unsupported`，
   * 两者一致；`denied` 同理。因此只有浏览器给出确定答案时才覆盖。
   */
  get permission() {
    const live = permissionOf(this.scope)
    if (live !== this.store.permission) this.store.setPermission(live)
    return live
  }

  /** 开始工作：装订阅、起定时器、立刻跑一轮。 */
  start() {
    this.presence.start()
    this.#ensurePendingSubscription()
    this.readPending()
    this.pollNotices()
    this.pollAlerts()
    this.timers.push(setInterval(() => {
      this.#ensurePendingSubscription()
      this.pollNotices()
    }, NOTICE_POLL_MS))
    this.timers.push(setInterval(() => { this.pollAlerts() }, ALERT_POLL_MS))
  }

  /**
   * 把浏览器当前的权限写回 store。
   *
   * 每次都真的重新读浏览器，而不是信自己缓存的那份：用户可以**不经过我们的
   * 按钮**改权限（地址栏左侧的站点设置、浏览器设置页）。只认自己写进去的值，
   * 界面就会永远停在旧状态——这正是「点了允许还说没授权」的成因之一。
   * 读取 `permission` 这个 getter 本身就会顺带同步，这里只是给它一个固定的
   * 调用点（每轮轮询一次），让状态在没有任何通知发生时也能刷新。
   */
  syncPermission() {
    void this.permission
  }

  /**
   * 确保已订阅待办交互，必要时补订。
   *
   * 必须能**迟到的补上**：`uiSession` 由 DSH 的另一个插件提供，而我们的 effect
   * 可能在它发布之前就跑起来了（客户端插件之间没有 apply 顺序保证）。只在
   * `start()` 里试一次的做法会以「授权/提问永远不提醒」的形式静默失败——
   * 既没有报错，也没有任何可见迹象。因此每一轮轮询都复查一次，代价只是一次
   * 属性读取。
   */
  #ensurePendingSubscription() {
    if (this.disposed || this.unsubscribe !== undefined) return
    const found = this.#pendingSource()
    if (found === undefined || typeof found.observable.subscribe !== 'function') return
    this.unsubscribe = found.observable.subscribe(() => { this.readPending() })
    this.readPending()
  }

  /**
   * 待办可观察量：**新版走 `sessionStatus`，旧版走 `pendingInteractions`**。
   *
   * DSH 0.1.6-alpha.2 起把待办搬进了 `uiSession.sessionStatus`：那是一张
   * `Map<SessionId, SessionStatus>`，每条含 `running` / `pendingInteraction` /
   * `completionUnread`；原先直接发布待办的 `uiSession.pendingInteractions`
   * （`Map<SessionId, interaction>`）**已被删除**。
   *
   * 为什么两代都认而不是直接改新接口：读不到属性时可选链得到的是 undefined，
   * 那不是「暂时没有待办」，而是「我们与宿主对不上话」——两者在界面上完全一样
   * （都不提醒），只认一代就会在对方那一代上永久静默失效。**先新后旧**，因为新版
   * 是当前契约；旧的只作为还没升上来的宿主回落。
   * @returns {{observable:object,read:(snapshot:object)=>Array<object>}|undefined} 可观察量与读数方式。
   */
  #pendingSource() {
    const session = this.uiSession?.()
    if (session === null || session === undefined) return undefined
    // 新版：值是一层 SessionStatus，待办在它的 pendingInteraction 上
    const status = session.sessionStatus
    if (status !== undefined && status !== null && typeof status.getSnapshot === 'function') {
      return {
        observable: status,
        read: (snapshot) => {
          const out = []
          snapshot.forEach((value, key) => {
            const interaction = value?.pendingInteraction
            if (interaction === undefined || interaction === null) return
            // 会话 id 以状态表的键为准：它是这份数据的权威来源。待办自身若已带上
            // 同名字段就原样保留（正常情况两者相同），缺失时才补，避免出现
            // 「通知点了切不到会话」——那正是这条提醒存在的意义。
            out.push(typeof interaction.sessionId === 'string' && interaction.sessionId !== ''
              ? interaction
              : { ...interaction, sessionId: String(key) })
          })
          return out
        },
      }
    }
    // 旧版：值**就是**那条待办
    const legacy = session.pendingInteractions
    if (legacy !== undefined && legacy !== null && typeof legacy.getSnapshot === 'function') {
      return {
        observable: legacy,
        read: (snapshot) => {
          const out = []
          snapshot.forEach((interaction) => {
            if (interaction !== undefined && interaction !== null) out.push(interaction)
          })
          return out
        },
      }
    }
    return undefined
  }

  /** 停止工作。插件卸载时调用，必须能把所有定时器与订阅都撤掉。 */
  dispose() {
    this.disposed = true
    this.presence.stop()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.storeUnsubscribe?.()
    this.storeUnsubscribe = undefined
  }

  /**
   * 当前的待办列表（写进 store，并派发尚未提醒过的那些）。
   */
  readPending() {
    const found = this.#pendingSource()
    const snapshot = found?.observable.getSnapshot?.()
    const list = snapshot !== undefined && typeof snapshot.forEach === 'function'
      ? found.read(snapshot)
      : []
    this.store.patch({ pending: list })
    this.#notifyPending()
  }

  /**
   * 把尚未提醒过的待办派发出去。
   *
   * 与 {@link readPending} 分开，是因为**配置可能后到**：首轮 `readPending()` 跑在
   * `pollNotices()` 拿到配置之前，此时 `#enabled` 一律为 false（「还没读到设置」
   * 不等于「用户全开着」），于是那批待办不会被派发。若就此不管，一个**在页面加载
   * 时就已存在**的授权请求会永远不提醒——直到用户回答别的东西把它顶掉。
   * 因此配置一到手就再试一次；{@link SeenTracker} 保证这里不会重复提醒。
   */
  #notifyPending() {
    if (!this.#enabled('notifyInteraction')) return
    for (const item of this.seen.takeInteractions(this.store.pending)) {
      this.#fire(composeInteraction(item), 'interaction')
    }
  }

  /**
   * 读宿主通知日志并派发新记录。
   * @returns {Promise<void>} 完成。
   */
  async pollNotices() {
    if (this.disposed) return
    // 每轮顺带同步一次权限：用户可能在浏览器站点设置里改过它。
    this.syncPermission()
    try {
      const payload = await fetchNotices({ since: this.seen.cursor })
      if (this.disposed) return
      // 配置随每次读取一起回来：面板在别的标签页改了设置，这边下一轮就同步。
      if (payload?.config !== undefined) this.store.setConfig(payload.config)
      this.store.patch({ error: '' })
      // 配置刚到（或刚被打开）时补发一次待办提醒：首轮 readPending 跑在配置之前，
      // 那时一律按「未启用」跳过（见 #notifyPending）。
      this.#notifyPending()
      const { fresh, dropped } = this.seen.takeNotices(payload)
      if (dropped) {
        this.#push({
          title: '有通知在断连期间丢失',
          body: '浏览器与宿主断开了一段时间，期间的提醒已被裁剪。',
          tag: 'dsh-px-drop',
          level: 'warn',
        }, 'system')
      }
      for (const notice of fresh) {
        // 「子智能体跑完一轮」与「主会话跑完」走**不同的开关**：
        // 团队里成员收工是进展同步，很多人只想要结论（主会话跑完）那一条。
        // 失败一律走 notifyError —— 失败不该因为「它只是个成员」而被降级。
        const progress = notice.subagent === true && notice.category === 'done'
        const gate = notice.category === 'done'
          ? (progress ? 'notifySubagent' : 'notifyDone')
          : 'notifyError'
        if (!this.#enabled(gate)) continue
        if (this.#quiet(notice)) {
          this.#noteQuiet(notice)
          continue
        }
        this.#fire(composeNotice(notice), notice.category)
      }
    } catch (error) {
      // 取数失败保留上一次的最近通知，只记错误——把已显示的提醒擦掉只会让人困惑
      this.store.patch({ error: String(error?.message ?? error) })
    }
  }

  /**
   * 检查余额与套餐阈值。
   * @returns {Promise<void>} 完成。
   */
  async pollAlerts() {
    if (this.disposed) return
    const config = this.config ?? {}
    const wantsBalance = this.#enabled('notifyBalance')
      && Object.keys(config.warnBalance ?? {}).length > 0
    const wantsQuota = this.#enabled('notifyQuota') && Number(config.warnQuotaPercent) > 0
    try {
      if (wantsBalance) {
        const payload = await fetchBalance({})
        if (this.disposed) return
        const alerts = balanceAlerts(payload, config.warnBalance)
        const fresh = this.latch.update(alerts.map((item) => `balance:${item.currency}`))
        const keys = new Set(fresh)
        const hit = alerts.filter((item) => keys.has(`balance:${item.currency}`))
        if (hit.length > 0) this.#fire(composeBalanceAlert(hit, formatMoney), 'balance')
      } else {
        this.latch.update([])
      }
      if (wantsQuota) {
        const payload = await fetchPlans({})
        if (this.disposed) return
        const alerts = quotaAlerts(payload, config.warnQuotaPercent)
        const fresh = this.latch.update(alerts.map((item) => `quota:${item.provider}:${item.window}`))
        const keys = new Set(fresh)
        const hit = alerts.filter((item) => keys.has(`quota:${item.provider}:${item.window}`))
        if (hit.length > 0) this.#fire(composeQuotaAlert(hit), 'quota')
      }
      if (!wantsBalance && !wantsQuota) this.latch.reset()
    } catch (error) {
      // 余额/额度取不到不是「预警」的失败，只是这一轮没有数据可判；
      // 但也不能静默——面板里会显示最近一次的错误。
      this.store.patch({ error: String(error?.message ?? error) })
    }
  }

  /** 某个开关是否打开（总开关优先）。 */
  #enabled(key) {
    const config = this.config
    if (config === undefined) return false
    if (config.notifyEnabled === false) return false
    return config[key] !== false
  }

  /**
   * 当前主视图显示的会话 id。
   *
   * **不能用 `sessions.list.getSnapshot().current`**：0.2.1 的客户端列表快照只有
   * `ids / byId / phase / projectionsBySession`，`current` 恒为 `undefined`。
   * 早先的判据读的就是它，于是 `shouldStayQuiet` 里「当前会话」这一条永远不成立
   * ——「当前会话不打扰」实际处于永不生效的状态（用户关掉它也看不出差别，
   * 原因就在这里）。
   *
   * 真正的事实来源有两个，按可靠性依次取：
   *   1) `sessions.list.byId[id].retainedBy.mainView > 0` —— 主视图的 retain 计数，
   *      这正是 DSH 自己 `isMain()` 的判据；
   *   2) `uiSession.mainRetainId` —— 派生值，作为兜底。
   * @returns {string|undefined} 会话 id；判不出来时 undefined（调用方按「不静默」处理）。
   */
  currentSessionId() {
    try {
      const byId = this.sessions?.()?.list?.getSnapshot?.()?.byId
      if (byId !== undefined && byId !== null) {
        for (const [id, row] of Object.entries(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return id
        }
      }
    } catch {
      // 读不出来就往下走兜底，绝不在这里抛。
    }
    try {
      const retained = this.uiSession?.()?.mainRetainId
      if (typeof retained === 'string' && retained !== '') return retained
    } catch {
      // 同上。
    }
    return undefined
  }

  /**
   * 这条会话结束通知是否应当**不打扰**。
   *
   * 判据是「页面正被看着」且「就是当前选中的会话」且「那条会话的界面确实在屏幕上」。
   * 只判焦点会漏掉「浏览器开着、正在看别的会话」；只判会话会漏掉「切到别的标签页
   * 干别的事」。
   *
   * 第三条（界面在屏幕上）原先漏了，而那正是用户报的**漏提醒**：`list.current`
   * 是**持久化的选中项**，不是「屏幕上是什么」。主区停在「用量看板」这类全局面板
   * 上时会话界面整个不挂载，`current` 却仍停在上次那条会话上，于是那条会话完成
   * 时提醒被静默吞掉。判定细节与「判不出来就不静默」的理由见
   * {@link shouldStayQuiet} / {@link conversationOnScreen}。
   *
   * **焦点不再直接读 `document.hasFocus()`**：Electron 里窗口若在未聚焦状态下
   * 加载，那个读数会永远为 true（electron/electron#7125），于是主会话的每次完成
   * 都被静默——用户报的正是「只有子智能体完成才提醒」。现在焦点、可见性、最近
   * 输入三项都由 {@link PresenceTracker} 汇总，判不出来就不静默。
   * @param {object} notice - 宿主通知记录。
   * @returns {boolean} 是否跳过。
   */
  #quiet(notice) {
    return shouldStayQuiet(notice, {
      config: this.config,
      current: this.currentSessionId(),
      onScreen: conversationOnScreen(this.scope?.document),
      ...this.presence.read(),
    })
  }

  /**
   * 记下一条**被刻意静默**的提醒。
   *
   * 静默不等于「当它没发生」。用户报的正是「漏了很多通知」——而一条**悄悄消失**
   * 的提醒与一条**从未产生**的提醒在界面上完全一样，用户无从判断是功能坏了还是
   * 本来就没有。因此被静默的提醒照样落进「最近通知」，只是不带系统通知、也不弹
   * 页面内提示条（那两样正是「不打扰」要避免的）。
   *
   * 这条记录本身就是「降级不静默」那条口径的落点：任何时候少了一条弹窗，用户都能
   * 在面板里看到它、知道它为什么没弹。
   * @param {object} notice - 宿主通知记录。
   */
  #noteQuiet(notice) {
    const spec = composeNotice(notice)
    this.store.pushRecent({
      at: Date.now(),
      category: 'quiet',
      ...spec,
      // 面板据此把这行标成「静默」，而不是让用户以为它本该弹却没弹。
      quiet: true,
    })
  }

  /**
   * 切换界面到某条会话。
   *
   * ## 为什么要点通知就切过去
   *
   * 「你的任务失败了」「有授权在等你」这类提醒，价值全在**接下来那一眼**。
   * 点开通知却停在原处，用户还得自己去侧栏里找出是哪条会话——提醒等于只做了
   * 一半。所以点通知直接切到它说的那条会话。
   *
   * ## 两个动作，缺一不可
   *
   *   1) `sessions.open(id)` —— 选中那条会话；
   *   2) `layout.selectPanel(null)` —— **退出主区面板**。
   *
   * 第 2 步最容易漏，也最要命：用户很可能正停在「用量看板」这类主区面板上，
   * 那时只调 `open()` 只是把选中项改了，主区**仍然显示着面板**——看起来就是
   * 「点了没反应」。必须同时把面板关掉，会话界面才会真的露出来。
   *
   * ## 失败一律安静
   *
   * `open()` 对列表里不存在的 id 会抛错（会话可能已经被删了，或者它属于另一台
   * 机器——账本里那些记录就没有本机会话）。点通知是**附加**功能，绝不能因为
   * 一条陈旧的通知把运行时的轮询打断。
   * @param {string} sessionId - 目标会话 id。
   * @returns {boolean} 是否真的切过去了。
   */
  openSession(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return false
    // 切换会话的正主是 `uiWorkspace.openSession(target)`。它内部做三件事：
    // `sessions.retain(target, { source: 'mainView' })`（让主视图持有这条会话，
    // 也是 `retainedBy.mainView` 的计数来源）、写 selection、再
    // `layout.selectPanel(null)` 退出主区面板。
    //
    // 早先这里调的是 `sessions.open(id)`——那个方法在 0.2.1 的客户端控制器上
    // **根本不存在**（实测 `open=undefined`，方法表里只有 retain/using/fork/...），
    // 于是异常被 catch 吞掉，表现就是「点通知只把窗口带到前台、会话没切」。
    try {
      const workspace = this.workspace?.()
      if (workspace !== undefined && typeof workspace.openSession === 'function') {
        workspace.openSession(id)
        return true
      }
    } catch (error) {
      // 会话可能已被删除、或属于另一台机器：不让它打断运行时。
      this.lastOpenError = String(error?.message ?? error)
      return false
    }
    // 兜底：服务缺失时至少退出主区面板，免得看起来「完全没反应」。
    try {
      const layout = this.layout?.()
      if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null)
    } catch {
      // 面板服务缺失：不阻断。
    }
    this.lastOpenError = 'uiWorkspace 服务不可用（宿主版本过旧？）'
    return false
  }

  /**
   * 播放提示音（只在用户选择了「自己发声」的音效时才调用）。
   *
   * ## 为什么内置音效用 WebAudio 合成而不是放音频文件
   *
   * 插件产物要能随包发布，塞 wav/mp3 会让包体和构建都变复杂；而三个提示音无非是
   * 几声正弦音，现场合成几行就够，且**不需要网络、不需要用户额外授权**。
   *
   * ## 为什么全程 try/catch 且失败不抛
   *
   * `AudioContext` 在部分环境里需要用户手势才能 resume、也可能被策略禁用。
   * 声音是附加体验：放不出来**绝不能**影响通知本身（通知已经弹出来了）。
   * @param {{play:'chime'|'soft'|'deep'|'custom'|undefined, url:string}} plan - 发声口径。
   */
  #playSound(plan) {
    // 与面板的「试听」共用同一个函数，避免两处发出的声音不一致。
    playSound(plan, this.scope, this.soundCache)
  }

  /**
   * 派发一条通知：系统通知优先，不可用时回落页面内提示条。
   *
   * ## 先尝试、后记账（踩过的坑）
   *
   * 这里的顺序是「先弹、再把结果记进最近通知」，而不是先记账再弹。早先是反的，
   * 后果是一次真实的排障灾难：用户在桌面端看到「最近通知」里明明有记录、系统却
   * 一条气泡都没有，而 `catch` 把构造失败**静默吞掉**，于是既没有气泡、也没有
   * 任何线索——只能靠对着 `LastNotificationAddedTime` 这类外部读数一步步反推。
   *
   * 归因就错在 catch 的注释上：它假定「构造失败一定是环境问题（未授权 / 非安全
   * 上下文）」，可实测存在**同一个进程里控制台 `new Notification()` 能弹、插件里
   * 同样的调用却弹不出**的情况——失败可能与这一条通知的内容有关，而不是环境。
   * 既然这种失败是**可归因到单条通知**的事实，就必须让它可见。
   * @param {object} spec - 文案（可带 sessionId）。
   * @param {string} category - 类别（面板展示与统计用）。
   */
  #fire(spec, category) {
    const failure = this.#deliver(spec)
    this.#push(spec, category, failure)
  }

  /**
   * 尝试弹系统通知。
   *
   * 返回值刻意区分三种「没弹」：**undefined = 正常**（含「没授权，按设计回落提示条」）、
   * 字符串 = 本可以弹却失败了，原因要写进最近通知给用户看。
   * @param {object} spec - 文案。
   * @returns {string|undefined} 失败原因；正常返回 undefined。
   */
  #deliver(spec) {
    if (this.permission !== 'granted') return undefined
    const Notification = this.scope?.Notification
    if (typeof Notification !== 'function') return '环境里没有 Notification，无法弹系统通知'
    try {
      // 提示音口径：自己发声时把系统通知设成 silent，否则会「系统一声 + 插件一声」。
      const plan = soundPlan(this.config)
      // tag 让同一条会话/同一条预警的新通知**替换**旧的那条，
      // 而不是在通知中心堆成一列——预警持续期间尤其明显。
      // `silent` **只在需要静音时才传**：默认的「跟随系统」什么都不传，
      // 保证和改动之前完全一样的构造参数，避免再引入未知回退。
      const options = { body: spec.body, tag: spec.tag }
      if (plan.silent) options.silent = true
      const notification = new Notification(spec.title, options)
      // 自己发声放在构造之后：通知构造失败时不该还有一声孤零零的响。
      if (plan.play !== undefined) this.#playSound(plan)
      // 点通知切到那条会话。只在**确实带着会话 id** 时挂这个回调：
      // 余额 / 套餐阈值那类预警不属于任何会话，点它切会话是无意义的动作。
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : ''
      if (sessionId !== '') {
        notification.onclick = () => {
          // ## 顺序是这里最要紧的东西（踩过回退）
          //
          // 曾经能生效的版本里，切会话那一步是**立刻抛错**的（调了不存在的
          // sessions.open），所以 `focus()` 早就执行完了。改成真正能切之后，
          // `uiWorkspace.openSession` 会同步触发主区重挂载（退出看板 + 重建整个
          // 会话视图），把渲染进程占住几百毫秒——而用户看到的是「点了，窗口还是
          // 没到前台」。
          //
          // 所以顺序固定为：**先请求聚焦 → 再收通知 → 最后才做切会话这件重活**，
          // 并追加一次延迟重试（有的引擎会丢掉「页面正忙时」的第一次聚焦请求）。
          try {
            this.scope?.focus?.()
          } catch {
            // 聚焦失败不影响后面的切会话。
          }
          // 渲染进程自己提不动窗口（实测 window.focus() 无效），所以请宿主代劳：
          // 宿主用系统命令唤起 `dsh://open`，由 Electron 主进程的
          // focusPrimaryWindow() 做 restore→show→focus。失败也不影响切会话。
          void requestFocus()
          try {
            this.scope?.setTimeout?.(() => {
              try {
                this.scope?.focus?.()
              } catch {
                // 重试失败就到此为止：这是尽力而为的一步。
              }
            }, 80)
          } catch {
            // 没有 setTimeout 的环境（测试闸门）：跳过重试。
          }
          try {
            // 把系统通知收掉：否则通知中心里会留着一条已经处理过的提醒。
            notification.close?.()
          } catch {
            // 关不掉也不影响切会话。
          }
          // 切会话放最后：这一步会重建主区，可能占住渲染进程。
          // 结果**必须可见**——用户报过「点了没反应」，而当时异常被吞掉，
          // 只能靠反查宿主 API 才查出来（sessions.open 根本不存在）。
          try {
            const ok = this.openSession(sessionId)
            this.store.noteClick({ at: Date.now(), sessionId, ok, error: this.lastOpenError })
          } catch (error) {
            this.store.noteClick({ at: Date.now(), sessionId, ok: false, error: String(error?.message ?? error) })
          }
          return true
        }
      }
      return undefined
    } catch (error) {
      // **绝不静默**：把原因带出去写进最近通知。用户看到的「有记录却没气泡」
      // 与「构造时抛错」之间必须有可见的因果，而不是靠注册表反推。
      const detail = error instanceof Error ? error.message : String(error)
      const name = error instanceof Error && error.name !== '' ? `${error.name}: ` : ''
      return `系统通知没有弹出来（${name}${detail}）`
    }
  }

  /**
   * 记一条派发记录，并刷新页面内提示。
   * @param {object} spec - 文案。
   * @param {string} category - 类别。
   * @param {string} [failure] - 系统通知未能弹出的原因；有值时记进这一条记录。
   */
  #push(spec, category, failure) {
    const entry = { at: Date.now(), category, ...spec }
    // 失败原因跟着这一条走：面板据此在行尾标出来，用户不必再猜。
    if (typeof failure === 'string' && failure !== '') entry.failed = failure
    this.store.pushRecent(entry)
    // 系统通知不可用时，页面内提示条是**唯一**的可见通道，必须亮出来。
    // 可用时不再叠加：系统通知已经弹过一次，页面里再来一条是重复打扰。
    if (this.permission !== 'granted') this.#showToast(entry)
  }

  /** 显示页面内提示条（自动消失）。 */
  #showToast(entry) {
    this.store.patch({ toast: entry })
    this.#renderToast()
    const timer = setTimeout(() => {
      if (this.store.toast === entry) {
        this.store.patch({ toast: undefined })
        this.#renderToast()
      }
    }, TOAST_MS)
    this.timers.push(timer)
  }

  /**
   * 把提示条画进 DOM。
   *
   * 直接建 DOM 而**不是**注册一个槽位组件：提示条必须在任何界面状态下都能出现
   * （包括用户正停在设置页、或主区根本没挂看板的时候），而槽位只在它所处的
   * 区域被渲染时才存在。用 DOM 也免掉了「组件没挂载 → 提醒静默消失」这种
   * 最难查的失败形态。样式复用全局挂上的 `.px-toast-*`（见 theme.js）。
   *
   * 全程可选链：渲染闸门与任何无 DOM 环境（SSR、测试）都必须在没有
   * `document` 时安静跳过，而不是抛错拖垮整个插件。
   */
  #renderToast() {
    const doc = this.scope?.document
    if (doc?.body === undefined || doc.body === null) return
    try {
      let host = doc.getElementById?.('px-toast-host')
      if (host === null || host === undefined) {
        host = doc.createElement('div')
        host.id = 'px-toast-host'
        host.className = 'px-toast-host'
        doc.body.appendChild(host)
      }
      host.textContent = ''
      const entry = this.store.toast
      if (entry === undefined) return
      const box = doc.createElement('div')
      box.className = `px-toast px-toast-${entry.level ?? 'ok'}`
      const title = doc.createElement('b')
      title.className = 'px-toast-title'
      title.textContent = String(entry.title ?? '')
      const body = doc.createElement('span')
      body.className = 'px-toast-body'
      body.textContent = String(entry.body ?? '')
      box.appendChild(title)
      box.appendChild(body)
      // 带会话 id 的提示条也**可点**：系统通知不可用时提示条是唯一通道，
      // 而「点一下就能跳过去」这件事不该只在系统通知那条路上有。
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : ''
      if (sessionId !== '') {
        box.classList.add('px-toast-clickable')
        box.addEventListener('click', () => {
          this.dismissToast()
          this.openSession(sessionId)
        })
      }
      host.appendChild(box)
    } catch {
      // 提示条是附加通道：画不出来不影响系统通知与「最近通知」列表。
    }
  }

  /** 由界面关闭提示条。 */
  dismissToast() {
    this.store.patch({ toast: undefined })
    this.#renderToast()
  }
}

/**
 * 装好通知运行时并挂到插件 fiber 上。
 *
 * 外层再套一个 try/catch：通知是**附加**功能，它坏掉不该让整个插件（包括
 * 看板与主题）一起失效。这与余额 / 套餐的 fail-soft 口径一致。
 * @param {object} ctx - 客户端 Cordis 上下文。
 * @param {NotifyStore} store - 状态所有者；**必须**与面板用的是同一个（见 notifyStore()）。
 * @returns {NotifierRuntime|undefined} 运行时；环境不支持时 undefined。
 */
export function installNotifier(ctx, store) {
  try {
    const runtime = new NotifierRuntime({
      store,
      uiSession: () => ctx.get('uiSession'),
      sessions: () => ctx.get('sessions'),
      // layout 只在「点通知切会话」时用到；它可能缺失（旧宿主 / 服务未就绪），
      // 那时会话仍会切换，只是不再额外退出主区面板。
      layout: () => ctx.get('layout'),
      // 切换会话的正主：uiWorkspace.openSession(target)。
      // 不能用 sessions.open —— 0.2.1 的 sessions 服务没有这个方法。
      workspace: () => ctx.get('uiWorkspace'),
    })
    // 先标记 ready：面板不该先渲染一屏空白再等第一轮轮询（最坏 4 秒）。
    // 配置仍是 undefined（运行时拿到宿主回应后才填），面板会用自带默认值兜底。
    store.patch({})
    ctx.effect(() => {
      runtime.start()
      return () => { runtime.dispose() }
    }, 'pixel-dashboard: 通知运行时')
    return runtime
  } catch (error) {
    console.warn('[dsh-pixel-dashboard] 通知运行时未能启动：', error)
    return undefined
  }
}
