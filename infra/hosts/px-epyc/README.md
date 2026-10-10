# px-epyc host files (installed 2026-10-08/09)

| File | Installed at | What |
|---|---|---|
| `gpu-5060ti-powercap.service` | `/etc/systemd/system/` (enabled) | Caps all four RTX 5060 Ti core clocks at 2600 MHz (`nvidia-smi -lgc 210,2600`) at boot - summer thermals; they throttle ~87 C and can drop off the bus at 89-90 C. |
| `gpu-thermal-recorder` + `.service` | `/usr/local/sbin/`, `/etc/systemd/system/` | ONE long-running `nvidia-smi -lms 1000` process (never one call per poll); logs 5060 Ti temps at 1 s while utilisation > 75 % to `/var/log/gpu-thermal/`. |
| `gpu-thermal-recorder.json` | `/etc/` | Per-card labels by UUID (cooling layout: #0/#3 have a 40 mm server fan at the heatsink end, #1 fan on heatsink, #2 PNY vertical fins). |
| `gpu-thermal-report` | `/usr/local/sbin/` | Summarises the recorder logs (peak / time above thresholds per card). |
| `zramswap` | `/etc/default/zramswap` | 32 GiB zstd zram swap, priority 100 - headroom for ai-epyc (CT176, RAM lowered to 160 GB). |

Re-install: copy each file to its path, `systemctl daemon-reload`, `systemctl enable --now <unit>`; zram via `systemctl restart zramswap`.
