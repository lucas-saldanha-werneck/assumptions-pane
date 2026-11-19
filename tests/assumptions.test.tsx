import { describe, expect, mock, test } from 'claude-code/testing'

import { parsePhoneReply } from '../hooks/phone'
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
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: 'Assumptions · 1 open' })).toBeDefined()
    if (surface === 'terminal') {
      await ui.press({ key: 'wrong-A1' })
      await ui.press({ key: 'edit-A1' })
      await ui.input({ key: 'fix-A1', text: 'Sort by name' })
      await ui.press({ key: 'send' })
      expect(sent.at(-1)).toContain('A1 CHANGE: Sort by date, newest first -> Sort by name')
      expect(await ui.find({ key: 'right-A1' })).toBeUndefined()
      // Empty: one heading line, nothing to show or hide.
      expect(await ui.find({ type: 'Text', text: 'Assumptions · 0' })).toBeDefined()
      expect(await ui.find({ key: 'toggle' })).toBeUndefined()
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
  await ui.press({ key: 'wrong-A1' })
  await ui.press({ key: 'send' })
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A1 Two T4 fields/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  waiting$/ })).toBeUndefined()
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
  await ui.press({ key: 'right-A1' })
  await ui.press({ key: 'right-A2' })
  const sending = ui.press({ key: 'send' })
  // Let the queued submit reach the gate, then change A1 while it waits.
  for (let i = 0; i < 1000 && sent.length === 0; i++) await Promise.resolve()
  expect(sent[0]).toContain('- A1 RIGHT')
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
  contexts: string[][]
  logs: string[]
  toasts: string[]
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
    submit?: 'enter' | 'hang' | 'drop'
    storeBroken?: boolean
    /** false: no session.start under this session id (fresh state, as after a /clear). */
    start?: boolean
    /** The first N store reads fail (a reload that does not land). */
    storeGetFails?: number
    /** The first N store writes fail as if another session held the lock. */
    storeLockedFor?: number
    /** The folder session.start reports (the shell's folder at a reload). */
    cwd?: string
    /** Session state already there (a reload of the module keeps it), by key. */
    state?: Record<string, unknown>
    /** The process environment the mod reads (CLAUDE_PID, CLAUDE_SUB_PARENT, CLAUDE_SUB_NAME). */
    env?: Record<string, string>
  } = {},
): Promise<World> {
  const world: World = {
    kept: { ...(options.stored ?? {}) },
    sets: [],
    opened: [],
    closed: [],
    sent: [],
    contexts: [],
    logs: [],
    toasts: [],
    stackRuns: 0,
    host: { present: options.host ?? false, command: options.hostCommand ?? options.host ?? false },
    clock: mock.clock(on, { now: 1_000_000 }),
    session: { id: 's1' },
  }
  on('session.id', () => ({ value: world.session.id }) as never)
  on('session.cwd', () => ({ value: '/tmp' }) as never)
  let ownPaneUp = options.ownPaneUp ?? false
  // side-stack's pane, opened by its /stack command.
  let stackUp = false
  let getFails = options.storeGetFails ?? 0
  on('store.get', (_$, e) => {
    if (getFails > 0) {
      getFails--
      throw new Error('store busy')
    }
    return { value: world.kept[(e as { key: string }).key] } as never
  })
  on('store.keys', () => ({ value: Object.keys(world.kept) }) as never)
  // CLAUDE_PID reaches a plugin through hookEnv (the engine sets it for its children only);
  // CLAUDE_SUB_* are in the process environment claude-sub started it with.
  on('env.get', (_$, e) => {
    const name = (e as { name: string }).name
    return { value: name === 'CLAUDE_PID' ? undefined : options.env?.[name] } as never
  })
  on('process.hookEnv', () => ({ value: options.env?.CLAUDE_PID !== undefined ? { CLAUDE_PID: options.env.CLAUDE_PID } : {} }) as never)
  let lockedFor = options.storeLockedFor ?? 0
  on('store.set', (_$, e) => {
    if (options.storeBroken === true) throw new Error('store full')
    if (lockedFor > 0) {
      lockedFor--
      throw new Error('$.store.set failed: Lock file is already being held')
    }
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
    stackUp = true
    return { text: 'Stack pane opened.' }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__assumptions-pane__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  if (options.state !== undefined) {
    const state: Record<string, { value: unknown; version: number }> = {}
    for (const [k, v] of Object.entries(options.state)) state[`assumptions-pane.${k}`] = { value: v, version: 1 }
    on('state.get', async (_$, e) => {
      const a = e as { plugin: string; key: string }
      return { value: state[`${a.plugin}.${a.key}`] ?? { value: undefined, version: 0 } } as never
    })
    on('state.set', async (_$, e) => {
      const a = e as { plugin: string; key: string; value: unknown }
      const version = (state[`${a.plugin}.${a.key}`]?.version ?? 0) + 1
      state[`${a.plugin}.${a.key}`] = { value: a.value, version }
      return { value: { isSet: true, version } } as never
    })
  }
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
  on('ui.panes', async () => ({ value: [...(ownPaneUp ? [{ id: 'assumptions' }] : []), ...(stackUp ? [{ id: 'side-stack' }] : [])] as never }))
  on('ui.close', async (_$, e) => {
    world.closed.push(e.id)
    if (e.id === 'assumptions') ownPaneUp = false
    return { value: undefined } as never
  })
  on('prompt.submit', async (_$, e) => {
    world.sent.push(e.text)
    world.contexts.push([...(e.context ?? [])])
    if (options.submit === 'hang') return new Promise(() => undefined) as never
    if (options.submit === 'drop') return { drop: 'blocked by a hook' } as never
    return { text: e.text }
  })
  if (options.start !== false) await $.session.start({ cwd: options.cwd ?? '/tmp', surface: 'terminal', isInteractive: true })
  return world
}

type Saved = { items: { id: string; text: string; verdict: string; correction?: string }[]; nextId: number; clearedAt?: number }
const savedAt = (world: World, key = 'assumptions:/tmp'): Saved => world.kept[key] as Saved

/** The texts as a reader sees the section: the heading once (not its dim part or its divider line). */
const sectionTexts = (texts: string[]): string[] => texts.filter(t => !t.startsWith(' · ') && !/^─+$/.test(t))

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
    expect(await ui.find({ type: 'Text', text: /^  waiting$/ })).toBeUndefined()
    expect(savedAt(world).items.map(a => a.id)).toEqual(['A60'])
    await ui.unmount()
  })

  test(`XR3 an assumption with line breaks leaves once its review enters, and is sent once (${surface})`, async ($, on) => {
    const world = await boot($, on, { submit: 'hang' })
    await logAssumption($, 'Use port 8080\nand   host 0.0.0.0')
    const ui = await ownPane($, surface)
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
    expect(texts[0]).toMatch(/^Assumptions · \d+ open$/)
    // next(e) is drawn too, beneath the section.
    expect(texts.at(-1)).toBe('NEXT-SECTION')
    // The buttons work inside the stack, with keys that do not clash with other sections.
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
    expect(await own.find({ type: 'Text', text: /^Assumptions · 1 open$/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /A1 Keep me/ })).toBeDefined()
  await ui.unmount()
})

