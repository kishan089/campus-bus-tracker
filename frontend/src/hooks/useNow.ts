import { useEffect, useState } from 'react'

/** Re-renders every `ms` so "x seconds ago" labels keep counting. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
