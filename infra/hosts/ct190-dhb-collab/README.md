# CT190 `dhb-collab`: an internet-exposed Claude Code box for a DHB coworker

Built 2026-11-03 by claude1 at Travis's request. Travis's DHB coworker uses it with **his own
enterprise Claude account** and reaches it over SSH from the internet. Its Claude Code instance is
fleet agent **`claude-dhb-collab`**.

| | |
|---|---|
| Container | **CT190** on **px-nas**, Debian 13, unprivileged, nesting+keyctl, 8c / 16 GB / 64 GB `local-zfs` |
| Address | **10.0.0.194** static. It is outside Technitium's dynamic pool (.21-.59), with no reservation. DNS is public (1.1.1.1 / 9.9.9.9). |
| SSH | Port **47983**, public key only. `PermitRootLogin no`, except root from **10.0.0.161** (claude1) with a key. `AllowGroups root sshusers`, no forwarding. fail2ban (nftables, systemd backend) bans for 1 h, escalating to 1 w. |
| Internet | OPNsense NAT `rdr pass` **WAN tcp 47983 → 10.0.0.194:47983**, logged. Backup: `/conf/config.xml.claude-pre-ct190-fwd-20261103`. |
| DNS name | `dhb-collab.deeveeyant.com` is a Cloudflare A record, **DNS-only**, pointing at the home WAN IP. It is kept current by **`cf-ddns.timer` on CT152** (every 5 min; two IP sources must agree; config and token in `/opt/ai-lab-secrets/cf-ddns/env`, not in git; add more names to `CF_DDNS_RECORDS`). On the LAN, Technitium's split-horizon resolves it to NPM, so test it from outside. |
| Patching | unattended-upgrades are on. |

## The fence: what CT190 can reach

It is enforced on the **px-nas host** (`etc/dhb-collab-ct190-fence.nft` and the unit in
`infra/hosts/px-nas`), so root inside the container cannot change it.

- **Egress to the LAN** is allowed only to `10.0.0.219:8098` (the gate) and `10.0.0.219:9857` (memory
  server #2). All other RFC1918, CGNAT, link-local and IPv6 traffic is dropped, and the internet is open.
- **Anti-spoofing:** frames must carry CT190's own MAC and IP, and ARP is limited to .194. This
  matters because the gate and the memory server identify callers by source IP.
- **Ingress:** only new TCP connections to 47983 are allowed. To expose anything else, Travis approves
  it, claude1 evaluates it, and claude1 adds a rule here.

## Lab side (CT152)

| Piece | What it is |
|---|---|
| `dhb-collab-gate.service` → `/opt/ai-lab-mcp/dhb-collab-gate.py 8098` | An allow-list proxy that accepts only CT190 and CT196 source IPs. **Fleet:** the sender, agent_id and viewer are FORCED to `claude-dhb-collab`, and DMs may go only to `claude1` and `claude-dhb-enterprise`. Feed, search, post, visibility, attachments, register and guard are refused, and thread reads are scoped to that viewer. fleetd does not authenticate senders, so this gate is the boundary. **Doc-RAG:** only `docs_dhb_*` collections: search, keyword search, listings, page images, and `index-b64` uploads. Uploads are forced to a `dhb_` name. **LLM:** chat/completions with the model pinned to the memory-extract model (CT190 only). |
| `ai-lab-memory-mcp-dhb.service` on **:9857** | A second instance of `/opt/mcp-unified-memory`. It uses **its own Qdrant** (`ailab-qdrant-dhb`, `127.0.0.1:6340`) and its own WAL (`/var/lib/unified-memory-wal-dhb`), with `HIPPOCAMPAI_URL=off` (patch 0004) and no OpenViking. The source IP 10.0.0.194 is **pinned** to namespace `dhb-collab`. |
| `ailab-qdrant-dhb` (compose service `qdrant-dhb`) | The second Qdrant, localhost only. It holds the **shared DHB document store** (`docs_dhb_*`, moved from the lab Qdrant 2026-11-03; snapshots in CT152 `/root/qdrant-dhb-migrate/`) and the coworker's memory. AI-Lab's vector proxy routes `docs_dhb_*` here using `collectionPrefixes: ["docs_dhb_"]` in `vector-db-config.json`. |

## Inside the container

- `opt/dhb-collab/provision-collab-user.sh <user> "<pubkey>"` creates the coworker's login: key only,
  passwordless sudo, `sshusers`. It installs Claude Code, writes the env and memory hooks into
  `~/.claude/settings.json`, and adds the user-scope MCP servers **fleet** (`cc_channel.ts`, via the gate),
  **memory** (:9857) and **dhb-docs**. It is idempotent.
- `opt/dhb-collab/CLAUDE.md` is installed as `~/.claude/CLAUDE.md`. It tells the instance it owns the
  container, that anything outside needs Travis's approval through claude1, and that outside exposure
  needs approval plus an evaluation.
- `usr/local/bin/cc` runs a persistent tmux session of `claude --dangerously-load-development-channels server:fleet`,
  so fleet messages still arrive while he's disconnected.
- `opt/dhb-docs/` is a fork of mcp-document-rag (patch `infra/patches/mcp-document-rag/0003`): it reaches
  everything through the gate and adds `add_documents` / `index_status`. Install it with
  `npm install --omit=dev` and create `data/`, writable by the user. The same server is installed on
  CT196 for claude-dhb-enterprise, whose fence gained `10.0.0.219:8098`.
- `/opt/claude-hooks` and `/opt/fleet-channel/adapters` are copies of the CT196 copies (identical
  md5 to CT152 and `/claude/bin` on 2026-11-03).

## Rollback

On px-nas: `systemctl disable --now dhb-collab-ct190-fence` (this OPENS the fence) and `pct stop 190`.
On OPNsense: delete the 47983 NAT rule and run `configctl filter reload`. On CT152:
`systemctl disable --now dhb-collab-gate ai-lab-memory-mcp-dhb`. Moving the DHB documents back means
restoring the snapshots into :6333 and removing the `qdrant-dhb` entry from `vector-db-config.json`.
