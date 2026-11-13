# 账户余额与第三方套餐

看板上有**两块**，因为它们回答的是两笔完全不同的账：

| 位置 | 内容 | 为什么分开 |
|---|---|---|
| **顶行第五格**（用户卡） | DeepSeek 官方**现金余额**：头像 + 金额 + 官网入口 | 按量扣钱，一眼要看到 |
| **「套餐余额」板块** | 第三方**订阅额度**，每家一张卡 | 订阅额度，单位互不相通、不做换算 |

## 一、顶行的用户卡（现金余额）

- 头像：登录官方账号时是品牌蓝鲸；**未登录时是灰度占位鲸鱼**，并写明缺哪个凭据引用名。
- **未登录就不查**：拿不到官方凭据时**一次网络请求都不发**，界面也不会显示 `¥0`
  （把「不知道」显示成「余额为 0」是最容易误导人的一种谎）。
- 右上角永远有一个**官网入口**（用量 / 充值），不依赖凭据。

## 二、「套餐余额」板块

**每家已配置的厂商一张卡**（响应式网格，窄屏单列）：

- 左侧**环形条**显示总余额（对只给百分比的厂商用「剩余百分比」，取最紧的那个窗口）；
- 右侧每个窗口一行：`5 小时` / `每周` / `每月` / `预算`，细进度条 + `已用 61.8%` +
  `11/15 16:00 重置（2 天 0 小时后）`；
- 卡底 **「凭据与开关」默认收起**：凭据怎么配（引用名、文件绝对路径、可自动发现的文件）、
  移除凭据（勾选 + 二次确认）、以及这一家的查询开关。

**没配过凭据的厂商不占版面**，收在底部的 **「添加厂商」** 里——点开能看到每一家的用途与
配法，**不是删掉**，插件支持哪些家始终查得到。

> 「当前监看」的那一家永远在最上面（带徽标）。点了它却在下面找不到，是最让人困惑的一种界面。

---

## 一、现金余额：只有 DeepSeek 官方

| 事项 | 说明 |
|---|---|
| 查询哪个账户 | 只查 **DSH 自己给官方 provider 用的那把 Key** 对应的账户（凭据引用默认 `DEEPSEEK_API_KEY`，可在 `llm-deepseek` 设置段里改）。暂不支持查询任意账户。 |
| 端点 | settings 段里显式配置的 `baseURL`，否则官方公网地址。**刻意不读 `DEEPSEEK_BASE_URL`**：端点决定 Key 发给谁，而进程环境不是可信来源。 |
| 币种 | 接口返回几种就显示几种（可能同时有 CNY 与 USD），**不做汇率换算**。 |
| 刷新 | 缓存 60 秒；看板上点「刷新」会强制重取。 |
| 拿不到时 | 明确显示原因（没配 Key / 请求失败 / 已关闭），**不会**显示成 `¥0`。 |
| 关闭 | 卡片里的开关；关掉后不再发请求。`DSH_PIXEL_BALANCE=0` 可硬性关闭。 |

余额为负数（例如 `-¥0.79`）是官方接口真实会返回的状态，表示已欠费，界面照实显示。

> **为什么别的厂商没有「现金余额」？** 因为那些钱不在插件能查的地方：第三方是**订阅
> 买断制**，本来就没有一个「按量计费的余额」可查。没有套餐哪来的余额——所以第三方的
> 额度只看**套餐窗口**，不做「通用余额查询」。

---

## 二、六家套餐：各自的形状不一样，**不做换算**

