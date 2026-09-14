# dsh-pixel-dashboard

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) Web 界面换上
「像素基因 + 现代做工」的皮肤，并加一个**用量与费用看板**：
马卡龙配色主题、Token 趋势、模型分布、全年活跃日历、**费用估算**、**时段倒计时**、
**官方账户余额**，以及输入框正下方的**本次会话费用条**。

这是**插件本体**包（宿主半边 + 浏览器半边）。安装请用组合包
[`dsh-pixel-dashboard-bundle`](https://www.npmjs.com/package/dsh-pixel-dashboard-bundle)：

```bash
# 两个包都发布到 npm 之后可用
dsh plugin --profile web add dsh-pixel-dashboard-bundle
```

> **当前（尚未发布到 npm）请改用源码安装**：先把仓库 clone 下来，再在仓库里运行
> `node tools/install-official.mjs --profile web`。原因见仓库 README 的「安装」一节——
> 组合包在 `dependencies` 里声明了本包，而本包不在 npm 上时，pnpm 会一直卡在解析它。

完整说明、口径与设计约束见
[仓库 README](https://github.com/Fun-thinker/dsh-pixel-dashboard#readme)。

## 隐私

- **API Key 不出本机。** 账户余额由**宿主进程**用 DSH 自己给官方 provider 用的那把
  Key 查询（`GET {baseURL}/user/balance`），浏览器端只收到金额与币种，永远拿不到 Key。
- **余额查询可以关掉。** 看板上「账户余额」卡片里有一键开关；关掉后宿主不再向官方
  端点发起任何请求。`DSH_PIXEL_BALANCE=0` 是更硬的一层关闭（用于 CI 等环境）。
- **统计只读本机。** 用量来自本机会话日志与 `$DSH_HOME` 下的账本，不向任何第三方发送。
- **端点不被环境变量改道。** 余额请求只发往 settings 里显式配置的 `baseURL`，
  否则发往官方公网地址 `https://api.deepseek.com`。

## 口径

单价与时段取自 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
（北京时间）。高峰时段 = 周一至周五 9:00–12:00、14:00–18:00；
其余时间（含全部周末）都是空闲时段，空闲价 = 高峰价的一半。
费用按**每条请求发生时刻**分档累计，是本地估算，实际账单以服务商为准。

## License

MIT
