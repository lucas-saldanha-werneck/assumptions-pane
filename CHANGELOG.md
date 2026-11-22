# Changelog

Versions are the `version` in `.claude-plugin/plugin.json`. Newest first.

## 0.6.3 (2026-11-22)

- No change to the plugin itself. The test run no longer fails now and then with "a rejection nothing handled: $.state.get refused": two tests start a Send whose submit never settles and left that press unhandled, so when the test world went away the press ended in a refused read. The press now expects that.

## 0.6.2 (2026-11-19)

- Answers marked and not sent yet stay in the pane until you press Send or send a prompt yourself (typed in the terminal or the desktop app, or on the phone). Before, any prompt took them along, also a background task's notification, a subsession's message or the main session's message to a subsession, which can arrive mid-turn: the answers left the pane while they were still being given.

## 0.6.1 (2026-11-19)

- On the phone (Remote Control), the session that started subsessions (claude-sub) also lists their open assumptions at the end of its reply, each with the subsession's name: `jbei-extras A3 – …`. Its own items keep plain ids (`A3`).
- A reply that names the subsession (`jbei-extras A3 errado: …`, `jbei-extras A3 certo`) answers that item: it is saved in the subsession's own list and handed to the subsession, which sends it to its own Claude, as Send does in the pane. A plain `A3` is still this session's own. `ok` marks every listed item right, the subsession's too.
- A subsession that has gone (no heartbeat for 3 minutes): the answer is given to this session's Claude, named `[jbei-extras] A3`, and the item leaves the subsession's list.
- Other sessions are unaffected.

## 0.6.0 (2026-11-19)

- The session that started a subsession (claude-sub 0.2.2 or later) lists the subsession's assumptions beside its own, in any folder, each with the subsession's name instead of "other session". Before, only a subsession in the same folder showed. Other sessions do not see them.
- An answer to a subsession's item is saved in the subsession's own list and Send hands it straight to the subsession, which sends it to its own Claude. A subsession that has gone (no heartbeat for 3 minutes) or has not sent it after 15 s: Send here sends it, named with the subsession. "All open are right" and "Clear all" act on those rows too.
- The session's pid is read through `$.process.hookEnv()` (CLAUDE_PID is not in a plugin's own environment); the subsession's `CLAUDE_SUB_PARENT` and `CLAUDE_SUB_NAME` through `$.env.get`.

## 0.5.2 (2026-11-19)

- Send shows, and counts, answers to items another session in the same folder logged (a subsession counts): it hands them to that session, which sends them to its own Claude within a couple of seconds. Before, Send counted only this session's own answers, so with only the other session's items answered there was no Send button, and "mark all" sent only some.
- The pane picks up what another session in the folder saved (its new items, the answers it sent) every 1.5 s, and says in a toast when answers given in this pane were sent from another session, instead of the rows leaving without a word. An answer handed over and not sent within 15 s (the other session runs an older version) can be sent from here.
- A plugin update or other reload of the mod keeps the folder's list and the session's owner mark. Before, the reload read the shell's current folder (after a `cd` into a subfolder the list moved to that subfolder's key) and minted a new owner mark (the session's own items showed as "other session" for 3 minutes).

## 0.5.1 (2026-11-19)

- The list shows open whenever it has items; a new assumption opens it again after a Hide.
- A save that fails (for example "Lock file is already being held" while another session in the same folder writes) is tried again up to 5 times before the warning shows.

## 0.5.0 (2026-11-18)

- On the phone (Remote Control): open assumptions go to Claude to list at the end of its reply, once each; a reply of `ok`, `A46 errado: …` or `A46 certo` marks them in the same list.
- One heading in both places, `Assumptions · 1 open`; an empty list is one line. The time sits at the end of the assumption's line (`time_format` still applies).
- Right green, Wrong red, Change… accent, Clear all red. Send shows only with something to send.
- Shorter status lines ("waiting", "other session", "+3 more").
- A new assumption or `/assumptions` asks side-stack for its pane silently (the `showStack` counter, side-stack 0.5.1+); `/stack` stays the fallback for an older side-stack.
- The side-stack guest protocol now comes from `hooks/stack-guest.tsx`, a byte-identical copy of side-stack's (CI checks it).
- Rendering split by surface: one look for the terminal, one for the apps (desktop, mobile, VS Code). Both draw the same tree for now.

## 0.4.1 (2026-11-18)

- Draw in the side-stack pane again on Claude Code 2.1.327 and later, which hears only a plugin's own drawings unless the hook names `plugin: '*'`. Older builds keep working (the hook is registered both ways and the section is drawn once).

## 0.4.0 (2026-11-17)

- Each item shows when it was logged, in grey under its text, so old items stand apart from current ones.
- New setting `time_format`: `YYYY-MM-DD HH:MM` (default), `DD/MM-HH:MM` or `MM/DD-HH:MM`.

## 0.3.7 (2026-11-13)

- README: add an Examples section.

## 0.3.6 (2026-11-12)

- Slash commands no longer carry or consume pending answers.
- Each item records the session that logged it; an answer goes back to that session while it is alive.
- Removed and cleared ids stay out, so a stale copy cannot bring them back.
- A RIGHT line carries only the id, not the model-written text.

## 0.3.5 (2026-11-11)

- Point to the catalog repo's new name, `lucas-tools`.

## 0.3.4 (2026-11-11)

- Catalog renamed to `lucas-tools`.

## 0.3.3 (2026-11-09)

- One-line description, catalog install steps, README headings.

## 0.3.2 (2026-11-09)

- Keep the loaded-for marker in session state.

## 0.3.1 (2026-11-09)

- Keep the section after a real /clear.

## 0.3.0 (2026-11-09)

- Section order in side-stack: keyed section, fills its slot.

## 0.2.1 (2026-11-09)

- Reload the list after a real /clear; side-stack presence from /stack alone.
- Two sessions in one folder merge the saved list by id instead of overwriting it.
- Clear all keeps its slot; side-stack counts as present only with its live /stack command (protocol v2).

## 0.2.0 (2026-11-09)

- Saved list per folder, Clear all, side-stack support.

## 0.1.2 (2026-11-08)

- Never strand or drop an unsent answer; unique ids under overlap.

## 0.1.1 (2026-11-08)

- Keep answers until Claude has them.

## 0.1.0 (2026-11-08)

- Side pane for the assumptions Claude logs.
