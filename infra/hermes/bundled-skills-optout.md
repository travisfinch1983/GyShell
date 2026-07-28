# Bundled-skill seeding: opt-out markers (task #84)

**Every profile under `/root/.hermes/profiles/<agent>/` carries a
`.no-bundled-skills` marker file.** Do not delete them without understanding this.

## What goes wrong without it

`hermes profile create` seeds the bundled skills library into a NEW profile, and
— the part that actually bites — **`hermes update` re-seeds EVERY profile**:

```python
# hermes_cli/main.py:9364
# "Sync bundled skills to all profiles (including the active one)."
for p in all_profiles:
    r = seed_profile_skills(p.path, quiet=True)
```

So a Hermes VERSION UPGRADE silently bulk-installs the whole bundled library into
every agent. That is how turing and mari ended up with all 778 skills each
(~2,690 md files per profile vs ~320 for everyone else) after Travis created them
and never opened the skills menu. Agents with curated sets (loom 73, cinder 80,
main 75, custodian/anvil 74) would have had ~700 dumped on top.

**NOTE: it is NOT the gateway restart.** `sync_skills()` writes to
`HERMES_HOME/skills` — the CENTRAL library — not into profiles. Only
`seed_profile_skills()` touches profiles, and its callers are: fresh profile
create, `hermes update`'s all-profile loop, and the web dashboard.

## The fix (native, no source patching)

`has_bundled_skills_opt_out(profile_dir)` returns True when
`<profile>/.no-bundled-skills` exists, and ALL THREE callers honour it. This is
the documented mechanism behind `hermes profile create --no-skills`.

`--no-skills` itself is **mutually exclusive with `--clone`**
(profiles.py:861), and AI-Lab's create path uses `--clone` — so the flag cannot
be added to `createArgs`. Writing the marker file directly is the way.

## Verified 2026-07-28 (both directions)

```
turing (marked)        seed_profile_skills -> {'skipped_opt_out': True}, 0 -> 0   NO-OP
temp profile (unmarked) seed_profile_skills -> copied 71 skills                   SEEDS
```
The control run matters: it proves the MARKER is what stopped the seeding.

## When adding a new agent

AI-Lab's `applySpec` clones from `default`, which now carries the marker — but
confirm `--clone` actually copies dotfiles. If a new profile lacks the marker,
write it, or that agent gets the full library on the next `hermes update`.
