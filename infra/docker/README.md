# AI-Lab stack — Docker

Everything AI-Lab depends on, built and deployed **from this repo**.

## Why build from the repo rather than commit copies
The in-repo `infra/mcp-unified-memory/` copy had drifted **441 lines** behind the
live `/opt/` deployment — deploying from it would have regressed production.
Committing a copy always drifts. Building and deploying from the repo makes that
class of bug structurally impossible.

## Why colocate at all
The 2026-07-26 storm produced three separate cross-container failures in one day:
weaviate came up without an IP, OpenViking's recall lane latched off because the
memory MCP health-probed it while it was down, and px-epyc dying took ai-epyc with
it. Colocating removes the network between these services entirely.

Accepted trade-off: CT152 becomes a single point of failure for the memory stack.
That is fine — AI-Lab, Hermes and the backends are mutually dependent, so any one
being down already breaks the whole stack.

## Layout
```
compose.yml              full stack
hippocampai/             memory engine — patches/ carries our local changes
openviking/              context database — patches/ MUST be applied, see below
```
Vector DBs (qdrant / weaviate / chroma) run from official images; no Dockerfile.

## The patches — read this before touching either service
Travis's rule: tweaking them is fine, **losing them is not.**

- **HippocampAI** is a git checkout of a Gitea **read-only mirror**, so changes
  cannot be pushed upstream. They are carried as a `git format-patch` in
  `hippocampai/patches/`, verified to apply cleanly onto the pinned base commit
  `ca24195`. The mirror has since moved on — do not float to `main` without
  re-testing.
- **OpenViking** is pip-installed with **no git lineage at all**, and its patches
  live inside `site-packages`. A bare `pip install` erases them silently. The
  Dockerfile applies them explicitly with `--fuzz=0` so the build FAILS rather
  than shipping an unpatched image. Full patched files are kept alongside the
  diffs as a fallback.

## Secrets
Never commit `.env` or `ov.conf`. Templates are `.env.example` / `ov.conf.example`;
real values come from the credential vault. `.env.bak*` is now gitignored upstream —
those backups were untracked but NOT ignored, so they could have been committed.

## Known issue this stack should fix
Three services each hardcoded a model that was offline on 2026-07-27: hippo's
`LLM_MODEL`, the `vision` role in `hermes-support-models.json`, and OpenViking's
`vlm.model`. Once colocated they can all bind-mount `/opt/ai-lab/.gybackend-data/`
read-only and derive from the same files AI-Lab already writes — file wins, env is
fallback, ~15s cache. One shared config surface instead of three separate hunts.
See task #77.
