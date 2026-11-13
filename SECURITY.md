# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Open the repository's
[Security tab](https://github.com/lucas-saldanha-werneck/assumptions-pane/security) and choose
"Report a vulnerability" (GitHub private vulnerability reporting).

## Supported versions

Only the latest release is supported. Fixes land there.

## What this plugin accesses

- It runs inside Claude Code's mod host. It adds one tool, `log_assumption`, that Claude calls to record a guess, and a side pane that lists them.
- Data: the list is kept in the mod's own plugin store and session state; it reads and writes no other files.
- Messages: when you press Send, it submits one message to your own session with your marks; nothing is sent without that press.
- Network and processes: the plugin's own code makes no network requests and starts no processes.

