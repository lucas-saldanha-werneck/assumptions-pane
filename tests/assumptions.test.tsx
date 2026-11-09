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
// Every drawing below runs on both the terminal and the desktop app.

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

type World = {
  kept: Record<string, unknown>
  sets: { key: string; value: unknown }[]
  opened: string[]
  closed: string[]
  sent: string[]
  logs: string[]
  stackRuns: number
  host: { present: boolean; command: boolean }
  clock: ReturnType<typeof mock.clock>
  session: { id: string }
}

/** The world beneath the plugin, with a store the test can read (mock.store
 *  does not hand its contents back) and a side-stack host that may be there:
 *  its `present` value and its live /stack command, each on its own. */
async function boot(
  $: Engine,
  on: On,
  options: {
    stored?: Record<string, unknown>
    host?: boolean
    hostCommand?: boolean
    ownPaneUp?: boolean
    submit?: 'enter' | 'hang'
    storeBroken?: boolean
    /** false: no session.start under this session id (fresh state, as after a /clear). */
    start?: boolean
  } = {},
): Promise<World> {
  const world: World = {
    kept: { ...(options.stored ?? {}) },
    sets: [],
    opened: [],
    closed: [],
    sent: [],
    logs: [],
    stackRuns: 0,
    host: { present: options.host ?? false, command: options.hostCommand ?? options.host ?? false },
    clock: mock.clock(on, { now: 1_000_000 }),
    session: { id: 's1' },
  }
  on('session.id', () => ({ value: world.session.id }) as never)
  on('session.cwd', () => ({ value: '/tmp' }) as never)
  let ownPaneUp = options.ownPaneUp ?? false
  on('store.get', (_$, e) => ({ value: world.kept[(e as { key: string }).key] }) as never)
  on('store.set', (_$, e) => {
    if (options.storeBroken === true) throw new Error('store full')
    const one = e as { key: string; value: unknown }
    world.kept[one.key] = JSON.parse(JSON.stringify(one.value))
    world.sets.push({ key: one.key, value: world.kept[one.key] })
    return { value: undefined } as never
  })
  // Stands for side-stack's /stack command. (Its `present` state value is per
  // session and gone after a /clear, so the mod does not read it; host.present
  // only records what side-stack would say.)
  on('command.list', () =>
    ({
      value: [
        { name: 'help', description: 'Help', source: 'builtin' },
        ...(world.host.command ? [{ name: 'stack', description: 'Open the Stack side pane', source: 'plugin', plugin: 'side-stack@side-stack' }] : []),
      ],
    }) as never,
  )
  on('command.run', { command: 'stack' }, () => {
    world.stackRuns++
    return { text: 'Stack pane opened.' }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__assumptions-pane__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', (_$, e) => {
    world.logs.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
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
  if (options.start !== false) await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  return world
}

type Saved = { items: { id: string; text: string; verdict: string; correction?: string }[]; nextId: number; clearedAt?: number }
const savedAt = (world: World, key = 'assumptions:/tmp'): Saved => world.kept[key] as Saved

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

const one = (id: string, text: string, verdict = 'open', extra: object = {}) => ({ id, text, verdict, isSent: false, ...extra })
const ownPane = ($: Engine, surface: Surface) => $.ui.mount({ plugin: AP, surface, ...PANE })
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

for (const surface of SURFACES) {
  test(`the list is saved per folder, with its numbering (${surface})`, async ($, on) => {
    const world = await boot($, on)
    await logAssumption($, 'Sort by date')
    await logAssumption($, 'Use tabs')
    const ui = await ownPane($, surface)
    await ui.press({ key: 'toggle' })
    await ui.press({ key: 'wrong-A1' })
    await ui.unmount()
    const saved = savedAt(world)
    expect(saved.items.map(a => `${a.id} ${a.verdict}`)).toEqual(['A1 wrong', 'A2 open'])
    expect(saved.nextId).toBe(3)
  })

  test(`a new session in the same folder gets the saved list back and numbering goes on (${surface})`, async ($, on) => {
    const stored = {
      'assumptions:/tmp': { items: [one('A4', 'Keep the old logo'), one('A5', 'Use port 8080', 'wrong')], nextId: 6 },
      'assumptions:/elsewhere': { items: [one('A1', 'Another folder')], nextId: 2 },
    }
    const world = await boot($, on, { stored })
    // A saved list opens the pane on its own.
    expect(world.opened).toContain('assumptions')
    const ui = await ownPane($, surface)
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /A4 Keep the old logo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Another folder/ })).toBeUndefined()
    expect(JSON.stringify(await logAssumption($, 'Use blue'))).toContain('A6')
    // The unsent answer saved before still goes to Claude.
    await ui.press({ key: 'send' })
    expect(world.sent.at(-1)).toContain('A5 WRONG: Use port 8080')
    await ui.unmount()
  })

  test(`XR2 Clear all: a double press lands on Cancel, Yes clears, the question expires (${surface})`, async ($, on) => {
    const stored = { 'assumptions:/tmp': { items: [one('A4', 'Keep', 'wrong')], nextId: 5 } }
    const world = await boot($, on, { stored })
    const ui = await ownPane($, surface)
    await ui.press({ key: 'toggle' })
    const keys = async () => (await ui.findAll({ type: 'Button' } as never)).map(b => (b as { key?: string }).key)
    const before = await keys()
    await ui.press({ key: 'clear' })
    const after = await keys()
    // The slot "Clear all" had now holds Cancel, so a second press there cancels.
    expect(after[before.indexOf('clear')]).toBe('clear-no')
    await ui.press({ key: after[before.indexOf('clear')] as string })
    expect(await ui.find({ type: 'Text', text: /A4 Keep/ })).toBeDefined()
    expect(await ui.find({ key: 'clear' })).toBeDefined()
    // Asked and left alone, the question goes away after 5 seconds.
    await ui.press({ key: 'clear' })
    await world.clock.advance(5000)
    expect(await ui.find({ key: 'clear-yes' })).toBeUndefined()
    // Asked and confirmed: empty, saved empty, numbers go on.
    await ui.press({ key: 'clear' })
    await ui.press({ key: 'clear-yes' })
    expect(await ui.find({ type: 'Text', text: /A4 Keep/ })).toBeUndefined()
    expect(savedAt(world).items).toEqual([])
    expect(JSON.stringify(await logAssumption($, 'Use blue'))).toContain('A5')
    await ui.unmount()
  })

  test(`a sent review leaves once its turn starts, even if the submit never settles (${surface})`, async ($, on) => {
    const stored = { 'assumptions:/tmp': { items: [one('A59', 'Turn off the notice'), one('A60', 'Use tabs')], nextId: 61 } }
    const world = await boot($, on, { stored, submit: 'hang' })
    const ui = await ownPane($, surface)
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
    expect(savedAt(world).items.map(a => a.id)).toEqual(['A60'])
    await ui.unmount()
  })

  test(`XR3 an assumption with line breaks leaves once its review enters, and is sent once (${surface})`, async ($, on) => {
    const world = await boot($, on, { submit: 'hang' })
    await logAssumption($, 'Use port 8080\nand   host 0.0.0.0')
    const ui = await ownPane($, surface)
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /A1 Use port 8080 and host 0\.0\.0\.0/ })).toBeDefined()
    await ui.press({ key: 'wrong-A1' })
    void ui.press({ key: 'send' })
    for (let i = 0; i < 400 && world.sent.length === 0; i++) await Promise.resolve()
    await $.turn.start({ turnId: 't2', text: world.sent.at(-1) as string })
    expect(await ui.find({ type: 'Text', text: /A1 Use port/ })).toBeUndefined()
    expect(await ui.find({ key: 'send' })).toBeUndefined()
    await settle()
    expect(world.sent.length).toBe(1)
    await ui.unmount()
  })

  test(`with side-stack running: a section in the Stack pane above the next one, own pane one line (${surface})`, async ($, on) => {
    sectionBeneath(on)
    const world = await boot($, on, { host: true, ownPaneUp: true })
    // The own pane opened before (a reload) is closed at start.
    expect(world.closed).toContain('assumptions')
    await logAssumption($, 'Sort by date')
    expect(world.opened).not.toContain('assumptions')
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toBe('Assumptions')
    // next(e) is drawn too, beneath the section.
    expect(texts.at(-1)).toBe('NEXT-SECTION')
    // The buttons work inside the stack, with keys that do not clash with other sections.
    await ui.press({ plugin: AP, key: 'as-toggle' })
    await ui.press({ plugin: AP, key: 'as-wrong-A1' })
    await ui.press({ plugin: AP, key: 'as-send' })
    expect(world.sent.at(-1)).toContain('A1 WRONG: Sort by date')
    expect(await ui.find({ type: 'Text', text: /NEXT-SECTION/ })).toBeDefined()
    await ui.unmount()
    // An own pane still drawn somewhere shows one line, never the list twice.
    const own = await ownPane($, surface)
    expect((await own.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Shown in the Stack pane (/stack)'])
    expect(await own.find({ key: 'toggle' })).toBeUndefined()
    await own.unmount()
    expect(world.opened).not.toContain('assumptions')
  })

  test(`in the stack the section keeps to its row budget (${surface})`, async ($, on) => {
    sectionBeneath(on)
    await boot($, on, { host: true })
    for (let i = 1; i <= 9; i++) await logAssumption($, `Choice ${i}`)
    const ui = await $.ui.mount({ ...STACK, surface })
    await ui.press({ plugin: AP, key: 'as-toggle' })
    expect(await ui.find({ plugin: AP, key: 'as-right-A6' } as never)).toBeDefined()
    expect(await ui.find({ plugin: AP, key: 'as-right-A7' } as never)).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /\+3 more/ })).toBeDefined()
    // "All shown are right" never marks a row the person did not see.
    await ui.press({ plugin: AP, key: 'as-all-right' })
    await ui.press({ plugin: AP, key: 'as-send' })
    await ui.unmount()
    const ui2 = await $.ui.mount({ ...STACK, surface })
    expect(await ui2.find({ plugin: AP, key: 'as-right-A7' } as never)).toBeDefined()
    expect(await ui2.find({ type: 'Text', text: /\+3 more/ })).toBeUndefined()
    await ui2.unmount()
  })

  test(`without side-stack nothing changes: own pane, nothing drawn in the stack (${surface})`, async ($, on) => {
    sectionBeneath(on)
    const world = await boot($, on, { host: false })
    await logAssumption($, 'Sort by date')
    expect(world.opened).toContain('assumptions')
    expect(world.stackRuns).toBe(0)
    const ui = await $.ui.mount({ ...STACK, surface })
    expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['NEXT-SECTION'])
    await ui.unmount()
    const own = await ownPane($, surface)
    expect(await own.find({ type: 'Text', text: /1 assumptions, 1 open/ })).toBeDefined()
    await own.unmount()
  })
}

