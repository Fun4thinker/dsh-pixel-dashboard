/**
 * 时段窗口与费用口径。
 *
 * 官方口径（北京时间，见 https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ ）：
 *   高峰时段 = **周一至周五（不含中国法定节假日）** 9:00–12:00、14:00–18:00；
 *   其余时段——**包括全部周末与中国法定节假日全天**——都是空闲时段，
 *   空闲价 = 高峰价的一半。
 *
 * 两个由 ./holidays.js 显式处理的例外，光看星期几都会判错：
 *
 *   1) **法定节假日全天按空闲计费**，哪怕它正落在周一至周五的正午前后。
 *      2026-10-01（周四）与 10-02（周五）就是：只看星期几会把这两天的白天算成
 *      高峰，而官方是按空闲计费的。
 *   2) **调休上班的周末仍按空闲计费**（官方说明原文：「调休上班的周末、中国法定
 *      节假日全天均按空闲时段计费」）。因此调休上班日**不**进工作时间表，
 *      把它当工作日会与官方口径正好相反。
 *
 * 因此这里不是「一个折扣窗口」，而是「若干高峰窗口 + 空闲兜底」，
 * 费用也必须按每条请求发生时刻所属的时段分别计价，不能整段套一个折扣。
 * @module dsh-pixel-dashboard/lib/pricing
 */
import { holidayNameOf, holidayYearCovered, isHoliday } from './holidays.js'

/** 默认站点时区：北京时间。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/**
 * 高峰时段窗口（站点时区当天时刻，单位分钟；endMinute 不含）。
 * 周一至周五 9:00–12:00 与 14:00–18:00。
 *
 * 「这一天的窗口成不成立」还要看它是不是工作日——周末与法定节假日整天都没有窗口
 * （见 {@link isPeak}）。这份数组只描述窗口的**形状**，不描述它对哪天生效。
 */
export const PEAK_WINDOWS = [
  { startMinute: 9 * 60, endMinute: 12 * 60 },
  { startMinute: 14 * 60, endMinute: 18 * 60 },
]

/**
 * 高峰只落在工作日：0=周日 … 6=周六。
 *
 * 「工作日」在这里是**排除法定节假日**之后的周一至周五；周末与法定节假日都不是
 * 高峰日（判定见 {@link isPeak}）。调休上班的周末仍然是周末，仍按空闲计费。
 */
export const PEAK_WEEKDAYS = [1, 2, 3, 4, 5]

/**
 * 官方价目表（**人民币 / 百万 token**）。
 *
 * 两类口径，别混：
 *
 *   1) **DeepSeek 分时定价**：高峰（周一至周五、不含法定节假日 9:00–12:00、14:00–18:00）与空闲
 *      两档，空闲价恰为高峰价的一半，因此写成 `{ peak, idle }`。
 *   2) **其他厂商不分时**：只有一个价。为复用同一套聚合与计价逻辑，peak 与 idle
 *      写成同一个值，并用 `flat: true` 标明「这是无分时，不是打折」。
 *
 * 币种统一为人民币：智谱官方定价页本身就是「元 / 百万 token」，与 DeepSeek 一致，
 * 因此看板可以把两者相加而不会混币。**不要**搬别的目录里的美元数字——混币会静默算错。
 *
 * `tiered: true` 表示官方按**输入长度分档**定价（如 GLM-5.1 在 32K 前后不同价）。
 * 账本里没有可靠的逐请求输入长度，因此这里只填最低档，并由 `pricingOf()` 把
 * `tiered` 透出去让界面注明「按最低档估算」，而不是假装精确。
 */
