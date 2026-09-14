# dsh-pixel-dashboard-bundle

[`dsh-pixel-dashboard`](https://www.npmjs.com/package/dsh-pixel-dashboard) 的 **profile 组合包**。

它自己不含任何代码，只声明 `dsh.bundle.patch`，由 `dsh` 自动把插件包作为一层配置
挂进 profile 的条目树（`dsh.profile.bundles`）。因此安装与卸载都走官方机制，
不残留手写配置行：

```bash
# 安装
dsh plugin --profile web add dsh-pixel-dashboard-bundle

# 卸载
dsh plugin --profile web remove dsh-pixel-dashboard-bundle
```

安装后**重启一次 `dsh`**（宿主侧代码只在启动时加载），再刷新浏览器页面。

> **本地路径安装的注意点**：pnpm 对本地目录用 `link:` 规格，而 `link:` 不解析目标包的
> `dependencies`，因此插件包不会被自动装上。本地开发时改用
> `node tools/install-official.mjs --profile web`（它会把两个包都装一次），
> 或直接 `dsh plugin --profile web add <插件包路径> <组合包路径>`。

## License

MIT
