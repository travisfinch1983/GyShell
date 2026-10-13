#!/usr/bin/env python3
"""Business agents (ledger, estimator, billing), the skills library, and Claude Code skills for nicky-claude.
Idempotent. (claude1, 2026-10-12)"""
import re, shutil, subprocess, pathlib
I = pathlib.Path("/root/hermes-import")
EXT = I / "external"
HP = pathlib.Path("/root/.hermes/profiles")
LIB = pathlib.Path("/root/hermes-skills-library")

def copy_skill(src, dst_dir, name=None):
    dst = dst_dir / (name or src.name)
    if dst.exists(): shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".git", "__pycache__"))
    return dst

# the estimator skill's frontmatter name isn't a valid skill id; fix it in the staged copy
est = EXT / "jmsktm_claude-settings/skills/construction-estimator/SKILL.md"
t = est.read_text()
est.write_text(re.sub(r"^name: .*$", "name: construction-estimator", t, count=1, flags=re.M))

ANTH = EXT / "anthropics_skills/skills"
RECEIPTOR = EXT / "receiptor-ai_bookkeeping-skills/skills"
CE = I / "skills/claude-extended"
skills = {
    "ledger": [*sorted(RECEIPTOR.iterdir()), ANTH / "xlsx", CE / "finance/financial-analyst"],
    "estimator": [est.parent, ANTH / "xlsx", ANTH / "docx", ANTH / "pdf", CE / "business-growth/contract-and-proposal-writer"],
    "billing": [ANTH / "docx", ANTH / "pdf", ANTH / "xlsx", RECEIPTOR / "contractor-1099", RECEIPTOR / "monthly-close",
                CE / "business-growth/contract-and-proposal-writer"],
}
desc = {
    "ledger": "Bookkeeping auditor: checks expenses, payouts, receipts, reconciliation, job costing and 1099s; flags errors and questions. Never files or moves money.",
    "estimator": "Electrical estimating: scope, takeoff, materials, labor units, overhead and profit; builds estimates, bids, quotes and change orders.",
    "billing": "Invoices, progress billing (schedule of values, retainage), receivables aging and collections drafts. Drafts only; Nicky sends.",
}
for name, srcs in skills.items():
    if not (HP / name).exists():
        subprocess.run(["hermes", "profile", "create", name, "--clone-from", "default", "--no-alias", "--description", desc[name]], check=True, capture_output=True, text=True)
    else:
        subprocess.run(["hermes", "profile", "describe", name, desc[name]], capture_output=True, text=True)
    (HP / name / "SOUL.md").write_text((I / "business" / f"{name}.md").read_text())
    sk = HP / name / "skills"
    if sk.exists(): shutil.rmtree(sk)
    sk.mkdir()
    for s in srcs:
        if s.is_dir() and (s / "SKILL.md").exists():
            copy_skill(s, sk)
    print(f"{name}: {sum(1 for _ in sk.rglob('SKILL.md'))} skills")

# the full library, unattached, for later (custom = Travis's lab-only skills, left out)
LIB.mkdir(exist_ok=True)
for d in (I / "skills").iterdir():
    if d.name != "custom": copy_skill(d, LIB)
copy_skill(ANTH, LIB, "anthropic")
copy_skill(RECEIPTOR, LIB, "bookkeeping")
copy_skill(est.parent, LIB / "construction" if (LIB / "construction").mkdir(exist_ok=True) or True else LIB)
print("library:", sum(1 for _ in LIB.rglob("SKILL.md")), "skills in", LIB)

# Claude Code skills for nicky-claude itself
CC = pathlib.Path("/root/.claude/skills"); CC.mkdir(parents=True, exist_ok=True)
for n in ["frontend-design", "webapp-testing", "xlsx", "docx", "pdf", "skill-creator"]:
    copy_skill(ANTH / n, CC)
print("claude code skills:", sorted(p.name for p in CC.iterdir()))