| 厂商 | 窗口 | 数据形状 | 凭据 | 自动发现 |
|---|---|---|---|---|
| 智谱 GLM Coding Plan | 5 小时、每周 | 官方只给百分比 | `ZHIPU_CODING_API_KEY` | —（智谱没有官方 CLI 凭据文件） |
| Command Code | 5 小时、每周、每月 | 5h/周给绝对值；月度只有剩余额 | `COMMAND_CODE_API_KEY` | `~/.commandcode/auth.json` 的 `apiKey` |
| 火山方舟 Agent / Coding Plan | 5 小时、每周、每月 | Agent Plan 绝对值；Coding Plan 百分比 | `VOLC_ACCESS_KEY_ID` + `VOLC_SECRET_ACCESS_KEY` | —（两把都要配） |
| Codex（ChatGPT 套餐） | 主 / 次两个滚动窗口（实测 1 小时与 5 小时都出现过） | 官方只给百分比 | `CODEX_ACCESS_TOKEN` + `CODEX_ACCOUNT_ID` | `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`） |
| Cursor | 一个计费周期 | 官方只给百分比 | `CURSOR_ACCESS_TOKEN` | `~/.cursor/auth.json`、`%APPDATA%\Cursor\auth.json` |
| Opencode | Go：rolling / 每周 / 每月；外加 Console 预算 | 套餐百分比 + 预算金额（美元） | `OPENCODE_API_KEY` + `OPENCODE_WORKSPACE_ID` | `$XDG_DATA_HOME/opencode/auth.json` |

**不同厂商的单位互不相通**（积分 / 美元 / 百分比），因此插件**不做跨厂商汇总，也不把
额度换算成金额**。引入汇率与换算假设会得到一个比没有数字更误导的结果。每一家的卡片上
都有一条「口径」说明，写清这一家给的是什么形状。

### 「—」是什么，以及为什么有些百分比永远显示不出来

| 界面上的样子 | 含义 |
|---|---|
| `—`（数字位） | **不知道**。官方没给这个字段，或这次没读懂。**绝不当成 0**。 |
| 没有进度条 | 百分比未知。画一条 0% 的空条看起来像「一点没用」，而事实是不知道。 |
| `已超限` 徽标 + 大于 100% 的数字 | 额度用超了。真值照实显示（例如 140%），只有进度条宽度夹到 100%。把 140% 显示成 100% 等于把「严重超限」伪装成「刚好用满」。 |
| 脚注「官方只报了余额，没有已用额度」 | 官方只给剩余额，没有「已用 / 上限」，因此算不出百分比。 |

### 重置时刻

每个窗口都会标出**绝对日期 + 剩余时间**，形如 `10/14 20:26 重置（23 天 9 小时后）`——
绝对日期按站点时区渲染。月额度这种长周期，光有「还剩 23 天」还得自己算日子，所以两个都给。
拿不到时刻时那一句**不显示**，不会编一个日期出来。

### Command Code 的月度是怎么算出来的

它的额度接口对 5 小时与每周都同时给了「已用」和「上限」，所以百分比直接算得出来；
**月度却只给一个剩余余额**（如 `$65.55`），既没有已用、也没有总额。它需要另外两个接口拼起来：

| 接口 | 给什么 |
|---|---|
| `GET /alpha/billing/credits` | 5 小时 / 每周的 `used` + `cap`，以及月度的**剩余**信用额 |
| `GET /alpha/usage/summary` | **本计费周期已用**信用额（`totalMonthlyCredits`） |
| `GET /alpha/billing/subscriptions` | **套餐身份**（`planId`）与计费周期（`currentPeriodEnd`） |

月度百分比 = 已用 ÷（已用 + 剩余）。三条规则，都是为了让界面不撒谎：

- **拿不到「已用」就按名义额度反推**，并在卡片上标注这是推算；
- **两个接口的数对不上名义额度时，一个百分比都不给**——跨计费周期或中途换套餐时，
  「已用 + 剩余」可能来自不同周期，相加看着合理却差着几十个百分点。这一栏只显示 `—` 与原因；
- **未收录的套餐不做推算**：没有名义额度这把尺子，就只用「已用 + 剩余」。

已收录的档位与名义月额度（2026-09 取值，只按**完整 `planId` 精确匹配**，绝不前缀匹配——
老一代 `individual-pro` 是 `$30`、现在的 `individual-pro-v1` 是 `$80`）：

