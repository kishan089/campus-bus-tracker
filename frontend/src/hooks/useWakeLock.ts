import { useEffect, useState } from 'react'

/** Keeps the screen on while `active` (browsers pause GPS for pages in the background / on a locked screen). */
export function useWakeLock(active: boolean): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request('screen')
        if (cancelled) { void l.release(); return }
        lock = l
        setHeld(true)
        l.addEventListener('release', () => setHeld(false))
      } catch {
        setHeld(false) // refused (battery saver, unsupported context)
      }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire() }

    void acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release()
      setHeld(false)
    }
  }, [active])

  return held
}
