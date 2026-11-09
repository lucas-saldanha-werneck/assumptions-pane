import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput } from 'claude-code'

import type { Assumption } from '../types'

// A small side pane: Claude logs each assumption it makes while it builds;
// the person marks it right or wrong, types a change, and sends the answers.
// Alone it draws its own pane; with the side-stack plugin running it draws
// one section inside the shared "Stack" pane instead.

const PANE = 'assumptions'
const STACK_PANE = 'side-stack'
const items = atom({ plugin: 'assumptions-pane', key: 'items' } as const, [])
const isExpanded = atom({ plugin: 'assumptions-pane', key: 'isExpanded' } as const, false)
const editing = atom({ plugin: 'assumptions-pane', key: 'editing' } as const, null)
// Numbers keep counting after a clear and after a reload, so A3 in the chat always means one item.
const nextId = atom({ plugin: 'assumptions-pane', key: 'nextId' } as const, 1)
// Ids sent with Send that have not entered yet (they wait for Claude's turn to end).
const queued = atom({ plugin: 'assumptions-pane', key: 'queued' } as const, [])
// "Clear all" pressed once: the stamp of that press (0 = not asked). It expires.
const confirmClear = atom({ plugin: 'assumptions-pane', key: 'confirmClear' } as const, 0)
// Where the list is saved: `assumptions:<folder>`, set at session start.
const storeKey = atom({ plugin: 'assumptions-pane', key: 'storeKey' } as const, null)
// The last "Clear all" (this session's or another's in the same folder).
const clearedAt = atom({ plugin: 'assumptions-pane', key: 'clearedAt' } as const, 0)
// Ids that left the list (sent, or over the cap), so a merge never brings them back.
const removed = atom({ plugin: 'assumptions-pane', key: 'removed' } as const, [])
// True while this plugin draws inside side-stack's pane (side-stack reads it).
const stacked = atom({ plugin: 'assumptions-pane', key: 'stacked' } as const, false)
// The session id the list was loaded under. Kept in state, not in the module:
// on a /clear, events can arrive under the new id before the state is emptied,
// and a marker in the module would then say "loaded" for a state that is gone.
// In state it vanishes with the list, so the next look loads again.
const loadedFor = atom({ plugin: 'assumptions-pane', key: 'loadedFor' } as const, null)

// In the stack, the section keeps to this many items so it cannot push the
// other sections off screen. The rest come in as answered ones leave.
const STACK_ROWS = 6
const CONFIRM_MS = 5000
const MAX_REMOVED = 300

const GUIDE = [
  'Assumptions pane: while you build or change something, each time you make an assumption the person did not state',
  '(a default value, a guess about what they want, a choice between options, a file or name you picked),',
  'call the log_assumption tool once for that assumption, in one short plain sentence, then keep working.',
  'Do not stop to ask about it: the person reviews the list in a side pane and sends corrections.',
  'When a message starts with "Assumption review", apply each correction it lists before you go on.',
].join(' ')

const toolName = ($: EngineInterface, name: string): string => `mcp__${$.plugin.name}__${name}`

// One line, single spaces: a review line then matches the prompt it entered in.
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()

// Module values: none of them is drawn from. They outlive a /clear (the process
// goes on), which is what lastKey is for.
let lastKey: string | null = null
let lastStamp = 0
let saving: Promise<void> = Promise.resolve()
let saveFailed = false
// Whether side-stack's pane is up, as far as this plugin has seen.
let stackSeenOpen = false
let stackAsked = false
// One reload at a time.
let ensuring: Promise<void> | null = null
// The session watch: started once per process, it outlives a /clear.
let watching = false
const WATCH_MS = 1500

// Increasing times: two changes in the same millisecond still order.
async function stamp($: EngineInterface): Promise<number> {
  let now = 0
  try {
    now = await $.clock.now()
  } catch {
    now = Date.now()
  }
  lastStamp = Math.max(now, lastStamp + 1)
  return lastStamp
}

// --- side-stack presence ----------------------------------------------------