test('/assumptions clear empties the list and the store', async ($, on) => {
  const world = await boot($, on, { stored: { 'assumptions:/tmp': { items: [one('A4', 'Keep the old logo')], nextId: 5 } } })
  const out = await $.command.run({ command: 'assumptions', args: 'clear' } as never)
  expect(JSON.stringify(out)).toContain('cleared')
  expect(savedAt(world).items).toEqual([])
  expect(savedAt(world).nextId).toBe(5)
})

test('XR1 another session in the same folder: its items are kept and its numbers are not reused', async ($, on) => {
  const world = await boot($, on, { stored: { 'assumptions:/tmp': { items: [one('A1', 'Old')], nextId: 2 } } })
  // Another session in /tmp logs A2 and saves.
  world.kept['assumptions:/tmp'] = { items: [one('A1', 'Old'), one('A2', 'Other session', 'wrong', { at: 2_000_000 })], nextId: 3 }
  const r = await logAssumption($, 'Mine')
  expect(JSON.stringify(r)).toContain('A3')
  expect(savedAt(world).items.map(a => `${a.id} ${a.text}`)).toEqual(['A1 Old', 'A2 Other session', 'A3 Mine'])
  expect(savedAt(world).nextId).toBe(4)
})

test("another session's Clear all is not undone by this session's stale list", async ($, on) => {
  const world = await boot($, on, { stored: { 'assumptions:/tmp': { items: [one('A1', 'Old', 'open', { at: 1_000_000 })], nextId: 2 } } })
  // The other session cleared the folder after this one loaded it.
  world.kept['assumptions:/tmp'] = { items: [], nextId: 2, clearedAt: 1_500_000 }
  await world.clock.advance(600_000)
  await logAssumption($, 'After the clear')
  expect(savedAt(world).items.map(a => a.id)).toEqual(['A2'])
})