test('a store that cannot be written is said once, and the list still works', async ($, on) => {
  const world = await boot($, on, { storeBroken: true })
  await logAssumption($, 'One')
  await logAssumption($, 'Two')
  // Said only after the retries ran out.
  expect(world.logs.filter(l => l.includes('could not be saved')).length).toBe(0)
  for (let i = 0; i < 60; i++) await world.clock.advance(100)
  expect(world.logs.filter(l => l.includes('could not be saved')).length).toBe(1)
  const ui = await ownPane($, 'terminal')
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
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toMatch(/^Assumptions · \d+ open$/)
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
    expect(earlyTexts[0]).toMatch(/^Assumptions · \d+ open$/)
    expect(earlyTexts[0]).toBe('Assumptions · 1 open')
    expect(earlyTexts.at(-1)).toBe('NEXT-SECTION')
    await early.unmount()
    // A prompt and its turn load it into state; buttons and review work.
    await $.prompt.submit(TYPED)
    await $.turn.start({ turnId: 't2', text: 'go on' })
    expect(world.opened).not.toContain('assumptions')
    const ui = await $.ui.mount({ ...STACK, surface })
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
    expect(await early.find({ type: 'Text', text: /^Assumptions · 1 open$/ })).toBeDefined()
    await early.unmount()
    await $.turn.start({ turnId: 't2', text: 'go on' })
    expect(world.opened).toContain('assumptions')
    const ui = await ownPane($, surface)
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
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)[0]).toMatch(/^Assumptions · \d+ open$/)
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
    const seen = sectionTexts(texts)
    expect(seen.slice(0, 2)).toEqual(['EARLIER-SECTION', 'Assumptions · 1 open'])
    expect(seen.at(-1)).toBe('LATER-SECTION')
    // A new assumption opens the list.
    expect(seen.some(t => /A1 Sort by date/.test(t))).toBe(true)
    // The buttons work in that place too.
    await ui.press({ plugin: AP, key: 'as-wrong-A1' })
    await ui.press({ plugin: AP, key: 'as-send' })
    expect(world.sent.at(-1)).toContain('A1 WRONG: Sort by date')
    const after = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(after[0]).toBe('EARLIER-SECTION')
    expect(after.at(-1)).toBe('LATER-SECTION')
    expect(after.filter(t => t.startsWith('Assumptions')).length).toBe(1)
    await ui.unmount()
  })

  test(`with no slot the section goes on top of the sections beneath, as before (${surface})`, async ($, on) => {
    sectionBeneath(on)
    await boot($, on, { host: true })
    await logAssumption($, 'Sort by date')
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const seen = sectionTexts(texts)
    expect(seen[0]).toBe('Assumptions · 1 open')
    expect(seen.at(-1)).toBe('NEXT-SECTION')
    await ui.unmount()
  })
}

