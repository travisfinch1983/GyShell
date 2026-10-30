# Remote consoles — prototypes (2026-10-30)

Roadmap: "Remote consoles in AI-Lab (AMT + IPMI KVM)" (proj-mvvicu101qp). These were proven by hand on
CT181 and then shut down; they have NO authentication of their own and must only run behind AI-Lab's login.
Credentials come from the environment (vault entries cred-0881b9af AMT, cred-d74574cc BMCs) — never commit them.

| Target | Box | Approach | Result |
|---|---|---|---|
| Intel AMT 15 (esp32-net, 10.50.0.6) | AAEON UP Xtreme i11 | `amt-kvm-relay.mjs` + noVNC 1.7.0 | ✅ full colour, keyboard works |
| px-nas BMC 10.0.20.30 | Supermicro X11, fw 01.04.03 | `bmc-proxy.mjs` `BMC_VENDOR=supermicro` | ✅ |
| px-epyc BMC 10.0.20.10 | Supermicro H12 (AS-4124GS-TNR), AST2500 fw 01.08.04 | `BMC_VENDOR=supermicro-redfish` | ✅ |
| px-gpu BMC 10.0.20.20 | Inspur / AMI MegaRAC SP-X | `BMC_VENDOR=megarac` | ✅ (view; "partial access" until older sessions expire) |

## amt-kvm-relay.mjs
Browser (noVNC over WebSocket) ↔ AMT redirection port 16994. Does the redirection handshake + digest auth
server-side (protocol from MeshCommander amt-redir-ws), then translates RFB:
- presents RFB 3.8 and renames the desktop — noVNC forces a poor 8-bit mode when the name is "Intel(r) AMT KVM";
- keeps AMT on its native RGB565, rewrites SetEncodings to Raw + DesktopSize, expands Raw rects 16→32 bpp.
Env: `AMT_HOST AMT_PORT AMT_USER AMT_PASS PORT DISPLAY_NAME`. Serves `console.html` + noVNC from `novnc/package`.

**Headless boxes:** with no monitor the iGPU disables every output → AMT shows black and drops the session at
~29 s. Force a connector: kernel cmdline `video=HDMI-A-1:1024x768@60e`. AMT also refuses a new session for
~30-45 s after the previous one closes.

`amt-wsman.py` — minimal WS-Man client used to enable KVM (CIM_KVMRedirectionSAP RequestStateChange 2,
AMT_RedirectionService ListenerEnabled) and set AMT's static IP (AMT_EthernetPortSettings).

## bmc-proxy.mjs
Auto-login reverse proxy for the BMC's OWN HTML5 viewer (skips the slow dashboard; BMC password stays server-side).
- `supermicro`: POST /cgi/login.cgi → SID cookie (the BMC sends an empty SID first — take the last non-empty);
  landing `/cgi/url_redirect.cgi?url_name=man_ikvm_html5_bootstrap`; viewer websocket ws://proxy/ → wss://BMC/.
- `supermicro-redfish`: Redfish session → `GET /redfish/v1/Managers/1/Oem/Supermicro/IKVM` → one-time `URI`
  that serves the HTML5 viewer page directly.
- `megarac`: POST /api/session → QSESSIONID + CSRFToken (injected as X-CSRFTOKEN); viewer `/viewer.html` needs
  sessionStorage the main UI normally sets (garc, features = /api/configuration/project, kvm_access, …) → proxy
  injects a seed script. 🛑 The BMC's /kvm websocket returns 400 without an `Origin` header (set via the ws
  library's `origin` option — a plain header is dropped).
Env: `BMC_HOST BMC_VENDOR BMC_USER BMC_PASS PORT`.

noVNC 1.7 has no ATEN (Supermicro iKVM) decoder, which is why the BMCs reuse their own viewer.
