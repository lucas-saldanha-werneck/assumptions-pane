import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

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

test('a pane that fails to open during Send does not strand the answers', async ($, on) => {
  let paneBroken = false
  on('ui.open', async () => {
    if (paneBroken) throw new Error('pane failed')
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', async () => ({ value: undefined }))
  const seen: string[] = []
  on('prompt.submit', async (_$, e) => {
    seen.push([e.text, ...(e.context ?? [])].join('\n'))
    return { text: e.text, context: e.context }
  })
  await logAssumption($, 'Use port 8080')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A1' })
  paneBroken = true
  await ui.press({ key: 'send' }).catch(() => undefined)
  paneBroken = false
  // The answer is not stuck as "waiting": the review went out, or a typed prompt still carries it.
  await $.prompt.submit(TYPED)
  expect(seen.join('\n')).toContain('A1 WRONG: Use port 8080')
  await ui.unmount()
})

test('assumptions logged at the same time get different numbers', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  const results = await Promise.all([
    logAssumption($, 'First'),
    logAssumption($, 'Second'),
    logAssumption($, 'Third'),
  ])
  const ids = results.map(r => JSON.stringify(r).match(/A\d+/)?.[0])
  expect(new Set(ids).size).toBe(3)
})

test('the 100-item cap never drops an answer that was not sent', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  const sent: string[] = []
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await logAssumption($, 'Use port 8080')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A1' })
  for (let i = 0; i < 105; i++) await logAssumption($, `Filler ${i}`)
  await ui.press({ key: 'send' })
  expect(sent.at(-1)).toContain('A1 WRONG: Use port 8080')
  await ui.unmount()
})

// --- Saved list, Clear all, side-stack ---------------------------------------

type World = {
  kept: Record<string, unknown>
  opened: string[]
  closed: string[]
  sent: string[]
  host: { present: boolean }
  clock: ReturnType<typeof mock.clock>
}

/** The world beneath the plugin, with a store the test can read (mock.store
 *  does not hand its contents back) and a side-stack host that may be there. */
