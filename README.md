# dsh-pixel-dashboard

给 DSH（DeepSeek Harness）Web 界面换上「像素基因 + 现代做工」的皮肤，并加一个用量看板：
马卡龙配色主题、Token 趋势、模型分布、全年活跃日历、**费用估算**、**时段倒计时**、
**官方账户余额**、**第三方订阅套餐额度**，以及输入框正下方的**本次会话费用条**。

按 DSH 官方的插件分发方式做成 **profile 组合包**：安装、卸载、以及随 DSH 升级都走官方机制。

## 安装

插件分两个包，`dsh` 通过组合包把它作为一层配置挂进 profile：

| 包 | 作用 |
|---|---|
| `dsh-pixel-dashboard` | 插件本体：宿主半边 + 浏览器半边 |
| `dsh-pixel-dashboard-bundle` | profile 组合包：声明 `dsh.bundle.patch`，由 dsh 自动加入 `dsh.profile.bundles` |

```bash
# 从 npm 安装（已发布时）
dsh plugin --profile web add dsh-pixel-dashboard-bundle

# 或直接从 GitHub 安装（仓库根就是组合包所在的仓库，见下方说明）
dsh plugin --profile web add github:<user>/dsh-pixel-dashboard

# 从本地源码安装（开发/验证用）
node tools/install-official.mjs --profile web

# 卸载
dsh plugin --profile web remove dsh-pixel-dashboard-bundle
```

`dsh plugin` 会把包交给 pnpm 装到 profile 目录，并把声明了 `dsh.bundle` 的依赖自动加进
`dsh.profile.bundles`；卸载时自动移出，不会残留配置行。

要求：Node ≥ 18（用到全局 `fetch`；DSH 本身的要求更高）。插件**没有任何第三方依赖**。

> **本地路径安装的注意点**：pnpm 对本地目录用 `link:` 规格，而 **`link:` 不解析目标包的
> `dependencies`**，因此组合包声明的插件包不会被装上，patch 里的行会解析失败。
> `tools/install-official.mjs` 会自动把插件包也装一次。从 npm / GitHub 安装则没有这个问题。

安装后**重启一次 `dsh`**（宿主侧代码只在启动时加载），再刷新浏览器页面。

### 换电脑

不需要拷贝 `~/.dsh` 下的任何东西——那是机器本地目录。只需两件事：

1. 把这个仓库拷过去（或 `git clone`）；
2. 在新机器上运行 `node tools/install-official.mjs --profile web`，
   或者已发布后用 `dsh plugin --profile web add dsh-pixel-dashboard-bundle`。

想连用量历史一起带走，额外复制 `usage-ledger.jsonl`（见下）。

## 隐私

这个插件读本机数据、也（可选地）发一个网络请求，因此把边界写清楚：

| 事项 | 行为 |
|---|---|
| API Key | **不出本机。** 只由宿主进程从 DSH 的 credentials 服务解析，用于拼一个 `Authorization` 头；响应里只回报金额、币种与来源层名（如 `file`），**从不回报 Key 本身**。 |
| 浏览器端 | 永远拿不到 Key，也拿不到带 Key 的 URL。 |
| 余额请求 | 只发往 settings 里显式配置的 `baseURL`，否则发往官方 `https://api.deepseek.com`。**刻意不读 `DEEPSEEK_BASE_URL` 环境变量**——端点决定 Key 发给谁，不能被环境变量改道（DSH 自己也只从可信层读它）。 |
| 套餐请求 | 只发往写死的官方域名（`open.bigmodel.cn` / `api.commandcode.ai`），同样不接受任何改写。第三方 Key 也只在宿主进程内使用。 |
| 自动发现 | Command Code 可自动读 `~/.commandcode/auth.json`（另一个 App 的密钥文件）；只读、读失败即当作未配置。不配置就完全不会读。 |
| 开关 | 看板上可一键关闭（余额与套餐各自独立）；关掉后宿主**一个请求都不发**。`DSH_PIXEL_BALANCE=0` / `DSH_PIXEL_PLANS=0` 是更硬的一层关闭（CI / 别人的机器上适用）。 |
| 统计 | 只读本机会话日志与 `$DSH_HOME` 下的账本，不向任何第三方发送。 |
| 落盘 | 只写两份本机文件：用量账本 `usage-ledger.jsonl` 与开关 `balance-prefs.json`，都在 `$DSH_HOME/plugins/dsh-pixel-dashboard/`。 |