// side-stack runs when its /stack command is listed. Its `present` state value
// is per session and gone after a /clear, so it is not relied on.
async function hostPresent($: EngineInterface): Promise<boolean> {
  try {
    const cmds = await $.command.list()
    return cmds.some(c => c.name === 'stack' && (c.plugin ?? '').split('@')[0] === 'side-stack')
  } catch {
    return false
  }
}

// Checks side-stack again and publishes this plugin's own `stacked` flag.
async function checkStack($: EngineInterface): Promise<boolean> {
  const isUp = await hostPresent($)
  try {
    await update($, stacked, () => isUp)
  } catch {
    // The flag is a hint for side-stack only.
  }
  return isUp
}

// Something new to see while stacked: bring side-stack's pane up if it is not.
// $.command.run waits for the session to be idle and is refused inside a hook
// the turn waits on, so it goes out from a timer, not from the hook.
function bringStack($: EngineInterface, why: string): void {
  if (stackSeenOpen || stackAsked) return
  stackAsked = true
  const fail = () => {
    stackAsked = false
    try {
      $.ui.toast(`${why} Open the Stack pane with /stack to see it.`)
    } catch {
      // Nothing more to do.
    }
  }
  try {
    $.clock.after(0, () => {
      void $.command.run({ command: 'stack', args: '' }).then(() => {
        stackSeenOpen = true
        stackAsked = false
      }, fail)
    })
  } catch {
    fail()
  }
}

// --- Saved list -------------------------------------------------------------
// The list is kept in $.store per folder, so a /clear or an app reload brings
// it back. $.store is one file per plugin shared by every session, so each save
// re-reads what is there and merges by id first: another session's items and
// answers are kept, the higher next number wins, and a "Clear all" (clearedAt)
// or a sent item (removed) is never brought back by a stale save.

type Saved = { items: Assumption[]; nextId: number; clearedAt: number; removed: string[] }

const asSaved = (raw: unknown): Saved | undefined => {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const v = raw as Partial<Saved>
  const list = Array.isArray(v.items) ? v.items : []
  return {
    items: list
      .filter(a => a !== null && typeof a === 'object' && typeof a.id === 'string' && typeof a.text === 'string')
      .map(a => ({
        ...a,
        text: norm(a.text),
        ...(a.why !== undefined ? { why: norm(String(a.why)) } : {}),
        ...(a.correction !== undefined ? { correction: norm(String(a.correction)) } : {}),
      })),
    nextId: Number.isFinite(Number(v.nextId)) ? Number(v.nextId) : 1,
    clearedAt: Number.isFinite(Number(v.clearedAt)) ? Number(v.clearedAt) : 0,
    removed: Array.isArray(v.removed) ? v.removed.filter(id => typeof id === 'string') : [],
  }
}

const idNumber = (id: string): number => Number(id.replace(/\D/g, '')) || 0

function mergeLists(local: Assumption[], saved: Saved | undefined, gone: Set<string>, cleared: number): Assumption[] {
  const byId = new Map<string, Assumption>()
  for (const a of saved?.items ?? []) byId.set(a.id, a)
  for (const a of local) {
    const other = byId.get(a.id)
    if (other === undefined || (a.at ?? 0) >= (other.at ?? 0)) byId.set(a.id, a)
  }
  const list = [...byId.values()]
    .filter(a => !gone.has(a.id) && (cleared === 0 || (a.at ?? 0) > cleared))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id))
  return capped(list)
}

// The key this session saves under. A /clear may start the new conversation
// with fresh state and no session.start, so the module keeps the last key.
async function currentKey($: EngineInterface): Promise<string | null> {
  const key = await read($, storeKey)
  if (key !== null) return key
  if (lastKey !== null) await update($, storeKey, () => lastKey)
  return lastKey
}

