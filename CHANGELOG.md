# Changelog

Versions are the `version` in `.claude-plugin/plugin.json`. Newest first.

## 0.5.2 (2026-11-19)

- Send shows, and counts, answers to items another session in the same folder logged (a subsession counts): it hands them to that session, which sends them to its own Claude within a couple of seconds. Before, Send counted only this session's own answers, so with only the other session's items answered there was no Send button, and "mark all" sent only some.
- The pane picks up what another session in the folder saved (its new items, the answers it sent) every 1.5 s, and says in a toast when answers given here reached the session that logged them, instead of the rows leaving without a word.
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