async function boot(
  $: Engine,
  on: On,
  options: { stored?: Record<string, unknown>; host?: boolean; ownPaneUp?: boolean; submit?: 'enter' | 'hang' } = {},
): Promise<World> {
  const world: World = {
    kept: { ...(options.stored ?? {}) },
    opened: [],
    closed: [],
    sent: [],
    host: { present: options.host ?? false },
    clock: mock.clock(on, { now: 1_000_000 }),
  }
  let ownPaneUp = options.ownPaneUp ?? false
  on('store.get', (_$, e) => ({ value: world.kept[(e as { key: string }).key] }) as never)
  on('store.set', (_$, e) => {
    const one = e as { key: string; value: unknown }
    world.kept[one.key] = JSON.parse(JSON.stringify(one.value))
    return { value: undefined } as never
  })
  // Stands for the side-stack plugin's value.
  on('state.get', { plugin: 'side-stack', key: 'present' }, () => ({ value: { value: world.host.present, version: 1 } }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__assumptions-pane__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async (_$, e) => {
    world.opened.push(e.id)
    if (e.id === 'assumptions') ownPaneUp = true
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', async () => ({ value: (ownPaneUp ? [{ id: 'assumptions' }] : []) as never }))
  on('ui.close', async (_$, e) => {
    world.closed.push(e.id)
    if (e.id === 'assumptions') ownPaneUp = false
    return { value: undefined } as never
  })
  on('prompt.submit', async (_$, e) => {
    world.sent.push(e.text)
    if (options.submit === 'hang') return new Promise(() => undefined) as never
    return { text: e.text }
  })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  return world
}

type Saved = { items: { id: string; text: string; verdict: string }[]; nextId: number }

// Buttons drawn in side-stack's pane belong to this plugin.
const AP = 'assumptions-pane'

const STACK = {
  plugin: 'side-stack',
  component: 'Pane',
  requestId: 'side-stack',
  props: { title: 'Stack', isFocused: false, bodyColumns: 44, placement: 'dock' } as never,
} as const

// Stands for the next section in the stack (another guest, or the host's own line).
const sectionBeneath = (on: On): void => {
  on('ui.render', { component: 'Pane', requestId: 'side-stack' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>NEXT-SECTION</Text>
  })
}

test('the list is saved per folder, with its numbering', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'Sort by date')
  await logAssumption($, 'Use tabs')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A1' })
  await ui.unmount()
  const saved = world.kept['assumptions:/tmp'] as Saved
  expect(saved.items.map(a => `${a.id} ${a.verdict}`)).toEqual(['A1 wrong', 'A2 open'])
  expect(saved.nextId).toBe(3)
})

test('after a /clear or a reload the saved list comes back and numbering goes on', async ($, on) => {
  // What the session before the /clear saved (the shape the test above checks).
  const stored = {
    'assumptions:/tmp': {
      items: [
        { id: 'A4', text: 'Keep the old logo', verdict: 'open', isSent: false },
        { id: 'A5', text: 'Use port 8080', verdict: 'wrong', isSent: false },
      ],
      nextId: 6,
    },
    'assumptions:/elsewhere': { items: [{ id: 'A1', text: 'Another folder', verdict: 'open', isSent: false }], nextId: 2 },
  }
  const world = await boot($, on, { stored })
  // A saved list opens the pane on its own.
  expect(world.opened).toContain('assumptions')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /A4 Keep the old logo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Another folder/ })).toBeUndefined()
  const logged = await logAssumption($, 'Use blue')
  expect(JSON.stringify(logged)).toContain('A6')
  // The unsent answer saved before the /clear still goes to Claude.
  await ui.press({ key: 'send' })
  expect(world.sent.at(-1)).toContain('A5 WRONG: Use port 8080')
  await ui.unmount()
})

test('Clear all needs two presses, and empties the saved list too', async ($, on) => {
  const stored = { 'assumptions:/tmp': { items: [{ id: 'A4', text: 'Keep the old logo', verdict: 'open', isSent: false }], nextId: 5 } }
  const world = await boot($, on, { stored })
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /A4 Keep the old logo/ })).toBeDefined()
  expect(await ui.find({ key: 'clear-yes' })).toBeDefined()
  await ui.press({ key: 'clear-no' })
  expect(await ui.find({ key: 'clear-yes' })).toBeUndefined()
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-yes' })
  expect(await ui.find({ type: 'Text', text: /Keep the old logo/ })).toBeUndefined()
  expect((world.kept['assumptions:/tmp'] as Saved).items).toEqual([])
  // Numbers keep counting after a clear.
  expect(JSON.stringify(await logAssumption($, 'Use blue'))).toContain('A5')
  await ui.unmount()
})

test('/assumptions clear empties the list and the store', async ($, on) => {
  const stored = { 'assumptions:/tmp': { items: [{ id: 'A4', text: 'Keep the old logo', verdict: 'open', isSent: false }], nextId: 5 } }
  const world = await boot($, on, { stored })
  const out = await $.command.run({ command: 'assumptions', args: 'clear' } as never)
  expect(JSON.stringify(out)).toContain('cleared')
  expect((world.kept['assumptions:/tmp'] as Saved).items).toEqual([])
})

