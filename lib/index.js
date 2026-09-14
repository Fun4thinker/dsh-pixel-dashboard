/**
 * dsh-pixel-dashboard 装载入口（由 tools/build.mjs 生成，勿手改）。
 *
 * 实现版本：f8ab29f1（宿主源码哈希）
 * 带版本号动态 import 是为了绕开「Loader 不重新 import 同一 specifier」，
 * 因此改完 src/host.js 重新构建即可热更新。
 * @module dsh-pixel-dashboard
 */
const { default: plugin } = await import('./host.js?v=f8ab29f1')

export default plugin