// Resolves true once the merge landed in state and the store took it.
function saveItems($: EngineInterface): Promise<boolean> {
  const run = saving.then(async (): Promise<boolean> => {
    try {
      const key = await currentKey($)
      if (key === null) return false
      const saved = asSaved(await $.store.get(key))
      const cleared = await update($, clearedAt, c => Math.max(c, saved?.clearedAt ?? 0))
      const gone = await update($, removed, r => [...new Set([...(saved?.removed ?? []), ...r])].slice(-MAX_REMOVED))
      const goneSet = new Set(gone)
      const merged = await update($, items, local => mergeLists(local, saved, goneSet, cleared))
      const next = await update($, nextId, n => Math.max(n, saved?.nextId ?? 1))
      // An empty folder keeps only a few bytes: its next number and its clear time.
      if (merged.length === 0) await $.store.set(key, { items: [], nextId: next, clearedAt: cleared })
      else await $.store.set(key, { items: merged, nextId: next, clearedAt: cleared, removed: gone })
      return true
    } catch (err) {
      // The list still holds for this session. Say so once, not on every change.
      if (!saveFailed) {
        saveFailed = true
        try {
          $.ui.log(`assumptions-pane: the list could not be saved (${String(err)}); it holds for this session only`)
          $.ui.toast('Assumptions could not be saved; they hold for this session only.')
        } catch {
          // Nowhere to say it.
        }
      }
      return false
    }
  })
  saving = run.then(() => undefined)
  return run
}

async function setItems($: EngineInterface, fn: (list: Assumption[]) => Assumption[]): Promise<void> {
  await ensureSession($).catch(() => undefined)
  await update($, items, fn)
  await saveItems($)
}

async function forget($: EngineInterface, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await update($, removed, r => [...new Set([...r, ...ids])].slice(-MAX_REMOVED))
}

// Takes the higher next number from the store before minting, so two sessions
// in the same folder do not hand out the same number.
async function syncNextId($: EngineInterface): Promise<void> {
  try {
    const key = await currentKey($)
    if (key === null) return
    const saved = asSaved(await $.store.get(key))
    if (saved !== undefined) await update($, nextId, n => Math.max(n, saved.nextId))
  } catch {
    // This session's own count stands.
  }
}

async function clearAll($: EngineInterface): Promise<void> {
  const at = await stamp($)
  await update($, clearedAt, c => Math.max(c, at))
  await update($, removed, () => [])
  await setItems($, () => [])
  await update($, editing, () => null)
  await update($, confirmClear, () => 0)
}

// --- Pane -------------------------------------------------------------------

const titleFor = (list: Assumption[]): string => {
  const open = list.filter(a => a.verdict === 'open').length
  return open > 0 ? `Assumptions (${open} open)` : 'Assumptions'
}

// With side-stack running the section lives in its pane: close our own if it is up.
const closeOwnPane = async ($: EngineInterface): Promise<void> => {
  try {
    if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  } catch {
    // Nothing to close.
  }
}

// Shows the list where it lives now. `why` set: something new the person
// should see, so a closed Stack pane is brought up.
const openPane = async ($: EngineInterface, focus = false, why?: string): Promise<void> => {
  if (await checkStack($)) {
    // The state reads in the section's drawing redraw it on their own.
    await closeOwnPane($)
    if (why !== undefined) bringStack($, why)
    return
  }
  const list = await read($, items)
  await $.ui.open({ id: PANE, title: titleFor(list), columns: 46, ...(focus ? { focus: true as const } : {}) })
}

// Redraws the pane; a pane that fails to open never blocks the answers.
const redraw = async ($: EngineInterface): Promise<void> => {
  try {
    await openPane($)
  } catch {
    // Nothing to do: the list itself is unchanged.
  }
}

// At session start, and again 0.1 s and 1.1 s later (plugin load order is not
// known, so side-stack may start after this plugin): pick the pane to use.
const settlePane = async ($: EngineInterface): Promise<void> => {
  if (await checkStack($)) await closeOwnPane($)
  else if ((await read($, items)).length > 0) await redraw($)
}

const sessionId = async ($: EngineInterface): Promise<string | null> => {
  try {
    return await $.session.id()
  } catch {
    return null
  }
}