test('a /clear (session end, no new session.start) keeps the list and never saves it empty', async ($, on) => {
  const world = await boot($, on, { stored: { 'assumptions:/tmp': { items: [one('A1', 'Keep me')], nextId: 2 } } })
  await logAssumption($, 'Before the clear')
  // The docs: a /clear raises session.end with reason "clear"; the process goes on, no session.start follows.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await $.turn.start({ turnId: 't9', text: 'next job' })
  expect(JSON.stringify(await logAssumption($, 'After the clear'))).toContain('A3')
  expect(savedAt(world).items.map(a => a.id)).toEqual(['A1', 'A2', 'A3'])
  expect(world.sets.every(s => (s.value as Saved).items.length > 0)).toBe(true)
  const ui = await ownPane($, 'desktop')
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /A1 Keep me/ })).toBeDefined()
  await ui.unmount()
})

test('a store that cannot be written is said once, and the list still works', async ($, on) => {
  const world = await boot($, on, { storeBroken: true })
  await logAssumption($, 'One')
  await logAssumption($, 'Two')
  expect(world.logs.filter(l => l.includes('could not be saved')).length).toBe(1)
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'right-A2' })).toBeDefined()
  await ui.unmount()
})

test('a side-stack flag without its /stack command counts as absent', async ($, on) => {
  sectionBeneath(on)
  const world = await boot($, on, { host: true, hostCommand: false })
  await logAssumption($, 'Sort by date')
  expect(world.opened).toContain('assumptions')
  const ui = await $.ui.mount({ ...STACK, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['NEXT-SECTION'])
  await ui.unmount()
})

test('stacked, a new assumption brings the Stack pane up only when it is not open', async ($, on) => {
  await boot($, on, { host: true }).then(async world => {
    await logAssumption($, 'First')
    await world.clock.advance(1)
    expect(world.stackRuns).toBe(1)
    await logAssumption($, 'Second')
    await world.clock.advance(1)
    expect(world.stackRuns).toBe(1)
    // (Reopening after the person closes it follows side-stack's ui.close; the
    // test engine cannot raise another plugin's close, so that part is not tested.)
    expect(world.opened).not.toContain('assumptions')
  })
})

test('side-stack starting after this plugin is seen within about a second', async ($, on) => {
  const world = await boot($, on, { host: false })
  await logAssumption($, 'Sort by date')
  expect(world.opened).toContain('assumptions')
  world.host.present = true
  world.host.command = true
  await world.clock.advance(1100)
  expect(world.closed).toContain('assumptions')
})

test('side-stack going away brings the own pane back on the next assumption', async ($, on) => {
  const world = await boot($, on, { host: true })
  await logAssumption($, 'First')
  expect(world.opened).not.toContain('assumptions')
  world.host.command = false
  await logAssumption($, 'Second')
  expect(world.opened).toContain('assumptions')
})

// v3: what a real /clear does, per the docs (SessionEndInput): the session ends
// with reason "clear", the process goes on under a NEW session id, no
// session.start fires, and session state (this plugin's and side-stack's
// `present`) does not carry over. The test kit cannot wipe a plugin's state
// (the test's $ has no $.state, and a test-held state stops redraws), so it is
// shown in two halves: A, the sequence itself; B, what the plugin meets after
// it, fresh state under a new id with no session.start and the list only in
// the store.
for (const surface of SURFACES) {
  test(`A: after the /clear sequence the list is in the stack, not in an own pane (${surface})`, async ($, on) => {
    sectionBeneath(on)
    const world = await boot($, on, { host: true })
    await logAssumption($, 'teste')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
    world.session.id = 's2'
    world.host.present = false
    // Another session saved one more meanwhile: the reload under s2 brings it in.
    world.kept['assumptions:/tmp'] = { items: [one('A1', 'teste'), one('A2', 'outra', 'open', { at: 2_000_000 })], nextId: 3 }
    await $.prompt.submit(TYPED)
    await $.turn.start({ turnId: 't2', text: 'go on' })
    expect(world.opened).not.toContain('assumptions')
    const ui = await $.ui.mount({ ...STACK, surface })
    await ui.press({ plugin: AP, key: 'as-toggle' })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toBe('Assumptions')
    expect(texts.join('|')).toContain('A1 teste')
    expect(texts.join('|')).toContain('A2 outra')
    expect(texts.at(-1)).toBe('NEXT-SECTION')
    await ui.unmount()
    expect(JSON.stringify(await logAssumption($, 'depois'))).toContain('A3')
  })

  test(`B: fresh state under a new id, no session.start: the saved list is back, in the stack (${surface})`, async ($, on) => {
    sectionBeneath(on)
    const stored = { 'assumptions:/tmp': { items: [one('A1', 'teste')], nextId: 2 } }
    const world = await boot($, on, { stored, host: false, hostCommand: true, start: false })
    world.session.id = 's2-fresh'
    // Before any prompt, the drawing reads the store.
    const early = await $.ui.mount({ ...STACK, surface })
    const earlyTexts = (await early.findAll({ type: 'Text' })).map(t => t.text)
    expect(earlyTexts[0]).toBe('Assumptions')
    expect(earlyTexts).toContain('1, 1 open')
    expect(earlyTexts.at(-1)).toBe('NEXT-SECTION')
    await early.unmount()
    // A prompt and its turn load it into state; buttons and review work.
    await $.prompt.submit(TYPED)
    await $.turn.start({ turnId: 't2', text: 'go on' })
    expect(world.opened).not.toContain('assumptions')
    const ui = await $.ui.mount({ ...STACK, surface })
    await ui.press({ plugin: AP, key: 'as-toggle' })
    expect(await ui.find({ type: 'Text', text: /A1 teste/ })).toBeDefined()
    await ui.press({ plugin: AP, key: 'as-wrong-A1' })
    await ui.press({ plugin: AP, key: 'as-send' })
    expect(world.sent.at(-1)).toContain('A1 WRONG: teste')
    await ui.unmount()
    expect(JSON.stringify(await logAssumption($, 'depois'))).toContain('A2')
    // The fresh, empty state never overwrote the saved list: the first save under s2 kept A1.
    expect((world.sets[0]?.value as Saved).items.map(x => x.id)).toEqual(['A1'])
  })

  test(`B: fresh state under a new id without side-stack: the own pane shows the saved list (${surface})`, async ($, on) => {
    const stored = { 'assumptions:/tmp': { items: [one('A1', 'teste')], nextId: 2 } }
    const world = await boot($, on, { stored, start: false })
    world.session.id = 's2-alone'
    const early = await ownPane($, surface)
    expect(await early.find({ type: 'Text', text: /1 assumptions, 1 open/ })).toBeDefined()
    await early.unmount()
    await $.turn.start({ turnId: 't2', text: 'go on' })
    expect(world.opened).toContain('assumptions')
    const ui = await ownPane($, surface)
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ type: 'Text', text: /A1 teste/ })).toBeDefined()
    await ui.unmount()
  })
}

