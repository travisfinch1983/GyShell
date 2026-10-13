#!/usr/bin/env python3
"""
Claude Instance Manager — the control plane for the consolidated Claude fleet
living as per-user dtach sessions inside CT180. AI-Lab's Claude-tab UI calls
these endpoints (proxied through AI-Lab's /api/claude/instances) to list,
spawn, control (exit / -c / -r), rename, and set soft cluster-permissions on
each instance.

Returns Fable's frozen UI contract shape directly, so the AI-Lab route is a
thin pass-through:

  GET  /instances                     -> { instances: [Instance...] }
  POST /instances        {name}       -> Instance            (spawn; status needs-login)
  POST /instances/:id/control {action:'exit'|'continue'|'resume'} -> { ok, status }
  POST /instances/:id/rename  {name}  -> Instance
  PUT  /instances/:id/permissions {primaryVmid?, allowed:'all'|number[]} -> Instance

Instance = { id, name, status, termPath, primaryVmid, allowed, user, ttydPort }
status ∈ { running, starting, needs-login, stopped }

Registry (persistent metadata) at /opt/instance-manager/instances.json.
Live status is derived per-request from systemd + the claude process + auth state.
Runs as root (manages other users' units/sockets). Bind 127.0.0.1:7700 (AI-Lab
reaches it via pct exec / the cluster exec channel).
"""
import datetime
import json, os, re, subprocess, sys, stat as statmod, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REGISTRY = "/opt/instance-manager/instances.json"
# fleetd lives on CT152 since 2026-08-27. Same value as fleet-channel/adapters use.
FLEETD_URL = "http://10.0.0.219:17900"
FLEET_CHANNEL_FLAG = "--dangerously-load-development-channels server:fleet"
PORT = 7700
# ── Matrix channel for spawned instances (2026-10-04) ────────────────────────────────────────
# Every Claude instance talks to Travis over Matrix (plugin:matrix@ailab-local, the fork at
# /opt/claude-plugins-ailab). Spawn creates the bot account through a RESTRICTED key whose only
# power is the VPS script matrix-bot-provision (it briefly opens token-only sign-ups under a lock,
# registers, and restores the exact previous mode), then opens an UNENCRYPTED DM room (the plugin
# has no E2EE) and invites Travis.
MATRIX_HS = "https://matrix.deeveeyant.com"
MATRIX_VPS = "root@107.173.17.151"
MATRIX_PROVISION_KEY = "/opt/instance-manager/matrix_provision_key"
MATRIX_OWNER = "@travis:deeveeyant.com"
MATRIX_PLUGIN = "matrix@ailab-local"
MATRIX_MARKETPLACE = "/opt/claude-plugins-ailab"
AILAB_API = "http://10.0.0.219:17890"
TERM_BASE = "/api/claude/term"

# Optional message-forwarding (Fable-style): a Stop hook that relays this instance's marked
# final messages to the fleet bus, + a brief telling the agent how to address the coordinator.
RELAY_HOOK_TEMPLATE = '''#!/usr/bin/env python3
"""{user} Stop hook -> shared fleet relay (AI-Lab ConversationBus). Only relays a final message
that contains a [<me> -> <recipient>] marker (arrow or ->). FLEET_AGENT_ID={user}."""
import os, runpy
os.environ.setdefault("FLEET_AGENT_ID", "{user}")
runpy.run_path("/claude/bin/fleet-relay-stop-hook.py", run_name="__main__")
'''
FORWARD_BRIEF_TEMPLATE = '''# {user} — relay brief

To message your coordinator (or any agent), end your response with a line in the form
`[{user} -> {target}]: <your message>`  (arrow `->` or `→`). A Stop hook relays it automatically
to the AI-Lab fleet bus — do NOT curl anything or call a tool. Just write the marker line and
finish your turn. One recipient per turn; the message is everything after the marker. Messages TO
you (from {target} etc.) arrive directly in your terminal.
'''


def sh(cmd, timeout=15):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    except Exception:
        class _R:  # noqa
            returncode = 1; stdout = ""; stderr = "timeout"
        return _R()


