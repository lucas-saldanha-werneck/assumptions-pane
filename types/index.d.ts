export type Verdict = 'open' | 'right' | 'wrong'

export type Assumption = {
  id: string
  text: string
  why?: string
  verdict: Verdict
  correction?: string
  isSent: boolean
}

declare module 'claude-code' {
  interface PluginState {
    // queued: ids sent with the Send button that have not reached Claude yet
    // (a plugin prompt waits until the session is idle).
    // confirmClear: "Clear all" was pressed once and waits for "Yes, clear all".
    // storeKey: where the list is saved in $.store (`assumptions:<folder>`).
    'assumptions-pane': {
      items: Assumption[]
      isExpanded: boolean
      editing: string | null
      nextId: number
      queued: string[]
      confirmClear: boolean
      storeKey: string | null
    }
    // Owned by the side-stack plugin; read here to know whether to draw inside its pane.
    'side-stack': { present: boolean }
  }
}