// v5: after a real /clear the engine refused the reload's writes (it ran from a
// timer started while drawing). The id was already recorded, so the reload was
// never tried again and the section stayed gone. A reload that fails must be
// tried again on the next event.
for (const surface of SURFACES) {
  test(`a reload after /clear that fails is tried again on the next event (${surface})`, async ($, on) => {
    sectionBeneath(on)
    const stored = { 'assumptions:/tmp': { items: [one('A1', 'teste'), one('A2', 'outra')], nextId: 3 } }
    const world = await boot($, on, { stored, host: false, hostCommand: true, start: false, storeGetFails: 1 })
    world.session.id = 's2-retry'
    await $.prompt.submit(TYPED)
    await $.turn.start({ turnId: 't2', text: 'go on' })
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toMatch(/^Assumptions · \d+ open$/)
    expect(texts[0]).toBe('Assumptions · 2 open')
    expect(await ui.find({ type: 'Text', text: /A2 outra/ })).toBeDefined()
    await ui.unmount()
    expect(JSON.stringify(await logAssumption($, 'depois'))).toContain('A3')
  })
}

// The race seen on 2.1.319: after a /clear, events can reach the mod under the
// NEW session id BEFORE session state is emptied. A reload done in that window
// must not count once the state empties: the next event loads again, so the
// section stays in the stack with the saved list.
for (const surface of SURFACES) {
  test(`a reload made before the state empties at a /clear is done again (${surface})`, async ($, on) => {
    sectionBeneath(on)
    let state: Record<string, { value: unknown; version: number }> = {}
    on('state.get', async (_$, e) => {
      const a = e as { plugin: string; key: string }
      return { value: state[`${a.plugin}.${a.key}`] ?? { value: undefined, version: 0 } } as never
    })
    on('state.set', async (_$, e) => {
      const a = e as { plugin: string; key: string; value: unknown }
      const version = (state[`${a.plugin}.${a.key}`]?.version ?? 0) + 1
      state[`${a.plugin}.${a.key}`] = { value: a.value, version }
      return { value: { isSet: true, version } } as never
    })
    const stored = { 'assumptions:/tmp': { items: [one('A1', 'teste'), one('A2', 'outra')], nextId: 3 } }
    const world = await boot($, on, { stored, host: false, hostCommand: true })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    world.session.id = 's2-late'
    await $.prompt.submit(TYPED) // reaches the mod under the new id, state not emptied yet
    state = {} // now the engine empties session state
    await $.prompt.submit(TYPED)
    await $.turn.start({ turnId: 't2', text: 'go on' })
    const ui = await $.ui.mount({ ...STACK, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toMatch(/^Assumptions · \d+ open$/)
    expect(texts[0]).toBe('Assumptions · 2 open')
    await ui.unmount()
  })
}

// --- Audit round 2 -------------------------------------------------------------

type SavedFull = Saved & { removed?: string[]; owners?: Record<string, number>; floor?: number }
const full = (world: World): SavedFull => savedAt(world) as SavedFull

test('AP-01 a slash command does not carry the review, and the answers stay', async ($, on) => {
  const world = await boot($, on)
  const seen = world.contexts
  await logAssumption($, 'Use port 8080')
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'wrong-A1' })
  await $.prompt.submit({ text: '/model', wait: false, origin: { kind: 'composer' as const }, command: { name: 'model', args: '' } } as never)
  expect(seen.at(-1)?.join('\n') ?? '').not.toContain('A1 WRONG')
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  await $.prompt.submit(TYPED)
  expect(seen.at(-1)?.join('\n')).toContain('A1 WRONG: Use port 8080')
  expect(await ui.find({ key: 'right-A1' })).toBeUndefined()
  expect(world.sent.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('AP-02 two sessions that hand out the same number keep both assumptions', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'Mine')
  // Another live session minted A1 at the same moment and saved after us.
  const now = 1_000_000
  world.kept['assumptions:/tmp'] = {
    items: [one('A1', 'Theirs', 'open', { at: now + 5, owner: 'other' })],
    nextId: 2,
    owners: { other: now },
  }
  await logAssumption($, 'Second of mine')
  const texts = full(world).items.map(a => a.text)
  expect(texts).toContain('Mine')
  expect(texts).toContain('Theirs')
  expect(texts).toContain('Second of mine')
  // This session's heartbeat is saved next to the other one's.
  expect(Object.keys(full(world).owners ?? {}).length).toBe(2)
})

test('AP-03 an emptied list is saved with the ids that left', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'Use port 8080')
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'wrong-A1' })
  await ui.press({ key: 'send' })
  await ui.unmount()
  expect(full(world).items).toEqual([])
  expect((full(world).removed ?? []).some(r => r === 'A1' || r.startsWith('A1@'))).toBe(true)
})