def load_reg():
    try:
        with open(REGISTRY) as f:
            return json.load(f)
    except Exception:
        return {"instances": []}


def save_reg(d):
    tmp = REGISTRY + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, REGISTRY)


def unit_state(unit):
    r = sh(f"systemctl is-active {unit}.service")
    return r.stdout.strip() or "unknown"


def sock_alive(sock):
    try:
        return statmod.S_ISSOCK(os.stat(sock).st_mode)
    except Exception:
        return False


def session_running(sock):
    """True if a dtach session (or its ttyd) holds this socket. Sock-based so
    claude1 and fable (both root) are distinguished, and it works whether the
    session came from the -session unit or a pre-existing manual dtach."""
    r = sh(f"pgrep -f {re.escape(sock)} | head -1")
    return bool(r.stdout.strip())


def is_authed(home):
    """needs-login if the config dir has no oauthAccount / apiKey."""
    for p in (f"{home}/.claude.json",):
        try:
            with open(p) as f:
                txt = f.read()
            if '"oauthAccount"' in txt or '"primaryApiKey"' in txt or '"customApiKeyResponses"' in txt:
                return True
        except Exception:
            continue
    return False


# ── login expiry ──────────────────────────────────────────────────────────────
# Claude Code silently refreshes its ~8h access token, but the REFRESH token has a hard
# ~4-week life that refreshing does NOT extend. When it lapses only an interactive /login
# recovers, and systemd still reports the unit active because the PROCESS is up — that is
# how five instances ran with dead credentials for up to 22 days. The header badge exists
# so the state is visible before it bites, rather than discovered mid-task.
#
# Thresholds live HERE and nowhere else: the tier is computed server-side so the badge, any
# future alert, and the CLI checker cannot drift into disagreeing about what "orange" means.
LOGIN_TIERS = (      # (max_days_remaining, tier)  — first match wins, ordered tightest first
    (0.0, "expired"),
    (2.0, "critical"),
    (7.0, "soon"),
    (14.0, "warn"),
)


def _credentials_path(home):
    """Locate an instance's credentials file across BOTH supported layouts.

    Two exist and the registry's `home` field does not say which is in play:
      - a real HOME          -> <home>/.claude/.credentials.json
      - a CLAUDE_CONFIG_DIR  -> <dir>/.credentials.json
    Fable-Builder runs with CLAUDE_CONFIG_DIR=/root/.claude-fable, so its "home" IS the config
    dir. Probing only the first layout reported it as "never logged in" while it was logged in
    and working — a path assumption surfacing as a confident claim about someone's auth state.
    """
    for p in (f"{home}/.claude/.credentials.json", f"{home}/.credentials.json"):
        if os.path.exists(p):
            return p
    return None


def login_info(home):
    """-> dict describing refresh-token life. Never returns or logs a token value."""
    path = _credentials_path(home) if home else None
    if not path:
        return {"tier": "unknown", "daysLeft": None, "expiresAt": None,
                "detail": "no credentials file found under either layout "
                          "(<home>/.claude/ or <config-dir>/) — cannot determine login state"}
    try:
        with open(path) as f:
            oauth = (json.load(f) or {}).get("claudeAiOauth") or {}
    except Exception as e:
        return {"tier": "unknown", "daysLeft": None, "expiresAt": None,
                "detail": f"credentials file unreadable ({e.__class__.__name__})"}
    exp = oauth.get("refreshTokenExpiresAt")
    if not exp:
        return {"tier": "unknown", "daysLeft": None, "expiresAt": None,
                "detail": "no refreshTokenExpiresAt recorded — never logged in, or logged out"}
    try:
        when = datetime.datetime.fromtimestamp(int(exp) / 1000)
    except Exception:
        return {"tier": "unknown", "daysLeft": None, "expiresAt": None,
                "detail": f"refreshTokenExpiresAt is not a timestamp: {exp!r}"}
    days = (when - datetime.datetime.now()).total_seconds() / 86400.0
    stamp = when.strftime("%Y-%m-%d %H:%M")
    tier = "ok"
    for limit, name in LOGIN_TIERS:
        if days <= limit:
            tier = name
            break
    detail = (f"login EXPIRED {abs(days):.1f} days ago (on {stamp}) — only an interactive "
              f"/login restores it; auto-refresh cannot recover an expired refresh token"
              if tier == "expired" else
              f"login valid for {days:.1f} more days (until {stamp})")
    return {"tier": tier, "daysLeft": round(days, 2), "expiresAt": when.isoformat(timespec="minutes"),
            "detail": detail}