export const MODEL_RATES = {
  'deepseek-flash': {
    label: 'DeepSeek Flash',
    vendor: 'DeepSeek',
    version: 'DeepSeek-V4.1-Flash',
    flat: false,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    cacheHit: { peak: 0.04, idle: 0.02 },
    cacheMiss: { peak: 2, idle: 1 },
    output: { peak: 8, idle: 4 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    version: 'DeepSeek-V4-Pro-0813',
    flat: false,
    contextWindow: 1_000_000,
    maxOutput: 384_000,
    cacheHit: { peak: 0.3, idle: 0.15 },
    cacheMiss: { peak: 9, idle: 4.5 },
    output: { peak: 27, idle: 13.5 },
  },
  // ── 智谱 GLM（元 / 百万 token，官方标准 API 定价，无分时）──────────────
  // 来源：https://docs.bigmodel.cn/cn/guide/start/pricing
  // 注意：Coding Plan 的**积分**抵扣另有「非高峰 50%」规则，那是订阅额度口径
  // （见 plans.js），与这里的按量金额不是一回事。
  'glm-5.3': {
    label: 'GLM-5.3',
    vendor: '智谱',
    version: 'GLM-5.3',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 2, idle: 2 },
    cacheMiss: { peak: 8, idle: 8 },
    output: { peak: 28, idle: 28 },
  },
  'glm-5.3-flash': {
    label: 'GLM-5.3-Flash',
    vendor: '智谱',
    version: 'GLM-5.3-Flash',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 0.23, idle: 0.23 },
    cacheMiss: { peak: 0.8, idle: 0.8 },
    output: { peak: 2.8, idle: 2.8 },
  },
  // GLM-5.3-FlashX 是**独立定价的另一个模型**，不是 Flash 的别名：官方价 2 / 7 / 0.57
  // 对 Flash 的 0.8 / 2.8 / 0.23，贵 2.5 倍。来源同 API 定价页的「最新模型」表。
  //
  // 早先它被当成「Flash 的加速标记」折进 `glm-5.3-flash`，那是错的：本机
  // `commandcode` 路由下确实挂着 `z-ai/glm-5.3-flashx`，折过去会把金额低估 2.5 倍。
  // 依据是官方把它与 Flash 并排列在同一张价目表里、各有各的单价——
  // 而 `-local` / `-free` 这类之所以能折，是因为官方**没有**给它们单独定价。
  'glm-5.3-flashx': {
    label: 'GLM-5.3-FlashX',
    vendor: '智谱',
    version: 'GLM-5.3-FlashX',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 0.57, idle: 0.57 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 7, idle: 7 },
  },
  'glm-5.2': {
    label: 'GLM-5.2',
    vendor: '智谱',
    version: 'GLM-5.2',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    cacheHit: { peak: 2, idle: 2 },
    cacheMiss: { peak: 8, idle: 8 },
    output: { peak: 28, idle: 28 },
  },
  'glm-4.6v': {
    label: 'GLM-4.6V',
    vendor: '智谱',
    version: 'GLM-4.6V',
    flat: true,
    tiered: true,
    contextWindow: 128_000,
    maxOutput: 32_768,
    // 官方分两档（<32K / 32K–128K），这里取最低档
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 1, idle: 1 },
    output: { peak: 3, idle: 3 },
  },
  // ── 阿里云百炼 / 千问（元 / 百万 token，**中国内地**官方价）──────────
  // 来源：https://www.alibabacloud.com/help/zh/model-studio/model-pricing
  // （更新时间 2026-11-05，取「华北2（北京）」小节）
  //
  // ## 为什么统一取中国内地
  //
  // 千问的价目**同时**受三个维度影响：地域（北京 / 新加坡 / 香港 / 法兰克福 /
  // 弗吉尼亚 / 东京）、阶梯（按单次请求输入 token 数分档）、限时折扣。
  // 同一个 `qwen3.8-max` 在官网能看到 $1.650/$4.951（北京）、$2/$6（新加坡）、
  // $0.345/$1.377（qwen-max 内地特例）等不同价。
  //
  // 而**账本里没有地域信息**（DSH 事件只给模型名与 token 数），任何取值都只能是
  // 「某一条件下」的价。这里统一按**中国内地（北京）标准价**接入——使用这套插件
  // 的场景绝大多数走国内节点；同时保留 `tiered: true`，让界面注明「按最低档估算」，
  // 与 GLM-4.6V 的处理一致：宁可标注不精确，也不假装精确。
  //
  // 缓存命中：官方口径为**标准输入价的 10%**（显式缓存创建为 125%），
  // 这里按 10% 计——与其它厂商的 cacheHit 口径一致，不额外建模创建费。
  //
  // 价格直接取国内站的人民币整数价（platform.qianwenai.com/pricing/api），
  // **不做美元折算**——折算会把 ¥12 变成 11.88 这种脏数字，且与用户账单对不上。
  'qwen3.8-max': {
    label: 'Qwen3.8-Max',
    vendor: '千问',
    version: 'qwen3.8-max',
    flat: true,
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    // 国内站（platform.qianwenai.com/pricing/api）：¥12 / ¥36 / 缓存命中 ¥1.5
    cacheHit: { peak: 1.5, idle: 1.5 },
    cacheMiss: { peak: 12, idle: 12 },
    output: { peak: 36, idle: 36 },
  },
  'qwen3.7-max': {
    label: 'Qwen3.7-Max',
    vendor: '千问',
    version: 'qwen3.7-max',
    flat: true,
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    // 国内站：¥12 / ¥36 / 缓存命中 ¥2.4（注意与 3.8-max 的 1.5 不同）
    cacheHit: { peak: 2.4, idle: 2.4 },
    cacheMiss: { peak: 12, idle: 12 },
    output: { peak: 36, idle: 36 },
  },
  'qwen3.8-flash': {
    label: 'Qwen3.8-Flash',
    vendor: '千问',
    version: 'qwen3.8-flash',
    flat: true,
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    // 国内站：¥0.8 / ¥2.7 / 缓存命中 ¥0.1
    cacheHit: { peak: 0.1, idle: 0.1 },
    cacheMiss: { peak: 0.8, idle: 0.8 },
    output: { peak: 2.7, idle: 2.7 },
  },
  'qwen3.7-plus': {
    label: 'Qwen3.7-Plus',
    vendor: '千问',
    version: 'qwen3.7-plus',
    flat: true,
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    // 国内站：原价 ¥2 / ¥8 / 缓存 ¥0.4；限时 8 折 → ¥1.6 / ¥6.4 / ¥0.32（0<Token≤256K）
    // 取**折后价**：用户当前实际扣费按 8 折算，按原价会高估 25%。
    cacheHit: { peak: 0.32, idle: 0.32 },
    cacheMiss: { peak: 1.6, idle: 1.6 },
    output: { peak: 6.4, idle: 6.4 },
  },
  // qwen-max 是内地**特例价**：国内 $0.345 / $1.377，与国际站 $1.6 / $6.4 差 4 倍多。
  // 单独列一条而不是折进 qwen3.8-max，否则国内用户按国际价算会高估近 5 倍。
  'qwen-max': {
    label: 'Qwen-Max',
    vendor: '千问',
    version: 'qwen-max',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 8_192,
    // 北京（中国内地）：$0.345 / $1.377，无阶梯
    cacheHit: { peak: 0.2484, idle: 0.2484 },
    cacheMiss: { peak: 2.484, idle: 2.484 },
    output: { peak: 9.9144, idle: 9.9144 },
  },
  // qwen3.7-flash 按**输入长度三档**计价（国内站）：
  //   ≤32K        ¥0.2  / ¥0.8  / 缓存 ¥0.04
  //   32K–256K    ¥0.6  / ¥2.4  / 缓存 ¥0.12
  //   256K–1M     ¥1.2  / ¥4.8  / 缓存 ¥0.24
  // 账本里没有逐请求输入长度，只能取最低档并标 tiered（与 GLM-4.6V 同一处理）。
  // 这一条尤其要标清楚：取错档会低估 6 倍。
  'qwen3.7-flash': {
    label: 'Qwen3.7-Flash',
    vendor: '千问',
    version: 'qwen3.7-flash',
    flat: true,
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    cacheHit: { peak: 0.04, idle: 0.04 },
    cacheMiss: { peak: 0.2, idle: 0.2 },
    output: { peak: 0.8, idle: 0.8 },
  },
  // ── OpenAI GPT（元 / 百万 token，按 7.2 折算）────────────────────
  // 来源：https://developers.openai.com/api/docs/pricing.md（Standard 档）
  //
  // 只录 Standard：Batch 五折、Fast/Ultrafast 加价、长上下文（>272K）另有档位，
  // 而账本里没有这些标识，录进来只会让「按什么价算的」变成谜。
  //
  // gpt-5.6-terra 是本机账本里**真实出现**的模型（provider: openai-codex），
  // 早先没有条目，它一直被按 Flash 兜底价标成「估算价」——数字有、只是错的。
  // ⚠ 币种变更（v3）：OpenAI 官方价是**美元**，因此这里填**原价美元数**，
  // 由 `currency: 'USD'` 标明，并在生效视图里按 `usdToCny()` 折成人民币参与合计。
  // 早先这几个数被写死成「×7.2 的人民币值」——汇率一变就与用户自己的汇率不一致，
  // 而且看不出那个 7.2 是从哪来的。现在汇率是用户可改的一项设置，界面会写「按汇率 X 折算」。
  'gpt-5.6-terra': {
    label: 'GPT-5.6 Terra',
    vendor: 'OpenAI',
    version: 'gpt-5.6-terra',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // 官方 Standard 短上下文：输入 $2.00 / 输出 $12.00 / 缓存命中 $0.20 / 30m 写入 $2.50
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 12, idle: 12 },
    cacheWrite: { peak: 2.5, idle: 2.5 },
  },
  'gpt-5.6-sol': {
    label: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    version: 'gpt-5.6-sol',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $4.00 / $20.00 / 缓存命中 $0.40 / 30m 写入 $5.00（促销价，官方注明至 2026-11-30）
    cacheHit: { peak: 0.4, idle: 0.4 },
    cacheMiss: { peak: 4, idle: 4 },
    output: { peak: 20, idle: 20 },
    cacheWrite: { peak: 5, idle: 5 },
  },
  'gpt-5.6-luna': {
    label: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    version: 'gpt-5.6-luna',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $0.20 / $1.20 / 缓存命中 $0.02 / 30m 写入 $0.25
    cacheHit: { peak: 0.02, idle: 0.02 },
    cacheMiss: { peak: 0.2, idle: 0.2 },
    output: { peak: 1.2, idle: 1.2 },
    cacheWrite: { peak: 0.25, idle: 0.25 },
  },
  // ── OpenAI GPT-6 世代（美元 / 百万 token，Standard 档、短上下文 ≤272K）──────
  // 来源：https://developers.openai.com/api/docs/pricing.md（截止 2026-11-13 抓取）
  //
  // 只录 **Standard 短上下文**：Batch 五折、Fast / Ultrafast 加价、长上下文
  // （>272K）另有档位，而账本里没有这些标识，录进来只会让「按什么价算的」变成谜。
  // 「30m write」是官方价目表里缓存写入那一档，与 DeepSeek 的 1.25× 规则不同源，
  // 因此单独写成 `cacheWrite`（见 costOf）。
  'gpt-6-astra': {
    label: 'GPT-6 Astra',
    vendor: 'OpenAI',
    version: 'gpt-6-astra',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $10.00 / $50.00 / 缓存命中 $1.00 / 30m 写入 $12.50
    cacheHit: { peak: 1, idle: 1 },
    cacheMiss: { peak: 10, idle: 10 },
    output: { peak: 50, idle: 50 },
    cacheWrite: { peak: 12.5, idle: 12.5 },
  },
  'gpt-6.1-sol': {
    label: 'GPT-6.1 Sol',
    vendor: 'OpenAI',
    version: 'gpt-6.1-sol',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $2.00 / $10.00 / 缓存命中 $0.10 / 30m 写入 $2.50
    cacheHit: { peak: 0.1, idle: 0.1 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 10, idle: 10 },
    cacheWrite: { peak: 2.5, idle: 2.5 },
  },
  'gpt-6.1-terra': {
    label: 'GPT-6.1 Terra',
    vendor: 'OpenAI',
    version: 'gpt-6.1-terra',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $1.00 / $5.00 / 缓存命中 $0.05 / 30m 写入 $1.25
    cacheHit: { peak: 0.05, idle: 0.05 },
    cacheMiss: { peak: 1, idle: 1 },
    output: { peak: 5, idle: 5 },
    cacheWrite: { peak: 1.25, idle: 1.25 },
  },
  'gpt-6-luna': {
    label: 'GPT-6 Luna',
    vendor: 'OpenAI',
    version: 'gpt-6-luna',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $0.10 / $0.50 / 缓存命中 $0.01 / 30m 写入 $0.125
    cacheHit: { peak: 0.01, idle: 0.01 },
    cacheMiss: { peak: 0.1, idle: 0.1 },
    output: { peak: 0.5, idle: 0.5 },
    cacheWrite: { peak: 0.125, idle: 0.125 },
  },
  'gpt-6-sol': {
    label: 'GPT-6 Sol',
    vendor: 'OpenAI',
    version: 'gpt-6-sol',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $2.00 / $10.00 / 缓存命中 $0.20 / 30m 写入 $2.50
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 10, idle: 10 },
    cacheWrite: { peak: 2.5, idle: 2.5 },
  },
  'gpt-5.5': {
    label: 'GPT-5.5',
    vendor: 'OpenAI',
    version: 'gpt-5.5',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $5.00 / $30.00 / 缓存命中 $0.50（官方未给 30m 写入价，写入按命中价的 12.5 倍估）
    cacheHit: { peak: 0.5, idle: 0.5 },
    cacheMiss: { peak: 5, idle: 5 },
    output: { peak: 30, idle: 30 },
  },
  'gpt-5.4': {
    label: 'GPT-5.4',
    vendor: 'OpenAI',
    version: 'gpt-5.4',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $2.50 / $15.00 / 缓存命中 $0.25
    cacheHit: { peak: 0.25, idle: 0.25 },
    cacheMiss: { peak: 2.5, idle: 2.5 },
    output: { peak: 15, idle: 15 },
  },
  'gpt-5.4-mini': {
    label: 'GPT-5.4 mini',
    vendor: 'OpenAI',
    version: 'gpt-5.4-mini',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $0.75 / $4.50 / 缓存命中 $0.075
    cacheHit: { peak: 0.075, idle: 0.075 },
    cacheMiss: { peak: 0.75, idle: 0.75 },
    output: { peak: 4.5, idle: 4.5 },
  },
  'gpt-5.4-nano': {
    label: 'GPT-5.4 nano',
    vendor: 'OpenAI',
    version: 'gpt-5.4-nano',
    currency: 'USD',
    flat: true,
    contextWindow: 272_000,
    maxOutput: 128_000,
    // $0.20 / $1.25 / 缓存命中 $0.02
    cacheHit: { peak: 0.02, idle: 0.02 },
    cacheMiss: { peak: 0.2, idle: 0.2 },
    output: { peak: 1.25, idle: 1.25 },
  },
  // ── Anthropic Claude（美元 / 百万 token，官方 API 标准价）─────────────────
  // 来源：https://docs.anthropic.com/en/docs/about-claude/pricing（2026-11-13 抓取）
  //
  // 官方表的口径是「Input / Output / 5m writes / 1h writes / Hits」：
  //   cacheHit = Hits，cacheWrite = **5m writes**（1h 那一档更贵，账本里没有 TTL 信息，
  //   因此统一按 5m 计——与 OpenAI 用 30m write 同一思路：取**最便宜的那一档写入**，
  //   免得把「可能用了 1h」当成必然）。长上下文（>200K）另有加价档，未收录。
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5',
    vendor: 'Anthropic',
    version: 'claude-sonnet-5-5',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $2.00 / $10.00 / 5m 写入 $2.50 / 命中 $0.10
    cacheHit: { peak: 0.1, idle: 0.1 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 10, idle: 10 },
    cacheWrite: { peak: 2.5, idle: 2.5 },
  },
  'claude-opus-5-5': {
    label: 'Claude Opus 5.5',
    vendor: 'Anthropic',
    version: 'claude-opus-5-5',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $4.00 / $20.00 / 5m 写入 $5.00 / 命中 $0.20
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 4, idle: 4 },
    output: { peak: 20, idle: 20 },
    cacheWrite: { peak: 5, idle: 5 },
  },
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    vendor: 'Anthropic',
    version: 'claude-haiku-5-5',
    currency: 'USD',
    flat: true,
    // 官方按**输入长度**分档（≤100K 与 >100K），账本里没有逐请求输入长度 →
    // 只取最低档并标 tiered，界面注明「按最低档估算」。
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // ≤100K：$0.10 / $0.50 / 5m 写入 $0.125 / 命中 $0.01（>100K 是 5 倍价）
    cacheHit: { peak: 0.01, idle: 0.01 },
    cacheMiss: { peak: 0.1, idle: 0.1 },
    output: { peak: 0.5, idle: 0.5 },
    cacheWrite: { peak: 0.125, idle: 0.125 },
  },
  'claude-fable-5-2': {
    label: 'Claude Fable 5.2',
    vendor: 'Anthropic',
    version: 'claude-fable-5-2',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $8.00 / $40.00 / 5m 写入 $10.00 / 命中 $0.20
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 8, idle: 8 },
    output: { peak: 40, idle: 40 },
    cacheWrite: { peak: 10, idle: 10 },
  },
  'claude-sonnet-4-6': {
    label: 'Claude Sonnet 4.6',
    vendor: 'Anthropic',
    version: 'claude-sonnet-4-6',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $3.00 / $15.00 / 5m 写入 $3.75 / 命中 $0.30
    cacheHit: { peak: 0.3, idle: 0.3 },
    cacheMiss: { peak: 3, idle: 3 },
    output: { peak: 15, idle: 15 },
    cacheWrite: { peak: 3.75, idle: 3.75 },
  },
  'claude-sonnet-4-5': {
    label: 'Claude Sonnet 4.5',
    vendor: 'Anthropic',
    version: 'claude-sonnet-4-5',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $3.00 / $15.00 / 5m 写入 $3.75 / 命中 $0.30
    cacheHit: { peak: 0.3, idle: 0.3 },
    cacheMiss: { peak: 3, idle: 3 },
    output: { peak: 15, idle: 15 },
    cacheWrite: { peak: 3.75, idle: 3.75 },
  },
  'claude-opus-4-6': {
    label: 'Claude Opus 4.6',
    vendor: 'Anthropic',
    version: 'claude-opus-4-6',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $5.00 / $25.00 / 5m 写入 $6.25 / 命中 $0.50
    cacheHit: { peak: 0.5, idle: 0.5 },
    cacheMiss: { peak: 5, idle: 5 },
    output: { peak: 25, idle: 25 },
    cacheWrite: { peak: 6.25, idle: 6.25 },
  },
  'claude-opus-4-5': {
    label: 'Claude Opus 4.5',
    vendor: 'Anthropic',
    version: 'claude-opus-4-5',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // $5.00 / $25.00 / 5m 写入 $6.25 / 命中 $0.50
    cacheHit: { peak: 0.5, idle: 0.5 },
    cacheMiss: { peak: 5, idle: 5 },
    output: { peak: 25, idle: 25 },
    cacheWrite: { peak: 6.25, idle: 6.25 },
  },
  // ── Google Gemini（美元 / 百万 token，Gemini Developer API 标准价）──────────
  // 来源：https://ai.google.dev/gemini-api/docs/pricing（2026-11-13 抓取）
  //
  // 注意两处**限时价**，官方页写明到期后翻倍，这里按「当前实际扣费」记：
  //   gemini-4-carbon / gemini-4-argon：$2/$10/$0.10 至 2026-11-30，之后 $4/$20/$0.20
  //   gemini-3.8-flash：$0.75/$3.75/$0.075 至 2026-12-31，之后 $1.50/$7.50/$0.15
  // 取当期折后价与千问 qwen3.7-plus 同一口径（用户当前账单就是按它扣的）。
  'gemini-4-carbon': {
    label: 'Gemini 4 Carbon',
    vendor: 'Google',
    version: 'gemini-4-carbon',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // 限时价至 2026-11-30：$2.00 / $10.00 / 缓存命中 $0.10
    cacheHit: { peak: 0.1, idle: 0.1 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 10, idle: 10 },
  },
  'gemini-4-argon': {
    label: 'Gemini 4 Argon',
    vendor: 'Google',
    version: 'gemini-4-argon',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // 限时价至 2026-11-30：$2.00 / $10.00 / 缓存命中 $0.10
    cacheHit: { peak: 0.1, idle: 0.1 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 10, idle: 10 },
  },
  'gemini-4-hydrogen': {
    label: 'Gemini 4 Hydrogen',
    vendor: 'Google',
    version: 'gemini-4-hydrogen',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // $1.50 / $7.50 / 缓存命中 $0.075
    cacheHit: { peak: 0.075, idle: 0.075 },
    cacheMiss: { peak: 1.5, idle: 1.5 },
    output: { peak: 7.5, idle: 7.5 },
  },
  'gemini-3.8-flash': {
    label: 'Gemini 3.8 Flash',
    vendor: 'Google',
    version: 'gemini-3.8-flash',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // 限时价至 2026-12-31：$0.75 / $3.75 / 缓存命中 $0.075
    cacheHit: { peak: 0.075, idle: 0.075 },
    cacheMiss: { peak: 0.75, idle: 0.75 },
    output: { peak: 3.75, idle: 3.75 },
  },
  'gemini-3.1-pro-preview': {
    label: 'Gemini 3.1 Pro',
    vendor: 'Google',
    version: 'gemini-3.1-pro-preview',
    currency: 'USD',
    flat: true,
    // 官方按 200K 输入分档，只有一档给了价（≤200K），按最低档记并标 tiered
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // ≤200K：$2.00 / $12.00 / 缓存命中 $0.20
    cacheHit: { peak: 0.2, idle: 0.2 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 12, idle: 12 },
  },
  'gemini-2.5-pro': {
    label: 'Gemini 2.5 Pro',
    vendor: 'Google',
    version: 'gemini-2.5-pro',
    currency: 'USD',
    flat: true,
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // ≤200K：$1.25 / $10.00 / 缓存命中 $0.125
    cacheHit: { peak: 0.125, idle: 0.125 },
    cacheMiss: { peak: 1.25, idle: 1.25 },
    output: { peak: 10, idle: 10 },
  },
  'gemini-2.5-flash': {
    label: 'Gemini 2.5 Flash',
    vendor: 'Google',
    version: 'gemini-2.5-flash',
    currency: 'USD',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    // $0.30 / $2.50 / 缓存命中 $0.03（音频输入另有价，账本里分不出来，不单列）
    cacheHit: { peak: 0.03, idle: 0.03 },
    cacheMiss: { peak: 0.3, idle: 0.3 },
    output: { peak: 2.5, idle: 2.5 },
  },
  // ── xAI Grok（美元 / 百万 token）────────────────────────────────────
  // 来源：https://x.ai/api（2026-11-13 抓取；文档站把价目放在 Models 页，
  // 该页由前端渲染，抓下来的 HTML 里是 `promptTextTokenPrice` 之类的原始字段，
  // 单位不是美元本身——因此这里只收录**渲染文本里能直接读到**的那一条旗舰价）
  'grok-4.7': {
    label: 'Grok 4.7',
    vendor: 'xAI',
    version: 'grok-4.7',
    currency: 'USD',
    flat: true,
    contextWindow: 500_000,
    maxOutput: 128_000,
    // $2.00 输入 / $6.00 输出；缓存命中 $0.50（官方价目字段为输入价的 25%）
    cacheHit: { peak: 0.5, idle: 0.5 },
    cacheMiss: { peak: 2, idle: 2 },
    output: { peak: 6, idle: 6 },
  },
  // ── MiniMax（元 / 百万 token，官方定价概览页）────────────────────────
  // 来源：https://platform.minimaxi.com/document/price（2026-11-13 抓取）
  'minimax-m3.1-flash': {
    label: 'MiniMax M3.1 Flash',
    vendor: 'MiniMax',
    version: 'MiniMax-M3.1-Flash',
    flat: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // ¥1.00 输入 / ¥4.00 输出 / 缓存读取 ¥0.10
    cacheHit: { peak: 0.1, idle: 0.1 },
    cacheMiss: { peak: 1, idle: 1 },
    output: { peak: 4, idle: 4 },
  },
  'minimax-m3': {
    label: 'MiniMax M3',
    vendor: 'MiniMax',
    version: 'MiniMax-M3',
    flat: true,
    // 官方按输入长度分档（≤512K / >512K），且标注「永久五折」：
    // 这里取 ≤512K 的**折后价**（当前实际扣费），并标 tiered。
    tiered: true,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    // ≤512K 折后：¥2.10 / ¥8.40 / 缓存读取 ¥0.42
    cacheHit: { peak: 0.42, idle: 0.42 },
    cacheMiss: { peak: 2.1, idle: 2.1 },
    output: { peak: 8.4, idle: 8.4 },
  },
}