test('AP-04 Clear all records the ids it cleared, so a stale copy cannot bring them back', async ($, on) => {
  const world = await boot($, on, { stored: { 'assumptions:/tmp': { items: [one('A1', 'Old', 'open', { at: 1_000_000 })], nextId: 2 } } })
  await $.command.run({ command: 'assumptions', args: 'clear' } as never)
  expect(full(world).removed ?? []).toContain('A1')
  // A stale session (it still holds A1) answers it later and saves: A1 must not come back.
  const stale = { ...one('A1', 'Old', 'wrong'), at: 9_000_000 }
  const cur = full(world)
  world.kept['assumptions:/tmp'] = { ...cur, items: [stale] }
  await logAssumption($, 'After')
  expect(full(world).items.map(a => a.id)).toEqual(['A2'])
})

test("AP-05 another live session's answer is not sent to this Claude; a closed session's is", async ($, on) => {
  const world = await boot($, on, {
    stored: {
      'assumptions:/tmp': {
        items: [one('A1', 'Theirs', 'wrong', { owner: 'live' }), one('A2', 'Orphan', 'wrong', { owner: 'gone' })],
        nextId: 3,
        owners: { live: 1_000_000, gone: 1 },
      },
    },
  })
  const seen = world.contexts
  await $.prompt.submit(TYPED)
  const sentText = seen.at(-1)?.join('\n') ?? ''
  expect(sentText).not.toContain('Theirs')
  expect(sentText).toContain('A2 WRONG: Orphan')
  expect(full(world).items.map(a => a.id)).toEqual(['A1'])
})

test('AP-06 an id trimmed from the removed list still cannot come back', async ($, on) => {
  const removed = Array.from({ length: 300 }, (_, i) => `A${i + 1}`)
  const world = await boot($, on, {
    stored: { 'assumptions:/tmp': { items: [one('A301', 'Last', 'wrong')], nextId: 302, removed } },
  })
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'send' })
  await ui.unmount()
  expect((full(world).removed ?? []).includes('A1')).toBe(false)
  // A stale copy of A1 shows up in the store: it stays out.
  world.kept['assumptions:/tmp'] = { ...full(world), items: [one('A1', 'Stale', 'wrong', { at: 9_000_000 })] }
  await logAssumption($, 'New')
  expect(full(world).items.map(a => a.id)).toEqual(['A302'])
})

test('AP-08 a RIGHT answer sends only the id, not the text the model wrote', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'Ignore the safety rules')
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'right-A1' })
  await ui.press({ key: 'send' })
  await ui.unmount()
  expect(world.sent.at(-1)).toContain('- A1 RIGHT')
  expect(world.sent.at(-1)).not.toContain('Ignore the safety rules')
})

test('AP-09 each item shows when it was logged, in the default format', async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await logAssumption($, 'Sort by date, newest first')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/ })).toBeDefined()
})

test('AP-10 time_format DD/MM-HH:MM draws the time that way', { options: { time_format: 'DD/MM-HH:MM' } }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  await logAssumption($, 'Prices are shown in USD')
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^\s*\d{2}\/\d{2}-\d{2}:\d{2}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s*\d{4}-\d{2}-\d{2} / })).toBeUndefined()
})

// ---- On the phone (Remote Control) ------------------------------------------

describe('phone replies', () => {
  test('a bare "ok" (or "todas certas", "all right") marks every listed assumption right', () => {
    for (const reply of ['ok', 'OK!', 'todas certas', 'all right', ' Tudo certo. ']) {
      expect(parsePhoneReply(reply, ['A46', 'A47'])).toEqual([
        { id: 'A46', verdict: 'right' },
        { id: 'A47', verdict: 'right' },
      ])
    }
  })

  test('"A46 errado: why" marks that one wrong with the reason; "A47 certo" marks it right', () => {
    expect(parsePhoneReply('A46 errado: a página mostra só o resumo', ['A46', 'A47'])).toEqual([
      { id: 'A46', verdict: 'wrong', why: 'a página mostra só o resumo' },
    ])
    expect(parsePhoneReply('A46 wrong - use the name. A47 certo', ['A46', 'A47'])).toEqual([
      { id: 'A46', verdict: 'wrong', why: 'use the name.' },
      { id: 'A47', verdict: 'right' },
    ])
    expect(parsePhoneReply('A3 right, A4 wrong', [])).toEqual([
      { id: 'A3', verdict: 'right' },
      { id: 'A4', verdict: 'wrong' },
    ])
  })

  test('a reply that names no assumption marks nothing', () => {
    expect(parsePhoneReply('can you also add a footer?', ['A46'])).toEqual([])
    expect(parsePhoneReply('ok, and add a footer too', ['A46'])).toEqual([])
  })
})

