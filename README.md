# assumptions-pane

A Claude Code mod that keeps a side pane of the assumptions Claude makes while it works. Each time
Claude picks something you did not state (a default value, a file name, one option over another),
it logs it in one line and keeps going. You mark each one Right or Wrong, type a change if needed,
and send the answers back in one message.

```
Assumptions (2 open)
2 assumptions, 2 open  [Hide]
? A1 The table sorts by date, newest first
  why: most recent entries matter most
  [Right] [Wrong] [Change…]
? A2 Prices are shown in USD
  [Right] [Wrong] [Change…]
[Nothing to send] [All open are right]
```

## Why

Claude has two bad options when a request leaves something open: stop and ask (slow), or guess
silently (you find out later). With this mod it guesses out loud, and you review the guesses when
it suits you, without interrupting the turn.

## What Claude sees

A section added to the system prompt tells Claude when to use the tool:

> Assumptions pane: while you build or change something, each time you make an assumption the
> person did not state (a default value, a guess about what they want, a choice between options, a
> file or name you picked), call the log_assumption tool once for that assumption, in one short
> plain sentence, then keep working. Do not stop to ask about it: the person reviews the list in a
> side pane and sends corrections. When a message starts with "Assumption review", apply each
> correction it lists before you go on.

The tool call and its result:

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

If you type a normal prompt instead, any answers not sent yet ride along with it, so none are
lost. If Claude is mid-turn, the review waits until the turn ends; if it is not delivered, your
answers stay in the pane.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin marketplace add lucas-saldanha-werneck/assumptions-pane
/plugin install assumptions-pane@assumptions-pane
```

From a shell: `claude plugin install assumptions-pane --marketplace lucas-saldanha-werneck/assumptions-pane`.

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins,
Add marketplace with `lucas-saldanha-werneck/assumptions-pane`, then Add plugin.

## Use

- The pane opens by itself when Claude logs the first assumption (in a terminal, only when the
  window is wide enough to dock it; otherwise it waits).
- `/assumptions` opens the pane at any width. `/assumptions clear` empties the list.
- Numbers keep counting after a clear, so "A3" always means one item.

## Where it works

Checked against the mod API reference bundled with Claude Code 2.1.319 and the tests in this repo:

- **Terminal:** yes (the tests draw the pane on the `terminal` surface).
- **Desktop app (Code tab, local session):** yes, when installed at user scope (the tests draw it
  on the `desktop` surface too).
- **Mobile app:** the pane draws, but the mobile app has no text field yet, so Change… asks you to
  type the change in the prompt box. Not tested on a phone.

## Settings

None.

## Optional requirements

None. It needs a Claude Code version with mods (hooks modules); it was built and tested on 2.1.319.

## Test

```
claude plugin test .
claude plugin validate .
```

## Uninstall

```
/plugin uninstall assumptions-pane@assumptions-pane
/plugin marketplace remove assumptions-pane
```

## License

MIT.

Built with Claude Code
