# 本机数据与隐私

## 本机数据

用量统计来自一份**本机账本**，默认位于：

```
$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl
```

每次模型请求一条记录。记录按 `sessionId:seq` 去重，因此**重复扫描不会让历史翻倍**——
重装、换机、重复导入都安全。

同一目录下还有三份小文件，都不是历史数据，**换机不必带走**（不带就回默认值）：

| 文件 | 内容 | 覆盖用的环境变量 |
|---|---|---|
| `balance-prefs.json` | 余额 / 套餐开关、通知开关 | `DSH_PIXEL_BALANCE_PREFS` |
| `custom-rates.json` | 你补充的单价、提供商倍率、美元折算汇率 | `DSH_PIXEL_RATES` |
| `session-cache.json` | 会话日志的**派生结果**缓存（只为加速，删掉会自动重建） | 跟账本同目录 |

`DSH_PIXEL_LEDGER` 可以覆盖账本路径。

> `session-cache.json` 里存的是「从日志里算出来的结果」（记录、轮次、标题），
> **不存原始会话事件**。这一点是硬约束：早先存原始事件让宿主常驻内存涨到 GB 级，
> 桌面端在刷新看板时被系统按内存压力杀掉，表现是「自己重启」。

## 隐私与数据安全

| 事项 | 行为 |
|---|---|
| API Key | **不出本机。** 只由宿主进程从 DSH 的 credentials 服务解析，用于拼一个 `Authorization` 头；响应里只回报金额、币种与来源层名，**从不回报 Key 本身**。 |
| 浏览器端 | 永远拿不到 Key，也拿不到带 Key 的 URL。 |
| 余额请求 | 只发往 settings 里显式配置的 `baseURL`，否则发往官方 `https://api.deepseek.com`。**不读 `DEEPSEEK_BASE_URL` 环境变量**。 |
| 套餐请求 | 只发往**写死的**各厂商官方域名，不接受任何改写：智谱 `open.bigmodel.cn`、Command Code `api.commandcode.ai`（三条只读路径 `/alpha/billing/credits`、`/alpha/usage/summary`、`/alpha/billing/subscriptions`）、火山 `open.volcengineapi.com`（控制面签名）、Codex 的 ChatGPT 后端、Cursor 与 Opencode 各自的官方接口。 |
| 自动发现 | 会**只读**这几个别的 App 的登录态文件：`~/.commandcode/auth.json`、`~/.codex/auth.json`、Cursor 的 `auth.json`、Opencode 的 `auth.json`。**不配置就完全不会读**，也**绝不写入**。 |
| 开关 | 余额与套餐各自独立开关；关掉后**一个请求都不发**。`DSH_PIXEL_BALANCE=0` / `DSH_PIXEL_PLANS=0` 可硬性关闭。 |
| 统计 | 只读本机会话日志与账本，不向任何第三方发送。 |
| 通知 | 触发提醒**不发任何网络请求**；弹的是本机系统通知。（余额 / 额度预警已取消，不再有定时轮询。） |
| 落盘 | 只写上面那四份本机文件。通知日志与「最近通知」**只在内存**。 |
| 移除凭据 | **只有你在看板上勾选并二次确认之后**才会写：删掉的是 DSH 凭据文件里那几个引用名（走 DSH 自己的 `credentials.unset`，不手改 YAML）。不勾就一个字节都不动；插件**不保留被删凭据的副本**。 |

## 宿主暴露的路由

插件在本地 webServer 上注册 11 条**精确匹配**路由，全部挂在 `/dsh-pixel` 前缀下：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-pixel/data` | GET | 看板全量数据（账本聚合 + 日历 + 价目）；`?refresh=1` 强制重扫 |
| `/dsh-pixel/session` | GET | **单会话明细**（会话标签页用）；`?id=<会话 id>`，只读 |
| `/dsh-pixel/balance` | GET | DeepSeek 官方余额 |
| `/dsh-pixel/plans` | GET | 六家订阅额度 |
| `/dsh-pixel/period` | GET | 纯时钟（高峰 / 空闲与切换时刻），不读账本 |
| `/dsh-pixel/version` | GET | 在线实现版本 |
| `/dsh-pixel/notify` | GET / POST | 通知日志（增量）与开关 |
| `/dsh-pixel/toggle` | POST | 余额 / 套餐查询开关 |
| `/dsh-pixel/rates` | GET / POST | 单价、倍率与汇率的读写 |
| `/dsh-pixel/plan-credentials` | GET / POST | 各家凭据现状 / 按勾选移除 |
| `/dsh-pixel/focus` | POST | 桌面端把窗口拉到前台（尽力而为） |

两条写路由（`/notify` 之外的 `/toggle`）与 `/plan-credentials`、`/rates` 都带**同源检查**：
不接受跨站表单触发。`/plan-credentials` 另有**引用名白名单**——它从浏览器可达，
凭一个字符串删任意环境变量是危险的。

无遥测、无自动上报、无外部依赖。