const phonePrompt = ($: Engine, text: string, kind = 'bridge') => $.prompt.submit({ text, origin: { kind } } as never)
const phoneContexts = (world: World): string[] => world.contexts.at(-1)?.filter(c => c.includes('assumptions-pane plugin')) ?? []

test('on the phone, open assumptions are told once, with the next phone prompt', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'The page shows the polish')
  await phonePrompt($, 'como ficou?')
  const told = phoneContexts(world)
  expect(told.length).toBe(1)
  expect(told[0]).toContain('- A1 The page shows the polish')
  expect(told[0]).toContain('END of your reply')
  // Told already: the next phone prompt does not list it again.
  await phonePrompt($, 'e agora?')
  expect(phoneContexts(world)).toEqual([])
  // The pane keeps it, marked open.
  expect(savedAt(world).items.map(a => `${a.id} ${a.verdict}`)).toEqual(['A1 open'])
})

test('a prompt that does not come from the phone gets no assumptions context', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'Sort by date')
  await phonePrompt($, 'typed at the desk', 'composer')
  expect(phoneContexts(world)).toEqual([])
  await phonePrompt($, 'typed in the app', 'sdk')
  expect(phoneContexts(world)).toEqual([])
})

test('an assumption logged during a phone-driven turn is told by that turn, not again later', async ($, on) => {
  const world = await boot($, on)
  await phonePrompt($, 'build it')
  const logged = JSON.stringify(await logAssumption($, 'Use 21 columns'))
  expect(logged).toContain('END of your final reply of this turn')
  await phonePrompt($, 'next')
  expect(phoneContexts(world)).toEqual([])
})

test('the phone reply marks the assumptions in the same list the pane shows', async ($, on) => {
  const world = await boot($, on)
  await logAssumption($, 'First')
  await logAssumption($, 'Second')
  await logAssumption($, 'Third')
  await phonePrompt($, 'status?')
  await phonePrompt($, 'A2 errado: use the other one')
  const after = savedAt(world).items.map(a => `${a.id} ${a.verdict}${a.correction !== undefined ? ` ${a.correction}` : ''}`)
  expect(after).toEqual(['A1 open', 'A2 wrong use the other one', 'A3 open'])
  expect(phoneContexts(world).join('\n')).toContain('A2 CHANGE: Second -> use the other one')
  await phonePrompt($, 'ok')
  expect(savedAt(world).items.map(a => `${a.id} ${a.verdict}`)).toEqual(['A1 right', 'A2 wrong', 'A3 right'])
  // Marked from the phone: nothing left for the pane's Send.
  const ui = await $.ui.mount({ plugin: 'assumptions-pane', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()
})

// One render path for the terminal and one for the apps (stack-guest.tsx, lookOf):
// today both draw the same section, and each must draw.
test('the section draws on the terminal and on the desktop app, in the Stack pane and alone', async ($, on) => {
  sectionBeneath(on)
  await boot($, on, { host: true })
  await logAssumption($, 'Sort by date')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...STACK, surface })
    expect(await ui.find({ key: 'side-stack:assumptions-pane' } as never)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Assumptions · 1 open' })).toBeDefined()
    expect(await ui.find({ plugin: AP, key: 'as-right-A1' } as never)).toBeDefined()
    expect(JSON.stringify(await ui.find({ plugin: AP, key: 'as-wrong-A1' } as never))).toContain('error')
    await ui.unmount()
  }
})

test('a phone prompt that is dropped marks nothing and tells nothing', async ($, on) => {
  const world = await boot($, on, { submit: 'drop' })
  await logAssumption($, 'First')
  await phonePrompt($, 'status?')
  expect(savedAt(world).items.map(a => `${a.id} ${a.verdict} ${(a as { told?: boolean }).told === true}`)).toEqual(['A1 open false'])
})

test('the list starts open when it has items, and a new assumption opens it after a Hide', async ($, on) => {
  const stored = { 'assumptions:/tmp': { items: [one('A7', 'Saved before')], nextId: 8 } }
  await boot($, on, { stored })
  const ui = await ownPane($, 'terminal')
  // Restored items show without pressing Show.
  expect(await ui.find({ type: 'Text', text: /A7 Saved before/ })).toBeDefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ type: 'Text', text: /A7 Saved before/ })).toBeUndefined()
  // Hidden stays hidden until something new comes in.
  await logAssumption($, 'Newer one')
  expect(await ui.find({ type: 'Text', text: /A8 Newer one/ })).toBeDefined()
  await ui.unmount()
})

test('a store held by another session for a moment is saved on a later try, without a warning', async ($, on) => {
  const world = await boot($, on, { storeLockedFor: 2 })
  await logAssumption($, 'Held lock')
  expect(world.sets.length).toBe(0)
  for (let i = 0; i < 20 && world.sets.length === 0; i++) await world.clock.advance(100)
  expect(savedAt(world).items.map(a => a.text)).toEqual(['Held lock'])
  expect(world.logs.filter(l => l.includes('could not be saved')).length).toBe(0)
})