# ── remote instances ─────────────────────────────────────────────────────────
# An instance whose registry entry has "host" (e.g. "root@10.0.0.24") runs in ANOTHER container:
# its status, login state and controls go over SSH (this box's root key, authorized there), and
# AI-Lab's console attaches to its dtach socket on that host (to_ui exposes it as sshTarget).
# Probes are cached briefly: AI-Lab polls /instances every few seconds.
REMOTE_KEY = "/root/.ssh/id_ed25519"
_remote_cache = {}


def rsh(host, cmd, timeout=12):
    return subprocess.run(["ssh", "-i", REMOTE_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=6",
                           "-o", "StrictHostKeyChecking=accept-new", host, cmd],
                          capture_output=True, text=True, timeout=timeout)


def remote_probe(inst):
    host, now = inst["host"], datetime.datetime.now().timestamp()
    c = _remote_cache.get(inst["id"])
    if c and now - c[0] < 15:
        return c[1]
    sock, home, unit = inst.get("sock", ""), inst.get("home", "/root"), inst.get("unit", "")
    script = (f"S={json.dumps(sock)}; H={json.dumps(home)}; "
              "sockok=0; [ -S \"$S\" ] && pgrep -f \"$S\" >/dev/null && sockok=1; "
              "authed=0; grep -q -E '\"(oauthAccount|primaryApiKey|customApiKeyResponses)\"' \"$H/.claude.json\" 2>/dev/null && authed=1; "
              "exp=$(python3 -c \"import json;print((json.load(open('$H/.claude/.credentials.json')).get('claudeAiOauth') or {}).get('refreshTokenExpiresAt',''))\" 2>/dev/null); "
              f"st=$(systemctl is-active {unit}.service 2>/dev/null); "
              "echo \"$sockok $authed ${exp:-none} ${st:-unknown}\"")
    try:
        r = rsh(host, script)
        parts = r.stdout.split()
        if r.returncode != 0 or len(parts) < 4:
            raise RuntimeError((r.stderr or r.stdout).strip()[:160] or f"exit {r.returncode}")
        sockok, authed, exp, st = parts[:4]
        res = {"ok": True, "running": sockok == "1", "authed": authed == "1", "exp": None if exp == "none" else exp, "unit": st}
    except Exception as e:
        res = {"ok": False, "error": str(e)[:200]}
    _remote_cache[inst["id"]] = (now, res)
    return res


def remote_login_info(res):
    if not res.get("ok"):
        return {"tier": "unknown", "daysLeft": None, "expiresAt": None, "detail": f"remote host unreachable: {res.get('error')}"}
    if not res.get("exp"):
        return {"tier": "unknown", "daysLeft": None, "expiresAt": None, "detail": "no refreshTokenExpiresAt recorded — never logged in, or logged out"}
    when = datetime.datetime.fromtimestamp(int(res["exp"]) / 1000)
    days = (when - datetime.datetime.now()).total_seconds() / 86400.0
    tier = "ok"
    for limit, name in LOGIN_TIERS:
        if days <= limit:
            tier = name
            break
    stamp = when.strftime("%Y-%m-%d %H:%M")
    return {"tier": tier, "daysLeft": round(days, 2), "expiresAt": when.isoformat(timespec="minutes"),
            "detail": f"login EXPIRED {abs(days):.1f} days ago (on {stamp})" if tier == "expired" else f"login valid for {days:.1f} more days (until {stamp})"}


