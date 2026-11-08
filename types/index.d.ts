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
    'assumptions-pane': { items: Assumption[]; isExpanded: boolean; editing: string | null; nextId: number; queued: string[] }
  }
}
