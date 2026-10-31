# CT1020 `homeassistant` — Home Assistant Core in an LXC (esp32-net, trailer)

- Static **10.50.0.20** (OPNsense dnsmasq `homeassistant-static`), UI on **http://10.50.0.20/** (port 80 — set in the
  migrated `.storage/http` `server_port`, so the unit grants CAP_NET_BIND_SERVICE). Unprivileged Debian 13, nesting,
  2 cores / 3 GB / 16 GB, onboot, startup order 2. VMIDs for trailer services live in the 10xx block (1xx/5xx collide
  with home nodes).
- **No Docker, no supervisor:** `ha-setup.sh` = apt deps + uv-managed **Python 3.14** (HA 2026.10 requires >= 3.14.2,
  Debian 13 ships 3.13) + venv `/opt/homeassistant/venv` + `homeassistant==<ver>`. Config `/var/lib/homeassistant/config`,
  user `homeassistant`, unit `home-assistant.service`. go2rtc 1.9.14 binary in /usr/local/bin (HA's RECOMMENDED_VERSION).
- **Upgrade:** `cd /var/lib/homeassistant && sudo -u homeassistant -H env VIRTUAL_ENV=/opt/homeassistant/venv uv pip install --python /opt/homeassistant/venv/bin/python -U homeassistant==<ver>` then `systemctl restart home-assistant`
  (check `homeassistant/components/go2rtc/const.py` RECOMMENDED_VERSION after big upgrades).
- **Migrated 2026-10-30** from HAOS VM 103 on px-mobile (HA 2026.10.3): stopped core (`ha core stop`), tarred
  `/data/homeassistant` from the supervisor container, unpacked here minus `deps/`; removed the `hassio` config entry
  (original kept at /root/core.config_entries.haos-original in the CT). VM 103 is STOPPED + onboot 0 (rollback: start it).
- First start installs integration requirements into the venv (PyAV, numpy, aioesphomeapi…) — several minutes on
  Starlink; transient "No module named numpy" errors during that window are expected; restart once after.
- Add-ons are separate LXCs (Travis's choice): Music Assistant planned as CT1021 / 10.50.0.21.
