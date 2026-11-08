import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'assumptions',
  props: { title: 'Assumptions', isFocused: true, bodyColumns: 44, placement: 'dock' } as never,
} as const

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
