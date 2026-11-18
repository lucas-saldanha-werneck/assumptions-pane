import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput } from 'claude-code'

import type { Assumption } from '../types'
import { inTurnNote, marksContext, parsePhoneReply, phoneListContext } from './phone'
import { HOST_CHECKS_MS, STACKED_LINE, hasSection, heading, hostPresent, lookOf, notePrompt, placeSection, promptFromPhone, showStack } from './stack-guest'
import type { Look, StackHook } from './stack-guest'

// A small side pane: Claude logs each assumption it makes while it builds;
// the person marks it right or wrong, types a change, and sends the answers.
// Alone it draws its own pane; with the side-stack plugin running it draws
// one section inside the shared "Stack" pane instead.

const PANE = 'assumptions'
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
// Counted up to ask side-stack for its pane, silently; side-stack (0.5.0 and
// later) answers with the same number in its `shownFor`. An older one answers nothing.
const showStackAtom = atom({ plugin: 'assumptions-pane', key: 'showStack' } as const, 0)
const shownForAtom = atom({ plugin: 'side-stack', key: 'shownFor' } as const, 0)

// In the stack, the section keeps to this many items so it cannot push the
// other sections off screen. The rest come in as answered ones leave.
const STACK_ROWS = 6
const CONFIRM_MS = 5000
const MAX_REMOVED = 300
// Each process marks its own items, so two sessions in one folder never mix up
// two items that got the same number, and a correction goes to the Claude that
// made the assumption. A process saves a heartbeat while it holds items of its
// own; an owner not seen for ALIVE_MS is gone, and any session sends its answers.
const OWNER = Math.random().toString(36).slice(2, 10) || 'owner'
const BEAT_MS = 60_000
const ALIVE_MS = 3 * BEAT_MS
const OWNER_TTL_MS = 24 * 60 * 60 * 1000

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

