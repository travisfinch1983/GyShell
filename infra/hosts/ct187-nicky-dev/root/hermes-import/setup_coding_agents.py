#!/usr/bin/env python3
"""Create the coding-team Hermes profiles on nicky-dev from the AI-Lab copies in /root/hermes-import.
Idempotent: re-running refreshes SOUL.md and skills. (claude1, 2026-10-12)"""
import os, re, shutil, subprocess, pathlib

IMPORT = pathlib.Path("/root/hermes-import/profiles")
HOME = pathlib.Path("/root/.hermes/profiles")
DESC = {
    "turing": "Orchestrator for the coding team: takes a coding request, does small work itself, briefs the right specialist for the rest, and returns one answer.",
    "planner": "Architecture and sequencing: decides how something should be built and in what order; breaks epics into steps. Does not write the implementation.",
    "coder": "Implementation: the only agent that changes production code. Features, fixes, refactors, with tests.",
    "bug-hunter": "Diagnosis: finds out why something is broken (crashes, wrong output, intermittent failures) and proves the root cause. Does not ship the fix.",
    "security": "Security audit and threat modelling: finds reachable vulnerabilities (auth, input handling, secrets, data exposure) and shows the exploit path.",
    "optimizer": "Performance: profiles and makes things faster or smaller, and proves it with before/after measurements.",
    "mapper": "Codebase mapping and documentation: explains what the code actually does, keeps README/docs accurate.",
}
SETTING = """

---

## On this box (nicky-dev)

You work on **Nicky's contractor app**: a business application for Nicky's electrical contracting
company (expenses, payouts, estimates, bids, quotes, invoices; web UI first, then Electron, then
Android). The code is in `/root/app` (git, pushed to Gitea). Services the app uses run in Docker
(`/opt/stack`: Postgres + pgvector, Redis, Qdrant, Authentik, Caddy) — see `/opt/stack/README.md`.

You are usually called by **nicky-claude**, the Claude Code instance that builds the app, to review
or help with its work. Answer it directly and concretely: file paths, line numbers, the exact
change or finding. Nicky's business data is confidential: never send it to outside services.
"""
TEAM = """
### Calling a specialist on this box

The specialists are Hermes profiles on this machine. Brief one from your terminal tool and read its
answer from stdout:

```
hermes -p <bug-hunter|planner|coder|security|optimizer|mapper> chat -Q --yolo -q "<your brief>"
```

Give each the full brief (goal, where, context, done-looks-like, bounds): they start blind. Run
independent briefs one after another, not dozens at once — they share one local model.
"""

for name, desc in DESC.items():
    src = IMPORT / name
    dst = HOME / name
    if not dst.exists():
        subprocess.run(["hermes", "profile", "create", name, "--clone-from", "default", "--no-alias",
                        "--description", desc], check=True, capture_output=True, text=True)
    else:
        subprocess.run(["hermes", "profile", "describe", name, desc], capture_output=True, text=True)
    soul = (src / "SOUL.md").read_text()
    soul = soul.replace("Travis talks to you and to nobody else on it.", "nicky-claude (the Claude Code instance building Nicky's app), Nicky or Travis talks to you; nobody talks to the specialists directly.")
    soul = re.sub(r"\bTravis\b", "the person you work for", soul)
    soul = soul.replace("the person you work for talks to **you**. He does", "The person you work for talks to **you**. They do")
    soul += SETTING + (TEAM if name == "turing" else "")
    (dst / "SOUL.md").write_text(soul)
    if (dst / "skills").exists():
        shutil.rmtree(dst / "skills")
    shutil.copytree(src / "skills", dst / "skills", ignore=shutil.ignore_patterns(".usage.json*", ".curator_ledger.jsonl"))
    n = sum(1 for _ in (dst / "skills").rglob("SKILL.md"))
    print(f"{name}: SOUL {len(soul)} chars, {n} skills")