test('side-stack counts as running from its /stack command alone (its flag is gone after /clear)', async ($, on) => {
  sectionBeneath(on)
  const world = await boot($, on, { host: false, hostCommand: true })
  await logAssumption($, 'Sort by date')
  expect(world.opened).not.toContain('assumptions')
  const ui = await $.ui.mount({ ...STACK, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)[0]).toBe('Assumptions')
  await ui.unmount()
})

// v4: side-stack may set an order. It then leaves an empty Box keyed
// `side-stack:slot:assumptions-pane` where this section goes; with no slot
// the section goes on top of what is beneath, as before.
const stackBeneathWithSlot = (on: On): void => {
  on('ui.render', { component: 'Pane', requestId: 'side-stack' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text>EARLIER-SECTION</Text>
        <Box key="side-stack:slot:assumptions-pane" flexDirection="column" />
        <Text>LATER-SECTION</Text>
      </Box>
    )
  })
}

for (const surface of SURFACES) {
  test(`a slot side-stack left is filled by the section, in its place (${surface})`, async ($, on) => {
    stackBeneathWithSlot(on)
    const world = await boot($, on, { host: true })
    await logAssumption($, 'Sort by date')
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toEqual(['EARLIER-SECTION', 'Assumptions', '1, 1 open', 'LATER-SECTION'])
    // The buttons work in that place too.
    await ui.press({ plugin: AP, key: 'as-toggle' })
    await ui.press({ plugin: AP, key: 'as-wrong-A1' })
    await ui.press({ plugin: AP, key: 'as-send' })
    expect(world.sent.at(-1)).toContain('A1 WRONG: Sort by date')
    const after = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(after[0]).toBe('EARLIER-SECTION')
    expect(after.at(-1)).toBe('LATER-SECTION')
    expect(after.filter(t => t === 'Assumptions').length).toBe(1)
    await ui.unmount()
  })

  test(`with no slot the section goes on top of the sections beneath, as before (${surface})`, async ($, on) => {
    sectionBeneath(on)
    await boot($, on, { host: true })
    await logAssumption($, 'Sort by date')
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toEqual(['Assumptions', '1, 1 open', 'NEXT-SECTION'])
    await ui.unmount()
  })
}
