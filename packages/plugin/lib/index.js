/**
 * dsh-pixel-dashboard 装载入口（由 tools/build.mjs 生成，勿手改）。
 *
 * 实现版本：d7be421a（宿主源码哈希）
 * 带版本号动态 import 是为了绕开「Loader 不重新 import 同一 specifier」，
 * 因此改完 src/host.js 重新构建即可热更新。
 * @module dsh-pixel-dashboard
 */
const { default: plugin } = await import('./host.js?v=d7be421a')

export default plugin
