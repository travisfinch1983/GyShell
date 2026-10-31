# Cellular out-of-band (OOB) access: trailer (db-mobile) and home (AZ)

Status: **planned** (2026-10-31). Hardware to be bought in a month or two; not urgent.
Roadmap: AI-Lab Roadmap → Fifth Wheel Controls → "Cellular OOB backup on db-mobile".

## Goal

A small, always-available foothold into each site's network when the main internet is down
(Starlink in the fifth wheel; the home ISP in Arizona). It is **not** a failover for the whole
network: only the machine holding the modem uses it, for SSH and management (and from there the
AMT consoles, the firewall, Home Assistant, etc.). Data use is tiny, so a SIM lasts years.

## Hardware (trailer: db-mobile = AAEON UP Xtreme i11, board UPX-TGL01)

| Item | Choice | Notes |
|---|---|---|
| Modem slot | M.2 **3052 B-key**, with an on-board nano-SIM socket | On this board the slot is wired as **USB 3** (UP community wiki). AAEON lists the FM150 as compatible. |
| Modem | **Fibocom FM150-NA** (5G Sub-6, falls back to LTE/3G on its own) | 🛑 **Must be the -NA (North America) variant.** The FM150-**AE** (Asia/Europe/Australia) lacks n71, n25 and n66 and low-band LTE B12/B13/B71, so in the US it would only have a few overlapping bands, i.e. poor coverage. |
| FM150-NA bands | 5G n2/n5/n7/n12/n25/n41/n48/n66/n71 (+n77/n78 on some lists); LTE incl. B2/B4/B5/B12/B13/B66/B71 | T-Mobile certified (FCC/IC/PTCRB). n71 (600 MHz) is T-Mobile's wide rural band. Check the exact sub-variant's datasheet when buying. |
| Antennas | 4 × MHF4 (I-PEX 4) ports on the module; 2 is the minimum, 4 is best for 5G MIMO | Rooftop MIMO antenna planned: the network cabinet has a straight run to the roof, so the cable stays short. Pigtails: MHF4 to whatever connector the roof antenna uses (usually SMA). |
| SIM | **Google Fi data-only SIM** (free for Fi subscribers; shares the plan's data; Travis checked that Fi allows modem use) | Fi rides T-Mobile, which matches the FM150-NA's bands. Keepgo (prepaid, non-expiring GB) was the alternative. Note Fi's APN (`h2g2`) when setting up. |
| Power | Board runs on the cabinet's native 12 V rail; a 5G M.2 module peaks around 3-4 W | Fine on the existing supply. |

**Home (AZ):** same idea. Either an M.2 5G/LTE modem in a home server or mini PC, or a small LTE/5G
router with Tailscale on it (GL.iNet type) next to px-gateway. That gives a foothold on the home LAN
and the IPMI management network (10.0.20.0/24) during an outage. Same rule: the -NA band variant.

## Why it works with carrier NAT

Cellular data is behind carrier-grade NAT, so nothing can connect *in* to the SIM's address. The
box keeps an **outbound** Tailscale connection to headscale (control server on the RackNerd VPS
107.173.17.151, independent of both sites), so it stays reachable at its tailnet IP
(db-mobile = **100.64.0.1**) over cellular. Peers reach it directly or through DERP relays.
Already verified: db-mobile is reachable over the tailnet alone (`ssh db-mobile-ts`, via CT110).

## Setup plan (when the hardware arrives)

1. **Install:** modem in the 3052 slot, SIM in the board's socket, antennas. Boot, check that
   `lsusb` shows the FM150 and that `mmcli -L` sees it.
   - Install ModemManager if needed (`apt install modemmanager`). Kernel 6.12 drivers
     (option / qmi_wwan / cdc_mbim) cover it. If ModemManager talks to it badly, switch the USB
     mode to MBIM with Fibocom's AT command (`AT+GTUSBMODE`, see the FM150 AT manual).
2. **Bearer:** NetworkManager GSM profile with the SIM's APN, autoconnect on.
3. **Backup-only routing:** the cellular profile gets a high route metric (e.g. 900 vs eno1's
   100), so nothing uses it while Starlink is up. Check that the default route stays on eno1.
   Leave Tailscale's `--accept-routes=false` as it is.
4. **Data saver while on cellular:** a NetworkManager dispatcher hook. When the default route moves
   to the modem, it pauses heavy services (apt/unattended-upgrades timers, Docker image pulls,
   RustDesk, the NAS CIFS automounts, any big sync jobs) and turns them back on when eno1 returns.
   Tailscale + SSH stay up.
5. **Alerts:** Matrix notices (`matrix-notify`) on failover and recovery, plus a daily
   data-used counter from the modem's stats.
6. **Radio mode:** let the module choose (5G preferred, LTE fallback). Lock bands or force LTE with
   AT commands only if a location needs it.
7. **Test:** unplug Starlink and confirm that `ssh db-mobile-ts`, the AMT consoles and the trailer
   OPNsense UI are reachable from home over cellular, and that the data counter barely moves.
8. **Docs:** record the modem IMEI, SIM ICCID, APN and dispatcher script in this folder.

## Sources

- UP community wiki, modems (FM150 on the i11: M.2 3052, USB3, works on kernel ≥ 5.11):
  https://github.com/up-board/up-community/wiki/Modems
- AAEON UP Xtreme i11 spec (M.2 3052 B-key with SIM):
  https://aaeon.com/en/product/detail/developer-board-intel-11th-up-xtreme-i11/specification
- FM150-NA bands / certification:
  https://everythingrf.com/products/cellular-modules/fibocom/811-761-fm150-na ,
  https://www.t-mobile.com/business/solutions/iot/device-certification/fibocom-fm150-na
- FM150-AE bands (why not AE): https://www.fibocom.com/en/Products/5G-FM150-AE.html
