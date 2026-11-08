import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption } from '../types'

// A small side pane: Claude logs each assumption it makes while it builds;
// the person marks it right or wrong, types a change, and sends the answers.

const PANE = 'assumptions'
const items = atom({ plugin: 'assumptions-pane', key: 'items' } as const, [])
const isExpanded = atom({ plugin: 'assumptions-pane', key: 'isExpanded' } as const, false)
const editing = atom({ plugin: 'assumptions-pane', key: 'editing' } as const, null)
// Numbers keep counting after a clear, so A3 in the chat always means one item.
const nextId = atom({ plugin: 'assumptions-pane', key: 'nextId' } as const, 1)
// Ids sent with Send that have not entered yet (they wait for Claude's turn to end).
const queued = atom({ plugin: 'assumptions-pane', key: 'queued' } as const, [])

const GUIDE = [
  'Assumptions pane: while you build or change something, each time you make an assumption the person did not state',
  '(a default value, a guess about what they want, a choice between options, a file or name you picked),',
  'call the log_assumption tool once for that assumption, in one short plain sentence, then keep working.',
  'Do not stop to ask about it: the person reviews the list in a side pane and sends corrections.',
  'When a message starts with "Assumption review", apply each correction it lists before you go on.',
].join(' ')

const toolName = ($: EngineInterface, name: string): string => `mcp__${$.plugin.name}__${name}`

const titleFor = (list: Assumption[]): string => {
  const open = list.filter(a => a.verdict === 'open').length
  return open > 0 ? `Assumptions (${open} open)` : 'Assumptions'
}

const openPane = async ($: EngineInterface, focus = false): Promise<void> => {
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

const setOne = async ($: EngineInterface, id: string, patch: Partial<Assumption>): Promise<void> => {
  await update($, items, list => list.map(a => (a.id === id ? { ...a, ...patch, isSent: false } : a)))
  await openPane($)
}

// The answers the person gave that Claude has not seen yet.
const unsent = (list: Assumption[]): Assumption[] =>
  list.filter(a => !a.isSent && (a.verdict !== 'open' || (a.correction ?? '') !== ''))

const reviewText = (list: Assumption[]): string => {
  const lines = list.map(a => {
    const fix = (a.correction ?? '').trim()
    if (a.verdict === 'right' && fix === '') return `- ${a.id} RIGHT: ${a.text}`
    if (fix !== '') return `- ${a.id} ${a.verdict === 'right' ? 'RIGHT, but change' : 'CHANGE'}: ${a.text} -> ${fix}`
    return `- ${a.id} WRONG: ${a.text} (do not keep this; ask me if the right choice is not clear)`
  })
  return ['Assumption review:', ...lines].join('\n')
}

// Answered items leave the list once Claude has them; open ones stay. Only the
// answer Claude got leaves: a row changed after it was sent stays, to send again.
const sameAnswer = (a: Assumption, b: Assumption): boolean =>
  a.verdict === b.verdict && (a.correction ?? '') === (b.correction ?? '')

const markSent = async ($: EngineInterface, delivered: Assumption[]): Promise<void> => {
  const isDelivered = (a: Assumption) => delivered.some(d => d.id === a.id && sameAnswer(a, d))
  const ids = (await read($, items)).filter(isDelivered).map(a => a.id)
  await update($, items, list => list.filter(a => !isDelivered(a)))
  await update($, editing, v => (v !== null && ids.includes(v) ? null : v))
  await redraw($)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    if ((await read($, items)).length > 0) await openPane($)
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
    await update($, items, list => {
      const one: Assumption = { id, text, verdict: 'open', isSent: false, ...(why !== '' ? { why } : {}) }
      return capped([...list, one])
    })
    await openPane($)
    return { result: `Logged as ${id}. Keep working; the person may correct it later.` }
  }).catch(($, e, next) => next(e))

  // A typed prompt carries any answers not sent yet. They leave the pane only
  // once the prompt has entered; if it is dropped or fails, they stay.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'plugin') return next(e)
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

  on('command.run', { command: 'assumptions' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'clear') {
      await update($, items, () => [])
      await update($, editing, () => null)
      await openPane($)
      return { text: 'Assumptions list cleared.' }
    }
    await update($, isExpanded, () => true)
    await openPane($, true)
    return { text: 'Assumptions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // A surface table without Input falls back to a hint. (A mobile app that does not draw
    // Input gets an empty Box instead, which a hook cannot detect.)
    const Input = 'Input' in table ? table.Input : undefined
    const list = await read($, items)
    const expanded = await read($, isExpanded)
    const editId = await read($, editing)
    const open = list.filter(a => a.verdict === 'open').length
    const queuedIds = await read($, queued)
    const waiting = unsent(list).filter(a => !queuedIds.includes(a.id)).length

    const header = (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text bold>{list.length === 0 ? 'No assumptions yet' : `${list.length} assumptions, ${open} open`}</Text>
        <Button key="toggle" plain onPress={() => update($, isExpanded, v => !v)}>
          {expanded ? 'Hide' : 'Show'}
        </Button>
      </Box>
    )
    if (!expanded) return <Box flexDirection="column">{header}</Box>

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {list.map(a => (
          <Box key={`row-${a.id}`} flexDirection="column">
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
              <Button key={`right-${a.id}`} onPress={() => setOne($, a.id, { verdict: 'right' })}>Right</Button>
              <Button key={`wrong-${a.id}`} onPress={() => setOne($, a.id, { verdict: 'wrong' })}>Wrong</Button>
              <Button key={`edit-${a.id}`} plain onPress={() => update($, editing, v => (v === a.id ? null : a.id))}>
                Change…
              </Button>
            </Box>
            {editId === a.id && Input === undefined && <Text dimColor>  Type the change in the prompt box.</Text>}
            {editId === a.id && Input !== undefined && (
              <Input
                key={`fix-${a.id}`}
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
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Button key="send" variant="primary" onPress={() => sendNow($)}>
              {waiting > 0 ? `Send ${waiting} to Claude` : queuedIds.length > 0 ? 'Waiting for Claude…' : 'Nothing to send'}
            </Button>
            <Button key="all-right" plain onPress={async () => {
              await update($, items, l => l.map(a => (a.verdict === 'open' ? { ...a, verdict: 'right' as const, isSent: false } : a)))
              await openPane($)
            }}>All open are right</Button>
          </Box>
        )}
      </Box>
    )
  })
}