无遥测、无自动上报、无外部依赖（只用 Node 内建模块）。

## 口径以官方为准

单价与时段取自 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
（**北京时间**）：

| 模型 | 输入（缓存命中） | 输入（缓存未命中） | 输出 |
|---|---|---|---|
| `deepseek-flash` | 空闲 0.02 / 高峰 0.04 | 空闲 1 / 高峰 2 | 空闲 4 / 高峰 8 |
| `deepseek-v4-pro` | 空闲 0.15 / 高峰 0.30 | 空闲 4.5 / 高峰 9 | 空闲 13.5 / 高峰 27 |

单位：元 / 百万 token。**高峰时段 = 周一至周五 9:00–12:00、14:00–18:00；
其余时间（含全部周末）都是空闲时段，空闲价 = 高峰价的一半。**

两个由此而来的实现决定：

- **按每条请求发生时刻分档。** 宿主导入会话日志时逐条判定该请求处于高峰还是空闲，
  费用是 `Σ(高峰用量 × 高峰价) + Σ(空闲用量 × 空闲价)`，而不是给整段用量套一个折扣。
- **旧模型名折叠到现行模型。** `deepseek-chat`、`deepseek-reasoner`、`deepseek-v4-flash`
  等旧名仍可调用但按 Flash 计费，因此统一归一到 `deepseek-flash`。

## 装了什么

| 部分 | 说明 |
|---|---|
| 视觉系统 | 奶油底 + 马卡龙色板，细腻圆角、柔和分层、统一缓动（140–320ms） |
| 字体 | **不替换产品字体**，只用正常系统字体 + `tabular-nums`；刻意不引入点阵/像素字体 |
| 配色默认生效 | 以令牌覆盖层叠在当前主题上，装完即见效，**不需要**去设置里切主题 |
| 两套可选主题 | 「奶油·昼」「暮色·夜」也注册进 **设置 → 外观**，想固定深/浅色的人可以显式选 |
| 用量看板 | 侧栏底部柱状图图标 → 主区整页看板 |
| 活跃日历 | 一年视图，**一格一天**（方形），悬停显示当天请求数 / 会话数 / token |
| 会话费用条 | 输入框**正下方**常驻一行，显示**本次会话**已花金额与 token 数 |
| 账户余额 | 看板「账户余额」卡片 + 费用条旁一枚，显示官方账户可用 / 充值 / 赠送余额（多币种），带一键开关 |
| 套餐额度 | 看板「订阅套餐额度」卡片，按厂商分块、按窗口（5 小时 / 每周 / 每月）画进度条与重置倒计时；费用条旁显示**最紧**的那个窗口。目前支持智谱 GLM Coding Plan 与 Command Code |
| 计费口径 | 见下「其他模型的费用计算」：DeepSeek 分时双档，智谱 GLM 不分时，单位统一人民币 |
| 费用估算 | 高峰/空闲分别计价，逐模型明细，并给出「若全走空闲可省多少」 |
| 时段倒计时 | 实时倒数到下一次时段切换（含跨周末到周一 9:00） |

## 用量记录（本机账本）

统计口径来自一份**本机账本** `lib/ledger.js`，默认位于：

```
$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl
```

每次模型请求一条 JSONL 记录（会话 id、seq、发生时刻、模型、分项 token）。之所以不直接读
会话日志：

- 会话日志是压缩的多帧文件，解析成本高；账本是一份小文件，看板只读它；
- 记录按 `sessionId:seq` 去重，**重复扫描不会让历史翻倍**——重装、换机、重复导入都安全。

`DSH_PIXEL_LEDGER` 可以覆盖这个路径（想放到别处时用）。

余额查询的开关存在同一目录的 `balance-prefs.json`（可用 `DSH_PIXEL_BALANCE_PREFS` 覆盖）。
它不是历史数据，换机时不必带走——不带就走默认值「开启」。

## 目录

```
src/                    源码（改这里）
  host.js               宿主半边：抽账本、按时段聚合、注册只读路由
  pricing.js            时段判定、价目表、费用折算（纯函数）
  ledger.js             本机用量账本
  balance.js            官方账户余额查询（宿主侧；Key 只在这里出现）
  plans.js              第三方套餐额度（宿主侧；智谱 / Command Code）
  prefs.js              本机开关存储（余额与套餐共用，避免互相覆盖）
  client/               浏览器半边源码
    balance.js          余额取数与格式化（浏览器侧；永远看不到 Key）
    plans.js            套餐额度取数、进度与格式化（浏览器侧）
    SessionCost.js      输入框正下方的费用条 + 余额 + 套餐额度
    dashboard.js        看板整页
packages/plugin/        发布的插件包（lib/ 是构建产物）
packages/bundle/        发布的 profile 组合包（cordis.patch.yml）
tools/                  构建、校验、安装、体检脚本
```