def derive_status(inst):
    if inst.get("host"):
        res = remote_probe(inst)
        if not res.get("ok"):
            return "unreachable"
        if res["running"]:
            return "running" if res["authed"] else "needs-login"
        return "starting" if res["unit"] == "activating" else "stopped"
    # actual runtime first (survives the "unit enabled-not-started but running via
    # a pre-existing dtach" case, e.g. claude1)
    if sock_alive(inst.get("sock", "")) and session_running(inst.get("sock", "")):
        return "running" if is_authed(inst.get("home", "")) else "needs-login"
    st = unit_state(inst.get("unit")) if inst.get("unit") else "unknown"
    if st == "activating":
        return "starting"
    return "stopped"


def to_ui(inst):
    return {
        "id": inst["id"],
        "name": inst.get("name", inst["id"]),
        "status": derive_status(inst),
        "termPath": f"{TERM_BASE}/{inst.get('termId', inst['id'])}",
        "primaryVmid": inst.get("primaryVmid"),
        "allowed": inst.get("allowed", "all"),
        "user": inst.get("user", "root"),
        "ttydPort": inst.get("ttydPort"),
        # dtach socket path — authoritative in the registry (socket names have no derivation
        # rule, e.g. claude-dhb). Consumed by the native-console bridge to attach the PTY.
        "sock": inst.get("sock"),
        # Refresh-token life, for the header badge. Computed here so the tier has ONE
        # definition; a UI that recomputed thresholds would drift from any alert that used them.
        "login": remote_login_info(remote_probe(inst)) if inst.get("host") else login_info(inst.get("home", "")),
        # remote instances: the SSH target AI-Lab's console attaches through (None = this box)
        "sshTarget": inst.get("host"),
    }


def find(reg, iid):
    return next((i for i in reg["instances"] if i["id"] == iid), None)