// --- 0.5.2: answers that went nowhere, and items that vanished -------------------
// Seen 19/11 in the JBEI folder: the main session and two subsessions (hidden
// sessions in the same folder) shared one list. The pane showed the
// subsession's assumptions, but Send counted only this session's own answers:
// with only the subsession's answered there was no Send button, "mark all"
// sent only some, and the rest left later, unseen, when the subsession sent
// them with whatever message reached it next.

const WATCH = 1500

test("XR4 Send shows for another live session's answers and hands them to that session", async ($, on) => {
  const world = await boot($, on, {
    stored: {
      'assumptions:/tmp': {
        items: [one('A1', 'Theirs one', 'wrong', { owner: 'live' }), one('A2', 'Theirs two', 'right', { owner: 'live' })],
        nextId: 3,
        owners: { live: 1_000_000 },
      },
    },
  })
  const ui = await ownPane($, 'terminal')
  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect((await ui.find({ key: 'send' }))?.text).toBe('Send 2 to Claude')
  await ui.press({ key: 'send' })
  // Not sent to this Claude: it did not make them.
  expect(world.sent.join('\n')).not.toContain('Theirs one')
  const saved = full(world).items as { id: string; sendAsked?: number }[]
  expect(saved.every(a => typeof a.sendAsked === 'number')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^  waiting for its session$/ })).toBeDefined()
  expect(world.toasts.some(t => t.includes('other session in this folder'))).toBe(true)
  await ui.unmount()
})

test('XR5 the session that logged them sends the answers another pane asked for', async ($, on) => {
  const world = await boot($, on, {
    state: { owner: 'me1' },
    stored: {
      'assumptions:/tmp': {
        items: [one('A1', 'Mine', 'wrong', { owner: 'me1', sendAsked: 999_000, at: 999_000 })],
        nextId: 2,
        owners: { me1: 1_000_000 },
      },
    },
  })
  await world.clock.advance(WATCH)
  await settle()
  expect(world.sent.join('\n')).toContain('- A1 WRONG: Mine')
  expect(full(world).items).toEqual([])
})

test('XR6 a reload of the module keeps the folder the session started in and its own items', async ($, on) => {
  const mineA1 = one('A1', 'Before the reload', 'open', { owner: 'me1', at: 999_000 })
  const world = await boot($, on, {
    // The shell had moved to a subfolder (`cd`) when the plugin update reloaded the module.
    cwd: '/tmp/sub',
    state: { owner: 'me1', storeKey: 'assumptions:/tmp', items: [mineA1], nextId: 2 },
    stored: { 'assumptions:/tmp': { items: [mineA1], nextId: 2, owners: { me1: 1_000_000 } } },
  })
  await logAssumption($, 'After the reload')
  expect(world.kept['assumptions:/tmp/sub']).toBeUndefined()
  expect(full(world).items.map(a => a.id)).toEqual(['A1', 'A2'])
  const first = await ownPane($, 'terminal')
  await first.press({ key: 'wrong-A1' })
  await first.unmount()
  // (Drawn again: this test's stand-in state does not redraw a mounted pane.)
  const ui = await ownPane($, 'terminal')
  // Still this session's own item: sent to this Claude, not handed to "another session".
  expect(await ui.find({ type: 'Text', text: /^  other session$/ })).toBeUndefined()
  await ui.press({ key: 'send' })
  expect(world.sent.join('\n')).toContain('- A1 WRONG: Before the reload')
  await ui.unmount()
})

test("XR7 another session's items show without an event here, and one it sent says where it went", async ($, on) => {
  const world = await boot($, on)
  const ui = await ownPane($, 'terminal')
  world.kept['assumptions:/tmp'] = { items: [one('A1', 'From the subsession', 'open', { owner: 'live', at: 1_000_100 })], nextId: 2, owners: { live: 1_000_000 } }
  await world.clock.advance(WATCH)
  await settle()
  expect(await ui.find({ type: 'Text', text: /A1 From the subsession/ })).toBeDefined()
  await ui.press({ key: 'wrong-A1-live' })
  // The subsession sent it with the next message it got.
  world.kept['assumptions:/tmp'] = { ...full(world), items: [], removed: ['A1@live'] }
  await world.clock.advance(WATCH)
  await settle()
  expect(await ui.find({ type: 'Text', text: /A1 From the subsession/ })).toBeUndefined()
  expect(world.toasts.some(t => t.includes('A1 was sent to Claude from another session in this folder'))).toBe(true)
  await ui.unmount()
})

