# Fleet delivery daemons (run on CT180, not here)

Two root-owned systemd daemons on **CT180** that make the AI-Lab ConversationBus
actually reach the Claude Code instances. Vendored here for version control and
review — **the running copies are `/opt/fleet-forwarder/` and
`/opt/fleet-relay-watcher/` on CT180.** Edit there, then re-vendor.

| | |
|---|---|
| `fleet-forwarder/` | INBOUND. Polls `/api/fleet/feed`, injects each envelope into the target's dtach pty. Also heartbeats liveness to `/api/fleet/heartbeat`. |
| `fleet-relay-watcher/` | OUTBOUND + ACTIVITY. Tails each instance's transcript for relay markers, and reports `/api/fleet/activity`. |

## Hard-won constraints — read before editing

**4096-byte tty cap.** A single `dtach -p` push lands in the pty line-discipline
buffer, capped at kernel `N_TTY_BUF_SIZE`. Excess is **discarded silently** and
dtach still exits 0. Measured: 4090→4091 delivered, 4200→4096, 6000→4096,
8000→4096. A real 5,914-byte brief lost its trailing 1,818 bytes and the CR then
submitted the fragment, while the log said "delivered". Hence `CHUNK_BYTES=3000`,
UTF-8-boundary chunking (em-dashes are 3 bytes — splitting corrupts), and the CR
is withheld unless every byte is confirmed pushed.

**Injection is simulated keystrokes.** `dtach -p` types into the pty; the
recipient cannot tell it from the human. So it collides with whatever the human
is typing. The quiet gate defers until the terminal is silent AND no turn is in
flight; it narrows the window, it cannot close it. The real fix is a pull-based
inbox, not a better gate.

**pty MTIME is the activity signal — NOT atime.** `/dev/pts` is mounted
`relatime`, which suppresses atime updates, and `dtach -p` input moves neither
timestamp (measured 33→37→38→42→43s straight through two keystroke pushes). mtime
works because the TUI *writes* on every keystroke and every streamed token. Do
not retry the atime approach.

**Transcript idle LAGS.** Claude Code buffers transcript writes during a long
turn — a record 233s old while the instance was actively running tools. So
liveness uses `min(transcript_idle, pty_idle)`: the transcript says WHAT, the pty
says WHEN.

**Anything held is already past the cursor.** The cursor advances BEFORE
injection so a wedged session can't replay forever — which means a deferred or
failed message would be lost on restart. Hence the queue persists to
`/var/lib/fleet-forwarder/queue.json`. Adding a hold-and-retry feature turns any
"we keep it in RAM" assumption into a live data-loss bug.

**Never mark shipped/delivered before confirming.** Both daemons had a version of
this bug: the forwarder logged "delivered" for a truncated push, and the watcher
marked its `recent` window shipped at build time so one failed POST suppressed it
permanently. Confirm, then mark.
