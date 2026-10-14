import { useEffect, useSyncExternalStore } from 'react'
import { getSession, restoreSession, subscribeSession } from '../services/auth'

export function useSession() {
  useEffect(() => { void restoreSession() }, [])
  return useSyncExternalStore(subscribeSession, getSession, getSession)
}