/**
 * 各家**官方定价页**。价目必须有出处——凭记忆写的价在界面上看不出来，只是错的。
 *
 * 抓取与核对的时间见 {@link RATES_AS_OF}；每次改价都要同时改这两处。
 * 抓不到官方价的厂商（本轮：Kimi 的价格表由前端渲染、豆包/火山方舟整站要 JS、
 * Mistral 的 API 价目页未给出逐模型表）**不收录**，宁可让它们继续显示「估算价」，
 * 也不写一个猜的数字——那正是本项目最忌惮的失败形态。
 */
const VENDOR_SOURCES = {
  DeepSeek: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  智谱: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
  千问: 'https://www.alibabacloud.com/help/zh/model-studio/model-pricing',
  OpenAI: 'https://developers.openai.com/api/docs/pricing.md',
  Anthropic: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  Google: 'https://ai.google.dev/gemini-api/docs/pricing',
  xAI: 'https://x.ai/api',
  MiniMax: 'https://platform.minimaxi.com/document/price',
}

/** 本轮价目的采集 / 核对截止月份（逐条可用 `asOf` 覆盖，如限时价）。 */
export const RATES_AS_OF = '2026-11'

/**
 * 给内置价目补齐 `currency` / `asOf` / `source`。
 *
 * 逐条重复写三个出处字段既啰嗦又容易漏，而「哪一条没有出处」这件事必须**一眼可查**：
 * 缺了就由厂商表兜着，界面上永远能点开原始定价页。
 * @param {object} table - 价目表（原地修改）。
 * @returns {void}
 */
function stampRateProvenance(table) {
  for (const rates of Object.values(table)) {
    if (rates.currency === undefined) rates.currency = 'CNY'
    if (rates.asOf === undefined) rates.asOf = RATES_AS_OF
    if (rates.source === undefined) rates.source = VENDOR_SOURCES[rates.vendor] ?? ''
  }
}

stampRateProvenance(MODEL_RATES)

/**
 * USD → CNY 的默认汇率。
 *
 * 为什么要它：官方价目只有一部分是人民币（DeepSeek / 智谱 / 千问 / MiniMax），
 * 其余（OpenAI / Anthropic / Google / xAI）官方**只给美元**。看板要把它们加在
 * 一起就必须换汇，而汇率只能由用户定——写死 7.2 的后果是数字对不上他自己的账单，
 * 且界面上看不出那个 7.2 从哪来。
 */
