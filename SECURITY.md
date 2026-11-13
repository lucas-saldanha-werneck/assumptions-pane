# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Open the repository's
[Security tab](https://github.com/lucas-saldanha-werneck/assumptions-pane/security) and choose
"Report a vulnerability" (GitHub private vulnerability reporting).

## Supported versions

Only the latest release is supported. Fixes land there.

## What this plugin accesses

- It runs inside Claude Code's mod host. It adds one tool, `log_assumption`, that Claude calls to record a guess, a side pane that lists them, and a short instruction to Claude's prompt in every session telling it to use that tool.
- Data: the list is kept in session state and in the mod's own plugin store, saved per project folder, so other sessions in the same folder see and merge the same list. It reads and writes no other files.
- Messages: answers you marked go to Claude in two ways only: as one message submitted to your own session when you press Send, or attached as context to the next message you type yourself.
- Other plugins: if the side-stack plugin is installed, it may run its `/stack` command to show the list there.
- Network and processes: the plugin's own code makes no network requests and starts no processes.
