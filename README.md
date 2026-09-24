# dsh-pixel-dashboard

> 给 [DSH（DeepSeek Harness）](https://github.com/deepseek-harness) 的 Web 界面换一套像素风皮肤，
> 并加一个用量看板：Token 趋势、模型分布、活跃日历、**费用估算**、**时段倒计时**、
> **账户余额与套餐额度**，以及**任务完成 / 失败 / 等待授权的系统通知**。

![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%3E%3D18-blue)

装完即生效，**不需要**去设置里切主题，也**不需要**任何配置。所有金额都是本机估算，
不联网上报，详见[隐私](#本机数据与隐私)。

侧栏「用量看板」那一行会一直显示**现在是高峰还是空闲、还有多久切换**，不打开看板也能看到：

```
[▮] 用量看板        2时15分后空闲期     ← 高峰中（红）
[▮] 用量看板        空闲期剩2时15分     ← 空闲中（绿）
```

## 安装

需要 Node ≥ 18。插件**没有第三方依赖**，也**不需要构建**——`lib/` 是随仓库提交的产物。

```bash
dsh plugin --profile web add github:Fun4thinker/dsh-pixel-dashboard
```

装完**重启一次 `dsh`**，再刷新浏览器页面。到此就能看到新配色、侧栏那行倒计时和看板。

卸载：

```bash
dsh plugin --profile web remove dsh-pixel-dashboard
```

<details>
<summary>其他安装方式</summary>

**从本地源码安装**（改代码时用）：

```bash
git clone https://github.com/Fun4thinker/dsh-pixel-dashboard.git
cd dsh-pixel-dashboard
node tools/build.mjs                              # 产物写进根 lib/
node tools/install-official.mjs --profile web      # 建 link: 软链指向本地目录
```

之后每次 `node tools/build.mjs` 都即时生效（客户端改动刷新页面即可，宿主改动要重启 `dsh`）。

**换电脑**：不需要拷贝 `~/.dsh` 下任何东西，只需要上面那一条安装命令。
想把用量历史一起带走，额外复制 `usage-ledger.jsonl`（见[本机数据](#本机数据与隐私)）。

</details>

## 功能

| 部分 | 说明 |
|---|---|
| 视觉系统 | 奶油底 + 马卡龙色板，细腻圆角、柔和分层、统一缓动 |
| 两套主题 | 默认「奶油·昼」，另注册「暮色·夜」到 **设置 → 外观**，想固定深浅色的人可以显式选 |
| 用量看板 | 侧栏底部柱状图图标 → 主区整页看板 |
| 时段倒计时 | 侧栏那一行右侧的小字，高峰红字、空闲绿字；悬停给出精确到秒与站点时区 |
| 活跃日历 | 一年视图，**一格一天**（正方形），悬停显示当天请求数 / 会话数 / token 与**当天消费估计** |
| Token 趋势 | 最近 7 / 30 / 90 日曲线，可切换**构成** / **模型** / **提供商**三种维度 |
| 消费估计趋势 | 与 Token 趋势**同行**并排，逐日金额曲线，标题行右侧是窗口内合计 |
| 会话费用条 | 输入框**正下方**常驻一行，显示**本次会话**已花金额与 token 数 |
| 账户绑定 | 费用条旁那一枚**按当前模型来源自动绑定**：走官方 API 显示官方余额，走某家套餐显示那家的额度 |
| 账户余额 | 看板「账户与套餐」卡片，官方可用 / 充值 / 赠送余额（多币种），带一键开关 |
| 套餐额度 | 按厂商分块、按窗口（5 小时 / 每周 / 每月）画进度条与重置倒计时；顶部有「当前监看」切换器 |
| 费用估算 | 高峰 / 空闲分别计价，逐模型明细，并给出「若全走空闲可省多少」 |
| 通知提醒 | 任务**完成 / 失败 / 中断**、**等待你授权或回答**时弹系统通知；不可用时回落页面内提示条。**点通知直接切到那条会话** |
| 余额与额度预警 | 给每个币种设余额下限、给套餐设已用百分比上限，越过阈值时提醒（持续期间只提醒一次） |
| 会话清单 | 第一列是**与侧栏任务栏同源的预览标题**，不是会话号；默认收起 |

## 计费口径

**所有金额都是「按官方单价估算」：假如这些 token 全部走 DeepSeek 官方 API，分峰谷要花多少钱。**
它**不是**你的实际账单——第三方中转与 Coding Plan 是买断制，不按 token 计费，因此不在此估算范围内。

高峰 = 周一至周五 9:00–12:00、14:00–18:00（北京时间）；其余（含全部周末）是空闲，
空闲价 = 高峰价的一半。费用按**每条请求发生时刻**分档计价。

价目表里没有的模型会被标成「估算价」并暂按 Flash 折算。**在看板上就能给它补一个官方价**
（费用明细 → 自定义单价），不必改源码、也不必重新构建。

单价表、token 缩略规则（K / M / 亿）、「为什么一条 = 一个模型 + 一个提供商」，
以及补价的两个入口，见 **[docs/pricing.md](docs/pricing.md)**。

## 账户与套餐

| 厂商 | 窗口 | 凭据引用 |
|---|---|---|
| DeepSeek 官方 | 余额 | `DEEPSEEK_API_KEY`（即 DSH 自己那把 Key） |
| 智谱 GLM Coding Plan | 5 小时、每周 | `ZHIPU_CODING_API_KEY` |
| Command Code | 5 小时、每周、每月 | `COMMAND_CODE_API_KEY`（可自动读 `~/.commandcode/auth.json`） |
| 火山方舟 | 5 小时、每周、每月 | `VOLC_ACCESS_KEY_ID` + `VOLC_SECRET_ACCESS_KEY` |

后三家的额度接口都是**未文档化的内部接口**，可能随时失效；一家失败只标那一家，其余照常工作。

月度百分比怎么算、套餐档位表、凭据往哪写（**火山要 AK/SK，不是 `ark-` 推理 Key**），
见 **[docs/account-and-plans.md](docs/account-and-plans.md)**。

## 通知与预警

七个独立开关：总开关、任务完成、失败 / 中断、等待授权 / 回答、余额预警、套餐额度预警、
当前会话不打扰。**当前会话不打扰**默认开着——你正看着的会话跑完不弹通知，别的会话照常提醒。

系统通知需要浏览器授权。**没授权 ≠ 收不到提醒**：会回落到页面右下角的提示条，
同时在面板「最近通知」里留一条。

浏览器授权状态怎么区分、平台限制（点通知不会把窗口调到前台）、阈值怎么设，
见 **[docs/notifications.md](docs/notifications.md)**。

## 本机数据与隐私

| 事项 | 行为 |
|---|---|
| API Key | **不出本机**，只用于拼一个 `Authorization` 头；响应里只回报金额、币种与来源层名 |
| 余额请求 | 只发往 settings 里显式配置的 `baseURL`，否则官方 `https://api.deepseek.com`。**不读 `DEEPSEEK_BASE_URL`** |
| 套餐请求 | 只发往写死的官方域名，不接受改写 |
| 落盘 | 只写三份本机文件：用量账本 `usage-ledger.jsonl`、开关 `balance-prefs.json`、自定义单价 `custom-rates.json` |

用量账本默认在 `$DSH_HOME/plugins/dsh-pixel-dashboard/usage-ledger.jsonl`，按 `sessionId:seq` 去重，
因此重复扫描不会让历史翻倍。无遥测、无自动上报、无外部依赖。

完整清单见 **[docs/data-and-privacy.md](docs/data-and-privacy.md)**。

## 常见问题

**装完没反应 / 页面没变化？**
重启一次 `dsh`，再强制刷新浏览器页面（**Ctrl/Cmd + Shift + R**）。

**配色没生效？**
插件默认就叠上了配色、不需要切主题。若仍是黑白，多半是没重启 `dsh`。

**余额显示「—」而不是金额？**
界面上会写明原因（没配 Key / 请求失败 / 已关闭）。把「不知道」显示成 `¥0` 会让人以为余额空了，
所以这里不这么做。

**某家套餐显示「不可用」？**
那一家取数失败了，原因写在同一块里。注意智谱要**编程套餐专属 Key**，火山要 **AK/SK**。

**Command Code 的月度显示「—」？**
官方对月度只报剩余余额，插件得从另外两个接口拼。对不上时会显示 `—` 与原因，
**绝不把「不知道」显示成 `0%`**。详见 [docs/account-and-plans.md](docs/account-and-plans.md)。

**改了代码没生效？**
宿主半边改动要**重启 `dsh`**；只改客户端则刷新页面即可。

**怎么确认装好了、跑的是哪个版本？**

```bash
node tools/doctor.mjs --profile web
```

它会告诉你插件装好没、在线版本与仓库构建是否一致、账本在哪。

## 开发

```bash
node tools/verify.mjs                            # 构建 + 全套闸门（改完代码先跑这个）
node tools/build.mjs                             # 只重新构建产物到根 lib/
node tools/doctor.mjs --profile web              # 体检：装好没、跑的哪个版本、账本在哪
```

改代码时注意：**宿主半边（`lib/host.js`、路由）只在启动时加载，必须重启 `dsh`**；
客户端半边刷新页面即可。仓库内的 `AGENT.md` 记录了架构取舍与踩过的坑。

## 许可

[MIT](LICENSE) © 2026 dsh-pixel-dashboard contributors