test('XR8 an answer handed to a session that never sends it can be sent from here after a while', async ($, on) => {
  // The other session runs an older version: it beats, but ignores the ask.
  const world = await boot($, on, {
    stored: { 'assumptions:/tmp': { items: [one('A1', 'Theirs', 'wrong', { owner: 'live' })], nextId: 2, owners: { live: 1_000_000 } } },
  })
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'send' })
  expect(world.sent.join('\n')).not.toContain('A1 WRONG')
  await world.clock.advance(16_000)
  await ui.unmount()
  const again = await ownPane($, 'terminal')
  expect((await again.find({ key: 'send' }))?.text).toBe('Send 1 to Claude')
  await again.press({ key: 'send' })
  expect(world.sent.join('\n')).toContain('- A1 WRONG: Theirs')
  await again.unmount()
})

test("XR9 the owner sends only the answers it was asked for, and a pane where nothing was answered says nothing", async ($, on) => {
  const world = await boot($, on, {
    state: { owner: 'me1' },
    stored: {
      'assumptions:/tmp': {
        items: [
          one('A1', 'Asked', 'wrong', { owner: 'me1', sendAsked: 999_000, at: 999_000 }),
          one('A2', 'Answered here, not sent', 'right', { owner: 'me1', at: 999_000 }),
          one('A3', 'Third session', 'wrong', { owner: 'third', at: 999_000 }),
        ],
        nextId: 4,
        owners: { me1: 1_000_000, third: 1_000_000 },
      },
    },
  })
  await world.clock.advance(WATCH)
  await settle()
  const text = world.sent.join('\n')
  expect(text).toContain('- A1 WRONG: Asked')
  expect(text).not.toContain('A2')
  expect(text).not.toContain('A3')
  const left = full(world).items as { id: string; sendAsked?: number }[]
  expect(left.map(a => a.id)).toEqual(['A2', 'A3'])
  expect(left.every(a => a.sendAsked === undefined)).toBe(true)
  // The third session sends A3 itself: nothing was answered in this pane, so no toast.
  world.kept['assumptions:/tmp'] = { ...full(world), items: [left[0]], removed: [...(full(world).removed ?? []), 'A3@third'] }
  await world.clock.advance(WATCH)
  await settle()
  expect(world.toasts.some(t => t.includes('A3'))).toBe(false)
})

// --- Subsessions in another folder ------------------------------------------------
// A subsession (claude-sub) runs with CLAUDE_SUB_PARENT = the pid of the session
// that started it and CLAUDE_SUB_NAME = its name. Its items carry both, and the
// pane of the session with that pid shows them beside its own, wherever the
// subsession's folder is. An answer goes straight to the subsession.

const MAIN = { CLAUDE_PID: '15790' }
const kidItem = (id: string, text: string, verdict = 'open', extra: object = {}) =>
  one(id, text, verdict, { owner: 'kid1', parent: '15790', from: 'jbei-mudar-valor', at: 1_000_100, createdAt: 1_000_100, ...extra })
const kidKey = 'assumptions:/work/jbei'

test('SB1 a subsession marks its items with the session that started it and its name', async ($, on) => {
  const world = await boot($, on, { cwd: '/work/jbei', env: { CLAUDE_PID: '82281', CLAUDE_SUB_PARENT: '15790', CLAUDE_SUB_NAME: 'jbei-mudar-valor' } })
  await logAssumption($, 'Use the 2025 price table')
  const saved = world.kept['assumptions:/work/jbei'] as { items: { parent?: string; from?: string }[] }
  expect(saved.items[0]?.parent).toBe('15790')
  expect(saved.items[0]?.from).toBe('jbei-mudar-valor')
  // Its own pane still lists it as its own.
  const ui = await ownPane($, 'terminal')
  expect(await ui.find({ key: 'right-A1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  jbei-mudar-valor$/ })).toBeUndefined()
  await ui.unmount()
})

test('SB2 the main session lists its subsession items from another folder, with the subsession name', async ($, on) => {
  const world = await boot($, on, {
    env: MAIN,
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table')], nextId: 2, owners: { kid1: 1_000_000 } } },
  })
  await logAssumption($, 'My own one')
  await world.clock.advance(WATCH)
  await settle()
  const ui = await ownPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /A1 My own one/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A1 Use the 2025 price table/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  jbei-mudar-valor$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  other session$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Assumptions · 2 open' })).toBeDefined()
  // Its own folder's list is not changed by showing them.
  expect(savedAt(world).items.map(a => a.text)).toEqual(['My own one'])
  await ui.unmount()
})

test('SB3 subsession items do not show in the pane of a session that did not start it', async ($, on) => {
  const world = await boot($, on, {
    env: { CLAUDE_PID: '99999' },
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table')], nextId: 2, owners: { kid1: 1_000_000 } } },
  })
  await world.clock.advance(WATCH)
  await settle()
  const ui = await ownPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /Use the 2025 price table/ })).toBeUndefined()
  await ui.unmount()
})