// The key for this folder: the one loaded, else from the session's folder.
// Reads only, so a drawing may call it.
async function folderKey($: EngineInterface): Promise<string | null> {
  const key = (await read($, storeKey)) ?? lastKey
  if (key !== null) return key
  try {
    return `assumptions:${await $.session.cwd()}`
  } catch {
    return null
  }
}

// After a /clear (a new session id): load the saved list into the fresh state,
// check side-stack again, publish `stacked`, and use the right pane.
async function ensureSession($: EngineInterface): Promise<void> {
  const id = await sessionId($)
  if (id === null || id === (await read($, loadedFor))) return
  if (ensuring !== null) return ensuring
  ensuring = (async () => {
    // The id is recorded only once the reload worked, so a reload that failed
    // (for example a write refused) is tried again on the next event.
    const key = await folderKey($)
    if (key !== null) {
      lastKey = key
      if ((await read($, storeKey)) === null) await update($, storeKey, () => key)
      if (!(await saveItems($))) return
    }
    const isUp = await hostPresent($)
    await update($, stacked, () => isUp)
    await update($, loadedFor, () => id)
    await settlePane($)
  })().finally(() => {
    ensuring = null
  })
  return ensuring
}

// What a drawing shows right after a /clear, before the reload has run: the
// saved list as the store holds it, and side-stack's presence asked directly.
async function drawingState($: EngineInterface): Promise<{ isStacked: boolean; list?: Assumption[] }> {
  const id = await sessionId($)
  if (id === null || id === (await read($, loadedFor))) return { isStacked: await read($, stacked) }
  // A drawing may not write state, and a timer started here runs as part of
  // this drawing (the engine refused its writes after a real /clear), so the
  // reload is left to the session watch and the next event.
  let list: Assumption[] | undefined
  try {
    const key = await folderKey($)
    const saved = key === null ? undefined : asSaved(await $.store.get(key))
    if (saved !== undefined) {
      const gone = new Set(saved.removed)
      list = mergeLists([], saved, gone, saved.clearedAt)
    }
  } catch {
    // Draw what the state holds.
  }
  return { isStacked: await hostPresent($), ...(list !== undefined ? { list } : {}) }
}

const setOne = async ($: EngineInterface, id: string, patch: Partial<Assumption>): Promise<void> => {
  const at = await stamp($)
  await setItems($, list => list.map(a => (a.id === id ? { ...a, ...patch, isSent: false, at } : a)))
  await openPane($)
}

// --- Review -----------------------------------------------------------------

// The answers the person gave that Claude has not seen yet.
const unsent = (list: Assumption[]): Assumption[] =>
  list.filter(a => !a.isSent && (a.verdict !== 'open' || (a.correction ?? '') !== ''))

const reviewLine = (a: Assumption): string => {
  const fix = norm(a.correction ?? '')
  if (a.verdict === 'right' && fix === '') return `- ${a.id} RIGHT: ${a.text}`
  if (fix !== '') return `- ${a.id} ${a.verdict === 'right' ? 'RIGHT, but change' : 'CHANGE'}: ${a.text} -> ${fix}`
  return `- ${a.id} WRONG: ${a.text} (do not keep this; ask me if the right choice is not clear)`
}

const REVIEW_HEAD = 'Assumption review:'
const reviewText = (list: Assumption[]): string => [REVIEW_HEAD, ...list.map(reviewLine)].join('\n')

// Answered items leave the list once Claude has them; open ones stay. Only the
// answer Claude got leaves: a row changed after it was sent stays, to send again.
const sameAnswer = (a: Assumption, b: Assumption): boolean =>
  a.verdict === b.verdict && (a.correction ?? '') === (b.correction ?? '')

const markSent = async ($: EngineInterface, delivered: Assumption[]): Promise<void> => {
  const isDelivered = (a: Assumption) => delivered.some(d => d.id === a.id && sameAnswer(a, d))
  const ids = (await read($, items)).filter(isDelivered).map(a => a.id)
  await forget($, ids)
  await setItems($, list => list.filter(a => !isDelivered(a)))
  await update($, editing, v => (v !== null && ids.includes(v) ? null : v))
  await redraw($)
}

