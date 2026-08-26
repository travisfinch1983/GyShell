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

## New agents — HANDLED IN CODE (verified, not assumed)

**`hermes profile create --clone` does NOT copy dotfiles.** Tested 2026-07-28 by
creating an agent through AI-Lab from the marked `default` profile: only `.env`
came across, the marker did not, and the new profile was seeded with **778
skills**. The marker cannot be inherited, and `--no-skills` cannot be passed
(mutually exclusive with `--clone`, profiles.py:861).

So `HermesManagementService.applySpec` now does it explicitly on create: writes
`.no-bundled-skills`, clears what seeding just installed, and logs the counts.
Verified on a fresh agent:

```
[hermes] zzskilltest2: cleared 778 auto-seeded bundled skill(s) and wrote
         .no-bundled-skills (was 778, now 0). Assign skills deliberately.
```

New agents therefore start with NO skills by design — assign them deliberately
via the AI-Lab Skills tab. If the opt-out ever fails it logs loudly rather than
failing silently, because the symptom otherwise only appears at the next
`hermes update`, long after the cause.
