/**
 * 通知运行时（浏览器半边）：常驻的取数与派发循环。
 *
 * ## 为什么用 `ctx.effect` 而不是 React 组件
 *
 * 提醒必须**始终**在工作，而组件只在它所在的槽位被渲染时才挂着——用户打开
 * 设置面板时提醒才生效，这显然不对。因此这里用插件 fiber 上的 effect 起一个
 * 自带定时器的循环，随插件加载而活、随插件卸载而停。
 *
 * 于是也**不需要 React**：待办交互从 `ctx.uiSession.pendingInteractions` 上
 * 直接读快照并订阅（那是 DSH 自己发布的全局可观察量），不必借助 hook。
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
  SeenTracker,
  balanceAlerts,
  composeBalanceAlert,
  composeInteraction,
  composeNotice,
  composeQuotaAlert,
  fetchNotices,
  permissionOf,
  quotaAlerts,
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
  constructor({ store, uiSession, sessions, layout, scope = globalThis }) {
    this.store = store
    this.uiSession = uiSession
    this.sessions = sessions
    this.layout = layout
    this.scope = scope
    this.seen = new SeenTracker()
    this.latch = new AlertLatch()
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
        tag: 'dsh-pixel-test',
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
    const source = this.uiSession?.()?.pendingInteractions
    if (source === undefined || typeof source.subscribe !== 'function') return
    this.unsubscribe = source.subscribe(() => { this.readPending() })
    this.readPending()
  }

  /** 停止工作。插件卸载时调用，必须能把所有定时器与订阅都撤掉。 */
  dispose() {
    this.disposed = true
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
    const source = this.uiSession?.()?.pendingInteractions
    const snapshot = source?.getSnapshot?.()
    const list = []
    if (snapshot !== undefined && typeof snapshot.forEach === 'function') {
      snapshot.forEach((interaction) => { list.push(interaction) })
    }
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
          tag: 'dsh-pixel-dropped',
          level: 'warn',
        }, 'system')
      }
      for (const notice of fresh) {
        if (!this.#enabled(notice.category === 'done' ? 'notifyDone' : 'notifyError')) continue
        if (this.#quiet(notice)) continue
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
   * 这条会话结束通知是否应当**不打扰**。
   *
   * 判据是「页面正被看着」且「就是当前选中的会话」——两者同时成立才跳过。
   * 只判焦点会漏掉「浏览器开着、正在看别的会话」；只判会话会漏掉「切到别的
   * 标签页干别的事」。
   * @param {object} notice - 宿主通知记录。
   * @returns {boolean} 是否跳过。
   */
  #quiet(notice) {
    if (this.config?.notifyQuietFocused === false) return false
    const doc = this.scope?.document
    if (doc?.hasFocus?.() !== true) return false
    const current = this.sessions?.()?.list?.getSnapshot?.()?.current
    return current !== undefined && String(current) === String(notice?.sessionId ?? '')
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
    let opened = false
    try {
      const sessions = this.sessions?.()
      if (sessions !== undefined && typeof sessions.open === 'function') {
        sessions.open(id)
        opened = true
      }
    } catch {
      // 会话不在列表里（已删除 / 属于别的机器）：保持安静，见方法说明。
    }
    // 即使 open 失败也把面板关掉：用户点的是「去看这条会话」，留在面板上更没意义。
    try {
      const layout = this.layout?.()
      if (layout !== undefined && typeof layout.selectPanel === 'function') {
        layout.selectPanel(null)
      }
    } catch {
      // 面板服务缺失 / 主区面板未注册：不阻断会话本身的切换。
    }
    return opened
  }

  /**
   * 派发一条通知：系统通知优先，不可用时回落页面内提示条。
   * @param {object} spec - 文案（可带 sessionId）。
   * @param {string} category - 类别（面板展示与统计用）。
   */
  #fire(spec, category) {
    this.#push(spec, category)
    if (this.permission !== 'granted') return
    const Notification = this.scope?.Notification
    if (typeof Notification !== 'function') return
    try {
      // tag 让同一条会话/同一条预警的新通知**替换**旧的那条，
      // 而不是在通知中心堆成一列——预警持续期间尤其明显。
      const notification = new Notification(spec.title, { body: spec.body, tag: spec.tag })
      // 点通知切到那条会话。只在**确实带着会话 id** 时挂这个回调：
      // 余额 / 套餐阈值那类预警不属于任何会话，点它切会话是无意义的动作。
      const sessionId = typeof spec.sessionId === 'string' ? spec.sessionId.trim() : ''
      if (sessionId !== '') {
        notification.onclick = () => {
          try {
            // 先把系统通知收掉，再切界面：否则通知中心里会留着一条已经处理过的提醒。
            notification.close?.()
            // 把窗口拉到前台——**这一步是尽力而为，不是保证**。
            //
            // 按规范 `window.focus()` 只是一次「请求」：MDN 明确写着它可能因用户
            // 设置而失败，返回前也不保证窗口已在最前。浏览器普遍拒绝脚本改窗口
            // z 序（防广告骚扰），Firefox 基本直接忽略，Chrome 也只在部分条件下认。
            //
            // 可靠把窗口拉到前台的是 **Service Worker 的 notificationclick**
            // （`clients.openWindow()` / `client.focus()`），但那是另一条通知通道，
            // 而 DSH 的 Web 端没有注册 Service Worker（见 AGENT.md）。
            // 因此这里照常调用（有环境会生效），但绝不假设它成功。
            this.scope?.focus?.()
            // 即使拉不到前台，**切会话这件事仍会完成**：用户手动切回窗口时，
            // 看到的已经是那条会话。这是当前技术条件下能做到的部分。
            this.openSession(sessionId)
          } catch {
            // 切界面失败不影响这条通知已经送达的事实。
          }
        }
      }
    } catch {
      // 某些环境（如未授权的 Worker、非安全上下文）构造会抛错：已经落进
      // 最近通知与页面内提示了，这里不再重复报错。
    }
  }

  /** 记一条派发记录，并刷新页面内提示。 */
  #push(spec, category) {
    const entry = { at: Date.now(), category, ...spec }
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
