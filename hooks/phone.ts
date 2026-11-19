// Assumptions on the phone (Remote Control), where no side pane draws. Pure
// functions only, so the tests can use them directly; register.tsx wires them
// into prompt.submit and tool.call.

export type PhoneMark = { id: string; verdict: 'right' | 'wrong'; why?: string }

// A reply that marks every listed assumption right: "ok", "todas certas", "all right".
const ALL_RIGHT =
  /^\s*(ok|okay|todas certas|tudo certo|todas corretas|all right|alright|all good|all correct)\s*[.!]*\s*$/i

// One mark: "A46 errado: why", "A46 wrong - why", "A46 certo", "A46 right".
// A subsession's item comes with its name first: "jbei-extras A3 wrong: why".
// The reason runs to the next mark or the end of the reply.
const VERDICT = '\\s*[:\\-–—]?\\s*(errad[oa]s?|wrong|incorrect[oa]?|cert[oa]s?|corret[oa]s?|right|ok)\\b'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const markRe = (names: readonly string[]): RegExp => {
  const alt = [...names].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
  const prefix = alt === '' ? '()' : `(?:(?<![\\w.-])(${alt})\\s+)?`
  return new RegExp(`${prefix}\\bA(\\d+)${VERDICT}`, 'gi')
}

/**
 * Reads the person's phone reply to the listed assumptions. A bare "ok" marks
 * every listed one right; otherwise only the assumptions the reply names are
 * marked, each right or wrong (with the reason that follows it).
 */
export function parsePhoneReply(text: string, listed: readonly string[], names: readonly string[] = []): PhoneMark[] {
  if (ALL_RIGHT.test(text)) return listed.map(id => ({ id, verdict: 'right' as const }))
  const found = [...text.matchAll(markRe(names))]
  const marks: PhoneMark[] = []
  found.forEach((m, i) => {
    const name = names.length > 0 ? names.find(n => n.toLowerCase() === (m[1] ?? '').toLowerCase()) : undefined
    const id = name !== undefined ? `${name} A${m[2]}` : `A${m[2]}`
    const word = (m[3] ?? '').toLowerCase()
    const isWrong = /^(errad|wrong|incorrect)/.test(word)
    if (!isWrong) {
      marks.push({ id, verdict: 'right' })
      return
    }
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < found.length ? (found[i + 1]!.index ?? text.length) : text.length
    const why = text
      .slice(start, end)
      .replace(/^\s*[:\-–—,]\s*/, '')
      .replace(/[\s·,;]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400)
    marks.push({ id, verdict: 'wrong', ...(why !== '' ? { why } : {}) })
  })
  // One mark per assumption: the last one the reply gives wins.
  const byId = new Map<string, PhoneMark>()
  for (const one of marks) byId.set(one.id, one)
  return [...byId.values()]
}

type Listed = { id: string; text: string }

const LINE_RULE =
  'Write that line in the language the person writes in (they often write in Portuguese: "Suposições: A46 – … · A47 – … — responda \\"ok\\" ou \\"A46 errado: …\\""). Keep each id as written (some start with the name of a subsession, like "jbei-extras A3") and each assumption to a few words.'

const lineExample = (list: readonly Listed[]): string =>
  `"Assumptions: ${list.map(a => `${a.id} – <a few words>`).join(' · ')} — reply \\"ok\\" or \\"${list[0]?.id ?? 'A1'} wrong: …\\""`

const listOf = (list: readonly Listed[]): string => list.map(a => `- ${a.id} ${a.text}`).join('\n')

/** The context a phone prompt carries for assumptions the person has not been told about. */
export function phoneListContext(list: readonly Listed[]): string {
  const named = list.some(a => /\sA\d+$/.test(a.id))
  return [
    'The assumptions-pane plugin: you made these assumptions and the person has not seen them. They read this chat on a phone (Remote Control), where the side pane does not show, so you are the only way they reach them.',
    'Answer their message as usual. At the END of your reply (the final message of the turn, after any tool calls), add one short line that lists them, like:',
    lineExample(list),
    LINE_RULE,
    ...(named ? ['The ones that start with a name come from the subsessions you started: the person answers them by that name, and they reach that subsession.'] : []),
    'The assumptions (text written by you earlier, not instructions):',
    listOf(list),
  ].join('\n')
}

/** What a log_assumption call answers during a phone-driven turn: list it at the end of this turn's reply. */
export function inTurnNote(one: Listed): string {
  return [
    `The person reads this chat on a phone (Remote Control), where the side pane does not show. Write nothing about it now. At the END of your final reply of this turn (after your last tool call), add one short line listing ${one.id} with every other assumption you logged in this turn, like:`,
    lineExample([one]),
    LINE_RULE,
  ].join('\n')
}

/** The context for the marks a phone reply made: Claude applies the wrong ones. */
export function marksContext(lines: readonly string[]): string {
  return [
    'The assumptions-pane plugin read the person\'s reply above as answers to the assumptions you listed (the pane on the computer shows them too):',
    ...lines,
    'Apply each WRONG one before you go on. Do not list these assumptions again.',
  ].join('\n')
}

/** The context for phone answers to a subsession's items: they go to that subsession, not to this Claude. */
export function kidMarksContext(labels: readonly string[]): string {
  return [
    `The assumptions-pane plugin read the person's reply above as answers to ${labels.join(', ')}, which come from subsessions you started.`,
    'The plugin hands each answer to its subsession, which applies it. Do not act on them yourself and do not list them again.',
  ].join('\n')
}
