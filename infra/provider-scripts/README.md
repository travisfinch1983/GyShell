# Provider install scripts

Source of truth for the per-provider installers the AI-Lab backend runs on GPU nodes.

The backend executes these out of `.gybackend-data/scripts/providers/`, which is
gitignored — it sits inside the runtime data dir. Until 2026-07-29 that meant these
scripts had **no version control at all**: 31 installers living on one container's
disk, no history, no backup.

## Layout

```
providers/
  <provider-id>.sh        # install|uninstall|status
  prereqs/                # shared install-chain steps (pytorch, symlinks, ...)
deploy.sh                 # repo -> data dir, plus --check for drift
```

## Deploying

```bash
./deploy.sh           # copy into the data dir (repo wins)
./deploy.sh --check   # report drift, write nothing, exit 1 if any
```

## The contract each script must honour

Invoked as `<script>.sh [install|uninstall|status]`. It must print one of:

```
PROXLAB_STATUS=installed|not_installed|error
PROXLAB_VERSION=<version>      # when installed
```

and, on install, write `/opt/<provider-id>/.version`. **Install detection is
`[ -f /opt/<provider-id>/.version ]`** — the install directory name is derived from
the provider ID in the registry. A provider whose script installs somewhere else
will always show as not-installed, no matter what the script printed.

That coupling is why renaming a provider ID is not a cosmetic change: it moves the
path detection looks at, orphaning any existing install. The `proxlab-tts` ID is
retained for exactly this reason even though its display name is now "AI-Lab TTS".

## The drift trap

Installers that embed a server file (`proxlab-tts.sh`, `rvc.sh`) carry a *copy* of
that server inside a heredoc. It is only as current as the last time someone
re-embedded it.

On 2026-07-29 the `server.py` embedded in `proxlab-tts.sh` was 374 lines while the
one actually running on ai-gpu was 461 — the installer had never been updated after
silence-trimming was added live. Reinstalling would have silently downgraded the
service and lost the feature. Nothing caught it because the copies were never compared.

`deploy.sh --check` compares repo against data dir. It **cannot** tell you the
embedded server matches what is deployed on a GPU node — that stays manual:

```bash
ssh <node> cat /opt/proxlab-tts/server.py > /tmp/live.py
# extract the heredoc from providers/proxlab-tts.sh and diff the two
```

Do that before trusting an installer that embeds a server, and re-embed if they differ.
