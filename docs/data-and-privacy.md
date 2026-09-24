# 本机数据与隐私

## 本机数据

用量统计来自一份**本机账本**，默认位于：

```
$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl
```

每次模型请求一条记录。记录按 `sessionId:seq` 去重，因此**重复扫描不会让历史翻倍**——
重装、换机、重复导入都安全。

`DSH_PIXEL_LEDGER` 可以覆盖这个路径。余额与套餐的开关、通知阈值存在同一目录的
`balance-prefs.json`（可用 `DSH_PIXEL_BALANCE_PREFS` 覆盖），它不是历史数据，
换机时不必带走——不带就走默认值「开启」。

## 隐私与数据安全

| 事项 | 行为 |
|---|---|
| API Key | **不出本机。** 只由宿主进程从 DSH 的 credentials 服务解析，用于拼一个 `Authorization` 头；响应里只回报金额、币种与来源层名，**从不回报 Key 本身**。 |
| 浏览器端 | 永远拿不到 Key，也拿不到带 Key 的 URL。 |
| 余额请求 | 只发往 settings 里显式配置的 `baseURL`，否则发往官方 `https://api.deepseek.com`。**不读 `DEEPSEEK_BASE_URL` 环境变量**。 |
| 套餐请求 | 只发往写死的官方域名（`open.bigmodel.cn` / `api.commandcode.ai` / `open.volcengineapi.com`），不接受任何改写。Command Code 走的是它自己的三条只读路径：`/alpha/billing/credits`、`/alpha/usage/summary`、`/alpha/billing/subscriptions`。 |
| 自动发现 | Command Code 可自动读 `~/.commandcode/auth.json`（另一个 App 的密钥文件）；**只读不写**，不配置就完全不会读。 |
| 开关 | 余额与套餐各自独立开关；关掉后**一个请求都不发**。`DSH_PIXEL_BALANCE=0` / `DSH_PIXEL_PLANS=0` 可硬性关闭。 |
| 统计 | 只读本机会话日志与账本，不向任何第三方发送。 |
| 通知 | 触发提醒**不发任何网络请求**；弹的是本机系统通知。 |
| 落盘 | 只写两份本机文件：用量账本 `usage-ledger.jsonl` 与开关 `balance-prefs.json`。通知日志与「最近通知」**只在内存**。 |

无遥测、无自动上报、无外部依赖。