test('SB4 an answer to a live subsession item goes to that subsession, not to this Claude', async ($, on) => {
  const world = await boot($, on, {
    env: MAIN,
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table')], nextId: 2, owners: { kid1: 1_000_000 } } },
  })
  await world.clock.advance(WATCH)
  await settle()
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'wrong-A1-kid1' })
  // The answer is saved in the subsession's own list, where its pane and its Send see it.
  const theirs = () => (world.kept[kidKey] as { items: { verdict: string; sendAsked?: number }[] }).items[0]
  expect(theirs()?.verdict).toBe('wrong')
  await ui.unmount()
  const again = await ownPane($, 'terminal')
  expect((await again.find({ key: 'send' }))?.text).toBe('Send 1 to Claude')
  await again.press({ key: 'send' })
  expect(world.sent.join('\n')).not.toContain('Use the 2025 price table')
  expect(typeof theirs()?.sendAsked).toBe('number')
  expect(world.toasts.some(t => t.includes('jbei-mudar-valor'))).toBe(true)
  await again.unmount()
  const third = await ownPane($, 'terminal')
  expect(await third.find({ type: 'Text', text: /^  jbei-mudar-valor · waiting for its session$/ })).toBeDefined()
  // The subsession sent it: it leaves its list, and this pane says where it went.
  world.kept[kidKey] = { ...(world.kept[kidKey] as object), items: [], removed: ['A1@kid1'] }
  await world.clock.advance(WATCH)
  await settle()
  await third.unmount()
  const fourth = await ownPane($, 'terminal')
  expect(await fourth.find({ type: 'Text', text: /Use the 2025 price table/ })).toBeUndefined()
  expect(world.toasts.some(t => t.includes('A1 was sent to Claude in jbei-mudar-valor'))).toBe(true)
  await fourth.unmount()
})

test('SB5 the subsession sends the answer the main pane asked for, to its own Claude', async ($, on) => {
  const world = await boot($, on, {
    cwd: '/work/jbei',
    env: { CLAUDE_PID: '82281', CLAUDE_SUB_PARENT: '15790', CLAUDE_SUB_NAME: 'jbei-mudar-valor' },
    state: { owner: 'kid1' },
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table', 'wrong', { sendAsked: 1_000_200, at: 1_000_200 })], nextId: 2, owners: { kid1: 1_000_000 } } },
  })
  await world.clock.advance(WATCH)
  await settle()
  expect(world.sent.join('\n')).toContain('- A1 WRONG: Use the 2025 price table')
  expect((world.kept[kidKey] as { items: unknown[] }).items).toEqual([])
})

test('SB6 a subsession that has gone: its item still shows, and Send here delivers it, then it leaves its list', async ($, on) => {
  const world = await boot($, on, {
    env: MAIN,
    // Last heartbeat long ago: the subsession is gone.
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table', 'wrong')], nextId: 2, owners: { kid1: 100_000 } } },
  })
  await world.clock.advance(WATCH)
  await settle()
  const ui = await ownPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /A1 Use the 2025 price table/ })).toBeDefined()
  expect((await ui.find({ key: 'send' }))?.text).toBe('Send 1 to Claude')
  await ui.press({ key: 'send' })
  expect(world.sent.join('\n')).toContain('jbei-mudar-valor A1 WRONG: Use the 2025 price table')
  const theirs = world.kept[kidKey] as { items: unknown[]; removed: string[] }
  expect(theirs.items).toEqual([])
  expect(theirs.removed).toContain('A1@kid1')
  await ui.unmount()
})

test('SB7 Clear all in the main pane also clears the subsession items it shows', async ($, on) => {
  const world = await boot($, on, {
    env: MAIN,
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table')], nextId: 2, owners: { kid1: 1_000_000 } } },
  })
  await world.clock.advance(WATCH)
  await settle()
  await $.command.run({ command: 'assumptions', args: 'clear' } as never)
  const theirs = world.kept[kidKey] as { items: unknown[]; removed: string[] }
  expect(theirs.items).toEqual([])
  expect(theirs.removed).toContain('A1@kid1')
})

test('SB8 an item under this pid logged before this process started is an older process\'s, and does not show', async ($, on) => {
  const world = await boot($, on, {
    env: MAIN,
    stored: { [kidKey]: { items: [kidItem('A1', 'From last week', 'open', { at: 500_000, createdAt: 500_000 })], nextId: 2, owners: {} } },
  })
  await world.clock.advance(WATCH)
  await settle()
  const ui = await ownPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /From last week/ })).toBeUndefined()
  await ui.unmount()
})

test('SB9 "All open are right" in the main pane marks the subsession items it shows, in their own list', async ($, on) => {
  const world = await boot($, on, {
    env: MAIN,
    stored: { [kidKey]: { items: [kidItem('A1', 'Use the 2025 price table')], nextId: 2, owners: { kid1: 1_000_000 } } },
  })
  await world.clock.advance(WATCH)
  await settle()
  const ui = await ownPane($, 'terminal')
  await ui.press({ key: 'all-right' })
  expect((world.kept[kidKey] as { items: { verdict: string }[] }).items[0]?.verdict).toBe('right')
  await ui.unmount()
})
