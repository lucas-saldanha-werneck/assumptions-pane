import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput } from 'claude-code'

import type { Assumption } from '../types'

// A small side pane: Claude logs each assumption it makes while it builds;
// the person marks it right or wrong, types a change, and sends the answers.
// Alone it draws its own pane; with the side-stack plugin installed it draws
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
// The first press of "Clear all" asks for a second press.
const confirmClear = atom({ plugin: 'assumptions-pane', key: 'confirmClear' } as const, false)
// Where the list is saved: `assumptions:<folder>`, set at session start.
const storeKey = atom({ plugin: 'assumptions-pane', key: 'storeKey' } as const, null)
// Set by the side-stack plugin while it runs (read only here).
const stackPresent = atom({ plugin: 'side-stack', key: 'present' } as const, false)

// In the stack, the section keeps to this many items so it cannot push the
// other sections off screen. The rest come in as answered ones leave.
const STACK_ROWS = 6

const GUIDE = [
  'Assumptions pane: while you build or change something, each time you make an assumption the person did not state',
  '(a default value, a guess about what they want, a choice between options, a file or name you picked),',
  'call the log_assumption tool once for that assumption, in one short plain sentence, then keep working.',
  'Do not stop to ask about it: the person reviews the list in a side pane and sends corrections.',
  'When a message starts with "Assumption review", apply each correction it lists before you go on.',
].join(' ')

const toolName = ($: EngineInterface, name: string): string => `mcp__${$.plugin.name}__${name}`

const isStacked = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await read($, stackPresent)) === true
  } catch {
    return false
  }
}

// --- Saved list -------------------------------------------------------------
// The list is kept in $.store per folder, so a /clear (a new session) or an app
// reload brings it back. Only "Clear all" or /assumptions clear empties it.

// Saves run one after another, each writing what the state holds when it runs,
// so the last save always writes the latest list.
let saving: Promise<void> = Promise.resolve()

function saveItems($: EngineInterface): Promise<void> {
  saving = saving.then(async () => {
    try {
      const key = await read($, storeKey)
      if (key === null) return
      await $.store.set(key, { items: await read($, items), nextId: await read($, nextId) })
    } catch {
      // The list still holds for this session.
    }
  })
  return saving
}

async function setItems($: EngineInterface, fn: (list: Assumption[]) => Assumption[]): Promise<void> {
  await update($, items, fn)
  await saveItems($)
}

async function loadItems($: EngineInterface, cwd: string): Promise<void> {
  const key = `assumptions:${cwd}`
  await update($, storeKey, () => key)
  try {
    const saved = (await $.store.get(key)) as { items?: Assumption[]; nextId?: number } | undefined
    if (saved === undefined || saved === null || !Array.isArray(saved.items)) return
    const list = saved.items
    if ((await read($, items)).length === 0) await update($, items, () => list)
    const savedNext = Number(saved.nextId ?? 1)
    if (Number.isFinite(savedNext)) await update($, nextId, n => Math.max(n, savedNext))
  } catch {
    // Starts empty.
  }
}

