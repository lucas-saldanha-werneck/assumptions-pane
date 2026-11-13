# Changelog

Versions are the `version` in `.claude-plugin/plugin.json`. Newest first.

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
