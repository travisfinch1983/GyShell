#!/usr/bin/env python3
"""Post a reply to a watched GitHub PR/issue — and tell Travis what was said.

WHY THIS EXISTS (Travis, 2026-08-22): the monitoring is only half a commitment
if the agent can see maintainer questions but not answer them. This closes that
loop. It deliberately notifies Travis on Telegram for EVERY post, including the
reasoning, so nothing goes out under his GitHub identity without him learning of
it — he is accountable for that account even when an agent does the typing.

Usage:
  pr-reply.py <pr-number> --body-file <path> --why "<one line: why this warrants a reply>"
  pr-reply.py <pr-number> --body-file <path> --why "..." --dry-run

Refuses to post unless the PR is one pr-watch is configured to watch, so a
comment quoted from the internet cannot steer a reply to an unrelated thread.
"""
import argparse, json, os, subprocess, sys, urllib.parse, urllib.request

CONFIG = os.environ.get("PRWATCH_CONFIG", "/opt/pr-watch/config.json")
TOKEN_FILE = "/root/.config/gh/token"


def die(msg, code=2):
    print(f"pr-reply: {msg}", file=sys.stderr)
    sys.exit(code)


def watched_repo_for(pr):
    try:
        cfg = json.load(open(CONFIG))
    except (OSError, ValueError) as e:
        die(f"cannot read {CONFIG}: {e}")
    for w in cfg.get("watch") or []:
        if int(w.get("pr", -1)) == pr:
            return w.get("repo")
    return None


def telegram(text):
    """Notify Travis. Name kept for the call sites; it now posts to his Matrix DM with claude1
    via /usr/local/bin/matrix-notify (Telegram retired 2026-10-16)."""
    import subprocess
    try:
        r = subprocess.run(["/usr/local/bin/matrix-notify"], input=text[:30000], text=True,
                           capture_output=True, timeout=90)
    except Exception as e:  # noqa: BLE001
        print(f"pr-reply: WARNING matrix-notify failed to run: {e}", file=sys.stderr); return False
    if r.returncode != 0:
        print(f"pr-reply: WARNING matrix-notify failed: {r.stderr.strip()[:300]}", file=sys.stderr); return False
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pr", type=int)
    ap.add_argument("--body-file", required=True)
    ap.add_argument("--why", required=True, help="one line: why a reply is warranted")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    repo = watched_repo_for(a.pr)
    if not repo:
        die(f"PR #{a.pr} is not in {CONFIG}'s watch list — refusing to post. "
            f"Register it first; this guard stops quoted text steering a reply "
            f"to an unrelated thread.")

    try:
        body = open(a.body_file).read().strip()
    except OSError as e:
        die(f"cannot read body file: {e}")
    if not body:
        die("refusing to post an empty comment")

    # Always disclose authorship on the comment itself.
    if "Claude" not in body:
        body += ("\n\n---\n*Posted by Claude (Anthropic's Claude Code) on behalf of the "
                 "account owner, who is notified of every reply. Monitored by both — "
                 "happy to follow up.*")

    if a.dry_run:
        print(f"[DRY RUN] would comment on {repo}#{a.pr}:\n{'-'*60}\n{body}\n{'-'*60}")
        return 0

    token = ""
    try:
        token = open(TOKEN_FILE).read().strip()
    except OSError:
        pass
    env = dict(os.environ)
    if token:
        env["GH_TOKEN"] = token

    p = subprocess.run(
        ["gh", "pr", "comment", str(a.pr), "--repo", repo, "--body", body],
        capture_output=True, text=True, timeout=60, env=env)
    if p.returncode != 0:
        err = (p.stderr or "").strip()[:400]
        telegram(f"⚠️ PR REPLY FAILED — {repo}#{a.pr}\n\n{err}")
        die(f"gh pr comment failed: {err}", 1)

    url = (p.stdout or "").strip()
    print(f"posted: {url}")
    telegram(
        f"💬 Claude replied on {repo}#{a.pr}\n\n"
        f"WHY: {a.why}\n\n"
        f"WHAT WAS POSTED:\n{body[:1800]}\n\n{url}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
