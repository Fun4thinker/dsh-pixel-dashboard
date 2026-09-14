# dsh-pixel-dashboard-bundle

[`dsh-pixel-dashboard`](https://www.npmjs.com/package/dsh-pixel-dashboard) 的 **profile 组合包**。

它自己不含任何代码，只声明 `dsh.bundle.patch`，由 `dsh` 自动把插件包作为一层配置
挂进 profile 的条目树（`dsh.profile.bundles`）。因此安装与卸载都走官方机制，
不残留手写配置行：

```bash
# 安装（两个包都发布到 npm 之后可用）
dsh plugin --profile web add dsh-pixel-dashboard-bundle

# 卸载
dsh plugin --profile web remove dsh-pixel-dashboard-bundle
```

> **当前（尚未发布到 npm）请改用源码安装**：先把仓库 clone 下来，再在仓库里运行
> `node tools/install-official.mjs --profile web`。本包在 `dependencies` 里声明的
> `dsh-pixel-dashboard` 还不在 npm 上，pnpm 会一直卡在解析它；直接
> `dsh plugin add github:...#path:packages/bundle` 同样会卡住。

安装后**重启一次 `dsh`**（宿主侧代码只在启动时加载），再刷新浏览器页面。

> **本地路径安装的注意点**：pnpm 对本地目录用 `link:` 规格，而 `link:` 不解析目标包的
> `dependencies`，因此插件包不会被自动装上。本地开发时改用
> `node tools/install-official.mjs --profile web`（它会把两个包都装一次），
> 或直接 `dsh plugin --profile web add <插件包路径> <组合包路径>`。

## License

MIT
