export type Verdict = 'open' | 'right' | 'wrong'

export type Assumption = {
  id: string
  text: string
  why?: string
  verdict: Verdict
  correction?: string
  isSent: boolean
  // Time of the last change (ms); a merge with another session's save keeps the newer.
  at?: number
}

declare module 'claude-code' {
  interface PluginState {
    // queued: ids sent with the Send button that have not reached Claude yet
    // (a plugin prompt waits until the session is idle).
    // confirmClear: stamp of a first "Clear all" press waiting for "Yes, clear all" (0 = none).
    // storeKey: where the list is saved in $.store (`assumptions:<folder>`).
    // clearedAt: time of the last Clear all; removed: ids that left (sent or capped).
    // stacked: true while this plugin draws inside side-stack's pane (side-stack reads it).
    'assumptions-pane': {
      items: Assumption[]
      isExpanded: boolean
      editing: string | null
      nextId: number
      queued: string[]
      confirmClear: number
      storeKey: string | null
      clearedAt: number
      removed: string[]
      stacked: boolean
    }
    // Owned by the side-stack plugin; read here to know whether to draw inside its pane.
    'side-stack': { present: boolean }
  }
}