// A review entered the chat (its prompt, or the turn it started): its rows
// leave. The app does not always settle the submit's promise once the review
// entered, so this does not wait for it. A row whose answer changed after it
// was sent no longer matches its line and stays, to send again.
const reviewEntered = async ($: EngineInterface, text: string): Promise<void> => {
  if (!text.includes(REVIEW_HEAD)) return
  const ids = [...text.matchAll(/^- (A\d+) /gm)].map(m => m[1] ?? '').filter(id => id !== '')
  if (ids.length === 0) return
  const lines = new Set(text.split('\n').map(l => l.trimEnd()))
  const delivered = (await read($, items)).filter(a => ids.includes(a.id) && lines.has(reviewLine(a)))
  await update($, queued, q => q.filter(id => !ids.includes(id)))
  if (delivered.length > 0) await markSent($, delivered)
}

// A plugin's prompt only enters once the session is idle, so while Claude is
// mid-turn the review waits. Keep the answers in the pane (marked "waiting")
// until the prompt has entered; if it is dropped or fails, give them back so
// nothing is lost.
const sendNow = async ($: EngineInterface): Promise<void> => {
  await ensureSession($).catch(() => undefined)
  const waitingIds = await read($, queued)
  const list = unsent(await read($, items)).filter(a => !waitingIds.includes(a.id))
  if (list.length === 0) return
  const ids = list.map(a => a.id)
  await update($, queued, q => [...q, ...ids])
  // Whatever happens below, the ids leave the queue again, so no answer is stuck as "waiting".
  let delivered = false
  try {
    await update($, editing, () => null)
    await redraw($)
    $.ui.toast('Review queued. Claude reads it as soon as its current turn ends.')
    let result: Awaited<ReturnType<typeof $.prompt.submit>> | undefined
    try {
      result = await $.prompt.submit({ text: reviewText(list) })
    } catch {
      result = undefined
    }
    delivered = result !== undefined && result.drop === undefined
    if (delivered) await markSent($, list)
  } finally {
    await update($, queued, q => q.filter(id => !ids.includes(id)))
    await redraw($)
  }
  if (!delivered) {
    $.ui.toast('Review not delivered. Your answers are still in the pane: press Send again or type a message.')
  }
}

// The list keeps at most this many items. Answers not sent yet never count
// against it: only the oldest items with nothing to send leave.
const MAX_ITEMS = 100
function capped(list: Assumption[]): Assumption[] {
  let excess = list.length - MAX_ITEMS
  if (excess <= 0) return list
  return list.filter(a => {
    if (excess > 0 && unsent([a]).length === 0) {
      excess--
      return false
    }
    return true
  })
}

// First press of "Clear all": ask again for a few seconds, then forget it.
async function askClear($: EngineInterface): Promise<void> {
  const token = await stamp($)
  await update($, confirmClear, () => token)
  try {
    $.clock.after(CONFIRM_MS, () => {
      void update($, confirmClear, v => (v === token ? 0 : v)).catch(() => undefined)
    })
  } catch {
    // Without a timer the question stays until Cancel or Yes.
  }
}

// --- Drawing ----------------------------------------------------------------

// side-stack orders its sections by these keys (protocol v4): ours is
// `side-stack:assumptions-pane`, and an empty Box keyed
// `side-stack:slot:assumptions-pane` in the tree beneath is where it goes.
const SECTION_KEY = 'side-stack:assumptions-pane'
const SLOT_KEY = 'side-stack:slot:assumptions-pane'

type Tree = { props?: Record<string, unknown>; children?: unknown[] }