export const DEFAULT_USD_TO_CNY = 7.3

/** 生效中的汇率（用户可改，见 {@link setUsdToCny}）。 */
let USD_TO_CNY = DEFAULT_USD_TO_CNY

/**
 * 当前生效的 USD → CNY 汇率。
 * @returns {number} 汇率。
 */
export function usdToCny() {
  return USD_TO_CNY
}

/**
 * 设置汇率并重建生效视图。
 *
 * 非法值（非数字 / ≤0）**回落到默认值**而不是保留旧值：汇率是「用户以为的那一个」，
 * 静默沿用旧值会让他以为改成功了。调用方（设置界面）在保存前已做校验并会报错，
 * 这里只是最后一道防线。
 * @param {number|string} value - 新汇率。
 * @returns {number} 实际生效的汇率。
 */
export function setUsdToCny(value) {
  const amount = Number(value)
  const next = Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_USD_TO_CNY
  if (next !== USD_TO_CNY) {
    USD_TO_CNY = next
    rebuildRateViews()
  }
  return USD_TO_CNY
}

/**
 * 提供商倍率（**中转加价**）：`provider 路由名 → 倍数`。
 *
 * 为什么要有：用户常常经由中转站调用官方模型，那家在官方价上加价（如 1.2 倍）。
 * 官价估算回答的是「如果走官方要多少钱」，加上这一层才答得上「我实际被扣了多少」。
 * 默认 1（不改变任何数字）；只影响**金额**，不影响用量与归属。
 */
let MARKUP_VIEW = Object.freeze({})

/**
 * 生效中的提供商倍率表（只读用途）。
 * @returns {Record<string, number>} 提供商路由名 → 倍数。
 */
export function activeMarkup() {
  return MARKUP_VIEW
}

/**
 * 取某个提供商的倍率。
 *
 * 认不出来（没配过 / 值非法）一律返回 **1**：倍率是「用户额外声明的信息」，
 * 缺省就该是「不加价」，而不是猜一个。
 * @param {string} provider - 提供商路由名（`commandcode` / `workbuddy-cn` …）。
 * @returns {number} 倍数（≥1 的实数；用户也可以填 <1 表示折扣）。
 */
export function markupOf(provider) {
  const name = String(provider ?? '').trim()
  if (name === '') return 1
  const value = MARKUP_VIEW[name]
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * 设置提供商倍率。
 * @param {Record<string, number>|undefined} map - 提供商 → 倍数。
 * @returns {void}
 */
export function setMarkup(map) {
  const next = {}
  for (const [provider, value] of Object.entries(map ?? {})) {
    const name = String(provider ?? '').trim()
    const amount = Number(value)
    if (name === '' || !Number.isFinite(amount) || amount <= 0) continue
    next[name] = amount
  }
  MARKUP_VIEW = Object.freeze(next)
}

/** 金额保留 6 位小数：换汇会产生 14.599999999 这种尾巴，累加后会与明细差一分钱。 */
function money(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount * 1e6) / 1e6 : 0
}

/**
 * 把一个价档对按汇率换算。
 * @param {{peak:number,idle:number}|undefined} pair - 原币价档。
 * @param {number} fx - 汇率。
 * @returns {{peak:number,idle:number}|undefined} 人民币价档。
 */
function convertPair(pair, fx) {
  if (pair === null || pair === undefined) return pair
  return { peak: money(pair.peak * fx), idle: money(pair.idle * fx) }
}

/**
 * 把一条价目折成**人民币**（计价与展示的唯一口径）。
 *
 * 三条设计约束：
 *   1) **人民币条目原样返回同一个对象**——`pricingOf(未知模型).rates` 与
 *      `MODEL_RATES['deepseek-flash']` 是同一个引用，闸门按引用钉死过这件事；
 *      而且 30 多条人民币条目没必要每次都复制一遍。
 *   2) **原币数字不丢**：折算后的条目带 `native`（原币价档）与 `sourceCurrency`，
 *      界面才能如实写「官方 $2.00 / 百万 token，按汇率 7.3 折算 ¥14.60」。
 *   3) **只折算、不改标签**：label / vendor / flat / tiered / asOf / source 原样带过去。
 * @param {object} rates - 价目条目。
 * @param {number} fx - USD → CNY 汇率。
 * @returns {object} 人民币条目。
 */
export function cnyRates(rates, fx = USD_TO_CNY) {
  const currency = typeof rates?.currency === 'string' ? rates.currency : 'CNY'
  if (currency === 'CNY' || currency === undefined) return rates
  const converted = {
    ...rates,
    currency: 'CNY',
    sourceCurrency: currency,
    fx,
    native: {
      currency,
      cacheHit: rates.cacheHit,
      cacheMiss: rates.cacheMiss,
      output: rates.output,
      ...(rates.cacheWrite === undefined ? {} : { cacheWrite: rates.cacheWrite }),
    },
    cacheHit: convertPair(rates.cacheHit, fx),
    cacheMiss: convertPair(rates.cacheMiss, fx),
    output: convertPair(rates.output, fx),
  }
  if (rates.cacheWrite !== undefined) converted.cacheWrite = convertPair(rates.cacheWrite, fx)
  return converted
}

/**
 * 把一整张价目表折成人民币视图（自定义条目也参与折算）。
 * @param {object} table - 原币价目表。
 * @param {number} fx - 汇率。
 * @returns {Record<string, object>} 人民币价目表。
 */
export function cnyRateTable(table, fx = USD_TO_CNY) {
  const out = {}
  for (const [key, rates] of Object.entries(table ?? {})) {
    if (rates === null || typeof rates !== 'object') continue
    out[key] = cnyRates(rates, fx)
  }
  return out
}

/**
 * 未知厂商的模型**不会**被 `MODEL_RATES` 认出来，此时落到 {@link FALLBACK_RATES}。
 *
 * 这正是本机账本里 `gpt-5.6-terra` 的处境：它有真实用量，但内置表没有它，
 * 于是被标成「估算价」并按 Flash 折算——数字有、不报错，只是不对。
 * 想改对有两个入口：
 *   1) 在面板里填「自定义单价」（写入 `custom-rates.json`，见 custom-rates.js）；
 *   2) 给本项目提 PR 把官方价补进 `MODEL_RATES`。
 */

/**
 * 未知模型的兜底价：按 Flash 计，避免看板出现空洞。
 *
 * **兜底是「猜」而不是「知道」。** 落在兜底上的模型会在数据里被标成
 * `priced: false`，界面据此显示「按 Flash 估算」，而不是让一个猜出来的数字
 * 看起来像官方价。静默兜底正是最容易骗到自己的一种错。
 */
export const FALLBACK_RATES = MODEL_RATES['deepseek-flash']

/**
 * 旧名 / 别名 → 价目表键。
 *
 * DeepSeek：官方说明旧名仍可调用但按 Flash 计费。
 * `deepseek-v4.1-flash` 是 **DSH 侧实际在用的模型名**（本机账本里就有近 2000 条），
 * 不折叠的话它会走兜底：金额虽然一样，但会被标成「估算不准」并多出一行以原始名
 * 展示的模型，看起来像另一个模型。
 * 智谱：官方说明调用历史模型会自动切换（GLM-5.2 → GLM-5.3，GLM-4.7 → GLM-5.3-Flash 等）。
 */
export const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  // WorkBuddy 给同一个 DeepSeek Flash 起的别名（本机账本里有实测记录）。
  // 不折叠就会多出一行「DeepSeek Flash / hy4-preview-f」并标成「估算价」——
  // 明明是按 Flash 计费的同一个模型，看起来却像另一个来路不明的模型。
  'hy4-preview-f': 'deepseek-flash',
  'glm-5.3-highspeed': 'glm-5.3',
  'glm-5.2-highspeed': 'glm-5.2',
  'glm-5.1': 'glm-5.3',
  'glm-5-turbo': 'glm-5.3-flash',
  'glm-4.7': 'glm-5.3-flash',
  'glm-5v-turbo': 'glm-5.3-flash',
  // ── 千问：官方模型 ID 带日期后缀（`qwen3.8-max-0902`），不同网关还会加
  // `qwen/` 前缀。这些写法指向**同一个计价模型**，不折叠就会各自变成一行
  // 「估算价」，而官方并没有给它们单独定价。
  'qwen3.8-max-0902': 'qwen3.8-max',
  'qwen3.7-max-2026-06-08': 'qwen3.7-max',
  'qwen3.7-max-2026-05-20': 'qwen3.7-max',
  'qwen3.7-max-preview': 'qwen3.7-max',
  'qwen3.7-plus-2026-05-26': 'qwen3.7-plus',
  'qwen3.6-plus': 'qwen3.7-plus',
  'qwen3.6-plus-2026-04-02': 'qwen3.7-plus',
  'qwen3.8-flash-0902': 'qwen3.8-flash',
  'qwen/qwen3.8-max': 'qwen3.8-max',
  'qwen/qwen3.7-max': 'qwen3.7-max',
  'qwen/qwen3.8-flash': 'qwen3.8-flash',
  'qwen/qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.8-2.4t-a95b': 'qwen3.8-max',
  'qwen3.7-flash-2026-07-15': 'qwen3.7-flash',
  // ── OpenAI：网关常带 openai/ 前缀，或写成版本化 id ──────────────
  'openai/gpt-5.6-terra': 'gpt-5.6-terra',
  'openai/gpt-5.6-sol': 'gpt-5.6-sol',
  'openai/gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.6-terra-2026': 'gpt-5.6-terra',
  // ── 其余厂商：只加「规范化之后仍对不上」的那些写法 ─────────────────
  //
  // 大多数写法由 normalizeModel 的三层（小写 / `提供商/` 前缀 / canonicalOf）
  // 与部署后缀那一步自动覆盖，不必在这里逐条罗列：
  //   `anthropic/claude-sonnet-5-5`、`claude-sonnet-5.5`、`Claude Sonnet 5.5`
  //   都会落到 `claude-sonnet-5-5`；`google/gemini-3.8-flash` 同理。
  // 这里只列**同一模型的不同代号**——那种对应关系机器猜不出来，必须显式写。
  'claude-3-5-sonnet': 'claude-sonnet-4-5',
  'claude-3-5-sonnet-latest': 'claude-sonnet-4-5',
  // Gemini 的官方 id 有时带 `-preview` 之外的日期后缀，而价目表只收正式 id：
  // 这类「同一模型的预览版」按正式版计价，免得整段用量落兜底。
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  // MiniMax 的对外叫法与 id 大小写不同（`MiniMax-M3` / `minimax-m3`），
  // 规范化已能覆盖；这里补的是文档里出现过的带档位写法。
  'minimax-m3.1': 'minimax-m3.1-flash',
}

