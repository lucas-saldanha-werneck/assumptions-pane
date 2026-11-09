# assumptions-pane

A Claude Code mod that lists the assumptions Claude makes while it works in a side pane, so you can
mark each one right or wrong and send corrections in one message. Claude does not stop to ask, and
it does not guess silently either.

Each time Claude picks something you did not state (a default value, a file name, one option over
another), it logs it in one line and keeps working. This sketch shows roughly how the pane looks in
a terminal after you press Show. It is not a screenshot:

```
Assumptions (2 open)
2 assumptions, 2 open  Hide
? A1 The table sorts by date, newest first
  why: most recent entries matter most
  [ Right ] [ Wrong ] Change…
? A2 Prices are shown in USD
  [ Right ] [ Wrong ] Change…
[ Nothing to send ] All open are right Clear all
```

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
- A2 RIGHT: Prices are shown in USD
```

An item marked Wrong with no change typed is sent as
`- A1 WRONG: <text> (do not keep this; ask me if the right choice is not clear)`.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install assumptions-pane --marketplace lucas-saldanha-werneck/assumptions-pane
```

Or from a shell:

```
claude plugin install assumptions-pane --marketplace lucas-saldanha-werneck/assumptions-pane
```

You can also add the marketplace first and then install:

```
/plugin marketplace add lucas-saldanha-werneck/assumptions-pane
/plugin install assumptions-pane@assumptions-pane
```

`/plugin` does not run in the desktop app. Install from a terminal with the user scope, and the mod
also loads in the desktop app's local Code sessions.

## Use

- The pane opens by itself when Claude logs the first assumption. It starts collapsed: press Show
  to see the list. In a terminal it only opens by itself when the window is at least 144 columns
  wide (110 if you have opened the pane before). Below that it waits.
- `/assumptions` opens the pane at any width. `/assumptions clear` empties the list.
- The list is saved per folder. A new session started in the same folder (for example after a
  reload of the app) loads it. After `/clear` the list stays. Each folder has its own list.
- Two sessions open in the same folder share the list: each save merges with what the other
  session saved, so neither wipes the other's items or answers, and numbers are not handed out
  twice.
- Clear all empties the list for that folder, in every session. It asks first: press Clear all, then
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
- Line breaks and runs of spaces in an assumption or a change are saved as one space.
- If the list cannot be saved (for example, the plugin store is full), the mod says so once and the
  list keeps working for that session.
- A review leaves the pane as soon as it enters the chat, even when the app does not report back
  that the message was sent.

There are no settings and nothing else to install.

## Works alone or inside side-stack

The desktop app and the terminal show separate panes as tabs, one at a time. If you use more than
one of these panes (assumptions-pane, idea-shelf, plan-checklist), the
[side-stack](https://github.com/lucas-saldanha-werneck/side-stack) mod gives them one shared pane,
"Stack", with each mod's part drawn one under the other.

- **Alone** (side-stack not installed): the mod works as described above, in its own
  "Assumptions" pane.
- side-stack counts as running only when it has said so and its `/stack` command is there. If
  side-stack goes away mid-session, the next new assumption or `/assumptions` brings the own pane
  back.
- **With side-stack**: the mod does not open its own pane. Its part shows inside the Stack pane,
  under the heading "Assumptions", with the same buttons. To keep room for the other parts it shows
  at most 6 items at a time; the rest show as the first ones are answered and sent, and the button
  reads "All shown are right" so a row you have not seen is never marked.
- When Claude logs a new assumption, or you run `/assumptions`, and the Stack pane is not open, the mod
  runs `/stack` to bring it up. That waits until Claude's turn ends (Claude Code runs a command a
  mod asks for only when the session is idle), and the command shows a line in the transcript.
  If it cannot run, a short notice says to open the pane with `/stack`.
- If an Assumptions pane from before is still on screen, it shows one line, "Shown in the Stack pane
  (/stack)", so the list never appears twice.
- While it draws inside the Stack pane the mod sets its own `stacked` value, which side-stack reads
  to hide its install hint.
- The order of the parts inside the Stack pane follows the order Claude Code loads the plugins in.
  It cannot be set.
- If side-stack starts after this mod, the mod notices within about a second and closes its own pane.

## Terminal and desktop app

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
side-stack's `present` value and command list to decide whether to draw its own pane or a part of
side-stack's pane (a `ui.render` hook on the `side-stack` pane that always draws the parts beneath it
too), checking again at session start, 0.1 s and 1.1 s later, and on every new item and command.

## Uninstall

```
/plugin uninstall assumptions-pane@assumptions-pane
/plugin marketplace remove assumptions-pane
```

From a shell, the same commands work with `claude plugin` in place of `/plugin`.

## Limits and what was not tested

- Built and tested on Claude Code 2.1.319. It needs a version with mods (hooks modules).
- The tests draw the pane on the `terminal` and `desktop` surfaces. Nobody has tried it by hand in the
  desktop app.
- The side-stack mode is tested with a stand-in for side-stack in the tests, not with the released
  side-stack mod. Bringing the Stack pane back after you close it depends on Claude Code passing
  side-stack's pane close to this mod's hooks, which the test kit cannot show.
- `/clear` is tested the way the docs describe it (the session ends with reason `clear` and no new
  session start follows), in the test kit, not by hand. A folder that was emptied keeps a small
  record (its next number and the time of the clear) in the store so numbers go on and an old
  session cannot bring cleared items back.
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