test('a sent review leaves once its turn starts, even if the submit never settles', async ($, on) => {
  const stored = {
    'assumptions:/tmp': {
      items: [
        { id: 'A59', text: 'Turn off the notice', verdict: 'open', isSent: false },
        { id: 'A60', text: 'Use tabs', verdict: 'open', isSent: false },
      ],
      nextId: 61,
    },
  }
  const world = await boot($, on, { stored, submit: 'hang' })
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: 'wrong-A59' })
  await ui.press({ key: 'right-A60' })
  void ui.press({ key: 'send' })
  for (let i = 0; i < 400 && world.sent.length === 0; i++) await Promise.resolve()
  expect(world.sent.at(-1)).toContain('A59 WRONG')
  // A60 changed while the review waited: its new answer must stay to send again.
  await ui.press({ key: 'wrong-A60' })
  await $.turn.start({ turnId: 't2', text: `The assumptions-pane plugin sent a message: ${world.sent.at(-1)}` })
  expect(await ui.find({ type: 'Text', text: /Turn off the notice/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /A60 Use tabs/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for Claude/ })).toBeUndefined()
  expect((world.kept['assumptions:/tmp'] as Saved).items.map(a => a.id)).toEqual(['A60'])
  await ui.unmount()
})

test('with side-stack running: no own pane, a section in the Stack pane above the next one', async ($, on) => {
  sectionBeneath(on)
  const world = await boot($, on, { host: true, ownPaneUp: true })
  // The own pane opened before (a reload) is closed at start.
  expect(world.closed).toContain('assumptions')
  await logAssumption($, 'Sort by date')
  expect(world.opened).not.toContain('assumptions')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toBe('Assumptions')
    // next(e) is drawn too, beneath the section.
    expect(texts.at(-1)).toBe('NEXT-SECTION')
    await ui.unmount()
  }
  // The buttons work inside the stack, with keys that do not clash with other sections.
  const ui = await $.ui.mount({ ...STACK, surface: 'terminal' })
  await ui.press({ plugin: AP, key: 'as-toggle' })
  await ui.press({ plugin: AP, key: 'as-wrong-A1' })
  await ui.press({ plugin: AP, key: 'as-send' })
  expect(world.sent.at(-1)).toContain('A1 WRONG: Sort by date')
  expect(await ui.find({ type: 'Text', text: /NEXT-SECTION/ })).toBeDefined()
  await ui.unmount()
  expect(world.opened).not.toContain('assumptions')
  const out = await $.command.run({ command: 'assumptions', args: '' } as never)
  expect(JSON.stringify(out)).toContain('Stack pane')
})

test('in the stack the section keeps to its row budget', async ($, on) => {
  sectionBeneath(on)
  await boot($, on, { host: true })
  for (let i = 1; i <= 9; i++) await logAssumption($, `Choice ${i}`)
  const ui = await $.ui.mount({ ...STACK, surface: 'terminal' })
  await ui.press({ plugin: AP, key: 'as-toggle' })
  expect(await ui.find({ plugin: AP, key: 'as-right-A6' } as never)).toBeDefined()
  expect(await ui.find({ plugin: AP, key: 'as-right-A7' } as never)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\+3 more/ })).toBeDefined()
  // "All shown are right" never marks a row the person did not see.
  await ui.press({ plugin: AP, key: 'as-all-right' })
  await ui.press({ plugin: AP, key: 'as-send' })
  await ui.unmount()
  const ui2 = await $.ui.mount({ ...STACK, surface: 'terminal' })
  expect(await ui2.find({ plugin: AP, key: 'as-right-A7' } as never)).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: /\+3 more/ })).toBeUndefined()
  await ui2.unmount()
})

test('without side-stack nothing changes: own pane, nothing drawn in the stack', async ($, on) => {
  sectionBeneath(on)
  const world = await boot($, on, { host: false })
  await logAssumption($, 'Sort by date')
  expect(world.opened).toContain('assumptions')
  const ui = await $.ui.mount({ ...STACK, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toEqual(['NEXT-SECTION'])
  await ui.unmount()
})

test('side-stack starting after this plugin is seen a second later', async ($, on) => {
  const world = await boot($, on, { host: false })
  await logAssumption($, 'Sort by date')
  expect(world.opened).toContain('assumptions')
  world.host.present = true
  await world.clock.advance(1000)
  expect(world.closed).toContain('assumptions')
})