/**
 * 部署 / 规格后缀 → 它们**不属于模型身份**的证据。
 *
 * 自建网关（vLLM、SGLang、Ollama、各家中转）习惯在官方模型名后面接一段自己的
 * 标记，说明「这份权重跑在哪、是哪个规格」，而**模型本身仍是那一个**：
 *
 *   `glm-5.3-flash-local`   本机 / 内网自建部署
 *   `glm-5.3-flash-free`    免费通道
 *   `glm-5.3-flash-20260101` 快照日
 *
 * **判据是「官方有没有给它单独定价」，而不是「名字长得像不像」。** `glm-5.3-flashx`
 * 看着也像 Flash 加个记号，但官方在价目表里**单独列了它**（2 / 7 / 0.57，贵 2.5 倍），
 * 因此它是独立模型、有自己的一行，绝不能折进 Flash。反过来，`-local` / `-free`
 * 这类官方价目表里根本没有，才是真正的部署标记。
 *
 * 这些都不该让它认不出模型——认不出的后果不是「少一个名字」，而是**按 DeepSeek
 * Flash 的单价计价**（见 FALLBACK_RATES）：数字有、界面也不报错，只是错的。
 * 实测本机 `glm-5.3-flash-local` 被按 `deepseek-flash` 算成了 ¥0.70，而按 GLM-5.3-Flash
 * 的官方价应当是 ¥1.57。
 *
 * ## 为什么必须是「清单 + 族内绑定」，而不是随便剥
 *
 * 剥后缀会**扩大**归一命中面，而这里最危险的失败模式恰好是「宽容变成乱认」
 * ——把别家模型按 DeepSeek 计价。因此两条约束一起上：
 *
 *   1) **只剥清单里列出的那一段**（外加纯数字快照日），不做「去掉最后一个 `-xxx`
 *      再试一次」这种通用回退：那会把 `gpt-6.1-sol` 里的 `sol` 当成后缀，一路剥到
 *      `gpt-6.1`，再撞不上就保留原名——看似无害，但 `kimi-k2-thinking` 会剥成
 *      `kimi-k2`，将来价目表一旦收录 `kimi-k2`，「思考版」就会按「基础版」计价。
 *   2) **只能折进同一族**（见 {@link familyOf}）：`glm-5.3-free` 认得，但
 *      `deepseek-v5-local` 不会因为有个 `local` 后缀就被折进 DeepSeek 的某一行。
 *
 * 认不出仍然是**默认结果**，这条路只是把「明显是同一个模型的部署标记」捡回来。
 */
const DEPLOYMENT_SUFFIXES = [
  'local', 'highspeed', 'turbo', 'free', 'online', 'server',
  'preview', 'exp', 'beta', 'stable', 'release', 'ga',
]

/** 全部可剥后缀，长的排前面免得被更短的规则先吃掉。 */
const DEPLOYMENT_SUFFIX_PATTERN = [...DEPLOYMENT_SUFFIXES]
  .sort((a, b) => b.length - a.length)
  .join('|')

/**
 * 取一个模型名的**族**（系列）：去掉结尾的规格档位、只留系列本身。
 *
 * 用来给「剥后缀」划一条不可逾越的边界。没有它，`deepseek-v5-local` 会被剥成
 * `deepseek-v5`——虽然仍认不出，但只要将来价目表收录了 `deepseek-v5`，一个**还不存在
 * 的版本**就会以「它有 local 后缀」为理由被折进现行价目。族内绑定让这种跨界折叠
 * 在构造上不可能发生：`glm-5.3-flash-local` 的族是 `glm-5.3`，候选行必须同族。
 *
 * 比较一律走 {@link canonicalOf}（只留小写字母与数字），因此
 * `glm-5.3-flash` 与 `glm53flash` 是同一个族、`的 GLM-5.3-Flash` 也一样。
 * **不要在这里按 `.` / `_` 做「统一成连字符」的替换**：那会把版本号
 * `5.3` 拆成 `5-3`，于是候选（还带点号）与价目表键（已换成连字符）算出的族
 * 永远不相等，整条路静默失效——踩过，症状是「新后缀一个都不认」。
 *
 * 档位只认价目表里真实出现过的 `flash`：族是不带档位的系列名。
 * @param {string} name - 模型名（可含 `提供商/` 前缀）。
 * @returns {string} 族名（规范化形式）；去不掉档位时返回规范化后的原名。
 */
function familyOf(name) {
  const text = String(name ?? '').toLowerCase().trim()
  const slash = text.lastIndexOf('/')
  let bare = slash >= 0 ? text.slice(slash + 1).trim() : text
  if (bare === '') return ''
  // **把所有**末尾标记都去掉，而不是只去一段。
  //
  // 只去一段的话，`glm-5.3-flash-local-preview` 算出来是 `glm53flashlocal`——里面还
  // 留着 `local`，而目标行 `glm-5.3-flash` 算出来是 `glm53flash`，两者永不相等，
  // 于是「多段标记」的名字整类静默失效（实测就是这么漏的）。系列名理应不含任何
  // 部署/规格标记，所以这里循环剥到不动为止。
  const marker = new RegExp(`-(?:${DEPLOYMENT_SUFFIX_PATTERN}|\\d{4,8})$`)
  for (let i = 0; i < 6; i += 1) {
    const next = bare.replace(marker, '')
    if (next === bare) break
    bare = next
  }
  // 再剥档位：族是不带档位的系列名（`glm-5.3-flash-local` 与 `glm-5.3` 同族）。
  const stripped = bare.replace(/-flash$/, '')
  return canonicalOf(stripped === '' ? bare : stripped)
}

/** 预计算的「族 → 该族下最长的价目表键」，只在自定义价目变更时重建。 */
let FAMILY_VIEW = new Map()

/**
 * 重建族索引。
 *
 * 同一个族有多条时取**最长的键**：`glm-5.3` 与 `glm-5.3-flash` 同族
 * （族都是 `glm-5.3`），而 `glm-5.3-flash-local` 显然更该是 Flash 那一行。
 * 取最短会把它按「完整的 GLM-5.3」计价——贵 10 倍，且看不出来。
 * @param {object} rates - 生效中的价目表。
 * @returns {void}
 */
function buildFamilyIndex(rates) {
  const index = new Map()
  for (const key of Object.keys(rates)) {
    const family = familyOf(key)
    const existing = index.get(family)
    if (existing === undefined || key.length > existing.length) index.set(family, key)
  }
  FAMILY_VIEW = index
}

/**
 * 受控地剥掉部署 / 规格后缀，并**只折进同一族**的价目表键。
 *
 * 逐层剥（`glm-5.3-flash-20260101-local` 要剥两段），每剥一层都回头查一次
 * ——与发售日那条路同一个套路，只是这里还多一道「同族」闸门。
 * @param {string} lower - 已小写的模型名。
 * @param {(candidate:string)=>string|undefined} lookup - 三种查法（价目表 / 别名 / 规范化）。
 * @returns {string|undefined} 价目表键；认不出返回 undefined。
 */
function stripDeploymentSuffix(lower, lookup) {
  const slash = lower.lastIndexOf('/')
  const head = slash >= 0 ? lower.slice(0, slash + 1) : ''
  let candidate = slash >= 0 ? lower.slice(slash + 1).trim() : lower
  if (candidate === '') return undefined
  const family = familyOf(candidate)

  for (let i = 0; i < 4; i += 1) {
    // 变体标记与发售日（四到八位数字快照日）可以交替出现，因此循环而不是一次替换。
    const match = candidate.match(new RegExp(`-(${DEPLOYMENT_SUFFIX_PATTERN}|\\d{4,8})$`))
    if (match === null) break
    candidate = candidate.slice(0, candidate.length - match[0].length)
    const resolved = lookup(`${head}${candidate}`)
    // 同族才收：`glm-5.3-flash-local` 折进 `glm-5.3-flash` 可以，
    // 折进 `deepseek-flash` 或别的系列都不行。
    if (resolved !== undefined && familyOf(resolved) === family) return resolved
  }
  return undefined
}

/**
 * 规范化形式：只保留小写字母与数字。
 *
 * 用来吸收各家网关对同一个模型的各种写法——大小写、连字符 / 下划线 / 点号的
 * 有无、提供商前缀，全都不该影响「这是哪个模型」的判断：
 *
 *   `deepseek-flash` · `DeepSeek-Flash` · `deepseek_v4.1_flash`
 *   · `deepseekv41flash` · `deepseek/deepseek-v4.1-flash`
 *
 * 全部归一成 `deepseekv41flash`。
 * @param {string} name - 任意写法。
 * @returns {string} 只含小写字母与数字的形式。
 */
