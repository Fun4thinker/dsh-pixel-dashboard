/**
 * dsh-pixel-dashboard 装载入口（由 tools/build.mjs 生成，勿手改）。
 *
 * 实现版本：678a9e66（宿主源码哈希）
 * 带版本号动态 import 是为了绕开「Loader 不重新 import 同一 specifier」：
 * 重新构建后 specifier 变了，**重启** dsh 就会加载新实现（客户端半边则刷新页面即可）。
 * 哈希自动派生，不存在「忘了加版本号」这种失败模式。
 * @module dsh-pixel-dashboard
 */
const { default: plugin } = await import('./host.js?v=678a9e66')

export default plugin
