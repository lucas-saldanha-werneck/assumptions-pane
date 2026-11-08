import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'assumptions',
  props: { title: 'Assumptions', isFocused: true, bodyColumns: 44, placement: 'dock' } as never,
} as const

// A prompt the person typed in the prompt box.
const TYPED = { text: 'go on', wait: false, origin: { kind: 'composer' as const } }

// Calls the tool the mod registers, the way the model would.
const logAssumption = ($: { tool: { call: unknown } }, assumption: string): Promise<unknown> =>
  ($.tool.call as (input: object) => Promise<unknown>)({ tool: 'mcp__assumptions-pane__log_assumption', assumption })

test('logs an assumption, marks it, and sends the review', async ($, on) => {
  const sent: string[] = []
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const logged = await logAssumption($, 'Sort by date, newest first')
  expect(JSON.stringify(logged)).toContain('A1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface, ...PANE })
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /1 assumptions/ })).toBeDefined()
    if (surface === 'terminal') {
      await ui.press({ key: 'toggle' })
      await ui.press({ key: 'wrong-A1' })
      await ui.press({ key: 'edit-A1' })
      await ui.input({ key: 'fix-A1', text: 'Sort by name' })
      await ui.press({ key: 'send' })
      expect(sent.at(-1)).toContain('A1 CHANGE: Sort by date, newest first -> Sort by name')
      expect(await ui.find({ key: 'right-A1' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /No assumptions yet/ })).toBeDefined()
      await logAssumption($, 'Use 21 columns')
    } else {
      expect(await ui.find({ key: 'right-A2' })).toBeDefined()
      expect(await ui.find({ key: 'right-A1' })).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('a review that does not enter stays in the pane', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', async () => ({ drop: 'turn still running' }))
  await logAssumption($, 'Two T4 fields')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A1' })
  await ui.press({ key: 'send' })
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A1 Two T4 fields/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for Claude/ })).toBeUndefined()
  await ui.unmount()
})

test('the system prompt tells Claude to call log_assumption', async ($, on) => {
  // Stands in for the engine's own sections, beneath the mod's hook.
  on('prompt.compose', async () => ({ sections: [] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-test',
    promptModel: 'claude-test',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  const guide = sections.find(s => s.id === 'assumptions:guide')
  expect(guide?.text).toContain('call the log_assumption tool')
  expect(guide?.text).toContain('Assumption review')
})

test('a typed prompt that is dropped keeps the answers', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  const seen: string[][] = []
  let drop = true
  on('prompt.submit', async (_$, e) => {
    seen.push([...(e.context ?? [])])
    return drop ? { drop: 'blocked by a settings hook' } : { text: e.text, context: e.context }
  })
  await logAssumption($, 'Use port 8080')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A1' })
  const first = await $.prompt.submit(TYPED)
  expect(first.drop).toBe('blocked by a settings hook')
  expect(seen.at(-1)?.join('\n')).toContain('A1 WRONG: Use port 8080')
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  drop = false
  await $.prompt.submit(TYPED)
  expect(seen.at(-1)?.join('\n')).toContain('A1 WRONG: Use port 8080')
  expect(await ui.find({ key: 'right-A1' })).toBeUndefined()
  await ui.unmount()
})

test('a typed prompt that throws beneath keeps the answers', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('prompt.submit', async () => {
    throw new Error('downstream broke')
  })
  await logAssumption($, 'Use port 8080')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A1' })
  await $.prompt.submit(TYPED).catch(() => undefined)
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  await ui.unmount()
})

test('an edit made while a review waits is kept after the review enters', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async () => ({ value: undefined }))
  const sent: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>(r => (release = r))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    if (sent.length === 1) await gate
    return { text: e.text }
  })
  await logAssumption($, 'Sort by date')
  await logAssumption($, 'Use tabs')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'right-A1' })
  await ui.press({ key: 'right-A2' })
  const sending = ui.press({ key: 'send' })
  // Let the queued submit reach the gate, then change A1 while it waits.
  for (let i = 0; i < 1000 && sent.length === 0; i++) await Promise.resolve()
  expect(sent[0]).toContain('A1 RIGHT: Sort by date')
  await ui.press({ key: 'wrong-A1' })
  release()
  await sending
  // A2 went through unchanged and leaves; A1's newer answer is still there to send.
  expect(await ui.find({ key: 'right-A2' })).toBeUndefined()
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  await ui.press({ key: 'send' })
  expect(sent.at(-1)).toContain('A1 WRONG: Sort by date')
  expect(await ui.find({ key: 'right-A1' })).toBeUndefined()
  await ui.unmount()
})