async function clearAll($: EngineInterface): Promise<void> {
  await setItems($, () => [])
  await update($, editing, () => null)
  await update($, confirmClear, () => false)
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

const openPane = async ($: EngineInterface, focus = false): Promise<void> => {
  if (await isStacked($)) {
    // The state reads in the section's drawing redraw it on their own.
    await closeOwnPane($)
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

// At session start, and once more a second later (plugin load order is not
// known, so side-stack may start after this plugin): pick the pane to use.
const settlePane = async ($: EngineInterface): Promise<void> => {
  if (await isStacked($)) await closeOwnPane($)
  else if ((await read($, items)).length > 0) await redraw($)
}

const setOne = async ($: EngineInterface, id: string, patch: Partial<Assumption>): Promise<void> => {
  await setItems($, list => list.map(a => (a.id === id ? { ...a, ...patch, isSent: false } : a)))
  await openPane($)
}

// --- Review -----------------------------------------------------------------

// The answers the person gave that Claude has not seen yet.
const unsent = (list: Assumption[]): Assumption[] =>
  list.filter(a => !a.isSent && (a.verdict !== 'open' || (a.correction ?? '') !== ''))

const reviewLine = (a: Assumption): string => {
  const fix = (a.correction ?? '').trim()
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
  const lines = new Set(text.split('\n'))
  const delivered = (await read($, items)).filter(a => ids.includes(a.id) && lines.has(reviewLine(a)))
  await update($, queued, q => q.filter(id => !ids.includes(id)))
  if (delivered.length > 0) await markSent($, delivered)
}

// A plugin's prompt only enters once the session is idle, so while Claude is
// mid-turn the review waits. Keep the answers in the pane (marked "waiting")
// until the prompt has entered; if it is dropped or fails, give them back so
// nothing is lost.
const sendNow = async ($: EngineInterface): Promise<void> => {
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
const capped = (list: Assumption[]): Assumption[] => {
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

// --- Drawing ----------------------------------------------------------------

// Draws the list. Alone it fills our own pane; stacked it is one section of the
// side-stack pane, with a heading, a row budget, and keys prefixed "as-" so they
// never clash with another section's buttons.
async function drawSection<E extends ResolveInput>($: EngineInterface, e: E, stacked: boolean) {
  const table = $.ui.resolve(e)
  const { Box, Text, Button } = table
  // A surface table without Input falls back to a hint. (A mobile app that does not draw
  // Input gets an empty Box instead, which a hook cannot detect.)
  const Input = 'Input' in table ? table.Input : undefined
  const k = (name: string): string => (stacked ? `as-${name}` : name)
  const list = await read($, items)
  const expanded = await read($, isExpanded)
  const editId = await read($, editing)
  const open = list.filter(a => a.verdict === 'open').length
  const queuedIds = await read($, queued)
  const confirm = await read($, confirmClear)
  const waiting = unsent(list).filter(a => !queuedIds.includes(a.id)).length
  const shown = stacked ? list.slice(0, STACK_ROWS) : list
  const hidden = list.length - shown.length

  const summary = list.length === 0 ? 'No assumptions yet' : `${list.length} assumptions, ${open} open`
  const toggle = (
    <Button key={k('toggle')} plain onPress={() => update($, isExpanded, v => !v)}>
      {expanded ? 'Hide' : 'Show'}
    </Button>
  )
  const header = stacked ? (
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
                await setOne($, a.id, { correction: value.trim(), verdict: a.verdict === 'open' ? 'wrong' : a.verdict })
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
            await setItems($, l => l.map(a => (a.verdict === 'open' && seen.includes(a.id) ? { ...a, verdict: 'right' as const, isSent: false } : a)))
            await openPane($)
          }}>{hidden > 0 ? 'All shown are right' : 'All open are right'}</Button>
          {confirm && <Button key={k('clear-yes')} onPress={() => clearAll($)}>Yes, clear all</Button>}
          {confirm && <Button key={k('clear-no')} plain onPress={() => update($, confirmClear, () => false)}>Cancel</Button>}
          {!confirm && <Button key={k('clear')} plain onPress={() => update($, confirmClear, () => true)}>Clear all</Button>}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await loadItems($, e.cwd)
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
    try {
      $.clock.after(1000, () => {
        void settlePane($).catch(() => undefined)
      })
    } catch {
      // No timer: the first check stands.
    }
    return next(e)
  })

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
    const text = String(input.assumption ?? '').trim().slice(0, 400)
    if (text === '') return { deny: 'log_assumption needs the assumption text.' }
    const why = String(input.why ?? '').trim().slice(0, 200)
    // update() writes atomically and resolves what it wrote, so two calls at once get two numbers.
    const id = `A${(await update($, nextId, n => n + 1)) - 1}`
    await setItems($, list => {
      const one: Assumption = { id, text, verdict: 'open', isSent: false, ...(why !== '' ? { why } : {}) }
      return capped([...list, one])
    })
    await openPane($)
    return { result: `Logged as ${id}. Keep working; the person may correct it later.` }
  }).catch(($, e, next) => next(e))

  // A typed prompt carries any answers not sent yet. They leave the pane only
  // once the prompt has entered; if it is dropped or fails, they stay.
  on('prompt.submit', async ($, e, next) => {
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
  // promise never settles: its rows leave.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await reviewEntered($, e.text).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'assumptions' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      await clearAll($)
      await redraw($)
      return { text: 'Assumptions list cleared.' }
    }
    await update($, isExpanded, () => true)
    if (await isStacked($)) {
      await closeOwnPane($)
      return { text: 'Assumptions are in the Stack pane (/stack opens it).' }
    }
    await openPane($, true)
    return { text: 'Assumptions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawSection($, e, false))

  // Inside side-stack's shared pane: our section, then every section beneath.
  on('ui.render', { component: 'Pane', requestId: STACK_PANE }, async ($, e, next) => {
    if (!(await isStacked($))) return next(e)
    const { Box } = $.ui.resolve(e)
    const section = await drawSection($, e, true)
    return (
      <Box flexDirection="column">
        <Box key="assumptions-section" flexDirection="column" marginBottom={1}>{section}</Box>
        {await next(e)}
      </Box>
    )
  })
}
