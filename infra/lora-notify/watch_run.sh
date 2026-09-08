#!/bin/bash
# Attach to a run we did NOT spawn (launched before its command carried the notifier). We
# cannot read its exit status — Linux gives a non-parent no way to — so notify_run.py is
# called with --rc unknown and reports an INFERRED verdict, clearly labelled as such.
PID="$1"; DIR="$2"; TO="$3"
while kill -0 "$PID" 2>/dev/null; do sleep 20; done
/opt/conda/bin/python3 /opt/lora-notify/notify_run.py --run-dir "$DIR" --rc unknown --to "$TO" || true