# ── control actions ──────────────────────────────────────────────────────────
def do_control(inst, action):
    unit = inst.get("unit")
    home = inst.get("home", "")
    if not unit:
        return False, "no unit"
    # continue (-c) / resume (-r): drop a launch-mode marker the launcher reads, then restart.
    mode = "resume" if action == "resume" else "continue"
    if inst.get("host"):
        _remote_cache.pop(inst["id"], None)
        if action == "exit":
            r = rsh(inst["host"], f"systemctl stop {unit}.service")
            return r.returncode == 0, "stopped" if r.returncode == 0 else (r.stderr.strip()[:160] or "failed")
        r = rsh(inst["host"], f"echo {mode} > {home}/.claude-launch-mode; systemctl restart {unit}.service")
        return r.returncode == 0, "starting" if r.returncode == 0 else (r.stderr.strip()[:160] or "failed")
    if action == "exit":
        sh(f"systemctl stop {unit}.service")
        return True, "stopped"
    try:
        with open(f"{home}/.claude-launch-mode", "w") as f:
            f.write(mode)
    except Exception:
        pass
    sh(f"systemctl restart {unit}.service")
    return True, "starting"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return {}

    def do_GET(self):
        if self.path.rstrip("/") == "/instances":
            reg = load_reg()
            return self._send(200, {"instances": [to_ui(i) for i in reg["instances"]]})
        if self.path.rstrip("/") == "/health":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        reg = load_reg()
        m = re.match(r"^/instances/([^/]+)/(control|rename)$", self.path.rstrip("/"))
        if self.path.rstrip("/") == "/instances":
            return self._spawn(reg)
        if m:
            iid, verb = m.group(1), m.group(2)
            inst = find(reg, iid)
            if not inst:
                return self._send(404, {"error": "instance not found"})
            b = self._body()
            if verb == "control":
                ok, status = do_control(inst, b.get("action", ""))
                return self._send(200, {"ok": ok, "status": status})
            if verb == "rename":
                inst["name"] = b.get("name", inst.get("name"))
                save_reg(reg)
                return self._send(200, to_ui(inst))
        self._send(404, {"error": "not found"})

    def do_PUT(self):
        reg = load_reg()
        m = re.match(r"^/instances/([^/]+)/permissions$", self.path.rstrip("/"))
        if m:
            inst = find(reg, m.group(1))
            if not inst:
                return self._send(404, {"error": "instance not found"})
            b = self._body()
            if "primaryVmid" in b:
                inst["primaryVmid"] = b["primaryVmid"]
            if "allowed" in b:
                inst["allowed"] = b["allowed"]
            save_reg(reg)
            return self._send(200, to_ui(inst))
        self._send(404, {"error": "not found"})

    def _spawn(self, reg):
        b = self._body()
        name = (b.get("name") or "").strip()
        if not name:
            return self._send(400, {"error": "name required"})
        # derive a safe unix user + id
        slug = re.sub(r"[^a-z0-9-]", "", name.lower().replace(" ", "-")) or "instance"
        user = slug if not slug[0].isdigit() else f"i-{slug}"
        if find(reg, user) or sh(f"id {user}").returncode == 0:
            return self._send(409, {"error": f"instance/user {user} already exists"})
        home = f"/home/{user}"
        # pick a free ttyd port in the 76xx band
        used = {i.get("ttydPort") for i in reg["instances"]}
        port = next(p for p in range(7695, 7720) if p not in used)
        termid = user
        sock = f"/tmp/claude-{user}.sock"
        # provision: user + launcher + units (fresh claude -> /login), enable+start
        fleetd = FLEETD_URL
        chanflag = FLEET_CHANNEL_FLAG
        prov = f"""
set -e
useradd -m -s /bin/bash {user} 2>/dev/null || true
echo '{user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/{user}; chmod 440 /etc/sudoers.d/{user}
# Provision claude for the new user: fresh users have none on PATH, and root's copy is NOT
# executable by them (Permission denied -> session exits -> ttyd loops on a missing socket).
# Copy the shared install (latest version) + symlink; the chown below covers ownership.
mkdir -p {home}/.local/share/claude/versions {home}/.local/bin
SRCVER=$(ls -1 /root/.local/share/claude/versions/ 2>/dev/null | sort -V | tail -1)
cp -a /root/.local/share/claude/versions/$SRCVER {home}/.local/share/claude/versions/
ln -sf {home}/.local/share/claude/versions/$SRCVER {home}/.local/bin/claude
cat > {home}/{user}-launch.sh <<'L'
#!/bin/bash
cd {home} || exit 1
export PATH="$HOME/.local/bin:$PATH"
CLAUDE="$(command -v claude || echo $HOME/.local/bin/claude)"
BRIEF=""; [ -f {home}/BRIEF.md ] && BRIEF="--append-system-prompt-file {home}/BRIEF.md"
# Fleet channel identity. FLEETD_URL is explicit rather than left to a default: fleetd moved off
# this container on 2026-08-27, and a stale default stays invisible until a restart needs it.
export FLEET_AGENT_ID={user}
export FLEETD_URL={fleetd}
# ONE array so every launch path (resume / continue / fresh) gets identical flags, and so
# migrate_instance.py has the shape it edits. Spawned instances previously wrote the flags inline
# per path, which meant a new instance came up with NO fleet channel and nobody noticed until it
# failed to answer a message.
COMMON=({chanflag} --dangerously-skip-permissions)
MODE=$(cat {home}/.claude-launch-mode 2>/dev/null); rm -f {home}/.claude-launch-mode
if [ "$MODE" = resume ] && ls {home}/.claude/projects/*/*.jsonl >/dev/null 2>&1; then exec "$CLAUDE" -r "${{COMMON[@]}}" $BRIEF
elif ls {home}/.claude/projects/*/*.jsonl >/dev/null 2>&1; then "$CLAUDE" --continue "${{COMMON[@]}}" $BRIEF || exec "$CLAUDE" "${{COMMON[@]}}" $BRIEF
else exec "$CLAUDE" "${{COMMON[@]}}" $BRIEF; fi
L
chmod +x {home}/{user}-launch.sh; chown -R {user}:{user} {home}
cat > /etc/systemd/system/{user}-session.service <<U
[Unit]
Description={name} — Claude Code headless session (dtach)
After=network-online.target
[Service]
Type=simple
User={user}
Group={user}
Environment=HOME={home}
Environment=IS_SANDBOX=1
Environment=CLAUDE_INSTANCE_ID={user}
WorkingDirectory={home}
ExecStart=/usr/bin/dtach -N {sock} {home}/{user}-launch.sh
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
U
# NO ttyd unit. Retired 2026-09-01: the native xterm.js console attaches to this same
# dtach socket over SSH and enforces ONE WRITER per session, which ttyd could not — it
# spawned a `dtach -a` per browser client, so two clients (or one plus a wifi reconnect)
# shared and stomped the same input line. Each ttyd was also an unauthenticated writable
# terminal; six of them, one as root, had to be fenced with nftables rather than removed.
# Recreating one here would have made the decommission cosmetic.
mkdir -p /etc/systemd/system/{user}-session.service.d
cat > /etc/systemd/system/{user}-session.service.d/fleet-accept.conf <<U
# Clear the dev-channel dialog so an UNATTENDED restart still loads the fleet channel.
# Without this the session sits on a dialog forever and the fleet goes quiet silently.
[Service]
ExecStartPost=-/opt/fleet-channel/adapters/fleet-accept-dialog.sh {user} {sock}
U
systemctl daemon-reload
systemctl enable {user}-session.service
"""
        r = sh(prov, timeout=60)
        if r.returncode != 0:
            return self._send(500, {"error": "provision failed", "detail": r.stderr[-400:]})
        # Default per-instance config: permission options, AI-Lab MCP gateway, folder-trust
        # auto-accept, and fleet relay registration — everything EXCEPT the optional message-
        # forwarding hook (wired only when forwardTo is set). Non-fatal: the instance still runs.
        forward_to = (b.get("forwardTo") or "").strip() or None
        # Registry entry FIRST: migrate_instance.py resolves an instance through
        # instances.json, so configuring before registering would silently skip the fleet
        # migration for the very instance being created.
        inst = {"id": user, "name": name, "user": user, "home": home, "sock": sock,
                "unit": f"{user}-session", "ttydPort": port, "termId": termid,
                "primaryVmid": 180, "allowed": "all", "forwardTo": forward_to}
        reg["instances"].append(inst)
        save_reg(reg)
        try:
            self._provision_defaults(user, home, name, forward_to)
        except Exception as e:
            sys.stderr.write(f"[spawn] config provisioning warning for {user}: {e}\n")
        # Start now that config is seeded (units were enabled, not started, above).
        sh(f"systemctl start {user}-session.service")
        return self._send(201, to_ui(inst))

    def _provision_defaults(self, user, home, name, forward_to):
        """Automated per-spawn setup (see _spawn). Idempotent; safe to re-run."""
        cdir = f"{home}/.claude"
        os.makedirs(cdir, exist_ok=True)
        settings = {
            "permissions": {"defaultMode": "bypassPermissions"},
            "skipDangerousModePermissionPrompt": True,
            "theme": "dark",
            "tui": "fullscreen",
        }
        if forward_to:
            settings["hooks"] = {"Stop": [{"hooks": [{"type": "command",
                                 "command": f"python3 {home}/stop-relay-hook.py"}]}]}
        json.dump(settings, open(f"{cdir}/settings.json", "w"), indent=2)
        # AI-Lab MCP gateway (user scope) + pre-accept the folder-trust dialog (else a headless
        # instance hangs on "Do you trust this folder?" and never finishes starting).
        cj = f"{home}/.claude.json"
        d = json.load(open(cj)) if os.path.exists(cj) else {}
        d.setdefault("mcpServers", {})["ai-lab"] = {"command": "/usr/bin/node",
            "args": ["/opt/mcpjungle-bridge/mcpjungle-bridge.mjs", "http://10.0.0.219:8080/mcp"]}
        d.setdefault("projects", {}).setdefault(home, {})["hasTrustDialogAccepted"] = True
        json.dump(d, open(cj, "w"), indent=2)
        # Optional message-forwarding: relay Stop hook + a brief telling the agent to report to forward_to.
        if forward_to:
            open(f"{home}/stop-relay-hook.py", "w").write(RELAY_HOOK_TEMPLATE.format(user=user))
            open(f"{home}/BRIEF.md", "w").write(FORWARD_BRIEF_TEMPLATE.format(user=user, target=forward_to))
        sh(f"chmod +x {home}/stop-relay-hook.py 2>/dev/null; chown -R {user}:{user} {home}")
        # Fleet relay setup: register as an agent + add to the forwarder so it can send/receive fleet msgs.
        self._fleet_register(user, name)
        self._forwarder_add(user, f"/tmp/claude-{user}.sock")
        # Fleet CHANNEL (distinct from the legacy relay above): .mcp.json server, heartbeat
        # hooks and fleetd registration. Idempotent and the single source of truth for that
        # wiring — duplicating its steps here would leave two versions to drift apart.
        r = sh(f"python3 /opt/fleet-channel/adapters/migrate_instance.py {user}", timeout=60)
        sys.stderr.write(f"[spawn] fleet-channel migrate {user}: "
                         f"{(r.stdout or r.stderr or '').strip()[:200]}\n")
        # Matrix channel: AFTER the fleet migration, which owns the COMMON=() flag line this edits.
        # Non-fatal — an instance without Matrix still runs; the reason is logged and reported.
        try:
            self._provision_matrix(user, home, name)
        except Exception as e:
            sys.stderr.write(f"[spawn] matrix provisioning FAILED for {user}: {e}\n")
            self._notify("warning", f"Matrix channel not set up for new instance {user}", str(e)[:400])

    # ── Matrix ──────────────────────────────────────────────────────────────────────────────
    def _matrix_call(self, method, path, token, body=None):
        req = urllib.request.Request(MATRIX_HS + path,
                                     json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": f"Bearer {token}"}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def _provision_matrix(self, user, home, name):
        """Bot account + DM room with Travis + plugin config + launcher flag. Idempotent-ish:
        skips everything if this instance already has a Matrix .env."""
        chan = f"{home}/.claude/channels/matrix"
        if os.path.exists(f"{chan}/.env"):
            sys.stderr.write(f"[spawn] matrix: {user} already configured, skipping\n")
            return
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,39}", user):
            raise RuntimeError(f"user '{user}' is not a valid Matrix localpart")
        # 1. account (restricted key -> matrix-bot-provision on the VPS)
        r = subprocess.run(["ssh", "-i", MATRIX_PROVISION_KEY, "-o", "BatchMode=yes",
                            "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new",
                            MATRIX_VPS, user], capture_output=True, text=True, timeout=120)
        line = next((l for l in r.stdout.splitlines() if l.startswith("RESULT: ")), None)
        if not line:
            raise RuntimeError(f"account provisioning failed: {(r.stdout + r.stderr).strip()[:300]}")
        acct = json.loads(line[len("RESULT: "):])
        uid, tok = acct["user_id"], acct["access_token"]
        # 2. profile + unencrypted DM room, Travis invited
        self._matrix_call("PUT", f"/_matrix/client/v3/profile/{uid}/displayname", tok, {"displayname": name})
        st, room = self._matrix_call("POST", "/_matrix/client/v3/createRoom", tok, {
            "preset": "trusted_private_chat", "is_direct": True, "invite": [MATRIX_OWNER],
            "name": name,
            "topic": f"{user} Claude Code channel. Unencrypted on purpose: the channel plugin has no E2EE support."})
        rid = room.get("room_id")
        if st != 200 or not rid:
            raise RuntimeError(f"createRoom failed ({st}): {room}")
        self._matrix_call("PUT", f"/_matrix/client/v3/user/{uid}/account_data/m.direct", tok, {MATRIX_OWNER: [rid]})
        self._matrix_call("PUT", f"/_matrix/client/v3/rooms/{rid}/send/m.room.message/spawn-{int(datetime.datetime.now().timestamp())}", tok,
                          {"msgtype": "m.notice", "body": f"New Claude Code instance \"{name}\" ({user}) was just spawned. "
                           "This room is its channel — messages here reach it once it has finished /login."})
        # 3. plugin config, owned by the instance user
        os.makedirs(chan, exist_ok=True)
        with open(f"{chan}/.env", "w") as f:
            f.write(f"MATRIX_HOMESERVER_URL={MATRIX_HS}\nMATRIX_ACCESS_TOKEN={tok}\n"
                    f"MATRIX_BOT_USER_ID={uid}\nMATRIX_ROOM_IDS={rid}\n")
        with open(f"{chan}/access.json", "w") as f:
            json.dump({"allowedUsers": [MATRIX_OWNER], "ackReaction": "\U0001F440"}, f, indent=2)
        sh(f"chown -R {user}:{user} {home}/.claude/channels && chmod 700 {chan} && chmod 600 {chan}/.env {chan}/access.json")
        # 4. install the plugin as the instance user (user scope)
        env = f"HOME={home} PATH=/usr/local/bin:/usr/bin:/bin:{home}/.local/bin"
        for args in (f"marketplace add {MATRIX_MARKETPLACE}", f"install {MATRIX_PLUGIN}"):
            r = sh(f"cd {home} && runuser -u {user} -- env {env} {home}/.local/bin/claude plugin {args}", timeout=120)
            if r.returncode != 0:
                raise RuntimeError(f"claude plugin {args} failed: {(r.stdout + r.stderr).strip()[-300:]}")
        # 5. launcher: load the channel next to fleet
        lp = f"{home}/{user}-launch.sh"
        ls_ = open(lp).read()
        if f"plugin:{MATRIX_PLUGIN}" not in ls_:
            ls_ = ls_.replace(FLEET_CHANNEL_FLAG, f"{FLEET_CHANNEL_FLAG} plugin:{MATRIX_PLUGIN}")
            if f"plugin:{MATRIX_PLUGIN}" not in ls_:
                raise RuntimeError(f"could not add plugin flag to {lp} (no '{FLEET_CHANNEL_FLAG}' in it)")
            open(lp, "w").write(ls_)
        # 6. credentials into the AI-Lab vault (best effort — the instance works without it)
        try:
            body = json.dumps({"name": f"Matrix bot {uid}", "type": "user_pass", "url": MATRIX_HS,
                               "username": uid, "password": acct.get("password", ""), "bearerToken": tok,
                               "notes": f"{user} Claude Code Matrix channel bot, created by instance-manager spawn. "
                                        f"Device {acct.get('device_id')}. DM room {rid} (unencrypted)."}).encode()
            urllib.request.urlopen(urllib.request.Request(f"{AILAB_API}/api/ai/credentials", data=body,
                                   headers={"Content-Type": "application/json"}, method="POST"), timeout=10).read()
        except Exception as e:
            sys.stderr.write(f"[spawn] matrix: vault store failed for {uid}: {e}\n")
        sys.stderr.write(f"[spawn] matrix: {uid} ready, room {rid}, invite sent to {MATRIX_OWNER}\n")

    def _notify(self, severity, message, detail=""):
        """Put a failure in front of Travis (AI-Lab notifications) instead of only a log line."""
        try:
            body = json.dumps({"severity": severity, "source": "instance-manager",
                               "message": message, "detail": detail}).encode()
            urllib.request.urlopen(urllib.request.Request(f"{AILAB_API}/api/notifications/emit", data=body,
                                   headers={"Content-Type": "application/json"}, method="POST"), timeout=8).read()
        except Exception as e:
            sys.stderr.write(f"[spawn] notify failed: {e}\n")

    def _fleet_register(self, agent_id, display):
        data = json.dumps({"agentId": agent_id, "displayName": display or agent_id,
                           "kind": "relay", "relayRecipient": agent_id}).encode()
        req = urllib.request.Request("http://10.0.0.219:17890/api/fleet/register", data=data,
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=8).read()

    def _forwarder_add(self, agent_id, sock):
        p = "/opt/fleet-forwarder/config.json"
        cfg = json.load(open(p))
        cfg.setdefault("instances", {})[agent_id] = sock
        json.dump(cfg, open(p, "w"), indent=2)
        sh("systemctl restart fleet-forwarder.service")


if __name__ == "__main__":
    # Bind the LAN so AI-Lab (CT152) reaches it directly at 10.0.0.161:7700,
    # exactly like it dials the ttyd term proxy. Trusted cluster net only.
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
