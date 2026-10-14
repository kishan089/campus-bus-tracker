import { useCallback, useEffect, useRef, useState } from 'react'

/** Loads data for an admin page, optionally refreshing every `pollMs`. Keeps showing the last data if a refresh fails. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true })
  const fnRef = useRef(fn)
  useEffect(() => { fnRef.current = fn })
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const data = await fnRef.current()
        if (alive) setState({ data, error: null, loading: false })
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'Something went wrong', loading: false }))
      }
    }
    void run()
    const t = pollMs ? setInterval(() => { if (!document.hidden) void run() }, pollMs) : undefined
    const onVisible = () => { if (pollMs && !document.hidden) void run() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, pollMs])

  return { ...state, reload }
}
