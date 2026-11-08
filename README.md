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
[ Nothing to send ] All open are right
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
- Right and Wrong mark an item. Change… opens a text field for the fix. All open are right marks
  every open item at once.
- Send hands your answers to Claude. If Claude is mid-turn, the review waits until the turn ends.
  If it is not delivered, your answers stay in the pane.
- If you type a normal prompt instead, any answers not sent yet go along with it. If that prompt
  is blocked and does not reach Claude, your answers stay in the pane.
- Answered items leave the list once Claude has them. Open items stay. If you change an answer
  while the review waits, the new answer stays in the pane so you can send it.
- Numbers keep counting after a clear, so "A3" always means one item.

There are no settings and nothing else to install.

## How it works

The mod is one hooks module (`hooks/register.tsx`). At session start it registers the
`log_assumption` tool and the `/assumptions` command. A `prompt.compose` hook adds the system prompt
section above. Each tool call stores the item in session state and opens the pane. Send submits the
review as a prompt from the mod. A `prompt.submit` hook adds unsent answers to a prompt you type.

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
- Not tested on the mobile app. A mobile app that does not draw text fields shows nothing for
  Change…, and the mod cannot tell. Use Right or Wrong there and type the fix in the prompt box.
- The list keeps about 100 items. When it is full, the oldest items with nothing to send leave
  first. An answer you have not sent yet never leaves to make room, so the list can grow past 100
  until you send. An assumption is cut at 400 characters and its reason at 200.
- Tests: `claude plugin test .` and `claude plugin validate .`.

## License

MIT. See `LICENSE`.

Built with Claude Code
