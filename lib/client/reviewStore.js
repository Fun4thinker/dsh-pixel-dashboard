/** Small bounded review cache. One inflight request per window/scope, independent of React renders. */
export function createReviewCache(fetcher = (...args) => fetch(...args)) {
  const entries = new Map()
  const keyOf = (days, scope) => {
    if (![7, 30, 90].includes(Number(days)) || !['recent', 'all'].includes(scope)) throw new Error('无效复盘范围')
    return `${Number(days)}:${scope}`
  }
  return {
    peek(days, scope) { return entries.get(keyOf(days, scope))?.data ?? null },
    clear() { entries.clear() },
    async load({ days, scope = 'recent', revision, force = false }) {
      const key = keyOf(days, scope)
      const entry = entries.get(key) ?? { data: null, revision: null, inflight: null }
      if (entry.inflight) return entry.inflight
      if (!force && entry.data && entry.revision === revision) return entry.data
      entries.set(key, entry)
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, 90_000)
      entry.inflight = Promise.resolve().then(async () => {
        try {
          const response = await fetcher(`/dsh-pixel/review?days=${Number(days)}&scope=${scope}`, {
            signal: controller.signal, headers: { accept: 'application/json' },
          })
          if (!response.ok) {
            let detail = ''
            try { detail = String((await response.json())?.error ?? '') } catch { /* HTTP status remains useful. */ }
            throw new Error(response.status === 404 ? '当前宿主尚未加载新版复盘接口，请重新加载插件。' : detail || `复盘数据读取失败（HTTP ${response.status}）`)
          }
          const data = await response.json()
          if (data?.schema !== 2 || Number(data?.range?.days) !== Number(days) || data.scope !== scope
            || !Array.isArray(data.sessions) || !Array.isArray(data.tools) || !Array.isArray(data.hours)) {
            throw new Error('复盘数据口径已更新，请重新加载看板插件。')
          }
          entry.data = data
          entry.revision = revision
          return data
        } catch (error) {
          if (error?.name === 'AbortError') throw new Error('复盘数据读取超时，请重试。')
          throw error
        } finally {
          clearTimeout(timer)
          entry.inflight = null
        }
      })
      return entry.inflight
    },
  }
}

export const reviewCache = createReviewCache()
