# assumptions-pane

[![CI](https://github.com/lucas-saldanha-werneck/assumptions-pane/actions/workflows/test.yml/badge.svg)](https://github.com/lucas-saldanha-werneck/assumptions-pane/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/lucas-saldanha-werneck/assumptions-pane)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.0-blue)](CHANGELOG.md)
[![plugin score (proposal)](https://img.shields.io/badge/plugin%20score%20(proposal)-94.2%20A-brightgreen)](https://github.com/NVIDIA/SkillEvaluator/issues/508)

A Claude Code mod: a side pane that lists each assumption Claude makes while it works, so you can
mark it right or wrong and send corrections in one message. Claude does not stop to ask, and
it does not guess silently either.

[![assumptions-pane demo: tap to open the video](https://github.com/user-attachments/assets/3dc2d729-8aae-4bab-b8af-7f08c2ed2fce)](https://lucas-saldanha-werneck.github.io/assumptions-pane/demo.mp4)

<table>
<tr>
<td align="center"><img src="https://github.com/user-attachments/assets/87d9b146-cacf-4263-bc1e-e335f7fb5158" alt="The assumptions pane in a terminal, one marked right and one still open" width="320"><br>In the terminal</td>
<td align="center"><img src="https://github.com/user-attachments/assets/02b4c1e2-aa04-426b-9bf7-08bc683c7b89" alt="The assumptions pane in the Claude desktop app" width="320"><br>In the desktop app</td>
<td align="center"><img src="https://github.com/user-attachments/assets/65ef80d8-32e8-4450-a2d8-c848754eae07" alt="Summary: no silent guesses, no interruptions" width="320"><br>The idea in short</td>
</tr>
</table>

Each time Claude picks something you did not state (a default value, a file name, one option over
another), it logs it in one line and keeps working. This sketch shows roughly how the pane looks in
a terminal. It is not a screenshot:

```
Assumptions · 2 open ────────── Hide
? A1 The table sorts by date, newest first  2026-11-25 18:02
  why: most recent entries matter most
  [ Right ] [ Wrong ] Change…
? A2 Prices are shown in USD  2026-11-25 18:05
  [ Right ] [ Wrong ] Change…
All open are right Clear all
```

Right is green, Wrong red, Change… in the accent color, and Clear all red. Send (`Send 1 to
Claude`) shows only once you have answered something. With nothing logged the pane is one line,
`Assumptions · 0`.

## What Claude sees

The mod adds this section to the system prompt:

> Assumptions pane: while you build or change something, each time you make an assumption the
> person did not state (a default value, a guess about what they want, a choice between options, a
> file or name you picked), call the log_assumption tool once for that assumption, in one short
> plain sentence, then keep working. Do not stop to ask about it: the person reviews the list in a
> side pane and sends corrections. When a message starts with "Assumption review", apply each
> correction it lists before you go on.

A tool call and its result:

```
log_assumption({ "assumption": "The table sorts by date, newest first", "why": "most recent entries matter most" })
-> Logged as A1. Keep working; the person may correct it later.
```

When you press Send, Claude gets a message like this:

```
Assumption review:
- A1 CHANGE: The table sorts by date, newest first -> Sort by name
- A2 RIGHT
```

A RIGHT carries only the number: the text was written by Claude, so it is not sent back as if
you had said it.

An item marked Wrong with no change typed is sent as
`- A1 WRONG: <text> (do not keep this; ask me if the right choice is not clear)`.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin marketplace add lucas-saldanha-werneck/lucas-tools
/plugin install assumptions-pane@lucas-tools
```

From a shell, the same commands work with `claude plugin` in place of `/plugin`.

`/plugin` does not run in the desktop app. Install from a terminal with the user scope, and the mod
also loads in the desktop app's local Code sessions.

## Use

- The pane opens by itself when Claude logs the first assumption, with the list showing. Hide
  folds it to one line; the next new assumption opens it again. In a terminal it only opens by itself when the window is at least 144 columns
  wide (110 if you have opened the pane before). Below that it waits.
- `/assumptions` opens the pane at any width. `/assumptions clear` empties the list.
- The list is saved per folder. A new session started in the same folder (for example after a
  reload of the app) loads it. After `/clear` (which starts a new session id with fresh state) the
  mod loads the saved list again; the pane shows it from the store even before the next prompt.
  Each folder has its own list.
- Two sessions open in the same folder share the list: each save merges with what the other
  session saved, so neither wipes the other's items or answers, and numbers are not handed out
  twice. Each item remembers the session that logged it: if two sessions hand out the same number
  at the same moment, both items are kept. A subsession (a hidden session started in the same
  folder) counts as one of these sessions. Your answer to an item goes to the Claude that logged
  it while that session is open (the row says "other session"): Send counts those answers too
  and hands them to that session, which sends them to its Claude within a couple of seconds (the
  row says "waiting for its session" meanwhile, and a toast says when answers given in this pane
  were sent from another session). If that session has not sent them after 15 seconds (an older
  version of the mod there), Send here sends them. Once that session has been gone for 3 minutes
  (it saves a heartbeat once a minute), any session in the folder sends it. The pane picks up what another session in the folder saved within about 1.5 s.
- A subsession started with [subsessions](https://github.com/lucas-saldanha-werneck/subsessions)
  0.2.2 or later shows its assumptions in the pane of the session that started it too, in any
  folder, each row with the subsession's name (for example `jbei-mudar-valor`) under it. Only
  that session sees them; other sessions do not. Your answer is saved in the subsession's own list
  and Send hands it straight to the subsession, which sends it to its own Claude (the row says
  `jbei-mudar-valor · waiting for its session` meanwhile, and a toast says when it went). Once the
  subsession has been gone for 3 minutes, or has not sent a handed-over answer after 15 seconds,
  Send here sends it to this Claude, named with the subsession (`- jbei-mudar-valor A3 WRONG: …`).
  "All open are right" and "Clear all" here act on the subsession's rows too. The subsession's own
  pane keeps working as before. This works through two variables `claude-sub` gives the
  subsession: `CLAUDE_SUB_PARENT` (the pid of the session that started it) and `CLAUDE_SUB_NAME`.
- A plugin update (or any reload of the mod) keeps the list of the folder the session started in,
  even if Claude's shell has moved to a subfolder since, and keeps the session's own items its own.
- A slash command (`/model`, `/clear`, a skill) never carries your answers; they go with your
  next prompt.
- Clear all empties the list for that folder, in every session, and records the cleared numbers so
  a session that still shows an old item cannot bring it back. It asks first: press Clear all, then
  Yes, clear all. While it asks, Cancel sits where Clear all was, so a double press cancels. The
  question goes away by itself after 5 seconds. `/assumptions clear` empties it without asking.
- Right and Wrong mark an item. Change… opens a text field for the fix. All open are right marks
  every open item at once.
- Send hands your answers to Claude. If Claude is mid-turn, the review waits until the turn ends.
  If it is not delivered, your answers stay in the pane.
- If you type a normal prompt instead, any answers not sent yet go along with it. If that prompt
  is blocked and does not reach Claude, your answers stay in the pane.
- Answered items leave the list once Claude has them. Open items stay. If you change an answer
  while the review waits, the new answer stays in the pane so you can send it.
- Numbers keep counting after a clear and after a reload, so "A3" always means one item.
- Each item shows, in grey at the end of its line, when it was logged, in this computer's time zone, so
  old items stand apart from current ones. Items saved by an older version show the time of their
  last change.
- Line breaks and runs of spaces in an assumption or a change are saved as one space.
- If the list cannot be saved (for example, the plugin store is full), the mod says so once and the
  list keeps working for that session.
- A review leaves the pane as soon as it enters the chat, even when the app does not report back
  that the message was sent.

One setting, in `/config`: **Time format** (`time_format`) picks how that time shows:
`YYYY-MM-DD HH:MM` (default, `2026-11-25 18:02`), `DD/MM-HH:MM` (`25/11-18:02`) or
`MM/DD-HH:MM` (`11/25-18:02`). Nothing else to install.

## Examples

- Claude builds a table and picks a sort order you did not state. It calls
  `log_assumption({ "assumption": "The table sorts by date, newest first" })`, keeps working, and the
  pane lists "A1" for you to mark.
- You open the list at any width with `/assumptions`, press Right on A1, Wrong with a change on A2
  ("Sort by name"), then Send. Claude gets `Assumption review:` with `- A1 RIGHT` and
  `- A2 CHANGE: ... -> Sort by name`, and applies the correction before it goes on.
- You type a normal prompt while answers are marked but not sent: they go along with it.
- `/assumptions clear` empties the list for the folder without asking.

## Works alone or inside side-stack

The desktop app and the terminal show separate panes as tabs, one at a time. If you use more than
one of these panes (assumptions-pane, idea-shelf, plan-checklist, clean-view), the
[side-stack](https://github.com/lucas-saldanha-werneck/side-stack) mod gives them one shared pane,
"Stack", with each mod's part drawn one under the other.

- **Alone** (side-stack not installed): the mod works as described above, in its own
  "Assumptions" pane.
- side-stack counts as running when its `/stack` command is listed. (side-stack's own "present"
  value lasts one session and is gone after `/clear`, so the mod does not rely on it.) If
  side-stack goes away mid-session, the next new assumption or `/assumptions` brings the own pane
  back.
- **With side-stack**: the mod does not open its own pane. Its part shows inside the Stack pane,
  under the heading "Assumptions", with the same buttons. To keep room for the other parts it shows
  at most 6 items at a time; the rest show as the first ones are answered and sent, and the button
  reads "All shown are right" so a row you have not seen is never marked.
- When Claude logs a new assumption and the Stack pane is not open, or you run `/assumptions`, the
  mod asks side-stack for its pane with nothing in the chat: it counts its `showStack` value up,
  and side-stack (0.5.1 and later) opens its pane and answers with the same number. A new
  assumption does not ask when your last prompt came through Remote Control (phone or claude.ai),
  where no pane shows (see [On the phone](#on-the-phone)). With an older side-stack, which does not
  answer, the mod runs `/stack` as before (it shows as a line in the transcript and waits until the
  turn ends); if that cannot run, a short notice says to open the pane with `/stack`.
- If an Assumptions pane from before is still on screen, it shows one line, "Shown in the Stack pane
  (/stack)", so the list never appears twice.
- While it draws inside the Stack pane the mod sets its own `stacked` value, which side-stack reads
  to hide its install hint.
- By default the parts inside the Stack pane follow the order Claude Code loads the plugins in
  (install order). side-stack can change it (`/stack order assumptions-pane,idea-shelf`, see its
  README). This mod draws its part in a box keyed `side-stack:assumptions-pane`; when side-stack
  has set an order it leaves an empty box keyed `side-stack:slot:assumptions-pane`, and the mod
  draws its part there. With no such box it draws on top of the parts beneath, as before.
- If side-stack starts after this mod, the mod notices within about a second and closes its own pane.

## On the phone

Remote Control (the phone app, claude.ai) draws no pane, so there Claude tells you the assumptions
in the chat, the way [side-notes](https://github.com/lucas-saldanha-werneck/side-notes) tells its notes.

- A session counts as driven from the phone when your last prompt came through Remote Control
  (origin `bridge`). A prompt typed in the terminal (`composer`) or in the desktop app (`sdk`) ends that.
- An assumption Claude logs during a phone-driven turn is told in that turn: the tool's answer asks
  Claude to list it at the end of its final reply. Open assumptions you have not been told about
  (logged while you were at the computer, or by another session in the folder) go with your next
  phone prompt, and Claude lists them at the end of its reply, in your language, for example:
  `Suposições: A46 – a página mostra o polish junto · A47 – … — responda "ok" ou "A46 errado: …"`.
- Each assumption is told once (saved with the list as `told`).
- Your next phone prompt is read as the answer: a bare `ok` (or `todas certas`, `tudo certo`,
  `all right`) marks every listed assumption right; `A46 errado: <why>` (or `A46 wrong: <why>`)
  marks that one wrong with the reason; `A46 certo` (or `A46 right`) marks it right. Several in one
  prompt work. Nothing the reply does not name is marked, except on `ok`.
- The marks go into the same saved list, so the pane on the computer shows them (dim, as sent:
  Claude read your reply, so Send does not send them again). Claude gets them as a review in that
  prompt and applies each wrong one.

## Terminal and desktop app

**Terminal look and app look.** The drawing is split by surface: one look for the terminal, one for
the apps (desktop, mobile, VS Code). Today both draw the same tree. Where each look lives, and how to
change one without the other: side-stack's README,
[Shared guest code, and where the terminal and app looks live](https://github.com/lucas-saldanha-werneck/side-stack#shared-guest-code-and-where-the-terminal-and-app-looks-live).
This repo's `hooks/stack-guest.tsx` is a byte-identical copy of side-stack's (CI checks it): change
it there first.

The same code draws on both, and the tests draw the own pane, the Stack section, the buttons and the
review flow on the `terminal` and `desktop` surfaces. What differs is Claude Code's own layout:

- In a terminal a pane opens by itself only in a wide enough window (see Use). The desktop app
  places it at any width.
- The terminal draws buttons as `[ Right ]`, and plain ones (Show, Change…, Clear all) as text.
  The desktop app draws its own buttons. The keys and the order are the same on both.

## How it works

The mod is one hooks module (`hooks/register.tsx`). At session start it registers the
`log_assumption` tool and the `/assumptions` command. A `prompt.compose` hook adds the system prompt
section above. Each tool call stores the item in session state, saves the list in the plugin store
under `assumptions:<folder>`, and opens the pane. Send submits the review as a prompt from the mod.
A `prompt.submit` hook adds unsent answers to a prompt you type, and a `turn.start` hook removes a
review's rows once its turn starts. Every save re-reads the store and merges by item id first
(newer change wins, the higher next number wins, sent or cleared items stay out). It reads
whether side-stack's `/stack` command is listed to decide whether to draw its own pane or a part of
side-stack's pane (a `ui.render` hook on the `side-stack` pane that always draws the parts beneath it
too), checking again at session start, 0.1 s and 1.1 s later, and on every new item and command.
A `/clear` goes on under a new session id with fresh state and no session start, so the mod keeps
the id it loaded under. A watch started at session start (every 1.5 s), and every prompt, turn,
command, tool call or button press, loads the list from the store again when the id differs,
checks side-stack again and republishes its `stacked` value; until then a drawing shows the list as
the store holds it. (A drawing cannot reload it itself: Claude Code refuses state writes made while
drawing, including from a timer the drawing starts.)

## Uninstall

```
/plugin uninstall assumptions-pane@lucas-tools
```

From a shell, the same commands work with `claude plugin` in place of `/plugin`.

## Limits

- Built and tested on Claude Code 2.1.319; 0.6.0 (subsession items) needs 2.1.327 or later (`$.process.hookEnv`). It needs a version with mods (hooks modules).
- The tests draw the pane on the `terminal` and `desktop` surfaces. Nobody has tried it by hand in the
  desktop app.
- The side-stack mode is tested with a stand-in for side-stack in the tests, not with the released
  side-stack mod. Bringing the Stack pane back after you close it depends on Claude Code passing
  side-stack's pane close to this mod's hooks, which the test kit cannot show.
- `/clear` is tested in the test kit the way the docs describe it: the session ends with reason
  `clear`, the session id changes and no new session start follows. The kit cannot wipe a plugin's
  state, so "fresh state" is tested as a new session id with no session start and the list only in
  the store. A real `/clear` was also tried by hand in a terminal (Claude Code 2.1.319, with
  side-stack, idea-shelf, plan-checklist and clean-view): the list stays in the Stack pane, comes
  back into the new session and numbering goes on. Not tried by hand in the desktop app. A folder that was emptied keeps a small
  record (its next number and the time of the clear) in the store so numbers go on and an old
  session cannot bring cleared items back.
- Subsession items in the starting session's pane were tried by hand in tmux (Claude Code
  2.1.327): a main session and a subsession in another folder started by `claude-sub`; the main
  pane listed the subsession's item with its name, an answer written to the subsession's list with
  `sendAsked` reached the subsession's Claude, and the row left the main pane. Pressing the
  buttons was tested in the test kit only. On the phone (Remote Control), Claude tells only the
  session's own assumptions, not its subsessions'.
- Not tested on the mobile app. A mobile app that does not draw text fields shows nothing for
  Change…, and the mod cannot tell. Use Right or Wrong there and type the fix in the prompt box.
- The list keeps about 100 items. When it is full, the oldest items with nothing to send leave
  first. An answer you have not sent yet never leaves to make room, so the list can grow past 100
  until you send. An assumption is cut at 400 characters and its reason at 200.
- Tests: `claude plugin test .` and `claude plugin validate .`.

## Credits

The idea comes from the "Assumption Checker" mod in the AI LABS video [Claude Mods Are Insane... You Need To Try These Right Now](https://www.youtube.com/watch?v=ERNqRK6sMJY&t=399) (06:39, 9 Oct 2026). This code was written separately with Claude Code.

## License

MIT. See `LICENSE`.

Built with Claude Code

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and what this plugin accesses.