function canonicalOf(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 规范化形式 → 价目表键。
 *
 * 由**价目表键与别名共同**建立，因此 `hy4-preview-f` 这类别名也能被规范化命中。
 *
 * **冲突必须显式拒绝，不能任选一个。** 两个不同的模型若规范化后撞在一起
 * （例如将来同时收录 `glm-5.3` 与 `glm-53`），随便取一个就会把 A 的价按到 B 头上，
 * 而那种错误在界面上完全看不出来——数字有、也不报错，只是错的。
 * 因此撞车的形式会从索引里**删除**并记进 `CANONICAL_COLLISIONS`，
 * 由闸门断言它为空；将来真撞上时打包/测试会直接失败，逼人加显式别名。
 */
function buildIndex(rates, aliases) {
  const index = new Map()
  const collisions = new Set()
  const add = (name, key) => {
    const canonical = canonicalOf(name)
    if (canonical === '') return
    const existing = index.get(canonical)
    if (existing === undefined) {
      index.set(canonical, key)
      return
    }
    if (existing !== key) {
      collisions.add(`${canonical}: ${existing} / ${key}`)
      index.delete(canonical)
    }
  }
  for (const key of Object.keys(rates)) add(key, key)
  for (const [alias, key] of Object.entries(aliases)) add(alias, key)
  return { index, collisions }
}

const BUILTIN_INDEX = buildIndex(MODEL_RATES, MODEL_ALIASES)

/**
 * 生效中的族索引：只在价目表变化时重建，`normalizeModel` 每命中一次都要查它，
 * 因此不能每次现算（它落在导入账本的热路径上：每条记录一次归一）。
 */
buildFamilyIndex(MODEL_RATES)

/** 规范化后互相冲突的**内置**模型名（应为空；非空时闸门会失败）。 */
export const CANONICAL_COLLISIONS = Object.freeze([...BUILTIN_INDEX.collisions])

/**
 * 当前生效的价目表：内置表 + 用户补充的条目（见 {@link setCustomRates}），
 * **并且已经折成人民币**。
 *
 * 之所以要一层「视图」而不是直接用 MODEL_RATES：用户想给一个价目表里没有的模型
 * （比如某个新发布的模型）补一个官方价，不该改源码、更不该重新构建。因此运行时
 * 可换一整套合并后的表，而 MODEL_RATES 始终是那份**内置**事实，供测试与
 * 「哪些是内置」的判断使用。
 *
 * 「折成人民币」是同一次重建里做的事：USD 条目必须换汇后才能与人民币条目相加，
 * 而汇率是可变的（{@link setUsdToCny}）。把它留在 `costOf` / 每个界面上各做一次，
 * 就会出现「合计按一个汇率、明细按另一个」——那种差异在界面上完全看不出来。
 */
let RATES_VIEW = MODEL_RATES
let ALIASES_VIEW = MODEL_ALIASES
let INDEX_VIEW = BUILTIN_INDEX
/** 用户补充的模型键（用于界面标注「自定义价」）。 */
let CUSTOM_KEYS = new Set()
/** 上一次应用的**原币**自定义条目：汇率变化时要用它重建视图。 */
let CUSTOM_INPUT = {}

/**
 * 重建生效视图（内置 + 自定义 → 合并且折成人民币）。
 *
 * 归一索引与族索引必须**一起**重建：用户新加的键要能被 `normalizeModel` 认出来，
 * 否则那份价永远落不到任何一行上——界面上表现为「我明明配了价，金额还是估算」。
 * @returns {void}
 */
function rebuildRateViews() {
  const entries = Object.entries(CUSTOM_INPUT)
  const merged = entries.length === 0 ? MODEL_RATES : { ...MODEL_RATES, ...CUSTOM_INPUT }
  // 外币条目必须换汇后才能与人民币条目相加。人民币条目在 `cnyRates()` 里**原样返回
  // 同一个对象**，因此 `RATES_VIEW['deepseek-flash']` 与 `MODEL_RATES['deepseek-flash']`
  // 仍是同一个引用——闸门按引用钉过这条，界面也靠它区分「内置」与「自定义」。
  const hasForeign = Object.values(merged).some((rate) => rate?.currency === 'USD')
  RATES_VIEW = hasForeign ? cnyRateTable(merged, USD_TO_CNY) : merged
  ALIASES_VIEW = MODEL_ALIASES
  CUSTOM_KEYS = new Set(entries.map(([key]) => key))
  // 内置索引与用户条目一起重建：两者可能规范化后撞车（如自定义 'glm-53' 撞上
  // 内置 'glm-5.3'），此时新索引会把这个形式删掉——归一认不出，而不是按错价。
  INDEX_VIEW = entries.length === 0 ? BUILTIN_INDEX : buildIndex(merged, MODEL_ALIASES)
  // 族索引同理：用户补的价要能接住带部署后缀的路由名，
  // 否则「我明明配了 glm-5.3-flash，`...-local` 却还是估算价」。
  buildFamilyIndex(merged)
}

/**
 * 当前生效的价目表（只读用途，**已折成人民币**）。
 * @returns {Record<string, object>} 价目表。
 */
export function activeRates() { return RATES_VIEW }

/** 该模型键的价是否来自用户补充（而不是内置表）。 */
export function isCustomRate(key) { return CUSTOM_KEYS.has(key) }

/**
 * 校验一份用户补充的价目。
 *
 * 用户写的文件是**手写 YAML/JSON**，出错的方式很多（少一个分档、把「元」写成
 * 「角」、键名拼错）。这里逐条验证并**返回可读原因**，让界面能指出是哪一条
 * 哪一项有问题——静默忽略一条写错的价，用户会以为插件没生效。
 * @param {unknown} input - 待校验的原始对象（模型键 → 价目条目）。
 * @returns {{rates:object,errors:string[]}} 通过的条目与错误清单。
 */
export function validateCustomRates(input) {
  const rates = {}
  const errors = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { rates, errors: ['顶层需要是一个对象：模型键 → 价目条目'] }
  }
  const numberOrError = (value, label, where) => {
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push(`${where} 的 ${label} 需要是一个非负数字，实际 ${JSON.stringify(value)}`)
      return undefined
    }
    return amount
  }
  for (const [key, entry] of Object.entries(input)) {
    const where = `模型「${key}」`
    if (key.trim() === '') { errors.push('存在空的模型键'); continue }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} 需要是一个对象`)
      continue
    }
    /**
     * 读一个价字段。**两种写法都认**：
     *   - 写一个数 → 不分时，高峰与空闲同价；
     *   - 写 `{ peak, idle }` → 分时，两个值都**照写出来的读**。
     *
     * 注意不能按「条目里有没有 idle」去推断是否分时：那个判据会把只写 peak 的
     * 分时条目静默压成同价（踩过——用户的 { idle: 20, peak: 40 } 被读成两个 40）。
     * 是否不分时只能由**读出来的三个字段是否两两相等**在最后判定。
     */
    const pick = (field) => {
      const value = entry[field]
      if (value === null || typeof value !== 'object') {
        const single = numberOrError(value, field, where)
        return single === undefined ? undefined : { peak: single, idle: single }
      }
      const peak = numberOrError(value.peak ?? value.idle, `${field}.peak`, where)
      const idle = numberOrError(value.idle ?? value.peak, `${field}.idle`, where)
      if (peak === undefined || idle === undefined) return undefined
      return { peak, idle }
    }
    // 缓存命中价**可以整项省略**：很多模型（或用户自己配的）没有缓存优惠，
    // 逼着填一个 0 只会增加出错机会。省略即按 0 计；写了但值不合法仍然报错。
    // 另外两档（未命中 / 输出）必须写：少了它们，这条价目没有任何金额含义。
    const cacheHit = entry.cacheHit === undefined ? { peak: 0, idle: 0 } : pick('cacheHit')
    const cacheMiss = pick('cacheMiss')
    const output = pick('output')
    if (cacheHit === undefined || cacheMiss === undefined || output === undefined) continue
    /**
     * 币种：可写 `"currency": "USD"` 表示这几个数字是**美元**，读取时按当前汇率折算。
     * 认不出的币种**明确报错**，而不是当成人民币——那会把 $2 当 ¥2 算，差 7 倍多。
     */
    let currency = 'CNY'
    if (entry.currency !== undefined) {
      const declared = String(entry.currency).trim().toUpperCase()
      if (declared === 'CNY' || declared === 'USD') currency = declared
      else {
        errors.push(`${where} 的 currency 只能是 CNY 或 USD，实际 ${JSON.stringify(entry.currency)}`)
        continue
      }
    }
    const cacheWrite = entry.cacheWrite === undefined ? undefined : pick('cacheWrite')
    if (entry.cacheWrite !== undefined && cacheWrite === undefined) continue
    const isFlat = cacheHit.peak === cacheHit.idle
      && cacheMiss.peak === cacheMiss.idle
      && output.peak === output.idle
    rates[key] = {
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : key,
      vendor: typeof entry.vendor === 'string' ? entry.vendor : '自定义',
      version: typeof entry.version === 'string' ? entry.version : '',
      currency,
      flat: isFlat,
      ...(entry.tiered === true ? { tiered: true } : {}),
      asOf: typeof entry.asOf === 'string' && entry.asOf !== '' ? entry.asOf : '自定义',
      ...(typeof entry.source === 'string' && entry.source !== '' ? { source: entry.source } : {}),
      cacheHit,
      cacheMiss,
      output,
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    }
  }
  return { rates, errors }
}

/**
 * 应用一份用户补充的价目（覆盖内置同名键，并参与归一）。
 *
 * 归一索引必须**重建**：用户新加的键要能被 normalizeModel 认出来，否则那份价
 * 永远落不到任何一行上——界面上表现为「我明明配了价，金额还是估算」。
 * @param {object} customRates - 已通过 {@link validateCustomRates} 的条目。
 * @returns {void}
 */
export function setCustomRates(customRates) {
  CUSTOM_INPUT = {}
  for (const [key, entry] of Object.entries(customRates ?? {})) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) CUSTOM_INPUT[key] = entry
  }
  rebuildRateViews()
}

// 模块初始化时先建一次视图：内置表里已经有 `currency: 'USD'` 的条目，
// 不折一次的话 `activeRates()` / `ratesOf()` 会把美元数字直接当人民币用。
rebuildRateViews()

/**
 * 把模型名归一：旧名与带日期的版本名折叠到价目表里的键。
 *
 * ## 为什么要做「规范化」而不只是精确匹配
 *
 * 用户为**自己配的任意第三方提供商**路由模型，路由名由那家网关决定，写法五花八门。
 * 只要那个名字能找到价目表归属，看板就该给出金额估算并按模型监看；找不到才退化成
 * 「只有调用量」。因此识别必须足够宽容——下面这些写法指的**都是** `deepseek-flash`：
 *
 *   `deepseek-flash` · `DeepSeek-Flash`（大小写）
 *   `deepseek/deepseek-flash`（网关「提供商/模型」前缀）
 *   `deepseek_v4.1_flash` · `deepseekv41flash`（分隔符有无）
 *   `deepseek-v4-flash-ga-260731`（带变体标记与发售日）
 *   `hy4-preview-f`（WorkBuddy 给同一个模型起的别名）
 *
 * ## 曾经漏掉的
 *
 * 早先只做「精确匹配 + 别名 + 剥后缀」，于是 `DeepSeek-Flash`（大小写不同）、
 * `deepseek/deepseek-flash`（带前缀）、`deepseekv41flash`（无分隔符）**全部落空**，
 * 被当成未知模型：既标成「估算价」，又在费用明细里另起一行，看起来像另一个模型。
 * 而用户举的例子恰好就是这三个。
 *
 * @param {string} model - 原始模型名。
 * @returns {string} 价目表键；认不出来时**原样返回**（保留原始写法供展示与分组）。
 */
export function normalizeModel(model) {
  const name = String(model ?? '').trim()
  if (name === '') return 'unknown'
  // 大小写不敏感：价目表键与别名表都是小写，先把输入也压成小写。
  const lower = name.toLowerCase()

  /**
   * 精确 / 别名 / 规范化，三种查法依次尝试。
   *
   * 带 `提供商/` 前缀时**连末段一起试**：调用方（包括部署后缀那条路）会拿
   * `z-ai/glm-5.3-flash` 这种还带着前缀的候选来查，而价目表里只有末段。
   * 早先这一步只做整体查，于是「带前缀 + 带部署后缀」的名字（实测
   * `z-ai/glm-5.3-flashx`）在最后一步凭空落空——前缀在别处剥掉了，
   * 这里却以为它已经被处理过。
   * @param {string} candidate - 候选模型名。
   * @returns {string|undefined} 价目表键。
   */
  const lookup = (candidate) => {
    const bare = (text) => {
      if (RATES_VIEW[text] !== undefined) return text
      const alias = ALIASES_VIEW[text]
      if (alias !== undefined) return alias
      return INDEX_VIEW.index.get(canonicalOf(text))
    }
    const direct = bare(candidate)
    if (direct !== undefined) return direct
    const slash = candidate.lastIndexOf('/')
    if (slash >= 0) {
      const tail = candidate.slice(slash + 1).trim()
      if (tail !== '') return bare(tail)
    }
    return undefined
  }

  const direct = lookup(lower)
  if (direct !== undefined) return direct

  // 网关「提供商/模型」形态：取最后一段再查。**只有查得到才采用**，
  // 查不到就保留原名——否则会把 `qwen/qwen3.6-max` 的展示名改成 `qwen3.6-max`。
  const slash = lower.lastIndexOf('/')
  if (slash >= 0) {
    const tail = lower.slice(slash + 1).trim()
    if (tail !== '') {
      const resolved = lookup(tail)
      if (resolved !== undefined) return resolved
    }
  }

  // 逐层剥后缀：变体标记（`-ga` / `-preview` / …）与发售日（4–6 位数字）可以
  // 交替出现，因此这里循环而不是一次正则。每剥一段都回头查三种查法——
  // `lookup` 里已含规范化查法，所以 `deepseek_v4_flash-260731` 这类也能命中。
  let candidate = lower
  for (let i = 0; i < 4; i += 1) {
    const next = candidate.replace(/-(?:\d{4,6}|ga|preview|exp|beta|stable|release)$/, '')
    if (next === candidate) break
    candidate = next
    const resolved = lookup(candidate)
    if (resolved !== undefined) return resolved
  }

  // 第四步：部署 / 规格后缀（`-local` / `-flashx` / 快照日 …），**限定同族**。
  // 放在最后是为了不动上面那条久经考验的路径——它是绝大多数命中的来源，
  // 而这一步只负责把「明显是同一个模型、只是标注了跑在哪」的名字捡回来。
  const deployment = stripDeploymentSuffix(lower, lookup)
  if (deployment !== undefined) return deployment

  // 认不出来：**原样返回**。保留用户自己的路由名有两个用处——费用明细里照实
  // 展示（而不是编一个价目表里的名字），以及在「只有调用量」的监看里能认出它。
  return name
}

/**
 * 取价目表条目。
 * @param {string} model - 模型名（可为旧名）。
 * @returns {object} 价目表条目。
 */
export function ratesOf(model) {
  return RATES_VIEW[normalizeModel(model)] ?? FALLBACK_RATES
}

/**
 * 取价目表条目，并说明这价格**是不是真的知道**。
 *
 * 与 {@link ratesOf} 的区别：后者永远返回一个可用价（兜底 Flash），调用方无法分辨
 * 「这是该模型的官方价」还是「猜的」。费用估算里这两者差别很大——把兜底价当真价展示，
 * 就是让用户相信一个错误的数字。
 * @param {string} model - 模型名（可为旧名）。
 * @returns {{rates:object,known:boolean,tiered:boolean,key:string,label:string,vendor:string}} 价目与可信度。
 */
export function pricingOf(model) {
  const key = normalizeModel(model)
  const rates = RATES_VIEW[key]
  if (rates === undefined) {
    return {
      rates: FALLBACK_RATES,
      known: false,
      tiered: false,
      key,
      label: FALLBACK_RATES.label,
      vendor: FALLBACK_RATES.vendor ?? '未知',
      // 兜底价永远是人民币（FALLBACK 是 Flash），因此这里不带外币痕迹。
      currency: 'CNY',
    }
  }
  return {
    rates,
    known: true,
    tiered: rates.tiered === true,
    // 契约（v3）里这一项叫 `tierNote`，而内部一直用 `tiered: true` 表达（闸门按它断言）。
    // 两者都给：内部约定不动，交付形状与契约对齐——界面不必猜该读哪一个。
    ...(rates.tiered === true ? { tierNote: '按最低档' } : {}),
    // 这一份价来自用户补充的价目文件，而不是内置表：界面据此标注，
    // 免得「自定义价」看起来像官方内置口径。
    custom: CUSTOM_KEYS.has(key),
    key,
    label: rates.label,
    vendor: rates.vendor ?? '',
    // 交付给界面的价一律是人民币；`currency` 恒为 CNY，而 `sourceCurrency`
    // 与 `native` 说明它原来是美元、按哪个汇率折过来的（界面据此写「按汇率 X 折算」）。
    currency: 'CNY',
    ...(rates.sourceCurrency === undefined ? {} : {
      sourceCurrency: rates.sourceCurrency,
      fx: rates.fx,
      native: rates.native,
    }),
    asOf: rates.asOf,
    source: rates.source,
  }
}

/**
 * 站点时区 → 已构造好的 formatter。
 *
 * **必须复用，不能每次现造。** `zonedParts()` 落在两条热路径上：导入账本时每条
 * 记录都要判一次高峰/空闲（本机 2400 条记录 ≈ 7000 次调用），而 `periodState()`
 * 找翻转点还要逐分钟扫几千次。实测每次新建 `Intl.DateTimeFormat` 约 51µs、
 * 复用约 2µs（11520 次调用 592ms → 23ms，差 26 倍）。formatter 自身无状态，
 * 按 IANA 名缓存即可，也不改变任何判定结果。
 * @type {Map<string, Intl.DateTimeFormat>}
 */
const ZONED_FORMATTERS = new Map()

/**
 * 取（并缓存）某个时区的 formatter。
 * @param {string} timeZone - IANA 时区名。
 * @returns {Intl.DateTimeFormat} formatter。
 */
function zonedFormatter(timeZone) {
  const cached = ZONED_FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  // 非法时区名在这里抛 RangeError，与「每次现造」时的行为一致：不缓存坏结果，
  // 因此下一次调用仍会抛出同一个错，不会把错误吞成静默降级。
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  ZONED_FORMATTERS.set(timeZone, created)
  return created
}

/**
 * 取站点时区下的“墙钟”字段。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,weekday:number,minuteOfDay:number}}
 */
export function zonedParts(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const bag = {}
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') bag[part.type] = part.value
  }
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(bag.weekday)
  // Intl 在 hour12:false 下可能给出 24 点，归一到 0 点
  const hour = Number(bag.hour) % 24
  const minute = Number(bag.minute)
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute,
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
    minuteOfDay: hour * 60 + minute,
  }
}

/**
 * 已取好的墙钟字段 → `YYYY-MM-DD`。
 *
 * 与 {@link dateKey} 的区别是它**不再格式化一次**：`isPeak()` / `periodState()`
 * 都已经拿到了 `zonedParts()` 的结果，再调一次会把 Intl 的开销翻倍——
 * 这两条都在热路径上（导入账本时每条记录都要判一次时段）。
 * @param {{year:number,month:number,day:number}} p - 墙钟字段。
 * @returns {string} 形如 `2026-10-02`。
 */
function dateKeyOf(p) {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** `YYYY-MM-DD` 日期键（站点时区）。 */
export function dateKey(epochMs, timeZone = DEFAULT_TIMEZONE) {
  return dateKeyOf(zonedParts(epochMs, timeZone))
}

/**
 * 判断某个时刻是否处于高峰时段。
 *
 * 三道闸门，顺序即是排除的顺序：**法定节假日 → 周末 → 高峰窗口**。
 * 前两道任意一道不通过都直接判空闲，因此「国庆期间虽然是周四、白天却在 9:00–12:00
 * 之间」这种情形按空闲计价，与官方一致。
 *
 * 「调休上班的周末」不需要单独一条规则：它本来就是周末，第一道（节假日）之后就被
 * 第二道（星期）挡下了。也正因如此，日历里不需要记录调休上班日——那与官方口径
 * 恰好相反（官方明确说了它们仍按空闲计费）。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {boolean} 高峰为真。
 */
export function isPeak(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(epochMs, timeZone)
  return isPeakOf(p, dateKeyOf(p))
}

/**
 * 已取好的墙钟字段 + 日期键 → 是否高峰。
 *
 * 与 {@link isPeak} 的关系同 {@link dateKeyOf} 与 {@link dateKey}：调用方
 * **已经付过格式化的钱**时走这条，不再格式化一次。
 * @param {{weekday:number,minuteOfDay:number}} p - `zonedParts()` 的结果。
 * @param {string} key - `dateKeyOf(p)` 的结果。
 * @returns {boolean} 高峰为真。
 */
export function isPeakOf(p, key) {
  if (isHoliday(key)) return false
  if (!PEAK_WEEKDAYS.includes(p.weekday)) return false
  return PEAK_WINDOWS.some((w) => p.minuteOfDay >= w.startMinute && p.minuteOfDay < w.endMinute)
}

/**
 * **一次**格式化取出「按发生时刻分档」所需的全部派生量。
 *
 * 这是给逐条记录的热路径用的：聚合一次账本要对每条记录同时知道日期键、高峰判定
 * 和墙钟的时/日，而这三个量全部来自同一个时间戳。分别调 `dateKey()` / `isPeak()` /
 * `zonedParts()` 会把同一次 Intl 格式化重复三遍——实测每次 `formatToParts` 约
 * 2.5–3.5µs，本机 20,007 条记录的账本因此每次聚合白花约 80,000 次调用（≈300ms）。
 *
 * 数值口径与那三个函数**逐字一致**（它们现在都走 `isPeakOf` / `dateKeyOf`），
 * 因此换成这条不会改变任何金额或分档。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {{parts:object,key:string,peak:boolean}} 墙钟字段、日期键、是否高峰。
 */
export function zonedFacts(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const parts = zonedParts(epochMs, timeZone)
  const key = dateKeyOf(parts)
  return { parts, key, peak: isPeakOf(parts, key) }
}

/** 一分钟的毫秒数；也是时段翻转的最小粒度。 */
const STEP_MS = 60_000

/** 一天多少分钟。 */
const MINUTES_PER_DAY = 24 * 60

/**
 * 找翻转点时的前后搜索上限（天）。
 *
 * 这不是「够用就行」的估计：2026 年春节是从 2/13（周五）18:00 一路空闲到 2/24（周二）
 * 9:00，**连续 10 天 15 小时**。旧实现是「8 天以内每分钟扫一遍」，遇到这种长连休会
 * 直接扫不到翻转点、把 `nextChangeMs` 留成 0——界面于是显示「0秒后空闲期」，
 * 而那段空闲其实还有好几天。现在边界按天算，长连休不再有截断风险，
 * 这个上限只剩防御作用：排不出更长空档时返回 0，也就是「说不清就不编一个数字」。
 */
const BOUNDARY_HORIZON_DAYS = 400

/**
 * 某一天没有高峰窗口时的空结果。
 *
 * 复用同一个冻结数组，而不是每天现造一个 `[]`：前后各查几天、每次调用都要问一遍，
 * 而这份倒计时每秒都在重画。
 */
const NO_SPANS = Object.freeze([])

/**
 * 当前时段状态、下一次切换时间，以及**本段已走了多久**。
 *
 * 多返回 `prevChangeMs` / `periodMs` 是为了让界面能画出「本段还剩多少」的环形进度条
 * （侧栏按钮上那枚时段指示灯）：只有 `nextChangeMs` 时，界面知道还剩多久、却不知道
 * 这一段总长，画不出比例。
 *
 * ## 为什么按「天」推，而不是按分钟扫
 *
 * 翻转点只有两种：某天某个高峰窗口的**开始**或**结束**（9:00 / 12:00 / 14:00 / 18:00），
 * 因此它们完全由「这一天有没有高峰窗口」决定。于是：
 *
 *   1) 先算出**今天及前后各天**的窗口表——周末与法定节假日为空（日历在 ./holidays.js）；
 *   2) 再把这些天里所有窗口的起止分钟摊平成一条边界线，取当前时刻左右最近的各一条。
 *
 * 一天最多贡献 4 条边界，而不是每分钟一条；搜索按天推进，因此长连休也不会被任何
 * 扫描上限截断。站点时区的偏移都是整分钟的倍数，所以绝对时刻的分钟边界与墙钟分钟
 * 边界一致，当前分钟里的零头（`intoMinute`）单独补上即可。
 *
 * 返回的 `nextChangeMs + prevChangeMs` 恰好等于本段总长：
 *   例 11:00:30（高峰 9:00–12:00）→ next = 59.5 分、prev = 120.5 分，合计 180 分。
 * 正好站在边界上时 `prevChangeMs` 为 0，于是 `periodMs === nextChangeMs`，仍然正确。
 * @param {number} epochMs - 绝对时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {{peak:boolean,minuteOfDay:number,weekday:number,nextChangeMs:number,prevChangeMs:number,periodMs:number,nextPeak:boolean,label:string,holiday:string,holidayCovered:boolean}}
 */
export function periodState(epochMs, timeZone = DEFAULT_TIMEZONE) {
  const p = zonedParts(epochMs, timeZone)
  // 当天 00:00 的 UTC 序号：只做**纯日历**加减，不受运行机器时区影响。
  const midnightUtc = Date.UTC(p.year, p.month - 1, p.day)
  const todayKey = dateKeyOf(p)
  // 复用刚取到的墙钟字段判时段：再调一次 `isPeak()` 会把 Intl 格式化翻倍，
  // 而这条也在热路径上（侧栏指示灯每次取数都要跑一遍）。
  const peak = isPeakOf(p, todayKey)
  const minuteOfDay = p.minuteOfDay
  // 当前时刻在本分钟里已走的毫秒数：边界都落在整分钟上，补上这段零头才是真实剩余。
  const intoMinute = epochMs % STEP_MS

  /**
   * 相对今天的第 `offset` 天有哪些高峰窗口（没有则给 NO_SPANS）。
   *
   * 星期几直接由当天推：日期在日轴上连续，因此 `(weekday + offset) mod 7` 就是那天的
   * 星期。这样前后查几天都不必再走一次 Intl 格式化——那是这条热路径上最贵的一步。
   * @param {number} offset - 与今天相差的天数（可负）。
   * @returns {readonly {startMinute:number,endMinute:number}[]} 高峰窗口。
   */
  const spansAt = (offset) => {
    const weekday = (((p.weekday + offset) % 7) + 7) % 7
    if (!PEAK_WEEKDAYS.includes(weekday)) return NO_SPANS
    // 今天的键已经算好；其余天用日轴加减得到，避免再格式化一次。
    const key = offset === 0
      ? todayKey
      : new Date(midnightUtc + offset * MINUTES_PER_DAY * STEP_MS).toISOString().slice(0, 10)
    if (isHoliday(key)) return NO_SPANS
    return PEAK_WINDOWS
  }

  // 向前找第一条边界：从今天起逐天看，每天取「窗口 start / 窗口 end」里第一个晚于当前的。
  let next
  for (let offset = 0; offset <= BOUNDARY_HORIZON_DAYS && next === undefined; offset += 1) {
    const spans = spansAt(offset)
    const base = offset * MINUTES_PER_DAY
    for (const w of spans) {
      if (base + w.startMinute > minuteOfDay) { next = base + w.startMinute; break }
      if (base + w.endMinute > minuteOfDay) { next = base + w.endMinute; break }
    }
  }

  // 向后找最近一条边界：逐天往回看，每天**从后一个窗口往前**取第一个不晚于当前的。
  // 同一天内窗口按时间递增且互不重叠，因此「先看 end、再看 start」就是该窗口里离当前
  // 最近的那条；一整天都没有就退到前一天。判据用「不晚于」而不是「早于」，是为了让
  // 正好站在边界上的那一刻把 prev 取成当前分钟（已走 0 秒，见下面 prevMinute）。
  let prev
  for (let offset = 0; offset >= -BOUNDARY_HORIZON_DAYS && prev === undefined; offset -= 1) {
    const spans = spansAt(offset)
    const base = offset * MINUTES_PER_DAY
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      if (base + spans[i].endMinute <= minuteOfDay) { prev = base + spans[i].endMinute; break }
      if (base + spans[i].startMinute <= minuteOfDay) { prev = base + spans[i].startMinute; break }
    }
  }

  // 边界查不到时才退回当前分钟：那是「说不清」，而不是「本段刚开始」。
  const prevMinute = prev ?? minuteOfDay
  const nextChangeMs = next === undefined ? 0 : (next - minuteOfDay) * STEP_MS - intoMinute
  const prevChangeMs = (minuteOfDay - prevMinute) * STEP_MS + intoMinute
  const holiday = holidayNameOf(todayKey)

  return {
    peak,
    minuteOfDay,
    weekday: p.weekday,
    nextChangeMs,
    prevChangeMs,
    periodMs: prevChangeMs + nextChangeMs,
    nextPeak: !peak,
    // 为什么现在是空闲：落在法定节假日里时说清是哪个节（春节 / 国庆节…），否则为空串。
    // 国庆那种「星期几本来是工作日」的假期，光看「空闲时段」四个字解释不了原因。
    holiday,
    // 这一年有没有被日历覆盖。表外年份退回「按周一至周五」判断，界面照实说明，
    // 而不是假装知道——漏判一天只会把高峰按空闲计价，数字有、也不报错。
    holidayCovered: holidayYearCovered(p.year),
    label: peak ? '高峰时段' : '空闲时段',
  }
}

/**
 * 按用量所属时段计费。
 *
 * 口径正确性的关键：历史用量必须按它当时处于高峰还是空闲来计价，
 * 不能把整段用量套同一个折扣。
 *
 * ## 缓存写入（cacheWrite）不能漏，也不能一律按 12.5 × 命中价
 *
 * 早先这里**完全没算 cacheWrite**：长会话里写缓存的那部分成本被静默漏掉，
 * 金额偏小且不报错——正是本项目最忌讳的那类错。补上时用的是 DeepSeek 的口径
 * （写入 = 1.25 × 标准输入价 = 12.5 × 命中价，因为 DeepSeek 命中价恰是输入价的 10%）。
 *
 * 但那个 12.5 倍是 **DeepSeek 的关系，不是通用关系**：Anthropic 的命中价是输入价的
 * 5%（12.5 倍会把写入算成一半），OpenAI 的命中价因型号而异。因此价目条目可以显式
 * 给出 `cacheWrite`（官方「5m writes」/「30m write」那一档），**有就用它**，
 * 没有才退回 DeepSeek 那条 12.5 倍的口径。这条退路只对 DeepSeek 与千问成立
 * （千问官方口径就是「命中 = 输入 10%、写入 = 输入 125%」）。
 *
 * @param {{cacheHit:number,cacheMiss:number,cacheWrite?:number,output:number}} usage - token 数。
 * @param {object} rates - 价目表条目（**人民币**；外币已在视图里折算）。
 * @param {'peak'|'idle'} period - 该笔用量所属时段。
 * @returns {number} 金额（元）。
 */
export function costOf(usage, rates, period) {
  const million = 1_000_000
  const written = Number(usage.cacheWrite ?? 0) / million
  const writeRate = rates.cacheWrite === undefined
    ? rates.cacheHit[period] * 12.5
    : rates.cacheWrite[period]
  return (
    (Number(usage.cacheHit ?? 0) / million) * rates.cacheHit[period]
    + (Number(usage.cacheMiss ?? 0) / million) * rates.cacheMiss[period]
    + written * writeRate
    + (Number(usage.output ?? 0) / million) * rates.output[period]
  )
}

/**
 * 人民币金额格式化：小额保留更多位，避免整天显示 ¥0.00。
 * @param {number} value - 金额。
 * @returns {string} 形如 `¥12.34`。
 */
export function formatCny(value) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount) || amount === 0) return '¥0'
  if (Math.abs(amount) >= 1) return `¥${amount.toFixed(2)}`
  if (Math.abs(amount) >= 0.01) return `¥${amount.toFixed(3)}`
  return `¥${amount.toFixed(4)}`
}