// A copy of the tree with our slot replaced by the section, or undefined when
// the tree has no slot (side-stack is not beneath, or keeps install order).
function fillSlot(node: unknown, section: unknown): unknown {
  const el = node as Tree | null
  if (el === null || typeof el !== 'object' || !Array.isArray(el.children)) return undefined
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i] as Tree | null
    const swapped =
      child !== null && typeof child === 'object' && child.props?.key === SLOT_KEY ? section : fillSlot(child, section)
    if (swapped !== undefined) {
      const children = [...el.children]
      children[i] = swapped
      return { ...el, children }
    }
  }
  return undefined
}

// Draws the list. Alone it fills our own pane; stacked it is one section of the
// side-stack pane, with a heading, a row budget, and keys prefixed "as-" so they
// never clash with another section's buttons.
async function drawSection<E extends ResolveInput>($: EngineInterface, e: E, isStacked: boolean, saved?: Assumption[]) {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  // A surface table without Input falls back to a hint. (A mobile app that does not draw
  // Input gets an empty Box instead, which a hook cannot detect.)
  const Input = 'Input' in table ? table.Input : undefined
  const k = (name: string): string => (isStacked ? `as-${name}` : name)
  const held = await read($, items)
  const list = saved !== undefined && held.length === 0 ? saved : held
  const expanded = await read($, isExpanded)
  const editId = await read($, editing)
  const open = list.filter(a => a.verdict === 'open').length
  const queuedIds = await read($, queued)
  const confirm = (await read($, confirmClear)) > 0
  const waiting = unsent(list).filter(a => !queuedIds.includes(a.id)).length
  const shown = isStacked ? list.slice(0, STACK_ROWS) : list
  const hidden = list.length - shown.length

  const summary = list.length === 0 ? 'No assumptions yet' : `${list.length} assumptions, ${open} open`
  const toggle = (
    <Button key={k('toggle')} plain onPress={() => update($, isExpanded, v => !v)}>
      {expanded ? 'Hide' : 'Show'}
    </Button>
  )
  const header = isStacked ? (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text bold>Assumptions</Text>
      <Text dimColor>{list.length === 0 ? 'none yet' : `${list.length}, ${open} open`}</Text>
      {toggle}
    </Box>
  ) : (
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text bold>{summary}</Text>
      {toggle}
    </Box>
  )
  if (!expanded) return <Box key="assumptions" flexDirection="column">{header}</Box>

  return (
    <Box key="assumptions" flexDirection="column" gap={1}>
      {header}
      {shown.map(a => (
        <Box key={k(`row-${a.id}`)} flexDirection="column">
          <Text
            color={a.verdict === 'right' ? 'success' : a.verdict === 'wrong' ? 'error' : undefined}
            dimColor={a.isSent && a.verdict === 'right'}
          >
            {a.verdict === 'right' ? '✓' : a.verdict === 'wrong' ? '✗' : '?'} {a.id} {a.text}
          </Text>
          {a.why !== undefined && <Text dimColor>  why: {a.why}</Text>}
          {(a.correction ?? '') !== '' && <Text color="warning">  change: {a.correction}</Text>}
          {queuedIds.includes(a.id) && <Text dimColor>  sent, waiting for Claude to finish its turn</Text>}
          <Box flexDirection="row" gap={1}>
            <Button key={k(`right-${a.id}`)} onPress={() => setOne($, a.id, { verdict: 'right' })}>Right</Button>
            <Button key={k(`wrong-${a.id}`)} onPress={() => setOne($, a.id, { verdict: 'wrong' })}>Wrong</Button>
            <Button key={k(`edit-${a.id}`)} plain onPress={() => update($, editing, v => (v === a.id ? null : a.id))}>
              Change…
            </Button>
          </Box>
          {editId === a.id && Input === undefined && <Text dimColor>  Type the change in the prompt box.</Text>}
          {editId === a.id && Input !== undefined && (
            <Input
              key={k(`fix-${a.id}`)}
              placeholder="What should it be?"
              submitLabel="save"
              value={a.correction ?? ''}
              autoFocus
              onSubmit={async (value: string) => {
                await setOne($, a.id, { correction: norm(value).slice(0, 400), verdict: a.verdict === 'open' ? 'wrong' : a.verdict })
                await update($, editing, () => null)
              }}
            />
          )}
        </Box>
      ))}
      {hidden > 0 && <Text dimColor>+{hidden} more: they show as these are answered and sent</Text>}
      {list.length > 0 && (
        <Box flexDirection="row" gap={1}>
          <Button key={k('send')} variant="primary" onPress={() => sendNow($)}>
            {waiting > 0 ? `Send ${waiting} to Claude` : queuedIds.length > 0 ? 'Waiting for Claude…' : 'Nothing to send'}
          </Button>
          <Button key={k('all-right')} plain onPress={async () => {
            // Only rows the person can see: hidden ones are never marked unseen.
            const seen = shown.map(a => a.id)
            const at = await stamp($)
            await setItems($, l => l.map(a => (a.verdict === 'open' && seen.includes(a.id) ? { ...a, verdict: 'right' as const, isSent: false, at } : a)))
            await openPane($)
          }}>{hidden > 0 ? 'All shown are right' : 'All open are right'}</Button>
          {/* Asked: Cancel takes the place "Clear all" had, so a double press cancels. */}
          {confirm && <Button key={k('clear-no')} plain onPress={() => update($, confirmClear, () => 0)}>Cancel</Button>}
          {confirm && <Button key={k('clear-yes')} onPress={() => clearAll($)}>Yes, clear all</Button>}
          {!confirm && <Button key={k('clear')} plain onPress={() => askClear($)}>Clear all</Button>}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const key = `assumptions:${e.cwd}`
    lastKey = key
    saving = Promise.resolve()
    saveFailed = false
    stackSeenOpen = false
    stackAsked = false
    {
      const id = await sessionId($)
      await update($, loadedFor, () => id)
    }
    await update($, storeKey, () => key)
    // Loading is a merge with what is saved.
    await saveItems($)
    await $.tool.register({
      name: 'log_assumption',
      description:
        'Log one assumption you made while building (a default, a guess about intent, a choice between options) so the person can confirm or correct it in the side pane. One short plain sentence. Then keep working; do not wait.',
      inputSchema: {
        type: 'object',
        properties: {
          assumption: { type: 'string', description: 'The assumption, like "The table sorts by date, newest first".' },
          why: { type: 'string', description: 'Optional: why you chose it, in a few words.' },
        },
        required: ['assumption'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'assumptions',
      description: 'Show the assumptions pane (clear: empty the list)',
      argumentHint: 'clear',
    })
    await settlePane($)
    for (const ms of [100, 1100]) {
      try {
        $.clock.after(ms, () => {
          void settlePane($).catch(() => undefined)
        })
      } catch {
        // No timer: the first check stands.
      }
    }
    // A /clear fires no session.start, and a drawing may not reload, so a
    // watch started here (outside any drawing) reloads once the id changes.
    if (!watching) {
      try {
        $.clock.every(WATCH_MS, () => {
          void ensureSession($).catch(() => undefined)
        })
        watching = true
      } catch {
        // The next prompt, turn, command or press reloads it.
      }
    }
    return next(e)
  })

  // A /clear ends the conversation and the process goes on with no new
  // session.start. Let a save in flight finish; the list is not emptied.
  on('session.end', async ($, e, next) => {
    await saving.catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    return {
      ...result,
      sections: [...result.sections, { id: 'assumptions:guide', text: GUIDE, scope: 'session' as const }],
    }
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) !== toolName($, 'log_assumption')) return next(e)
    const input = e as unknown as Record<string, unknown>
    const text = norm(String(input.assumption ?? '')).slice(0, 400)
    if (text === '') return { deny: 'log_assumption needs the assumption text.' }
    await ensureSession($).catch(() => undefined)
    const why = norm(String(input.why ?? '')).slice(0, 200)
    await syncNextId($)
    // update() writes atomically and resolves what it wrote, so two calls at once get two numbers.
    const id = `A${(await update($, nextId, n => n + 1)) - 1}`
    const at = await stamp($)
    const prevIds = (await read($, items)).map(a => a.id)
    const after = await update($, items, list => {
      const one: Assumption = { id, text, verdict: 'open', isSent: false, at, ...(why !== '' ? { why } : {}) }
      return capped([...list, one])
    })
    // Rows the cap pushed out stay out of the saved list too.
    await forget($, prevIds.filter(old => !after.some(a => a.id === old)))
    await saveItems($)
    await openPane($, false, `New assumption ${id}.`)
    return { result: `Logged as ${id}. Keep working; the person may correct it later.` }
  }).catch(($, e, next) => next(e))

  // A typed prompt carries any answers not sent yet. They leave the pane only
  // once the prompt has entered; if it is dropped or fails, they stay.
  on('prompt.submit', async ($, e, next) => {
    await ensureSession($).catch(() => undefined)
    if (e.origin?.kind === 'plugin') {
      const result = await next(e)
      // Our own review entering the chat: its rows leave now.
      const origin = e.origin as { kind: string; name?: string }
      if (origin.name === $.plugin.name && result.drop === undefined) {
        await reviewEntered($, e.text ?? '').catch(() => undefined)
      }
      return result
    }
    const waitingIds = await read($, queued)
    const list = unsent(await read($, items)).filter(a => !waitingIds.includes(a.id))
    if (list.length === 0) return next(e)
    const ids = list.map(a => a.id)
    await update($, queued, q => [...q, ...ids])
    try {
      const result = await next({ ...e, context: [...(e.context ?? []), reviewText(list)] })
      if (result.drop === undefined) await markSent($, list)
      return result
    } finally {
      await update($, queued, q => q.filter(id => !ids.includes(id)))
    }
  }).catch(($, e, next) => next(e))

  // A sent review starting its turn entered the chat, even when the submit's
  // promise never settles: its rows leave. After a /clear that started with
  // fresh state, the first turn also brings the saved list back.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await ensureSession($).catch(() => undefined)
      if ((await read($, storeKey)) === null && lastKey !== null) await saveItems($)
      await reviewEntered($, e.text).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Follows side-stack's pane: brought up only while it is not open.
  on('ui.open', async ($, e, next) => {
    const result = await next(e)
    if (e.id === STACK_PANE) stackSeenOpen = true
    return result
  })
  on('ui.close', async ($, e, next) => {
    if (e.id === STACK_PANE) stackSeenOpen = false
    return next(e)
  })

  on('command.run', { command: 'assumptions' }, async ($, e) => {
    await ensureSession($).catch(() => undefined)
    if (e.args.trim().toLowerCase() === 'clear') {
      await clearAll($)
      await redraw($)
      return { text: 'Assumptions list cleared.' }
    }
    await update($, isExpanded, () => true)
    if (await checkStack($)) {
      await closeOwnPane($)
      stackSeenOpen = false
      bringStack($, 'The assumptions are in the Stack pane.')
      return { text: 'Assumptions are in the Stack pane (/stack opens it).' }
    }
    await openPane($, true)
    return { text: 'Assumptions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await drawingState($)
    if (now.isStacked) {
      // Never the list twice with live buttons.
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Shown in the Stack pane (/stack)</Text>
    }
    return drawSection($, e, false, now.list)
  })

  // Inside side-stack's shared pane: our section, then every section beneath,
  // unless side-stack left an empty slot for us (a set order): then it goes there.
  on('ui.render', { component: 'Pane', requestId: STACK_PANE }, async ($, e, next) => {
    stackSeenOpen = true
    const now = await drawingState($)
    if (!now.isStacked) return next(e)
    const { Box } = $.ui.resolve(e)
    const section = (
      <Box key={SECTION_KEY} flexDirection="column" marginBottom={1}>
        {await drawSection($, e, true, now.list)}
      </Box>
    )
    const below = await next(e)
    const filled = fillSlot(below, section)
    if (filled !== undefined) return filled as typeof below
    return (
      <Box flexDirection="column">
        {section}
        {below}
      </Box>
    )
  })
}
