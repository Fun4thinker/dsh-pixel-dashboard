/**
 * 会话耗时分解（模型等待 / 模型思考 / 模型回复 / 工具执行）。
 *
 * ## 为什么需要它（用户的核心质疑）
 *
 * 「活跃时长 = 创建到最后使用」是**坏指标**：一个会话三周前建的、今天又聊了两句，
 * 会被算成 500 多小时。有用的时间数据是**模型真正在干活的那段**：
 * 用户提问之后，等待首个 token、思考、生成回复、执行工具。
 *
 * ## 口径（与 dsh-context 的 TimingTotals 对齐）
 *
 * 单个 step 的生命周期：
 *
 *   step/start ──► ttft ──► (assistant/message) ──► tool/call … tool/result ──► step/end
 *
 * - **模型等待（ttft）**：`step/start` → 该 step 的第一条 `assistant/message`。
 *   这段是「发出去等首字」，通常是大头（排队 + 预填充）。
 * - **模型回复（gen）**：第一条 `assistant/message` → 该 step 结束之间的生成时长。
 *   账本里没有逐 token 时间戳，因此这里把「首字到 step 结束」整体算作回复，
 *   并把其中**工具执行**的那部分单独扣出来（见下）。
 * - **工具执行（tools）**：`tool/call` → 对应 `tool/result` 的配对时长。
 * - **模型思考（reasoning）**：DSH 的思考内容与回复在同一条 `assistant/message` 里
 *   到达，事件层面**无法单独切分**，因此这里**不编造**这个数字。界面会明确说明
 *   「思考与回复无法在日志层面分离」，而不是给一个看起来很精确的假数。
 *
 * ## 一个刻意的简化与其代价
 *
 * 工具执行时间是从「回复窗口」里扣出来的，而不是独立测量：若工具在两次
 * assistant/message 之间执行，扣减后不会出现负数（用 Math.max 兜底）。
 * 并行工具会各自计时并可能重叠，因此 `toolsMs` 可能略大于真实墙钟——
 * 但它回答的是「总共花了多少工具时间」，重叠部分本来就该各算一次。
 */
export class TimingBreakdown {
  constructor() {
    /** 累计毫秒。 */
    this.ttftMs = 0
    this.genMs = 0
    this.toolsMs = 0
    /** 参与统计的 step 数（用于「平均每步」）。 */
    this.steps = 0
    /** 当前 step 的起点与首条消息时刻。 */
    this.stepStart = null
    this.firstMessageAt = null
    /** 已开启但未结束的工具调用：callId → 起始时刻。 */
    this.openCalls = new Map()
    /** 当前 step 内的工具累计（step 结束时并入 toolsMs）。 */
    this.stepToolsMs = 0
    /** 本轮已累计的工具耗时（用于从回复窗口里扣除）。 */
    this.stepToolRanges = []
  }

  /** 是否已经见过任何可用的时间数据。 */
  get seen() {
    return this.steps > 0
  }

  /**
   * 吃一个事件。
   * @param {object} event - 会话事件。
   * @returns {void}
   */
  observe(event) {
    const at = Number(event?.time)
    // 注意：**时间戳 0 是合法值**（测试夹具与某些合成日志会从 0 起算）。
    // 用 at <= 0 挡会把整段计时静默丢掉，表现为「时间全是 0」而没有报错。
    if (!Number.isFinite(at) || at < 0) return
    switch (event?.type) {
      case 'step/start':
        this.stepStart = at
        this.firstMessageAt = null
        this.stepToolsMs = 0
        this.stepToolRanges = []
        break
      case 'assistant/message':
        // 首条消息 = 首个可观测 token：之前是等待，之后是生成。
        if (this.firstMessageAt === null) this.firstMessageAt = at
        break
      case 'tool/call': {
        const id = String(event?.data?.callId ?? event?.data?.id ?? '')
        if (id !== '') this.openCalls.set(id, at)
        break
      }
      case 'tool/result': {
        const id = String(event?.data?.callId ?? event?.data?.id ?? '')
        const started = id === '' ? undefined : this.openCalls.get(id)
        if (started === undefined) break
        this.openCalls.delete(id)
        const cost = Math.max(0, at - started)
        this.stepToolsMs += cost
        this.stepToolRanges.push([started, at])
        break
      }
      case 'step/end':
        if (this.stepStart === null) break
        this.steps += 1
        // 没有 assistant/message 的 step（纯工具链）不计入 ttft，避免把整步当等待。
        if (this.firstMessageAt !== null) {
          this.ttftMs += Math.max(0, this.firstMessageAt - this.stepStart)
          // 生成窗口 = 首条消息 → step 结束，其中工具执行的那部分扣掉。
          const windowMs = Math.max(0, at - this.firstMessageAt)
          this.genMs += Math.max(0, windowMs - this.stepToolsMs)
        }
        this.toolsMs += this.stepToolsMs
        // 兜底：step 结束时仍未闭合的工具调用（异常中断）按到 step/end 计时。
        for (const [id, started] of this.openCalls) {
          const cost = Math.max(0, at - started)
          this.toolsMs += cost
          this.stepToolsMs += cost
          this.openCalls.delete(id)
        }
        this.stepStart = null
        this.firstMessageAt = null
        break
      default:
        break
    }
  }

  /**
   * 导出结果。
   * @returns {{ttftMs:number,genMs:number,toolsMs:number,steps:number,totalMs:number}}
   *   `totalMs` 是「模型真正在干活」的总时长 = 等待 + 回复 + 工具。
   */
  toJSON() {
    const totalMs = this.ttftMs + this.genMs + this.toolsMs
    return {
      ttftMs: Math.round(this.ttftMs),
      genMs: Math.round(this.genMs),
      toolsMs: Math.round(this.toolsMs),
      steps: this.steps,
      totalMs: Math.round(totalMs),
    }
  }
}