// When a row was logged, in this computer's time zone, in the chosen format.
const TIME_FORMATS = ['YYYY-MM-DD HH:MM', 'DD/MM-HH:MM', 'MM/DD-HH:MM'] as const
type TimeFormat = (typeof TIME_FORMATS)[number]
export function formatTime(ms: number, format: TimeFormat): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const day = p(d.getDate())
  const month = p(d.getMonth() + 1)
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`
  if (format === 'DD/MM-HH:MM') return `${day}/${month}-${clock}`
  if (format === 'MM/DD-HH:MM') return `${month}/${day}-${clock}`
  return `${d.getFullYear()}-${month}-${day} ${clock}`
}

// Module values: none of them is drawn from. They outlive a /clear (the process
// goes on), which is what lastKey is for.
let lastKey: string | null = null
let lastStamp = 0
// The time_format option (userConfig), set when the module loads.
let timeFormat: TimeFormat = 'YYYY-MM-DD HH:MM'
let saving: Promise<void> = Promise.resolve()
let saveFailed = false
// One reload at a time.
let ensuring: Promise<void> | null = null
// The session watch: started once per process, it outlives a /clear.
let watching = false
const WATCH_MS = 1500
// Owners' last heartbeats as last read from the store, and this process's last one.
let owners: Record<string, number> = {}
let lastBeat = 0
// Highest number among ids trimmed off `removed`: an item at or below it never comes back.
let removedFloor = 0
// On the phone: the assumptions Claude was last asked to list (uids), which a bare "ok" answers.
let phoneListed: string[] = []

// The identity of an item: its number and the process that logged it.
const uid = (a: { id: string; owner?: string }): string => (a.owner !== undefined ? `${a.id}@${a.owner}` : a.id)
const isGone = (a: Assumption, gone: Set<string>, floor: number): boolean =>
  gone.has(uid(a)) || gone.has(a.id) || (floor > 0 && idNumber(a.id) <= floor)
const alive = (owner: string, now: number): boolean => owner === OWNER || (owners[owner] ?? 0) > now - ALIVE_MS
// Answers this session may send: its own, old ones without an owner, and those of an owner that is gone.
const mine = (a: Assumption, now: number): boolean =>
  a.owner === undefined || a.owner === OWNER || !alive(a.owner, now)
// A key for drawing: the plain id for this session's rows, the owner added for another's.
const rowKey = (a: Assumption): string => (a.owner === undefined || a.owner === OWNER ? a.id : `${a.id}-${a.owner}`)

async function nowMs($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// Keeps `removed` to MAX_REMOVED; the numbers trimmed off raise the floor.
function trimRemoved(list: string[]): string[] {
  if (list.length <= MAX_REMOVED) return list
  const cut = list.slice(0, list.length - MAX_REMOVED)
  for (const r of cut) removedFloor = Math.max(removedFloor, idNumber(r))
  return list.slice(-MAX_REMOVED)
}

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

// side-stack runs when its /stack command is listed (hostPresent, stack-guest.tsx).
// Its `present` state value is per session and gone after a /clear, so it is not relied on.

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

// Something new to see while stacked: ask side-stack for its pane, with nothing
// in the chat (its showStack counter). Not when the pane is open already, or the
// person reads from Remote Control (no pane shows there); `asked` (/assumptions)
// always asks. An older side-stack answers nothing: then /stack runs, and if that
// is refused, a toast says where to look.
async function bringStack($: EngineInterface, why: string, asked = false): Promise<void> {
  await showStack(
    $,
    {
      ask: () => update($, showStackAtom, n => (n ?? 0) + 1),
      answer: () => read($, shownForAtom),
      fallback: async () => {
        try {
          await $.command.run({ command: 'stack', args: '' })
        } catch {
          try {
            $.ui.toast(`${why} Open the Stack pane with /stack to see it.`)
          } catch {
            // Nothing more to do.
          }
        }
      },
    },
    asked,
  ).catch(() => false)
}

// --- Saved list -------------------------------------------------------------
// The list is kept in $.store per folder, so a /clear or an app reload brings
// it back. $.store is one file per plugin shared by every session, so each save
// re-reads what is there and merges by id first: another session's items and
// answers are kept, the higher next number wins, and a "Clear all" (clearedAt)
// or a sent item (removed) is never brought back by a stale save.

type Saved = {
  items: Assumption[]
  nextId: number
  clearedAt: number
  removed: string[]
  owners: Record<string, number>
  floor: number
}

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
    owners:
      v.owners !== null && typeof v.owners === 'object'
        ? Object.fromEntries(Object.entries(v.owners).filter(([, t]) => Number.isFinite(Number(t))).map(([k, t]) => [k, Number(t)]))
        : {},
    floor: Number.isFinite(Number(v.floor)) ? Number(v.floor) : 0,
  }
}

// The number of an id ("A12" or "A12@owner" -> 12).
const idNumber = (id: string): number => Number(/^A(\d+)/.exec(id)?.[1] ?? 0) || 0

// One map entry per item. A row saved before items had an owner is the same
// item as an owned row with its number.
function mergeLists(local: Assumption[], saved: Saved | undefined, gone: Set<string>, cleared: number, floor = 0): Assumption[] {
  const byKey = new Map<string, Assumption>()
  const sameKey = (a: Assumption): string | undefined => {
    if (byKey.has(uid(a))) return uid(a)
    for (const [k, b] of byKey) if (b.id === a.id && (b.owner === undefined) !== (a.owner === undefined)) return k
    return undefined
  }
  for (const a of [...(saved?.items ?? []), ...local]) {
    const k = sameKey(a)
    const other = k === undefined ? undefined : byKey.get(k)
    if (other === undefined) {
      byKey.set(uid(a), a)
      continue
    }
    const newer = (a.at ?? 0) >= (other.at ?? 0) ? a : other
    const owner = a.owner ?? other.owner
    byKey.delete(k as string)
    const item = owner !== undefined ? { ...newer, owner } : newer
    byKey.set(uid(item), item)
  }
  const list = [...byKey.values()]
    .filter(a => !isGone(a, gone, floor) && (cleared === 0 || (a.at ?? 0) > cleared))
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
      const now = await nowMs($)
      removedFloor = Math.max(removedFloor, saved?.floor ?? 0)
      const cleared = await update($, clearedAt, c => Math.max(c, saved?.clearedAt ?? 0))
      const gone = await update($, removed, r => trimRemoved([...new Set([...(saved?.removed ?? []), ...r])]))
      const goneSet = new Set(gone)
      const floor = removedFloor
      const merged = await update($, items, local => mergeLists(local, saved, goneSet, cleared, floor))
      const next = await update($, nextId, n => Math.max(n, saved?.nextId ?? 1))
      // Heartbeats: this process's while it holds items of its own; entries a day old leave.
      const beats = Object.fromEntries(Object.entries(saved?.owners ?? {}).filter(([, t]) => t > now - OWNER_TTL_MS))
      if (merged.some(a => a.owner === OWNER)) {
        beats[OWNER] = now
        lastBeat = now
      }
      owners = beats
      await $.store.set(key, { items: merged, nextId: next, clearedAt: cleared, removed: gone, owners: beats, floor })
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
  await update($, removed, r => trimRemoved([...new Set([...r, ...ids])]))
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

// While this process holds items of its own, it says it is alive about once a minute.
async function heartbeat($: EngineInterface): Promise<void> {
  if ((await nowMs($)) - lastBeat < BEAT_MS) return
  if (!(await read($, items)).some(a => a.owner === OWNER)) return
  await saveItems($)
}

async function clearAll($: EngineInterface): Promise<void> {
  // Every item there is now (another session's saved ones too) is recorded as
  // gone, so a stale copy answered later cannot bring it back with a newer time.
  await saveItems($)
  const ids = (await read($, items)).map(uid)
  const at = await stamp($)
  await update($, clearedAt, c => Math.max(c, at))
  await forget($, ids)
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
    if (why !== undefined) await bringStack($, why)
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
      list = mergeLists([], saved, gone, saved.clearedAt, saved.floor)
    }
  } catch {
    // Draw what the state holds.
  }
  return { isStacked: await hostPresent($), ...(list !== undefined ? { list } : {}) }
}

const setOne = async ($: EngineInterface, key: string, patch: Partial<Assumption>): Promise<void> => {
  const at = await stamp($)
  await setItems($, list => list.map(a => (uid(a) === key ? { ...a, ...patch, isSent: false, at } : a)))
  await openPane($)
}

// --- Review -----------------------------------------------------------------

// The answers the person gave that Claude has not seen yet.
const unsent = (list: Assumption[]): Assumption[] =>
  list.filter(a => !a.isSent && (a.verdict !== 'open' || (a.correction ?? '') !== ''))

// The answers this session sends: not another live session's (they go to that Claude).
const sendable = async ($: EngineInterface, list: Assumption[]): Promise<Assumption[]> => {
  const now = await nowMs($)
  return unsent(list).filter(a => mine(a, now))
}

// A RIGHT carries only the id: the text was written by the model, and the person
// confirming it should not hand it back as their own words.
const reviewLine = (a: Assumption): string => {
  const fix = norm(a.correction ?? '')
  if (a.verdict === 'right' && fix === '') return `- ${a.id} RIGHT`
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
  const isDelivered = (a: Assumption) => delivered.some(d => uid(d) === uid(a) && sameAnswer(a, d))
  const ids = (await read($, items)).filter(isDelivered).map(uid)
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
  const now = await nowMs($)
  const named = (await read($, items)).filter(a => ids.includes(a.id) && mine(a, now))
  const delivered = named.filter(a => lines.has(reviewLine(a)))
  const keys = named.map(uid)
  await update($, queued, q => q.filter(id => !keys.includes(id)))
  if (delivered.length > 0) await markSent($, delivered)
}

// A plugin's prompt only enters once the session is idle, so while Claude is
// mid-turn the review waits. Keep the answers in the pane (marked "waiting")
// until the prompt has entered; if it is dropped or fails, give them back so
// nothing is lost.
const sendNow = async ($: EngineInterface): Promise<void> => {
  await ensureSession($).catch(() => undefined)
  const waitingIds = await read($, queued)
  const list = (await sendable($, await read($, items))).filter(a => !waitingIds.includes(uid(a)))
  if (list.length === 0) return
  const ids = list.map(uid)
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

// --- On the phone -------------------------------------------------------------
// Remote Control draws no pane. A phone prompt first applies the person's reply
// to the assumptions Claude listed ("ok" marks them all right, "A46 errado: why"
// marks one wrong), then hands Claude the open assumptions the person has not
// been told about, to list at the end of its reply. Each is told once (`told`,
// saved with the list); one logged during a phone-driven turn is told by the
// log_assumption call itself (inTurnNote). The marks land in the same store, so
// the pane on the computer shows them; they count as sent (Claude read the reply).

async function onPhonePrompt($: EngineInterface, text: string): Promise<string[]> {
  const out: string[] = []
  const now = await nowMs($)
  const list = await read($, items)
  const listedIds = list.filter(a => phoneListed.includes(uid(a)) && a.verdict === 'open').map(a => a.id)
  const marks = parsePhoneReply(text, listedIds)
  const lines: string[] = []
  const marked = new Map<string, Assumption>()
  if (marks.length > 0) {
    const at = await stamp($)
    for (const m of marks) {
      const a = list.find(one => one.id === m.id && mine(one, now))
      if (a === undefined) continue
      const item: Assumption = { ...a, verdict: m.verdict, isSent: true, at, told: true, ...(m.why !== undefined ? { correction: m.why } : {}) }
      marked.set(uid(a), item)
      lines.push(reviewLine(item))
    }
    if (marked.size > 0) {
      await setItems($, l => l.map(a => marked.get(uid(a)) ?? a))
      await redraw($)
      out.push(marksContext(lines))
    }
  }
  const untold = (await read($, items)).filter(a => a.verdict === 'open' && !a.isSent && a.told !== true && mine(a, now))
  if (untold.length > 0) {
    const ids = untold.map(uid)
    await setItems($, l => l.map(a => (ids.includes(uid(a)) ? { ...a, told: true } : a)))
    phoneListed = [...phoneListed.filter(id => !marked.has(id)), ...ids]
    out.push(phoneListContext(untold.map(a => ({ id: a.id, text: a.text }))))
  } else {
    // The ones listed and not answered yet stay for a later "ok".
    phoneListed = phoneListed.filter(id => !marked.has(id))
  }
  return out
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

// Draws the list. One view for both looks (terminal and app, see
// stack-guest.tsx); today they draw the same tree. Alone it fills our own pane;
// stacked it is one section of the side-stack pane, with a row budget and keys
// prefixed "as-" so they never clash with another section's buttons. An empty
// list is one heading line.
async function drawSection<E extends ResolveInput>($: EngineInterface, e: E, look: Look, isStacked: boolean, saved?: Assumption[]) {
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
  const sendNowList = await sendable($, list)
  const waiting = sendNowList.filter(a => !queuedIds.includes(uid(a))).length
  const elsewhere = new Set(unsent(list).filter(a => !sendNowList.includes(a)).map(uid))
  const shown = isStacked ? list.slice(0, STACK_ROWS) : list
  const hidden = list.length - shown.length

  // Empty: the heading alone, nothing to show or hide.
  if (list.length === 0) return heading($, e, look, 'assumptions-pane', 'Assumptions', '0')
  const toggle = (
    <Button key={k('toggle')} plain onPress={() => update($, isExpanded, v => !v)}>
      {expanded ? 'Hide' : 'Show'}
    </Button>
  )
  const header = heading($, e, look, 'assumptions-pane', 'Assumptions', `${open} open`, toggle)
  if (!expanded) return header

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {shown.map(a => {
        const at = a.createdAt ?? a.at
        return (
          <Box key={k(`row-${rowKey(a)}`)} flexDirection="column">
            <Text
              color={a.verdict === 'right' ? 'success' : a.verdict === 'wrong' ? 'error' : undefined}
              dimColor={a.isSent && a.verdict === 'right'}
            >
              {a.verdict === 'right' ? '✓' : a.verdict === 'wrong' ? '✗' : '?'} {a.id} {a.text}
              {at !== undefined ? <Text dimColor>  {formatTime(at, timeFormat)}</Text> : null}
            </Text>
            {a.why !== undefined && <Text dimColor>  why: {a.why}</Text>}
            {(a.correction ?? '') !== '' && <Text color="warning">  change: {a.correction}</Text>}
            {queuedIds.includes(uid(a)) && <Text dimColor>  waiting</Text>}
            {elsewhere.has(uid(a)) && <Text dimColor>  other session</Text>}
            <Box flexDirection="row" gap={1}>
              <Button key={k(`right-${rowKey(a)}`)} label="Right" onPress={() => setOne($, uid(a), { verdict: 'right' })}>
                <Text color="success">Right</Text>
              </Button>
              <Button key={k(`wrong-${rowKey(a)}`)} label="Wrong" onPress={() => setOne($, uid(a), { verdict: 'wrong' })}>
                <Text color="error">Wrong</Text>
              </Button>
              <Button key={k(`edit-${rowKey(a)}`)} label="Change…" plain onPress={() => update($, editing, v => (v === uid(a) ? null : uid(a)))}>
                <Text color="suggestion">Change…</Text>
              </Button>
            </Box>
            {editId === uid(a) && Input === undefined && <Text dimColor>  Type the change in the prompt box.</Text>}
            {editId === uid(a) && Input !== undefined && (
              <Input
                key={k(`fix-${rowKey(a)}`)}
                placeholder="What should it be?"
                submitLabel="save"
                value={a.correction ?? ''}
                autoFocus
                onSubmit={async (value: string) => {
                  await setOne($, uid(a), { correction: norm(value).slice(0, 400), verdict: a.verdict === 'open' ? 'wrong' : a.verdict })
                  await update($, editing, () => null)
                }}
              />
            )}
          </Box>
        )
      })}
      {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
      <Box flexDirection="row" gap={1}>
        {/* Send shows only with something to send; "Waiting…" while a send is queued. */}
        {waiting > 0 && (
          <Button key={k('send')} variant="primary" onPress={() => sendNow($)}>
            {`Send ${waiting} to Claude`}
          </Button>
        )}
        {waiting === 0 && queuedIds.length > 0 && (
          <Button key={k('send')} variant="primary" onPress={() => sendNow($)}>
            Waiting for Claude…
          </Button>
        )}
        <Button key={k('all-right')} plain onPress={async () => {
          // Only rows the person can see: hidden ones are never marked unseen.
          const seen = shown.map(uid)
          const at = await stamp($)
          await setItems($, l => l.map(a => (a.verdict === 'open' && seen.includes(uid(a)) ? { ...a, verdict: 'right' as const, isSent: false, at } : a)))
          await openPane($)
        }}>{hidden > 0 ? 'All shown are right' : 'All open are right'}</Button>
        {/* Asked: Cancel takes the place "Clear all" had, so a double press cancels. */}
        {confirm && <Button key={k('clear-no')} plain onPress={() => update($, confirmClear, () => 0)}>Cancel</Button>}
        {confirm && (
          <Button key={k('clear-yes')} label="Yes, clear all" onPress={() => clearAll($)}>
            <Text color="error">Yes, clear all</Text>
          </Button>
        )}
        {!confirm && (
          <Button key={k('clear')} label="Clear all" plain onPress={() => askClear($)}>
            <Text color="error">Clear all</Text>
          </Button>
        )}
      </Box>
    </Box>
  )
}

// Inside side-stack's shared pane: our section, then every section beneath
// (or in the slot side-stack left for it). See stack-guest.tsx.
async function drawStacked<E extends ResolveInput>($: EngineInterface, e: E, look: Look) {
  const now = await drawingState($)
  if (!now.isStacked) return null
  return drawSection($, e, look, true, now.list)
}
const drawInStack: StackHook = async ($, e, next) => {
  const below = await next(e)
  if (hasSection(below, 'assumptions-pane')) return below
  // A broken section never hides the others.
  return placeSection($, e, below, 'assumptions-pane', await drawStacked($, e, lookOf(e.surface)).catch(() => null))
}

export const register: Register = (on, options) => {
  const chosen = String((options as Record<string, unknown> | undefined)?.time_format ?? '')
  timeFormat = (TIME_FORMATS as readonly string[]).includes(chosen) ? (chosen as TimeFormat) : 'YYYY-MM-DD HH:MM'
  on('session.start', async ($, e, next) => {
    const key = `assumptions:${e.cwd}`
    lastKey = key
    saving = Promise.resolve()
    saveFailed = false
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
    for (const ms of HOST_CHECKS_MS) {
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
          void heartbeat($).catch(() => undefined)
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
    const prevIds = (await read($, items)).map(uid)
    // On the phone (Remote Control) no pane shows: Claude lists it at the end of this turn's reply.
    const isPhone = promptFromPhone()
    const after = await update($, items, list => {
      const one: Assumption = { id, text, verdict: 'open', isSent: false, at, createdAt: at, owner: OWNER, ...(why !== '' ? { why } : {}), ...(isPhone ? { told: true } : {}) }
      return capped([...list, one])
    })
    if (isPhone) phoneListed = [...phoneListed, `${id}@${OWNER}`]
    // Rows the cap pushed out stay out of the saved list too.
    await forget($, prevIds.filter(old => !after.some(a => uid(a) === old)))
    await saveItems($)
    await openPane($, false, `New assumption ${id}.`)
    if (isPhone) return { result: `Logged as ${id}. Keep working.\n${inTurnNote({ id, text })}` }
    return { result: `Logged as ${id}. Keep working; the person may correct it later.` }
  }).catch(($, e, next) => next(e))

  // A typed prompt carries any answers not sent yet. They leave the pane only
  // once the prompt has entered; if it is dropped or fails, they stay.
  on('prompt.submit', async ($, e, next) => {
    await ensureSession($).catch(() => undefined)
    notePrompt(e.origin?.kind)
    if (e.origin?.kind === 'plugin') {
      const result = await next(e)
      // Our own review entering the chat: its rows leave now.
      const origin = e.origin as { kind: string; name?: string }
      if (origin.name === $.plugin.name && result.drop === undefined) {
        await reviewEntered($, e.text ?? '').catch(() => undefined)
      }
      return result
    }
    // A slash command (/model, /clear, a skill) is not a message Claude reads
    // as-is: the answers wait for the next prompt.
    if (e.command !== undefined) return next(e)
    if (e.origin?.kind === 'bridge') {
      const phone = await onPhonePrompt($, e.text ?? '').catch(() => [] as string[])
      if (phone.length > 0) e = { ...e, context: [...(e.context ?? []), ...phone] }
    }
    const waitingIds = await read($, queued)
    const list = (await sendable($, await read($, items))).filter(a => !waitingIds.includes(uid(a)))
    if (list.length === 0) return next(e)
    const ids = list.map(uid)
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
      await bringStack($, 'The assumptions are in the Stack pane.', true)
      return { text: 'Stack pane opened.' }
    }
    await openPane($, true)
    return { text: 'Assumptions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await drawingState($)
    if (now.isStacked) {
      // Never the list twice with live buttons.
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{STACKED_LINE}</Text>
    }
    return drawSection($, e, lookOf(e.surface), false, now.list)
  })

  on('ui.render', { component: 'Pane', requestId: 'side-stack', plugin: '*' }, drawInStack)
  on('ui.render', { component: 'Pane', requestId: 'side-stack' }, drawInStack)
}