## 账户余额

看板里的「账户余额」卡片，以及输入框正下方费用条旁的一枚余额，都来自官方
[`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance)。

| 事项 | 说明 |
|---|---|
| 查询哪个账户 | 只查 **DSH 自己给官方 provider 用的那把 Key** 对应的账户（凭据引用默认 `DEEPSEEK_API_KEY`，可在 `llm-deepseek` 设置段里改）。暂不支持查询任意账户。 |
| 端点 | settings 段里显式配置的 `baseURL`，否则官方公网地址。 |
| 币种 | 接口返回几种就显示几种（可能同时有 CNY 与 USD），**不做汇率换算**。 |
| 刷新 | 宿主侧缓存 60 秒；看板上点「刷新」会强制重取。 |
| 拿不到时 | 明确显示原因（没配 Key / 请求失败 / 已关闭），**不会**显示成 `¥0`——把「不知道」显示成 0 会让人以为余额真的空了。 |
| 关闭 | 看板卡片里的开关；关掉后宿主不再发请求。`DSH_PIXEL_BALANCE=0` 可硬性关闭。 |

余额为负数（例如 `-¥0.79`）是官方接口真实会返回的状态，表示已欠费，界面照实显示。

## 订阅套餐额度

看板里的「订阅套餐额度」卡片监控第三方 Coding Plan 的剩余额度，按窗口画进度条。

| 厂商 | 窗口 | 备注 |
|---|---|---|
| 智谱 GLM Coding Plan | 5 小时、每周 | 官方**没有**月度额度（文档只定义这两个窗口），卡片里会写明 |
| Command Code | 5 小时、每周、每月 | 月度额度是美元信用额（如 `$70`） |

### 请先读这一段：这些接口是未文档化的

**两家都没有公开文档化的额度 API。** 本插件用的是它们**前端自己在用**的内部接口：

| 厂商 | 接口 | 鉴权 |
|---|---|---|
| 智谱 | `GET open.bigmodel.cn/api/monitor/usage/quota/limit` | **裸 Key，不加 `Bearer `** |
| Command Code | `GET api.commandcode.ai/alpha/billing/credits` | `Authorization: Bearer <key>` |

由此带来三条**必须知情**的后果：

1. **可能随时失效。** 官方一改前端，这里就会取不到。因此全程 fail-soft：一家失败只标
   那一家，另一家与看板其余部分照常工作，界面上明确写「未文档化的内部接口」。
2. **智谱的失败不走 HTTP 状态码。** 它鉴权失败时 HTTP **仍是 200**，得看响应体里的
   `success` 字段——只看状态码会把失败当成成功。
3. **智谱的窗口分类看 `unit` 字段，不能按重置时间猜。** 周期末尾「每周」会比「5 小时」
   更早重置，按时间排序必然把两个窗口标反（这是社区踩过的坑，代码里已按 `unit`
   区分并写了注释）。

### 凭据怎么配

| 厂商 | 显式配置（推荐） | 自动发现 |
|---|---|---|
| 智谱 | 凭据引用 `ZHIPU_CODING_API_KEY` | —（智谱没有官方 CLI 凭据文件） |
| Command Code | 凭据引用 `COMMAND_CODE_API_KEY` | `~/.commandcode/auth.json` 的 `apiKey` |

写进 DSH 凭据库即可（环境变量同名亦可）。Command Code 若已装 CLI 并登录过，插件会
自动读该文件，**无需**额外配置；`COMMANDCODE_HOME` 可覆盖它的目录。

> **智谱的 Key 必须是「编程套餐专属」的那一把**——在「个人编程套餐」里新建，
> 与平台普通 API Key **不通用**。用错的表现是：标准模型调用能过，但额度查询报
> `Authentication Failed`。界面上会显示凭据尾 4 位（如 `…a1b2`），便于你确认读到的
> 是哪一把。

### 隐私

- **Key 只在宿主进程内使用**，绝不写进响应、日志或落盘。浏览器端只收到额度数字、
  来源标记（`credentials` / `env` / `cli-file`）与**打码后的尾段**——尾段只够让你辨认
  用的是哪把 Key，不足以还原密钥。
- **端点写死在官方域名**，不接受任何环境变量或配置改写（与余额同理：端点决定 Key 发给谁）。
- **可一键关闭。** 关掉后宿主不再向任何第三方端点发请求。`DSH_PIXEL_PLANS=0` 可硬性关闭
  （适用于 CI / 别人的机器）。
- 读 `~/.commandcode/auth.json` 属于读**另一个 App 的密钥文件**，因此只读不写、读失败
  一律安静当作「没配」。

### 关于「其他模型的费用计算」

费用明细表覆盖 **DeepSeek 与智谱 GLM**，单位统一为**人民币 / 百万 token**：

| 模型 | 输入（缓存未命中） | 输出 | 缓存命中 | 计费方式 |
|---|---|---|---|---|
| `deepseek-flash` | 空闲 1 / 高峰 2 | 空闲 4 / 高峰 8 | 空闲 0.02 / 高峰 0.04 | 分时（高峰 = 周一至周五 9:00–12:00、14:00–18:00） |
| `deepseek-v4-pro` | 空闲 4.5 / 高峰 9 | 空闲 13.5 / 高峰 27 | 空闲 0.15 / 高峰 0.30 | 分时 |
| `glm-5.3` | 8 | 28 | 2 | 不分时 |
| `glm-5.3-flash` | 0.8 | 2.8 | 0.23 | 不分时 |
| `glm-5.2` | 8 | 28 | 2 | 不分时 |
| `glm-4.6v` | 1（最低档） | 3（最低档） | 0.2 | 不分时，官方按输入长度分档 |

来源：[DeepSeek 定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、
[智谱定价页](https://docs.bigmodel.cn/cn/guide/start/pricing)。

口径上有三个刻意的处理，都是为了**不把估算说成事实**：

1. **不分时的厂商只显示一列 token、一个单价。** 智谱高峰与空闲同价，硬摆一对相同的
   「空闲 / 高峰」数字纯属噪音，还会让人以为有折扣。
2. **价目表里没有的模型会标「估算价」。** 它们暂按 Flash 单价计，界面上明确写出来——
   静默兜底会让一个猜出来的数字看起来像官方价。
3. **分档定价的模型标「按最低档」。** 如 GLM-4.6V 官方按输入长度分档，账本里没有可靠的
   逐请求输入长度，因此只按最低档估算并注明。

**没有做跨厂商的额度→金额换算。** 订阅套餐的额度单位互不相通（智谱是积分、Command Code
是美元信用额），换算需要引入汇率与并不权威的假设，算出来的数字会比没有数字更误导。
因此套餐额度只**照实显示各家自己的口径**（见上），费用估算则只覆盖按量计费。

## 常用命令

```bash
node tools/verify.mjs              # 构建 + 全套闸门（改完代码先跑这个）
node tools/install-official.mjs --profile web    # 按官方方式装到本机 profile
node tools/doctor.mjs --profile web              # 体检：装好没、跑的哪个版本、账本在哪
node tools/uninstall.mjs           # 清理早期「整机部署」方式的残留
```

`node tools/verify.mjs` 依次跑：构建 → 时段/价目/账本逻辑（36 项）→ 补丁层清理与校验（13 项）
→ 宿主预检 + 非空数据 + 余额隐私与开关 + 套餐解析 → 客户端渲染闸门。
其中三条与隐私/排版/口径直接相关，改动时不要绕过：

- **余额隐私闸门**（`tools/preflight.mjs`）种一个假 API Key，断言它的值一个字节都没出现在
  响应里、Key 只经 `Authorization` 头发出、且 `DEEPSEEK_BASE_URL` 不能把端点改道。
- **套餐解析闸门**（`tools/preflight.mjs`）用假响应验：智谱按 `unit` 而非重置时间归类窗口、
  鉴权失败（HTTP 200 + `success:false`）被识别、Command Code 三窗口与裸数字月度、
  「缺失不显示成 0」、以及**两个开关互不覆盖**的交叉回归。
- **费用条排版闸门**（`tools/render-check.mjs`）断言注册到 `conversation.composer.dock`
  的 `order` 是负数，并断言拿不到余额/额度时不渲染空的那些枚。

## 发布到 npm / GitHub

两个包分别发布，**先发插件包，再发组合包**（组合包依赖插件包的版本号）：

```bash
node tools/build.mjs
npm publish ./packages/plugin      # dsh-pixel-dashboard
npm publish ./packages/bundle      # dsh-pixel-dashboard-bundle
```

`tools/build.mjs` 会把仓库根的 `LICENSE` 拷进两个包（`package.json` 的 `files` 里都声明了它，
少了这份文件 npm 只是静默跳过，不会报错）。

组合包里的 `dependencies: { "dsh-pixel-dashboard": "^2.0.0" }` 必须与插件包实际发布的版本
匹配，否则安装时拉不到。升级时两边版本一起改。

GitHub 直装不需要发布：`dsh plugin --profile web add github:<user>/dsh-pixel-dashboard`，
但需要 pnpm 允许该仓库的构建脚本（组合包不需要构建，插件包的 `lib/` 已随仓库提交）。

> 仓库里的 `packages/plugin/lib/` 是**构建产物但必须入库**：GitHub 直装不会跑构建，
> 而 DSH 加载的正是 `lib/client.js`。发布前确认它是最新的（`node tools/build.mjs`）。

> 发布前确认 `packages/plugin/lib/` 是最新的（`node tools/build.mjs`），
> 它是构建产物，但必须随包一起发布——DSH 加载的是 `lib/client.js`，不是源码。

## 必须守住的设计约束

都是踩过坑换来的，改动前请先读完：

- **组合包的 patch 用包名，不用路径。** `name: 'dsh-pixel-dashboard'` 由 profile 的
  `node_modules` 解析，因此换机、升级、pnpm 重新布局都不影响；写死路径会在别的机器上失效。
- **一条插件行只能有一个来源。** 组合包和手写 loader 行同时存在会重复注册
  `/dsh-pixel/data`，路由冲突 → Loader 整体回滚 → 旧代码继续应答，而且**没有任何报错**。
  二选一。
- **实现版本由源码哈希自动派生。** 入口用 `await import('./host.js?v=<hash>')`，
  于是改完实现重新构建即可热更新；哈希自动算，不存在「忘了加版本号」这种失败模式。
- **写配置层前必须过 YAML 校验。** 配置层写坏会重挂整棵插件树，浏览器端却只表现为
  `client api: session/prompt failed: Failed to fetch (gateway/internal)`，看起来像网络问题。
- **`conversation.composer.dock` 里的 `order` 必须是负数。** 该槽位按 `order`
  **升序**渲染，而产品自带的统计条（`StatsPills`，显示耗时与 token 用量）注册在
  `order: 0`。用正值（曾用 `10`）会被排到产品统计条**下面**，离输入框更远——而费用条
  想表达的正是「贴着本次会话」。另一个理由：产品统计条在没有 token 活动时**整体不渲染**，
  排在它后面会让本插件那一行上下跳动。渲染闸门会断言这个 `order < 0`。
- **费用条的容器是「纵向 flex + `align-items: center`，且没有 `gap`」。**
  因此这一行必须自己写 `width: 100%` 撑满、并自带上边距，否则会收缩居中并贴住输入框。
  宽度与内边距对齐产品统计条（`max-width: var(--dsh-chat-content-width)`、
  `padding: 4px calc(var(--dsh-composer-side-clearance) + 16px) 0`），左右边界才与输入框齐平。
  同理，没有内容时要 `return null` 而不是渲染空 `div`，否则会污染产品的 4px 间距节奏。
- **图表不要用 `preserveAspectRatio="none"`**，热力图格子必须是正方形：配固定像素高度会把
  几何非等比拉伸；把 24 小时塞进同一格只会画出条形。渲染闸门会直接量 SVG 矩形的宽高差。
- **不要把「兼容性」做成取数的前置闸门。** 版本哈希或能力名对不上并不等于数据不可用，
  拦在取数层会让整块界面失去数据，症状是「一直加载中」这种最难查的形态。
  让数据先到手，各界面按字段有无自行降级，并且降级必须可见。
- **API Key 只能在宿主进程里出现，且端点不能被环境变量改道。** 余额查询用 DSH 自己那把
  Key，响应里只回报金额 / 币种 / 来源层名。**刻意不读 `DEEPSEEK_BASE_URL`**：端点决定
  Key 发给谁，而进程环境不是可信来源（DSH 自己也只从可信的 launch-environment 层读它）。
  预检闸门会种一个假 Key，断言它的值一个字节都没出现在响应里——比搜字段名可靠。
- **拿不到余额时不要显示成 0。** 「读不懂」与「真的是 0」是两件事，把前者显示成
  `¥0` 会让人以为余额空了。缺失一律显示 `—`，并给出可读的原因。注意
  `Number(null)` 与 `Number('')` 都等于 `0`，接口字段缺失时会踩这个坑，必须显式挡掉
  （预检闸门里有对应断言）。
- **第三方额度接口是未文档化的，必须按「随时会坏」来写。** 一律 fail-soft：一家失败只标
  那一家；界面上明说数据源是内部接口。两个具体坑：智谱鉴权失败时 **HTTP 仍是 200**，只看
  状态码会把失败当成功；窗口分类必须看它给的 `unit` 字段，按重置时间排序会把「每周」与
  「5 小时」标反。
- **额度百分比可以超过 100，不要夹到 100。** 套餐额度用超时官方会给出 >100 的百分比，
  而「超了多少」正是最该让用户看见的信息。宿主保留真值，只在**进度条宽度**上夹取
  （`barPercent`），并单独标出「已超限」。夹数字会把「已严重超限」伪装成「刚好用满」。
- **多个功能的开关必须共用一个存储且写入串行。** 余额与套餐各写各的同一份 JSON 会互相
  覆盖（读—改—写竞态）：用户关掉套餐，结果余额也被关掉。预检闸门里有这条交叉回归断言。
- **不要为了「统一」而把不同厂商的额度换算成金额。** 智谱是积分、Command Code 是美元信用额，
  单位互不相通；引入汇率与换算假设会得到一个比没有数字更误导的结果。各家照实显示各自的
  口径，不做跨厂商汇总。
- **「空闲价 = 高峰价的一半」是 DeepSeek 的分时规则，不是通用规则。** 智谱等按量定价不分时
  （peak === idle）。价目表用 `flat: true` 标明这一点，渲染闸门会断言 flat 条目的两档相等，
  而「半价关系」只对非 flat 条目断言——否则加一个厂商就会踩坏旧断言。
- **模型名折叠要覆盖 DSH 实际在用的名字。** 本机账本里有近 2000 条 `deepseek-v4.1-flash`，
  它并不等于价目表里的 `deepseek-flash`；不折叠就会走兜底：金额虽然一样，但会被标成
  「估算价」并多出一行按原始名展示的模型，看起来像另一个模型。

另外两点容易踩的：

- **必须声明 `inject: ['webServer']`。** 实测 `apply` 执行时 `webServer` 可能还没发布，
  自行判空后 `return` 会让整行静默不激活（路由 404 且无报错）。
- **`ctx.webServer` 与 `ctx.get('webServer')` 不等价。** 前者是受注入约束的属性代理，
  没声明 `inject` 时读它会被 Guard 拒绝；后者才是无副作用的可选读取。

## 随 DSH 升级

插件只依赖两样东西：Node 内建模块（含全局 `fetch`），以及宿主侧的服务名
（`sessionPersistence`、`sessions`、`webServer`，以及可选读取的 `credentials`、`settings`）
与客户端槽位（`main`、`sidebar.panellist`、`conversation.composer.dock`）。
所有可选服务都通过 `ctx.get()` 惰性读取并处理缺失；槽位通过 `slots.inject()` 注册，
槽位不存在时不会报错。

具体到余额这一块，**每一层缺失都有明确降级**，不会让整块界面失效：

| 缺失的东西 | 表现 |
|---|---|
| 没有 `credentials` 服务 | 退回读进程环境里的 `DEEPSEEK_API_KEY` 等引用；Command Code 还会退回读本机 CLI 凭据文件 |
| 没有 `settings` 服务 / 没有 `llm-deepseek` 段 | 用官方默认引用与官方公网端点 |
| 没配 Key | 明确显示「没有找到 XXX_API_KEY」，其余部分照常工作 |
| 官方/第三方接口失败 | 显示具体原因（如 `HTTP 401` / 请求超时 / 鉴权失败） |
| 第三方内部接口变更 | 那一家标成不可用，另一家与看板其余部分照常 |
| 宿主是旧版本（没有余额/套餐路由） | 对应那一枚不渲染，看板其余部分照常 |

因此 DSH 升级后：重新启动即加载新版本；若某个服务或槽位改名，用
`node tools/doctor.mjs --profile <profile>` 能立刻看出哪一项失效。

## 回滚

```bash
dsh plugin --profile web remove dsh-pixel-dashboard-bundle
# 然后重启 dsh、刷新页面
```