| planId | 套餐 | 月额度 | 5 小时 | 每周 |
|---|---|---|---|---|
| `individual-go` | Go | `$10` | `$3` | `$6` |
| `individual-goat` | GOAT | `$70` | `$14` | `$35` |
| `individual-pro-v1` | Pro | `$80` | `$16` | `$40` |
| `individual-max` | Max 10× | `$150` | `$45` | `$90` |
| `individual-ultra` | Max 20× | `$300` | `$90` | `$180` |
| `teams-pro` | Team Pro | `$40` | `$12` | `$24` |

---

## 三、三家的接口出处（可自己核对）

这一节是「凭什么相信这个数字」的答案。**每一家都是未文档化的内部接口**，插件用的是它们
前端 / CLI 自己在调的那一个，因此可能随时失效。

### Codex（**有一方来源**：官方开源代码）

- 端点：`GET https://chatgpt.com/backend-api/wham/usage`
- 鉴权：`Authorization: Bearer <access token>` + 请求头 `chatgpt-account-id: <账号 id>`
- 形状：`rate_limit.primary_window` / `secondary_window` 各给
  `{ used_percent, limit_window_seconds, reset_at }`，**只有百分比**，`reset_at` 是**秒**
- 出处：[`codex-rs/backend-client/src/client/rate_limit_resets.rs`](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)
  的 `rate_limit_status_url()`；鉴权头见同目录 `client.rs` 与
  [`codex-rs/http-client/src/openai_headers.rs`](https://github.com/openai/codex/blob/main/codex-rs/http-client/src/openai_headers.rs)
- 凭据文件：`$CODEX_HOME/auth.json`，取 `tokens.access_token` 与 `tokens.account_id`
  （见 [`codex-rs/login/src/auth/storage.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)）
- **窗口身份按 `limit_window_seconds` 判**，不按 primary/secondary 的位置猜：上游出现过
  3600 秒与 18000 秒两种主窗口。认不出的长度会照实显示长度本身（如「每小时」），
  不塞进某个已知窗口

> 这里的 token 是 **ChatGPT 登录态**（JWT），**不是 `sk-` 开头的平台 API Key**。
> 拿平台 Key 打这个端点只会 401。缺账号 id 时插件**不发请求**，直接说清缺什么。

### Opencode（**有一方来源**：官方开源代码）

- Go 套餐：`GET https://opencode.ai/zen/go/v1/usage`，
  头 `Authorization: Bearer <key>` + `x-opencode-org-id: <workspace id>`；
  形状 `{ usage: { rolling | weekly | monthly: { status, percent, resetsAt } } }`，**只有百分比**；
  `status: "rate-limited"` 表示已被拒绝（标「已超限」），`403` 表示该 workspace 没订 Go
- Console 预算：`GET https://opencode.ai/console/api/policies/current-budgets`，
  头 `Authorization: Bearer <key>` + `x-org-id: <workspace id>`；
  形状是一个数组，每项 `{ ruleID, limitDollars, spentDollars, coverage, scope, resetsAt }`，
  **绝对值（美元）**；`403` 表示服务账号 Key（本来就没有预算）
- 出处：[`packages/core/src/usage-limits.ts`](https://github.com/sst/opencode/blob/dev/packages/core/src/usage-limits.ts)
  的 `readGo()` / `readBudgets()`；Console 地址与请求头见
  [`packages/core/src/console-access.ts`](https://github.com/sst/opencode/blob/dev/packages/core/src/console-access.ts)
- 凭据文件：`$XDG_DATA_HOME/opencode/auth.json`（默认 `~/.local/share/opencode/auth.json`）
  里 `opencode` 那一条的 `key` / `access` 与 `metadata.orgID`
- **两个接口都要 workspace id**，缺了只能回报「缺 workspace id」——现编一个只会得到 403

### Cursor（**只有社区核验，没有一方来源**）

- 端点：`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- 鉴权：`Authorization: Bearer <access token>` + `connect-protocol-version: 1`，body 是 `{}`
- 形状：`planUsage.totalPercentUsed`（本计费周期已用百分比）、`billingCycleEnd`（**毫秒**）、
  `spendLimitUsage.individualUsed` / `individualLimit`（按需付费上限）
- 凭据文件：`~/.cursor/auth.json`、`%APPDATA%\Cursor\auth.json` 的 `accessToken`（短时 JWT）

**为什么它的核验级别不同：** Cursor 的客户端与 CLI **不开源**，官方文档只公开了团队 / 企业的
Admin API（那是团队聚合用量，不是个人套餐额度）。这个端点是两个**互相独立**的开源实现
逆向出来的，两者给出的地址、鉴权头与字段一致：

1. [`rarf/hermes-quota-plugin` 的 `cursor.py`](https://github.com/rarf/hermes-quota-plugin/blob/master/quota_providers/cursor.py)
2. [`PowerUserZ/OpenTokenUsage` 的 `docs/providers/cursor.md`](https://github.com/PowerUserZ/OpenTokenUsage/blob/main/docs/providers/cursor.md)

因此 Cursor 那一页会明确写「端点未核验到一方来源（社区逆向实现），随时可能失效」。
**不含糊其辞**：这类差距必须让用户看得见，才能自己决定要不要依赖它。

> 桌面端的登录态只存在 SQLite（`state.vscdb`）里，插件**不读它**：读 SQLite 要么引第三方
> 依赖、要么自己写二进制解析器，两者都不划算（本项目零依赖）。所以只支持 CLI 的 `auth.json`
> 与显式配置。

---

## 四、凭据怎么配

拿到的值有**两种**写法，任选其一（同名即通用）：

**写法一：写进 DSH 凭据文件**（推荐）

文件是 `<DSH_HOME>/.credentials.yaml`（`DSH_HOME` 默认 `~/.dsh`），在 `refs:` 段下按名字加行：

```yaml
version: 1
refs:
  CODEX_ACCESS_TOKEN: ...
  CODEX_ACCOUNT_ID: ...
```

DSH 会**自动重载**这个文件，改完不用重启——等下一次额度刷新（约 30 秒）或点一下「刷新」。

**写法二：设成同名环境变量**

写进 `<DSH_HOME>/.env` 或项目目录的 `.env`，或者启动 `dsh` 前 export。这两条路都要
**重启 `dsh`**：环境值在启动时就快照固定了。

优先级是**启动时环境 > 凭据文件 > 项目 `.env` > `<DSH_HOME>/.env`**。

> **为什么不能直接在「设置 → 模型」里填？** 那个页面只把你填的 Key 存到它自己按路由名
> 派生的 `<路由名>_API_KEY` 之下（如 `VOLCENGINE_API_KEY`），而火山要的是固定的
> `VOLC_ACCESS_KEY_ID` / `VOLC_SECRET_ACCESS_KEY`——**这两个名字不可能由那条规则推导出来**。
> 所以对这类固定名字，凭据文件（或环境变量）是唯一可靠的去处。每一家的「这家凭据怎么配」
> 会直接把**这台机器上的完整路径**显示出来。
>
> Codex / Cursor / Opencode 还有一个更省事的办法：**装过它们自己的 CLI 并登录过就行**，
> 插件会自动读那几份本机文件（只读、不写、不删）。卡片里会把这些路径列出来，并标出
> 「存在 / 不存在」。

**三家容易配错的地方：**

- **智谱的 Key 必须是「编程套餐专属」的那一把**——在「个人编程套餐」里新建，与平台普通
  API Key **不通用**。用错的表现是：标准模型调用能过，但额度查询报 `Authentication Failed`。
- **火山要的是 AccessKey ID / Secret Access Key，不是推理用的 `ark-` Key。** AK/SK 是
  **账号级 IAM 凭据**，入口是[「API 访问密钥」页](https://console.volcengine.com/iam/keymanage/)，
  **不在方舟控制台里**。用推理 Key 去查会在网关格式层被拒（HTTP 400 / `InvalidAuthorization` 100024）。
  Secret Access Key **只在创建时显示一次**，记得当场下载凭证。
- **Codex 要的是登录态 access token，不是 `sk-` 平台 Key；Cursor 同理。** 这两把都会过期，
  过期后 401：在各自 CLI 里重新登录即可（本插件**不做 token 刷新**——刷新要写回另一个 App
  的凭据文件，越权了）。

---

## 五、移除凭据

不再用某家套餐时，那一家的页面底部有**「移除…的凭据」**，点开能看到插件会去读的
**每一个引用名**、它现在配没配、来自哪一层。

勾一条或多条，点「移除」，**再确认一次**才会真的删。删的是
`<DSH_HOME>/.credentials.yaml` 里的那几行，删完这家就回到「未配置」。

### 有三种情形是删不掉的，界面会直说

能不能删不取决于「插件想不想」，而取决于那条凭据**来自哪一层**——
DSH 的解析优先级是 `启动环境变量 > 凭据文件 > 项目 .env > <DSH_HOME>/.env`，
而插件只能写**凭据文件**那一层：

| 来源 | 点「移除」会怎样 | 界面上 |
|---|---|---|
| DSH 凭据文件 | 真正删掉那一行 | 可勾选 |
| 启动时的环境变量 | DSH **拒绝**这次写入并报错 | 勾选框禁用，叫你回终端里改 |
| 项目 `.env` / `<DSH_HOME>/.env` | **静默什么都没做**（删一行不存在的记录，解析照样回落到那个文件） | 勾选框禁用，叫你去改那个文件 |

最后一行是最阴的一种：它不报错、不抛异常，删完那家照样是「已配置」。所以插件在删除后
**会重新查一遍**，仍然读得到就如实报「未移除」并指出该去哪删，**绝不把「什么都没发生」
显示成「已移除」**。

### 三条刻意不碰的东西

- **别人 App 的凭据文件**（`~/.codex/auth.json`、`~/.cursor/auth.json`、
  `~/.local/share/opencode/auth.json`、`~/.commandcode/auth.json`）不在删除范围内。
  那是**另一个 App 的登录文件**，插件一直只读不写。但它们会出现在清单里并写明路径
  ——不说的话，你清完凭据文件里那把之后插件照样读得到，「已移除」就是假的。
- **清单之外的任何引用名。** 这条路由从浏览器可达，只凭一个字符串就能删任意环境变量是
  危险的，因此服务端逐条核对白名单。
- **不做 token 刷新。** 刷新要写回上面的文件，属于越权。

> 面板里列的候选名是**从各家解析凭据时用的那份清单推导出来的**，不是另抄一份：
> 抄的那份迟早会漂移，而漂移的表现是「点了移除，那家照样能用」。

---

## 六、这些接口都是未文档化的

**六家都没有公开文档化的「个人套餐额度」API。** 本插件用的是它们**前端 / CLI 自己在用**的
内部接口（Codex 与 Opencode 虽然是开源的，但那些路由也是标注为内部/实验性的），
因此**可能随时失效**。一家失败只标那一家，其余各家与看板其余部分照常工作。

每一家的卡片上会写清两件事，用来判断「这个数字能不能当准」：

| 字段 | 含义 |
|---|---|
| 口径 | 这一家给的是百分比、绝对值、还是只有剩余额 |
| 核验级别 | `有一方来源`（开源代码 / 官方文档）或 `社区逆向`（未核验到一方来源，随时可能失效） |

核验不到的字段**一律显示 `—`**，插件不会为了「看起来完整」而编一个数字。

### 面板只显示你真正在用的那几家

- **配好凭据的（或配过但出问题的）一直显示**在标签栏里；
- **从没配过凭据的**收进「添加厂商」，点开能看到每一家的用途与配法；
- **一家都没配时「添加厂商」默认展开**：那时上面是空的，收起会让新用户什么都看不到；
- **你正在监看、或刚点中的那一家，永远留在标签栏里。**

> 判据是「**有没有配过**」，不是「成功还是失败」。**配过但坏了**的那一家（鉴权被拒 /
> 接口失败）不会因为失败就被藏起来——那正是你需要看到原因的时候。
