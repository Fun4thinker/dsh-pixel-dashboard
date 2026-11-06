# 插件能力请求：桌面端需要「通知点击 → 激活窗口」与最小化的窗口聚焦通道

> 提交位置：**Discussions**（README 指定 "Submit feedback or bug reports through GitHub Discussions"）。
> 建议分类：Feature request / Plugin development。

## 一、为什么以插件开发者视角提这件事

DSH 的「一切皆插件」是这套生态最大的价值，而通知类插件是插件生态里很基础的一类：
任务完成、需要授权、AI 提问、余额/额度预警，这些场景的共同诉求都是
**在用户不看着 DSH 的时候，把人叫回来**。

这类插件目前卡在同一个地方：**能把通知弹出来，但点了回不到应用**。
这不是某一个插件的实现问题——我用 DevTools 和 asar 逐层验证过，渲染进程**没有任何**
能把 Electron 窗口带到前台的通道（证据见第四节）。也就是说，任何插件作者尝试做
「点击通知回到对应会话」，都会在同一处撞墙，并且只能给出「请你自己手动切回窗口」
这种半截体验。

考虑到桌面端是 DSH 面向普通用户的主要形态，而通知又是「离开窗口时」唯一有效的触达手段，
我把它当作插件生态的一块**基础设施缺口**来提，而不是一个孤立 bug。

## 二、期望的能力（按重要性排序）

### 1）点击系统通知时激活并还原窗口（必需）

用户点击 DSH 弹出的 toast 时，期望：

- 窗口被还原（若最小化）、显示、并置于前台；
- 随后照常把 click 事件派发给创建该通知的渲染进程，插件可据此切到对应会话。

现在的结果是：toast 正常显示、点击后**窗口不动**，渲染进程的 `onclick`
有时甚至完全不触发。用户体验上等同于「点了没反应」。

### 2）一个最小的「请求聚焦窗口」通道（建议）

即使 (1) 修好，插件仍有需要显式请求聚焦的场景（例如通知已被系统折叠进通知中心、
或插件在页面内提供「回到该会话」的入口）。建议暴露一个最小 IPC，例如：

```js
// preload
contextBridge.exposeInMainWorld('dshDesktop', {
  ...,
  focusWindow: () => ipcRenderer.invoke('dsh-desktop:focus-window')
})

// main
ipcMain.handle('dsh-desktop:focus-window', (event) => {
  assertDesktopSender(event, ...)          // 与既有 IPC 同样的来源校验
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win === null) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
})
```

这不需要插件有特殊权限：它只影响自己的那个窗口，且必须沿用现有的
`assertDesktopSender` 来源校验。对插件生态的价值是「通知类插件第一次能做到闭环」。

### 3）可选：Service Worker 通知通道

浏览器侧之所以点通知能激活窗口，是因为 Chromium 的浏览器进程负责激活。
桌面端也可以用同一套语义：由壳在 toast 激活回调里聚焦窗口（即第 1 条），
插件侧不需要感知差异。

## 三、最小复现

1. 打开 DSH Desktop，安装任意会创建 web notification 的插件
   （我用的是自己写的 `dsh-pixel-dashboard`；换成任意 `new Notification(...)` 的插件同样成立）；
2. 让一个后台任务跑完，触发一条系统通知；
3. 把 DSH 窗口切到其他应用后面；
4. 点击该通知 → 窗口不来到前台，渲染进程的 click 回调不触发。

对照组：同一插件在浏览器里（`npx @deepseek-ai/dsh web` + Chrome/Edge）点击同一条通知，
**浏览器窗口会正常激活**，会话也能正确切换。差异只在 Electron 壳这一侧。

## 四、排查证据（已排除插件自身原因）

**1）渲染进程无法提窗口**

窗口被其他应用盖住时，在 DevTools Console 执行 `window.focus()`：返回 `undefined`，
窗口无任何反应。

**2）preload 没有提供 focus / activate 通道**

`contextBridge` 暴露的桥：`dsh / dshDesktop / dshPlatform / dshDesktopBoot / dshWelcome /
dshUpdateDialog / dshMandatoryUpdate / dshOnboarding`。

与窗口相关的是 `PLATFORM_IPC`：

```js
const PLATFORM_IPC = {
  bootstrap: "dsh-platform:bootstrap",
  localeChanged: "dsh-platform:locale-changed",
  open: "dsh-platform:open",
  bounds: "dsh-platform:bounds",
  close: "dsh-platform:close"
};
```

`DESKTOP_IPC.*` 也只有快捷键、外观、全屏、更新、locale 等。**没有任何
focus / activate / raise / restore 通道。**

**3）AUMID 与快捷方式身份不一致（怀疑是「点击不激活」的直接原因）**

- `app.asar` 内搜索 `setAppUserModelId`：**0 处**（大小写不敏感）；
- 因此 toast 落在 Electron 默认身份下，注册表可见
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\electron.app.DeepSeek Harness`
  的 `LastNotificationAddedTime`（证明该身份确实在发通知）；
- 但开始菜单快捷方式为 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk`
  → `E:\dsh-desktop\DeepSeek Harness.exe`，注册表里另有 `ai.deepseek.dsh.desktop` 身份。

三者身份不一致时，Windows 仍会显示 toast，但点击时无法把该 toast 映射回「应激活哪个程序」，
于是既不激活窗口，也可能不派发点击回调。主进程启动早期调用
`app.setAppUserModelId('ai.deepseek.dsh.desktop')`（与安装器写入的身份一致）
有可能单独修好这一条，建议先试。

## 五、对生态的影响

- 通知类插件（完成提醒、授权等待、提问提醒、额度预警、CI/任务看板、IM 桥接等）
  都依赖「点通知能回到应用」这一条闭环；缺了它，这类插件在桌面端只能算「半可用」；
- 用户侧的直接感受是「DSH 通知没用，点了没反应」，而这类负面体验会被归到插件生态上；
- 一旦补上（哪怕只是第 1 条 + 第 2 条），通知类插件就能做到与原生应用一致的交互，
  这是插件生态能否长出「真正好用」的桌面型插件的前置条件。
